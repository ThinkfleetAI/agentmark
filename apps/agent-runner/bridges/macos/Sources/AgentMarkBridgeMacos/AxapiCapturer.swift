// Core AXAPI work — list_windows + capture. Mirrors UiaCapturer.cs
// from the Windows bridge in behaviour and output shape.
//
// macOS-specific architectural notes:
//
// 1. Window enumeration goes via NSWorkspace.runningApplications
//    (gives us regular apps + their pids) followed by
//    AXUIElementCreateApplication(pid) → kAXWindowsAttribute. There's
//    no Win32 HWND analog so we encode window ids as
//    `axapi:<pid>:<index>` and re-resolve on each call.
//
// 2. AXAPI access requires Accessibility permission. We probe
//    AXIsProcessTrusted() once at the start of every call that
//    actually touches AXAPI. Without permission the bridge returns a
//    clear JSON-RPC error with code -32020 (accessibilityNotGranted)
//    pointing the user at System Settings.
//
// 3. macOS has no "AutomationId" — every element gets a content-derived
//    stable hash via AxElement.stableId(). Survives across captures as
//    long as title/value/position stay stable; works fine for the
//    capture→execute round-trip the agent needs.

import Foundation
import ApplicationServices
import Cocoa

final class AxapiCapturer {

    /// Per-capture session — maps element_id → live AXUIElement so
    /// execute() (Phase 0e3') can find the same element again.
    final class Session {
        let rootApp: AXUIElement
        let rootWindow: AXUIElement
        var elements: [String: AXUIElement] = [:]
        init(rootApp: AXUIElement, rootWindow: AXUIElement) {
            self.rootApp = rootApp
            self.rootWindow = rootWindow
        }
    }

    private(set) var lastSession: Session?

    // MARK: - list_windows

    /// Enumerate top-level visible windows the bridge can see.
    func listWindows() throws -> [[String: Any]] {
        try requirePermission()
        let focusedHint = focusedAppPid()
        var out: [[String: Any]] = []

        for app in NSWorkspace.shared.runningApplications {
            // Skip background-only / agent-style apps; they rarely have
            // windows worth surfacing and clutter the list.
            if app.activationPolicy != .regular { continue }
            let pid = app.processIdentifier
            if pid <= 0 { continue }

            let appAx = AXUIElementCreateApplication(pid)
            guard let windows = appWindows(appAx) else { continue }

            for (idx, win) in windows.enumerated() {
                let el = AxElement(win)
                let title = el.string(kAXTitleAttribute as String) ?? ""
                // Skip chrome-less ghost windows.
                if title.isEmpty { continue }

                let isMain = el.bool(kAXMainAttribute as String) ?? false
                let isFocused = el.bool(kAXFocusedAttribute as String) ?? false
                let hasFocus = pid == focusedHint && (isFocused || isMain)

                var summary: [String: Any] = [
                    "windowId": encodeWindowId(pid: pid, index: idx),
                    "windowTitle": title,
                    "processName": app.localizedName ?? "(unknown)",
                    "processId": Int(pid),
                    "hasFocus": hasFocus,
                ]
                if let role = el.string(kAXRoleAttribute as String) {
                    // Surface the AX role as a hint; many GUI tools want this.
                    summary["windowClass"] = role
                }
                out.append(summary)
            }
        }
        return out
    }

    // MARK: - capture

    struct CaptureRequest {
        var processName: String?
        var processId: Int?
        var windowTitle: String?
        var windowId: String?
        var maxDepth: Int = 12
        var includeHidden: Bool = false
        var timeoutMs: Int = 5000
        var maxElements: Int = 2000
    }

    func capture(_ req: CaptureRequest) throws -> [String: Any] {
        try requirePermission()

        guard let target = resolveTarget(req) else {
            throw RpcError(
                code: .windowNotFound,
                message: "No matching window found and no focused window available."
            )
        }
        let (appAx, windowAx, pid, app) = target

        let session = Session(rootApp: appAx, rootWindow: windowAx)
        var ctx = WalkContext(
            maxDepth: max(1, req.maxDepth),
            maxElements: max(50, req.maxElements),
            includeHidden: req.includeHidden,
            deadline: Date().addingTimeInterval(Double(max(500, req.timeoutMs)) / 1000.0)
        )

        let rootDto = walk(AxElement(windowAx), depth: 0, ctx: &ctx, session: session)
        self.lastSession = session

        let focusedElementId = resolveFocusedElementId(in: session)

        var out: [String: Any] = [
            "platform": "macos",
            "processName": app.localizedName ?? "(unknown)",
            "processId": Int(pid),
            "windowTitle": AxElement(windowAx).string(kAXTitleAttribute as String) ?? "(untitled window)",
            "windowId": encodeWindowId(pid: pid, index: indexOf(window: windowAx, app: appAx) ?? 0),
            "treeDepth": ctx.maxDepthReached,
            "elementCount": ctx.elementCount,
            "root": rootDto,
        ]
        if let role = AxElement(windowAx).string(kAXRoleAttribute as String) {
            out["windowClass"] = role
        }
        if let fid = focusedElementId {
            out["focusedElementId"] = fid
        }
        return out
    }

    // MARK: - Walk

    private struct WalkContext {
        let maxDepth: Int
        let maxElements: Int
        let includeHidden: Bool
        let deadline: Date
        var elementCount: Int = 0
        var maxDepthReached: Int = 0
        var seenIds: Set<String> = []
    }

    private func walk(
        _ el: AxElement,
        depth: Int,
        ctx: inout WalkContext,
        session: Session
    ) -> [String: Any] {
        ctx.elementCount += 1
        if depth > ctx.maxDepthReached { ctx.maxDepthReached = depth }

        let role = el.string(kAXRoleAttribute as String)
        let subrole = el.string(kAXSubroleAttribute as String)
        let mappedRole = RoleMapper.toRole(role: role, subrole: subrole)

        var id = el.stableId(role: mappedRole, fallbackIndex: ctx.elementCount)
        // Disambiguate hash collisions across siblings.
        if ctx.seenIds.contains(id) {
            var n = 2
            while ctx.seenIds.contains("\(id)#\(n)") { n += 1 }
            id = "\(id)#\(n)"
        }
        ctx.seenIds.insert(id)
        session.elements[id] = el.element

        var dto: [String: Any] = [
            "id": id,
            "role": mappedRole,
        ]
        if let name = el.string(kAXTitleAttribute as String), !name.isEmpty {
            dto["name"] = name
        } else if let alt = el.string("AXDescription"), !alt.isEmpty {
            dto["name"] = alt
        }
        if let v = el.value(), !v.isEmpty {
            dto["value"] = v
        }
        if let placeholder = el.string("AXPlaceholderValue"), !placeholder.isEmpty {
            dto["placeholder"] = placeholder
        }
        if let enabled = el.bool(kAXEnabledAttribute as String) {
            dto["enabled"] = enabled
        }
        if let selected = el.bool(kAXSelectedAttribute as String) {
            dto["selected"] = selected
        }
        if let expanded = el.bool(kAXExpandedAttribute as String) {
            dto["expanded"] = expanded
        }
        if let bounds = el.bounds() {
            dto["bounds"] = [
                "x": bounds.x, "y": bounds.y,
                "width": bounds.width, "height": bounds.height,
            ]
        }

        // Stop expanding at caps. Parent still includes its own data
        // but children get truncated; body-builder on the Node side
        // renders the markdown gracefully when children is null.
        if depth >= ctx.maxDepth { return dto }
        if ctx.elementCount >= ctx.maxElements { return dto }
        if Date() > ctx.deadline { return dto }

        let children = el.children()
        if children.isEmpty { return dto }

        var kids: [[String: Any]] = []
        kids.reserveCapacity(children.count)
        for c in children {
            if ctx.elementCount >= ctx.maxElements { break }
            if Date() > ctx.deadline { break }
            // Off-screen / zero-size filter — children with no bounds
            // are rare but exist (hidden helper elements); skip unless
            // includeHidden is set.
            if !ctx.includeHidden {
                if let b = c.bounds(), b.width == 0 || b.height == 0 { continue }
            }
            kids.append(walk(c, depth: depth + 1, ctx: &ctx, session: session))
        }
        if !kids.isEmpty {
            dto["children"] = kids
        }
        return dto
    }

    // MARK: - Target resolution

    private func resolveTarget(_ req: CaptureRequest) -> (AXUIElement, AXUIElement, pid_t, NSRunningApplication)? {
        // 1. window_id (axapi:<pid>:<index>) is the most precise match.
        if let id = req.windowId, let decoded = decodeWindowId(id) {
            if let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == decoded.pid }) {
                let appAx = AXUIElementCreateApplication(decoded.pid)
                if let windows = appWindows(appAx), decoded.index < windows.count {
                    return (appAx, windows[decoded.index], decoded.pid, app)
                }
            }
        }

        // 2. processId match
        if let pid = req.processId {
            if let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid_t(pid) }) {
                let appAx = AXUIElementCreateApplication(pid_t(pid))
                if let win = firstMeaningfulWindow(appAx) {
                    return (appAx, win, pid_t(pid), app)
                }
            }
        }

        // 3. processName match (substring, case-insensitive, .app suffix tolerant)
        if let needle = req.processName?.lowercased().replacingOccurrences(of: ".app", with: "") {
            for app in NSWorkspace.shared.runningApplications {
                if app.activationPolicy != .regular { continue }
                let name = (app.localizedName ?? "").lowercased()
                let bundle = (app.bundleIdentifier ?? "").lowercased()
                if name.contains(needle) || bundle.contains(needle) {
                    let appAx = AXUIElementCreateApplication(app.processIdentifier)
                    if let win = firstMeaningfulWindow(appAx) {
                        return (appAx, win, app.processIdentifier, app)
                    }
                }
            }
        }

        // 4. windowTitle match
        if let titleNeedle = req.windowTitle?.lowercased() {
            for app in NSWorkspace.shared.runningApplications {
                if app.activationPolicy != .regular { continue }
                let appAx = AXUIElementCreateApplication(app.processIdentifier)
                guard let windows = appWindows(appAx) else { continue }
                for win in windows {
                    if let t = AxElement(win).string(kAXTitleAttribute as String),
                       t.lowercased().contains(titleNeedle) {
                        return (appAx, win, app.processIdentifier, app)
                    }
                }
            }
        }

        // 5. Default: focused window.
        if let pid = focusedAppPid(),
           let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) {
            let appAx = AXUIElementCreateApplication(pid)
            if let win = focusedWindow(appAx) ?? firstMeaningfulWindow(appAx) {
                return (appAx, win, pid, app)
            }
        }
        return nil
    }

    // MARK: - Helpers

    private func requirePermission() throws {
        if !AccessibilityPermission.isGranted {
            throw RpcError(
                code: .accessibilityNotGranted,
                message: "Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable the process that launched this bridge (Claude Desktop, Terminal during dev, or the agentmark MCP server)."
            )
        }
    }

    private func appWindows(_ appAx: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appAx, kAXWindowsAttribute as CFString, &value)
        guard err == .success, let v = value else { return nil }
        if CFGetTypeID(v) == CFArrayGetTypeID() {
            let arr = v as! [AnyObject]
            return arr.compactMap { item in
                if CFGetTypeID(item) == AXUIElementGetTypeID() {
                    return (item as! AXUIElement)
                }
                return nil
            }
        }
        return nil
    }

    private func firstMeaningfulWindow(_ appAx: AXUIElement) -> AXUIElement? {
        guard let windows = appWindows(appAx) else { return nil }
        for win in windows {
            let el = AxElement(win)
            if let t = el.string(kAXTitleAttribute as String), !t.isEmpty {
                return win
            }
        }
        return windows.first
    }

    private func focusedWindow(_ appAx: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appAx, kAXFocusedWindowAttribute as CFString, &value)
        guard err == .success, let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else {
            return nil
        }
        return (v as! AXUIElement)
    }

    private func focusedAppPid() -> pid_t? {
        // NSWorkspace.frontmostApplication is the highest-fidelity
        // signal — it tracks the actually-active window owner.
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    private func resolveFocusedElementId(in session: Session) -> String? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(session.rootApp, kAXFocusedUIElementAttribute as CFString, &value)
        guard err == .success, let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else {
            return nil
        }
        let focused = v as! AXUIElement
        // Try to find that element in the captured session.
        for (id, el) in session.elements {
            if CFEqual(el, focused) {
                return id
            }
        }
        return nil
    }

    private func indexOf(window: AXUIElement, app: AXUIElement) -> Int? {
        guard let windows = appWindows(app) else { return nil }
        for (i, w) in windows.enumerated() where CFEqual(w, window) {
            return i
        }
        return nil
    }

    // MARK: - Window ID encoding

    func encodeWindowId(pid: pid_t, index: Int) -> String {
        return "axapi:\(pid):\(index)"
    }

    func decodeWindowId(_ s: String) -> (pid: pid_t, index: Int)? {
        guard s.hasPrefix("axapi:") else { return nil }
        let parts = s.dropFirst("axapi:".count).split(separator: ":")
        guard parts.count == 2,
              let pid = pid_t(parts[0]),
              let idx = Int(parts[1])
        else { return nil }
        return (pid, idx)
    }
}

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

    // MARK: - Execute

    struct ExecuteRequest {
        var elementId: String = ""
        var actionType: String = "click"
        var text: String?
        var value: String?
        var checked: Bool?
        var expanded: Bool?
        var key: String?
        var modifiers: [String]?
        var clearFirst: Bool = false
        var timeoutMs: Int = 5000
    }

    func execute(_ req: ExecuteRequest) throws -> [String: Any] {
        try requirePermission()

        guard let session = lastSession else {
            return [
                "ok": false,
                "message": "No capture session active. Call `capture` before `execute` so the bridge can resolve element_ids.",
            ]
        }
        guard let element = session.elements[req.elementId] else {
            return [
                "ok": false,
                "message": "Unknown element_id `\(req.elementId)` in the current capture session. Re-capture if the window has changed.",
            ]
        }

        do {
            switch req.actionType {
            case "click":     return try doClick(element)
            case "type":      return try doType(element, text: req.text ?? "", clearFirst: req.clearFirst)
            case "select":    return try doSelect(element, value: req.value ?? "")
            case "check":     return try doCheck(element, want: req.checked ?? true)
            case "expand":    return try doExpand(element, want: req.expanded ?? true)
            case "focus":     return try doFocus(element)
            case "scroll_to": return try doScrollTo(element)
            case "key":       return try doKey(element, key: req.key ?? "", modifiers: req.modifiers ?? [])
            default:
                return ["ok": false, "message": "Unknown action type `\(req.actionType)`."]
            }
        } catch let rpcError as RpcError {
            return ["ok": false, "message": rpcError.message]
        } catch {
            return ["ok": false, "message": "\(error)"]
        }
    }

    // ---- Per-action helpers ----

    private func doClick(_ el: AXUIElement) throws -> [String: Any] {
        // Try AXPress first (buttons, menu items, links).
        if performAction(el, "AXPress") {
            return ["ok": true]
        }
        // Toggle action (some checkboxes).
        if performAction(el, "AXToggle") {
            return ["ok": true]
        }
        // Pick (some popups / list items).
        if performAction(el, "AXPick") {
            return ["ok": true]
        }
        // Confirm (default button in a dialog).
        if performAction(el, "AXConfirm") {
            return ["ok": true]
        }
        // Show menu (for popup-button-style controls).
        if performAction(el, "AXShowMenu") {
            return ["ok": true, "message": "Used AXShowMenu fallback (element exposed no AXPress)."]
        }
        return ["ok": false, "message": "Element does not support any clickable AX action."]
    }

    private func doType(_ el: AXUIElement, text: String, clearFirst: Bool) throws -> [String: Any] {
        // AXAPI's standard text input is kAXValueAttribute as a String.
        // Setting it via AXUIElementSetAttributeValue replaces content
        // atomically; honour `clearFirst` by setting "" first when
        // requested.
        _ = setFocus(el)  // best-effort; some apps require focus before SetValue is honoured

        if clearFirst {
            _ = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, "" as CFTypeRef)
        }
        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
        if err == .success {
            let newValue = AxElement(el).value() ?? text
            return ["ok": true, "newValue": newValue]
        }

        // Fallback: synthesise keystrokes via CGEvent. Only usable when
        // the element accepts focus and the host app honours regular
        // keyboard input on the focused element.
        if !setFocus(el) {
            return ["ok": false, "message": "SetAttributeValue failed (\(err)) and element refused focus."]
        }
        if clearFirst {
            sendKeyCombo(keyCode: 0x00 /* a */, modifiers: [.maskCommand])
            sendKey(keyCode: 0x33 /* delete */)
        }
        typeString(text)
        return ["ok": true, "message": "Used keyboard fallback (AXValue not writable)."]
    }

    private func doSelect(_ el: AXUIElement, value: String) throws -> [String: Any] {
        // For selection-item elements (rows, menu items, tabs), perform AXPress.
        if performAction(el, "AXPress") { return ["ok": true, "newValue": AxElement(el).string(kAXTitleAttribute as String) ?? value] }
        // For popup buttons, set kAXValue directly.
        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef)
        if err == .success { return ["ok": true, "newValue": value] }
        return ["ok": false, "message": "Element does not support a selection action."]
    }

    private func doCheck(_ el: AXUIElement, want: Bool) throws -> [String: Any] {
        // Toggle until state matches (cap at 3 to avoid loops on
        // tri-state controls).
        var guardCount = 3
        while guardCount > 0 {
            guardCount -= 1
            let current = AxElement(el).bool(kAXValueAttribute as String) ?? false
            if current == want { break }
            // Try AXPress first, then AXToggle.
            if !performAction(el, "AXPress") && !performAction(el, "AXToggle") {
                return ["ok": false, "message": "Element does not support AXPress/AXToggle."]
            }
        }
        let final = AxElement(el).bool(kAXValueAttribute as String) ?? false
        return ["ok": final == want, "newValue": final ? "true" : "false"]
    }

    private func doExpand(_ el: AXUIElement, want: Bool) throws -> [String: Any] {
        // Expanded state lives in kAXExpandedAttribute or kAXDisclosing.
        let current = AxElement(el).bool(kAXExpandedAttribute as String) ?? AxElement(el).bool("AXDisclosing") ?? false
        if current == want {
            return ["ok": true, "newValue": want ? "Expanded" : "Collapsed"]
        }
        // Try setting the attribute directly (works for outline rows).
        let setErr = AXUIElementSetAttributeValue(el, kAXExpandedAttribute as CFString, want as CFTypeRef)
        if setErr == .success {
            return ["ok": true, "newValue": want ? "Expanded" : "Collapsed"]
        }
        // Fall back to AXShowMenu / AXPress to toggle.
        if performAction(el, "AXShowMenu") || performAction(el, "AXPress") {
            return ["ok": true, "newValue": want ? "Expanded" : "Collapsed", "message": "Used AXPress fallback."]
        }
        return ["ok": false, "message": "Element does not support expand/collapse."]
    }

    private func doFocus(_ el: AXUIElement) throws -> [String: Any] {
        if setFocus(el) { return ["ok": true] }
        return ["ok": false, "message": "Element refused focus."]
    }

    private func doScrollTo(_ el: AXUIElement) throws -> [String: Any] {
        if performAction(el, "AXScrollToVisible") {
            return ["ok": true]
        }
        // SetFocus often implies scroll-into-view for most controls.
        if setFocus(el) {
            return ["ok": true, "message": "Used focus fallback (no AXScrollToVisible)."]
        }
        return ["ok": false, "message": "Element does not support AXScrollToVisible and refused focus."]
    }

    private func doKey(_ el: AXUIElement, key: String, modifiers: [String]) throws -> [String: Any] {
        if key.isEmpty {
            return ["ok": false, "message": "Missing `key` argument."]
        }
        _ = setFocus(el)
        guard let code = virtualKeyCode(forName: key) else {
            // Not a named key — type the literal text.
            typeString(key)
            return ["ok": true, "message": "Typed literal text `\(key)`."]
        }
        let mods = modifiers.compactMap(modifierFlag(forName:))
        sendKeyCombo(keyCode: code, modifiers: mods)
        return ["ok": true]
    }

    // MARK: - AXAPI action helpers

    /// AXUIElementPerformAction returns success on no-op as well as on
    /// real activation, so we don't try to interpret partial-failure.
    /// Caller chains alternatives if `false` returned.
    private func performAction(_ el: AXUIElement, _ action: String) -> Bool {
        return AXUIElementPerformAction(el, action as CFString) == .success
    }

    /// Best-effort focus. Some elements ignore kAXFocusedAttribute
    /// (Document role, AXStaticText); not strictly necessary for the
    /// caller to act on the result.
    private func setFocus(_ el: AXUIElement) -> Bool {
        let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        return err == .success
    }

    // MARK: - Keyboard simulation (CGEvent)

    private func typeString(_ s: String) {
        // CGEvent supports unicode payload directly via
        // CGEventKeyboardSetUnicodeString — works for most Latin
        // and accented characters without per-character key-code
        // lookup.
        for ch in s {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
            let unicodeChars = Array(String(ch).utf16)
            down.keyboardSetUnicodeString(stringLength: unicodeChars.count, unicodeString: unicodeChars)
            up.keyboardSetUnicodeString(stringLength: unicodeChars.count, unicodeString: unicodeChars)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private func sendKey(keyCode: CGKeyCode) {
        sendKeyCombo(keyCode: keyCode, modifiers: [])
    }

    private func sendKeyCombo(keyCode: CGKeyCode, modifiers: [CGEventFlags]) {
        let combined: CGEventFlags = modifiers.reduce(CGEventFlags(rawValue: 0)) { CGEventFlags(rawValue: $0.rawValue | $1.rawValue) }
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) {
            down.flags = combined
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
            up.flags = combined
            up.post(tap: .cghidEventTap)
        }
    }

    /// Mapping of friendly key names to macOS virtual key codes.
    /// Values from Carbon's `Events.h` (`kVK_*`) — Apple still ships
    /// these as the canonical key-code constants on Apple Silicon.
    private func virtualKeyCode(forName name: String) -> CGKeyCode? {
        switch name.lowercased() {
        case "return", "enter":  return 0x24
        case "tab":              return 0x30
        case "space", "spacebar": return 0x31
        case "delete", "backspace": return 0x33
        case "escape", "esc":    return 0x35
        case "left":  return 0x7B
        case "right": return 0x7C
        case "down":  return 0x7D
        case "up":    return 0x7E
        case "home":  return 0x73
        case "end":   return 0x77
        case "pageup", "pgup":   return 0x74
        case "pagedown", "pgdn": return 0x79
        case "f1": return 0x7A
        case "f2": return 0x78
        case "f3": return 0x63
        case "f4": return 0x76
        case "f5": return 0x60
        case "f6": return 0x61
        case "f7": return 0x62
        case "f8": return 0x64
        case "f9": return 0x65
        case "f10": return 0x6D
        case "f11": return 0x67
        case "f12": return 0x6F
        default: return nil
        }
    }

    private func modifierFlag(forName name: String) -> CGEventFlags? {
        switch name.lowercased() {
        case "ctrl", "control": return .maskControl
        case "alt", "option":   return .maskAlternate
        case "shift":           return .maskShift
        case "meta", "cmd", "command", "win", "windows": return .maskCommand
        default: return nil
        }
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

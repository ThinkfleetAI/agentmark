// AXAPI plumbing — wraps AXUIElement, AXUIElementCopyAttributeValue,
// and friends in idiomatic Swift. Mirrors the Windows bridge's UIA
// patterns: defensive everywhere, swallows mid-walk failures, never
// throws on missing attributes.

import Foundation
import ApplicationServices
import Cocoa

// MARK: - Permission

enum AccessibilityPermission {
    /// True if the running process has been granted Accessibility
    /// permission in System Settings → Privacy & Security → Accessibility.
    /// Phase 0e2'/0e3' surfaces a clear JSON-RPC error if this is false.
    static var isGranted: Bool {
        return AXIsProcessTrusted()
    }

    /// Triggers the system prompt (one-time) to grant Accessibility.
    /// We don't call this from the bridge — the prompt would interrupt
    /// the parent process. Useful for installers / first-run UI.
    static func promptForAccess() -> Bool {
        let options: NSDictionary = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString: true
        ]
        return AXIsProcessTrustedWithOptions(options)
    }
}

// MARK: - AxElement

/// Lightweight wrapper around an `AXUIElement`. Every attribute read
/// returns nil on any AXAPI error so a single stale element doesn't
/// abort the whole capture.
struct AxElement {
    let element: AXUIElement

    init(_ element: AXUIElement) {
        self.element = element
    }

    // ---- Attribute readers ----

    func string(_ attr: String) -> String? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success, let v = value else { return nil }
        if CFGetTypeID(v) == CFStringGetTypeID() {
            return v as? String
        }
        return nil
    }

    func bool(_ attr: String) -> Bool? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success, let v = value else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() {
            return (v as! CFBoolean) === kCFBooleanTrue
        }
        return nil
    }

    /// Generic "value" extractor — AX exposes value as either string,
    /// number, AXValue (CGPoint/Size/etc.), or bool depending on the role.
    /// We canonicalise to a string representation that's useful for the
    /// agent.
    func value(_ attr: String = kAXValueAttribute as String) -> String? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success, let v = value else { return nil }
        let typeId = CFGetTypeID(v)
        if typeId == CFStringGetTypeID() {
            return v as? String
        }
        if typeId == CFNumberGetTypeID() {
            return "\(v as! NSNumber)"
        }
        if typeId == CFBooleanGetTypeID() {
            return ((v as! CFBoolean) === kCFBooleanTrue) ? "true" : "false"
        }
        return nil
    }

    func children(limit: Int = 5_000) -> [AxElement] {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        guard err == .success, let v = value else { return [] }
        if CFGetTypeID(v) == CFArrayGetTypeID() {
            let arr = v as! [AnyObject]
            return arr.prefix(limit).compactMap { item in
                // Each child should be an AXUIElement. CFGetTypeID()
                // confirms; AXUIElementGetTypeID is the real test.
                if CFGetTypeID(item) == AXUIElementGetTypeID() {
                    return AxElement(item as! AXUIElement)
                }
                return nil
            }
        }
        return []
    }

    /// Screen-space bounds via kAXPositionAttribute + kAXSizeAttribute.
    /// Returns nil when either is missing or fails to decode.
    func bounds() -> (x: Double, y: Double, width: Double, height: Double)? {
        var posRef: CFTypeRef?
        let posErr = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef)
        var sizeRef: CFTypeRef?
        let sizeErr = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
        guard posErr == .success, let pos = posRef,
              sizeErr == .success, let size = sizeRef else { return nil }
        var point = CGPoint.zero
        var sz = CGSize.zero
        AXValueGetValue(pos as! AXValue, .cgPoint, &point)
        AXValueGetValue(size as! AXValue, .cgSize, &sz)
        if sz.width == 0 && sz.height == 0 { return nil }
        return (Double(point.x), Double(point.y), Double(sz.width), Double(sz.height))
    }

    /// Stable id for the element. AXAPI has no AutomationId equivalent;
    /// kAXIdentifierAttribute is occasionally populated but most apps
    /// don't set it. Fall back to a content-derived hash so the same
    /// element produces the same id across captures.
    func stableId(role: String, fallbackIndex: Int) -> String {
        if let id = string(kAXIdentifierAttribute as String), !id.isEmpty {
            return id
        }
        // Hash inputs: role + title + value's first 32 chars + position.
        let title = string(kAXTitleAttribute as String) ?? ""
        let value = self.value() ?? ""
        let trimmedValue = String(value.prefix(32))
        var pos = "?"
        if let b = bounds() {
            pos = "\(Int(b.x)),\(Int(b.y)),\(Int(b.width))x\(Int(b.height))"
        }
        let raw = "\(role)|\(title)|\(trimmedValue)|\(pos)|\(fallbackIndex)"
        let hash = AxElement.djb2Hash(raw)
        return String(format: "el_%08x", hash)
    }

    static func djb2Hash(_ s: String) -> UInt32 {
        var hash: UInt32 = 5381
        for byte in s.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt32(byte)
        }
        return hash
    }
}

// MARK: - Role mapping

enum RoleMapper {
    /// Translates AXAPI role (and where helpful, subrole) into the
    /// AgentMark v0.4 normalised `DesktopRole` vocabulary. Unknown
    /// roles fall through to "other"; the body-builder on the Node
    /// side renders these gracefully (recurses but doesn't surface
    /// them as actions).
    static func toRole(role: String?, subrole: String?) -> String {
        guard let role = role else { return "other" }

        // Subrole takes priority for a few cases that change semantics.
        if role == "AXTextField" && subrole == "AXSecureTextField" {
            return "password_input"
        }
        if role == "AXTextField" && subrole == "AXSearchField" {
            return "text_input"
        }
        if (role == "AXTextArea") || (role == "AXTextField" && subrole == "AXContentSearchField") {
            return "text_area"
        }
        if role == "AXButton" && subrole == "AXToggleSubrole" {
            // older apps use AXToggleSubrole for toggle buttons
            return "button"
        }
        if role == "AXWindow" && (subrole == "AXDialog" || subrole == "AXSystemDialog") {
            return "dialog"
        }

        switch role {
        case "AXWindow":       return "window"
        case "AXGroup":        return "group"
        case "AXSplitGroup":   return "pane"
        case "AXScrollArea":   return "pane"
        case "AXToolbar":      return "toolbar"
        case "AXMenuBar":      return "menu"
        case "AXMenu":         return "menu"
        case "AXMenuItem":     return "menu_item"
        case "AXMenuBarItem":  return "menu_item"
        case "AXMenuButton":   return "split_button"
        case "AXTabGroup":     return "tab_list"
        case "AXRadioGroup":   return "group"
        case "AXTab":          return "tab"
        case "AXOutline":      return "tree"
        case "AXOutlineRow":   return "tree_item"
        case "AXList":         return "list"
        case "AXListItem":     return "list_item"
        case "AXTable":        return "table"
        case "AXRow":          return "row"
        case "AXCell":         return "cell"
        case "AXColumn":       return "column_header"
        case "AXButton":       return "button"
        case "AXTextField":    return "text_input"
        case "AXTextArea":     return "text_area"
        case "AXCheckBox":     return "check_box"
        case "AXRadioButton":  return "radio_button"
        case "AXPopUpButton":  return "combo_box"
        case "AXComboBox":     return "combo_box"
        case "AXSlider":       return "slider"
        case "AXProgressIndicator": return "progress_bar"
        case "AXLink":         return "link"
        case "AXStaticText":   return "static_text"
        case "AXImage":        return "image"
        case "AXSplitter":     return "separator"
        case "AXScrollBar":    return "scroll_bar"
        case "AXSheet":        return "dialog"
        case "AXDrawer":       return "pane"
        case "AXHelpTag":      return "tooltip"
        case "AXValueIndicator": return "static_text"
        case "AXIncrementor":  return "slider"
        case "AXBusyIndicator": return "progress_bar"
        case "AXDisclosureTriangle": return "button"
        default: return "other"
        }
    }
}

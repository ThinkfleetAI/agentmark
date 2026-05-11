/**
 * Desktop support — types for OS-accessibility capture backends and the
 * structured tree `convertDesktop()` consumes.
 *
 * Backends implement `DesktopCaptureBackend` and are typically OS-bound:
 *
 *   - Windows: a .NET sidecar process exposing UIA via FlaUI
 *   - macOS:   a Swift/ObjC sidecar exposing AXAPI
 *   - Linux:   a sidecar over AT-SPI / D-Bus
 *   - Vision:  a fallback that captures a screenshot and parses it
 *              (e.g. OmniParser, GUI-Actor) when no accessibility tree
 *              is available (Electron canvas, Citrix sessions, etc.)
 *
 * The converter is OS-agnostic: it consumes a `DesktopCapture` tree and
 * produces an AgentMark Snapshot with `kind: 'desktop'`. Bridges live in
 * separate processes/repos; the Node-side just talks to whatever bridge
 * implements this interface.
 */

export interface DesktopCaptureBackend {
    /** Stable backend identifier — populated into `desktop_meta.a11y_backend`.
     *  Convention: `windows_uia`, `macos_axapi`, `linux_atspi`, `vision_fallback`,
     *  or `fixture` for tests. */
    readonly name: string

    /** Enumerate top-level windows the backend can see. Returns lightweight
     *  summaries (no element tree) so an agent can pick a target before
     *  paying for the full capture. */
    listTargets(): Promise<DesktopTargetSummary[]>

    /** Capture the current state of a target window/application. */
    capture(opts: CaptureDesktopOptions): Promise<DesktopCapture>

    /** Execute an action against a previously-captured element. The element
     *  is identified by `element_id` which comes from the capture tree. */
    execute(opts: ExecuteDesktopOptions): Promise<ExecuteDesktopResult>

    /** Optional teardown — release native handles, close sidecar process. */
    close?(): Promise<void>
}

/** Lightweight summary of one open window — what `listTargets()` returns. */
export interface DesktopTargetSummary {
    /** Opaque handle the caller passes back as `target.window_id` to
     *  capture this specific window. Format is backend-defined
     *  (Windows: `hwnd:0x...`; macOS: `axapi:<pid>:<index>`; fixture:
     *  the preset key). */
    window_id: string
    process_name?: string
    process_id?: number
    window_title: string
    /** Toolkit / class hint — Windows class name (e.g. `XLMAIN`),
     *  macOS AX role (e.g. `AXWindow`), useful for UI inspectors. */
    window_class?: string
    /** True when this window currently has keyboard focus. */
    has_focus: boolean
}

/** Identifies a target window. Backends accept any combination they can
 *  resolve; if nothing is provided the currently focused window is used. */
export interface DesktopTarget {
    process_name?: string
    process_id?: number
    window_title?: string
    /** Opaque OS handle — e.g. Windows HWND as a stringified pointer, macOS
     *  AXUIElementRef pointer encoded as a base64 string. Returned in
     *  `DesktopCapture.window_id` so callers can re-target precisely. */
    window_id?: string
}

export interface CaptureDesktopOptions {
    /** Which window/app to capture. Defaults to focused window if omitted. */
    target?: DesktopTarget
    /** Maximum tree depth to traverse. Default: backend-defined (typically 12). */
    maxDepth?: number
    /** Whether to include elements that are off-screen or invisible. Default: false. */
    includeHidden?: boolean
    /** Per-request timeout (ms). Default: 5000. */
    timeoutMs?: number
}

export interface DesktopCapture {
    platform: 'windows' | 'macos' | 'linux'
    process_name?: string
    process_id?: number
    window_title: string
    window_class?: string
    /** Backend-defined opaque handle for re-targeting this exact window. */
    window_id?: string
    /** Stable accessibility ID of the currently focused element, when one
     *  is focused inside the captured window. */
    focused_element_id?: string
    /** Maximum depth the backend traversed (may be < requested if a leaf
     *  was reached first). */
    tree_depth: number
    /** Total elements captured (interactive + static). */
    element_count: number
    /** Root of the accessibility tree. */
    root: DesktopElement
}

/**
 * One node in the accessibility tree. Roles map to the underlying OS
 * concept (UIA ControlType / AXRole). The converter inspects `role` to
 * decide whether the element becomes an `ActionDefinition` (interactive)
 * or a static body block (label/text/group).
 */
export interface DesktopElement {
    /** Stable accessibility identifier. Windows: UIA AutomationId; macOS:
     *  AXIdentifier; Linux: AT-SPI accessible-id. Falls back to a
     *  backend-generated stable hash when the platform omits the ID. */
    id: string

    /** Control role — backends normalise to a small vocabulary the
     *  converter understands. */
    role: DesktopRole

    /** Accessible name / display label. */
    name?: string

    /** Current value (for inputs, sliders, combo selections, etc.). */
    value?: string

    /** Placeholder / help text when the element shows one. */
    placeholder?: string

    /** Whether the element is enabled. Disabled elements are still
     *  captured but won't generate executable actions. */
    enabled?: boolean

    /** Selection state for checkboxes, radios, list items, tabs. */
    selected?: boolean

    /** Read-only text fields, etc. */
    read_only?: boolean

    /** ExpandCollapsePattern state for combo boxes, tree items, menus. */
    expanded?: boolean

    /** ARIA-equivalent properties when supplied by the backend. */
    aria?: {
        pressed?: boolean
        checked?: boolean | 'mixed'
        required?: boolean
        invalid?: boolean
    }

    /** Bounds in screen coordinates. Optional — used by vision-fallback
     *  backends or when the agent wants pixel-targeted clicks. */
    bounds?: { x: number; y: number; width: number; height: number }

    /** Nested children. Backends pre-order traversal; converter renders
     *  in document order. */
    children?: DesktopElement[]
}

/**
 * Normalised role vocabulary. Backends translate UIA/AXAPI roles to
 * these. Unknowns become `'other'` and render as static body text.
 */
export type DesktopRole =
    | 'window'
    | 'pane'
    | 'group'
    | 'toolbar'
    | 'menu'
    | 'menu_item'
    | 'tab_list'
    | 'tab'
    | 'tree'
    | 'tree_item'
    | 'list'
    | 'list_item'
    | 'table'
    | 'row'
    | 'cell'
    | 'column_header'
    | 'button'
    | 'split_button'
    | 'text_input'
    | 'password_input'
    | 'text_area'
    | 'check_box'
    | 'radio_button'
    | 'combo_box'
    | 'list_box'
    | 'slider'
    | 'progress_bar'
    | 'link'
    | 'label'
    | 'static_text'
    | 'image'
    | 'separator'
    | 'status_bar'
    | 'scroll_bar'
    | 'dialog'
    | 'tooltip'
    | 'other'

export interface ExecuteDesktopOptions {
    /** Which window the element lives in. Optional if the backend can
     *  resolve the element_id globally. */
    target?: DesktopTarget
    /** What to do. */
    action: ExecuteDesktopAction
    /** Per-request timeout (ms). Default: 5000. */
    timeoutMs?: number
}

/** All supported actions. The backend translates these to UIA patterns
 *  (InvokePattern, ValuePattern, TogglePattern, etc.) or AXAPI equivalents. */
export type ExecuteDesktopAction =
    | { type: 'click'; element_id: string }
    | { type: 'type'; element_id: string; text: string; clear_first?: boolean }
    | { type: 'select'; element_id: string; value: string }
    | { type: 'check'; element_id: string; checked: boolean }
    | { type: 'expand'; element_id: string; expanded: boolean }
    | { type: 'focus'; element_id: string }
    | { type: 'scroll_to'; element_id: string }
    | { type: 'key'; element_id?: string; key: string; modifiers?: ReadonlyArray<KeyModifier> }

export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'meta' | 'win'

export interface ExecuteDesktopResult {
    ok: boolean
    /** Backend-supplied detail when ok is false (e.g. 'element disabled',
     *  'element no longer in tree'). */
    message?: string
    /** Snapshot of the element AFTER the action when the backend can
     *  cheaply re-query it. Lets the agent confirm state without a full
     *  re-capture. */
    new_value?: string
}

/**
 * agentmark v0.1 — in-memory types.
 *
 * These mirror the spec at docs/specs/agentmark-v0.1.md.
 * Producers build an `Snapshot`; serializers turn it into the wire format.
 */

export const AGENTMARK_VERSION = '0.4' as const

/** Spec versions this implementation can validate against. */
export const SUPPORTED_SPEC_VERSIONS = ['0.1', '0.2', '0.3', '0.4'] as const

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter envelope
// ──────────────────────────────────────────────────────────────────────────

/**
 * Discriminator. v0.2 added `webpage|document|form`; v0.3 added `audio|video`;
 * v0.4 adds `desktop` for native application surfaces captured via OS
 * accessibility APIs (Windows UIA, macOS AXAPI, Linux AT-SPI).
 * Defaults to 'webpage' when omitted (v0.1 compatibility).
 */
export type SnapshotKind = 'webpage' | 'document' | 'form' | 'audio' | 'video' | 'desktop'

export interface Snapshot {
    /** Spec version, e.g. "0.1" or "0.2" */
    agentmark: string
    /** Surface kind (v0.2+). Default: 'webpage'. */
    kind?: SnapshotKind
    /** Absolute URL of the page (or document `file://` URI) at capture time */
    url: string
    /** Page or document title */
    title: string

    /** ISO 8601 capture timestamp */
    captured_at?: string
    /** ISO 8601 expiry — after this, snapshot is stale */
    expires_at?: string
    /** Source classification (default: "rendered") */
    source?: SnapshotSource
    /** BCP-47 language tag */
    language?: string
    /** Text direction override */
    direction?: 'ltr' | 'rtl'

    state?: PageState
    actions?: Record<string, ActionDefinition>
    media?: Record<string, MediaDefinition>
    memory?: MemoryHints
    capabilities?: RendererCapabilities
    cookies?: CookieState
    permissions?: PermissionState

    /** Document-specific metadata (v0.2+, populated when kind === 'document'). */
    document?: DocumentMeta

    /** Audio/video-specific metadata (v0.3+, populated when kind === 'audio' | 'video'). */
    media_meta?: MediaMeta

    /** Speaker labels keyed by ID (v0.3+, audio/video). Map ID → display name. */
    speakers?: Record<string, string>

    /** Desktop-specific metadata (v0.4+, populated when kind === 'desktop'). */
    desktop_meta?: DesktopMeta

    /**
     * Detected signatures on the document, keyed by signature ID
     * (e.g. `sig_1`). Body uses `[SIGNATURE:sig_1]` to reference them.
     * Populated by the signature-detection pipeline (v0.8+) when the
     * source surface is a PDF.
     */
    signatures?: Record<string, SignatureDescriptor>

    /** The Markdown body */
    body: string

    /** Vendor extensions (`x-` prefix) */
    [key: `x-${string}`]: unknown
}

export type SnapshotSource = 'rendered' | 'declared' | 'hybrid'

/**
 * Media (audio/video) metadata.
 */
export interface MediaMeta {
    /** Total duration in seconds. */
    duration_sec?: number
    /** Format identifier (e.g. 'mp3', 'wav', 'mp4', 'webm'). */
    format?: string
    /** BCP-47 language tag of the spoken content. */
    language?: string
    /** Whether the source was transcribed (audio) or transcribed+frame-captioned (video). */
    transcribed?: boolean
    /** When transcribed: name of the transcription backend used. */
    transcription_backend?: string
    /** When video frames were captioned: name of the vision backend used. */
    vision_backend?: string
    /** Number of speakers identified (when diarized). */
    speaker_count?: number
    /** Number of frames captioned (video only). */
    frame_count?: number
}

/**
 * Document metadata extracted from PDF (or other document) backends. All
 * fields optional — backends populate what they can.
 */
export interface DocumentMeta {
    /** Total page count. */
    pages?: number
    /** Document author, when present in metadata. */
    author?: string
    /** ISO 8601 creation timestamp from the source document. */
    created_at?: string
    /** ISO 8601 last-modified timestamp from the source document. */
    modified_at?: string
    /** Source format identifier — 'pdf', 'docx', etc. */
    format?: 'pdf' | 'docx' | 'rtf' | 'txt' | 'html'
    /** Format-specific version (e.g. PDF spec version "1.7"). */
    format_version?: string
    /** Whether the source was OCR'd (i.e. originally a scan). */
    ocr_used?: boolean
}

/**
 * Desktop metadata captured from OS accessibility APIs (v0.4+). Producer
 * walks the platform's accessibility tree (Windows UIA, macOS AXAPI, Linux
 * AT-SPI) and emits a Snapshot describing one or more application windows.
 * Interactive elements are exposed through the standard `actions` map; the
 * fields here are descriptive metadata only.
 *
 * All fields are optional — backends populate what they can.
 */
export interface DesktopMeta {
    /** Operating system the snapshot was captured on. */
    platform?: 'windows' | 'macos' | 'linux'
    /** Process name owning the focused window (e.g. 'EXCEL.EXE', 'Slack'). */
    process_name?: string
    /** OS process id of the captured window's owning process. */
    process_id?: number
    /** Toolkit / window class hint — Windows: UIA control type or Win32
     *  class (e.g. 'XLMAIN'); macOS: AXSubrole; Linux: AT-SPI role. */
    window_class?: string
    /** Stable accessibility identifier of the currently focused element.
     *  On Windows this is typically the UIA AutomationId; on macOS the
     *  AXIdentifier; on Linux the AT-SPI accessible-id. */
    focused_element_id?: string
    /** Accessibility backend that produced the snapshot. Helps consumers
     *  understand the fidelity of the captured data. */
    a11y_backend?: 'windows_uia' | 'macos_axapi' | 'linux_atspi' | 'vision_fallback' | string
    /** Maximum depth of the captured accessibility tree (debugging /
     *  cardinality hint for renderers). */
    tree_depth?: number
    /** Total interactive elements extracted into the `actions` map. */
    element_count?: number
}

// ──────────────────────────────────────────────────────────────────────────
// Page state
// ──────────────────────────────────────────────────────────────────────────

export interface PageState {
    loading?: boolean
    auth?: 'logged_in' | 'logged_out' | 'unknown'
    error?: string | null
    empty?: boolean
    ssl?: 'valid' | 'invalid' | 'mixed' | 'none'
    modal_open?: boolean
    active_tab?: string | null
    active_step?: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Actions
// ──────────────────────────────────────────────────────────────────────────

export type ActionType =
    | 'click'
    | 'type'
    | 'check'
    | 'select'
    | 'multi_select'
    | 'nav'
    | 'submit'
    | 'upload'
    | 'date'
    | 'time'
    | 'datetime'
    | 'range'
    | 'color'
    | 'key'
    | 'hover'
    | 'scroll_to'
    | 'drag'

export type ActionCost = 'free' | 'destructive' | 'financial'

export interface ActionDefinition {
    type: ActionType
    label: string
    description?: string
    disabled?: boolean
    disabled_reason?: string
    required?: boolean
    read_only?: boolean
    validation?: string
    value?: unknown
    placeholder?: string
    options?: unknown[]
    min?: number
    max?: number
    step?: number
    target?: string
    target_id?: string
    cost?: ActionCost
    confirms?: boolean
    auth_required?: string
    precondition_ids?: string[]
    aria?: AriaState
    region_id?: string
    idempotent?: boolean
    honeypot?: boolean
}

export interface AriaState {
    expanded?: boolean
    pressed?: boolean
    checked?: boolean | 'mixed'
    selected?: boolean
    disabled?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// Media
// ──────────────────────────────────────────────────────────────────────────

export interface MediaDefinition {
    type: 'image' | 'video' | 'audio'
    alt?: string
    caption?: string | null
    preview_url?: string
    preview_token?: string | null
    text_extract?: string | null
    ocr_available?: boolean
    transcript_available?: boolean
    width?: number
    height?: number
    /** Base64 bytes — only present when explicitly fetched on demand */
    bytes?: string | null
}

// ──────────────────────────────────────────────────────────────────────────
// Memory, capabilities, cookies, permissions
// ──────────────────────────────────────────────────────────────────────────

export interface MemoryHints {
    last_visited?: string
    visit_count?: number
    selectors_known?: number
    notes?: string[]
    facts?: Array<{ kind: string, value: string, as_of?: string }>
}

export interface RendererCapabilities {
    preview_media?: boolean
    expand_disclosures?: boolean
    paginate?: boolean
    scroll?: boolean
    keyboard?: boolean
    drag?: boolean
    ocr?: boolean
    vision?: boolean
}

export interface CookieState {
    banner_present?: boolean
    banner_action_id?: string
    consent_state?: 'accepted' | 'rejected' | 'pending' | 'unknown'
}

export interface PermissionState {
    pending?: string[]
}

// ──────────────────────────────────────────────────────────────────────────
// Body tags (intermediate, before serializing)
// ──────────────────────────────────────────────────────────────────────────

/** Tags that may appear inline in the body. */
export type BodyTagKind =
    | 'ACTION'
    | 'INPUT'
    | 'NAV'
    | 'MEDIA'
    | 'MODAL'
    | 'TAB'
    | 'DISCLOSURE'
    | 'AUTH_WALL'
    | 'CHALLENGE'
    | 'ERROR'
    | 'TOAST'
    /** v0.2+: page boundary marker for `kind: 'document'`. Payload is a
     *  page identifier like `p_1` whose number maps to the source PDF page. */
    | 'PAGE'
    /** v0.8+: signature reference. Payload is a signature ID (e.g. `sig_1`)
     *  whose details live in the `signatures` map of the envelope. */
    | 'SIGNATURE'
    /** v0.3+: timestamp marker for `kind: 'audio' | 'video'`. Payload is
     *  a time identifier (`t_0`, `t_120`) whose number is seconds-from-start. */
    | 'TIME'
    /** v0.3+: speaker label for `kind: 'audio' | 'video'`. Payload is a
     *  speaker ID (`s_alice`) keyed in the `speakers` map. */
    | 'SPEAKER'
    /** v0.3+: video frame reference. Payload is a frame ID (`f_42`) whose
     *  thumbnail + caption live in the `media` map. */
    | 'FRAME'
    /** v0.4+: window boundary marker for `kind: 'desktop'`. Payload is a
     *  window identifier (e.g. `w_1`) — used when a single snapshot spans
     *  multiple application windows. */
    | 'WINDOW'
    /** v0.4+: non-interactive accessibility element reference for
     *  `kind: 'desktop'`. Payload is an element ID (e.g. `e_42`) that
     *  matches the element's AutomationId / AXIdentifier. Interactive
     *  controls (buttons, inputs, etc.) continue to use ACTION / INPUT. */
    | 'ELEMENT'

/**
 * Descriptor for a detected signature. Lives in `Snapshot.signatures` keyed
 * by ID. Body references via `[SIGNATURE:sig_1]`.
 */
export interface SignatureDescriptor {
    kind:
        | 'widget_visible_signed'
        | 'widget_unsigned'
        | 'cryptographic'
        | 'image_handwritten'
        | 'image_typed'
        | 'docusign'
        | 'adobe_sign'
        | 'unknown'
    page: number
    rect?: { x: number; y: number; width: number; height: number }
    field_name?: string
    inferred_role?: string
    signer_name?: string
    signer_email?: string
    signed_at?: string
    confidence: number
    valid?: boolean
    notes?: string
}

export interface BodyTagReference {
    kind: BodyTagKind
    /** ID for tags that carry one (most), or payload for tags like CHALLENGE/ERROR */
    payload?: string
}

// ──────────────────────────────────────────────────────────────────────────
// Builder result
// ──────────────────────────────────────────────────────────────────────────

/**
 * The output of conversion. Includes the agentmark string and the binding map
 * used by the renderer to resolve action IDs back to live DOM elements.
 */
export interface ConversionResult {
    /** The serialized agentmark document */
    agentmark: string
    /** Map of action ID → opaque DOM binding handle (renderer-defined) */
    binding: ActionBinding
}

/**
 * Action ID → binding handle. Implementations use this to resolve
 * "click act_7" back to the real DOM element. The handle shape is
 * renderer-defined; for the Playwright backend it's a JS-side handle ID.
 */
export interface ActionBinding {
    get(actionId: string): string | undefined
    set(actionId: string, handle: string): void
    all(): Map<string, string>
}

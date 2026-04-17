/**
 * agentmark v0.1 — in-memory types.
 *
 * These mirror the spec at docs/specs/agentmark-v0.1.md.
 * Producers build an `Snapshot`; serializers turn it into the wire format.
 */

export const AGENTMARK_VERSION = '0.1' as const

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter envelope
// ──────────────────────────────────────────────────────────────────────────

export interface Snapshot {
    /** Spec version, e.g. "0.1" */
    agentmark: string
    /** Absolute URL of the page at capture time */
    url: string
    /** Page title */
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

    /** The Markdown body */
    body: string

    /** Vendor extensions (`x-` prefix) */
    [key: `x-${string}`]: unknown
}

export type SnapshotSource = 'rendered' | 'declared' | 'hybrid'

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

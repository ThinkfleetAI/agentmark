/**
 * Shared types + helpers for the MCP server. The server holds long-lived
 * resources (browsers, opened PDF documents) keyed by session ID, so any
 * MCP client can drive multiple parallel agents from one connection.
 */

import type {
    ActionBinding,
    Browser,
    DesktopCapture,
    DesktopCaptureBackend,
    DesktopTarget,
    Page,
    PdfDocument,
} from '../index'

export interface BrowserSession {
    id: string
    browser: Browser
    pages: Map<string, Page>  // pageId → Page
    createdAt: Date
}

export interface PdfSession {
    id: string
    document: PdfDocument
    createdAt: Date
}

export interface DesktopSession {
    id: string
    backend: DesktopCaptureBackend
    /** Last `target` passed to capture(); reused by execute() when the
     *  client doesn't re-specify it. */
    lastTarget?: DesktopTarget
    /** Result of the most recent capture — used so execute() knows which
     *  process to drive and which element_count to report. */
    lastCapture?: DesktopCapture
    /** Binding map from the most recent convertDesktop() call —
     *  resolves actionId → element_id for execute(). */
    lastBinding?: ActionBinding
    /** Action types keyed by actionId from the most recent snapshot.
     *  Used by execute() to translate the client's `value` argument
     *  into the right ExecuteDesktopAction variant. */
    lastActionTypes?: Map<string, string>
    createdAt: Date
}

/**
 * Generates a short unique ID. Uses crypto.randomUUID() if available,
 * otherwise a Math.random fallback. The IDs are opaque to clients —
 * they're returned by `_open` tools and passed back on subsequent calls.
 */
export function generateSessionId(prefix: 'br' | 'pdf' | 'pg' | 'dt'): string {
    const r =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
            : Math.random().toString(36).slice(2, 14)
    return `${prefix}_${r}`
}

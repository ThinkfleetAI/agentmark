/**
 * Shared types + helpers for the MCP server. The server holds long-lived
 * resources (browsers, opened PDF documents) keyed by session ID, so any
 * MCP client can drive multiple parallel agents from one connection.
 */

import type { Browser, Page, PdfDocument } from '../index'

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

/**
 * Generates a short unique ID. Uses crypto.randomUUID() if available,
 * otherwise a Math.random fallback. The IDs are opaque to clients —
 * they're returned by `_open` tools and passed back on subsequent calls.
 */
export function generateSessionId(prefix: 'br' | 'pdf' | 'pg'): string {
    const r =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
            : Math.random().toString(36).slice(2, 14)
    return `${prefix}_${r}`
}

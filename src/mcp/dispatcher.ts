/**
 * AgentMark MCP tool dispatcher — pure function that maps a tool name +
 * arguments to an AgentMark operation. Stateless except for the session
 * registries it receives.
 *
 * Kept separate from the MCP transport layer so tests can drive it
 * directly without spinning up stdio + jsonrpc.
 */

import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    createBrowser,
    convertDesktop,
    FixtureBackend,
    openPdfDocument,
    isAgentMarkError,
    parseSnapshot,
    PopplerRenderBackend,
    TesseractOcrBackend,
    type Browser,
    type DesktopCaptureBackend,
    type DesktopTarget,
    type ExecuteDesktopAction,
    type KeyModifier,
    type Page,
    type PdfDocument,
    type OcrPipelineOptions,
} from '../index'
import { generateSessionId, type BrowserSession, type DesktopSession, type PdfSession } from './types'

export interface DispatcherState {
    browsers: Map<string, BrowserSession>
    pages: Map<string, { browserId: string; page: Page }>
    pdfs: Map<string, PdfSession>
    desktops: Map<string, DesktopSession>
}

export function createDispatcherState(): DispatcherState {
    return {
        browsers: new Map(),
        pages: new Map(),
        pdfs: new Map(),
        desktops: new Map(),
    }
}

export interface DispatchResult {
    /** Plain-text content returned to the MCP client. */
    text: string
    /** True when the operation reports a user-facing error (vs success). */
    isError?: boolean
}

export async function dispatch(
    state: DispatcherState,
    name: string,
    args: Record<string, unknown>,
): Promise<DispatchResult> {
    try {
        switch (name) {
            // ── Web browser ──────────────────────────────────────────────
            case 'agentmark_browser_open':
                return await openBrowser(state, args)
            case 'agentmark_browser_close':
                return await closeBrowser(state, args)
            case 'agentmark_browser_save_session':
                return await saveBrowserSession(state, args)
            case 'agentmark_page_open':
                return await openPage(state, args)
            case 'agentmark_page_navigate':
                return await pageNavigate(state, args)
            case 'agentmark_page_snapshot':
                return await pageSnapshot(state, args)
            case 'agentmark_page_execute':
                return await pageExecute(state, args)
            case 'agentmark_page_close':
                return await closePage(state, args)

            // ── PDF document ─────────────────────────────────────────────
            case 'agentmark_pdf_open':
                return await openPdf(state, args)
            case 'agentmark_pdf_close':
                return await closePdf(state, args)
            case 'agentmark_pdf_snapshot':
                return await pdfSnapshot(state, args)
            case 'agentmark_pdf_execute':
                return await pdfExecute(state, args)
            case 'agentmark_pdf_save':
                return await pdfSave(state, args)
            case 'agentmark_pdf_reset':
                return await pdfReset(state, args)

            // ── Desktop ──────────────────────────────────────────────────
            case 'agentmark_desktop_open':
                return await openDesktop(state, args)
            case 'agentmark_desktop_close':
                return await closeDesktop(state, args)
            case 'agentmark_desktop_snapshot':
                return await desktopSnapshot(state, args)
            case 'agentmark_desktop_execute':
                return await desktopExecute(state, args)

            // ── Meta ─────────────────────────────────────────────────────
            case 'agentmark_list_sessions':
                return listSessions(state)

            default:
                return { text: `Unknown tool: ${name}`, isError: true }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = isAgentMarkError(err) ? `[${err.code}] ` : ''
        return { text: `${code}${message}`, isError: true }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Web tool handlers
// ──────────────────────────────────────────────────────────────────────────

async function openBrowser(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const headless = args.headless !== false
    const sessionPath = typeof args.session_path === 'string' ? args.session_path : undefined

    const browser = await createBrowser({
        launch: { headless },
        sessionPath,
    })
    const id = generateSessionId('br')
    state.browsers.set(id, {
        id,
        browser,
        pages: new Map(),
        createdAt: new Date(),
    })
    return { text: JSON.stringify({ browser_id: id }, null, 2) }
}

async function closeBrowser(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'browser_id')
    const session = state.browsers.get(id)
    if (!session) return { text: `Unknown browser_id: ${id}`, isError: true }
    // Remove all pages owned by this browser.
    for (const [pageId, info] of state.pages) {
        if (info.browserId === id) state.pages.delete(pageId)
    }
    await session.browser.close()
    state.browsers.delete(id)
    return { text: `Browser ${id} closed.` }
}

async function saveBrowserSession(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'browser_id')
    const targetPath = path.resolve(requireString(args, 'path'))
    const session = state.browsers.get(id)
    if (!session) return { text: `Unknown browser_id: ${id}`, isError: true }
    await session.browser.saveSession(targetPath)
    return { text: `Session saved to ${targetPath}` }
}

async function openPage(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const browserId = requireString(args, 'browser_id')
    const session = state.browsers.get(browserId)
    if (!session) return { text: `Unknown browser_id: ${browserId}`, isError: true }
    const page = await session.browser.newPage()
    const pageId = generateSessionId('pg')
    state.pages.set(pageId, { browserId, page })
    session.pages.set(pageId, page)
    return { text: JSON.stringify({ page_id: pageId, browser_id: browserId }, null, 2) }
}

async function pageNavigate(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const pageId = requireString(args, 'page_id')
    const url = requireString(args, 'url')
    const page = requirePage(state, pageId)
    const waitUntil = args.wait_until as 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined
    const timeout = typeof args.timeout === 'number' ? args.timeout : undefined
    const response = await page.goto(url, { waitUntil, timeout })
    return {
        text: JSON.stringify(
            {
                final_url: page.url(),
                status: response?.status() ?? null,
            },
            null,
            2,
        ),
    }
}

async function pageSnapshot(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const pageId = requireString(args, 'page_id')
    const page = requirePage(state, pageId)
    const snap = await page.snapshot()
    return { text: snap.agentmark }
}

async function pageExecute(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const pageId = requireString(args, 'page_id')
    const actionId = requireString(args, 'action_id')
    const page = requirePage(state, pageId)
    const result = await page.execute(actionId, args.value)
    return {
        text: JSON.stringify(
            {
                action_id: result.actionId,
                action_type: result.actionType,
                duration_ms: result.durationMs,
            },
            null,
            2,
        ),
    }
}

async function closePage(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const pageId = requireString(args, 'page_id')
    const info = state.pages.get(pageId)
    if (!info) return { text: `Unknown page_id: ${pageId}`, isError: true }
    await info.page.close()
    state.pages.delete(pageId)
    state.browsers.get(info.browserId)?.pages.delete(pageId)
    return { text: `Page ${pageId} closed.` }
}

// ──────────────────────────────────────────────────────────────────────────
// PDF tool handlers
// ──────────────────────────────────────────────────────────────────────────

async function openPdf(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const source = requireString(args, 'source')
    const data = await loadPdfBytes(source)
    const sourceUrl =
        typeof args.source_url === 'string'
            ? args.source_url
            : source.startsWith('data:')
                ? source.slice(0, 80) + '...'
                : pathToFileURL(path.resolve(source)).toString()
    const title = typeof args.title === 'string' ? args.title : undefined
    const password = typeof args.password === 'string' ? args.password : undefined

    let ocr: OcrPipelineOptions | undefined
    if (args.enable_ocr === true) {
        const language = typeof args.ocr_language === 'string' ? args.ocr_language : 'eng'
        const dpi = typeof args.ocr_dpi === 'number' ? args.ocr_dpi : 200
        ocr = {
            render: new PopplerRenderBackend(),
            ocr: new TesseractOcrBackend({ language }),
            mode: 'auto',
            dpi,
            language,
        }
    }

    const document = await openPdfDocument({ data, sourceUrl, title, password, ocr })
    const id = generateSessionId('pdf')
    state.pdfs.set(id, { id, document, createdAt: new Date() })
    return {
        text: JSON.stringify(
            {
                doc_id: id,
                source_url: sourceUrl,
                field_count: document.fields.size,
                ocr_enabled: args.enable_ocr === true,
            },
            null,
            2,
        ),
    }
}

async function closePdf(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'doc_id')
    const session = state.pdfs.get(id)
    if (!session) return { text: `Unknown doc_id: ${id}`, isError: true }
    await session.document.close()
    state.pdfs.delete(id)
    return { text: `PDF ${id} closed.` }
}

async function pdfSnapshot(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'doc_id')
    const doc = requirePdf(state, id)
    const snap = await doc.snapshot()
    return { text: snap.agentmark }
}

async function pdfExecute(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'doc_id')
    const actionId = requireString(args, 'action_id')
    const doc = requirePdf(state, id)
    await doc.execute(actionId, args.value)
    return {
        text: JSON.stringify(
            {
                action_id: actionId,
                pending_count: doc.pending.size,
            },
            null,
            2,
        ),
    }
}

async function pdfSave(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'doc_id')
    const outputPath = path.resolve(requireString(args, 'output_path'))
    const flatten = args.flatten === true
    const doc = requirePdf(state, id)
    const bytes = await doc.save({ flatten })
    await writeFile(outputPath, bytes)
    return {
        text: JSON.stringify(
            {
                output_path: outputPath,
                bytes: bytes.length,
                flattened: flatten,
            },
            null,
            2,
        ),
    }
}

async function pdfReset(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'doc_id')
    const doc = requirePdf(state, id)
    doc.reset()
    return { text: `PDF ${id} pending values cleared.` }
}

// ──────────────────────────────────────────────────────────────────────────
// Desktop tool handlers
// ──────────────────────────────────────────────────────────────────────────

async function openDesktop(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const requested = typeof args.backend === 'string' ? args.backend : 'fixture'
    let backend: DesktopCaptureBackend
    switch (requested) {
        case 'fixture':
            backend = new FixtureBackend()
            break
        case 'windows_uia':
        case 'macos_axapi':
            return {
                text:
                    `Backend "${requested}" is not yet bundled with this build of agentmark. `
                    + 'Run agentmark_desktop_open with backend="fixture" to use the in-memory '
                    + 'preset trees. Real OS bridges land in subsequent releases.',
                isError: true,
            }
        default:
            return { text: `Unknown desktop backend: ${requested}`, isError: true }
    }

    const id = generateSessionId('dt')
    state.desktops.set(id, {
        id,
        backend,
        createdAt: new Date(),
    })
    return {
        text: JSON.stringify({ desktop_id: id, backend: requested }, null, 2),
    }
}

async function closeDesktop(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'desktop_id')
    const session = state.desktops.get(id)
    if (!session) return { text: `Unknown desktop_id: ${id}`, isError: true }
    await session.backend.close?.()
    state.desktops.delete(id)
    return { text: `Desktop session ${id} closed.` }
}

async function desktopSnapshot(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'desktop_id')
    const session = requireDesktop(state, id)

    const target = parseTarget(args.target)
    const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : undefined
    const includeHidden = args.include_hidden === true
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined

    const { agentmark, binding } = await convertDesktop({
        backend: session.backend,
        target,
        maxDepth,
        includeHidden,
        timeoutMs,
    })

    // Cache binding + action types so subsequent _execute can resolve.
    session.lastTarget = target
    session.lastBinding = binding
    const snap = parseSnapshot(agentmark)
    session.lastActionTypes = new Map(
        Object.entries(snap.actions ?? {}).map(([k, def]) => [k, def.type]),
    )

    return { text: agentmark }
}

async function desktopExecute(state: DispatcherState, args: Record<string, unknown>): Promise<DispatchResult> {
    const id = requireString(args, 'desktop_id')
    const actionId = requireString(args, 'action_id')
    const session = requireDesktop(state, id)

    if (!session.lastBinding || !session.lastActionTypes) {
        return {
            text:
                `No cached snapshot for desktop_id ${id}. Call `
                + `agentmark_desktop_snapshot first so the action_id can be resolved.`,
            isError: true,
        }
    }

    const elementId = session.lastBinding.get(actionId)
    if (!elementId) {
        return { text: `Unknown action_id: ${actionId}`, isError: true }
    }

    const actionType = session.lastActionTypes.get(actionId) ?? 'click'
    const value = args.value
    const modifiers = parseModifiers(args.modifiers)
    const clearFirst = args.clear_first === true

    const action = buildExecuteAction(actionType, elementId, value, modifiers, clearFirst)
    const result = await session.backend.execute({
        target: session.lastTarget,
        action,
    })

    return {
        text: JSON.stringify(
            {
                action_id: actionId,
                action_type: actionType,
                element_id: elementId,
                ok: result.ok,
                ...(result.message !== undefined ? { message: result.message } : {}),
                ...(result.new_value !== undefined ? { new_value: result.new_value } : {}),
            },
            null,
            2,
        ),
        isError: !result.ok,
    }
}

function parseTarget(input: unknown): DesktopTarget | undefined {
    if (!input || typeof input !== 'object') return undefined
    const t = input as Record<string, unknown>
    const out: DesktopTarget = {}
    if (typeof t.process_name === 'string') out.process_name = t.process_name
    if (typeof t.process_id === 'number') out.process_id = t.process_id
    if (typeof t.window_title === 'string') out.window_title = t.window_title
    if (typeof t.window_id === 'string') out.window_id = t.window_id
    return Object.keys(out).length > 0 ? out : undefined
}

function parseModifiers(input: unknown): KeyModifier[] | undefined {
    if (!Array.isArray(input)) return undefined
    const allowed: ReadonlySet<KeyModifier> = new Set(['ctrl', 'alt', 'shift', 'meta', 'win'])
    const out: KeyModifier[] = []
    for (const m of input) {
        if (typeof m === 'string' && allowed.has(m as KeyModifier)) out.push(m as KeyModifier)
    }
    return out.length > 0 ? out : undefined
}

function buildExecuteAction(
    actionType: string,
    elementId: string,
    value: unknown,
    modifiers: KeyModifier[] | undefined,
    clearFirst: boolean,
): ExecuteDesktopAction {
    switch (actionType) {
        case 'type':
            return {
                type: 'type',
                element_id: elementId,
                text: typeof value === 'string' ? value : String(value ?? ''),
                clear_first: clearFirst,
            }
        case 'check':
            return {
                type: 'check',
                element_id: elementId,
                checked: value === true || value === 'true',
            }
        case 'select':
        case 'multi_select':
            return {
                type: 'select',
                element_id: elementId,
                value: typeof value === 'string' ? value : String(value ?? ''),
            }
        case 'range':
            return {
                type: 'type',
                element_id: elementId,
                text: typeof value === 'number' ? String(value) : String(value ?? ''),
            }
        case 'key':
            return {
                type: 'key',
                element_id: elementId,
                key: typeof value === 'string' ? value : String(value ?? ''),
                modifiers,
            }
        case 'scroll_to':
            return { type: 'scroll_to', element_id: elementId }
        default:
            return { type: 'click', element_id: elementId }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Meta
// ──────────────────────────────────────────────────────────────────────────

function listSessions(state: DispatcherState): DispatchResult {
    return {
        text: JSON.stringify(
            {
                browsers: Array.from(state.browsers.values()).map((s) => ({
                    browser_id: s.id,
                    page_ids: Array.from(s.pages.keys()),
                    created_at: s.createdAt.toISOString(),
                })),
                pdfs: Array.from(state.pdfs.values()).map((s) => ({
                    doc_id: s.id,
                    field_count: s.document.fields.size,
                    pending: s.document.pending.size,
                    created_at: s.createdAt.toISOString(),
                })),
                desktops: Array.from(state.desktops.values()).map((s) => ({
                    desktop_id: s.id,
                    backend: s.backend.name,
                    has_snapshot: s.lastBinding !== undefined,
                    created_at: s.createdAt.toISOString(),
                })),
            },
            null,
            2,
        ),
    }
}

/**
 * Dispose of every active resource — called on server shutdown.
 */
export async function disposeAll(state: DispatcherState): Promise<void> {
    const closers: Promise<unknown>[] = []
    for (const session of state.browsers.values()) {
        closers.push(session.browser.close().catch(() => {}))
    }
    for (const session of state.pdfs.values()) {
        closers.push(session.document.close().catch(() => {}))
    }
    for (const session of state.desktops.values()) {
        if (session.backend.close) closers.push(session.backend.close().catch(() => {}))
    }
    await Promise.allSettled(closers)
    state.browsers.clear()
    state.pages.clear()
    state.pdfs.clear()
    state.desktops.clear()
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function requirePage(state: DispatcherState, pageId: string): Page {
    const info = state.pages.get(pageId)
    if (!info) throw new Error(`Unknown page_id: ${pageId}`)
    return info.page
}

function requirePdf(state: DispatcherState, docId: string): PdfDocument {
    const session = state.pdfs.get(docId)
    if (!session) throw new Error(`Unknown doc_id: ${docId}`)
    return session.document
}

function requireDesktop(state: DispatcherState, desktopId: string): DesktopSession {
    const session = state.desktops.get(desktopId)
    if (!session) throw new Error(`Unknown desktop_id: ${desktopId}`)
    return session
}

/**
 * Load PDF bytes from either a file path OR a data URL. Data URLs are
 * useful for clients that have the PDF in memory and don't want to write
 * a temp file.
 */
async function loadPdfBytes(source: string): Promise<Uint8Array> {
    if (source.startsWith('data:')) {
        const commaAt = source.indexOf(',')
        if (commaAt === -1) throw new Error('Malformed data URI')
        const header = source.slice(5, commaAt)
        const payload = source.slice(commaAt + 1)
        if (header.includes(';base64')) {
            return new Uint8Array(Buffer.from(payload, 'base64'))
        }
        return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
    }
    const buf = await readFile(path.resolve(source))
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

// Re-export so unrelated callers don't need to reach into types.ts.
export { type DispatcherState as McpDispatcherState }

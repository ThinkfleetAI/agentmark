/**
 * `convertDesktop()` — capture a native window via an accessibility-tree
 * backend and emit an AgentMark snapshot with `kind: 'desktop'`.
 *
 * Mirrors `convertAudio()` and `convertVideo()`: the converter is
 * pure-Node and OS-agnostic; OS-specific work is hidden behind the
 * `DesktopCaptureBackend` interface.
 *
 * Output body grammar (see `body-builder.ts` for full detail):
 *
 *   [WINDOW:w_excel]
 *
 *   # Microsoft Excel — Book1
 *
 *   ## Worksheet
 *
 *   [INPUT:act_cell_a1]
 *
 *   [ACTION:act_save]
 *
 * Interactive controls produce entries in the snapshot's `actions` map;
 * the runtime invokes the backend's `execute()` with the matching
 * `element_id` (stored as `target_id` on each action so the renderer
 * can resolve it).
 */

import {
    AGENTMARK_VERSION,
    type ConversionResult,
    type DesktopMeta,
    type Snapshot,
} from '../types'
import { serializeSnapshot } from '../serializers/yaml-frontmatter'
import { InMemoryActionBinding } from '../binding/action-binding'
import { noopLogger, type Logger } from '../observability/logger'
import { SnapshotError } from '../errors'
import { buildDesktopBody } from './body-builder'
import type {
    DesktopCaptureBackend,
    DesktopCapture,
    DesktopTarget,
} from './types'

export interface ConvertDesktopOptions {
    /** Accessibility-tree backend (Windows UIA, macOS AXAPI, vision fallback, fixture, etc.). */
    backend: DesktopCaptureBackend

    /** Which window to capture. Defaults to focused window if omitted. */
    target?: DesktopTarget

    /** Override the snapshot title. Default: the captured window title. */
    title?: string

    /** Override the snapshot URL — use this when the producer wants to
     *  identify the surface canonically (e.g. `desktop://hostname/app/process_id`).
     *  Default: a synthesised `desktop://<process_name>/<window_id>` URI. */
    url?: string

    /** Max tree depth to traverse. Default: 12. */
    maxDepth?: number

    /** Include hidden / off-screen elements. Default: false. */
    includeHidden?: boolean

    /** Per-capture timeout (ms). Default: 5000. */
    timeoutMs?: number

    /** TTL for `expires_at` (ms). Desktop UI is highly dynamic, so the
     *  default is short — 15 seconds. Producers should re-capture before
     *  acting on a stale snapshot. */
    ttlMs?: number

    /** Structured logger. */
    logger?: Logger

    /** Vendor extensions (`x-` prefixed fields) attached to the snapshot. */
    vendorExtensions?: Record<string, unknown>
}

/**
 * Desktop-specific extension of `ConversionResult` that also exposes the
 * raw `DesktopCapture` tree. Callers that want to diff snapshots or
 * inspect the structured tree without re-parsing the AgentMark string
 * read it off this field.
 */
export interface DesktopConversionResult extends ConversionResult {
    /** The raw capture returned by the backend, before AgentMark
     *  serialisation. Same object the binding refers into. */
    capture: DesktopCapture
}

export async function convertDesktop(options: ConvertDesktopOptions): Promise<DesktopConversionResult> {
    const logger = options.logger ?? noopLogger
    const ttlMs = options.ttlMs ?? 15_000

    logger.debug('snapshot.capture.start', {
        source: options.target?.window_title ?? options.target?.process_name ?? '<focused>',
        kind: 'desktop',
        backend: options.backend.name,
    })

    let capture: DesktopCapture
    try {
        capture = await options.backend.capture({
            target: options.target,
            maxDepth: options.maxDepth ?? 12,
            includeHidden: options.includeHidden ?? false,
            timeoutMs: options.timeoutMs ?? 5000,
        })
    } catch (err) {
        logger.error('snapshot.failed', { error: (err as Error).message })
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError(
            `Desktop capture failed (${options.backend.name}): ${(err as Error).message}`,
            err as Error,
        )
    }

    const captured_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + ttlMs).toISOString()

    const { body, actions, element_ids, has_interactive } = buildDesktopBody(capture)

    // Stash each action's underlying desktop element_id in the
    // ActionBinding. The runtime later resolves binding.get(actionId)
    // to the opaque element_id and passes it to backend.execute().
    const binding = new InMemoryActionBinding()
    for (const [actionId, elementId] of Object.entries(element_ids)) {
        binding.set(actionId, elementId)
    }

    const desktopMeta: DesktopMeta = stripUndefined({
        platform: capture.platform,
        process_name: capture.process_name,
        process_id: capture.process_id,
        window_class: capture.window_class,
        focused_element_id: capture.focused_element_id,
        a11y_backend: options.backend.name,
        tree_depth: capture.tree_depth,
        element_count: capture.element_count,
    })

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        kind: 'desktop',
        url: options.url ?? synthesiseDesktopUrl(capture),
        title: options.title ?? capture.window_title,
        captured_at,
        expires_at,
        source: 'rendered',
        desktop_meta: desktopMeta,
        actions: has_interactive ? actions : undefined,
        capabilities: {
            preview_media: false,
            expand_disclosures: true,
            paginate: false,
            scroll: true,
            keyboard: true,
            drag: false,
            ocr: false,
            vision: false,
        },
        body,
    }

    if (options.vendorExtensions) {
        for (const [k, v] of Object.entries(options.vendorExtensions)) {
            if (k.startsWith('x-')) (snapshot as unknown as Record<string, unknown>)[k] = v
        }
    }

    const text = serializeSnapshot(snapshot)
    logger.info('snapshot.captured', {
        source: snapshot.url,
        kind: 'desktop',
        backend: options.backend.name,
        elements: capture.element_count,
        actions: Object.keys(actions).length,
        bytes: text.length,
    })

    return { agentmark: text, binding, capture }
}

function synthesiseDesktopUrl(capture: DesktopCapture): string {
    const host = capture.process_name?.toLowerCase().replace(/[^a-z0-9._-]/g, '_') ?? 'unknown'
    const path = capture.window_id ?? String(capture.process_id ?? 'window')
    return `desktop://${capture.platform}/${host}/${path}`
}

function stripUndefined<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
    return out as T
}

/**
 * `convertPdf()` — convert a PDF buffer into an AgentMark snapshot with
 * `kind: 'document'`. Mirrors the shape of `convertPage()` for web pages.
 *
 * Returns the same `ConversionResult` (serialized text + binding) so the
 * downstream LLM pipeline is identical regardless of the source surface.
 *
 * @example
 *   import { readFile } from 'node:fs/promises'
 *   import { convertPdf } from '@thinkfleet/agentmark'
 *
 *   const data = await readFile('./report.pdf')
 *   const { agentmark } = await convertPdf({ data, sourceUrl: 'file:///report.pdf' })
 *   console.log(agentmark)
 */

import {
    AGENTMARK_VERSION,
    type ConversionResult,
    type DocumentMeta,
    type Snapshot,
} from '../types'
import { buildBody } from '../extractors/body-builder'
import { serializeSnapshot } from '../serializers/yaml-frontmatter'
import { extractPdf } from './pdf-extractor'
import { buildBodyFromPdf, type BuildPdfBodyOptions } from './body-builder'
import { InMemoryActionBinding } from '../binding/action-binding'
import { noopLogger, type Logger } from '../observability/logger'
import { SnapshotError } from '../errors'

export interface ConvertPdfOptions {
    /** Raw PDF bytes (from `readFile`, `fetch`, etc.). */
    data: Uint8Array | ArrayBuffer
    /** URL or `file://` URI identifying the document source. Used as `snapshot.url`. */
    sourceUrl: string
    /** Override the document title. Default: PDF metadata title, or sourceUrl basename. */
    title?: string
    /** Password for encrypted PDFs. */
    password?: string
    /** Heading detection threshold passed to the body builder. Default: 1.3. */
    headingThreshold?: number
    /** TTL for `expires_at` (ms). Default: 1 hour. PDFs change less than web pages. */
    ttlMs?: number
    /** BCP-47 language tag, if known. */
    language?: string
    /** Logger for structured events. Default: noopLogger. */
    logger?: Logger
    /** Vendor extensions (`x-` prefix). */
    vendorExtensions?: Record<string, unknown>
    /** Extra body-builder options. */
    body?: BuildPdfBodyOptions
}

/**
 * Convert PDF bytes into an AgentMark snapshot.
 *
 * Throws `SnapshotError` on parse / extraction failure (wrapped from pdfjs-dist).
 * The optional peer dep `pdfjs-dist` must be installed; surface a clear error
 * if missing (see `pdfjs-loader.ts`).
 */
export async function convertPdf(options: ConvertPdfOptions): Promise<ConversionResult> {
    const logger = options.logger ?? noopLogger
    const ttlMs = options.ttlMs ?? 60 * 60_000 // 1 hour default — PDFs change rarely

    logger.debug('snapshot.capture.start', { source: options.sourceUrl, kind: 'document' })

    let extracted: Awaited<ReturnType<typeof extractPdf>>
    try {
        extracted = await extractPdf({ data: options.data, password: options.password })
    } catch (err) {
        logger.error('snapshot.failed', { error: (err as Error).message })
        // extractPdf wraps in SnapshotError already; pass through.
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError(`PDF extraction failed: ${(err as Error).message}`, err as Error)
    }

    const segments = buildBodyFromPdf(extracted, options.body ?? {})
    const body = buildBody(segments)

    const captured_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + ttlMs).toISOString()

    const documentMeta: DocumentMeta = {
        pages: extracted.metadata.pages,
        author: extracted.metadata.author,
        created_at: extracted.metadata.created_at,
        modified_at: extracted.metadata.modified_at,
        format: 'pdf',
        format_version: extracted.metadata.pdf_version,
        ocr_used: false,
    }

    const title =
        options.title
        ?? extracted.metadata.title
        ?? deriveTitleFromUrl(options.sourceUrl)

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        kind: 'document',
        url: options.sourceUrl,
        title,
        captured_at,
        expires_at,
        source: 'declared',
        language: options.language,
        document: stripUndefined(documentMeta),
        capabilities: {
            preview_media: false,
            expand_disclosures: false,
            paginate: true,
            scroll: true,
            keyboard: false,
            drag: false,
            ocr: documentMeta.ocr_used ?? false,
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
        source: options.sourceUrl,
        kind: 'document',
        pages: documentMeta.pages,
        segments: segments.length,
        bytes: text.length,
    })

    // PDFs have no interactive actions in this release (M3 will add AcroForm
    // support and populate the binding). Return an empty binding for now.
    return { agentmark: text, binding: new InMemoryActionBinding() }
}

function deriveTitleFromUrl(url: string): string {
    try {
        const u = new URL(url)
        const last = u.pathname.split('/').filter(Boolean).pop() ?? '(untitled)'
        return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '') || '(untitled)'
    } catch {
        return '(untitled)'
    }
}

function stripUndefined<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v
    }
    return out as T
}

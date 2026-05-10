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
    type ActionDefinition,
    type ConversionResult,
    type DocumentMeta,
    type Snapshot,
    type SnapshotKind,
} from '../types'
import { buildBody } from '../extractors/body-builder'
import { serializeSnapshot } from '../serializers/yaml-frontmatter'
import { extractPdf } from './pdf-extractor'
import { buildBodyFromPdf, type BuildPdfBodyOptions } from './body-builder'
import { InMemoryActionBinding } from '../binding/action-binding'
import { noopLogger, type Logger } from '../observability/logger'
import { SnapshotError } from '../errors'
import type {
    OcrPipelineOptions,
} from './ocr/types'
import type { ExtractedPdf, PdfTextItem } from './types'
import { extractAcroForm } from './forms/acroform-extractor'
import type { AcroFormField } from './forms/types'
import {
    detectSignatures,
    defaultDetectors,
    type DetectedSignature,
    type SignatureDetector,
} from './signatures'
import type { SignatureDescriptor } from '../types'

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
    /**
     * OCR pipeline configuration. When provided, pages with no extractable
     * text are rendered + OCR'd and the result is merged back into the
     * PdfDocument before body-building.
     */
    ocr?: OcrPipelineOptions
    /**
     * Custom signature-detector chain. When omitted, runs the default
     * detectors (AcroForm Sig widgets + heuristic image signatures).
     * Pass an empty array to disable signature detection entirely.
     */
    signatureDetectors?: SignatureDetector[]
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

    let ocrUsed = false
    if (options.ocr && options.ocr.mode !== 'never') {
        ocrUsed = await applyOcr(extracted, options.data, options.ocr, logger)
    }

    // Extract AcroForm fields (if any). PDFs with form fields get
    // `kind: 'form'` and an `actions` map; otherwise `kind: 'document'`.
    const acroform = await extractAcroForm({ data: options.data, password: options.password })
        .catch((err: Error) => {
            logger.warn('acroform.extract.failed', { error: err.message })
            return { fields: [] as AcroFormField[], hasFields: false }
        })

    // Detect signatures (AcroForm Sig widgets + heuristic image detection).
    // Empty array passed → user explicitly disabled detection.
    const detectorChain =
        options.signatureDetectors === undefined
            ? defaultDetectors()
            : options.signatureDetectors
    const rawBytes =
        options.data instanceof ArrayBuffer
            ? new Uint8Array(options.data)
            : new Uint8Array(options.data.buffer, options.data.byteOffset, options.data.byteLength)
    const signatures: DetectedSignature[] = detectorChain.length > 0
        ? await detectSignatures(
            { extracted, rawBytes, password: options.password },
            detectorChain,
        ).catch((err: Error) => {
            logger.warn('signatures.detect.failed', { error: err.message })
            return []
        })
        : []

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
        ocr_used: ocrUsed,
    }

    const title =
        options.title
        ?? extracted.metadata.title
        ?? deriveTitleFromUrl(options.sourceUrl)

    const kind: SnapshotKind = acroform.hasFields ? 'form' : 'document'

    const actions: Record<string, ActionDefinition> = {}
    for (const field of acroform.fields) {
        actions[field.actionId] = field.action
    }

    // Build the signatures map for the envelope, preserving the renumbered
    // IDs from detectSignatures.
    const signaturesMap: Record<string, SignatureDescriptor> = {}
    for (const sig of signatures) {
        signaturesMap[sig.id] = stripUndefined({
            kind: sig.kind,
            page: sig.page,
            rect: sig.rect,
            field_name: sig.field_name,
            inferred_role: sig.inferred_role,
            signer_name: sig.signer_name,
            signer_email: sig.signer_email,
            signed_at: sig.signed_at,
            confidence: sig.confidence,
            valid: sig.valid,
            notes: sig.notes,
        })
    }

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        kind,
        url: options.sourceUrl,
        title,
        captured_at,
        expires_at,
        source: 'declared',
        language: options.language,
        document: stripUndefined(documentMeta),
        actions: acroform.hasFields ? actions : undefined,
        signatures: signatures.length > 0 ? signaturesMap : undefined,
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
        kind,
        pages: documentMeta.pages,
        segments: segments.length,
        bytes: text.length,
        actions: Object.keys(actions).length,
    })

    // The binding maps each AcroForm action ID to the original PDF field
    // name — that's what a future fillPdf() / Document.save() will look up
    // when persisting changes back to the PDF.
    const binding = new InMemoryActionBinding()
    for (const field of acroform.fields) {
        binding.set(field.actionId, field.fieldName)
    }
    return { agentmark: text, binding }
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

/**
 * Apply the OCR pipeline to the extracted document, mutating it in place
 * with OCR'd text on pages that need it.
 *
 * Mode semantics:
 *   - 'auto'   (default): OCR pages with no extractable text
 *   - 'always':           OCR every page (overrides any extracted text)
 *   - 'never':            no-op (caller should have skipped this fn)
 *
 * Returns true if OCR was actually applied to ≥1 page.
 */
async function applyOcr(
    doc: ExtractedPdf,
    pdfData: Uint8Array | ArrayBuffer,
    options: OcrPipelineOptions,
    logger: Logger,
): Promise<boolean> {
    const mode = options.mode ?? 'auto'
    if (mode === 'never') return false

    const dpi = options.dpi ?? 150
    const language = options.language ?? 'eng'

    const dataView = pdfData instanceof ArrayBuffer
        ? new Uint8Array(pdfData)
        : new Uint8Array(pdfData.buffer, pdfData.byteOffset, pdfData.byteLength)

    let pagesProcessed = 0
    try {
        for (const page of doc.pages) {
            const hasText = page.items.some((it) => it.text.trim().length > 0)
            if (mode === 'auto' && hasText) continue

            logger.debug('ocr.page.start', {
                page: page.number,
                render: options.render.name,
                ocr: options.ocr.name,
            })

            const rendered = await options.render.renderPage(dataView, {
                pageNumber: page.number,
                dpi,
                format: 'png',
            })

            const result = await options.ocr.extractPage(rendered.image, {
                pageNumber: page.number,
                language,
                dpi,
            })

            // Replace items if OCR mode is 'always' or page had no text
            // (mode === 'auto' && !hasText). Either way, we overwrite.
            page.items = result.items?.length
                ? result.items
                : ocrTextToItems(result.text, page.height)

            pagesProcessed++
            logger.info('ocr.page.complete', {
                page: page.number,
                confidence: result.confidence,
                items: page.items.length,
            })
        }
    } finally {
        // Best-effort cleanup of long-lived resources (Tesseract worker, etc.).
        // Mocks may return undefined instead of a Promise, so wrap defensively.
        try { await Promise.resolve(options.ocr.close?.()) } catch { /* ignore */ }
        try { await Promise.resolve(options.render.close?.()) } catch { /* ignore */ }
    }

    return pagesProcessed > 0
}

/**
 * Fallback when an OCR backend returns plain text without word-level
 * positioning: synthesize a single text item per line so the body builder
 * still produces paragraph-level output.
 */
function ocrTextToItems(text: string, pageHeight: number): PdfTextItem[] {
    if (!text || !text.trim()) return []
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const items: PdfTextItem[] = []
    const lineHeight = 12 // pt — approximate body-text size
    for (let i = 0; i < lines.length; i++) {
        const y = pageHeight - 50 - i * lineHeight
        items.push({
            text: lines[i].trim(),
            fontSize: 11,
            fontName: 'ocr',
            x: 50,
            y,
            width: lines[i].length * 5.5,
            hasEol: true,
        })
    }
    return items
}

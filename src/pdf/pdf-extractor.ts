/**
 * Extract a structured PdfDocument from a PDF buffer using pdfjs-dist.
 *
 * Outputs raw items per page (text + position + font size). Higher-level
 * structural inference (headings, paragraphs, lists) lives in body-builder.
 */

import { loadPdfjs } from './pdfjs-loader'
import { SnapshotError } from '../errors'
import type { PdfDocument, PdfPage, PdfTextItem } from './types'

export interface ExtractPdfOptions {
    /** Raw PDF bytes (from `readFile`, `fetch`, etc.). */
    data: Uint8Array | ArrayBuffer
    /** Optional password, if the PDF is encrypted. */
    password?: string
}

export async function extractPdf(opts: ExtractPdfOptions): Promise<PdfDocument> {
    const pdfjs = await loadPdfjs()

    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
    try {
        const data = opts.data instanceof Uint8Array
            ? opts.data
            : new Uint8Array(opts.data)
        doc = await pdfjs.getDocument({
            data,
            password: opts.password,
            // Suppress pdfjs-dist's verbose console logging.
            verbosity: 0,
        }).promise
    } catch (err) {
        throw new SnapshotError(
            `Failed to open PDF: ${(err as Error).message}`,
            err as Error,
        )
    }

    const metadata = await readMetadata(doc)
    const pages: PdfPage[] = []

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1 })
        const text = await page.getTextContent({
            // Don't normalize whitespace — we do our own joining.
            includeMarkedContent: false,
        })

        const items: PdfTextItem[] = []
        for (const raw of text.items) {
            // Skip non-text items (marked-content is filtered above; this
            // catches anything else pdfjs may return).
            if (!('str' in raw)) continue
            // pdfjs's transform: [a, b, c, d, e, f]
            //   a = x scale (font size), e = x position, f = y position (top-left origin in viewport)
            const t = raw.transform
            if (!t || t.length < 6) continue
            items.push({
                text: raw.str,
                fontSize: Math.abs(t[3]) || Math.abs(t[0]),
                fontName: raw.fontName ?? 'unknown',
                x: t[4],
                y: t[5],
                width: raw.width ?? 0,
                hasEol: raw.hasEOL ?? false,
            })
        }

        pages.push({
            number: pageNum,
            width: viewport.width,
            height: viewport.height,
            items,
        })

        // Free the page resources. pdfjs holds references in a cache otherwise.
        page.cleanup()
    }

    await doc.destroy()

    return {
        pages,
        metadata: { ...metadata, pages: doc.numPages },
    }
}

interface PdfInfoFields {
    Title?: string
    Author?: string
    CreationDate?: string
    ModDate?: string
    PDFFormatVersion?: string
}

async function readMetadata(
    doc: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>,
): Promise<Omit<PdfDocument['metadata'], 'pages'>> {
    try {
        const m = await doc.getMetadata()
        const info = (m.info ?? {}) as PdfInfoFields
        return {
            title: typeof info.Title === 'string' ? info.Title : undefined,
            author: typeof info.Author === 'string' ? info.Author : undefined,
            created_at: parsePdfDate(info.CreationDate),
            modified_at: parsePdfDate(info.ModDate),
            pdf_version: typeof info.PDFFormatVersion === 'string' ? info.PDFFormatVersion : undefined,
        }
    } catch {
        // Some PDFs lack the info dict entirely — fall through with empty metadata.
        return {}
    }
}

/**
 * PDF dates are typically in the form `D:YYYYMMDDHHmmSS+HH'mm'`. Translate
 * to ISO 8601, returning undefined on parse failure.
 */
function parsePdfDate(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined
    const match = raw.match(
        /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(\d{2})'?(\d{2})?'?)?$/,
    )
    if (!match) return undefined
    const [, y, mo, d, h, mi, s, tz, tzh, tzm] = match
    const year = y
    const month = mo ?? '01'
    const day = d ?? '01'
    const hour = h ?? '00'
    const minute = mi ?? '00'
    const second = s ?? '00'
    let offset = 'Z'
    if (tz === '+' || tz === '-') {
        offset = `${tz}${tzh ?? '00'}:${tzm ?? '00'}`
    }
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`
    const parsed = Date.parse(iso)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

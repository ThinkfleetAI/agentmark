/**
 * Tesseract.js OCR backend.
 *
 * Runs Tesseract via WASM in-process — free, offline, no API key. Lower
 * accuracy than cloud OCR providers but handles clean text reasonably well.
 *
 * Maintains a long-lived `Worker` so the WASM + language data only loads
 * once. Call `close()` when done to terminate the worker.
 *
 * Requires the optional peer dependency:
 *   npm install tesseract.js@^5
 */

import { SnapshotError } from '../../errors'
import type { PdfTextItem } from '../types'
import type {
    OcrBackend,
    OcrPageOptions,
    OcrPageResult,
} from './types'

// Loaded lazily so callers without the dep don't pay the import cost.
type TesseractMod = typeof import('tesseract.js')
type TesseractWorker = Awaited<ReturnType<TesseractMod['createWorker']>>

export interface TesseractBackendOptions {
    /** BCP-47 language(s). Default: 'eng'. Use '+' for multi: 'eng+spa'. */
    language?: string
    /** Optional path to local cached training data (offline use). */
    cachePath?: string
}

export class TesseractOcrBackend implements OcrBackend {
    readonly name = 'tesseract'
    private workerPromise: Promise<TesseractWorker> | null = null
    private readonly defaultLanguage: string
    private readonly cachePath?: string

    constructor(options: TesseractBackendOptions = {}) {
        this.defaultLanguage = options.language ?? 'eng'
        this.cachePath = options.cachePath
    }

    async extractPage(image: Uint8Array, opts: OcrPageOptions): Promise<OcrPageResult> {
        const worker = await this.getWorker(opts.language ?? this.defaultLanguage)

        const result = await worker.recognize(Buffer.from(image))

        // tesseract.js returns confidence in 0-100; AgentMark uses 0-1.
        const confidence = (result.data.confidence ?? 0) / 100

        // Tesseract.js v5+ may not expose words in the default API; we accept
        // missing position info and emit a single text-only result. Body
        // builder will treat the OCR'd page as one paragraph block per page,
        // which is correct enough for v0.5.
        const items: PdfTextItem[] | undefined = extractItems(result, opts.dpi ?? 150)

        return {
            text: result.data.text ?? '',
            confidence,
            items,
        }
    }

    async close(): Promise<void> {
        if (!this.workerPromise) return
        const worker = await this.workerPromise.catch(() => null)
        this.workerPromise = null
        if (worker) await worker.terminate().catch(() => {})
    }

    private async getWorker(language: string): Promise<TesseractWorker> {
        if (this.workerPromise) return this.workerPromise

        this.workerPromise = (async () => {
            const tesseract = await loadTesseract()
            const opts: Parameters<TesseractMod['createWorker']>[2] = {}
            if (this.cachePath) opts.cachePath = this.cachePath
            return tesseract.createWorker(language, undefined, opts)
        })()

        return this.workerPromise
    }
}

async function loadTesseract(): Promise<TesseractMod> {
    try {
        return await import('tesseract.js')
    } catch (err) {
        throw new SnapshotError(
            'Tesseract OCR support requires the optional peer dependency tesseract.js. '
            + 'Install with: npm install tesseract.js@^5',
            err as Error,
        )
    }
}

/**
 * tesseract.js exposes word-level data on result.data.words in some builds.
 * When present we map to PdfTextItem so body-builder can do its normal
 * structural inference (heading detection, list grouping). When absent,
 * we return undefined and the OCR text becomes a single paragraph per page.
 */
function extractItems(
    result: Awaited<ReturnType<TesseractWorker['recognize']>>,
    dpi: number,
): PdfTextItem[] | undefined {
    interface Word {
        text: string
        confidence: number
        bbox: { x0: number; y0: number; x1: number; y1: number }
        font_size?: number
    }
    const words = (result.data as { words?: Word[] }).words
    if (!words || words.length === 0) return undefined

    // Convert pixel bbox → PDF user-space coords using DPI.
    // (1pt = 1/72 inch; pixel = 1/dpi inch; so pt-per-pixel = 72/dpi)
    const ptPerPx = 72 / dpi

    const items: PdfTextItem[] = []
    for (const w of words) {
        if (!w.text || !w.text.trim()) continue
        const x = w.bbox.x0 * ptPerPx
        const y = w.bbox.y1 * ptPerPx // bottom of bbox; PDF origin is bottom-left
        const width = (w.bbox.x1 - w.bbox.x0) * ptPerPx
        const height = (w.bbox.y1 - w.bbox.y0) * ptPerPx
        items.push({
            text: w.text,
            fontSize: w.font_size ?? height * 0.85, // height ≈ ascent + descent
            fontName: 'ocr',
            x,
            y,
            width,
            hasEol: false,
        })
    }
    return items
}

/**
 * Mistral OCR backend (cloud).
 *
 * Calls Mistral's OCR endpoint (https://api.mistral.ai/v1/ocr) which produces
 * markdown-formatted, layout-aware text from document images. Best quality
 * of the reference backends; cheap (~$1 per 1k pages at time of writing).
 *
 * Requires an API key:
 *   export MISTRAL_API_KEY=...
 *
 * No npm dependency needed — uses the global `fetch`.
 */

import { SnapshotError } from '../../errors'
import type { PdfTextItem } from '../types'
import type {
    OcrBackend,
    OcrPageOptions,
    OcrPageResult,
} from './types'

export interface MistralOcrOptions {
    /** Mistral API key. Defaults to env MISTRAL_API_KEY. */
    apiKey?: string
    /** Override the API endpoint (e.g. for a self-hosted proxy). */
    endpoint?: string
    /** OCR model identifier. Default: 'mistral-ocr-latest'. */
    model?: string
    /** Per-request timeout (ms). Default: 60000. */
    timeoutMs?: number
}

interface MistralOcrResponse {
    pages?: Array<{
        index?: number
        markdown?: string
        text?: string
        words?: Array<{
            text: string
            bbox?: [number, number, number, number] // [x0, y0, x1, y1] in image px
            confidence?: number
        }>
    }>
    text?: string
    markdown?: string
    confidence?: number
}

export class MistralOcrBackend implements OcrBackend {
    readonly name = 'mistral'
    private readonly apiKey: string
    private readonly endpoint: string
    private readonly model: string
    private readonly timeoutMs: number

    constructor(options: MistralOcrOptions = {}) {
        const apiKey = options.apiKey ?? process.env.MISTRAL_API_KEY
        if (!apiKey) {
            throw new SnapshotError(
                'MistralOcrBackend requires an API key. Set MISTRAL_API_KEY '
                + 'in the environment or pass { apiKey } to the constructor.',
            )
        }
        this.apiKey = apiKey
        this.endpoint = options.endpoint ?? 'https://api.mistral.ai/v1/ocr'
        this.model = options.model ?? 'mistral-ocr-latest'
        this.timeoutMs = options.timeoutMs ?? 60_000
    }

    async extractPage(image: Uint8Array, opts: OcrPageOptions): Promise<OcrPageResult> {
        const mimeType: 'image/png' | 'image/jpeg' = sniffMimeType(image)
        const base64 = Buffer.from(image).toString('base64')
        const dataUrl = `data:${mimeType};base64,${base64}`

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)

        let response: Response
        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    document: { type: 'image_url', image_url: dataUrl },
                }),
                signal: controller.signal,
            })
        } catch (err) {
            const e = err as Error & { name?: string }
            if (e.name === 'AbortError') {
                throw new SnapshotError(
                    `Mistral OCR request timed out after ${this.timeoutMs}ms`,
                    e,
                )
            }
            throw new SnapshotError(`Mistral OCR request failed: ${e.message}`, e)
        } finally {
            clearTimeout(timer)
        }

        if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new SnapshotError(
                `Mistral OCR returned ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
            )
        }

        const json = (await response.json()) as MistralOcrResponse
        const page = json.pages?.[0]
        const text = page?.markdown ?? page?.text ?? json.markdown ?? json.text ?? ''
        const confidence = json.confidence ?? avgConfidence(page?.words) ?? 0.85

        const items = page?.words ? wordsToItems(page.words, opts.dpi ?? 150) : undefined

        return {
            text,
            confidence,
            items,
            mimeType,
        }
    }
}

function sniffMimeType(image: Uint8Array): 'image/png' | 'image/jpeg' {
    if (image.length >= 4 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) {
        return 'image/png'
    }
    return 'image/jpeg'
}

function avgConfidence(words: Array<{ confidence?: number }> | undefined): number | null {
    if (!words || words.length === 0) return null
    const sum = words.reduce((acc, w) => acc + (w.confidence ?? 0), 0)
    return sum / words.length
}

function wordsToItems(
    words: Array<{ text: string; bbox?: [number, number, number, number]; confidence?: number }>,
    dpi: number,
): PdfTextItem[] {
    const ptPerPx = 72 / dpi
    const items: PdfTextItem[] = []
    for (const w of words) {
        if (!w.text?.trim() || !w.bbox) continue
        const [x0, y0, x1, y1] = w.bbox
        const height = (y1 - y0) * ptPerPx
        items.push({
            text: w.text,
            fontSize: height * 0.85,
            fontName: 'ocr',
            x: x0 * ptPerPx,
            y: y1 * ptPerPx,
            width: (x1 - x0) * ptPerPx,
            hasEol: false,
        })
    }
    return items
}

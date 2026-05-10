/**
 * OCR + page-rendering interfaces for AgentMark's PDF pipeline.
 *
 * The architecture splits cleanly:
 *
 *    PDF page  ──[RenderBackend]──►  PNG/JPEG bytes  ──[OcrBackend]──►  Text + positions
 *
 * Both interfaces are minimal so callers can plug in their own implementations
 * (AWS Textract, Google Document AI, Apple Vision Framework on macOS, etc.).
 *
 * Reference implementations bundled:
 *   - PopplerRenderBackend  — shells out to `pdftoppm` (system Poppler)
 *   - PdfjsRenderBackend    — pure-Node via pdfjs-dist + node-canvas
 *   - TesseractOcrBackend   — in-process WASM via tesseract.js
 *   - MistralOcrBackend     — Mistral OCR cloud API
 */

import type { PdfTextItem } from '../types'

// ──────────────────────────────────────────────────────────────────────────
// Render backend
// ──────────────────────────────────────────────────────────────────────────

export interface RenderPageOptions {
    /** 1-indexed page number to render. */
    pageNumber: number
    /** DPI for rasterization. Higher = sharper but slower / larger. Default: 150. */
    dpi?: number
    /** Output format. Default: 'png'. */
    format?: 'png' | 'jpeg'
}

export interface RenderedPage {
    /** Raw image bytes in the requested format. */
    image: Uint8Array
    /** MIME type of `image`. */
    mimeType: 'image/png' | 'image/jpeg'
    /** Rendered width in pixels. */
    width: number
    /** Rendered height in pixels. */
    height: number
    /** DPI used. */
    dpi: number
}

/**
 * Convert PDF pages into images. Implementations may share resources
 * (e.g. a long-lived pdftoppm subprocess or a pdfjs-dist document handle).
 */
export interface RenderBackend {
    /** Implementation name — used in logs and source-mode reports. */
    readonly name: string
    /** Render a single page from PDF bytes. */
    renderPage(pdfData: Uint8Array, options: RenderPageOptions): Promise<RenderedPage>
    /** Optional: dispose of any long-lived resources (subprocess, doc handle). */
    close?(): Promise<void>
}

// ──────────────────────────────────────────────────────────────────────────
// OCR backend
// ──────────────────────────────────────────────────────────────────────────

export interface OcrPageOptions {
    /** 1-indexed page number — used for logging / structured output. */
    pageNumber: number
    /** BCP-47 language hint. Default: 'eng'. */
    language?: string
    /** Render DPI of the input image (helps OCR backends with sizing). */
    dpi?: number
}

export interface OcrPageResult {
    /** Raw extracted text, joined in reading order. */
    text: string
    /** Average confidence for the page in 0-1 (higher = more confident). */
    confidence: number
    /**
     * Optional fine-grained items mirroring the regular extractor's PdfTextItem.
     * When provided, body-builder can reuse the same structural inference
     * (heading detection, list grouping, etc.) on OCR'd output.
     */
    items?: PdfTextItem[]
    /** Original mime type of the input image — useful for debugging. */
    mimeType?: 'image/png' | 'image/jpeg'
}

export interface OcrBackend {
    /** Implementation name — surfaces in `document.ocr_used` flag context. */
    readonly name: string
    /**
     * Extract text from a rendered page image. Implementations may batch
     * internally; AgentMark calls this serially per page.
     */
    extractPage(image: Uint8Array, options: OcrPageOptions): Promise<OcrPageResult>
    /** Optional cleanup — terminate workers, close API connections, etc. */
    close?(): Promise<void>
}

// ──────────────────────────────────────────────────────────────────────────
// Combined OCR pipeline configuration
// ──────────────────────────────────────────────────────────────────────────

export interface OcrPipelineOptions {
    render: RenderBackend
    ocr: OcrBackend
    /** DPI to render at. Default: 150 (good text/cost tradeoff). */
    dpi?: number
    /** OCR language. Default: 'eng'. */
    language?: string
    /**
     * When to invoke OCR per page:
     *   - 'auto'        OCR a page only when text extraction yielded nothing (default)
     *   - 'always'      OCR every page (overrides any extracted text)
     *   - 'never'       Disable OCR entirely (same as omitting `ocr` from convertPdf)
     */
    mode?: 'auto' | 'always' | 'never'
}

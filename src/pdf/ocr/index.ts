/**
 * OCR + render-backend module.
 *
 * Public API:
 *   - Types:           OcrBackend, RenderBackend, OcrPipelineOptions
 *   - Render backends: PopplerRenderBackend (system pdftoppm),
 *                      PdfjsRenderBackend (pdfjs-dist + node-canvas)
 *   - OCR backends:    TesseractOcrBackend (in-process WASM, free),
 *                      MistralOcrBackend (cloud API, best quality)
 *
 * Ship-your-own implementations of either interface — AWS Textract,
 * Google Document AI, Apple Vision, etc. all fit the same shape.
 */

export type {
    RenderBackend,
    RenderPageOptions,
    RenderedPage,
    OcrBackend,
    OcrPageOptions,
    OcrPageResult,
    OcrPipelineOptions,
} from './types'

export { PopplerRenderBackend } from './poppler-render'
export type { PopplerRenderOptions } from './poppler-render'

export { PdfjsRenderBackend } from './pdfjs-render'

export { TesseractOcrBackend } from './tesseract-backend'
export type { TesseractBackendOptions } from './tesseract-backend'

export { MistralOcrBackend } from './mistral-backend'
export type { MistralOcrOptions } from './mistral-backend'

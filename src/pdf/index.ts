/**
 * PDF support module.
 *
 * Public entry point: `convertPdf()` produces a `kind: 'document'` AgentMark
 * snapshot from PDF bytes. Mirrors the shape of `convertPage()` for web pages.
 */

export { convertPdf } from './pdf-converter'
export type { ConvertPdfOptions } from './pdf-converter'
export { extractPdf } from './pdf-extractor'
export type { ExtractPdfOptions } from './pdf-extractor'
export { buildBodyFromPdf } from './body-builder'
export type { BuildPdfBodyOptions } from './body-builder'
export type {
    ExtractedPdf,
    PdfDocumentMeta,
    PdfPage,
    PdfTextItem,
    PdfBlock,
} from './types'

// ── OCR + render-backend module ──────────────────────────────────────────
export {
    PopplerRenderBackend,
    PdfjsRenderBackend,
    TesseractOcrBackend,
    MistralOcrBackend,
} from './ocr'
export type {
    PopplerRenderOptions,
    TesseractBackendOptions,
    MistralOcrOptions,
    RenderBackend,
    RenderPageOptions,
    RenderedPage,
    OcrBackend,
    OcrPageOptions,
    OcrPageResult,
    OcrPipelineOptions,
} from './ocr'

// ── M3: AcroForm support (kind: 'form') ──────────────────────────────────
export { extractAcroForm, PdfDocument, openPdfDocument } from './forms'
export type {
    ExtractAcroFormOptions,
    AcroFormExtraction,
    AcroFormField,
    AcroFormFieldKind,
    OpenPdfDocumentOptions,
    PdfDocumentSnapshot,
    SaveOptions,
} from './forms'

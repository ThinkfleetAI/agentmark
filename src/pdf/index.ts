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
    PdfDocument,
    PdfDocumentMeta,
    PdfPage,
    PdfTextItem,
    PdfBlock,
} from './types'

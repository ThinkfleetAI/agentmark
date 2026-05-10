/**
 * AcroForm support — extract fillable PDF form fields as AgentMark actions.
 *
 * Public API:
 *   - extractAcroForm() — read all form fields from a PDF
 *   - AcroFormField / AcroFormFieldKind — typed result shapes
 *
 * `convertPdf()` calls into this module automatically when the PDF declares
 * form fields, setting `kind: 'form'` on the resulting snapshot.
 */

export { extractAcroForm } from './acroform-extractor'
export type {
    ExtractAcroFormOptions,
    AcroFormExtraction,
} from './acroform-extractor'
export type { AcroFormField, AcroFormFieldKind } from './types'

export { PdfDocument, openPdfDocument } from './document'
export type {
    OpenPdfDocumentOptions,
    PdfDocumentSnapshot,
    SaveOptions,
} from './document'

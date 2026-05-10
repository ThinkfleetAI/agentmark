/**
 * Internal PDF extraction types — the structured intermediate between
 * pdfjs-dist's text-content output and AgentMark's body grammar.
 */

export interface PdfTextItem {
    /** Plain text run. */
    text: string
    /** Font height in PDF user-space units. */
    fontSize: number
    /** Font name from the PDF's font dictionary. */
    fontName: string
    /** X position (left edge), PDF user space. */
    x: number
    /** Y position (baseline), PDF user space (origin bottom-left). */
    y: number
    /** Width of the run, PDF user space. */
    width: number
    /** Whether this item ends with whitespace requiring a join space. */
    hasEol: boolean
}

export interface PdfPage {
    /** 1-indexed page number. */
    number: number
    /** Page width in PDF user space. */
    width: number
    /** Page height in PDF user space. */
    height: number
    /** Items in document order (top-to-bottom, left-to-right within line). */
    items: PdfTextItem[]
}

/**
 * The structured result of PDF text extraction. Renamed from `PdfDocument`
 * in v0.6 to avoid collision with the public `PdfDocument` *class* (which
 * wraps an `ExtractedPdf` plus mutation state for filling forms).
 */
export interface ExtractedPdf {
    pages: PdfPage[]
    metadata: PdfDocumentMeta
}

export interface PdfDocumentMeta {
    title?: string
    author?: string
    /** ISO 8601 if parseable. */
    created_at?: string
    modified_at?: string
    /** Format version reported by the PDF (e.g. "1.7"). */
    pdf_version?: string
    /** Total page count. */
    pages: number
}

/**
 * A higher-level structural block — what we actually emit to AgentMark.
 * One PDF page typically becomes many blocks.
 */
export type PdfBlock =
    | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; page: number }
    | { kind: 'paragraph'; text: string; page: number }
    | { kind: 'list'; ordered: boolean; items: string[]; page: number }
    | { kind: 'page_break'; page: number }

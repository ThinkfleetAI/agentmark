/**
 * Vision-based signature detector.
 *
 * Renders each candidate page to an image and asks a vision model
 * (Claude / OpenAI / etc.) to identify signatures with bounding boxes,
 * inferred role, and signer name when visible.
 *
 * This is the only signature detector that catches:
 *   - Hand-signed scans (whole page is one rasterized image)
 *   - Signatures without nearby labels
 *   - Typed cursive-font signatures
 *   - "X______" lines marked as signed in their visual context
 *
 * Cost-conscious by default: scans only the LAST `maxPages` pages where
 * signatures usually live. Override with `pages: 'all'` to scan everywhere.
 */

import type { RenderBackend } from '../ocr/types'
import type { VisionBackend } from '../vision/types'
import type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
} from './types'

export interface VisionSignatureDetectorOptions {
    /** Renders PDF pages to images. */
    render: RenderBackend
    /** Vision model used for analysis. */
    vision: VisionBackend
    /**
     * Which pages to scan:
     *   - 'all' — every page
     *   - 'last' — only the last 2 pages (default; signatures usually here)
     *   - 'flagged' — only pages whose extracted text contains a signature label
     *   - number[] — specific 1-indexed page numbers
     */
    pages?: 'all' | 'last' | 'flagged' | number[]
    /** Number of pages to scan when pages='last'. Default: 2. */
    lastPagesCount?: number
    /** DPI for rasterization. Default: 150. */
    dpi?: number
    /** Min confidence threshold from the vision model. Default: 0.5. */
    minConfidence?: number
}

interface VisionResponse {
    signatures: Array<{
        kind?:
            | 'image_handwritten'
            | 'image_typed'
            | 'widget_unsigned'
            | 'unknown'
        bbox?: { x: number; y: number; width: number; height: number } // normalized 0-1
        inferred_role?: string
        signer_name?: string
        confidence: number
        notes?: string
    }>
}

const SIGNATURE_HINT_RE = /\b(signature|signed\s*by|sign\s*here|initial(?:s|ed)?|x\s*[:_])\b/i

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['signatures'],
    properties: {
        signatures: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['confidence'],
                properties: {
                    kind: {
                        type: 'string',
                        enum: ['image_handwritten', 'image_typed', 'widget_unsigned', 'unknown'],
                    },
                    bbox: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['x', 'y', 'width', 'height'],
                        properties: {
                            x: { type: 'number', minimum: 0, maximum: 1 },
                            y: { type: 'number', minimum: 0, maximum: 1 },
                            width: { type: 'number', minimum: 0, maximum: 1 },
                            height: { type: 'number', minimum: 0, maximum: 1 },
                        },
                    },
                    inferred_role: { type: 'string' },
                    signer_name: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    notes: { type: 'string' },
                },
            },
        },
    },
}

const PROMPT =
    'You are analyzing a single page of a document to find SIGNATURES on it. '
    + 'A signature is a handwritten name, a typed cursive name acting as a signature, '
    + 'or a clearly visible signature widget that has been signed. Do NOT report '
    + 'empty signature lines, signature boxes that have not been signed, or '
    + 'signature *labels* (the text "Signature:" alone is not a signature). '
    + 'For EACH signature you find, report:\n'
    + '  - kind: image_handwritten | image_typed | widget_unsigned | unknown\n'
    + '  - bbox: normalized [0,1] x/y/width/height (origin top-left)\n'
    + '  - inferred_role: the role of the signer based on the page\'s context '
    + '(client, agent, broker, buyer, seller, tenant, landlord, witness, '
    + 'notary, attorney, employee, employer, applicant, etc). Use lowercase. '
    + 'Use "unknown" if you cannot tell.\n'
    + '  - signer_name: the name of the person if visible (e.g. printed below '
    + 'the signature, or the typed cursive itself). Omit if not visible.\n'
    + '  - confidence: 0-1 (your confidence this is actually a signature, '
    + 'not just an empty line or label).\n'
    + '  - notes: 1 short sentence with anything useful (\"signature is on the '
    + 'right side of the page next to a tenant label\").\n\n'
    + 'If there are NO signatures on this page, return an empty array. Do not '
    + 'invent signatures. Be precise with bbox coordinates.'

export class VisionSignatureDetector implements SignatureDetector {
    readonly name = 'vision'
    private readonly opts: VisionSignatureDetectorOptions

    constructor(opts: VisionSignatureDetectorOptions) {
        this.opts = opts
    }

    async detect(input: SignatureDetectorInput): Promise<DetectedSignature[]> {
        const totalPages = input.extracted.pages.length
        if (totalPages === 0) return []

        const pages = this.resolvePagesToScan(input, totalPages)
        if (pages.length === 0) return []

        const minConfidence = this.opts.minConfidence ?? 0.5
        const dpi = this.opts.dpi ?? 150

        const detections: DetectedSignature[] = []
        let counter = 0

        for (const pageNum of pages) {
            const rendered = await this.opts.render.renderPage(input.rawBytes, {
                pageNumber: pageNum,
                dpi,
                format: 'png',
            }).catch(() => null)
            if (!rendered) continue

            const result = await this.opts.vision
                .analyze<VisionResponse>({
                    image: rendered.image,
                    mimeType: rendered.mimeType,
                    prompt: PROMPT,
                    schema: SCHEMA,
                    schemaName: 'report_signatures',
                    maxTokens: 1024,
                })
                .catch(() => null)

            const signatures = result?.structured?.signatures ?? []
            const page = input.extracted.pages.find((p) => p.number === pageNum)
            const pageWidth = page?.width ?? rendered.width
            const pageHeight = page?.height ?? rendered.height

            for (const sig of signatures) {
                if (sig.confidence < minConfidence) continue
                counter++

                // Convert normalized 0-1 bbox to PDF user-space rect.
                // pdf-extractor uses origin bottom-left so we flip Y.
                let rect: DetectedSignature['rect']
                if (sig.bbox) {
                    rect = {
                        x: sig.bbox.x * pageWidth,
                        y: pageHeight - (sig.bbox.y + sig.bbox.height) * pageHeight,
                        width: sig.bbox.width * pageWidth,
                        height: sig.bbox.height * pageHeight,
                    }
                }

                detections.push({
                    id: `sig_v_${counter}`,
                    kind: sig.kind ?? 'image_handwritten',
                    page: pageNum,
                    rect,
                    inferred_role: sig.inferred_role && sig.inferred_role !== 'unknown'
                        ? sig.inferred_role.toLowerCase()
                        : undefined,
                    signer_name: sig.signer_name,
                    confidence: sig.confidence,
                    notes: sig.notes
                        ? `Vision (${this.opts.vision.name}): ${sig.notes}`
                        : `Detected via ${this.opts.vision.name} vision`,
                })
            }
        }
        return detections
    }

    private resolvePagesToScan(
        input: SignatureDetectorInput,
        totalPages: number,
    ): number[] {
        const mode = this.opts.pages ?? 'last'
        if (Array.isArray(mode)) {
            return mode.filter((p) => p >= 1 && p <= totalPages)
        }
        if (mode === 'all') {
            return Array.from({ length: totalPages }, (_, i) => i + 1)
        }
        if (mode === 'last') {
            const count = Math.min(this.opts.lastPagesCount ?? 2, totalPages)
            return Array.from({ length: count }, (_, i) => totalPages - count + 1 + i)
        }
        if (mode === 'flagged') {
            return input.extracted.pages
                .filter((p) => p.items.some((it) => SIGNATURE_HINT_RE.test(it.text)))
                .map((p) => p.number)
        }
        return []
    }
}

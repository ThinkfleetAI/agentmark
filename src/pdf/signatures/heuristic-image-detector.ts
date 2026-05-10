/**
 * Heuristic image-signature detector.
 *
 * Walks each PDF page's operator list looking for `paintImageXObject` ops,
 * computes the image's user-space rectangle from the current transform
 * matrix, then filters down to signature-shaped images (aspect ratio,
 * size range, position on page) AND requires proximity to either:
 *   - explicit signature labels ("Signature", "Sign here", "X")
 *   - any role keyword ("Tenant", "Buyer", etc.)
 *
 * Heuristic-only — no vision model. False positives are bounded by the
 * proximity-to-label requirement; a vision detector layer can be added
 * later for higher recall on docs with no labels.
 */

import { loadPdfjs } from '../pdfjs-loader'
import { inferRoleFromNearbyText } from './role-inference'
import type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
} from './types'

export interface HeuristicImageDetectorOptions {
    /** Max signature aspect ratio (width / height). Default: 12 (very wide is OK; signatures are wider than tall). */
    maxAspectRatio?: number
    /** Min signature aspect ratio. Default: 1.2. */
    minAspectRatio?: number
    /** Min width in PDF points. Default: 60 (~0.83 inch). */
    minWidth?: number
    /** Max width. Default: 400 (~5.5 inch). */
    maxWidth?: number
    /** Min height. Default: 12 (~0.17 inch). */
    minHeight?: number
    /** Max height. Default: 100 (~1.4 inch). */
    maxHeight?: number
}

const DEFAULTS: Required<HeuristicImageDetectorOptions> = {
    maxAspectRatio: 12,
    minAspectRatio: 1.2,
    minWidth: 60,
    maxWidth: 400,
    minHeight: 12,
    maxHeight: 100,
}

export class HeuristicImageSignatureDetector implements SignatureDetector {
    readonly name = 'heuristic_image'
    private readonly opts: Required<HeuristicImageDetectorOptions>

    constructor(options: HeuristicImageDetectorOptions = {}) {
        this.opts = { ...DEFAULTS, ...options }
    }

    async detect(input: SignatureDetectorInput): Promise<DetectedSignature[]> {
        const detections: DetectedSignature[] = []
        const pdfjs = await loadPdfjs()

        // Defensive copy — pdfjs may detach the buffer.
        const data = new Uint8Array(input.rawBytes)
        const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise

        try {
            const ops = pdfjs.OPS as Record<string, number>
            const PAINT = ops.paintImageXObject
            const PAINT_INLINE = ops.paintInlineImageXObject
            const TRANSFORM = ops.transform
            const SAVE = ops.save
            const RESTORE = ops.restore

            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const page = await doc.getPage(pageNum)
                const opList = await page.getOperatorList()
                const fns = opList.fnArray
                const args = opList.argsArray

                // Walk operators tracking the current transform matrix (CTM).
                // This is a simplified model that handles the common forms;
                // pdfjs's actual coordinate handling is more elaborate but
                // for image-position heuristics this suffices.
                const stack: number[][] = [identity()]
                let ctm = stack[0]

                let imageCounter = 0
                for (let i = 0; i < fns.length; i++) {
                    const fn = fns[i]
                    if (fn === SAVE) {
                        ctm = clone(ctm)
                        stack.push(ctm)
                    } else if (fn === RESTORE) {
                        stack.pop()
                        ctm = stack[stack.length - 1] ?? identity()
                    } else if (fn === TRANSFORM) {
                        const m = args[i] as number[]
                        if (m && m.length >= 6) ctm = multiply(ctm, m)
                    } else if (fn === PAINT || fn === PAINT_INLINE) {
                        // Image XObject is painted with the current CTM scaled
                        // to fit a unit-square (0,0)-(1,1).
                        const rect = ctmToRect(ctm)
                        if (this.looksLikeSignature(rect)) {
                            imageCounter++
                            const detection = this.tryDetect(
                                input,
                                pageNum,
                                rect,
                                imageCounter,
                            )
                            if (detection) detections.push(detection)
                        }
                    }
                }
                page.cleanup()
            }
        } finally {
            await doc.destroy()
        }
        return detections
    }

    private looksLikeSignature(rect: { x: number; y: number; width: number; height: number }): boolean {
        const { width, height } = rect
        if (width <= 0 || height <= 0) return false
        if (width < this.opts.minWidth || width > this.opts.maxWidth) return false
        if (height < this.opts.minHeight || height > this.opts.maxHeight) return false
        const aspect = width / height
        if (aspect < this.opts.minAspectRatio || aspect > this.opts.maxAspectRatio) return false
        return true
    }

    private tryDetect(
        input: SignatureDetectorInput,
        page: number,
        rect: { x: number; y: number; width: number; height: number },
        counter: number,
    ): DetectedSignature | null {
        // Check proximity to a signature-related label or role keyword.
        const roleHit = inferRoleFromNearbyText(input.extracted, { page, rect })
        const sigLabelHit = hasSignatureLabel(input.extracted, page, rect)

        // Require AT LEAST one positive signal. An anonymous image
        // somewhere on the page is too noisy to call a signature.
        if (!roleHit && !sigLabelHit) return null

        const confidence = roleHit && sigLabelHit
            ? 0.85
            : roleHit
                ? 0.7
                : 0.55

        const notes = roleHit
            ? `Role from nearby text: "${roleHit.snippet}"`
            : 'Image is signature-shaped near a "Signature/Sign/X" label, but no role inferred'

        return {
            id: `sig_h_${page}_${counter}`,
            kind: 'image_handwritten',
            page,
            rect,
            inferred_role: roleHit?.role,
            confidence,
            notes,
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// CTM helpers
// ──────────────────────────────────────────────────────────────────────────

function identity(): number[] {
    return [1, 0, 0, 1, 0, 0]
}

function clone(m: number[]): number[] {
    return [m[0], m[1], m[2], m[3], m[4], m[5]]
}

/**
 * PDF matrix multiplication (3×3 affine, encoded as [a b c d e f]):
 *
 *   | a  b  0 |
 *   | c  d  0 |
 *   | e  f  1 |
 *
 * `m1` is the existing CTM, `m2` is being concat'd onto it.
 */
function multiply(m1: number[], m2: number[]): number[] {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]
}

/**
 * Convert a CTM into the user-space rect of the unit square (0,0)-(1,1).
 * Image XObjects are by convention drawn into the unit square; the
 * transform matrix encodes their actual size + position.
 */
function ctmToRect(ctm: number[]): { x: number; y: number; width: number; height: number } {
    // The unit square's corners are (0,0), (1,0), (0,1), (1,1).
    // After transform: each corner is (a*x + c*y + e, b*x + d*y + f).
    const [a, b, c, d, e, f] = ctm
    const xs = [e, a + e, c + e, a + c + e]
    const ys = [f, b + f, d + f, b + d + f]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Label proximity helper
// ──────────────────────────────────────────────────────────────────────────

const SIGNATURE_LABEL_RE = /\b(signature|signed|sign\s*here|x\s*[:_]|initials?)\b/i

function hasSignatureLabel(
    pdf: import('../types').ExtractedPdf,
    pageNum: number,
    rect: { x: number; y: number; width: number; height: number },
): boolean {
    const page = pdf.pages.find((p) => p.number === pageNum)
    if (!page) return false

    const radius = 80
    const top = rect.y + rect.height + radius
    const bottom = rect.y - radius * 0.25
    const left = rect.x - radius
    const right = rect.x + rect.width + radius

    for (const item of page.items) {
        if (item.y < bottom || item.y > top) continue
        const itemRight = item.x + (item.width || 0)
        if (itemRight < left || item.x > right) continue
        if (SIGNATURE_LABEL_RE.test(item.text)) return true
    }
    return false
}

/**
 * Signature-detection module.
 *
 * Public API:
 *   - detectSignatures(input, detectors?) — runs all configured detectors
 *     and merges results
 *   - AcroFormSignatureDetector / HeuristicImageSignatureDetector — bundled
 *     reference implementations
 *   - SignatureDetector / DetectedSignature / SignatureKind / SignatureRole types
 */

import type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
} from './types'
import { AcroFormSignatureDetector } from './acroform-detector'
import { HeuristicImageSignatureDetector } from './heuristic-image-detector'
import { LabelPatternSignatureDetector } from './label-pattern-detector'

export type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
    SignatureKind,
    SignatureRole,
} from './types'
export { AcroFormSignatureDetector } from './acroform-detector'
export {
    HeuristicImageSignatureDetector,
} from './heuristic-image-detector'
export type {
    HeuristicImageDetectorOptions,
} from './heuristic-image-detector'
export { LabelPatternSignatureDetector } from './label-pattern-detector'
export { VisionSignatureDetector } from './vision-detector'
export type { VisionSignatureDetectorOptions } from './vision-detector'
export {
    inferRoleFromFieldName,
    inferRoleFromNearbyText,
} from './role-inference'

/**
 * Default detector chain — runs AcroForm detection first (cheap + reliable),
 * then heuristic image detection. Override by passing a custom array.
 */
export function defaultDetectors(): SignatureDetector[] {
    return [
        new AcroFormSignatureDetector(),
        new LabelPatternSignatureDetector(),
        new HeuristicImageSignatureDetector(),
    ]
}

/**
 * Run a chain of detectors and merge results, deduping overlapping
 * detections by (page, IoU > 0.5). Renumbers IDs to a clean `sig_1` …
 * `sig_N` ordering across all detectors.
 */
export async function detectSignatures(
    input: SignatureDetectorInput,
    detectors: SignatureDetector[] = defaultDetectors(),
): Promise<DetectedSignature[]> {
    const all: DetectedSignature[] = []
    for (const d of detectors) {
        try {
            const found = await d.detect(input)
            for (const f of found) all.push(f)
        } catch {
            // Detectors are best-effort; one failing should not abort the others.
        }
    }
    const merged = deduplicate(all)
    // Renumber to clean sig_1 .. sig_N
    return merged.map((sig, i) => ({ ...sig, id: `sig_${i + 1}` }))
}

/**
 * Drop duplicates: when two detections on the same page overlap by IoU > 0.5,
 * keep the one with higher confidence.
 */
function deduplicate(detections: DetectedSignature[]): DetectedSignature[] {
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
    const kept: DetectedSignature[] = []
    for (const candidate of sorted) {
        const overlap = kept.find(
            (k) => k.page === candidate.page && k.rect && candidate.rect && iou(k.rect, candidate.rect) > 0.5,
        )
        if (!overlap) kept.push(candidate)
    }
    return kept
}

interface Rect { x: number; y: number; width: number; height: number }

function iou(a: Rect, b: Rect): number {
    const ax2 = a.x + a.width
    const ay2 = a.y + a.height
    const bx2 = b.x + b.width
    const by2 = b.y + b.height
    const ix1 = Math.max(a.x, b.x)
    const iy1 = Math.max(a.y, b.y)
    const ix2 = Math.min(ax2, bx2)
    const iy2 = Math.min(ay2, by2)
    const iw = Math.max(0, ix2 - ix1)
    const ih = Math.max(0, iy2 - iy1)
    const inter = iw * ih
    const aArea = a.width * a.height
    const bArea = b.width * b.height
    const union = aArea + bArea - inter
    return union <= 0 ? 0 : inter / union
}

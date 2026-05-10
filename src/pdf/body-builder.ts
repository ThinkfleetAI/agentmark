/**
 * Convert a structured PdfDocument into AgentMark `BodySegment[]` ready for
 * the existing serializer pipeline.
 *
 * The hard problem here is that PDFs have no semantic structure — only
 * positioned glyphs. This builder uses lightweight heuristics:
 *
 *   - Lines are reconstructed by Y-coordinate clustering within a page.
 *   - Headings are inferred from outlier (larger) font sizes.
 *   - Lists are inferred from leading bullet glyphs or "1.", "2." patterns.
 *   - Page boundaries become explicit `[PAGE:p_n]` markers.
 *
 * Heuristics are intentionally conservative — false positives (mistakenly
 * promoted headings, missed lists) hurt agent comprehension less than
 * overreach. Tables are deliberately skipped in v0.2; better-than-nothing
 * text fallback ships, structural detection deferred to a later release.
 */

import type { BodySegment } from '../extractors/dom-extractor'
import type { PdfDocument, PdfPage, PdfTextItem } from './types'

export interface BuildPdfBodyOptions {
    /** Multiplier on median font size above which text is promoted to a heading.
     *  Default: 1.3 — fairly conservative. */
    headingThreshold?: number
}

/**
 * Top-level: convert a parsed PdfDocument to AgentMark body segments.
 * Each page emits a `[PAGE:p_N]` tag followed by its text segments.
 */
export function buildBodyFromPdf(doc: PdfDocument, opts: BuildPdfBodyOptions = {}): BodySegment[] {
    const headingThreshold = opts.headingThreshold ?? 1.3
    const allSizes = collectAllFontSizes(doc)
    const sortedDescending = [...allSizes].sort((a, b) => b - a)
    // Top 3 distinct sizes map to h1/h2/h3 if the document uses multiple sizes.
    // Otherwise we fall back to median-based heading detection per page.
    const topSizes = uniqueDescending(sortedDescending, 4)
    const median = computeMedian(allSizes)

    const segments: BodySegment[] = []

    for (const page of doc.pages) {
        if (page.items.length === 0) {
            // Empty page (e.g. pure-image page that needs OCR — coming in M2 Pass 3).
            segments.push({ kind: 'tag', tag: 'PAGE', ref: pageRef(page.number) })
            continue
        }

        segments.push({ kind: 'tag', tag: 'PAGE', ref: pageRef(page.number) })

        const lines = groupItemsIntoLines(page)
        const blocks = linesToBlocks(lines, median, topSizes, headingThreshold, page.height)
        segments.push(...blocks)
    }

    return segments
}

// ────────────────────────────────────────────────────────────────────────
// Line reconstruction
// ────────────────────────────────────────────────────────────────────────

interface PdfLine {
    /** Y baseline of the line. */
    y: number
    /** Maximum font size on this line — used as the line's "size class". */
    maxFontSize: number
    /** Concatenated text. */
    text: string
    /** X position of the first item — used for indentation hints. */
    leftX: number
}

/**
 * Cluster items by Y-coordinate. Items whose baselines are within
 * `Y_TOLERANCE * fontSize` belong to the same visual line.
 */
function groupItemsIntoLines(page: PdfPage): PdfLine[] {
    const Y_TOLERANCE = 0.5
    // Sort by Y descending (PDF origin is bottom-left, so larger Y = higher
    // on the page = comes first in reading order).
    const items = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)

    const lines: PdfLine[] = []
    let current: PdfTextItem[] = []
    let currentY: number | null = null

    for (const item of items) {
        if (!item.text) continue
        const tolerance = Math.max(item.fontSize * Y_TOLERANCE, 1)
        if (currentY === null || Math.abs(item.y - currentY) <= tolerance) {
            if (currentY === null) currentY = item.y
            current.push(item)
        } else {
            if (current.length > 0) lines.push(buildLine(current))
            current = [item]
            currentY = item.y
        }
    }
    if (current.length > 0) lines.push(buildLine(current))

    return lines
}

function buildLine(items: PdfTextItem[]): PdfLine {
    // Sort by X ascending so reading order is preserved.
    const sorted = [...items].sort((a, b) => a.x - b.x)
    const text = sorted
        .map((it) => it.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    const maxFontSize = sorted.reduce((m, it) => Math.max(m, it.fontSize), 0)
    return {
        y: sorted[0]?.y ?? 0,
        maxFontSize,
        text,
        leftX: sorted[0]?.x ?? 0,
    }
}

// ────────────────────────────────────────────────────────────────────────
// Block detection (lines → segments)
// ────────────────────────────────────────────────────────────────────────

function linesToBlocks(
    lines: PdfLine[],
    median: number,
    topSizes: number[],
    headingThreshold: number,
    pageHeight: number,
): BodySegment[] {
    const segments: BodySegment[] = []
    const PARAGRAPH_GAP_FACTOR = 1.6

    let paragraphBuffer: string[] = []
    let prevY: number | null = null
    let prevSize: number | null = null
    let listBuffer: { ordered: boolean; items: string[] } | null = null

    const flushParagraph = () => {
        if (paragraphBuffer.length > 0) {
            const text = paragraphBuffer.join(' ').trim()
            if (text) segments.push({ kind: 'paragraph', text })
            paragraphBuffer = []
        }
    }
    const flushList = () => {
        if (listBuffer && listBuffer.items.length > 0) {
            segments.push({ kind: 'list', ordered: listBuffer.ordered, items: listBuffer.items })
        }
        listBuffer = null
    }
    const flushAll = () => {
        flushParagraph()
        flushList()
    }

    for (const line of lines) {
        if (!line.text) continue

        // ── Page-break-equivalent: treat large vertical gap as paragraph break ──
        if (prevY !== null && prevSize !== null) {
            const gap = prevY - line.y // PDF origin bottom-left, so prevY > line.y normally
            if (gap > prevSize * PARAGRAPH_GAP_FACTOR) {
                flushAll()
            }
        }

        // ── Heading detection ─────────────────────────────────────────────
        const headingLevel = inferHeadingLevel(line.maxFontSize, median, topSizes, headingThreshold)
        if (headingLevel !== null) {
            flushAll()
            segments.push({ kind: 'heading', level: headingLevel, text: line.text })
            prevY = line.y
            prevSize = line.maxFontSize
            continue
        }

        // ── List item detection ───────────────────────────────────────────
        const listInfo = detectListItem(line.text)
        if (listInfo) {
            flushParagraph()
            if (!listBuffer || listBuffer.ordered !== listInfo.ordered) {
                flushList()
                listBuffer = { ordered: listInfo.ordered, items: [] }
            }
            listBuffer.items.push(listInfo.text)
            prevY = line.y
            prevSize = line.maxFontSize
            continue
        }

        // ── Default: append to current paragraph ──────────────────────────
        flushList()
        paragraphBuffer.push(line.text)
        prevY = line.y
        prevSize = line.maxFontSize
    }

    flushAll()
    void pageHeight // reserved for future use
    return segments
}

function inferHeadingLevel(
    fontSize: number,
    median: number,
    topSizes: number[],
    threshold: number,
): 1 | 2 | 3 | null {
    if (fontSize < median * threshold) return null
    // If the document has multiple distinct large sizes, map them to h1/h2/h3.
    if (topSizes.length >= 1 && approxEqual(fontSize, topSizes[0], 0.5)) return 1
    if (topSizes.length >= 2 && approxEqual(fontSize, topSizes[1], 0.5)) return 2
    if (topSizes.length >= 3 && approxEqual(fontSize, topSizes[2], 0.5)) return 3
    // Otherwise just call it h2.
    return 2
}

function detectListItem(text: string): { ordered: boolean; text: string } | null {
    // Bulleted: starts with •, ◦, ●, ○, ▪, ▫, *, –, —, -
    const bulletMatch = text.match(/^[•◦●○▪▫\*–—\-]\s+(.+)$/)
    if (bulletMatch) return { ordered: false, text: bulletMatch[1].trim() }

    // Ordered: starts with "1.", "2)", "(1)", etc.
    const orderedMatch = text.match(/^(?:\d+|[a-zA-Z])[.)]\s+(.+)$/)
        ?? text.match(/^\(\d+\)\s+(.+)$/)
    if (orderedMatch) return { ordered: true, text: orderedMatch[1].trim() }

    return null
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function collectAllFontSizes(doc: PdfDocument): number[] {
    const sizes: number[] = []
    for (const page of doc.pages) {
        for (const item of page.items) {
            if (item.text.trim().length > 0) sizes.push(item.fontSize)
        }
    }
    return sizes
}

function computeMedian(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function uniqueDescending(values: number[], limit: number): number[] {
    const tolerance = 0.5
    const out: number[] = []
    for (const v of values) {
        if (out.every((u) => Math.abs(u - v) > tolerance)) out.push(v)
        if (out.length >= limit) break
    }
    return out
}

function approxEqual(a: number, b: number, tolerance: number): boolean {
    return Math.abs(a - b) <= tolerance
}

function pageRef(pageNumber: number): string {
    return `p_${pageNumber}`
}

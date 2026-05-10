/**
 * Diagnostic CLI for the PDF→AgentMark converter.
 *
 *   npx tsx examples/diagnose-pdf.ts <path-to.pdf> [--out report.md]
 *   npx tsx examples/diagnose-pdf.ts <directory-of-pdfs> [--out report.md]
 *
 * Produces a structured report scoring how well AgentMark parses the input:
 *
 *   - Per-page diagnostics: text-item count, font size distribution,
 *     median + outlier detection, suspected-scan flag (zero text items),
 *     suspected-multi-column flag (X-coordinate clustering)
 *   - Body-builder output: heading count, paragraph count, list count,
 *     percentage of items captured, percentage dropped
 *   - AgentMark size + estimated token cost
 *   - Quality score (heuristic, 0-100)
 *   - Suggestions for v0.5 work based on what failed
 *
 * Use this on a corpus of real-world county PDFs to find blind spots.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractPdf } from '../src/pdf/pdf-extractor'
import { buildBodyFromPdf } from '../src/pdf/body-builder'
import { convertPdf } from '../src/pdf/pdf-converter'
import { parseSnapshot } from '../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../src/validators/schema-validator'
import { loadPdfjs } from '../src/pdf/pdfjs-loader'
import { PopplerRenderBackend, TesseractOcrBackend } from '../src/pdf/ocr'
import type { ExtractedPdf } from '../src/pdf/types'
import type { OcrPipelineOptions } from '../src/pdf/ocr'

/**
 * What kind of PDF did this start life as? Drives the suggestion text and
 * the diagnostic flags.
 */
type SourceMode =
    | 'real_text'           // Text streams with showText ops — extraction works
    | 'scan'                // Single-image-per-page (Epson, scanner output) — needs OCR
    | 'print_to_pdf_vector' // Microsoft Print To PDF / similar — glyphs as vector paths, needs OCR
    | 'mixed'               // Some text + some images — partial extraction
    | 'empty'               // No content at all
    | 'unknown'

interface PageDiagnostic {
    page: number
    itemCount: number
    medianFontSize: number
    distinctFontSizes: number
    suspectedScan: boolean
    suspectedMultiColumn: boolean
    minX: number
    maxX: number
    columnGapDetected: boolean
}

interface DocReport {
    file: string
    sizeBytes: number
    parseError?: string
    pages?: number
    metadata?: { title?: string; author?: string; pdf_version?: string; producer?: string }
    sourceMode?: SourceMode
    perPage?: PageDiagnostic[]
    body?: {
        segments: number
        headings: number
        paragraphs: number
        lists: number
        page_markers: number
    }
    agentmark?: { bytes: number; tokens: number }
    valid?: boolean
    validationErrors?: string[]
    qualityScore?: number
    flags: string[]
    suggestions: string[]
}

async function diagnose(
    filePath: string,
    ocr?: OcrPipelineOptions,
    snapshotDir?: string,
): Promise<DocReport> {
    const flags: string[] = []
    const suggestions: string[] = []

    const stats = await stat(filePath).catch(() => null)
    if (!stats) {
        return {
            file: filePath,
            sizeBytes: 0,
            parseError: 'file not found',
            flags,
            suggestions,
        }
    }

    const data = await readFile(filePath)
    const sourceUrl = pathToFileURL(path.resolve(filePath)).toString()

    let extracted: ExtractedPdf
    try {
        extracted = await extractPdf({ data })
    } catch (err) {
        return {
            file: filePath,
            sizeBytes: stats.size,
            parseError: (err as Error).message,
            flags: ['extract_failed'],
            suggestions: ['Investigate parse failure — possibly encrypted, corrupt, or unsupported PDF version'],
        }
    }

    // Source-mode classification — distinguishes the three failure modes
    // discovered in the insurance corpus: real text, scanner output, and
    // "Print To PDF" vector-rendered glyphs.
    const { sourceMode, producer } = await classifySourceMode(data, extracted)

    // Per-page analysis
    const perPage: PageDiagnostic[] = []
    let scannedPages = 0
    let multiColumnPages = 0
    let totalItems = 0
    for (const page of extracted.pages) {
        const sizes = page.items.map((i) => i.fontSize).filter((s) => s > 0)
        const median = sizes.length === 0 ? 0 : medianOf(sizes)
        const distinctSizes = new Set(sizes.map((s) => Math.round(s * 2) / 2)).size
        const xs = page.items.map((i) => i.x)
        const minX = xs.length ? Math.min(...xs) : 0
        const maxX = xs.length ? Math.max(...xs) : 0
        const columnGap = detectColumnGap(xs, page.width)
        const suspectedScan = page.items.length === 0 || page.items.every((i) => !i.text.trim())
        const suspectedMultiColumn = !suspectedScan && columnGap

        if (suspectedScan) scannedPages++
        if (suspectedMultiColumn) multiColumnPages++
        totalItems += page.items.length

        perPage.push({
            page: page.number,
            itemCount: page.items.length,
            medianFontSize: round(median, 2),
            distinctFontSizes: distinctSizes,
            suspectedScan,
            suspectedMultiColumn,
            minX: round(minX, 1),
            maxX: round(maxX, 1),
            columnGapDetected: columnGap,
        })
    }

    if (multiColumnPages > 0) {
        flags.push(`${multiColumnPages}/${extracted.pages.length} pages appear multi-column`)
        suggestions.push('Multi-column reading-order inference (v0.5+) would improve this document')
    }

    // Source-mode-specific flags + suggestions
    if (sourceMode === 'scan') {
        flags.push(`Source mode: scanner output${producer ? ` (Producer: "${producer}")` : ''} — pages are images, no extractable text`)
        suggestions.push('OCR backend (v0.5) needed — images-only PDFs cannot be text-extracted without OCR')
    } else if (sourceMode === 'print_to_pdf_vector') {
        flags.push(`Source mode: "Print To PDF" vector-rendered glyphs (Producer: "${producer ?? 'unknown'}") — text rendered as filled paths, not text streams`)
        suggestions.push('OCR backend (v0.5) is the practical fix; alternatively request the original source PDF from the issuer to skip OCR entirely')
    } else if (sourceMode === 'mixed') {
        flags.push(`${scannedPages}/${extracted.pages.length} pages have no extractable text (mixed-content document)`)
        suggestions.push('OCR backend (v0.5) needed for the image pages; text pages already extract')
    } else if (sourceMode === 'empty') {
        flags.push('Document contains no extractable content (no text, no images)')
        suggestions.push('Investigate — file may be corrupt or use an unsupported encoding')
    }

    // Body-builder analysis
    const segments = buildBodyFromPdf(extracted)
    const headings = segments.filter((s) => s.kind === 'heading').length
    const paragraphs = segments.filter((s) => s.kind === 'paragraph').length
    const lists = segments.filter((s) => s.kind === 'list').length
    const pageMarkers = segments.filter((s) => s.kind === 'tag' && s.tag === 'PAGE').length

    if (headings === 0 && extracted.pages.length > 1) {
        flags.push('No headings detected — heading inference may have failed')
        suggestions.push('Tune headingThreshold; document may use uniform font sizes')
    }
    if (paragraphs === 0 && totalItems > 0) {
        flags.push('Text items present but no paragraphs emitted — body builder regression')
        suggestions.push('Investigate body-builder line/paragraph clustering')
    }

    // Full conversion (with optional OCR)
    let bytes = 0
    let valid = false
    let validationErrors: string[] = []
    try {
        const { agentmark } = await convertPdf({ data, sourceUrl, ocr })
        bytes = agentmark.length
        const snap = parseSnapshot(agentmark)
        const result = validateSnapshot(snap)
        valid = result.valid
        validationErrors = result.errors.map((e) => `${e.path}: ${e.message}`)
        if (ocr && snap.document?.ocr_used) {
            flags.push('✅ OCR backend filled in the missing text')
        }
        // Optionally write the actual snapshot per-document for inspection.
        if (snapshotDir) {
            const safe = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_')
            const outPath = path.join(snapshotDir, `${safe}.agentmark.md`)
            await writeFile(outPath, agentmark, 'utf8')
        }
    } catch (err) {
        flags.push(`Full conversion failed: ${(err as Error).message}`)
    }

    if (!valid && validationErrors.length > 0) {
        flags.push(`Schema validation: ${validationErrors.length} error(s)`)
        suggestions.push('Investigate schema validation failures — see validationErrors')
    }

    // Quality score (rough)
    let score = 100
    // If OCR wasn't applied, penalize for scanned/print-to-pdf pages.
    // If OCR WAS applied successfully, those penalties are nullified.
    const ocrApplied = ocr && (sourceMode === 'scan' || sourceMode === 'print_to_pdf_vector' || sourceMode === 'mixed')
    if (scannedPages > 0 && !ocrApplied) score -= Math.min(50, (scannedPages / extracted.pages.length) * 60)
    if (multiColumnPages > 0) score -= Math.min(20, (multiColumnPages / extracted.pages.length) * 30)
    if (headings === 0 && extracted.pages.length > 1) score -= 10
    if (paragraphs === 0 && totalItems > 0 && !ocrApplied) score -= 30
    if (!valid) score -= 20
    score = Math.max(0, Math.round(score))

    return {
        file: filePath,
        sizeBytes: stats.size,
        pages: extracted.pages.length,
        metadata: {
            title: extracted.metadata.title,
            author: extracted.metadata.author,
            pdf_version: extracted.metadata.pdf_version,
            producer,
        },
        sourceMode,
        perPage,
        body: {
            segments: segments.length,
            headings,
            paragraphs,
            lists,
            page_markers: pageMarkers,
        },
        agentmark: { bytes, tokens: Math.ceil(bytes / 4) },
        valid,
        validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        qualityScore: score,
        flags,
        suggestions,
    }
}

/**
 * Determine the source mode by inspecting metadata + operator distribution
 * on a sample of pages. Distinguishes:
 *   - 'real_text'           → has text streams (showText ops)
 *   - 'scan'                → images-only (paintImageXObject + scanner producer)
 *   - 'print_to_pdf_vector' → glyphs as filled paths (constructPath/fill, no text ops, Print-to-PDF producer)
 *   - 'mixed'               → some text + some image pages
 *   - 'empty'               → no text, no images
 */
async function classifySourceMode(
    data: Uint8Array,
    extracted: ExtractedPdf,
): Promise<{ sourceMode: SourceMode; producer?: string }> {
    const pdfjs = await loadPdfjs()
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const doc = await pdfjs
        .getDocument({ data: new Uint8Array(view), verbosity: 0 })
        .promise

    const meta = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }))
    const info = (meta.info ?? {}) as { Producer?: string }
    const producer = typeof info.Producer === 'string' ? info.Producer : undefined

    const ops = pdfjs.OPS as Record<string, number>
    const SHOW_TEXT = ops.showText
    const PAINT_IMAGE = ops.paintImageXObject
    const PAINT_INLINE_IMAGE = ops.paintInlineImageXObject
    const CONSTRUCT_PATH = ops.constructPath
    const FILL = ops.fill

    // Sample the first up-to-3 pages for op-level analysis (full doc would
    // be too slow on large PDFs; first few pages are highly representative).
    const sampleCount = Math.min(doc.numPages, 3)
    let pagesWithText = 0
    let pagesWithImageOnly = 0
    let pagesWithVectorGlyphs = 0
    let pagesEmpty = 0

    for (let i = 1; i <= sampleCount; i++) {
        const page = await doc.getPage(i)
        const opList = await page.getOperatorList()
        const fns = opList.fnArray
        let textOps = 0
        let imageOps = 0
        let pathOps = 0
        let fillOps = 0
        for (const fn of fns) {
            if (fn === SHOW_TEXT) textOps++
            else if (fn === PAINT_IMAGE || fn === PAINT_INLINE_IMAGE) imageOps++
            else if (fn === CONSTRUCT_PATH) pathOps++
            else if (fn === FILL) fillOps++
        }

        const itemsOnThisPage = extracted.pages[i - 1]?.items.length ?? 0

        if (textOps > 0 && itemsOnThisPage > 0) {
            pagesWithText++
        } else if (imageOps > 0 && textOps === 0) {
            pagesWithImageOnly++
        } else if (pathOps > 50 && fillOps > 50 && textOps === 0) {
            // Heavy vector drawing with no text ops → glyphs as filled paths
            pagesWithVectorGlyphs++
        } else if (fns.length === 0) {
            pagesEmpty++
        } else {
            // Some other shape — count as image-only fallback
            pagesWithImageOnly++
        }
        page.cleanup()
    }
    await doc.destroy()

    let sourceMode: SourceMode = 'unknown'
    if (pagesWithText > 0 && pagesWithImageOnly + pagesWithVectorGlyphs === 0) {
        sourceMode = 'real_text'
    } else if (pagesWithImageOnly > 0 && pagesWithText === 0 && pagesWithVectorGlyphs === 0) {
        sourceMode = 'scan'
    } else if (pagesWithVectorGlyphs > 0 && pagesWithText === 0) {
        sourceMode = 'print_to_pdf_vector'
    } else if (pagesEmpty === sampleCount) {
        sourceMode = 'empty'
    } else if (pagesWithText > 0) {
        sourceMode = 'mixed'
    }

    return { sourceMode, producer }
}

function detectColumnGap(xs: number[], pageWidth: number): boolean {
    if (xs.length < 20) return false
    const sorted = [...xs].sort((a, b) => a - b)
    // Find largest gap between consecutive X positions in the middle 60% of the page.
    const minRange = pageWidth * 0.2
    const maxRange = pageWidth * 0.8
    let largestGap = 0
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1] < minRange) continue
        if (sorted[i] > maxRange) break
        const gap = sorted[i] - sorted[i - 1]
        if (gap > largestGap) largestGap = gap
    }
    // A gap > 10% of page width in the middle of the page suggests a column.
    return largestGap > pageWidth * 0.1
}

function medianOf(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(n: number, decimals: number): number {
    const factor = 10 ** decimals
    return Math.round(n * factor) / factor
}

function renderReport(reports: DocReport[]): string {
    const lines: string[] = []
    lines.push('# AgentMark PDF Diagnostic Report')
    lines.push('')
    lines.push(`Generated: ${new Date().toISOString()}`)
    lines.push(`Documents: ${reports.length}`)
    lines.push('')

    // Summary
    const ok = reports.filter((r) => !r.parseError && (r.qualityScore ?? 0) >= 70)
    const partial = reports.filter((r) => !r.parseError && (r.qualityScore ?? 0) >= 30 && (r.qualityScore ?? 0) < 70)
    const failed = reports.filter((r) => r.parseError || (r.qualityScore ?? 0) < 30)

    lines.push(`## Summary`)
    lines.push('')
    lines.push(`| Bucket | Count | Median quality |`)
    lines.push(`|---|---|---|`)
    lines.push(`| 🟢 Good (≥70) | ${ok.length} | ${medianOf(ok.map((r) => r.qualityScore ?? 0))} |`)
    lines.push(`| 🟡 Partial (30-69) | ${partial.length} | ${medianOf(partial.map((r) => r.qualityScore ?? 0))} |`)
    lines.push(`| 🔴 Failed (<30) | ${failed.length} | ${medianOf(failed.map((r) => r.qualityScore ?? 0))} |`)
    lines.push('')

    // Aggregate flag counts
    const flagCounts = new Map<string, number>()
    for (const r of reports) {
        for (const f of r.flags) {
            const key = f.replace(/\d+\/\d+/, 'N/M')
            flagCounts.set(key, (flagCounts.get(key) ?? 0) + 1)
        }
    }
    if (flagCounts.size > 0) {
        lines.push(`## Top issues across corpus`)
        lines.push('')
        const sorted = [...flagCounts.entries()].sort((a, b) => b[1] - a[1])
        for (const [flag, count] of sorted) {
            lines.push(`- **(${count}×)** ${flag}`)
        }
        lines.push('')
    }

    // Source mode breakdown
    const modes = new Map<string, number>()
    for (const r of reports) {
        if (r.sourceMode) modes.set(r.sourceMode, (modes.get(r.sourceMode) ?? 0) + 1)
    }
    if (modes.size > 0) {
        lines.push(`## Source-mode breakdown`)
        lines.push('')
        lines.push(`| Mode | Count | Meaning |`)
        lines.push(`|---|---|---|`)
        const explain: Record<string, string> = {
            real_text: 'Text streams present — extraction works',
            scan: 'Scanner output (image-per-page) — needs OCR',
            print_to_pdf_vector: '"Print To PDF" vector glyphs — needs OCR or original source',
            mixed: 'Some text pages + some image pages — needs OCR for image pages',
            empty: 'No content',
            unknown: 'Could not classify',
        }
        for (const [mode, count] of [...modes.entries()].sort((a, b) => b[1] - a[1])) {
            lines.push(`| \`${mode}\` | ${count} | ${explain[mode] ?? '?'} |`)
        }
        lines.push('')
    }

    lines.push(`## Per-document detail`)
    lines.push('')
    for (const r of reports) {
        lines.push(`### ${path.basename(r.file)}`)
        lines.push('')
        lines.push(`- Path: \`${r.file}\``)
        lines.push(`- Size: ${(r.sizeBytes / 1024).toFixed(1)} KB`)
        if (r.parseError) {
            lines.push(`- ❌ Parse error: ${r.parseError}`)
            lines.push('')
            continue
        }
        lines.push(`- Pages: ${r.pages}`)
        lines.push(`- Quality score: **${r.qualityScore}/100**`)
        if (r.sourceMode) lines.push(`- Source mode: \`${r.sourceMode}\``)
        if (r.metadata?.producer) lines.push(`- Producer: ${r.metadata.producer}`)
        if (r.metadata?.title) lines.push(`- Title: ${r.metadata.title}`)
        if (r.metadata?.pdf_version) lines.push(`- PDF version: ${r.metadata.pdf_version}`)
        if (r.body) {
            lines.push(
                `- Body: ${r.body.segments} segments (${r.body.headings} headings, ${r.body.paragraphs} paragraphs, ${r.body.lists} lists, ${r.body.page_markers} page markers)`,
            )
        }
        if (r.agentmark) {
            lines.push(`- AgentMark size: ${(r.agentmark.bytes / 1024).toFixed(1)} KB (~${r.agentmark.tokens} tokens)`)
        }
        if (r.flags.length > 0) {
            lines.push(`- Flags:`)
            for (const f of r.flags) lines.push(`  - ${f}`)
        }
        if (r.suggestions.length > 0) {
            lines.push(`- Suggestions:`)
            for (const s of r.suggestions) lines.push(`  - ${s}`)
        }
        if (r.validationErrors && r.validationErrors.length > 0) {
            lines.push(`- Validation errors:`)
            for (const e of r.validationErrors) lines.push(`  - ${e}`)
        }
        lines.push('')
    }

    return lines.join('\n')
}

async function gatherFiles(input: string): Promise<string[]> {
    const stats = await stat(input)
    if (stats.isFile() && input.toLowerCase().endsWith('.pdf')) return [input]
    if (stats.isDirectory()) {
        const entries = await readdir(input)
        return entries
            .filter((e) => e.toLowerCase().endsWith('.pdf'))
            .map((e) => path.join(input, e))
    }
    throw new Error(`Not a PDF file or directory: ${input}`)
}

async function main() {
    const args = process.argv.slice(2)
    if (args.length === 0) {
        console.error(
            'Usage: npx tsx examples/diagnose-pdf.ts <pdf-or-dir> [--out report.md] '
            + '[--snapshots <dir>] [--ocr]',
        )
        console.error('  --out <file>         Write the markdown report to a file')
        console.error('  --snapshots <dir>    Write each PDF\'s AgentMark snapshot to <dir>/<file>.agentmark.md')
        console.error('  --ocr                Enable Tesseract+Poppler OCR on pages with no text')
        process.exit(1)
    }

    const outIdx = args.indexOf('--out')
    const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined
    const snapIdx = args.indexOf('--snapshots')
    const snapshotDir = snapIdx >= 0 ? args[snapIdx + 1] : undefined
    const enableOcr = args.includes('--ocr')
    const inputs = args.filter((a, i) => {
        if (a === '--out' || a === '--ocr' || a === '--snapshots') return false
        if (outIdx >= 0 && i === outIdx + 1) return false
        if (snapIdx >= 0 && i === snapIdx + 1) return false
        return true
    })

    const allFiles: string[] = []
    for (const inp of inputs) allFiles.push(...(await gatherFiles(inp)))

    if (allFiles.length === 0) {
        console.error('No PDF files found.')
        process.exit(1)
    }

    if (snapshotDir) {
        await import('node:fs/promises').then((fs) => fs.mkdir(snapshotDir, { recursive: true }))
        console.error(`Writing per-doc AgentMark snapshots to: ${snapshotDir}`)
    }

    let ocr: OcrPipelineOptions | undefined
    let ocrBackend: TesseractOcrBackend | undefined
    if (enableOcr) {
        console.error('OCR enabled (Poppler + Tesseract). First page may take ~10s as the worker spins up.')
        ocrBackend = new TesseractOcrBackend({ language: 'eng' })
        ocr = {
            render: new PopplerRenderBackend(),
            ocr: ocrBackend,
            mode: 'auto',
            dpi: 200,
        }
    }

    console.error(`Diagnosing ${allFiles.length} file(s)...`)
    const reports: DocReport[] = []
    try {
        for (const file of allFiles) {
            process.stderr.write(`  ${path.basename(file)}... `)
            try {
                const r = await diagnose(file, ocr, snapshotDir)
                reports.push(r)
                const tag = r.parseError
                    ? '❌'
                    : (r.qualityScore ?? 0) >= 70
                        ? '🟢'
                        : (r.qualityScore ?? 0) >= 30
                            ? '🟡'
                            : '🔴'
                console.error(`${tag} (score ${r.qualityScore ?? 'n/a'})`)
            } catch (err) {
                console.error(`💥 ${(err as Error).message}`)
            }
        }
    } finally {
        await ocrBackend?.close().catch(() => {})
    }

    const report = renderReport(reports)
    if (outPath) {
        await writeFile(outPath, report, 'utf8')
        console.error(`\nReport written to: ${outPath}`)
    } else {
        console.log(report)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

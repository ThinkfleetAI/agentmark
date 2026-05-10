/**
 * AgentMark kitchen-sink demo — exercises every public surface in one run.
 *
 *   npx tsx examples/kitchen-sink.ts [insurance-corpus-dir]
 *
 * What it does:
 *   1. Web — captures example.com via Chromium + AgentMark snapshot
 *   2. PDF (text) — converts a Farm Bureau-style PDF to AgentMark
 *   3. PDF (OCR) — runs Tesseract + Poppler on a "Print To PDF" / scanned
 *      doc and verifies text was recovered
 *   4. AcroForm — generates a fillable PDF, fills it, saves, re-extracts
 *      and asserts values round-tripped
 *
 * Prints a summary report at the end. Exits non-zero on any failure.
 *
 * Optional first arg: a directory of real PDFs (e.g. your insurance corpus).
 * If provided, tests 2 + 3 use real files from there instead of a synthetic
 * fixture.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
    createBrowser,
    convertPdf,
    openPdfDocument,
    PopplerRenderBackend,
    TesseractOcrBackend,
    consoleLogger,
} from '../src'

interface Result {
    name: string
    ok: boolean
    detail: string
    durationMs: number
}

const results: Result[] = []

async function run(name: string, fn: () => Promise<string>): Promise<void> {
    const start = Date.now()
    try {
        const detail = await fn()
        results.push({ name, ok: true, detail, durationMs: Date.now() - start })
        process.stderr.write(`  🟢 ${name}\n`)
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        results.push({ name, ok: false, detail, durationMs: Date.now() - start })
        process.stderr.write(`  🔴 ${name}\n     → ${detail}\n`)
    }
}

// ──────────────────────────────────────────────────────────────────────────

async function testWebCapture(): Promise<string> {
    const browser = await createBrowser({ launch: { headless: true } })
    try {
        const page = await browser.newPage()
        await page.goto('https://example.com', { waitUntil: 'load', timeout: 30_000 })
        const snap = await page.snapshot()
        if (!snap.snapshot.title) throw new Error('No title in snapshot')
        if (!snap.agentmark.includes('Example Domain')) throw new Error('Body content missing')
        return `${snap.agentmark.length} bytes, title="${snap.snapshot.title}"`
    } finally {
        await browser.close()
    }
}

// Pick the largest text-extractable PDF in the corpus (the FB renewals work well).
async function findTextPdf(corpusDir: string | undefined): Promise<string | null> {
    if (!corpusDir) return null
    try {
        const entries = await readdir(corpusDir)
        const pdfs = entries.filter((e) => e.toLowerCase().endsWith('.pdf'))
        for (const file of pdfs) {
            // FB renewal PDFs in the insurance corpus are reliably text-PDFs.
            if (/FB|farm.bureau/i.test(file)) return path.join(corpusDir, file)
        }
        // Fallback: pick the smallest PDF (less likely to be scanned image)
        if (pdfs.length === 0) return null
        const sized = await Promise.all(
            pdfs.map(async (f) => {
                const s = await stat(path.join(corpusDir, f))
                return { file: f, size: s.size }
            }),
        )
        sized.sort((a, b) => a.size - b.size)
        return path.join(corpusDir, sized[0].file)
    } catch {
        return null
    }
}

async function findScannedOrPrintToPdf(corpusDir: string | undefined): Promise<string | null> {
    if (!corpusDir) return null
    try {
        const entries = await readdir(corpusDir)
        const pdfs = entries.filter((e) => e.toLowerCase().endsWith('.pdf'))
        // Erie Auto Quote = Microsoft Print To PDF case
        const erie = pdfs.find((f) => /erie/i.test(f))
        if (erie) return path.join(corpusDir, erie)
        // Or anything labeled Scan/Flood Map etc.
        const scanLike = pdfs.find((f) => /scan|flood|reseller/i.test(f))
        return scanLike ? path.join(corpusDir, scanLike) : null
    } catch {
        return null
    }
}

async function buildSyntheticTextPdf(): Promise<string> {
    const target = path.join(os.tmpdir(), `agentmark-kitchen-text-${Date.now()}.pdf`)
    const doc = await PDFDocument.create()
    doc.setTitle('Synthetic Insurance Renewal')
    doc.setAuthor('AgentMark Kitchen Sink')
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const page = doc.addPage([595, 842])
    page.drawText('PART B DECLARATION PAGE', { x: 50, y: 800, size: 14, font: bold })
    page.drawText('POLICY NUMBER: 12345', { x: 50, y: 770, size: 11, font })
    page.drawText('Coverage: Comprehensive auto insurance', { x: 50, y: 740, size: 11, font })
    page.drawText('Premium: $1,234.56 due 2026-06-01', { x: 50, y: 720, size: 11, font })
    await writeFile(target, await doc.save())
    return target
}

async function buildSyntheticAcroForm(): Promise<string> {
    const target = path.join(os.tmpdir(), `agentmark-kitchen-form-${Date.now()}.pdf`)
    const doc = await PDFDocument.create()
    doc.setTitle('Synthetic Vendor Application')
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([595, 842])
    const form = doc.getForm()

    page.drawText('VENDOR APPLICATION', { x: 50, y: 800, size: 18, font })
    page.drawText('Company Name:', { x: 50, y: 750, size: 11, font })
    const company = form.createTextField('company_name')
    company.addToPage(page, { x: 200, y: 745, width: 300, height: 18, font })

    page.drawText('I agree to terms:', { x: 50, y: 700, size: 11, font })
    const agree = form.createCheckBox('agree_terms')
    agree.addToPage(page, { x: 200, y: 698, width: 14, height: 14 })

    page.drawText('State:', { x: 50, y: 660, size: 11, font })
    const stateDd = form.createDropdown('state')
    stateDd.setOptions(['NC', 'SC', 'GA', 'TN'])
    stateDd.addToPage(page, { x: 200, y: 655, width: 100, height: 18, font })

    await writeFile(target, await doc.save())
    return target
}

async function testTextPdf(corpusDir: string | undefined): Promise<string> {
    let pdfPath = await findTextPdf(corpusDir)
    let isReal = pdfPath !== null
    if (!pdfPath) pdfPath = await buildSyntheticTextPdf()

    const data = await readFile(pdfPath)
    const { agentmark } = await convertPdf({
        data,
        sourceUrl: pathToFileURL(pdfPath).toString(),
    })
    if (!agentmark.includes('[PAGE:p_1]')) throw new Error('No PAGE markers emitted')
    if (agentmark.length < 200) throw new Error(`Snapshot too small (${agentmark.length} bytes)`)
    return `${path.basename(pdfPath)} ${isReal ? '(real)' : '(synthetic)'} → ${agentmark.length} bytes`
}

async function testOcrPdf(corpusDir: string | undefined): Promise<string> {
    const pdfPath = await findScannedOrPrintToPdf(corpusDir)
    if (!pdfPath) {
        // No suitable real doc — skip with a synthetic message.
        return 'SKIPPED — no scanned/print-to-pdf doc in corpus'
    }
    const data = await readFile(pdfPath)
    const ocr = new TesseractOcrBackend({ language: 'eng' })
    try {
        const { agentmark } = await convertPdf({
            data,
            sourceUrl: pathToFileURL(pdfPath).toString(),
            ocr: {
                render: new PopplerRenderBackend(),
                ocr,
                mode: 'auto',
                dpi: 200,
            },
        })
        // Heuristic: OCR'd output should produce way more than just the
        // PAGE markers. If we see < 500 chars of body, something is wrong.
        const bodyMatch = agentmark.split('---')[2] ?? ''
        if (bodyMatch.length < 500) {
            throw new Error(`OCR produced only ${bodyMatch.length} chars of body`)
        }
        return `${path.basename(pdfPath)} → ${agentmark.length} bytes (OCR'd)`
    } finally {
        await ocr.close()
    }
}

async function testAcroFormRoundTrip(): Promise<string> {
    const pdfPath = await buildSyntheticAcroForm()
    const data = await readFile(pdfPath)

    const doc = await openPdfDocument({
        data,
        sourceUrl: pathToFileURL(pdfPath).toString(),
    })
    try {
        if (doc.fields.size !== 3) {
            throw new Error(`Expected 3 fields, got ${doc.fields.size}`)
        }

        // Locate fields by their original names
        const byName = new Map<string, string>()
        for (const [actionId, field] of doc.fields) byName.set(field.fieldName, actionId)

        await doc.execute(byName.get('company_name')!, 'Acme Inc.')
        await doc.execute(byName.get('agree_terms')!, true)
        await doc.execute(byName.get('state')!, 'NC')

        const filled = await doc.save()
        if (filled.length < 100) throw new Error('Save produced near-empty bytes')

        // Round-trip: re-load the filled PDF and verify values
        const verified = await PDFDocument.load(filled)
        const f = verified.getForm()
        const company = f.getTextField('company_name').getText()
        const agree = f.getCheckBox('agree_terms').isChecked()
        const state = f.getDropdown('state').getSelected()
        if (company !== 'Acme Inc.') throw new Error(`company round-trip failed: "${company}"`)
        if (agree !== true) throw new Error(`agree round-trip failed: ${agree}`)
        if (state.join(',') !== 'NC') throw new Error(`state round-trip failed: ${state}`)

        return `3 fields filled + round-trip verified (${filled.length} bytes)`
    } finally {
        await doc.close()
    }
}

async function testMcpDispatcher(): Promise<string> {
    // Lightweight: spin up the dispatcher, list tools, list_sessions, dispose.
    const { createDispatcherState, dispatch, disposeAll } = await import('../src/mcp/dispatcher')
    const { ALL_TOOLS } = await import('../src/mcp/tool-defs')
    const state = createDispatcherState()
    try {
        const r = await dispatch(state, 'agentmark_list_sessions', {})
        if (r.isError) throw new Error('list_sessions failed')
        const json = JSON.parse(r.text)
        if (!Array.isArray(json.browsers)) throw new Error('list_sessions shape wrong')
        return `${ALL_TOOLS.length} tools registered, dispatcher returns valid JSON`
    } finally {
        await disposeAll(state)
    }
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
    const corpusDir = process.argv[2]
    process.stderr.write(`AgentMark kitchen-sink demo\n`)
    if (corpusDir) {
        process.stderr.write(`  Using corpus: ${corpusDir}\n`)
    } else {
        process.stderr.write(
            `  No corpus dir provided — using synthetic fixtures only.\n`
            + `  Pass a directory as the first arg to test against real PDFs.\n`,
        )
    }
    process.stderr.write(`\n`)

    void consoleLogger // imported for the user to enable manually

    await run('Web — capture example.com via Chromium', testWebCapture)
    await run('PDF (text) — extract structured AgentMark from text PDF', () => testTextPdf(corpusDir))
    await run('PDF (OCR) — Tesseract + Poppler on scanned/print-to-PDF', () => testOcrPdf(corpusDir))
    await run('AcroForm — fill + save round-trip', testAcroFormRoundTrip)
    await run('MCP — dispatcher list_sessions returns valid JSON', testMcpDispatcher)

    process.stderr.write(`\n──── Summary ────\n`)
    let okCount = 0
    let totalMs = 0
    for (const r of results) {
        process.stderr.write(
            `  ${r.ok ? '🟢' : '🔴'} ${r.name.padEnd(60)} ${r.durationMs.toString().padStart(6)}ms\n`,
        )
        process.stderr.write(`     ${r.detail}\n`)
        if (r.ok) okCount++
        totalMs += r.durationMs
    }
    process.stderr.write(`\n  ${okCount}/${results.length} passed in ${totalMs}ms total.\n`)

    if (okCount !== results.length) process.exit(1)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

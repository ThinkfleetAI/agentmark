/**
 * Unit tests for the MCP tool dispatcher.
 *
 * Drives `dispatch()` directly — no MCP transport, no JSON-RPC. The
 * dispatcher is the meaty logic; transport is a thin pass-through tested
 * separately.
 *
 * PDF + form tests use programmatically generated PDFs (no real browsers,
 * no API keys) so the suite is deterministic and fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
    dispatch,
    createDispatcherState,
    disposeAll,
    type DispatcherState,
} from '../../src/mcp/dispatcher'
import { ALL_TOOLS } from '../../src/mcp/tool-defs'

let state: DispatcherState
const tmpFiles: string[] = []

function tmpPath(suffix = '.pdf'): string {
    const p = path.join(
        os.tmpdir(),
        `agentmark-mcp-test-${process.pid}-${Date.now()}-${Math.random()}${suffix}`,
    )
    tmpFiles.push(p)
    return p
}

async function writeFormPdf(targetPath: string): Promise<void> {
    const doc = await PDFDocument.create()
    doc.setTitle('MCP Test Form')
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()

    const tf = form.createTextField('company')
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 18, font })

    const cb = form.createCheckBox('agree')
    cb.addToPage(page, { x: 50, y: 650, width: 12, height: 12 })

    const bytes = await doc.save()
    await fs.writeFile(targetPath, bytes)
}

beforeEach(() => {
    state = createDispatcherState()
})

afterEach(async () => {
    await disposeAll(state)
    for (const p of tmpFiles.splice(0)) {
        await fs.unlink(p).catch(() => {})
    }
})

describe('Tool registry', () => {
    it('exports a non-empty list of unique tool definitions', () => {
        expect(ALL_TOOLS.length).toBeGreaterThan(10)
        const names = ALL_TOOLS.map((t) => t.name)
        expect(new Set(names).size).toBe(names.length)
    })

    it('every tool has the AgentMark naming prefix', () => {
        for (const t of ALL_TOOLS) {
            expect(t.name).toMatch(/^agentmark_/)
        }
    })

    it('every tool has a non-trivial description', () => {
        for (const t of ALL_TOOLS) {
            // Min 15 chars — short enough to allow concise tools like
            // "Close a single page." while still catching empty/missing.
            expect(t.description.length).toBeGreaterThanOrEqual(15)
        }
    })

    it('every tool has a JSON-Schema-shaped inputSchema', () => {
        for (const t of ALL_TOOLS) {
            expect(t.inputSchema.type).toBe('object')
            expect(typeof t.inputSchema.properties).toBe('object')
        }
    })
})

describe('dispatch — error semantics', () => {
    it('returns isError for unknown tool names', async () => {
        const r = await dispatch(state, 'agentmark_nonexistent', {})
        expect(r.isError).toBe(true)
        expect(r.text).toContain('Unknown tool')
    })

    it('returns isError when a required argument is missing', async () => {
        const r = await dispatch(state, 'agentmark_browser_close', {})
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/browser_id/)
    })

    it('returns isError when referencing an unknown session ID', async () => {
        const r = await dispatch(state, 'agentmark_pdf_snapshot', { doc_id: 'bogus' })
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/Unknown doc_id/)
    })

    it('errors include the AgentMark error code prefix when present', async () => {
        const pdf = tmpPath()
        await writeFormPdf(pdf)
        const open = await dispatch(state, 'agentmark_pdf_open', { source: pdf })
        const docId = JSON.parse(open.text).doc_id

        const r = await dispatch(state, 'agentmark_pdf_execute', {
            doc_id: docId,
            action_id: 'act_does_not_exist',
        })
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/\[action_not_found\]/)
    })
})

describe('dispatch — pdf flow end-to-end', () => {
    it('open → snapshot → execute → save round trip', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)

        // open
        const open = await dispatch(state, 'agentmark_pdf_open', { source: pdfPath })
        expect(open.isError).not.toBe(true)
        const opened = JSON.parse(open.text)
        const docId = opened.doc_id as string
        expect(opened.field_count).toBe(2)

        // snapshot
        const snap = await dispatch(state, 'agentmark_pdf_snapshot', { doc_id: docId })
        expect(snap.isError).not.toBe(true)
        expect(snap.text).toMatch(/^---/)
        expect(snap.text).toContain('kind: form')

        // Find action IDs by parsing the snapshot's `actions:` block.
        // (Cheaper than parsing YAML; we just need a couple action IDs.)
        const ids = (snap.text.match(/^\s+(act_field_\d+):/gm) ?? []).map((m) =>
            m.trim().replace(':', ''),
        )
        expect(ids.length).toBe(2)

        // execute (queue values)
        const exec1 = await dispatch(state, 'agentmark_pdf_execute', {
            doc_id: docId,
            action_id: ids[0],
            value: 'Acme Inc.',
        })
        expect(exec1.isError).not.toBe(true)
        const exec2 = await dispatch(state, 'agentmark_pdf_execute', {
            doc_id: docId,
            action_id: ids[1],
            value: true,
        })
        expect(exec2.isError).not.toBe(true)

        // save
        const outPath = tmpPath('-filled.pdf')
        const save = await dispatch(state, 'agentmark_pdf_save', {
            doc_id: docId,
            output_path: outPath,
        })
        expect(save.isError).not.toBe(true)
        const saved = JSON.parse(save.text)
        expect(saved.output_path).toBe(path.resolve(outPath))
        expect(saved.bytes).toBeGreaterThan(100)

        // file actually exists with content
        const stat = await fs.stat(outPath)
        expect(stat.size).toBe(saved.bytes)

        // close
        const close = await dispatch(state, 'agentmark_pdf_close', { doc_id: docId })
        expect(close.isError).not.toBe(true)
        const reopen = await dispatch(state, 'agentmark_pdf_snapshot', { doc_id: docId })
        expect(reopen.isError).toBe(true)
    })

    it('reset clears pending values', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)
        const open = await dispatch(state, 'agentmark_pdf_open', { source: pdfPath })
        const docId = JSON.parse(open.text).doc_id

        const snap = await dispatch(state, 'agentmark_pdf_snapshot', { doc_id: docId })
        const ids = (snap.text.match(/^\s+(act_field_\d+):/gm) ?? []).map((m) =>
            m.trim().replace(':', ''),
        )
        await dispatch(state, 'agentmark_pdf_execute', {
            doc_id: docId,
            action_id: ids[0],
            value: 'Will be reset',
        })
        await dispatch(state, 'agentmark_pdf_reset', { doc_id: docId })

        const list = await dispatch(state, 'agentmark_list_sessions', {})
        const json = JSON.parse(list.text)
        expect(json.pdfs[0].pending).toBe(0)
    })

    it('open with enable_ocr=true sets ocr_enabled in the response', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)
        const open = await dispatch(state, 'agentmark_pdf_open', {
            source: pdfPath,
            enable_ocr: true,
            ocr_language: 'eng',
        })
        expect(open.isError).not.toBe(true)
        const opened = JSON.parse(open.text)
        expect(opened.ocr_enabled).toBe(true)
        // Cleanup — the doc owns Tesseract worker; close releases it.
        await dispatch(state, 'agentmark_pdf_close', { doc_id: opened.doc_id })
    })

    it('open with enable_ocr omitted defaults to no OCR', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)
        const open = await dispatch(state, 'agentmark_pdf_open', { source: pdfPath })
        const opened = JSON.parse(open.text)
        expect(opened.ocr_enabled).toBe(false)
    })

    it('open accepts a base64 data URI', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)
        const bytes = await fs.readFile(pdfPath)
        const dataUrl = `data:application/pdf;base64,${bytes.toString('base64')}`
        const open = await dispatch(state, 'agentmark_pdf_open', {
            source: dataUrl,
            source_url: 'memory://test.pdf',
        })
        expect(open.isError).not.toBe(true)
        const opened = JSON.parse(open.text)
        expect(opened.field_count).toBe(2)
        expect(opened.source_url).toBe('memory://test.pdf')
    })
})

describe('dispatch — list_sessions', () => {
    it('returns empty arrays when nothing is open', async () => {
        const r = await dispatch(state, 'agentmark_list_sessions', {})
        const json = JSON.parse(r.text)
        expect(json.browsers).toEqual([])
        expect(json.pdfs).toEqual([])
    })

    it('lists open PDFs with their field counts', async () => {
        const pdf1 = tmpPath()
        const pdf2 = tmpPath()
        await writeFormPdf(pdf1)
        await writeFormPdf(pdf2)
        await dispatch(state, 'agentmark_pdf_open', { source: pdf1 })
        await dispatch(state, 'agentmark_pdf_open', { source: pdf2 })

        const r = await dispatch(state, 'agentmark_list_sessions', {})
        const json = JSON.parse(r.text)
        expect(json.pdfs.length).toBe(2)
        for (const pdf of json.pdfs) {
            expect(pdf.field_count).toBe(2)
            expect(pdf.pending).toBe(0)
        }
    })
})

describe('disposeAll', () => {
    it('closes every active resource and clears state', async () => {
        const pdfPath = tmpPath()
        await writeFormPdf(pdfPath)
        await dispatch(state, 'agentmark_pdf_open', { source: pdfPath })
        await dispatch(state, 'agentmark_pdf_open', { source: pdfPath })

        expect(state.pdfs.size).toBe(2)
        await disposeAll(state)
        expect(state.pdfs.size).toBe(0)
        expect(state.browsers.size).toBe(0)
        expect(state.pages.size).toBe(0)
    })
})

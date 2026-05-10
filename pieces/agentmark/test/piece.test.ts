/**
 * Tests for the AgentMark Activepieces piece.
 *
 * Verifies action shape (names, prop schemas, descriptions) and exercises
 * fill_pdf_form end-to-end against an in-memory fillable PDF. The web-page
 * snapshot action launches Chromium and is gated on AGENTMARK_INTEGRATION
 * to keep CI fast.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { agentmark } from '../src/index'
import { fillPdfForm } from '../src/lib/actions/fill-pdf-form'
import { snapshotPdf } from '../src/lib/actions/snapshot-pdf'
import { snapshotWebPage } from '../src/lib/actions/snapshot-web-page'

const tmpFiles: string[] = []

function tmpPath(suffix = '.pdf'): string {
    const p = path.join(
        os.tmpdir(),
        `agentmark-piece-test-${process.pid}-${Date.now()}-${Math.random()}${suffix}`,
    )
    tmpFiles.push(p)
    return p
}

async function buildFillableForm(target: string): Promise<void> {
    const doc = await PDFDocument.create()
    doc.setTitle('Piece Test Form')
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()

    const tf = form.createTextField('company')
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 18, font })

    const cb = form.createCheckBox('agree')
    cb.addToPage(page, { x: 50, y: 650, width: 12, height: 12 })

    const bytes = await doc.save()
    await fs.writeFile(target, bytes)
}

afterEach(async () => {
    for (const p of tmpFiles.splice(0)) {
        await fs.unlink(p).catch(() => {})
    }
})

// ──────────────────────────────────────────────────────────────────────────
// Piece metadata + action shape
// ──────────────────────────────────────────────────────────────────────────

describe('AgentMark Activepieces piece', () => {
    it('declares display name + minimum release', () => {
        expect(agentmark.displayName).toBe('AgentMark')
        expect(agentmark.minimumSupportedRelease).toBeDefined()
        expect('auth' in agentmark).toBe(true)
    })

    it('exposes the three v1 actions', () => {
        const actions = Object.keys(agentmark.actions())
        expect(actions).toEqual(
            expect.arrayContaining(['snapshot_web_page', 'snapshot_pdf', 'fill_pdf_form']),
        )
    })

    it('every action has a non-empty description and props schema', () => {
        const actions = Object.values(agentmark.actions())
        for (const action of actions) {
            expect(action.description.length).toBeGreaterThan(15)
            expect(action.props).toBeDefined()
        }
    })
})

describe('snapshot_web_page action shape', () => {
    it('declares URL, wait_until, timeout_ms, headless props', () => {
        const props = snapshotWebPage.props
        expect(props.url).toBeDefined()
        expect(props.wait_until).toBeDefined()
        expect(props.timeout_ms).toBeDefined()
        expect(props.headless).toBeDefined()
    })
})

describe('snapshot_pdf action shape', () => {
    it('declares source, source_url, title, password, ocr props', () => {
        const props = snapshotPdf.props
        expect(props.source).toBeDefined()
        expect(props.source_url).toBeDefined()
        expect(props.title).toBeDefined()
        expect(props.password).toBeDefined()
        expect(props.enable_ocr).toBeDefined()
        expect(props.ocr_language).toBeDefined()
    })
})

describe('fill_pdf_form action shape', () => {
    it('declares source, values, flatten, return_format, password props', () => {
        const props = fillPdfForm.props
        expect(props.source).toBeDefined()
        expect(props.values).toBeDefined()
        expect(props.flatten).toBeDefined()
        expect(props.return_format).toBeDefined()
        expect(props.password).toBeDefined()
    })
})

// ──────────────────────────────────────────────────────────────────────────
// fill_pdf_form end-to-end (no browsers needed)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Minimal Activepieces context for an action `run`. Just enough surface
 * to invoke our actions; we don't exercise context.server / context.flows.
 */
function fakeContext<T extends Record<string, unknown>>(propsValue: T) {
    return { propsValue } as unknown as Parameters<typeof fillPdfForm.run>[0]
}

describe('fill_pdf_form — end-to-end', () => {
    it('fills fields by action ID and returns a valid base64 data URI', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await fillPdfForm.run(
            fakeContext({
                source: pdfPath,
                values: { act_field_1: 'Acme Inc.', act_field_2: true },
                flatten: false,
                return_format: 'data_uri',
            }),
        )

        expect(result.fields_applied.length).toBe(2)
        expect(result.fields_skipped).toEqual([])
        expect(result.filled_pdf.startsWith('data:application/pdf;base64,')).toBe(true)
        expect(result.bytes).toBeGreaterThan(100)
    })

    it('fills fields by original field name (not just action ID)', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await fillPdfForm.run(
            fakeContext({
                source: pdfPath,
                values: { company: 'Inc by Name', agree: true },
                flatten: false,
                return_format: 'data_uri',
            }),
        )
        expect(result.fields_applied.length).toBe(2)
        const resolved = result.fields_applied.map((s) => s.resolved_action_id).sort()
        expect(resolved).toEqual(['act_field_1', 'act_field_2'])
    })

    it('reports unknown keys via fields_skipped (does not throw)', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await fillPdfForm.run(
            fakeContext({
                source: pdfPath,
                values: {
                    company: 'Real',
                    nonexistent_field: 'ignored',
                    another_missing: 42,
                },
                flatten: false,
                return_format: 'data_uri',
            }),
        )
        expect(result.fields_applied.length).toBe(1)
        expect(result.fields_skipped).toEqual(['nonexistent_field', 'another_missing'])
    })

    it('return_format=base64 returns raw base64 (no data URI prefix)', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await fillPdfForm.run(
            fakeContext({
                source: pdfPath,
                values: { company: 'Plain' },
                flatten: false,
                return_format: 'base64',
            }),
        )
        expect(result.filled_pdf.startsWith('data:')).toBe(false)
        // base64 alphabet only
        expect(result.filled_pdf).toMatch(/^[A-Za-z0-9+/=]+$/)
    })

    it('flatten: true removes the form so the result is no longer fillable', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await fillPdfForm.run(
            fakeContext({
                source: pdfPath,
                values: { company: 'Flattened' },
                flatten: true,
                return_format: 'base64',
            }),
        )
        expect(result.flattened).toBe(true)
        // Re-load via pdf-lib and check the form has no fields
        const filled = Buffer.from(result.filled_pdf, 'base64')
        const reloaded = await PDFDocument.load(filled)
        expect(reloaded.getForm().getFields().length).toBe(0)
    })

    it('accepts a base64 data URI as source (no temp file required)', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)
        const bytes = await fs.readFile(pdfPath)
        const dataUri = `data:application/pdf;base64,${bytes.toString('base64')}`

        const result = await fillPdfForm.run(
            fakeContext({
                source: dataUri,
                values: { company: 'From Data URI' },
                flatten: false,
                return_format: 'data_uri',
            }),
        )
        expect(result.fields_applied.length).toBe(1)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// snapshot_pdf end-to-end (no OCR — keeps test fast)
// ──────────────────────────────────────────────────────────────────────────

describe('snapshot_pdf — end-to-end (text PDF, no OCR)', () => {
    it('returns kind: form when AcroForm fields are present', async () => {
        const pdfPath = tmpPath()
        await buildFillableForm(pdfPath)

        const result = await snapshotPdf.run(
            fakeContext({
                source: pdfPath,
                source_url: 'file:///tmp/test.pdf',
                enable_ocr: false,
            }),
        )

        expect(result.bytes).toBeGreaterThan(50)
        expect(result.agentmark).toContain('kind: form')
        expect(result.source_url).toBe('file:///tmp/test.pdf')
        expect(result.ocr_used).toBe(false)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// snapshot_web_page — gated on real Chromium
// ──────────────────────────────────────────────────────────────────────────

const RUN_BROWSER_TESTS = process.env.AGENTMARK_INTEGRATION === '1'

describe.runIf(RUN_BROWSER_TESTS)('snapshot_web_page — real Chromium', () => {
    let serverUrl: string
    let server: import('node:http').Server

    beforeAll(async () => {
        const http = await import('node:http')
        server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<!doctype html><title>Test</title><h1>Hi</h1><button>X</button>')
        })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('no addr')
        serverUrl = `http://127.0.0.1:${addr.port}`
    })

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()))
    })

    it('captures a real page through the action', async () => {
        const result = await snapshotWebPage.run(
            fakeContext({
                url: serverUrl,
                wait_until: 'load',
                timeout_ms: 15_000,
                headless: true,
            }),
        )
        expect(result.title).toBe('Test')
        expect(result.bytes).toBeGreaterThan(50)
        expect(result.agentmark).toContain('kind: webpage')
    })
})

/**
 * Unit tests for the PDF → AgentMark converter pipeline.
 *
 * Generates fresh PDFs with `pdf-lib` so fixtures live in code (easy to
 * inspect and modify) rather than as committed binary files. Tests both
 * the extraction layer (text + metadata) and the higher-level converter
 * (heading inference, page markers, AgentMark serialization).
 */

import { describe, it, expect } from 'vitest'
import {
    PDFDocument,
    StandardFonts,
    rgb,
} from 'pdf-lib'
import { convertPdf } from '../../src/pdf/pdf-converter'
import { extractPdf } from '../../src/pdf/pdf-extractor'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../../src/validators/schema-validator'

interface BuildPdfOpts {
    title?: string
    author?: string
    pages: Array<{
        title?: { text: string; size?: number }
        sections?: Array<{ heading?: { text: string; size?: number }; paragraphs?: string[] }>
        bullets?: string[]
        body?: string
    }>
}

async function buildPdf(opts: BuildPdfOpts): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    if (opts.title) doc.setTitle(opts.title)
    if (opts.author) doc.setAuthor(opts.author)

    const helvetica = await doc.embedFont(StandardFonts.Helvetica)
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold)

    for (const pageSpec of opts.pages) {
        const page = doc.addPage([595, 842]) // A4
        let y = 800

        if (pageSpec.title) {
            const size = pageSpec.title.size ?? 24
            page.drawText(pageSpec.title.text, {
                x: 50,
                y,
                size,
                font: helveticaBold,
                color: rgb(0, 0, 0),
            })
            y -= size + 16
        }

        for (const section of pageSpec.sections ?? []) {
            if (section.heading) {
                const size = section.heading.size ?? 16
                page.drawText(section.heading.text, {
                    x: 50,
                    y,
                    size,
                    font: helveticaBold,
                })
                y -= size + 8
            }
            for (const para of section.paragraphs ?? []) {
                page.drawText(para, { x: 50, y, size: 11, font: helvetica })
                y -= 18
            }
            y -= 10
        }

        for (const bullet of pageSpec.bullets ?? []) {
            page.drawText(`• ${bullet}`, { x: 60, y, size: 11, font: helvetica })
            y -= 16
        }

        if (pageSpec.body) {
            page.drawText(pageSpec.body, { x: 50, y, size: 11, font: helvetica })
        }
    }

    return await doc.save()
}

describe('extractPdf', () => {
    it('reports correct page count and metadata', async () => {
        const pdf = await buildPdf({
            title: 'Test Doc',
            author: 'AgentMark',
            pages: [
                { body: 'Page one.' },
                { body: 'Page two.' },
                { body: 'Page three.' },
            ],
        })
        const result = await extractPdf({ data: pdf })
        expect(result.metadata.pages).toBe(3)
        expect(result.metadata.title).toBe('Test Doc')
        expect(result.metadata.author).toBe('AgentMark')
        expect(result.pages.length).toBe(3)
    })

    it('extracts text items with positions and font sizes', async () => {
        const pdf = await buildPdf({
            pages: [{ body: 'Hello world' }],
        })
        const result = await extractPdf({ data: pdf })
        const items = result.pages[0].items
        expect(items.length).toBeGreaterThan(0)
        // Should find "Hello world" content
        const allText = items.map((i) => i.text).join(' ')
        expect(allText).toMatch(/Hello/)
        expect(allText).toMatch(/world/)
        // Font size should be ~11
        expect(items[0].fontSize).toBeGreaterThan(8)
        expect(items[0].fontSize).toBeLessThan(15)
    })

    it('throws SnapshotError on invalid PDF bytes', async () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03])
        await expect(extractPdf({ data: garbage })).rejects.toMatchObject({
            code: 'snapshot_failed',
        })
    })

    it('accepts the same buffer twice without ArrayBuffer detachment errors', async () => {
        // Regression: pdfjs-dist transfers ownership of the underlying
        // ArrayBuffer during parse. extractPdf must defensively copy so
        // callers can pass the same Uint8Array to multiple calls.
        const pdf = await buildPdf({ pages: [{ body: 'Reusable bytes.' }] })
        const first = await extractPdf({ data: pdf })
        const second = await extractPdf({ data: pdf })
        expect(first.metadata.pages).toBe(1)
        expect(second.metadata.pages).toBe(1)
    })

    it('accepts a Node Buffer (Uint8Array subclass) without prototype mismatch', async () => {
        // Regression: pdfjs-dist's strict prototype check rejects Buffer.
        const pdf = await buildPdf({ pages: [{ body: 'Buffer compat.' }] })
        const buffer = Buffer.from(pdf)
        const result = await extractPdf({ data: buffer })
        expect(result.metadata.pages).toBe(1)
    })
})

describe('convertPdf', () => {
    it('produces a valid v0.2 document snapshot', async () => {
        const pdf = await buildPdf({
            title: 'Annual Report',
            author: 'Acme Inc.',
            pages: [
                {
                    title: { text: 'Annual Report 2025', size: 28 },
                    sections: [
                        {
                            heading: { text: 'Introduction', size: 16 },
                            paragraphs: [
                                'This is the introduction paragraph for the report.',
                                'It contains some company background information.',
                            ],
                        },
                    ],
                },
                {
                    sections: [
                        {
                            heading: { text: 'Financial Highlights', size: 16 },
                            paragraphs: ['Revenue grew 25 percent year-over-year.'],
                        },
                    ],
                    bullets: ['Q1 strong', 'Q2 record', 'Q3 steady', 'Q4 best ever'],
                },
            ],
        })

        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/annual-report.pdf',
        })

        // Snapshot is parseable + validates against v0.2 schema
        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('document')
        expect(snap.agentmark).toBe('0.2')
        expect(snap.url).toBe('file:///tmp/annual-report.pdf')
        expect(snap.title).toBe('Annual Report')

        // Document metadata populated
        expect(snap.document?.pages).toBe(2)
        expect(snap.document?.author).toBe('Acme Inc.')
        expect(snap.document?.format).toBe('pdf')
        expect(snap.document?.ocr_used).toBe(false)

        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
        expect(result.valid).toBe(true)
    })

    it('emits PAGE markers between pages', async () => {
        const pdf = await buildPdf({
            pages: [
                { body: 'First page content here.' },
                { body: 'Second page content here.' },
                { body: 'Third page content here.' },
            ],
        })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/multi.pdf',
        })
        expect(agentmark).toContain('[PAGE:p_1]')
        expect(agentmark).toContain('[PAGE:p_2]')
        expect(agentmark).toContain('[PAGE:p_3]')
    })

    it('promotes large-font text to headings', async () => {
        const pdf = await buildPdf({
            pages: [
                {
                    title: { text: 'Big Heading', size: 28 },
                    sections: [
                        {
                            paragraphs: ['Body text in a normal size font goes here.'],
                        },
                    ],
                },
            ],
        })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/heading.pdf',
        })
        // The 28pt title should become a heading; the 11pt body stays paragraph
        expect(agentmark).toMatch(/^# +Big Heading/m)
    })

    it('detects bullet lists', async () => {
        const pdf = await buildPdf({
            pages: [
                {
                    bullets: ['First item', 'Second item', 'Third item'],
                },
            ],
        })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/bullets.pdf',
        })
        // The body builder emits these as a Markdown list
        expect(agentmark).toMatch(/[-*] +First item/)
        expect(agentmark).toMatch(/[-*] +Second item/)
        expect(agentmark).toMatch(/[-*] +Third item/)
    })

    it('falls back to URL basename when title metadata is missing', async () => {
        const pdf = await buildPdf({
            // no title
            pages: [{ body: 'Content.' }],
        })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/my-document.pdf',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.title).toBe('my-document')
    })

    it('passes logger events end-to-end', async () => {
        const events: string[] = []
        const pdf = await buildPdf({ pages: [{ body: 'Hi.' }] })
        await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/x.pdf',
            logger: {
                debug: (e) => events.push(e),
                info: (e) => events.push(e),
                warn: (e) => events.push(e),
                error: (e) => events.push(e),
            },
        })
        expect(events).toContain('snapshot.capture.start')
        expect(events).toContain('snapshot.captured')
    })

    it('respects custom title override', async () => {
        const pdf = await buildPdf({
            title: 'PDF Internal Title',
            pages: [{ body: 'Hi.' }],
        })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/x.pdf',
            title: 'Override Title',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.title).toBe('Override Title')
    })

    it('handles documents with no extracted text gracefully', async () => {
        // Empty page (no text)
        const pdf = await buildPdf({ pages: [{}, {}] })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/empty.pdf',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('document')
        expect(snap.document?.pages).toBe(2)
        expect(agentmark).toContain('[PAGE:p_1]')
        expect(agentmark).toContain('[PAGE:p_2]')
    })

    it('vendor extensions pass through to the snapshot', async () => {
        const pdf = await buildPdf({ pages: [{ body: 'Content.' }] })
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/x.pdf',
            vendorExtensions: { 'x-custom-id': 'doc-42' },
        })
        expect(agentmark).toContain('x-custom-id')
        expect(agentmark).toContain('doc-42')
    })
})

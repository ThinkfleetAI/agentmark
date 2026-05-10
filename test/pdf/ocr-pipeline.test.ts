/**
 * Unit tests for the OCR pipeline integration in convertPdf.
 *
 * Uses mock RenderBackend + OcrBackend so tests are fast and deterministic.
 * Real Tesseract / Poppler are exercised via AGENTMARK_INTEGRATION=1 in
 * the integration suite.
 */

import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { convertPdf } from '../../src/pdf/pdf-converter'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import type {
    OcrBackend,
    OcrPageResult,
    RenderBackend,
    RenderedPage,
} from '../../src/pdf/ocr/types'

async function buildEmptyPdf(pages: number): Promise<Uint8Array> {
    // Build a PDF whose pages have no text — so the auto-OCR pathway fires.
    const doc = await PDFDocument.create()
    doc.setTitle('Image-Only Test')
    await doc.embedFont(StandardFonts.Helvetica) // ensure at least one font is referenced
    for (let i = 0; i < pages; i++) doc.addPage([595, 842])
    return await doc.save()
}

async function buildTextPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    doc.setTitle('Has Text')
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([595, 842])
    page.drawText('Hello world.', { x: 50, y: 800, size: 12, font })
    return await doc.save()
}

function mockRender(): RenderBackend & { calls: number } {
    return {
        name: 'mock-render',
        calls: 0,
        async renderPage(): Promise<RenderedPage> {
            this.calls++
            // 1×1 transparent PNG
            const tinyPng = new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
                0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
                0, 0, 0, 13, 73, 68, 65, 84, 8, 153, 99, 248, 255, 255, 63, 0,
                5, 0, 1, 254, 215, 17, 196, 70, 0, 0, 0, 0, 73, 69, 78, 68,
                174, 66, 96, 130,
            ])
            return {
                image: tinyPng,
                mimeType: 'image/png',
                width: 1,
                height: 1,
                dpi: 150,
            }
        },
    } as RenderBackend & { calls: number }
}

function mockOcr(textPerPage: string[]): OcrBackend & { calls: number } {
    let i = 0
    return {
        name: 'mock-ocr',
        calls: 0,
        async extractPage(): Promise<OcrPageResult> {
            this.calls++
            return {
                text: textPerPage[i++ % textPerPage.length] ?? 'mock text',
                confidence: 0.92,
            }
        },
        async close() {},
    } as OcrBackend & { calls: number }
}

describe('convertPdf — OCR pipeline integration', () => {
    it('mode "auto": invokes OCR only on pages with no extractable text', async () => {
        const pdf = await buildEmptyPdf(2)
        const render = mockRender()
        const ocr = mockOcr(['First page OCR.', 'Second page OCR.'])

        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/empty.pdf',
            ocr: { render, ocr, mode: 'auto' },
        })

        expect(render.calls).toBe(2)
        expect(ocr.calls).toBe(2)

        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('document')
        expect(snap.document?.ocr_used).toBe(true)
        expect(agentmark).toContain('First page OCR.')
        expect(agentmark).toContain('Second page OCR.')
    })

    it('mode "auto": skips OCR when text is already extracted', async () => {
        const pdf = await buildTextPdf()
        const render = mockRender()
        const ocr = mockOcr(['unused'])

        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/text.pdf',
            ocr: { render, ocr, mode: 'auto' },
        })

        // Page already had text → OCR backends should not be invoked
        expect(render.calls).toBe(0)
        expect(ocr.calls).toBe(0)

        const snap = parseSnapshot(agentmark)
        expect(snap.document?.ocr_used).toBe(false)
        expect(agentmark).toContain('Hello world')
    })

    it('mode "always": OCRs every page even if text is extracted', async () => {
        const pdf = await buildTextPdf()
        const render = mockRender()
        const ocr = mockOcr(['Always-OCR text overrides.'])

        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/text.pdf',
            ocr: { render, ocr, mode: 'always' },
        })

        expect(render.calls).toBe(1)
        expect(ocr.calls).toBe(1)

        const snap = parseSnapshot(agentmark)
        expect(snap.document?.ocr_used).toBe(true)
        expect(agentmark).toContain('Always-OCR text overrides')
    })

    it('mode "never": disables OCR entirely', async () => {
        const pdf = await buildEmptyPdf(2)
        const render = mockRender()
        const ocr = mockOcr(['unused'])

        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/empty.pdf',
            ocr: { render, ocr, mode: 'never' },
        })

        expect(render.calls).toBe(0)
        expect(ocr.calls).toBe(0)
        const snap = parseSnapshot(agentmark)
        expect(snap.document?.ocr_used).toBe(false)
    })

    it('omitting `ocr` from options leaves snapshots unaffected (backwards compat)', async () => {
        const pdf = await buildTextPdf()
        const { agentmark } = await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/text.pdf',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.document?.ocr_used).toBe(false)
        expect(agentmark).toContain('Hello world')
    })

    it('calls close() on both backends after processing (cleanup)', async () => {
        const pdf = await buildEmptyPdf(1)
        const render = mockRender()
        const renderClose = vi.fn()
        ;(render as RenderBackend).close = renderClose
        const ocr = mockOcr(['text'])
        const ocrClose = vi.fn()
        ;(ocr as OcrBackend).close = ocrClose

        await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/x.pdf',
            ocr: { render, ocr, mode: 'auto' },
        })

        expect(renderClose).toHaveBeenCalledTimes(1)
        expect(ocrClose).toHaveBeenCalledTimes(1)
    })

    it('OCR errors are wrapped — pipeline does not silently swallow them', async () => {
        const pdf = await buildEmptyPdf(1)
        const render = mockRender()
        const failingOcr: OcrBackend = {
            name: 'failing',
            async extractPage() {
                throw new Error('OCR backend exploded')
            },
        }

        await expect(
            convertPdf({
                data: pdf,
                sourceUrl: 'file:///tmp/x.pdf',
                ocr: { render, ocr: failingOcr, mode: 'auto' },
            }),
        ).rejects.toThrow(/OCR backend exploded/)
    })

    it('passes language + dpi options through to the OCR call', async () => {
        const pdf = await buildEmptyPdf(1)
        const render = mockRender()
        const ocr: OcrBackend & { receivedLanguage?: string; receivedDpi?: number } = {
            name: 'capture',
            async extractPage(_image, opts) {
                this.receivedLanguage = opts.language
                this.receivedDpi = opts.dpi
                return { text: 'ok', confidence: 1 }
            },
        }
        await convertPdf({
            data: pdf,
            sourceUrl: 'file:///tmp/x.pdf',
            ocr: { render, ocr, mode: 'auto', language: 'spa', dpi: 250 },
        })
        expect(ocr.receivedLanguage).toBe('spa')
        expect(ocr.receivedDpi).toBe(250)
    })
})

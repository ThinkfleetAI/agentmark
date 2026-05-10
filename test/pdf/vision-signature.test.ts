/**
 * Vision-based signature detection tests.
 *
 * Mocks both the RenderBackend and the VisionBackend so the test suite
 * stays deterministic + offline (real Claude/OpenAI calls are cost +
 * network-dependent).
 */

import { describe, it, expect, vi } from 'vitest'
import { VisionSignatureDetector } from '../../src/pdf/signatures/vision-detector'
import type { RenderBackend, RenderedPage } from '../../src/pdf/ocr/types'
import type { VisionBackend, AnalyzeResult } from '../../src/pdf/vision/types'
import type { ExtractedPdf } from '../../src/pdf/types'

function fakePdf(pageCount: number, withSignatureLabel?: number[]): ExtractedPdf {
    const pages = Array.from({ length: pageCount }, (_, i) => {
        const number = i + 1
        const items = withSignatureLabel?.includes(number)
            ? [{
                text: 'Signature:',
                fontSize: 11,
                fontName: 'Helvetica',
                x: 50,
                y: 100,
                width: 80,
                hasEol: false,
            }]
            : []
        return { number, width: 612, height: 792, items }
    })
    return { pages, metadata: { pages: pageCount, format: 'pdf' } }
}

function tinyPng(): Uint8Array {
    return new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
        0, 0, 0, 13, 73, 68, 65, 84, 8, 153, 99, 248, 255, 255, 63, 0,
        5, 0, 1, 254, 215, 17, 196, 70, 0, 0, 0, 0, 73, 69, 78, 68,
        174, 66, 96, 130,
    ])
}

function fakeRender(): RenderBackend & { calls: number[] } {
    return {
        name: 'fake_render',
        calls: [] as number[],
        async renderPage(_data, opts): Promise<RenderedPage> {
            this.calls.push(opts.pageNumber)
            return {
                image: tinyPng(),
                mimeType: 'image/png',
                width: 612 * 2,
                height: 792 * 2,
                dpi: 144,
            }
        },
    } as RenderBackend & { calls: number[] }
}

interface VisionResp {
    signatures: Array<{
        kind?: string
        bbox?: { x: number; y: number; width: number; height: number }
        inferred_role?: string
        signer_name?: string
        confidence: number
        notes?: string
    }>
}

function fakeVision(response: VisionResp): VisionBackend & { callCount: number } {
    return {
        name: 'fake_vision',
        callCount: 0,
        async analyze(): Promise<AnalyzeResult<VisionResp>> {
            this.callCount++
            return { structured: response, text: JSON.stringify(response) }
        },
    } as VisionBackend & { callCount: number }
}

describe('VisionSignatureDetector', () => {
    it('returns empty when no pages', async () => {
        const detector = new VisionSignatureDetector({
            render: fakeRender(),
            vision: fakeVision({ signatures: [] }),
        })
        const result = await detector.detect({
            extracted: { pages: [], metadata: { pages: 0, format: 'pdf' } },
            rawBytes: new Uint8Array(),
        })
        expect(result).toEqual([])
    })

    it('default mode "last" scans the last 2 pages', async () => {
        const render = fakeRender()
        const vision = fakeVision({ signatures: [] })
        const detector = new VisionSignatureDetector({ render, vision })
        await detector.detect({
            extracted: fakePdf(5),
            rawBytes: new Uint8Array(),
        })
        expect(render.calls).toEqual([4, 5])
        expect(vision.callCount).toBe(2)
    })

    it('mode "all" scans every page', async () => {
        const render = fakeRender()
        const vision = fakeVision({ signatures: [] })
        const detector = new VisionSignatureDetector({
            render,
            vision,
            pages: 'all',
        })
        await detector.detect({
            extracted: fakePdf(3),
            rawBytes: new Uint8Array(),
        })
        expect(render.calls).toEqual([1, 2, 3])
    })

    it('mode "flagged" scans only pages with signature label text', async () => {
        const render = fakeRender()
        const vision = fakeVision({ signatures: [] })
        const detector = new VisionSignatureDetector({
            render,
            vision,
            pages: 'flagged',
        })
        await detector.detect({
            extracted: fakePdf(5, [2, 4]),
            rawBytes: new Uint8Array(),
        })
        expect(render.calls).toEqual([2, 4])
    })

    it('explicit page-list mode scans only those pages', async () => {
        const render = fakeRender()
        const vision = fakeVision({ signatures: [] })
        const detector = new VisionSignatureDetector({
            render,
            vision,
            pages: [1, 3],
        })
        await detector.detect({
            extracted: fakePdf(5),
            rawBytes: new Uint8Array(),
        })
        expect(render.calls).toEqual([1, 3])
    })

    it('emits a DetectedSignature for each model-found signature', async () => {
        const detector = new VisionSignatureDetector({
            render: fakeRender(),
            vision: fakeVision({
                signatures: [
                    {
                        kind: 'image_handwritten',
                        bbox: { x: 0.1, y: 0.8, width: 0.3, height: 0.05 },
                        inferred_role: 'tenant',
                        signer_name: 'Jane Doe',
                        confidence: 0.92,
                        notes: 'Bottom-left of the page near a tenant label.',
                    },
                ],
            }),
        })
        const result = await detector.detect({
            extracted: fakePdf(1),
            rawBytes: new Uint8Array(),
        })
        expect(result).toHaveLength(1)
        const sig = result[0]
        expect(sig.kind).toBe('image_handwritten')
        expect(sig.inferred_role).toBe('tenant')
        expect(sig.signer_name).toBe('Jane Doe')
        expect(sig.confidence).toBe(0.92)
        expect(sig.notes).toMatch(/Vision \(fake_vision\):/)
        expect(sig.rect).toBeDefined()
        // bbox(x=0.1, y=0.8, w=0.3, h=0.05) on 612×792 page
        // PDF origin is bottom-left so y_pdf = 792 - (0.8 + 0.05) * 792
        expect(sig.rect!.x).toBeCloseTo(61.2, 0)
        expect(sig.rect!.width).toBeCloseTo(183.6, 0)
        expect(sig.rect!.height).toBeCloseTo(39.6, 0)
    })

    it('filters out detections below minConfidence', async () => {
        const detector = new VisionSignatureDetector({
            render: fakeRender(),
            vision: fakeVision({
                signatures: [
                    { confidence: 0.3 },
                    { confidence: 0.55 },
                    { confidence: 0.8 },
                ],
            }),
            minConfidence: 0.6,
        })
        const result = await detector.detect({
            extracted: fakePdf(1),
            rawBytes: new Uint8Array(),
        })
        expect(result.length).toBe(1)
        expect(result[0].confidence).toBe(0.8)
    })

    it('lowercases inferred_role and drops "unknown"', async () => {
        const detector = new VisionSignatureDetector({
            render: fakeRender(),
            vision: fakeVision({
                signatures: [
                    { confidence: 0.9, inferred_role: 'TENANT' },
                    { confidence: 0.9, inferred_role: 'unknown' },
                ],
            }),
        })
        const result = await detector.detect({
            extracted: fakePdf(1),
            rawBytes: new Uint8Array(),
        })
        expect(result[0].inferred_role).toBe('tenant')
        expect(result[1].inferred_role).toBeUndefined()
    })

    it('continues when one page render or analyze fails', async () => {
        let calls = 0
        const flakyVision: VisionBackend = {
            name: 'flaky',
            async analyze() {
                calls++
                if (calls === 1) throw new Error('model 500')
                return {
                    structured: { signatures: [{ confidence: 0.9 }] },
                    text: '',
                } as unknown as AnalyzeResult<VisionResp>
            },
        }
        const detector = new VisionSignatureDetector({
            render: fakeRender(),
            vision: flakyVision,
            pages: 'all',
        })
        const result = await detector.detect({
            extracted: fakePdf(2),
            rawBytes: new Uint8Array(),
        })
        // Page 1 failed, page 2 returned 1 signature.
        expect(result.length).toBe(1)
    })
})

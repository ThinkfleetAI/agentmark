/**
 * pdfjs-dist render backend.
 *
 * Pure-Node alternative to Poppler — uses pdfjs-dist's rendering pipeline
 * with `node-canvas` to rasterize pages. Heavier install (node-canvas is
 * a native module) but no system dependencies.
 *
 * Requires the optional peer dep `canvas`:
 *   npm install canvas
 *
 * On macOS / Linux node-canvas usually has prebuilt binaries; if it falls
 * back to compiling, you'll need cairo + pango + pixman installed.
 */

import { loadPdfjs } from '../pdfjs-loader'
import { SnapshotError } from '../../errors'
import type { RenderBackend, RenderPageOptions, RenderedPage } from './types'

// `canvas` is an optional peer dependency. We type it manually rather than
// `typeof import('canvas')` so TypeScript doesn't fail when the dep isn't
// installed (which is fine — callers who don't use PdfjsRenderBackend
// shouldn't need canvas).
interface CanvasModule {
    createCanvas(width: number, height: number): NodeCanvas
}
interface NodeCanvas {
    getContext(type: '2d'): unknown
    toBuffer(mimeType?: 'image/png'): Buffer
    toBuffer(mimeType: 'image/jpeg', config?: { quality?: number }): Buffer
}

let cachedCanvas: CanvasModule | null = null

async function loadCanvas(): Promise<CanvasModule> {
    if (cachedCanvas) return cachedCanvas
    try {
        // String-literal import path so callers without the dep can still
        // build — we only fail at runtime if PdfjsRenderBackend is used.
        cachedCanvas = (await import('canvas' as string)) as CanvasModule
        return cachedCanvas
    } catch (err) {
        throw new SnapshotError(
            'PdfjsRenderBackend requires the optional peer dependency `canvas`. '
            + 'Install with: npm install canvas',
            err as Error,
        )
    }
}

export class PdfjsRenderBackend implements RenderBackend {
    readonly name = 'pdfjs'

    async renderPage(pdfData: Uint8Array, opts: RenderPageOptions): Promise<RenderedPage> {
        const pdfjs = await loadPdfjs()
        const canvas = await loadCanvas()

        const dpi = opts.dpi ?? 150
        const format = opts.format ?? 'png'
        const scale = dpi / 72

        // Defensive copy — see notes in pdf-extractor.ts
        const data = new Uint8Array(
            pdfData instanceof ArrayBuffer
                ? new Uint8Array(pdfData)
                : new Uint8Array(pdfData.buffer, pdfData.byteOffset, pdfData.byteLength),
        )

        const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise
        try {
            const page = await doc.getPage(opts.pageNumber)
            const viewport = page.getViewport({ scale })

            const c = canvas.createCanvas(viewport.width, viewport.height)
            // pdfjs expects the standard CanvasRenderingContext2D API; node-canvas
            // is largely compatible. The cast bridges the structurally-similar
            // but separately-typed interfaces.
            const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D

            await page.render({
                canvasContext: ctx,
                viewport,
                // pdfjs-dist v4 renamed this property; keep for forward compat.
                canvas: c as unknown as HTMLCanvasElement,
            } as unknown as Parameters<typeof page.render>[0]).promise

            const image =
                format === 'jpeg'
                    ? c.toBuffer('image/jpeg', { quality: 0.85 })
                    : c.toBuffer('image/png')

            page.cleanup()

            return {
                image: new Uint8Array(image),
                mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
                width: viewport.width,
                height: viewport.height,
                dpi,
            }
        } finally {
            await doc.destroy()
        }
    }
}

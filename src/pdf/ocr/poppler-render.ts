/**
 * Poppler-based render backend.
 *
 * Shells out to `pdftoppm` from Poppler's command-line tools to rasterize
 * PDF pages. This is the lightest approach in Node — no native bindings,
 * no WASM, just a child process.
 *
 * Requires Poppler to be installed system-wide:
 *   macOS:   brew install poppler
 *   Linux:   apt-get install poppler-utils
 *   Windows: install via choco / scoop / WSL
 *
 * If `pdftoppm` is missing, `PopplerRenderBackend.renderPage()` throws a
 * `SnapshotError` with installation instructions on the first call.
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SnapshotError } from '../../errors'
import type { RenderBackend, RenderPageOptions, RenderedPage } from './types'

export interface PopplerRenderOptions {
    /** Override path to the pdftoppm binary. Default: 'pdftoppm' on $PATH. */
    binary?: string
    /** Anti-alias text rendering. Default: 'yes'. */
    antialias?: 'yes' | 'no'
}

export class PopplerRenderBackend implements RenderBackend {
    readonly name = 'poppler'
    private readonly binary: string
    private readonly antialias: 'yes' | 'no'
    private binaryChecked = false

    constructor(options: PopplerRenderOptions = {}) {
        this.binary = options.binary ?? 'pdftoppm'
        this.antialias = options.antialias ?? 'yes'
    }

    async renderPage(pdfData: Uint8Array, opts: RenderPageOptions): Promise<RenderedPage> {
        await this.ensureBinaryAvailable()

        const dpi = opts.dpi ?? 150
        const format = opts.format ?? 'png'
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentmark-poppler-'))
        const inputPdf = path.join(tmpDir, 'in.pdf')
        const outputBase = path.join(tmpDir, 'page')

        try {
            await writeFile(inputPdf, pdfData)

            const args = [
                '-f',
                String(opts.pageNumber),
                '-l',
                String(opts.pageNumber),
                '-r',
                String(dpi),
                format === 'jpeg' ? '-jpeg' : '-png',
                '-aa',
                this.antialias,
                '-aaVector',
                this.antialias,
                inputPdf,
                outputBase,
            ]

            await this.spawnPdftoppm(args)

            // pdftoppm names the output file with a zero-padded page number.
            const padding = String(opts.pageNumber).length < 2 ? '-1' : `-${opts.pageNumber}`
            const ext = format === 'jpeg' ? '.jpg' : '.png'
            // pdftoppm uses a non-fixed pad width — try common variants.
            const candidates = [
                `${outputBase}${padding}${ext}`,
                `${outputBase}-${String(opts.pageNumber).padStart(2, '0')}${ext}`,
                `${outputBase}-${String(opts.pageNumber).padStart(3, '0')}${ext}`,
                `${outputBase}-${opts.pageNumber}${ext}`,
            ]

            let imagePath: string | null = null
            for (const candidate of candidates) {
                try {
                    await readFile(candidate, { encoding: null })
                    imagePath = candidate
                    break
                } catch {
                    // not this one
                }
            }

            if (!imagePath) {
                throw new SnapshotError(
                    `pdftoppm produced no output for page ${opts.pageNumber}`,
                )
            }

            const image = await readFile(imagePath)
            const { width, height } = parseImageDimensions(image, format)

            return {
                image: new Uint8Array(image),
                mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
                width,
                height,
                dpi,
            }
        } finally {
            // Best-effort cleanup of the temp directory.
            await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
    }

    private async ensureBinaryAvailable(): Promise<void> {
        if (this.binaryChecked) return
        try {
            await this.spawnPdftoppm(['-v'])
            this.binaryChecked = true
        } catch (err) {
            throw new SnapshotError(
                `Could not run "${this.binary}". Install Poppler:\n`
                + `  macOS:   brew install poppler\n`
                + `  Linux:   apt-get install poppler-utils\n`
                + `  Windows: install via choco / scoop / WSL`,
                err as Error,
            )
        }
    }

    private spawnPdftoppm(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
            let stderr = ''
            proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
            proc.on('error', reject)
            proc.on('close', (code) => {
                if (code === 0) resolve()
                else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`))
            })
        })
    }
}

/**
 * Read width + height from a PNG or JPEG header without decoding the full
 * image. Lightweight enough to run in the hot path.
 */
function parseImageDimensions(buffer: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } {
    if (format === 'png') {
        // PNG: 8-byte signature, then IHDR chunk at offset 8: 4 bytes length + 4 bytes type ("IHDR") + 4 bytes width + 4 bytes height
        if (buffer.length < 24) return { width: 0, height: 0 }
        return {
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
        }
    }
    // JPEG: walk segments looking for SOFn (0xFFC0..0xFFC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF)
    let i = 2
    while (i < buffer.length - 9) {
        if (buffer[i] !== 0xff) {
            i++
            continue
        }
        const marker = buffer[i + 1]
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf)
        if (isSof) {
            return {
                height: buffer.readUInt16BE(i + 5),
                width: buffer.readUInt16BE(i + 7),
            }
        }
        const segLen = buffer.readUInt16BE(i + 2)
        i += 2 + segLen
    }
    return { width: 0, height: 0 }
}

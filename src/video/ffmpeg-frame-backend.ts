/**
 * Frame-extraction backend that shells out to `ffmpeg`.
 *
 * Requires ffmpeg installed system-wide:
 *   macOS:   brew install ffmpeg
 *   Linux:   apt-get install ffmpeg
 *   Windows: choco / scoop / official binaries
 *
 * If ffmpeg is missing, `extractFrames()` throws a SnapshotError with
 * installation instructions on the first call.
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SnapshotError } from '../errors'
import type {
    ExtractedFrame,
    ExtractFramesOptions,
    FrameExtractionBackend,
} from './types'

export interface FfmpegFrameBackendOptions {
    /** Override the ffmpeg binary path. Default: 'ffmpeg' on $PATH. */
    binary?: string
    /** Override the ffprobe binary path (used to read video duration). */
    ffprobeBinary?: string
}

export class FfmpegFrameBackend implements FrameExtractionBackend {
    readonly name = 'ffmpeg'
    private readonly binary: string
    private readonly ffprobeBinary: string
    private binaryChecked = false

    constructor(options: FfmpegFrameBackendOptions = {}) {
        this.binary = options.binary ?? 'ffmpeg'
        this.ffprobeBinary = options.ffprobeBinary ?? 'ffprobe'
    }

    async extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]> {
        await this.ensureBinaryAvailable()
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentmark-ffmpeg-'))
        const inputPath = path.join(tmpDir, 'input')
        const ext = opts.format ?? 'jpeg'

        try {
            await writeFile(inputPath, opts.data)

            const sampling = opts.sampling
            const args: string[] = ['-y', '-loglevel', 'error', '-i', inputPath]
            if ('every' in sampling) {
                args.push('-vf', `fps=1/${sampling.every}`)
            } else if ('count' in sampling) {
                const duration = await this.probeDuration(inputPath).catch(() => 0)
                if (duration > 0) {
                    const interval = duration / Math.max(sampling.count, 1)
                    args.push('-vf', `fps=1/${interval.toFixed(2)}`)
                } else {
                    args.push('-vf', 'thumbnail') // best fallback for "give me N frames"
                    args.push('-frames:v', String(sampling.count))
                }
            } else if (sampling.keyframes) {
                args.push('-vf', "select='eq(pict_type,I)'", '-vsync', 'vfr')
            }
            if (opts.width) args.push('-vf', `${args[args.length - 1] === ',' ? '' : ''}scale=${opts.width}:-1`)
            args.push('-q:v', '4') // jpeg quality 1-31, lower = better
            const outputPattern = path.join(tmpDir, `frame-%04d.${ext === 'png' ? 'png' : 'jpg'}`)
            args.push(outputPattern)

            await this.spawnFfmpeg(args)

            // Find emitted frames
            const entries = await readdir(tmpDir)
            const frameFiles = entries
                .filter((f) => f.startsWith('frame-') && (f.endsWith('.jpg') || f.endsWith('.png')))
                .sort()

            if (frameFiles.length === 0) return []

            // Compute timestamps for the emitted frames
            const timestamps = await this.computeTimestamps(sampling, frameFiles.length, inputPath)

            const frames: ExtractedFrame[] = []
            for (let i = 0; i < frameFiles.length; i++) {
                const buf = await readFile(path.join(tmpDir, frameFiles[i]))
                frames.push({
                    timestamp: timestamps[i] ?? 0,
                    image: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
                    mimeType: ext === 'png' ? 'image/png' : 'image/jpeg',
                })
            }
            return frames
        } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
    }

    private async ensureBinaryAvailable(): Promise<void> {
        if (this.binaryChecked) return
        try {
            await this.spawnFfmpeg(['-version'])
            this.binaryChecked = true
        } catch (err) {
            throw new SnapshotError(
                `Could not run "${this.binary}". Install ffmpeg:\n`
                + `  macOS:   brew install ffmpeg\n`
                + `  Linux:   apt-get install ffmpeg\n`
                + `  Windows: choco install ffmpeg / scoop install ffmpeg`,
                err as Error,
            )
        }
    }

    private spawnFfmpeg(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
            let stderr = ''
            proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
            proc.on('error', reject)
            proc.on('close', (code) => {
                if (code === 0) resolve()
                else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 1000)}`))
            })
        })
    }

    private async probeDuration(inputPath: string): Promise<number> {
        return await new Promise<number>((resolve, reject) => {
            const proc = spawn(this.ffprobeBinary, [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                inputPath,
            ], { stdio: ['ignore', 'pipe', 'ignore'] })
            let stdout = ''
            proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
            proc.on('error', reject)
            proc.on('close', () => {
                const dur = parseFloat(stdout.trim())
                resolve(Number.isFinite(dur) ? dur : 0)
            })
        })
    }

    private async computeTimestamps(
        sampling: ExtractFramesOptions['sampling'],
        frameCount: number,
        inputPath: string,
    ): Promise<number[]> {
        if ('every' in sampling) {
            return Array.from({ length: frameCount }, (_, i) => i * sampling.every)
        }
        if ('count' in sampling) {
            const duration = await this.probeDuration(inputPath).catch(() => 0)
            if (duration > 0 && frameCount > 0) {
                const interval = duration / frameCount
                return Array.from({ length: frameCount }, (_, i) => Math.round((i + 0.5) * interval))
            }
        }
        // keyframes — without parsing frame metadata we can't know exact timestamps;
        // return evenly distributed estimates.
        const duration = await this.probeDuration(inputPath).catch(() => 0)
        if (duration > 0 && frameCount > 0) {
            const interval = duration / frameCount
            return Array.from({ length: frameCount }, (_, i) => Math.round(i * interval))
        }
        return Array.from({ length: frameCount }, () => 0)
    }
}

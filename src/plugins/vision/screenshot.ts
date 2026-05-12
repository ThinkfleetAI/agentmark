/**
 * Full-screen screenshot capture for the Vision Pack.
 *
 * Shells out to OS-native CLI utilities — no native deps, no npm
 * packages. Each platform writes to a temp file, the temp is read, and
 * the file is removed.
 *
 *   macOS:   `screencapture -x <path>`                  (always installed)
 *   Linux:   `gnome-screenshot -f <path>` or `scrot <path>`
 *   Windows: PowerShell + .NET System.Drawing (built into .NET 8)
 *
 * Per-window captures aren't in v0 — they need bridge work (UIA / AXAPI
 * window-handle → PNG buffer). Full-screen is enough to unblock the
 * "AI vision fallback when accessibility is broken" use case: the
 * multimodal model can crop / target on its own from the full image.
 */
import { spawn } from 'node:child_process'
import { readFile, unlink, mkdir } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface ScreenshotOptions {
    /**
     * When set, the captured PNG is written here instead of being
     * returned in-band. Returns just { path, bytes }. Useful for large
     * captures where the agent doesn't need the raw image data and a
     * follow-up vision call can re-read from disk.
     */
    outputPath?: string
    /** Which display index to capture (default: primary). macOS-only — other
     *  platforms ignore this and capture the active screen. */
    displayIndex?: number
}

export interface ScreenshotResult {
    /** Where the PNG was written, if `outputPath` was supplied. */
    path?: string
    /** Base64-encoded PNG payload. Omitted when `outputPath` is set. */
    image_base64?: string
    /** Size in bytes. */
    bytes: number
    /** The CLI utility that produced the capture. */
    captured_by: 'screencapture' | 'gnome-screenshot' | 'scrot' | 'powershell'
    platform: NodeJS.Platform
}

export async function captureScreenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const tmpDir = path.join(os.tmpdir(), 'agentmark-screenshots')
    await mkdir(tmpDir, { recursive: true })
    const tmpPath = opts.outputPath ?? path.join(tmpDir, `screen-${process.pid}-${Date.now()}.png`)

    let capturedBy: ScreenshotResult['captured_by']
    try {
        if (process.platform === 'darwin') {
            capturedBy = 'screencapture'
            const args = ['-x']
            if (typeof opts.displayIndex === 'number') {
                args.push('-D', String(opts.displayIndex + 1)) // screencapture is 1-indexed
            }
            args.push(tmpPath)
            await runCommand('screencapture', args)
        } else if (process.platform === 'win32') {
            capturedBy = 'powershell'
            await runCommand('powershell', [
                '-NoProfile',
                '-Command',
                buildWindowsScreenshotScript(tmpPath),
            ])
        } else {
            const linuxResult = await captureLinux(tmpPath)
            capturedBy = linuxResult
        }
    } catch (err) {
        // Clean up any partial output before bubbling up.
        await unlink(tmpPath).catch(() => {})
        throw err
    }

    const bytes = await readFile(tmpPath)
    const sizeBytes = bytes.length

    if (opts.outputPath) {
        return {
            path: tmpPath,
            bytes: sizeBytes,
            captured_by: capturedBy,
            platform: process.platform,
        }
    }

    // In-band return — delete the temp file once read.
    await unlink(tmpPath).catch(() => {})
    return {
        image_base64: bytes.toString('base64'),
        bytes: sizeBytes,
        captured_by: capturedBy,
        platform: process.platform,
    }
}

async function captureLinux(targetPath: string): Promise<'gnome-screenshot' | 'scrot'> {
    try {
        await runCommand('gnome-screenshot', ['-f', targetPath])
        return 'gnome-screenshot'
    } catch {
        // fall through
    }
    try {
        await runCommand('scrot', [targetPath])
        return 'scrot'
    } catch {
        throw new Error(
            'Linux screenshot requires gnome-screenshot or scrot. '
            + 'Install one: `apt install gnome-screenshot` or `apt install scrot`.',
        )
    }
}

function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
        })
    })
}

function buildWindowsScreenshotScript(targetPath: string): string {
    // Native .NET 8 PowerShell snippet — no external module install needed.
    // System.Windows.Forms.Screen.PrimaryScreen.Bounds gives the full
    // primary monitor; CopyFromScreen draws it onto a Bitmap.
    const escaped = targetPath.replace(/'/g, "''")
    return [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
        "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
        "$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
        `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        "$gfx.Dispose()",
        "$bmp.Dispose()",
    ].join('; ')
}

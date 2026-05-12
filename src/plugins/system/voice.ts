/**
 * Native OS text-to-speech.
 *
 *   macOS:   `say "text"` (always installed)
 *   Windows: PowerShell + System.Speech.Synthesis (built into .NET on Win)
 *   Linux:   espeak / espeak-ng (install separately)
 *
 * Asynchronous — returns once the OS has accepted the request, but the
 * audio playback continues in background. Agents that want to wait for
 * playback completion need a future `voice_listen` integration that
 * isn't in v0.
 */
import { spawn } from 'node:child_process'

export interface SpeakOptions {
    /** Text to vocalise. */
    text: string
    /** Voice name (platform-specific). macOS: say -v ?, Win: SAPI installed voice. */
    voice?: string
    /** Words per minute. Maps to platform-native rate scaling. */
    rate?: number
}

export async function speak(opts: SpeakOptions): Promise<void> {
    if (!opts.text) throw new Error('speak: text is required.')

    if (process.platform === 'darwin') {
        await speakMac(opts)
    } else if (process.platform === 'win32') {
        await speakWindows(opts)
    } else {
        await speakLinux(opts)
    }
}

async function speakMac(opts: SpeakOptions): Promise<void> {
    const args: string[] = []
    if (opts.voice) args.push('-v', opts.voice)
    if (typeof opts.rate === 'number') args.push('-r', String(opts.rate))
    args.push(opts.text)
    await runCommand('say', args)
}

async function speakWindows(opts: SpeakOptions): Promise<void> {
    // SAPI rate is -10..+10 mapping to roughly 100..400 wpm. Convert from
    // wpm if supplied: 100 → -10, 250 → 0, 400 → +10 (linear).
    const rateStmt = typeof opts.rate === 'number'
        ? `; $synth.Rate = [int]([math]::Max(-10, [math]::Min(10, ($args[0]) / 25 - 10))) -as [int]`
        : ''
    const voiceStmt = opts.voice ? `; $synth.SelectVoice('${escapeForPs(opts.voice)}')` : ''
    const text = escapeForPs(opts.text)
    const script = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer${voiceStmt}${rateStmt}; $synth.Speak('${text}')`
    const args = ['-NoProfile', '-Command', script]
    if (typeof opts.rate === 'number') args.push(String(opts.rate))
    await runCommand('powershell', args)
}

async function speakLinux(opts: SpeakOptions): Promise<void> {
    const args: string[] = []
    if (opts.voice) args.push('-v', opts.voice)
    if (typeof opts.rate === 'number') args.push('-s', String(opts.rate))
    args.push(opts.text)
    for (const cmd of ['espeak-ng', 'espeak'] as const) {
        try {
            await runCommand(cmd, args)
            return
        } catch {
            continue
        }
    }
    throw new Error(
        'Linux TTS requires espeak-ng or espeak. '
        + 'Install: `apt install espeak-ng` (Debian/Ubuntu).',
    )
}

function escapeForPs(s: string): string {
    return s.replace(/'/g, "''")
}

function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
        })
    })
}

/**
 * Cross-platform clipboard access.
 *
 * No external dependencies — shells out to the OS-provided clipboard
 * utility on each platform:
 *   - macOS:   pbcopy / pbpaste
 *   - Windows: PowerShell Get-Clipboard / Set-Clipboard
 *   - Linux:   xclip (preferred) or xsel as fallback; wl-paste on Wayland
 *
 * Only text is supported in this first pass. HTML and image clipboards
 * are valuable but each requires platform-specific incantations (CF_HTML
 * with envelope on Windows, NSPasteboardItem on Mac); shipping later.
 */
import { spawn } from 'node:child_process'

export async function readClipboardText(): Promise<string> {
    if (process.platform === 'darwin') {
        return await runForOutput('pbpaste', [])
    }
    if (process.platform === 'win32') {
        // -Raw avoids PowerShell appending a trailing CRLF on the final line.
        // -OutputBuffer suppresses Get-Clipboard's deprecation warning.
        const out = await runForOutput('powershell', [
            '-NoProfile',
            '-Command',
            'Get-Clipboard -Raw',
        ])
        // PowerShell ends with `\r\n` of its own; strip exactly one trailing
        // newline to match pbpaste / xclip behavior.
        return out.replace(/\r?\n$/, '')
    }
    // Linux: try wl-paste (Wayland) → xclip → xsel.
    for (const [cmd, args] of [
        ['wl-paste', ['--no-newline']],
        ['xclip', ['-selection', 'clipboard', '-out']],
        ['xsel', ['--clipboard', '--output']],
    ] as const) {
        try {
            return await runForOutput(cmd, [...args])
        } catch {
            continue
        }
    }
    throw new Error(
        'Clipboard read on Linux requires wl-paste, xclip, or xsel. '
        + 'Install one: `apt install xclip` (X11) or `apt install wl-clipboard` (Wayland).',
    )
}

export async function writeClipboardText(text: string): Promise<void> {
    if (process.platform === 'darwin') {
        await runWithInput('pbcopy', [], text)
        return
    }
    if (process.platform === 'win32') {
        // Set-Clipboard reads stdin when -Value isn't supplied; the
        // simpler form avoids escaping nightmares for arbitrary text.
        await runWithInput('powershell', [
            '-NoProfile',
            '-Command',
            '$input | Set-Clipboard',
        ], text)
        return
    }
    for (const [cmd, args] of [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard', '-in']],
        ['xsel', ['--clipboard', '--input']],
    ] as const) {
        try {
            await runWithInput(cmd, [...args], text)
            return
        } catch {
            continue
        }
    }
    throw new Error(
        'Clipboard write on Linux requires wl-copy, xclip, or xsel.',
    )
}

function runForOutput(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve(stdout)
            else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
        })
    })
}

function runWithInput(command: string, args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
        })
        child.stdin.write(input)
        child.stdin.end()
    })
}

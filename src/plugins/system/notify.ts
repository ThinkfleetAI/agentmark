/**
 * Native OS notifications.
 *
 *   macOS:   osascript display notification (always installed)
 *   Windows: PowerShell + Windows.UI.Notifications (built into Win 10+)
 *   Linux:   notify-send (libnotify-bin; standard on most desktops)
 *
 * Used by agents to ping the human: "I'm waiting on you", "background
 * job finished", "I need confirmation". Display only — there's no
 * "did the user click?" callback; we don't need full toast actions
 * yet.
 */
import { spawn } from 'node:child_process'

export interface NotifyOptions {
    title: string
    body?: string
    /** Optional subtitle (macOS only — other platforms append to title). */
    subtitle?: string
    /** Play the default notification sound. Default: false. */
    sound?: boolean
}

export async function notify(opts: NotifyOptions): Promise<void> {
    if (!opts.title) throw new Error('notify: title is required.')

    if (process.platform === 'darwin') {
        await notifyMac(opts)
    } else if (process.platform === 'win32') {
        await notifyWindows(opts)
    } else {
        await notifyLinux(opts)
    }
}

async function notifyMac(opts: NotifyOptions): Promise<void> {
    // osascript -e 'display notification "body" with title "title" subtitle "..." sound name "default"'
    const parts: string[] = [`display notification "${escapeAppleScript(opts.body ?? '')}" with title "${escapeAppleScript(opts.title)}"`]
    if (opts.subtitle) parts.push(`subtitle "${escapeAppleScript(opts.subtitle)}"`)
    if (opts.sound) parts.push('sound name "default"')
    await runCommand('osascript', ['-e', parts.join(' ')])
}

async function notifyWindows(opts: NotifyOptions): Promise<void> {
    // Use the Windows.UI.Notifications toast API — built into Win 10/11.
    // No external module install required.
    const title = escapeForPowerShell(opts.title)
    const body = escapeForPowerShell(opts.body ?? opts.subtitle ?? '')
    const script = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
        `$xml = '<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>'`,
        '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$doc.LoadXml($xml)',
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("AgentMark").Show($toast)',
    ].join('; ')
    await runCommand('powershell', ['-NoProfile', '-Command', script])
}

async function notifyLinux(opts: NotifyOptions): Promise<void> {
    const args = [opts.title]
    if (opts.body) args.push(opts.body)
    try {
        await runCommand('notify-send', args)
    } catch {
        throw new Error(
            'Linux notifications require `notify-send` from libnotify-bin. '
            + 'Install: `apt install libnotify-bin` (Debian/Ubuntu).',
        )
    }
}

function escapeAppleScript(s: string): string {
    // AppleScript strings are double-quoted; escape backslashes and quotes.
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeForPowerShell(s: string): string {
    // We're emitting a literal XML string inside single-quoted PowerShell,
    // then loading via LoadXml — escape XML special chars + the single quote
    // that would close the PS string.
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, "''")
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

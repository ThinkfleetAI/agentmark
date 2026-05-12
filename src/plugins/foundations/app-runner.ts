/**
 * Cross-platform application launcher.
 *
 * Handles three invocation shapes:
 *   1. App name        — "Excel", "Calculator"; resolved via OS file
 *                        associations / Launch Services / Start Menu.
 *   2. Absolute path   — "C:\\path\\to\\app.exe", "/Applications/Excel.app"
 *   3. File path       — "report.xlsx" → opened in the default associated app.
 *
 * The shape is detected automatically. On macOS we shell out to `open`
 * (handles all three transparently); on Windows we use `start` for the
 * same effect; on Linux we use `xdg-open` for files and direct spawn
 * for binaries.
 */
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import * as path from 'node:path'

export interface RunAppOptions {
    /** App name, absolute path to a binary/bundle, or file path. */
    command: string
    /** Extra arguments forwarded to the launched app. */
    args?: string[]
    /** Working directory for the spawned process. Default: process.cwd(). */
    cwd?: string
    /** Detach so the spawned process survives the MCP server's death. Default: true. */
    detached?: boolean
}

export interface RunAppResult {
    /** OS process id of the launcher invocation. The launched app may run
     *  as a child of this (Mac `open`, Windows `start`) — agents should
     *  use `agentmark_desktop_list_targets` to find the actual window. */
    pid: number
    /** What was actually invoked (resolved command + args), for diagnostics. */
    command: string
    args: string[]
    platform: NodeJS.Platform
}

export async function runApp(opts: RunAppOptions): Promise<RunAppResult> {
    const { command, args = [], cwd, detached = true } = opts
    if (!command) throw new Error('runApp: command is required.')

    const platform = process.platform
    const resolved = await resolveLaunch(command, args, platform)

    const child = spawn(resolved.command, resolved.args, {
        cwd,
        detached,
        stdio: 'ignore',
        windowsHide: false,
    })

    if (detached) child.unref()

    if (!child.pid) {
        throw new Error(
            `runApp: failed to spawn ${resolved.command}. The OS rejected the launch.`,
        )
    }

    return {
        pid: child.pid,
        command: resolved.command,
        args: resolved.args,
        platform,
    }
}

interface ResolvedLaunch {
    command: string
    args: string[]
}

async function resolveLaunch(
    command: string,
    args: string[],
    platform: NodeJS.Platform,
): Promise<ResolvedLaunch> {
    const isAbsolute = path.isAbsolute(command)
    let existsAsFile = false
    if (isAbsolute) {
        try {
            await access(command, constants.F_OK)
            existsAsFile = true
        } catch {
            existsAsFile = false
        }
    }

    if (platform === 'darwin') {
        // `open` handles app bundles, file paths, and app names equally.
        // Use -a only when we have a bare app name; let `open` infer
        // otherwise so file associations work.
        if (existsAsFile || isAbsolute) {
            return { command: 'open', args: [command, ...maybeArgs(args)] }
        }
        return { command: 'open', args: ['-a', command, ...maybeArgs(args)] }
    }

    if (platform === 'win32') {
        // `cmd /c start "" "<command>" args...` makes Windows resolve via
        // file associations / Start Menu when `<command>` isn't an absolute
        // exe. The empty title arg is required syntax for `start`.
        return {
            command: 'cmd',
            args: ['/c', 'start', '""', command, ...args],
        }
    }

    // Linux / other Unix
    if (existsAsFile || !looksLikeFile(command)) {
        return { command, args }
    }
    return { command: 'xdg-open', args: [command, ...args] }
}

function maybeArgs(args: string[]): string[] {
    if (args.length === 0) return []
    // macOS `open` passes args via `--args` (everything after is forwarded
    // to the launched app).
    return ['--args', ...args]
}

function looksLikeFile(command: string): boolean {
    // Heuristic: if the command has an extension and a path separator OR
    // ends in a known document extension, treat it as a file path.
    const ext = path.extname(command).toLowerCase()
    if (!ext) return false
    return /\.(xlsx|xls|docx|doc|pptx|ppt|pdf|txt|csv|md|html|jpg|jpeg|png|gif)$/.test(ext)
}

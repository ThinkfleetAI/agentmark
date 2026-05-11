/**
 * WindowsUiaBackend — DesktopCaptureBackend that drives a real Windows
 * machine via the agentmark-bridge-windows.exe sidecar process.
 *
 * Architecture:
 *
 *      Node                                         Windows native
 *   ┌────────────────────┐  stdio JSON-RPC 2.0   ┌────────────────────────┐
 *   │ WindowsUiaBackend  │ ◄──────────────────►  │ agentmark-bridge-      │
 *   │  (this file)       │                       │  windows.exe (.NET 8)  │
 *   │                    │                       │   ↳ FlaUI / UIA3       │
 *   └────────────────────┘                       └────────────────────────┘
 *           ▲
 *           │ DesktopCaptureBackend contract
 *           │
 *   ┌────────────────────┐
 *   │ convertDesktop()   │
 *   │ MCP server         │
 *   │ ...any consumer    │
 *   └────────────────────┘
 *
 * The bridge process is spawned lazily on the first capture/execute
 * call and reused for the lifetime of the backend. close() shuts it
 * down. Multiple in-flight calls are serialised by id; the bridge
 * processes them sequentially on its STA worker thread.
 *
 * Bridge resolution order:
 *   1. options.bridgePath (explicit)
 *   2. AGENTMARK_BRIDGE_PATH environment variable
 *   3. Walk up from __dirname looking for
 *      apps/agent-runner/bridges/windows/bin/{Debug,Release}/net8.0-windows/
 *      agentmark-bridge-windows.exe (works in both monorepo dev mode and
 *      Parallels-shared-folder layouts)
 *   4. Throw a helpful error pointing at the build command + env var
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { Readable, Writable } from 'node:stream'

import { noopLogger, type Logger } from '../observability/logger'
import type {
    CaptureDesktopOptions,
    DesktopCapture,
    DesktopCaptureBackend,
    ExecuteDesktopAction,
    ExecuteDesktopOptions,
    ExecuteDesktopResult,
    KeyModifier,
} from './types'

export interface WindowsUiaBackendOptions {
    /** Absolute path to agentmark-bridge-windows.exe. When omitted the
     *  backend looks at AGENTMARK_BRIDGE_PATH then walks up from the
     *  package directory probing common dev-build paths. */
    bridgePath?: string

    /** Max time to wait for the bridge to respond to its first ping
     *  before declaring startup failed. Default: 10000. */
    startupTimeoutMs?: number

    /** Per-call timeout when the bridge appears stuck. Default: 30000. */
    callTimeoutMs?: number

    /** Structured logger. */
    logger?: Logger

    /** Bypass the `process.platform === 'win32'` guard. Intended for
     *  unit tests that supply a mock bridge path; production should
     *  never use this. */
    allowNonWindows?: boolean
}

interface PendingCall {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    method: string
    timeout: NodeJS.Timeout
}

interface JsonRpcResponse {
    jsonrpc: '2.0'
    id: number
    result?: unknown
    error?: { code: number; message: string }
}

export class WindowsUiaBackend implements DesktopCaptureBackend {
    readonly name = 'windows_uia'

    private readonly bridgePath: string
    private readonly logger: Logger
    private readonly startupTimeoutMs: number
    private readonly callTimeoutMs: number

    private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null
    private rl: ReadlineInterface | null = null
    private pending = new Map<number, PendingCall>()
    private nextId = 1
    private starting: Promise<void> | null = null
    private closed = false

    constructor(opts: WindowsUiaBackendOptions = {}) {
        if (process.platform !== 'win32' && !opts.allowNonWindows) {
            throw new Error(
                `WindowsUiaBackend requires Windows (process.platform=='win32'). `
                + `Current platform: ${process.platform}. For tests that supply `
                + `a fake bridge, pass allowNonWindows: true.`,
            )
        }
        this.bridgePath = opts.bridgePath ?? resolveBridgePath()
        this.logger = opts.logger ?? noopLogger
        this.startupTimeoutMs = opts.startupTimeoutMs ?? 10_000
        this.callTimeoutMs = opts.callTimeoutMs ?? 30_000
    }

    // ── DesktopCaptureBackend implementation ─────────────────────────

    async capture(opts: CaptureDesktopOptions = {}): Promise<DesktopCapture> {
        await this.ensureStarted()
        const params = {
            processName: opts.target?.process_name,
            processId: opts.target?.process_id,
            windowTitle: opts.target?.window_title,
            windowId: opts.target?.window_id,
            maxDepth: opts.maxDepth,
            includeHidden: opts.includeHidden,
            timeoutMs: opts.timeoutMs,
        }
        const result = (await this.call('capture', params)) as RawDesktopCapture
        return mapCaptureResponse(result)
    }

    async execute(opts: ExecuteDesktopOptions): Promise<ExecuteDesktopResult> {
        await this.ensureStarted()
        const params = buildExecuteParams(opts.action)
        if (opts.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs

        const result = (await this.call('execute', params)) as RawExecuteResult
        return {
            ok: !!result.ok,
            message: result.message ?? undefined,
            new_value: result.newValue ?? undefined,
        }
    }

    async close(): Promise<void> {
        this.closed = true
        const proc = this.proc
        if (!proc) return

        // Reject any pending calls.
        for (const [id, slot] of this.pending) {
            clearTimeout(slot.timeout)
            slot.reject(new Error(`Bridge closed before ${slot.method} (id=${id}) completed`))
        }
        this.pending.clear()

        // Close stdin so the bridge sees EOF and exits cleanly.
        try { proc.stdin.end() } catch { /* swallow */ }

        // Give it 2 seconds, then SIGKILL.
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                try { proc.kill('SIGKILL') } catch { /* swallow */ }
                resolve()
            }, 2000)
            proc.once('exit', () => {
                clearTimeout(timeout)
                resolve()
            })
        })

        this.proc = null
        this.rl?.close()
        this.rl = null
    }

    // ── Lifecycle ─────────────────────────────────────────────────────

    private ensureStarted(): Promise<void> {
        if (this.closed) {
            return Promise.reject(new Error('WindowsUiaBackend was closed; create a new instance.'))
        }
        if (this.proc) return Promise.resolve()
        if (this.starting) return this.starting

        this.starting = this.spawnAndHandshake()
            .catch((err) => {
                // Clear so a subsequent call can retry; rethrow for this attempt.
                this.starting = null
                throw err
            })
            .finally(() => {
                if (this.proc) this.starting = null
            })
        return this.starting
    }

    private async spawnAndHandshake(): Promise<void> {
        this.logger.debug('windows-uia.spawn', { bridgePath: this.bridgePath })

        const proc = spawn(this.bridgePath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }) as ChildProcessByStdio<Writable, Readable, Readable>

        this.proc = proc

        proc.on('error', (err) => {
            this.logger.error('windows-uia.spawn-error', { error: err.message })
            this.failAllPending(new Error(`Bridge process error: ${err.message}`))
        })

        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (chunk: string) => {
            // Bridge writes diagnostics to stderr — surface at debug.
            const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0)
            for (const line of lines) {
                this.logger.debug('windows-uia.bridge-stderr', { line })
            }
        })

        proc.on('exit', (code, signal) => {
            this.logger.info('windows-uia.bridge-exit', { code, signal })
            this.failAllPending(new Error(`Bridge process exited (code=${code}, signal=${signal})`))
            this.proc = null
            this.rl?.close()
            this.rl = null
        })

        const rl = createInterface({ input: proc.stdout })
        this.rl = rl
        rl.on('line', (line) => this.handleResponseLine(line))

        // Handshake: ping with a startup-specific timeout.
        const originalTimeout = this.callTimeoutMs
        try {
            await this.callWithTimeout('ping', {}, this.startupTimeoutMs)
        } catch (err) {
            // Tear down the half-started bridge so a retry starts clean.
            try { proc.kill('SIGKILL') } catch { /* swallow */ }
            this.proc = null
            this.rl?.close()
            this.rl = null
            throw new Error(`Bridge handshake failed: ${(err as Error).message}`)
        }
    }

    // ── JSON-RPC plumbing ─────────────────────────────────────────────

    private call(method: string, params: Record<string, unknown>): Promise<unknown> {
        return this.callWithTimeout(method, params, this.callTimeoutMs)
    }

    private callWithTimeout(
        method: string,
        params: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<unknown> {
        const proc = this.proc
        if (!proc) return Promise.reject(new Error('Bridge process not started'))

        const id = this.nextId++
        // Drop undefined fields so the bridge sees a tidy payload.
        const tidyParams: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) tidyParams[k] = v
        }
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: tidyParams }) + '\n'

        return new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Bridge call ${method} (id=${id}) timed out after ${timeoutMs}ms`))
            }, timeoutMs)

            this.pending.set(id, { resolve, reject, method, timeout })
            try {
                proc.stdin.write(frame, (err) => {
                    if (err) {
                        clearTimeout(timeout)
                        this.pending.delete(id)
                        reject(err)
                    }
                })
            } catch (err) {
                clearTimeout(timeout)
                this.pending.delete(id)
                reject(err as Error)
            }
        })
    }

    private handleResponseLine(line: string): void {
        const trimmed = line.trim()
        if (trimmed.length === 0) return

        let msg: JsonRpcResponse
        try {
            msg = JSON.parse(trimmed) as JsonRpcResponse
        } catch (err) {
            this.logger.warn('windows-uia.invalid-frame', { line: trimmed.slice(0, 200) })
            return
        }

        const slot = this.pending.get(msg.id)
        if (!slot) {
            this.logger.warn('windows-uia.orphan-response', { id: msg.id })
            return
        }
        this.pending.delete(msg.id)
        clearTimeout(slot.timeout)

        if (msg.error) {
            slot.reject(new Error(`[bridge ${msg.error.code}] ${msg.error.message}`))
            return
        }
        slot.resolve(msg.result)
    }

    private failAllPending(err: Error): void {
        for (const [, slot] of this.pending) {
            clearTimeout(slot.timeout)
            slot.reject(err)
        }
        this.pending.clear()
    }
}

// ──────────────────────────────────────────────────────────────────────
// Param mapping
// ──────────────────────────────────────────────────────────────────────

function buildExecuteParams(action: ExecuteDesktopAction): Record<string, unknown> {
    // The bridge accepts a flat payload with `actionType` plus only the
    // fields the action uses. Keep this in sync with HandleExecute in
    // Program.cs on the C# side.
    const base: Record<string, unknown> = {
        actionType: action.type,
        elementId: 'element_id' in action ? action.element_id : undefined,
    }

    switch (action.type) {
        case 'click':
        case 'focus':
        case 'scroll_to':
            break
        case 'type':
            base.text = action.text
            if (action.clear_first) base.clearFirst = true
            break
        case 'select':
            base.value = action.value
            break
        case 'check':
            base.checked = action.checked
            break
        case 'expand':
            base.expanded = action.expanded
            break
        case 'key':
            base.key = action.key
            if (action.modifiers && action.modifiers.length > 0) {
                base.modifiers = action.modifiers as readonly KeyModifier[]
            }
            break
        default: {
            // exhaustiveness check — switch is closed over the union
            const _exhaustive: never = action
            void _exhaustive
        }
    }
    return base
}

// ──────────────────────────────────────────────────────────────────────
// Bridge path resolution
// ──────────────────────────────────────────────────────────────────────

const BRIDGE_EXE = 'agentmark-bridge-windows.exe'
const RELATIVE_BRIDGE_PATHS = [
    path.join('apps', 'agent-runner', 'bridges', 'windows', 'bin', 'Release', 'net8.0-windows', BRIDGE_EXE),
    path.join('apps', 'agent-runner', 'bridges', 'windows', 'bin', 'Debug', 'net8.0-windows', BRIDGE_EXE),
]

function resolveBridgePath(): string {
    const fromEnv = process.env.AGENTMARK_BRIDGE_PATH
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

    // Package compiles to CommonJS; __dirname is always defined.
    const startDir = __dirname

    let current = startDir
    for (let i = 0; i < 8; i++) {
        for (const rel of RELATIVE_BRIDGE_PATHS) {
            const candidate = path.join(current, rel)
            if (fs.existsSync(candidate)) return candidate
        }
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
    }

    throw new Error(
        `Cannot find ${BRIDGE_EXE}. Tried AGENTMARK_BRIDGE_PATH env var and `
        + `walked up from ${startDir}. Build the bridge with:\n`
        + `  cd apps/agent-runner/bridges/windows && dotnet build\n`
        + `Or set AGENTMARK_BRIDGE_PATH to an existing exe.`,
    )
}

// ──────────────────────────────────────────────────────────────────────
// Wire format — raw shapes returned by the bridge
// ──────────────────────────────────────────────────────────────────────

interface RawDesktopCapture {
    platform: 'windows' | 'macos' | 'linux'
    processName?: string | null
    processId?: number | null
    windowTitle: string
    windowClass?: string | null
    windowId: string
    focusedElementId?: string | null
    treeDepth: number
    elementCount: number
    root: RawDesktopElement
}

interface RawDesktopElement {
    id: string
    role: string
    name?: string | null
    value?: string | null
    placeholder?: string | null
    enabled?: boolean | null
    selected?: boolean | null
    readOnly?: boolean | null
    expanded?: boolean | null
    aria?: {
        pressed?: boolean | null
        checked?: boolean | 'mixed' | null
        required?: boolean | null
        invalid?: boolean | null
    } | null
    bounds?: { x: number; y: number; width: number; height: number } | null
    children?: RawDesktopElement[] | null
}

interface RawExecuteResult {
    ok: boolean
    message?: string | null
    newValue?: string | null
}

function mapCaptureResponse(raw: RawDesktopCapture): DesktopCapture {
    return {
        platform: raw.platform,
        process_name: raw.processName ?? undefined,
        process_id: raw.processId ?? undefined,
        window_title: raw.windowTitle,
        window_class: raw.windowClass ?? undefined,
        window_id: raw.windowId,
        focused_element_id: raw.focusedElementId ?? undefined,
        tree_depth: raw.treeDepth,
        element_count: raw.elementCount,
        root: mapElement(raw.root),
    }
}

function mapElement(raw: RawDesktopElement): import('./types').DesktopElement {
    return {
        id: raw.id,
        role: raw.role as import('./types').DesktopRole,
        name: raw.name ?? undefined,
        value: raw.value ?? undefined,
        placeholder: raw.placeholder ?? undefined,
        enabled: raw.enabled ?? undefined,
        selected: raw.selected ?? undefined,
        read_only: raw.readOnly ?? undefined,
        expanded: raw.expanded ?? undefined,
        aria: raw.aria ? {
            pressed: raw.aria.pressed ?? undefined,
            checked: raw.aria.checked ?? undefined,
            required: raw.aria.required ?? undefined,
            invalid: raw.aria.invalid ?? undefined,
        } : undefined,
        bounds: raw.bounds ?? undefined,
        children: raw.children ? raw.children.map(mapElement) : undefined,
    }
}

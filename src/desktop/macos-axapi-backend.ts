/**
 * MacosAxapiBackend — DesktopCaptureBackend that drives a real macOS
 * machine via the agentmark-bridge-macos sidecar process (Swift /
 * AXAPI).
 *
 * Architecture mirrors `WindowsUiaBackend` exactly — same JSON-RPC
 * protocol, same spawn/handshake/correlate-by-id pattern, same
 * close lifecycle. The only macOS-specific bits are the bridge binary
 * resolution paths and the platform check.
 *
 * The two backends share ~90% of their code; a future cleanup pass
 * can extract a shared `SubprocessBridgeBackend` base class. Keeping
 * them parallel for now so each one is reviewable on its own.
 *
 * Accessibility permission note: macOS guards AXAPI behind System
 * Settings → Privacy & Security → Accessibility. The PARENT process
 * (Claude Desktop, the AgentMark MCP server, or the terminal during
 * dev) must be granted — granting the bridge binary alone is not
 * sufficient because AXAPI inherits the calling process's trust. If
 * permission is missing, the bridge returns a clear
 * `accessibilityNotGranted` JSON-RPC error (code -32020) on the
 * first capture/execute call.
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
    DesktopTargetSummary,
    ExecuteDesktopAction,
    ExecuteDesktopBatchOptions,
    ExecuteDesktopBatchResult,
    ExecuteDesktopOptions,
    ExecuteDesktopResult,
    KeyModifier,
} from './types'

export interface MacosAxapiBackendOptions {
    /** Absolute path to agentmark-bridge-macos. When omitted the
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

    /** Bypass the `process.platform === 'darwin'` guard. Intended for
     *  unit tests that supply a mock bridge path; production should
     *  never use this. */
    allowNonMac?: boolean
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

export class MacosAxapiBackend implements DesktopCaptureBackend {
    readonly name = 'macos_axapi'

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

    constructor(opts: MacosAxapiBackendOptions = {}) {
        if (process.platform !== 'darwin' && !opts.allowNonMac) {
            throw new Error(
                `MacosAxapiBackend requires macOS (process.platform=='darwin'). `
                + `Current platform: ${process.platform}. For tests that supply `
                + `a fake bridge, pass allowNonMac: true.`,
            )
        }
        this.bridgePath = opts.bridgePath ?? resolveBridgePath()
        this.logger = opts.logger ?? noopLogger
        this.startupTimeoutMs = opts.startupTimeoutMs ?? 10_000
        this.callTimeoutMs = opts.callTimeoutMs ?? 30_000
    }

    // ── DesktopCaptureBackend implementation ─────────────────────────

    async listTargets(): Promise<DesktopTargetSummary[]> {
        await this.ensureStarted()
        const result = (await this.call('list_windows', {})) as { windows?: RawWindowSummary[] }
        const raw = result?.windows ?? []
        return raw.map((w) => ({
            window_id: w.windowId,
            process_name: w.processName ?? undefined,
            process_id: w.processId ?? undefined,
            window_title: w.windowTitle,
            window_class: w.windowClass ?? undefined,
            has_focus: !!w.hasFocus,
        }))
    }

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

    async executeBatch(opts: ExecuteDesktopBatchOptions): Promise<ExecuteDesktopBatchResult> {
        await this.ensureStarted()
        const params: Record<string, unknown> = {
            actions: opts.actions.map((a) => buildExecuteParams(a)),
            onError: opts.on_error ?? 'stop',
        }
        if (opts.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs

        const raw = (await this.callWithTimeout(
            'execute_batch',
            params,
            opts.timeoutMs ?? Math.max(5000, opts.actions.length * 50),
        )) as { results?: RawExecuteResult[]; allOk?: boolean; executedCount?: number }

        const results = (raw.results ?? []).map((r) => ({
            ok: !!r.ok,
            message: r.message ?? undefined,
            new_value: r.newValue ?? undefined,
        }))
        return {
            results,
            all_ok: typeof raw.allOk === 'boolean' ? raw.allOk : results.every((r) => r.ok),
            executed_count: typeof raw.executedCount === 'number' ? raw.executedCount : results.length,
        }
    }

    async close(): Promise<void> {
        this.closed = true
        const proc = this.proc
        if (!proc) return

        for (const [id, slot] of this.pending) {
            clearTimeout(slot.timeout)
            slot.reject(new Error(`Bridge closed before ${slot.method} (id=${id}) completed`))
        }
        this.pending.clear()

        try { proc.stdin.end() } catch { /* swallow */ }

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
            return Promise.reject(new Error('MacosAxapiBackend was closed; create a new instance.'))
        }
        if (this.proc) return Promise.resolve()
        if (this.starting) return this.starting

        this.starting = this.spawnAndHandshake()
            .catch((err) => {
                this.starting = null
                throw err
            })
            .finally(() => {
                if (this.proc) this.starting = null
            })
        return this.starting
    }

    private async spawnAndHandshake(): Promise<void> {
        this.logger.debug('macos-axapi.spawn', { bridgePath: this.bridgePath })

        const proc = spawn(this.bridgePath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessByStdio<Writable, Readable, Readable>

        this.proc = proc

        proc.on('error', (err) => {
            this.logger.error('macos-axapi.spawn-error', { error: err.message })
            this.failAllPending(new Error(`Bridge process error: ${err.message}`))
        })

        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (chunk: string) => {
            const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0)
            for (const line of lines) {
                this.logger.debug('macos-axapi.bridge-stderr', { line })
            }
        })

        proc.on('exit', (code, signal) => {
            this.logger.info('macos-axapi.bridge-exit', { code, signal })
            this.failAllPending(new Error(`Bridge process exited (code=${code}, signal=${signal})`))
            this.proc = null
            this.rl?.close()
            this.rl = null
        })

        const rl = createInterface({ input: proc.stdout })
        this.rl = rl
        rl.on('line', (line) => this.handleResponseLine(line))

        try {
            await this.callWithTimeout('ping', {}, this.startupTimeoutMs)
        } catch (err) {
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
            this.logger.warn('macos-axapi.invalid-frame', { line: trimmed.slice(0, 200) })
            return
        }

        const slot = this.pending.get(msg.id)
        if (!slot) {
            this.logger.warn('macos-axapi.orphan-response', { id: msg.id })
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
// Param mapping (identical to the Windows backend — bridges share
// the same wire format)
// ──────────────────────────────────────────────────────────────────────

function buildExecuteParams(action: ExecuteDesktopAction): Record<string, unknown> {
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
            const _exhaustive: never = action
            void _exhaustive
        }
    }
    return base
}

// ──────────────────────────────────────────────────────────────────────
// Bridge path resolution
// ──────────────────────────────────────────────────────────────────────

const BRIDGE_BIN = 'agentmark-bridge-macos'
const RELATIVE_BRIDGE_PATHS = [
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'release', BRIDGE_BIN),
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'debug', BRIDGE_BIN),
    // Swift Package Manager also writes to architecture-specific
    // subpaths (e.g. .build/arm64-apple-macosx/release/) depending on
    // build configuration. Probe both.
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'arm64-apple-macosx', 'release', BRIDGE_BIN),
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'arm64-apple-macosx', 'debug', BRIDGE_BIN),
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'x86_64-apple-macosx', 'release', BRIDGE_BIN),
    path.join('apps', 'agent-runner', 'bridges', 'macos', '.build', 'x86_64-apple-macosx', 'debug', BRIDGE_BIN),
]

function resolveBridgePath(): string {
    const fromEnv = process.env.AGENTMARK_BRIDGE_PATH
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

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
        `Cannot find ${BRIDGE_BIN}. Tried AGENTMARK_BRIDGE_PATH env var and `
        + `walked up from ${startDir}. Build the bridge with:\n`
        + `  cd apps/agent-runner/bridges/macos && swift build\n`
        + `Or set AGENTMARK_BRIDGE_PATH to an existing binary.`,
    )
}

// ──────────────────────────────────────────────────────────────────────
// Wire format mapping (shared with Windows backend)
// ──────────────────────────────────────────────────────────────────────

interface RawWindowSummary {
    windowId: string
    processName?: string | null
    processId?: number | null
    windowTitle: string
    windowClass?: string | null
    hasFocus: boolean
}

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

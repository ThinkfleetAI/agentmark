/**
 * WebSocket session management for the Network Pack.
 *
 * Uses native `WebSocket` (Node 22+, browsers). Each connection gets a
 * stable `ws_id` returned to the agent. Incoming messages are queued;
 * `receive` pulls them (optionally waiting up to `timeout_ms` for the
 * first one). `send` writes a text or binary message. `close` releases
 * the session.
 *
 * Stateful — sessions live on the plugin instance until close() or
 * plugin dispose().
 */
import type { UrlAllowlist } from './allowlist'

export interface WebSocketSession {
    id: string
    url: string
    ws: WebSocket
    queue: QueuedMessage[]
    waiters: Array<(msg: QueuedMessage | null) => void>
    /** State transitions for diagnostics. */
    state: 'connecting' | 'open' | 'closing' | 'closed'
    /** Closure code+reason if the server closed us. */
    close_code?: number
    close_reason?: string
}

export interface QueuedMessage {
    /** When the message arrived (epoch ms). */
    received_at: number
    /** UTF-8 text or base64 bytes. */
    kind: 'text' | 'binary'
    data: string
}

export class WebSocketManager {
    private readonly sessions = new Map<string, WebSocketSession>()

    constructor(private readonly allowlist: UrlAllowlist) {}

    list(): Array<{ ws_id: string; url: string; state: string; queued: number }> {
        return Array.from(this.sessions.values()).map((s) => ({
            ws_id: s.id,
            url: s.url,
            state: s.state,
            queued: s.queue.length,
        }))
    }

    async connect(url: string, protocols?: string[]): Promise<{ ws_id: string; state: string }> {
        this.allowlist.assertAllowed(url)

        const ws = new WebSocket(url, protocols)
        const id = generateId()
        const session: WebSocketSession = {
            id,
            url,
            ws,
            queue: [],
            waiters: [],
            state: 'connecting',
        }
        this.sessions.set(id, session)

        ws.addEventListener('open', () => {
            session.state = 'open'
        })
        ws.addEventListener('message', (event: MessageEvent) => {
            const msg = encodeIncoming(event.data)
            // Hand-off to any waiter, else queue.
            const waiter = session.waiters.shift()
            if (waiter) waiter(msg)
            else session.queue.push(msg)
        })
        ws.addEventListener('close', (event: CloseEvent) => {
            session.state = 'closed'
            session.close_code = event.code
            session.close_reason = event.reason
            // Wake any waiters with null so they don't hang forever.
            for (const w of session.waiters.splice(0)) w(null)
        })
        ws.addEventListener('error', () => {
            // The 'close' event always follows; let the close handler
            // record the state. The error itself doesn't carry useful
            // structured info in the browser API.
        })

        // Wait for either 'open' or initial failure so the caller doesn't
        // get a ws_id pointing at a dead socket.
        await awaitOpen(ws, 30_000)
        return { ws_id: id, state: session.state }
    }

    send(wsId: string, data: string, format: 'text' | 'base64' = 'text'): void {
        const session = this.require(wsId)
        if (session.state !== 'open') {
            throw new Error(`WebSocket ${wsId} is ${session.state}; cannot send.`)
        }
        if (format === 'base64') {
            session.ws.send(Buffer.from(data, 'base64'))
        } else {
            session.ws.send(data)
        }
    }

    async receive(wsId: string, opts: { timeoutMs?: number; max?: number } = {}): Promise<QueuedMessage[]> {
        const session = this.require(wsId)
        const max = Math.max(1, opts.max ?? 100)

        // If anything queued, return up to `max` immediately.
        if (session.queue.length > 0) {
            return session.queue.splice(0, max)
        }
        if (session.state === 'closed') return []

        // Wait for the next message (or timeout).
        const first = await new Promise<QueuedMessage | null>((resolve) => {
            const timer = opts.timeoutMs
                ? setTimeout(() => {
                    const idx = session.waiters.indexOf(resolver)
                    if (idx !== -1) session.waiters.splice(idx, 1)
                    resolve(null)
                }, opts.timeoutMs)
                : null

            const resolver = (msg: QueuedMessage | null) => {
                if (timer) clearTimeout(timer)
                resolve(msg)
            }
            session.waiters.push(resolver)
        })

        if (first === null) return []
        // Drain any extras that arrived in the same tick, up to max.
        return [first, ...session.queue.splice(0, max - 1)]
    }

    async close(wsId: string, code = 1000, reason?: string): Promise<void> {
        const session = this.require(wsId)
        session.state = 'closing'
        session.ws.close(code, reason)
        // Give the 'close' handler a tick to fire so the final state is recorded.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        this.sessions.delete(wsId)
    }

    async closeAll(): Promise<void> {
        for (const id of Array.from(this.sessions.keys())) {
            await this.close(id).catch(() => {})
        }
    }

    private require(wsId: string): WebSocketSession {
        const s = this.sessions.get(wsId)
        if (!s) throw new Error(`Unknown ws_id: ${wsId}`)
        return s
    }
}

function encodeIncoming(data: unknown): QueuedMessage {
    if (typeof data === 'string') {
        return { received_at: Date.now(), kind: 'text', data }
    }
    // ArrayBuffer / Blob / TypedArray cases.
    if (data instanceof ArrayBuffer) {
        return { received_at: Date.now(), kind: 'binary', data: Buffer.from(data).toString('base64') }
    }
    if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        return { received_at: Date.now(), kind: 'binary', data: Buffer.from(bytes).toString('base64') }
    }
    // Last-resort: stringify whatever it is.
    return { received_at: Date.now(), kind: 'text', data: String(data) }
}

function awaitOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (ws.readyState === 1 /* OPEN */) return resolve()
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        const onOpen = () => { cleanup(); resolve() }
        const onError = () => { cleanup(); reject(new Error('WebSocket open failed')) }
        const onClose = () => { cleanup(); reject(new Error('WebSocket closed before open')) }
        const cleanup = () => {
            clearTimeout(timer)
            ws.removeEventListener('open', onOpen)
            ws.removeEventListener('error', onError)
            ws.removeEventListener('close', onClose)
        }
        ws.addEventListener('open', onOpen)
        ws.addEventListener('error', onError)
        ws.addEventListener('close', onClose)
    })
}

function generateId(): string {
    const r =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
            : Math.random().toString(36).slice(2, 14)
    return `ws_${r}`
}

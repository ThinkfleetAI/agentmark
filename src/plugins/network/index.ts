/**
 * Network Pack — HTTP + WebSocket tools.
 *
 * Bounded by a URL allowlist (empty by default → denies everything).
 * Configure via `urlAllowlist` config option or `AGENTMARK_HTTP_ALLOWLIST`
 * (colon-separated patterns).
 */
import { UrlAllowlist } from './allowlist'
import { httpRequest } from './http'
import { WebSocketManager } from './websocket'
import { NETWORK_TOOLS } from './tool-defs'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export interface NetworkPluginConfig {
    /** Glob-style URL patterns allowed for HTTP + WebSocket requests.
     *  Empty list = deny all (default). */
    urlAllowlist?: string[]
}

export function createNetworkPlugin(config: NetworkPluginConfig = {}): AgentMarkPlugin {
    const fromEnv = (process.env.AGENTMARK_HTTP_ALLOWLIST ?? '')
        .split(/[:,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    const patterns = [...(config.urlAllowlist ?? []), ...fromEnv]
    const allowlist = new UrlAllowlist(patterns)
    const wsManager = new WebSocketManager(allowlist)

    const handlers: Record<string, ToolHandler> = {
        agentmark_http_request: async (args): Promise<DispatchResult> => {
            const url = requireString(args, 'url')
            const response = await httpRequest(allowlist, {
                url,
                method: typeof args.method === 'string' ? args.method : undefined,
                headers: isStringMap(args.headers) ? (args.headers as Record<string, string>) : undefined,
                body: args.body,
                response_format: args.response_format === 'json' || args.response_format === 'base64'
                    ? args.response_format
                    : 'text',
                timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
                follow_redirects: args.follow_redirects !== false,
            })
            return { text: JSON.stringify(response, null, 2) }
        },

        agentmark_websocket_connect: async (args): Promise<DispatchResult> => {
            const url = requireString(args, 'url')
            const protocols = optionalStringArray(args, 'protocols')
            const result = await wsManager.connect(url, protocols)
            return { text: JSON.stringify(result, null, 2) }
        },

        agentmark_websocket_send: async (args): Promise<DispatchResult> => {
            const wsId = requireString(args, 'ws_id')
            const data = requireString(args, 'data')
            const format = args.format === 'base64' ? 'base64' : 'text'
            wsManager.send(wsId, data, format)
            return { text: JSON.stringify({ sent: true, ws_id: wsId, bytes: data.length }, null, 2) }
        },

        agentmark_websocket_receive: async (args): Promise<DispatchResult> => {
            const wsId = requireString(args, 'ws_id')
            const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 5000
            const max = typeof args.max === 'number' ? args.max : 100
            const messages = await wsManager.receive(wsId, { timeoutMs, max })
            return { text: JSON.stringify({ count: messages.length, messages }, null, 2) }
        },

        agentmark_websocket_close: async (args): Promise<DispatchResult> => {
            const wsId = requireString(args, 'ws_id')
            const code = typeof args.code === 'number' ? args.code : 1000
            const reason = typeof args.reason === 'string' ? args.reason : undefined
            await wsManager.close(wsId, code, reason)
            return { text: JSON.stringify({ closed: true, ws_id: wsId, code }, null, 2) }
        },
    }

    return {
        name: 'network',
        version: '0.1.0',
        tools: NETWORK_TOOLS,
        handlers,
        dispose: async () => {
            await wsManager.closeAll()
        },
        describeSessions: () => ({
            network: {
                url_allowlist: allowlist.patterns,
                websockets: wsManager.list(),
            },
        }),
    }
}

export { UrlAllowlist } from './allowlist'
export { httpRequest } from './http'
export { WebSocketManager } from './websocket'
export { NETWORK_TOOLS } from './tool-defs'
export type { HttpRequestArgs, HttpResponse } from './http'
export type { WebSocketSession, QueuedMessage } from './websocket'

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
    const v = args[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`Argument ${key} must be an array of strings.`)
    }
    return v as string[]
}

function isStringMap(v: unknown): boolean {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
}

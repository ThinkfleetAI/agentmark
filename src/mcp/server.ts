/**
 * AgentMark MCP server.
 *
 * Wraps the entire AgentMark library (web + PDF + form + OCR + desktop)
 * as a Model Context Protocol server so any MCP client (Claude Desktop,
 * Cursor, Claude Code, custom agents) can drive it through a single
 * configuration entry — no SDK install, no language commitment.
 *
 * Plugin model: capabilities are registered as `AgentMarkPlugin`s. The
 * default plugin set (web + pdf + desktop + meta) is loaded automatically
 * unless the caller provides their own array.
 *
 * Transport: stdio (the most common MCP transport for desktop and CLI
 * clients). HTTP/SSE transports can be added later if needed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createDispatcherState, type DispatcherState } from './dispatcher'
import { Dispatcher, type AgentMarkPlugin } from './plugin'

export interface AgentMarkMcpServerOptions {
    /** Server name reported on the MCP handshake. */
    name?: string
    /** Server version reported on the MCP handshake. */
    version?: string
    /**
     * Override the default plugin set. When omitted, the first-party set
     * (web + pdf + desktop + meta) is registered automatically. Pass an
     * array to add your own plugins or to ship a subset.
     */
    plugins?: AgentMarkPlugin[]
}

/**
 * Construct the MCP server (without connecting it). Used by tests that
 * inject custom transports or want to wire the dispatcher directly.
 *
 * Returns the `state` for backward compatibility. When the caller passes
 * a custom `plugins` array, the legacy per-capability maps on `state`
 * (`browsers`, `pdfs`, etc.) reflect only the first-party plugins that
 * happen to be in the array; for new code, prefer `state.dispatcher`.
 */
export function createMcpServer(options: AgentMarkMcpServerOptions = {}): {
    server: Server
    state: DispatcherState
} {
    const server = new Server(
        {
            name: options.name ?? 'agentmark',
            version: options.version ?? '0.7.0',
        },
        {
            capabilities: {
                tools: {},
            },
        },
    )

    const state = options.plugins
        ? buildCustomState(options.plugins)
        : createDispatcherState()

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Array.from(state.dispatcher.tools),
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        const result = await state.dispatcher.dispatch(name, args ?? {})
        return {
            content: [{ type: 'text', text: result.text }],
            isError: result.isError === true,
        }
    })

    return { server, state }
}

/**
 * Start the AgentMark MCP server on stdio. Returns a stop() function that
 * disposes all resources and closes the transport.
 */
export async function startMcpServer(
    options: AgentMarkMcpServerOptions = {},
): Promise<{ stop: () => Promise<void> }> {
    const { server, state } = createMcpServer(options)
    const transport = new StdioServerTransport()
    await server.connect(transport)

    const stop = async () => {
        await state.dispatcher.dispose()
        await server.close().catch(() => {})
    }

    // Best-effort cleanup on process termination signals. The MCP client
    // typically tears the connection down explicitly, but ctrl-C / SIGTERM
    // need to release Playwright + Tesseract workers + open PDFs.
    const onShutdown = () => {
        stop().finally(() => process.exit(0))
    }
    process.once('SIGINT', onShutdown)
    process.once('SIGTERM', onShutdown)
    // If the client dies without sending a signal (Windows terminal close,
    // Claude Code session exit, lost ssh pipe), stdin closes but the
    // process otherwise has nothing to exit on. Don't let zombies pile up.
    process.stdin.once('end', onShutdown)
    process.stdin.once('close', onShutdown)

    return { stop }
}

/**
 * Build a DispatcherState around a caller-supplied plugin array. The
 * legacy per-capability maps are populated from any first-party plugin
 * instances found in the array; if a category isn't represented, that
 * map is empty.
 */
function buildCustomState(plugins: AgentMarkPlugin[]): DispatcherState {
    const dispatcher = new Dispatcher(plugins)
    return {
        browsers: pickMap(plugins, 'web', 'browsers') as DispatcherState['browsers'],
        pages: pickMap(plugins, 'web', 'pages') as DispatcherState['pages'],
        pdfs: pickMap(plugins, 'pdf', 'pdfs') as DispatcherState['pdfs'],
        desktops: pickMap(plugins, 'desktop', 'desktops') as DispatcherState['desktops'],
        dispatcher,
        plugins,
    }
}

function pickMap(
    plugins: AgentMarkPlugin[],
    name: string,
    key: string,
): Map<string, unknown> {
    const found = plugins.find((p) => p.name === name) as Record<string, unknown> | undefined
    const candidate = found?.[key]
    return candidate instanceof Map ? (candidate as Map<string, unknown>) : new Map()
}

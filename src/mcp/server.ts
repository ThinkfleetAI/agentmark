/**
 * AgentMark MCP server.
 *
 * Wraps the entire AgentMark library (web + PDF + form + OCR) as a Model
 * Context Protocol server so any MCP client (Claude Desktop, Cursor,
 * Claude Code, custom agents) can drive it through a single configuration
 * entry — no SDK install, no language commitment.
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
import { ALL_TOOLS } from './tool-defs'
import {
    createDispatcherState,
    dispatch,
    disposeAll,
    type DispatcherState,
} from './dispatcher'

export interface AgentMarkMcpServerOptions {
    /** Server name reported on the MCP handshake. */
    name?: string
    /** Server version reported on the MCP handshake. */
    version?: string
}

/**
 * Construct the MCP server (without connecting it). Used by tests that
 * inject custom transports or want to wire the dispatcher directly.
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

    const state = createDispatcherState()

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ALL_TOOLS,
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        const result = await dispatch(state, name, args ?? {})
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
        await disposeAll(state)
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

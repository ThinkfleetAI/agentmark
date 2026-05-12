/**
 * Meta MCP plugin.
 *
 * Provides `agentmark_list_sessions`, which surfaces the merged session
 * descriptors from every other plugin. The plugin must be registered AFTER
 * the plugins it introspects so its handler can ask them for descriptors.
 */
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../plugin'
import type { McpToolDef } from '../tool-defs'

const META_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_list_sessions',
        description:
            'List all currently open browsers, pages, PDF documents, and '
            + 'desktop sessions with their IDs. Useful for debugging or '
            + 'recovering a stuck session.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
]

/**
 * Create the meta plugin. Takes a `peers` array used to gather session
 * descriptors at call time (not at construction time, so late-registered
 * plugins are reflected).
 */
export function createMetaPlugin(peers: ReadonlyArray<AgentMarkPlugin>): AgentMarkPlugin {
    const handlers: Record<string, ToolHandler> = {
        agentmark_list_sessions: async (): Promise<DispatchResult> => {
            const merged: Record<string, unknown> = {}
            for (const peer of peers) {
                if (peer.describeSessions) Object.assign(merged, peer.describeSessions())
            }
            return { text: JSON.stringify(merged, null, 2) }
        },
    }

    return {
        name: 'meta',
        tools: META_TOOLS,
        handlers,
    }
}

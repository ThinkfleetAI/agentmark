/**
 * Meta MCP plugin.
 *
 * Provides cross-plugin introspection — what's loaded, what's
 * configured, what sessions are open. Used by any AI agent that
 * connects to the server to discover what capabilities are available
 * without hardcoded assumptions.
 *
 * Tools:
 *   - agentmark_list_sessions: merged session descriptors
 *   - agentmark_capabilities: full server + plugin + tool catalog
 *
 * Must be registered AFTER the plugins it introspects so its handler
 * can ask them for descriptors at call time. Late-registered plugins
 * after meta won't appear (rare).
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
    {
        name: 'agentmark_capabilities',
        description:
            'Return the full server + plugin + tool catalog for the running '
            + 'agentmark MCP server. Returns:\n'
            + '  - server: { name, version }\n'
            + '  - plugins: array of { name, version, tool_count, tools[] }\n'
            + '  - tools: flat tool list with plugin attribution\n'
            + '  - describe_sessions: merged config + session info per plugin\n'
            + '\nUse this when an AI agent first connects to discover what '
            + 'this server can do without hardcoded assumptions. The same '
            + 'agent code can then adapt to a minimal server (just web + pdf) '
            + 'or a full ThinkFleet Desktop install (memory + recipes + '
            + 'network + ...).',
        inputSchema: {
            type: 'object',
            properties: {
                include_tool_schemas: {
                    type: 'boolean',
                    description: 'When true, each tool entry includes its full inputSchema. Default: false (names + descriptions only).',
                },
            },
        },
    },
]

export interface MetaPluginConfig {
    /** Server name to report in capabilities. */
    serverName?: string
    /** Server version to report in capabilities. */
    serverVersion?: string
}

/**
 * Create the meta plugin. Takes a `peers` array used to gather session
 * descriptors + tool catalogs at call time (not at construction time, so
 * late-registered plugins are reflected). `serverInfo` lets the caller
 * pin specific name/version fields; if omitted, defaults are used.
 */
export function createMetaPlugin(
    peers: ReadonlyArray<AgentMarkPlugin>,
    config: MetaPluginConfig = {},
): AgentMarkPlugin {
    const serverName = config.serverName ?? 'agentmark'
    const serverVersion = config.serverVersion ?? '0.7.0'

    const handlers: Record<string, ToolHandler> = {
        agentmark_list_sessions: async (): Promise<DispatchResult> => {
            const merged: Record<string, unknown> = {}
            for (const peer of peers) {
                if (peer.describeSessions) Object.assign(merged, peer.describeSessions())
            }
            return { text: JSON.stringify(merged, null, 2) }
        },

        agentmark_capabilities: async (args): Promise<DispatchResult> => {
            const includeSchemas = args.include_tool_schemas === true

            // Include meta itself in the plugin catalog so agents see the
            // full picture (capabilities + list_sessions are useful tools too).
            const allPlugins: AgentMarkPlugin[] = [
                ...peers,
                { name: 'meta', version: serverVersion, tools: META_TOOLS, handlers: {} },
            ]

            const pluginEntries = allPlugins.map((p) => ({
                name: p.name,
                version: p.version,
                tool_count: p.tools.length,
                tools: p.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    ...(includeSchemas ? { input_schema: t.inputSchema } : {}),
                })),
            }))

            const flatTools: Array<{ name: string; plugin: string; description: string }> = []
            for (const plugin of allPlugins) {
                for (const tool of plugin.tools) {
                    flatTools.push({
                        name: tool.name,
                        plugin: plugin.name,
                        description: tool.description,
                    })
                }
            }

            const describe: Record<string, unknown> = {}
            for (const peer of peers) {
                if (peer.describeSessions) Object.assign(describe, peer.describeSessions())
            }

            return {
                text: JSON.stringify({
                    server: { name: serverName, version: serverVersion },
                    plugins: pluginEntries,
                    tools: flatTools,
                    describe_sessions: describe,
                }, null, 2),
            }
        },
    }

    return {
        name: 'meta',
        version: serverVersion,
        tools: META_TOOLS,
        handlers,
    }
}

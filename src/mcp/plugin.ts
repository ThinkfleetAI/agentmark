/**
 * AgentMark MCP plugin contract.
 *
 * A plugin is a self-contained bundle of MCP tools that can be registered
 * against an AgentMark MCP server. First-party capabilities (Web, PDF,
 * Desktop, Meta) and third-party packs (Microsoft Workflows, Insurance,
 * etc.) use this same shape — there is no special-casing for built-ins.
 *
 * Registration semantics:
 *   - Every tool name in `tools` must have a corresponding handler in
 *     `handlers`. Mismatched plugins are rejected at registration time.
 *   - No two plugins may declare the same tool name. Conflicts throw.
 *   - `dispose()` is invoked on server shutdown, in parallel across plugins.
 *   - `describeSessions()` contributes to `agentmark_list_sessions` output;
 *     keys from different plugins are merged into a single JSON object.
 */
import { isAgentMarkError } from '../errors'
import type { McpToolDef } from './tool-defs'

export type ToolHandler = (args: Record<string, unknown>) => Promise<DispatchResult>

export interface DispatchResult {
    /** Plain-text content returned to the MCP client. */
    text: string
    /** True when the operation reports a user-facing error (vs success). */
    isError?: boolean
}

export interface AgentMarkPlugin {
    /** Unique plugin id. Used in diagnostics and conflict messages. */
    name: string
    /** Optional plugin version, surfaced in diagnostics. */
    version?: string
    /** Tool definitions this plugin contributes. */
    tools: McpToolDef[]
    /** Handler for each tool name in `tools`. Keys must match exactly. */
    handlers: Record<string, ToolHandler>
    /** Optional shutdown hook; called on server stop. */
    dispose?: () => Promise<void>
    /**
     * Optional session-introspection hook. The returned object is merged
     * into the `agentmark_list_sessions` payload. Use a top-level key
     * scoped to this plugin (e.g. `browsers`, `pdfs`) to avoid collisions
     * with other plugins.
     */
    describeSessions?: () => Record<string, unknown>
}

/**
 * Registry + router for MCP tools. Constructed from an ordered list of
 * plugins. Stateless beyond the registration metadata it holds; per-tool
 * state lives inside each plugin's closure.
 */
export class Dispatcher {
    private readonly plugins: ReadonlyArray<AgentMarkPlugin>
    private readonly handlerMap: Map<string, ToolHandler>
    private readonly toolList: ReadonlyArray<McpToolDef>

    constructor(plugins: AgentMarkPlugin[]) {
        const handlers = new Map<string, ToolHandler>()
        const tools: McpToolDef[] = []
        const seen = new Map<string, string>() // tool name -> plugin name

        for (const plugin of plugins) {
            for (const def of plugin.tools) {
                const handler = plugin.handlers[def.name]
                if (!handler) {
                    throw new Error(
                        `Plugin "${plugin.name}" declares tool "${def.name}" `
                        + `but provides no handler for it.`,
                    )
                }
                const prev = seen.get(def.name)
                if (prev) {
                    throw new Error(
                        `Tool name conflict: "${def.name}" is declared by both `
                        + `plugin "${prev}" and plugin "${plugin.name}".`,
                    )
                }
                seen.set(def.name, plugin.name)
                handlers.set(def.name, handler)
                tools.push(def)
            }
        }

        this.plugins = plugins
        this.handlerMap = handlers
        this.toolList = tools
    }

    /** All tool definitions, in plugin-registration order. */
    get tools(): ReadonlyArray<McpToolDef> {
        return this.toolList
    }

    /** Set of registered tool names; useful for diagnostics. */
    get toolNames(): string[] {
        return Array.from(this.handlerMap.keys())
    }

    /**
     * Route a tool invocation to the owning plugin's handler. Unknown tools
     * and thrown errors are wrapped as `isError` responses rather than
     * propagated, matching the MCP server's expectations.
     */
    async dispatch(name: string, args: Record<string, unknown>): Promise<DispatchResult> {
        const handler = this.handlerMap.get(name)
        if (!handler) {
            return { text: `Unknown tool: ${name}`, isError: true }
        }
        try {
            return await handler(args)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const code = isAgentMarkError(err) ? `[${err.code}] ` : ''
            return { text: `${code}${message}`, isError: true }
        }
    }

    /**
     * Merged describeSessions output from every plugin that implements it.
     * Last writer wins on key collisions — plugins should namespace their
     * keys (`browsers`, `pdfs`, `desktops`, etc.) to avoid this.
     */
    describeSessions(): Record<string, unknown> {
        const merged: Record<string, unknown> = {}
        for (const plugin of this.plugins) {
            if (!plugin.describeSessions) continue
            Object.assign(merged, plugin.describeSessions())
        }
        return merged
    }

    /** Run every plugin's dispose hook in parallel. */
    async dispose(): Promise<void> {
        await Promise.allSettled(
            this.plugins.map((p) => (p.dispose ? p.dispose() : Promise.resolve())),
        )
    }
}

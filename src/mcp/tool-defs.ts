/**
 * MCP tool-definition shape and the aggregate `ALL_TOOLS` list.
 *
 * Each AgentMark capability lives in its own plugin under `./plugins/`.
 * The tool definition arrays themselves are co-located with their handlers
 * (so adding a new tool is a one-file change). `ALL_TOOLS` is the merged
 * default set, exposed here for backward-compat with consumers that
 * import it directly.
 */
import { createWebPlugin } from './plugins/web'
import { createPdfPlugin } from './plugins/pdf'
import { createDesktopPlugin } from './plugins/desktop'
import { createMetaPlugin } from './plugins/meta'
import type { AgentMarkPlugin } from './plugin'

export interface McpToolDef {
    name: string
    description: string
    inputSchema: {
        type: 'object'
        properties: Record<string, unknown>
        required?: string[]
    }
}

/**
 * The default first-party plugin set, materialised purely to read off the
 * union of tool definitions. The plugin instances themselves are thrown
 * away — `ALL_TOOLS` is the only thing consumers see.
 *
 * If you're embedding AgentMark and want a custom plugin set, register
 * `Dispatcher` with your own plugin array instead of relying on this.
 */
function buildDefaultToolList(): McpToolDef[] {
    const web = createWebPlugin()
    const pdf = createPdfPlugin()
    const desktop = createDesktopPlugin()
    const meta = createMetaPlugin([web, pdf, desktop])
    const plugins: AgentMarkPlugin[] = [web, pdf, desktop, meta]
    const out: McpToolDef[] = []
    for (const p of plugins) out.push(...p.tools)
    // Drop the placeholder plugin instances on the floor — they were only
    // built to enumerate tool defs, not to hold runtime state.
    void plugins
    return out
}

export const ALL_TOOLS: ReadonlyArray<McpToolDef> = buildDefaultToolList()

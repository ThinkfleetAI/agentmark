/**
 * Public entry points for the AgentMark MCP server.
 *
 * Most users just want the `agentmark-mcp` bin (no code import). Programmatic
 * access is provided here for testing and embedding the server in a larger
 * application, and for building third-party plugin packs (Microsoft,
 * Insurance, etc.) against the AgentMarkPlugin contract.
 */

// Server entry points
export { startMcpServer, createMcpServer } from './server'
export type { AgentMarkMcpServerOptions } from './server'

// Legacy functional dispatcher API (kept for backward compatibility)
export {
    dispatch,
    createDispatcherState,
    disposeAll,
} from './dispatcher'
export type { DispatcherState } from './dispatcher'

// Plugin contract — use this when authoring a new plugin pack.
export { Dispatcher } from './plugin'
export type {
    AgentMarkPlugin,
    DispatchResult,
    ToolHandler,
} from './plugin'

// First-party plugin factories — invoke these to assemble a custom plugin
// array (e.g. to add your own pack alongside the defaults).
export { createWebPlugin, type WebPlugin } from './plugins/web'
export { createPdfPlugin, type PdfPlugin } from './plugins/pdf'
export { createDesktopPlugin, type DesktopPlugin } from './plugins/desktop'
export { createMetaPlugin } from './plugins/meta'

// Microsoft Workflows Pack (Graph-only v0) — opt-in; not part of the
// default plugin set. Pass it explicitly via `createMcpServer({ plugins })`.
export {
    createMicrosoftPlugin,
    MicrosoftAuth,
    GraphClient,
    GraphError,
    NotAuthenticatedError,
    MICROSOFT_TOOLS,
} from '../plugins/microsoft'
export type {
    MicrosoftPluginConfig,
    MicrosoftAuthConfig,
    TokenSet,
    DeviceCodeStartResponse,
} from '../plugins/microsoft'

// Tool definition shape + the aggregated default list.
export { ALL_TOOLS } from './tool-defs'
export type { McpToolDef } from './tool-defs'

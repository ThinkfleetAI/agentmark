/**
 * Public entry points for the AgentMark MCP server.
 *
 * Most users just want the `agentmark-mcp` bin (no code import). Programmatic
 * access is provided here for testing and embedding the server in a larger
 * application.
 */

export { startMcpServer, createMcpServer } from './server'
export type { AgentMarkMcpServerOptions } from './server'
export {
    dispatch,
    createDispatcherState,
    disposeAll,
} from './dispatcher'
export type { DispatcherState, DispatchResult } from './dispatcher'
export { ALL_TOOLS } from './tool-defs'
export type { McpToolDef } from './tool-defs'

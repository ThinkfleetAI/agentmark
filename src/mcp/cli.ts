#!/usr/bin/env node

/**
 * `agentmark-mcp` CLI — the bin entry referenced by package.json.
 *
 * Configure in any MCP client to expose the entire AgentMark library:
 *
 *   {
 *     "mcpServers": {
 *       "agentmark": {
 *         "command": "npx",
 *         "args": ["-y", "@thinkfleet/agentmark", "agentmark-mcp"]
 *       }
 *     }
 *   }
 *
 * (Or just `npx -y @thinkfleet/agentmark` once the bin name resolves on $PATH.)
 */

import { startMcpServer } from './server'

async function main(): Promise<void> {
    await startMcpServer({
        name: 'agentmark',
        // Version is read from package.json at build time; for now hardcoded.
        version: '0.7.0',
    })
    // Stay alive — the MCP transport keeps the event loop busy via stdio.
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start AgentMark MCP server:', err)
    process.exit(1)
})

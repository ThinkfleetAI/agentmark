/**
 * Wire-level test for the MCP server. Connects an in-memory `Client` to an
 * in-memory transport pair so we exercise the full handshake → ListTools →
 * CallTool flow without spawning a subprocess.
 *
 * Verifies that the server:
 *   1. Negotiates the MCP handshake correctly
 *   2. Returns the full tool catalog on tools/list
 *   3. Routes tool calls through the dispatcher and returns content blocks
 *   4. Surfaces errors via isError on the response
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/server'
import { disposeAll } from '../../src/mcp/dispatcher'

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    for (const c of cleanup.splice(0)) {
        await c().catch(() => {})
    }
})

async function connect() {
    const { server, state } = createMcpServer({ name: 'agentmark-test', version: '0.7.0-test' })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const client = new Client(
        { name: 'agentmark-test-client', version: '0.0.0' },
        { capabilities: {} },
    )
    await client.connect(clientTransport)

    cleanup.push(async () => {
        await client.close().catch(() => {})
        await disposeAll(state)
        await server.close().catch(() => {})
    })

    return { client, server, state }
}

describe('AgentMark MCP server (in-memory transport)', () => {
    it('lists every defined AgentMark tool', async () => {
        const { client } = await connect()
        const result = await client.listTools()
        const names = result.tools.map((t) => t.name)
        expect(names.length).toBeGreaterThan(10)
        expect(names).toEqual(expect.arrayContaining([
            'agentmark_pdf_open',
            'agentmark_pdf_snapshot',
            'agentmark_pdf_execute',
            'agentmark_pdf_save',
            'agentmark_browser_open',
            'agentmark_page_navigate',
            'agentmark_page_snapshot',
            'agentmark_page_execute',
            'agentmark_list_sessions',
        ]))
    })

    it('routes tool calls through the dispatcher and returns text content', async () => {
        const { client } = await connect()
        const result = await client.callTool({
            name: 'agentmark_list_sessions',
            arguments: {},
        })
        expect(Array.isArray(result.content)).toBe(true)
        const content = result.content as Array<{ type: string; text: string }>
        expect(content.length).toBe(1)
        expect(content[0].type).toBe('text')
        const json = JSON.parse(content[0].text)
        expect(json.browsers).toEqual([])
        expect(json.pdfs).toEqual([])
    })

    it('surfaces dispatcher errors via isError on the response', async () => {
        const { client } = await connect()
        const result = await client.callTool({
            name: 'agentmark_pdf_snapshot',
            arguments: { doc_id: 'bogus' },
        })
        expect(result.isError).toBe(true)
        const content = result.content as Array<{ type: string; text: string }>
        expect(content[0].text).toMatch(/Unknown doc_id/)
    })

    it('rejects calls to unknown tools', async () => {
        const { client } = await connect()
        const result = await client.callTool({
            name: 'agentmark_nope',
            arguments: {},
        })
        expect(result.isError).toBe(true)
        const content = result.content as Array<{ type: string; text: string }>
        expect(content[0].text).toMatch(/Unknown tool/)
    })
})

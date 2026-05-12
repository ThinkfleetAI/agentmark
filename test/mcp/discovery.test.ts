/**
 * Tests for agentmark_capabilities — the discovery tool that lets any
 * AI agent connecting to the MCP server introspect what's available.
 */
import { describe, it, expect } from 'vitest'
import { Dispatcher, type AgentMarkPlugin, type McpToolDef } from '../../src/mcp'
import { createMetaPlugin } from '../../src/mcp/plugins/meta'

function makePlugin(name: string, tools: McpToolDef[], extras: Partial<AgentMarkPlugin> = {}): AgentMarkPlugin {
    const handlers: Record<string, AgentMarkPlugin['handlers'][string]> = {}
    for (const t of tools) {
        handlers[t.name] = async () => ({ text: `${t.name} called` })
    }
    return { name, version: '0.1.0', tools, handlers, ...extras }
}

function toolDef(name: string): McpToolDef {
    return { name, description: `Demo tool ${name}.`, inputSchema: { type: 'object', properties: {} } }
}

describe('agentmark_capabilities — discovery surface', () => {
    it('reports server name, version, plugins, and tools', async () => {
        const alpha = makePlugin('alpha', [toolDef('alpha_one'), toolDef('alpha_two')])
        const beta = makePlugin('beta', [toolDef('beta_one')])
        const meta = createMetaPlugin([alpha, beta], { serverName: 'agentmark-test', serverVersion: '9.9.9' })

        const dispatcher = new Dispatcher([alpha, beta, meta])
        const result = await dispatcher.dispatch('agentmark_capabilities', {})
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)

        expect(body.server).toEqual({ name: 'agentmark-test', version: '9.9.9' })

        const pluginNames = body.plugins.map((p: { name: string }) => p.name).sort()
        expect(pluginNames).toEqual(['alpha', 'beta', 'meta'])

        const alphaInfo = body.plugins.find((p: { name: string }) => p.name === 'alpha')
        expect(alphaInfo.tool_count).toBe(2)
        expect(alphaInfo.tools.map((t: { name: string }) => t.name).sort()).toEqual(['alpha_one', 'alpha_two'])
    })

    it('flat tools list includes every plugin\'s tools with plugin attribution', async () => {
        const alpha = makePlugin('alpha', [toolDef('alpha_one')])
        const meta = createMetaPlugin([alpha])
        const dispatcher = new Dispatcher([alpha, meta])

        const result = await dispatcher.dispatch('agentmark_capabilities', {})
        const body = JSON.parse(result.text)
        const flat = body.tools as Array<{ name: string; plugin: string }>

        expect(flat.find((t) => t.name === 'alpha_one')?.plugin).toBe('alpha')
        // Meta's own tools should be discoverable too.
        expect(flat.find((t) => t.name === 'agentmark_capabilities')?.plugin).toBe('meta')
        expect(flat.find((t) => t.name === 'agentmark_list_sessions')?.plugin).toBe('meta')
    })

    it('omits input_schema by default (keeps payloads small)', async () => {
        const alpha = makePlugin('alpha', [{
            name: 'alpha_one',
            description: 'x',
            inputSchema: { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] },
        }])
        const meta = createMetaPlugin([alpha])
        const dispatcher = new Dispatcher([alpha, meta])

        const result = await dispatcher.dispatch('agentmark_capabilities', {})
        const body = JSON.parse(result.text)
        const alphaPlugin = body.plugins.find((p: { name: string }) => p.name === 'alpha')
        expect(alphaPlugin.tools[0].input_schema).toBeUndefined()
    })

    it('includes input_schema when include_tool_schemas=true', async () => {
        const alpha = makePlugin('alpha', [{
            name: 'alpha_one',
            description: 'x',
            inputSchema: { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] },
        }])
        const meta = createMetaPlugin([alpha])
        const dispatcher = new Dispatcher([alpha, meta])

        const result = await dispatcher.dispatch('agentmark_capabilities', { include_tool_schemas: true })
        const body = JSON.parse(result.text)
        const alphaPlugin = body.plugins.find((p: { name: string }) => p.name === 'alpha')
        expect(alphaPlugin.tools[0].input_schema).toEqual({
            type: 'object',
            properties: { foo: { type: 'string' } },
            required: ['foo'],
        })
    })

    it('merges describeSessions() output from every plugin into describe_sessions', async () => {
        const alpha = makePlugin('alpha', [toolDef('a')], {
            describeSessions: () => ({ alpha_state: { count: 3 } }),
        })
        const beta = makePlugin('beta', [toolDef('b')], {
            describeSessions: () => ({ beta_state: { active: true } }),
        })
        const meta = createMetaPlugin([alpha, beta])
        const dispatcher = new Dispatcher([alpha, beta, meta])

        const result = await dispatcher.dispatch('agentmark_capabilities', {})
        const body = JSON.parse(result.text)
        expect(body.describe_sessions).toEqual({
            alpha_state: { count: 3 },
            beta_state: { active: true },
        })
    })

    it('agentmark_list_sessions still works (regression check on the existing tool)', async () => {
        const alpha = makePlugin('alpha', [toolDef('a')], {
            describeSessions: () => ({ alphas: [{ id: 'a1' }] }),
        })
        const meta = createMetaPlugin([alpha])
        const dispatcher = new Dispatcher([alpha, meta])

        const result = await dispatcher.dispatch('agentmark_list_sessions', {})
        expect(JSON.parse(result.text)).toEqual({ alphas: [{ id: 'a1' }] })
    })
})

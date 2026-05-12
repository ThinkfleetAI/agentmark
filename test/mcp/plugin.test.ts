/**
 * Smoke tests for the AgentMark MCP plugin contract.
 *
 * Covers the Dispatcher class directly (no MCP transport, no first-party
 * plugins). Serves as the reference for third-party plugin authors.
 */

import { describe, it, expect } from 'vitest'
import {
    Dispatcher,
    type AgentMarkPlugin,
    type McpToolDef,
} from '../../src/mcp'

function makePlugin(
    name: string,
    overrides: Partial<AgentMarkPlugin> = {},
): AgentMarkPlugin {
    const tool: McpToolDef = {
        name: `${name}_ping`,
        description: 'Demo tool.',
        inputSchema: { type: 'object', properties: {} },
    }
    return {
        name,
        tools: [tool],
        handlers: {
            [tool.name]: async () => ({ text: `pong from ${name}` }),
        },
        ...overrides,
    }
}

describe('AgentMarkPlugin contract', () => {
    it('dispatches a tool call to the owning plugin', async () => {
        const dispatcher = new Dispatcher([makePlugin('alpha')])
        const result = await dispatcher.dispatch('alpha_ping', {})
        expect(result.isError).toBeFalsy()
        expect(result.text).toBe('pong from alpha')
    })

    it('aggregates tools across plugins in registration order', () => {
        const dispatcher = new Dispatcher([
            makePlugin('alpha'),
            makePlugin('beta'),
            makePlugin('gamma'),
        ])
        expect(dispatcher.toolNames).toEqual(['alpha_ping', 'beta_ping', 'gamma_ping'])
    })

    it('rejects duplicate tool names across plugins', () => {
        expect(() =>
            new Dispatcher([
                makePlugin('alpha'),
                makePlugin('beta', {
                    tools: [{
                        name: 'alpha_ping', // collision
                        description: 'x',
                        inputSchema: { type: 'object', properties: {} },
                    }],
                    handlers: { alpha_ping: async () => ({ text: '' }) },
                }),
            ]),
        ).toThrow(/Tool name conflict.*alpha_ping/)
    })

    it('rejects a plugin that declares a tool without a handler', () => {
        expect(() =>
            new Dispatcher([
                {
                    name: 'broken',
                    tools: [{
                        name: 'broken_ping',
                        description: 'x',
                        inputSchema: { type: 'object', properties: {} },
                    }],
                    handlers: {}, // intentionally empty
                },
            ]),
        ).toThrow(/declares tool "broken_ping" but provides no handler/)
    })

    it('returns isError when a tool is unknown', async () => {
        const dispatcher = new Dispatcher([makePlugin('alpha')])
        const result = await dispatcher.dispatch('nope', {})
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/Unknown tool: nope/)
    })

    it('wraps thrown errors from handlers as isError responses', async () => {
        const dispatcher = new Dispatcher([
            makePlugin('boom', {
                handlers: {
                    boom_ping: async () => { throw new Error('kaboom') },
                },
            }),
        ])
        const result = await dispatcher.dispatch('boom_ping', {})
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/kaboom/)
    })

    it('merges describeSessions output from every plugin', () => {
        const dispatcher = new Dispatcher([
            makePlugin('alpha', { describeSessions: () => ({ alphas: [{ id: 'a1' }] }) }),
            makePlugin('beta', { describeSessions: () => ({ betas: [{ id: 'b1' }] }) }),
        ])
        const merged = dispatcher.describeSessions()
        expect(merged).toEqual({ alphas: [{ id: 'a1' }], betas: [{ id: 'b1' }] })
    })

    it('calls every plugin dispose hook on dispose()', async () => {
        let alphaDisposed = false
        let betaDisposed = false
        const dispatcher = new Dispatcher([
            makePlugin('alpha', { dispose: async () => { alphaDisposed = true } }),
            makePlugin('beta', { dispose: async () => { betaDisposed = true } }),
        ])
        await dispatcher.dispose()
        expect(alphaDisposed).toBe(true)
        expect(betaDisposed).toBe(true)
    })

    it('continues disposing other plugins even if one throws', async () => {
        let betaDisposed = false
        const dispatcher = new Dispatcher([
            makePlugin('alpha', { dispose: async () => { throw new Error('alpha boom') } }),
            makePlugin('beta', { dispose: async () => { betaDisposed = true } }),
        ])
        await expect(dispatcher.dispose()).resolves.toBeUndefined()
        expect(betaDisposed).toBe(true)
    })
})

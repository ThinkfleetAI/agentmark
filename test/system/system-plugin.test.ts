/**
 * Tests for the System Pack.
 *
 * The actual notify/speak operations have no programmatic verification
 * path (they pop OS toast / play audio). We test plugin registration
 * and argument validation; the live execution is smoke-tested via the
 * Mac + Win VMs.
 */
import { describe, it, expect } from 'vitest'
import {
    createSystemPlugin,
    SYSTEM_TOOLS,
} from '../../src/plugins/system'
import { Dispatcher } from '../../src/mcp/plugin'

describe('System plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = createSystemPlugin()
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(SYSTEM_TOOLS.map((t) => t.name).sort())
    })

    it('exposes the v0 tool set', () => {
        expect(SYSTEM_TOOLS.map((t) => t.name).sort()).toEqual([
            'agentmark_notify',
            'agentmark_voice_speak',
        ])
    })
})

describe('System plugin — argument validation', () => {
    it('agentmark_notify requires title', async () => {
        const plugin = createSystemPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_notify', {})
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/title/)
    })

    it('agentmark_voice_speak requires text', async () => {
        const plugin = createSystemPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_voice_speak', {})
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/text/)
    })
})

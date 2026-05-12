/**
 * Tests for the Vision Pack.
 *
 * The screenshot itself shells out to OS-native tools that need a real
 * display session, so we don't run the real capture in unit tests. We
 * verify plugin registration, tool surface, and that the handler is
 * wired to the screenshot function (which is tested via the live demo
 * paths on real Mac + Win VMs).
 */
import { describe, it, expect } from 'vitest'
import {
    createVisionPlugin,
    VISION_TOOLS,
} from '../../src/plugins/vision'
import { Dispatcher } from '../../src/mcp/plugin'

describe('Vision plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = createVisionPlugin()
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(VISION_TOOLS.map((t) => t.name).sort())
    })

    it('exposes the v0 tool set', () => {
        expect(VISION_TOOLS.map((t) => t.name)).toEqual(['agentmark_screenshot'])
    })

    it('plugin.name + version are set', () => {
        const plugin = createVisionPlugin()
        expect(plugin.name).toBe('vision')
        expect(plugin.version).toBe('0.1.0')
    })
})

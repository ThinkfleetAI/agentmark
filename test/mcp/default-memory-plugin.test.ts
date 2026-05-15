/**
 * Tests that the default MCP plugin set picks up the memory plugin
 * automatically — and that misconfigured env vars disable memory but
 * leave the rest of the server working.
 *
 * The memory plugin in the default set is what makes "install ThinkFleet
 * Desktop → AI tools have persistent memory" a zero-config experience.
 * Regressing this means every user-facing wiring path breaks silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDispatcherState, disposeAll, type DispatcherState } from '../../src/mcp/dispatcher'
import { MEMORY_TOOLS } from '../../src/plugins/memory'

const SAAS_ENV_KEYS = [
    'THINKFLEET_BASE_URL',
    'THINKFLEET_PROJECT_ID',
    'THINKFLEET_API_KEY',
    'THINKFLEET_CHATBOT_ID',
]

let originalEnv: Record<string, string | undefined>
let consoleSpy: ReturnType<typeof vi.spyOn>
let state: DispatcherState | null = null

beforeEach(() => {
    originalEnv = Object.fromEntries(SAAS_ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of SAAS_ENV_KEYS) delete process.env[k]
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
    if (state) {
        await disposeAll(state).catch(() => {})
        state = null
    }
    for (const k of SAAS_ENV_KEYS) {
        if (originalEnv[k] === undefined) delete process.env[k]
        else process.env[k] = originalEnv[k]
    }
    consoleSpy.mockRestore()
})

const memoryToolNames = MEMORY_TOOLS.map((t) => t.name).sort()

describe('default plugin set — memory wiring', () => {
    it('registers every memory tool when no creds are set (local-file backend)', () => {
        state = createDispatcherState()
        const tools = Array.from(state.dispatcher.toolNames).filter((n) => n.startsWith('agentmark_memory_'))
        expect(tools.sort()).toEqual(memoryToolNames)
    })

    it('still registers memory tools when full SaaS creds are present', () => {
        process.env.THINKFLEET_BASE_URL = 'https://app.thinkfleet.ai'
        process.env.THINKFLEET_PROJECT_ID = 'proj_test_1234567890'
        process.env.THINKFLEET_API_KEY = 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa'

        state = createDispatcherState()
        const tools = Array.from(state.dispatcher.toolNames).filter((n) => n.startsWith('agentmark_memory_'))
        expect(tools.sort()).toEqual(memoryToolNames)
    })

    it('logs which backend got selected on startup (no creds in the log line)', () => {
        process.env.THINKFLEET_BASE_URL = 'https://app.thinkfleet.ai'
        process.env.THINKFLEET_PROJECT_ID = 'proj_test_1234567890'
        process.env.THINKFLEET_API_KEY = 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa'

        state = createDispatcherState()

        const logLines = consoleSpy.mock.calls.map((c) => String(c[0]))
        const backendLine = logLines.find((l) => l.includes('memory backend:'))
        expect(backendLine).toBeDefined()
        expect(backendLine).toContain('activepieces')
        expect(backendLine).not.toContain('sk-test')
    })

    it('disables memory but keeps the rest of the server alive on partial creds', () => {
        process.env.THINKFLEET_BASE_URL = 'https://app.thinkfleet.ai'
        // intentionally omit api key

        state = createDispatcherState()

        // Memory tools are gone.
        const memTools = Array.from(state.dispatcher.toolNames).filter((n) => n.startsWith('agentmark_memory_'))
        expect(memTools).toEqual([])

        // Other capabilities still registered.
        const webTools = Array.from(state.dispatcher.toolNames).filter((n) => n.startsWith('agentmark_browser_'))
        expect(webTools.length).toBeGreaterThan(0)

        // Disable reason surfaced to stderr (MCP clients show it).
        const logLines = consoleSpy.mock.calls.map((c) => String(c[0]))
        expect(logLines.some((l) => l.includes('memory plugin disabled'))).toBe(true)
    })

    it('disables memory on malformed API key without leaking the bad key', () => {
        process.env.THINKFLEET_BASE_URL = 'https://app.thinkfleet.ai'
        process.env.THINKFLEET_PROJECT_ID = 'proj_test'
        process.env.THINKFLEET_API_KEY = 'totally-not-an-sk-key-very-secret'

        state = createDispatcherState()

        const memTools = Array.from(state.dispatcher.toolNames).filter((n) => n.startsWith('agentmark_memory_'))
        expect(memTools).toEqual([])

        const allLogs = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
        expect(allLogs).not.toContain('totally-not-an-sk-key-very-secret')
    })
})

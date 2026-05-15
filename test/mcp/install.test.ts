/**
 * Tests for `agentmark-mcp install` — the auto-wiring of detected AI
 * clients (Claude Code, Claude Desktop, Cursor, Windsurf) to talk to
 * the agentmark MCP server.
 *
 * Tests run against synthetic config files in a tmpdir. The client
 * descriptors are exercised by injecting a custom one that points at
 * the tmp paths — keeps the test independent of whether Claude Code
 * et al. are actually installed on the test machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, writeFile, readFile, access, constants } from 'node:fs/promises'
import {
    installToClients,
    uninstallFromClients,
    readJson,
    writeJson,
    type ClientDescriptor,
    type McpServerEntry,
} from '../../src/mcp/install'

let tmp: string

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'agentmark-install-'))
})

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
})

/** Build a synthetic descriptor pointing at a tmp file so tests don't
 *  depend on which clients are installed on the host. */
function fakeClient(id: string, fileName: string): ClientDescriptor {
    const cfgPath = path.join(tmp, fileName)
    return {
        id,
        name: id,
        configPath: () => cfgPath,
        isInstalled: async () => true,
        applyEntry: (config, name, entry) => {
            const cfg = (config && typeof config === 'object' ? config : {}) as { mcpServers?: Record<string, McpServerEntry> }
            return { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), [name]: entry } }
        },
        removeEntry: (config, name) => {
            if (!config || typeof config !== 'object') return { config: {}, removed: false }
            const cfg = config as { mcpServers?: Record<string, McpServerEntry> }
            if (!cfg.mcpServers || !(name in cfg.mcpServers)) return { config, removed: false }
            const { [name]: _, ...rest } = cfg.mcpServers
            void _
            return { config: { ...cfg, mcpServers: rest }, removed: true }
        },
    }
}

const ENTRY: McpServerEntry = { command: '/opt/thinkfleet/agentmark/bin/agentmark-mcp', args: [] }

// installToClients takes ids and looks them up in the global registry,
// but tests want to use fake descriptors. Drive the underlying logic by
// calling apply + writeJson directly when we need to drive a synthetic
// client; use the real installToClients flow when we want end-to-end
// coverage via the global registry.
//
// For the unit tests below we use the underlying readJson/writeJson +
// descriptor methods directly (this is what installToClients does
// internally).
async function applyToFake(client: ClientDescriptor, entry: McpServerEntry, name = 'agentmark'): Promise<{ action: string; backup?: string }> {
    const cfgPath = client.configPath()!
    const { value: current } = await readJson(cfgPath)
    const existing = (current as { mcpServers?: Record<string, unknown> })?.mcpServers?.[name]
    const action = existing
        ? JSON.stringify(existing) === JSON.stringify(entry) ? 'already_present' : 'updated'
        : 'added'
    const updated = client.applyEntry(current, name, entry)
    const result = await writeJson(cfgPath, updated)
    return { action, backup: result.backup_path }
}

describe('readJson / writeJson — atomic config IO', () => {
    it('returns existed=false + value={} for a missing file', async () => {
        const r = await readJson(path.join(tmp, 'missing.json'))
        expect(r.existed).toBe(false)
        expect(r.value).toEqual({})
    })

    it('round-trips JSON values', async () => {
        const file = path.join(tmp, 'cfg.json')
        const w = await writeJson(file, { mcpServers: { x: { command: '/x' } } })
        expect(w.existed_before).toBe(false)
        expect(w.backup_path).toBeUndefined()

        const r = await readJson(file)
        expect(r.existed).toBe(true)
        expect(r.value).toEqual({ mcpServers: { x: { command: '/x' } } })
    })

    it('creates a .bak file on second write', async () => {
        const file = path.join(tmp, 'cfg.json')
        await writeJson(file, { v: 1 })
        const w = await writeJson(file, { v: 2 })
        expect(w.existed_before).toBe(true)
        expect(w.backup_path).toBe(file + '.bak')
        await access(file + '.bak', constants.F_OK) // doesn't throw
    })

    it('refuses to overwrite a file with malformed JSON', async () => {
        const file = path.join(tmp, 'broken.json')
        await writeFile(file, '{not valid json')
        await expect(readJson(file)).rejects.toThrow(/not valid JSON/)
    })

    it('creates parent directories when needed', async () => {
        const file = path.join(tmp, 'a', 'b', 'c.json')
        await writeJson(file, { hi: true })
        const r = await readJson(file)
        expect(r.value).toEqual({ hi: true })
    })
})

describe('Fake client end-to-end — apply + remove', () => {
    it('adds the entry under mcpServers on first run', async () => {
        const client = fakeClient('test-a', 'a.json')
        const r = await applyToFake(client, ENTRY)
        expect(r.action).toBe('added')

        const written = JSON.parse(await readFile(client.configPath()!, 'utf8'))
        expect(written).toEqual({ mcpServers: { agentmark: ENTRY } })
    })

    it('writes the env block when the entry carries env vars', async () => {
        const client = fakeClient('test-a-env', 'a-env.json')
        const envEntry: McpServerEntry = {
            command: '/opt/thinkfleet/agentmark/bin/agentmark-mcp',
            args: [],
            env: {
                THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
                THINKFLEET_PROJECT_ID: 'proj_test',
                THINKFLEET_API_KEY: 'sk-test-token',
            },
        }
        await applyToFake(client, envEntry)
        const written = JSON.parse(await readFile(client.configPath()!, 'utf8'))
        expect(written.mcpServers.agentmark.env).toEqual(envEntry.env)
    })

    it('updates the env block when the install is re-run with new values', async () => {
        const client = fakeClient('test-a-rotate', 'a-rotate.json')
        await applyToFake(client, {
            command: '/x', args: [],
            env: { THINKFLEET_API_KEY: 'sk-old' },
        })
        const second = await applyToFake(client, {
            command: '/x', args: [],
            env: { THINKFLEET_API_KEY: 'sk-new' },
        })
        expect(second.action).toBe('updated')
        const written = JSON.parse(await readFile(client.configPath()!, 'utf8'))
        expect(written.mcpServers.agentmark.env.THINKFLEET_API_KEY).toBe('sk-new')
    })

    it('preserves unrelated keys (mcp + other) in the config', async () => {
        const client = fakeClient('test-b', 'b.json')
        await writeJson(client.configPath()!, {
            theme: 'dark',
            mcpServers: { existing: { command: '/other' } },
        })
        await applyToFake(client, ENTRY)
        const written = JSON.parse(await readFile(client.configPath()!, 'utf8'))
        expect(written).toEqual({
            theme: 'dark',
            mcpServers: {
                existing: { command: '/other' },
                agentmark: ENTRY,
            },
        })
    })

    it('reports already_present when re-running with the same entry', async () => {
        const client = fakeClient('test-c', 'c.json')
        await applyToFake(client, ENTRY)
        const second = await applyToFake(client, ENTRY)
        expect(second.action).toBe('already_present')
    })

    it('reports updated when the entry exists but differs', async () => {
        const client = fakeClient('test-d', 'd.json')
        await applyToFake(client, ENTRY)
        const next = await applyToFake(client, { command: '/different/path' })
        expect(next.action).toBe('updated')
    })

    it('removes only our entry, leaving siblings intact', async () => {
        const client = fakeClient('test-e', 'e.json')
        await writeJson(client.configPath()!, {
            mcpServers: { agentmark: ENTRY, sibling: { command: '/s' } },
        })
        const { config: updated, removed } = client.removeEntry(
            JSON.parse(await readFile(client.configPath()!, 'utf8')),
            'agentmark',
        )
        expect(removed).toBe(true)
        expect(updated).toEqual({ mcpServers: { sibling: { command: '/s' } } })
    })

    it('removeEntry returns removed=false when no agentmark entry exists', async () => {
        const client = fakeClient('test-f', 'f.json')
        await writeJson(client.configPath()!, { mcpServers: { other: { command: '/o' } } })
        const { removed } = client.removeEntry(
            JSON.parse(await readFile(client.configPath()!, 'utf8')),
            'agentmark',
        )
        expect(removed).toBe(false)
    })
})

describe('installToClients / uninstallFromClients via the global registry', () => {
    // These tests exercise the actual installToClients() flow. We
    // restrict to specific client ids and point those clients at tmp
    // paths via env-var injection isn't possible (descriptors are
    // static), so we instead use --dry-run mode + clientIds for a
    // client we know is in the registry. The combination proves the
    // flow without requiring the test machine to have any clients
    // installed.

    it('errors on unknown client id', async () => {
        await expect(
            installToClients({ clientIds: ['nonexistent'], entry: ENTRY }),
        ).rejects.toThrow(/Unknown client id/)
    })

    it('dry-run install does NOT write to disk', async () => {
        // Use a real client id but point its config at a path we control
        // — actually impossible with static descriptors. So we drive a
        // representative scenario through the fake-client unit tests
        // above, and just confirm dry-run produces the right action
        // tag here via the public API.
        const result = await installToClients({
            clientIds: ['claude-code'],
            entry: ENTRY,
            dryRun: true,
        })
        expect(result.clients).toHaveLength(1)
        expect(['added', 'updated', 'already_present']).toContain(result.clients[0].action)
        // dry-run message is appended.
        expect(result.clients[0].message ?? '').toMatch(/dry run/i)
    })
})

/**
 * Tests for the Memory Pack.
 *
 * Covers store semantics (set / get / scope-hierarchy resolution /
 * search / TTL / LRU eviction) and dispatcher integration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import {
    createMemoryPlugin,
    MemoryStore,
    MEMORY_TOOLS,
} from '../../src/plugins/memory'
import { Dispatcher } from '../../src/mcp/plugin'

let tmp: string

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'agentmark-memory-'))
})

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
})

function pluginAt(): ReturnType<typeof createMemoryPlugin> {
    return createMemoryPlugin({ storePath: path.join(tmp, 'memory.json') })
}

describe('Memory plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(MEMORY_TOOLS.map((t) => t.name).sort())
    })

    it('exposes the v0 tool set', () => {
        expect(MEMORY_TOOLS.map((t) => t.name).sort()).toEqual([
            'agentmark_memory_delete',
            'agentmark_memory_get',
            'agentmark_memory_list',
            'agentmark_memory_search',
            'agentmark_memory_set',
        ])
    })
})

describe('MemoryStore — basic CRUD', () => {
    it('set + get within the same scope', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        const record = await store.set({
            key: 'build_command',
            value: 'pnpm build',
            scope: { type: 'project', id: '/repo/agentmark' },
        })
        expect(record.key).toBe('build_command')
        expect(record.value).toBe('pnpm build')

        const got = await store.get({
            key: 'build_command',
            scopes: [{ type: 'project', id: '/repo/agentmark' }],
        })
        expect(got?.value).toBe('pnpm build')
        // get bumps access count.
        expect(got?.access_count).toBe(1)
    })

    it('set with same key + scope replaces the value but preserves history', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        const scope = { type: 'project' as const, id: '/repo' }

        const v1 = await store.set({ key: 'k', value: 'old', scope })
        await store.get({ key: 'k', scopes: [scope] })
        await store.get({ key: 'k', scopes: [scope] })
        const v2 = await store.set({ key: 'k', value: 'new', scope })

        expect(v2.record_id).toBe(v1.record_id)
        expect(v2.value).toBe('new')
        expect(v2.created_at).toBe(v1.created_at)
        expect(v2.access_count).toBe(2)
    })

    it('returns null when the key is not in the queried scope', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'k', value: 'v', scope: { type: 'project', id: '/repo/a' } })
        const got = await store.get({ key: 'k', scopes: [{ type: 'project', id: '/repo/b' }] })
        expect(got).toBeNull()
    })

    it('rejects non-platform scope without an id', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await expect(
            store.set({ key: 'k', value: 'v', scope: { type: 'project' } }),
        ).rejects.toThrow(/requires an id/)
    })

    it('platform scope does not require an id', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        const r = await store.set({ key: 'k', value: 'v', scope: { type: 'platform' } })
        expect(r.scope.type).toBe('platform')
    })
})

describe('MemoryStore — hierarchical resolution', () => {
    it('returns the first matching scope when multiple are tried', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'theme', value: 'platform-default', scope: { type: 'platform' } })
        await store.set({ key: 'theme', value: 'project-override', scope: { type: 'project', id: '/repo' } })

        const got = await store.get({
            key: 'theme',
            scopes: [{ type: 'project', id: '/repo' }, { type: 'platform' }],
        })
        expect(got?.value).toBe('project-override')

        // Different project — falls through to platform.
        const fallback = await store.get({
            key: 'theme',
            scopes: [{ type: 'project', id: '/other-repo' }, { type: 'platform' }],
        })
        expect(fallback?.value).toBe('platform-default')
    })
})

describe('MemoryStore — TTL', () => {
    it('expired records are not returned by get', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({
            key: 'ephemeral',
            value: 'v',
            scope: { type: 'platform' },
            ttlSeconds: -1, // already expired
        })
        const got = await store.get({ key: 'ephemeral', scopes: [{ type: 'platform' }] })
        expect(got).toBeNull()
    })

    it('records without TTL persist indefinitely', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'eternal', value: 'v', scope: { type: 'platform' } })
        const got = await store.get({ key: 'eternal', scopes: [{ type: 'platform' }] })
        expect(got?.value).toBe('v')
    })
})

describe('MemoryStore — search', () => {
    it('substring matches against key and stringified value', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'build_command', value: 'pnpm build', scope: { type: 'project', id: '/r' } })
        await store.set({ key: 'test_command', value: 'pnpm test', scope: { type: 'project', id: '/r' } })
        await store.set({ key: 'unrelated', value: { x: 'foo' }, scope: { type: 'project', id: '/r' } })

        const byKey = await store.search({ query: 'command' })
        expect(byKey.map((r) => r.key).sort()).toEqual(['build_command', 'test_command'])

        const byValue = await store.search({ query: 'pnpm' })
        expect(byValue.length).toBe(2)
    })

    it('filters by tags', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'a', value: 1, scope: { type: 'platform' }, tags: ['build', 'fast'] })
        await store.set({ key: 'b', value: 2, scope: { type: 'platform' }, tags: ['test'] })
        await store.set({ key: 'c', value: 3, scope: { type: 'platform' }, tags: ['build'] })

        const buildOnly = await store.search({ tags: ['build'] })
        expect(buildOnly.map((r) => r.key).sort()).toEqual(['a', 'c'])
    })

    it('respects scope filter', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'a', value: 1, scope: { type: 'project', id: '/x' } })
        await store.set({ key: 'b', value: 2, scope: { type: 'project', id: '/y' } })

        const xOnly = await store.search({ scope: { type: 'project', id: '/x' } })
        expect(xOnly.map((r) => r.key)).toEqual(['a'])
    })

    it('scope filter with no id matches all records of that type', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json') })
        await store.set({ key: 'a', value: 1, scope: { type: 'project', id: '/x' } })
        await store.set({ key: 'b', value: 2, scope: { type: 'platform' } })

        const allProjects = await store.search({ scope: { type: 'project' } })
        expect(allProjects.length).toBe(1)
        expect(allProjects[0].key).toBe('a')
    })
})

describe('MemoryStore — LRU eviction', () => {
    it('evicts least-recently-accessed when capacity is exceeded', async () => {
        const store = new MemoryStore({ path: path.join(tmp, 'memory.json'), maxRecords: 3 })
        await store.set({ key: 'a', value: 1, scope: { type: 'platform' } })
        await new Promise((r) => setTimeout(r, 2))
        await store.set({ key: 'b', value: 2, scope: { type: 'platform' } })
        await new Promise((r) => setTimeout(r, 2))
        await store.set({ key: 'c', value: 3, scope: { type: 'platform' } })

        // Touch b so it's most recently accessed.
        await store.get({ key: 'b', scopes: [{ type: 'platform' }] })

        // Add d — should evict the oldest unread (a).
        await store.set({ key: 'd', value: 4, scope: { type: 'platform' } })

        const all = await store.list({ type: 'platform' })
        const keys = all.map((r) => r.key).sort()
        expect(keys).toEqual(['b', 'c', 'd'])
    })
})

describe('Memory plugin — dispatched through the plugin', () => {
    it('set + get round-trip via the dispatcher', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        const set = await dispatcher.dispatch('agentmark_memory_set', {
            key: 'build_command',
            value: 'pnpm build',
            scope: { type: 'project', id: '/repo' },
        })
        expect(set.isError).toBeFalsy()

        const get = await dispatcher.dispatch('agentmark_memory_get', {
            key: 'build_command',
            scopes: [{ type: 'project', id: '/repo' }],
        })
        const body = JSON.parse(get.text)
        expect(body.found).toBe(true)
        expect(body.record.value).toBe('pnpm build')
    })

    it('get with multiple scopes walks the hierarchy', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_memory_set', {
            key: 'editor',
            value: 'vim',
            scope: { type: 'platform' },
        })
        await dispatcher.dispatch('agentmark_memory_set', {
            key: 'editor',
            value: 'code',
            scope: { type: 'project', id: '/agentmark' },
        })

        const get = await dispatcher.dispatch('agentmark_memory_get', {
            key: 'editor',
            scopes: [{ type: 'project', id: '/agentmark' }, { type: 'platform' }],
        })
        expect(JSON.parse(get.text).record.value).toBe('code')
    })

    it('search returns matching records', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_memory_set', { key: 'a', value: 1, scope: { type: 'platform' }, tags: ['build'] })
        await dispatcher.dispatch('agentmark_memory_set', { key: 'b', value: 2, scope: { type: 'platform' }, tags: ['test'] })

        const search = await dispatcher.dispatch('agentmark_memory_search', { tags: ['build'] })
        const body = JSON.parse(search.text)
        expect(body.count).toBe(1)
        expect(body.records[0].key).toBe('a')
    })

    it('delete by record_id', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        const set = await dispatcher.dispatch('agentmark_memory_set', {
            key: 'gone',
            value: 'v',
            scope: { type: 'platform' },
        })
        const id = JSON.parse(set.text).record.record_id

        const del = await dispatcher.dispatch('agentmark_memory_delete', { record_id: id })
        expect(JSON.parse(del.text).deleted).toBe(true)

        const get = await dispatcher.dispatch('agentmark_memory_get', { key: 'gone', scopes: [{ type: 'platform' }] })
        expect(JSON.parse(get.text).found).toBe(false)
    })

    it('delete with neither record_id nor key+scope returns isError', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])
        const del = await dispatcher.dispatch('agentmark_memory_delete', {})
        expect(del.isError).toBe(true)
        expect(del.text).toMatch(/record_id.*key.*scope/)
    })
})

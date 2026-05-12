/**
 * Tests for the Foundations Pack — filesystem allowlist + state store.
 *
 * App launcher and clipboard are intentionally not exercised here: both
 * shell out to OS-shipped binaries and would either pop windows or write
 * to the test runner's real clipboard. Their handlers are thin wrappers;
 * the worth-testing logic is path canonicalisation (escape resistance)
 * and the durable-state file round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, realpath } from 'node:fs/promises'
import {
    createFoundationsPlugin,
    FilesGuard,
    StateStore,
    FOUNDATIONS_TOOLS,
} from '../../src/plugins/foundations'
import { Dispatcher } from '../../src/mcp/plugin'

let tmp: string

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'agentmark-foundations-'))
})

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
})

describe('Foundations plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        // Dispatcher construction validates handler/tool alignment.
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(FOUNDATIONS_TOOLS.map((t) => t.name).sort())
    })

    it('describeSessions reports the file allowlist + state path', () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const info = plugin.describeSessions?.()
        expect(info).toEqual({
            foundations: {
                file_roots: [tmp],
                state_path: path.join(tmp, 'state.json'),
            },
        })
    })
})

describe('FilesGuard — allowlist enforcement', () => {
    it('accepts paths inside an allowed root', async () => {
        const guard = new FilesGuard({ roots: [tmp] })
        const inside = path.join(tmp, 'nested', 'file.txt')
        const result = await guard.safeResolve(inside)
        // Compare against the canonical (realpath-resolved) tmp because
        // macOS aliases /var → /private/var.
        const canonicalTmp = await realpath(tmp)
        expect(result.startsWith(canonicalTmp)).toBe(true)
    })

    it('rejects paths outside the allowlist', async () => {
        const guard = new FilesGuard({ roots: [tmp] })
        await expect(guard.safeResolve('/etc/passwd')).rejects.toThrow(/outside the allowed roots/)
    })

    it('rejects parent-traversal even with valid prefix', async () => {
        const guard = new FilesGuard({ roots: [tmp] })
        await expect(guard.safeResolve(path.join(tmp, '..', '..', 'etc'))).rejects.toThrow(/outside/)
    })

    it('follows symlinks before the allowlist check', async () => {
        // Create a symlink inside tmp that points to /etc — agent should
        // not be able to escape via the symlink.
        const linkPath = path.join(tmp, 'escape-link')
        try {
            await symlink('/etc', linkPath)
        } catch {
            // Skip on platforms where symlink creation needs admin (some Win configs).
            return
        }
        const guard = new FilesGuard({ roots: [tmp] })
        await expect(guard.safeResolve(linkPath)).rejects.toThrow(/outside/)
    })
})

describe('Files handlers — dispatched through the plugin', () => {
    it('agentmark_files_write + read round-trips utf8 content', async () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])
        const target = path.join(tmp, 'note.txt')

        const write = await dispatcher.dispatch('agentmark_files_write', {
            path: target,
            content: 'hello\nworld\n',
        })
        expect(write.isError).toBeFalsy()

        const read = await dispatcher.dispatch('agentmark_files_read', { path: target })
        expect(read.isError).toBeFalsy()
        const body = JSON.parse(read.text)
        expect(body.content).toBe('hello\nworld\n')

        // Confirm the actual file on disk matches.
        const disk = await readFile(target, 'utf8')
        expect(disk).toBe('hello\nworld\n')
    })

    it('agentmark_files_write rejects writes outside the allowlist', async () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_files_write', {
            path: '/etc/agentmark-pwn',
            content: 'should not land',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/outside/)
    })

    it('agentmark_files_list returns directory entries', async () => {
        await writeFile(path.join(tmp, 'a.txt'), 'a')
        await writeFile(path.join(tmp, 'b.txt'), 'bbb')
        await mkdir(path.join(tmp, 'sub'))

        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])
        const list = await dispatcher.dispatch('agentmark_files_list', { path: tmp })
        const body = JSON.parse(list.text)
        expect(body.count).toBeGreaterThanOrEqual(3)
        const names = body.items.map((i: { name: string }) => i.name).sort()
        expect(names).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'sub']))
    })

    it('agentmark_files_delete refuses non-empty dirs without recursive', async () => {
        const dir = path.join(tmp, 'with-content')
        await mkdir(dir)
        await writeFile(path.join(dir, 'inner.txt'), 'x')

        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])
        const refused = await dispatcher.dispatch('agentmark_files_delete', { path: dir })
        expect(refused.isError).toBe(true)
        expect(refused.text).toMatch(/recursive=true/)

        const allowed = await dispatcher.dispatch('agentmark_files_delete', { path: dir, recursive: true })
        expect(allowed.isError).toBeFalsy()
    })
})

describe('StateStore — durable round-trip', () => {
    it('set + get round-trips arbitrary JSON values', async () => {
        const store = new StateStore({ path: path.join(tmp, 'state.json') })
        await store.set('counter', 42)
        await store.set('config', { theme: 'dark', recent: ['a', 'b'] })
        expect(await store.get('counter')).toBe(42)
        expect(await store.get('config')).toEqual({ theme: 'dark', recent: ['a', 'b'] })
    })

    it('persists to disk so a fresh instance sees prior writes', async () => {
        const p = path.join(tmp, 'state.json')
        const a = new StateStore({ path: p })
        await a.set('last_customer', 'acme')

        const b = new StateStore({ path: p })
        expect(await b.get('last_customer')).toBe('acme')
    })

    it('delete returns whether the key existed', async () => {
        const store = new StateStore({ path: path.join(tmp, 'state.json') })
        await store.set('foo', 1)
        expect(await store.delete('foo')).toBe(true)
        expect(await store.delete('foo')).toBe(false)
    })

    it('list returns all keys, filterable by prefix', async () => {
        const store = new StateStore({ path: path.join(tmp, 'state.json') })
        await store.set('user.name', 'Ryan')
        await store.set('user.role', 'admin')
        await store.set('system.version', 1)

        const all = await store.list()
        expect(all.length).toBe(3)

        const userOnly = await store.list('user.')
        expect(userOnly.length).toBe(2)
        expect(userOnly.map((e) => e.key).sort()).toEqual(['user.name', 'user.role'])
    })
})

describe('State handlers — dispatched through the plugin', () => {
    it('agentmark_state_set + get round-trip through the dispatcher', async () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_state_set', { key: 'flow.last_run', value: '2026-05-11T12:00:00Z' })
        const got = await dispatcher.dispatch('agentmark_state_get', { key: 'flow.last_run' })
        expect(JSON.parse(got.text).value).toBe('2026-05-11T12:00:00Z')
    })

    it('agentmark_state_get returns null for missing keys', async () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])
        const got = await dispatcher.dispatch('agentmark_state_get', { key: 'nonexistent' })
        expect(JSON.parse(got.text).value).toBeNull()
    })

    it('agentmark_state_set requires both key and value', async () => {
        const plugin = createFoundationsPlugin({ fileRoots: [tmp], statePath: path.join(tmp, 'state.json') })
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_state_set', { key: 'k' })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/`value` is required/)
    })
})

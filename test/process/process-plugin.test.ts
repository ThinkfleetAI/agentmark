/**
 * Tests for the Process Pack.
 *
 * Exercises against real `ps` / PowerShell — no mocks. We assert on
 * shape + a few invariants (current process must be in the list, info
 * for our own pid must resolve) rather than specific values.
 */
import { describe, it, expect } from 'vitest'
import {
    createProcessPlugin,
    listProcesses,
    getProcessDetail,
    PROCESS_TOOLS,
} from '../../src/plugins/process'
import { Dispatcher } from '../../src/mcp/plugin'

describe('Process plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(PROCESS_TOOLS.map((t) => t.name).sort())
    })

    it('exposes the v0 tool set', () => {
        expect(PROCESS_TOOLS.map((t) => t.name).sort()).toEqual([
            'agentmark_process_info',
            'agentmark_process_list',
        ])
    })
})

describe('listProcesses — live OS call', () => {
    it('includes the current Node process in the list', async () => {
        const all = await listProcesses()
        expect(all.length).toBeGreaterThan(0)
        const self = all.find((p) => p.pid === process.pid)
        expect(self).toBeDefined()
    })

    it('every entry has at least pid and name', async () => {
        const all = await listProcesses()
        for (const p of all.slice(0, 20)) {
            expect(p.pid).toBeTypeOf('number')
            expect(p.name).toBeTypeOf('string')
            expect(p.name.length).toBeGreaterThan(0)
        }
    })
})

describe('getProcessDetail — live OS call', () => {
    it('returns detail for the current process', async () => {
        const detail = await getProcessDetail(process.pid)
        expect(detail).not.toBeNull()
        expect(detail!.pid).toBe(process.pid)
        // ppid + command should usually populate.
        expect(typeof detail!.ppid === 'number' || detail!.ppid === undefined).toBe(true)
    })

    it('returns null for a PID that does not exist', async () => {
        // PIDs in the very-high range are virtually never assigned.
        const detail = await getProcessDetail(99_999_999)
        expect(detail).toBeNull()
    })
})

describe('agentmark_process_list — dispatched through the plugin', () => {
    it('returns a structured response with total/matched/returned + processes', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_process_list', { limit: 10 })
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(body.total).toBeGreaterThan(0)
        expect(body.returned).toBeLessThanOrEqual(10)
        expect(Array.isArray(body.processes)).toBe(true)
        expect(body.sort_by).toBe('cpu')
    })

    it('substring-matches via name_filter (case-insensitive)', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        // 'node' should match the current Node process on every platform
        // we care about (and basically everything that runs JS).
        const result = await dispatcher.dispatch('agentmark_process_list', { name_filter: 'NODE' })
        const body = JSON.parse(result.text)
        expect(body.matched).toBeGreaterThan(0)
        for (const p of body.processes) {
            expect(p.name.toLowerCase()).toContain('node')
        }
    })

    it('sorts by memory descending when requested', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_process_list', { sort_by: 'memory', limit: 5 })
        const body = JSON.parse(result.text)
        for (let i = 1; i < body.processes.length; i++) {
            expect(body.processes[i - 1].memory_kb ?? 0).toBeGreaterThanOrEqual(body.processes[i].memory_kb ?? 0)
        }
    })
})

describe('agentmark_process_info — dispatched through the plugin', () => {
    it('returns found=true with details for the current PID', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_process_info', { pid: process.pid })
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(body.found).toBe(true)
        expect(body.pid).toBe(process.pid)
    })

    it('returns isError + found=false for unknown PID', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_process_info', { pid: 99_999_999 })
        expect(result.isError).toBe(true)
        const body = JSON.parse(result.text)
        expect(body.found).toBe(false)
    })

    it('rejects non-positive pid', async () => {
        const plugin = createProcessPlugin()
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_process_info', { pid: -1 })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/positive integer/)
    })
})

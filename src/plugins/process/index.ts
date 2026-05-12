/**
 * Process Pack — OS-process introspection.
 *
 * Read-only in v0. Useful for agents debugging "why isn't this app
 * responding?" or "is the bridge still alive?" or "what's eating CPU?".
 * Kill / signal sending lands in a follow-up with explicit gating.
 */
import {
    listProcesses,
    getProcessDetail,
    type ProcessSummary,
} from './process-runner'
import { PROCESS_TOOLS } from './tool-defs'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export function createProcessPlugin(): AgentMarkPlugin {
    const handlers: Record<string, ToolHandler> = {
        agentmark_process_list: async (args): Promise<DispatchResult> => {
            const all = await listProcesses()
            const filter = typeof args.name_filter === 'string' ? args.name_filter.toLowerCase() : null
            const sortBy = ['cpu', 'memory', 'name', 'pid'].includes(args.sort_by as string)
                ? (args.sort_by as 'cpu' | 'memory' | 'name' | 'pid')
                : 'cpu'
            const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 200

            const filtered = filter
                ? all.filter((p) => p.name.toLowerCase().includes(filter))
                : all

            filtered.sort((a, b) => compareProcesses(a, b, sortBy))
            const trimmed = filtered.slice(0, limit)

            return {
                text: JSON.stringify({
                    total: all.length,
                    matched: filtered.length,
                    returned: trimmed.length,
                    sort_by: sortBy,
                    processes: trimmed,
                }, null, 2),
            }
        },

        agentmark_process_info: async (args): Promise<DispatchResult> => {
            const pid = args.pid
            if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
                return { text: '`pid` must be a positive integer.', isError: true }
            }
            const detail = await getProcessDetail(pid)
            if (!detail) {
                return {
                    text: JSON.stringify({ pid, found: false }, null, 2),
                    isError: true,
                }
            }
            return { text: JSON.stringify({ found: true, ...detail }, null, 2) }
        },
    }

    return {
        name: 'process',
        version: '0.1.0',
        tools: PROCESS_TOOLS,
        handlers,
    }
}

function compareProcesses(a: ProcessSummary, b: ProcessSummary, by: 'cpu' | 'memory' | 'name' | 'pid'): number {
    switch (by) {
        case 'cpu':
            return (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0)
        case 'memory':
            return (b.memory_kb ?? 0) - (a.memory_kb ?? 0)
        case 'pid':
            return a.pid - b.pid
        case 'name':
            return a.name.localeCompare(b.name)
    }
}

export { listProcesses, getProcessDetail } from './process-runner'
export { PROCESS_TOOLS } from './tool-defs'
export type { ProcessSummary, ProcessDetail } from './process-runner'

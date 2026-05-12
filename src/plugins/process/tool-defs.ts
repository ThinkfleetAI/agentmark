/**
 * Process Pack — tool definitions.
 *
 * Read-only introspection in v0 (list + per-PID detail). Process kill
 * is intentionally out — too easy to misuse, lands in a follow-up
 * with explicit "allow_kill" gating + signal whitelist.
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const PROCESS_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_process_list',
        description:
            'List running processes on the host. Returns one summary per '
            + 'process: pid, name, user, cpu_percent, memory_kb, command, '
            + 'elapsed. Use `name_filter` to substring-match the process '
            + 'name (case-insensitive) when you only want to see specific '
            + 'apps.\n'
            + '\nCross-platform via OS-native tools: `ps` on macOS/Linux, '
            + 'PowerShell `Get-Process` on Windows.',
        inputSchema: {
            type: 'object',
            properties: {
                name_filter: {
                    type: 'string',
                    description: 'Case-insensitive substring match on process name. Omit to list everything.',
                },
                limit: {
                    type: 'number',
                    description: 'Truncate to this many results (after sorting). Default: 200.',
                },
                sort_by: {
                    type: 'string',
                    enum: ['cpu', 'memory', 'name', 'pid'],
                    description: 'Sort order. Default: cpu (descending).',
                },
            },
        },
    },
    {
        name: 'agentmark_process_info',
        description:
            'Return detailed info about a single process by PID. Includes '
            + 'parent PID, virtual + resident memory, OS-specific state '
            + 'flag, and full command line where available. Returns null '
            + 'when the PID is not running.',
        inputSchema: {
            type: 'object',
            properties: {
                pid: { type: 'number' },
            },
            required: ['pid'],
        },
    },
]

/**
 * Memory Pack — hierarchical persistent memory for AI agents.
 *
 * Designed primarily for IDE coding-assistant integrations (Claude Code,
 * Cursor, Codex, Windsurf) where per-session amnesia is the dominant
 * UX limitation. Adds 5 MCP tools the agent uses to remember things
 * across sessions: project conventions, build commands, last-known-good
 * states, user preferences.
 *
 * Five scope levels (platform / project / agent / user / session)
 * organise memories so the right amount of context surfaces in the
 * right place. agentmark_memory_get can walk the scope hierarchy in
 * one call.
 */
import { LocalFileMemoryBackend } from './store'
import { MEMORY_TOOLS } from './tool-defs'
import type { MemoryBackend } from './backend'
import type { MemoryScope } from './types'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export interface MemoryPluginConfig {
    /**
     * Storage backend. Pass a `RemoteMemoryBackend` to point at an
     * on-prem or cloud ThinkFleet memory service. Defaults to a
     * `LocalFileMemoryBackend` at ~/.thinkfleet/agentmark/memory.json.
     */
    backend?: MemoryBackend
    /** Local-file backend convenience: override the on-disk store path.
     *  Ignored when `backend` is supplied. */
    storePath?: string
    /** Local-file backend convenience: soft LRU cap. Ignored when
     *  `backend` is supplied. Default: 10000. */
    maxRecords?: number
    /** Default scope to apply when callers omit one. Ignored when
     *  `backend` is supplied (configure on the backend instead). */
    defaultScope?: MemoryScope
}

export function createMemoryPlugin(config: MemoryPluginConfig = {}): AgentMarkPlugin {
    const store: MemoryBackend = config.backend ?? new LocalFileMemoryBackend({
        path: config.storePath,
        maxRecords: config.maxRecords,
        defaultScope: config.defaultScope,
    })

    const handlers: Record<string, ToolHandler> = {
        agentmark_memory_set: async (args): Promise<DispatchResult> => {
            const key = requireString(args, 'key')
            if (!('value' in args)) {
                return { text: '`value` is required.', isError: true }
            }
            const scope = parseScope(args.scope)
            const tags = optionalStringArray(args.tags)
            const ttlSeconds = typeof args.ttl_seconds === 'number' ? args.ttl_seconds : undefined

            const record = await store.set({
                key,
                value: args.value,
                scope,
                tags,
                ttlSeconds,
            })
            return { text: JSON.stringify({ saved: true, record }, null, 2) }
        },

        agentmark_memory_get: async (args): Promise<DispatchResult> => {
            const key = requireString(args, 'key')
            const scopes = Array.isArray(args.scopes)
                ? (args.scopes as Array<unknown>).map((s) => parseScope(s))
                : undefined
            const record = await store.get({ key, scopes })
            return { text: JSON.stringify({ found: record !== null, record }, null, 2) }
        },

        agentmark_memory_search: async (args): Promise<DispatchResult> => {
            const records = await store.search({
                query: typeof args.query === 'string' ? args.query : undefined,
                scope: args.scope ? parseScope(args.scope) : undefined,
                tags: optionalStringArray(args.tags),
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                sort_by: ['recency', 'access_count', 'created'].includes(args.sort_by as string)
                    ? (args.sort_by as 'recency' | 'access_count' | 'created')
                    : undefined,
            })
            return { text: JSON.stringify({ count: records.length, records }, null, 2) }
        },

        agentmark_memory_list: async (args): Promise<DispatchResult> => {
            const records = await store.list(
                args.scope ? parseScope(args.scope) : undefined,
                typeof args.prefix === 'string' ? args.prefix : undefined,
                typeof args.limit === 'number' ? args.limit : 200,
            )
            return { text: JSON.stringify({ count: records.length, records }, null, 2) }
        },

        agentmark_memory_delete: async (args): Promise<DispatchResult> => {
            if (typeof args.record_id === 'string') {
                const deleted = await store.deleteById(args.record_id)
                return { text: JSON.stringify({ deleted, record_id: args.record_id }, null, 2) }
            }
            if (typeof args.key === 'string' && args.scope) {
                const deleted = await store.deleteByKey(args.key, parseScope(args.scope))
                return { text: JSON.stringify({ deleted, key: args.key }, null, 2) }
            }
            return {
                text: 'Pass either `record_id`, OR `key` + `scope`, to identify which memory to delete.',
                isError: true,
            }
        },
    }

    // describeSessions is synchronous; pre-compute the static parts here
    // and let `describe()` (async) feed into agentmark_capabilities via
    // its own code path. The static description is enough for routine
    // diagnostics.
    const isLocalFile = store instanceof LocalFileMemoryBackend

    return {
        name: 'memory',
        version: '0.1.0',
        tools: MEMORY_TOOLS,
        handlers,
        describeSessions: () => ({
            memory: isLocalFile
                ? {
                    kind: 'local-file',
                    store_path: (store as LocalFileMemoryBackend).filePath,
                    max_records: (store as LocalFileMemoryBackend).maxRecords,
                    default_scope: (store as LocalFileMemoryBackend).defaultScope,
                }
                : {
                    kind: 'custom',
                    backend_class: store.constructor.name,
                },
        }),
    }
}

function parseScope(input: unknown): MemoryScope {
    if (!input || typeof input !== 'object') {
        throw new Error('`scope` must be an object: { type, id? }')
    }
    const obj = input as Record<string, unknown>
    if (typeof obj.type !== 'string') {
        throw new Error('`scope.type` is required.')
    }
    return {
        type: obj.type as MemoryScope['type'],
        id: typeof obj.id === 'string' ? obj.id : undefined,
    }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function optionalStringArray(v: unknown): string[] | undefined {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error('Expected an array of strings.')
    }
    return v as string[]
}

export { LocalFileMemoryBackend, MemoryStore } from './store'
export type { LocalFileMemoryBackendConfig, MemoryStoreConfig } from './store'
export { RemoteMemoryBackend, RemoteMemoryError } from './remote-backend'
export type { RemoteMemoryBackendConfig } from './remote-backend'
export type { MemoryBackend, MemoryBackendDescription, MemorySetInput } from './backend'
export { MEMORY_TOOLS } from './tool-defs'
export type {
    MemoryRecord,
    MemoryScope,
    MemoryScopeType,
    MemorySearchQuery,
} from './types'

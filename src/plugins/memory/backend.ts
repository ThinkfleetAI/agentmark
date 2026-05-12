/**
 * Memory backend abstraction.
 *
 * The same plugin works against any backend that satisfies this
 * interface. Two ship in v0:
 *
 *   - LocalFileMemoryBackend — JSON file on disk (default).
 *   - RemoteMemoryBackend    — HTTP client; talks to a ThinkFleet
 *                              service (on-prem or cloud).
 *
 * The desktop app picks one at construction time based on user/org
 * config. The same agentmark binary supports both wirings — no
 * conditional code paths inside the plugin or its tool handlers.
 */
import type { MemoryRecord, MemoryScope, MemorySearchQuery } from './types'

export interface MemorySetInput {
    key: string
    value: unknown
    scope?: MemoryScope
    tags?: string[]
    ttlSeconds?: number
}

export interface MemoryBackend {
    set(input: MemorySetInput): Promise<MemoryRecord>
    get(input: { key: string; scopes?: MemoryScope[] }): Promise<MemoryRecord | null>
    deleteById(recordId: string): Promise<boolean>
    deleteByKey(key: string, scope: MemoryScope): Promise<boolean>
    search(query: MemorySearchQuery): Promise<MemoryRecord[]>
    list(scope?: MemoryScope, prefix?: string, limit?: number): Promise<MemoryRecord[]>
    clear(): Promise<void>
    /** Backend-defined metadata for inclusion in agentmark_list_sessions /
     *  agentmark_capabilities output. The `kind` field is the only one
     *  every backend must set ("local-file", "remote-http", "in-memory"). */
    describe(): Promise<MemoryBackendDescription>
}

export interface MemoryBackendDescription {
    kind: string
    [k: string]: unknown
}

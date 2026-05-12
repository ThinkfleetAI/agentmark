/**
 * Local-file memory backend.
 *
 * The default `MemoryBackend` implementation: a single JSON file on
 * disk (mode 0600), atomic temp-file + rename writes, soft LRU cap
 * via `maxRecords`. Suitable for single-machine setups; for team
 * sharing or on-prem/cloud sync, use RemoteMemoryBackend instead.
 *
 * Default path: `~/.thinkfleet/agentmark/memory.json`. Separate from
 * Foundations StateStore + Recipes RecipeStore so each has
 * independent persistence + backup/sync.
 */
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MemoryBackend, MemoryBackendDescription, MemorySetInput } from './backend'
import type { MemoryRecord, MemoryScope, MemorySearchQuery } from './types'

export interface LocalFileMemoryBackendConfig {
    /** Override the on-disk path (mostly for tests). */
    path?: string
    /** Soft cap on total records before LRU-eviction kicks in. Default: 10000. */
    maxRecords?: number
    /** Default scope to use when callers omit one. */
    defaultScope?: MemoryScope
}

/** @deprecated Use LocalFileMemoryBackendConfig. */
export type MemoryStoreConfig = LocalFileMemoryBackendConfig

interface MemoryFile {
    version: 1
    records: Record<string, MemoryRecord>
}

const SCOPE_ORDER: Array<MemoryScope['type']> = ['session', 'agent', 'user', 'project', 'platform']

export class LocalFileMemoryBackend implements MemoryBackend {
    readonly filePath: string
    readonly maxRecords: number
    readonly defaultScope?: MemoryScope
    private cached: MemoryFile | null = null

    constructor(config: LocalFileMemoryBackendConfig = {}) {
        this.filePath = config.path
            ?? path.join(os.homedir(), '.thinkfleet', 'agentmark', 'memory.json')
        this.maxRecords = config.maxRecords ?? 10_000
        this.defaultScope = config.defaultScope
    }

    /**
     * Store a memory. When a record with the same key + scope exists it's
     * replaced (and access_count / created_at preserved).
     */
    async set(input: {
        key: string
        value: unknown
        scope?: MemoryScope
        tags?: string[]
        ttlSeconds?: number
    }): Promise<MemoryRecord> {
        const scope = input.scope ?? this.defaultScope ?? { type: 'platform' }
        validateScope(scope)

        const file = await this.load()
        const existing = findByKeyAndScope(file.records, input.key, scope)
        const now = new Date().toISOString()
        const recordId = existing?.record_id ?? generateRecordId()

        const record: MemoryRecord = {
            record_id: recordId,
            key: input.key,
            value: input.value,
            scope,
            tags: input.tags,
            expires_at: typeof input.ttlSeconds === 'number'
                ? Date.now() + input.ttlSeconds * 1000
                : existing?.expires_at,
            created_at: existing?.created_at ?? now,
            updated_at: now,
            access_count: existing?.access_count ?? 0,
            last_accessed_at: existing?.last_accessed_at,
        }
        file.records[recordId] = record
        this.evictIfOverCapacity(file)
        await this.persist(file)
        return record
    }

    /**
     * Look up a memory by key. When `scopes` is supplied, each scope is
     * tried in order and the first hit is returned. When `scopes` is
     * omitted, the entire scope hierarchy (session > agent > user >
     * project > platform) is walked from most-specific to most-general.
     */
    async get(input: { key: string; scopes?: MemoryScope[] }): Promise<MemoryRecord | null> {
        const file = await this.load()
        const scopes = input.scopes ?? this.implicitScopeHierarchy()
        for (const scope of scopes) {
            const record = findByKeyAndScope(file.records, input.key, scope)
            if (!record) continue
            if (record.expires_at && record.expires_at < Date.now()) continue
            await this.touchRecord(file, record)
            return record
        }
        return null
    }

    async deleteById(recordId: string): Promise<boolean> {
        const file = await this.load()
        if (!(recordId in file.records)) return false
        delete file.records[recordId]
        await this.persist(file)
        return true
    }

    async deleteByKey(key: string, scope: MemoryScope): Promise<boolean> {
        const file = await this.load()
        const record = findByKeyAndScope(file.records, key, scope)
        if (!record) return false
        delete file.records[record.record_id]
        await this.persist(file)
        return true
    }

    async search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
        const file = await this.load()
        const now = Date.now()
        const limit = query.limit ?? 50

        let records = Object.values(file.records).filter((r) => {
            if (r.expires_at && r.expires_at < now) return false
            if (query.scope && !scopeMatches(r.scope, query.scope)) return false
            if (query.tags && query.tags.length > 0) {
                if (!r.tags || !r.tags.some((t) => query.tags!.includes(t))) return false
            }
            if (query.query) {
                const needle = query.query.toLowerCase()
                if (!r.key.toLowerCase().includes(needle) && !stringContains(r.value, needle)) {
                    return false
                }
            }
            return true
        })

        records.sort((a, b) => compareRecords(a, b, query.sort_by ?? 'recency'))
        records = records.slice(0, limit)
        // Bump access counts for the returned records.
        for (const r of records) await this.touchRecord(file, r)
        return records
    }

    async list(scope?: MemoryScope, prefix?: string, limit = 200): Promise<MemoryRecord[]> {
        const file = await this.load()
        const now = Date.now()
        let records = Object.values(file.records).filter((r) => {
            if (r.expires_at && r.expires_at < now) return false
            if (scope && !scopeMatches(r.scope, scope)) return false
            if (prefix && !r.key.startsWith(prefix)) return false
            return true
        })
        records.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        return records.slice(0, limit)
    }

    async clear(): Promise<void> {
        this.cached = { version: 1, records: {} }
        await unlink(this.filePath).catch(() => {})
    }

    /** Stats helper for `describeSessions`. */
    async describe(): Promise<MemoryBackendDescription> {
        const file = await this.load()
        const all = Object.values(file.records)
        const now = Date.now()
        return {
            kind: 'local-file',
            total: all.length,
            expired: all.filter((r) => r.expires_at && r.expires_at < now).length,
            path: this.filePath,
        }
    }

    private implicitScopeHierarchy(): MemoryScope[] {
        // Without explicit caller-supplied scopes, fall back to just the
        // default scope (or platform). The hierarchy is meaningful only
        // when the caller knows their session / agent / project ids.
        return [this.defaultScope ?? { type: 'platform' }]
    }

    private async touchRecord(file: MemoryFile, record: MemoryRecord): Promise<void> {
        record.access_count += 1
        record.last_accessed_at = new Date().toISOString()
        await this.persist(file)
    }

    private evictIfOverCapacity(file: MemoryFile): void {
        const records = Object.values(file.records)
        if (records.length <= this.maxRecords) return
        records.sort((a, b) => (a.last_accessed_at ?? a.updated_at).localeCompare(b.last_accessed_at ?? b.updated_at))
        const toEvict = records.length - this.maxRecords
        for (let i = 0; i < toEvict; i++) {
            delete file.records[records[i].record_id]
        }
    }

    private async load(): Promise<MemoryFile> {
        if (this.cached) return this.cached
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as MemoryFile
            if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== 'object') {
                throw new Error(`Malformed memory file at ${this.filePath}: unexpected schema.`)
            }
            this.cached = parsed
            return parsed
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.cached = { version: 1, records: {} }
                return this.cached
            }
            throw err
        }
    }

    private async persist(file: MemoryFile): Promise<void> {
        this.cached = file
        await mkdir(path.dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8' })
        await chmod(tmp, 0o600).catch(() => {
            // Windows ACL semantics swallow chmod; not fatal.
        })
        await rename(tmp, this.filePath)
    }
}

function findByKeyAndScope(records: Record<string, MemoryRecord>, key: string, scope: MemoryScope): MemoryRecord | null {
    for (const r of Object.values(records)) {
        if (r.key === key && scopeExactMatch(r.scope, scope)) return r
    }
    return null
}

function scopeExactMatch(a: MemoryScope, b: MemoryScope): boolean {
    return a.type === b.type && (a.id ?? null) === (b.id ?? null)
}

function scopeMatches(record: MemoryScope, query: MemoryScope): boolean {
    if (record.type !== query.type) return false
    // When the query scope omits id, accept any id within the scope type.
    if (query.id === undefined) return true
    return record.id === query.id
}

function compareRecords(a: MemoryRecord, b: MemoryRecord, by: NonNullable<MemorySearchQuery['sort_by']>): number {
    switch (by) {
        case 'access_count': return b.access_count - a.access_count
        case 'created':      return b.created_at.localeCompare(a.created_at)
        case 'recency':
        default:             return b.updated_at.localeCompare(a.updated_at)
    }
}

function stringContains(value: unknown, needle: string): boolean {
    if (typeof value === 'string') return value.toLowerCase().includes(needle)
    if (value && typeof value === 'object') {
        try {
            return JSON.stringify(value).toLowerCase().includes(needle)
        } catch {
            return false
        }
    }
    return String(value).toLowerCase().includes(needle)
}

function validateScope(scope: MemoryScope): void {
    if (!SCOPE_ORDER.includes(scope.type)) {
        throw new Error(`Unknown memory scope type: ${scope.type}. Allowed: ${SCOPE_ORDER.join(', ')}`)
    }
    if (scope.type !== 'platform' && !scope.id) {
        throw new Error(`Memory scope type "${scope.type}" requires an id (e.g. project path, user email, session id).`)
    }
}

function generateRecordId(): string {
    const r =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
            : Math.random().toString(36).slice(2, 16)
    return `mem_${r}`
}

/**
 * Backward-compat alias. Old code did `new MemoryStore({ path })`; that
 * still works — it just constructs the local-file backend under its
 * descriptive name.
 *
 * @deprecated Prefer `LocalFileMemoryBackend` or pass a `MemoryBackend`
 * directly to `createMemoryPlugin({ backend })`.
 */
export const MemoryStore = LocalFileMemoryBackend

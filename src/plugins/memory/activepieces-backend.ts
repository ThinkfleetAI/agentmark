/**
 * Activepieces-backed memory backend.
 *
 * Wires the agentmark Memory plugin to the production Activepieces
 * agent-memory API. Same `MemoryBackend` interface as the disk-backed
 * store — the plugin layer + tool handlers don't know or care which
 * backend they're talking to.
 *
 * The user's ThinkFleet stack already has a rich memory system
 * (bi-temporal facts, hybrid vector+BM25 search, scope-aware
 * confirmation workflow, knowledge graph). The simple key/value
 * interface agentmark exposes to AI agents maps onto a subset of
 * that system; this class is the bridge.
 *
 * Mapping (agentmark K/V → Activepieces rich shape):
 *   - agentmark `key`     → Activepieces `metadata.agentmark_key`
 *     (Activepieces stores free-form `content`, not key/value pairs;
 *     we round-trip the key through metadata so get/deleteByKey can
 *     locate records.)
 *   - agentmark `value`   → Activepieces `content` (string-coerced)
 *                         + `metadata.raw_value` (preserves type)
 *   - agentmark `scope`   → Activepieces `scope` (same five-level enum)
 *   - agentmark `scope.id` → `metadata.scope_id`
 *   - agentmark `tags`    → `metadata.tags` (string[])
 *
 * Auth: `Authorization: Bearer sk-<api-key>` against the Activepieces
 * Service-principal flow. The backend is scoped to one project; pass
 * a `chatbotId` to target chatbot-scoped routes (richer create/search
 * semantics), otherwise omit and the project-scoped routes are used.
 */
import type { MemoryBackend, MemoryBackendDescription, MemorySetInput } from './backend'
import type { MemoryRecord, MemoryScope, MemorySearchQuery } from './types'

export interface ActivepiecesMemoryBackendConfig {
    /** Base URL of the Activepieces API (no trailing slash). */
    baseUrl: string
    /** API key (must start with `sk-`). Service principal. */
    apiKey: string
    /** Project id this backend operates against. Required. */
    projectId: string
    /** Optional chatbot id for chatbot-scoped routes. */
    chatbotId?: string
    /** Injectable fetch (for tests). Default: globalThis.fetch. */
    fetch?: typeof fetch
    /** Per-request timeout in ms. Default: 15000. */
    timeoutMs?: number
    /** Activepieces `source` value to stamp on writes. Defaults to
     *  'agentmark' so records this backend creates are filterable. */
    source?: string
}

export class ActivepiecesMemoryError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message)
        this.name = 'ActivepiecesMemoryError'
    }
}

/** Shape of one item in the Activepieces clawdbot_memory_item table. */
interface ApMemoryItem {
    id: string
    platformId: string
    projectId: string | null
    chatbotId: string | null
    type: string
    content: string
    category: string | null
    importance: number
    source: string | null
    sessionKey: string | null
    chatIdentityId: string | null
    metadata: Record<string, unknown> | null
    scope: string
    status: string
    confidence: number
    impact: string | null
    confirmedAt: string | null
    validAt: string
    invalidAt: string | null
    created: string
    updated: string
    similarity?: number
}

const AP_KEY_FIELD = 'agentmark_key'
const AP_RAW_VALUE_FIELD = 'raw_value'
const AP_TAGS_FIELD = 'tags'

export class ActivepiecesMemoryBackend implements MemoryBackend {
    readonly baseUrl: string
    readonly projectId: string
    readonly chatbotId?: string
    readonly source: string
    private readonly apiKey: string
    private readonly fetcher: typeof fetch
    private readonly timeoutMs: number

    constructor(config: ActivepiecesMemoryBackendConfig) {
        if (!config.baseUrl) throw new Error('ActivepiecesMemoryBackend: baseUrl is required.')
        if (!config.apiKey) throw new Error('ActivepiecesMemoryBackend: apiKey is required.')
        if (!config.apiKey.startsWith('sk-')) {
            throw new Error('ActivepiecesMemoryBackend: apiKey must start with "sk-".')
        }
        if (!config.projectId) throw new Error('ActivepiecesMemoryBackend: projectId is required.')

        this.baseUrl = config.baseUrl.replace(/\/+$/, '')
        this.apiKey = config.apiKey
        this.projectId = config.projectId
        this.chatbotId = config.chatbotId
        this.source = config.source ?? 'agentmark'
        this.fetcher = config.fetch ?? globalThis.fetch
        this.timeoutMs = config.timeoutMs ?? 15_000
    }

    async set(input: MemorySetInput): Promise<MemoryRecord> {
        const scope = input.scope ?? { type: 'platform' as const }
        const body = {
            type: 'fact',
            content: stringifyValue(input.value),
            scope: scope.type,
            source: this.source,
            metadata: {
                [AP_KEY_FIELD]: input.key,
                [AP_RAW_VALUE_FIELD]: input.value,
                ...(input.tags ? { [AP_TAGS_FIELD]: input.tags } : {}),
                ...(scope.id ? { scope_id: scope.id } : {}),
            },
        }

        // Match agentmark's "set replaces same key+scope" semantics by
        // looking up the existing record and deleting it before create.
        const existing = await this.findByKey(input.key, scope)
        if (existing) await this.deleteById(existing.id)

        const created = await this.request<ApMemoryItem>('POST', this.memoryRoot(), body)
        return apToAgentmark(created)
    }

    async get(input: { key: string; scopes?: MemoryScope[] }): Promise<MemoryRecord | null> {
        const scopes = input.scopes ?? [{ type: 'platform' }]
        for (const scope of scopes) {
            const found = await this.findByKey(input.key, scope)
            if (found) return apToAgentmark(found)
        }
        return null
    }

    async deleteById(recordId: string): Promise<boolean> {
        try {
            await this.request<unknown>('DELETE', `${this.memoryRoot()}/${encodeURIComponent(recordId)}`)
            return true
        } catch (err) {
            if (err instanceof ActivepiecesMemoryError && err.status === 404) return false
            throw err
        }
    }

    async deleteByKey(key: string, scope: MemoryScope): Promise<boolean> {
        const found = await this.findByKey(key, scope)
        if (!found) return false
        return this.deleteById(found.id)
    }

    async search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
        // Activepieces' /memory/search requires a non-empty query for
        // hybrid (vector + BM25) ranking. When agentmark callers didn't
        // pass a query, fall back to a scope-filtered list so the
        // MemoryBackend contract is preserved.
        if (!query.query) return this.listFallback(query)

        const body: Record<string, unknown> = { query: query.query, limit: query.limit ?? 10 }
        if (query.scope) body.scope = query.scope.type

        const results = await this.request<ApMemoryItem[]>(
            'POST',
            `${this.memoryRoot()}/search`,
            body,
        )

        let records = results.map(apToAgentmark)
        if (query.tags && query.tags.length > 0) {
            records = records.filter((r) =>
                r.tags && r.tags.some((t) => query.tags!.includes(t)),
            )
        }
        // Activepieces' hybrid search already orders by similarity; let
        // explicit sort_by override.
        if (query.sort_by === 'recency') {
            records.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        } else if (query.sort_by === 'access_count') {
            records.sort((a, b) => b.access_count - a.access_count)
        } else if (query.sort_by === 'created') {
            records.sort((a, b) => b.created_at.localeCompare(a.created_at))
        }
        return records
    }

    async list(scope?: MemoryScope, prefix?: string, limit = 200): Promise<MemoryRecord[]> {
        const params = new URLSearchParams()
        if (scope?.type) params.set('scope', scope.type)
        params.set('source', this.source)
        params.set('limit', String(Math.min(limit, 100))) // server caps at 100/page

        const items = await this.request<ApMemoryItem[]>(
            'GET',
            `${this.memoryRoot()}?${params.toString()}`,
        )
        let records = items.map(apToAgentmark)
        if (prefix) records = records.filter((r) => r.key.startsWith(prefix))
        return records.slice(0, limit)
    }

    async clear(): Promise<void> {
        // No bulk-delete endpoint; iterate with source filter so we only
        // touch records this backend wrote. Bounded at 10 pages × 100 =
        // 1000 records to avoid runaway loops on misconfigured servers.
        const params = new URLSearchParams({ source: this.source, limit: '100' })
        for (let page = 0; page < 10; page++) {
            const items = await this.request<ApMemoryItem[]>(
                'GET',
                `${this.memoryRoot()}?${params.toString()}`,
            )
            if (items.length === 0) break
            for (const item of items) await this.deleteById(item.id)
            if (items.length < 100) break
        }
    }

    async describe(): Promise<MemoryBackendDescription> {
        return {
            kind: 'activepieces',
            base_url: this.baseUrl,
            project_id: this.projectId,
            chatbot_id: this.chatbotId,
            source: this.source,
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────────────────────

    private memoryRoot(): string {
        if (this.chatbotId) {
            return `/v1/projects/${encodeURIComponent(this.projectId)}/chatbots/${encodeURIComponent(this.chatbotId)}/memory`
        }
        return `/v1/projects/${encodeURIComponent(this.projectId)}/memory`
    }

    private async findByKey(key: string, scope: MemoryScope): Promise<ApMemoryItem | null> {
        // List by scope + source (cheap server-side filter), then match
        // key client-side. source=agentmark scopes us to records THIS
        // backend wrote so we don't collide with manually-created
        // Activepieces memories.
        const params = new URLSearchParams({
            scope: scope.type,
            source: this.source,
            limit: '100',
        })
        const items = await this.request<ApMemoryItem[]>(
            'GET',
            `${this.memoryRoot()}?${params.toString()}`,
        )
        for (const item of items) {
            const md = (item.metadata ?? {}) as Record<string, unknown>
            if (md[AP_KEY_FIELD] !== key) continue
            // Strict scope_id match: distinguishes two project-scoped
            // memories with the same key from different repos.
            if (scope.id !== undefined && md.scope_id !== scope.id) continue
            return item
        }
        return null
    }

    private async listFallback(query: MemorySearchQuery): Promise<MemoryRecord[]> {
        const records = await this.list(query.scope, undefined, query.limit ?? 50)
        if (query.tags && query.tags.length > 0) {
            return records.filter((r) =>
                r.tags && r.tags.some((t) => query.tags!.includes(t)),
            )
        }
        return records
    }

    private async request<T>(method: string, p: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {
            authorization: `Bearer ${this.apiKey}`,
        }
        if (body !== undefined) headers['content-type'] = 'application/json'

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)

        let response: Response
        try {
            response = await this.fetcher(`${this.baseUrl}${p}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            })
        } finally {
            clearTimeout(timer)
        }

        const text = await response.text()
        let parsed: unknown = undefined
        if (text.length > 0) {
            try { parsed = JSON.parse(text) } catch { parsed = text }
        }

        if (!response.ok) {
            throw new ActivepiecesMemoryError(
                `Activepieces memory ${method} ${p} failed: ${response.status} ${response.statusText}`,
                response.status,
                parsed,
            )
        }
        return parsed as T
    }
}

function stringifyValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return ''
    return JSON.stringify(value)
}

function apToAgentmark(item: ApMemoryItem): MemoryRecord {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>
    const storedKey = typeof metadata[AP_KEY_FIELD] === 'string'
        ? metadata[AP_KEY_FIELD] as string
        : item.id
    const rawValue = AP_RAW_VALUE_FIELD in metadata
        ? metadata[AP_RAW_VALUE_FIELD]
        : item.content
    const tags = Array.isArray(metadata[AP_TAGS_FIELD])
        ? metadata[AP_TAGS_FIELD] as string[]
        : undefined
    const scopeId = typeof metadata.scope_id === 'string' ? metadata.scope_id as string : undefined

    return {
        record_id: item.id,
        key: storedKey,
        value: rawValue,
        scope: {
            type: item.scope as MemoryScope['type'],
            id: scopeId,
        },
        tags,
        expires_at: item.invalidAt ? Date.parse(item.invalidAt) : undefined,
        created_at: item.created,
        updated_at: item.updated,
        access_count: 0,
        last_accessed_at: undefined,
    }
}

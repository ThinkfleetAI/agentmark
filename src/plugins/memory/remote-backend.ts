/**
 * Remote (HTTP) memory backend.
 *
 * Hits a ThinkFleet memory service over HTTPS. Same agentmark binary
 * works against on-prem deployments (internal URL, internal auth) and
 * cloud deployments (api.thinkfleet.ai) — only the `baseUrl` + `token`
 * differ.
 *
 * Auth: Bearer token. Optional `X-Workspace-Id` header scopes calls to
 * a specific team/org so a single user can be a member of multiple
 * workspaces.
 *
 * Endpoint contract (v1 proposal — subject to change before the
 * service ships):
 *
 *   POST   /v1/memory/records              { key, value, scope, tags?, ttl_seconds? } → MemoryRecord
 *   POST   /v1/memory/records/get          { key, scopes? }                            → MemoryRecord | null
 *   DELETE /v1/memory/records/:record_id                                               → { deleted: boolean }
 *   DELETE /v1/memory/records              { key, scope }                              → { deleted: boolean }
 *   POST   /v1/memory/search               MemorySearchQuery                           → MemoryRecord[]
 *   GET    /v1/memory/records?scope_type=&scope_id=&prefix=&limit=                     → MemoryRecord[]
 *   DELETE /v1/memory/records/all                                                      → { cleared: true }
 *   GET    /v1/memory/describe                                                         → MemoryBackendDescription
 *
 * Errors: non-2xx responses are surfaced as RemoteMemoryError with the
 * status code + parsed JSON body (when JSON). Auth-related 401s also
 * include the workspace header for easier debugging.
 */
import type { MemoryBackend, MemoryBackendDescription, MemorySetInput } from './backend'
import type { MemoryRecord, MemoryScope, MemorySearchQuery } from './types'

export interface RemoteMemoryBackendConfig {
    /** Base URL of the memory service (no trailing slash). */
    baseUrl: string
    /** Bearer token. Required for all non-anonymous deployments. */
    token?: string
    /** Optional workspace / team id sent as `X-Workspace-Id`. */
    workspaceId?: string
    /** Injectable fetch (defaults to globalThis.fetch). Used by tests. */
    fetch?: typeof fetch
    /** Per-request timeout in ms. Default: 15_000. */
    timeoutMs?: number
}

export class RemoteMemoryError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message)
        this.name = 'RemoteMemoryError'
    }
}

export class RemoteMemoryBackend implements MemoryBackend {
    readonly baseUrl: string
    readonly workspaceId?: string
    private readonly token?: string
    private readonly fetcher: typeof fetch
    private readonly timeoutMs: number

    constructor(config: RemoteMemoryBackendConfig) {
        if (!config.baseUrl) throw new Error('RemoteMemoryBackend: baseUrl is required.')
        this.baseUrl = config.baseUrl.replace(/\/+$/, '')
        this.token = config.token
        this.workspaceId = config.workspaceId
        this.fetcher = config.fetch ?? globalThis.fetch
        this.timeoutMs = config.timeoutMs ?? 15_000
    }

    async set(input: MemorySetInput): Promise<MemoryRecord> {
        return await this.request<MemoryRecord>('POST', '/v1/memory/records', {
            key: input.key,
            value: input.value,
            scope: input.scope ?? { type: 'platform' },
            tags: input.tags,
            ttl_seconds: input.ttlSeconds,
        })
    }

    async get(input: { key: string; scopes?: MemoryScope[] }): Promise<MemoryRecord | null> {
        const result = await this.request<MemoryRecord | null>('POST', '/v1/memory/records/get', input)
        return result ?? null
    }

    async deleteById(recordId: string): Promise<boolean> {
        const r = await this.request<{ deleted: boolean }>(
            'DELETE',
            `/v1/memory/records/${encodeURIComponent(recordId)}`,
        )
        return r.deleted === true
    }

    async deleteByKey(key: string, scope: MemoryScope): Promise<boolean> {
        const r = await this.request<{ deleted: boolean }>('DELETE', '/v1/memory/records', { key, scope })
        return r.deleted === true
    }

    async search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
        return await this.request<MemoryRecord[]>('POST', '/v1/memory/search', query)
    }

    async list(scope?: MemoryScope, prefix?: string, limit?: number): Promise<MemoryRecord[]> {
        const params = new URLSearchParams()
        if (scope?.type) params.set('scope_type', scope.type)
        if (scope?.id) params.set('scope_id', scope.id)
        if (prefix) params.set('prefix', prefix)
        if (typeof limit === 'number') params.set('limit', String(limit))
        const qs = params.toString()
        return await this.request<MemoryRecord[]>(
            'GET',
            `/v1/memory/records${qs ? '?' + qs : ''}`,
        )
    }

    async clear(): Promise<void> {
        await this.request<{ cleared: true }>('DELETE', '/v1/memory/records/all')
    }

    async describe(): Promise<MemoryBackendDescription> {
        const remote = await this.request<MemoryBackendDescription | undefined>(
            'GET',
            '/v1/memory/describe',
        ).catch((): undefined => undefined)
        return {
            kind: 'remote-http',
            base_url: this.baseUrl,
            workspace_id: this.workspaceId,
            ...(remote ?? {}),
        }
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {}
        if (this.token) headers.authorization = `Bearer ${this.token}`
        if (this.workspaceId) headers['x-workspace-id'] = this.workspaceId
        if (body !== undefined) headers['content-type'] = 'application/json'

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)

        let response: Response
        try {
            response = await this.fetcher(`${this.baseUrl}${path}`, {
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
            throw new RemoteMemoryError(
                `Memory service ${method} ${path} failed: ${response.status} ${response.statusText}`,
                response.status,
                parsed,
            )
        }
        return parsed as T
    }
}

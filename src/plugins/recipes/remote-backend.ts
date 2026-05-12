/**
 * Remote (HTTP) recipe backend.
 *
 * Same auth + workspace pattern as RemoteMemoryBackend. The desktop
 * app instantiates this when the user/org is configured for on-prem
 * or cloud sync — recipes saved by one teammate become available to
 * everyone in the workspace.
 *
 * Endpoint contract (v1 proposal):
 *
 *   POST   /v1/recipes                  Recipe                     → Recipe
 *   GET    /v1/recipes/:name                                       → Recipe | null
 *   GET    /v1/recipes?target_app=...                              → Recipe[]
 *   DELETE /v1/recipes/:name                                       → { deleted: boolean }
 *   DELETE /v1/recipes/all                                         → { cleared: true }
 *   GET    /v1/recipes/describe                                    → RecipeBackendDescription
 *
 * Save semantics: server controls version + timestamps; the on_conflict
 * flag is passed as a query param.
 */
import type { RecipeBackend, RecipeBackendDescription } from './backend'
import type { Recipe } from './types'

export interface RemoteRecipeBackendConfig {
    /** Base URL of the recipe service (no trailing slash). */
    baseUrl: string
    /** Bearer token. */
    token?: string
    /** Optional workspace / team id sent as `X-Workspace-Id`. */
    workspaceId?: string
    /** Injectable fetch (defaults to globalThis.fetch). */
    fetch?: typeof fetch
    /** Per-request timeout in ms. Default: 15_000. */
    timeoutMs?: number
}

export class RemoteRecipeError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message)
        this.name = 'RemoteRecipeError'
    }
}

export class RemoteRecipeBackend implements RecipeBackend {
    readonly baseUrl: string
    readonly workspaceId?: string
    private readonly token?: string
    private readonly fetcher: typeof fetch
    private readonly timeoutMs: number

    constructor(config: RemoteRecipeBackendConfig) {
        if (!config.baseUrl) throw new Error('RemoteRecipeBackend: baseUrl is required.')
        this.baseUrl = config.baseUrl.replace(/\/+$/, '')
        this.token = config.token
        this.workspaceId = config.workspaceId
        this.fetcher = config.fetch ?? globalThis.fetch
        this.timeoutMs = config.timeoutMs ?? 15_000
    }

    async get(name: string): Promise<Recipe | null> {
        try {
            return await this.request<Recipe>('GET', `/v1/recipes/${encodeURIComponent(name)}`)
        } catch (err) {
            if (err instanceof RemoteRecipeError && err.status === 404) return null
            throw err
        }
    }

    async list(filter?: { target_app?: string }): Promise<Recipe[]> {
        const qs = filter?.target_app ? `?target_app=${encodeURIComponent(filter.target_app)}` : ''
        return await this.request<Recipe[]>('GET', `/v1/recipes${qs}`)
    }

    async save(recipe: Recipe, options: { on_conflict?: 'replace' | 'fail' } = {}): Promise<Recipe> {
        const onConflict = options.on_conflict ?? 'fail'
        return await this.request<Recipe>(
            'POST',
            `/v1/recipes?on_conflict=${onConflict}`,
            recipe,
        )
    }

    async delete(name: string): Promise<boolean> {
        try {
            const r = await this.request<{ deleted: boolean }>(
                'DELETE',
                `/v1/recipes/${encodeURIComponent(name)}`,
            )
            return r.deleted === true
        } catch (err) {
            if (err instanceof RemoteRecipeError && err.status === 404) return false
            throw err
        }
    }

    async clear(): Promise<void> {
        await this.request<{ cleared: true }>('DELETE', '/v1/recipes/all')
    }

    async describe(): Promise<RecipeBackendDescription> {
        const remote = await this.request<RecipeBackendDescription | undefined>(
            'GET',
            '/v1/recipes/describe',
        ).catch((): undefined => undefined)
        return {
            kind: 'remote-http',
            base_url: this.baseUrl,
            workspace_id: this.workspaceId,
            ...(remote ?? {}),
        }
    }

    private async request<T>(method: string, p: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {}
        if (this.token) headers.authorization = `Bearer ${this.token}`
        if (this.workspaceId) headers['x-workspace-id'] = this.workspaceId
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
            throw new RemoteRecipeError(
                `Recipe service ${method} ${p} failed: ${response.status} ${response.statusText}`,
                response.status,
                parsed,
            )
        }
        return parsed as T
    }
}

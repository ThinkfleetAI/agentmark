/**
 * Activepieces-backed recipe backend.
 *
 * Wires the agentmark Recipes plugin to the production Activepieces
 * `clawdbot_recipe` REST API. Same `RecipeBackend` interface as the
 * local-file store — the plugin layer + tool handlers don't know or
 * care which backend they're talking to.
 *
 * Endpoint contract (mirrored 1:1 from the Activepieces routes shipped
 * in flobyteAI PR #694):
 *
 *   POST   /v1/projects/:projectId/[chatbots/:chatbotId/]recipes
 *          ?on_conflict=fail|replace                   create / replace
 *   GET    /v1/projects/:projectId/[chatbots/:chatbotId/]recipes
 *          ?target_app=<name>                          list + filter
 *   GET    /v1/projects/:projectId/[chatbots/:chatbotId/]recipes/:name
 *   DELETE /v1/projects/:projectId/[chatbots/:chatbotId/]recipes/:name
 *   GET    /v1/projects/:projectId/[chatbots/:chatbotId/]recipes/describe
 *
 * Auth: `Authorization: Bearer sk-<api-key>` (Activepieces Service
 * principal). The backend is scoped to one project; pass `chatbotId`
 * for chatbot-scoped storage, omit for project-scoped.
 *
 * Field-name mapping (Activepieces uses `targetApp` camelCase
 * server-side; the agentmark Recipe type uses `target_app` to match
 * the tool-arg convention):
 *   - agentmark `target_app` ↔ Activepieces `targetApp`
 *   Everything else is identical.
 */
import type { RecipeBackend, RecipeBackendDescription } from './backend'
import type { Recipe } from './types'

export interface ActivepiecesRecipeBackendConfig {
    /** Base URL of the Activepieces API (no trailing slash). */
    baseUrl: string
    /** API key (must start with `sk-`). */
    apiKey: string
    /** Project id this backend operates against. Required. */
    projectId: string
    /** Optional chatbot id for chatbot-scoped routes. */
    chatbotId?: string
    /** Injectable fetch (for tests). Default: globalThis.fetch. */
    fetch?: typeof fetch
    /** Per-request timeout in ms. Default: 15000. */
    timeoutMs?: number
}

export class ActivepiecesRecipeError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message)
        this.name = 'ActivepiecesRecipeError'
    }
}

/** Wire shape on the Activepieces side. Note the camelCase `targetApp`. */
interface ApRecipe {
    id: string
    platformId: string
    projectId: string
    chatbotId: string | null
    name: string
    description: string | null
    targetApp: string | null
    parameters: Recipe['parameters']
    steps: Recipe['steps']
    version: number
    created: string
    updated: string
}

export class ActivepiecesRecipeBackend implements RecipeBackend {
    readonly baseUrl: string
    readonly projectId: string
    readonly chatbotId?: string
    private readonly apiKey: string
    private readonly fetcher: typeof fetch
    private readonly timeoutMs: number

    constructor(config: ActivepiecesRecipeBackendConfig) {
        if (!config.baseUrl) throw new Error('ActivepiecesRecipeBackend: baseUrl is required.')
        if (!config.apiKey) throw new Error('ActivepiecesRecipeBackend: apiKey is required.')
        if (!config.apiKey.startsWith('sk-')) {
            throw new Error('ActivepiecesRecipeBackend: apiKey must start with "sk-".')
        }
        if (!config.projectId) throw new Error('ActivepiecesRecipeBackend: projectId is required.')

        this.baseUrl = config.baseUrl.replace(/\/+$/, '')
        this.apiKey = config.apiKey
        this.projectId = config.projectId
        this.chatbotId = config.chatbotId
        this.fetcher = config.fetch ?? globalThis.fetch
        this.timeoutMs = config.timeoutMs ?? 15_000
    }

    async get(name: string): Promise<Recipe | null> {
        try {
            const r = await this.request<ApRecipe>('GET', `${this.recipeRoot()}/${encodeURIComponent(name)}`)
            return apToAgentmark(r)
        } catch (err) {
            if (err instanceof ActivepiecesRecipeError && err.status === 404) return null
            throw err
        }
    }

    async list(filter?: { target_app?: string }): Promise<Recipe[]> {
        const qs = filter?.target_app
            ? `?target_app=${encodeURIComponent(filter.target_app)}`
            : ''
        const results = await this.request<ApRecipe[]>('GET', `${this.recipeRoot()}${qs}`)
        return results.map(apToAgentmark)
    }

    async save(recipe: Recipe, options: { on_conflict?: 'replace' | 'fail' } = {}): Promise<Recipe> {
        const onConflict = options.on_conflict ?? 'fail'
        const body = {
            name: recipe.name,
            description: recipe.description,
            targetApp: recipe.target_app, // snake → camel for the wire
            parameters: recipe.parameters,
            steps: recipe.steps,
        }
        const saved = await this.request<ApRecipe>(
            'POST',
            `${this.recipeRoot()}?on_conflict=${onConflict}`,
            body,
        )
        return apToAgentmark(saved)
    }

    async delete(name: string): Promise<boolean> {
        try {
            const r = await this.request<{ deleted: boolean }>(
                'DELETE',
                `${this.recipeRoot()}/${encodeURIComponent(name)}`,
            )
            return r.deleted === true
        } catch (err) {
            if (err instanceof ActivepiecesRecipeError && err.status === 404) return false
            throw err
        }
    }

    async clear(): Promise<void> {
        // No bulk-delete endpoint exists; iterate.
        const recipes = await this.list()
        for (const r of recipes) await this.delete(r.name)
    }

    async describe(): Promise<RecipeBackendDescription> {
        const remote = await this.request<RecipeBackendDescription | undefined>(
            'GET',
            `${this.recipeRoot()}/describe`,
        ).catch((): undefined => undefined)
        return {
            kind: 'activepieces',
            base_url: this.baseUrl,
            project_id: this.projectId,
            chatbot_id: this.chatbotId,
            ...(remote ?? {}),
        }
    }

    private recipeRoot(): string {
        if (this.chatbotId) {
            return `/v1/projects/${encodeURIComponent(this.projectId)}/chatbots/${encodeURIComponent(this.chatbotId)}/recipes`
        }
        return `/v1/projects/${encodeURIComponent(this.projectId)}/recipes`
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
            throw new ActivepiecesRecipeError(
                `Activepieces recipe ${method} ${p} failed: ${response.status} ${response.statusText}`,
                response.status,
                parsed,
            )
        }
        return parsed as T
    }
}

function apToAgentmark(r: ApRecipe): Recipe {
    return {
        name: r.name,
        description: r.description ?? undefined,
        target_app: r.targetApp ?? undefined,
        parameters: r.parameters ?? [],
        steps: r.steps,
        version: r.version,
        created_at: r.created,
        updated_at: r.updated,
    }
}

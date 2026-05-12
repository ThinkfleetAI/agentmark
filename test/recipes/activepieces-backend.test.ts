/**
 * Tests for ActivepiecesRecipeBackend.
 * Mocks globalThis.fetch; no real network calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ActivepiecesRecipeBackend, ActivepiecesRecipeError } from '../../src/plugins/recipes'
import type { Recipe } from '../../src/plugins/recipes'

let originalFetch: typeof globalThis.fetch
let requests: Array<{ url: string; init?: RequestInit }>

beforeEach(() => {
    originalFetch = globalThis.fetch
    requests = []
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString()
        requests.push({ url, init })
        return Promise.resolve(responder(url, init))
    }) as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

/** Server-side wire shape (camelCase). */
function apRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'rec_default',
        platformId: 'plat_1',
        projectId: 'proj_1',
        chatbotId: null,
        name: 'fill-customer',
        description: 'Fill the customer form',
        targetApp: 'nowcerts',
        parameters: [{ name: 'company', type: 'string', required: true }],
        steps: [{ tool: 'agentmark_desktop_execute', args: { action_id: 'act_company' } }],
        version: 1,
        created: '2026-05-12T00:00:00Z',
        updated: '2026-05-12T00:00:00Z',
        ...overrides,
    }
}

const baseConfig = {
    baseUrl: 'https://app.example.com',
    apiKey: 'sk-test-1234',
    projectId: 'proj_1',
}

describe('ActivepiecesRecipeBackend — construction', () => {
    it('requires baseUrl + sk-prefixed apiKey + projectId', () => {
        expect(() => new ActivepiecesRecipeBackend({ ...baseConfig, baseUrl: '' })).toThrow(/baseUrl/)
        expect(() => new ActivepiecesRecipeBackend({ ...baseConfig, apiKey: '' })).toThrow(/apiKey/)
        expect(() => new ActivepiecesRecipeBackend({ ...baseConfig, apiKey: 'not-sk' })).toThrow(/sk-/)
        expect(() => new ActivepiecesRecipeBackend({ ...baseConfig, projectId: '' })).toThrow(/projectId/)
    })

    it('strips trailing slashes from baseUrl', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesRecipeBackend({ ...baseConfig, baseUrl: 'https://x.com///' })
        await backend.list()
        expect(requests[0].url.startsWith('https://x.com/v1/projects/')).toBe(true)
    })
})

describe('ActivepiecesRecipeBackend — auth + path routing', () => {
    it('attaches Authorization Bearer header on every request', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        await backend.list()
        const headers = requests[0].init?.headers as Record<string, string>
        expect(headers.authorization).toBe('Bearer sk-test-1234')
    })

    it('targets project-scoped routes when chatbotId omitted', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        await backend.list()
        expect(requests[0].url).toContain('/v1/projects/proj_1/recipes')
        expect(requests[0].url).not.toContain('/chatbots/')
    })

    it('targets chatbot-scoped routes when chatbotId supplied', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesRecipeBackend({ ...baseConfig, chatbotId: 'cb_42' })
        await backend.list()
        expect(requests[0].url).toContain('/v1/projects/proj_1/chatbots/cb_42/recipes')
    })
})

describe('ActivepiecesRecipeBackend — save', () => {
    it('POSTs to /recipes with on_conflict query + camelCase targetApp', async () => {
        mockFetch(() => jsonResponse(apRecipe()))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        const recipe: Recipe = {
            name: 'fill-customer',
            description: 'desc',
            target_app: 'nowcerts',
            parameters: [],
            steps: [{ tool: 'agentmark_desktop_execute', args: {} }],
            version: 0,
            created_at: '',
            updated_at: '',
        }
        await backend.save(recipe, { on_conflict: 'replace' })

        expect(requests[0].url).toBe('https://app.example.com/v1/projects/proj_1/recipes?on_conflict=replace')
        expect(requests[0].init?.method).toBe('POST')
        const body = JSON.parse(requests[0].init?.body as string)
        // snake_case → camelCase on the wire
        expect(body.targetApp).toBe('nowcerts')
        expect(body.target_app).toBeUndefined()
    })

    it('defaults on_conflict to "fail"', async () => {
        mockFetch(() => jsonResponse(apRecipe()))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        await backend.save({
            name: 'x', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '',
        })
        expect(requests[0].url).toContain('on_conflict=fail')
    })

    it('maps the response back to the agentmark Recipe shape (camelCase → snake_case)', async () => {
        mockFetch(() => jsonResponse(apRecipe({ targetApp: 'excel' })))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        const r = await backend.save({
            name: 'x', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '',
        })
        expect(r.target_app).toBe('excel') // came back as snake_case
    })
})

describe('ActivepiecesRecipeBackend — get + list + delete', () => {
    it('get returns the mapped recipe', async () => {
        mockFetch(() => jsonResponse(apRecipe()))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        const r = await backend.get('fill-customer')
        expect(r?.name).toBe('fill-customer')
        expect(r?.target_app).toBe('nowcerts')
        expect(requests[0].url).toContain('/recipes/fill-customer')
    })

    it('get returns null on 404 instead of throwing', async () => {
        mockFetch(() => jsonResponse({ error: 'not_found' }, 404))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        const r = await backend.get('missing')
        expect(r).toBeNull()
    })

    it('list with target_app builds the query string', async () => {
        mockFetch(() => jsonResponse([apRecipe()]))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        await backend.list({ target_app: 'excel' })
        expect(requests[0].url).toContain('target_app=excel')
    })

    it('delete returns true on success', async () => {
        mockFetch(() => jsonResponse({ deleted: true }))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        const ok = await backend.delete('to-go')
        expect(ok).toBe(true)
        expect(requests[0].init?.method).toBe('DELETE')
    })

    it('delete returns false on 404 (not an error)', async () => {
        mockFetch(() => jsonResponse({ error: 'not_found' }, 404))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        expect(await backend.delete('missing')).toBe(false)
    })
})

describe('ActivepiecesRecipeBackend — errors + describe', () => {
    it('throws ActivepiecesRecipeError on non-2xx with status + body', async () => {
        mockFetch(() => jsonResponse({ error: 'forbidden' }, 403))
        const backend = new ActivepiecesRecipeBackend(baseConfig)
        try {
            await backend.list()
            throw new Error('should not reach')
        } catch (err) {
            expect(err).toBeInstanceOf(ActivepiecesRecipeError)
            expect((err as ActivepiecesRecipeError).status).toBe(403)
        }
    })

    it('describe reports kind=activepieces + project + chatbot', async () => {
        mockFetch(() => new Response('', { status: 404 }))
        const backend = new ActivepiecesRecipeBackend({ ...baseConfig, chatbotId: 'cb_x' })
        const desc = await backend.describe()
        expect(desc.kind).toBe('activepieces')
        expect(desc.project_id).toBe('proj_1')
        expect(desc.chatbot_id).toBe('cb_x')
    })
})

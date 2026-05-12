/**
 * Tests for RemoteRecipeBackend — HTTP shape + 404 handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RemoteRecipeBackend, RemoteRecipeError } from '../../src/plugins/recipes'
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

const SAMPLE: Recipe = {
    name: 'test-recipe',
    steps: [{ tool: 'agentmark_desktop_execute', args: {} }],
    version: 1,
    created_at: '',
    updated_at: '',
}

describe('RemoteRecipeBackend — verb mapping', () => {
    it('save → POST /v1/recipes with on_conflict query param', async () => {
        mockFetch(() => jsonResponse(SAMPLE))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        await backend.save(SAMPLE, { on_conflict: 'replace' })
        expect(requests[0].url).toBe('https://r.example.com/v1/recipes?on_conflict=replace')
        expect(requests[0].init?.method).toBe('POST')
    })

    it('save without on_conflict defaults to "fail"', async () => {
        mockFetch(() => jsonResponse(SAMPLE))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        await backend.save(SAMPLE)
        expect(requests[0].url).toBe('https://r.example.com/v1/recipes?on_conflict=fail')
    })

    it('get → GET /v1/recipes/:name', async () => {
        mockFetch(() => jsonResponse(SAMPLE))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        const r = await backend.get('test-recipe')
        expect(r?.name).toBe('test-recipe')
        expect(requests[0].url).toBe('https://r.example.com/v1/recipes/test-recipe')
        expect(requests[0].init?.method).toBe('GET')
    })

    it('list with target_app builds the query string', async () => {
        mockFetch(() => jsonResponse([SAMPLE]))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        await backend.list({ target_app: 'excel' })
        expect(requests[0].url).toBe('https://r.example.com/v1/recipes?target_app=excel')
    })

    it('delete → DELETE /v1/recipes/:name', async () => {
        mockFetch(() => jsonResponse({ deleted: true }))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        const ok = await backend.delete('to-go')
        expect(ok).toBe(true)
        expect(requests[0].init?.method).toBe('DELETE')
    })
})

describe('RemoteRecipeBackend — 404 handling', () => {
    it('get returns null on 404 (instead of throwing)', async () => {
        mockFetch(() => jsonResponse({ error: 'not_found' }, 404))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        const r = await backend.get('missing')
        expect(r).toBeNull()
    })

    it('delete returns false on 404 (instead of throwing)', async () => {
        mockFetch(() => jsonResponse({ error: 'not_found' }, 404))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        const ok = await backend.delete('missing')
        expect(ok).toBe(false)
    })

    it('other 4xx/5xx throw RemoteRecipeError', async () => {
        mockFetch(() => jsonResponse({ error: 'server_error' }, 500))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' })
        try {
            await backend.get('boom')
            throw new Error('should not reach')
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteRecipeError)
            expect((err as RemoteRecipeError).status).toBe(500)
        }
    })
})

describe('RemoteRecipeBackend — describe', () => {
    it('returns kind=remote-http with base_url + workspace_id', async () => {
        mockFetch(() => new Response('', { status: 404 }))
        const backend = new RemoteRecipeBackend({ baseUrl: 'https://r.example.com', workspaceId: 'ws_1' })
        const desc = await backend.describe()
        expect(desc.kind).toBe('remote-http')
        expect(desc.base_url).toBe('https://r.example.com')
        expect(desc.workspace_id).toBe('ws_1')
    })
})

describe('Backend injection — plugin acceptance', () => {
    it('createRecipesPlugin accepts a custom backend', async () => {
        const { createRecipesPlugin } = await import('../../src/plugins/recipes')
        const plugin = createRecipesPlugin({
            backend: new RemoteRecipeBackend({ baseUrl: 'https://r.example.com' }),
        })
        expect(plugin.name).toBe('recipes')
        // describeSessions reports "custom" when a non-LocalFile backend is used.
        const info = plugin.describeSessions?.()
        expect((info as { recipes: { kind: string } }).recipes.kind).toBe('custom')
    })
})

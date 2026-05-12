/**
 * Tests for RemoteMemoryBackend — HTTP shape + auth + error handling.
 * fetch is mocked; no real network calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteMemoryBackend, RemoteMemoryError } from '../../src/plugins/memory'

let originalFetch: typeof globalThis.fetch
let requests: Array<{ url: string; init?: RequestInit }>

beforeEach(() => {
    originalFetch = globalThis.fetch
    requests = []
})

afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
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

describe('RemoteMemoryBackend — request shape', () => {
    it('attaches Bearer token + X-Workspace-Id when configured', async () => {
        mockFetch(() => jsonResponse({ record_id: 'mem_x', key: 'k', value: 'v', scope: { type: 'platform' }, version: 1, created_at: '', updated_at: '', access_count: 0 }))

        const backend = new RemoteMemoryBackend({
            baseUrl: 'https://memory.example.com',
            token: 'secret',
            workspaceId: 'ws_123',
        })
        await backend.set({ key: 'k', value: 'v' })

        expect(requests).toHaveLength(1)
        const headers = requests[0].init?.headers as Record<string, string>
        expect(headers.authorization).toBe('Bearer secret')
        expect(headers['x-workspace-id']).toBe('ws_123')
        expect(headers['content-type']).toBe('application/json')
    })

    it('strips trailing slashes from baseUrl', async () => {
        mockFetch(() => jsonResponse(null))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://memory.example.com///' })
        await backend.get({ key: 'k' })
        expect(requests[0].url).toBe('https://memory.example.com/v1/memory/records/get')
    })

    it('throws if baseUrl is missing', () => {
        expect(() => new RemoteMemoryBackend({ baseUrl: '' })).toThrow(/baseUrl is required/)
    })
})

describe('RemoteMemoryBackend — verb mapping', () => {
    it('set → POST /v1/memory/records', async () => {
        mockFetch(() => jsonResponse({ record_id: 'r', key: 'k', value: 'v', scope: { type: 'platform' }, created_at: '', updated_at: '', access_count: 0 }))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        await backend.set({ key: 'k', value: 'v', tags: ['t'], ttlSeconds: 60 })

        expect(requests[0].url).toBe('https://x.com/v1/memory/records')
        expect(requests[0].init?.method).toBe('POST')
        const body = JSON.parse(requests[0].init?.body as string)
        expect(body).toEqual({
            key: 'k',
            value: 'v',
            scope: { type: 'platform' },
            tags: ['t'],
            ttl_seconds: 60,
        })
    })

    it('get → POST /v1/memory/records/get', async () => {
        mockFetch(() => jsonResponse(null))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        const result = await backend.get({ key: 'k' })
        expect(result).toBeNull()
        expect(requests[0].url).toBe('https://x.com/v1/memory/records/get')
        expect(requests[0].init?.method).toBe('POST')
    })

    it('deleteById → DELETE /v1/memory/records/:id', async () => {
        mockFetch(() => jsonResponse({ deleted: true }))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        const ok = await backend.deleteById('mem_abc')
        expect(ok).toBe(true)
        expect(requests[0].url).toBe('https://x.com/v1/memory/records/mem_abc')
        expect(requests[0].init?.method).toBe('DELETE')
    })

    it('list builds the correct query string', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        await backend.list({ type: 'project', id: '/repo' }, 'build_', 25)
        expect(requests[0].url).toBe('https://x.com/v1/memory/records?scope_type=project&scope_id=%2Frepo&prefix=build_&limit=25')
        expect(requests[0].init?.method).toBe('GET')
    })

    it('search → POST /v1/memory/search', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        await backend.search({ query: 'foo', tags: ['build'] })
        expect(requests[0].url).toBe('https://x.com/v1/memory/search')
        expect(JSON.parse(requests[0].init?.body as string)).toEqual({ query: 'foo', tags: ['build'] })
    })
})

describe('RemoteMemoryBackend — error handling', () => {
    it('throws RemoteMemoryError with status + body on non-2xx', async () => {
        mockFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com', token: 'bad' })
        try {
            await backend.set({ key: 'k', value: 'v' })
            throw new Error('should not reach')
        } catch (err) {
            expect(err).toBeInstanceOf(RemoteMemoryError)
            expect((err as RemoteMemoryError).status).toBe(401)
            expect((err as RemoteMemoryError).body).toEqual({ error: 'unauthorized' })
        }
    })

    it('describe() returns "remote-http" kind even when the service has no /describe endpoint', async () => {
        mockFetch(() => new Response('', { status: 404 }))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com', workspaceId: 'ws_1' })
        const desc = await backend.describe()
        expect(desc.kind).toBe('remote-http')
        expect(desc.base_url).toBe('https://x.com')
        expect(desc.workspace_id).toBe('ws_1')
    })

    it('describe() merges remote server-supplied fields when available', async () => {
        mockFetch(() => jsonResponse({ total_records: 42, region: 'us-east-1' }))
        const backend = new RemoteMemoryBackend({ baseUrl: 'https://x.com' })
        const desc = await backend.describe()
        expect(desc.kind).toBe('remote-http')
        expect(desc.total_records).toBe(42)
        expect(desc.region).toBe('us-east-1')
    })
})

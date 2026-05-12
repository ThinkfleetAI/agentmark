/**
 * Tests for ActivepiecesMemoryBackend.
 *
 * Mocks globalThis.fetch to assert the request shape we send to the
 * Activepieces API + that responses are correctly mapped back to the
 * agentmark MemoryRecord shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ActivepiecesMemoryBackend, ActivepiecesMemoryError } from '../../src/plugins/memory'

let originalFetch: typeof globalThis.fetch
let requests: Array<{ url: string; init?: RequestInit }>

beforeEach(() => {
    originalFetch = globalThis.fetch
    requests = []
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

function mockFetch(responder: Handler) {
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

// Reusable fixture: minimal Activepieces memory-item shape that
// `apToAgentmark` understands. Includes the `agentmark_key` metadata
// so round-trips look natural.
function apItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'mem_default',
        platformId: 'plat_1',
        projectId: 'proj_1',
        chatbotId: null,
        type: 'fact',
        content: 'pnpm build',
        category: null,
        importance: 5,
        source: 'agentmark',
        sessionKey: null,
        chatIdentityId: null,
        metadata: {
            agentmark_key: 'build_command',
            raw_value: 'pnpm build',
            scope_id: 'proj_1',
        },
        scope: 'project',
        status: 'confirmed',
        confidence: 1.0,
        impact: null,
        confirmedAt: null,
        validAt: '2026-05-12T00:00:00Z',
        invalidAt: null,
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

describe('ActivepiecesMemoryBackend — construction', () => {
    it('requires baseUrl, apiKey starting with sk-, and projectId', () => {
        expect(() => new ActivepiecesMemoryBackend({ ...baseConfig, baseUrl: '' })).toThrow(/baseUrl/)
        expect(() => new ActivepiecesMemoryBackend({ ...baseConfig, apiKey: '' })).toThrow(/apiKey/)
        expect(() => new ActivepiecesMemoryBackend({ ...baseConfig, apiKey: 'not-sk-key' })).toThrow(/sk-/)
        expect(() => new ActivepiecesMemoryBackend({ ...baseConfig, projectId: '' })).toThrow(/projectId/)
    })

    it('strips trailing slashes from baseUrl', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend({ ...baseConfig, baseUrl: 'https://x.com///' })
        await backend.list({ type: 'platform' })
        expect(requests[0].url.startsWith('https://x.com/v1/projects/')).toBe(true)
    })
})

describe('ActivepiecesMemoryBackend — auth + path shape', () => {
    it('attaches Authorization Bearer header on every request', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        await backend.list()
        const headers = requests[0].init?.headers as Record<string, string>
        expect(headers.authorization).toBe('Bearer sk-test-1234')
    })

    it('targets project-scoped routes when chatbotId is omitted', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        await backend.list()
        expect(requests[0].url).toContain('/v1/projects/proj_1/memory')
        expect(requests[0].url).not.toContain('/chatbots/')
    })

    it('targets chatbot-scoped routes when chatbotId is supplied', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend({ ...baseConfig, chatbotId: 'cb_42' })
        await backend.list()
        expect(requests[0].url).toContain('/v1/projects/proj_1/chatbots/cb_42/memory')
    })
})

describe('ActivepiecesMemoryBackend — set', () => {
    it('first looks for an existing record with the same key+scope, then POSTs a new one', async () => {
        mockFetch((url, init) => {
            if (init?.method === 'GET') {
                // findByKey: returns one existing record we should delete.
                return jsonResponse([apItem({ id: 'mem_existing' })])
            }
            if (init?.method === 'DELETE') {
                return jsonResponse({})
            }
            // POST create.
            return jsonResponse(apItem({
                id: 'mem_new',
                content: 'pnpm test',
                metadata: { agentmark_key: 'build_command', raw_value: 'pnpm test', scope_id: 'proj_1' },
            }))
        })

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const record = await backend.set({
            key: 'build_command',
            value: 'pnpm test',
            scope: { type: 'project', id: 'proj_1' },
        })

        // Sequence: GET (find existing) → DELETE (existing) → POST (create new).
        expect(requests.map((r) => r.init?.method)).toEqual(['GET', 'DELETE', 'POST'])
        const postBody = JSON.parse(requests[2].init?.body as string)
        expect(postBody.type).toBe('fact')
        expect(postBody.scope).toBe('project')
        expect(postBody.source).toBe('agentmark')
        expect(postBody.metadata.agentmark_key).toBe('build_command')
        expect(postBody.metadata.raw_value).toBe('pnpm test')
        expect(postBody.metadata.scope_id).toBe('proj_1')
        expect(record.record_id).toBe('mem_new')
        expect(record.value).toBe('pnpm test')
    })

    it('JSON-stringifies non-string values into Activepieces `content` while preserving the raw value in metadata', async () => {
        const captured: Array<{ body: unknown }> = []
        mockFetch((_url, init) => {
            if (init?.method === 'GET') return jsonResponse([])
            if (init?.method === 'POST') {
                captured.push({ body: JSON.parse(init.body as string) })
                return jsonResponse(apItem({ content: '{"x":1}' }))
            }
            return jsonResponse({})
        })

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        await backend.set({ key: 'cfg', value: { x: 1 } })

        const sent = captured[0]?.body as { content: string; metadata: Record<string, unknown> }
        expect(sent.content).toBe('{"x":1}')
        expect(sent.metadata.raw_value).toEqual({ x: 1 })
    })
})

describe('ActivepiecesMemoryBackend — get + deleteByKey', () => {
    it('walks the supplied scope list and returns the first match', async () => {
        // Two scopes will be queried in order: project then platform.
        // Make project return nothing, platform return one match.
        let call = 0
        mockFetch(() => {
            call += 1
            if (call === 1) return jsonResponse([]) // project scope: miss
            return jsonResponse([apItem({ id: 'mem_platform' })]) // platform scope: hit
        })

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const record = await backend.get({
            key: 'build_command',
            scopes: [{ type: 'project', id: 'proj_1' }, { type: 'platform' }],
        })
        expect(record?.record_id).toBe('mem_platform')
    })

    it('returns null when no scope has the key', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const record = await backend.get({ key: 'missing', scopes: [{ type: 'platform' }] })
        expect(record).toBeNull()
    })

    it('disambiguates by scope_id when scope.id is supplied', async () => {
        // Two records in the same scope; only the one with matching scope_id should win.
        mockFetch(() => jsonResponse([
            apItem({ id: 'mem_other_repo', metadata: { agentmark_key: 'build_command', scope_id: '/repo/b' } }),
            apItem({ id: 'mem_my_repo', metadata: { agentmark_key: 'build_command', scope_id: '/repo/a' } }),
        ]))

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const record = await backend.get({
            key: 'build_command',
            scopes: [{ type: 'project', id: '/repo/a' }],
        })
        expect(record?.record_id).toBe('mem_my_repo')
    })

    it('deleteByKey looks up + deletes', async () => {
        mockFetch((_url, init) => {
            if (init?.method === 'GET') return jsonResponse([apItem({ id: 'mem_to_delete' })])
            return jsonResponse({}) // DELETE
        })

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const ok = await backend.deleteByKey('build_command', { type: 'platform' })
        expect(ok).toBe(true)
        expect(requests[1].init?.method).toBe('DELETE')
        expect(requests[1].url).toContain('/memory/mem_to_delete')
    })

    it('deleteByKey returns false when no matching record exists', async () => {
        mockFetch(() => jsonResponse([]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        expect(await backend.deleteByKey('missing', { type: 'platform' })).toBe(false)
    })
})

describe('ActivepiecesMemoryBackend — search', () => {
    it('routes text queries to /memory/search and respects scope filter', async () => {
        let captured: { body: unknown } | null = null
        mockFetch((_url, init) => {
            captured = { body: JSON.parse(init?.body as string) }
            return jsonResponse([apItem({ id: 'mem_hit', similarity: 0.91 })])
        })

        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const results = await backend.search({
            query: 'how do I build',
            scope: { type: 'project' },
            limit: 25,
        })
        expect(requests[0].url).toContain('/memory/search')
        const body = captured?.body as { query: string; scope: string; limit: number }
        expect(body).toEqual({ query: 'how do I build', scope: 'project', limit: 25 })
        expect(results[0].record_id).toBe('mem_hit')
    })

    it('falls back to listing when no query is supplied', async () => {
        mockFetch(() => jsonResponse([apItem()]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        await backend.search({ scope: { type: 'platform' }, limit: 10 })
        expect(requests[0].init?.method).toBe('GET')
        expect(requests[0].url).toContain('/memory?')
        expect(requests[0].url).toContain('scope=platform')
    })

    it('filters search results client-side by tags when supplied', async () => {
        mockFetch(() => jsonResponse([
            apItem({ id: 'mem_with_tag', metadata: { agentmark_key: 'k1', tags: ['build', 'fast'] } }),
            apItem({ id: 'mem_without_tag', metadata: { agentmark_key: 'k2' } }),
        ]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const results = await backend.search({ query: 'anything', tags: ['build'] })
        expect(results).toHaveLength(1)
        expect(results[0].record_id).toBe('mem_with_tag')
    })
})

describe('ActivepiecesMemoryBackend — list', () => {
    it('passes scope, source, and limit as query params; caps limit at 100', async () => {
        mockFetch(() => jsonResponse([apItem()]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        await backend.list({ type: 'project', id: '/repo' }, undefined, 999)
        const url = requests[0].url
        expect(url).toContain('scope=project')
        expect(url).toContain('source=agentmark')
        expect(url).toContain('limit=100') // capped from 999
    })

    it('filters by prefix client-side', async () => {
        mockFetch(() => jsonResponse([
            apItem({ id: 'a', metadata: { agentmark_key: 'build_a' } }),
            apItem({ id: 'b', metadata: { agentmark_key: 'test_b' } }),
            apItem({ id: 'c', metadata: { agentmark_key: 'build_c' } }),
        ]))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        const results = await backend.list(undefined, 'build_')
        expect(results.map((r) => r.key).sort()).toEqual(['build_a', 'build_c'])
    })
})

describe('ActivepiecesMemoryBackend — error handling', () => {
    it('throws ActivepiecesMemoryError on non-2xx responses with status + body', async () => {
        mockFetch(() => jsonResponse({ error: 'forbidden', detail: 'wrong project' }, 403))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        try {
            await backend.list()
            throw new Error('should not reach')
        } catch (err) {
            expect(err).toBeInstanceOf(ActivepiecesMemoryError)
            expect((err as ActivepiecesMemoryError).status).toBe(403)
            expect((err as ActivepiecesMemoryError).body).toEqual({ error: 'forbidden', detail: 'wrong project' })
        }
    })

    it('deleteById returns false on 404 instead of throwing', async () => {
        mockFetch(() => jsonResponse({ error: 'not_found' }, 404))
        const backend = new ActivepiecesMemoryBackend(baseConfig)
        expect(await backend.deleteById('mem_missing')).toBe(false)
    })
})

describe('ActivepiecesMemoryBackend — describe', () => {
    it('reports kind, project_id, chatbot_id, source', async () => {
        const backend = new ActivepiecesMemoryBackend({ ...baseConfig, chatbotId: 'cb_x' })
        const desc = await backend.describe()
        expect(desc).toEqual({
            kind: 'activepieces',
            base_url: 'https://app.example.com',
            project_id: 'proj_1',
            chatbot_id: 'cb_x',
            source: 'agentmark',
        })
    })
})

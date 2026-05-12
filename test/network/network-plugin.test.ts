/**
 * Tests for the Network Pack.
 *
 * Allowlist matching + HTTP request shaping is covered with mocked
 * global fetch. WebSocket coverage is deliberately scoped to the
 * disallow path — exercising the full WS lifecycle in unit tests
 * needs a real server, which we'll add in an integration suite later.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
    createNetworkPlugin,
    UrlAllowlist,
    NETWORK_TOOLS,
} from '../../src/plugins/network'
import { Dispatcher } from '../../src/mcp/plugin'

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
    originalFetch = globalThis.fetch
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString()
        return Promise.resolve(handler(url, init))
    }) as typeof globalThis.fetch
}

describe('UrlAllowlist', () => {
    it('denies everything when empty', () => {
        const list = new UrlAllowlist([])
        expect(list.allows('https://api.example.com/foo')).toBe(false)
        expect(() => list.assertAllowed('https://api.example.com/foo')).toThrow(/allowlist is empty/)
    })

    it('matches single-star glob in path', () => {
        const list = new UrlAllowlist(['https://api.example.com/*'])
        expect(list.allows('https://api.example.com/users')).toBe(true)
        expect(list.allows('https://api.example.com/users/1')).toBe(false) // single * doesn't cross /
        expect(list.allows('https://other.example.com/users')).toBe(false)
    })

    it('matches double-star glob for any-path', () => {
        const list = new UrlAllowlist(['https://api.example.com/**'])
        expect(list.allows('https://api.example.com/')).toBe(true)
        expect(list.allows('https://api.example.com/users/1/posts')).toBe(true)
    })

    it('matches wildcard subdomain', () => {
        const list = new UrlAllowlist(['https://*.example.com/**'])
        expect(list.allows('https://api.example.com/foo')).toBe(true)
        expect(list.allows('https://other.example.com/bar')).toBe(true)
        expect(list.allows('https://example.com/bar')).toBe(false) // wildcard requires a subdomain
    })

    it('produces a helpful error listing the configured patterns', () => {
        const list = new UrlAllowlist(['https://api.x.com/**'])
        try {
            list.assertAllowed('https://evil.com/exfil')
        } catch (err) {
            expect((err as Error).message).toContain('not in allowlist')
            expect((err as Error).message).toContain('"https://api.x.com/**"')
        }
    })
})

describe('Network plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(NETWORK_TOOLS.map((t) => t.name).sort())
    })

    it('describeSessions reports the configured allowlist', () => {
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const info = plugin.describeSessions?.()
        expect(info).toEqual({
            network: {
                url_allowlist: ['https://api.example.com/**'],
                websockets: [],
            },
        })
    })
})

describe('agentmark_http_request — happy paths', () => {
    it('makes a GET, returns the body as text by default', async () => {
        mockFetch(() => new Response('hello world', { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } }))
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/greet',
        })
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(body.status).toBe(200)
        expect(body.body).toBe('hello world')
        expect(body.headers['content-type']).toBe('text/plain')
    })

    it('encodes a JSON object body and sets content-type', async () => {
        let captured: { url: string; init?: RequestInit } | null = null
        mockFetch((url, init) => {
            captured = { url, init }
            return new Response('{}', { status: 201 })
        })
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/users',
            method: 'POST',
            body: { name: 'Ryan', role: 'admin' },
            response_format: 'json',
        })
        expect(captured?.init?.method).toBe('POST')
        const headers = captured?.init?.headers as Record<string, string>
        expect(headers['content-type']).toBe('application/json')
        expect(captured?.init?.body).toBe('{"name":"Ryan","role":"admin"}')
    })

    it('returns parsed JSON when response_format=json', async () => {
        mockFetch(() => new Response(JSON.stringify({ ok: true, n: 7 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/stat',
            response_format: 'json',
        })
        const body = JSON.parse(result.text)
        expect(body.body).toEqual({ ok: true, n: 7 })
    })

    it('returns base64 when response_format=base64 (binary content)', async () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header
        mockFetch(() => new Response(bytes, { status: 200 }))
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/logo.png',
            response_format: 'base64',
        })
        const body = JSON.parse(result.text)
        expect(body.body).toBe(Buffer.from(bytes).toString('base64'))
    })
})

describe('agentmark_http_request — boundary enforcement', () => {
    it('refuses requests when allowlist is empty', async () => {
        const plugin = createNetworkPlugin({})
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/anything',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/allowlist is empty/)
    })

    it('refuses URLs outside the allowlist', async () => {
        mockFetch(() => { throw new Error('fetch should not have been called') })
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://evil.example.org/exfil',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/not in allowlist/)
    })

    it('parses error response when response_format=json but body is not JSON', async () => {
        mockFetch(() => new Response('<html>not json</html>', { status: 200 }))
        const plugin = createNetworkPlugin({ urlAllowlist: ['https://api.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_http_request', {
            url: 'https://api.example.com/bad',
            response_format: 'json',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/not valid JSON/)
    })
})

describe('agentmark_websocket_* — allowlist boundary', () => {
    it('refuses websocket_connect for URLs outside the allowlist', async () => {
        const plugin = createNetworkPlugin({ urlAllowlist: ['wss://realtime.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        const result = await dispatcher.dispatch('agentmark_websocket_connect', {
            url: 'wss://evil.example.org/socket',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/not in allowlist/)
    })

    it('refuses websocket_connect when allowlist is empty', async () => {
        const plugin = createNetworkPlugin({})
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_websocket_connect', {
            url: 'wss://realtime.example.com/socket',
        })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/allowlist is empty/)
    })

    it('rejects send/receive/close calls for unknown ws_id', async () => {
        const plugin = createNetworkPlugin({ urlAllowlist: ['wss://realtime.example.com/**'] })
        const dispatcher = new Dispatcher([plugin])

        for (const tool of ['agentmark_websocket_send', 'agentmark_websocket_close']) {
            const r = await dispatcher.dispatch(tool, { ws_id: 'ws_missing', data: 'x' })
            expect(r.isError).toBe(true)
            expect(r.text).toContain('Unknown ws_id')
        }
        const r = await dispatcher.dispatch('agentmark_websocket_receive', { ws_id: 'ws_missing' })
        expect(r.isError).toBe(true)
    })
})

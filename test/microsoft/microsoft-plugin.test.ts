/**
 * Tests for the Microsoft Workflows Pack (Graph-only v0).
 *
 * We mock `globalThis.fetch` so the tests run offline and deterministically.
 * The auth flow is exercised end-to-end (device code → poll → token cache
 * → refresh) against the mocked endpoints.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import {
    createMicrosoftPlugin,
    MicrosoftAuth,
    MICROSOFT_TOOLS,
    NotAuthenticatedError,
} from '../../src/plugins/microsoft'
import { Dispatcher } from '../../src/mcp/plugin'

let originalFetch: typeof globalThis.fetch
let tmpDir: string
let cachePath: string

beforeEach(async () => {
    originalFetch = globalThis.fetch
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentmark-ms-test-'))
    cachePath = path.join(tmpDir, 'tokens.json')
})

afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
})

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString()
        return Promise.resolve(responder(url, init))
    }) as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

describe('MicrosoftAuth — device code flow', () => {
    it('starts a device-code session and surfaces the user instructions', async () => {
        mockFetch((url) => {
            if (url.includes('devicecode')) {
                return jsonResponse({
                    user_code: 'ABC-123',
                    device_code: 'dc_token',
                    verification_uri: 'https://microsoft.com/devicelogin',
                    expires_in: 900,
                    interval: 5,
                    message: 'To sign in, use a web browser to open the page.',
                })
            }
            throw new Error(`Unexpected URL: ${url}`)
        })

        const auth = new MicrosoftAuth({ clientId: 'test-client', cachePath })
        const start = await auth.startDeviceCode()
        expect(start.user_code).toBe('ABC-123')
        expect(start.verification_uri).toBe('https://microsoft.com/devicelogin')
    })

    it('refuses to start without a client id', async () => {
        const auth = new MicrosoftAuth({ clientId: '', cachePath })
        await expect(auth.startDeviceCode()).rejects.toThrow(/client ID is not set/i)
    })

    it('polls the token endpoint and caches tokens on completion', async () => {
        let poll = 0
        mockFetch((url) => {
            if (url.includes('/oauth2/v2.0/token')) {
                poll += 1
                if (poll < 2) {
                    return jsonResponse({ error: 'authorization_pending' }, 400)
                }
                return jsonResponse({
                    access_token: 'access-1',
                    refresh_token: 'refresh-1',
                    expires_in: 3600,
                    scope: 'Mail.Send Files.ReadWrite',
                })
            }
            throw new Error(`Unexpected URL: ${url}`)
        })

        const auth = new MicrosoftAuth({ clientId: 'test', cachePath })
        const tokens = await auth.completeDeviceCode({
            user_code: 'X',
            device_code: 'dc',
            verification_uri: 'https://x',
            expires_in: 60,
            // Use a short interval so the test runs quickly.
            interval: 0,
            message: '',
        })
        expect(tokens.access_token).toBe('access-1')
        expect(tokens.refresh_token).toBe('refresh-1')

        const saved = JSON.parse(await readFile(cachePath, 'utf8'))
        expect(saved.access_token).toBe('access-1')
    })

    it('returns a cached access token when non-expired', async () => {
        await writeFile(
            cachePath,
            JSON.stringify({
                access_token: 'cached-access',
                refresh_token: 'cached-refresh',
                expires_at: Date.now() + 5 * 60_000,
                scope: 'Mail.Send',
            }),
        )
        const auth = new MicrosoftAuth({ clientId: 'test', cachePath })
        const token = await auth.getAccessToken()
        expect(token).toBe('cached-access')
    })

    it('refreshes when the cached token is expired', async () => {
        await writeFile(
            cachePath,
            JSON.stringify({
                access_token: 'old-access',
                refresh_token: 'refresh-token',
                expires_at: Date.now() - 1000,
                scope: 'Mail.Send',
            }),
        )
        mockFetch((url, init) => {
            if (url.includes('/oauth2/v2.0/token')) {
                const body = (init?.body as URLSearchParams).toString()
                expect(body).toContain('grant_type=refresh_token')
                expect(body).toContain('refresh_token=refresh-token')
                return jsonResponse({
                    access_token: 'fresh-access',
                    refresh_token: 'rotated-refresh',
                    expires_in: 3600,
                    scope: 'Mail.Send',
                })
            }
            throw new Error(`Unexpected URL: ${url}`)
        })
        const auth = new MicrosoftAuth({ clientId: 'test', cachePath })
        const token = await auth.getAccessToken()
        expect(token).toBe('fresh-access')
    })

    it('throws NotAuthenticatedError when no tokens are cached', async () => {
        const auth = new MicrosoftAuth({ clientId: 'test', cachePath })
        await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NotAuthenticatedError)
    })
})

describe('Microsoft plugin — registration', () => {
    it('registers every tool from MICROSOFT_TOOLS with a matching handler', () => {
        const plugin = createMicrosoftPlugin({ clientId: 'test', cachePath })
        // Dispatcher construction validates the handler-vs-tools contract;
        // if any tool is missing a handler this throws.
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames).toEqual(MICROSOFT_TOOLS.map((t) => t.name))
    })

    it('exposes the expected v0 tool names', () => {
        const names = MICROSOFT_TOOLS.map((t) => t.name).sort()
        expect(names).toEqual([
            'agentmark_microsoft_login',
            'agentmark_microsoft_logout',
            'agentmark_microsoft_whoami',
            'agentmark_onedrive_download',
            'agentmark_onedrive_list',
            'agentmark_onedrive_upload',
            'agentmark_outlook_get_message',
            'agentmark_outlook_reply',
            'agentmark_outlook_search',
            'agentmark_outlook_send_email',
        ])
    })

    it('describeSessions reports the configured scopes + client id state', () => {
        const plugin = createMicrosoftPlugin({ clientId: 'test', cachePath, scopes: ['Mail.Send'] })
        const info = plugin.describeSessions?.()
        expect(info).toEqual({
            microsoft: { client_id_set: true, scopes: ['Mail.Send'] },
        })
    })
})

describe('Microsoft plugin — Outlook handlers (via Graph mock)', () => {
    async function loginFirst(): Promise<void> {
        await writeFile(
            cachePath,
            JSON.stringify({
                access_token: 'fake-access',
                refresh_token: 'fake-refresh',
                expires_at: Date.now() + 60 * 60_000,
                scope: 'Mail.Send',
            }),
        )
    }

    it('agentmark_outlook_send_email posts to /me/sendMail with the expected envelope', async () => {
        await loginFirst()
        let captured: { url: string; body: unknown } | null = null
        mockFetch((url, init) => {
            captured = { url, body: JSON.parse(init!.body as string) }
            return new Response(null, { status: 202 })
        })

        const plugin = createMicrosoftPlugin({ clientId: 'test', cachePath })
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_outlook_send_email', {
            to: ['user@example.com'],
            subject: 'Test',
            body: '<p>hi</p>',
        })
        expect(result.isError).toBeFalsy()
        expect(captured).not.toBeNull()
        expect(captured!.url).toMatch(/\/me\/sendMail$/)
        const envelope = captured!.body as { message: { subject: string; toRecipients: unknown[] } }
        expect(envelope.message.subject).toBe('Test')
        expect(envelope.message.toRecipients).toEqual([
            { emailAddress: { address: 'user@example.com' } },
        ])
    })

    it('agentmark_outlook_search returns a flattened message list', async () => {
        await loginFirst()
        mockFetch((url) => {
            expect(url).toMatch(/\/me\/mailFolders\/inbox\/messages/)
            expect(url).toContain('%24search')
            return jsonResponse({
                value: [
                    {
                        id: 'msg1',
                        subject: 'Hello',
                        from: { emailAddress: { address: 'alice@x.com', name: 'Alice' } },
                        receivedDateTime: '2026-05-10T00:00:00Z',
                        hasAttachments: false,
                        bodyPreview: 'preview',
                    },
                ],
            })
        })

        const plugin = createMicrosoftPlugin({ clientId: 'test', cachePath })
        const dispatcher = new Dispatcher([plugin])
        const result = await dispatcher.dispatch('agentmark_outlook_search', { query: 'invoice' })
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(body.count).toBe(1)
        expect(body.messages[0]).toMatchObject({
            id: 'msg1',
            subject: 'Hello',
            from: 'alice@x.com',
            preview: 'preview',
        })
    })

    it('agentmark_outlook_reply hits /reply by default, /replyAll when asked', async () => {
        await loginFirst()
        const hits: string[] = []
        mockFetch((url) => {
            hits.push(url)
            return new Response(null, { status: 202 })
        })

        const plugin = createMicrosoftPlugin({ clientId: 'test', cachePath })
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_outlook_reply', { message_id: 'abc', body: 'ack' })
        await dispatcher.dispatch('agentmark_outlook_reply', { message_id: 'abc', body: 'ack', reply_all: true })

        expect(hits[0]).toMatch(/\/me\/messages\/abc\/reply$/)
        expect(hits[1]).toMatch(/\/me\/messages\/abc\/replyAll$/)
    })
})

/**
 * Integration tests for the Browser/Page SDK surface.
 *
 * These tests launch a real Chromium instance via playwright-core and run
 * against a local HTTP server that serves deterministic test fixtures.
 * Local-server tests (rather than real public sites) keep CI fast and
 * stable — public sites change underneath us.
 *
 * Gated by `AGENTMARK_INTEGRATION=1` because not every dev machine has
 * browser binaries installed (`npx playwright install chromium`).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBrowser, type Browser } from '../src/runtime/browser'
import { ActionDisabledError, ActionNotFoundError, ExecutionError } from '../src/errors'

const RUN = process.env.AGENTMARK_INTEGRATION === '1'

const PAGES: Record<string, string> = {
    '/': `<!doctype html>
<html><head><title>Home</title></head>
<body>
  <h1>Welcome</h1>
  <p>Click the button to continue.</p>
  <button id="b">Click Me</button>
  <a href="/login">Sign in</a>
</body></html>`,

    '/login': `<!doctype html>
<html><head><title>Login</title></head>
<body>
  <h1>Sign In</h1>
  <form id="f" method="post" action="/welcome">
    <input id="email" name="email" type="email" placeholder="Email" required />
    <input id="password" name="password" type="password" placeholder="Password" required />
    <label><input id="remember" name="remember" type="checkbox" /> Remember me</label>
    <button type="submit">Sign In</button>
  </form>
</body></html>`,

    '/welcome': `<!doctype html>
<html><head><title>Welcome</title></head>
<body>
  <h1>You're in</h1>
  <p id="status">success</p>
  <button id="logout" disabled aria-disabled="true">Log Out (disabled)</button>
</body></html>`,
}

let server: http.Server
let serverUrl: string
const tmpFiles: string[] = []

beforeAll(async () => {
    if (!RUN) return

    server = http.createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0]
        const html = PAGES[url] ?? '<!doctype html><html><body>Not Found</body></html>'
        const status = PAGES[url] ? 200 : 404

        // login form posts to /welcome — accept the post and 303 to GET
        if (req.method === 'POST' && url === '/welcome') {
            res.writeHead(303, { Location: '/welcome' })
            res.end()
            return
        }

        res.writeHead(status, { 'Content-Type': 'text/html' })
        res.end(html)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('No server address')
    serverUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
    if (!RUN) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
    for (const p of tmpFiles.splice(0)) {
        await fs.unlink(p).catch(() => {})
    }
})

function tmpSessionPath(): string {
    const p = path.join(
        os.tmpdir(),
        `agentmark-it-session-${process.pid}-${Date.now()}-${Math.random()}.json`,
    )
    tmpFiles.push(p)
    return p
}

describe.runIf(RUN)('Browser + Page integration', () => {
    let browser: Browser

    afterEach(async () => {
        await browser?.close()
    })

    it('snapshots a real page and exposes parsed actions', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')

        const snap = await page.snapshot()

        expect(snap.snapshot.title).toBe('Home')
        expect(snap.snapshot.url).toBe(serverUrl + '/')
        expect(snap.snapshot.actions).toBeDefined()

        const types = Object.values(snap.snapshot.actions!).map((a) => a.type)
        expect(types).toContain('click')
        // The <a href="/login"> should appear as nav or click
        expect(types.some((t) => t === 'nav' || t === 'click')).toBe(true)

        // Wire format must be non-empty and contain frontmatter
        expect(snap.agentmark.length).toBeGreaterThan(50)
        expect(snap.agentmark).toContain('---')
        expect(snap.agentmark).toContain('agentmark:')
    })

    it('caches snapshot on the Page so execute() does not need it threaded', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')
        await page.snapshot()
        expect(page.snapshotCache).not.toBeNull()
        expect(page.snapshotCache?.snapshot.title).toBe('Home')
    })

    it('execute() throws when no snapshot has been captured', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')
        // Did not call .snapshot()
        await expect(page.execute('act_1')).rejects.toBeInstanceOf(ExecutionError)
    })

    it('execute() throws ActionNotFoundError for unknown ID', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')
        await page.snapshot()
        await expect(page.execute('act_does_not_exist')).rejects.toBeInstanceOf(
            ActionNotFoundError,
        )
    })

    it('fills a form and submits via execute()', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/login')
        const snap = await page.snapshot()

        // Find action IDs by label/type — labels are stable across page changes.
        // Password fields are intentionally redacted by the extractor (their
        // label becomes "(redacted)" and the description mentions the type),
        // so we match by description for the password.
        const ids = Object.entries(snap.snapshot.actions ?? {})
        const emailId = ids.find(([, a]) => a.type === 'type' && /email/i.test(a.label))?.[0]
        const passwordId = ids.find(
            ([, a]) => a.type === 'type' && a.label === '(redacted)' && /password/i.test(a.description ?? ''),
        )?.[0]
        const submitId = ids.find(
            ([, a]) => a.type === 'submit' || (a.type === 'click' && /sign in/i.test(a.label)),
        )?.[0]

        expect(emailId).toBeDefined()
        expect(passwordId).toBeDefined()
        expect(submitId).toBeDefined()

        await page.execute(emailId!, 'user@example.com')
        await page.execute(passwordId!, 'hunter2')
        await page.execute(submitId!)

        // Wait for the welcome page to load after the redirect
        await page.raw.waitForURL(serverUrl + '/welcome', { timeout: 5000 })
        expect(page.url()).toBe(serverUrl + '/welcome')
    })

    it('refuses to execute a disabled action (welcome page logout button)', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/welcome')
        const snap = await page.snapshot()

        const disabledId = Object.entries(snap.snapshot.actions ?? {}).find(
            ([, a]) => a.disabled && /log out/i.test(a.label),
        )?.[0]

        expect(disabledId).toBeDefined()
        await expect(page.execute(disabledId!)).rejects.toBeInstanceOf(ActionDisabledError)
    })

    it('navigation invalidates the cached snapshot', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')
        await page.snapshot()
        expect(page.snapshotCache).not.toBeNull()

        await page.goto(serverUrl + '/login')
        expect(page.snapshotCache).toBeNull()
    })

    it('saves and reloads a session — cookies persist across browsers', async () => {
        const sessionPath = tmpSessionPath()

        // Browser A — set a cookie
        const browserA = await createBrowser({ launch: { headless: true } })
        try {
            const page = await browserA.newPage()
            await page.goto(serverUrl + '/')
            await browserA.rawContext.addCookies([
                {
                    name: 'agentmark_test',
                    value: 'hello',
                    domain: '127.0.0.1',
                    path: '/',
                    expires: -1,
                    httpOnly: false,
                    secure: false,
                    sameSite: 'Lax',
                },
            ])
            await browserA.saveSession(sessionPath)
        } finally {
            await browserA.close()
        }

        // Browser B — load the session, verify the cookie comes back
        const browserB = await createBrowser({
            launch: { headless: true },
            sessionPath,
        })
        try {
            const cookies = await browserB.rawContext.cookies()
            const found = cookies.find((c) => c.name === 'agentmark_test')
            expect(found?.value).toBe('hello')
        } finally {
            await browserB.close()
        }
    })

    it('close() is idempotent', async () => {
        browser = await createBrowser({ launch: { headless: true } })
        await browser.close()
        await expect(browser.close()).resolves.toBeUndefined()
    })

    it('logger receives structured events end-to-end', async () => {
        const events: string[] = []
        browser = await createBrowser({
            launch: { headless: true },
            logger: {
                debug: (e) => events.push(e),
                info: (e) => events.push(e),
                warn: (e) => events.push(e),
                error: (e) => events.push(e),
            },
        })
        const page = await browser.newPage()
        await page.goto(serverUrl + '/')
        await page.snapshot()
        expect(events).toContain('navigation.start')
        expect(events).toContain('navigation.complete')
        expect(events).toContain('snapshot.capture.start')
        expect(events).toContain('snapshot.captured')
    })
})

/**
 * `Browser` — high-level wrapper around a Playwright browser + browser context.
 *
 * `createBrowser()` is the main entry point of the AgentMark SDK. It either
 * launches a fresh Chromium instance via `playwright-core` or wraps an
 * existing Playwright browser passed by the caller.
 */

import type {
    Browser as PlaywrightBrowser,
    BrowserContext,
    BrowserContextOptions,
    LaunchOptions,
} from 'playwright-core'
import { Page } from './page'
import { saveSessionToFile, loadSessionFromFile } from './session'
import { noopLogger, type Logger } from '../observability/logger'
import { SessionError } from '../errors'

export interface CreateBrowserOptions {
    /** Logger for structured events. Default: noopLogger (silent). */
    logger?: Logger

    /**
     * Use an existing Playwright Browser. If omitted, AgentMark launches
     * a new Chromium instance via `playwright-core`.
     */
    playwrightBrowser?: PlaywrightBrowser

    /**
     * Browser launch options. Only used when AgentMark is launching its own
     * browser (i.e. `playwrightBrowser` is not provided).
     */
    launch?: LaunchOptions

    /** Browser-context options (viewport, userAgent, locale, etc.). */
    context?: BrowserContextOptions

    /**
     * Path to a session file produced by `browser.saveSession()`. If provided,
     * the resulting browser context starts with these cookies + storage.
     */
    sessionPath?: string
}

export class Browser {
    /** The underlying Playwright Browser. Use as an escape hatch. */
    readonly raw: PlaywrightBrowser
    /** The underlying Playwright BrowserContext. Use as an escape hatch. */
    readonly rawContext: BrowserContext

    private readonly ownsBrowser: boolean
    private readonly logger: Logger
    private readonly pages: Page[] = []
    private closed = false

    private constructor(
        playwrightBrowser: PlaywrightBrowser,
        context: BrowserContext,
        ownsBrowser: boolean,
        logger: Logger,
    ) {
        this.raw = playwrightBrowser
        this.rawContext = context
        this.ownsBrowser = ownsBrowser
        this.logger = logger
    }

    /**
     * Create a new AgentMark Browser. Lazily imports `playwright-core` only
     * when AgentMark needs to launch its own browser, so callers passing
     * their own Playwright instance pay no startup cost.
     */
    static async create(options: CreateBrowserOptions = {}): Promise<Browser> {
        const logger = options.logger ?? noopLogger
        let playwrightBrowser: PlaywrightBrowser
        let ownsBrowser = false

        if (options.playwrightBrowser) {
            playwrightBrowser = options.playwrightBrowser
        } else {
            // Lazy import — avoids loading playwright-core when callers
            // bring their own browser instance.
            const { chromium } = await import('playwright-core')
            playwrightBrowser = await chromium.launch(options.launch ?? {})
            ownsBrowser = true
        }

        const contextOptions: BrowserContextOptions = { ...options.context }

        if (options.sessionPath) {
            try {
                contextOptions.storageState = await loadSessionFromFile(options.sessionPath)
                logger.info('session.loaded', { path: options.sessionPath })
            } catch (err) {
                throw new SessionError(
                    'session_load_failed',
                    `Could not load session from ${options.sessionPath}: ${(err as Error).message}`,
                    err as Error,
                )
            }
        }

        const context = await playwrightBrowser.newContext(contextOptions)

        return new Browser(playwrightBrowser, context, ownsBrowser, logger)
    }

    /** Open a new Page in this browser context. */
    async newPage(): Promise<Page> {
        if (this.closed) {
            throw new SessionError('browser_closed', 'Browser has been closed')
        }
        const playwrightPage = await this.rawContext.newPage()
        const page = new Page(playwrightPage, this.logger)
        this.pages.push(page)
        return page
    }

    /**
     * Persist the current session (cookies + per-origin storage) to a JSON
     * file. The file can be loaded by passing `sessionPath` to a future
     * `createBrowser()` call.
     */
    async saveSession(filePath: string): Promise<void> {
        this.logger.debug('session.save.start', { path: filePath })
        try {
            await saveSessionToFile(this.rawContext, filePath)
            this.logger.info('session.saved', { path: filePath })
        } catch (err) {
            this.logger.error('session.failed', {
                path: filePath,
                error: (err as Error).message,
            })
            throw new SessionError(
                'session_save_failed',
                `Could not save session to ${filePath}: ${(err as Error).message}`,
                err as Error,
            )
        }
    }

    /**
     * Close all pages, the browser context, and (if AgentMark launched the
     * underlying browser) the browser itself. Idempotent — safe to call
     * multiple times.
     */
    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true

        for (const page of this.pages) {
            await page.close().catch(() => {})
        }
        await this.rawContext.close().catch(() => {})
        if (this.ownsBrowser) {
            await this.raw.close().catch(() => {})
        }
    }
}

/**
 * Convenience factory mirroring the static `Browser.create()` method.
 *
 * @example
 *   import { createBrowser } from '@thinkfleet/agentmark'
 *
 *   const browser = await createBrowser({ launch: { headless: true } })
 *   const page = await browser.newPage()
 *   await page.goto('https://example.com')
 *   const snap = await page.snapshot()
 *   await browser.close()
 */
export function createBrowser(options?: CreateBrowserOptions): Promise<Browser> {
    return Browser.create(options)
}

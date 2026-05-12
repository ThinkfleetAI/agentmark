/**
 * Web (Playwright/Chromium) MCP plugin.
 *
 * Wraps the AgentMark Browser/Page API as MCP tools. Owns its own
 * browser + page session maps and disposes them on shutdown.
 */
import { createBrowser, type Browser, type Page } from '../../index'
import { generateSessionId, type BrowserSession } from '../types'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../plugin'
import type { McpToolDef } from '../tool-defs'

const WEB_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_browser_open',
        description:
            'Launch a Chromium browser and return a browser_id. The browser '
            + 'lives for the duration of the MCP session unless explicitly '
            + 'closed. Optional: load a previously saved session file to resume '
            + 'an authenticated state.',
        inputSchema: {
            type: 'object',
            properties: {
                headless: { type: 'boolean', description: 'Run Chromium in headless mode (default: true).' },
                session_path: { type: 'string', description: 'Path to a session file produced by browser_save_session.' },
            },
        },
    },
    {
        name: 'agentmark_browser_close',
        description: 'Close a browser and all its pages.',
        inputSchema: {
            type: 'object',
            properties: { browser_id: { type: 'string' } },
            required: ['browser_id'],
        },
    },
    {
        name: 'agentmark_browser_save_session',
        description:
            'Persist the browser\'s cookies + storage to a file path so a '
            + 'future agentmark_browser_open call can resume the same session.',
        inputSchema: {
            type: 'object',
            properties: {
                browser_id: { type: 'string' },
                path: { type: 'string', description: 'Output file path.' },
            },
            required: ['browser_id', 'path'],
        },
    },
    {
        name: 'agentmark_page_open',
        description: 'Open a new page in a browser. Returns a page_id.',
        inputSchema: {
            type: 'object',
            properties: { browser_id: { type: 'string' } },
            required: ['browser_id'],
        },
    },
    {
        name: 'agentmark_page_navigate',
        description: 'Navigate a page to a URL. Returns the resolved URL + HTTP status.',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
                url: { type: 'string' },
                wait_until: {
                    type: 'string',
                    enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                    description: 'Playwright waitUntil semantics. Default: load.',
                },
                timeout: { type: 'number', description: 'Per-navigation timeout in ms.' },
            },
            required: ['page_id', 'url'],
        },
    },
    {
        name: 'agentmark_page_snapshot',
        description:
            'Capture an AgentMark snapshot of the page (YAML+markdown wire format). '
            + 'Returns interactive elements as `actions` the agent can call via '
            + 'agentmark_page_execute.',
        inputSchema: {
            type: 'object',
            properties: { page_id: { type: 'string' } },
            required: ['page_id'],
        },
    },
    {
        name: 'agentmark_page_execute',
        description:
            'Execute a snapshot action by its action_id. Optional `value` for '
            + 'input-style actions (string for text/select, boolean for checkbox).',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
                action_id: { type: 'string' },
                value: { description: 'Value for input actions; type varies by action.' },
            },
            required: ['page_id', 'action_id'],
        },
    },
    {
        name: 'agentmark_page_close',
        description: 'Close a single page (keeps the browser alive).',
        inputSchema: {
            type: 'object',
            properties: { page_id: { type: 'string' } },
            required: ['page_id'],
        },
    },
]

export interface WebPlugin extends AgentMarkPlugin {
    readonly browsers: Map<string, BrowserSession>
    readonly pages: Map<string, { browserId: string; page: Page }>
}

export function createWebPlugin(): WebPlugin {
    const browsers = new Map<string, BrowserSession>()
    const pages = new Map<string, { browserId: string; page: Page }>()

    const requirePage = (pageId: string): Page => {
        const info = pages.get(pageId)
        if (!info) throw new Error(`Unknown page_id: ${pageId}`)
        return info.page
    }

    const handlers: Record<string, ToolHandler> = {
        agentmark_browser_open: async (args): Promise<DispatchResult> => {
            const headless = args.headless !== false
            const sessionPath = typeof args.session_path === 'string' ? args.session_path : undefined
            const browser = await createBrowser({ launch: { headless }, sessionPath })
            const id = generateSessionId('br')
            browsers.set(id, { id, browser, pages: new Map(), createdAt: new Date() })
            return { text: JSON.stringify({ browser_id: id }, null, 2) }
        },

        agentmark_browser_close: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'browser_id')
            const session = browsers.get(id)
            if (!session) return { text: `Unknown browser_id: ${id}`, isError: true }
            for (const [pageId, info] of pages) {
                if (info.browserId === id) pages.delete(pageId)
            }
            await session.browser.close()
            browsers.delete(id)
            return { text: `Browser ${id} closed.` }
        },

        agentmark_browser_save_session: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'browser_id')
            const targetPath = resolvePath(requireString(args, 'path'))
            const session = browsers.get(id)
            if (!session) return { text: `Unknown browser_id: ${id}`, isError: true }
            await session.browser.saveSession(targetPath)
            return { text: `Session saved to ${targetPath}` }
        },

        agentmark_page_open: async (args): Promise<DispatchResult> => {
            const browserId = requireString(args, 'browser_id')
            const session = browsers.get(browserId)
            if (!session) return { text: `Unknown browser_id: ${browserId}`, isError: true }
            const page = await session.browser.newPage()
            const pageId = generateSessionId('pg')
            pages.set(pageId, { browserId, page })
            session.pages.set(pageId, page)
            return { text: JSON.stringify({ page_id: pageId, browser_id: browserId }, null, 2) }
        },

        agentmark_page_navigate: async (args): Promise<DispatchResult> => {
            const pageId = requireString(args, 'page_id')
            const url = requireString(args, 'url')
            const page = requirePage(pageId)
            const waitUntil = args.wait_until as 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined
            const timeout = typeof args.timeout === 'number' ? args.timeout : undefined
            const response = await page.goto(url, { waitUntil, timeout })
            return { text: JSON.stringify({ final_url: page.url(), status: response?.status() ?? null }, null, 2) }
        },

        agentmark_page_snapshot: async (args): Promise<DispatchResult> => {
            const pageId = requireString(args, 'page_id')
            const snap = await requirePage(pageId).snapshot()
            return { text: snap.agentmark }
        },

        agentmark_page_execute: async (args): Promise<DispatchResult> => {
            const pageId = requireString(args, 'page_id')
            const actionId = requireString(args, 'action_id')
            const result = await requirePage(pageId).execute(actionId, args.value)
            return {
                text: JSON.stringify({
                    action_id: result.actionId,
                    action_type: result.actionType,
                    duration_ms: result.durationMs,
                }, null, 2),
            }
        },

        agentmark_page_close: async (args): Promise<DispatchResult> => {
            const pageId = requireString(args, 'page_id')
            const info = pages.get(pageId)
            if (!info) return { text: `Unknown page_id: ${pageId}`, isError: true }
            await info.page.close()
            pages.delete(pageId)
            browsers.get(info.browserId)?.pages.delete(pageId)
            return { text: `Page ${pageId} closed.` }
        },
    }

    return {
        name: 'web',
        tools: WEB_TOOLS,
        handlers,
        browsers,
        pages,
        dispose: async () => {
            await Promise.allSettled(
                Array.from(browsers.values()).map((s) => s.browser.close()),
            )
            browsers.clear()
            pages.clear()
        },
        describeSessions: () => ({
            browsers: Array.from(browsers.values()).map((s) => ({
                browser_id: s.id,
                page_ids: Array.from(s.pages.keys()),
                created_at: s.createdAt.toISOString(),
            })),
        }),
    }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function resolvePath(p: string): string {
    // Lazy import to avoid pulling node:path into bundlers when unused.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    return path.resolve(p)
}

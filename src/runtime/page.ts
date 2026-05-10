/**
 * `Page` — high-level wrapper around a Playwright Page that exposes the
 * AgentMark snapshot/execute primitives.
 *
 * A `Page` holds the most recently captured snapshot and uses it to validate
 * `execute()` calls against the action definitions before dispatching.
 */

import type { Page as PlaywrightPage, Response } from 'playwright-core'
import { convertPage, type ConvertOptions } from '../converter'
import { parseSnapshot } from '../serializers/yaml-frontmatter'
import {
    executeAction,
    type ExecuteOptions,
    type ExecutionResult,
} from './action-executor'
import { ActionId } from '../ids/branded'
import { noopLogger, type Logger } from '../observability/logger'
import {
    ActionNotFoundError,
    ExecutionError,
    SnapshotError,
} from '../errors'
import type { Snapshot, ActionBinding } from '../types'

export interface PageSnapshot {
    /** YAML+markdown serialized form (the wire format). */
    agentmark: string
    /** Parsed Snapshot object — same data, structured. */
    snapshot: Snapshot
    /** Map of action ID → opaque binding handle. */
    binding: ActionBinding
    /** When this snapshot was captured. */
    capturedAt: Date
}

export interface PageNavigationOptions {
    /** Maximum navigation time in ms. Default: Playwright default (30s). */
    timeout?: number
    /** When to consider navigation succeeded. Default: 'load'. */
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
    /** Referrer header for the navigation. */
    referer?: string
}

export class Page {
    /** The underlying Playwright Page. Use as an escape hatch. */
    readonly raw: PlaywrightPage

    private readonly logger: Logger
    private currentSnapshot: PageSnapshot | null = null

    constructor(playwrightPage: PlaywrightPage, logger: Logger = noopLogger) {
        this.raw = playwrightPage
        this.logger = logger
    }

    /**
     * Navigate to a URL. Invalidates any previously held snapshot.
     */
    async goto(url: string, options: PageNavigationOptions = {}): Promise<Response | null> {
        this.logger.info('navigation.start', { url })
        try {
            const response = await this.raw.goto(url, options)
            this.currentSnapshot = null
            this.logger.info('navigation.complete', {
                url,
                status: response?.status(),
                final_url: this.raw.url(),
            })
            return response
        } catch (err) {
            this.logger.error('navigation.failed', { url, error: (err as Error).message })
            throw err
        }
    }

    /**
     * Capture an AgentMark snapshot of the current page state.
     *
     * The result is stored on this Page so subsequent `execute()` calls can
     * validate against it without callers needing to thread the snapshot
     * through every call.
     */
    async snapshot(options: ConvertOptions = {}): Promise<PageSnapshot> {
        this.logger.debug('snapshot.capture.start', { url: this.raw.url() })
        try {
            const result = await convertPage(this.raw, options)
            const parsed = parseSnapshot(result.agentmark)
            const snap: PageSnapshot = {
                agentmark: result.agentmark,
                snapshot: parsed,
                binding: result.binding,
                capturedAt: new Date(),
            }
            this.currentSnapshot = snap

            this.logger.info('snapshot.captured', {
                url: this.raw.url(),
                action_count: Object.keys(parsed.actions ?? {}).length,
                bytes: result.agentmark.length,
            })
            return snap
        } catch (err) {
            this.logger.error('snapshot.failed', { error: (err as Error).message })
            throw new SnapshotError(`Snapshot failed: ${(err as Error).message}`, err as Error)
        }
    }

    /**
     * Execute an action by ID against the most recently captured snapshot.
     *
     * Throws `ExecutionError` (or a subclass) if no snapshot has been captured,
     * the action ID does not exist, the action is disabled, the value is the
     * wrong type, or Playwright execution fails.
     *
     * @example
     *   await page.execute('act_email', 'user@example.com')
     *   await page.execute('act_submit')
     */
    async execute(
        actionId: string,
        value?: unknown,
        options: ExecuteOptions = {},
    ): Promise<ExecutionResult> {
        if (!this.currentSnapshot) {
            throw new ExecutionError(
                'no_snapshot',
                `Cannot execute "${actionId}" — no snapshot has been captured. Call page.snapshot() first.`,
                ActionId(actionId),
            )
        }

        const action = this.currentSnapshot.snapshot.actions?.[actionId]
        if (!action) {
            throw new ActionNotFoundError(ActionId(actionId))
        }

        return executeAction(this.raw, action, ActionId(actionId), value, {
            logger: this.logger,
            ...options,
        })
    }

    /**
     * The most recently captured snapshot, or null if none.
     * Useful for callers that want to inspect snapshot without re-capturing.
     */
    get snapshotCache(): Readonly<PageSnapshot> | null {
        return this.currentSnapshot
    }

    /** URL of the current page. */
    url(): string {
        return this.raw.url()
    }

    async close(): Promise<void> {
        await this.raw.close().catch(() => {})
    }
}

/**
 * Server-side action executor.
 *
 * Resolves an AgentMark action ID against the live page (via the
 * `window.__agentmark.elements` map seeded by the DOM extractor) and
 * dispatches the appropriate Playwright operation.
 *
 * The executor is intentionally decoupled from the SDK surface (`Browser`,
 * `Page` wrappers) — it operates on a raw Playwright `Page` and an
 * `ActionDefinition`. The SDK layer composes it with snapshot + binding
 * lookups.
 */

import type { ElementHandle, Page } from 'playwright-core'
import type { ActionDefinition, ActionType } from '../types'
import type { ActionId } from '../ids/branded'
import type { Logger } from '../observability/logger'
import { noopLogger } from '../observability/logger'
import {
    ActionDisabledError,
    ActionTypeError,
    ElementNotFoundError,
    ExecutionError,
    ExecutionTimeoutError,
} from '../errors'

/** Default per-action timeout. Mirrors Playwright's default. */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000

export interface ExecuteOptions {
    /** Override default per-action timeout (ms). Default: 30000. */
    timeout?: number
    /** Bypass Playwright's actionability checks. Use sparingly. Default: false. */
    force?: boolean
    /** Logger to receive structured events. Default: noopLogger. */
    logger?: Logger
}

export interface ExecutionResult {
    actionId: ActionId
    actionType: ActionType
    durationMs: number
}

/**
 * Execute a single AgentMark action against a live Playwright page.
 *
 * Throws an `ExecutionError` subclass (see `errors/`) on any failure.
 * The element handle resolved during execution is always disposed before
 * return, even on error.
 *
 * @example
 *   const result = await executeAction(page, snapshot.actions['act_submit']!,
 *                                       'act_submit' as ActionId)
 *
 * @example
 *   await executeAction(page, snapshot.actions['act_email']!,
 *                       'act_email' as ActionId, 'user@example.com')
 */
export async function executeAction(
    page: Page,
    action: ActionDefinition,
    actionId: ActionId,
    value?: unknown,
    options: ExecuteOptions = {},
): Promise<ExecutionResult> {
    const startedAt = Date.now()
    const logger = options.logger ?? noopLogger
    const timeout = options.timeout ?? DEFAULT_ACTION_TIMEOUT_MS
    const force = options.force ?? false

    logger.debug('action.execute.start', { actionId, type: action.type })

    // ── Pre-flight validation ─────────────────────────────────────────────
    if (action.disabled) {
        const reason = action.disabled_reason ?? 'Action is disabled'
        logger.warn('action.execute.skipped', { actionId, reason: 'disabled' })
        throw new ActionDisabledError(actionId, reason)
    }

    if (action.read_only && requiresValueInput(action.type)) {
        logger.warn('action.execute.skipped', { actionId, reason: 'read_only' })
        throw new ActionDisabledError(actionId, 'Action is read-only')
    }

    if (action.honeypot) {
        // Honeypots are bot-trap fields — refuse to interact.
        logger.warn('action.execute.skipped', { actionId, reason: 'honeypot' })
        throw new ActionDisabledError(actionId, 'Action is a honeypot — refused')
    }

    validateValue(actionId, action, value)

    // ── 'key' is a page-level action, not element-bound ───────────────────
    if (action.type === 'key') {
        try {
            // page.keyboard.press has no native timeout — wrap manually so
            // the contract matches all other action types.
            await withTimeout(page.keyboard.press(value as string), timeout, actionId)
        } catch (err) {
            const classified = classifyError(actionId, err, timeout)
            logger.error('action.execute.failed', { actionId, code: classified.code })
            throw classified
        }
        return finish(actionId, action.type, startedAt, logger)
    }

    // ── Resolve the element via the page-side binding map ─────────────────
    const element = await resolveElement(page, actionId)
    if (!element) {
        const err = new ElementNotFoundError(actionId)
        logger.error('action.execute.failed', { actionId, code: err.code })
        throw err
    }

    // ── Dispatch by action type ───────────────────────────────────────────
    try {
        await dispatch(page, element, action, actionId, value, { timeout, force })
    } catch (err) {
        const classified = classifyError(actionId, err, timeout)
        logger.error('action.execute.failed', { actionId, code: classified.code })
        throw classified
    } finally {
        await element.dispose().catch(() => {})
    }

    return finish(actionId, action.type, startedAt, logger)
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

function finish(
    actionId: ActionId,
    type: ActionType,
    startedAt: number,
    logger: Logger,
): ExecutionResult {
    const durationMs = Date.now() - startedAt
    logger.info('action.execute.complete', { actionId, type, durationMs })
    return { actionId, actionType: type, durationMs }
}

/**
 * Resolve an action ID to a live ElementHandle by reading the binding map
 * the DOM extractor stashed on `window.__agentmark.elements`.
 *
 * Returns null if the page no longer has a binding for this ID (stale
 * snapshot, navigation, etc.) — callers raise `ElementNotFoundError`.
 */
async function resolveElement(page: Page, actionId: ActionId): Promise<ElementHandle | null> {
    try {
        const handle = await page.evaluateHandle((id: string) => {
            const am = (window as unknown as {
                __agentmark?: { elements?: Map<string, Element> }
            }).__agentmark
            return am?.elements?.get(id) ?? null
        }, actionId)
        const element = handle.asElement()
        if (!element) {
            await handle.dispose().catch(() => {})
            return null
        }
        return element as ElementHandle
    } catch {
        return null
    }
}

interface DispatchOptions {
    timeout: number
    force: boolean
}

async function dispatch(
    page: Page,
    element: ElementHandle,
    action: ActionDefinition,
    actionId: ActionId,
    value: unknown,
    opts: DispatchOptions,
): Promise<void> {
    const { timeout, force } = opts

    switch (action.type) {
        case 'click':
        case 'nav':
        case 'submit':
            await element.click({ timeout, force })
            return

        case 'hover':
            await element.hover({ timeout, force })
            return

        case 'scroll_to':
            await element.scrollIntoViewIfNeeded({ timeout })
            return

        case 'type':
        case 'date':
        case 'time':
        case 'datetime':
        case 'range':
        case 'color':
            await element.fill(String(value ?? ''), { timeout, force })
            return

        case 'check':
            await element.setChecked(Boolean(value), { timeout, force })
            return

        case 'select':
            await element.selectOption(String(value), { timeout })
            return

        case 'multi_select':
            await element.selectOption(value as string[], { timeout })
            return

        case 'upload':
            await element.setInputFiles(value as string | string[], { timeout })
            return

        case 'drag': {
            // value is the target action ID
            const targetId = value as ActionId
            const target = await resolveElement(page, targetId)
            if (!target) {
                throw new ElementNotFoundError(targetId)
            }
            try {
                const box = await target.boundingBox()
                if (!box) {
                    throw new ExecutionError(
                        'drag_target_invisible',
                        `Drag target "${targetId}" has no bounding box (likely hidden)`,
                        actionId,
                    )
                }
                await element.hover({ timeout })
                await page.mouse.down()
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
                    steps: 10,
                })
                await page.mouse.up()
            } finally {
                await target.dispose().catch(() => {})
            }
            return
        }

        case 'key':
            // Handled before dispatch — should never reach here.
            throw new ExecutionError(
                'internal',
                'key actions are dispatched at the page level, not element level',
                actionId,
            )

        default: {
            const _exhaustive: never = action.type
            throw new ExecutionError(
                'unknown_action_type',
                `Unknown action type: ${String(_exhaustive)}`,
                actionId,
            )
        }
    }
}

/**
 * True if this action type requires a value at execution time. Read-only
 * inputs (e.g. a `read_only` text field) cannot accept new values, but
 * action-types that don't take values (click, hover, etc.) are unaffected
 * by `read_only`.
 */
function requiresValueInput(type: ActionType): boolean {
    switch (type) {
        case 'type':
        case 'check':
        case 'select':
        case 'multi_select':
        case 'upload':
        case 'date':
        case 'time':
        case 'datetime':
        case 'range':
        case 'color':
        case 'key':
        case 'drag':
            return true
        case 'click':
        case 'nav':
        case 'submit':
        case 'hover':
        case 'scroll_to':
            return false
    }
}

/**
 * Validate that the supplied value matches the action type's expected shape.
 * Throws `ActionTypeError` on mismatch.
 */
function validateValue(actionId: ActionId, action: ActionDefinition, value: unknown): void {
    switch (action.type) {
        case 'click':
        case 'nav':
        case 'submit':
        case 'hover':
        case 'scroll_to':
            // value is ignored
            return

        case 'type':
        case 'date':
        case 'time':
        case 'datetime':
        case 'range':
        case 'color':
        case 'key':
        case 'select':
        case 'drag':
            if (typeof value !== 'string') {
                throw new ActionTypeError(actionId, 'string', describeType(value))
            }
            return

        case 'check':
            if (typeof value !== 'boolean') {
                throw new ActionTypeError(actionId, 'boolean', describeType(value))
            }
            return

        case 'multi_select':
            if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
                throw new ActionTypeError(actionId, 'string[]', describeType(value))
            }
            return

        case 'upload':
            if (
                typeof value !== 'string'
                && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))
            ) {
                throw new ActionTypeError(actionId, 'string | string[]', describeType(value))
            }
            return
    }
}

/**
 * Wrap a promise that has no native timeout option with a deadline. On
 * deadline exceeded, throws an Error whose message matches what `classifyError`
 * recognizes as a timeout, so callers get a uniform `ExecutionTimeoutError`.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, actionId: ActionId): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Action "${actionId}" timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function describeType(value: unknown): string {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

/**
 * Map an arbitrary thrown value into the AgentMark error hierarchy. Playwright
 * timeout errors become `ExecutionTimeoutError`; everything else becomes a
 * generic `ExecutionError`. AgentMark errors pass through untouched.
 */
function classifyError(actionId: ActionId, err: unknown, timeout: number): ExecutionError {
    if (err instanceof ExecutionError) return err

    const message = err instanceof Error ? err.message : String(err)
    const cause = err instanceof Error ? err : undefined

    if (/timeout|exceeded|timed out/i.test(message)) {
        return new ExecutionTimeoutError(actionId, timeout, cause)
    }

    return new ExecutionError(
        'execution_failed',
        `Action "${actionId}" failed: ${message}`,
        actionId,
    )
}

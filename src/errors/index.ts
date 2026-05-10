/**
 * Structured error hierarchy for @thinkfleet/agentmark.
 *
 * All errors thrown by AgentMark public APIs extend `AgentMarkError`. Callers
 * can `catch` on the base or on a specific subclass; every error carries a
 * stable `code` string for programmatic handling.
 *
 * Error code stability: `code` values are part of the public API and follow
 * semver. Renaming a code requires a major version bump.
 */

import type { ActionId } from '../ids/branded'

/**
 * Root of the AgentMark error hierarchy.
 *
 * @example
 *   try {
 *     await page.execute('act_submit')
 *   } catch (err) {
 *     if (err instanceof AgentMarkError) {
 *       console.error(err.code, err.message)
 *     }
 *   }
 */
export class AgentMarkError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.code = code
        this.name = 'AgentMarkError'
        // Restore prototype chain — TS-extending-Error has known issues
        // when targeting older runtimes; this guard is cheap and safe.
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot errors — capture failed
// ──────────────────────────────────────────────────────────────────────────

export class SnapshotError extends AgentMarkError {
    readonly cause?: Error

    constructor(message: string, cause?: Error) {
        super('snapshot_failed', message)
        this.name = 'SnapshotError'
        this.cause = cause
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Execution errors — action could not be executed
// ──────────────────────────────────────────────────────────────────────────

export class ExecutionError extends AgentMarkError {
    readonly actionId: ActionId

    constructor(code: string, message: string, actionId: ActionId) {
        super(code, message)
        this.name = 'ExecutionError'
        this.actionId = actionId
    }
}

/**
 * The action ID was not present in the snapshot's binding map.
 *
 * Most common cause: the snapshot is stale and the binding map for that
 * snapshot has been cleared by a more recent capture.
 */
export class ActionNotFoundError extends ExecutionError {
    constructor(actionId: ActionId) {
        super(
            'action_not_found',
            `Action "${actionId}" not found. The snapshot may be stale; capture a new one.`,
            actionId,
        )
        this.name = 'ActionNotFoundError'
    }
}

/**
 * The action exists but is marked disabled, read-only, or as a honeypot.
 * Honeypots are bot-trap fields; AgentMark refuses to execute them.
 */
export class ActionDisabledError extends ExecutionError {
    readonly reason: string

    constructor(actionId: ActionId, reason: string) {
        super('action_disabled', `Action "${actionId}" is disabled: ${reason}`, actionId)
        this.name = 'ActionDisabledError'
        this.reason = reason
    }
}

/**
 * The value passed to `execute()` does not match the action's expected type.
 */
export class ActionTypeError extends ExecutionError {
    readonly expected: string
    readonly got: string

    constructor(actionId: ActionId, expected: string, got: string) {
        super(
            'action_value_type_mismatch',
            `Action "${actionId}" expects value of type "${expected}", got "${got}"`,
            actionId,
        )
        this.name = 'ActionTypeError'
        this.expected = expected
        this.got = got
    }
}

/**
 * The action ID resolved through the binding map but the underlying DOM
 * element is gone (page mutated, navigated, or element was removed).
 */
export class ElementNotFoundError extends ExecutionError {
    constructor(actionId: ActionId) {
        super(
            'element_not_found',
            `Element for action "${actionId}" not found in DOM. The page may have changed since the snapshot was captured.`,
            actionId,
        )
        this.name = 'ElementNotFoundError'
    }
}

/**
 * Playwright reported a timeout while executing the action.
 */
export class ExecutionTimeoutError extends ExecutionError {
    readonly timeoutMs: number
    readonly cause?: Error

    constructor(actionId: ActionId, timeoutMs: number, cause?: Error) {
        super('execution_timeout', `Action "${actionId}" timed out after ${timeoutMs}ms`, actionId)
        this.name = 'ExecutionTimeoutError'
        this.timeoutMs = timeoutMs
        this.cause = cause
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Session errors — persistence / load failures
// ──────────────────────────────────────────────────────────────────────────

export class SessionError extends AgentMarkError {
    readonly cause?: Error

    constructor(code: string, message: string, cause?: Error) {
        super(code, message)
        this.name = 'SessionError'
        this.cause = cause
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * True if `value` is any AgentMarkError. Useful in catch blocks where the
 * thrown value may be `unknown`.
 */
export function isAgentMarkError(value: unknown): value is AgentMarkError {
    return value instanceof AgentMarkError
}

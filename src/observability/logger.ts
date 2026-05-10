/**
 * Pluggable structured logger for AgentMark.
 *
 * AgentMark emits structured events (see `./events.ts` for the catalog). By
 * default no logger is attached — pass one explicitly to observe internals.
 *
 * Logger implementations must be safe to call synchronously from any
 * context; AgentMark never awaits a log call.
 */

export interface Logger {
    debug(event: string, data?: Record<string, unknown>): void
    info(event: string, data?: Record<string, unknown>): void
    warn(event: string, data?: Record<string, unknown>): void
    error(event: string, data?: Record<string, unknown>): void
}

/**
 * No-op logger. Used as the default when no logger is provided.
 * Calls compile away at the JIT level — zero overhead in hot paths.
 */
export const noopLogger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
}

/**
 * Console-backed logger emitting JSON lines. Useful for local development
 * and structured log aggregation.
 *
 * @example
 *   const browser = await createBrowser({ logger: consoleLogger })
 */
export const consoleLogger: Logger = {
    debug(event, data) {
        console.debug(JSON.stringify({ level: 'debug', event, ...data }))
    },
    info(event, data) {
        console.info(JSON.stringify({ level: 'info', event, ...data }))
    },
    warn(event, data) {
        console.warn(JSON.stringify({ level: 'warn', event, ...data }))
    },
    error(event, data) {
        console.error(JSON.stringify({ level: 'error', event, ...data }))
    },
}

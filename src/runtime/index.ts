/**
 * Runtime module — high-level SDK surface.
 *
 * `createBrowser()` is the main entry point; it returns a `Browser` whose
 * `newPage()` produces `Page` instances exposing `snapshot()` and `execute()`.
 */

export { Browser, createBrowser } from './browser'
export type { CreateBrowserOptions } from './browser'

export { Page } from './page'
export type { PageSnapshot, PageNavigationOptions } from './page'

export {
    executeAction,
    DEFAULT_ACTION_TIMEOUT_MS,
} from './action-executor'
export type { ExecuteOptions, ExecutionResult } from './action-executor'

export {
    saveSessionToFile,
    loadSessionFromFile,
    SESSION_FORMAT_VERSION,
} from './session'
export type { SessionFile, StorageState } from './session'

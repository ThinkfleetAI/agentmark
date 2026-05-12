/**
 * Backward-compatible facade for the legacy `dispatch()` / `createDispatcherState()`
 * functional API. The real work happens in the plugin registry
 * (`./plugin.ts`) and the per-capability plugins under `./plugins/`.
 *
 * Kept for two reasons:
 *   1. The existing test suite drives `dispatch(state, name, args)` directly.
 *   2. Third-party code that imports these functions shouldn't break across
 *      this refactor.
 *
 * Prefer the new API for new code:
 *   import { Dispatcher, createWebPlugin, createPdfPlugin, ... } from '@thinkfleet/agentmark'
 */

import { Dispatcher, type AgentMarkPlugin, type DispatchResult } from './plugin'
import { createWebPlugin, type WebPlugin } from './plugins/web'
import { createPdfPlugin, type PdfPlugin } from './plugins/pdf'
import { createDesktopPlugin, type DesktopPlugin } from './plugins/desktop'
import { createMetaPlugin } from './plugins/meta'
import type { BrowserSession, DesktopSession, PdfSession } from './types'
import type { Page } from '../index'

export type { DispatchResult } from './plugin'

/**
 * Aggregate state container exposed by `createDispatcherState()`. The
 * per-capability maps (`browsers`, `pages`, `pdfs`, `desktops`) are
 * preserved for backward compatibility with code that reached into the
 * dispatcher state directly. New code should use the `dispatcher` field
 * (a `Dispatcher` instance) instead.
 */
export interface DispatcherState {
    browsers: Map<string, BrowserSession>
    pages: Map<string, { browserId: string; page: Page }>
    pdfs: Map<string, PdfSession>
    desktops: Map<string, DesktopSession>
    /** The plugin registry that owns the handler routing. */
    dispatcher: Dispatcher
    /** Plugins registered with this state, in registration order. */
    plugins: ReadonlyArray<AgentMarkPlugin>
}

/**
 * Build the default first-party plugin set (web + pdf + desktop + meta)
 * and return a `DispatcherState` that exposes both the new dispatcher
 * and the legacy per-capability maps.
 */
export function createDispatcherState(): DispatcherState {
    const web: WebPlugin = createWebPlugin()
    const pdf: PdfPlugin = createPdfPlugin()
    const desktop: DesktopPlugin = createDesktopPlugin()
    const meta = createMetaPlugin([web, pdf, desktop])
    const plugins: AgentMarkPlugin[] = [web, pdf, desktop, meta]
    const dispatcher = new Dispatcher(plugins)

    return {
        browsers: web.browsers,
        pages: web.pages,
        pdfs: pdf.pdfs,
        desktops: desktop.desktops,
        dispatcher,
        plugins,
    }
}

/**
 * Route a tool invocation through the legacy state's dispatcher.
 * Equivalent to `state.dispatcher.dispatch(name, args)`.
 */
export async function dispatch(
    state: DispatcherState,
    name: string,
    args: Record<string, unknown>,
): Promise<DispatchResult> {
    return state.dispatcher.dispatch(name, args)
}

/**
 * Dispose every resource held by the dispatcher's plugins. Equivalent to
 * `state.dispatcher.dispose()`. Safe to call multiple times — plugins'
 * own dispose hooks should be idempotent.
 */
export async function disposeAll(state: DispatcherState): Promise<void> {
    await state.dispatcher.dispose()
}

// Re-export so unrelated callers don't need to reach into types.ts.
export { type DispatcherState as McpDispatcherState }

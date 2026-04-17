import type { Page } from 'playwright'

export type WaitMode = 'fast' | 'smart' | 'aggressive'

export interface WaitOptions {
    mode?: WaitMode
    /** Max time we'll wait, regardless of mode. Default: 15000ms */
    maxWaitMs?: number
    /** For `smart`/`aggressive`: how long DOM must stay stable. Default: 500ms */
    stabilityMs?: number
}

/**
 * Wait for the page to be ready for snapshot capture.
 *
 * - `fast`: domcontentloaded only (~hundreds of ms typical)
 * - `smart`: domcontentloaded + network idle + DOM mutation stability (default)
 * - `aggressive`: smart + scroll-to-bottom to trigger lazy loads
 *
 * The "DOM mutation stability" check is the key insight: SPAs often have an
 * initial render → hydration → data-fetch → re-render cycle. We wait until
 * mutations stop for `stabilityMs` after networkidle.
 */
export async function waitForPageReady(page: Page, options: WaitOptions = {}): Promise<void> {
    const mode = options.mode ?? 'smart'
    const maxWaitMs = options.maxWaitMs ?? 15_000
    const stabilityMs = options.stabilityMs ?? 500
    const startedAt = Date.now()

    // Always wait at least for domcontentloaded
    await page.waitForLoadState('domcontentloaded', { timeout: maxWaitMs }).catch(() => {})

    if (mode === 'fast') return

    // Smart + Aggressive: wait for network idle, then DOM mutation stability
    const remainingForNetwork = Math.max(1000, maxWaitMs - (Date.now() - startedAt))
    await page.waitForLoadState('networkidle', { timeout: remainingForNetwork }).catch(() => {})

    const remainingForMutations = Math.max(stabilityMs * 2, maxWaitMs - (Date.now() - startedAt))
    await waitForMutationStability(page, stabilityMs, remainingForMutations)

    if (mode === 'aggressive') {
        // Trigger lazy loads: scroll to bottom, wait for stability again
        await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {})
        const remainingForLazyLoad = Math.max(stabilityMs * 2, maxWaitMs - (Date.now() - startedAt))
        await waitForMutationStability(page, stabilityMs, remainingForLazyLoad)
        await page.evaluate(`window.scrollTo(0, 0)`).catch(() => {})
    }
}

/**
 * Wait until the DOM stops mutating for `stabilityMs`, or `maxWaitMs` elapses.
 * Uses MutationObserver in the page context.
 */
async function waitForMutationStability(page: Page, stabilityMs: number, maxWaitMs: number): Promise<void> {
    if (maxWaitMs <= 0) return

    const script = `
        new Promise(resolve => {
            let lastMutation = Date.now();
            const observer = new MutationObserver(() => { lastMutation = Date.now(); });
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });
            const startedAt = Date.now();
            const interval = setInterval(() => {
                const sinceLastMutation = Date.now() - lastMutation;
                const elapsed = Date.now() - startedAt;
                if (sinceLastMutation >= ${stabilityMs} || elapsed >= ${maxWaitMs}) {
                    observer.disconnect();
                    clearInterval(interval);
                    resolve(true);
                }
            }, 100);
        })
    `

    await page.evaluate(script).catch(() => {})
}

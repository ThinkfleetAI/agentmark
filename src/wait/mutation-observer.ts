import type { Page } from 'playwright-core'

export interface ObservedMutation {
    timestamp: number
    /** Approximate magnitude — number of mutations bundled in this batch */
    magnitude: number
    /** Heuristic kind of change */
    kind: 'route_change' | 'modal' | 'lazy_load' | 'data_refresh' | 'minor'
}

export interface MutationObserverHandle {
    /** Stop observing (also cleans up the browser-side observer) */
    stop(): Promise<void>
}

export interface ObserveOptions {
    /** Minimum mutations within `windowMs` to fire callback. Default: 5 */
    minBatchSize?: number
    /** Window in ms to count mutations into a batch. Default: 250 */
    windowMs?: number
    /** Min ms between callback firings (debounce). Default: 1000 */
    debounceMs?: number
}

/**
 * Install a MutationObserver in the page that calls back on the host side
 * when significant DOM changes occur. Useful for re-emitting agentmark
 * when an SPA route swap or modal open happens.
 *
 * The callback receives a high-level classification + magnitude — the
 * caller decides whether to re-render agentmark in response.
 *
 * Implementation note: the browser-side observer batches mutations, then
 * calls a host-exposed function (`__agentmark_mutation`) via a Playwright
 * `exposeBinding`. This is more efficient than polling.
 */
export async function observeMutations(
    page: Page,
    onMutation: (m: ObservedMutation) => void,
    options: ObserveOptions = {},
): Promise<MutationObserverHandle> {
    const minBatchSize = options.minBatchSize ?? 5
    const windowMs = options.windowMs ?? 250
    const debounceMs = options.debounceMs ?? 1000

    // Expose a callback that the page can invoke. Playwright dedupes binding
    // names, so re-installation is safe across navigations.
    const bindingName = '__agentmark_mutation'
    let lastFiredAt = 0

    await page.exposeBinding(bindingName, (_source, payload: ObservedMutation) => {
        const now = Date.now()
        if (now - lastFiredAt < debounceMs) return
        lastFiredAt = now
        try {
            onMutation(payload)
        } catch {
            // swallow — observer must not crash on user callback errors
        }
    }).catch(() => {
        // Binding may already exist from a prior call; that's fine.
    })

    const installScript = `
        (() => {
            if (window.__agentmark_observer) {
                window.__agentmark_observer.disconnect();
            }
            let batch = [];
            let batchTimer = null;
            let lastUrl = location.href;

            const flush = () => {
                if (batch.length === 0) { batchTimer = null; return; }
                const magnitude = batch.length;
                let kind = 'minor';
                if (location.href !== lastUrl) { kind = 'route_change'; lastUrl = location.href; }
                else if (magnitude >= 50) kind = 'data_refresh';
                else if (document.querySelector('[role="dialog"][aria-modal="true"]')) kind = 'modal';
                else if (magnitude >= ${minBatchSize}) kind = 'lazy_load';

                if (magnitude >= ${minBatchSize}) {
                    window.${bindingName}({ timestamp: Date.now(), magnitude: magnitude, kind: kind });
                }
                batch = [];
                batchTimer = null;
            };

            const observer = new MutationObserver(records => {
                batch.push(...records);
                if (!batchTimer) batchTimer = setTimeout(flush, ${windowMs});
            });
            observer.observe(document.body, {
                childList: true, subtree: true, attributes: true, characterData: false,
            });

            // Also catch URL changes triggered by history.pushState
            const wrap = (method) => {
                const orig = history[method];
                history[method] = function(...args) {
                    const r = orig.apply(this, args);
                    setTimeout(flush, ${windowMs});
                    return r;
                };
            };
            wrap('pushState');
            wrap('replaceState');

            window.__agentmark_observer = observer;
        })()
    `

    await page.evaluate(installScript)

    return {
        async stop() {
            await page.evaluate(`(() => {
                if (window.__agentmark_observer) {
                    window.__agentmark_observer.disconnect();
                    delete window.__agentmark_observer;
                }
            })()`).catch(() => {})
        },
    }
}

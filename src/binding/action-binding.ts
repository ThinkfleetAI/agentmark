import type { ActionBinding } from '../types'

/**
 * In-memory binding from action IDs to opaque DOM handles.
 *
 * The handle is renderer-defined. For the Playwright backend it's a
 * window-scoped JS variable name (e.g. `__am_el_3`) that resolves to the
 * actual element when looked up via `page.evaluateHandle`.
 *
 * IDs are valid only for the snapshot they were generated in — see spec §7.7.
 */
export class InMemoryActionBinding implements ActionBinding {
    private map = new Map<string, string>()

    get(actionId: string): string | undefined {
        return this.map.get(actionId)
    }

    set(actionId: string, handle: string): void {
        this.map.set(actionId, handle)
    }

    all(): Map<string, string> {
        return new Map(this.map)
    }

    clear(): void {
        this.map.clear()
    }
}

/**
 * Diff two `DesktopCapture` trees.
 *
 * Used by `agentmark_desktop_diff` to let agents check "did my action
 * take effect?" or "did a new dialog appear?" with a much smaller token
 * payload than re-snapshotting the whole window.
 *
 * Matching is by stable accessibility id (`DesktopElement.id`). Roles,
 * names, bounds are reported as auxiliary fields on each change entry,
 * not used for matching.
 *
 * Out of scope (v1): structural moves (element reparented). Treated
 * as "removed from old parent, added to new parent" — agents that care
 * can re-snapshot.
 */
import type { DesktopCapture, DesktopElement } from './types'

export interface DesktopElementChange {
    /** Stable id present in both before and after. */
    id: string
    role: string
    name?: string
    /** Map of field → { from, to } for every primitive property that changed. */
    changes: Record<string, { from: unknown; to: unknown }>
}

export interface DesktopElementSummary {
    id: string
    role: string
    name?: string
    value?: string
}

export interface DesktopDiff {
    /** True when nothing meaningful changed (all arrays empty + title/focus same). */
    no_changes: boolean
    /** Title changes — common after navigation / dialog open. */
    window_title_changed: { from: string; to: string } | null
    /** Focus change — different element now has keyboard focus. */
    focus_changed: { from: string | undefined; to: string | undefined } | null
    /** Counts so agents can decide cheaply whether to re-snapshot. */
    summary: {
        added: number
        removed: number
        changed: number
    }
    /** Elements present in `after` but not `before`. */
    elements_added: DesktopElementSummary[]
    /** Elements present in `before` but not `after`. */
    elements_removed: DesktopElementSummary[]
    /** Elements present in both with one or more primitive field changes. */
    elements_changed: DesktopElementChange[]
}

/**
 * Compare two captures and return a structured diff. The function is
 * pure — neither argument is mutated. Order of the arguments matters:
 * `before` is the older snapshot, `after` is the newer one.
 */
export function diffDesktopCaptures(
    before: DesktopCapture,
    after: DesktopCapture,
): DesktopDiff {
    const beforeMap = indexById(before.root)
    const afterMap = indexById(after.root)

    const addedIds: string[] = []
    const removedIds: string[] = []
    const sharedIds: string[] = []

    for (const id of afterMap.keys()) {
        if (beforeMap.has(id)) sharedIds.push(id)
        else addedIds.push(id)
    }
    for (const id of beforeMap.keys()) {
        if (!afterMap.has(id)) removedIds.push(id)
    }

    const elements_added: DesktopElementSummary[] = addedIds.map((id) => summarise(afterMap.get(id)!))
    const elements_removed: DesktopElementSummary[] = removedIds.map((id) => summarise(beforeMap.get(id)!))
    const elements_changed: DesktopElementChange[] = []

    for (const id of sharedIds) {
        const a = beforeMap.get(id)!
        const b = afterMap.get(id)!
        const changes = compareElement(a, b)
        if (Object.keys(changes).length > 0) {
            elements_changed.push({
                id,
                role: b.role,
                name: b.name,
                changes,
            })
        }
    }

    const window_title_changed =
        before.window_title !== after.window_title
            ? { from: before.window_title, to: after.window_title }
            : null

    const focus_changed =
        before.focused_element_id !== after.focused_element_id
            ? { from: before.focused_element_id, to: after.focused_element_id }
            : null

    const summary = {
        added: elements_added.length,
        removed: elements_removed.length,
        changed: elements_changed.length,
    }

    const no_changes =
        summary.added === 0
        && summary.removed === 0
        && summary.changed === 0
        && window_title_changed === null
        && focus_changed === null

    return {
        no_changes,
        window_title_changed,
        focus_changed,
        summary,
        elements_added,
        elements_removed,
        elements_changed,
    }
}

/** Build a flat id → element index by walking the tree. */
function indexById(root: DesktopElement): Map<string, DesktopElement> {
    const out = new Map<string, DesktopElement>()
    const stack: DesktopElement[] = [root]
    while (stack.length > 0) {
        const el = stack.pop()!
        if (!out.has(el.id)) out.set(el.id, el)
        if (el.children) {
            for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i])
        }
    }
    return out
}

function summarise(el: DesktopElement): DesktopElementSummary {
    return {
        id: el.id,
        role: el.role,
        name: el.name,
        value: el.value,
    }
}

/** Compare two elements' primitive fields. Children are diffed at the
 *  tree level via add/remove sets; not recursed into here. */
function compareElement(a: DesktopElement, b: DesktopElement): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {}

    const scalarFields = ['role', 'name', 'value', 'placeholder', 'enabled', 'selected', 'read_only', 'expanded'] as const
    for (const field of scalarFields) {
        const av = a[field]
        const bv = b[field]
        if (av !== bv) changes[field] = { from: av, to: bv }
    }

    // aria — small shallow object; compare each known key.
    const ariaA = a.aria ?? {}
    const ariaB = b.aria ?? {}
    const ariaKeys: Array<keyof NonNullable<DesktopElement['aria']>> = ['pressed', 'checked', 'required', 'invalid']
    for (const key of ariaKeys) {
        if (ariaA[key] !== ariaB[key]) {
            changes[`aria.${key}`] = { from: ariaA[key], to: ariaB[key] }
        }
    }

    // bounds — only report if any coordinate shifted by more than 1px
    // (sub-pixel jitter from compositor isn't actionable).
    if (a.bounds && b.bounds) {
        const dx = Math.abs(a.bounds.x - b.bounds.x)
        const dy = Math.abs(a.bounds.y - b.bounds.y)
        const dw = Math.abs(a.bounds.width - b.bounds.width)
        const dh = Math.abs(a.bounds.height - b.bounds.height)
        if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
            changes.bounds = { from: a.bounds, to: b.bounds }
        }
    } else if (a.bounds !== b.bounds) {
        changes.bounds = { from: a.bounds, to: b.bounds }
    }

    return changes
}

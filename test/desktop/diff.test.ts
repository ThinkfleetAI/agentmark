/**
 * Tests for diffDesktopCaptures — the pure function comparing two
 * DesktopCapture trees by stable element ID.
 */
import { describe, it, expect } from 'vitest'
import { diffDesktopCaptures } from '../../src/desktop/diff'
import type { DesktopCapture, DesktopElement } from '../../src/desktop/types'

function makeCapture(overrides: Partial<DesktopCapture> & { root: DesktopElement }): DesktopCapture {
    return {
        platform: 'windows',
        window_title: 'Test Window',
        tree_depth: 2,
        element_count: 0, // recomputed below
        root: overrides.root,
        ...overrides,
    }
}

function el(id: string, role: string, fields: Partial<DesktopElement> = {}, children?: DesktopElement[]): DesktopElement {
    return { id, role: role as DesktopElement['role'], children, ...fields }
}

describe('diffDesktopCaptures — no-op cases', () => {
    it('returns no_changes=true when two identical captures are compared', () => {
        const root = el('root', 'window', { name: 'App' }, [
            el('a', 'button', { name: 'Save' }),
            el('b', 'text_input', { name: 'Email', value: 'x@y.com' }),
        ])
        const before = makeCapture({ root })
        const after = makeCapture({ root: structuredClone(root) })

        const diff = diffDesktopCaptures(before, after)
        expect(diff.no_changes).toBe(true)
        expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 })
        expect(diff.window_title_changed).toBeNull()
    })
})

describe('diffDesktopCaptures — value + state changes', () => {
    it('reports a single value change on an input', () => {
        const before = makeCapture({
            root: el('root', 'window', {}, [
                el('email', 'text_input', { value: 'old@x.com' }),
            ]),
        })
        const after = makeCapture({
            root: el('root', 'window', {}, [
                el('email', 'text_input', { value: 'new@x.com' }),
            ]),
        })

        const diff = diffDesktopCaptures(before, after)
        expect(diff.no_changes).toBe(false)
        expect(diff.summary.changed).toBe(1)
        expect(diff.elements_changed[0]).toMatchObject({
            id: 'email',
            role: 'text_input',
            changes: { value: { from: 'old@x.com', to: 'new@x.com' } },
        })
    })

    it('reports enabled flips and aria.checked flips', () => {
        const before = makeCapture({
            root: el('root', 'window', {}, [
                el('btn', 'button', { enabled: false, aria: { checked: false } }),
            ]),
        })
        const after = makeCapture({
            root: el('root', 'window', {}, [
                el('btn', 'button', { enabled: true, aria: { checked: true } }),
            ]),
        })

        const diff = diffDesktopCaptures(before, after)
        const change = diff.elements_changed.find((c) => c.id === 'btn')
        expect(change?.changes.enabled).toEqual({ from: false, to: true })
        expect(change?.changes['aria.checked']).toEqual({ from: false, to: true })
    })

    it('ignores sub-pixel bounds jitter (<=1px)', () => {
        const before = makeCapture({
            root: el('root', 'window', { bounds: { x: 100, y: 200, width: 800, height: 600 } }),
        })
        const after = makeCapture({
            root: el('root', 'window', { bounds: { x: 100.5, y: 200, width: 800, height: 600.5 } }),
        })

        const diff = diffDesktopCaptures(before, after)
        expect(diff.no_changes).toBe(true)
    })

    it('reports bounds change when the shift exceeds 1px', () => {
        const before = makeCapture({
            root: el('root', 'window', { bounds: { x: 100, y: 200, width: 800, height: 600 } }),
        })
        const after = makeCapture({
            root: el('root', 'window', { bounds: { x: 100, y: 200, width: 1200, height: 600 } }),
        })

        const diff = diffDesktopCaptures(before, after)
        const rootChange = diff.elements_changed.find((c) => c.id === 'root')
        expect(rootChange?.changes.bounds).toBeDefined()
    })
})

describe('diffDesktopCaptures — added + removed', () => {
    it('reports elements added in the after tree', () => {
        const before = makeCapture({
            root: el('root', 'window', {}, [el('a', 'button', { name: 'A' })]),
        })
        const after = makeCapture({
            root: el('root', 'window', {}, [
                el('a', 'button', { name: 'A' }),
                el('b', 'button', { name: 'B (new)' }),
            ]),
        })

        const diff = diffDesktopCaptures(before, after)
        expect(diff.summary).toMatchObject({ added: 1, removed: 0 })
        expect(diff.elements_added[0]).toMatchObject({ id: 'b', name: 'B (new)' })
    })

    it('reports elements removed when a dialog closes', () => {
        const before = makeCapture({
            root: el('root', 'window', {}, [
                el('main', 'pane'),
                el('dialog', 'dialog', { name: 'Confirm' }, [
                    el('ok', 'button', { name: 'OK' }),
                    el('cancel', 'button', { name: 'Cancel' }),
                ]),
            ]),
        })
        const after = makeCapture({
            root: el('root', 'window', {}, [el('main', 'pane')]),
        })

        const diff = diffDesktopCaptures(before, after)
        expect(diff.summary.removed).toBe(3) // dialog + ok + cancel
        const removedIds = diff.elements_removed.map((e) => e.id).sort()
        expect(removedIds).toEqual(['cancel', 'dialog', 'ok'])
    })
})

describe('diffDesktopCaptures — window-level changes', () => {
    it('reports window_title_changed', () => {
        const before = makeCapture({ root: el('root', 'window'), window_title: 'Untitled' })
        const after = makeCapture({ root: el('root', 'window'), window_title: 'Untitled — Saved' })
        const diff = diffDesktopCaptures(before, after)
        expect(diff.no_changes).toBe(false)
        expect(diff.window_title_changed).toEqual({ from: 'Untitled', to: 'Untitled — Saved' })
    })

    it('reports focus_changed', () => {
        const before = makeCapture({ root: el('root', 'window'), focused_element_id: 'a' })
        const after = makeCapture({ root: el('root', 'window'), focused_element_id: 'b' })
        const diff = diffDesktopCaptures(before, after)
        expect(diff.focus_changed).toEqual({ from: 'a', to: 'b' })
    })
})

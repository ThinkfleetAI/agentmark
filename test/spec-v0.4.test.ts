import { describe, it, expect } from 'vitest'
import { validateSnapshot } from '../src/validators/schema-validator'
import { serializeSnapshot, parseSnapshot } from '../src/serializers/yaml-frontmatter'
import type { Snapshot } from '../src/types'

describe('Spec v0.4 — desktop kind', () => {
    it('accepts a minimal desktop snapshot with desktop_meta', () => {
        const snap: Snapshot = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/12345',
            title: 'Microsoft Excel - Book1',
            desktop_meta: {
                platform: 'windows',
                process_name: 'EXCEL.EXE',
                process_id: 12345,
                window_class: 'XLMAIN',
                a11y_backend: 'windows_uia',
                tree_depth: 8,
                element_count: 47,
            },
            actions: {
                act_save: { type: 'click', label: 'Save' },
            },
            body: '# Microsoft Excel — Book1\n\n[ACTION:act_save]',
        }
        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
        expect(result.valid).toBe(true)
    })

    it('accepts a desktop snapshot on macOS via AXAPI', () => {
        const snap: Snapshot = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/pages-1',
            title: 'Pages - Untitled',
            desktop_meta: {
                platform: 'macos',
                process_name: 'Pages',
                a11y_backend: 'macos_axapi',
                element_count: 12,
            },
            body: '# Pages — Untitled\n\nEmpty document.',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('rejects desktop_meta with unknown platform', () => {
        const snap = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/1',
            title: 'Bad',
            desktop_meta: {
                // @ts-expect-error — intentionally invalid for the test
                platform: 'beos',
            },
            body: 'x',
        } as unknown as Snapshot
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(false)
        expect(result.errors.some(e => e.path.includes('desktop_meta'))).toBe(true)
    })

    it('rejects desktop_meta with extra fields (closed object)', () => {
        const snap = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/1',
            title: 'Bad',
            desktop_meta: {
                platform: 'windows',
                // @ts-expect-error — additional properties not allowed
                weird_field: 'nope',
            },
            body: 'x',
        } as unknown as Snapshot
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(false)
    })

    it('accepts [WINDOW:w_1] and [ELEMENT:e_42] body tags without action lookup', () => {
        // WINDOW and ELEMENT are structural — payload doesn't need to resolve
        // to anything in actions/media/signatures.
        const snap: Snapshot = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/123',
            title: 'Multi-window snapshot',
            desktop_meta: { platform: 'windows', a11y_backend: 'windows_uia' },
            body: '[WINDOW:w_1]\n\n## Excel\n\n[ELEMENT:e_42] read-only cell value\n\n[WINDOW:w_2]\n\n## Outlook',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('round-trips a desktop snapshot through YAML serialization', () => {
        const original: Snapshot = {
            agentmark: '0.4',
            kind: 'desktop',
            url: 'desktop://localhost/window/abc',
            title: 'NowCerts Customer Detail',
            desktop_meta: {
                platform: 'windows',
                process_name: 'NowCerts.exe',
                a11y_backend: 'windows_uia',
                element_count: 23,
            },
            actions: {
                act_search: { type: 'type', label: 'Search', placeholder: 'Search customers...' },
            },
            body: '# NowCerts\n\n[INPUT:act_search]',
        }
        const serialized = serializeSnapshot(original)
        const reparsed = parseSnapshot(serialized)
        expect(reparsed.kind).toBe('desktop')
        expect(reparsed.desktop_meta?.platform).toBe('windows')
        expect(reparsed.desktop_meta?.process_name).toBe('NowCerts.exe')
        expect(reparsed.actions?.act_search?.type).toBe('type')
    })

    it('v0.3 snapshots continue to validate against v0.4 (backwards compat)', () => {
        const snap: Snapshot = {
            agentmark: '0.3',
            kind: 'webpage',
            url: 'https://example.com/',
            title: 'Example',
            body: '# Hello',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })
})

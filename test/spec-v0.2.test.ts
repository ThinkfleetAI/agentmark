import { describe, it, expect } from 'vitest'
import { validateSnapshot } from '../src/validators/schema-validator'
import { serializeSnapshot, parseSnapshot } from '../src/serializers/yaml-frontmatter'
import type { Snapshot } from '../src/types'
import { SUPPORTED_SPEC_VERSIONS, AGENTMARK_VERSION } from '../src/types'

describe('Spec v0.2 — kind discriminator', () => {
    it('default version is 0.3 in this implementation (v0.3 ships with audio support)', () => {
        expect(AGENTMARK_VERSION).toBe('0.3')
    })

    it('reports v0.1, v0.2, and v0.3 as supported', () => {
        expect(SUPPORTED_SPEC_VERSIONS).toEqual(['0.1', '0.2', '0.3'])
    })

    it('v0.1 snapshots without kind still validate (backwards compat)', () => {
        const snap: Snapshot = {
            agentmark: '0.1',
            url: 'https://example.com/',
            title: 'Example',
            body: '# Hello',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('v0.2 snapshots may declare kind: webpage', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'webpage',
            url: 'https://example.com/',
            title: 'Example',
            body: '# Hello',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('v0.2 snapshots may declare kind: document with metadata', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/report.pdf',
            title: 'Annual Report 2025',
            document: {
                pages: 47,
                author: 'Acme Inc.',
                created_at: '2025-03-15T00:00:00.000Z',
                format: 'pdf',
                format_version: '1.7',
                ocr_used: false,
            },
            body: '[PAGE:p_1]\n\n# Cover\n\n[PAGE:p_2]\n\n## Introduction',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
        expect(result.warnings).toEqual([])
    })

    it('v0.2 snapshots may declare kind: form', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'form',
            url: 'file:///tmp/application.pdf',
            title: 'Vendor Application',
            actions: {
                act_company_name: { type: 'type', label: 'Company Name', required: true },
                act_submit: { type: 'submit', label: 'Submit Application' },
            },
            body: '# Vendor Application\n\n[INPUT:act_company_name]\n\n[ACTION:act_submit]',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('rejects kind: unknown_value', () => {
        const snap = {
            agentmark: '0.2',
            kind: 'spreadsheet',
            url: 'https://example.com/',
            title: 'Test',
            body: '# Hi',
        } as unknown as Snapshot
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(false)
    })

    it('rejects document with negative or zero pages', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/x.pdf',
            title: 'Test',
            document: { pages: 0 },
            body: '',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(false)
    })

    it('rejects document with unknown format', () => {
        const snap = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/x.epub',
            title: 'Test',
            document: { format: 'epub' },
            body: '',
        } as unknown as Snapshot
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(false)
    })
})

describe('Spec v0.2 — PAGE body tag', () => {
    it('PAGE markers do not require resolution to actions or media', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/doc.pdf',
            title: 'Doc',
            body: '[PAGE:p_1]\n\n# First page\n\nContent.\n\n[PAGE:p_2]\n\n# Second page',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
    })

    it('PAGE markers serialize and parse round-trip', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/doc.pdf',
            title: 'Doc',
            document: { pages: 2, format: 'pdf' },
            body: '[PAGE:p_1]\n\n# First page\n\n[PAGE:p_2]\n\n# Second page',
        }
        const serialized = serializeSnapshot(snap)
        const parsed = parseSnapshot(serialized)
        expect(parsed.kind).toBe('document')
        expect(parsed.body).toContain('[PAGE:p_1]')
        expect(parsed.body).toContain('[PAGE:p_2]')
        expect(parsed.document?.pages).toBe(2)
        expect(parsed.document?.format).toBe('pdf')
    })
})

describe('Spec v0.2 — version negotiation', () => {
    it('warns when document declares unknown version above 0.2', () => {
        const snap: Snapshot = {
            agentmark: '0.5',
            url: 'https://example.com/',
            title: 'Future spec',
            body: '# Hi',
        }
        const result = validateSnapshot(snap)
        const versionWarning = result.warnings.find((w) => w.path === '/agentmark')
        expect(versionWarning).toBeDefined()
    })

    it('warns when document with kind: document has webpage state fields', () => {
        const snap: Snapshot = {
            agentmark: '0.2',
            kind: 'document',
            url: 'file:///tmp/doc.pdf',
            title: 'Doc',
            state: { auth: 'logged_in' },
            body: '# Content',
        }
        const result = validateSnapshot(snap)
        expect(result.valid).toBe(true)
        expect(result.warnings.some((w) => w.path === '/state')).toBe(true)
    })
})

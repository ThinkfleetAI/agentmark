import { describe, it, expect } from 'vitest'
import { serializeSnapshot, parseSnapshot } from '../src/serializers/yaml-frontmatter'
import type { Snapshot } from '../src/types'

describe('serializeSnapshot / parseSnapshot', () => {
    const sample: Snapshot = {
        agentmark: '0.1',
        url: 'https://example.com/page',
        title: 'Example Page',
        captured_at: '2026-04-16T12:00:00.000Z',
        state: { auth: 'logged_out', loading: false },
        actions: {
            act_login: { type: 'click', label: 'Log In' },
            act_email: { type: 'type', label: 'Email', required: true, validation: 'email' },
        },
        body: '# Example\n\n[ACTION:act_login]',
    }

    it('round-trips a minimal snapshot', () => {
        const text = serializeSnapshot(sample)
        const parsed = parseSnapshot(text)
        expect(parsed.url).toBe(sample.url)
        expect(parsed.title).toBe(sample.title)
        expect(parsed.actions?.act_login?.type).toBe('click')
        expect(parsed.body).toContain('[ACTION:act_login]')
    })

    it('starts with frontmatter delimiter', () => {
        const text = serializeSnapshot(sample)
        expect(text.startsWith('---\n')).toBe(true)
    })

    it('contains body separated by closing ---', () => {
        const text = serializeSnapshot(sample)
        expect(text).toMatch(/---\n\n# Example/)
    })

    it('strips empty/undefined fields', () => {
        const minimal: Snapshot = {
            agentmark: '0.1',
            url: 'https://x.com',
            title: 'X',
            body: '',
            // explicitly undefined-laden state
            state: { loading: undefined, auth: undefined },
        }
        const text = serializeSnapshot(minimal)
        expect(text).not.toContain('state:')   // empty state should be stripped
        expect(text).not.toContain('undefined')
    })

    it('rejects documents missing frontmatter delimiters', () => {
        expect(() => parseSnapshot('# just markdown')).toThrow(/missing frontmatter/)
    })

    it('rejects documents missing required fields', () => {
        const noUrl = '---\nagentmark: "0.1"\ntitle: "x"\n---\n\nbody'
        expect(() => parseSnapshot(noUrl)).toThrow(/missing required field "url"/)
    })

    it('strips a leading UTF-8 BOM', () => {
        const text = '\uFEFF' + serializeSnapshot(sample)
        const parsed = parseSnapshot(text)
        expect(parsed.url).toBe(sample.url)
    })

    it('handles CRLF line endings', () => {
        const text = serializeSnapshot(sample).replace(/\n/g, '\r\n')
        const parsed = parseSnapshot(text)
        expect(parsed.title).toBe(sample.title)
    })

    it('preserves vendor extensions', () => {
        const ext: Snapshot = {
            ...sample,
            'x-thinkfleet-project-id': 'abc123',
        }
        const text = serializeSnapshot(ext)
        const parsed = parseSnapshot(text)
        expect((parsed as Record<string, unknown>)['x-thinkfleet-project-id']).toBe('abc123')
    })
})

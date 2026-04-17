import { describe, it, expect } from 'vitest'
import { buildSnapshot } from '../src/converter'
import { validateSnapshot } from '../src/validators/schema-validator'
import type { RawExtraction } from '../src/extractors/dom-extractor'

function fakeExtraction(overrides: Partial<RawExtraction> = {}): RawExtraction {
    return {
        title: 'Test Page',
        url: 'https://example.com/test',
        language: 'en',
        direction: 'ltr',
        state: { loading: false, modal_open: false, ssl: 'valid' },
        actions: {
            act_1: {
                type: 'click',
                label: 'Sign Up',
                disabled: false,
            },
            act_2: {
                type: 'type',
                label: 'Email',
                disabled: false,
                required: true,
                validation: 'email',
            },
        },
        media: {},
        body_segments: [
            { kind: 'heading', level: 1, text: 'Test Page' },
            { kind: 'paragraph', text: 'A short description.' },
            { kind: 'tag', tag: 'INPUT', ref: 'act_2' },
            { kind: 'tag', tag: 'ACTION', ref: 'act_1' },
        ],
        cookies: { banner_present: false },
        ...overrides,
    }
}

describe('buildSnapshot', () => {
    it('produces a valid snapshot from a fake extraction', () => {
        const snap = buildSnapshot(fakeExtraction())
        const v = validateSnapshot(snap)
        expect(v.valid).toBe(true)
    })

    it('sets agentmark version, source, and timestamps', () => {
        const snap = buildSnapshot(fakeExtraction())
        expect(snap.agentmark).toBe('0.1')
        expect(snap.source).toBe('rendered')
        expect(snap.captured_at).toBeDefined()
        expect(snap.expires_at).toBeDefined()
        expect(new Date(snap.expires_at!).getTime()).toBeGreaterThan(new Date(snap.captured_at!).getTime())
    })

    it('honors source override', () => {
        const snap = buildSnapshot(fakeExtraction(), { source: 'declared' })
        expect(snap.source).toBe('declared')
    })

    it('honors ttlMs', () => {
        const snap = buildSnapshot(fakeExtraction(), { ttlMs: 5000 })
        const ttl = new Date(snap.expires_at!).getTime() - new Date(snap.captured_at!).getTime()
        expect(ttl).toBeGreaterThanOrEqual(4900)
        expect(ttl).toBeLessThanOrEqual(5100)
    })

    it('attaches memory hints when provided', () => {
        const snap = buildSnapshot(fakeExtraction(), {
            memory: { last_visited: '2026-04-01T00:00:00Z', visit_count: 5 },
        })
        expect(snap.memory?.visit_count).toBe(5)
    })

    it('preserves vendor extensions with x- prefix', () => {
        const snap = buildSnapshot(fakeExtraction(), {
            vendorExtensions: { 'x-thinkfleet-project-id': 'p_123' },
        })
        expect((snap as Record<string, unknown>)['x-thinkfleet-project-id']).toBe('p_123')
    })

    it('drops vendor fields without x- prefix (sanitization)', () => {
        const snap = buildSnapshot(fakeExtraction(), {
            vendorExtensions: { 'arbitrary': 'no' },
        })
        expect((snap as Record<string, unknown>)['arbitrary']).toBeUndefined()
    })

    it('builds the body string from segments', () => {
        const snap = buildSnapshot(fakeExtraction())
        expect(snap.body).toContain('# Test Page')
        expect(snap.body).toContain('A short description.')
        expect(snap.body).toContain('[INPUT:act_2]')
        expect(snap.body).toContain('[ACTION:act_1]')
    })

    it('omits actions/media when empty', () => {
        const snap = buildSnapshot(fakeExtraction({ actions: {}, media: {} }))
        expect(snap.actions).toBeUndefined()
        expect(snap.media).toBeUndefined()
    })

    it('emits cookie banner action when present', () => {
        const snap = buildSnapshot(fakeExtraction({
            cookies: { banner_present: true, banner_action_id: 'act_1' },
        }))
        expect(snap.cookies?.banner_present).toBe(true)
        expect(snap.cookies?.banner_action_id).toBe('act_1')
    })
})

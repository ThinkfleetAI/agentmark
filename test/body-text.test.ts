import { describe, it, expect } from 'vitest'
import {
    escapeBodyText,
    renderTag,
    hasTagReference,
    extractTagReferences,
} from '../src/serializers/body-text'

describe('escapeBodyText', () => {
    it('escapes [ before uppercase letters (potential tag start)', () => {
        expect(escapeBodyText('[ACTION:foo]')).toBe('\\[ACTION:foo]')
        expect(escapeBodyText('[FAKE]')).toBe('\\[FAKE]')
    })

    it('does not escape [ before lowercase (regular markdown links)', () => {
        expect(escapeBodyText('[click here](url)')).toBe('[click here](url)')
    })

    it('escapes backslashes first', () => {
        expect(escapeBodyText('\\already')).toBe('\\\\already')
    })

    it('handles plain text untouched', () => {
        expect(escapeBodyText('Just some text')).toBe('Just some text')
    })
})

describe('renderTag', () => {
    it('renders tags with payload', () => {
        expect(renderTag('ACTION', 'act_7')).toBe('[ACTION:act_7]')
        expect(renderTag('CHALLENGE', 'cloudflare')).toBe('[CHALLENGE:cloudflare]')
    })

    it('renders tags without payload', () => {
        expect(renderTag('AUTH_WALL')).toBe('[AUTH_WALL]')
    })
})

describe('hasTagReference', () => {
    it('detects tag references', () => {
        expect(hasTagReference('hello [ACTION:act_7] world')).toBe(true)
        expect(hasTagReference('[AUTH_WALL]')).toBe(true)
    })

    it('returns false for plain text', () => {
        expect(hasTagReference('hello world')).toBe(false)
        expect(hasTagReference('[lowercase] doesnt count')).toBe(false)
    })
})

describe('extractTagReferences', () => {
    it('extracts all references in order', () => {
        const refs = extractTagReferences('[NAV:a] some text [ACTION:b] more [AUTH_WALL]')
        expect(refs).toHaveLength(3)
        expect(refs[0]).toMatchObject({ kind: 'NAV', payload: 'a' })
        expect(refs[1]).toMatchObject({ kind: 'ACTION', payload: 'b' })
        expect(refs[2]).toMatchObject({ kind: 'AUTH_WALL' })
    })

    it('records position of each reference', () => {
        const body = 'pre [TAB:t1] mid [TAB:t2] end'
        const refs = extractTagReferences(body)
        expect(body.slice(refs[0].position, refs[0].position + 8)).toBe('[TAB:t1]')
    })

    it('skips references inside fenced code blocks per spec', () => {
        const body = '```\n[ACTION:should_not_match]\n```\n[ACTION:real]'
        const refs = extractTagReferences(body)
        expect(refs).toHaveLength(1)
        expect(refs[0]).toMatchObject({ kind: 'ACTION', payload: 'real' })
    })

    it('handles tags with no payload (AUTH_WALL, etc.)', () => {
        const refs = extractTagReferences('[AUTH_WALL] now [ACTION:x]')
        expect(refs).toHaveLength(2)
        expect(refs[0].payload).toBeUndefined()
        expect(refs[1].payload).toBe('x')
    })

    it('handles multiple tags on one line', () => {
        const refs = extractTagReferences('[NAV:a] · [NAV:b] · [NAV:c]')
        expect(refs).toHaveLength(3)
    })
})

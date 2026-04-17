import { describe, it, expect } from 'vitest'
import { validateSnapshot } from '../src/validators/schema-validator'
import type { Snapshot } from '../src/types'

describe('validateSnapshot', () => {
    function valid(): Snapshot {
        return {
            agentmark: '0.1',
            url: 'https://example.com/',
            title: 'Example',
            actions: {
                act_1: { type: 'click', label: 'Click me' },
            },
            body: '[ACTION:act_1]',
        }
    }

    it('accepts a minimal valid snapshot', () => {
        const r = validateSnapshot(valid())
        expect(r.valid).toBe(true)
        expect(r.errors).toEqual([])
    })

    it('rejects bad agentmark version format', () => {
        const s = valid()
        s.agentmark = 'invalid'
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
    })

    it('rejects bad action type', () => {
        const s = valid()
        s.actions!.act_1.type = 'mash' as never
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
    })

    it('rejects action ID with bad characters', () => {
        const s = valid()
        s.actions = { 'BadID-99': { type: 'click', label: 'x' } }
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
    })

    it('flags body reference to undefined action', () => {
        const s = valid()
        s.body = '[ACTION:does_not_exist]'
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
        expect(r.errors[0].message).toMatch(/no matching action/)
    })

    it('flags self-precondition', () => {
        const s = valid()
        s.actions!.act_1.precondition_ids = ['act_1']
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
        expect(r.errors.some(e => e.message.includes('cannot precondition itself'))).toBe(true)
    })

    it('flags precondition referencing unknown action', () => {
        const s = valid()
        s.actions!.act_1.precondition_ids = ['nope']
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
    })

    it('flags target_id pointing at unknown action', () => {
        const s = valid()
        s.actions!.act_1 = { type: 'drag', label: 'Drag', target_id: 'nope' }
        const r = validateSnapshot(s)
        expect(r.valid).toBe(false)
    })

    it('warns on enabled honeypot', () => {
        const s = valid()
        s.actions!.act_1.honeypot = true
        const r = validateSnapshot(s)
        expect(r.warnings.some(w => w.message.includes('honeypot'))).toBe(true)
    })

    it('warns on destructive cost without confirms', () => {
        const s = valid()
        s.actions!.act_1.cost = 'destructive'
        const r = validateSnapshot(s)
        expect(r.warnings.some(w => w.message.includes('confirms'))).toBe(true)
    })

    it('does not warn on destructive cost when confirms is set', () => {
        const s = valid()
        s.actions!.act_1.cost = 'destructive'
        s.actions!.act_1.confirms = true
        const r = validateSnapshot(s)
        expect(r.warnings.some(w => w.message.includes('confirms'))).toBe(false)
    })

    it('skips ERROR/CHALLENGE payload validation (they carry reasons not IDs)', () => {
        const s = valid()
        s.body = '[ERROR:render_timeout] [CHALLENGE:cloudflare]'
        const r = validateSnapshot(s)
        // ERROR and CHALLENGE payloads are not action IDs, so should not trigger lookup
        expect(r.errors.filter(e => e.message.includes('no matching')).length).toBe(0)
    })

    it('warns on unsupported major version', () => {
        const s = valid()
        s.agentmark = '1.0'
        const r = validateSnapshot(s)
        expect(r.warnings.some(w => w.message.includes('v1.0'))).toBe(true)
    })
})

/**
 * Tests for the self-healing fingerprint primitives.
 */
import { describe, it, expect } from 'vitest'
import {
    computeFingerprint,
    findByFingerprint,
    scoreFingerprintMatch,
} from '../../src/desktop/fingerprint'
import type { DesktopCapture, DesktopElement } from '../../src/desktop/types'

function el(id: string, role: string, fields: Partial<DesktopElement> = {}, children?: DesktopElement[]): DesktopElement {
    return { id, role: role as DesktopElement['role'], children, ...fields }
}

function capture(root: DesktopElement, overrides: Partial<DesktopCapture> = {}): DesktopCapture {
    return {
        platform: 'windows',
        window_title: 'Test',
        tree_depth: 3,
        element_count: 0,
        root,
        ...overrides,
    }
}

describe('computeFingerprint', () => {
    it('captures role + name + parent + sibling context', () => {
        const tree = capture(
            el('root', 'window', { name: 'Form' }, [
                el('label_email', 'label', { name: 'Email' }),
                el('input_email', 'text_input', { name: 'Email', placeholder: 'you@example.com' }),
                el('label_phone', 'label', { name: 'Phone' }),
            ]),
        )
        const fp = computeFingerprint(tree, 'input_email')
        expect(fp).toEqual({
            role: 'text_input',
            name: 'Email',
            value: undefined,
            placeholder: 'you@example.com',
            depth: 1,
            parent_role: 'window',
            parent_name: 'Form',
            preceding_sibling: { role: 'label', name: 'Email' },
            following_sibling: { role: 'label', name: 'Phone' },
        })
    })

    it('returns null for unknown ids', () => {
        const tree = capture(el('root', 'window'))
        expect(computeFingerprint(tree, 'nope')).toBeNull()
    })
})

describe('scoreFingerprintMatch', () => {
    it('returns 0 when roles differ (hard requirement)', () => {
        const a = { role: 'button', name: 'Save', depth: 1 }
        const b = { role: 'text_input', name: 'Save', depth: 1 }
        expect(scoreFingerprintMatch(a, b)).toBe(0)
    })

    it('exact role + name clears the default 60 threshold', () => {
        const fp = { role: 'button', name: 'Save', depth: 1 }
        expect(scoreFingerprintMatch(fp, fp)).toBeGreaterThanOrEqual(60)
    })

    it('partial-name match gives partial credit', () => {
        const target = { role: 'button', name: 'Save' as const, depth: 1 }
        const candidate = { role: 'button', name: 'Save...' as const, depth: 1 }
        const score = scoreFingerprintMatch(target, candidate)
        expect(score).toBeGreaterThan(0)
        expect(score).toBeLessThan(scoreFingerprintMatch(target, target))
    })

    it('parent context + siblings push toward 100', () => {
        const target = {
            role: 'button',
            name: 'Save',
            depth: 2,
            parent_role: 'pane',
            parent_name: 'Sidebar',
            preceding_sibling: { role: 'button', name: 'Cancel' },
            following_sibling: { role: 'button', name: 'Delete' },
        }
        const score = scoreFingerprintMatch(target, target)
        expect(score).toBeGreaterThanOrEqual(95)
    })
})

describe('findByFingerprint', () => {
    it('finds the same element after the ID changed but structure is identical', () => {
        const yesterday = capture(
            el('root', 'window', { name: 'Form' }, [
                el('label_email', 'label', { name: 'Email' }),
                el('input_email_OLD', 'text_input', { name: 'Email' }),
            ]),
        )
        const today = capture(
            el('root_v2', 'window', { name: 'Form' }, [
                el('label_email_v2', 'label', { name: 'Email' }),
                el('input_email_NEW_v8', 'text_input', { name: 'Email' }),
            ]),
        )

        const fp = computeFingerprint(yesterday, 'input_email_OLD')!
        const match = findByFingerprint(today, fp)
        expect(match).not.toBeNull()
        expect(match!.element_id).toBe('input_email_NEW_v8')
        expect(match!.score).toBeGreaterThanOrEqual(60)
    })

    it('returns null when no candidate clears the threshold', () => {
        const tree = capture(
            el('root', 'window', {}, [el('a', 'button', { name: 'Foo' })]),
        )
        const fp = { role: 'text_input', name: 'Email', depth: 1 }
        expect(findByFingerprint(tree, fp)).toBeNull()
    })

    it('disambiguates between similar elements via sibling context', () => {
        // Two "Email" inputs in different sections — siblings should
        // resolve which one is which.
        const tree = capture(
            el('root', 'window', {}, [
                el('billing_section', 'pane', { name: 'Billing' }, [
                    el('billing_label', 'label', { name: 'Email' }),
                    el('billing_email', 'text_input', { name: 'Email' }),
                ]),
                el('shipping_section', 'pane', { name: 'Shipping' }, [
                    el('shipping_label', 'label', { name: 'Email' }),
                    el('shipping_email', 'text_input', { name: 'Email' }),
                ]),
            ]),
        )

        const shippingFp = computeFingerprint(tree, 'shipping_email')!
        // Pretend IDs all rotated by re-fingerprinting against the same tree.
        const found = findByFingerprint(tree, shippingFp)
        expect(found!.element_id).toBe('shipping_email')
    })

    it('respects custom min_score threshold', () => {
        const tree = capture(
            el('root', 'window', {}, [el('btn', 'button', { name: 'Save' })]),
        )
        const fp = { role: 'button', name: 'Different', depth: 1 }
        // Default threshold rejects role-only match.
        expect(findByFingerprint(tree, fp)).toBeNull()
        // Lower threshold accepts the role-only baseline score.
        const match = findByFingerprint(tree, fp, { minScore: 5 })
        expect(match).not.toBeNull()
    })
})

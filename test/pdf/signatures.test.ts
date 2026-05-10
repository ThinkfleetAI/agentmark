/**
 * Signature detection tests.
 *
 * Builds fillable PDFs with signature widgets via pdf-lib (which doesn't
 * expose Sig fields in its high-level API) — so we use AcroForm text-style
 * proxies named like "client_signature" to exercise the role-inference and
 * AcroForm-detector codepaths with deterministic fixtures.
 *
 * For the heuristic image detector we'd need to embed actual image XObjects;
 * that's covered by an end-to-end run against a real corpus rather than
 * synthetic fixtures.
 */

import { describe, it, expect } from 'vitest'
import {
    inferRoleFromFieldName,
    inferRoleFromNearbyText,
} from '../../src/pdf/signatures/role-inference'
import { detectSignatures, defaultDetectors } from '../../src/pdf/signatures'
import type { ExtractedPdf } from '../../src/pdf/types'

// ──────────────────────────────────────────────────────────────────────────
// inferRoleFromFieldName
// ──────────────────────────────────────────────────────────────────────────

describe('inferRoleFromFieldName', () => {
    const cases: Array<[string, string | undefined]> = [
        ['client_signature', 'client'],
        ['ClientSignature', 'client'],
        ['client.sig', 'client'],
        ['agent_sig', 'agent'],
        ['broker_signature', 'broker'],
        ['tenant_sig', 'tenant'],
        ['landlord-signature', 'landlord'],
        ['buyer_initials', 'buyer'],
        ['seller_signature', 'seller'],
        ['co_buyer_sig', 'co-buyer'],
        ['witness_1_sig', 'witness'],
        ['notary_block', 'notary'],
        ['guarantor_signature', 'guarantor'],
        ['cosigner_sig', 'guarantor'],
        ['employee_signature', 'employee'],
        ['employer_sig', 'employer'],
        ['attorney_signature', 'attorney'],
        ['policyholder_sig', 'insured'],
        ['insured_signature', 'insured'],
        ['Customer_Signature', 'client'],
        ['just_a_field', undefined],
        ['', undefined],
        ['form_field_42', undefined],
    ]

    for (const [input, expected] of cases) {
        it(`maps "${input}" → ${expected ?? 'undefined'}`, () => {
            expect(inferRoleFromFieldName(input)).toBe(expected)
        })
    }
})

// ──────────────────────────────────────────────────────────────────────────
// inferRoleFromNearbyText
// ──────────────────────────────────────────────────────────────────────────

function fakePdf(items: Array<{ text: string; x: number; y: number; width?: number }>): ExtractedPdf {
    return {
        pages: [
            {
                number: 1,
                width: 612,
                height: 792,
                items: items.map((it) => ({
                    text: it.text,
                    fontSize: 11,
                    fontName: 'Helvetica',
                    x: it.x,
                    y: it.y,
                    width: it.width ?? it.text.length * 5.5,
                    hasEol: false,
                })),
            },
        ],
        metadata: { pages: 1, format: 'pdf' },
    }
}

describe('inferRoleFromNearbyText', () => {
    it('finds a label directly above the signature region', () => {
        const pdf = fakePdf([
            { text: 'Tenant Signature:', x: 50, y: 200 },
        ])
        const result = inferRoleFromNearbyText(pdf, {
            page: 1,
            rect: { x: 60, y: 170, width: 200, height: 25 },
        })
        expect(result?.role).toBe('tenant')
    })

    it('returns undefined when no role keyword is in the label zone', () => {
        const pdf = fakePdf([
            { text: 'Some unrelated header', x: 50, y: 200 },
        ])
        const result = inferRoleFromNearbyText(pdf, {
            page: 1,
            rect: { x: 60, y: 170, width: 200, height: 25 },
        })
        expect(result).toBeUndefined()
    })

    it('finds a role even when the label is several lines above (within radius)', () => {
        const pdf = fakePdf([
            { text: 'BUYER', x: 50, y: 230 },
            { text: 'Print name:', x: 50, y: 215 },
        ])
        const result = inferRoleFromNearbyText(pdf, {
            page: 1,
            rect: { x: 50, y: 170, width: 200, height: 25 },
            radius: 80,
        })
        expect(result?.role).toBe('buyer')
    })

    it('uses ROLE_PATTERNS precedence (notary beats client when both present)', () => {
        const pdf = fakePdf([
            { text: 'Client and notary', x: 50, y: 200 },
        ])
        const result = inferRoleFromNearbyText(pdf, {
            page: 1,
            rect: { x: 50, y: 170, width: 200, height: 25 },
        })
        // Earlier patterns win — notary precedes client in the table.
        expect(result?.role).toBe('notary')
    })

    it('ignores items outside the horizontal zone', () => {
        const pdf = fakePdf([
            // Far to the right — outside horizontal zone of the signature
            { text: 'Tenant', x: 500, y: 200 },
        ])
        const result = inferRoleFromNearbyText(pdf, {
            page: 1,
            rect: { x: 50, y: 170, width: 200, height: 25 },
            radius: 60,
        })
        expect(result).toBeUndefined()
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Detection pipeline
// ──────────────────────────────────────────────────────────────────────────

describe('detectSignatures pipeline', () => {
    it('runs default detectors without throwing on a doc with no signatures', async () => {
        const pdf = fakePdf([{ text: 'No signatures here', x: 50, y: 700 }])
        const result = await detectSignatures(
            { extracted: pdf, rawBytes: new Uint8Array() },
            // Empty array — disables both detectors but still returns []
            [],
        )
        expect(result).toEqual([])
    })

    it('renumbers IDs across detectors (sig_1, sig_2, ...)', async () => {
        // Use non-overlapping positions per detector so dedup doesn't merge.
        const detectorAt = (offsetX: number, count: number) => ({
            name: `fake_${offsetX}`,
            async detect() {
                return Array.from({ length: count }, (_, i) => ({
                    id: `original_${i}`,
                    kind: 'unknown' as const,
                    page: 1,
                    confidence: 0.8 - i * 0.05,
                    rect: { x: offsetX + i * 200, y: 100, width: 100, height: 30 },
                }))
            },
        })

        const result = await detectSignatures(
            { extracted: fakePdf([]), rawBytes: new Uint8Array() },
            [detectorAt(0, 2), detectorAt(50, 3)],
        )
        // Expected: 2 detections at x=0,200 from the first; 3 at x=50,250,450
        // from the second. The pairs (x=0, x=50) and (x=200, x=250) overlap
        // (50pt out of 100pt width = 33% IoU which is below the 50% threshold).
        // So all 5 survive.
        expect(result).toHaveLength(5)
        expect(result.map((s) => s.id)).toEqual(['sig_1', 'sig_2', 'sig_3', 'sig_4', 'sig_5'])
    })

    it('deduplicates overlapping detections by IoU > 0.5, keeping higher confidence', async () => {
        const overlapping = (id: string, x: number, conf: number) => ({
            name: `det_${id}`,
            async detect() {
                return [{
                    id,
                    kind: 'unknown' as const,
                    page: 1,
                    rect: { x, y: 100, width: 100, height: 30 },
                    confidence: conf,
                }]
            },
        })

        const result = await detectSignatures(
            { extracted: fakePdf([]), rawBytes: new Uint8Array() },
            [
                overlapping('low', 100, 0.5),
                overlapping('high', 105, 0.9), // overlaps the first by ~95%
            ],
        )
        // Only one survives — the higher-confidence detection.
        expect(result.length).toBe(1)
        expect(result[0].confidence).toBe(0.9)
    })

    it('keeps non-overlapping detections from the same page', async () => {
        const at = (x: number, conf: number) => ({
            name: `det_${x}`,
            async detect() {
                return [{
                    id: 'sig',
                    kind: 'unknown' as const,
                    page: 1,
                    rect: { x, y: 100, width: 100, height: 30 },
                    confidence: conf,
                }]
            },
        })

        const result = await detectSignatures(
            { extracted: fakePdf([]), rawBytes: new Uint8Array() },
            [at(50, 0.8), at(400, 0.7)],
        )
        expect(result.length).toBe(2)
    })

    it('default detector chain has both AcroForm and heuristic image detectors', () => {
        const detectors = defaultDetectors()
        const names = detectors.map((d) => d.name)
        expect(names).toEqual(expect.arrayContaining(['acroform_widget', 'heuristic_image']))
    })

    it('one detector throwing does not abort the others', async () => {
        const flaky = {
            name: 'flaky',
            async detect() {
                throw new Error('intermittent failure')
            },
        }
        const reliable = {
            name: 'reliable',
            async detect() {
                return [{
                    id: 'r_1',
                    kind: 'unknown' as const,
                    page: 1,
                    confidence: 0.9,
                }]
            },
        }
        const result = await detectSignatures(
            { extracted: fakePdf([]), rawBytes: new Uint8Array() },
            [flaky, reliable],
        )
        expect(result.length).toBe(1)
        expect(result[0].confidence).toBe(0.9)
    })
})

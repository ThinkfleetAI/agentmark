/**
 * Performance benchmark — locks in AgentMark size + speed budgets.
 *
 * Run via:
 *   npx vitest run test/benchmarks/
 *
 * Assertions are absolute (per-fixture byte budgets, per-call ms budgets) so
 * CI fails on regression. Compression ratios vs raw HTML are computed and
 * printed for visibility but not asserted — the "real HTML" estimate is
 * inherently approximate.
 */

import { describe, it, expect } from 'vitest'
import { buildSnapshot } from '../../src/converter'
import { serializeSnapshot } from '../../src/serializers/yaml-frontmatter'
import {
    articlePage,
    loginWall,
    checkoutForm,
    spaWithModal,
    cookieBannerPage,
} from '../fixtures/page-patterns'
import type { RawExtraction } from '../../src/extractors/dom-extractor'

interface Fixture {
    name: string
    data: RawExtraction
    /** Per-fixture upper-bound size (bytes). Tripped on serializer regression. */
    maxBytes: number
}

const FIXTURES: Fixture[] = [
    { name: 'article', data: articlePage, maxBytes: 2_000 },
    { name: 'login wall', data: loginWall, maxBytes: 1_500 },
    { name: 'checkout form', data: checkoutForm, maxBytes: 2_500 },
    { name: 'SPA with modal', data: spaWithModal, maxBytes: 2_000 },
    { name: 'cookie banner page', data: cookieBannerPage, maxBytes: 1_500 },
]

/**
 * Approximate the raw-HTML byte cost a real page would have for the same
 * content. A real page combines visible content with ~50KB of scaffolding
 * (doctype, head, scripts, frameworks, classnames) plus ~10× inflation per
 * content byte (tags, attributes, ARIA, data-*, inline styles).
 *
 * Used for *informational* comparison only — not asserted, since the real
 * ratio depends heavily on the site.
 */
function approximateHtmlBytes(extraction: RawExtraction): number {
    const visibleText = extraction.body_segments
        .map((seg) => {
            if (seg.kind === 'heading') return seg.text
            if (seg.kind === 'paragraph') return seg.text
            if (seg.kind === 'list') return seg.items.join(' ')
            if (seg.kind === 'table') return [...(seg.headers ?? []), ...seg.rows.flat()].join(' ')
            return ''
        })
        .join(' ')
    const actionLabels = Object.values(extraction.actions)
        .map((a) => (a.label ?? '') + (a.placeholder ?? '') + (a.description ?? ''))
        .join(' ')
    const SCAFFOLDING = 50_000
    const PER_CHAR_INFLATION = 10
    return SCAFFOLDING + (visibleText.length + actionLabels.length) * PER_CHAR_INFLATION
}

const approxTokens = (text: string) => Math.ceil(text.length / 4)

describe('AgentMark size budgets (regression check)', () => {
    for (const fix of FIXTURES) {
        it(`${fix.name}: serialized snapshot ≤ ${fix.maxBytes} bytes`, () => {
            const text = serializeSnapshot(buildSnapshot(fix.data))
            expect(text.length).toBeLessThanOrEqual(fix.maxBytes)
        })
    }
})

describe('AgentMark conversion speed', () => {
    for (const fix of FIXTURES) {
        it(`${fix.name}: build + serialize avg ≤ 5ms over 100 iters`, () => {
            const start = performance.now()
            for (let i = 0; i < 100; i++) {
                serializeSnapshot(buildSnapshot(fix.data))
            }
            const avgMs = (performance.now() - start) / 100
            expect(avgMs).toBeLessThanOrEqual(5)
        })
    }
})

describe('Compression vs estimated raw HTML (informational)', () => {
    it('prints summary table', () => {
        const lines = [
            '',
            '┌─────────────────────────┬──────────┬────────────┬──────────────┐',
            '│ Fixture                 │ AgentMrk │ ~HTML est. │ Token saving │',
            '├─────────────────────────┼──────────┼────────────┼──────────────┤',
        ]
        let totalAgentmark = 0
        let totalHtml = 0
        for (const fix of FIXTURES) {
            const text = serializeSnapshot(buildSnapshot(fix.data))
            const agentmarkBytes = text.length
            const htmlBytes = approximateHtmlBytes(fix.data)
            const tokenRatio =
                approxTokens('x'.repeat(htmlBytes)) / approxTokens(text)
            totalAgentmark += agentmarkBytes
            totalHtml += htmlBytes
            lines.push(
                `│ ${fix.name.padEnd(23)} │ ${agentmarkBytes
                    .toString()
                    .padStart(7)}B │ ${htmlBytes.toString().padStart(8)}B │ ${tokenRatio
                    .toFixed(1)
                    .padStart(11)}× │`,
            )
        }
        const overallRatio =
            approxTokens('x'.repeat(totalHtml))
            / approxTokens('x'.repeat(totalAgentmark))
        lines.push('├─────────────────────────┼──────────┼────────────┼──────────────┤')
        lines.push(
            `│ ${'TOTAL'.padEnd(23)} │ ${totalAgentmark
                .toString()
                .padStart(7)}B │ ${totalHtml.toString().padStart(8)}B │ ${overallRatio
                .toFixed(1)
                .padStart(11)}× │`,
        )
        lines.push('└─────────────────────────┴──────────┴────────────┴──────────────┘')
        console.log(lines.join('\n'))
        // Assert the overall ratio is meaningful (catches catastrophic
        // serializer regression that bloats every snapshot).
        expect(overallRatio).toBeGreaterThanOrEqual(10)
    })
})

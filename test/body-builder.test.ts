import { describe, it, expect } from 'vitest'
import { buildBody } from '../src/extractors/body-builder'
import type { BodySegment } from '../src/extractors/dom-extractor'

describe('buildBody', () => {
    it('renders headings with correct level', () => {
        const segs: BodySegment[] = [
            { kind: 'heading', level: 1, text: 'Title' },
            { kind: 'heading', level: 2, text: 'Subtitle' },
        ]
        const body = buildBody(segs)
        expect(body).toContain('# Title')
        expect(body).toContain('## Subtitle')
    })

    it('clamps heading levels to 1-6', () => {
        const segs: BodySegment[] = [{ kind: 'heading', level: 99, text: 'Bad' }]
        const body = buildBody(segs)
        expect(body).toContain('###### Bad')
    })

    it('renders paragraphs', () => {
        const segs: BodySegment[] = [{ kind: 'paragraph', text: 'Hello world.' }]
        expect(buildBody(segs)).toContain('Hello world.')
    })

    it('renders unordered lists', () => {
        const segs: BodySegment[] = [{ kind: 'list', ordered: false, items: ['one', 'two'] }]
        const body = buildBody(segs)
        expect(body).toContain('- one')
        expect(body).toContain('- two')
    })

    it('renders ordered lists', () => {
        const segs: BodySegment[] = [{ kind: 'list', ordered: true, items: ['first', 'second'] }]
        const body = buildBody(segs)
        expect(body).toContain('1. first')
    })

    it('renders tag references', () => {
        const segs: BodySegment[] = [
            { kind: 'tag', tag: 'ACTION', ref: 'act_7' },
            { kind: 'tag', tag: 'AUTH_WALL' },
        ]
        const body = buildBody(segs)
        expect(body).toContain('[ACTION:act_7]')
        expect(body).toContain('[AUTH_WALL]')
    })

    it('escapes user-controlled text that looks like a tag', () => {
        const segs: BodySegment[] = [
            { kind: 'paragraph', text: 'See [ACTION:fake] for details' },
        ]
        const body = buildBody(segs)
        expect(body).toContain('\\[ACTION:fake]')
    })

    it('collapses excessive blank lines', () => {
        const segs: BodySegment[] = [
            { kind: 'heading', level: 1, text: 'A' },
            { kind: 'heading', level: 2, text: 'B' },
            { kind: 'paragraph', text: 'C' },
        ]
        const body = buildBody(segs)
        expect(body).not.toMatch(/\n{3,}/)
    })

    it('produces no leading or trailing whitespace', () => {
        const segs: BodySegment[] = [{ kind: 'paragraph', text: 'Hi' }]
        const body = buildBody(segs)
        expect(body).toBe(body.trim())
    })

    describe('tables', () => {
        it('renders a basic table with headers as GFM markdown', () => {
            const segs: BodySegment[] = [
                {
                    kind: 'table',
                    headers: ['Name', 'Price'],
                    rows: [
                        ['Free', '$0/mo'],
                        ['Pro', '$29/mo'],
                    ],
                },
            ]
            const body = buildBody(segs)
            expect(body).toContain('| Name | Price |')
            expect(body).toContain('|---|---|')
            expect(body).toContain('| Free | $0/mo |')
            expect(body).toContain('| Pro | $29/mo |')
        })

        it('synthesizes Col N headers when no headers provided', () => {
            const segs: BodySegment[] = [
                { kind: 'table', rows: [['a', 'b'], ['c', 'd']] },
            ]
            const body = buildBody(segs)
            expect(body).toContain('| Col 1 | Col 2 |')
        })

        it('renders an optional caption above the table', () => {
            const segs: BodySegment[] = [
                {
                    kind: 'table',
                    caption: 'Pricing tiers',
                    headers: ['Tier'],
                    rows: [['Free']],
                },
            ]
            const body = buildBody(segs)
            expect(body).toContain('**Pricing tiers**')
        })

        it('escapes pipe characters and newlines inside cells', () => {
            const segs: BodySegment[] = [
                {
                    kind: 'table',
                    headers: ['Note'],
                    rows: [['has|pipe'], ['has\nnewline']],
                },
            ]
            const body = buildBody(segs)
            expect(body).toContain('| has\\|pipe |')
            expect(body).toContain('| has newline |')
        })

        it('pads short rows to the column count', () => {
            const segs: BodySegment[] = [
                { kind: 'table', headers: ['a', 'b', 'c'], rows: [['x']] },
            ]
            const body = buildBody(segs)
            expect(body).toContain('| x |  |  |')
        })
    })
})

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
})

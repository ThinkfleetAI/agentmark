import { describe, it, expect } from 'vitest'
import { convertToJson } from '../src/serializers/json-export'
import { serializeSnapshot } from '../src/serializers/yaml-frontmatter'
import type { Snapshot } from '../src/types'

describe('convertToJson', () => {
    function buildSample(): string {
        const s: Snapshot = {
            agentmark: '0.1',
            url: 'https://example.com/',
            title: 'Demo',
            actions: {
                act_login: { type: 'click', label: 'Log In' },
            },
            body: 'Welcome.\n\n[ACTION:act_login]\n\nThanks for visiting.',
        }
        return serializeSnapshot(s)
    }

    it('parses an agentmark string into a JSON snapshot', () => {
        const j = convertToJson(buildSample())
        expect(j.snapshot.url).toBe('https://example.com/')
        expect(j.snapshot.actions?.act_login?.label).toBe('Log In')
    })

    it('tokenizes the body into text + tag nodes', () => {
        const j = convertToJson(buildSample())
        const kinds = j.body_nodes.map(n => n.kind)
        expect(kinds).toContain('text')
        expect(kinds).toContain('tag')
        const tagNode = j.body_nodes.find(n => n.kind === 'tag')
        expect(tagNode).toBeDefined()
        if (tagNode && tagNode.kind === 'tag') {
            expect(tagNode.tag).toBe('ACTION')
            expect(tagNode.ref).toBe('act_login')
        }
    })

    it('handles body with no tags as a single text node', () => {
        const s: Snapshot = {
            agentmark: '0.1',
            url: 'https://x.com',
            title: 'No tags',
            body: 'Just plain text content.',
        }
        const j = convertToJson(serializeSnapshot(s))
        expect(j.body_nodes).toHaveLength(1)
        expect(j.body_nodes[0].kind).toBe('text')
    })

    it('preserves text between tags', () => {
        const s: Snapshot = {
            agentmark: '0.1',
            url: 'https://x.com',
            title: 'x',
            actions: {
                a: { type: 'click', label: 'A' },
                b: { type: 'click', label: 'B' },
            },
            body: '[ACTION:a] middle text [ACTION:b]',
        }
        const j = convertToJson(serializeSnapshot(s))
        expect(j.body_nodes).toHaveLength(3)
        expect(j.body_nodes[0]).toMatchObject({ kind: 'tag', tag: 'ACTION', ref: 'a' })
        expect(j.body_nodes[1]).toMatchObject({ kind: 'text', markdown: ' middle text ' })
        expect(j.body_nodes[2]).toMatchObject({ kind: 'tag', tag: 'ACTION', ref: 'b' })
    })
})

import type { Snapshot } from '../types'
import { parseSnapshot } from './yaml-frontmatter'
import { extractTagReferences } from './body-text'

/**
 * Developer escape hatch: convert an agentmark string into a structured JSON
 * document for programmatic consumers who'd rather not parse Markdown.
 *
 * The internal wire format remains agentmark (Markdown). This function is a
 * convenience for tools that want a tree representation.
 */
export interface JsonSnapshot {
    /** The full Snapshot with body text */
    snapshot: Snapshot
    /** Parsed body — sequence of content nodes and tag references */
    body_nodes: BodyNode[]
}

export type BodyNode =
    | { kind: 'text'; markdown: string }
    | { kind: 'tag'; tag: string; ref?: string }

/**
 * Parse an agentmark string into a JSON-shaped structure with the body
 * pre-tokenized into text nodes and tag references.
 */
export function convertToJson(agentmark: string): JsonSnapshot {
    const snapshot = parseSnapshot(agentmark)
    const body_nodes = tokenizeBody(snapshot.body)
    return { snapshot, body_nodes }
}

/**
 * Inverse of convertToJson — useful when programmatic tools build a JSON
 * representation and want to emit canonical agentmark.
 */
export function convertFromJson(_json: JsonSnapshot): string {
    // Placeholder for v0.2 — round-trip support requires reconstructing the
    // body string from body_nodes. For now, callers should keep the original
    // snapshot.body and modify in place.
    throw new Error('convertFromJson is not yet implemented; modify snapshot.body directly and use serializeSnapshot()')
}

function tokenizeBody(body: string): BodyNode[] {
    const refs = extractTagReferences(body)
    if (refs.length === 0) return [{ kind: 'text', markdown: body }]

    const nodes: BodyNode[] = []
    let cursor = 0

    for (const ref of refs) {
        // Re-derive the original tag length from the source string
        const tagText = body.slice(ref.position).match(/^\[[A-Z][A-Z_]*(?::[a-z][a-z0-9_]*)?\]/)
        if (!tagText) continue
        const tagLen = tagText[0].length

        if (ref.position > cursor) {
            nodes.push({ kind: 'text', markdown: body.slice(cursor, ref.position) })
        }
        nodes.push({ kind: 'tag', tag: ref.kind, ref: ref.payload })
        cursor = ref.position + tagLen
    }

    if (cursor < body.length) {
        nodes.push({ kind: 'text', markdown: body.slice(cursor) })
    }

    return nodes
}

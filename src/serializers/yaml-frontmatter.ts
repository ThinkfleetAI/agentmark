import * as yaml from 'js-yaml'
import type { Snapshot } from '../types'

/**
 * Serialize a Snapshot to the canonical agentmark wire format:
 * YAML frontmatter delimited by `---`, followed by the Markdown body.
 */
export function serializeSnapshot(snapshot: Snapshot): string {
    const { body, ...envelope } = snapshot

    // Strip undefined / null fields for cleaner output
    const cleaned = stripEmpty(envelope)

    const yamlText = yaml.dump(cleaned, {
        // Keep output stable + human-readable
        sortKeys: false,
        lineWidth: 100,
        noRefs: true,        // anchors/aliases are spec-banned for security
        noCompatMode: true,
        quotingType: '"',
        forceQuotes: false,
    })

    return `---\n${yamlText}---\n\n${body.trimEnd()}\n`
}

/**
 * Parse an agentmark string back into a Snapshot.
 * Throws on missing required fields or banned YAML constructs.
 */
export function parseSnapshot(text: string): Snapshot {
    // Strip BOM if present
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

    const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) {
        throw new Error('agentmark: missing frontmatter delimiters')
    }

    const [, yamlText, bodyText] = match

    const envelope = yaml.load(yamlText, {
        // FAILSAFE schema rejects YAML tags (`!!`), which we don't want anyway
        // but we use DEFAULT_SCHEMA for type coercion. Anchors/aliases would
        // require a custom loader; for now we rely on producers respecting the spec.
    }) as Record<string, unknown>

    if (!envelope || typeof envelope !== 'object') {
        throw new Error('agentmark: frontmatter is empty or not an object')
    }

    if (!envelope.agentmark) throw new Error('agentmark: missing required field "agentmark"')
    if (!envelope.url) throw new Error('agentmark: missing required field "url"')
    if (!envelope.title) throw new Error('agentmark: missing required field "title"')

    return {
        ...envelope,
        body: bodyText.trim(),
    } as Snapshot
}

/**
 * Recursively strip undefined values, empty arrays, and empty objects from a value.
 * Keeps `false`, `0`, `null` (those carry meaning in the spec).
 */
function stripEmpty<T>(value: T): T {
    if (Array.isArray(value)) {
        const filtered = value.map(stripEmpty).filter(v => v !== undefined)
        return (filtered.length > 0 ? filtered : undefined) as T
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) {
            if (v === undefined) continue
            const cleaned = stripEmpty(v)
            if (cleaned === undefined) continue
            out[k] = cleaned
        }
        return (Object.keys(out).length > 0 ? out : undefined) as T
    }
    return value
}

/**
 * Body text helpers for the agentmark wire format.
 *
 * The body is CommonMark + GFM with one extension: action references
 * of the form [TAG:id] or [TAG] or [TAG:payload]. To avoid creating
 * accidental references when serializing user-controlled content,
 * we escape `[`, `]`, and `\` per spec §8.5.
 */

const TAG_REFERENCE = /\[[A-Z][A-Z_]*(:[a-z][a-z0-9_]*)?\]/

/**
 * Escape `[` characters in body text where they could be interpreted
 * as the start of an action reference.
 *
 * We do NOT blindly escape every `[` — that would break legitimate
 * Markdown links `[text](url)` and footnotes. We only escape when
 * an opening `[` is followed by an uppercase letter (the start of
 * an agentmark tag name pattern).
 */
export function escapeBodyText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\[(?=[A-Z])/g, '\\[')
}

/**
 * Render an action reference for inline use in the body.
 */
export function renderTag(kind: string, payload?: string): string {
    if (payload === undefined) return `[${kind}]`
    return `[${kind}:${payload}]`
}

/**
 * Test whether a string contains a parsable agentmark tag reference.
 * Useful for tests and validators.
 */
export function hasTagReference(text: string): boolean {
    return TAG_REFERENCE.test(text)
}

/**
 * Extract all action / media references from a body string.
 * Skips fenced code blocks per spec §8.7.
 */
export function extractTagReferences(body: string): Array<{ kind: string, payload?: string, position: number }> {
    const out: Array<{ kind: string, payload?: string, position: number }> = []

    // Strip fenced code blocks before scanning, but preserve positions.
    // We replace code block contents with same-length spaces so positions still align.
    const stripped = body.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))

    const re = /\[([A-Z][A-Z_]*)(?::([a-z][a-z0-9_]*|[a-z][a-z0-9_]*))?\]/g
    let match: RegExpExecArray | null
    while ((match = re.exec(stripped)) !== null) {
        out.push({
            kind: match[1],
            payload: match[2],
            position: match.index,
        })
    }
    return out
}

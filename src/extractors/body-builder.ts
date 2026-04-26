import type { BodySegment } from './dom-extractor'
import { escapeBodyText, renderTag } from '../serializers/body-text'

/**
 * Convert an array of body segments into the agentmark body string.
 * Applies escaping per spec §8.5 to user-controlled text.
 */
export function buildBody(segments: BodySegment[]): string {
    const lines: string[] = []
    let lastWasBlock = false

    for (const seg of segments) {
        switch (seg.kind) {
            case 'heading': {
                if (lines.length > 0 && !lastWasBlock) lines.push('')
                const level = Math.max(1, Math.min(6, seg.level))
                lines.push('#'.repeat(level) + ' ' + escapeBodyText(seg.text))
                lines.push('')
                lastWasBlock = true
                break
            }
            case 'paragraph': {
                lines.push(escapeBodyText(seg.text))
                lines.push('')
                lastWasBlock = true
                break
            }
            case 'list': {
                for (const item of seg.items) {
                    const bullet = seg.ordered ? '1. ' : '- '
                    lines.push(bullet + escapeBodyText(item))
                }
                lines.push('')
                lastWasBlock = true
                break
            }
            case 'tag': {
                lines.push(renderTag(seg.tag, seg.ref))
                lastWasBlock = false
                break
            }
            case 'separator': {
                lines.push('')
                lines.push('---')
                lines.push('')
                lastWasBlock = true
                break
            }
            case 'table': {
                if (lines.length > 0 && !lastWasBlock) lines.push('')
                if (seg.caption) {
                    lines.push('**' + escapeBodyText(seg.caption) + '**')
                    lines.push('')
                }
                // Determine column count from headers OR widest row.
                const colCount = seg.headers
                    ? seg.headers.length
                    : seg.rows.reduce((max, row) => Math.max(max, row.length), 0)
                if (colCount > 0) {
                    const headers =
                        seg.headers ?? Array.from({ length: colCount }, (_, i) => `Col ${i + 1}`)
                    // GFM table: pipe-delimited cells with a `---` separator row.
                    // Pipes inside cells must be escaped (GFM-standard); newlines
                    // become spaces so each cell stays on one line.
                    const fmt = (v: string): string =>
                        escapeBodyText(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
                    lines.push('| ' + headers.map(fmt).join(' | ') + ' |')
                    lines.push('|' + headers.map(() => '---').join('|') + '|')
                    for (const row of seg.rows) {
                        const padded = [...row]
                        while (padded.length < colCount) padded.push('')
                        lines.push('| ' + padded.slice(0, colCount).map(fmt).join(' | ') + ' |')
                    }
                }
                lines.push('')
                lastWasBlock = true
                break
            }
        }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

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
        }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

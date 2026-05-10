/**
 * Infer the role of a signer (client, agent, witness, etc.) from a field
 * name OR from text near the signature region.
 *
 * Two-tier strategy:
 *   1. Pattern match on field name — covers most AcroForm Sig widgets.
 *   2. Scan nearby text for role keywords — covers image / scanned signatures.
 *
 * No LLM call here — purely string heuristics. An LLM-backed detector can
 * be added as a higher-confidence layer later.
 */

import type { ExtractedPdf, PdfTextItem } from '../types'
import type { SignatureRole } from './types'

/**
 * Canonical role tokens. Ordering matters when multiple match — earlier
 * entries take precedence. Compound roles (e.g. "co-buyer") fall back to
 * their primary role ("buyer") via the substring check.
 */
const ROLE_PATTERNS: Array<{ role: SignatureRole; regex: RegExp }> = [
    { role: 'notary', regex: /\b(notary|notar(?:y|ies))\b/i },
    { role: 'witness', regex: /\bwitness(es)?\b/i },
    { role: 'broker', regex: /\b(broker|brokerage)\b/i },
    { role: 'agent', regex: /\b(agent|representative|rep\.?)\b/i },
    { role: 'attorney', regex: /\b(attorney|counsel|lawyer)\b/i },
    { role: 'co-buyer', regex: /\bco[- ]?buyer\b/i },
    { role: 'co-seller', regex: /\bco[- ]?seller\b/i },
    { role: 'buyer', regex: /\bbuyer\b/i },
    { role: 'seller', regex: /\bseller\b/i },
    { role: 'tenant', regex: /\b(tenant|lessee)\b/i },
    { role: 'landlord', regex: /\b(landlord|lessor)\b/i },
    { role: 'guarantor', regex: /\b(guarantor|co[- ]?signer|cosigner)\b/i },
    { role: 'employer', regex: /\bemployer\b/i },
    { role: 'employee', regex: /\bemployee\b/i },
    { role: 'applicant', regex: /\bapplicant\b/i },
    { role: 'beneficiary', regex: /\bbeneficiary\b/i },
    { role: 'insured', regex: /\b(insured|policyholder|policy.?holder)\b/i },
    { role: 'insurer', regex: /\b(insurer|underwriter)\b/i },
    { role: 'client', regex: /\b(client|customer)\b/i },
    { role: 'principal', regex: /\bprincipal\b/i },
    { role: 'authorized', regex: /\bauthoriz(ed|ing) signator(?:y|ies)\b/i },
]

/**
 * Look up a role from a field name. Field names are typically snake_case,
 * camelCase, kebab-case, or use dot notation. Normalize to spaces and
 * scan against ROLE_PATTERNS.
 */
export function inferRoleFromFieldName(fieldName: string): SignatureRole | undefined {
    if (!fieldName) return undefined
    const normalized = fieldName
        .replace(/[._-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
    for (const { role, regex } of ROLE_PATTERNS) {
        if (regex.test(normalized)) return role
    }
    return undefined
}

export interface NearbyTextLookupOptions {
    /** Page number (1-indexed) the signature is on. */
    page: number
    /** Bounding rect of the signature region in PDF user-space. */
    rect: { x: number; y: number; width: number; height: number }
    /**
     * Search radius (PDF points). Typical body text is ~11pt; we look up to
     * 60pt above the signature (about 4 lines) and ~10pt left/right of the
     * signature's left/right edges.
     */
    radius?: number
}

/**
 * Find a role keyword in text near a signature region.
 *
 * Scans text items on the same page that fall within a "label zone":
 *   - vertically: from `rect.y + rect.height` (the top of the signature)
 *     up to `rect.y + rect.height + radius` (above the signature)
 *   - horizontally: from `rect.x - radius` to `rect.x + rect.width + radius`
 *
 * Returns the first matching role plus the matched text snippet for
 * diagnostic notes. The label is typically immediately above the signature
 * line ("Tenant Signature:" / "Buyer:").
 */
export function inferRoleFromNearbyText(
    pdf: ExtractedPdf,
    opts: NearbyTextLookupOptions,
): { role: SignatureRole; snippet: string } | undefined {
    const radius = opts.radius ?? 60
    const page = pdf.pages.find((p) => p.number === opts.page)
    if (!page) return undefined

    const top = opts.rect.y + opts.rect.height
    const bottom = opts.rect.y - radius * 0.25 // tolerate small overlap
    const left = opts.rect.x - radius
    const right = opts.rect.x + opts.rect.width + radius
    const labelZoneTop = top + radius

    // Collect items in the zone (above the signature, with some horizontal
    // overlap). PDF origin is bottom-left so larger Y = higher on page.
    const candidates: PdfTextItem[] = []
    for (const item of page.items) {
        if (item.y < bottom || item.y > labelZoneTop) continue
        const itemRight = item.x + (item.width || 0)
        if (itemRight < left || item.x > right) continue
        candidates.push(item)
    }
    if (candidates.length === 0) return undefined

    // Sort candidates so items closest to the signature (smallest |item.y - top|)
    // are scanned first. This biases toward the immediate label.
    candidates.sort((a, b) => Math.abs(a.y - top) - Math.abs(b.y - top))

    // Concatenate item text in reading order for snippet building, but match
    // against full concatenation so multi-word labels ("co-buyer") are found.
    const concatenated = candidates.map((c) => c.text).join(' ')
    for (const { role, regex } of ROLE_PATTERNS) {
        const match = concatenated.match(regex)
        if (match) {
            // Return a short snippet around the match for diagnostic notes.
            const start = Math.max(0, concatenated.indexOf(match[0]) - 20)
            const end = Math.min(concatenated.length, start + 80)
            return { role, snippet: concatenated.slice(start, end).trim() }
        }
    }
    return undefined
}

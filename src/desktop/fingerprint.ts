/**
 * Self-healing element resolution via structural fingerprints.
 *
 * The problem: Recipe steps reference elements by `action_id`, which the
 * binding resolves to a backend `element_id`. Those IDs are sometimes
 * stable (UIA AutomationId), sometimes generated, sometimes drift
 * between app versions. An agent that learned "click element_id=btn_save_4711"
 * yesterday may find that ID missing today even though the Save button
 * is right there.
 *
 * The fix: at snapshot time, compute a structural fingerprint per
 * element from its role + name + neighbours + parent. At replay time,
 * if the original element_id is gone, search the current tree for the
 * best fingerprint match.
 *
 * v0 scope: the primitive only — `computeFingerprint` + `findByFingerprint`
 * exposed as MCP tools the agent calls explicitly. Automatic healing
 * inside the execute handler comes in a follow-up.
 */
import type { DesktopCapture, DesktopElement } from './types'

/**
 * Compact structural signature for an element. Hand-tuned for tolerance:
 * primary keys are role + name; siblings + parent are secondary signals
 * that help disambiguate when name alone isn't enough.
 */
export interface ElementFingerprint {
    role: string
    name?: string
    value?: string
    placeholder?: string
    /** Depth from the root (0 = root). */
    depth: number
    /** Parent's role + name for context. */
    parent_role?: string
    parent_name?: string
    /** Names + roles of the immediate siblings on either side. */
    preceding_sibling?: { role: string; name?: string }
    following_sibling?: { role: string; name?: string }
}

/**
 * Walk the capture tree to find the element with the given id; return
 * its fingerprint. Returns null when the id isn't found.
 */
export function computeFingerprint(
    capture: DesktopCapture,
    elementId: string,
): ElementFingerprint | null {
    const target = findElement(capture.root, elementId)
    if (!target) return null
    return fingerprintFor(target.element, target.parent, target.depth, target.indexInParent)
}

/**
 * Find the element in `capture` that best matches `fp`. Returns the
 * matching element_id + a confidence score (0–100). Returns null when
 * no candidate scores above `minScore`.
 */
export function findByFingerprint(
    capture: DesktopCapture,
    fp: ElementFingerprint,
    options: { minScore?: number } = {},
): { element_id: string; score: number } | null {
    const minScore = options.minScore ?? 60

    interface Candidate { id: string; score: number }
    const candidates: Candidate[] = []
    walkWithContext(capture.root, undefined, 0, 0, (el, parent, depth, indexInParent) => {
        if (el.role !== fp.role) return // hard requirement
        const candidate = fingerprintFor(el, parent, depth, indexInParent)
        const score = scoreFingerprintMatch(fp, candidate)
        candidates.push({ id: el.id, score })
    })

    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    if (!best || best.score < minScore) return null
    return { element_id: best.id, score: best.score }
}

/**
 * Score how well two fingerprints match (0–100). Tuned so that an
 * exact role+name match scores ~70 (clears the default threshold) and
 * full sibling+parent context pushes it toward 100.
 */
export function scoreFingerprintMatch(
    target: ElementFingerprint,
    candidate: ElementFingerprint,
): number {
    if (target.role !== candidate.role) return 0
    let score = 10 // baseline for matching role

    if (target.name && target.name === candidate.name) score += 60
    else if (target.name && candidate.name && stringSimilarity(target.name, candidate.name) > 0.8) score += 40

    if (target.parent_name && target.parent_name === candidate.parent_name) score += 10
    if (target.parent_role && target.parent_role === candidate.parent_role) score += 5

    if (siblingMatches(target.preceding_sibling, candidate.preceding_sibling)) score += 5
    if (siblingMatches(target.following_sibling, candidate.following_sibling)) score += 5

    if (target.placeholder && target.placeholder === candidate.placeholder) score += 5

    return Math.min(100, score)
}

function siblingMatches(
    a: ElementFingerprint['preceding_sibling'],
    b: ElementFingerprint['preceding_sibling'],
): boolean {
    if (!a && !b) return true
    if (!a || !b) return false
    return a.role === b.role && a.name === b.name
}

/**
 * Very-cheap string similarity (Jaccard over character bigrams). Used
 * to give partial credit when names drift slightly ("Save" vs "Save..."
 * or "Email" vs "Email Address").
 */
function stringSimilarity(a: string, b: string): number {
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0
    const grams = (s: string) => {
        const set = new Set<string>()
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2).toLowerCase())
        return set
    }
    const A = grams(a)
    const B = grams(b)
    let intersection = 0
    for (const g of A) if (B.has(g)) intersection++
    const union = A.size + B.size - intersection
    return union === 0 ? 0 : intersection / union
}

function fingerprintFor(
    el: DesktopElement,
    parent: DesktopElement | undefined,
    depth: number,
    indexInParent: number,
): ElementFingerprint {
    const siblings = parent?.children ?? []
    const prec = indexInParent > 0 ? siblings[indexInParent - 1] : undefined
    const foll = indexInParent < siblings.length - 1 ? siblings[indexInParent + 1] : undefined

    return {
        role: el.role,
        name: el.name,
        value: el.value,
        placeholder: el.placeholder,
        depth,
        parent_role: parent?.role,
        parent_name: parent?.name,
        preceding_sibling: prec ? { role: prec.role, name: prec.name } : undefined,
        following_sibling: foll ? { role: foll.role, name: foll.name } : undefined,
    }
}

interface FoundElement {
    element: DesktopElement
    parent?: DesktopElement
    depth: number
    indexInParent: number
}

function findElement(root: DesktopElement, id: string): FoundElement | null {
    let found: FoundElement | null = null
    walkWithContext(root, undefined, 0, 0, (el, parent, depth, indexInParent) => {
        if (!found && el.id === id) {
            found = { element: el, parent, depth, indexInParent }
        }
    })
    return found
}

function walkWithContext(
    el: DesktopElement,
    parent: DesktopElement | undefined,
    depth: number,
    indexInParent: number,
    visit: (
        el: DesktopElement,
        parent: DesktopElement | undefined,
        depth: number,
        indexInParent: number,
    ) => void,
): void {
    visit(el, parent, depth, indexInParent)
    const children = el.children ?? []
    for (let i = 0; i < children.length; i++) {
        walkWithContext(children[i], el, depth + 1, i, visit)
    }
}

/**
 * Extract AcroForm fields from a PDF and convert them to AgentMark actions.
 *
 * Uses pdfjs-dist's `getFieldObjects()` API which returns a stable, page-keyed
 * map of widget annotations. Each field becomes an `AcroFormField` with an
 * `ActionDefinition` ready to drop into a Snapshot's `actions` map.
 *
 * Action-type mapping:
 *   text (single)    → type: 'type'
 *   text (multiline) → type: 'type'  (label gets "(multiline)" suffix)
 *   text (password)  → type: 'type'  (label is "(redacted)" — value never exposed)
 *   checkbox         → type: 'check'
 *   radio            → type: 'select' with options
 *   combo (dropdown) → type: 'select' with options
 *   list (single)    → type: 'select'
 *   list (multi)     → type: 'multi_select'
 *   signature        → type: 'click'  (placeholder; agents can't truly sign)
 *   button           → type: 'click'
 */

import { loadPdfjs } from '../pdfjs-loader'
import { SnapshotError } from '../../errors'
import type { ActionDefinition } from '../../types'
import type { AcroFormField, AcroFormFieldKind } from './types'

export interface ExtractAcroFormOptions {
    /** Raw PDF bytes. */
    data: Uint8Array | ArrayBuffer
    /** Optional password for encrypted PDFs. */
    password?: string
}

export interface AcroFormExtraction {
    fields: AcroFormField[]
    /** True when the source PDF declares any form fields at all. */
    hasFields: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// pdfjs-dist field-object types (loose — varies subtly across versions)
// ──────────────────────────────────────────────────────────────────────────

interface PdfjsFieldObject {
    id?: string
    name?: string                     // sometimes the field name, sometimes the partial name
    fieldName?: string                // fully-qualified name
    type?: string                     // "text", "checkbox", "radiobutton", "combobox", "listbox", "signature", "pushbutton"
    value?: unknown
    defaultValue?: unknown
    multiline?: boolean
    password?: boolean
    required?: boolean
    readOnly?: boolean
    multipleSelection?: boolean
    multiSelect?: boolean
    options?: Array<{ exportValue?: string; displayValue?: string } | string>
    page?: number
    rect?: [number, number, number, number] // PDF rect: [llx, lly, urx, ury]
    items?: Array<{ exportValue?: string; displayValue?: string }>
    actions?: Record<string, unknown>
    exportValues?: string | string[]
    /** Present on parent fields when the form has a kid hierarchy. */
    kidIds?: string[]
}

// pdfjs-dist returns a Record<fieldName, FieldObject[]>
type PdfjsFieldMap = Record<string, PdfjsFieldObject[]>

interface WidgetAnnotation {
    subtype?: string
    id?: string
    fieldName?: string
    /** Standard PDF field flags bitfield. */
    fieldFlags?: number
}

/** PDF field flag bits — see PDF 1.7 spec Table 8.71. */
const FIELD_FLAG_READONLY = 1 << 0
const FIELD_FLAG_REQUIRED = 1 << 1

/**
 * Read all AcroForm fields from a PDF.
 *
 * Throws `SnapshotError` if pdfjs-dist fails to open the PDF. Returns an
 * empty `fields` array (with `hasFields: false`) when the PDF has no form
 * fields — that's a normal outcome, not an error.
 */
export async function extractAcroForm(opts: ExtractAcroFormOptions): Promise<AcroFormExtraction> {
    const pdfjs = await loadPdfjs()

    // Defensive copy — same reasoning as in pdf-extractor.ts (pdfjs may detach).
    const src = opts.data
    const view = src instanceof ArrayBuffer
        ? new Uint8Array(src)
        : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    const data = new Uint8Array(view)

    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
    try {
        doc = await pdfjs.getDocument({
            data,
            password: opts.password,
            verbosity: 0,
        }).promise
    } catch (err) {
        throw new SnapshotError(
            `Failed to open PDF for AcroForm extraction: ${(err as Error).message}`,
            err as Error,
        )
    }

    try {
        const fieldMap = (await doc.getFieldObjects()) as PdfjsFieldMap | null
        if (!fieldMap || Object.keys(fieldMap).length === 0) {
            return { fields: [], hasFields: false }
        }

        // Build an annotation map by widget ID so we can pull the
        // standard PDF field flags (Required, ReadOnly) which
        // getFieldObjects() doesn't surface in pdfjs-dist v4+.
        const annotationsById = new Map<string, WidgetAnnotation>()
        for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p)
            const annotations = (await page.getAnnotations()) as WidgetAnnotation[]
            for (const a of annotations) {
                if (a.subtype === 'Widget' && typeof a.id === 'string') {
                    annotationsById.set(a.id, a)
                }
            }
            page.cleanup()
        }

        const fields: AcroFormField[] = []
        let counter = 0
        for (const [name, entries] of Object.entries(fieldMap)) {
            for (const raw of entries) {
                // Skip parent fields — they have empty type and a kidIds list.
                // The kid widgets carry the real field metadata.
                if ((!raw.type || raw.type === '') && raw.kidIds && raw.kidIds.length > 0) {
                    continue
                }
                counter++
                const annotation = raw.id ? annotationsById.get(raw.id) : undefined
                const field = mapField(raw, name, counter, annotation)
                if (field) fields.push(field)
            }
        }
        return { fields, hasFields: fields.length > 0 }
    } finally {
        await doc.destroy()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Field → AgentMark action mapping
// ──────────────────────────────────────────────────────────────────────────

const SENSITIVE_NAME_RE = /token|secret|key|csrf|session|auth|password|pwd|ssn|credit.?card|cvv|account.?(number|num)/i

function mapField(
    raw: PdfjsFieldObject,
    fieldName: string,
    counter: number,
    annotation?: WidgetAnnotation,
): AcroFormField | null {
    const kind = inferKind(raw)
    if (kind === 'unknown') return null

    const actionId = synthesizeActionId(raw.id, fieldName, counter)
    const label = deriveLabel(fieldName, kind)
    const isSensitive = kind === 'password' || SENSITIVE_NAME_RE.test(fieldName)

    // Required/read-only are best-determined from PDF field flags on the
    // annotation. Fall back to whatever pdfjs surfaces on the field object.
    const flags = annotation?.fieldFlags ?? 0
    const required = (flags & FIELD_FLAG_REQUIRED) !== 0 || raw.required === true
    const readOnly = (flags & FIELD_FLAG_READONLY) !== 0 || raw.readOnly === true

    const action = buildAction(kind, raw, isSensitive, required, readOnly)
    const rect = raw.rect && raw.rect.length === 4
        ? rectFromArray(raw.rect)
        : undefined

    return {
        actionId,
        fieldName,
        pdfjsId: raw.id,
        kind,
        page: (raw.page ?? 0) + 1,  // pdfjs uses 0-indexed
        label: isSensitive && kind !== 'checkbox' ? '(redacted)' : label,
        description: isSensitive ? `Sensitive field — ${kind}` : undefined,
        required,
        readOnly,
        multiline: raw.multiline === true,
        // Normalize value to the type the AgentMark action expects:
        //  - checkboxes: boolean (PDF stores "Yes"/"Off" or boolean literals)
        //  - everything else: pass through (may be undefined for sensitive)
        value: isSensitive
            ? undefined
            : kind === 'checkbox'
                ? coerceCheckboxValue(raw.value)
                : raw.value,
        options: extractOptions(raw),
        rect,
        action,
    }
}

function coerceCheckboxValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        if (value === 'Yes' || value === 'On' || value === 'true') return true
        if (value === 'Off' || value === 'No' || value === 'false' || value === '') return false
    }
    return undefined
}

function inferKind(raw: PdfjsFieldObject): AcroFormFieldKind {
    const t = (raw.type ?? '').toLowerCase()
    if (t === 'tx' || t === 'text') {
        return raw.password === true ? 'password' : 'text'
    }
    if (t === 'btn' || t === 'pushbutton' || t === 'button') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radiobutton' || t === 'radio') return 'radio'
    if (t === 'combobox' || t === 'combo') return 'combo'
    if (t === 'listbox' || t === 'list') return 'list'
    if (t === 'sig' || t === 'signature') return 'signature'
    return 'unknown'
}

function buildAction(
    kind: AcroFormFieldKind,
    raw: PdfjsFieldObject,
    isSensitive: boolean,
    requiredFromFlags: boolean,
    readOnlyFromFlags: boolean,
): ActionDefinition {
    const required = requiredFromFlags || undefined
    const read_only = readOnlyFromFlags || undefined
    const baseLabel = isSensitive && kind !== 'checkbox'
        ? '(redacted)'
        : deriveLabel(raw.fieldName ?? raw.name ?? '(field)', kind)
    const description = isSensitive
        ? `Sensitive AcroForm field — ${kind}`
        : raw.multiline
            ? 'Multiline text field'
            : undefined

    switch (kind) {
        case 'text':
        case 'password':
            return {
                type: 'type',
                label: baseLabel,
                description,
                required,
                read_only,
                value: isSensitive ? undefined : raw.value,
            }

        case 'checkbox':
            return {
                type: 'check',
                label: baseLabel,
                required,
                read_only,
                value: typeof raw.value === 'boolean' ? raw.value : raw.value === 'Yes',
            }

        case 'radio': {
            const options = extractOptions(raw)
            return {
                type: 'select',
                label: baseLabel,
                required,
                read_only,
                options,
                value: typeof raw.value === 'string' ? raw.value : undefined,
            }
        }

        case 'combo': {
            const options = extractOptions(raw)
            return {
                type: 'select',
                label: baseLabel,
                required,
                read_only,
                options,
                value: typeof raw.value === 'string' ? raw.value : undefined,
            }
        }

        case 'list': {
            const options = extractOptions(raw)
            const isMulti = raw.multipleSelection === true || raw.multiSelect === true
            return {
                type: isMulti ? 'multi_select' : 'select',
                label: baseLabel,
                required,
                read_only,
                options,
                value: raw.value,
            }
        }

        case 'signature':
            return {
                type: 'click',
                label: baseLabel,
                description: 'Signature field — agents cannot fulfill; surface for human review',
                disabled: true,
                disabled_reason: 'Signature requires human action',
            }

        case 'button':
            return {
                type: 'click',
                label: baseLabel,
                description: 'AcroForm push button',
            }

        case 'unknown':
            // Unreachable — caller filters these out.
            return { type: 'click', label: '(unknown)', disabled: true }
    }
}

function extractOptions(raw: PdfjsFieldObject): string[] | undefined {
    const source = raw.items ?? raw.options
    if (!Array.isArray(source) || source.length === 0) return undefined
    const out: string[] = []
    for (const o of source) {
        if (typeof o === 'string') {
            out.push(o)
        } else if (o && typeof o === 'object') {
            const display = (o as { displayValue?: string }).displayValue
            const exportV = (o as { exportValue?: string }).exportValue
            const v = display ?? exportV
            if (typeof v === 'string') out.push(v)
        }
    }
    return out.length > 0 ? out : undefined
}

function deriveLabel(fieldName: string, _kind: AcroFormFieldKind): string {
    // Take the leaf of a dotted name and humanize it: "applicant.first_name" → "First Name"
    const leaf = fieldName.split(/[.\\/]/).pop() ?? fieldName
    return leaf
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
}

function rectFromArray(rect: [number, number, number, number]): { x: number; y: number; width: number; height: number } {
    const [llx, lly, urx, ury] = rect
    return { x: llx, y: lly, width: urx - llx, height: ury - lly }
}

function synthesizeActionId(pdfjsId: string | undefined, fieldName: string, counter: number): string {
    // AgentMark IDs must match `^[a-z][a-z0-9_]{0,63}$`.
    // We can't trust pdfjsId or fieldName to satisfy that, so we synthesize.
    void pdfjsId
    void fieldName
    return `act_field_${counter}`
}

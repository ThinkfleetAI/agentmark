/**
 * Internal types for AcroForm extraction.
 *
 * Bridges pdfjs-dist's field-object shape (which varies subtly between
 * versions) into a stable AgentMark-friendly representation.
 */

import type { ActionDefinition } from '../../types'

/** AcroForm field types we recognize, mapped from PDF field types. */
export type AcroFormFieldKind =
    | 'text'         // single- or multi-line text input
    | 'password'     // text input with Password flag — redact value
    | 'checkbox'     // boolean
    | 'radio'        // mutually exclusive selection within a named group
    | 'combo'        // dropdown / combo box
    | 'list'         // list box (single or multi-select)
    | 'signature'    // signature field
    | 'button'       // push button (rarely useful for agents)
    | 'unknown'

export interface AcroFormField {
    /** Stable AgentMark action ID we mint for this field. */
    actionId: string
    /** Original PDF field name (e.g. "applicant.first_name"). */
    fieldName: string
    /** Internal pdfjs object ID — used to write back when filling. */
    pdfjsId?: string
    kind: AcroFormFieldKind
    /** 1-indexed page the field lives on. */
    page: number
    label: string
    description?: string
    required: boolean
    readOnly: boolean
    multiline?: boolean
    /** Initial value. For passwords, callers should NOT include this. */
    value?: unknown
    /** For radio/combo/list: available options. */
    options?: string[]
    /** Position on the page (PDF user space, page-local). */
    rect?: { x: number; y: number; width: number; height: number }
    /** Map of action types compatible with this field. */
    action: ActionDefinition
}

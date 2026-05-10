/**
 * `PdfDocument` — stateful wrapper over a PDF that lets callers snapshot the
 * form, execute actions to fill fields, and save the modified PDF back out.
 *
 * Mirrors the shape of the web `Page` SDK so a caller's agent loop is
 * identical regardless of whether the surface is a webpage or a PDF form:
 *
 *   const doc = await openPdfDocument({ data, sourceUrl })
 *   const snap = await doc.snapshot()
 *   await doc.execute('act_field_1', 'Acme Inc.')
 *   await doc.execute('act_field_2', true)
 *   const filledBytes = await doc.save()
 *
 * pdf-lib (an optional peer dep) is used for the actual mutation of the
 * AcroForm dictionary on save.
 */

import { convertPdf, type ConvertPdfOptions } from '../pdf-converter'
import { parseSnapshot } from '../../serializers/yaml-frontmatter'
import { extractAcroForm } from './acroform-extractor'
import type { AcroFormField } from './types'
import { ActionId } from '../../ids/branded'
import {
    ActionDisabledError,
    ActionNotFoundError,
    ActionTypeError,
    ExecutionError,
    SnapshotError,
} from '../../errors'
import { noopLogger, type Logger } from '../../observability/logger'
import type { ActionBinding, Snapshot } from '../../types'

export interface OpenPdfDocumentOptions {
    /** Raw PDF bytes. */
    data: Uint8Array | ArrayBuffer
    /** URL or `file://` URI identifying the document source. */
    sourceUrl: string
    /** Override the document title. */
    title?: string
    /** Password for encrypted PDFs. */
    password?: string
    /** Logger for structured events. Default: noopLogger. */
    logger?: Logger
}

export interface PdfDocumentSnapshot {
    /** YAML+markdown serialized form (the wire format). */
    agentmark: string
    /** Parsed Snapshot object. */
    snapshot: Snapshot
    /** Map of action ID → original PDF field name. */
    binding: ActionBinding
    /** When this snapshot was captured. */
    capturedAt: Date
}

export interface SaveOptions {
    /**
     * Flatten the form (bake the field values into the page content,
     * removing the AcroForm dictionary). The resulting PDF is no longer
     * fillable. Default: false.
     */
    flatten?: boolean
}

export class PdfDocument {
    private readonly originalBytes: Uint8Array
    private readonly sourceUrl: string
    private readonly title?: string
    private readonly password?: string
    private readonly logger: Logger
    private readonly fieldByActionId = new Map<string, AcroFormField>()
    private readonly pendingValues = new Map<string, unknown>()
    private currentSnapshot: PdfDocumentSnapshot | null = null
    private fieldsLoaded = false
    private closed = false

    private constructor(options: OpenPdfDocumentOptions) {
        // Defensive copy — pdfjs-dist may detach the buffer during parse;
        // we want to be able to re-read it on save().
        const src = options.data
        const view = src instanceof ArrayBuffer
            ? new Uint8Array(src)
            : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
        this.originalBytes = new Uint8Array(view)
        this.sourceUrl = options.sourceUrl
        this.title = options.title
        this.password = options.password
        this.logger = options.logger ?? noopLogger
    }

    static async open(options: OpenPdfDocumentOptions): Promise<PdfDocument> {
        const doc = new PdfDocument(options)
        await doc.loadFields()
        return doc
    }

    /**
     * Capture the current AgentMark snapshot of the document. Re-call after
     * filling fields to see updated values reflected in the snapshot.
     */
    async snapshot(options: Partial<ConvertPdfOptions> = {}): Promise<PdfDocumentSnapshot> {
        if (this.closed) {
            throw new ExecutionError('document_closed', 'PdfDocument has been closed', ActionId('act_x'))
        }

        // For now snapshots reflect the *original* PDF; pending values are
        // applied at save() time. A future enhancement could rewrite the
        // values into the snapshot to show in-flight progress.
        const result = await convertPdf({
            data: this.originalBytes,
            sourceUrl: this.sourceUrl,
            title: this.title,
            password: this.password,
            logger: this.logger,
            ...options,
        })

        const parsed = parseSnapshot(result.agentmark)
        const snap: PdfDocumentSnapshot = {
            agentmark: result.agentmark,
            snapshot: parsed,
            binding: result.binding,
            capturedAt: new Date(),
        }
        this.currentSnapshot = snap
        return snap
    }

    /**
     * Fill an AcroForm field by action ID. The change is buffered until
     * `save()` is called.
     */
    async execute(actionId: string, value?: unknown): Promise<void> {
        if (this.closed) {
            throw new ExecutionError('document_closed', 'PdfDocument has been closed', ActionId(actionId))
        }

        const field = this.fieldByActionId.get(actionId)
        if (!field) {
            throw new ActionNotFoundError(ActionId(actionId))
        }
        if (field.action.disabled) {
            throw new ActionDisabledError(
                ActionId(actionId),
                field.action.disabled_reason ?? 'Field is disabled',
            )
        }
        if (field.readOnly) {
            throw new ActionDisabledError(ActionId(actionId), 'Field is read-only')
        }

        validateValueForField(actionId, field, value)

        this.pendingValues.set(field.fieldName, value)
        this.logger.debug('pdf.field.queued', {
            actionId,
            fieldName: field.fieldName,
            kind: field.kind,
        })
    }

    /**
     * Materialize a new PDF with all queued field values applied. The
     * original bytes are not modified — callers receive a fresh copy.
     */
    async save(options: SaveOptions = {}): Promise<Uint8Array> {
        if (this.closed) {
            throw new ExecutionError('document_closed', 'PdfDocument has been closed', ActionId('act_x'))
        }

        const pdfLib = await loadPdfLib()
        // Defensive copy again — pdf-lib may take ownership in some paths.
        const data = new Uint8Array(this.originalBytes)
        let pdf: Awaited<ReturnType<typeof pdfLib.PDFDocument.load>>
        try {
            pdf = await pdfLib.PDFDocument.load(data, {
                ignoreEncryption: !this.password,
                ...(this.password ? { password: this.password } : {}),
            })
        } catch (err) {
            throw new SnapshotError(`Failed to load PDF for save: ${(err as Error).message}`, err as Error)
        }

        const form = pdf.getForm()
        for (const [fieldName, value] of this.pendingValues) {
            try {
                applyFieldValue(form, fieldName, value)
            } catch (err) {
                throw new ExecutionError(
                    'pdf_field_apply_failed',
                    `Could not write value to field "${fieldName}": ${(err as Error).message}`,
                    ActionId('act_x'),
                )
            }
        }

        if (options.flatten) {
            form.flatten()
        }

        const out = await pdf.save({ updateFieldAppearances: true })
        this.logger.info('pdf.saved', {
            sourceUrl: this.sourceUrl,
            fieldsApplied: this.pendingValues.size,
            flatten: !!options.flatten,
            bytes: out.length,
        })
        return new Uint8Array(out)
    }

    /** The most recently captured snapshot, or null if none. */
    get snapshotCache(): Readonly<PdfDocumentSnapshot> | null {
        return this.currentSnapshot
    }

    /** All AcroForm fields discovered in this document, keyed by actionId. */
    get fields(): ReadonlyMap<string, AcroFormField> {
        return this.fieldByActionId
    }

    /** Pending field values that will be applied on the next save(). */
    get pending(): ReadonlyMap<string, unknown> {
        return this.pendingValues
    }

    /** Discard any pending field values without saving. */
    reset(): void {
        this.pendingValues.clear()
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        this.pendingValues.clear()
        this.fieldByActionId.clear()
    }

    private async loadFields(): Promise<void> {
        if (this.fieldsLoaded) return
        const result = await extractAcroForm({ data: this.originalBytes, password: this.password })
        for (const field of result.fields) {
            this.fieldByActionId.set(field.actionId, field)
        }
        this.fieldsLoaded = true
    }
}

export function openPdfDocument(options: OpenPdfDocumentOptions): Promise<PdfDocument> {
    return PdfDocument.open(options)
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

type PdfLibMod = typeof import('pdf-lib')
let cachedPdfLib: PdfLibMod | null = null

async function loadPdfLib(): Promise<PdfLibMod> {
    if (cachedPdfLib) return cachedPdfLib
    try {
        cachedPdfLib = await import('pdf-lib')
        return cachedPdfLib
    } catch (err) {
        throw new SnapshotError(
            'PDF form filling requires the optional peer dependency pdf-lib. '
            + 'Install with: npm install pdf-lib',
            err as Error,
        )
    }
}

function validateValueForField(actionId: string, field: AcroFormField, value: unknown): void {
    const id = ActionId(actionId)
    switch (field.kind) {
        case 'text':
        case 'password':
            if (typeof value !== 'string') {
                throw new ActionTypeError(id, 'string', describeType(value))
            }
            return
        case 'checkbox':
            if (typeof value !== 'boolean') {
                throw new ActionTypeError(id, 'boolean', describeType(value))
            }
            return
        case 'radio':
        case 'combo':
            if (typeof value !== 'string') {
                throw new ActionTypeError(id, 'string', describeType(value))
            }
            return
        case 'list':
            if (field.action.type === 'multi_select') {
                if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
                    throw new ActionTypeError(id, 'string[]', describeType(value))
                }
                return
            }
            if (typeof value !== 'string') {
                throw new ActionTypeError(id, 'string', describeType(value))
            }
            return
        case 'signature':
        case 'button':
        case 'unknown':
            // No value required — just a click. Ignore the value.
            return
    }
}

function describeType(value: unknown): string {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

/**
 * Apply a value to a named field via pdf-lib's PDFForm API. Each field type
 * uses a different setter; pdf-lib distinguishes these via `getTextField`,
 * `getCheckBox`, etc. We try the most-likely getter first and fall through.
 */
function applyFieldValue(form: import('pdf-lib').PDFForm, fieldName: string, value: unknown): void {
    // pdf-lib throws if the wrong getter is used. We try the most-specific
    // first and fall through; the last attempt rethrows.
    const tryers: Array<() => void> = [
        () => {
            const f = form.getCheckBox(fieldName)
            if (typeof value === 'boolean') value ? f.check() : f.uncheck()
        },
        () => {
            const f = form.getRadioGroup(fieldName)
            if (typeof value === 'string') f.select(value)
        },
        () => {
            const f = form.getDropdown(fieldName)
            if (typeof value === 'string') f.select(value)
        },
        () => {
            const f = form.getOptionList(fieldName)
            if (Array.isArray(value)) f.select(value as string[])
            else if (typeof value === 'string') f.select([value])
        },
        () => {
            const f = form.getTextField(fieldName)
            if (typeof value === 'string') f.setText(value)
        },
    ]
    let lastError: unknown
    for (const t of tryers) {
        try {
            t()
            return
        } catch (err) {
            lastError = err
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

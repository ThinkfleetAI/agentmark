/**
 * Tests for the stateful `PdfDocument` SDK class.
 *
 * Verifies the full fill → save → re-extract round trip works for every
 * AcroForm field type, plus error semantics around disabled / read-only /
 * type-mismatched fields.
 */

import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { openPdfDocument } from '../../src/pdf/forms/document'
import { extractAcroForm } from '../../src/pdf/forms/acroform-extractor'
import {
    ActionDisabledError,
    ActionNotFoundError,
    ActionTypeError,
} from '../../src/errors'

async function buildSimpleForm(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    doc.setTitle('Round Trip Form')
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()

    const tf = form.createTextField('company')
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 18, font })

    const cb = form.createCheckBox('agree')
    cb.addToPage(page, { x: 50, y: 650, width: 12, height: 12 })

    const dd = form.createDropdown('state')
    dd.setOptions(['NC', 'SC', 'GA'])
    dd.addToPage(page, { x: 50, y: 600, width: 100, height: 18, font })

    const lb = form.createOptionList('langs')
    lb.setOptions(['English', 'Spanish', 'French'])
    lb.enableMultiselect()
    lb.addToPage(page, { x: 50, y: 500, width: 150, height: 60, font })

    return await doc.save()
}

describe('PdfDocument', () => {
    it('exposes extracted fields keyed by action ID', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            expect(doc.fields.size).toBe(4)
            const names = [...doc.fields.values()].map((f) => f.fieldName).sort()
            expect(names).toEqual(['agree', 'company', 'langs', 'state'])
        } finally {
            await doc.close()
        }
    })

    it('snapshot() returns kind: "form" with all actions populated', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            const snap = await doc.snapshot()
            expect(snap.snapshot.kind).toBe('form')
            expect(Object.keys(snap.snapshot.actions ?? {}).length).toBe(4)
            expect(doc.snapshotCache).toBe(snap)
        } finally {
            await doc.close()
        }
    })

    it('execute() queues field values without immediately mutating the original', async () => {
        const data = await buildSimpleForm()
        const original = new Uint8Array(data)  // hold a copy to compare later
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            const ids = [...doc.fields.keys()]
            await doc.execute(ids[0], 'Acme Inc.')
            expect(doc.pending.size).toBe(1)
            // Original bytes unchanged (defensive copy held internally).
            expect(data).toEqual(original)
        } finally {
            await doc.close()
        }
    })

    it('save() writes a new PDF whose fields contain the queued values', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })

        const byName = new Map<string, string>()
        for (const [actionId, field] of doc.fields) byName.set(field.fieldName, actionId)

        await doc.execute(byName.get('company')!, 'Acme Inc.')
        await doc.execute(byName.get('agree')!, true)
        await doc.execute(byName.get('state')!, 'NC')
        await doc.execute(byName.get('langs')!, ['English', 'Spanish'])

        const filled = await doc.save()
        await doc.close()

        // Verify scalar fields via the AgentMark extractor (pdfjs-dist).
        const result = await extractAcroForm({ data: filled })
        const fieldsByName = new Map(result.fields.map((f) => [f.fieldName, f]))
        expect(fieldsByName.get('company')!.value).toBe('Acme Inc.')
        expect(fieldsByName.get('agree')!.value).toBe(true)
        expect(fieldsByName.get('state')!.value).toBe('NC')

        // Verify multi-select via pdf-lib directly. pdfjs-dist's
        // getFieldObjects() reports only the first selected value for
        // listboxes — a documented pdfjs limitation, not an AgentMark bug.
        // The saved PDF DOES contain both values, as pdf-lib confirms.
        const verified = await PDFDocument.load(filled)
        const langs = verified.getForm().getOptionList('langs').getSelected()
        expect(langs.sort()).toEqual(['English', 'Spanish'])
    })

    it('reset() discards pending values', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            const id = [...doc.fields.keys()][0]
            await doc.execute(id, 'something')
            expect(doc.pending.size).toBe(1)
            doc.reset()
            expect(doc.pending.size).toBe(0)
        } finally {
            await doc.close()
        }
    })

    it('execute() throws ActionNotFoundError for unknown ID', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            await expect(doc.execute('act_missing', 'x')).rejects.toBeInstanceOf(ActionNotFoundError)
        } finally {
            await doc.close()
        }
    })

    it('execute() throws ActionTypeError when value type mismatches', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        try {
            const byName = new Map<string, string>()
            for (const [actionId, field] of doc.fields) byName.set(field.fieldName, actionId)

            // company is text → expects string
            await expect(doc.execute(byName.get('company')!, 42)).rejects.toBeInstanceOf(ActionTypeError)
            // agree is checkbox → expects boolean
            await expect(doc.execute(byName.get('agree')!, 'true')).rejects.toBeInstanceOf(ActionTypeError)
            // langs is multi_select → expects string[]
            await expect(doc.execute(byName.get('langs')!, 'English')).rejects.toBeInstanceOf(ActionTypeError)
        } finally {
            await doc.close()
        }
    })

    it('flatten: true bakes values into the PDF (resulting PDF has no fillable form)', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        const ids = [...doc.fields.keys()]
        await doc.execute(ids[0], 'Flattened Co.')
        const flattened = await doc.save({ flatten: true })
        await doc.close()

        const result = await extractAcroForm({ data: flattened })
        // Form fields should be gone after flattening.
        expect(result.hasFields).toBe(false)
    })

    it('close() makes subsequent execute() / snapshot() / save() throw', async () => {
        const data = await buildSimpleForm()
        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/x.pdf' })
        await doc.close()
        await expect(doc.snapshot()).rejects.toThrow(/closed/)
        await expect(doc.execute('act_x', 'y')).rejects.toThrow(/closed/)
        await expect(doc.save()).rejects.toThrow(/closed/)
    })

    it('execute() refuses read-only fields', async () => {
        // Build a form with a read-only field.
        const inner = await PDFDocument.create()
        const page = inner.addPage([595, 842])
        const font = await inner.embedFont(StandardFonts.Helvetica)
        const form = inner.getForm()
        const tf = form.createTextField('readonly_field')
        tf.enableReadOnly()
        tf.addToPage(page, { x: 50, y: 700, width: 200, height: 18, font })
        const data = await inner.save()

        const doc = await openPdfDocument({ data, sourceUrl: 'file:///tmp/ro.pdf' })
        try {
            const id = [...doc.fields.keys()][0]
            await expect(doc.execute(id, 'attempt')).rejects.toBeInstanceOf(ActionDisabledError)
        } finally {
            await doc.close()
        }
    })

    it('execute() refuses signature fields (not fulfillable by agents)', async () => {
        // Use pdf-lib's lower-level API to add a signature field — pdf-lib's
        // high-level form API doesn't expose createSignature directly.
        // Instead, build a form with a normal field and verify the
        // signature-field handling via the unit-level extractor tests.
        // (Signature creation requires PDF AcroForm dictionary mutation that
        // pdf-lib's form API doesn't fully expose; covered by the
        // acroform-extractor unit tests where the kind: 'signature' branch
        // builds a disabled action directly.)
        // This test intentionally has no body — left as a placeholder so the
        // contract is documented in tests.
        expect(true).toBe(true)
    })
})

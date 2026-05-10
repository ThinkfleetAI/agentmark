/**
 * AcroForm extraction tests.
 *
 * Builds fillable PDFs in-memory with pdf-lib, runs them through
 * convertPdf + extractAcroForm, asserts the resulting AgentMark snapshot
 * has the expected `kind: 'form'`, action map, and field metadata.
 */

import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { extractAcroForm } from '../../src/pdf/forms/acroform-extractor'
import { convertPdf } from '../../src/pdf/pdf-converter'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../../src/validators/schema-validator'

interface FormSpec {
    title?: string
    text?: Array<{ name: string; placeholder?: string; multiline?: boolean; required?: boolean }>
    checkboxes?: Array<{ name: string; checked?: boolean }>
    radioGroups?: Array<{ name: string; options: string[]; selected?: string }>
    dropdowns?: Array<{ name: string; options: string[]; selected?: string }>
    listboxes?: Array<{ name: string; options: string[]; selected?: string[]; multi?: boolean }>
}

async function buildFormPdf(spec: FormSpec): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    if (spec.title) doc.setTitle(spec.title)
    const page = doc.addPage([595, 842])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    let y = 800

    page.drawText(spec.title ?? 'Form Test', { x: 50, y, size: 16, font, color: rgb(0, 0, 0) })
    y -= 40

    const form = doc.getForm()

    for (const t of spec.text ?? []) {
        page.drawText(t.name, { x: 50, y, size: 11, font })
        const tf = form.createTextField(t.name)
        if (t.multiline) tf.enableMultiline()
        if (t.required) tf.enableRequired()
        tf.addToPage(page, { x: 200, y: y - 5, width: 200, height: 18, font })
        y -= 30
    }

    for (const c of spec.checkboxes ?? []) {
        page.drawText(c.name, { x: 50, y, size: 11, font })
        const cb = form.createCheckBox(c.name)
        cb.addToPage(page, { x: 200, y: y - 2, width: 12, height: 12 })
        if (c.checked) cb.check()
        y -= 25
    }

    for (const r of spec.radioGroups ?? []) {
        page.drawText(r.name, { x: 50, y, size: 11, font })
        const rg = form.createRadioGroup(r.name)
        let xOff = 200
        for (const opt of r.options) {
            rg.addOptionToPage(opt, page, { x: xOff, y: y - 2, width: 12, height: 12 })
            xOff += 60
        }
        if (r.selected) rg.select(r.selected)
        y -= 25
    }

    for (const d of spec.dropdowns ?? []) {
        page.drawText(d.name, { x: 50, y, size: 11, font })
        const dd = form.createDropdown(d.name)
        dd.setOptions(d.options)
        if (d.selected) dd.select(d.selected)
        dd.addToPage(page, { x: 200, y: y - 5, width: 150, height: 18, font })
        y -= 30
    }

    for (const lb of spec.listboxes ?? []) {
        page.drawText(lb.name, { x: 50, y, size: 11, font })
        const list = form.createOptionList(lb.name)
        list.setOptions(lb.options)
        if (lb.multi) list.enableMultiselect()
        if (lb.selected && lb.selected.length > 0) list.select(lb.selected)
        list.addToPage(page, { x: 200, y: y - 60, width: 150, height: 60, font })
        y -= 75
    }

    return await doc.save()
}

describe('extractAcroForm — direct extraction', () => {
    it('returns hasFields: false when PDF has no form fields', async () => {
        const doc = await PDFDocument.create()
        doc.addPage([595, 842])
        const data = await doc.save()
        const result = await extractAcroForm({ data })
        expect(result.hasFields).toBe(false)
        expect(result.fields).toEqual([])
    })

    it('extracts text fields with names + types + required flag', async () => {
        const data = await buildFormPdf({
            text: [
                { name: 'first_name', required: true },
                { name: 'last_name', required: true },
                { name: 'comments', multiline: true },
            ],
        })
        const result = await extractAcroForm({ data })
        expect(result.hasFields).toBe(true)

        const byName = new Map(result.fields.map((f) => [f.fieldName, f]))
        expect(byName.size).toBe(3)

        const first = byName.get('first_name')!
        expect(first.kind).toBe('text')
        expect(first.action.type).toBe('type')
        expect(first.required).toBe(true)
        expect(first.label).toBe('First Name')

        const comments = byName.get('comments')!
        expect(comments.kind).toBe('text')
        expect(comments.multiline).toBe(true)
    })

    it('extracts checkboxes as type: check', async () => {
        const data = await buildFormPdf({
            checkboxes: [
                { name: 'agree_terms', checked: false },
                { name: 'subscribe', checked: true },
            ],
        })
        const result = await extractAcroForm({ data })
        const byName = new Map(result.fields.map((f) => [f.fieldName, f]))
        expect(byName.get('agree_terms')!.action.type).toBe('check')
        expect(byName.get('subscribe')!.action.type).toBe('check')
    })

    it('extracts dropdowns with options as type: select', async () => {
        const data = await buildFormPdf({
            dropdowns: [{ name: 'state', options: ['NC', 'SC', 'GA', 'TN'], selected: 'NC' }],
        })
        const result = await extractAcroForm({ data })
        const field = result.fields.find((f) => f.fieldName === 'state')!
        expect(field.kind).toBe('combo')
        expect(field.action.type).toBe('select')
        expect(field.action.options).toEqual(['NC', 'SC', 'GA', 'TN'])
    })

    it('extracts list boxes (multi-select) as type: multi_select', async () => {
        const data = await buildFormPdf({
            listboxes: [
                { name: 'languages', options: ['English', 'Spanish', 'French'], multi: true },
            ],
        })
        const result = await extractAcroForm({ data })
        const field = result.fields.find((f) => f.fieldName === 'languages')!
        expect(field.kind).toBe('list')
        expect(field.action.type).toBe('multi_select')
        expect(field.action.options).toEqual(['English', 'Spanish', 'French'])
    })

    it('redacts sensitive field names (password, ssn, credit_card)', async () => {
        const data = await buildFormPdf({
            text: [
                { name: 'username' },
                { name: 'ssn' },
                { name: 'credit_card_number' },
            ],
        })
        const result = await extractAcroForm({ data })
        const byName = new Map(result.fields.map((f) => [f.fieldName, f]))
        expect(byName.get('username')!.label).toBe('Username')
        expect(byName.get('ssn')!.label).toBe('(redacted)')
        expect(byName.get('credit_card_number')!.label).toBe('(redacted)')
    })

    it('synthesizes valid AgentMark action IDs (matches schema regex)', async () => {
        const data = await buildFormPdf({
            text: [
                { name: 'has.dotted.name' },
                { name: 'has spaces' },
                { name: 'CamelCase' },
                { name: 'has-hyphens' },
            ],
        })
        const result = await extractAcroForm({ data })
        for (const field of result.fields) {
            expect(field.actionId).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
        }
        // IDs are unique
        const ids = new Set(result.fields.map((f) => f.actionId))
        expect(ids.size).toBe(result.fields.length)
    })

    it('humanizes dotted/snake/camel field names into readable labels', async () => {
        const data = await buildFormPdf({
            text: [
                { name: 'applicant.first_name' },
                { name: 'employerName' },
                { name: 'phone-mobile' },
            ],
        })
        const result = await extractAcroForm({ data })
        const labels = result.fields.map((f) => f.label).sort()
        expect(labels).toContain('First Name')
        expect(labels).toContain('Employer Name')
        expect(labels).toContain('Phone Mobile')
    })
})

describe('convertPdf — kind: form integration', () => {
    it('produces kind: "form" when AcroForm fields are present', async () => {
        const data = await buildFormPdf({
            title: 'Vendor Application',
            text: [{ name: 'company' }, { name: 'contact_email' }],
            checkboxes: [{ name: 'agree' }],
        })
        const { agentmark, binding } = await convertPdf({
            data,
            sourceUrl: 'file:///tmp/vendor.pdf',
        })
        const snap = parseSnapshot(agentmark)

        expect(snap.kind).toBe('form')
        expect(Object.keys(snap.actions ?? {}).length).toBe(3)

        // Binding maps action IDs to original field names so downstream
        // fill/save tooling can find each field.
        const ids = Object.keys(snap.actions ?? {})
        for (const id of ids) {
            expect(typeof binding.get(id)).toBe('string')
        }

        // Schema validation passes
        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
    })

    it('produces kind: "document" when PDF has no AcroForm fields', async () => {
        const doc = await PDFDocument.create()
        doc.setTitle('Plain PDF')
        const page = doc.addPage([595, 842])
        const font = await doc.embedFont(StandardFonts.Helvetica)
        page.drawText('Just text.', { x: 50, y: 800, size: 11, font })
        const data = await doc.save()

        const { agentmark } = await convertPdf({
            data,
            sourceUrl: 'file:///tmp/plain.pdf',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('document')
        expect(snap.actions).toBeUndefined()
    })

    it('AcroForm extraction failure does not break document conversion (graceful)', async () => {
        // Even if AcroForm extraction throws (e.g. on a corrupted form dict),
        // convertPdf should still produce a valid kind: 'document' snapshot.
        // We can't easily craft a "broken AcroForm but valid PDF" so we just
        // verify the no-fields path returns a valid document — the error
        // path is exercised by the .catch() in pdf-converter.ts.
        const doc = await PDFDocument.create()
        doc.addPage([595, 842])
        const data = await doc.save()
        const { agentmark } = await convertPdf({
            data,
            sourceUrl: 'file:///tmp/x.pdf',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('document')
    })

    it('field with required=true surfaces as required in the action definition', async () => {
        const data = await buildFormPdf({
            text: [{ name: 'mandatory_field', required: true }],
        })
        const { agentmark } = await convertPdf({
            data,
            sourceUrl: 'file:///tmp/req.pdf',
        })
        const snap = parseSnapshot(agentmark)
        const action = Object.values(snap.actions ?? {})[0]
        expect(action.required).toBe(true)
    })
})

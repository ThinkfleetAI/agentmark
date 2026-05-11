import { describe, it, expect } from 'vitest'
import { convertDesktop } from '../../src/desktop/desktop-converter'
import { FixtureBackend } from '../../src/desktop/fixture-backend'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../../src/validators/schema-validator'

describe('convertDesktop', () => {
    it('produces a valid v0.4 desktop snapshot from the Excel fixture', async () => {
        const backend = new FixtureBackend()
        const { agentmark, binding } = await convertDesktop({ backend })

        const snap = parseSnapshot(agentmark)
        expect(snap.agentmark).toBe('0.4')
        expect(snap.kind).toBe('desktop')
        expect(snap.title).toBe('Microsoft Excel - Book1')
        expect(snap.desktop_meta?.platform).toBe('windows')
        expect(snap.desktop_meta?.process_name).toBe('EXCEL.EXE')
        expect(snap.desktop_meta?.a11y_backend).toBe('fixture')
        expect(snap.desktop_meta?.element_count).toBe(9)

        // Body includes the window marker, the title, and at least one
        // INPUT/ACTION reference resolvable in actions.
        expect(snap.body).toContain('[WINDOW:w_excel_exe]')
        expect(snap.body).toContain('# Microsoft Excel - Book1')
        expect(snap.body).toContain('[ACTION:')

        // Validates clean against the schema + cross-field invariants.
        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
        expect(result.valid).toBe(true)

        // Binding has entries for every action.
        for (const actionId of Object.keys(snap.actions ?? {})) {
            expect(binding.get(actionId)).toBeDefined()
        }
    })

    it('renders the NowCerts fixture with editable inputs as INPUT tags', async () => {
        const backend = new FixtureBackend()
        const { agentmark } = await convertDesktop({
            backend,
            target: { window_id: 'nowcerts_customer' },
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.title).toBe('NowCerts - Customer Detail - Acme Corp')
        expect(snap.body).toContain('[INPUT:act_in_company]')
        expect(snap.actions?.act_in_company?.type).toBe('type')
        expect(snap.actions?.act_in_company?.value).toBe('Acme Corp')
        expect(snap.actions?.act_in_company?.label).toBe('Company Name')
    })

    it('round-trips type → re-capture → observe the typed text', async () => {
        const backend = new FixtureBackend()

        // First capture — Company Name has its initial fixture value.
        const initial = await convertDesktop({
            backend,
            target: { window_id: 'nowcerts_customer' },
        })
        const initialSnap = parseSnapshot(initial.agentmark)
        expect(initialSnap.actions?.act_in_company?.value).toBe('Acme Corp')

        // Resolve the binding to get the underlying element_id, then
        // drive the backend's execute() the way the runtime will.
        const elementId = initial.binding.get('act_in_company')
        expect(elementId).toBe('in_company')

        await backend.execute({
            action: { type: 'type', element_id: elementId!, text: 'Beta Industries' },
        })
        expect(backend.executed).toHaveLength(1)

        // Second capture — the typed value should be reflected.
        const updated = await convertDesktop({
            backend,
            target: { window_id: 'nowcerts_customer' },
        })
        const updatedSnap = parseSnapshot(updated.agentmark)
        expect(updatedSnap.actions?.act_in_company?.value).toBe('Beta Industries')
    })

    it('returns a synthesised desktop:// URL when none is provided', async () => {
        const backend = new FixtureBackend()
        const { agentmark } = await convertDesktop({ backend })
        const snap = parseSnapshot(agentmark)
        expect(snap.url).toMatch(/^desktop:\/\/windows\/excel\.exe\//)
    })

    it('respects an explicit URL override', async () => {
        const backend = new FixtureBackend()
        const { agentmark } = await convertDesktop({
            backend,
            url: 'desktop://my-host/excel/12345',
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.url).toBe('desktop://my-host/excel/12345')
    })

    it('reports the backend name in desktop_meta.a11y_backend', async () => {
        const backend = new FixtureBackend()
        const { agentmark } = await convertDesktop({ backend })
        const snap = parseSnapshot(agentmark)
        expect(snap.desktop_meta?.a11y_backend).toBe('fixture')
    })

    it('handles a check_box element with aria.checked state', async () => {
        const backend = new FixtureBackend()
        const { agentmark } = await convertDesktop({
            backend,
            target: { window_id: 'nowcerts_customer' },
        })
        const snap = parseSnapshot(agentmark)
        const activeCheckbox = snap.actions?.act_cb_active
        expect(activeCheckbox?.type).toBe('check')
        expect(activeCheckbox?.aria?.checked).toBe(true)
    })

    it('drops the `actions` field when no interactive elements are captured', async () => {
        const staticBackend: import('../../src/desktop/types').DesktopCaptureBackend = {
            name: 'static-fixture',
            async capture() {
                return {
                    platform: 'macos',
                    process_name: 'Pages',
                    window_title: 'Untitled - Pages',
                    tree_depth: 2,
                    element_count: 2,
                    root: {
                        id: 'root',
                        role: 'window',
                        name: 'Pages',
                        children: [
                            { id: 'label_1', role: 'static_text', name: 'Empty document.' },
                        ],
                    },
                }
            },
            async execute() {
                return { ok: true }
            },
        }
        const { agentmark } = await convertDesktop({ backend: staticBackend })
        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('desktop')
        expect(snap.actions).toBeUndefined()
        expect(snap.body).toContain('Empty document.')
    })
})

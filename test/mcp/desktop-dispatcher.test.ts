/**
 * MCP dispatcher tests for the desktop tools (v0.4).
 *
 * Drives `dispatch()` directly with the agentmark_desktop_* tool names.
 * Uses the FixtureBackend, so these tests are deterministic and run on
 * any OS (no real bridge required).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
    dispatch,
    createDispatcherState,
    disposeAll,
    type DispatcherState,
} from '../../src/mcp/dispatcher'
import { ALL_TOOLS } from '../../src/mcp/tool-defs'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'

let state: DispatcherState

beforeEach(() => {
    state = createDispatcherState()
})

afterEach(async () => {
    await disposeAll(state)
})

describe('MCP — desktop tools', () => {
    it('registers all five desktop tools in ALL_TOOLS', () => {
        const names = ALL_TOOLS.map(t => t.name)
        expect(names).toContain('agentmark_desktop_open')
        expect(names).toContain('agentmark_desktop_close')
        expect(names).toContain('agentmark_desktop_list_targets')
        expect(names).toContain('agentmark_desktop_snapshot')
        expect(names).toContain('agentmark_desktop_execute')
    })

    it('agentmark_desktop_list_targets returns the fixture preset windows', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const result = await dispatch(state, 'agentmark_desktop_list_targets', { desktop_id })
        expect(result.isError).toBeFalsy()

        const body = JSON.parse(result.text)
        expect(Array.isArray(body.windows)).toBe(true)
        // Fixture ships two preset shapes: excel_blank and nowcerts_customer.
        // Each is exposed under two keys (excel + excel_blank; nowcerts + nowcerts_customer)
        // so length is 4. Don't over-constrain on the exact number; just
        // require both preset families are represented.
        const titles = body.windows.map((w: { window_title: string }) => w.window_title)
        expect(titles.some((t: string) => t.includes('Excel'))).toBe(true)
        expect(titles.some((t: string) => t.includes('NowCerts'))).toBe(true)
        // Every entry has the right shape.
        for (const w of body.windows) {
            expect(w).toHaveProperty('window_id')
            expect(w).toHaveProperty('window_title')
            expect(typeof w.has_focus).toBe('boolean')
        }
    })

    it('agentmark_desktop_list_targets errors on unknown desktop_id', async () => {
        const result = await dispatch(state, 'agentmark_desktop_list_targets', { desktop_id: 'dt_missing' })
        expect(result.isError).toBe(true)
        expect(result.text).toContain('Unknown desktop_id')
    })

    it('agentmark_desktop_open with no args defaults to the fixture backend', async () => {
        const result = await dispatch(state, 'agentmark_desktop_open', {})
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(body.desktop_id).toMatch(/^dt_/)
        expect(body.backend).toBe('fixture')
    })

    it('agentmark_desktop_open with backend=fixture returns a desktop_id', async () => {
        const result = await dispatch(state, 'agentmark_desktop_open', { backend: 'fixture' })
        expect(result.isError).toBeFalsy()
        const body = JSON.parse(result.text)
        expect(state.desktops.has(body.desktop_id)).toBe(true)
    })

    it('agentmark_desktop_open rejects unknown backend names', async () => {
        const result = await dispatch(state, 'agentmark_desktop_open', { backend: 'mystery' })
        expect(result.isError).toBe(true)
        expect(result.text).toContain('Unknown desktop backend')
    })

    it('agentmark_desktop_open with windows_uia refuses to start on non-Windows platforms', async () => {
        // On non-Windows: clear OS-mismatch error.
        // On Windows: the dispatcher would attempt to spawn the bridge; that
        // path is exercised in test/desktop/windows-uia-backend.test.ts.
        if (process.platform === 'win32') return

        const result = await dispatch(state, 'agentmark_desktop_open', { backend: 'windows_uia' })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/requires Windows/i)
    })

    it('agentmark_desktop_open with macos_axapi refuses to start on non-macOS platforms', async () => {
        // On non-macOS: clear OS-mismatch error.
        // On macOS: the dispatcher would attempt to spawn the bridge; that
        // path is exercised in test/desktop/macos-axapi-backend.test.ts.
        if (process.platform === 'darwin') return

        const result = await dispatch(state, 'agentmark_desktop_open', { backend: 'macos_axapi' })
        expect(result.isError).toBe(true)
        expect(result.text).toMatch(/requires macOS/i)
    })

    it('agentmark_desktop_snapshot returns a valid v0.4 desktop snapshot', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const result = await dispatch(state, 'agentmark_desktop_snapshot', { desktop_id })
        expect(result.isError).toBeFalsy()

        const snap = parseSnapshot(result.text)
        expect(snap.agentmark).toBe('0.4')
        expect(snap.kind).toBe('desktop')
        expect(snap.desktop_meta?.platform).toBe('windows')
        expect(snap.desktop_meta?.a11y_backend).toBe('fixture')
    })

    it('snapshot can target a specific preset via target.window_id', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const result = await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })
        const snap = parseSnapshot(result.text)
        expect(snap.title).toContain('NowCerts')
        expect(snap.actions?.act_in_company?.label).toBe('Company Name')
    })

    it('agentmark_desktop_execute drives a type action and the next snapshot reflects it', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        // First snapshot — caches the binding.
        await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })

        const exec = await dispatch(state, 'agentmark_desktop_execute', {
            desktop_id,
            action_id: 'act_in_company',
            value: 'Beta Industries',
        })
        expect(exec.isError).toBeFalsy()
        const body = JSON.parse(exec.text)
        expect(body.action_type).toBe('type')
        expect(body.element_id).toBe('in_company')
        expect(body.ok).toBe(true)
        expect(body.new_value).toBe('Beta Industries')

        // Re-snapshot the same target → value should reflect the typed text.
        const after = await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })
        const snap = parseSnapshot(after.text)
        expect(snap.actions?.act_in_company?.value).toBe('Beta Industries')
    })

    it('agentmark_desktop_execute rejects unknown action IDs', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        await dispatch(state, 'agentmark_desktop_snapshot', { desktop_id })

        const exec = await dispatch(state, 'agentmark_desktop_execute', {
            desktop_id,
            action_id: 'act_bogus_id',
        })
        expect(exec.isError).toBe(true)
        expect(exec.text).toContain('Unknown action_id')
    })

    it('agentmark_desktop_execute errors when no snapshot has been captured yet', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const exec = await dispatch(state, 'agentmark_desktop_execute', {
            desktop_id,
            action_id: 'act_anything',
        })
        expect(exec.isError).toBe(true)
        expect(exec.text).toContain('No cached snapshot')
    })

    it('agentmark_desktop_execute_batch runs a sequence of actions in one dispatch', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })

        const batch = await dispatch(state, 'agentmark_desktop_execute_batch', {
            desktop_id,
            actions: [
                { action_id: 'act_in_company', value: 'Beta Industries' },
                { action_id: 'act_in_phone', value: '555-0100' },
            ],
        })
        expect(batch.isError).toBeFalsy()
        const body = JSON.parse(batch.text)
        expect(body.all_ok).toBe(true)
        expect(body.executed_count).toBe(2)
        expect(body.requested_count).toBe(2)
        expect(body.results[0]).toMatchObject({ action_id: 'act_in_company', ok: true, new_value: 'Beta Industries' })
        expect(body.results[1]).toMatchObject({ action_id: 'act_in_phone', ok: true, new_value: '555-0100' })

        // Re-snapshot to confirm both values landed.
        const after = await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })
        const snap = parseSnapshot(after.text)
        expect(snap.actions?.act_in_company?.value).toBe('Beta Industries')
        expect(snap.actions?.act_in_phone?.value).toBe('555-0100')
    })

    it('agentmark_desktop_execute_batch fails fast on unknown action_id before dispatching anything', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })

        const batch = await dispatch(state, 'agentmark_desktop_execute_batch', {
            desktop_id,
            actions: [
                { action_id: 'act_in_company', value: 'OK' },
                { action_id: 'act_bogus_id', value: 'fails' },
            ],
        })
        expect(batch.isError).toBe(true)
        expect(batch.text).toContain('Unknown action_id at index 1')

        // Crucially: the fixture backend should NOT have received any execute
        // call — fail-fast happens *before* the backend is touched. That's
        // what makes the batch tool safe for ordered workflows.
        const desktop = state.desktops.get(desktop_id)!
        const backend = desktop.backend as unknown as { executed: unknown[] }
        expect(backend.executed.length).toBe(0)
    })

    it('agentmark_desktop_execute_batch rejects an empty actions array', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)
        await dispatch(state, 'agentmark_desktop_snapshot', { desktop_id })

        const batch = await dispatch(state, 'agentmark_desktop_execute_batch', {
            desktop_id,
            actions: [],
        })
        expect(batch.isError).toBe(true)
        expect(batch.text).toMatch(/non-empty array/i)
    })

    it('agentmark_desktop_execute_batch errors when no snapshot has been captured yet', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const batch = await dispatch(state, 'agentmark_desktop_execute_batch', {
            desktop_id,
            actions: [{ action_id: 'act_anything' }],
        })
        expect(batch.isError).toBe(true)
        expect(batch.text).toContain('No cached snapshot')
    })

    it('agentmark_desktop_diff returns no_changes when nothing happened between snapshots', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })

        const diff = await dispatch(state, 'agentmark_desktop_diff', { desktop_id })
        expect(diff.isError).toBeFalsy()
        const body = JSON.parse(diff.text)
        expect(body.no_changes).toBe(true)
    })

    it('agentmark_desktop_diff surfaces the value change after an execute', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        await dispatch(state, 'agentmark_desktop_snapshot', {
            desktop_id,
            target: { window_id: 'nowcerts_customer' },
        })

        await dispatch(state, 'agentmark_desktop_execute', {
            desktop_id,
            action_id: 'act_in_company',
            value: 'Globex Corp',
        })

        const diff = await dispatch(state, 'agentmark_desktop_diff', { desktop_id })
        expect(diff.isError).toBeFalsy()
        const body = JSON.parse(diff.text)
        expect(body.no_changes).toBe(false)
        expect(body.summary.changed).toBeGreaterThanOrEqual(1)
        const companyChange = body.elements_changed.find((c: { id: string }) => c.id === 'in_company')
        expect(companyChange?.changes?.value?.to).toBe('Globex Corp')
    })

    it('agentmark_desktop_diff errors when no snapshot has been captured yet', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const diff = await dispatch(state, 'agentmark_desktop_diff', { desktop_id })
        expect(diff.isError).toBe(true)
        expect(diff.text).toContain('No cached capture')
    })

    it('agentmark_desktop_close removes the session', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)
        expect(state.desktops.has(desktop_id)).toBe(true)

        const close = await dispatch(state, 'agentmark_desktop_close', { desktop_id })
        expect(close.isError).toBeFalsy()
        expect(state.desktops.has(desktop_id)).toBe(false)
    })

    it('agentmark_list_sessions includes desktop sessions', async () => {
        const open = await dispatch(state, 'agentmark_desktop_open', {})
        const { desktop_id } = JSON.parse(open.text)

        const list = await dispatch(state, 'agentmark_list_sessions', {})
        const body = JSON.parse(list.text)
        expect(body.desktops).toHaveLength(1)
        expect(body.desktops[0].desktop_id).toBe(desktop_id)
        expect(body.desktops[0].backend).toBe('fixture')
        expect(body.desktops[0].has_snapshot).toBe(false)
    })
})

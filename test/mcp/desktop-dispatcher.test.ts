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
    it('registers all four desktop tools in ALL_TOOLS', () => {
        const names = ALL_TOOLS.map(t => t.name)
        expect(names).toContain('agentmark_desktop_open')
        expect(names).toContain('agentmark_desktop_close')
        expect(names).toContain('agentmark_desktop_snapshot')
        expect(names).toContain('agentmark_desktop_execute')
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

    it('agentmark_desktop_open with windows_uia returns "not yet bundled" (until the bridge ships)', async () => {
        const result = await dispatch(state, 'agentmark_desktop_open', { backend: 'windows_uia' })
        expect(result.isError).toBe(true)
        expect(result.text).toContain('not yet bundled')
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

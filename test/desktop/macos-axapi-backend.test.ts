import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import { MacosAxapiBackend } from '../../src/desktop/macos-axapi-backend'

// Reuse the same fake-bridge.cjs the Windows backend tests use. The
// wire protocol is byte-identical between the two bridges, so a
// single fake substitutes for both.
const FAKE_BRIDGE = path.join(__dirname, 'fixtures', 'fake-bridge.cjs')

function makeBackend(extra: Partial<ConstructorParameters<typeof MacosAxapiBackend>[0]> = {}) {
    return new MacosAxapiBackend({
        bridgePath: FAKE_BRIDGE,
        allowNonMac: true,
        startupTimeoutMs: 5000,
        callTimeoutMs: 5000,
        ...extra,
    })
}

let backend: MacosAxapiBackend | null = null

afterEach(async () => {
    if (backend) {
        try { await backend.close() } catch { /* swallow */ }
        backend = null
    }
})

describe('MacosAxapiBackend', () => {
    it('refuses to construct on non-macOS without allowNonMac', () => {
        if (process.platform === 'darwin') return // not applicable
        expect(() => new MacosAxapiBackend({ bridgePath: FAKE_BRIDGE })).toThrow(/requires macOS/)
    })

    it('reports `macos_axapi` as its backend name', () => {
        backend = makeBackend()
        expect(backend.name).toBe('macos_axapi')
    })

    it('listTargets maps the bridge `windows` array to snake_case DesktopTargetSummary', async () => {
        backend = makeBackend()
        const targets = await backend.listTargets()
        expect(targets.length).toBeGreaterThan(0)
        const w = targets[0]
        expect(w.window_title).toBe('Fake Window 1')
        expect(w.process_name).toBe('FakeApp.exe')
        expect(w.process_id).toBe(42)
        expect(w.has_focus).toBe(true)
    })

    it('captures via the bridge and maps the response to DesktopCapture', async () => {
        backend = makeBackend()
        const cap = await backend.capture({})

        // The fake bridge always reports platform=windows in its preset
        // (it's a shared fixture); the backend should pass that through
        // verbatim. We assert on the structural fields the macOS backend
        // is responsible for mapping.
        expect(cap.window_title).toBe('Fake Window 1')
        expect(cap.tree_depth).toBe(2)
        expect(cap.element_count).toBe(3)
        expect(cap.root.role).toBe('window')
        expect(cap.root.children).toHaveLength(2)
        expect(cap.root.children?.[0].role).toBe('text_input')
        expect(cap.root.children?.[0].value).toBe('Acme')
    })

    it('forwards capture target to the bridge', async () => {
        backend = makeBackend()
        const cap = await backend.capture({
            target: { window_id: 'axapi:1234:0', process_name: 'TextEdit' },
        })
        expect(cap.window_id).toBe('axapi:1234:0')
        expect(cap.process_name).toBe('TextEdit')
    })

    it('executes a type action and maps newValue back to new_value', async () => {
        backend = makeBackend()
        await backend.capture({})
        const res = await backend.execute({
            action: { type: 'type', element_id: 'in_company', text: 'Beta Industries' },
        })
        expect(res.ok).toBe(true)
        expect(res.new_value).toBe('Beta Industries')
    })

    it('reuses the same bridge process across multiple calls', async () => {
        backend = makeBackend()
        const r1 = await backend.capture({})
        const r2 = await backend.capture({})
        expect(r1.window_id).toBe(r2.window_id)
    })

    it('reports a clear error when the bridge fails its handshake', async () => {
        backend = makeBackend()
        await backend.close()
        process.env.AGENTMARK_FAKE_BRIDGE_FAIL_PING = '1'
        try {
            backend = makeBackend()
            await expect(backend.capture({})).rejects.toThrow(/handshake failed/i)
        } finally {
            delete process.env.AGENTMARK_FAKE_BRIDGE_FAIL_PING
        }
    })

    it('closes cleanly and rejects subsequent calls', async () => {
        backend = makeBackend()
        await backend.capture({})
        await backend.close()
        await expect(backend.capture({})).rejects.toThrow(/closed/i)
    })

    it('defers bridge-path validation until first call', () => {
        // Constructor should not probe the path (matches WindowsUiaBackend behaviour).
        expect(() => new MacosAxapiBackend({
            bridgePath: '/definitely/does/not/exist/agentmark-bridge-macos',
            allowNonMac: true,
        })).not.toThrow()
    })
})

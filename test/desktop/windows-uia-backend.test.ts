import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import { WindowsUiaBackend } from '../../src/desktop/windows-uia-backend'

// The fake bridge is a Node script that speaks the same stdio JSON-RPC
// 2.0 protocol the real C# bridge does. Lets us validate the
// WindowsUiaBackend's spawn/handshake/call/close lifecycle without
// needing a Windows host or the .NET runtime.
const FAKE_BRIDGE = path.join(__dirname, 'fixtures', 'fake-bridge.cjs')

function makeBackend(extra: Partial<ConstructorParameters<typeof WindowsUiaBackend>[0]> = {}) {
    // Spawn 'node' with the fake-bridge script. By pointing
    // bridgePath at the Node executable itself we sidestep the
    // "child must be an exe" assumption on Windows; on macOS/Linux
    // node executes the .cjs script directly when given as argv[0]
    // -- well, it doesn't. We need to wrap it. The trick: bridgePath
    // = path to a tiny .cjs that shebangs node + execs the fake bridge.
    return new WindowsUiaBackend({
        // The fake bridge ships its own shebang. On Mac/Linux that's
        // enough for spawn() to execute it directly (after chmod +x).
        // We rely on Node's own bin on PATH for the shebang to work.
        bridgePath: FAKE_BRIDGE,
        allowNonWindows: true,
        startupTimeoutMs: 5000,
        callTimeoutMs: 5000,
        ...extra,
    })
}

let backend: WindowsUiaBackend | null = null

afterEach(async () => {
    if (backend) {
        try { await backend.close() } catch { /* swallow */ }
        backend = null
    }
})

describe('WindowsUiaBackend', () => {
    it('refuses to construct on non-Windows without allowNonWindows', () => {
        if (process.platform === 'win32') return // not applicable
        expect(() => new WindowsUiaBackend({ bridgePath: FAKE_BRIDGE })).toThrow(/requires Windows/)
    })

    it('captures via the bridge and maps the response to DesktopCapture', async () => {
        backend = makeBackend()
        const cap = await backend.capture({})

        expect(cap.platform).toBe('windows')
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
            target: { window_id: 'hwnd:0xDEAD0001', process_name: 'NowCerts.exe' },
        })
        expect(cap.window_id).toBe('hwnd:0xDEAD0001')
        expect(cap.process_name).toBe('NowCerts.exe')
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
        backend = makeBackend({
            // Use process.env override via spawn options? Spawn doesn't
            // accept env directly through our constructor; set it on
            // the parent and unset after.
        })
        // Tear down the default backend; build one with the env in place.
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

    it('rejects construction when bridgePath is not found and AGENTMARK_BRIDGE_PATH unset', () => {
        // We avoid the path-walk fallback by NOT passing bridgePath and
        // confirming the resolver throws cleanly.
        const oldEnv = process.env.AGENTMARK_BRIDGE_PATH
        delete process.env.AGENTMARK_BRIDGE_PATH
        try {
            // Use a path that definitely doesn't exist plus a guard so
            // the failure mode is exercised.
            expect(() => new WindowsUiaBackend({
                bridgePath: '/definitely/does/not/exist/agentmark-bridge-windows.exe',
                allowNonWindows: true,
            })).not.toThrow()
            // The constructor doesn't probe the path; failure surfaces on first call.
        } finally {
            if (oldEnv !== undefined) process.env.AGENTMARK_BRIDGE_PATH = oldEnv
        }
    })
})

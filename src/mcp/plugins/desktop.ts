/**
 * Desktop (AXAPI / UIA / fixture) MCP plugin.
 *
 * Wraps the AgentMark DesktopCaptureBackend protocol as MCP tools and
 * owns its own DesktopSession map.
 */
import {
    convertDesktop,
    diffDesktopCaptures,
    FixtureBackend,
    MacosAxapiBackend,
    WindowsUiaBackend,
    parseSnapshot,
    type DesktopCaptureBackend,
    type DesktopTarget,
    type ExecuteDesktopAction,
    type KeyModifier,
} from '../../index'
import { generateSessionId, type DesktopSession } from '../types'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../plugin'
import type { McpToolDef } from '../tool-defs'

const DESKTOP_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_desktop_open',
        description:
            'Attach to a desktop accessibility-tree backend and return a '
            + 'desktop_id. Backends:\n'
            + '  - "fixture" (default): pre-baked Excel + NowCerts trees, '
            + 'works on any OS — useful for testing without a real bridge '
            + 'installed.\n'
            + '  - "windows_uia": connects to the Windows FlaUI sidecar '
            + 'process (requires the bridge running on the same machine).\n'
            + '  - "macos_axapi": connects to the macOS AXAPI sidecar '
            + '(requires the bridge + Accessibility permission granted).\n'
            + '\nThe session lives for the duration of the MCP connection '
            + 'unless explicitly closed.',
        inputSchema: {
            type: 'object',
            properties: {
                backend: {
                    type: 'string',
                    enum: ['fixture', 'windows_uia', 'macos_axapi'],
                    description: 'Which backend to use. Default: "fixture".',
                },
                bridge_url: {
                    type: 'string',
                    description:
                        'Override the bridge WebSocket URL (for non-fixture '
                        + 'backends). Default: ws://127.0.0.1:9325/agentmark-bridge.',
                },
            },
        },
    },
    {
        name: 'agentmark_desktop_close',
        description: 'Close a desktop session and release the bridge connection.',
        inputSchema: {
            type: 'object',
            properties: { desktop_id: { type: 'string' } },
            required: ['desktop_id'],
        },
    },
    {
        name: 'agentmark_desktop_list_targets',
        description:
            'Enumerate top-level windows the backend can see. Returns one '
            + 'lightweight summary per window (process_name, process_id, '
            + 'window_title, window_class, window_id, has_focus) without '
            + 'walking the full element tree. Use this to let the user (or '
            + 'agent) pick a window before calling agentmark_desktop_snapshot '
            + 'with that specific window_id.',
        inputSchema: {
            type: 'object',
            properties: { desktop_id: { type: 'string' } },
            required: ['desktop_id'],
        },
    },
    {
        name: 'agentmark_desktop_snapshot',
        description:
            'Capture an AgentMark snapshot of a desktop window. If `target` '
            + 'is omitted, the currently focused window is captured. The '
            + 'result is cached on the session so subsequent '
            + 'agentmark_desktop_execute calls can resolve action IDs back '
            + 'to native accessibility element IDs.',
        inputSchema: {
            type: 'object',
            properties: {
                desktop_id: { type: 'string' },
                target: {
                    type: 'object',
                    description:
                        'Which window to capture. Provide any combination; '
                        + 'the backend resolves whichever it can. Omit to '
                        + 'capture the focused window.',
                    properties: {
                        process_name: { type: 'string' },
                        process_id: { type: 'number' },
                        window_title: { type: 'string' },
                        window_id: {
                            type: 'string',
                            description:
                                'Backend-defined opaque handle returned by a '
                                + 'previous snapshot. Most precise targeting.',
                        },
                    },
                },
                max_depth: { type: 'number', description: 'Maximum accessibility-tree depth to traverse. Default: 12.' },
                include_hidden: { type: 'boolean', description: 'Include off-screen / invisible elements. Default: false.' },
                timeout_ms: { type: 'number', description: 'Per-capture timeout in milliseconds. Default: 5000.' },
            },
            required: ['desktop_id'],
        },
    },
    {
        name: 'agentmark_desktop_execute',
        description:
            'Execute an action against the most recent snapshot of a '
            + 'desktop session. `action_id` is one of the keys from the '
            + 'snapshot\'s `actions` map (e.g. `act_btn_save`). The MCP '
            + 'server resolves it to the underlying element via the '
            + 'ActionBinding captured at snapshot time.\n'
            + '\nValue semantics by action type:\n'
            + '  - click / focus / scroll_to: omit `value`\n'
            + '  - type: string (text to enter)\n'
            + '  - check: boolean (target state)\n'
            + '  - select: string (option value or label)\n'
            + '  - key: string (key name, e.g. "Enter", "F5") + optional '
            + '`modifiers` array',
        inputSchema: {
            type: 'object',
            properties: {
                desktop_id: { type: 'string' },
                action_id: { type: 'string' },
                value: { description: 'Value for input-style actions. Type depends on the action: string, boolean, etc.' },
                modifiers: {
                    type: 'array',
                    items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta', 'win'] },
                    description: 'Key modifiers for `key` actions (or holding modifiers during a click).',
                },
                clear_first: {
                    type: 'boolean',
                    description: 'For `type` actions, clear the existing value before typing. Default: false.',
                },
            },
            required: ['desktop_id', 'action_id'],
        },
    },
    {
        name: 'agentmark_desktop_diff',
        description:
            'Take a fresh capture of the target window and return only what '
            + 'CHANGED since the last snapshot or diff on this session. '
            + 'Much smaller payload than a full re-snapshot — useful for '
            + 'verifying "did my action take effect?" or detecting a new '
            + 'dialog without paying for the whole tree.\n'
            + '\nReturns: { no_changes, summary {added/removed/changed}, '
            + 'window_title_changed, focus_changed, elements_added[], '
            + 'elements_removed[], elements_changed[] }. Each `elements_changed` '
            + 'entry lists the specific fields that moved (value, enabled, '
            + 'aria.checked, bounds, etc.) with from/to pairs.\n'
            + '\nAfter the diff completes, the session\'s cached capture is '
            + 'updated so the NEXT diff is against this new state. The '
            + 'action-id binding from the most recent full snapshot is NOT '
            + 'changed — call agentmark_desktop_snapshot when you need '
            + 'fresh action_ids after a structural change.',
        inputSchema: {
            type: 'object',
            properties: {
                desktop_id: { type: 'string' },
                target: {
                    type: 'object',
                    description: 'Optional target override (same shape as snapshot).',
                    properties: {
                        process_name: { type: 'string' },
                        process_id: { type: 'number' },
                        window_title: { type: 'string' },
                        window_id: { type: 'string' },
                    },
                },
                max_depth: { type: 'number' },
                include_hidden: { type: 'boolean' },
                timeout_ms: { type: 'number' },
            },
            required: ['desktop_id'],
        },
    },
    {
        name: 'agentmark_desktop_execute_batch',
        description:
            'Run a sequence of actions in ONE round-trip. Use this for any '
            + 'workflow that drives more than a handful of elements — form '
            + 'fills, bulk Excel cell writes, table populations. The actions '
            + 'array is processed in order. Each entry is an `action_id` '
            + 'from the most recent snapshot plus optional input data '
            + '(same shape as agentmark_desktop_execute, minus desktop_id).\n'
            + '\nBackends that support a native batched path (windows_uia, '
            + 'macos_axapi) run the whole array inside the sidecar without '
            + 'crossing back to Node between actions; the fixture backend '
            + 'simulates this. Net effect: a 1000-action batch costs ~1 '
            + 'MCP dispatch + ~1 stdio round-trip instead of 1000 each.\n'
            + '\nReturns one result per executed action, an `all_ok` flag, '
            + 'and `executed_count` (which may be less than actions.length '
            + 'when on_error="stop" hits a failure).',
        inputSchema: {
            type: 'object',
            properties: {
                desktop_id: { type: 'string' },
                actions: {
                    type: 'array',
                    description: 'Sequence of actions to run.',
                    items: {
                        type: 'object',
                        properties: {
                            action_id: { type: 'string' },
                            value: { description: 'Value for input actions (same semantics as agentmark_desktop_execute).' },
                            modifiers: {
                                type: 'array',
                                items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta', 'win'] },
                            },
                            clear_first: { type: 'boolean' },
                        },
                        required: ['action_id'],
                    },
                },
                on_error: {
                    type: 'string',
                    enum: ['stop', 'continue'],
                    description:
                        '"stop" (default): abort the rest of the batch on '
                        + 'the first failure. "continue": run every action '
                        + 'regardless. Pick "stop" for ordered workflows '
                        + 'where a missing prerequisite invalidates the '
                        + 'rest; "continue" for independent bulk fills.',
                },
                timeout_ms: { type: 'number', description: 'Per-batch timeout. Default scales with action count.' },
            },
            required: ['desktop_id', 'actions'],
        },
    },
]

export interface DesktopPlugin extends AgentMarkPlugin {
    readonly desktops: Map<string, DesktopSession>
}

export function createDesktopPlugin(): DesktopPlugin {
    const desktops = new Map<string, DesktopSession>()

    const requireDesktop = (id: string): DesktopSession => {
        const s = desktops.get(id)
        if (!s) throw new Error(`Unknown desktop_id: ${id}`)
        return s
    }

    const handlers: Record<string, ToolHandler> = {
        agentmark_desktop_open: async (args): Promise<DispatchResult> => {
            const requested = typeof args.backend === 'string' ? args.backend : 'fixture'
            const bridgePath = typeof args.bridge_path === 'string' ? args.bridge_path : undefined

            let backend: DesktopCaptureBackend
            try {
                switch (requested) {
                    case 'fixture':
                        backend = new FixtureBackend()
                        break
                    case 'windows_uia':
                        if (process.platform !== 'win32') {
                            return {
                                text:
                                    `Backend "windows_uia" requires Windows (process.platform=='win32'). `
                                    + `Current platform: ${process.platform}. Use backend="fixture" for `
                                    + `in-memory testing, or run agentmark on a Windows host.`,
                                isError: true,
                            }
                        }
                        backend = new WindowsUiaBackend({ bridgePath })
                        break
                    case 'macos_axapi':
                        if (process.platform !== 'darwin') {
                            return {
                                text:
                                    `Backend "macos_axapi" requires macOS (process.platform=='darwin'). `
                                    + `Current platform: ${process.platform}. Use backend="fixture" for `
                                    + `in-memory testing, or run agentmark on a Mac host.`,
                                isError: true,
                            }
                        }
                        backend = new MacosAxapiBackend({ bridgePath })
                        break
                    default:
                        return { text: `Unknown desktop backend: ${requested}`, isError: true }
                }
            } catch (err) {
                return {
                    text: `Failed to initialise backend "${requested}": ${(err as Error).message}`,
                    isError: true,
                }
            }

            const id = generateSessionId('dt')
            desktops.set(id, { id, backend, createdAt: new Date() })
            return { text: JSON.stringify({ desktop_id: id, backend: requested }, null, 2) }
        },

        agentmark_desktop_close: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const session = desktops.get(id)
            if (!session) return { text: `Unknown desktop_id: ${id}`, isError: true }
            await session.backend.close?.()
            desktops.delete(id)
            return { text: `Desktop session ${id} closed.` }
        },

        agentmark_desktop_list_targets: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const session = requireDesktop(id)
            const windows = await session.backend.listTargets()
            return { text: JSON.stringify({ windows }, null, 2) }
        },

        agentmark_desktop_snapshot: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const session = requireDesktop(id)

            const target = parseTarget(args.target)
            const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : undefined
            const includeHidden = args.include_hidden === true
            const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined

            const { agentmark, binding, capture } = await convertDesktop({
                backend: session.backend,
                target,
                maxDepth,
                includeHidden,
                timeoutMs,
            })

            session.lastTarget = target
            session.lastBinding = binding
            // Cache the raw capture so agentmark_desktop_diff can compare
            // a future snapshot against the most recent one without forcing
            // the agent to re-fetch the previous baseline.
            session.lastCapture = capture
            const snap = parseSnapshot(agentmark)
            session.lastActionTypes = new Map(
                Object.entries(snap.actions ?? {}).map(([k, def]) => [k, def.type]),
            )

            return { text: agentmark }
        },

        agentmark_desktop_diff: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const session = requireDesktop(id)

            if (!session.lastCapture) {
                return {
                    text:
                        `No cached capture for desktop_id ${id}. Call `
                        + `agentmark_desktop_snapshot first so the diff has a baseline.`,
                    isError: true,
                }
            }

            const target = parseTarget(args.target) ?? session.lastTarget
            const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : undefined
            const includeHidden = args.include_hidden === true
            const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 5000

            const fresh = await session.backend.capture({
                target,
                maxDepth,
                includeHidden,
                timeoutMs,
            })

            const diff = diffDesktopCaptures(session.lastCapture, fresh)

            // Move the baseline forward so the NEXT diff is against this
            // capture rather than the original snapshot.
            session.lastCapture = fresh
            session.lastTarget = target

            return { text: JSON.stringify(diff, null, 2) }
        },

        agentmark_desktop_execute: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const actionId = requireString(args, 'action_id')
            const session = requireDesktop(id)

            if (!session.lastBinding || !session.lastActionTypes) {
                return {
                    text:
                        `No cached snapshot for desktop_id ${id}. Call `
                        + `agentmark_desktop_snapshot first so the action_id can be resolved.`,
                    isError: true,
                }
            }

            const elementId = session.lastBinding.get(actionId)
            if (!elementId) {
                return { text: `Unknown action_id: ${actionId}`, isError: true }
            }

            const actionType = session.lastActionTypes.get(actionId) ?? 'click'
            const modifiers = parseModifiers(args.modifiers)
            const clearFirst = args.clear_first === true
            const action = buildExecuteAction(actionType, elementId, args.value, modifiers, clearFirst)

            const result = await session.backend.execute({ target: session.lastTarget, action })

            return {
                text: JSON.stringify({
                    action_id: actionId,
                    action_type: actionType,
                    element_id: elementId,
                    ok: result.ok,
                    ...(result.message !== undefined ? { message: result.message } : {}),
                    ...(result.new_value !== undefined ? { new_value: result.new_value } : {}),
                }, null, 2),
                isError: !result.ok,
            }
        },

        agentmark_desktop_execute_batch: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'desktop_id')
            const session = requireDesktop(id)

            if (!session.lastBinding || !session.lastActionTypes) {
                return {
                    text:
                        `No cached snapshot for desktop_id ${id}. Call `
                        + `agentmark_desktop_snapshot first so action_ids can be resolved.`,
                    isError: true,
                }
            }

            const rawActions = args.actions
            if (!Array.isArray(rawActions) || rawActions.length === 0) {
                return { text: '`actions` must be a non-empty array.', isError: true }
            }

            // Resolve every action_id to its (action_type, element_id) up
            // front. If any are unknown we fail fast — saves the round-trip
            // for an invariably-doomed batch.
            const resolved: Array<{
                action_id: string
                action_type: string
                element_id: string
                action: ReturnType<typeof buildExecuteAction>
            }> = []
            for (let i = 0; i < rawActions.length; i++) {
                const item = rawActions[i] as Record<string, unknown>
                const actionId = typeof item?.action_id === 'string' ? item.action_id : ''
                if (!actionId) {
                    return { text: `actions[${i}].action_id is required.`, isError: true }
                }
                const elementId = session.lastBinding.get(actionId)
                if (!elementId) {
                    return { text: `Unknown action_id at index ${i}: ${actionId}`, isError: true }
                }
                const actionType = session.lastActionTypes.get(actionId) ?? 'click'
                const modifiers = parseModifiers(item.modifiers)
                const clearFirst = item.clear_first === true
                const action = buildExecuteAction(actionType, elementId, item.value, modifiers, clearFirst)
                resolved.push({ action_id: actionId, action_type: actionType, element_id: elementId, action })
            }

            const onError =
                args.on_error === 'continue' || args.on_error === 'stop'
                    ? (args.on_error as 'stop' | 'continue')
                    : 'stop'
            const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined

            // Use the backend's native batched path when available; otherwise
            // loop execute() so the tool still has the same surface (only
            // savings is per-MCP-call overhead).
            let batchResult: { results: Array<{ ok: boolean; message?: string; new_value?: string }>; all_ok: boolean; executed_count: number }
            if (typeof session.backend.executeBatch === 'function') {
                const raw = await session.backend.executeBatch({
                    target: session.lastTarget,
                    actions: resolved.map((r) => r.action),
                    on_error: onError,
                    timeoutMs,
                })
                batchResult = {
                    results: raw.results.map((r) => ({ ...r })),
                    all_ok: raw.all_ok,
                    executed_count: raw.executed_count,
                }
            } else {
                const results: Array<{ ok: boolean; message?: string; new_value?: string }> = []
                for (const r of resolved) {
                    const res = await session.backend.execute({ target: session.lastTarget, action: r.action })
                    results.push({ ok: res.ok, message: res.message, new_value: res.new_value })
                    if (!res.ok && onError === 'stop') break
                }
                batchResult = {
                    results,
                    all_ok: results.every((r) => r.ok),
                    executed_count: results.length,
                }
            }

            return {
                text: JSON.stringify({
                    all_ok: batchResult.all_ok,
                    executed_count: batchResult.executed_count,
                    requested_count: resolved.length,
                    results: batchResult.results.map((r, i) => ({
                        action_id: resolved[i]?.action_id,
                        action_type: resolved[i]?.action_type,
                        ok: r.ok,
                        ...(r.message !== undefined ? { message: r.message } : {}),
                        ...(r.new_value !== undefined ? { new_value: r.new_value } : {}),
                    })),
                }, null, 2),
                isError: !batchResult.all_ok,
            }
        },
    }

    return {
        name: 'desktop',
        tools: DESKTOP_TOOLS,
        handlers,
        desktops,
        dispose: async () => {
            await Promise.allSettled(
                Array.from(desktops.values())
                    .filter((s) => s.backend.close)
                    .map((s) => s.backend.close!()),
            )
            desktops.clear()
        },
        describeSessions: () => ({
            desktops: Array.from(desktops.values()).map((s) => ({
                desktop_id: s.id,
                backend: s.backend.name,
                has_snapshot: s.lastBinding !== undefined,
                created_at: s.createdAt.toISOString(),
            })),
        }),
    }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function parseTarget(input: unknown): DesktopTarget | undefined {
    if (!input || typeof input !== 'object') return undefined
    const t = input as Record<string, unknown>
    const out: DesktopTarget = {}
    if (typeof t.process_name === 'string') out.process_name = t.process_name
    if (typeof t.process_id === 'number') out.process_id = t.process_id
    if (typeof t.window_title === 'string') out.window_title = t.window_title
    if (typeof t.window_id === 'string') out.window_id = t.window_id
    return Object.keys(out).length > 0 ? out : undefined
}

function parseModifiers(input: unknown): KeyModifier[] | undefined {
    if (!Array.isArray(input)) return undefined
    const allowed: ReadonlySet<KeyModifier> = new Set(['ctrl', 'alt', 'shift', 'meta', 'win'])
    const out: KeyModifier[] = []
    for (const m of input) {
        if (typeof m === 'string' && allowed.has(m as KeyModifier)) out.push(m as KeyModifier)
    }
    return out.length > 0 ? out : undefined
}

function buildExecuteAction(
    actionType: string,
    elementId: string,
    value: unknown,
    modifiers: KeyModifier[] | undefined,
    clearFirst: boolean,
): ExecuteDesktopAction {
    switch (actionType) {
        case 'type':
            return {
                type: 'type',
                element_id: elementId,
                text: typeof value === 'string' ? value : String(value ?? ''),
                clear_first: clearFirst,
            }
        case 'check':
            return {
                type: 'check',
                element_id: elementId,
                checked: value === true || value === 'true',
            }
        case 'select':
        case 'multi_select':
            return {
                type: 'select',
                element_id: elementId,
                value: typeof value === 'string' ? value : String(value ?? ''),
            }
        case 'range':
            return {
                type: 'type',
                element_id: elementId,
                text: typeof value === 'number' ? String(value) : String(value ?? ''),
            }
        case 'key':
            return {
                type: 'key',
                element_id: elementId,
                key: typeof value === 'string' ? value : String(value ?? ''),
                modifiers,
            }
        case 'scroll_to':
            return { type: 'scroll_to', element_id: elementId }
        default:
            return { type: 'click', element_id: elementId }
    }
}

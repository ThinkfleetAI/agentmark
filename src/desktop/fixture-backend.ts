/**
 * `FixtureBackend` — an in-memory `DesktopCaptureBackend` that returns
 * pre-baked accessibility trees. Useful for:
 *
 *   - Local development on machines without the OS bridge installed
 *     (e.g. running the MCP server on macOS before the AXAPI bridge
 *     exists, or on a CI runner with no GUI).
 *   - Tests for the converter and MCP server.
 *   - Demo flows that don't need real applications.
 *
 * Ships one preset by default — an Excel-like spreadsheet window —
 * mirroring the shape a real Windows UIA backend would produce. Callers
 * can supply their own `presets` map for custom scenarios.
 */

import type {
    DesktopCapture,
    DesktopCaptureBackend,
    CaptureDesktopOptions,
    DesktopElement,
    DesktopTarget,
    DesktopTargetSummary,
    ExecuteDesktopAction,
    ExecuteDesktopBatchOptions,
    ExecuteDesktopBatchResult,
    ExecuteDesktopOptions,
    ExecuteDesktopResult,
} from './types'

export interface FixtureBackendOptions {
    /** Preset name → DesktopCapture. Defaults to a built-in Excel preset. */
    presets?: Record<string, DesktopCapture>
    /** Default preset to return when `target` is omitted or doesn't match. */
    defaultPreset?: string
    /** Optional latency to simulate the bridge round-trip (ms). */
    latencyMs?: number
}

export class FixtureBackend implements DesktopCaptureBackend {
    readonly name = 'fixture'
    private readonly presets: Record<string, DesktopCapture>
    private readonly defaultPreset: string
    private readonly latencyMs: number

    /** Captured executions — handy for tests to assert what was driven. */
    public readonly executed: Array<ExecuteDesktopOptions> = []

    /** Mutable map of element_id → new value, applied to subsequent
     *  capture() results so a test can roundtrip type → re-capture →
     *  observe the typed text. */
    public readonly elementValues = new Map<string, string>()

    constructor(opts: FixtureBackendOptions = {}) {
        this.presets = { ...DEFAULT_PRESETS, ...(opts.presets ?? {}) }
        this.defaultPreset = opts.defaultPreset ?? 'excel_blank'
        this.latencyMs = opts.latencyMs ?? 0
    }

    async listTargets(): Promise<DesktopTargetSummary[]> {
        if (this.latencyMs) await delay(this.latencyMs)

        // One summary per registered preset. Use the preset key as
        // window_id so a subsequent capture({ target: { window_id: key }})
        // resolves back to the same preset.
        return Object.entries(this.presets).map(([key, cap]) => ({
            window_id: key,
            process_name: cap.process_name,
            process_id: cap.process_id,
            window_title: cap.window_title,
            window_class: cap.window_class,
            has_focus: key === this.defaultPreset,
        }))
    }

    async capture(opts: CaptureDesktopOptions = {}): Promise<DesktopCapture> {
        if (this.latencyMs) await delay(this.latencyMs)

        const key = pickPresetKey(opts, this.presets, this.defaultPreset)
        const base = this.presets[key]
        if (!base) {
            throw new Error(`FixtureBackend: no preset named "${key}"`)
        }

        // Clone so mutations don't leak across calls, then layer in any
        // values the test has typed.
        const cloned = structuredClone(base) as DesktopCapture
        if (this.elementValues.size > 0) {
            applyValues(cloned.root, this.elementValues)
        }
        return cloned
    }

    async execute(opts: ExecuteDesktopOptions): Promise<ExecuteDesktopResult> {
        if (this.latencyMs) await delay(this.latencyMs)
        this.executed.push(opts)

        switch (opts.action.type) {
            case 'type':
                this.elementValues.set(opts.action.element_id, opts.action.text)
                return { ok: true, new_value: opts.action.text }
            case 'check':
                this.elementValues.set(opts.action.element_id, opts.action.checked ? 'true' : 'false')
                return { ok: true, new_value: String(opts.action.checked) }
            case 'select':
                this.elementValues.set(opts.action.element_id, opts.action.value)
                return { ok: true, new_value: opts.action.value }
            default:
                return { ok: true }
        }
    }

    async executeBatch(opts: ExecuteDesktopBatchOptions): Promise<ExecuteDesktopBatchResult> {
        // The fixture pays its `latencyMs` once for the whole batch — modelling
        // a bridge that processes the whole array inside its sidecar. The
        // looped-execute fallback in WindowsUiaBackend / MacosAxapiBackend
        // pays it per call.
        if (this.latencyMs) await delay(this.latencyMs)

        const results: ExecuteDesktopResult[] = []
        const onError = opts.on_error ?? 'stop'
        for (const action of opts.actions) {
            const result = await this.executeAction(opts.target, action)
            results.push(result)
            if (!result.ok && onError === 'stop') break
        }
        return {
            results,
            all_ok: results.every((r) => r.ok),
            executed_count: results.length,
        }
    }

    private async executeAction(
        target: DesktopTarget | undefined,
        action: ExecuteDesktopAction,
    ): Promise<ExecuteDesktopResult> {
        this.executed.push({ target, action })
        switch (action.type) {
            case 'type':
                this.elementValues.set(action.element_id, action.text)
                return { ok: true, new_value: action.text }
            case 'check':
                this.elementValues.set(action.element_id, action.checked ? 'true' : 'false')
                return { ok: true, new_value: String(action.checked) }
            case 'select':
                this.elementValues.set(action.element_id, action.value)
                return { ok: true, new_value: action.value }
            default:
                return { ok: true }
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function pickPresetKey(
    opts: CaptureDesktopOptions,
    presets: Record<string, DesktopCapture>,
    fallback: string,
): string {
    const t = opts.target
    if (!t) return fallback
    if (t.window_id && presets[t.window_id]) return t.window_id
    if (t.process_name) {
        const k = t.process_name.toLowerCase().replace(/\..*$/, '')
        if (presets[k]) return k
    }
    if (t.window_title) {
        const k = t.window_title.toLowerCase().replace(/[^a-z0-9_]/g, '_')
        if (presets[k]) return k
    }
    return fallback
}

function applyValues(el: DesktopElement, values: Map<string, string>): void {
    const v = values.get(el.id)
    if (v !== undefined) el.value = v
    for (const child of el.children ?? []) applyValues(child, values)
}

// ──────────────────────────────────────────────────────────────────────────
// Built-in presets
// ──────────────────────────────────────────────────────────────────────────

const EXCEL_BLANK: DesktopCapture = {
    platform: 'windows',
    process_name: 'EXCEL.EXE',
    process_id: 12345,
    window_title: 'Microsoft Excel - Book1',
    window_class: 'XLMAIN',
    window_id: 'excel_blank',
    focused_element_id: 'cell_A1',
    tree_depth: 4,
    element_count: 9,
    root: {
        id: 'root',
        role: 'window',
        name: 'Microsoft Excel - Book1',
        enabled: true,
        children: [
            {
                id: 'ribbon',
                role: 'toolbar',
                name: 'Ribbon',
                enabled: true,
                children: [
                    { id: 'btn_save', role: 'button', name: 'Save', enabled: true },
                    { id: 'btn_undo', role: 'button', name: 'Undo', enabled: false },
                    { id: 'btn_redo', role: 'button', name: 'Redo', enabled: false },
                ],
            },
            {
                id: 'sheet_sheet1',
                role: 'pane',
                name: 'Sheet1',
                enabled: true,
                children: [
                    {
                        id: 'grid_main',
                        role: 'table',
                        name: 'Sheet1 grid',
                        enabled: true,
                        children: [
                            {
                                id: 'row_header',
                                role: 'row',
                                children: [
                                    { id: 'col_A', role: 'column_header', name: 'A' },
                                    { id: 'col_B', role: 'column_header', name: 'B' },
                                    { id: 'col_C', role: 'column_header', name: 'C' },
                                ],
                            },
                            {
                                id: 'row_1',
                                role: 'row',
                                children: [
                                    { id: 'cell_A1', role: 'cell', name: 'A1', value: '', enabled: true },
                                    { id: 'cell_B1', role: 'cell', name: 'B1', value: '', enabled: true },
                                    { id: 'cell_C1', role: 'cell', name: 'C1', value: '', enabled: true },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'status_bar',
                role: 'status_bar',
                name: 'Ready',
                value: 'Ready',
            },
        ],
    },
}

const NOWCERTS_CUSTOMER: DesktopCapture = {
    platform: 'windows',
    process_name: 'NowCerts.exe',
    process_id: 22120,
    window_title: 'NowCerts - Customer Detail - Acme Corp',
    window_class: 'WindowsForms10.Window.8.app.0.378734a',
    window_id: 'nowcerts_customer',
    focused_element_id: 'in_company',
    tree_depth: 5,
    element_count: 12,
    root: {
        id: 'root',
        role: 'window',
        name: 'NowCerts - Customer Detail',
        enabled: true,
        children: [
            {
                id: 'panel_company',
                role: 'group',
                name: 'Company Information',
                enabled: true,
                children: [
                    {
                        id: 'in_company',
                        role: 'text_input',
                        name: 'Company Name',
                        value: 'Acme Corp',
                        enabled: true,
                    },
                    {
                        id: 'in_email',
                        role: 'text_input',
                        name: 'Primary Email',
                        value: 'contact@acme.com',
                        enabled: true,
                    },
                    {
                        id: 'in_phone',
                        role: 'text_input',
                        name: 'Phone',
                        value: '(555) 123-4567',
                        enabled: true,
                    },
                    {
                        id: 'cb_active',
                        role: 'check_box',
                        name: 'Active Customer',
                        selected: true,
                        enabled: true,
                        aria: { checked: true },
                    },
                ],
            },
            {
                id: 'panel_actions',
                role: 'toolbar',
                name: 'Actions',
                enabled: true,
                children: [
                    { id: 'btn_save', role: 'button', name: 'Save', enabled: true },
                    { id: 'btn_cancel', role: 'button', name: 'Cancel', enabled: true },
                    { id: 'btn_new_policy', role: 'button', name: 'New Policy', enabled: true },
                ],
            },
        ],
    },
}

const DEFAULT_PRESETS: Record<string, DesktopCapture> = {
    excel_blank: EXCEL_BLANK,
    excel: EXCEL_BLANK,
    nowcerts_customer: NOWCERTS_CUSTOMER,
    nowcerts: NOWCERTS_CUSTOMER,
}

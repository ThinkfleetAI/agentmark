/**
 * Walk a captured desktop accessibility tree and emit:
 *
 *   1. A markdown body that renders the UI as structured text agents
 *      can read. Headings for windows/panes/dialogs; lists for menus
 *      and tab lists; tables for grid controls; inline tags for
 *      interactive elements.
 *
 *   2. An `actions` map keyed by `act_<id>` that the runtime later
 *      passes to the backend's `execute()` call.
 *
 * The tag conventions mirror the rest of AgentMark:
 *
 *   - `[ACTION:act_save]`  — clickable / triggers (button, link, menu_item)
 *   - `[INPUT:act_first_name]` — editable controls (text_input, combo_box,
 *      check_box, radio_button, slider, etc.)
 *   - `[ELEMENT:e_status]` — non-interactive references the agent might
 *      cite (status text, table cell IDs)
 *   - `[WINDOW:w_excel_1]` — window boundary marker for multi-window
 *      captures
 *
 * Interactive elements always land in the `actions` map. Static text
 * usually just appears in body text — but when the producer wants to
 * give the agent a stable reference, it emits `[ELEMENT:e_x]` and
 * doesn't add to actions.
 */

import type { ActionDefinition, ActionType } from '../types'
import type { DesktopCapture, DesktopElement, DesktopRole } from './types'

export interface BuildDesktopBodyResult {
    /** The markdown body. */
    body: string
    /** Actions discovered while walking the tree, keyed by act_<id>. */
    actions: Record<string, ActionDefinition>
    /** Mapping action ID → original desktop element_id. The runtime
     *  pushes this into the ActionBinding so that `execute(act_X)`
     *  translates to `backend.execute({ element_id: ... })`. */
    element_ids: Record<string, string>
    /** Whether the tree contained any interactive elements. */
    has_interactive: boolean
}

const ESCAPE_REGEX = /\[(?=[A-Z])/g

function escapeBody(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(ESCAPE_REGEX, '\\[')
}

/** Roles whose elements become entries in the `actions` map. */
const INTERACTIVE_ROLES: ReadonlySet<DesktopRole> = new Set<DesktopRole>([
    'button',
    'split_button',
    'menu_item',
    'tab',
    'link',
    'text_input',
    'password_input',
    'text_area',
    'check_box',
    'radio_button',
    'combo_box',
    'list_box',
    'slider',
    'tree_item',
    'list_item',
])

/** Map normalised desktop role → AgentMark ActionType. */
function actionTypeFor(role: DesktopRole): ActionType {
    switch (role) {
        case 'text_input':
        case 'password_input':
        case 'text_area':
            return 'type'
        case 'check_box':
            return 'check'
        case 'radio_button':
            return 'check'
        case 'combo_box':
        case 'list_box':
            return 'select'
        case 'slider':
            return 'range'
        default:
            return 'click'
    }
}

/** Tag used for an element — INPUT for editable controls, ACTION otherwise. */
function tagKindFor(role: DesktopRole): 'INPUT' | 'ACTION' {
    switch (role) {
        case 'text_input':
        case 'password_input':
        case 'text_area':
        case 'check_box':
        case 'radio_button':
        case 'combo_box':
        case 'list_box':
        case 'slider':
            return 'INPUT'
        default:
            return 'ACTION'
    }
}

interface BuilderState {
    actions: Record<string, ActionDefinition>
    element_ids: Record<string, string>
    seen: Set<string>
    has_interactive: boolean
}

function uniqueActionId(state: BuilderState, raw: string): string {
    // Sanitise to AgentMark action ID rules: lowercase, alnum + underscore,
    // starts with a letter.
    const base = `act_${raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 56) || 'el'}`
    if (!state.seen.has(base)) {
        state.seen.add(base)
        return base
    }
    let n = 2
    while (state.seen.has(`${base}_${n}`)) n++
    const id = `${base}_${n}`
    state.seen.add(id)
    return id
}

export function buildDesktopBody(capture: DesktopCapture): BuildDesktopBodyResult {
    const state: BuilderState = {
        actions: {},
        element_ids: {},
        seen: new Set(),
        has_interactive: false,
    }

    const lines: string[] = []
    // Top-of-body window marker so multi-window producers (or future
    // multi-tab captures) can interleave consistently.
    const winId = `w_${(capture.process_name ?? 'window').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24) || 'app'}`
    lines.push(`[WINDOW:${winId}]`)
    lines.push('')
    lines.push(`# ${capture.window_title || '(untitled window)'}`)
    lines.push('')

    renderElement(capture.root, lines, state, 0)

    // Trim trailing blank lines
    while (lines.length && lines[lines.length - 1] === '') lines.pop()

    return {
        body: lines.join('\n') + '\n',
        actions: state.actions,
        element_ids: state.element_ids,
        has_interactive: state.has_interactive,
    }
}

function renderElement(
    el: DesktopElement,
    lines: string[],
    state: BuilderState,
    depth: number,
): void {
    const role = el.role

    // Containers — render a heading or list marker, then recurse.
    if (role === 'window' || role === 'pane' || role === 'dialog' || role === 'group') {
        if (el.name) {
            const level = Math.min(2 + depth, 6)
            lines.push(`${'#'.repeat(level)} ${escapeBody(el.name)}`)
            lines.push('')
        }
        renderChildren(el, lines, state, depth + 1)
        return
    }

    if (role === 'toolbar' || role === 'menu' || role === 'tab_list') {
        if (el.name) {
            lines.push(`**${escapeBody(el.name)}**`)
            lines.push('')
        }
        renderChildren(el, lines, state, depth + 1)
        return
    }

    if (role === 'tree' || role === 'list') {
        if (el.name) {
            lines.push(`**${escapeBody(el.name)}**`)
            lines.push('')
        }
        for (const child of el.children ?? []) {
            const item = renderInteractiveAsTag(child, state)
            if (item) {
                lines.push(`- ${item}`)
            } else if (child.name) {
                lines.push(`- ${escapeBody(child.name)}`)
            } else {
                renderElement(child, lines, state, depth + 1)
            }
        }
        lines.push('')
        return
    }

    if (role === 'table') {
        renderTable(el, lines, state)
        return
    }

    // Interactive leaves — emit a tag inline, push action to map.
    if (INTERACTIVE_ROLES.has(role)) {
        const tag = renderInteractiveAsTag(el, state)
        if (tag) {
            lines.push(tag)
            lines.push('')
        }
        return
    }

    // Static text / labels / status — render plain.
    if (role === 'label' || role === 'static_text' || role === 'status_bar') {
        if (el.name || el.value) {
            lines.push(escapeBody(el.value ?? el.name ?? ''))
            lines.push('')
        }
        return
    }

    // Anything else — recurse into children but otherwise ignore.
    renderChildren(el, lines, state, depth + 1)
}

function renderChildren(
    el: DesktopElement,
    lines: string[],
    state: BuilderState,
    depth: number,
): void {
    for (const child of el.children ?? []) {
        renderElement(child, lines, state, depth)
    }
}

function renderInteractiveAsTag(el: DesktopElement, state: BuilderState): string | null {
    const actionId = uniqueActionId(state, el.id || el.name || el.role)
    const def: ActionDefinition = {
        type: actionTypeFor(el.role),
        label: el.name || el.value || el.id || el.role,
    }
    if (el.value !== undefined) def.value = el.value
    if (el.placeholder !== undefined) def.placeholder = el.placeholder
    if (el.enabled === false) {
        def.disabled = true
    }
    if (el.read_only === true) def.read_only = true
    if (el.aria) {
        def.aria = {}
        if (el.aria.pressed !== undefined) def.aria.pressed = el.aria.pressed
        if (el.aria.checked !== undefined) def.aria.checked = el.aria.checked
    }
    if (el.selected !== undefined) {
        def.aria = def.aria ?? {}
        def.aria.selected = el.selected
    }
    if (el.expanded !== undefined) {
        def.aria = def.aria ?? {}
        def.aria.expanded = el.expanded
    }

    state.actions[actionId] = def
    if (el.id) state.element_ids[actionId] = el.id
    state.has_interactive = true

    const tagKind = tagKindFor(el.role)
    return `[${tagKind}:${actionId}]`
}

function renderTable(el: DesktopElement, lines: string[], state: BuilderState): void {
    if (el.name) {
        lines.push(`**${escapeBody(el.name)}**`)
        lines.push('')
    }
    const rows = (el.children ?? []).filter(c => c.role === 'row')
    const headerRow = (el.children ?? []).find(c => c.role === 'row' && (c.children ?? []).some(cc => cc.role === 'column_header'))
    const headers = headerRow
        ? (headerRow.children ?? []).filter(c => c.role === 'column_header' || c.role === 'cell').map(c => c.name ?? '')
        : (el.children ?? []).filter(c => c.role === 'column_header').map(c => c.name ?? '')

    if (headers.length === 0) {
        // No headers — fall back to plain list of rows.
        for (const row of rows) {
            const cells = (row.children ?? []).filter(c => c.role === 'cell')
            const line = cells.map(c => escapeBody(c.value ?? c.name ?? '')).join(' | ')
            if (line) lines.push(`- ${line}`)
        }
        lines.push('')
        return
    }

    lines.push(`| ${headers.map(escapeBody).join(' | ')} |`)
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`)

    for (const row of rows) {
        if (row === headerRow) continue
        const cells = (row.children ?? []).filter(c => c.role === 'cell')
        const padded = headers.map((_, i) => escapeBody(cells[i]?.value ?? cells[i]?.name ?? ''))
        lines.push(`| ${padded.join(' | ')} |`)
    }
    lines.push('')
}

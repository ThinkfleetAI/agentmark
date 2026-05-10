import { describe, it, expect, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { executeAction } from '../src/runtime/action-executor'
import {
    ActionDisabledError,
    ActionNotFoundError,
    ActionTypeError,
    ElementNotFoundError,
    ExecutionError,
    ExecutionTimeoutError,
    isAgentMarkError,
    AgentMarkError,
} from '../src/errors'
import { ActionId } from '../src/ids/branded'
import type { ActionDefinition } from '../src/types'
import type { Logger } from '../src/observability/logger'

function fakeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
    return {
        type: 'click',
        label: 'Test Action',
        ...overrides,
    }
}

function captureLogger(): { logger: Logger; events: Array<{ level: string; event: string; data?: Record<string, unknown> }> } {
    const events: Array<{ level: string; event: string; data?: Record<string, unknown> }> = []
    const logger: Logger = {
        debug: (event, data) => events.push({ level: 'debug', event, data }),
        info: (event, data) => events.push({ level: 'info', event, data }),
        warn: (event, data) => events.push({ level: 'warn', event, data }),
        error: (event, data) => events.push({ level: 'error', event, data }),
    }
    return { logger, events }
}

/** Mock page that returns a null element handle — simulates "binding stale". */
function mockPageNoElement(): Page {
    return {
        evaluateHandle: vi.fn().mockResolvedValue({
            asElement: () => null,
            dispose: () => Promise.resolve(),
        }),
    } as unknown as Page
}

describe('executeAction — pre-flight validation', () => {
    it('throws ActionDisabledError when action.disabled is true', async () => {
        const action = fakeAction({ disabled: true, disabled_reason: 'closed for maintenance' })
        await expect(
            executeAction(mockPageNoElement(), action, ActionId('act_1')),
        ).rejects.toBeInstanceOf(ActionDisabledError)
    })

    it('uses default reason when disabled_reason is absent', async () => {
        const action = fakeAction({ disabled: true })
        try {
            await executeAction(mockPageNoElement(), action, ActionId('act_1'))
            expect.fail('expected to throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ActionDisabledError)
            expect((err as ActionDisabledError).reason).toBe('Action is disabled')
        }
    })

    it('throws ActionDisabledError when action.honeypot is true', async () => {
        const action = fakeAction({ honeypot: true })
        try {
            await executeAction(mockPageNoElement(), action, ActionId('act_trap'))
            expect.fail('expected to throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ActionDisabledError)
            expect((err as ActionDisabledError).reason).toMatch(/honeypot/)
        }
    })

    it('throws ActionDisabledError when action is read_only and requires a value', async () => {
        const action = fakeAction({ type: 'type', read_only: true })
        await expect(
            executeAction(mockPageNoElement(), action, ActionId('act_field'), 'foo'),
        ).rejects.toBeInstanceOf(ActionDisabledError)
    })

    it('does NOT block read_only on actions that take no value (e.g. click)', async () => {
        // click on a read_only action should not be blocked by read_only
        // (but will still fail at element resolution since we mock no element)
        const action = fakeAction({ type: 'click', read_only: true })
        await expect(
            executeAction(mockPageNoElement(), action, ActionId('act_btn')),
        ).rejects.toBeInstanceOf(ElementNotFoundError)
    })
})

describe('executeAction — value type validation', () => {
    const cases: Array<{
        type: ActionDefinition['type']
        bad: unknown
        good: unknown
        expected: string
    }> = [
        { type: 'type', bad: 42, good: 'hello', expected: 'string' },
        { type: 'check', bad: 'yes', good: true, expected: 'boolean' },
        { type: 'select', bad: 99, good: 'option-a', expected: 'string' },
        { type: 'multi_select', bad: 'a', good: ['a', 'b'], expected: 'string[]' },
        { type: 'multi_select', bad: [1, 2], good: ['a'], expected: 'string[]' },
        { type: 'upload', bad: 99, good: '/tmp/x.png', expected: 'string | string[]' },
        { type: 'date', bad: new Date(), good: '2026-01-01', expected: 'string' },
        { type: 'key', bad: undefined, good: 'Enter', expected: 'string' },
    ]

    for (const c of cases) {
        it(`rejects bad value for ${c.type}`, async () => {
            const action = fakeAction({ type: c.type })
            try {
                await executeAction(mockPageNoElement(), action, ActionId('act_x'), c.bad)
                expect.fail('expected to throw')
            } catch (err) {
                expect(err).toBeInstanceOf(ActionTypeError)
                expect((err as ActionTypeError).expected).toBe(c.expected)
            }
        })
    }

    it('ignores value for click', async () => {
        const action = fakeAction({ type: 'click' })
        // Will fail at element resolution, not at value validation
        await expect(
            executeAction(mockPageNoElement(), action, ActionId('act_btn'), 'ignored'),
        ).rejects.toBeInstanceOf(ElementNotFoundError)
    })
})

describe('executeAction — element resolution', () => {
    it('throws ElementNotFoundError when binding map has no element', async () => {
        const action = fakeAction({ type: 'click' })
        try {
            await executeAction(mockPageNoElement(), action, ActionId('act_missing'))
            expect.fail('expected to throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ElementNotFoundError)
            expect((err as ExecutionError).code).toBe('element_not_found')
            expect((err as ExecutionError).actionId).toBe('act_missing')
        }
    })

    it('returns ElementNotFoundError when evaluateHandle throws', async () => {
        const page = {
            evaluateHandle: vi.fn().mockRejectedValue(new Error('detached frame')),
        } as unknown as Page
        await expect(
            executeAction(page, fakeAction(), ActionId('act_x')),
        ).rejects.toBeInstanceOf(ElementNotFoundError)
    })
})

describe('executeAction — observability', () => {
    it('emits start + skipped events on disabled action', async () => {
        const { logger, events } = captureLogger()
        const action = fakeAction({ disabled: true })
        await executeAction(mockPageNoElement(), action, ActionId('act_1'), undefined, { logger })
            .catch(() => {})
        expect(events.find((e) => e.event === 'action.execute.start')).toBeDefined()
        expect(events.find((e) => e.event === 'action.execute.skipped')).toBeDefined()
    })

    it('emits start + failed events on element-not-found', async () => {
        const { logger, events } = captureLogger()
        await executeAction(mockPageNoElement(), fakeAction(), ActionId('act_1'), undefined, { logger })
            .catch(() => {})
        expect(events.find((e) => e.event === 'action.execute.start')).toBeDefined()
        const failed = events.find((e) => e.event === 'action.execute.failed')
        expect(failed).toBeDefined()
        expect(failed?.data?.code).toBe('element_not_found')
    })

    it('does not emit when no logger is provided (default noop)', async () => {
        // Smoke test: ensure absence of logger does not crash
        await expect(
            executeAction(mockPageNoElement(), fakeAction(), ActionId('act_1')),
        ).rejects.toThrow()
    })
})

describe('error hierarchy', () => {
    it('all execution errors extend AgentMarkError', () => {
        const id = ActionId('act_x')
        const errs: AgentMarkError[] = [
            new ActionNotFoundError(id),
            new ActionDisabledError(id, 'reason'),
            new ActionTypeError(id, 'string', 'number'),
            new ElementNotFoundError(id),
            new ExecutionTimeoutError(id, 30_000),
            new ExecutionError('custom', 'msg', id),
        ]
        for (const err of errs) {
            expect(err).toBeInstanceOf(AgentMarkError)
            expect(err).toBeInstanceOf(ExecutionError)
            expect(typeof err.code).toBe('string')
            expect(err.code.length).toBeGreaterThan(0)
        }
    })

    it('preserves prototype chain (instanceof works after throw)', () => {
        try {
            throw new ActionNotFoundError(ActionId('act_x'))
        } catch (err) {
            expect(err).toBeInstanceOf(ActionNotFoundError)
            expect(err).toBeInstanceOf(ExecutionError)
            expect(err).toBeInstanceOf(AgentMarkError)
            expect(err).toBeInstanceOf(Error)
        }
    })

    it('isAgentMarkError narrows unknown values correctly', () => {
        const err: unknown = new ActionNotFoundError(ActionId('act_x'))
        const plain: unknown = new Error('plain')
        expect(isAgentMarkError(err)).toBe(true)
        expect(isAgentMarkError(plain)).toBe(false)
        expect(isAgentMarkError('string')).toBe(false)
        expect(isAgentMarkError(null)).toBe(false)
    })

    it('error codes are stable strings (do not depend on instance state)', () => {
        const id = ActionId('act_x')
        expect(new ActionNotFoundError(id).code).toBe('action_not_found')
        expect(new ActionDisabledError(id, 'r').code).toBe('action_disabled')
        expect(new ActionTypeError(id, 'string', 'number').code).toBe('action_value_type_mismatch')
        expect(new ElementNotFoundError(id).code).toBe('element_not_found')
        expect(new ExecutionTimeoutError(id, 1000).code).toBe('execution_timeout')
    })
})

describe('ActionId branded type', () => {
    it('ActionId() constructor returns the same string at runtime', () => {
        expect(ActionId('act_7')).toBe('act_7')
    })

    it('ActionId values are usable as Map keys', () => {
        const m = new Map<string, number>()
        m.set(ActionId('act_1'), 1)
        expect(m.get('act_1')).toBe(1)
    })
})

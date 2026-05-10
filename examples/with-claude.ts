/**
 * Caller's-loop example — Claude reads an AgentMark snapshot via tool use,
 * picks an action ID, AgentMark executes it. Repeat until done.
 *
 * AgentMark itself has no agent loop. The caller (this file) brings it.
 *
 * Requires:
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=...
 *
 *   npx tsx examples/with-claude.ts "<goal>" "<starting URL>"
 */

import Anthropic from '@anthropic-ai/sdk'
import { createBrowser, ActionNotFoundError, type Page } from '../src'

const MODEL = 'claude-sonnet-4-6'
const MAX_STEPS = 20

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'execute_action',
        description:
            'Execute an AgentMark action by ID. Look up the ID in the snapshot\'s `actions` map.',
        input_schema: {
            type: 'object' as const,
            properties: {
                action_id: { type: 'string', description: 'The action ID, e.g. "act_7"' },
                value: {
                    description:
                        'Value for actions that take input (type/select/check/upload/etc.). Omit for click/hover/etc.',
                },
            },
            required: ['action_id'],
        },
    },
    {
        name: 'finish',
        description: 'Call when the goal has been achieved. Provide a brief summary.',
        input_schema: {
            type: 'object' as const,
            properties: {
                summary: { type: 'string' },
            },
            required: ['summary'],
        },
    },
]

async function runAgent(page: Page, goal: string): Promise<string> {
    const client = new Anthropic()
    const messages: Anthropic.MessageParam[] = []

    for (let step = 0; step < MAX_STEPS; step++) {
        const snapshot = await page.snapshot()
        messages.push({
            role: 'user',
            content: `Goal: ${goal}\n\nCurrent page:\n\n${snapshot.agentmark}`,
        })

        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system:
                'You are an AI agent driving a browser via the AgentMark format. '
                + 'Read the snapshot, pick the next action, and call execute_action. '
                + 'Call finish when the goal is achieved.',
            tools: TOOLS,
            messages,
        })

        messages.push({ role: 'assistant', content: response.content })

        const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        if (!toolUse) {
            return 'Agent stopped without calling a tool.'
        }

        if (toolUse.name === 'finish') {
            const input = toolUse.input as { summary: string }
            return input.summary
        }

        if (toolUse.name === 'execute_action') {
            const input = toolUse.input as { action_id: string; value?: unknown }
            try {
                const result = await page.execute(input.action_id, input.value)
                messages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: `Executed ${result.actionType} on ${result.actionId} (${result.durationMs}ms).`,
                        },
                    ],
                })
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                messages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: `Failed: ${message}`,
                            is_error: true,
                        },
                    ],
                })
                if (err instanceof ActionNotFoundError) {
                    // Snapshot may be stale — loop will recapture next iteration
                    continue
                }
            }
        }
    }

    return `Reached ${MAX_STEPS}-step budget without finishing.`
}

async function main() {
    const goal = process.argv[2] ?? 'Find the contact email on the about page'
    const startUrl = process.argv[3] ?? 'https://example.com'

    const browser = await createBrowser({ launch: { headless: false } })
    try {
        const page = await browser.newPage()
        await page.goto(startUrl)
        const result = await runAgent(page, goal)
        console.log('\n──────────\n', result)
    } finally {
        await browser.close()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

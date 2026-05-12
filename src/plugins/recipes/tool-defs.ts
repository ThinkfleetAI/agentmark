/**
 * Recipes Pack — tool definitions.
 *
 * CRUD + resolution (playbook). The plugin doesn't auto-execute recipes
 * server-side; agentmark_recipe_get returns the resolved plan and the
 * agent dispatches each step itself.
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const RECIPES_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_recipe_save',
        description:
            'Persist a recipe — a named sequence of MCP tool calls with '
            + 'optional parameter substitution. Recipes are durable across '
            + 'MCP sessions, so once the agent figures out "to add a '
            + 'customer in NowCerts, do X then Y then Z" it never needs to '
            + 'rediscover the sequence.\n'
            + '\nFor `args` strings, embed `{{param.name}}` to reference '
            + 'parameter values defined in `parameters`. Bare-string tokens '
            + 'preserve the param\'s native type; embedded tokens are '
            + 'string-interpolated.\n'
            + '\nReturns the saved recipe with assigned version + timestamps.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Unique recipe id.' },
                description: { type: 'string' },
                target_app: { type: 'string', description: 'App or surface this drives ("excel", "nowcerts", etc.). Used by list filter.' },
                parameters: {
                    type: 'array',
                    description: 'Parameter schema.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string', enum: ['string', 'number', 'boolean'] },
                            description: { type: 'string' },
                            default: { description: 'Value used when the caller omits the param.' },
                            required: { type: 'boolean' },
                        },
                        required: ['name', 'type'],
                    },
                },
                steps: {
                    type: 'array',
                    description: 'Ordered list of MCP tool calls to execute.',
                    items: {
                        type: 'object',
                        properties: {
                            tool: { type: 'string', description: 'MCP tool name to call.' },
                            args: { type: 'object', description: 'Arguments (string values may contain `{{param.name}}` placeholders).' },
                            description: { type: 'string' },
                            verify: {
                                type: 'object',
                                description: 'Optional verification hint for the AI to check via diff after this step.',
                            },
                            on_failure: { type: 'string', enum: ['abort', 'continue', 'retry'] },
                        },
                        required: ['tool', 'args'],
                    },
                },
                on_conflict: {
                    type: 'string',
                    enum: ['replace', 'fail'],
                    description: 'What to do if a recipe with this name already exists. Default: fail.',
                },
            },
            required: ['name', 'steps'],
        },
    },
    {
        name: 'agentmark_recipe_list',
        description:
            'List saved recipes. Optionally filter by `target_app`. Each '
            + 'entry includes name, description, target_app, parameter count, '
            + 'step count, version, created_at, updated_at.',
        inputSchema: {
            type: 'object',
            properties: {
                target_app: { type: 'string', description: 'Only return recipes with this target_app.' },
            },
        },
    },
    {
        name: 'agentmark_recipe_get',
        description:
            'Fetch a recipe by name. When `params` is supplied, the recipe '
            + 'is resolved (parameter substitution applied + defaults filled '
            + 'in) and the steps come back ready to dispatch. Without `params`, '
            + 'returns the raw recipe with placeholders intact.\n'
            + '\nThe agent should iterate the returned `steps` and call '
            + 'each one\'s `tool` with its `args` via the regular MCP '
            + 'dispatch path. After each step that has a `verify` block, '
            + 'consider calling agentmark_desktop_diff to confirm the '
            + 'expected change occurred.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                params: {
                    type: 'object',
                    description: 'Caller-supplied parameter values. Triggers resolution.',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'agentmark_recipe_delete',
        description: 'Remove a recipe by name. Returns whether it existed.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
            },
            required: ['name'],
        },
    },
]

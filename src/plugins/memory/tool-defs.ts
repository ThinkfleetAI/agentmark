/**
 * Memory Pack — tool definitions.
 *
 * Hierarchical persistent memory for AI agents (especially IDE coding
 * assistants that suffer per-session amnesia). Five scope levels;
 * `get` walks the hierarchy from most-specific to most-general.
 */
import type { McpToolDef } from '../../mcp/tool-defs'

const SCOPE_PROPERTY = {
    type: 'object',
    description:
        'Memory scope. One of:\n'
        + '  - platform: global across this install (no id)\n'
        + '  - project: scoped to a repo / working dir (id = absolute path)\n'
        + '  - agent: scoped to one AI agent (id = agent name)\n'
        + '  - user: scoped to an end-user identity (id = email / user id)\n'
        + '  - session: scoped to one MCP session (id = session id)',
    properties: {
        type: { type: 'string', enum: ['platform', 'project', 'agent', 'user', 'session'] },
        id: { type: 'string', description: 'Required for all scope types except platform.' },
    },
    required: ['type'],
} as const

export const MEMORY_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_memory_set',
        description:
            'Store a memory the agent can retrieve later. Memories survive '
            + 'across MCP sessions — use them to remember things like "this '
            + 'repo uses pnpm not npm", "the user prefers terse code reviews", '
            + '"last successful build was on 2026-05-12". Same key + same '
            + 'scope replaces the existing memory.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Free-form key within the scope.' },
                value: { description: 'Any JSON-serialisable value.' },
                scope: SCOPE_PROPERTY,
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional tags for search.',
                },
                ttl_seconds: {
                    type: 'number',
                    description: 'Optional TTL. Omit for memories that should persist forever.',
                },
            },
            required: ['key', 'value'],
        },
    },
    {
        name: 'agentmark_memory_get',
        description:
            'Fetch a memory by key. When `scopes` is supplied, each scope '
            + 'is tried in order and the first hit is returned — use this to '
            + 'resolve "this project\'s value, falling back to my user default, '
            + 'falling back to platform default" in one call. Without `scopes`, '
            + 'only the plugin\'s default scope is queried.\n'
            + '\nReturns null when no scope has the key (or when all matches '
            + 'have expired). Bumps access_count + last_accessed_at on hits.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                scopes: {
                    type: 'array',
                    items: SCOPE_PROPERTY,
                    description: 'Ordered list of scopes to try (most specific first).',
                },
            },
            required: ['key'],
        },
    },
    {
        name: 'agentmark_memory_search',
        description:
            'Search memories by substring + tags. `query` matches the key or '
            + 'stringified value case-insensitively. `tags` filters to records '
            + 'with any of the listed tags. `scope` restricts to one scope.\n'
            + '\nSort by recency (default), access_count, or created.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Substring (case-insensitive).' },
                scope: SCOPE_PROPERTY,
                tags: { type: 'array', items: { type: 'string' } },
                limit: { type: 'number', description: 'Max results. Default: 50.' },
                sort_by: { type: 'string', enum: ['recency', 'access_count', 'created'] },
            },
        },
    },
    {
        name: 'agentmark_memory_list',
        description:
            'List memories in a scope (optionally filtered by key prefix). '
            + 'Same shape as search results, sorted by updated_at desc.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: SCOPE_PROPERTY,
                prefix: { type: 'string', description: 'Only keys starting with this string.' },
                limit: { type: 'number', description: 'Default: 200.' },
            },
        },
    },
    {
        name: 'agentmark_memory_delete',
        description:
            'Remove a memory. Pass either `record_id` (returned by set/get) '
            + 'OR `key` + `scope` to delete by lookup. Returns whether anything '
            + 'was deleted.',
        inputSchema: {
            type: 'object',
            properties: {
                record_id: { type: 'string' },
                key: { type: 'string' },
                scope: SCOPE_PROPERTY,
            },
        },
    },
]

/**
 * Foundations Pack — tool definitions.
 *
 * The "OS basics" layer: app launching, clipboard, filesystem, durable
 * state. Cross-platform, pure-Node (no bridge dependencies). Pairs
 * with the desktop driver so agents can touch the rest of the machine,
 * not just the running app they're driving.
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const FOUNDATIONS_TOOLS: McpToolDef[] = [
    // ── App launching ──────────────────────────────────────────────────
    {
        name: 'agentmark_app_run',
        description:
            'Launch an application or open a file with its associated app. '
            + 'Cross-platform: detects whether `command` is an app name, an '
            + 'absolute binary path, or a file path, and uses the right OS '
            + 'mechanism (open / start / xdg-open). Returns the launcher PID; '
            + 'use agentmark_desktop_list_targets afterward to find the '
            + 'app\'s window once it\'s ready.',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description:
                        'App name ("Excel"), absolute path ("/Applications/Calculator.app", '
                        + '"C:\\\\Program Files\\\\..."), or file path ("report.xlsx").',
                },
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Extra arguments forwarded to the launched app.',
                },
                cwd: {
                    type: 'string',
                    description: 'Working directory for the spawn.',
                },
                detached: {
                    type: 'boolean',
                    description:
                        'Detach so the launched process survives the MCP server. '
                        + 'Default: true (recommended for any UI app).',
                },
            },
            required: ['command'],
        },
    },

    // ── Clipboard ──────────────────────────────────────────────────────
    {
        name: 'agentmark_clipboard_read',
        description: 'Read text from the OS clipboard. Cross-platform (no external deps).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'agentmark_clipboard_write',
        description: 'Write text to the OS clipboard.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
            },
            required: ['text'],
        },
    },

    // ── Filesystem ─────────────────────────────────────────────────────
    {
        name: 'agentmark_files_list',
        description:
            'List the contents of a directory. Set recursive=true to walk '
            + 'subdirectories. Every returned path is within the configured '
            + 'allowlist (default: cwd + os.tmpdir, override via '
            + 'AGENTMARK_FILES_ROOTS env var).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                recursive: { type: 'boolean', description: 'Walk subdirectories. Default: false.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'agentmark_files_read',
        description:
            'Read a file. `encoding`="utf8" (default) returns the text directly; '
            + '"base64" returns base64-encoded bytes for binary content.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
            },
            required: ['path'],
        },
    },
    {
        name: 'agentmark_files_write',
        description:
            'Write content to a file. `encoding`="utf8" (default) writes text directly; '
            + '"base64" decodes base64 to bytes first. Set append=true to append '
            + 'instead of overwriting.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'] },
                append: { type: 'boolean', description: 'Append instead of overwrite. Default: false.' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'agentmark_files_stat',
        description: 'Return file metadata: kind, size, modified time.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
    },
    {
        name: 'agentmark_files_delete',
        description:
            'Delete a file or directory. recursive=true is required to delete '
            + 'non-empty directories (a safety check, not a convenience flag).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                recursive: { type: 'boolean', description: 'Required for directories. Default: false.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'agentmark_files_move',
        description: 'Move or rename a file/directory. Both `from` and `to` must be within the allowlist.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
            },
            required: ['from', 'to'],
        },
    },
    {
        name: 'agentmark_files_mkdir',
        description: 'Create a directory. recursive=true creates intermediate parents.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                recursive: { type: 'boolean', description: 'Create intermediate dirs. Default: true.' },
            },
            required: ['path'],
        },
    },

    // ── Durable state ──────────────────────────────────────────────────
    {
        name: 'agentmark_state_get',
        description:
            'Read a value from the durable agent state store. Returns the '
            + 'value (any JSON-serialisable shape) or null if the key is unset. '
            + 'Backed by ~/.thinkfleet/agentmark/state.json (0600).',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
    },
    {
        name: 'agentmark_state_set',
        description: 'Write a value to the durable agent state store. Value may be any JSON-serialisable shape.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                value: { description: 'Any JSON-serialisable value.' },
            },
            required: ['key', 'value'],
        },
    },
    {
        name: 'agentmark_state_delete',
        description: 'Remove a key from the durable state store. Returns whether the key existed.',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
    },
    {
        name: 'agentmark_state_list',
        description:
            'List keys in the durable state store, optionally filtered by a '
            + '`prefix`. Returns array of {key, value} entries.',
        inputSchema: {
            type: 'object',
            properties: {
                prefix: { type: 'string', description: 'Only return keys starting with this prefix.' },
            },
        },
    },
]

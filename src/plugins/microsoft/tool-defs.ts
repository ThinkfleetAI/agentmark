/**
 * Microsoft Workflows Pack — tool definitions.
 *
 * v0 surface: device-code login, Outlook (send/search/reply/get_message),
 * OneDrive (list/upload/download). All universal — works identically on
 * Windows and macOS because they hit Microsoft Graph rather than native
 * COM/AppleScript bindings. (Excel + Word drivers ship in PR B.)
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const MICROSOFT_TOOLS: McpToolDef[] = [
    // ── Auth ─────────────────────────────────────────────────────────────
    {
        name: 'agentmark_microsoft_login',
        description:
            'Initiate Microsoft Graph device-code login. Returns a short '
            + 'user_code + verification_uri to surface to the human user. '
            + 'When `wait=true` (default), the tool polls until login '
            + 'completes and returns the resulting token state. When '
            + '`wait=false`, returns immediately so a UI can render the '
            + 'code itself and call again later. Tokens are persisted to '
            + '~/.thinkfleet/agentmark/microsoft-tokens.json (0600).',
        inputSchema: {
            type: 'object',
            properties: {
                wait: {
                    type: 'boolean',
                    description: 'Block until the user completes login (default: true).',
                },
            },
        },
    },
    {
        name: 'agentmark_microsoft_logout',
        description: 'Clear the cached Microsoft Graph tokens (forces a fresh login).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'agentmark_microsoft_whoami',
        description:
            'Return basic profile info for the currently authenticated '
            + 'Microsoft Graph user (id, displayName, userPrincipalName, mail). '
            + 'Useful for confirming which account a session is operating against.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Outlook ──────────────────────────────────────────────────────────
    {
        name: 'agentmark_outlook_send_email',
        description:
            'Send an email via Outlook (Microsoft Graph). Body may be plain '
            + 'text or HTML. Recipients are arrays; pass strings for simple '
            + 'addresses or {address, name} objects for display-name overrides. '
            + 'Optional CC/BCC. Attachments are inline base64 byte arrays.',
        inputSchema: {
            type: 'object',
            properties: {
                to: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Recipient email addresses.',
                },
                subject: { type: 'string' },
                body: { type: 'string', description: 'Message body (HTML or plain text — see body_type).' },
                body_type: {
                    type: 'string',
                    enum: ['html', 'text'],
                    description: 'Body content type. Default: html.',
                },
                cc: { type: 'array', items: { type: 'string' } },
                bcc: { type: 'array', items: { type: 'string' } },
                save_to_sent_items: {
                    type: 'boolean',
                    description: 'Persist a copy in Sent Items. Default: true.',
                },
            },
            required: ['to', 'subject', 'body'],
        },
    },
    {
        name: 'agentmark_outlook_search',
        description:
            'Search the authenticated user\'s mailbox. Uses Graph KQL '
            + '(e.g. `from:alice@x.com AND subject:invoice`). Returns up '
            + 'to `top` message summaries with id, subject, from, '
            + 'receivedDateTime, hasAttachments, previewBody.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'KQL query.' },
                top: { type: 'number', description: 'Max messages to return (default 25, max 100).' },
                folder: {
                    type: 'string',
                    description:
                        'Restrict to a folder ID or well-known folder name '
                        + '(inbox, sentItems, drafts, etc). Default: inbox.',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'agentmark_outlook_get_message',
        description:
            'Fetch a single message by id, including body. Returns subject, '
            + 'from, to, cc, body content + content type, attachment list.',
        inputSchema: {
            type: 'object',
            properties: {
                message_id: { type: 'string' },
            },
            required: ['message_id'],
        },
    },
    {
        name: 'agentmark_outlook_reply',
        description:
            'Reply to an existing message by id. Sends to the original '
            + 'sender (and CC list if reply_all=true). Body is HTML or text '
            + '— see body_type.',
        inputSchema: {
            type: 'object',
            properties: {
                message_id: { type: 'string' },
                body: { type: 'string' },
                body_type: {
                    type: 'string',
                    enum: ['html', 'text'],
                    description: 'Body content type. Default: html.',
                },
                reply_all: {
                    type: 'boolean',
                    description: 'Send to original sender + CC list. Default: false.',
                },
            },
            required: ['message_id', 'body'],
        },
    },

    // ── OneDrive ─────────────────────────────────────────────────────────
    {
        name: 'agentmark_onedrive_list',
        description:
            'List the contents of a OneDrive folder. Pass a slash-prefixed '
            + 'path (e.g. "/Documents/Invoices") or omit `path` to list the '
            + 'root. Returns name, id, kind (file|folder), size, modified time.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Folder path within the drive (omit for root).',
                },
                top: { type: 'number', description: 'Max items to return (default 200).' },
            },
        },
    },
    {
        name: 'agentmark_onedrive_upload',
        description:
            'Upload a local file to OneDrive. For files under ~4MB this is '
            + 'a single PUT; larger files use a resumable upload session. '
            + 'Returns the resulting OneDrive item id + webUrl.',
        inputSchema: {
            type: 'object',
            properties: {
                local_path: { type: 'string', description: 'Absolute path on the local filesystem.' },
                remote_path: {
                    type: 'string',
                    description: 'OneDrive target path (e.g. "/Documents/report.pdf").',
                },
                conflict_behavior: {
                    type: 'string',
                    enum: ['rename', 'replace', 'fail'],
                    description: 'How to handle existing files. Default: replace.',
                },
            },
            required: ['local_path', 'remote_path'],
        },
    },
    {
        name: 'agentmark_onedrive_download',
        description:
            'Download a OneDrive file to a local path. Returns the local '
            + 'path + byte count.',
        inputSchema: {
            type: 'object',
            properties: {
                remote_path: {
                    type: 'string',
                    description: 'OneDrive source path (e.g. "/Documents/report.pdf").',
                },
                local_path: { type: 'string', description: 'Where to write the file locally.' },
            },
            required: ['remote_path', 'local_path'],
        },
    },
]

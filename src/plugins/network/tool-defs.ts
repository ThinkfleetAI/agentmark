/**
 * Network Pack — tool definitions.
 *
 * HTTP request + WebSocket session management. Both bounded by a URL
 * allowlist that the operator configures explicitly (empty by default).
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const NETWORK_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_http_request',
        description:
            'Make an HTTP request to a URL on the configured allowlist. '
            + 'Supports GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Body is '
            + 'auto-encoded: JSON objects → application/json string, strings '
            + 'sent verbatim, { base64: "..." } objects → raw bytes.\n'
            + '\n`response_format` controls the body shape:\n'
            + '  - "text" (default): body returned as a string\n'
            + '  - "json": body parsed (errors if not valid JSON)\n'
            + '  - "base64": body base64-encoded (use for binary content)',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                method: {
                    type: 'string',
                    description: 'HTTP method. Default: GET.',
                },
                headers: {
                    type: 'object',
                    description: 'Request headers. Content-Type is set automatically when a JSON body is supplied.',
                },
                body: {
                    description: 'Request body. JSON object → stringified; string → verbatim; { base64 } → raw bytes.',
                },
                response_format: {
                    type: 'string',
                    enum: ['text', 'json', 'base64'],
                    description: 'How to encode the response body. Default: text.',
                },
                timeout_ms: { type: 'number', description: 'Request timeout in ms. Default: 30000.' },
                follow_redirects: { type: 'boolean', description: 'Follow 3xx redirects. Default: true.' },
            },
            required: ['url'],
        },
    },

    // ── WebSockets ─────────────────────────────────────────────────────
    {
        name: 'agentmark_websocket_connect',
        description:
            'Open a WebSocket connection to a URL on the allowlist. Returns '
            + 'a ws_id once the handshake completes. Subsequent send/receive '
            + 'calls target the session by ws_id.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                protocols: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Sec-WebSocket-Protocol subprotocols to offer.',
                },
            },
            required: ['url'],
        },
    },
    {
        name: 'agentmark_websocket_send',
        description: 'Send a message on a WebSocket session.',
        inputSchema: {
            type: 'object',
            properties: {
                ws_id: { type: 'string' },
                data: { type: 'string' },
                format: {
                    type: 'string',
                    enum: ['text', 'base64'],
                    description: '"base64" decodes `data` to bytes before sending. Default: text.',
                },
            },
            required: ['ws_id', 'data'],
        },
    },
    {
        name: 'agentmark_websocket_receive',
        description:
            'Pull queued messages from a WebSocket session. If no messages '
            + 'are queued, waits up to `timeout_ms` (default: 5000) for the '
            + 'next one. Returns an array (possibly empty if the timeout fires '
            + 'or the socket closed).',
        inputSchema: {
            type: 'object',
            properties: {
                ws_id: { type: 'string' },
                timeout_ms: { type: 'number', description: 'Max wait when the queue is empty. Default: 5000.' },
                max: { type: 'number', description: 'Max messages to return in one call. Default: 100.' },
            },
            required: ['ws_id'],
        },
    },
    {
        name: 'agentmark_websocket_close',
        description: 'Close a WebSocket session. Sends a close frame and releases the session.',
        inputSchema: {
            type: 'object',
            properties: {
                ws_id: { type: 'string' },
                code: { type: 'number', description: 'WebSocket close code. Default: 1000 (normal).' },
                reason: { type: 'string' },
            },
            required: ['ws_id'],
        },
    },
]

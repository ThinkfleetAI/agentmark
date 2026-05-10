/**
 * MCP tool definitions for AgentMark.
 *
 * Each tool corresponds to one operation in the AgentMark SDK; agents drive
 * the library by calling these. Names follow `agentmark_<surface>_<verb>`.
 *
 * Schema follows the JSON Schema flavor MCP expects.
 */

export interface McpToolDef {
    name: string
    description: string
    inputSchema: {
        type: 'object'
        properties: Record<string, unknown>
        required?: string[]
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Web browser tools
// ──────────────────────────────────────────────────────────────────────────

const WEB_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_browser_open',
        description:
            'Launch a Chromium browser and return a browser_id. The browser '
            + 'lives for the duration of the MCP session unless explicitly '
            + 'closed. Optional: load a previously saved session file to resume '
            + 'an authenticated state.',
        inputSchema: {
            type: 'object',
            properties: {
                headless: {
                    type: 'boolean',
                    description: 'Run Chromium in headless mode (default: true).',
                },
                session_path: {
                    type: 'string',
                    description: 'Path to a session file produced by browser_save_session.',
                },
            },
        },
    },
    {
        name: 'agentmark_browser_close',
        description: 'Close a browser and all its pages.',
        inputSchema: {
            type: 'object',
            properties: {
                browser_id: { type: 'string' },
            },
            required: ['browser_id'],
        },
    },
    {
        name: 'agentmark_browser_save_session',
        description:
            'Persist the browser\'s cookies + storage to a file path so a '
            + 'future agentmark_browser_open call can resume the same session.',
        inputSchema: {
            type: 'object',
            properties: {
                browser_id: { type: 'string' },
                path: { type: 'string', description: 'Output file path.' },
            },
            required: ['browser_id', 'path'],
        },
    },
    {
        name: 'agentmark_page_open',
        description: 'Open a new page in a browser. Returns a page_id.',
        inputSchema: {
            type: 'object',
            properties: {
                browser_id: { type: 'string' },
            },
            required: ['browser_id'],
        },
    },
    {
        name: 'agentmark_page_navigate',
        description:
            'Navigate a page to a URL. Invalidates any cached snapshot. '
            + 'Returns once the wait condition is met (default: load).',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
                url: { type: 'string' },
                wait_until: {
                    type: 'string',
                    enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                },
                timeout: { type: 'number', description: 'Timeout in milliseconds.' },
            },
            required: ['page_id', 'url'],
        },
    },
    {
        name: 'agentmark_page_snapshot',
        description:
            'Capture an AgentMark snapshot of the current page state. Returns '
            + 'the YAML+markdown wire format. The result is cached on the page '
            + 'so subsequent agentmark_page_execute calls can resolve action IDs.',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
            },
            required: ['page_id'],
        },
    },
    {
        name: 'agentmark_page_execute',
        description:
            'Execute an action by ID against the most recent snapshot. Pass '
            + '`value` for actions that take input (type, select, check, etc).',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
                action_id: { type: 'string' },
                value: {
                    description:
                        'Value for actions that take input. Omit for click/hover/etc.',
                },
            },
            required: ['page_id', 'action_id'],
        },
    },
    {
        name: 'agentmark_page_close',
        description: 'Close a single page.',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'string' },
            },
            required: ['page_id'],
        },
    },
]

// ──────────────────────────────────────────────────────────────────────────
// PDF / document tools
// ──────────────────────────────────────────────────────────────────────────

const PDF_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_pdf_open',
        description:
            'Open a PDF document for reading + form interaction. Returns a '
            + 'doc_id. Source can be a local file path OR a base64-encoded '
            + 'data URI (e.g. "data:application/pdf;base64,JVBERi0..."). '
            + 'The document is held in memory until agentmark_pdf_close. '
            + 'Set enable_ocr=true for scanned PDFs or "Microsoft Print To PDF" '
            + 'output where text extraction yields nothing.',
        inputSchema: {
            type: 'object',
            properties: {
                source: {
                    type: 'string',
                    description: 'File path OR `data:application/pdf;base64,...` URI.',
                },
                source_url: {
                    type: 'string',
                    description: 'Optional URI to record as the snapshot\'s `url` field.',
                },
                title: {
                    type: 'string',
                    description: 'Override the document title.',
                },
                password: {
                    type: 'string',
                    description: 'Password for encrypted PDFs.',
                },
                enable_ocr: {
                    type: 'boolean',
                    description:
                        'Run OCR (Tesseract + Poppler) on pages with no extractable '
                        + 'text. Requires `pdftoppm` on the worker host (macOS: '
                        + '`brew install poppler`). Default: false.',
                },
                ocr_language: {
                    type: 'string',
                    description: 'BCP-47 language hint for OCR. Default: eng.',
                },
                ocr_dpi: {
                    type: 'number',
                    description: 'DPI for OCR rasterization. Default: 200.',
                },
            },
            required: ['source'],
        },
    },
    {
        name: 'agentmark_pdf_close',
        description: 'Close an opened PDF document and release its resources.',
        inputSchema: {
            type: 'object',
            properties: {
                doc_id: { type: 'string' },
            },
            required: ['doc_id'],
        },
    },
    {
        name: 'agentmark_pdf_snapshot',
        description:
            'Capture an AgentMark snapshot of the PDF. PDFs with form fields '
            + 'will have `kind: "form"` with all fields exposed as actions; '
            + 'plain documents have `kind: "document"`. Returns the YAML+markdown '
            + 'wire format.',
        inputSchema: {
            type: 'object',
            properties: {
                doc_id: { type: 'string' },
            },
            required: ['doc_id'],
        },
    },
    {
        name: 'agentmark_pdf_execute',
        description:
            'Fill a form field by action ID. Value type depends on the action '
            + 'type: string for text/select/radio, boolean for checkbox, '
            + 'string[] for multi_select. Changes are buffered until '
            + 'agentmark_pdf_save is called.',
        inputSchema: {
            type: 'object',
            properties: {
                doc_id: { type: 'string' },
                action_id: { type: 'string' },
                value: {
                    description: 'Value for the field. Type depends on action type.',
                },
            },
            required: ['doc_id', 'action_id'],
        },
    },
    {
        name: 'agentmark_pdf_save',
        description:
            'Write the PDF (with all queued field values applied) to a file. '
            + 'Returns the absolute path. If `flatten` is true, field values '
            + 'are baked into the page content and the PDF is no longer fillable.',
        inputSchema: {
            type: 'object',
            properties: {
                doc_id: { type: 'string' },
                output_path: {
                    type: 'string',
                    description: 'Where to write the filled PDF.',
                },
                flatten: {
                    type: 'boolean',
                    description: 'Bake values into page content (default: false).',
                },
            },
            required: ['doc_id', 'output_path'],
        },
    },
    {
        name: 'agentmark_pdf_reset',
        description: 'Discard all queued field values without saving.',
        inputSchema: {
            type: 'object',
            properties: {
                doc_id: { type: 'string' },
            },
            required: ['doc_id'],
        },
    },
]

// ──────────────────────────────────────────────────────────────────────────
// Session inspection
// ──────────────────────────────────────────────────────────────────────────

const META_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_list_sessions',
        description:
            'List all currently open browsers, pages, and PDF documents '
            + 'with their IDs. Useful for debugging or recovering a stuck session.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
]

export const ALL_TOOLS: McpToolDef[] = [...WEB_TOOLS, ...PDF_TOOLS, ...META_TOOLS]

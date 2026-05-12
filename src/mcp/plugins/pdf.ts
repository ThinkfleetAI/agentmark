/**
 * PDF MCP plugin.
 *
 * Wraps the AgentMark PDF document API (open / snapshot / execute / save /
 * reset / close) as MCP tools. Owns its own PdfSession map.
 */
import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    openPdfDocument,
    PopplerRenderBackend,
    TesseractOcrBackend,
    type PdfDocument,
    type OcrPipelineOptions,
} from '../../index'
import { generateSessionId, type PdfSession } from '../types'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../plugin'
import type { McpToolDef } from '../tool-defs'

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
                source: { type: 'string', description: 'File path OR `data:application/pdf;base64,...` URI.' },
                source_url: { type: 'string', description: 'Optional URI to record as the snapshot\'s `url` field.' },
                title: { type: 'string', description: 'Override the document title.' },
                password: { type: 'string', description: 'Password for encrypted PDFs.' },
                enable_ocr: {
                    type: 'boolean',
                    description:
                        'Run OCR (Tesseract + Poppler) on pages with no extractable '
                        + 'text. Requires `pdftoppm` on the worker host (macOS: '
                        + '`brew install poppler`). Default: false.',
                },
                ocr_language: { type: 'string', description: 'BCP-47 language hint for OCR. Default: eng.' },
                ocr_dpi: { type: 'number', description: 'DPI for OCR rasterization. Default: 200.' },
            },
            required: ['source'],
        },
    },
    {
        name: 'agentmark_pdf_close',
        description: 'Close an opened PDF document and release its resources.',
        inputSchema: {
            type: 'object',
            properties: { doc_id: { type: 'string' } },
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
            properties: { doc_id: { type: 'string' } },
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
                value: { description: 'Value for the field. Type depends on action type.' },
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
                output_path: { type: 'string', description: 'Where to write the filled PDF.' },
                flatten: { type: 'boolean', description: 'Bake values into page content (default: false).' },
            },
            required: ['doc_id', 'output_path'],
        },
    },
    {
        name: 'agentmark_pdf_reset',
        description: 'Discard all queued field values without saving.',
        inputSchema: {
            type: 'object',
            properties: { doc_id: { type: 'string' } },
            required: ['doc_id'],
        },
    },
]

export interface PdfPlugin extends AgentMarkPlugin {
    readonly pdfs: Map<string, PdfSession>
}

export function createPdfPlugin(): PdfPlugin {
    const pdfs = new Map<string, PdfSession>()

    const requirePdf = (id: string): PdfDocument => {
        const s = pdfs.get(id)
        if (!s) throw new Error(`Unknown doc_id: ${id}`)
        return s.document
    }

    const handlers: Record<string, ToolHandler> = {
        agentmark_pdf_open: async (args): Promise<DispatchResult> => {
            const source = requireString(args, 'source')
            const data = await loadPdfBytes(source)
            const sourceUrl =
                typeof args.source_url === 'string'
                    ? args.source_url
                    : source.startsWith('data:')
                        ? source.slice(0, 80) + '...'
                        : pathToFileURL(path.resolve(source)).toString()
            const title = typeof args.title === 'string' ? args.title : undefined
            const password = typeof args.password === 'string' ? args.password : undefined

            let ocr: OcrPipelineOptions | undefined
            if (args.enable_ocr === true) {
                const language = typeof args.ocr_language === 'string' ? args.ocr_language : 'eng'
                const dpi = typeof args.ocr_dpi === 'number' ? args.ocr_dpi : 200
                ocr = {
                    render: new PopplerRenderBackend(),
                    ocr: new TesseractOcrBackend({ language }),
                    mode: 'auto',
                    dpi,
                    language,
                }
            }

            const document = await openPdfDocument({ data, sourceUrl, title, password, ocr })
            const id = generateSessionId('pdf')
            pdfs.set(id, { id, document, createdAt: new Date() })
            return {
                text: JSON.stringify({
                    doc_id: id,
                    source_url: sourceUrl,
                    field_count: document.fields.size,
                    ocr_enabled: args.enable_ocr === true,
                }, null, 2),
            }
        },

        agentmark_pdf_close: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'doc_id')
            const session = pdfs.get(id)
            if (!session) return { text: `Unknown doc_id: ${id}`, isError: true }
            await session.document.close()
            pdfs.delete(id)
            return { text: `PDF ${id} closed.` }
        },

        agentmark_pdf_snapshot: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'doc_id')
            const snap = await requirePdf(id).snapshot()
            return { text: snap.agentmark }
        },

        agentmark_pdf_execute: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'doc_id')
            const actionId = requireString(args, 'action_id')
            const doc = requirePdf(id)
            await doc.execute(actionId, args.value)
            return {
                text: JSON.stringify({
                    action_id: actionId,
                    pending_count: doc.pending.size,
                }, null, 2),
            }
        },

        agentmark_pdf_save: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'doc_id')
            const outputPath = path.resolve(requireString(args, 'output_path'))
            const flatten = args.flatten === true
            const bytes = await requirePdf(id).save({ flatten })
            await writeFile(outputPath, bytes)
            return {
                text: JSON.stringify({
                    output_path: outputPath,
                    bytes: bytes.length,
                    flattened: flatten,
                }, null, 2),
            }
        },

        agentmark_pdf_reset: async (args): Promise<DispatchResult> => {
            const id = requireString(args, 'doc_id')
            requirePdf(id).reset()
            return { text: `PDF ${id} pending values cleared.` }
        },
    }

    return {
        name: 'pdf',
        tools: PDF_TOOLS,
        handlers,
        pdfs,
        dispose: async () => {
            await Promise.allSettled(
                Array.from(pdfs.values()).map((s) => s.document.close()),
            )
            pdfs.clear()
        },
        describeSessions: () => ({
            pdfs: Array.from(pdfs.values()).map((s) => ({
                doc_id: s.id,
                field_count: s.document.fields.size,
                pending: s.document.pending.size,
                created_at: s.createdAt.toISOString(),
            })),
        }),
    }
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

async function loadPdfBytes(source: string): Promise<Uint8Array> {
    if (source.startsWith('data:')) {
        const commaAt = source.indexOf(',')
        if (commaAt === -1) throw new Error('Malformed data URI')
        const header = source.slice(5, commaAt)
        const payload = source.slice(commaAt + 1)
        if (header.includes(';base64')) {
            return new Uint8Array(Buffer.from(payload, 'base64'))
        }
        return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
    }
    const buf = await readFile(path.resolve(source))
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

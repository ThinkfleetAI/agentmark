/**
 * Claude vision backend.
 *
 * Calls https://api.anthropic.com/v1/messages with an image + prompt.
 * Uses Claude's tool-use feature for structured output when a schema is
 * provided — most reliable way to get JSON back consistently.
 *
 * No SDK dependency — uses the global `fetch`. Authenticate via
 * `ANTHROPIC_API_KEY` env var or the constructor option.
 */

import { SnapshotError } from '../../errors'
import type { AnalyzeOptions, AnalyzeResult, VisionBackend } from './types'

export interface ClaudeVisionOptions {
    /** Anthropic API key. Defaults to env ANTHROPIC_API_KEY. */
    apiKey?: string
    /** Override the API base URL (e.g. for a self-hosted proxy). */
    endpoint?: string
    /** Model identifier. Default: 'claude-haiku-4-5-20251001'. */
    model?: string
    /** Anthropic API version header. Default: '2023-06-01'. */
    anthropicVersion?: string
}

interface AnthropicMessagesResponse {
    content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
    usage?: { input_tokens?: number; output_tokens?: number }
    stop_reason?: string
}

export class ClaudeVisionBackend implements VisionBackend {
    readonly name = 'claude'
    private readonly apiKey: string
    private readonly endpoint: string
    private readonly model: string
    private readonly anthropicVersion: string

    constructor(options: ClaudeVisionOptions = {}) {
        const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
        if (!apiKey) {
            throw new SnapshotError(
                'ClaudeVisionBackend requires an API key. Set ANTHROPIC_API_KEY '
                + 'in the environment or pass { apiKey } to the constructor.',
            )
        }
        this.apiKey = apiKey
        this.endpoint = options.endpoint ?? 'https://api.anthropic.com/v1/messages'
        this.model = options.model ?? 'claude-haiku-4-5-20251001'
        this.anthropicVersion = options.anthropicVersion ?? '2023-06-01'
    }

    async analyze<T = unknown>(opts: AnalyzeOptions): Promise<AnalyzeResult<T>> {
        const mediaType = opts.mimeType ?? sniffMimeType(opts.image)
        const base64 = Buffer.from(opts.image).toString('base64')

        const content: Array<Record<string, unknown>> = [
            {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            { type: 'text', text: opts.prompt },
        ]

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: opts.maxTokens ?? 1024,
            messages: [{ role: 'user', content }],
        }
        if (opts.system) body.system = opts.system

        // Use tool use to coerce structured output when a schema is given.
        const schemaName = opts.schemaName ?? 'extract'
        if (opts.schema) {
            body.tools = [
                {
                    name: schemaName,
                    description: 'Return the analysis result in this schema.',
                    input_schema: opts.schema,
                },
            ]
            body.tool_choice = { type: 'tool', name: schemaName }
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)

        let response: Response
        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': this.anthropicVersion,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            })
        } catch (err) {
            const e = err as Error & { name?: string }
            if (e.name === 'AbortError') {
                throw new SnapshotError(
                    `Claude vision request timed out after ${opts.timeoutMs ?? 60_000}ms`,
                    e,
                )
            }
            throw new SnapshotError(`Claude vision request failed: ${e.message}`, e)
        } finally {
            clearTimeout(timer)
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new SnapshotError(
                `Claude vision returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
            )
        }

        const json = (await response.json()) as AnthropicMessagesResponse

        let structured: T | undefined
        let textOut = ''
        for (const block of json.content) {
            if (block.type === 'tool_use' && block.name === schemaName) {
                structured = block.input as T
            } else if (block.type === 'text') {
                textOut += block.text
            }
        }

        return {
            structured,
            text: textOut || (structured ? JSON.stringify(structured) : ''),
            tokens: {
                input: json.usage?.input_tokens ?? 0,
                output: json.usage?.output_tokens ?? 0,
            },
        }
    }
}

function sniffMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png'
    }
    if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp'
    }
    return 'image/jpeg'
}

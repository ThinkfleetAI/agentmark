/**
 * OpenAI vision backend.
 *
 * Calls https://api.openai.com/v1/chat/completions with an image attachment.
 * Uses the `response_format: { type: 'json_schema' }` feature for
 * structured output when a schema is provided.
 *
 * No SDK dependency — uses the global `fetch`. Authenticate via
 * `OPENAI_API_KEY` env var or the constructor option.
 */

import { SnapshotError } from '../../errors'
import type { AnalyzeOptions, AnalyzeResult, VisionBackend } from './types'

export interface OpenAiVisionOptions {
    /** OpenAI API key. Defaults to env OPENAI_API_KEY. */
    apiKey?: string
    /** Override the API base URL (e.g. for a self-hosted proxy). */
    endpoint?: string
    /** Model identifier. Default: 'gpt-4o-mini'. */
    model?: string
}

interface OpenAiChatResponse {
    choices: Array<{ message: { content: string | null } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class OpenAiVisionBackend implements VisionBackend {
    readonly name = 'openai'
    private readonly apiKey: string
    private readonly endpoint: string
    private readonly model: string

    constructor(options: OpenAiVisionOptions = {}) {
        const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
        if (!apiKey) {
            throw new SnapshotError(
                'OpenAiVisionBackend requires an API key. Set OPENAI_API_KEY '
                + 'in the environment or pass { apiKey } to the constructor.',
            )
        }
        this.apiKey = apiKey
        this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/chat/completions'
        this.model = options.model ?? 'gpt-4o-mini'
    }

    async analyze<T = unknown>(opts: AnalyzeOptions): Promise<AnalyzeResult<T>> {
        const mediaType = opts.mimeType ?? 'image/png'
        const base64 = Buffer.from(opts.image).toString('base64')
        const dataUrl = `data:${mediaType};base64,${base64}`

        const content: Array<Record<string, unknown>> = [
            { type: 'text', text: opts.prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
        ]

        const messages: Array<Record<string, unknown>> = [
            { role: 'user', content },
        ]
        if (opts.system) {
            messages.unshift({ role: 'system', content: opts.system })
        }

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: opts.maxTokens ?? 1024,
            messages,
        }
        if (opts.schema) {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: opts.schemaName ?? 'extract',
                    strict: true,
                    schema: opts.schema,
                },
            }
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)

        let response: Response
        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            })
        } catch (err) {
            const e = err as Error & { name?: string }
            if (e.name === 'AbortError') {
                throw new SnapshotError(
                    `OpenAI vision request timed out after ${opts.timeoutMs ?? 60_000}ms`,
                    e,
                )
            }
            throw new SnapshotError(`OpenAI vision request failed: ${e.message}`, e)
        } finally {
            clearTimeout(timer)
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new SnapshotError(
                `OpenAI vision returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
            )
        }

        const json = (await response.json()) as OpenAiChatResponse
        const messageText = json.choices[0]?.message?.content ?? ''

        let structured: T | undefined
        if (opts.schema) {
            try {
                structured = JSON.parse(messageText) as T
            } catch {
                // Fall back to text-only mode when the model didn't return valid JSON.
            }
        }

        return {
            structured,
            text: messageText,
            tokens: {
                input: json.usage?.prompt_tokens ?? 0,
                output: json.usage?.completion_tokens ?? 0,
            },
        }
    }
}

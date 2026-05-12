/**
 * HTTP request handler for the Network Pack.
 *
 * Thin wrapper over global fetch (Node 18+/22+/browsers). Translates
 * the agent-facing JSON args into a fetch call, applies the allowlist
 * check, and returns a normalised response (status, headers, body).
 *
 * Body handling:
 *   - JSON object → stringified, content-type defaults to application/json
 *   - Plain string → sent verbatim
 *   - { base64: "..." } → decoded to bytes
 *
 * Response body:
 *   - 'text' (default) → returned as string
 *   - 'base64' → returned as base64-encoded bytes (use for binary)
 *   - 'json' → parsed (errors if response isn't valid JSON)
 */
import type { UrlAllowlist } from './allowlist'

export interface HttpRequestArgs {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: unknown
    response_format?: 'text' | 'base64' | 'json'
    timeout_ms?: number
    follow_redirects?: boolean
}

export interface HttpResponse {
    status: number
    status_text: string
    url: string
    headers: Record<string, string>
    body: unknown
    response_format: 'text' | 'base64' | 'json'
    duration_ms: number
}

export async function httpRequest(
    allowlist: UrlAllowlist,
    args: HttpRequestArgs,
): Promise<HttpResponse> {
    const url = args.url
    if (!url) throw new Error('`url` is required.')
    allowlist.assertAllowed(url)

    const method = (args.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(args.headers ?? {}) }
    const responseFormat = args.response_format ?? 'text'
    const followRedirects = args.follow_redirects !== false

    const init: RequestInit = {
        method,
        headers,
        redirect: followRedirects ? 'follow' : 'manual',
    }

    if (args.body !== undefined && args.body !== null) {
        const { body, contentType } = encodeBody(args.body)
        if (!hasHeader(headers, 'content-type') && contentType) {
            headers['content-type'] = contentType
        }
        init.body = body
    }

    const controller = new AbortController()
    const timeoutMs = args.timeout_ms ?? 30_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    init.signal = controller.signal

    const startedAt = Date.now()
    let response: Response
    try {
        response = await fetch(url, init)
    } finally {
        clearTimeout(timer)
    }
    const duration_ms = Date.now() - startedAt

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => { responseHeaders[key] = value })

    let body: unknown
    if (responseFormat === 'base64') {
        const buf = await response.arrayBuffer()
        body = Buffer.from(buf).toString('base64')
    } else if (responseFormat === 'json') {
        const text = await response.text()
        try {
            body = text.length > 0 ? JSON.parse(text) : null
        } catch (err) {
            throw new Error(
                `response_format="json" but response body is not valid JSON: `
                + `${(err as Error).message}. Body preview: ${text.slice(0, 200)}`,
            )
        }
    } else {
        body = await response.text()
    }

    return {
        status: response.status,
        status_text: response.statusText,
        url: response.url,
        headers: responseHeaders,
        body,
        response_format: responseFormat,
        duration_ms,
    }
}

function encodeBody(body: unknown): { body: BodyInit; contentType?: string } {
    if (typeof body === 'string') {
        return { body }
    }
    if (body && typeof body === 'object' && 'base64' in (body as Record<string, unknown>)) {
        const b64 = (body as { base64: string }).base64
        const bytes = Buffer.from(b64, 'base64')
        return { body: bytes as unknown as BodyInit, contentType: 'application/octet-stream' }
    }
    return { body: JSON.stringify(body), contentType: 'application/json' }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    const target = name.toLowerCase()
    return Object.keys(headers).some((k) => k.toLowerCase() === target)
}

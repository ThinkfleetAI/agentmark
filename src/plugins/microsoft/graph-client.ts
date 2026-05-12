/**
 * Thin Microsoft Graph HTTP client.
 *
 * Only the verbs the v0 pack uses (GET / POST / PATCH / DELETE / PUT-bytes).
 * Each call acquires a fresh access token from MicrosoftAuth, attaches
 * the bearer header, and parses the response. On 401 we retry exactly
 * once after a token refresh, since cached tokens can be invalidated
 * server-side (admin revocation, password change, etc).
 */
import { MicrosoftAuth, NotAuthenticatedError } from './auth'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export interface GraphRequestOptions {
    /** Query-string parameters, automatically encoded. */
    query?: Record<string, string | number | boolean | undefined>
    /** JSON body (will be stringified). Use `bytes` for raw upload bodies. */
    body?: unknown
    /** Raw bytes body (e.g. PUT /content for file uploads). */
    bytes?: Uint8Array
    /** Override the Content-Type (default: application/json for body, application/octet-stream for bytes). */
    contentType?: string
    /** Extra request headers. */
    headers?: Record<string, string>
}

export class GraphClient {
    constructor(private readonly auth: MicrosoftAuth) {}

    get<T>(p: string, options?: GraphRequestOptions): Promise<T> {
        return this.request<T>('GET', p, options)
    }

    post<T>(p: string, options?: GraphRequestOptions): Promise<T> {
        return this.request<T>('POST', p, options)
    }

    patch<T>(p: string, options?: GraphRequestOptions): Promise<T> {
        return this.request<T>('PATCH', p, options)
    }

    delete<T>(p: string, options?: GraphRequestOptions): Promise<T> {
        return this.request<T>('DELETE', p, options)
    }

    put<T>(p: string, options?: GraphRequestOptions): Promise<T> {
        return this.request<T>('PUT', p, options)
    }

    /** GET that returns raw bytes (e.g. `/content` endpoints). */
    async getBytes(p: string, options?: GraphRequestOptions): Promise<Uint8Array> {
        const url = buildUrl(p, options?.query)
        const token = await this.auth.getAccessToken()
        const response = await fetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, ...(options?.headers ?? {}) },
        })
        if (!response.ok) throw await graphError(response)
        const buffer = await response.arrayBuffer()
        return new Uint8Array(buffer)
    }

    private async request<T>(
        method: string,
        p: string,
        options: GraphRequestOptions = {},
        retried = false,
    ): Promise<T> {
        const url = buildUrl(p, options.query)
        const token = await this.auth.getAccessToken()
        const headers: Record<string, string> = {
            authorization: `Bearer ${token}`,
            ...(options.headers ?? {}),
        }
        let body: BodyInit | undefined
        if (options.bytes !== undefined) {
            // Node's undici-based fetch accepts Uint8Array; the dom-lib
            // type for BodyInit is overly narrow, so we cast.
            body = options.bytes as unknown as BodyInit
            headers['content-type'] = options.contentType ?? 'application/octet-stream'
        } else if (options.body !== undefined) {
            body = JSON.stringify(options.body)
            headers['content-type'] = options.contentType ?? 'application/json'
        }

        const response = await fetch(url, { method, headers, body })

        if (response.status === 401 && !retried) {
            // Force a fresh access token and retry once.
            await this.auth.clear()
            // The retry will re-trigger NotAuthenticatedError if the
            // refresh token is also dead — which is the right surface.
            return this.request<T>(method, p, options, true)
        }
        if (!response.ok) throw await graphError(response)

        // 204 No Content
        if (response.status === 204) return undefined as T
        const text = await response.text()
        if (!text) return undefined as T
        try {
            return JSON.parse(text) as T
        } catch {
            // Some endpoints (e.g. ranged downloads) return non-JSON.
            return text as unknown as T
        }
    }
}

export class GraphError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly graphCode?: string,
    ) {
        super(message)
        this.name = 'GraphError'
    }
}

async function graphError(response: Response): Promise<Error> {
    const text = await response.text()
    if (response.status === 401) {
        return new NotAuthenticatedError(`Microsoft Graph rejected the token: ${text}`)
    }
    try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
        const code = parsed.error?.code
        const message = parsed.error?.message ?? text
        return new GraphError(
            `Microsoft Graph ${response.status} ${code ?? ''}: ${message}`.trim(),
            response.status,
            code,
        )
    } catch {
        return new GraphError(`Microsoft Graph ${response.status}: ${text}`, response.status)
    }
}

function buildUrl(p: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = p.startsWith('http') ? p : `${GRAPH_BASE}${p.startsWith('/') ? p : '/' + p}`
    if (!query) return base
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue
        qs.append(k, String(v))
    }
    const queryString = qs.toString()
    if (!queryString) return base
    return base.includes('?') ? `${base}&${queryString}` : `${base}?${queryString}`
}

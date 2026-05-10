/**
 * Vision backend interface — used by both signature detection (v0.9) and
 * video frame captioning (v0.11). One backend, two callers.
 *
 * Implementations should accept an image (PNG/JPEG bytes), a system prompt,
 * a user prompt, and an optional JSON schema for structured output. The
 * vision provider returns either freeform text or a parsed JSON object
 * matching the schema.
 */

export interface VisionBackend {
    /** Implementation name — surfaces in detection notes for debugging. */
    readonly name: string

    /**
     * Run a vision query against an image. When `schema` is provided the
     * implementation must return an object matching it (Claude tool use,
     * OpenAI json_schema response format, etc.). Without `schema` returns
     * the model's freeform text.
     */
    analyze<T = unknown>(opts: AnalyzeOptions): Promise<AnalyzeResult<T>>

    /** Optional cleanup. */
    close?(): Promise<void>
}

export interface AnalyzeOptions {
    /** Image bytes — typically PNG or JPEG. */
    image: Uint8Array
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'
    /** Instruction prompt for the model. */
    prompt: string
    /** Optional system message — useful for tone / role control. */
    system?: string
    /**
     * If provided, the model is asked to return a JSON object matching
     * this schema (via tool use / response_format depending on provider).
     */
    schema?: Record<string, unknown>
    /** Schema name when `schema` is given (default: 'extract'). */
    schemaName?: string
    /** Max tokens. Default: 1024. */
    maxTokens?: number
    /** Per-request timeout (ms). Default: 60000. */
    timeoutMs?: number
}

export interface AnalyzeResult<T = unknown> {
    /** Structured output when `schema` was provided. */
    structured?: T
    /** Freeform text. Always populated. */
    text: string
    /** Approx tokens consumed (when the provider reports them). */
    tokens?: { input: number; output: number }
}

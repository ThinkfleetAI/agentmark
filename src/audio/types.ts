/**
 * Audio support — types for transcription backends and the structured
 * output convertAudio() emits.
 */

export interface TranscriptionBackend {
    readonly name: string
    transcribe(opts: TranscribeOptions): Promise<TranscriptionResult>
    close?(): Promise<void>
}

export interface TranscribeOptions {
    /** Audio bytes — common formats (mp3/wav/m4a/ogg/flac/webm). */
    data: Uint8Array
    /** MIME type. Default sniffed from bytes. */
    mimeType?: string
    /** BCP-47 language hint. Default: auto-detect. */
    language?: string
    /** When true, attempt speaker diarization. Default: false. */
    diarize?: boolean
    /** Per-request timeout (ms). Default: 600000 (10 min). */
    timeoutMs?: number
}

export interface TranscriptionResult {
    /** Detected language (BCP-47) — when reported. */
    language?: string
    /** Total duration in seconds — when reported. */
    duration_sec?: number
    /** Transcript broken into time-aligned segments. */
    segments: TranscriptionSegment[]
    /** Joined plain text — convenience. */
    full_text: string
    /** Speaker labels keyed by ID, when diarized. */
    speakers?: Record<string, string>
}

export interface TranscriptionSegment {
    /** Start time in seconds. */
    start: number
    /** End time in seconds. */
    end: number
    /** Text spoken in this segment. */
    text: string
    /** Optional speaker ID (e.g. 's_alice') when diarized. */
    speaker?: string
}

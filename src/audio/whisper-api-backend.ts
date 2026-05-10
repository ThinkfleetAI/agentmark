/**
 * OpenAI Whisper API transcription backend.
 *
 *   POST https://api.openai.com/v1/audio/transcriptions
 *
 * Sends a multipart/form-data request with the audio file. Asks for
 * `verbose_json` so we get word/segment-level timestamps.
 *
 * No SDK dependency — uses the global `fetch` + `FormData`.
 * Authenticate via `OPENAI_API_KEY` env var or constructor option.
 *
 * Diarization: Whisper API does NOT do speaker diarization itself.
 * For diarized transcripts, use a backend that supports it (AssemblyAI,
 * Deepgram, etc.) — the interface is identical, just bring-your-own.
 */

import { SnapshotError } from '../errors'
import type {
    TranscriptionBackend,
    TranscriptionResult,
    TranscriptionSegment,
    TranscribeOptions,
} from './types'

export interface WhisperApiOptions {
    /** OpenAI API key. Defaults to env OPENAI_API_KEY. */
    apiKey?: string
    /** Override the API base URL. */
    endpoint?: string
    /** Whisper model identifier. Default: 'whisper-1'. */
    model?: string
}

interface VerboseJsonResponse {
    text: string
    language?: string
    duration?: number
    segments?: Array<{
        id: number
        start: number
        end: number
        text: string
    }>
    words?: Array<{ word: string; start: number; end: number }>
}

export class WhisperApiBackend implements TranscriptionBackend {
    readonly name = 'whisper-api'
    private readonly apiKey: string
    private readonly endpoint: string
    private readonly model: string

    constructor(options: WhisperApiOptions = {}) {
        const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
        if (!apiKey) {
            throw new SnapshotError(
                'WhisperApiBackend requires an API key. Set OPENAI_API_KEY '
                + 'in the environment or pass { apiKey } to the constructor.',
            )
        }
        this.apiKey = apiKey
        this.endpoint = options.endpoint
            ?? 'https://api.openai.com/v1/audio/transcriptions'
        this.model = options.model ?? 'whisper-1'
    }

    async transcribe(opts: TranscribeOptions): Promise<TranscriptionResult> {
        const mimeType = opts.mimeType ?? sniffAudioMimeType(opts.data)
        const filename = filenameForMime(mimeType)

        const form = new FormData()
        form.append('model', this.model)
        if (opts.language) form.append('language', opts.language)
        form.append('response_format', 'verbose_json')
        form.append('timestamp_granularities[]', 'segment')
        // Whisper accepts a Blob; convert from Uint8Array.
        const blob = new Blob([opts.data as BlobPart], { type: mimeType })
        form.append('file', blob, filename)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000)

        let response: Response
        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.apiKey}` },
                body: form,
                signal: controller.signal,
            })
        } catch (err) {
            const e = err as Error & { name?: string }
            if (e.name === 'AbortError') {
                throw new SnapshotError(
                    `Whisper API request timed out after ${opts.timeoutMs ?? 600_000}ms`,
                    e,
                )
            }
            throw new SnapshotError(`Whisper API request failed: ${e.message}`, e)
        } finally {
            clearTimeout(timer)
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new SnapshotError(
                `Whisper API returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
            )
        }

        const json = (await response.json()) as VerboseJsonResponse
        const segments: TranscriptionSegment[] = (json.segments ?? []).map((s) => ({
            start: s.start,
            end: s.end,
            text: s.text.trim(),
        }))

        return {
            language: json.language,
            duration_sec: json.duration,
            segments,
            full_text: json.text ?? segments.map((s) => s.text).join(' '),
        }
    }
}

function sniffAudioMimeType(bytes: Uint8Array): string {
    // ID3v2 / MP3 magic
    if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg'
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
    // RIFF / WAV
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
        return 'audio/wav'
    }
    // OggS
    if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return 'audio/ogg'
    }
    // ftyp / M4A
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        return 'audio/m4a'
    }
    // FLaC
    if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
        return 'audio/flac'
    }
    // Default: webm (most common browser-recorded format)
    return 'audio/webm'
}

function filenameForMime(mimeType: string): string {
    if (mimeType === 'audio/mpeg') return 'audio.mp3'
    if (mimeType === 'audio/wav') return 'audio.wav'
    if (mimeType === 'audio/ogg') return 'audio.ogg'
    if (mimeType === 'audio/m4a') return 'audio.m4a'
    if (mimeType === 'audio/flac') return 'audio.flac'
    if (mimeType === 'audio/webm') return 'audio.webm'
    return 'audio.bin'
}

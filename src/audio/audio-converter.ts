/**
 * `convertAudio()` — convert audio bytes into an AgentMark snapshot with
 * `kind: 'audio'`. Mirrors convertPdf's contract.
 *
 * Output body grammar:
 *
 *   [TIME:t_0]
 *   [SPEAKER:s_1] First spoken segment text.
 *
 *   [TIME:t_4]
 *   [SPEAKER:s_2] Second spoken segment text.
 *
 *   ...
 *
 * - [TIME:t_N] markers carry seconds-from-start as the numeric suffix.
 *   Agents can correlate timestamps to body text directly.
 * - [SPEAKER:s_X] markers identify speakers when the transcription
 *   backend supports diarization. Without diarization, no SPEAKER tags
 *   are emitted.
 *
 * The transcript is the body — no extra structure is inferred. Agents
 * can summarize, extract action items, etc. directly.
 */

import {
    AGENTMARK_VERSION,
    type ConversionResult,
    type MediaMeta,
    type Snapshot,
} from '../types'
import { serializeSnapshot } from '../serializers/yaml-frontmatter'
import { InMemoryActionBinding } from '../binding/action-binding'
import { noopLogger, type Logger } from '../observability/logger'
import { SnapshotError } from '../errors'
import type {
    TranscriptionBackend,
    TranscriptionResult,
    TranscriptionSegment,
} from './types'

export interface ConvertAudioOptions {
    /** Raw audio bytes. */
    data: Uint8Array | ArrayBuffer
    /** URL or `file://` URI identifying the audio source. */
    sourceUrl: string
    /** Transcription backend (Whisper API, AssemblyAI, etc.). */
    transcribe: TranscriptionBackend
    /** Override the document title. Default: source URL basename. */
    title?: string
    /** BCP-47 language hint passed to the backend. */
    language?: string
    /** Request speaker diarization. Default: false (most backends ignore). */
    diarize?: boolean
    /** TTL for `expires_at` (ms). Default: 24 hours — audio doesn't change. */
    ttlMs?: number
    /** Logger for structured events. */
    logger?: Logger
    /** Vendor extensions (`x-` prefixed fields). */
    vendorExtensions?: Record<string, unknown>
    /** MIME type override (otherwise sniffed). */
    mimeType?: string
}

export async function convertAudio(options: ConvertAudioOptions): Promise<ConversionResult> {
    const logger = options.logger ?? noopLogger
    const ttlMs = options.ttlMs ?? 24 * 60 * 60_000 // 24 h

    logger.debug('snapshot.capture.start', { source: options.sourceUrl, kind: 'audio' })

    const data = options.data instanceof ArrayBuffer
        ? new Uint8Array(options.data)
        : new Uint8Array(options.data.buffer, options.data.byteOffset, options.data.byteLength)

    let transcription: TranscriptionResult
    try {
        transcription = await options.transcribe.transcribe({
            data,
            mimeType: options.mimeType,
            language: options.language,
            diarize: options.diarize,
        })
    } catch (err) {
        logger.error('snapshot.failed', { error: (err as Error).message })
        if (err instanceof SnapshotError) throw err
        throw new SnapshotError(
            `Audio transcription failed: ${(err as Error).message}`,
            err as Error,
        )
    }

    const captured_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + ttlMs).toISOString()

    const speakers = transcription.speakers
    const speakerCount = speakers ? Object.keys(speakers).length : countDistinctSpeakers(transcription.segments)

    const mediaMeta: MediaMeta = {
        duration_sec: transcription.duration_sec,
        format: deriveFormat(options.mimeType ?? sniffFormat(data)),
        language: transcription.language ?? options.language,
        transcribed: true,
        transcription_backend: options.transcribe.name,
        speaker_count: speakerCount > 0 ? speakerCount : undefined,
    }

    const title = options.title ?? deriveTitleFromUrl(options.sourceUrl)
    const body = buildAudioBody(transcription)

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        kind: 'audio',
        url: options.sourceUrl,
        title,
        captured_at,
        expires_at,
        source: 'declared',
        language: mediaMeta.language,
        media_meta: stripUndefined(mediaMeta),
        speakers: speakers && Object.keys(speakers).length > 0 ? speakers : undefined,
        capabilities: {
            preview_media: false,
            expand_disclosures: false,
            paginate: false,
            scroll: true,
            keyboard: false,
            drag: false,
            ocr: false,
            vision: false,
        },
        body,
    }

    if (options.vendorExtensions) {
        for (const [k, v] of Object.entries(options.vendorExtensions)) {
            if (k.startsWith('x-')) (snapshot as unknown as Record<string, unknown>)[k] = v
        }
    }

    const text = serializeSnapshot(snapshot)
    logger.info('snapshot.captured', {
        source: options.sourceUrl,
        kind: 'audio',
        duration_sec: mediaMeta.duration_sec,
        segments: transcription.segments.length,
        bytes: text.length,
    })

    return { agentmark: text, binding: new InMemoryActionBinding() }
}

// ──────────────────────────────────────────────────────────────────────────
// Body builder
// ──────────────────────────────────────────────────────────────────────────

function buildAudioBody(t: TranscriptionResult): string {
    if (t.segments.length === 0) {
        // No segments — just emit the full text under a single TIME marker.
        const startStamp = `[TIME:t_0]`
        return `${startStamp}\n\n${escapeBody(t.full_text || '')}\n`
    }

    const lines: string[] = []
    let lastSpeaker: string | undefined
    for (const seg of t.segments) {
        const timeId = `t_${Math.round(seg.start)}`
        lines.push(`[TIME:${timeId}]`)
        if (seg.speaker && seg.speaker !== lastSpeaker) {
            lines.push(`[SPEAKER:${seg.speaker}] ${escapeBody(seg.text)}`)
            lastSpeaker = seg.speaker
        } else if (seg.speaker) {
            // Same speaker continuing — omit the SPEAKER tag for compactness.
            lines.push(escapeBody(seg.text))
        } else {
            lines.push(escapeBody(seg.text))
        }
        lines.push('') // blank line between segments
    }
    return lines.join('\n')
}

function escapeBody(text: string): string {
    // Same rules as web body builder: escape `[` followed by uppercase
    // (could otherwise create accidental tag references) and backslashes.
    return text.replace(/\\/g, '\\\\').replace(/\[(?=[A-Z])/g, '\\[')
}

function countDistinctSpeakers(segments: TranscriptionSegment[]): number {
    const set = new Set<string>()
    for (const s of segments) if (s.speaker) set.add(s.speaker)
    return set.size
}

function deriveTitleFromUrl(url: string): string {
    try {
        const u = new URL(url)
        const last = u.pathname.split('/').filter(Boolean).pop() ?? '(untitled)'
        return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '') || '(untitled)'
    } catch {
        return '(untitled)'
    }
}

function deriveFormat(mimeType: string | undefined): string | undefined {
    if (!mimeType) return undefined
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
    if (mimeType.includes('wav')) return 'wav'
    if (mimeType.includes('m4a')) return 'm4a'
    if (mimeType.includes('ogg')) return 'ogg'
    if (mimeType.includes('webm')) return 'webm'
    if (mimeType.includes('flac')) return 'flac'
    return undefined
}

function sniffFormat(bytes: Uint8Array): string | undefined {
    if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg'
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav'
    if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67) return 'audio/ogg'
    return undefined
}

function stripUndefined<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v
    }
    return out as T
}

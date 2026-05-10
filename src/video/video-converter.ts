/**
 * `convertVideo()` — convert video bytes into an AgentMark snapshot with
 * `kind: 'video'`. Combines:
 *
 *   1. Audio transcription (TranscriptionBackend) → [TIME] + [SPEAKER] markers
 *   2. Frame extraction (FrameExtractionBackend) → keyframes / sampled frames
 *   3. Frame captioning (VisionBackend) → text descriptions per frame
 *
 * Output body interleaves transcript segments and frame captions in
 * timestamp order so an LLM reading the snapshot sees both audio and
 * visual context aligned in time:
 *
 *   [TIME:t_0]
 *   [SPEAKER:s_alice] Welcome to the demo.
 *
 *   [TIME:t_5] [FRAME:f_1]
 *   (frame caption: "Slide showing pricing tiers: Free, Pro, Enterprise")
 *
 *   [TIME:t_8]
 *   [SPEAKER:s_alice] Today we'll cover three pricing options...
 */

import {
    AGENTMARK_VERSION,
    type ConversionResult,
    type MediaDefinition,
    type MediaMeta,
    type Snapshot,
} from '../types'
import { serializeSnapshot } from '../serializers/yaml-frontmatter'
import { InMemoryActionBinding } from '../binding/action-binding'
import { noopLogger, type Logger } from '../observability/logger'
import { SnapshotError } from '../errors'
import type { TranscriptionBackend, TranscriptionSegment } from '../audio/types'
import type { VisionBackend } from '../pdf/vision/types'
import type {
    ExtractedFrame,
    ExtractFramesOptions,
    FrameExtractionBackend,
} from './types'

export interface ConvertVideoOptions {
    data: Uint8Array | ArrayBuffer
    sourceUrl: string
    /** Audio transcription backend. Required — the spoken track is the
     *  spine of the body. Pass `null` to skip transcription entirely. */
    transcribe: TranscriptionBackend | null
    /** Frame extraction backend (FfmpegFrameBackend or custom). */
    frames: FrameExtractionBackend
    /** Vision backend used to caption each extracted frame. Pass `null`
     *  to skip captions and just emit [FRAME] markers without text. */
    caption: VisionBackend | null
    /** Frame sampling strategy. Default: { every: 30 } (one per 30s). */
    sampling?: ExtractFramesOptions['sampling']
    /** Width for extracted frames. Default: 800px. */
    frameWidth?: number
    /** Override title. Default: source URL basename. */
    title?: string
    language?: string
    diarize?: boolean
    ttlMs?: number
    logger?: Logger
    vendorExtensions?: Record<string, unknown>
    mimeType?: string
}

interface TimelineEvent {
    time: number
    type: 'transcript' | 'frame'
    transcript?: TranscriptionSegment
    frame?: { id: string; index: number; caption?: string }
}

export async function convertVideo(options: ConvertVideoOptions): Promise<ConversionResult> {
    const logger = options.logger ?? noopLogger
    const ttlMs = options.ttlMs ?? 24 * 60 * 60_000

    logger.debug('snapshot.capture.start', { source: options.sourceUrl, kind: 'video' })

    const data = options.data instanceof ArrayBuffer
        ? new Uint8Array(options.data)
        : new Uint8Array(options.data.buffer, options.data.byteOffset, options.data.byteLength)
    const sampling = options.sampling ?? { every: 30 }

    // Run frame extraction and (optionally) transcription in parallel.
    const [framesResult, transcriptionResult] = await Promise.all([
        options.frames
            .extractFrames({
                data,
                mimeType: options.mimeType,
                sampling,
                width: options.frameWidth ?? 800,
                format: 'jpeg',
            })
            .catch((err: Error) => {
                logger.warn('video.frames.failed', { error: err.message })
                return [] as ExtractedFrame[]
            }),
        options.transcribe
            ? options.transcribe.transcribe({
                data,
                mimeType: options.mimeType,
                language: options.language,
                diarize: options.diarize,
            }).catch((err: Error) => {
                logger.warn('video.transcribe.failed', { error: err.message })
                return null
            })
            : Promise.resolve(null),
    ])

    if (framesResult.length === 0 && !transcriptionResult) {
        throw new SnapshotError('Video conversion produced no frames and no transcript')
    }

    // Caption frames in series (vision API rate limits + token cost). Skip
    // when caption=null.
    const captionedFrames: Array<{ frame: ExtractedFrame; caption?: string; id: string }> = []
    for (let i = 0; i < framesResult.length; i++) {
        const frame = framesResult[i]
        const id = `f_${i + 1}`
        let caption: string | undefined
        if (options.caption) {
            try {
                const result = await options.caption.analyze({
                    image: frame.image,
                    mimeType: frame.mimeType,
                    prompt:
                        'Describe this video frame in 1-2 short sentences. Focus on '
                        + 'what is most informative for someone who cannot see it: '
                        + 'on-screen text, the subject, the setting, key visual cues. '
                        + 'Be concrete and specific. No editorializing.',
                    maxTokens: 200,
                })
                caption = result.text.trim()
            } catch (err) {
                logger.warn('video.caption.failed', {
                    frame: id,
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
        captionedFrames.push({ frame, caption, id })
    }

    // Build interleaved timeline
    const events: TimelineEvent[] = []
    if (transcriptionResult) {
        for (const seg of transcriptionResult.segments) {
            events.push({ time: seg.start, type: 'transcript', transcript: seg })
        }
    }
    for (let i = 0; i < captionedFrames.length; i++) {
        const cf = captionedFrames[i]
        events.push({
            time: cf.frame.timestamp,
            type: 'frame',
            frame: { id: cf.id, index: i, caption: cf.caption },
        })
    }
    events.sort((a, b) => a.time - b.time)

    const body = buildVideoBody(events)

    // Frames go into the `media` map so [FRAME:f_n] resolves through the
    // existing MEDIA-resolving validator path.
    const media: Record<string, MediaDefinition> = {}
    for (const cf of captionedFrames) {
        media[cf.id] = {
            type: 'image',
            caption: cf.caption ?? null,
        }
    }

    const captured_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + ttlMs).toISOString()
    const speakers = transcriptionResult?.speakers
    const speakerCount = speakers
        ? Object.keys(speakers).length
        : countDistinctSpeakers(transcriptionResult?.segments ?? [])

    const mediaMeta: MediaMeta = {
        duration_sec: transcriptionResult?.duration_sec,
        format: deriveFormat(options.mimeType ?? sniffFormat(data)),
        language: transcriptionResult?.language ?? options.language,
        transcribed: transcriptionResult !== null,
        transcription_backend: options.transcribe?.name,
        vision_backend: options.caption?.name,
        speaker_count: speakerCount > 0 ? speakerCount : undefined,
        frame_count: captionedFrames.length,
    }

    const title = options.title ?? deriveTitleFromUrl(options.sourceUrl)

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        kind: 'video',
        url: options.sourceUrl,
        title,
        captured_at,
        expires_at,
        source: 'declared',
        language: mediaMeta.language,
        media_meta: stripUndefined(mediaMeta),
        speakers: speakers && Object.keys(speakers).length > 0 ? speakers : undefined,
        media: Object.keys(media).length > 0 ? media : undefined,
        capabilities: {
            preview_media: true,
            expand_disclosures: false,
            paginate: false,
            scroll: true,
            keyboard: false,
            drag: false,
            ocr: false,
            vision: options.caption !== null,
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
        kind: 'video',
        duration_sec: mediaMeta.duration_sec,
        frames: captionedFrames.length,
        segments: transcriptionResult?.segments.length ?? 0,
        bytes: text.length,
    })

    // Best-effort cleanup of long-lived backends.
    try { await Promise.resolve(options.transcribe?.close?.()) } catch { /* ignore */ }
    try { await Promise.resolve(options.frames.close?.()) } catch { /* ignore */ }
    try { await Promise.resolve(options.caption?.close?.()) } catch { /* ignore */ }

    return { agentmark: text, binding: new InMemoryActionBinding() }
}

// ──────────────────────────────────────────────────────────────────────────
// Body builder
// ──────────────────────────────────────────────────────────────────────────

function buildVideoBody(events: TimelineEvent[]): string {
    if (events.length === 0) {
        return '[TIME:t_0]\n\n(No transcript or frames extracted.)\n'
    }
    const lines: string[] = []
    let lastSpeaker: string | undefined
    for (const event of events) {
        const timeId = `t_${Math.round(event.time)}`
        if (event.type === 'transcript' && event.transcript) {
            lines.push(`[TIME:${timeId}]`)
            const seg = event.transcript
            if (seg.speaker && seg.speaker !== lastSpeaker) {
                lines.push(`[SPEAKER:${seg.speaker}] ${escapeBody(seg.text)}`)
                lastSpeaker = seg.speaker
            } else {
                lines.push(escapeBody(seg.text))
            }
            lines.push('')
        } else if (event.type === 'frame' && event.frame) {
            lines.push(`[TIME:${timeId}] [FRAME:${event.frame.id}]`)
            if (event.frame.caption) {
                lines.push(`(frame caption: ${escapeBody(event.frame.caption)})`)
            }
            lines.push('')
        }
    }
    return lines.join('\n')
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers (copied from audio-converter — small, not worth a shared module)
// ──────────────────────────────────────────────────────────────────────────

function escapeBody(text: string): string {
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
    if (mimeType.includes('mp4')) return 'mp4'
    if (mimeType.includes('webm')) return 'webm'
    if (mimeType.includes('quicktime') || mimeType.includes('mov')) return 'mov'
    if (mimeType.includes('matroska') || mimeType.includes('mkv')) return 'mkv'
    if (mimeType.includes('avi')) return 'avi'
    return undefined
}

function sniffFormat(bytes: Uint8Array): string | undefined {
    // ftyp signature at offset 4
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        return 'video/mp4'
    }
    // EBML header for webm/mkv
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        return 'video/webm'
    }
    // RIFF + AVI
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49) {
        return 'video/avi'
    }
    return undefined
}

function stripUndefined<T extends object>(obj: T): T {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v
    }
    return out as T
}

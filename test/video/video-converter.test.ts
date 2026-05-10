/**
 * Video converter tests with mocked transcription / frame / vision backends.
 *
 * Real ffmpeg + Whisper + Claude run via the kitchen-sink demo / manual
 * smoke test against actual video files; this suite locks the
 * orchestration logic.
 */

import { describe, it, expect } from 'vitest'
import { convertVideo } from '../../src/video/video-converter'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../../src/validators/schema-validator'
import type {
    TranscriptionBackend,
    TranscriptionResult,
} from '../../src/audio/types'
import type {
    FrameExtractionBackend,
    ExtractedFrame,
} from '../../src/video/types'
import type {
    AnalyzeOptions,
    AnalyzeResult,
    VisionBackend,
} from '../../src/pdf/vision/types'

function tinyJpeg(): Uint8Array {
    return new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ])
}

function fakeTranscribe(result: TranscriptionResult): TranscriptionBackend {
    return {
        name: 'fake_whisper',
        async transcribe() { return result },
    }
}

function fakeFrames(frames: ExtractedFrame[]): FrameExtractionBackend {
    return {
        name: 'fake_ffmpeg',
        async extractFrames() { return frames },
    }
}

function fakeCaption(captions: string[]): VisionBackend & { calls: number } {
    let i = 0
    return {
        name: 'fake_vision',
        calls: 0,
        async analyze(_opts: AnalyzeOptions): Promise<AnalyzeResult> {
            this.calls++
            return { text: captions[i++ % captions.length] ?? 'caption', structured: undefined }
        },
    } as VisionBackend & { calls: number }
}

const SAMPLE_FRAMES = (count: number, every = 30): ExtractedFrame[] =>
    Array.from({ length: count }, (_, i) => ({
        timestamp: i * every,
        image: tinyJpeg(),
        mimeType: 'image/jpeg' as const,
    }))

describe('convertVideo', () => {
    it('produces kind: "video" snapshot interleaving transcript + frames', async () => {
        const transcribe = fakeTranscribe({
            duration_sec: 90,
            segments: [
                { start: 0, end: 5, text: 'Hello.', speaker: 's_alice' },
                { start: 60, end: 65, text: 'Now the demo.', speaker: 's_alice' },
            ],
            full_text: 'Hello. Now the demo.',
            speakers: { s_alice: 'Alice (Presenter)' },
        })
        const frames = fakeFrames(SAMPLE_FRAMES(3, 30)) // 0, 30, 60
        const caption = fakeCaption([
            'Title slide reading "Q4 Demo".',
            'Architecture diagram with three boxes.',
            'Closing slide with contact info.',
        ])

        const { agentmark } = await convertVideo({
            data: new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), // ftyp magic
            sourceUrl: 'file:///tmp/demo.mp4',
            transcribe,
            frames,
            caption,
        })

        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('video')
        expect(snap.media_meta?.duration_sec).toBe(90)
        expect(snap.media_meta?.transcribed).toBe(true)
        expect(snap.media_meta?.transcription_backend).toBe('fake_whisper')
        expect(snap.media_meta?.vision_backend).toBe('fake_vision')
        expect(snap.media_meta?.frame_count).toBe(3)
        expect(snap.speakers?.s_alice).toBe('Alice (Presenter)')

        // Body has TIME + SPEAKER + FRAME tags interleaved by time
        expect(agentmark).toMatch(/\[TIME:t_0\]/)
        expect(agentmark).toMatch(/\[SPEAKER:s_alice\] Hello/)
        expect(agentmark).toMatch(/\[TIME:t_30\] \[FRAME:f_2\]/)
        expect(agentmark).toMatch(/Architecture diagram with three boxes/)
        expect(agentmark).toMatch(/\[TIME:t_60\]/)

        // media map populated with frame entries
        expect(snap.media?.f_1?.type).toBe('image')
        expect(snap.media?.f_1?.caption).toMatch(/Title slide/)
        expect(caption.calls).toBe(3)
    })

    it('validates against the v0.3 schema', async () => {
        const { agentmark } = await convertVideo({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp4',
            transcribe: fakeTranscribe({
                segments: [{ start: 0, end: 1, text: 'x' }],
                full_text: 'x',
            }),
            frames: fakeFrames(SAMPLE_FRAMES(1)),
            caption: fakeCaption(['caption']),
        })
        const snap = parseSnapshot(agentmark)
        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
    })

    it('runs without captions when caption=null (FRAME tags but no descriptions)', async () => {
        const { agentmark } = await convertVideo({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp4',
            transcribe: fakeTranscribe({
                segments: [{ start: 0, end: 1, text: 'speech' }],
                full_text: 'speech',
            }),
            frames: fakeFrames(SAMPLE_FRAMES(2)),
            caption: null,
        })
        expect(agentmark).toMatch(/\[FRAME:f_1\]/)
        expect(agentmark).not.toMatch(/frame caption:/)
    })

    it('runs without transcription when transcribe=null', async () => {
        const { agentmark } = await convertVideo({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp4',
            transcribe: null,
            frames: fakeFrames(SAMPLE_FRAMES(1)),
            caption: fakeCaption(['Just a frame.']),
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.media_meta?.transcribed).toBe(false)
        expect(agentmark).not.toMatch(/\[SPEAKER:/)
        expect(agentmark).toMatch(/Just a frame/)
    })

    it('throws when both frames and transcript are empty', async () => {
        await expect(
            convertVideo({
                data: new Uint8Array(),
                sourceUrl: 'file:///tmp/x.mp4',
                transcribe: null,
                frames: fakeFrames([]),
                caption: null,
            }),
        ).rejects.toThrow(/no frames and no transcript/)
    })

    it('continues when caption fails for one frame', async () => {
        let i = 0
        const flaky: VisionBackend = {
            name: 'flaky',
            async analyze() {
                i++
                if (i === 2) throw new Error('rate limit')
                return { text: `caption ${i}`, structured: undefined }
            },
        }
        const { agentmark } = await convertVideo({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp4',
            transcribe: null,
            frames: fakeFrames(SAMPLE_FRAMES(3)),
            caption: flaky,
        })
        const snap = parseSnapshot(agentmark)
        // Frame 1 + frame 3 captioned; frame 2 has no caption (graceful)
        expect(snap.media?.f_1?.caption).toBe('caption 1')
        expect(snap.media?.f_2?.caption).toBeNull()
        expect(snap.media?.f_3?.caption).toMatch(/caption 3/)
    })

    it('orders timeline events by timestamp regardless of insertion order', async () => {
        // Transcript at t=0, t=60. Frames at t=30, t=90. Should interleave.
        const { agentmark } = await convertVideo({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp4',
            transcribe: fakeTranscribe({
                segments: [
                    { start: 0, end: 5, text: 'speak 0' },
                    { start: 60, end: 65, text: 'speak 60' },
                ],
                full_text: '',
            }),
            frames: fakeFrames([
                { timestamp: 30, image: tinyJpeg(), mimeType: 'image/jpeg' },
                { timestamp: 90, image: tinyJpeg(), mimeType: 'image/jpeg' },
            ]),
            caption: fakeCaption(['frame_30', 'frame_90']),
        })

        const positions = ['t_0', 't_30', 't_60', 't_90'].map((id) => agentmark.indexOf(`[TIME:${id}]`))
        expect(positions[0]).toBeGreaterThan(0)
        expect(positions[1]).toBeGreaterThan(positions[0])
        expect(positions[2]).toBeGreaterThan(positions[1])
        expect(positions[3]).toBeGreaterThan(positions[2])
    })
})

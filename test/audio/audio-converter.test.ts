/**
 * Audio support tests with a mocked transcription backend.
 */

import { describe, it, expect } from 'vitest'
import { convertAudio } from '../../src/audio/audio-converter'
import { parseSnapshot } from '../../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../../src/validators/schema-validator'
import type {
    TranscriptionBackend,
    TranscriptionResult,
} from '../../src/audio/types'

function fakeTranscription(result: TranscriptionResult): TranscriptionBackend {
    return {
        name: 'fake_transcribe',
        async transcribe() {
            return result
        },
    }
}

describe('convertAudio', () => {
    it('produces kind: "audio" snapshot with timestamps and speakers', async () => {
        const transcribe = fakeTranscription({
            language: 'en',
            duration_sec: 12.5,
            segments: [
                { start: 0, end: 3, text: 'Hi, thanks for calling.', speaker: 's_alice' },
                { start: 3, end: 7, text: 'I have a question.', speaker: 's_bob' },
                { start: 7, end: 12, text: 'Sure, go ahead.', speaker: 's_alice' },
            ],
            full_text: 'Hi, thanks for calling. I have a question. Sure, go ahead.',
            speakers: { s_alice: 'Alice (Support)', s_bob: 'Bob (Customer)' },
        })

        const { agentmark } = await convertAudio({
            data: new Uint8Array([0x49, 0x44, 0x33, 0x04]), // ID3v2 header (mp3-ish)
            sourceUrl: 'file:///tmp/call.mp3',
            transcribe,
        })

        const snap = parseSnapshot(agentmark)
        expect(snap.kind).toBe('audio')
        expect(snap.agentmark).toBe('0.4')
        expect(snap.media_meta?.duration_sec).toBe(12.5)
        expect(snap.media_meta?.transcribed).toBe(true)
        expect(snap.media_meta?.transcription_backend).toBe('fake_transcribe')
        expect(snap.media_meta?.speaker_count).toBe(2)
        expect(snap.speakers).toEqual({
            s_alice: 'Alice (Support)',
            s_bob: 'Bob (Customer)',
        })

        // Body has TIME + SPEAKER markers + escaped speech
        expect(agentmark).toMatch(/\[TIME:t_0\]/)
        expect(agentmark).toMatch(/\[TIME:t_3\]/)
        expect(agentmark).toMatch(/\[TIME:t_7\]/)
        expect(agentmark).toMatch(/\[SPEAKER:s_alice\] Hi, thanks for calling/)
        expect(agentmark).toMatch(/\[SPEAKER:s_bob\] I have a question/)
        // Same speaker continuing — second alice segment OMITS the speaker tag
        expect(agentmark).toMatch(/\[SPEAKER:s_alice\] Sure, go ahead/)
    })

    it('validates against the v0.3 schema', async () => {
        const transcribe = fakeTranscription({
            duration_sec: 5,
            segments: [{ start: 0, end: 5, text: 'Hello world.' }],
            full_text: 'Hello world.',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.wav',
            transcribe,
        })
        const snap = parseSnapshot(agentmark)
        const result = validateSnapshot(snap)
        expect(result.errors).toEqual([])
    })

    it('handles transcription with no segments (full_text only)', async () => {
        const transcribe = fakeTranscription({
            segments: [],
            full_text: 'A short utterance.',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp3',
            transcribe,
        })
        expect(agentmark).toContain('[TIME:t_0]')
        expect(agentmark).toContain('A short utterance.')
    })

    it('omits speakers map when transcription has none', async () => {
        const transcribe = fakeTranscription({
            duration_sec: 3,
            segments: [{ start: 0, end: 3, text: 'Solo speech.' }],
            full_text: 'Solo speech.',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp3',
            transcribe,
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.speakers).toBeUndefined()
        expect(agentmark).not.toMatch(/\[SPEAKER:/)
    })

    it('falls back to URL basename when title is omitted', async () => {
        const transcribe = fakeTranscription({
            segments: [{ start: 0, end: 1, text: 'x' }],
            full_text: 'x',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/customer-call-2026-05-10.mp3',
            transcribe,
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.title).toBe('customer-call-2026-05-10')
    })

    it('counts distinct speakers when no speakers map provided', async () => {
        const transcribe = fakeTranscription({
            segments: [
                { start: 0, end: 3, text: 'A', speaker: 's_1' },
                { start: 3, end: 6, text: 'B', speaker: 's_2' },
                { start: 6, end: 9, text: 'C', speaker: 's_1' },
            ],
            full_text: 'A B C',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp3',
            transcribe,
        })
        const snap = parseSnapshot(agentmark)
        expect(snap.media_meta?.speaker_count).toBe(2)
    })

    it('wraps backend failures in SnapshotError', async () => {
        const broken: TranscriptionBackend = {
            name: 'broken',
            async transcribe() {
                throw new Error('API exploded')
            },
        }
        await expect(
            convertAudio({
                data: new Uint8Array(),
                sourceUrl: 'file:///tmp/x.mp3',
                transcribe: broken,
            }),
        ).rejects.toThrow(/transcription failed/)
    })

    it('escapes [TAG] sequences in transcript text so they do not become tag refs', async () => {
        const transcribe = fakeTranscription({
            segments: [
                { start: 0, end: 3, text: 'I read [PAGE:p_1] in the document' },
            ],
            full_text: 'I read [PAGE:p_1] in the document',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp3',
            transcribe,
        })
        // Escaped form
        expect(agentmark).toMatch(/I read \\\[PAGE:p_1\] in the document/)
    })

    it('preserves vendor extensions', async () => {
        const transcribe = fakeTranscription({
            segments: [{ start: 0, end: 1, text: 'x' }],
            full_text: 'x',
        })
        const { agentmark } = await convertAudio({
            data: new Uint8Array(),
            sourceUrl: 'file:///tmp/x.mp3',
            transcribe,
            vendorExtensions: { 'x-call-id': 'abc-123' },
        })
        expect(agentmark).toContain('x-call-id')
        expect(agentmark).toContain('abc-123')
    })
})

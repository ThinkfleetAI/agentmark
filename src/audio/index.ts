/**
 * Audio support — convertAudio() + transcription backends.
 */

export { convertAudio } from './audio-converter'
export type { ConvertAudioOptions } from './audio-converter'
export { WhisperApiBackend } from './whisper-api-backend'
export type { WhisperApiOptions } from './whisper-api-backend'
export type {
    TranscriptionBackend,
    TranscriptionResult,
    TranscriptionSegment,
    TranscribeOptions,
} from './types'

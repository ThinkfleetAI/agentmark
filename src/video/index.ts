/**
 * Video support — convertVideo() + frame extraction backends.
 */

export { convertVideo } from './video-converter'
export type { ConvertVideoOptions } from './video-converter'
export { FfmpegFrameBackend } from './ffmpeg-frame-backend'
export type { FfmpegFrameBackendOptions } from './ffmpeg-frame-backend'
export type {
    FrameExtractionBackend,
    ExtractFramesOptions,
    ExtractedFrame,
} from './types'

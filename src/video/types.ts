/**
 * Video support — frame-extraction interface + convertVideo() output types.
 */

export interface FrameExtractionBackend {
    readonly name: string
    /**
     * Extract a sample of frames from video bytes. Implementations should
     * yield evenly-spaced frames OR detect scene changes; the interface
     * doesn't dictate.
     */
    extractFrames(opts: ExtractFramesOptions): Promise<ExtractedFrame[]>
    close?(): Promise<void>
}

export interface ExtractFramesOptions {
    /** Video bytes — typically mp4/webm/mov/mkv. */
    data: Uint8Array
    /** MIME type. Default: sniffed from bytes. */
    mimeType?: string
    /**
     * Frame sampling strategy:
     *   - { every: N } — sample every N seconds
     *   - { count: N } — sample N evenly-spaced frames
     *   - { keyframes: true } — keyframes only
     */
    sampling: { every: number } | { count: number } | { keyframes: true }
    /** Per-frame output format. Default: 'jpeg'. */
    format?: 'jpeg' | 'png'
    /** Per-frame output width in pixels. Default: 800. */
    width?: number
}

export interface ExtractedFrame {
    /** Timestamp in seconds where this frame was sampled. */
    timestamp: number
    /** Image bytes. */
    image: Uint8Array
    /** MIME type of `image`. */
    mimeType: 'image/jpeg' | 'image/png'
}

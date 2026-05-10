/**
 * Vision-backend module — used by signature detection (v0.9) and video
 * frame captioning (v0.11).
 */

export type {
    VisionBackend,
    AnalyzeOptions,
    AnalyzeResult,
} from './types'
export { ClaudeVisionBackend } from './claude-backend'
export type { ClaudeVisionOptions } from './claude-backend'
export { OpenAiVisionBackend } from './openai-backend'
export type { OpenAiVisionOptions } from './openai-backend'

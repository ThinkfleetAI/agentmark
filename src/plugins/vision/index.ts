/**
 * Vision Pack — Layer 2 fallback for accessibility-tree gaps.
 *
 * Right now ships one tool: full-screen screenshot. The multimodal AI
 * does its own parsing on the returned image. As we expand:
 *
 *   - per-window capture via bridges
 *   - OmniParser-style structured GUI parsing inside the plugin
 *   - "tree was sparse, auto-fallback to vision" hook on desktop_snapshot
 */
import { captureScreenshot } from './screenshot'
import { VISION_TOOLS } from './tool-defs'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export interface VisionPluginConfig {
    /** Reserved for future config (preferred OCR backend, model hints, etc.). */
    _reserved?: never
}

export function createVisionPlugin(_config: VisionPluginConfig = {}): AgentMarkPlugin {
    const handlers: Record<string, ToolHandler> = {
        agentmark_screenshot: async (args): Promise<DispatchResult> => {
            const result = await captureScreenshot({
                outputPath: typeof args.output_path === 'string' ? args.output_path : undefined,
                displayIndex: typeof args.display_index === 'number' ? args.display_index : undefined,
            })
            return { text: JSON.stringify(result, null, 2) }
        },
    }

    return {
        name: 'vision',
        version: '0.1.0',
        tools: VISION_TOOLS,
        handlers,
    }
}

export { captureScreenshot } from './screenshot'
export { VISION_TOOLS } from './tool-defs'
export type { ScreenshotOptions, ScreenshotResult } from './screenshot'

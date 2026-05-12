/**
 * Vision Pack — tool definitions.
 *
 * v0 ships full-screen capture only. Per-window screenshots come in a
 * follow-up that adds bridge-level support (UIA / AXAPI window handle
 * → PNG buffer).
 */
import type { McpToolDef } from '../../mcp/tool-defs'

export const VISION_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_screenshot',
        description:
            'Capture a full-screen PNG screenshot. Returns the image as '
            + 'base64 in the response by default, or writes it to `output_path` '
            + 'and returns just the path + byte count. Use when the '
            + 'accessibility tree is too sparse to drive an app reliably '
            + '(custom-drawn UIs, Electron apps with weak a11y, games) — the '
            + 'multimodal AI can vision-parse the image directly.\n'
            + '\nUtilities used per platform:\n'
            + '  - macOS:   screencapture (always installed)\n'
            + '  - Windows: PowerShell + .NET System.Drawing\n'
            + '  - Linux:   gnome-screenshot OR scrot (install one)',
        inputSchema: {
            type: 'object',
            properties: {
                output_path: {
                    type: 'string',
                    description:
                        'If set, write the PNG to this path and return just '
                        + '{ path, bytes }. Otherwise return base64 inline.',
                },
                display_index: {
                    type: 'number',
                    description:
                        'Zero-based display index (macOS only — other platforms '
                        + 'capture the active screen). Default: primary.',
                },
            },
        },
    },
]

/**
 * System Pack — native OS notifications + text-to-speech.
 *
 * Two surfaces that turn a background agent into something that can
 * politely interrupt the human without flipping them to a chat window.
 * Both cross-platform via OS-shipped utilities; no Node deps.
 */
import { notify, type NotifyOptions } from './notify'
import { speak, type SpeakOptions } from './voice'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'
import type { McpToolDef } from '../../mcp/tool-defs'

const SYSTEM_TOOLS: McpToolDef[] = [
    {
        name: 'agentmark_notify',
        description:
            'Display a native OS notification. Use to ping the human '
            + 'mid-flow ("I need confirmation", "job finished") without '
            + 'taking over their screen. macOS, Windows 10+, Linux (libnotify).',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                body: { type: 'string', description: 'Notification body text.' },
                subtitle: { type: 'string', description: 'Subtitle (macOS only; other platforms append to title).' },
                sound: { type: 'boolean', description: 'Play the default notification sound. Default: false.' },
            },
            required: ['title'],
        },
    },
    {
        name: 'agentmark_voice_speak',
        description:
            'Speak the given text via the OS text-to-speech engine. macOS '
            + '`say`, Windows SAPI (System.Speech.Synthesis), Linux espeak. '
            + 'Voice + rate are optional and platform-specific.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                voice: { type: 'string', description: 'Voice name (platform-specific).' },
                rate: { type: 'number', description: 'Words per minute (roughly).' },
            },
            required: ['text'],
        },
    },
]

export interface SystemPluginConfig {
    /** Reserved for future config (e.g. preferred voice, default sound). */
    _reserved?: never
}

export function createSystemPlugin(_config: SystemPluginConfig = {}): AgentMarkPlugin {
    const handlers: Record<string, ToolHandler> = {
        agentmark_notify: async (args): Promise<DispatchResult> => {
            const title = requireString(args, 'title')
            await notify({
                title,
                body: typeof args.body === 'string' ? args.body : undefined,
                subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined,
                sound: args.sound === true,
            })
            return { text: JSON.stringify({ sent: true, title }, null, 2) }
        },

        agentmark_voice_speak: async (args): Promise<DispatchResult> => {
            const text = requireString(args, 'text')
            await speak({
                text,
                voice: typeof args.voice === 'string' ? args.voice : undefined,
                rate: typeof args.rate === 'number' ? args.rate : undefined,
            })
            return { text: JSON.stringify({ spoken: true, bytes: text.length }, null, 2) }
        },
    }

    return {
        name: 'system',
        version: '0.1.0',
        tools: SYSTEM_TOOLS,
        handlers,
    }
}

export { notify, speak, SYSTEM_TOOLS }
export type { NotifyOptions, SpeakOptions }

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

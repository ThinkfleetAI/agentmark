/**
 * Foundations Pack — the OS-basics plugin.
 *
 * Combines app launching, clipboard, allowlisted filesystem, and a
 * durable key/value state store into one plugin. Cross-platform,
 * dependency-free (only shells out to OS-shipped binaries where needed).
 *
 *   const foundations = createFoundationsPlugin({
 *       fileRoots: ['/Users/me/Documents', '/tmp'],
 *       statePath: '/Users/me/.thinkfleet/agentmark/state.json',
 *   })
 *   createMcpServer({ plugins: [web, pdf, desktop, foundations, meta] })
 *
 * Auth-free, opt-in. Filesystem operations are bounded by the allowlist
 * passed in (or defaulted to cwd + tmpdir).
 */
import { runApp } from './app-runner'
import { readClipboardText, writeClipboardText } from './clipboard'
import {
    FilesGuard,
    listFiles,
    readFileText,
    writeFileText,
    statFile,
    deleteFile,
    moveFile,
    makeDir,
} from './files'
import { StateStore } from './state'
import { FOUNDATIONS_TOOLS } from './tool-defs'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export interface FoundationsPluginConfig {
    /** Allowed root directories for filesystem tools. */
    fileRoots?: string[]
    /** Override the durable state file path (mostly for tests). */
    statePath?: string
}

export function createFoundationsPlugin(config: FoundationsPluginConfig = {}): AgentMarkPlugin {
    const filesGuard = new FilesGuard({ roots: config.fileRoots })
    const stateStore = new StateStore({ path: config.statePath })

    const handlers: Record<string, ToolHandler> = {
        agentmark_app_run: async (args): Promise<DispatchResult> => {
            const command = requireString(args, 'command')
            const result = await runApp({
                command,
                args: optionalStringArray(args, 'args'),
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                detached: args.detached !== false,
            })
            return { text: JSON.stringify(result, null, 2) }
        },

        agentmark_clipboard_read: async (): Promise<DispatchResult> => {
            const text = await readClipboardText()
            return { text: JSON.stringify({ text }, null, 2) }
        },

        agentmark_clipboard_write: async (args): Promise<DispatchResult> => {
            const text = requireString(args, 'text')
            await writeClipboardText(text)
            return { text: JSON.stringify({ written: true, bytes: Buffer.byteLength(text, 'utf8') }, null, 2) }
        },

        agentmark_files_list: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const recursive = args.recursive === true
            const items = await listFiles(filesGuard, path, recursive)
            return { text: JSON.stringify({ count: items.length, items }, null, 2) }
        },

        agentmark_files_read: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const encoding = args.encoding === 'base64' ? 'base64' : 'utf8'
            const content = await readFileText(filesGuard, path, encoding)
            return { text: JSON.stringify({ path, encoding, content }, null, 2) }
        },

        agentmark_files_write: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const content = requireString(args, 'content')
            const encoding = args.encoding === 'base64' ? 'base64' : 'utf8'
            const append = args.append === true
            const result = await writeFileText(filesGuard, path, content, encoding, append)
            return { text: JSON.stringify(result, null, 2) }
        },

        agentmark_files_stat: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const info = await statFile(filesGuard, path)
            return { text: JSON.stringify(info, null, 2) }
        },

        agentmark_files_delete: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const recursive = args.recursive === true
            const result = await deleteFile(filesGuard, path, recursive)
            return { text: JSON.stringify({ deleted: true, ...result }, null, 2) }
        },

        agentmark_files_move: async (args): Promise<DispatchResult> => {
            const from = requireString(args, 'from')
            const to = requireString(args, 'to')
            const result = await moveFile(filesGuard, from, to)
            return { text: JSON.stringify({ moved: true, ...result }, null, 2) }
        },

        agentmark_files_mkdir: async (args): Promise<DispatchResult> => {
            const path = requireString(args, 'path')
            const recursive = args.recursive !== false
            const result = await makeDir(filesGuard, path, recursive)
            return { text: JSON.stringify({ created: true, ...result }, null, 2) }
        },

        agentmark_state_get: async (args): Promise<DispatchResult> => {
            const key = requireString(args, 'key')
            const value = await stateStore.get(key)
            return { text: JSON.stringify({ key, value: value ?? null }, null, 2) }
        },

        agentmark_state_set: async (args): Promise<DispatchResult> => {
            const key = requireString(args, 'key')
            if (!('value' in args)) {
                return { text: '`value` is required (any JSON-serialisable shape).', isError: true }
            }
            await stateStore.set(key, args.value)
            return { text: JSON.stringify({ key, set: true }, null, 2) }
        },

        agentmark_state_delete: async (args): Promise<DispatchResult> => {
            const key = requireString(args, 'key')
            const existed = await stateStore.delete(key)
            return { text: JSON.stringify({ key, existed }, null, 2) }
        },

        agentmark_state_list: async (args): Promise<DispatchResult> => {
            const prefix = typeof args.prefix === 'string' ? args.prefix : undefined
            const entries = await stateStore.list(prefix)
            return { text: JSON.stringify({ count: entries.length, entries }, null, 2) }
        },
    }

    return {
        name: 'foundations',
        version: '0.1.0',
        tools: FOUNDATIONS_TOOLS,
        handlers,
        describeSessions: () => ({
            foundations: {
                file_roots: filesGuard.roots,
                state_path: stateStore.filePath,
            },
        }),
    }
}

// Re-export the building blocks so consumers can compose smaller plugins.
export { runApp } from './app-runner'
export { readClipboardText, writeClipboardText } from './clipboard'
export { FilesGuard } from './files'
export { StateStore } from './state'
export { FOUNDATIONS_TOOLS } from './tool-defs'

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
    const v = args[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`Argument ${key} must be an array of strings.`)
    }
    return v as string[]
}

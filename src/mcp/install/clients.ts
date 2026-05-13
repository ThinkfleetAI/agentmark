/**
 * Per-client config descriptors.
 *
 * Every major MCP client uses the same `mcpServers` JSON shape; only
 * the file path differs. The descriptors below capture the per-OS
 * paths + a cheap "is this client installed" check so the installer
 * can offer the right ones at runtime.
 *
 * Adding a new client: write one new factory function, append it to
 * `ALL_CLIENTS`.
 */
import { access, constants } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ClientDescriptor, McpServerEntry } from './types'

// The standard mcpServers shape every supported client uses today.
// Documented here so the per-client factories can share a single
// applyEntry / removeEntry implementation.
interface McpServersConfig {
    mcpServers?: Record<string, McpServerEntry>
}

function applyStandardEntry(config: unknown, name: string, entry: McpServerEntry): unknown {
    const cfg = (config && typeof config === 'object' ? config : {}) as McpServersConfig
    const servers = { ...(cfg.mcpServers ?? {}) }
    servers[name] = entry
    return { ...cfg, mcpServers: servers }
}

function removeStandardEntry(config: unknown, name: string): { config: unknown; removed: boolean } {
    if (!config || typeof config !== 'object') return { config: config ?? {}, removed: false }
    const cfg = config as McpServersConfig
    if (!cfg.mcpServers || !(name in cfg.mcpServers)) return { config, removed: false }
    const { [name]: _removed, ...rest } = cfg.mcpServers
    void _removed
    return {
        config: { ...cfg, mcpServers: rest },
        removed: true,
    }
}

async function pathExists(p: string | null): Promise<boolean> {
    if (!p) return false
    try { await access(p, constants.F_OK); return true } catch { return false }
}

// ──────────────────────────────────────────────────────────────────────
// Claude Code CLI
// ──────────────────────────────────────────────────────────────────────

function claudeCode(): ClientDescriptor {
    return {
        id: 'claude-code',
        name: 'Claude Code',
        configPath: () => path.join(os.homedir(), '.claude.json'),
        isInstalled: async () => {
            // Either the config file exists or `claude` is on PATH.
            if (await pathExists(path.join(os.homedir(), '.claude.json'))) return true
            return commandExists('claude')
        },
        applyEntry: applyStandardEntry,
        removeEntry: removeStandardEntry,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Claude Desktop (standalone app)
// ──────────────────────────────────────────────────────────────────────

function claudeDesktop(): ClientDescriptor {
    return {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        configPath: () => {
            if (process.platform === 'darwin') {
                return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            }
            if (process.platform === 'win32') {
                const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
                return path.join(appData, 'Claude', 'claude_desktop_config.json')
            }
            // Linux: no official Claude Desktop, but the config layout is
            // documented in case someone runs the unofficial port.
            return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
        },
        isInstalled: async () => {
            const cfgPath = claudeDesktop().configPath()
            if (await pathExists(cfgPath)) return true
            if (process.platform === 'darwin') {
                return pathExists('/Applications/Claude.app')
            }
            return false
        },
        applyEntry: applyStandardEntry,
        removeEntry: removeStandardEntry,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Cursor
// ──────────────────────────────────────────────────────────────────────

function cursor(): ClientDescriptor {
    return {
        id: 'cursor',
        name: 'Cursor',
        configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
        isInstalled: async () => {
            if (await pathExists(path.join(os.homedir(), '.cursor'))) return true
            if (process.platform === 'darwin') {
                return pathExists('/Applications/Cursor.app')
            }
            return commandExists('cursor')
        },
        applyEntry: applyStandardEntry,
        removeEntry: removeStandardEntry,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Windsurf
// ──────────────────────────────────────────────────────────────────────

function windsurf(): ClientDescriptor {
    return {
        id: 'windsurf',
        name: 'Windsurf',
        configPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
        isInstalled: async () => {
            if (await pathExists(path.join(os.homedir(), '.codeium', 'windsurf'))) return true
            if (process.platform === 'darwin') {
                return pathExists('/Applications/Windsurf.app')
            }
            return commandExists('windsurf')
        },
        applyEntry: applyStandardEntry,
        removeEntry: removeStandardEntry,
    }
}

// ──────────────────────────────────────────────────────────────────────
// Codex CLI (OpenAI)
// ──────────────────────────────────────────────────────────────────────

function codex(): ClientDescriptor {
    return {
        id: 'codex',
        name: 'Codex CLI',
        configPath: () => path.join(os.homedir(), '.codex', 'config.toml'),
        isInstalled: async () => {
            if (await pathExists(path.join(os.homedir(), '.codex'))) return true
            return commandExists('codex')
        },
        // Codex CLI's config is TOML, not JSON, so it gets its own
        // shape later. Until the TOML writer lands, the descriptor
        // signals "not yet supported" via a sentinel error.
        applyEntry: () => {
            throw new Error(
                'Codex CLI configuration (TOML) is not yet supported by `agentmark-mcp install`. '
                + 'Add the agentmark MCP server manually to ~/.codex/config.toml for now.',
            )
        },
        removeEntry: (config) => ({ config, removed: false }),
    }
}

// ──────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────

export function allClients(): ClientDescriptor[] {
    return [claudeCode(), claudeDesktop(), cursor(), windsurf(), codex()]
}

export function clientById(id: string): ClientDescriptor | null {
    return allClients().find((c) => c.id === id) ?? null
}

/** Cheap PATH lookup for clients that ship a CLI binary. */
async function commandExists(command: string): Promise<boolean> {
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    const exeSuffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
    for (const dir of pathDirs) {
        for (const suffix of exeSuffixes) {
            if (await pathExists(path.join(dir, command + suffix))) return true
        }
    }
    return false
}

// Re-export so consumers (tests) can poke at internals.
export { applyStandardEntry, removeStandardEntry, commandExists, pathExists }

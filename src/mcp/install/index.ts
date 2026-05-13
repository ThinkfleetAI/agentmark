/**
 * `agentmark-mcp install` — auto-wire AI clients to talk to the agentmark
 * MCP server.
 *
 * After the installer drops the binary onto a machine, this is the
 * second-and-final click users need to be productive: detect which
 * AI assistants are present (Claude Code, Claude Desktop, Cursor,
 * Windsurf, …) and write the `mcpServers` entry into each one's
 * config file.
 *
 * Idempotent: re-running picks up new clients without disturbing
 * existing entries. Every write is preceded by a `<path>.bak` copy
 * so a fumbled config can be rolled back with one `mv`.
 */
import { allClients, clientById } from './clients'
import { readJson, writeJson } from './writer'
import type {
    ClientDescriptor,
    InstallOptions,
    InstallResult,
    McpServerEntry,
    UninstallOptions,
} from './types'

const DEFAULT_ENTRY_NAME = 'agentmark'

/**
 * Wire the agentmark MCP server into each detected (or caller-specified)
 * AI client's config. Returns a per-client result so the CLI can print
 * a readable summary without re-discovering state.
 */
export async function installToClients(options: InstallOptions): Promise<InstallResult> {
    const targets = await resolveTargets(options.clientIds)
    const name = options.entryName ?? DEFAULT_ENTRY_NAME
    const out: InstallResult['clients'] = []

    for (const client of targets) {
        const cfgPath = client.configPath()
        if (!cfgPath) {
            out.push({
                id: client.id, name: client.name, path: '',
                action: 'skipped',
                message: `Not supported on platform ${process.platform}.`,
            })
            continue
        }

        try {
            const { value: current } = await readJson(cfgPath)
            const existingEntry = extractExistingEntry(current, name)
            const action: InstallResult['clients'][number]['action'] = existingEntry
                ? entriesEqual(existingEntry, options.entry) ? 'already_present' : 'updated'
                : 'added'

            const updated = client.applyEntry(current, name, options.entry)

            if (options.dryRun) {
                out.push({ id: client.id, name: client.name, path: cfgPath, action, message: '(dry run; nothing written)' })
                continue
            }

            const written = await writeJson(cfgPath, updated)
            out.push({
                id: client.id,
                name: client.name,
                path: cfgPath,
                action,
                message: written.backup_path ? `backup: ${written.backup_path}` : undefined,
            })
        } catch (err) {
            out.push({
                id: client.id, name: client.name, path: cfgPath,
                action: 'error', message: (err as Error).message,
            })
        }
    }

    return { clients: out }
}

/**
 * Remove agentmark from each targeted client's config. Mirror of
 * installToClients with the same dry-run + error-collection semantics.
 */
export async function uninstallFromClients(options: UninstallOptions): Promise<InstallResult> {
    const targets = await resolveTargets(options.clientIds)
    const name = options.entryName ?? DEFAULT_ENTRY_NAME
    const out: InstallResult['clients'] = []

    for (const client of targets) {
        const cfgPath = client.configPath()
        if (!cfgPath) {
            out.push({
                id: client.id, name: client.name, path: '',
                action: 'skipped',
                message: `Not supported on platform ${process.platform}.`,
            })
            continue
        }

        try {
            const { existed, value: current } = await readJson(cfgPath)
            if (!existed) {
                out.push({ id: client.id, name: client.name, path: cfgPath, action: 'not_present' })
                continue
            }
            const { config: updated, removed } = client.removeEntry(current, name)
            if (!removed) {
                out.push({ id: client.id, name: client.name, path: cfgPath, action: 'not_present' })
                continue
            }
            if (options.dryRun) {
                out.push({ id: client.id, name: client.name, path: cfgPath, action: 'removed', message: '(dry run; nothing written)' })
                continue
            }
            const written = await writeJson(cfgPath, updated)
            out.push({
                id: client.id, name: client.name, path: cfgPath, action: 'removed',
                message: written.backup_path ? `backup: ${written.backup_path}` : undefined,
            })
        } catch (err) {
            out.push({
                id: client.id, name: client.name, path: cfgPath,
                action: 'error', message: (err as Error).message,
            })
        }
    }

    return { clients: out }
}

async function resolveTargets(ids?: string[]): Promise<ClientDescriptor[]> {
    if (ids && ids.length > 0) {
        const out: ClientDescriptor[] = []
        for (const id of ids) {
            const c = clientById(id)
            if (!c) throw new Error(`Unknown client id: ${id}. Known: ${allClients().map((x) => x.id).join(', ')}`)
            out.push(c)
        }
        return out
    }
    // Default: every client that looks installed.
    const all = allClients()
    const detected: ClientDescriptor[] = []
    for (const c of all) {
        if (await c.isInstalled()) detected.push(c)
    }
    return detected
}

function extractExistingEntry(config: unknown, name: string): McpServerEntry | null {
    if (!config || typeof config !== 'object') return null
    const cfg = config as { mcpServers?: Record<string, McpServerEntry> }
    return cfg.mcpServers?.[name] ?? null
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
    if (a.command !== b.command) return false
    if (JSON.stringify(a.args ?? []) !== JSON.stringify(b.args ?? [])) return false
    if (JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})) return false
    return true
}

export { allClients, clientById } from './clients'
export type {
    ClientDescriptor,
    InstallOptions,
    UninstallOptions,
    InstallResult,
    McpServerEntry,
} from './types'
export { readJson, writeJson } from './writer'

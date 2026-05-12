/**
 * Types for the `agentmark-mcp install` subcommand.
 *
 * Each supported MCP client (Claude Code, Claude Desktop, Cursor,
 * Windsurf, Codex CLI, …) has a `ClientDescriptor` that describes:
 *   - how to detect whether the client is installed
 *   - where its MCP-config JSON file lives
 *   - whether its config uses the standard `mcpServers` shape or
 *     something bespoke
 *
 * The installer iterates descriptors, asks the user which to enable,
 * and writes a uniform `McpServerEntry` into each chosen client's
 * config file using atomic temp-file + rename.
 */

export interface McpServerEntry {
    /** Absolute path to the binary or launcher that runs the MCP server. */
    command: string
    /** Arguments forwarded to the command. Typically empty. */
    args?: string[]
    /** Environment variables to inject when the client spawns the server. */
    env?: Record<string, string>
}

export interface ClientDescriptor {
    /** Stable identifier (`claude-code`, `cursor`, …). Lowercase, kebab-case. */
    id: string
    /** Human-friendly display name for prompts + logs. */
    name: string
    /** Returns the absolute path of the MCP-config file for this client on
     *  the current OS, or `null` when the client doesn't ship on this OS. */
    configPath(): string | null
    /** Cheap detection — true when the config file already exists OR when
     *  the client's binary is on PATH. Used to decide whether to even
     *  offer this client in the interactive picker. */
    isInstalled(): Promise<boolean>
    /** Apply the new server entry to a parsed config object. Most clients
     *  use the standard `mcpServers` shape but the seam exists for any
     *  that diverge later. */
    applyEntry(config: unknown, name: string, entry: McpServerEntry): unknown
    /** Remove our entry from a parsed config object. Returns whether
     *  anything was removed (useful for `--remove` reporting). */
    removeEntry(config: unknown, name: string): { config: unknown; removed: boolean }
}

export interface InstallResult {
    /** One entry per client we attempted to wire up. */
    clients: Array<{
        id: string
        name: string
        path: string
        action: 'added' | 'updated' | 'already_present' | 'removed' | 'not_present' | 'skipped' | 'error'
        message?: string
    }>
}

export interface InstallOptions {
    /** Restrict to specific client ids. When omitted, all detected
     *  clients are targeted. */
    clientIds?: string[]
    /** Don't write anything; just report what would change. */
    dryRun?: boolean
    /** The server entry to install / update. */
    entry: McpServerEntry
    /** Name to register under in each client's `mcpServers` map.
     *  Default: 'agentmark'. */
    entryName?: string
}

export interface UninstallOptions {
    clientIds?: string[]
    dryRun?: boolean
    entryName?: string
}

/**
 * Flag parser for `agentmark-mcp install / setup / uninstall`.
 *
 * Extracted into a standalone module so tests can exercise the
 * parser without importing `cli.ts` (which has top-level
 * side effects: it spawns the MCP server on import).
 *
 * Supported flags:
 *   --client=<id>     repeatable, comma-separable
 *   --name=<name>     entry name (default: agentmark)
 *   --command=<path>  command to register
 *   --env=KEY=VALUE   env var for the registered server. Repeatable.
 *   --dry-run | -n    no-op write
 */
import type { McpServerEntry } from './types'

export interface ParsedFlags {
    client: string[] | undefined
    name: string[] | undefined
    command: string[] | undefined
    /** When supplied, the resolved env map. Empty object means
     *  `--env` was used but every value parsed empty (still valid). */
    env: Record<string, string> | undefined
    dryRun: boolean
}

/**
 * Env-var name shape. Restricted to identifier chars so a malformed
 * `--env` can't be coerced into shell metacharacters that an MCP
 * client's launcher might interpret. Mixed case allowed because some
 * tools use them (e.g. `NodeEnv`).
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_VALUE_MAX_LEN = 4 * 1024

export function parseFlags(args: string[], emit?: (line: string) => void): ParsedFlags {
    const client: string[] = []
    const name: string[] = []
    const command: string[] = []
    const env: Record<string, string> = {}
    let envSeen = false
    let dryRun = false
    const warn = emit ?? ((line: string) => process.stderr.write(`${line}\n`))

    for (const arg of args) {
        if (arg === '--dry-run' || arg === '-n') { dryRun = true; continue }
        const m = arg.match(/^--(client|name|command|env)(?:=(.*))?$/)
        if (!m) continue
        const value = m[2]
        if (value === undefined) continue
        if (m[1] === 'client') value.split(',').filter(Boolean).forEach((v) => client.push(v.trim()))
        if (m[1] === 'name') name.push(value)
        if (m[1] === 'command') command.push(value)
        if (m[1] === 'env') {
            const { key, value: envValue } = parseEnvFlag(value)
            if (Object.prototype.hasOwnProperty.call(env, key)) {
                warn(`warning: --env=${key}=… specified more than once; later value wins.`)
            }
            env[key] = envValue
            envSeen = true
        }
    }

    return {
        client: client.length > 0 ? client : undefined,
        name: name.length > 0 ? name : undefined,
        command: command.length > 0 ? command : undefined,
        env: envSeen ? env : undefined,
        dryRun,
    }
}

/**
 * Parse one `KEY=value` pair. Throws on malformed input so a typo
 * fails the install loudly instead of silently writing a broken
 * config block to the user's AI client.
 */
export function parseEnvFlag(raw: string): { key: string; value: string } {
    const idx = raw.indexOf('=')
    if (idx < 1) {
        throw new Error(
            `--env must be in KEY=VALUE form (got "${raw}"). `
            + 'Quote the whole pair if the value contains spaces.',
        )
    }
    const key = raw.slice(0, idx)
    const value = raw.slice(idx + 1)
    if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(
            `--env key "${key}" is not a valid env-var name. `
            + 'Must match [A-Za-z_][A-Za-z0-9_]*.',
        )
    }
    if (value.length > ENV_VALUE_MAX_LEN) {
        throw new Error(
            `--env value for "${key}" exceeds ${ENV_VALUE_MAX_LEN} chars. `
            + 'Use a credential reference instead of inlining a long secret.',
        )
    }
    if (value.indexOf('\0') !== -1) {
        throw new Error(`--env value for "${key}" contains a null byte; rejected.`)
    }
    return { key, value }
}

/**
 * Compose an {@link McpServerEntry} from parsed flags. `command`
 * defaults to whatever the caller resolves; passing it in keeps
 * this module pure (no PATH lookups, no fs).
 */
export function buildEntryFromFlags(
    flags: ParsedFlags,
    defaults: { command: string },
): McpServerEntry {
    const command = flags.command?.[0] ?? defaults.command
    const entry: McpServerEntry = { command, args: [] }
    if (flags.env && Object.keys(flags.env).length > 0) {
        entry.env = flags.env
    }
    return entry
}

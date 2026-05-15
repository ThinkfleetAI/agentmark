#!/usr/bin/env node

/**
 * `agentmark-mcp` CLI.
 *
 *   agentmark-mcp                 → start the MCP server (default)
 *   agentmark-mcp serve           → same; explicit
 *   agentmark-mcp install         → auto-wire detected AI clients
 *   agentmark-mcp install --client=cursor --dry-run
 *   agentmark-mcp uninstall       → remove our entries
 *   agentmark-mcp doctor          → diagnose what's wired up
 *   agentmark-mcp --help          → usage
 */

import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { startMcpServer } from './server'
import {
    installToClients,
    uninstallFromClients,
    allClients,
    type McpServerEntry,
} from './install'
import {
    parseFlags,
    buildEntryFromFlags,
    type ParsedFlags,
} from './install/flags'
import { installSkill, type SkillInstallResult } from './install/skills'
import { getSkillContent } from './skills/thinkfleet-memory'

const HELP = `agentmark-mcp — Model Context Protocol server for AgentMark

USAGE
  agentmark-mcp [serve]                 Start the MCP server (default; speaks stdio)
  agentmark-mcp install [options]       Wire detected AI clients to talk to this server
  agentmark-mcp setup [options]         Alias for install (more discoverable name)
  agentmark-mcp uninstall [options]     Remove our entry from those clients
  agentmark-mcp doctor                  Diagnose what's installed + wired up
  agentmark-mcp --help                  This help

QUICKSTART (Node already installed)
  Run the npm package directly via npx, no global install required:

      npx -y @thinkfleet/agentmark setup

  Detects Claude Code / Claude Desktop / Cursor / Windsurf in one go
  and wires them all up to use this MCP server. Use --dry-run first
  to preview.

OPTIONS (install / setup / uninstall)
  --client=<id>     Target specific client(s). Repeat or comma-separate.
                    Known: ${allClients().map((c) => c.id).join(', ')}
  --name=<name>     Entry name to register under (default: agentmark)
  --command=<path>  Absolute command path to register (default: auto-detected)
  --env=KEY=VALUE   Add an env var that the client launches the MCP server
                    with. Repeatable. Used to wire THINKFLEET_* credentials
                    so the memory plugin talks to your ThinkFleet workspace
                    instead of the on-disk default backend.

                    Security note: the value is written into the client's
                    MCP config file on disk. Prefer rotating secrets from
                    an OS keychain (ThinkFleet Desktop does this) rather
                    than passing long-lived keys on a shared machine.
  --skill=<name>    Also install a skill that teaches the agent when /
                    how to use the tools you just wired. Repeatable.
                    Known: thinkfleet-memory. Native-skill clients get a
                    skill.md file; rules-file clients get a marker block.
  --dry-run         Show what would change without writing

EXAMPLE — wire Claude Code to ThinkFleet memory + install skill:
  agentmark-mcp install --client=claude-code \\
      --env=THINKFLEET_BASE_URL=https://app.thinkfleet.ai \\
      --env=THINKFLEET_PROJECT_ID=proj_xxx \\
      --env=THINKFLEET_API_KEY=sk-xxx \\
      --skill=thinkfleet-memory
`

async function main(argv: string[]): Promise<number> {
    const sub = argv[0] ?? 'serve'

    if (sub === '-h' || sub === '--help' || sub === 'help') {
        process.stdout.write(HELP)
        return 0
    }

    if (sub === 'serve') {
        await startMcpServer({ name: 'agentmark', version: pkgVersion() })
        // The MCP transport keeps the event loop alive via stdio.
        return await new Promise<number>(() => { /* never resolves */ })
    }

    if (sub === 'install' || sub === 'setup' || sub === 'quickstart') {
        return await runInstall(argv.slice(1))
    }
    if (sub === 'uninstall') {
        return await runUninstall(argv.slice(1))
    }
    if (sub === 'doctor') {
        return await runDoctor()
    }

    process.stderr.write(`Unknown subcommand: ${sub}\n\n${HELP}`)
    return 2
}

async function runInstall(args: string[]): Promise<number> {
    const flags = parseFlags(args)
    const entry = entryForCli(flags)
    const result = await installToClients({
        clientIds: flags.client,
        entry,
        entryName: flags.name?.[0],
        dryRun: flags.dryRun,
    })
    printInstallResult(result, flags.dryRun ? 'dry-run' : 'install')

    // After the MCP entry is wired, optionally install skill files
    // that teach the agent when/how to use those tools. Opt-in via
    // `--skill=<name>` so callers who only want the MCP wiring
    // (and not opinions injected into their agent prompts) can
    // still install just the server entry.
    let skillsOk = true
    if (flags.skill && flags.skill.length > 0) {
        for (const name of flags.skill) {
            const skill = getSkillContent(name)
            if (!skill) {
                process.stderr.write(`Unknown skill: ${name}. Skipping.\n`)
                skillsOk = false
                continue
            }
            const skillResult = await installSkill({
                skillName: name,
                content: skill.content,
                clientIds: flags.client,
                dryRun: flags.dryRun,
            })
            printSkillResult(name, skillResult, flags.dryRun ? 'dry-run' : 'install')
            if (!skillResult.ok) skillsOk = false
        }
    }

    const installOk = result.clients.every((r) => r.action !== 'error')
    return installOk && skillsOk ? 0 : 1
}

async function runUninstall(args: string[]): Promise<number> {
    const flags = parseFlags(args)
    const result = await uninstallFromClients({
        clientIds: flags.client,
        entryName: flags.name?.[0],
        dryRun: flags.dryRun,
    })
    printInstallResult(result, flags.dryRun ? 'dry-run' : 'uninstall')
    return result.clients.every((r) => r.action !== 'error') ? 0 : 1
}

async function runDoctor(): Promise<number> {
    process.stdout.write('agentmark-mcp doctor\n\n')
    process.stdout.write(`Auto-detected command:  ${defaultCommand()}\n`)
    process.stdout.write(`Node:                   ${process.execPath} (${process.version})\n\n`)
    process.stdout.write('Clients:\n')
    for (const c of allClients()) {
        const cfg = c.configPath() ?? '(unsupported on this OS)'
        const installed = await c.isInstalled()
        process.stdout.write(`  ${c.id.padEnd(16)} ${installed ? '✓' : '·'}  ${cfg}\n`)
    }
    return 0
}

function entryForCli(flags: ParsedFlags): McpServerEntry {
    return buildEntryFromFlags(flags, { command: defaultCommand() })
}

/**
 * Best-effort detection of the agentmark-mcp launcher to register in
 * client configs. In order of preference:
 *   1. Same-directory launcher script (when running from the bundled
 *      installer layout: <root>/bin/agentmark-mcp or <root>\agentmark-mcp.cmd)
 *   2. `agentmark-mcp` on PATH
 *   3. Fall back to `npx -y @thinkfleet/agentmark agentmark-mcp` form
 */
function defaultCommand(): string {
    // 1. Bundled-installer layout: this script lives at
    //    <root>/agentmark/dist/src/mcp/cli.js; the launcher is at
    //    <root>/bin/agentmark-mcp (POSIX) or <root>\agentmark-mcp.cmd (Win).
    try {
        const here = path.dirname(__filename)
        const installRoot = path.resolve(here, '..', '..', '..', '..')
        const posixLauncher = path.join(installRoot, 'bin', 'agentmark-mcp')
        if (existsSync(posixLauncher)) return posixLauncher
        const winLauncher = path.join(installRoot, 'agentmark-mcp.cmd')
        if (existsSync(winLauncher)) return winLauncher
    } catch { /* swallow — fall through to PATH lookup */ }

    // 2. PATH lookup.
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agentmark-mcp'], { encoding: 'utf8' })
    if (which.status === 0) {
        const found = which.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
        if (found) return found.trim()
    }

    // 3. Last resort.
    return process.execPath
}

function pkgVersion(): string {
    try {
        // The compiled cli.js sits next to package.json in the dist tree
        // when bundled by the installer; the source layout differs.
        // Read it lazily and tolerate failure.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return (require(path.resolve(__dirname, '..', '..', 'package.json')).version as string) ?? '0.0.0'
    } catch {
        return '0.0.0'
    }
}

function printSkillResult(skillName: string, result: SkillInstallResult, label: string): void {
    process.stdout.write(`agentmark-mcp ${label} — skill "${skillName}":\n\n`)
    for (const c of result.clients) {
        const flag =
            c.action === 'added' || c.action === 'updated' ? '✓'
                : c.action === 'already_present' ? '·'
                    : c.action === 'skipped' ? '⏭'
                        : '✗'
        const padded = `${c.clientName} [${c.action}]`.padEnd(40)
        process.stdout.write(`  ${flag}  ${padded}  ${c.path}\n`)
        if (c.message) process.stdout.write(`     ${c.message}\n`)
    }
    process.stdout.write('\n')
}

function printInstallResult(result: { clients: Array<{ id: string; name: string; path: string; action: string; message?: string }> }, label: string): void {
    process.stdout.write(`agentmark-mcp ${label} — results:\n\n`)
    for (const c of result.clients) {
        const flag =
            c.action === 'added' || c.action === 'updated' || c.action === 'removed' ? '✓'
                : c.action === 'already_present' || c.action === 'not_present' ? '·'
                    : c.action === 'skipped' ? '⏭'
                        : '✗'
        const padded = `${c.name} [${c.action}]`.padEnd(40)
        process.stdout.write(`  ${flag}  ${padded}  ${c.path}\n`)
        if (c.message) process.stdout.write(`     ${c.message}\n`)
    }
    process.stdout.write('\n')
}

main(process.argv.slice(2))
    .then((code) => {
        if (typeof code === 'number' && code !== 0) process.exit(code)
    })
    .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`agentmark-mcp: ${(err as Error).message ?? err}`)
        process.exit(1)
    })

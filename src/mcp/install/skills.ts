/**
 * Per-AI-tool skill installer.
 *
 * Some clients (Claude Code, Claude Desktop) have a native "skills"
 * concept — a directory of `skill.md` files the agent loads at
 * session start. We write the canonical skill content directly to
 * the known path.
 *
 * Other clients (Cursor, Windsurf, Codex CLI) don't have skills,
 * but they DO load a rules / instructions file automatically every
 * session. We render the skill content as a marker-wrapped block
 * inside that file so re-running the installer surgically replaces
 * just our section without disturbing the user's hand-written
 * rules.
 *
 * Why this lives alongside the MCP-config installer:
 *   The skill is useless without the corresponding MCP tools, so
 *   the natural install moment is the same. The CLI's
 *   `--skill=<name>` flag opts in per-skill so users who only want
 *   the MCP wiring (no opinions injected into their agent) can
 *   still install just the server entry.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export const MANAGED_BLOCK_START = '<!-- thinkfleet:skill:start -->'
export const MANAGED_BLOCK_END = '<!-- thinkfleet:skill:end -->'

export interface SkillTarget {
    /** Client id matching `ClientDescriptor.id`. */
    clientId: string
    /** Human-readable client name (for log output). */
    clientName: string
    /** Absolute path the renderer writes to. Returns null when the
     *  client doesn't ship on this OS. */
    pathFor(skillName: string): string | null
    /** When `true`, the file at the path is owned exclusively by the
     *  skill — we write the whole file. When `false`, the skill is
     *  one marker-delimited block inside a larger file the user
     *  also edits — we replace only the block. */
    exclusive: boolean
}

export interface SkillInstallResult {
    clients: Array<{
        clientId: string
        clientName: string
        skillName: string
        path: string
        action: 'added' | 'updated' | 'already_present' | 'skipped' | 'error'
        message?: string
    }>
    ok: boolean
}

export interface SkillInstallOptions {
    skillName: string
    /** Markdown body of the skill (frontmatter + content). */
    content: string
    /** When set, restrict to these client ids. */
    clientIds?: string[]
    /** Skill targets to use. Defaults to {@link DEFAULT_SKILL_TARGETS}. */
    targets?: SkillTarget[]
    /** Preview only — log paths + actions, don't write. */
    dryRun?: boolean
}

/** Native-skill clients (write the whole file). */
function claudeCodeSkillTarget(): SkillTarget {
    return {
        clientId: 'claude-code',
        clientName: 'Claude Code',
        pathFor: (name) => path.join(os.homedir(), '.claude', 'skills', name, 'skill.md'),
        exclusive: true,
    }
}

function claudeDesktopSkillTarget(): SkillTarget {
    return {
        clientId: 'claude-desktop',
        clientName: 'Claude Desktop',
        pathFor: (name) => {
            if (process.platform === 'darwin') {
                return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'skills', name, 'skill.md')
            }
            if (process.platform === 'win32') {
                const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
                return path.join(appData, 'Claude', 'skills', name, 'skill.md')
            }
            // Linux Claude Desktop isn't shipped today.
            return null
        },
        exclusive: true,
    }
}

/**
 * The defaults the install CLI uses when the caller doesn't supply
 * a custom list. Today: just the two Claude-family tools with
 * native skill support. Cursor / Windsurf / Codex rules-file
 * injection lands in a follow-up — they need a separate code path
 * for the marker-block replacement.
 */
export const DEFAULT_SKILL_TARGETS: SkillTarget[] = [
    claudeCodeSkillTarget(),
    claudeDesktopSkillTarget(),
]

export async function installSkill(options: SkillInstallOptions): Promise<SkillInstallResult> {
    const targets = options.targets ?? DEFAULT_SKILL_TARGETS
    const filtered = options.clientIds
        ? targets.filter((t) => options.clientIds!.includes(t.clientId))
        : targets

    const out: SkillInstallResult['clients'] = []

    for (const target of filtered) {
        const dest = target.pathFor(options.skillName)
        if (!dest) {
            out.push({
                clientId: target.clientId,
                clientName: target.clientName,
                skillName: options.skillName,
                path: '',
                action: 'skipped',
                message: `Not supported on platform ${process.platform}.`,
            })
            continue
        }

        try {
            const action = await writeSkillForTarget(target, dest, options.content, options.dryRun === true)
            out.push({
                clientId: target.clientId,
                clientName: target.clientName,
                skillName: options.skillName,
                path: dest,
                action,
                message: options.dryRun ? '(dry run; nothing written)' : undefined,
            })
        }
        catch (err) {
            out.push({
                clientId: target.clientId,
                clientName: target.clientName,
                skillName: options.skillName,
                path: dest,
                action: 'error',
                message: (err as Error).message,
            })
        }
    }

    return { clients: out, ok: out.every((r) => r.action !== 'error') }
}

async function writeSkillForTarget(
    target: SkillTarget,
    dest: string,
    content: string,
    dryRun: boolean,
): Promise<'added' | 'updated' | 'already_present'> {
    if (target.exclusive) {
        // Whole-file write: read existing, decide action, replace.
        const existing = await safeReadFile(dest)
        if (existing !== null && existing === content) return 'already_present'
        if (!dryRun) {
            await mkdir(path.dirname(dest), { recursive: true })
            await atomicWriteFile(dest, content)
        }
        return existing === null ? 'added' : 'updated'
    }

    // Marker-block write: replace just our section in a larger file.
    const existing = (await safeReadFile(dest)) ?? ''
    const block = `${MANAGED_BLOCK_START}\n${content}\n${MANAGED_BLOCK_END}\n`
    const next = upsertManagedBlock(existing, block)
    if (next === existing) return 'already_present'
    if (!dryRun) {
        await mkdir(path.dirname(dest), { recursive: true })
        await atomicWriteFile(dest, next)
    }
    return existing.includes(MANAGED_BLOCK_START) ? 'updated' : 'added'
}

async function safeReadFile(p: string): Promise<string | null> {
    try {
        return await readFile(p, 'utf8')
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
}

/**
 * Atomic write — temp file in the same dir + rename. Sets `0644`
 * on POSIX so the skill file is readable by the AI client but not
 * writable by other users.
 */
async function atomicWriteFile(dest: string, content: string): Promise<void> {
    const tmp = `${dest}.tmp.${process.pid}`
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 })
    await rename(tmp, dest)
}

/**
 * Replace the existing managed block in `text`, or append a new
 * block at the end. Pure function — easy to unit-test.
 */
export function upsertManagedBlock(text: string, block: string): string {
    const startIdx = text.indexOf(MANAGED_BLOCK_START)
    const endIdx = text.indexOf(MANAGED_BLOCK_END)
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        // Include trailing newline if present
        const trailing = text.charAt(endIdx + MANAGED_BLOCK_END.length) === '\n' ? 1 : 0
        const before = text.slice(0, startIdx)
        const after = text.slice(endIdx + MANAGED_BLOCK_END.length + trailing)
        return `${before}${block}${after}`
    }
    // Append (with separating newline if existing text doesn't end in one).
    const sep = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    return `${text}${sep}${block}`
}

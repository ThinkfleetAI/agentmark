/**
 * Filesystem tools with an allowlist boundary.
 *
 * Every path arriving from the agent is resolved + canonicalised, then
 * checked to ensure it lives inside one of the configured root paths.
 * Symlinks are followed before the check, so an agent cannot escape via
 * `~/Documents/safe → /etc/passwd`.
 *
 * Default allowlist:
 *   - The process working directory + descendants.
 *   - The OS temp directory + descendants.
 *
 * Override via `FoundationsPluginConfig.fileRoots` or the
 * `AGENTMARK_FILES_ROOTS` env var (colon-separated, OS-pathlist style).
 */
import {
    readFile,
    writeFile,
    appendFile,
    stat,
    readdir,
    unlink,
    rm,
    rename,
    mkdir,
    realpath,
} from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface FilesConfig {
    /** Allowed root directories. Paths must canonicalise to live inside
     *  one of these. */
    roots: string[]
}

export class FilesGuard {
    readonly roots: string[]
    /** Roots after realpath() — what we actually compare against. Populated
     *  lazily on first safeResolve() so construction stays synchronous. */
    private canonicalRoots: string[] | null = null

    constructor(config?: Partial<FilesConfig>) {
        const fromEnv = (process.env.AGENTMARK_FILES_ROOTS ?? '')
            .split(path.delimiter)
            .filter(Boolean)
        const fromConfig = config?.roots ?? []
        const roots = [...fromConfig, ...fromEnv]
        if (roots.length === 0) {
            roots.push(process.cwd(), os.tmpdir())
        }
        this.roots = roots.map((r) => path.resolve(r))
    }

    /**
     * Resolve `p` relative to cwd, follow symlinks if the path exists,
     * then assert the result is inside the allowlist. Returns the
     * canonical path. Throws with a clear error on violation.
     */
    async safeResolve(p: string): Promise<string> {
        const resolved = path.resolve(p)
        let canonical = resolved
        try {
            canonical = await realpath(resolved)
        } catch {
            // The path doesn't exist yet (writing a new file). Walk up to
            // the first existing ancestor and realpath that, then append
            // the remainder. Prevents `..` and symlink escape via a
            // not-yet-created suffix.
            canonical = await canonicaliseViaParent(resolved)
        }
        const roots = await this.getCanonicalRoots()
        const ok = roots.some((root) => isPrefixPath(root, canonical))
        if (!ok) {
            throw new Error(
                `Path is outside the allowed roots: ${canonical}. `
                + `Allowed roots: ${roots.join(', ')}. `
                + `Configure via FoundationsPluginConfig.fileRoots or AGENTMARK_FILES_ROOTS.`,
            )
        }
        return canonical
    }

    /**
     * Canonicalise the configured roots once via realpath. Needed because
     * macOS aliases `/var` → `/private/var` and `/tmp` → `/private/tmp` —
     * candidate paths from realpath go through that alias, so roots have
     * to follow the same path for the prefix check to work.
     */
    private async getCanonicalRoots(): Promise<string[]> {
        if (this.canonicalRoots) return this.canonicalRoots
        const out: string[] = []
        for (const root of this.roots) {
            try {
                out.push(await realpath(root))
            } catch {
                out.push(root)
            }
        }
        this.canonicalRoots = out
        return out
    }
}

export interface ListItem {
    name: string
    path: string
    kind: 'file' | 'directory' | 'symlink' | 'other'
    size: number
    modified: string
}

export async function listFiles(
    guard: FilesGuard,
    targetPath: string,
    recursive: boolean,
): Promise<ListItem[]> {
    const root = await guard.safeResolve(targetPath)
    const out: ListItem[] = []
    await walk(root, recursive, out)
    return out
}

async function walk(dir: string, recursive: boolean, out: ListItem[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        const info = await stat(full).catch(() => null)
        if (!info) continue
        out.push({
            name: entry.name,
            path: full,
            kind: entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                    ? 'file'
                    : entry.isSymbolicLink()
                        ? 'symlink'
                        : 'other',
            size: info.size,
            modified: info.mtime.toISOString(),
        })
        if (recursive && entry.isDirectory()) {
            await walk(full, true, out)
        }
    }
}

export async function readFileText(
    guard: FilesGuard,
    p: string,
    encoding: 'utf8' | 'base64',
): Promise<string> {
    const canonical = await guard.safeResolve(p)
    if (encoding === 'base64') {
        const buf = await readFile(canonical)
        return buf.toString('base64')
    }
    return await readFile(canonical, 'utf8')
}

export async function writeFileText(
    guard: FilesGuard,
    p: string,
    content: string,
    encoding: 'utf8' | 'base64',
    append: boolean,
): Promise<{ path: string; bytes: number }> {
    const canonical = await guard.safeResolve(p)
    const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
    if (append) {
        await appendFile(canonical, data)
    } else {
        await writeFile(canonical, data)
    }
    return { path: canonical, bytes: data.length }
}

export async function statFile(
    guard: FilesGuard,
    p: string,
): Promise<ListItem> {
    const canonical = await guard.safeResolve(p)
    const info = await stat(canonical)
    return {
        name: path.basename(canonical),
        path: canonical,
        kind: info.isDirectory()
            ? 'directory'
            : info.isFile()
                ? 'file'
                : info.isSymbolicLink()
                    ? 'symlink'
                    : 'other',
        size: info.size,
        modified: info.mtime.toISOString(),
    }
}

export async function deleteFile(
    guard: FilesGuard,
    p: string,
    recursive: boolean,
): Promise<{ path: string }> {
    const canonical = await guard.safeResolve(p)
    const info = await stat(canonical)
    if (info.isDirectory()) {
        if (!recursive) {
            throw new Error(`Refusing to delete directory ${canonical} without recursive=true.`)
        }
        await rm(canonical, { recursive: true, force: false })
    } else {
        await unlink(canonical)
    }
    return { path: canonical }
}

export async function moveFile(
    guard: FilesGuard,
    fromPath: string,
    toPath: string,
): Promise<{ from: string; to: string }> {
    const from = await guard.safeResolve(fromPath)
    const to = await guard.safeResolve(toPath)
    await rename(from, to)
    return { from, to }
}

export async function makeDir(
    guard: FilesGuard,
    p: string,
    recursive: boolean,
): Promise<{ path: string }> {
    const canonical = await guard.safeResolve(p)
    await mkdir(canonical, { recursive })
    return { path: canonical }
}

function isPrefixPath(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate)
    // Same path, or a descendant. Reject anything that needs `..` to get there.
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function canonicaliseViaParent(p: string): Promise<string> {
    let parent = path.dirname(p)
    let suffix = path.basename(p)
    // Walk up until we find an existing ancestor we can realpath.
    while (parent !== path.dirname(parent)) {
        try {
            const real = await realpath(parent)
            return path.join(real, suffix)
        } catch {
            suffix = path.join(path.basename(parent), suffix)
            parent = path.dirname(parent)
        }
    }
    return p
}

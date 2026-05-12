/**
 * Atomic JSON writer for client config files.
 *
 * Every write goes through:
 *   1. Read existing file (or empty object if missing).
 *   2. Back up to `<path>.bak` (rotated — only one backup kept).
 *   3. Write new content to `<path>.tmp-<pid>-<ts>`.
 *   4. Rename onto the target path.
 *
 * Rename is atomic on every Unix filesystem we care about and on
 * Windows NTFS when MoveFileEx is used (Node's `fs.rename` does this
 * automatically). The .bak makes recovery one `mv` away if anything
 * goes wrong.
 */
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises'
import * as path from 'node:path'

export interface WriteResult {
    /** Did the file exist before this write? */
    existed_before: boolean
    /** Path of the .bak file we created (when the file existed). */
    backup_path?: string
    /** Bytes written. */
    bytes: number
}

/**
 * Read + parse a JSON file. Returns `{}` when the file doesn't exist.
 * Throws on malformed JSON so callers can decide whether to bail or
 * overwrite (we choose to bail — losing a user's config silently is
 * not OK).
 */
export async function readJson(filePath: string): Promise<{ existed: boolean; value: unknown }> {
    try {
        const raw = await readFile(filePath, 'utf8')
        try {
            return { existed: true, value: JSON.parse(raw) }
        } catch (err) {
            throw new Error(
                `${filePath} exists but is not valid JSON: ${(err as Error).message}. `
                + `Refusing to overwrite. Fix the file or remove it and re-run.`,
            )
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { existed: false, value: {} }
        }
        throw err
    }
}

export async function writeJson(filePath: string, value: unknown): Promise<WriteResult> {
    const dir = path.dirname(filePath)
    await mkdir(dir, { recursive: true })

    const existedBefore = await fileExists(filePath)
    let backupPath: string | undefined
    if (existedBefore) {
        backupPath = `${filePath}.bak`
        await copyFile(filePath, backupPath)
    }

    const json = JSON.stringify(value, null, 2) + '\n'
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, json, 'utf8')
    await rename(tmp, filePath)

    return {
        existed_before: existedBefore,
        backup_path: backupPath,
        bytes: Buffer.byteLength(json, 'utf8'),
    }
}

async function fileExists(p: string): Promise<boolean> {
    try {
        const { access, constants } = await import('node:fs/promises')
        await access(p, constants.F_OK)
        return true
    } catch {
        return false
    }
}

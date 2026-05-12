/**
 * Durable key/value store for cross-session agent state.
 *
 * Backed by a single JSON file at `~/.thinkfleet/agentmark/state.json`
 * (mode 0600). Suitable for small, slow-changing data: last-customer
 * worked with, cached enumerations, retry counters. Not a database —
 * writes serialise the whole file, so don't put megabytes in here.
 *
 * Keys are flat strings. Values are anything `JSON.stringify` can
 * round-trip. Snapshots are atomic via write-temp + rename to avoid
 * partial-file corruption on crash.
 */
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface StateStoreConfig {
    /** Override the on-disk path (mostly for tests). */
    path?: string
}

export class StateStore {
    readonly filePath: string
    private cached: Record<string, unknown> | null = null

    constructor(config: StateStoreConfig = {}) {
        this.filePath = config.path
            ?? path.join(os.homedir(), '.thinkfleet', 'agentmark', 'state.json')
    }

    async get(key: string): Promise<unknown> {
        const data = await this.load()
        return data[key]
    }

    async set(key: string, value: unknown): Promise<void> {
        const data = await this.load()
        data[key] = value
        await this.save(data)
    }

    async delete(key: string): Promise<boolean> {
        const data = await this.load()
        if (!(key in data)) return false
        delete data[key]
        await this.save(data)
        return true
    }

    async list(prefix?: string): Promise<Array<{ key: string; value: unknown }>> {
        const data = await this.load()
        const keys = Object.keys(data)
        const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys
        return filtered.map((k) => ({ key: k, value: data[k] }))
    }

    async clear(): Promise<void> {
        this.cached = {}
        await unlink(this.filePath).catch(() => {})
    }

    private async load(): Promise<Record<string, unknown>> {
        if (this.cached) return this.cached
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as Record<string, unknown>
            this.cached = parsed
            return parsed
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.cached = {}
                return this.cached
            }
            throw err
        }
    }

    private async save(data: Record<string, unknown>): Promise<void> {
        this.cached = data
        await mkdir(path.dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' })
        await chmod(tmp, 0o600).catch(() => {
            // Windows ACL semantics swallow chmod; not fatal.
        })
        await rename(tmp, this.filePath)
    }
}

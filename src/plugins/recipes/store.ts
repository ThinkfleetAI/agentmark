/**
 * Recipe storage — single JSON file containing a `{ name → Recipe }` map.
 *
 * Default path: `~/.thinkfleet/agentmark/recipes.json` (mode 0600).
 * Separate from the Foundations StateStore so recipes don't bloat the
 * general K/V file and so they can be backed up / synced independently.
 *
 * Writes use the same temp-file + rename pattern as StateStore.
 */
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Recipe } from './types'

export interface RecipeStoreConfig {
    /** Override the on-disk path (mostly for tests). */
    path?: string
}

interface RecipeFile {
    version: 1
    recipes: Record<string, Recipe>
}

export class RecipeStore {
    readonly filePath: string
    private cached: RecipeFile | null = null

    constructor(config: RecipeStoreConfig = {}) {
        this.filePath = config.path
            ?? path.join(os.homedir(), '.thinkfleet', 'agentmark', 'recipes.json')
    }

    async get(name: string): Promise<Recipe | null> {
        const file = await this.load()
        return file.recipes[name] ?? null
    }

    async list(filter?: { target_app?: string }): Promise<Recipe[]> {
        const file = await this.load()
        let recipes = Object.values(file.recipes)
        if (filter?.target_app) {
            recipes = recipes.filter((r) => r.target_app === filter.target_app)
        }
        // Stable order by name to make listings predictable.
        recipes.sort((a, b) => a.name.localeCompare(b.name))
        return recipes
    }

    async save(recipe: Recipe, options: { on_conflict?: 'replace' | 'fail' } = {}): Promise<Recipe> {
        const file = await this.load()
        const existing = file.recipes[recipe.name]
        if (existing && options.on_conflict !== 'replace') {
            throw new Error(
                `Recipe "${recipe.name}" already exists. `
                + `Pass on_conflict="replace" to overwrite or pick a different name.`,
            )
        }
        const now = new Date().toISOString()
        const stored: Recipe = {
            ...recipe,
            version: (existing?.version ?? 0) + 1,
            created_at: existing?.created_at ?? recipe.created_at ?? now,
            updated_at: now,
        }
        file.recipes[recipe.name] = stored
        await this.persist(file)
        return stored
    }

    async delete(name: string): Promise<boolean> {
        const file = await this.load()
        if (!(name in file.recipes)) return false
        delete file.recipes[name]
        await this.persist(file)
        return true
    }

    async clear(): Promise<void> {
        this.cached = { version: 1, recipes: {} }
        await unlink(this.filePath).catch(() => {})
    }

    private async load(): Promise<RecipeFile> {
        if (this.cached) return this.cached
        try {
            const raw = await readFile(this.filePath, 'utf8')
            const parsed = JSON.parse(raw) as RecipeFile
            if (parsed.version !== 1 || !parsed.recipes || typeof parsed.recipes !== 'object') {
                throw new Error(`Malformed recipe file at ${this.filePath}: unexpected schema.`)
            }
            this.cached = parsed
            return parsed
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.cached = { version: 1, recipes: {} }
                return this.cached
            }
            throw err
        }
    }

    private async persist(file: RecipeFile): Promise<void> {
        this.cached = file
        await mkdir(path.dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
        await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8' })
        await chmod(tmp, 0o600).catch(() => {
            // Windows ACL semantics swallow chmod; not fatal.
        })
        await rename(tmp, this.filePath)
    }
}

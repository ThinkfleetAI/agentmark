/**
 * Local-file recipe backend.
 *
 * The default `RecipeBackend` implementation: single JSON file
 * containing a `{ name → Recipe }` map. For team sharing or on-prem/
 * cloud sync, use `RemoteRecipeBackend` instead.
 *
 * Default path: `~/.thinkfleet/agentmark/recipes.json` (mode 0600).
 * Atomic temp-file + rename writes.
 */
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RecipeBackend, RecipeBackendDescription } from './backend'
import type { Recipe } from './types'

export interface LocalFileRecipeBackendConfig {
    /** Override the on-disk path (mostly for tests). */
    path?: string
}

/** @deprecated Use LocalFileRecipeBackendConfig. */
export type RecipeStoreConfig = LocalFileRecipeBackendConfig

interface RecipeFile {
    version: 1
    recipes: Record<string, Recipe>
}

export class LocalFileRecipeBackend implements RecipeBackend {
    readonly filePath: string
    private cached: RecipeFile | null = null

    constructor(config: LocalFileRecipeBackendConfig = {}) {
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

    async describe(): Promise<RecipeBackendDescription> {
        const file = await this.load()
        return {
            kind: 'local-file',
            store_path: this.filePath,
            recipe_count: Object.keys(file.recipes).length,
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

/**
 * Backward-compat alias for the renamed class.
 * @deprecated Use `LocalFileRecipeBackend` directly, or pass a
 * `RecipeBackend` to `createRecipesPlugin({ backend })`.
 */
export const RecipeStore = LocalFileRecipeBackend

/**
 * Recipe backend abstraction.
 *
 * Same pattern as MemoryBackend: an interface so the same plugin works
 * against a local-file store (default) or a remote ThinkFleet service
 * (on-prem or cloud). The desktop app picks one at construction time.
 */
import type { Recipe } from './types'

export interface RecipeBackend {
    get(name: string): Promise<Recipe | null>
    list(filter?: { target_app?: string }): Promise<Recipe[]>
    save(recipe: Recipe, options?: { on_conflict?: 'replace' | 'fail' }): Promise<Recipe>
    delete(name: string): Promise<boolean>
    clear(): Promise<void>
    describe(): Promise<RecipeBackendDescription>
}

export interface RecipeBackendDescription {
    kind: string
    [k: string]: unknown
}

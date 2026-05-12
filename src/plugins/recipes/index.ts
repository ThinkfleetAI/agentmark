/**
 * Recipes Pack — durable named playbooks the agent learns once + replays.
 *
 * Recipes are stored as JSON; `agentmark_recipe_get` returns a resolved
 * plan (parameter substitutions applied) and the AI dispatches each
 * step itself. The plugin deliberately does NOT auto-execute server-side
 * — keeps the steps visible to the AI's reasoning chain and avoids the
 * recursive-dispatch coupling between the recipe plugin and the
 * surrounding Dispatcher.
 *
 * Pairs naturally with agentmark_desktop_diff: each step in a recipe
 * can carry a `verify` block describing what the diff should look like
 * after the step lands, and the agent decides what "verified" means.
 */
import { LocalFileRecipeBackend } from './store'
import { resolveRecipe, substitute, applyParameterSchema } from './substitute'
import { RECIPES_TOOLS } from './tool-defs'
import type { RecipeBackend } from './backend'
import type { Recipe, RecipeStep, RecipeParameter } from './types'
import type { AgentMarkPlugin, DispatchResult, ToolHandler } from '../../mcp/plugin'

export interface RecipesPluginConfig {
    /**
     * Storage backend. Pass a `RemoteRecipeBackend` to point at an
     * on-prem or cloud ThinkFleet recipe service. Defaults to a
     * `LocalFileRecipeBackend` at ~/.thinkfleet/agentmark/recipes.json.
     */
    backend?: RecipeBackend
    /** Local-file backend convenience: override the on-disk store path.
     *  Ignored when `backend` is supplied. */
    storePath?: string
}

export function createRecipesPlugin(config: RecipesPluginConfig = {}): AgentMarkPlugin {
    const store: RecipeBackend = config.backend ?? new LocalFileRecipeBackend({ path: config.storePath })

    const handlers: Record<string, ToolHandler> = {
        agentmark_recipe_save: async (args): Promise<DispatchResult> => {
            const name = requireString(args, 'name')
            const steps = requireArray<RecipeStep>(args, 'steps')
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i] as unknown as Record<string, unknown>
                if (typeof s.tool !== 'string') {
                    return { text: `steps[${i}].tool must be a string.`, isError: true }
                }
                if (!s.args || typeof s.args !== 'object') {
                    return { text: `steps[${i}].args must be an object.`, isError: true }
                }
            }

            const now = new Date().toISOString()
            const recipe: Recipe = {
                name,
                description: typeof args.description === 'string' ? args.description : undefined,
                target_app: typeof args.target_app === 'string' ? args.target_app : undefined,
                parameters: Array.isArray(args.parameters) ? (args.parameters as RecipeParameter[]) : undefined,
                steps,
                version: 0, // store bumps this
                created_at: now,
                updated_at: now,
            }

            const onConflict = args.on_conflict === 'replace' ? 'replace' : 'fail'
            const saved = await store.save(recipe, { on_conflict: onConflict })
            return { text: JSON.stringify({ saved: true, ...recipeSummary(saved) }, null, 2) }
        },

        agentmark_recipe_list: async (args): Promise<DispatchResult> => {
            const target = typeof args.target_app === 'string' ? args.target_app : undefined
            const recipes = await store.list({ target_app: target })
            return {
                text: JSON.stringify({
                    count: recipes.length,
                    recipes: recipes.map(recipeSummary),
                }, null, 2),
            }
        },

        agentmark_recipe_get: async (args): Promise<DispatchResult> => {
            const name = requireString(args, 'name')
            const recipe = await store.get(name)
            if (!recipe) {
                return { text: `Unknown recipe: ${name}`, isError: true }
            }

            const paramsSupplied = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
            if (!paramsSupplied) {
                return { text: JSON.stringify({ resolved: false, recipe }, null, 2) }
            }

            try {
                const supplied = args.params as Record<string, unknown>
                const applied = applyParameterSchema(recipe.parameters, supplied)
                const resolvedSteps = recipe.steps.map((step) => ({
                    ...step,
                    args: substitute(step.args, applied) as Record<string, unknown>,
                }))
                return {
                    text: JSON.stringify({
                        resolved: true,
                        recipe: {
                            ...recipeSummary(recipe),
                            description: recipe.description,
                            target_app: recipe.target_app,
                        },
                        resolved_with: applied,
                        steps: resolvedSteps,
                    }, null, 2),
                }
            } catch (err) {
                return { text: (err as Error).message, isError: true }
            }
        },

        agentmark_recipe_delete: async (args): Promise<DispatchResult> => {
            const name = requireString(args, 'name')
            const existed = await store.delete(name)
            return { text: JSON.stringify({ name, existed }, null, 2) }
        },
    }

    const isLocalFile = store instanceof LocalFileRecipeBackend

    return {
        name: 'recipes',
        version: '0.1.0',
        tools: RECIPES_TOOLS,
        handlers,
        describeSessions: () => ({
            recipes: isLocalFile
                ? { kind: 'local-file', store_path: (store as LocalFileRecipeBackend).filePath }
                : { kind: 'custom', backend_class: store.constructor.name },
        }),
    }
}

function recipeSummary(r: Recipe): Record<string, unknown> {
    return {
        name: r.name,
        description: r.description,
        target_app: r.target_app,
        parameter_count: r.parameters?.length ?? 0,
        step_count: r.steps.length,
        version: r.version,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

export { LocalFileRecipeBackend, RecipeStore } from './store'
export type { LocalFileRecipeBackendConfig, RecipeStoreConfig } from './store'
export type { RecipeBackend, RecipeBackendDescription } from './backend'
export { resolveRecipe, substitute, applyParameterSchema } from './substitute'
export { RECIPES_TOOLS } from './tool-defs'
export type { Recipe, RecipeStep, RecipeParameter, RecipeVerification, ResolvedRecipe, ResolvedRecipeStep } from './types'

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key]
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`Missing required argument: ${key}`)
    }
    return v
}

function requireArray<T>(args: Record<string, unknown>, key: string): T[] {
    const v = args[key]
    if (!Array.isArray(v) || v.length === 0) {
        throw new Error(`Argument ${key} must be a non-empty array.`)
    }
    return v as T[]
}

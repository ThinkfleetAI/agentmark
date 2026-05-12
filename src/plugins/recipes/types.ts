/**
 * Recipe type system.
 *
 * A Recipe is a saved sequence of MCP tool calls with optional parameter
 * substitution. Stored as JSON; retrieved as a "playbook" the agent
 * executes step-by-step itself (rather than auto-running inside the
 * server, which would couple the plugin to the Dispatcher and hide the
 * actions from the AI's reasoning chain).
 *
 * Substitution syntax: `{{param.name}}` in any string arg. The token
 * can stand alone ("{{param.name}}" → the raw param value, preserving
 * non-string types) or be embedded ("prefix {{param.name}} suffix" →
 * always coerced to string).
 *
 * Verification fields on each step describe what a subsequent
 * agentmark_desktop_diff call SHOULD return — the agent uses them to
 * check the step landed before proceeding. They aren't enforced
 * server-side; the agent decides what "verified" means.
 */

export interface Recipe {
    /** Stable unique identifier. Used as the storage key. */
    name: string
    /** Human-friendly description of what this recipe accomplishes. */
    description?: string
    /** App or surface this recipe drives ("excel", "nowcerts", etc.).
     *  Used for filtering in `agentmark_recipe_list`. */
    target_app?: string
    /** Parameter schema. Recipe callers supply values matching these. */
    parameters?: RecipeParameter[]
    /** Ordered list of steps to execute. */
    steps: RecipeStep[]
    /** Bumped each time the recipe is saved. */
    version: number
    /** ISO timestamps. */
    created_at: string
    updated_at: string
}

export interface RecipeParameter {
    name: string
    description?: string
    type: 'string' | 'number' | 'boolean'
    /** Default value used when the caller doesn't supply one. */
    default?: unknown
    /** When true, `agentmark_recipe_get` errors if the caller omits the param. */
    required?: boolean
}

export interface RecipeStep {
    /** MCP tool name to call (e.g. `agentmark_desktop_execute`). */
    tool: string
    /** Tool arguments; string values may contain `{{param.name}}` placeholders. */
    args: Record<string, unknown>
    /** Optional human-friendly description of what this step does.
     *  Surfaced in the resolved plan to help the AI understand intent. */
    description?: string
    /** Optional verification hint — what the AI should check via diff. */
    verify?: RecipeVerification
    /** What to do when this step fails. Default: 'abort'. */
    on_failure?: 'abort' | 'continue' | 'retry'
}

export interface RecipeVerification {
    /** Specific element values the next diff should report. */
    expect_value_changes?: Array<{ element_id: string; to: unknown }>
    /** Window-title check after this step. */
    expect_window_title?: string | { contains: string }
    /** Number of new elements that should appear (e.g. a dialog opening). */
    expect_added_elements?: number
    /** True when the agent expects no observable change (e.g. background save). */
    expect_no_changes?: boolean
}

export interface ResolvedRecipe extends Omit<Recipe, 'steps'> {
    /** Steps with `{{param.X}}` placeholders substituted. */
    steps: ResolvedRecipeStep[]
    /** The parameter values that were applied. */
    resolved_with: Record<string, unknown>
}

export interface ResolvedRecipeStep extends Omit<RecipeStep, 'args'> {
    args: Record<string, unknown>
}

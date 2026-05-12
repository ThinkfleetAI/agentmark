/**
 * Parameter substitution for recipe args.
 *
 * Two syntaxes:
 *   - Bare token `{{param.name}}` → returns the param value unchanged
 *     (preserves number / boolean / array types).
 *   - Embedded `prefix {{param.name}} suffix` → string interpolation;
 *     non-string values are coerced via String(...).
 *
 * Walks the args object recursively so nested objects + arrays also
 * substitute. Throws on unknown param references when `strict: true`;
 * leaves the placeholder verbatim when `strict: false` (default).
 */

import type { Recipe, RecipeParameter } from './types'

export interface SubstituteOptions {
    strict?: boolean
}

const BARE_TOKEN = /^\{\{\s*param\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/
const EMBEDDED_TOKEN = /\{\{\s*param\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/**
 * Apply parameter values to a recipe's step args. Returns a new
 * deep-copied args structure; never mutates the input. `params` should
 * already be type-validated against the recipe's parameter schema.
 */
export function substitute(
    value: unknown,
    params: Record<string, unknown>,
    options: SubstituteOptions = {},
): unknown {
    if (typeof value === 'string') {
        return substituteString(value, params, options)
    }
    if (Array.isArray(value)) {
        return value.map((v) => substitute(v, params, options))
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = substitute(v, params, options)
        }
        return out
    }
    return value
}

function substituteString(s: string, params: Record<string, unknown>, options: SubstituteOptions): unknown {
    const bare = s.match(BARE_TOKEN)
    if (bare) {
        const name = bare[1]
        if (!(name in params)) {
            if (options.strict) throw new Error(`Unknown parameter: ${name}`)
            return s
        }
        return params[name]
    }
    // Embedded substitutions — always produce a string.
    EMBEDDED_TOKEN.lastIndex = 0
    return s.replace(EMBEDDED_TOKEN, (_match, name: string) => {
        if (!(name in params)) {
            if (options.strict) throw new Error(`Unknown parameter: ${name}`)
            return _match
        }
        const v = params[name]
        return v === null || v === undefined ? '' : String(v)
    })
}

/**
 * Validate that the caller-supplied params match the recipe's parameter
 * schema. Fills in defaults; errors on missing required params; coerces
 * basic types where it's lossless (number string → number).
 */
export function applyParameterSchema(
    schema: RecipeParameter[] | undefined,
    supplied: Record<string, unknown>,
): Record<string, unknown> {
    if (!schema || schema.length === 0) return { ...supplied }

    const out: Record<string, unknown> = {}
    for (const param of schema) {
        const provided = supplied[param.name]
        if (provided === undefined) {
            if (param.default !== undefined) {
                out[param.name] = param.default
                continue
            }
            if (param.required) {
                throw new Error(`Recipe parameter "${param.name}" is required.`)
            }
            continue
        }

        const coerced = coerceType(provided, param.type, param.name)
        out[param.name] = coerced
    }

    // Pass through any extra keys the recipe author didn't declare. Strict
    // mode could reject these later; for now keep it forgiving so authors
    // can add new params without breaking old callers.
    for (const [k, v] of Object.entries(supplied)) {
        if (!(k in out)) out[k] = v
    }

    return out
}

function coerceType(value: unknown, type: RecipeParameter['type'], name: string): unknown {
    if (type === 'string') {
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        throw new Error(`Recipe parameter "${name}" must be a string; got ${typeof value}`)
    }
    if (type === 'number') {
        if (typeof value === 'number') return value
        if (typeof value === 'string') {
            const n = Number(value)
            if (!Number.isFinite(n)) {
                throw new Error(`Recipe parameter "${name}" must be a number; got "${value}"`)
            }
            return n
        }
        throw new Error(`Recipe parameter "${name}" must be a number; got ${typeof value}`)
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return value
        if (value === 'true' || value === 'false') return value === 'true'
        throw new Error(`Recipe parameter "${name}" must be a boolean; got ${typeof value}`)
    }
    return value
}

/**
 * Resolve a whole recipe — apply parameter schema, substitute into each
 * step's args, return a `ResolvedRecipe` ready for the AI to execute.
 */
export function resolveRecipe(
    recipe: Recipe,
    params: Record<string, unknown>,
): Recipe['steps'] extends Array<infer S> ? { steps: Array<S>; resolved_with: Record<string, unknown> } : never {
    const applied = applyParameterSchema(recipe.parameters, params)
    const steps = recipe.steps.map((step) => ({
        ...step,
        args: substitute(step.args, applied) as Record<string, unknown>,
    }))
    return { steps, resolved_with: applied } as never
}

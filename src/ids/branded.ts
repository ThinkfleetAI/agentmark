/**
 * Nominal (branded) ID types for AgentMark.
 *
 * These types are structurally `string` at runtime but distinct at the type
 * level. Using `ActionId` instead of raw `string` for action lookups prevents
 * accidental mixing of IDs (e.g. passing a media ID where an action ID is
 * expected) without runtime overhead.
 *
 * @example
 *   const id = ActionId('act_7')          // explicit cast through constructor
 *   await page.execute(id)                // type-safe
 *   await page.execute('act_7' as ActionId) // also OK
 */

declare const __actionIdBrand: unique symbol
declare const __mediaIdBrand: unique symbol
declare const __regionIdBrand: unique symbol

/**
 * Identifier for an interactive action defined in a snapshot's `actions` map.
 * Action IDs are stable within a snapshot; they may shift between snapshots
 * of the same page (see spec §7.7).
 */
export type ActionId = string & { readonly [__actionIdBrand]: never }

/**
 * Identifier for a media reference defined in a snapshot's `media` map.
 */
export type MediaId = string & { readonly [__mediaIdBrand]: never }

/**
 * Identifier for a logical region of the page (used for grouping actions).
 */
export type RegionId = string & { readonly [__regionIdBrand]: never }

/**
 * Cast a string into an `ActionId`. Performs no runtime validation —
 * the brand is purely a type-level marker.
 */
export function ActionId(value: string): ActionId {
    return value as ActionId
}

/** Cast a string into a `MediaId`. */
export function MediaId(value: string): MediaId {
    return value as MediaId
}

/** Cast a string into a `RegionId`. */
export function RegionId(value: string): RegionId {
    return value as RegionId
}

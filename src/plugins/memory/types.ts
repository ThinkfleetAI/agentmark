/**
 * Hierarchical agent-memory types.
 *
 * Designed for use across IDE coding assistants (Claude Code, Cursor,
 * Codex, etc.) that suffer per-session amnesia. Memory is scoped to
 * one of five levels so callers can persist things at the right
 * granularity:
 *
 *   platform — global to this machine / install
 *   project  — scoped to a repo (or working dir)
 *   agent    — scoped to a specific AI agent (e.g. Claude Code session)
 *   user     — scoped to an end-user identity
 *   session  — scoped to one MCP session (lost on disconnect)
 *
 * `agentmark_memory_get` resolves by walking from most-specific to
 * most-general — session > agent > user > project > platform — so a
 * project-specific note overrides a platform-default for the same key.
 *
 * Records are JSON; values may be any JSON-serialisable shape. TTL is
 * optional (memories without one persist forever). Tags enable
 * lightweight search beyond exact-key lookup.
 */

export type MemoryScopeType = 'platform' | 'project' | 'agent' | 'user' | 'session'

export interface MemoryScope {
    type: MemoryScopeType
    /** Identifier within the scope. Platform scope has no id (it's global);
     *  the others require one (repo path, agent name, user email, session id). */
    id?: string
}

export interface MemoryRecord {
    /** Stable opaque id for this memory record. Returned by set, used
     *  by delete-by-id. */
    record_id: string
    /** The memory's logical key — free-form string within a scope. */
    key: string
    /** JSON-serialisable value. */
    value: unknown
    scope: MemoryScope
    /** Lightweight search tags. */
    tags?: string[]
    /** Epoch-ms expiry. Memories past their TTL are filtered out on read. */
    expires_at?: number
    /** ISO timestamps. */
    created_at: string
    updated_at: string
    /** How many times this record has been read via `get` or `search`. */
    access_count: number
    /** ISO timestamp of the most recent read. */
    last_accessed_at?: string
}

export interface MemorySearchQuery {
    /** Substring match against key / value (when stringifiable). */
    query?: string
    /** Restrict to a specific scope. */
    scope?: MemoryScope
    /** Match any of these tags. */
    tags?: string[]
    /** Max records to return. Default: 50. */
    limit?: number
    /** Sort order. Default: 'recency' (most recently updated first). */
    sort_by?: 'recency' | 'access_count' | 'created'
}

/**
 * Session persistence — save and restore the cookies + origin storage of a
 * Playwright `BrowserContext` so an agent can resume an authenticated session
 * across runs.
 *
 * The on-disk format wraps Playwright's `storageState` with a small envelope
 * so we can evolve the schema later without losing backward compatibility.
 */

import type { BrowserContext, BrowserContextOptions } from 'playwright-core'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AGENTMARK_VERSION } from '../types'

/** AgentMark session-file format (separate from the spec version). */
export const SESSION_FORMAT_VERSION = '1' as const

/** Playwright's storageState shape, sourced from the type system to stay in sync. */
export type StorageState = NonNullable<BrowserContextOptions['storageState']>

export interface SessionFile {
    /** Format version of this session file. */
    session_format: typeof SESSION_FORMAT_VERSION
    /** AgentMark version that wrote the file. */
    agentmark: string
    /** ISO 8601 timestamp when the session was captured. */
    saved_at: string
    /** Playwright storageState (cookies + per-origin localStorage). */
    storage_state: StorageState
}

/**
 * Persist the current `BrowserContext` state to a JSON file on disk.
 * Creates parent directories as needed. Atomic via write-to-temp-then-rename
 * to prevent partial writes on crash.
 */
export async function saveSessionToFile(context: BrowserContext, filePath: string): Promise<void> {
    const absolute = path.resolve(filePath)
    const dir = path.dirname(absolute)
    await fs.mkdir(dir, { recursive: true })

    const storage = (await context.storageState()) as StorageState
    const file: SessionFile = {
        session_format: SESSION_FORMAT_VERSION,
        agentmark: AGENTMARK_VERSION,
        saved_at: new Date().toISOString(),
        storage_state: storage,
    }

    // Atomic write — avoids leaving a half-written file if the process crashes.
    const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await fs.rename(tmp, absolute)
}

/**
 * Load a previously-saved session file and return the `storageState` to be
 * passed to `browser.newContext({ storageState })`.
 *
 * Throws on missing file or invalid format.
 */
export async function loadSessionFromFile(filePath: string): Promise<StorageState> {
    const data = await fs.readFile(path.resolve(filePath), 'utf8')
    let parsed: unknown
    try {
        parsed = JSON.parse(data)
    } catch (err) {
        throw new Error(`Session file is not valid JSON: ${(err as Error).message}`)
    }

    if (!isSessionFile(parsed)) {
        throw new Error('Session file is missing required fields (session_format, storage_state)')
    }

    if (parsed.session_format !== SESSION_FORMAT_VERSION) {
        throw new Error(
            `Unsupported session_format "${parsed.session_format}"; expected "${SESSION_FORMAT_VERSION}"`,
        )
    }

    return parsed.storage_state
}

function isSessionFile(value: unknown): value is SessionFile {
    if (typeof value !== 'object' || value === null) return false
    const v = value as Record<string, unknown>
    return (
        typeof v.session_format === 'string'
        && typeof v.saved_at === 'string'
        && typeof v.storage_state === 'object'
        && v.storage_state !== null
    )
}

/**
 * Shared helpers for AgentMark Activepieces actions.
 */

import { readFile } from 'node:fs/promises'
import { fetch } from 'undici'
import * as path from 'node:path'

/**
 * Resolve a "PDF source" prop into raw bytes. The piece accepts any of:
 *   - HTTP(S) URL → fetched
 *   - File path / file:// URI → read from disk (Activepieces workers run with
 *     filesystem access; flows that move files use temp paths)
 *   - data: URI with base64 payload → decoded inline
 *   - Bare base64 string (no scheme) → decoded as PDF bytes
 */
export async function resolveBytes(source: string): Promise<Uint8Array> {
    if (!source) throw new Error('Empty source')

    if (source.startsWith('http://') || source.startsWith('https://')) {
        const res = await fetch(source)
        if (!res.ok) {
            throw new Error(`Fetch failed: ${res.status} ${res.statusText} (${source})`)
        }
        const buf = Buffer.from(await res.arrayBuffer())
        return new Uint8Array(buf)
    }

    if (source.startsWith('data:')) {
        const commaAt = source.indexOf(',')
        if (commaAt === -1) throw new Error('Malformed data URI')
        const header = source.slice(5, commaAt)
        const payload = source.slice(commaAt + 1)
        if (header.includes(';base64')) {
            return new Uint8Array(Buffer.from(payload, 'base64'))
        }
        return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
    }

    if (source.startsWith('file://')) {
        const fp = new URL(source).pathname
        const buf = await readFile(fp)
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }

    // Heuristic for "looks like a path": contains a path separator, doesn't
    // contain whitespace, and ends with a likely extension. Anything else
    // gets decoded as base64.
    const looksLikePath =
        (source.includes('/') || source.includes('\\'))
        && !/\s/.test(source)
        && /\.[a-z0-9]{2,5}$/i.test(source)
    if (looksLikePath) {
        const buf = await readFile(path.resolve(source))
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }

    return new Uint8Array(Buffer.from(source, 'base64'))
}

export function bytesToBase64DataUri(bytes: Uint8Array, mime = 'application/pdf'): string {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

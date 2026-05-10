import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    loadSessionFromFile,
    SESSION_FORMAT_VERSION,
    type SessionFile,
} from '../src/runtime/session'

const tmpFiles: string[] = []

function tmpPath(suffix = '.json'): string {
    const p = path.join(os.tmpdir(), `agentmark-session-test-${process.pid}-${Date.now()}-${Math.random()}${suffix}`)
    tmpFiles.push(p)
    return p
}

afterEach(async () => {
    for (const p of tmpFiles.splice(0)) {
        await fs.unlink(p).catch(() => {})
    }
})

describe('loadSessionFromFile', () => {
    it('loads a well-formed session file', async () => {
        const file: SessionFile = {
            session_format: SESSION_FORMAT_VERSION,
            agentmark: '0.1',
            saved_at: new Date().toISOString(),
            storage_state: { cookies: [], origins: [] },
        }
        const p = tmpPath()
        await fs.writeFile(p, JSON.stringify(file), 'utf8')
        const state = await loadSessionFromFile(p)
        expect(state).toEqual({ cookies: [], origins: [] })
    })

    it('throws on missing file', async () => {
        await expect(loadSessionFromFile('/nonexistent/path/never.json')).rejects.toThrow()
    })

    it('throws on invalid JSON', async () => {
        const p = tmpPath()
        await fs.writeFile(p, '{ not json', 'utf8')
        await expect(loadSessionFromFile(p)).rejects.toThrow(/not valid JSON/)
    })

    it('throws on missing required fields', async () => {
        const p = tmpPath()
        await fs.writeFile(p, JSON.stringify({ saved_at: 'now' }), 'utf8')
        await expect(loadSessionFromFile(p)).rejects.toThrow(/missing required fields/)
    })

    it('throws on unsupported session_format version', async () => {
        const p = tmpPath()
        await fs.writeFile(
            p,
            JSON.stringify({
                session_format: '99',
                agentmark: '0.1',
                saved_at: new Date().toISOString(),
                storage_state: {},
            }),
            'utf8',
        )
        await expect(loadSessionFromFile(p)).rejects.toThrow(/Unsupported session_format/)
    })
})

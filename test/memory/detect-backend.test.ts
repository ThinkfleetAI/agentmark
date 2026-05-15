/**
 * Tests for `detectMemoryBackend()` — env-aware backend selection.
 *
 * Threat model under test:
 *  - Partial creds MUST throw (silent fallback to local would demote
 *    a user from "memory syncs to my team" to "memory only on my disk"
 *    on a typo).
 *  - Malformed API key MUST throw (an invalid key would burn every
 *    memory call as a 401 round-trip).
 *  - No creds MUST return a local backend (the legacy default).
 *  - Full creds MUST return the SaaS backend.
 *  - Successful path MUST NOT leak credentials in thrown errors or
 *    `describeMemoryBackend` output.
 */
import { describe, it, expect } from 'vitest'
import {
    detectMemoryBackend,
    describeMemoryBackend,
    LocalFileMemoryBackend,
    ActivepiecesMemoryBackend,
    MemoryBackendConfigError,
} from '../../src/plugins/memory'

const FULL_ENV = {
    THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
    THINKFLEET_PROJECT_ID: 'proj_test_1234567890',
    THINKFLEET_API_KEY: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa',
} as const

describe('detectMemoryBackend — no creds', () => {
    it('returns LocalFileMemoryBackend when none of the env vars are set', () => {
        const backend = detectMemoryBackend({})
        expect(backend).toBeInstanceOf(LocalFileMemoryBackend)
    })

    it('treats empty strings as absent', () => {
        const backend = detectMemoryBackend({
            THINKFLEET_BASE_URL: '',
            THINKFLEET_PROJECT_ID: '',
            THINKFLEET_API_KEY: '',
        })
        expect(backend).toBeInstanceOf(LocalFileMemoryBackend)
    })

    it('treats whitespace-only strings as absent', () => {
        const backend = detectMemoryBackend({
            THINKFLEET_BASE_URL: '   ',
            THINKFLEET_PROJECT_ID: '\t',
            THINKFLEET_API_KEY: '\n',
        })
        expect(backend).toBeInstanceOf(LocalFileMemoryBackend)
    })
})

describe('detectMemoryBackend — full creds', () => {
    it('returns ActivepiecesMemoryBackend when all three env vars are set', () => {
        const backend = detectMemoryBackend(FULL_ENV)
        expect(backend).toBeInstanceOf(ActivepiecesMemoryBackend)
    })

    it('trims surrounding whitespace before constructing', () => {
        const backend = detectMemoryBackend({
            THINKFLEET_BASE_URL: '  https://app.thinkfleet.ai  ',
            THINKFLEET_PROJECT_ID: ' proj_test ',
            THINKFLEET_API_KEY: ' sk-test-aaaa ',
        }) as ActivepiecesMemoryBackend
        expect(backend.baseUrl).toBe('https://app.thinkfleet.ai')
        expect(backend.projectId).toBe('proj_test')
    })

    it('plumbs THINKFLEET_CHATBOT_ID through when present', () => {
        const backend = detectMemoryBackend({
            ...FULL_ENV,
            THINKFLEET_CHATBOT_ID: 'cb_abc',
        }) as ActivepiecesMemoryBackend
        expect(backend.chatbotId).toBe('cb_abc')
    })

    it('omits chatbotId when the env var is absent or empty', () => {
        const backend = detectMemoryBackend(FULL_ENV) as ActivepiecesMemoryBackend
        expect(backend.chatbotId).toBeUndefined()
    })
})

describe('detectMemoryBackend — partial creds (loud failures)', () => {
    it('throws when API key is set without base url + project id', () => {
        expect(() => detectMemoryBackend({
            THINKFLEET_API_KEY: 'sk-test',
        })).toThrowError(MemoryBackendConfigError)
    })

    it('throws when only base url is set', () => {
        expect(() => detectMemoryBackend({
            THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
        })).toThrowError(/Partial ThinkFleet credentials/)
    })

    it('error message names exactly which vars are missing', () => {
        try {
            detectMemoryBackend({
                THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
                THINKFLEET_PROJECT_ID: 'proj_test',
            })
            expect.fail('should have thrown')
        }
        catch (err) {
            expect(err).toBeInstanceOf(MemoryBackendConfigError)
            const m = (err as Error).message
            expect(m).toContain('THINKFLEET_API_KEY')
            expect(m).toContain('missing')
            expect(m).toContain('THINKFLEET_BASE_URL')
            expect(m).toContain('found')
        }
    })

    it('error message does NOT contain the partially-supplied API key value', () => {
        try {
            detectMemoryBackend({
                THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
                THINKFLEET_API_KEY: 'sk-very-secret-do-not-leak',
            })
            expect.fail('should have thrown')
        }
        catch (err) {
            const m = (err as Error).message
            expect(m).not.toContain('sk-very-secret-do-not-leak')
        }
    })
})

describe('detectMemoryBackend — malformed creds', () => {
    it('throws when API key does not start with "sk-"', () => {
        expect(() => detectMemoryBackend({
            ...FULL_ENV,
            THINKFLEET_API_KEY: 'wrong-format-12345',
        })).toThrowError(/must start with "sk-"/)
    })

    it('error truncates the bad key to first 4 chars so secrets do not leak', () => {
        try {
            detectMemoryBackend({
                ...FULL_ENV,
                THINKFLEET_API_KEY: 'pk-abcdefghijklmnopqrstuvwxyz',
            })
            expect.fail('should have thrown')
        }
        catch (err) {
            const m = (err as Error).message
            expect(m).toContain('pk-a…')
            expect(m).not.toContain('pk-abcdefghijklmnopqrstuvwxyz')
        }
    })
})

describe('describeMemoryBackend', () => {
    it('returns a credential-free description for ActivepiecesMemoryBackend', () => {
        const backend = detectMemoryBackend(FULL_ENV)
        const label = describeMemoryBackend(backend)
        expect(label).toContain('activepieces')
        expect(label).toContain(FULL_ENV.THINKFLEET_PROJECT_ID)
        expect(label).toContain(FULL_ENV.THINKFLEET_BASE_URL)
        expect(label).not.toContain(FULL_ENV.THINKFLEET_API_KEY)
    })

    it('includes chatbot id when present', () => {
        const backend = detectMemoryBackend({
            ...FULL_ENV,
            THINKFLEET_CHATBOT_ID: 'cb_xyz',
        })
        expect(describeMemoryBackend(backend)).toContain('cb_xyz')
    })

    it('returns "local-file" for LocalFileMemoryBackend', () => {
        expect(describeMemoryBackend(detectMemoryBackend({}))).toBe('local-file')
    })
})

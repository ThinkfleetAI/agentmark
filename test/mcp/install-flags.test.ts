/**
 * Tests for the install-CLI flag parser.
 *
 * Focus on the new `--env=KEY=VALUE` surface introduced for the
 * ThinkFleet Memory Bridge — it carries credentials into the AI
 * client's MCP config, so malformed input must fail loud and the
 * happy path must produce exactly the McpServerEntry shape the
 * downstream writer expects.
 */
import { describe, it, expect } from 'vitest'
import {
    parseFlags,
    parseEnvFlag,
    buildEntryFromFlags,
} from '../../src/mcp/install/flags'

describe('parseEnvFlag', () => {
    it('parses a simple KEY=VALUE pair', () => {
        expect(parseEnvFlag('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' })
    })

    it('preserves "=" signs inside the value (e.g. base64)', () => {
        expect(parseEnvFlag('TOKEN=abc=def==')).toEqual({
            key: 'TOKEN',
            value: 'abc=def==',
        })
    })

    it('allows empty values', () => {
        expect(parseEnvFlag('FLAG=')).toEqual({ key: 'FLAG', value: '' })
    })

    it('rejects missing "=" entirely', () => {
        expect(() => parseEnvFlag('NOEQUALS')).toThrowError(/KEY=VALUE form/)
    })

    it('rejects "=value" without a key', () => {
        expect(() => parseEnvFlag('=oops')).toThrowError(/KEY=VALUE form/)
    })

    it('rejects keys with shell-relevant characters', () => {
        expect(() => parseEnvFlag('FOO;rm=anything')).toThrowError(/not a valid env-var name/)
        expect(() => parseEnvFlag('FOO BAR=x')).toThrowError(/not a valid env-var name/)
        expect(() => parseEnvFlag('FOO`x`=y')).toThrowError(/not a valid env-var name/)
    })

    it('rejects keys starting with a digit', () => {
        expect(() => parseEnvFlag('1FOO=bar')).toThrowError(/not a valid env-var name/)
    })

    it('accepts mixed-case keys (NodeEnv-style)', () => {
        expect(parseEnvFlag('NodeEnv=production')).toEqual({
            key: 'NodeEnv',
            value: 'production',
        })
    })

    it('rejects values containing a null byte', () => {
        expect(() => parseEnvFlag('FOO=before\0after')).toThrowError(/null byte/)
    })

    it('rejects values over the 4KB cap', () => {
        const big = 'x'.repeat(4 * 1024 + 1)
        expect(() => parseEnvFlag(`FOO=${big}`)).toThrowError(/exceeds 4096/)
    })
})

describe('parseFlags — --env', () => {
    it('returns env undefined when no --env was passed', () => {
        const flags = parseFlags(['--client=cursor'])
        expect(flags.env).toBeUndefined()
    })

    it('captures a single --env=KEY=VAL', () => {
        const flags = parseFlags(['--env=THINKFLEET_API_KEY=sk-abc'])
        expect(flags.env).toEqual({ THINKFLEET_API_KEY: 'sk-abc' })
    })

    it('captures multiple --env flags in order', () => {
        const flags = parseFlags([
            '--env=THINKFLEET_BASE_URL=https://app.thinkfleet.ai',
            '--env=THINKFLEET_PROJECT_ID=proj_test',
            '--env=THINKFLEET_API_KEY=sk-test',
        ])
        expect(flags.env).toEqual({
            THINKFLEET_BASE_URL: 'https://app.thinkfleet.ai',
            THINKFLEET_PROJECT_ID: 'proj_test',
            THINKFLEET_API_KEY: 'sk-test',
        })
    })

    it('lets a later --env override an earlier one and warns on stderr', () => {
        const warnings: string[] = []
        const flags = parseFlags(
            ['--env=THINKFLEET_API_KEY=sk-old', '--env=THINKFLEET_API_KEY=sk-new'],
            (l) => warnings.push(l),
        )
        expect(flags.env).toEqual({ THINKFLEET_API_KEY: 'sk-new' })
        expect(warnings.length).toBe(1)
        expect(warnings[0]).toContain('THINKFLEET_API_KEY')
        expect(warnings[0]).toContain('more than once')
    })

    it('warning lines NEVER contain the env values (secret-safe)', () => {
        const warnings: string[] = []
        parseFlags(
            ['--env=APIKEY=sk-very-secret-original', '--env=APIKEY=sk-equally-secret-replacement'],
            (l) => warnings.push(l),
        )
        const joined = warnings.join('\n')
        expect(joined).not.toContain('sk-very-secret-original')
        expect(joined).not.toContain('sk-equally-secret-replacement')
    })

    it('coexists with the other flags', () => {
        const flags = parseFlags([
            '--client=claude-code,cursor',
            '--env=A=1',
            '--name=thinkfleet',
            '--dry-run',
        ])
        expect(flags.client).toEqual(['claude-code', 'cursor'])
        expect(flags.env).toEqual({ A: '1' })
        expect(flags.name).toEqual(['thinkfleet'])
        expect(flags.dryRun).toBe(true)
    })

    it('throws (propagates parseEnvFlag error) on a malformed --env', () => {
        expect(() => parseFlags(['--env=NOEQ'])).toThrowError(/KEY=VALUE form/)
    })

    it('returns env as an empty object when --env was used but only empty-value pairs were supplied', () => {
        // Edge case: `--env=FLAG=` is legal and means "set FLAG to empty string".
        const flags = parseFlags(['--env=FLAG='])
        expect(flags.env).toEqual({ FLAG: '' })
    })
})

describe('buildEntryFromFlags', () => {
    it('uses the default command when --command is absent', () => {
        const flags = parseFlags([])
        const entry = buildEntryFromFlags(flags, { command: '/opt/agentmark/bin/agentmark-mcp' })
        expect(entry.command).toBe('/opt/agentmark/bin/agentmark-mcp')
        expect(entry.args).toEqual([])
        expect(entry.env).toBeUndefined()
    })

    it('honors --command when supplied', () => {
        const flags = parseFlags(['--command=/usr/local/bin/agentmark-mcp'])
        const entry = buildEntryFromFlags(flags, { command: '/should/not/be/used' })
        expect(entry.command).toBe('/usr/local/bin/agentmark-mcp')
    })

    it('populates entry.env from parsed flags', () => {
        const flags = parseFlags(['--env=A=1', '--env=B=2'])
        const entry = buildEntryFromFlags(flags, { command: '/opt/agentmark/bin/agentmark-mcp' })
        expect(entry.env).toEqual({ A: '1', B: '2' })
    })

    it('omits entry.env when no --env was supplied (clean JSON)', () => {
        const entry = buildEntryFromFlags(parseFlags([]), { command: '/x' })
        // Strict undefined — the writer's JSON serializer will skip it.
        expect(entry.env).toBeUndefined()
    })
})

/**
 * Tests for the per-AI-tool skill installer.
 *
 * Two coverage axes:
 *  1. `upsertManagedBlock` — pure marker-block replacement logic
 *     for rules-file clients (Cursor / Windsurf / Codex CLI in the
 *     future). Test thoroughly here so the file-mutation paths are
 *     trusted before we wire them up.
 *  2. `installSkill` end-to-end with a fake SkillTarget pointing at
 *     a tmp file — proves the write happens, idempotency holds, and
 *     dry-run is honored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    installSkill,
    upsertManagedBlock,
    MANAGED_BLOCK_START,
    MANAGED_BLOCK_END,
    type SkillTarget,
} from '../../src/mcp/install/skills'
import {
    THINKFLEET_MEMORY_SKILL,
    THINKFLEET_MEMORY_SKILL_NAME,
    getSkillContent,
} from '../../src/mcp/skills/thinkfleet-memory'

let tmp: string

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'agentmark-skill-'))
})

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
})

function fakeNativeTarget(id: string, fileName: string): SkillTarget {
    const dest = path.join(tmp, id, fileName)
    return {
        clientId: id,
        clientName: id,
        pathFor: () => dest,
        exclusive: true,
    }
}

function fakeRulesTarget(id: string, fileName: string): SkillTarget {
    return {
        clientId: id,
        clientName: id,
        pathFor: () => path.join(tmp, fileName),
        exclusive: false,
    }
}

describe('upsertManagedBlock', () => {
    const block = `${MANAGED_BLOCK_START}\nhello\n${MANAGED_BLOCK_END}\n`

    it('appends a block to empty text', () => {
        expect(upsertManagedBlock('', block)).toBe(block)
    })

    it('appends a block to text without a trailing newline', () => {
        const result = upsertManagedBlock('user notes', block)
        expect(result.startsWith('user notes\n\n')).toBe(true)
        expect(result.endsWith(block)).toBe(true)
    })

    it('separates the appended block with a blank line for readability', () => {
        // Both "no trailing newline" and "single trailing newline"
        // produce a blank line between user content and the managed
        // block — markdown looks cleaner with the visual break.
        const result = upsertManagedBlock('user notes\n', block)
        expect(result).toBe(`user notes\n\n${block}`)
    })

    it('replaces an existing managed block in place', () => {
        const original = `prefix\n${MANAGED_BLOCK_START}\nold\n${MANAGED_BLOCK_END}\nsuffix\n`
        const newBlock = `${MANAGED_BLOCK_START}\nnew\n${MANAGED_BLOCK_END}\n`
        expect(upsertManagedBlock(original, newBlock)).toBe(`prefix\n${newBlock}suffix\n`)
    })

    it('is idempotent — same block produces same output', () => {
        const original = `prefix\n${block}suffix\n`
        expect(upsertManagedBlock(original, block)).toBe(original)
    })

    it('does NOT touch text outside the managed block', () => {
        const userContent = '# my rules\n- do not use comments\n- prefer terse\n'
        const result = upsertManagedBlock(userContent, block)
        expect(result).toContain('do not use comments')
        expect(result).toContain('prefer terse')
        expect(result).toContain(MANAGED_BLOCK_START)
    })
})

describe('installSkill — native-skill targets (exclusive)', () => {
    it('writes the skill content to the target path on first run', async () => {
        const target = fakeNativeTarget('test-native', 'skill.md')
        const result = await installSkill({
            skillName: 'demo',
            content: 'hello world\n',
            targets: [target],
        })
        expect(result.ok).toBe(true)
        expect(result.clients[0].action).toBe('added')

        const dest = target.pathFor('demo')!
        expect(await readFile(dest, 'utf8')).toBe('hello world\n')
    })

    it('reports already_present on a second run with unchanged content', async () => {
        const target = fakeNativeTarget('test-native-idem', 'skill.md')
        const opts = { skillName: 'demo', content: 'same content\n', targets: [target] }
        await installSkill(opts)
        const second = await installSkill(opts)
        expect(second.clients[0].action).toBe('already_present')
    })

    it('reports updated when content changes', async () => {
        const target = fakeNativeTarget('test-native-up', 'skill.md')
        await installSkill({ skillName: 'demo', content: 'v1\n', targets: [target] })
        const second = await installSkill({ skillName: 'demo', content: 'v2\n', targets: [target] })
        expect(second.clients[0].action).toBe('updated')
        expect(await readFile(target.pathFor('demo')!, 'utf8')).toBe('v2\n')
    })

    it('honors dryRun — does not write', async () => {
        const target = fakeNativeTarget('test-native-dry', 'skill.md')
        const result = await installSkill({
            skillName: 'demo',
            content: 'should not land\n',
            targets: [target],
            dryRun: true,
        })
        expect(result.clients[0].action).toBe('added')
        await expect(readFile(target.pathFor('demo')!, 'utf8')).rejects.toThrow()
    })

    it('skips when the target returns null path (unsupported platform)', async () => {
        const target: SkillTarget = {
            clientId: 'unsupported',
            clientName: 'unsupported',
            pathFor: () => null,
            exclusive: true,
        }
        const result = await installSkill({
            skillName: 'demo',
            content: 'whatever\n',
            targets: [target],
        })
        expect(result.clients[0].action).toBe('skipped')
    })
})

describe('installSkill — rules-file targets (non-exclusive)', () => {
    it('appends a marker-wrapped block to an existing rules file', async () => {
        const target = fakeRulesTarget('cursor-fake', '.cursorrules')
        const dest = target.pathFor('demo')!
        await writeFile(dest, '# user rules\n- terse\n', 'utf8')

        const result = await installSkill({
            skillName: 'demo',
            content: 'agent prompt content\n',
            targets: [target],
        })
        expect(result.clients[0].action).toBe('added')

        const written = await readFile(dest, 'utf8')
        expect(written).toContain('# user rules')
        expect(written).toContain('- terse')
        expect(written).toContain(MANAGED_BLOCK_START)
        expect(written).toContain('agent prompt content')
        expect(written).toContain(MANAGED_BLOCK_END)
    })

    it('replaces just the marker block on update — user rules untouched', async () => {
        const target = fakeRulesTarget('cursor-fake-2', '.cursorrules')
        const dest = target.pathFor('demo')!
        await writeFile(dest, '# user rules\n- terse\n', 'utf8')

        await installSkill({ skillName: 'demo', content: 'v1 content\n', targets: [target] })
        await installSkill({ skillName: 'demo', content: 'v2 content\n', targets: [target] })

        const written = await readFile(dest, 'utf8')
        expect(written).toContain('- terse')           // user content preserved
        expect(written).toContain('v2 content')         // new block in
        expect(written).not.toContain('v1 content')     // old block out
    })
})

describe('built-in skill catalog', () => {
    it('exports the thinkfleet-memory skill with frontmatter', () => {
        const skill = getSkillContent(THINKFLEET_MEMORY_SKILL_NAME)
        expect(skill).not.toBeNull()
        expect(skill!.content).toBe(THINKFLEET_MEMORY_SKILL)
        // Must look like a skill (YAML frontmatter + markdown body).
        expect(skill!.content.startsWith('---\n')).toBe(true)
        expect(skill!.content).toContain('name: thinkfleet-memory')
        expect(skill!.content).toContain('# Using ThinkFleet Memory')
    })

    it('returns null for unknown skill names', () => {
        expect(getSkillContent('does-not-exist')).toBeNull()
    })

    it('skill catalog lists every tool the AI is expected to call', () => {
        const skill = getSkillContent(THINKFLEET_MEMORY_SKILL_NAME)!
        for (const tool of [
            'agentmark_memory_get',
            'agentmark_memory_set',
            'agentmark_memory_search',
            'agentmark_memory_list',
            'agentmark_memory_delete',
        ]) {
            expect(skill.content).toContain(tool)
        }
    })
})

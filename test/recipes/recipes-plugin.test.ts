/**
 * Tests for the Recipes Pack — substitution semantics, store CRUD,
 * dispatcher integration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import {
    createRecipesPlugin,
    RecipeStore,
    RECIPES_TOOLS,
    substitute,
    applyParameterSchema,
} from '../../src/plugins/recipes'
import { Dispatcher } from '../../src/mcp/plugin'

let tmp: string

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'agentmark-recipes-'))
})

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
})

function pluginAt(): ReturnType<typeof createRecipesPlugin> {
    return createRecipesPlugin({ storePath: path.join(tmp, 'recipes.json') })
}

describe('Recipes plugin — registration', () => {
    it('registers every tool with a matching handler', () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])
        expect(dispatcher.toolNames.sort()).toEqual(RECIPES_TOOLS.map((t) => t.name).sort())
    })

    it('exposes the v0 tool set', () => {
        expect(RECIPES_TOOLS.map((t) => t.name).sort()).toEqual([
            'agentmark_recipe_delete',
            'agentmark_recipe_get',
            'agentmark_recipe_list',
            'agentmark_recipe_save',
        ])
    })
})

describe('substitute — placeholder semantics', () => {
    it('replaces a bare token, preserving the param\'s native type', () => {
        const out = substitute('{{param.count}}', { count: 42 })
        expect(out).toBe(42)
    })

    it('embedded tokens always coerce to string', () => {
        const out = substitute('Hello, {{param.name}}! You have {{param.count}} items.', {
            name: 'Ryan',
            count: 3,
        })
        expect(out).toBe('Hello, Ryan! You have 3 items.')
    })

    it('recurses into nested objects + arrays', () => {
        const out = substitute(
            { to: ['{{param.email}}'], subject: 'Welcome, {{param.name}}', count: '{{param.count}}' },
            { email: 'a@b.com', name: 'Ryan', count: 7 },
        )
        expect(out).toEqual({
            to: ['a@b.com'],
            subject: 'Welcome, Ryan',
            count: 7,
        })
    })

    it('leaves unknown tokens verbatim by default', () => {
        const out = substitute('{{param.missing}}', {})
        expect(out).toBe('{{param.missing}}')
    })

    it('throws on unknown tokens when strict=true', () => {
        expect(() => substitute('{{param.missing}}', {}, { strict: true })).toThrow(/Unknown parameter/)
    })
})

describe('applyParameterSchema — validation + defaults', () => {
    it('fills in default values for omitted params', () => {
        const applied = applyParameterSchema(
            [{ name: 'rate', type: 'number', default: 200 }],
            {},
        )
        expect(applied.rate).toBe(200)
    })

    it('errors when a required param is missing', () => {
        expect(() =>
            applyParameterSchema(
                [{ name: 'name', type: 'string', required: true }],
                {},
            ),
        ).toThrow(/required/)
    })

    it('coerces "42" → 42 for number params', () => {
        const applied = applyParameterSchema(
            [{ name: 'rate', type: 'number' }],
            { rate: '42' },
        )
        expect(applied.rate).toBe(42)
    })

    it('rejects non-numeric strings for number params', () => {
        expect(() =>
            applyParameterSchema(
                [{ name: 'rate', type: 'number' }],
                { rate: 'banana' },
            ),
        ).toThrow(/must be a number/)
    })
})

describe('RecipeStore — durable CRUD', () => {
    it('save + get round-trip', async () => {
        const store = new RecipeStore({ path: path.join(tmp, 'recipes.json') })
        const saved = await store.save({
            name: 'add-customer',
            steps: [{ tool: 'agentmark_desktop_execute', args: { action_id: 'a' } }],
            version: 0,
            created_at: '',
            updated_at: '',
        })
        expect(saved.version).toBe(1)

        const got = await store.get('add-customer')
        expect(got?.name).toBe('add-customer')
        expect(got?.version).toBe(1)
    })

    it('save with on_conflict="fail" rejects duplicates', async () => {
        const store = new RecipeStore({ path: path.join(tmp, 'recipes.json') })
        const recipe = {
            name: 'dup',
            steps: [{ tool: 'x', args: {} }],
            version: 0,
            created_at: '',
            updated_at: '',
        }
        await store.save(recipe)
        await expect(store.save(recipe)).rejects.toThrow(/already exists/)
    })

    it('save with on_conflict="replace" bumps version', async () => {
        const store = new RecipeStore({ path: path.join(tmp, 'recipes.json') })
        const recipe = {
            name: 'evolving',
            steps: [{ tool: 'x', args: {} }],
            version: 0,
            created_at: '',
            updated_at: '',
        }
        const v1 = await store.save(recipe)
        const v2 = await store.save(recipe, { on_conflict: 'replace' })
        expect(v1.version).toBe(1)
        expect(v2.version).toBe(2)
    })

    it('list filters by target_app', async () => {
        const store = new RecipeStore({ path: path.join(tmp, 'recipes.json') })
        await store.save({ name: 'a', target_app: 'excel', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '' })
        await store.save({ name: 'b', target_app: 'word', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '' })
        await store.save({ name: 'c', target_app: 'excel', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '' })

        const excelOnly = await store.list({ target_app: 'excel' })
        expect(excelOnly.map((r) => r.name).sort()).toEqual(['a', 'c'])
    })

    it('delete returns whether the recipe existed', async () => {
        const store = new RecipeStore({ path: path.join(tmp, 'recipes.json') })
        await store.save({ name: 'tmp', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '' })
        expect(await store.delete('tmp')).toBe(true)
        expect(await store.delete('tmp')).toBe(false)
    })

    it('persists to disk so a fresh instance sees prior writes', async () => {
        const p = path.join(tmp, 'recipes.json')
        const a = new RecipeStore({ path: p })
        await a.save({ name: 'persistent', steps: [{ tool: 't', args: {} }], version: 0, created_at: '', updated_at: '' })

        const b = new RecipeStore({ path: p })
        expect((await b.get('persistent'))?.name).toBe('persistent')

        const onDisk = JSON.parse(await readFile(p, 'utf8'))
        expect(onDisk.version).toBe(1)
        expect(onDisk.recipes.persistent.name).toBe('persistent')
    })
})

describe('Recipes plugin — dispatched through the plugin', () => {
    it('save + get without params returns the raw recipe', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        const save = await dispatcher.dispatch('agentmark_recipe_save', {
            name: 'fill-form',
            description: 'Fill a single text field with a name',
            target_app: 'nowcerts',
            parameters: [{ name: 'customer_name', type: 'string', required: true }],
            steps: [
                {
                    tool: 'agentmark_desktop_execute',
                    args: { action_id: 'act_in_company', value: '{{param.customer_name}}' },
                },
            ],
        })
        expect(save.isError).toBeFalsy()
        const saved = JSON.parse(save.text)
        expect(saved.saved).toBe(true)
        expect(saved.version).toBe(1)

        const got = await dispatcher.dispatch('agentmark_recipe_get', { name: 'fill-form' })
        const body = JSON.parse(got.text)
        expect(body.resolved).toBe(false)
        // Placeholder still present.
        expect(body.recipe.steps[0].args.value).toBe('{{param.customer_name}}')
    })

    it('get with params resolves placeholders', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_recipe_save', {
            name: 'fill-form',
            parameters: [{ name: 'customer_name', type: 'string', required: true }],
            steps: [
                { tool: 'agentmark_desktop_execute', args: { action_id: 'act_in_company', value: '{{param.customer_name}}' } },
            ],
        })

        const got = await dispatcher.dispatch('agentmark_recipe_get', {
            name: 'fill-form',
            params: { customer_name: 'Globex Corp' },
        })
        const body = JSON.parse(got.text)
        expect(body.resolved).toBe(true)
        expect(body.steps[0].args.value).toBe('Globex Corp')
        expect(body.resolved_with).toEqual({ customer_name: 'Globex Corp' })
    })

    it('get errors when a required param is missing', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_recipe_save', {
            name: 'needs-name',
            parameters: [{ name: 'customer_name', type: 'string', required: true }],
            steps: [{ tool: 'x', args: {} }],
        })

        const got = await dispatcher.dispatch('agentmark_recipe_get', {
            name: 'needs-name',
            params: {},
        })
        expect(got.isError).toBe(true)
        expect(got.text).toMatch(/required/)
    })

    it('get errors on unknown recipe', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])
        const got = await dispatcher.dispatch('agentmark_recipe_get', { name: 'nope' })
        expect(got.isError).toBe(true)
        expect(got.text).toMatch(/Unknown recipe/)
    })

    it('list filters by target_app', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_recipe_save', {
            name: 'excel-a',
            target_app: 'excel',
            steps: [{ tool: 't', args: {} }],
        })
        await dispatcher.dispatch('agentmark_recipe_save', {
            name: 'word-a',
            target_app: 'word',
            steps: [{ tool: 't', args: {} }],
        })

        const listed = await dispatcher.dispatch('agentmark_recipe_list', { target_app: 'excel' })
        const body = JSON.parse(listed.text)
        expect(body.count).toBe(1)
        expect(body.recipes[0].name).toBe('excel-a')
    })

    it('delete + get-after-delete', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_recipe_save', { name: 'gone', steps: [{ tool: 't', args: {} }] })
        const del = await dispatcher.dispatch('agentmark_recipe_delete', { name: 'gone' })
        expect(JSON.parse(del.text).existed).toBe(true)

        const got = await dispatcher.dispatch('agentmark_recipe_get', { name: 'gone' })
        expect(got.isError).toBe(true)
    })

    it('save defaults to on_conflict="fail"', async () => {
        const plugin = pluginAt()
        const dispatcher = new Dispatcher([plugin])

        await dispatcher.dispatch('agentmark_recipe_save', { name: 'dup', steps: [{ tool: 't', args: {} }] })
        const second = await dispatcher.dispatch('agentmark_recipe_save', { name: 'dup', steps: [{ tool: 't', args: {} }] })
        expect(second.isError).toBe(true)
        expect(second.text).toMatch(/already exists/)
    })
})

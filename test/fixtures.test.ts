import { describe, it, expect } from 'vitest'
import { buildSnapshot } from '../src/converter'
import { serializeSnapshot, parseSnapshot } from '../src/serializers/yaml-frontmatter'
import { validateSnapshot } from '../src/validators/schema-validator'
import {
    articlePage,
    loginWall,
    checkoutForm,
    cloudflareBlocked,
    spaWithModal,
    cookieBannerPage,
} from './fixtures/page-patterns'

const fixtures = {
    article: articlePage,
    'login-wall': loginWall,
    'checkout-form': checkoutForm,
    'cloudflare-blocked': cloudflareBlocked,
    'spa-with-modal': spaWithModal,
    'cookie-banner': cookieBannerPage,
}

describe('fixture pipeline (extraction → snapshot → serialize → parse → validate)', () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
        it(`${name}: snapshot is valid`, () => {
            const snap = buildSnapshot(fixture)
            const v = validateSnapshot(snap)
            expect(v.valid, `${name} validation errors: ${JSON.stringify(v.errors)}`).toBe(true)
        })

        it(`${name}: round-trips through serialize/parse without loss`, () => {
            const snap = buildSnapshot(fixture)
            const text = serializeSnapshot(snap)
            const reparsed = parseSnapshot(text)

            expect(reparsed.url).toBe(snap.url)
            expect(reparsed.title).toBe(snap.title)
            expect(Object.keys(reparsed.actions ?? {}).sort()).toEqual(Object.keys(snap.actions ?? {}).sort())
        })

        it(`${name}: serialized form is parseable as valid YAML+MD`, () => {
            const snap = buildSnapshot(fixture)
            const text = serializeSnapshot(snap)
            expect(text).toMatch(/^---\n/)
            expect(text).toMatch(/\n---\n/)
            expect(text.length).toBeGreaterThan(50)
        })
    }
})

describe('fixture-specific assertions', () => {
    it('article: contains heading, paragraphs, and action references', () => {
        const snap = buildSnapshot(articlePage)
        expect(snap.body).toContain('# An Introduction to AI Agents')
        expect(snap.body).toContain('[ACTION:act_share]')
    })

    it('login wall: emits AUTH_WALL tag and auth_required hint', () => {
        const snap = buildSnapshot(loginWall)
        expect(snap.body).toContain('[AUTH_WALL]')
        expect(snap.actions?.act_login.auth_required).toBe('salesforce')
    })

    it('login wall: redacted password field is in actions but not body', () => {
        const snap = buildSnapshot(loginWall)
        expect(snap.actions?.act_password.label).toBe('(redacted)')
        // The body still has [INPUT:act_password] in this fixture; the
        // production extractor decides whether to emit honeypots/sensitive
        // refs in the body.
    })

    it('checkout form: financial submit has cost marker', () => {
        const snap = buildSnapshot(checkoutForm)
        expect(snap.actions?.act_submit.cost).toBe('financial')
    })

    it('checkout form: honeypot is in actions but not in body refs', () => {
        const snap = buildSnapshot(checkoutForm)
        expect(snap.actions?.act_addr2_honeypot.honeypot).toBe(true)
        expect(snap.body).not.toContain('act_addr2_honeypot')
    })

    it('cloudflare blocked: emits CHALLENGE tag', () => {
        const snap = buildSnapshot(cloudflareBlocked)
        expect(snap.body).toContain('[CHALLENGE:cloudflare]')
    })

    it('SPA with modal: state.modal_open is true', () => {
        const snap = buildSnapshot(spaWithModal)
        expect(snap.state?.modal_open).toBe(true)
    })

    it('SPA with modal: destructive cost on confirm action', () => {
        const snap = buildSnapshot(spaWithModal)
        expect(snap.actions?.act_confirm_delete.cost).toBe('destructive')
    })

    it('cookie banner: cookies.banner_present is true with banner_action_id', () => {
        const snap = buildSnapshot(cookieBannerPage)
        expect(snap.cookies?.banner_present).toBe(true)
        expect(snap.cookies?.banner_action_id).toBe('act_cookie_accept')
    })
})

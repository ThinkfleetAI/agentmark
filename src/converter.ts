import type { Page } from 'playwright'
import { AGENTMARK_VERSION, type Snapshot, type ConversionResult, type ActionDefinition, type MediaDefinition } from './types'
import { EXTRACTOR_SCRIPT, type RawExtraction, type RawAction } from './extractors/dom-extractor'
import { buildBody } from './extractors/body-builder'
import { serializeSnapshot } from './serializers/yaml-frontmatter'
import { waitForPageReady, type WaitOptions } from './wait/wait-strategy'
import { resolveChallenge, type ChallengeResolverOptions } from './wait/challenge-resolver'
import { InMemoryActionBinding } from './binding/action-binding'

export interface ConvertOptions {
    /** Wait strategy. Default: { mode: 'smart' } */
    wait?: WaitOptions | false
    /** Auto-dismiss cookie consent banners before extracting. Default: true */
    dismissCookieBanner?: boolean
    /** Auto-resolve anti-bot challenges (Cloudflare, reCAPTCHA, hCaptcha). Default: true */
    resolveChallenge?: boolean | ChallengeResolverOptions
    /** Set agentmark `source` field. Default: 'rendered' */
    source?: 'rendered' | 'declared' | 'hybrid'
    /** Set agentmark `expires_at`. Default: captured_at + 60s */
    ttlMs?: number
    /** Renderer capabilities to advertise. Default: all true except drag */
    capabilities?: Partial<Snapshot['capabilities']>
    /** Memory hints to attach (typically populated by host platform) */
    memory?: Snapshot['memory']
    /** Vendor extensions (`x-` prefixed fields) */
    vendorExtensions?: Record<string, unknown>
}

/**
 * Convert a live Playwright Page into an agentmark Snapshot + binding map.
 *
 * This is the primary public API of @thinkfleet/agentmark.
 *
 * The binding map is held both in this process (returned `binding`) and
 * inside the page context (`window.__agentmark.elements`). Renderers that
 * need to invoke an action by ID can use either:
 *   - host-side: pass the binding to your own resolver
 *   - browser-side: `await page.evaluate('window.__agentmark.elements.get("act_7")?.click()')`
 */
export async function convertPage(page: Page, options: ConvertOptions = {}): Promise<ConversionResult> {
    if (options.wait !== false) {
        await waitForPageReady(page, options.wait ?? {})
    }

    // Auto-resolve anti-bot challenges (Cloudflare, reCAPTCHA, hCaptcha).
    // Clicks "I am human" checkboxes, waits for JS challenges, optionally
    // uses AI vision for image CAPTCHAs.
    if (options.resolveChallenge !== false) {
        const challengeOpts = typeof options.resolveChallenge === 'object' ? options.resolveChallenge : {}
        await resolveChallenge(page, challengeOpts)
    }

    // Auto-dismiss cookie consent banners before extracting content.
    // This is transparent to the agent — it never sees the popup.
    if (options.dismissCookieBanner !== false) {
        await dismissCookieBanner(page)
    }

    const raw = await page.evaluate<RawExtraction>(EXTRACTOR_SCRIPT)

    const snapshot = buildSnapshot(raw, options)
    const text = serializeSnapshot(snapshot)

    // Mirror the browser-side binding map into a host-side binding for callers
    // that prefer to resolve IDs without re-evaluating in the page context.
    const binding = new InMemoryActionBinding()
    for (const id of Object.keys(raw.actions)) {
        binding.set(id, `window.__agentmark.elements.get(${JSON.stringify(id)})`)
    }

    return { agentmark: text, binding }
}

/**
 * Lower-level: convert a raw extraction into a Snapshot without serializing.
 * Useful when callers want to mutate the snapshot before emitting (e.g. add memory hints).
 */
export function buildSnapshot(raw: RawExtraction, options: ConvertOptions = {}): Snapshot {
    const captured_at = new Date().toISOString()
    const expires_at = new Date(Date.now() + (options.ttlMs ?? 60_000)).toISOString()

    const actions: Record<string, ActionDefinition> = {}
    for (const [id, raw_action] of Object.entries(raw.actions)) {
        actions[id] = mapAction(raw_action)
    }

    const media: Record<string, MediaDefinition> = {}
    for (const [id, raw_media] of Object.entries(raw.media)) {
        media[id] = {
            type: raw_media.type,
            alt: raw_media.alt,
            preview_url: raw_media.preview_url,
            width: raw_media.width,
            height: raw_media.height,
        }
    }

    const body = buildBody(raw.body_segments)

    const snapshot: Snapshot = {
        agentmark: AGENTMARK_VERSION,
        url: raw.url,
        title: raw.title || '(untitled)',
        captured_at,
        expires_at,
        source: options.source ?? 'rendered',
        language: raw.language ?? undefined,
        direction: raw.direction === 'rtl' ? 'rtl' : 'ltr',
        state: {
            loading: raw.state.loading,
            modal_open: raw.state.modal_open,
            ssl: raw.state.ssl,
        },
        actions: Object.keys(actions).length > 0 ? actions : undefined,
        media: Object.keys(media).length > 0 ? media : undefined,
        memory: options.memory,
        capabilities: {
            preview_media: true,
            expand_disclosures: true,
            paginate: false,
            scroll: true,
            keyboard: true,
            drag: false,
            ocr: false,
            vision: true,
            ...options.capabilities,
        },
        cookies: raw.cookies.banner_present
            ? { banner_present: true, banner_action_id: raw.cookies.banner_action_id }
            : undefined,
        body,
    }

    if (options.vendorExtensions) {
        for (const [k, v] of Object.entries(options.vendorExtensions)) {
            if (k.startsWith('x-')) (snapshot as unknown as Record<string, unknown>)[k] = v
        }
    }

    return snapshot
}

function mapAction(raw: RawAction): ActionDefinition {
    return {
        type: raw.type as ActionDefinition['type'],
        label: raw.label,
        description: raw.description,
        disabled: raw.disabled || undefined,
        disabled_reason: raw.disabled_reason,
        required: raw.required || undefined,
        read_only: raw.read_only || undefined,
        validation: raw.validation,
        value: raw.value,
        placeholder: raw.placeholder,
        options: raw.options,
        min: raw.min,
        max: raw.max,
        step: raw.step,
        target: raw.target,
        cost: raw.cost,
        auth_required: raw.auth_required,
        aria: raw.aria,
        region_id: raw.region_id,
        honeypot: raw.honeypot,
    }
}

/**
 * Auto-dismiss cookie consent banners.
 *
 * Strategy (cascading — first match wins):
 *   1. Known banner libraries (OneTrust, Cookiebot, etc.)
 *   2. Generic: find a dialog/banner with "cookie" in its attributes,
 *      then click the first button inside it that contains "accept" or "agree"
 *   3. Common accept button patterns (e.g. "Accept All", "I Agree")
 *
 * Best-effort — if nothing matches, silently continues. The worst case is
 * the agent sees the banner + its accept button as an agentmark action.
 */
async function dismissCookieBanner(page: Page): Promise<void> {
    const dismissed = await page.evaluate(`(() => {
        // Known banner accept selectors (most specific first)
        const knownSelectors = [
            // OneTrust
            '#onetrust-accept-btn-handler',
            // Cookiebot
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
            '#CybotCookiebotDialogBodyButtonAccept',
            // Quantcast / GDPR consent
            '.qc-cmp2-summary-buttons button[mode="primary"]',
            // Osano
            '.osano-cm-accept-all',
            // Didomi
            '#didomi-notice-agree-button',
            // Cookie Notice plugin
            '.cookie-notice-container .cn-accept-cookie',
            // Iubenda
            '.iubenda-cs-accept-btn',
        ];

        for (var sel of knownSelectors) {
            var btn = document.querySelector(sel);
            if (btn) { btn.click(); return 'known:' + sel; }
        }

        // Generic: find a cookie-related dialog and click its accept button
        var dialogSelectors = [
            '[id*="cookie" i][role="dialog"]',
            '[class*="cookie" i][class*="banner" i]',
            '[class*="cookie" i][class*="consent" i]',
            '[class*="gdpr" i]',
            '[class*="privacy" i][class*="banner" i]',
        ];
        for (var dSel of dialogSelectors) {
            var dialog = document.querySelector(dSel);
            if (!dialog) continue;
            var buttons = dialog.querySelectorAll('button, a[role="button"], [class*="accept" i]');
            for (var b of buttons) {
                var text = (b.textContent || '').toLowerCase().trim();
                if (/accept|agree|allow|got it|ok|consent|continue/i.test(text)) {
                    b.click();
                    return 'generic:' + text;
                }
            }
        }

        // Last resort: look for any visible button with accept/agree text
        var allButtons = document.querySelectorAll('button, a[role="button"]');
        for (var ab of allButtons) {
            var t = (ab.textContent || '').toLowerCase().trim();
            if (/^(accept all|accept cookies|accept|i agree|agree|allow all|got it|ok)$/i.test(t)) {
                var rect = ab.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    ab.click();
                    return 'fallback:' + t;
                }
            }
        }

        return null;
    })()`) as string | null

    if (dismissed) {
        // Wait briefly for the banner to animate out
        await page.waitForTimeout(500).catch(() => {})
    }
}

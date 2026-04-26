/**
 * Browser-side DOM extraction logic.
 *
 * This entire module runs inside the page context via Page.evaluate().
 * It walks the DOM, identifies semantic content + interactive elements,
 * assigns action IDs, and stashes a binding map on `window.__agentmark`
 * for later resolution by the renderer.
 *
 * The extractor returns a serializable result that the host (Node side)
 * uses to build a Snapshot.
 */

export interface RawExtraction {
    title: string
    url: string
    language: string | null
    direction: 'ltr' | 'rtl'
    state: {
        loading: boolean
        modal_open: boolean
        ssl: 'valid' | 'invalid' | 'mixed' | 'none'
    }
    actions: Record<string, RawAction>
    media: Record<string, RawMedia>
    body_segments: BodySegment[]
    cookies: { banner_present: boolean; banner_action_id?: string }
}

export interface RawAction {
    type: string
    label: string
    description?: string
    disabled: boolean
    disabled_reason?: string
    required?: boolean
    read_only?: boolean
    validation?: string
    value?: unknown
    placeholder?: string
    options?: unknown[]
    min?: number
    max?: number
    step?: number
    target?: string
    cost?: 'free' | 'destructive' | 'financial'
    auth_required?: string
    aria?: { expanded?: boolean; pressed?: boolean; checked?: boolean | 'mixed'; selected?: boolean }
    region_id?: string
    honeypot?: boolean
}

export interface RawMedia {
    type: 'image' | 'video' | 'audio'
    alt?: string
    preview_url?: string
    width?: number
    height?: number
}

export type BodySegment =
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'paragraph'; text: string }
    | { kind: 'list'; ordered: boolean; items: string[] }
    | { kind: 'tag'; tag: string; ref?: string }
    | { kind: 'separator' }

/**
 * The browser-side extractor function, as a string. We pass this to
 * Page.evaluate() because Playwright requires functions/strings for evaluation.
 *
 * The script:
 *  1. Initializes window.__agentmark (binding map + counter)
 *  2. Walks the document body extracting content + interactive elements
 *  3. Assigns each interactive element a stable ID + stashes its DOM ref
 *  4. Returns the RawExtraction result
 *
 * The script is intentionally kept as one self-contained string to avoid
 * any dependency on Playwright's auto-bundling.
 */
export const EXTRACTOR_SCRIPT = `
(() => {
    // Reset binding state on each call. Action IDs are snapshot-scoped.
    if (!window.__agentmark) {
        window.__agentmark = { elements: new Map(), counter: 0 };
    } else {
        window.__agentmark.elements.clear();
        window.__agentmark.counter = 0;
    }

    const state = window.__agentmark;

    // ────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────

    const SENSITIVE_NAMES = /token|secret|key|csrf|session|auth|password|pwd|ssn|credit.?card/i;
    const SENSITIVE_TYPES = new Set(['password', 'hidden']);

    function nextId(prefix) {
        state.counter += 1;
        return prefix + '_' + state.counter;
    }

    function bindElement(prefix, el) {
        const id = nextId(prefix);
        state.elements.set(id, el);
        return id;
    }

    function getAccessibleName(el) {
        // Order: aria-labelledby > aria-label > label[for] > value > placeholder > textContent
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const ids = labelledBy.split(/\\s+/);
            const text = ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
            if (text) return text.slice(0, 256);
        }
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.slice(0, 256);
        if (el.id) {
            const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (labelEl?.textContent) return labelEl.textContent.trim().slice(0, 256);
        }
        const wrappingLabel = el.closest('label');
        if (wrappingLabel?.textContent) {
            const text = Array.from(wrappingLabel.childNodes)
                .filter(n => n !== el && n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent).join(' ').trim();
            if (text) return text.slice(0, 256);
        }
        if (el.value && (el.tagName === 'BUTTON' || el.type === 'submit' || el.type === 'button')) {
            return el.value.slice(0, 256);
        }
        if (el.placeholder) return el.placeholder.slice(0, 256);
        const txt = (el.textContent || '').trim();
        if (txt) return txt.slice(0, 256);
        return '';
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    function isHoneypot(input) {
        const type = (input.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden') return false;  // hidden is handled separately
        const name = input.getAttribute('name') || '';
        if (!isVisible(input)) {
            // Visually hidden but not type=hidden — strong signal
            if (/honey|bot|trap|address_2|email_confirm|phone2/i.test(name)) return true;
            return true;
        }
        return false;
    }

    function inferAriaState(el) {
        const aria = {};
        const expanded = el.getAttribute('aria-expanded');
        if (expanded != null) aria.expanded = expanded === 'true';
        const pressed = el.getAttribute('aria-pressed');
        if (pressed != null) aria.pressed = pressed === 'true';
        const checked = el.getAttribute('aria-checked');
        if (checked != null) aria.checked = checked === 'mixed' ? 'mixed' : checked === 'true';
        const selected = el.getAttribute('aria-selected');
        if (selected != null) aria.selected = selected === 'true';
        return Object.keys(aria).length > 0 ? aria : undefined;
    }

    function inferCost(el, label) {
        const text = (label || '').toLowerCase();
        if (/delete|remove|destroy|cancel subscription|close account/.test(text)) return 'destructive';
        if (/pay|buy|purchase|checkout|subscribe|charge|donate/.test(text)) return 'financial';
        return undefined;
    }

    function inferAuthRequired(el) {
        const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        if (/sign in with google|continue with google/.test(text)) return 'google';
        if (/sign in with microsoft|sign in with office/.test(text)) return 'microsoft';
        if (/sign in with github/.test(text)) return 'github';
        if (/sign in with slack/.test(text)) return 'slack';
        if (/sign in with apple/.test(text)) return 'apple';
        if (/sign in with facebook/.test(text)) return 'facebook';
        if (/sign in with linkedin/.test(text)) return 'linkedin';
        return undefined;
    }

    function inferValidation(input) {
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        if (type === 'email') return 'email';
        if (type === 'tel') return 'tel';
        if (type === 'url') return 'url';
        if (type === 'number') return 'number';
        if (type === 'date') return 'date';
        if (type === 'time') return 'time';
        if (type === 'datetime-local') return 'datetime';
        const pattern = input.getAttribute('pattern');
        if (pattern) return 'regex:' + pattern;
        const minLen = input.getAttribute('minlength');
        const maxLen = input.getAttribute('maxlength');
        if (minLen || maxLen) return 'length:' + (minLen || '0') + ':' + (maxLen || '*');
        return undefined;
    }

    function classifyInput(input) {
        const tag = input.tagName.toLowerCase();
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        if (tag === 'select') return input.multiple ? 'multi_select' : 'select';
        if (tag === 'textarea') return 'type';
        if (type === 'checkbox' || type === 'radio') return 'check';
        if (type === 'date') return 'date';
        if (type === 'time') return 'time';
        if (type === 'datetime-local') return 'datetime';
        if (type === 'range') return 'range';
        if (type === 'color') return 'color';
        if (type === 'file') return 'upload';
        if (type === 'submit' || type === 'button') return 'click';
        return 'type';
    }

    // ────────────────────────────────────────────────
    // Auth wall + challenge detection
    // ────────────────────────────────────────────────

    const url = location.href;
    const isLoginUrl = /\\/(login|signin|sign-in|auth|sso)(\\/|\\?|#|$)/i.test(url);
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    const interactiveCount = document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea').length;
    const looksLikeAuthWall = (passwordInputs.length > 0 && interactiveCount < 8) || isLoginUrl;

    const cloudflareChallenge = document.title.includes('Just a moment') || document.querySelector('[id*="cf-"]');
    const recaptcha = document.querySelector('iframe[src*="recaptcha"]');
    const hcaptcha = document.querySelector('iframe[src*="hcaptcha"]');

    const challenges = [];
    if (cloudflareChallenge) challenges.push('cloudflare');
    if (recaptcha) challenges.push('recaptcha');
    if (hcaptcha) challenges.push('hcaptcha');

    // ────────────────────────────────────────────────
    // Cookie banner detection
    // ────────────────────────────────────────────────

    let cookieBanner = null;
    const cookieSelectors = [
        '[id*="cookie" i][role="dialog"]',
        '[class*="cookie" i][class*="banner" i]',
        '[class*="cookie" i][class*="consent" i]',
        '[id*="onetrust"]',
        '[id*="cookiebot"]',
    ];
    for (const sel of cookieSelectors) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) { cookieBanner = el; break; }
    }
    let cookieBannerActionId;
    if (cookieBanner) {
        const accept = cookieBanner.querySelector('button');
        if (accept) cookieBannerActionId = bindElement('act', accept);
    }

    // ────────────────────────────────────────────────
    // Walk DOM
    // ────────────────────────────────────────────────

    const actions = {};
    const media = {};
    const segments = [];

    function emitHeading(el, level) {
        const text = (el.textContent || '').trim().slice(0, 512);
        if (text) segments.push({ kind: 'heading', level: level, text: text });
    }

    function emitParagraph(text) {
        const t = text.trim();
        if (t) segments.push({ kind: 'paragraph', text: t.slice(0, 4000) });
    }

    function emitList(el, ordered) {
        const items = Array.from(el.querySelectorAll(':scope > li'))
            .map(li => (li.textContent || '').trim().slice(0, 512))
            .filter(t => t.length > 0)
            .slice(0, 100);
        if (items.length > 0) segments.push({ kind: 'list', ordered: ordered, items: items });
    }

    function emitTag(tag, ref) {
        segments.push({ kind: 'tag', tag: tag, ref: ref });
    }

    function emitIframe(el) {
        var src = el.getAttribute('src') || '';
        var title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
        var id = nextId('frame');
        // Treat iframes like media for the binding/registry — the
        // host can later resolve them into action targets via Frame
        // dispatch in the runner.
        media[id] = {
            type: 'image',  // best fit in current type vocab; spec extension TBD
            alt: title || src.slice(0, 200),
            preview_url: src || undefined,
        };
        // Attempt same-origin walk. cross-origin throws SecurityError
        // and we fall through to emitting just the tag reference.
        var inlineWalked = false;
        try {
            if (el.contentDocument && el.contentDocument.body) {
                var doc = el.contentDocument;
                emitTag('IFRAME_OPEN', id);
                if (title) emitParagraph('Iframe: ' + title);
                else if (src) emitParagraph('Iframe: ' + src);
                for (var c of Array.from(doc.body.children)) {
                    processNode(c);
                }
                emitTag('IFRAME_CLOSE', id);
                inlineWalked = true;
            }
        }
        catch (_e) {
            // Cross-origin — script can't pierce. Fall through.
        }
        if (!inlineWalked) {
            emitTag('IFRAME', id);
            if (title) emitParagraph('Cross-origin iframe: ' + title + (src ? ' (' + src + ')' : ''));
            else if (src) emitParagraph('Cross-origin iframe: ' + src);
        }
    }

    if (cookieBannerActionId) {
        emitTag('ACTION', cookieBannerActionId);
    }

    if (challenges.length > 0) {
        emitTag('CHALLENGE', challenges[0]);
    } else if (looksLikeAuthWall) {
        emitTag('AUTH_WALL');
    }

    function processNode(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node;
        const tag = el.tagName.toLowerCase();

        // Skip invisible, scripts, styles, etc.
        if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;

        // Shadow DOM piercing. Modern web components (Salesforce
        // Lightning, MS 365, every-Lit-app, custom elements) hide
        // their interactive content behind a shadow root. Without
        // piercing them the LLM sees an empty <my-button> with no
        // text or actions. We only get OPEN shadow roots — closed
        // ones are intentionally inaccessible to scripts (browser
        // limitation, not fixable). Process before tag-specific
        // handling so shadow content gets an action ID even if the
        // host element is also tagged.
        if (el.shadowRoot) {
            for (const sChild of Array.from(el.shadowRoot.children)) {
                processNode(sChild);
            }
        }

        // Headings
        if (/^h[1-6]$/.test(tag)) {
            emitHeading(el, parseInt(tag[1], 10));
            return;
        }

        // Lists
        if (tag === 'ul' || tag === 'ol') {
            emitList(el, tag === 'ol');
            return;
        }

        // Interactive: button, link, input, select, textarea
        if (tag === 'button' || (tag === 'input' && (el.type === 'submit' || el.type === 'button'))) {
            const label = getAccessibleName(el);
            if (!label && !el.querySelector('img')) return;  // skip empty no-text buttons
            const id = bindElement('act', el);
            actions[id] = {
                type: 'click',
                label: label || '(button)',
                disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
                aria: inferAriaState(el),
                cost: inferCost(el, label),
                auth_required: inferAuthRequired(el),
            };
            emitTag('ACTION', id);
            return;
        }

        if (tag === 'a' && el.href) {
            const label = getAccessibleName(el);
            const id = bindElement('act', el);
            actions[id] = {
                type: 'nav',
                label: label || el.href,
                target: el.href,
                disabled: false,
                aria: inferAriaState(el),
            };
            emitTag('NAV', id);
            return;
        }

        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const inputType = (el.getAttribute('type') || '').toLowerCase();
            // Skip sensitive: emit a redaction marker action so agent knows it's there
            if (SENSITIVE_TYPES.has(inputType) || SENSITIVE_NAMES.test(el.name || '')) {
                const id = bindElement('act', el);
                actions[id] = {
                    type: classifyInput(el),
                    label: '(redacted)',
                    description: 'Sensitive field — content not exposed to agent. Type: ' + inputType,
                    required: el.required === true,
                    aria: inferAriaState(el),
                };
                emitTag('INPUT', id);
                return;
            }

            const id = bindElement('act', el);
            const honeypot = isHoneypot(el);
            const action = {
                type: classifyInput(el),
                label: getAccessibleName(el) || '(input)',
                disabled: el.disabled === true,
                required: el.required === true,
                read_only: el.readOnly === true,
                placeholder: el.placeholder || undefined,
                value: el.value || undefined,
                validation: inferValidation(el),
                aria: inferAriaState(el),
                honeypot: honeypot || undefined,
            };
            if (tag === 'select') {
                action.options = Array.from(el.options).map(o => o.value);
                action.value = el.value;
            }
            const min = el.getAttribute('min');
            const max = el.getAttribute('max');
            const step = el.getAttribute('step');
            if (min) action.min = Number(min);
            if (max) action.max = Number(max);
            if (step) action.step = Number(step);

            actions[id] = action;
            if (!honeypot) emitTag('INPUT', id);
            return;
        }

        // Iframes. Two strategies:
        //   1. Same-origin: walk contentDocument.body inline so the LLM
        //      sees iframe content as if part of the parent page.
        //      Many embedded forms / docs / maps fit this case.
        //   2. Cross-origin: contentDocument access throws; fall back
        //      to emitting an IFRAME tag with the src URL so the LLM
        //      at least knows the iframe is there. Clicking elements
        //      inside cross-origin iframes requires runner-side
        //      frame-aware dispatch — a separate change.
        if (tag === 'iframe' || tag === 'frame') {
            emitIframe(el);
            return;
        }

        // Images
        if (tag === 'img') {
            const id = nextId('img');
            media[id] = {
                type: 'image',
                alt: el.alt || '',
                preview_url: el.src || undefined,
                width: el.naturalWidth || el.width || undefined,
                height: el.naturalHeight || el.height || undefined,
            };
            if (el.alt && el.alt.trim()) emitTag('MEDIA', id);
            return;
        }

        // Paragraphs — recurse into children first to extract any interactive
        // elements (links, buttons), then emit the remaining text content.
        if (tag === 'p') {
            var hasInteractive = el.querySelector('a, button, input, select, textarea');
            if (hasInteractive) {
                for (var ci of Array.from(el.children)) { processNode(ci); }
                // Emit any remaining text that wasn't captured by child handlers
                var pureText = Array.from(el.childNodes)
                    .filter(function(n) { return n.nodeType === Node.TEXT_NODE; })
                    .map(function(n) { return n.textContent; })
                    .join(' ').trim();
                if (pureText) emitParagraph(pureText);
            } else {
                emitParagraph(el.textContent || '');
            }
            return;
        }

        // Generic container — recurse
        for (const child of Array.from(el.children)) {
            processNode(child);
        }
    }

    for (const child of Array.from(document.body.children)) {
        processNode(child);
    }

    return {
        title: document.title,
        url: location.href,
        language: document.documentElement.lang || null,
        direction: getComputedStyle(document.documentElement).direction || 'ltr',
        state: {
            loading: document.readyState !== 'complete',
            modal_open: !!document.querySelector('[role="dialog"][aria-modal="true"]'),
            ssl: location.protocol === 'https:' ? 'valid' : 'none',
        },
        actions: actions,
        media: media,
        body_segments: segments,
        cookies: {
            banner_present: !!cookieBanner,
            banner_action_id: cookieBannerActionId,
        },
    };
})()
`

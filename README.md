# @thinkfleet/agentmark

Reference implementation of the **agentmark** spec — a wire format for representing live web pages to AI agents.

> **Spec:** [agentmark v0.1](../../docs/specs/agentmark-v0.1.md)
> **License:** MIT (this package) / CC0 (the spec)

---

## What is agentmark?

agentmark is **Markdown with an envelope and a small action vocabulary.** It's designed as an AI-friendly alternative to feeding LLMs raw HTML or DOM snapshots. Pages become 5-10x smaller, agents read them natively, and every interactive element is referenced by a stable ID — no CSS selectors leak to the model.

```yaml
---
agentmark: "0.1"
url: "https://acme.com/pricing"
title: "Acme — Pricing"
state:
  auth: logged_out
actions:
  act_pro:
    type: click
    label: "Choose Pro"
    cost: financial
    confirms: true
  act_email:
    type: type
    label: "Email"
    required: true
    validation: email
---

# Acme Pricing

## Pro Plan — $29/mo
[ACTION:act_pro]

## Get a demo
[INPUT:act_email]
```

## Install

```bash
npm install @thinkfleet/agentmark playwright-core
npx playwright-core install chromium    # one-time browser install
```

`playwright-core` is a peer dependency. AgentMark wraps a Playwright `Browser`
under the hood and exposes a small SDK that any AI (Claude, GPT, your own
agent loop) can drive.

## Quick Start — drive a real page

```ts
import { createBrowser } from '@thinkfleet/agentmark'

const browser = await createBrowser({ launch: { headless: true } })
const page = await browser.newPage()
await page.goto('https://example.com/login')

// Capture a compact AgentMark snapshot — pipe to any LLM
const snap = await page.snapshot()
console.log(snap.agentmark)

// LLM (or you) picks an action ID from the snapshot
await page.execute('act_email', 'user@example.com')
await page.execute('act_password', 'hunter2')
await page.execute('act_submit')

await browser.saveSession('./session.json')   // persist cookies + storage
await browser.close()

// Later — resume the same authenticated session
const browser2 = await createBrowser({ sessionPath: './session.json' })
```

That's the whole API. AgentMark itself is **library-only** — no agent loop,
no LLM client, no prompts. The caller (you, Claude, GPT, an Activepieces
flow, etc.) brings the loop. AgentMark just exposes great browser primitives.

## Why AgentMark

- **5–10× smaller than raw HTML.** Pages become compact markdown with a
  small action vocabulary. Cheaper to send to LLMs, faster to read.
- **Stable action IDs.** Refs survive layout shifts and re-renders — no
  CSS selectors leaking into prompts that break next week.
- **Sensitive fields auto-redacted.** Password/token/SSN inputs are
  marked `(redacted)` in the snapshot. Values never reach the LLM.
- **Cookie banners and anti-bot challenges handled.** OneTrust, Cookiebot,
  Cloudflare, reCAPTCHA, hCaptcha auto-resolved before snapshot.
- **Library, not a framework.** Bring your own model, prompts, and loop.

## Lower-level APIs

For callers who want direct control over conversion or want to feed AgentMark
into a custom Playwright pipeline:

### Serialize a Snapshot

```ts
import { serializeSnapshot, type Snapshot } from '@thinkfleet/agentmark'

const snapshot: Snapshot = {
    agentmark: '0.1',
    url: 'https://example.com/',
    title: 'Example',
    actions: { act_login: { type: 'click', label: 'Log In' } },
    body: '# Welcome\n\n[ACTION:act_login]',
}

const text = serializeSnapshot(snapshot)
```

### Parse + Validate

```ts
import { parseSnapshot, validateSnapshot } from '@thinkfleet/agentmark'

const snapshot = parseSnapshot(text)
const result = validateSnapshot(snapshot)
if (!result.valid) {
    console.error(result.errors)
}
```

### Convert to JSON (developer escape hatch)

```ts
import { convertToJson } from '@thinkfleet/agentmark'

const { snapshot, body_nodes } = convertToJson(text)
```

## Observability

Pass a logger to see structured events. Default is silent.

```ts
import { createBrowser, consoleLogger } from '@thinkfleet/agentmark'

const browser = await createBrowser({ logger: consoleLogger })
// Emits JSON lines: navigation.start / navigation.complete /
// snapshot.captured / action.execute.complete / session.saved / etc.
```

## Error handling

All AgentMark errors extend `AgentMarkError` and carry stable `code` strings.

```ts
import {
    isAgentMarkError,
    ActionNotFoundError,
    ActionDisabledError,
    ElementNotFoundError,
    ExecutionTimeoutError,
} from '@thinkfleet/agentmark'

try {
    await page.execute('act_submit')
} catch (err) {
    if (err instanceof ActionDisabledError) { /* button is disabled */ }
    else if (err instanceof ElementNotFoundError) { /* snapshot stale */ }
    else if (err instanceof ExecutionTimeoutError) { /* page hung */ }
    else if (isAgentMarkError(err)) { console.error(err.code, err.message) }
}
```

## Status

- **v0.3.0** — first production-ready release. Stable SDK surface; backwards
  compatible upgrades thereafter. Spec extension to v0.2 (PDF + form support)
  in active development.

See [CHANGELOG.md](./CHANGELOG.md) for full release notes.

## License

MIT for this package. The agentmark spec is released under CC0 (public domain).

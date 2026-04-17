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
npm install @thinkfleet/agentmark
```

`playwright` is a peer dependency (the converter operates on a Playwright `Page`).

## Quick Start

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
// → "---\nagentmark: \"0.1\"\nurl: \"https://example.com/\"\n...\n---\n\n# Welcome\n\n[ACTION:act_login]\n"
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
// snapshot — full envelope + body
// body_nodes — pre-tokenized [{kind: 'text'} | {kind: 'tag', tag, ref}]
```

## Status

- **v0.1** — draft, unstable. Breaking changes possible until v1.0.
- Reference DOM converter (Playwright Page → agentmark) is in active development.

## License

MIT for this package. The agentmark spec is released under CC0 (public domain).

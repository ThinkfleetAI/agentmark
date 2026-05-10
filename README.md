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

## PDFs (v0.4+)

The same wire format works for PDFs. `convertPdf()` produces a `kind: 'document'` snapshot with `[PAGE:p_n]` markers between pages.

```ts
import { readFile } from 'node:fs/promises'
import { convertPdf } from '@thinkfleet/agentmark'

const data = await readFile('./report.pdf')
const { agentmark } = await convertPdf({
    data,
    sourceUrl: 'file:///abs/path/report.pdf',
})

console.log(agentmark)
// ---
// agentmark: "0.2"
// kind: document
// url: "file:///abs/path/report.pdf"
// title: "Annual Report 2025"
// document:
//   pages: 47
//   author: "Acme Inc."
//   format: pdf
//   format_version: "1.7"
//   ocr_used: false
// ---
//
// [PAGE:p_1]
//
// # Annual Report 2025
// ...
```

PDF support is opt-in via the optional peer dependency:

```bash
npm install pdfjs-dist@^4
```

If `pdfjs-dist` is missing, `convertPdf()` throws a `SnapshotError` with install instructions. Heading detection uses font-size + bold-font-name heuristics (configurable via `headingThreshold`); bullet and ordered lists auto-detect.

### Fillable PDF forms (v0.6+)

When a PDF contains AcroForm fields (most fillable government and business forms), AgentMark sets `kind: 'form'` on the snapshot and exposes each field as an action. Use the stateful `PdfDocument` SDK class to fill and save:

```ts
import { openPdfDocument } from '@thinkfleet/agentmark'

const data = await readFile('./vendor-application.pdf')
const doc = await openPdfDocument({ data, sourceUrl: 'file:///vendor.pdf' })

const snap = await doc.snapshot()
console.log(snap.snapshot.kind)  // 'form'
console.log(Object.keys(snap.snapshot.actions ?? {}))

// Fill fields. Same execute() shape as the web Page SDK.
await doc.execute('act_field_1', 'Acme Inc.')
await doc.execute('act_field_2', true)            // checkbox
await doc.execute('act_field_3', 'NC')            // dropdown
await doc.execute('act_field_4', ['English', 'Spanish'])  // multi-select

// Save the filled PDF as new bytes.
const filled = await doc.save()
await writeFile('./vendor-application-filled.pdf', filled)

// Or flatten — bake values into the page content; no longer fillable.
const flattened = await doc.save({ flatten: true })

await doc.close()
```

Field handling:

| AcroForm type | AgentMark action | Notes |
|---|---|---|
| Text (single + multi-line) | `type: 'type'` | Sensitive names auto-redacted (password, ssn, credit_card, etc.) |
| Checkbox | `type: 'check'` | Boolean |
| Radio group | `type: 'select'` | Options from PDF |
| Dropdown | `type: 'select'` | Options from PDF |
| Listbox (single / multi) | `type: 'select'` / `'multi_select'` | |
| Signature | `type: 'click'` (disabled) | Refused — agents can't sign |
| Push button | `type: 'click'` | |

Required fields, read-only fields, and PDF field flags (read from page annotations) all surface in the resulting `ActionDefinition`.

PDF form filling is opt-in via the optional peer dependency:

```bash
npm install pdf-lib
```

If `pdf-lib` is missing, `doc.save()` throws a `SnapshotError` with install instructions — `doc.snapshot()` and `doc.execute()` still work without it (fields are read via pdfjs-dist).

### OCR for scanned and "Print To PDF" documents (v0.5+)

Many real-world PDFs have no extractable text — scanner output, "Microsoft Print To PDF" exports, etc. AgentMark ships pluggable OCR + render backends to handle these. Two of each are bundled; bring your own (AWS Textract, Google Document AI, Apple Vision Framework) by implementing the `OcrBackend` / `RenderBackend` interfaces.

```ts
import {
    convertPdf,
    PopplerRenderBackend,
    TesseractOcrBackend,
} from '@thinkfleet/agentmark'

const { agentmark } = await convertPdf({
    data,
    sourceUrl: 'file:///tmp/scanned.pdf',
    ocr: {
        render: new PopplerRenderBackend(),       // pdftoppm-based rasterization
        ocr:    new TesseractOcrBackend(),        // in-process WASM OCR
        mode: 'auto',  // OCR only pages with no extractable text (default)
    },
})
```

**Bundled render backends:**

| Backend | Install | When to use |
|---|---|---|
| `PopplerRenderBackend` | `brew install poppler` (macOS) / `apt-get install poppler-utils` | Lightest. No native node modules. |
| `PdfjsRenderBackend` | `npm install canvas` | Pure-Node, no system deps. Heavier install. |

**Bundled OCR backends:**

| Backend | Install | Cost | Quality |
|---|---|---|---|
| `TesseractOcrBackend` | `npm install tesseract.js@^5` | Free | Decent on clean text |
| `MistralOcrBackend` | (none — uses `fetch`) | ~$1/1k pages | Excellent, layout-aware |

OCR modes:
- `'auto'` (default) — OCR only pages with no extractable text. Mixed text+image PDFs handled correctly.
- `'always'` — OCR every page (overrides any extracted text).
- `'never'` — disable OCR. Same as omitting `ocr` from `convertPdf`.

## MCP server (v0.7+)

AgentMark ships a Model Context Protocol server so any MCP client (Claude Desktop, Cursor, Claude Code, custom agents) can use the entire library — web, PDF, OCR, AcroForm — through one configuration entry. No SDK install, no language commitment.

**Configure once in your MCP client:**

```json
{
  "mcpServers": {
    "agentmark": {
      "command": "npx",
      "args": ["-y", "@thinkfleet/agentmark", "agentmark-mcp"]
    }
  }
}
```

The server exposes ~15 tools, prefixed `agentmark_*`:

| Surface | Tools |
|---|---|
| Browser | `agentmark_browser_open`, `agentmark_browser_close`, `agentmark_browser_save_session` |
| Page | `agentmark_page_open`, `agentmark_page_navigate`, `agentmark_page_snapshot`, `agentmark_page_execute`, `agentmark_page_close` |
| PDF | `agentmark_pdf_open`, `agentmark_pdf_close`, `agentmark_pdf_snapshot`, `agentmark_pdf_execute`, `agentmark_pdf_save`, `agentmark_pdf_reset` |
| Meta | `agentmark_list_sessions` |

Each tool is documented in-line via the MCP `list_tools` response — clients see usage hints, JSON schemas, and parameter descriptions automatically.

The server holds long-lived state per connection (browsers, opened PDFs) keyed by IDs returned from `_open` calls — agents can drive multiple parallel surfaces from one connection. Resources auto-release on shutdown via SIGINT/SIGTERM cleanup.

MCP support is opt-in via the optional peer dependency:

```bash
npm install @modelcontextprotocol/sdk
```

Library callers who don't run the MCP server pay no install cost.

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

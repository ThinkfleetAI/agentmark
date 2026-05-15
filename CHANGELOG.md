# Changelog

All notable changes to `@thinkfleet/agentmark` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] — 2026-05-15

The **ThinkFleet Memory Bridge** release. Makes the Memory Pack a
zero-config default and turns `agentmark-mcp install` into a one-shot
that wires creds + a teaching skill into every AI client it touches.
Designed for ThinkFleet Desktop to drive — the result is that an
end user signs in once and every installed AI tool (Claude Code,
Cursor, Codex, Windsurf, Claude Desktop) gains persistent hierarchical
memory across sessions with no prompt rituals.

### Added

- **Memory plugin in the default plugin set.** `createDispatcherState()`
  now always builds the memory plugin and registers it alongside web +
  pdf + desktop. Backend chosen automatically by `detectMemoryBackend()`
  — see below. Backwards-compatible: callers passing an explicit
  `plugins` array to `createMcpServer()` see no change.

- **`detectMemoryBackend()` — env-aware backend selection.** Cascading
  rule:
  - All three of `THINKFLEET_BASE_URL` + `THINKFLEET_PROJECT_ID` +
    `THINKFLEET_API_KEY` present → `ActivepiecesMemoryBackend` (memory
    flows to the configured ThinkFleet workspace; available across
    machines + AI tools).
  - None present → `LocalFileMemoryBackend` (the legacy default,
    on-disk, offline-safe).
  - Some-but-not-all present → throws `MemoryBackendConfigError`.
    Refusing to silently fall back to local on partial creds matters:
    a typo in one variable shouldn't quietly demote a user from
    "memory syncs to my team" to "memory only on my disk."
  - Malformed API key (no `sk-` prefix) → throws; truncated to first
    4 chars in the error so secrets don't leak into logs.

  `THINKFLEET_CHATBOT_ID` is plumbed through when present for
  chatbot-scoped memory routes.

- **`describeMemoryBackend()` + `MemoryBackendConfigError`** — public
  exports so embedders can render a credential-free description of the
  active backend and discriminate config-time failures from runtime
  errors.

- **`agentmark-mcp install --env=KEY=VALUE`** — repeatable flag that
  writes the env block into each AI client's MCP config. The natural
  transport for `THINKFLEET_*` creds without forcing every user to
  edit JSON by hand.

  Validation (all of these *throw* rather than silently mangle):
  - Key must match `^[A-Za-z_][A-Za-z0-9_]*$` — rejects shell
    metacharacters that a launcher might interpret.
  - Value capped at 4 KiB — prevents config bombs.
  - Null bytes rejected.
  - Duplicate keys: stderr warning, last value wins. The warning
    contains the key name but **never** the values.

- **`agentmark-mcp install --skill=<name>`** — repeatable flag that
  installs a skill file alongside the MCP entry. Skills are
  instruction packets AI tools load automatically at session start;
  they teach the agent *when* and *how* to use the tools, without
  which the model often has tools available but doesn't know to call
  them.

  - **Native-skill targets**: Claude Code (`~/.claude/skills/<name>/skill.md`)
    and Claude Desktop (`~/Library/Application Support/Claude/skills/...`).
  - **Marker-block targets** (Cursor `.cursorrules`, Windsurf
    `.windsurfrules`, Codex CLI `AGENTS.md`): scaffolded via
    `upsertManagedBlock` — surgical replacement of a marker-wrapped
    section that preserves any user-authored rules around it. Not in
    the default target list yet; lands in a follow-up after per-tool
    rules-file location research.
  - Skill name validation: `^[a-z0-9][a-z0-9-]*$` — rejects
    path-traversal (`../escape`) and shell-relevant chars.
  - Atomic write (temp + rename, `0644`). Idempotent: same content
    → `already_present`, different → `updated`, missing → `added`.

- **Canonical `thinkfleet-memory` skill** ships with the package.
  Tells the agent to:
  - Call `agentmark_memory_search` at session start to load project
    context.
  - Save user preferences / project facts / decisions without being
    asked.
  - Search memory before guessing about the user's environment.
  - Pick the right scope (platform / user / project / agent / session).
  - Recognise failure modes; avoid pitfalls (don't dump every memory
    at the user, don't save secrets, don't overwrite user-scope with
    session-scope writes).

### Changed

- The MCP server's stderr now logs the selected memory backend at
  startup (`[agentmark] memory backend: …`). Credential-free,
  surfaces in MCP-client diagnostics so configuration issues are
  visible without enabling debug logging.
- On a misconfigured `THINKFLEET_*` env (partial creds, malformed key)
  the memory plugin is disabled with a clear stderr message; the rest
  of the MCP server stays alive. The disabled state surfaces to the
  AI tool as "tool not found" if it tries to call a memory tool, which
  combined with the stderr is the loud-failure signal we want.

### Security

- API tokens never appear in:
  - The selected-backend log line.
  - `describeMemoryBackend()` output.
  - Any error message thrown by `detectMemoryBackend()` (malformed key
    is truncated to first 4 chars).
  - Duplicate-`--env` warnings from the install CLI.
- The `--env` value is documented as on-disk inside the client's MCP
  config file (e.g. `~/.cursor/mcp.json`). Designed to be paired
  with an OS-keychain caller (ThinkFleet Desktop reads tokens from
  Electron `safeStorage` and passes them at install time only).

### Internal

- `parseFlags` / `parseEnvFlag` / `buildEntryFromFlags` extracted from
  `src/mcp/cli.ts` to `src/mcp/install/flags.ts` so tests can exercise
  the parser without spawning the MCP server.
- New tests:
  - `test/memory/detect-backend.test.ts` (16 cases): cascade branches,
    error sanitization, whitespace handling, `chatbotId` plumbing,
    secret-safe error messages.
  - `test/mcp/default-memory-plugin.test.ts` (5 cases): memory plugin
    in default set, startup log, partial-creds disables cleanly.
  - `test/mcp/install-flags.test.ts` (28 cases): `--env` and `--skill`
    parsing + validation.
  - `test/mcp/install-skills.test.ts` (16 cases): `upsertManagedBlock`
    purity, end-to-end installer with fake targets, skill catalog.
  - Suite: **586 passed, 10 skipped** (596 total).

## [0.7.0] — 2026-05-10

MCP server. The entire AgentMark library is now drivable from any MCP
client (Claude Desktop, Cursor, Claude Code, custom agents) through a
single config entry.

### Added

- **`agentmark-mcp` CLI** — bin entry in package.json. Configure any
  MCP client with one line:
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
- **15 MCP tools** covering every public surface:
  - Browser: `browser_open` / `browser_close` / `browser_save_session`
  - Page: `page_open` / `page_navigate` / `page_snapshot` / `page_execute` / `page_close`
  - PDF: `pdf_open` (file path or `data:` URI) / `pdf_close` / `pdf_snapshot` / `pdf_execute` / `pdf_save` / `pdf_reset`
  - Meta: `list_sessions` for debugging stuck connections
- **Stateful session model.** The server holds long-lived browsers + open
  PDFs keyed by IDs returned from `_open` calls, so one MCP connection
  can drive multiple parallel agents.
- **Programmatic access.** `createMcpServer()` + `startMcpServer()` +
  `dispatch()` exported for embedding the server in other applications
  or testing without spinning up stdio.
- **Graceful shutdown.** SIGINT / SIGTERM disposes all browsers,
  Tesseract workers, and PDF handles before exit.
- **`@modelcontextprotocol/sdk` as optional peer dependency.** Library
  callers who don't run the MCP server pay no install cost; surface a
  clean error if the SDK is missing.

### Tests

- 14 new dispatcher tests (PDF round-trip, error semantics, data-URI
  loading, session listing, dispose-all)
- 4 new wire-level handshake tests using `InMemoryTransport` (full
  MCP protocol — handshake, ListTools, CallTool, error responses) —
  proves real MCP clients can connect without spawning a subprocess.
- Total: 213 unit + 10 real-Chromium integration = 223 (was 199).

### Distribution unlocked

After `npm publish`, anyone can configure AgentMark in any MCP client
with the snippet above. No code, no language, no setup beyond the
config file. The full SDK (web + PDF + OCR + form fill/save) becomes
available as ~15 tools any agent can call.

## [0.6.0] — 2026-05-10

PDF form support. AcroForm fields become AgentMark actions; the new
`PdfDocument` class lets agents fill, save, and flatten forms with the
same `execute()` shape as the web `Page` SDK.

### Added

- **AcroForm extraction.** `convertPdf()` automatically reads AcroForm
  fields and sets `kind: 'form'` on snapshots that have any. Fields
  become `ActionDefinition`s with the correct AgentMark action types
  (text → `type`, checkbox → `check`, radio/combo → `select`,
  multi-list → `multi_select`, signature → disabled `click`).
- **Field flag handling.** `Required` and `ReadOnly` flags are read from
  page annotations (where pdfjs-dist surfaces them) since
  `getFieldObjects()` doesn't expose them in v4+.
- **Sensitive-name redaction.** Field names matching common patterns
  (password, ssn, credit_card, cvv, account_num, token, secret, etc.)
  get `(redacted)` labels and `undefined` values, mirroring the
  password-field handling in the web extractor.
- **Humanized labels.** `applicant.first_name` / `firstName` /
  `first-name` all become `"First Name"` in the action's `label`.
- **`PdfDocument` SDK class** + `openPdfDocument()` factory — stateful
  wrapper that pairs the snapshot with field-fill state:
  - `snapshot()` — capture current form state
  - `execute(actionId, value)` — queue a field value
  - `save({ flatten? })` — write a new PDF with all queued values
    applied; `flatten: true` bakes values into page content
  - `reset()` — discard queued values
  - `close()` — release resources
  - `fields`, `pending`, `snapshotCache` — read-only accessors
- **Schema validation.** AgentMark IDs synthesized for AcroForm fields
  match the spec regex `^[a-z][a-z0-9_]{0,63}$` regardless of how
  irregular the source field names are.
- **`pdf-lib` as optional peer dependency.** Reading + extracting fields
  uses `pdfjs-dist`; writing fields back requires `pdf-lib`. Surface a
  clean `SnapshotError` with install instructions if `pdf-lib` is
  missing.

### Changed

- Internal type `PdfDocument` (the extraction-result interface) renamed
  to `ExtractedPdf` to free `PdfDocument` for the public class. The
  type was internal; no consumer code references it through the public
  API.
- `convertPdf()` now sets `kind: 'form'` (not `'document'`) when the
  source PDF has AcroForm fields.
- Action IDs for AcroForm fields are synthesized as `act_field_N` to
  guarantee schema compliance — original field names are preserved in
  the binding map for fill operations.

### Tests

- 12 new AcroForm extractor tests + 11 new `PdfDocument` round-trip
  tests, all passing.
- Total: 199 unit + 10 real-Chromium integration = 209 (was 188).
- Round-trip coverage: text / checkbox / dropdown / multi-select listbox
  all verified through fill → save → re-extract.

### Known limitations

- `pdfjs-dist`'s `getFieldObjects()` only reports the first selected
  value of a multi-select listbox. The PDF saved by AgentMark contains
  ALL selected values correctly (verified via direct pdf-lib reading);
  it's only the snapshot that under-reports. No fix planned — wait for
  pdfjs-dist upstream support.
- Signature fields surface as disabled actions; AgentMark intentionally
  refuses to fulfill them. Human review required.

## [0.5.0] — 2026-05-10

OCR + render-backend support. Pages with no extractable text (scanner
output, "Microsoft Print To PDF" exports, image-only PDFs) can now be
rasterized + OCR'd transparently. Two render backends and two OCR
backends ship; the interfaces let callers plug in any provider.

### Added

- **`OcrBackend` / `RenderBackend` interfaces.** Minimal, plug-and-play.
  Bring AWS Textract, Google Document AI, Apple Vision, etc. by
  implementing one method each.
- **`PopplerRenderBackend`** — shells out to `pdftoppm`. Lightest install.
- **`PdfjsRenderBackend`** — pure-Node via pdfjs-dist + node-canvas.
- **`TesseractOcrBackend`** — in-process WASM OCR. Free, offline.
- **`MistralOcrBackend`** — Mistral OCR cloud API. Best quality.
- **`convertPdf({ ocr: { render, ocr, mode } })`** — opt-in OCR pipeline
  with three modes: `auto` (OCR only pages with no extractable text;
  default), `always` (OCR every page), `never` (disable).
- **`document.ocr_used` flag** — set to `true` in the snapshot's
  document metadata when OCR was actually applied.
- **`agentmark` capability `ocr: true`** is set on snapshots that used OCR.
- **Diagnostic CLI `--ocr` flag** — `npx tsx examples/diagnose-pdf.ts
  ./corpus --ocr` to validate OCR on a corpus.
- **`examples/ocr-pdf.ts`** — end-to-end demo wiring Poppler + Tesseract.

### Changed

- `tesseract.js` and `canvas` added as optional peer dependencies. Both
  are required only by the matching backend; web-only callers install
  neither.
- `convertPdf` defensively wraps cleanup `close()` calls so backends
  may return `void | Promise<void>`.

### Real-world validation

Insurance corpus (12 docs) results, before vs after v0.5:

| Mode | 🟢 ≥70 | 🟡 30-69 | 🔴 <30 |
|---|---|---|---|
| Without OCR | 6 (50%) | 6 (50%) | 0 |
| With OCR (Poppler + Tesseract) | **12 (100%)** | 0 | 0 |

Failing categories before v0.5 — all now resolved by OCR:
- "Microsoft Print To PDF" vector-glyph PDFs (4 docs)
- Scanner output (2 docs)

### Tests

- 8 new OCR pipeline unit tests (mocked backends, deterministic).
- Total: 176 unit + 10 real-Chromium integration = 186 (was 176).

### Not in this release (deferred)

- AWS Textract / Google Document AI / Apple Vision reference adapters
  (interface ships; community impls welcome)
- Form-structure inference (label/value pair detection on non-AcroForm
  PDFs) — paired with M3 / v0.6
- AcroForm support — M3 / v0.6

## [0.4.0] — 2026-05-10

PDF support. The same wire format now applies to documents — `convertPdf()`
produces a `kind: 'document'` snapshot from PDF bytes. Spec extension to v0.2.

### Added

- **Spec v0.2** — adds `kind: webpage | document | form` discriminator,
  optional `document` metadata block (pages, author, created_at, format,
  format_version, ocr_used), and the `[PAGE:p_n]` body tag for page-boundary
  markers in documents. Fully backwards-compatible: v0.1 snapshots without
  `kind` still validate (treated as webpages).
- **`convertPdf({ data, sourceUrl, ... })`** — main entry point. Parses
  PDF metadata (title, author, dates, format version), extracts text + font
  sizes per page, builds an AgentMark body with PAGE markers and inferred
  structure (headings via font-size outliers, bullet + ordered list
  detection, paragraph reflow). Returns the same `ConversionResult` as
  `convertPage()` for uniform downstream handling.
- **`extractPdf()`** — lower-level extraction returning a structured
  `PdfDocument` (pages with positioned text items + metadata). For callers
  who want to do their own structural inference.
- **`buildBodyFromPdf()`** — body-segment builder consumed by `convertPdf`,
  exposed for callers who want a different envelope.
- **`schema/agentmark-v0.2.json`** — JSON schema for the v0.2 envelope;
  validator now picks v0.1 or v0.2 schema based on the declared `agentmark`
  version.
- **`pdfjs-dist`** as an optional peer dependency. Throws clean
  `SnapshotError` with install instructions if missing — web-only callers
  pay no install cost.
- 13 new spec-v0.2 tests + 12 new PDF converter tests, all passing.
  Total: 166 unit + 10 real-Chromium integration = 176 (was 141).

### Changed

- `AGENTMARK_VERSION` constant bumped from `'0.1'` to `'0.2'`. Existing
  callers serializing snapshots get v0.2 by default. Validator accepts both.
- README and `examples/pdf.ts` show the new PDF flow.

### Not yet shipped

- OCR for scanned PDFs — interface designed (`document.ocr_used` flag in
  metadata), implementation deferred to v0.5.0.
- Table detection — heuristics for column-aligned text deferred to v0.5.0.
- AcroForm support — coming in M3 / v0.5.0.

## [0.3.0] — 2026-05-10

The **first production-ready release**. Adds the high-level SDK
surface, structured error hierarchy, observability hooks, and session
persistence on top of the v0.2 wire-format conversion.

### Added

- **High-level SDK** — `createBrowser()`, `Browser`, `Page` wrappers with a
  small surface (`page.goto()`, `page.snapshot()`, `page.execute()`) that
  hides Playwright details from typical callers while keeping `.raw`
  escape hatches for advanced use.
- **Action executor** (`executeAction`) — full coverage of all 17
  `ActionType`s with a single `execute(actionId, value?)` entry point.
  Resolves binding, dispatches the right Playwright operation, validates
  value types, classifies errors, disposes element handles in `finally`.
- **Error hierarchy** — `AgentMarkError` (base) → `SnapshotError`,
  `ExecutionError` (with `ActionNotFoundError`, `ActionDisabledError`,
  `ActionTypeError`, `ElementNotFoundError`, `ExecutionTimeoutError`),
  `SessionError`. All errors carry stable `code` strings, preserve the
  prototype chain, and pass through `isAgentMarkError()` type guard.
- **Branded ID types** — `ActionId`, `MediaId`, `RegionId` for nominal
  type safety on identifiers. Zero runtime overhead.
- **Pluggable structured logger** — `Logger` interface with `noopLogger`
  (default, zero overhead) and `consoleLogger` (JSON-lines for dev).
  Threaded through `Browser` → `Page` → executor; emits typed events
  (catalog in `AgentMarkEvent`).
- **Session persistence** — `browser.saveSession(path)` /
  `createBrowser({ sessionPath })` for cookie + storageState round-trips.
  Atomic write via temp+rename to prevent partial files on crash.
  Versioned file format (`session_format: '1'`).
- **Honeypot refusal** — actions marked `honeypot: true` (bot-trap fields)
  throw `ActionDisabledError` instead of executing.

### Changed

- Public exports re-organized: `src/runtime` is now the canonical module
  for SDK surface (`createBrowser`, `Browser`, `Page`, `executeAction`).
  Existing `convertPage` + `InMemoryActionBinding` continue to work.

### Tests

- 130 tests passing (was 90 in v0.2). 30 new unit tests cover the
  executor, errors, branded types, and session file format.
- 10 new real-Chromium integration tests gated on
  `AGENTMARK_INTEGRATION=1`. Cover snapshot capture, form fill + submit
  + redirect, disabled-action refusal, navigation invalidation, session
  round-trip across browser instances, idempotent close, end-to-end
  logger event flow.

### Production-readiness gates cleared

- Type safety: zero `any` in new code; branded IDs prevent type confusion
- Error taxonomy: full hierarchy with stable codes, prototype-chain safe
- Observability: every public op emits structured events; default no-op
- Atomic writes: sessions never leave partial files
- Backwards compatibility: all v0.2 tests still passing
- Cross-platform: build clean; CI matrix Node 20+22

## [0.2.0] — 2026-04-26

### Added

- Tables → GFM markdown extraction
- iframe content traversal
- Shadow DOM piercing
- Cross-platform CI workflow (`npm install` workaround for npm/cli#4828)

### Fixed

- DOM-race hardening (body-existence guards in wait strategy)
- Type-import alignment

## [0.1.0] — 2026-04-26

Initial release of `@thinkfleet/agentmark`.

### Added

- Reference implementation of agentmark v0.1 spec
- DOM extractor (Playwright Page → AgentMark)
- YAML frontmatter, body-text, and JSON serializers
- Schema validator (Ajv-based)
- Wait strategies: `fast`, `smart` (default), `aggressive`
- Mutation observer for SPA stability detection
- Anti-bot challenge resolver (Cloudflare, reCAPTCHA, hCaptcha)
- Cookie banner auto-dismissal (OneTrust, Cookiebot, Quantcast, Osano,
  Didomi, Iubenda, generic, fallback)
- In-memory action binding
- 90 tests, npm provenance auto-publish

[0.7.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.7.0
[0.6.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.6.0
[0.5.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.5.0
[0.4.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.4.0
[0.3.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.3.0
[0.2.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.1.0

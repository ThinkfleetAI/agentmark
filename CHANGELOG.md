# Changelog

All notable changes to `@thinkfleet/agentmark` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.4.0
[0.3.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.3.0
[0.2.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.1.0

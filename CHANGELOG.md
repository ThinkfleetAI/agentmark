# Changelog

All notable changes to `@thinkfleet/agentmark` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.6.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.6.0
[0.5.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.5.0
[0.4.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.4.0
[0.3.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.3.0
[0.2.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/ThinkfleetAI/agentmark/releases/tag/v0.1.0

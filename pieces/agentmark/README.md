# @thinkfleet/piece-agentmark

[Activepieces](https://www.activepieces.com/) piece for [AgentMark](https://github.com/ThinkfleetAI/agentmark) — convert any web page or PDF into a compact AgentMark snapshot from inside a flow, and fill PDF forms with data from previous flow steps.

## What this piece adds

| Action | What it does | Inputs | Outputs |
|---|---|---|---|
| **Capture Web Page** | Launch Chromium, snapshot a URL, return AgentMark | `url`, `wait_until`, `timeout_ms`, `headless` | `agentmark`, `url`, `title`, `kind`, `action_count`, `bytes` |
| **Capture PDF** | Convert a PDF (URL/file/base64/data URI) to AgentMark; optional OCR | `source`, `source_url`, `title`, `password`, `enable_ocr`, `ocr_language` | `agentmark`, `source_url`, `bytes`, `ocr_used` |
| **Fill PDF Form** | Fill an AcroForm PDF and return the filled bytes | `source`, `values`, `flatten`, `return_format`, `password` | `filled_pdf` (data URI or raw base64), `bytes`, `fields_applied`, `fields_skipped`, `flattened` |

All actions run on the Activepieces worker — no external service required. Browser-based snapshots use Chromium via Playwright; PDF support uses pdfjs-dist + pdf-lib; optional OCR uses Tesseract.js with Poppler (`pdftoppm`).

## Why use this in a flow

- **Drop AgentMark into any agent flow** without writing code. The agent loop lives in your flow — call `Capture Page`, pass the snapshot to your AI step, then `Page Execute` (coming soon) or chain another snapshot.
- **Fill insurance/government/vendor PDFs** from CRM data. Map field action IDs from a previous step to records pulled from your data store, run `Fill PDF Form`, attach the result to an email.
- **Extract structured data from scanned docs** by enabling OCR on `Capture PDF`. Works on "Microsoft Print To PDF" output and scanner outputs.

## Activepieces setup

This piece depends on:

- `@thinkfleet/agentmark` (the core library)
- `playwright-core` for browser-based actions
- `pdfjs-dist` (optional, required for any PDF action)
- `pdf-lib` (optional, required for `Fill PDF Form`)
- `tesseract.js` + Poppler installed on the worker (optional, required for OCR)

Install Chromium binaries on the worker once:

```bash
npx playwright-core install chromium
```

Install Poppler on the worker (only if using OCR):

```bash
brew install poppler           # macOS
apt-get install poppler-utils  # Ubuntu/Debian
```

## License

MIT.

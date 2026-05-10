# Testing AgentMark Locally

End-to-end verification across every surface AgentMark ships: SDK, PDF, OCR, AcroForm, MCP server, and Activepieces piece.

Tested working on macOS arm64 with Node 20, but every command should work on Linux x64 too.

## Prerequisites

```bash
# 1. Clone + install
git clone https://github.com/ThinkfleetAI/agentmark
cd agentmark
git checkout feat/m5-activepieces-piece    # latest stack — has all 6 PRs
npm install

# 2. Browser binaries (one-time, ~150 MB)
npx playwright-core install chromium

# 3. Poppler — only if you want OCR via PopplerRenderBackend
brew install poppler                        # macOS
# apt-get install poppler-utils             # Ubuntu/Debian

# 4. Build
npm run build
```

## 1. Unit + integration tests

```bash
# Fast: 207 unit tests (~2s)
npm test

# Full: includes 10 real-Chromium integration tests (~12s)
AGENTMARK_INTEGRATION=1 npm test
```

Expected: **207 unit + 10 integration = 217 passing.**

## 2. Kitchen-sink demo — every surface in one run

```bash
# Synthetic fixtures only
npx tsx examples/kitchen-sink.ts

# Or against your own PDF corpus (recommended — exercises real-world docs)
npx tsx examples/kitchen-sink.ts ~/Downloads/your-pdfs
```

Output (with insurance corpus):

```
🟢 Web — capture example.com via Chromium                         2433ms
🟢 PDF (text) — extract structured AgentMark from text PDF         741ms
🟢 PDF (OCR) — Tesseract + Poppler on scanned/print-to-PDF       15406ms
🟢 AcroForm — fill + save round-trip                                73ms
🟢 MCP — dispatcher list_sessions returns valid JSON                26ms

5/5 passed in 18679ms total.
```

## 3. Surface-by-surface tests

### 3a. PDF diagnostic CLI — score a corpus

```bash
# Without OCR — see how much breaks naturally
npx tsx examples/diagnose-pdf.ts ~/Downloads/your-pdfs --out /tmp/report.md

# With OCR — verify scanned + print-to-PDF docs get rescued
npx tsx examples/diagnose-pdf.ts ~/Downloads/your-pdfs --ocr --out /tmp/report-ocr.md

cat /tmp/report-ocr.md
```

The report classifies every doc into `real_text` / `print_to_pdf_vector` / `scan` / `mixed` and tells you exactly what works.

### 3b. SDK — programmatic usage

```bash
# Web page basic
npx tsx examples/basic.ts

# PDF
npx tsx examples/pdf.ts ~/Downloads/some.pdf

# OCR a scanned/print-to-PDF
npx tsx examples/ocr-pdf.ts ~/Downloads/some-scanned.pdf

# Driving an LLM agent loop (needs ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/with-claude.ts \
    "find the contact email" "https://example.com"
```

### 3c. MCP server — standalone

```bash
# Start the server (it'll wait on stdin for MCP protocol messages)
node dist/src/mcp/cli.js
```

It just hangs — that's correct. The server is waiting for an MCP client to connect over stdio.

### 3d. Activepieces piece

```bash
cd pieces/agentmark
npm install
npm run build
npm test                          # 13 unit tests
```

## 4. Wire it into Claude Desktop (real MCP client test)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentmark": {
      "command": "node",
      "args": ["/Users/YOU/path/to/agentmark/dist/src/mcp/cli.js"],
      "env": {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Restart Claude Desktop, then in a new conversation try:

> "Use the AgentMark tool to capture a snapshot of https://news.ycombinator.com and tell me the top 3 story titles."

Or:

> "Open the PDF at /Users/YOU/Downloads/some-form.pdf, list its form fields, then fill the company name field with 'Test Co'."

## 5. Wire it into OpenClaw

OpenClaw supports MCP servers via its **MCP Registry**. The configuration shape is the same as Claude Desktop. Following [OpenClaw's installation docs](https://github.com/openclaw/openclaw):

1. Install OpenClaw locally per their README
2. Register the AgentMark MCP server in OpenClaw's config — typically:

```yaml
# ~/.openclaw/workspace/mcp.yaml (exact path may differ — check OpenClaw docs)
servers:
  agentmark:
    command: node
    args:
      - /Users/YOU/path/to/agentmark/dist/src/mcp/cli.js
```

3. Restart OpenClaw and ask it (in whatever chat app you've connected — WhatsApp/Telegram/etc.):

> "Capture the page at example.com and summarize what's on it."
> "Fill out the PDF at ~/Downloads/vendor-form.pdf with company=Acme and email=foo@bar.com."

OpenClaw should discover the AgentMark tools, route the request to the MCP server, and execute against your local browser + PDF stack.

## 6. The full distribution checklist

| Surface | Manual smoke test | Script test | Status |
|---|---|---|---|
| TypeScript SDK | `npx tsx examples/basic.ts` | `npm test` | ✅ |
| PDF (text) | `npx tsx examples/pdf.ts` | kitchen-sink | ✅ |
| PDF + OCR | `npx tsx examples/ocr-pdf.ts` | kitchen-sink | ✅ |
| AcroForm | (no example yet) | kitchen-sink | ✅ |
| Diagnostic CLI | `npx tsx examples/diagnose-pdf.ts` | manual | ✅ |
| MCP server | Configure Claude Desktop / OpenClaw | `npm test test/mcp/` | ✅ |
| Activepieces piece | Drag into a real flow | `cd pieces/agentmark && npm test` | ✅ |

## 7. Common gotchas

- **`pdftoppm: command not found`** — install Poppler (`brew install poppler` / `apt-get install poppler-utils`).
- **`Could not load `playwright-core`**` — run `npx playwright-core install chromium` once after `npm install`.
- **MCP server doesn't appear in Claude Desktop** — make sure you restarted Claude Desktop after editing the config; check Claude's logs at `~/Library/Logs/Claude/`.
- **Kitchen-sink PDF (OCR) test takes 15+ seconds** — that's normal. Tesseract loads its language model on first call. Subsequent runs are faster within the same process.
- **`eng.traineddata` shows up in your repo root** — that's Tesseract's language model. It's gitignored by `.gitignore` (line: `*.traineddata`). Safe to delete; it'll re-download next OCR run.

## 8. What to change if you find a real-world failure

The diagnostic CLI is your friend:

```bash
# Probe a single problem PDF at the operator level
npx tsx examples/probe-pdf.ts /path/to/broken.pdf

# Inspect font distribution
npx tsx examples/dump-fonts.ts /path/to/broken.pdf

# Run full diagnostic
npx tsx examples/diagnose-pdf.ts /path/to/broken.pdf
```

The diagnostic categorizes every failure (scan / print-to-pdf / unknown) and recommends the right fix.

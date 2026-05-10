/**
 * Fetch a starter corpus of public government PDFs for testing AgentMark.
 *
 *   npx tsx examples/fetch-gov-corpus.ts <output-dir> [manifest.json]
 *
 * Reads `examples/gov-corpus-manifest.json` (or a custom manifest) and
 * downloads each entry to `<output-dir>/<name>`. Skips files already present.
 * Reports a final summary with byte sizes + any failures.
 *
 * Government URLs change constantly — failures are expected and reported,
 * not fatal. Edit the manifest freely to add your own stable sources
 * (state Sec of State filings, county building permits, etc.).
 */

import { writeFile, mkdir, stat, readFile } from 'node:fs/promises'
import * as path from 'node:path'

interface ManifestEntry {
    name: string
    url: string
    category: string
    expected_kind?: 'webpage' | 'document' | 'form'
    notes?: string
}

interface Manifest {
    documents: ManifestEntry[]
}

interface FetchResult {
    name: string
    url: string
    ok: boolean
    bytes?: number
    error?: string
    skipped?: boolean
}

async function fetchOne(entry: ManifestEntry, outputDir: string): Promise<FetchResult> {
    const target = path.join(outputDir, entry.name)
    try {
        const existing = await stat(target).catch(() => null)
        if (existing && existing.isFile() && existing.size > 0) {
            return { name: entry.name, url: entry.url, ok: true, bytes: existing.size, skipped: true }
        }
    } catch {
        // not present, fall through to download
    }

    try {
        const response = await fetch(entry.url, {
            headers: {
                'User-Agent': 'agentmark-test-corpus-fetcher/0.1 (+https://agentmark.dev)',
                Accept: 'application/pdf,*/*',
            },
            redirect: 'follow',
        })
        if (!response.ok) {
            return {
                name: entry.name,
                url: entry.url,
                ok: false,
                error: `${response.status} ${response.statusText}`,
            }
        }
        const contentType = response.headers.get('content-type') ?? ''
        const buffer = Buffer.from(await response.arrayBuffer())

        // Sanity-check: file must look like a PDF (starts with %PDF-)
        if (buffer.subarray(0, 5).toString('utf8') !== '%PDF-') {
            return {
                name: entry.name,
                url: entry.url,
                ok: false,
                error: `not a PDF (content-type: ${contentType}, first bytes: ${buffer.subarray(0, 16).toString('utf8')})`,
            }
        }

        await writeFile(target, buffer)
        return { name: entry.name, url: entry.url, ok: true, bytes: buffer.length }
    } catch (err) {
        return {
            name: entry.name,
            url: entry.url,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

async function main() {
    const outputDir = process.argv[2]
    const manifestPath = process.argv[3] ?? path.join(__dirname, 'gov-corpus-manifest.json')
    if (!outputDir) {
        console.error(
            'Usage: npx tsx examples/fetch-gov-corpus.ts <output-dir> [manifest.json]',
        )
        console.error(
            '  Default manifest: examples/gov-corpus-manifest.json',
        )
        process.exit(1)
    }

    const absOutput = path.resolve(outputDir)
    await mkdir(absOutput, { recursive: true })

    const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!Array.isArray(manifest.documents)) {
        console.error(`Manifest at ${manifestPath} is missing "documents" array`)
        process.exit(1)
    }

    console.error(`Fetching ${manifest.documents.length} document(s) into ${absOutput}\n`)

    const results: FetchResult[] = []
    for (const entry of manifest.documents) {
        process.stderr.write(`  ${entry.name.padEnd(40)} `)
        const r = await fetchOne(entry, absOutput)
        results.push(r)
        if (r.skipped) {
            process.stderr.write(`⏭  ${r.bytes} B (already present)\n`)
        } else if (r.ok) {
            process.stderr.write(`✅ ${r.bytes} B\n`)
        } else {
            process.stderr.write(`❌ ${r.error}\n`)
        }
    }

    const ok = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)

    console.error(`\n──── Summary ────`)
    console.error(`  ${ok.length}/${results.length} fetched successfully`)
    console.error(`  Output dir: ${absOutput}`)

    if (failed.length > 0) {
        console.error(`\nFailures (likely outdated URLs in the manifest — edit and retry):`)
        for (const r of failed) {
            console.error(`  ${r.name}: ${r.error}`)
            console.error(`    URL: ${r.url}`)
        }
    }

    if (ok.length > 0) {
        console.error(`\nNext step:`)
        console.error(
            `  npx tsx examples/diagnose-pdf.ts "${absOutput}" --ocr `
            + `--snapshots /tmp/agentmark-snaps --out /tmp/gov-corpus-report.md`,
        )
    }

    if (failed.length === results.length) process.exit(1)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

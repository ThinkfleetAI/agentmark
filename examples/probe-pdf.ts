/**
 * Deep probe of a problematic PDF — answers: "why doesn't text extract?"
 *
 *   npx tsx examples/probe-pdf.ts <path-to.pdf>
 *
 * Per page, reports:
 *   - Text content items (the extractor's normal channel)
 *   - Operator list (low-level draw ops — text-rendering, image-drawing, paths)
 *   - Font dictionary (font types, encodings)
 *   - Image XObjects (count + sizes — if many large images, the doc is rasterized)
 *   - Op-name histogram so we can spot e.g. "all draw ops are paintImageXObject"
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { loadPdfjs } from '../src/pdf/pdfjs-loader'

async function main() {
    const filePath = process.argv[2]
    if (!filePath) {
        console.error('Usage: npx tsx examples/probe-pdf.ts <pdf-path>')
        process.exit(1)
    }

    const pdfjs = await loadPdfjs()
    const data = await readFile(filePath)
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(view),
        verbosity: 0,
    }).promise

    console.log(`File: ${path.basename(filePath)}`)
    console.log(`Pages: ${doc.numPages}`)
    const meta = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }))
    console.log(`Metadata: ${JSON.stringify(meta.info, null, 2)}`)
    console.log()

    for (let n = 1; n <= Math.min(doc.numPages, 2); n++) {
        const page = await doc.getPage(n)
        console.log(`──── Page ${n} ────`)

        const text = await page.getTextContent()
        console.log(`  textContent items: ${text.items.length}`)
        if (text.items.length > 0 && 'str' in text.items[0]) {
            const sample = text.items.slice(0, 3).map((i) => 'str' in i ? `"${i.str}"` : '(non-text)').join(', ')
            console.log(`  first items: ${sample}`)
        }

        const opList = await page.getOperatorList()
        console.log(`  operatorList ops: ${opList.fnArray.length}`)

        // Reverse-look-up op codes from the OPS map
        const ops = pdfjs.OPS as Record<string, number>
        const opName = new Map<number, string>()
        for (const [name, code] of Object.entries(ops)) opName.set(code as number, name)

        const histogram = new Map<string, number>()
        for (const code of opList.fnArray) {
            const name = opName.get(code) ?? `op_${code}`
            histogram.set(name, (histogram.get(name) ?? 0) + 1)
        }
        const sorted = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        console.log(`  top 10 ops:`)
        for (const [name, count] of sorted) console.log(`    ${count.toString().padStart(5)} ${name}`)

        // Fonts
        try {
            const objs = (page as unknown as { commonObjs: { _objs: Map<string, unknown> } }).commonObjs
            const fontKeys = objs?._objs ? [...objs._objs.keys()].filter((k) => k.startsWith('g_')) : []
            console.log(`  font / common objects: ${fontKeys.length}`)
        } catch {
            // ignore
        }

        page.cleanup()
        console.log()
    }

    await doc.destroy()
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

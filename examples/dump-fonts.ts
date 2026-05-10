/**
 * Dump unique font names + sample text per font to understand a PDF's
 * heading-vs-body distinction. Useful when bold-name detection alone
 * misses headings.
 *
 *   npx tsx examples/dump-fonts.ts <pdf-path>
 */

import { readFile } from 'node:fs/promises'
import { extractPdf } from '../src/pdf/pdf-extractor'

async function main() {
    const file = process.argv[2]
    if (!file) {
        console.error('Usage: npx tsx examples/dump-fonts.ts <pdf-path>')
        process.exit(1)
    }
    const data = await readFile(file)
    const doc = await extractPdf({ data })

    interface Stat {
        font: string
        sizes: Set<number>
        samples: Set<string>
        count: number
    }
    const stats = new Map<string, Stat>()
    for (const page of doc.pages) {
        for (const item of page.items) {
            if (!item.text.trim()) continue
            const key = item.fontName
            let s = stats.get(key)
            if (!s) {
                s = { font: key, sizes: new Set(), samples: new Set(), count: 0 }
                stats.set(key, s)
            }
            s.count++
            s.sizes.add(Math.round(item.fontSize * 2) / 2)
            if (s.samples.size < 3) s.samples.add(item.text.slice(0, 50))
        }
    }

    console.log(`File: ${file}`)
    console.log(`Pages: ${doc.pages.length}`)
    console.log(`Distinct fonts: ${stats.size}`)
    console.log()
    const sorted = [...stats.values()].sort((a, b) => b.count - a.count)
    for (const s of sorted) {
        const sizes = [...s.sizes].sort((a, b) => a - b).join(', ')
        console.log(`  ${s.count.toString().padStart(5)} × ${s.font}`)
        console.log(`         sizes: ${sizes}`)
        for (const ex of s.samples) console.log(`         e.g.: "${ex}"`)
        console.log()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

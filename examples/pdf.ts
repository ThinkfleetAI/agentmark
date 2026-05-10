/**
 * Convert a PDF to AgentMark and print the snapshot.
 *
 *   npx tsx examples/pdf.ts /path/to/document.pdf
 *
 * Requires the optional peer dep:
 *   npm install pdfjs-dist@^4
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { convertPdf, consoleLogger } from '../src'

async function main() {
    const filePath = process.argv[2]
    if (!filePath) {
        console.error('Usage: npx tsx examples/pdf.ts <path-to.pdf>')
        process.exit(1)
    }

    const data = await readFile(filePath)
    const sourceUrl = pathToFileURL(path.resolve(filePath)).toString()

    const { agentmark } = await convertPdf({
        data,
        sourceUrl,
        logger: consoleLogger,
    })

    console.log('\n────── AgentMark snapshot ──────\n')
    console.log(agentmark)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})

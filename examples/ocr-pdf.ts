/**
 * End-to-end OCR demo. Tries to convert a PDF that lacks extractable text
 * (scan or "Microsoft Print To PDF" output) using:
 *
 *   - Render backend: Poppler (`pdftoppm`) — must be on PATH
 *   - OCR backend:    Tesseract.js (in-process, free)
 *
 *   npx tsx examples/ocr-pdf.ts <path-to.pdf>
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    convertPdf,
    PopplerRenderBackend,
    TesseractOcrBackend,
    consoleLogger,
} from '../src'

async function main() {
    const filePath = process.argv[2]
    if (!filePath) {
        console.error('Usage: npx tsx examples/ocr-pdf.ts <pdf-path>')
        process.exit(1)
    }

    const data = await readFile(filePath)
    const sourceUrl = pathToFileURL(path.resolve(filePath)).toString()

    const render = new PopplerRenderBackend()
    const ocr = new TesseractOcrBackend({ language: 'eng' })

    try {
        const { agentmark } = await convertPdf({
            data,
            sourceUrl,
            logger: consoleLogger,
            ocr: {
                render,
                ocr,
                mode: 'auto',  // OCR only pages with no extractable text
                dpi: 200,
            },
        })

        console.log('\n────── AgentMark snapshot ──────\n')
        console.log(agentmark)
    } finally {
        await ocr.close().catch(() => {})
    }
}

main().catch((err) => {
    console.error('FAILED:', err)
    process.exit(1)
})

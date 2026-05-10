/**
 * Lazy loader for `pdfjs-dist`. The dependency is an *optional* peer dep
 * because most AgentMark callers only use the web-page path. Surface a
 * clear error if the user calls `convertPdf()` without it installed.
 */

import { SnapshotError } from '../errors'

// pdfjs-dist's Node ESM bundle. We use the legacy build because the modern
// build expects a fetch-style worker setup; legacy runs cleanly in Node.
type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let cached: PdfjsLib | null = null

export async function loadPdfjs(): Promise<PdfjsLib> {
    if (cached) return cached
    try {
        // Dynamic import keeps pdfjs-dist out of the require graph for
        // callers who never touch PDFs. The string-literal path is required
        // for Node's ESM resolution to find the legacy build.
        cached = await import('pdfjs-dist/legacy/build/pdf.mjs')
        return cached
    } catch (err) {
        throw new SnapshotError(
            'PDF support requires the optional peer dependency pdfjs-dist. '
            + 'Install with: npm install pdfjs-dist@^4',
            err as Error,
        )
    }
}

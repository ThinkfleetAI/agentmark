import { createAction, Property } from '@activepieces/pieces-framework'
import {
    convertPdf,
    PopplerRenderBackend,
    TesseractOcrBackend,
} from '@thinkfleet/agentmark'
import { resolveBytes } from '../common'

export const snapshotPdf = createAction({
    name: 'snapshot_pdf',
    displayName: 'Capture PDF',
    description:
        'Convert a PDF (URL, file path, base64, or data URI) into a compact '
        + 'AgentMark snapshot. PDFs with form fields produce kind: \'form\'; '
        + 'plain documents produce kind: \'document\'. Optionally OCR pages '
        + 'with no extractable text using Tesseract + Poppler.',
    props: {
        source: Property.LongText({
            displayName: 'Source',
            description:
                'HTTP(S) URL, file path, file:// URI, data:application/pdf;base64,... '
                + 'URI, or a bare base64 string.',
            required: true,
        }),
        source_url: Property.ShortText({
            displayName: 'Source URL (override)',
            description:
                'Optional URI to record as the snapshot\'s `url` field. Useful '
                + 'when the input is a data URI or in-memory base64 and you '
                + 'want a stable identifier for downstream steps.',
            required: false,
        }),
        title: Property.ShortText({
            displayName: 'Title (override)',
            description: 'Override the document title. Leave blank to use the PDF metadata title.',
            required: false,
        }),
        password: Property.ShortText({
            displayName: 'Password',
            description: 'Password for encrypted PDFs.',
            required: false,
        }),
        enable_ocr: Property.Checkbox({
            displayName: 'Enable OCR',
            description:
                'Run Tesseract OCR on pages with no extractable text. Required '
                + 'for scanned PDFs and "Microsoft Print To PDF" output. Slower; '
                + 'requires Poppler installed on the worker host (pdftoppm).',
            required: false,
            defaultValue: false,
        }),
        ocr_language: Property.ShortText({
            displayName: 'OCR Language',
            description: 'BCP-47 language hint. Default: eng.',
            required: false,
            defaultValue: 'eng',
        }),
    },
    async run(context) {
        const {
            source,
            source_url,
            title,
            password,
            enable_ocr,
            ocr_language,
        } = context.propsValue

        const data = await resolveBytes(source)
        const sourceUrl = source_url
            ?? (source.startsWith('http') ? source : 'inline:pdf')

        const ocrBackend = enable_ocr ? new TesseractOcrBackend({ language: ocr_language ?? 'eng' }) : undefined
        try {
            const { agentmark } = await convertPdf({
                data,
                sourceUrl,
                title,
                password,
                ocr: enable_ocr
                    ? {
                        render: new PopplerRenderBackend(),
                        ocr: ocrBackend!,
                        mode: 'auto',
                        dpi: 200,
                        language: ocr_language ?? 'eng',
                    }
                    : undefined,
            })

            return {
                agentmark,
                source_url: sourceUrl,
                bytes: agentmark.length,
                ocr_used: enable_ocr === true,
            }
        } finally {
            await ocrBackend?.close().catch(() => {})
        }
    },
})

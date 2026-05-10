/**
 * AcroForm signature widget detector.
 *
 * Walks the PDF's AcroForm fields looking for `/Sig` widgets. Each becomes
 * a DetectedSignature with role inferred from the field name.
 *
 * Distinguishing signed vs unsigned without reading the cryptographic
 * signature dictionary is approximate: pdfjs-dist's `getFieldObjects()`
 * exposes a `value` field on signed widgets that's typically null/empty
 * when unsigned. We use this as the heuristic; cryptographic verification
 * comes in a follow-up release via Poppler's `pdfsig`.
 */

import { extractAcroForm } from '../forms/acroform-extractor'
import { inferRoleFromFieldName } from './role-inference'
import type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
} from './types'

export class AcroFormSignatureDetector implements SignatureDetector {
    readonly name = 'acroform_widget'

    async detect(input: SignatureDetectorInput): Promise<DetectedSignature[]> {
        const acroform = await extractAcroForm({
            data: input.rawBytes,
            password: input.password,
        }).catch(() => ({ fields: [], hasFields: false }))

        const detections: DetectedSignature[] = []
        let counter = 0
        for (const field of acroform.fields) {
            if (field.kind !== 'signature') continue
            counter++

            // Heuristic for signed vs unsigned: if pdfjs surfaced any value
            // we treat it as signed; empty string / undefined → unsigned.
            const valuePresent =
                typeof field.value === 'string' && field.value.length > 0
            const kind = valuePresent ? 'widget_visible_signed' : 'widget_unsigned'

            const inferred_role = inferRoleFromFieldName(field.fieldName)
            const confidence = valuePresent
                ? inferred_role ? 0.9 : 0.7
                : inferred_role ? 0.85 : 0.6

            detections.push({
                id: `sig_a_${counter}`,
                kind,
                page: field.page,
                rect: field.rect,
                field_name: field.fieldName,
                inferred_role,
                confidence,
                notes: inferred_role
                    ? `Role inferred from field name: "${field.fieldName}"`
                    : `Sig widget — field name "${field.fieldName}" did not match any role pattern`,
            })
        }
        return detections
    }
}

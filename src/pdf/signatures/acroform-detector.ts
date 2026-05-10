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
import { inferRoleFromFieldName, inferRoleFromNearbyText } from './role-inference'
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

            // Three-tier role inference. Field name is fastest + most reliable
            // when the name has semantic meaning ("client_signature"); fall
            // back to label, then to nearby text. The third tier catches
            // form-builder-generated random IDs (HelloSign, etc.).
            let inferred_role = inferRoleFromFieldName(field.fieldName)
            let role_source = inferred_role ? 'field name' : ''
            if (!inferred_role) {
                const labelRole = inferRoleFromFieldName(field.label)
                if (labelRole) {
                    inferred_role = labelRole
                    role_source = 'label'
                }
            }
            let nearbySnippet: string | undefined
            if (!inferred_role && field.rect) {
                const nearby = inferRoleFromNearbyText(input.extracted, {
                    page: field.page,
                    rect: field.rect,
                })
                if (nearby) {
                    inferred_role = nearby.role
                    nearbySnippet = nearby.snippet
                    role_source = 'nearby text'
                }
            }

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
                    ? `Role from ${role_source}${nearbySnippet ? `: "${nearbySnippet}"` : ` "${field.fieldName}"`}`
                    : `Sig widget "${field.fieldName}" — no role pattern matched`,
            })
        }
        return detections
    }
}

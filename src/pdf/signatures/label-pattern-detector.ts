/**
 * Label-pattern signature detector.
 *
 * Many government and legacy forms use plain *text* AcroForm fields labeled
 * "Signature" / "Signed by" / "X" / role+signature instead of the proper
 * `/Sig` widget type. The AcroForm detector only catches `/Sig` fields;
 * this one finds the text-field-as-signature pattern.
 *
 * Heuristic: any AcroForm text field whose name OR label contains a
 * signature keyword. Combined with role inference from the same name/label
 * to figure out who's signing.
 */

import { extractAcroForm } from '../forms/acroform-extractor'
import { inferRoleFromFieldName, inferRoleFromNearbyText } from './role-inference'
import type {
    DetectedSignature,
    SignatureDetector,
    SignatureDetectorInput,
} from './types'

const SIGNATURE_LABEL_RE =
    /\b(signature|signed\s*by|sign\s*here|initial(?:s|ed)?|autograph|sign-?off)\b/i

export class LabelPatternSignatureDetector implements SignatureDetector {
    readonly name = 'label_pattern'

    async detect(input: SignatureDetectorInput): Promise<DetectedSignature[]> {
        const acroform = await extractAcroForm({
            data: input.rawBytes,
            password: input.password,
        }).catch(() => ({ fields: [], hasFields: false }))

        const detections: DetectedSignature[] = []
        let counter = 0
        for (const field of acroform.fields) {
            // Only text-type fields — Sig widgets handled by AcroForm detector.
            if (field.kind !== 'text' && field.kind !== 'unknown') continue

            const haystack = `${field.fieldName} ${field.label}`
            if (!SIGNATURE_LABEL_RE.test(haystack)) continue

            counter++
            let inferred_role =
                inferRoleFromFieldName(field.fieldName)
                ?? inferRoleFromFieldName(field.label)
            // Fall back to surrounding-text inference when neither name nor
            // label contains a role keyword — covers form-builder-generated
            // random IDs and labels like "Provide R Signature".
            let nearbySnippet: string | undefined
            if (!inferred_role && field.rect) {
                const nearby = inferRoleFromNearbyText(input.extracted, {
                    page: field.page,
                    rect: field.rect,
                })
                if (nearby) {
                    inferred_role = nearby.role
                    nearbySnippet = nearby.snippet
                }
            }

            const valuePresent =
                typeof field.value === 'string' && field.value.length > 0

            // Treat as widget_unsigned (text-field-as-signature is unsigned by
            // design — there's nothing cryptographic about it). When the user
            // has typed a name into the field, kind stays unsigned but the
            // value flows through normally.
            const confidence = inferred_role
                ? valuePresent ? 0.85 : 0.7
                : 0.55

            detections.push({
                id: `sig_l_${counter}`,
                kind: 'widget_unsigned',
                page: field.page,
                rect: field.rect,
                field_name: field.fieldName,
                inferred_role,
                confidence,
                notes:
                    `Text-field-as-signature: name="${field.fieldName}", `
                    + `label="${field.label}"`
                    + (inferred_role
                        ? nearbySnippet
                            ? `, role from nearby text: "${nearbySnippet}"`
                            : `, role from field`
                        : ''),
            })
        }
        return detections
    }
}

import { createAction, Property } from '@activepieces/pieces-framework'
import { openPdfDocument } from '@thinkfleet/agentmark'
import { resolveBytes, bytesToBase64DataUri } from '../common'

export const fillPdfForm = createAction({
    name: 'fill_pdf_form',
    displayName: 'Fill PDF Form',
    description:
        'Fill an AcroForm PDF in one atomic step. Pass a values object keyed '
        + 'by AgentMark action ID OR by original field name; the action '
        + 'matches either. Returns the filled PDF as a base64 data URI.',
    props: {
        source: Property.LongText({
            displayName: 'PDF Source',
            description:
                'HTTP(S) URL, file path, file:// URI, data: URI, or base64 string.',
            required: true,
        }),
        values: Property.Json({
            displayName: 'Field Values',
            description:
                'Object mapping field IDs (action IDs like `act_field_1`) or '
                + 'field names (e.g. `applicant.first_name`) to values. '
                + 'Strings for text/select/radio, booleans for checkboxes, '
                + 'arrays for multi-select.',
            required: true,
            defaultValue: {},
        }),
        flatten: Property.Checkbox({
            displayName: 'Flatten',
            description:
                'Bake values into page content. Resulting PDF is no longer fillable.',
            required: false,
            defaultValue: false,
        }),
        return_format: Property.StaticDropdown({
            displayName: 'Return Format',
            description: 'How the filled PDF is returned in the action output.',
            required: false,
            defaultValue: 'data_uri',
            options: {
                disabled: false,
                options: [
                    { label: 'Base64 data URI', value: 'data_uri' },
                    { label: 'Raw base64 (no scheme)', value: 'base64' },
                ],
            },
        }),
        password: Property.ShortText({
            displayName: 'Password',
            description: 'Password for encrypted PDFs.',
            required: false,
        }),
    },
    async run(context) {
        const { source, values, flatten, return_format, password } = context.propsValue
        const data = await resolveBytes(source)
        const doc = await openPdfDocument({
            data,
            sourceUrl: source.startsWith('http') ? source : 'inline:pdf',
            password,
        })

        try {
            const valuesMap = (values ?? {}) as Record<string, unknown>

            // Build action-id-keyed dispatch map from BOTH action IDs and
            // original field names. Caller can use whichever is convenient.
            const actionIdByName = new Map<string, string>()
            for (const [actionId, field] of doc.fields) {
                actionIdByName.set(field.fieldName, actionId)
            }

            const summary: Array<{ key: string; resolved_action_id: string }> = []
            const skipped: string[] = []

            for (const [key, value] of Object.entries(valuesMap)) {
                const resolved = doc.fields.has(key)
                    ? key
                    : actionIdByName.get(key)
                if (!resolved) {
                    skipped.push(key)
                    continue
                }
                await doc.execute(resolved, value)
                summary.push({ key, resolved_action_id: resolved })
            }

            const filled = await doc.save({ flatten: flatten === true })
            const out = return_format === 'base64'
                ? Buffer.from(filled).toString('base64')
                : bytesToBase64DataUri(filled)

            return {
                filled_pdf: out,
                bytes: filled.length,
                fields_applied: summary,
                fields_skipped: skipped,
                flattened: flatten === true,
            }
        } finally {
            await doc.close()
        }
    },
})

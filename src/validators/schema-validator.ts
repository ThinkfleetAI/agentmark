import Ajv2020 from 'ajv/dist/2020'
import type { ErrorObject, ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import * as fs from 'fs'
import * as path from 'path'
import type { Snapshot } from '../types'
import { extractTagReferences } from '../serializers/body-text'

const validatorCache = new Map<string, ValidateFunction>()

/**
 * Resolve the schema major.minor for a declared agentmark version. We accept
 * any patch version of a known major.minor (e.g. "0.1.3" matches v0.1).
 * Unknown versions fall back to the highest known schema and emit a warning
 * elsewhere — see `validateSnapshot` cross-field check 2e.
 */
function resolveSchemaVersion(declared: string): '0.1' | '0.2' {
    const [major, minor] = declared.split('.')
    const minorMajor = `${major}.${minor}`
    if (minorMajor === '0.1') return '0.1'
    return '0.2'
}

function loadValidator(version: '0.1' | '0.2'): ValidateFunction {
    const cached = validatorCache.get(version)
    if (cached) return cached

    const ajv = new Ajv2020({ allErrors: true, strict: false })
    // ajv-formats ships its own nested ajv version; the cast bridges the type mismatch.
    // The runtime is identical (same JSON Schema spec).
    addFormats(ajv as unknown as Parameters<typeof addFormats>[0])

    const schemaPath = path.join(__dirname, '..', '..', 'schema', `agentmark-v${version}.json`)
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'))
    const validator = ajv.compile(schema)
    validatorCache.set(version, validator)
    return validator
}

export interface ValidationIssue {
    severity: 'error' | 'warning'
    path: string
    message: string
}

export interface ValidationResult {
    valid: boolean
    errors: ValidationIssue[]
    warnings: ValidationIssue[]
}

/**
 * Validate a Snapshot against the agentmark v0.1 JSON Schema, plus
 * additional cross-field invariants the schema can't express:
 *  - body action references must exist in `actions` or `media`
 *  - precondition_ids must reference existing actions
 *  - region_id must reference an existing modal/tab/disclosure action
 *  - target_id must reference an existing action (for `drag`)
 */
export function validateSnapshot(snapshot: Snapshot): ValidationResult {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    // 1. Schema validation (frontmatter only) — pick schema by declared version
    const schemaVersion = resolveSchemaVersion(snapshot.agentmark)
    const validator = loadValidator(schemaVersion)
    const { body, ...envelope } = snapshot
    const valid = validator(envelope)
    if (!valid && validator.errors) {
        for (const err of validator.errors) {
            errors.push({
                severity: 'error',
                path: err.instancePath || '/',
                message: ajvMessage(err),
            })
        }
    }

    // 2. Cross-field invariants
    const actionIds = new Set(Object.keys(snapshot.actions ?? {}))
    const mediaIds = new Set(Object.keys(snapshot.media ?? {}))

    // 2a. Body references must resolve
    // Action-resolving tags: ACTION, INPUT, NAV, TOAST — must match an action
    // Media-resolving tags:  MEDIA — must match a media entry
    // Region/structural tags: MODAL, TAB, DISCLOSURE — IDs are local labels, not action IDs
    // Payload-carrying tags (no lookup): ERROR, CHALLENGE
    // No-payload tags: AUTH_WALL
    const ACTION_RESOLVING = new Set(['ACTION', 'INPUT', 'NAV', 'TOAST'])
    const MEDIA_RESOLVING = new Set(['MEDIA'])
    const SIGNATURE_RESOLVING = new Set(['SIGNATURE'])
    const PAYLOAD_TAGS = new Set(['ERROR', 'CHALLENGE'])
    // PAGE is a v0.2 structural marker for `kind: 'document'` — payload is a
    // page identifier (e.g. p_1) that does not resolve to any envelope entry.
    const STRUCTURAL_TAGS = new Set(['PAGE'])

    const signatureIds = new Set(Object.keys(snapshot.signatures ?? {}))

    const bodyRefs = extractTagReferences(body)
    for (const ref of bodyRefs) {
        if (!ref.payload) continue // AUTH_WALL etc.
        if (PAYLOAD_TAGS.has(ref.kind)) continue
        if (STRUCTURAL_TAGS.has(ref.kind)) continue
        if (ACTION_RESOLVING.has(ref.kind) && !actionIds.has(ref.payload)) {
            errors.push({
                severity: 'error',
                path: `body[${ref.position}]`,
                message: `Body references ${ref.kind}:${ref.payload} but no matching action is defined`,
            })
        }
        if (MEDIA_RESOLVING.has(ref.kind) && !mediaIds.has(ref.payload)) {
            errors.push({
                severity: 'error',
                path: `body[${ref.position}]`,
                message: `Body references ${ref.kind}:${ref.payload} but no matching media is defined`,
            })
        }
        if (SIGNATURE_RESOLVING.has(ref.kind) && !signatureIds.has(ref.payload)) {
            errors.push({
                severity: 'error',
                path: `body[${ref.position}]`,
                message: `Body references ${ref.kind}:${ref.payload} but no matching signature is defined in the envelope`,
            })
        }
        // MODAL/TAB/DISCLOSURE refs are structural — payload is a label,
        // optionally matched to an action via region_id but not required to.
    }

    // 2b. precondition_ids must exist
    for (const [id, action] of Object.entries(snapshot.actions ?? {})) {
        for (const pre of action.precondition_ids ?? []) {
            if (!actionIds.has(pre)) {
                errors.push({
                    severity: 'error',
                    path: `/actions/${id}/precondition_ids`,
                    message: `Precondition references unknown action "${pre}"`,
                })
            }
            if (pre === id) {
                errors.push({
                    severity: 'error',
                    path: `/actions/${id}/precondition_ids`,
                    message: `Action cannot precondition itself`,
                })
            }
        }
        if (action.region_id && !actionIds.has(action.region_id)) {
            warnings.push({
                severity: 'warning',
                path: `/actions/${id}/region_id`,
                message: `region_id references unknown action "${action.region_id}"`,
            })
        }
        if (action.target_id && !actionIds.has(action.target_id)) {
            errors.push({
                severity: 'error',
                path: `/actions/${id}/target_id`,
                message: `target_id references unknown action "${action.target_id}"`,
            })
        }
    }

    // 2c. Honeypot flagged but enabled — warn (likely a bug)
    for (const [id, action] of Object.entries(snapshot.actions ?? {})) {
        if (action.honeypot && !action.disabled) {
            warnings.push({
                severity: 'warning',
                path: `/actions/${id}`,
                message: `Action marked as honeypot but not disabled — agents will be tempted to interact`,
            })
        }
    }

    // 2d. cost: financial/destructive without confirms — warn (UX hint)
    for (const [id, action] of Object.entries(snapshot.actions ?? {})) {
        if ((action.cost === 'destructive' || action.cost === 'financial') && action.confirms === undefined) {
            warnings.push({
                severity: 'warning',
                path: `/actions/${id}`,
                message: `Action has cost=${action.cost} but no \`confirms\` flag set — consider true if it triggers a confirmation dialog`,
            })
        }
    }

    // 2e. version compatibility
    const major = parseInt(snapshot.agentmark.split('.')[0], 10)
    const minor = parseInt(snapshot.agentmark.split('.')[1] ?? '0', 10)
    if (major > 0 || minor > 2) {
        warnings.push({
            severity: 'warning',
            path: '/agentmark',
            message: `This validator implements v0.1 + v0.2; snapshot declares v${snapshot.agentmark}. Validated against v0.2 schema.`,
        })
    }

    // 2f. document-kind sanity (v0.2)
    if (snapshot.kind === 'document') {
        if (snapshot.state?.auth || snapshot.state?.modal_open) {
            warnings.push({
                severity: 'warning',
                path: '/state',
                message: `Web-page state fields (auth, modal_open) are unusual for kind: 'document'`,
            })
        }
    }

    return { valid: errors.length === 0, errors, warnings }
}

function ajvMessage(err: ErrorObject): string {
    return `${err.message ?? 'invalid'}${err.params ? ` (${JSON.stringify(err.params)})` : ''}`
}

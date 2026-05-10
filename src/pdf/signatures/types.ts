/**
 * Signature-detection types.
 *
 * AgentMark surfaces signatures (digital + hand-drawn + cryptographic) found
 * in a document so an agent can answer "who signed this and in what role?"
 * without reading every page.
 */

import type { ExtractedPdf } from '../types'

export type SignatureKind =
    /** AcroForm `/Sig` widget that has been signed (has appearance + cert). */
    | 'widget_visible_signed'
    /** AcroForm `/Sig` widget that is empty / awaiting a signature. */
    | 'widget_unsigned'
    /** Cryptographic PKCS#7 signature on the document — verified or not (kind says nothing about validity; see `valid` field). */
    | 'cryptographic'
    /** A signature-shaped image embedded on the page (hand-drawn scan or tablet capture). */
    | 'image_handwritten'
    /** Typed text in a script-style font near a "Signature:" label. */
    | 'image_typed'
    /** DocuSign envelope-style signature with audit trail. */
    | 'docusign'
    /** Adobe Sign envelope-style signature with audit trail. */
    | 'adobe_sign'
    /** Detected as something signature-shaped but the kind couldn't be narrowed. */
    | 'unknown'

/**
 * Inferred role of the signer. Free-form lowercase string. Common values:
 * client, agent, broker, buyer, seller, tenant, landlord, witness, notary,
 * guarantor, employer, employee, attorney, applicant. Use 'unknown' when
 * the role can't be inferred.
 */
export type SignatureRole = string

export interface DetectedSignature {
    /** Stable ID, e.g. `sig_1`. Match against `[SIGNATURE:sig_1]` body tags. */
    id: string
    kind: SignatureKind
    /** 1-indexed page where the signature was detected. */
    page: number
    /** Position on the page (PDF user space, page-local), when known. */
    rect?: { x: number; y: number; width: number; height: number }
    /** Original PDF field name when sourced from an AcroForm Sig widget. */
    field_name?: string
    /** Inferred role of the signer (client, agent, witness, etc.). */
    inferred_role?: SignatureRole
    /** Signer's name — from a cert subject, surrounding text, or DocuSign audit. */
    signer_name?: string
    /** Signer's email — from a cert or audit trail. */
    signer_email?: string
    /** ISO 8601 timestamp when the signature was applied, when known. */
    signed_at?: string
    /** Confidence the detection is real and the role/name are correct (0-1). */
    confidence: number
    /** For cryptographic sigs: validation result, when checked. */
    valid?: boolean
    /** Free-form notes — surrounding text snippet, label match, etc. */
    notes?: string
}

/**
 * A detector turns extracted PDF data into a list of DetectedSignature.
 * Implementations run independently; the pipeline merges results across
 * detectors and deduplicates overlapping detections by page + rect overlap.
 */
export interface SignatureDetector {
    /** Implementation name — surfaced in detection notes for debugging. */
    readonly name: string
    detect(input: SignatureDetectorInput): Promise<DetectedSignature[]>
}

export interface SignatureDetectorInput {
    /** Extracted PDF (text items per page, metadata). */
    extracted: ExtractedPdf
    /** Raw PDF bytes — needed by detectors that call back into pdfjs/poppler. */
    rawBytes: Uint8Array
    /** Optional password for encrypted PDFs. */
    password?: string
}

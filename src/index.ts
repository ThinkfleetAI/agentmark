// @thinkfleet/agentmark — reference implementation of the agentmark spec
// MIT License | https://github.com/ThinkfleetAI/agentmark
// Spec: docs/specs/agentmark-v0.1.md

export { AGENTMARK_VERSION, SUPPORTED_SPEC_VERSIONS } from './types'
export type {
    Snapshot,
    SnapshotSource,
    SnapshotKind,
    DocumentMeta,
    PageState,
    ActionType,
    ActionCost,
    ActionDefinition,
    AriaState,
    MediaDefinition,
    MemoryHints,
    RendererCapabilities,
    CookieState,
    PermissionState,
    BodyTagKind,
    BodyTagReference,
    ConversionResult,
    ActionBinding,
} from './types'

export { serializeSnapshot, parseSnapshot } from './serializers/yaml-frontmatter'
export {
    escapeBodyText,
    renderTag,
    hasTagReference,
    extractTagReferences,
} from './serializers/body-text'
export { convertToJson, convertFromJson } from './serializers/json-export'
export type { JsonSnapshot, BodyNode } from './serializers/json-export'

export { validateSnapshot } from './validators/schema-validator'
export type { ValidationResult, ValidationIssue } from './validators/schema-validator'

export { convertPage, buildSnapshot } from './converter'
export type { ConvertOptions } from './converter'

export { waitForPageReady } from './wait/wait-strategy'
export type { WaitMode, WaitOptions } from './wait/wait-strategy'

export { observeMutations } from './wait/mutation-observer'
export type { ObservedMutation, ObserveOptions, MutationObserverHandle } from './wait/mutation-observer'

export { resolveChallenge } from './wait/challenge-resolver'
export type { ChallengeResolverOptions, ChallengeResult } from './wait/challenge-resolver'

export { InMemoryActionBinding } from './binding/action-binding'

export { buildBody } from './extractors/body-builder'
export { EXTRACTOR_SCRIPT } from './extractors/dom-extractor'
export type { RawExtraction, RawAction, RawMedia, BodySegment } from './extractors/dom-extractor'

// ── M1 Pass 1: runtime, errors, observability, branded IDs ───────────────

export { ActionId, MediaId, RegionId } from './ids/branded'

export {
    AgentMarkError,
    SnapshotError,
    ExecutionError,
    ActionNotFoundError,
    ActionDisabledError,
    ActionTypeError,
    ElementNotFoundError,
    ExecutionTimeoutError,
    SessionError,
    isAgentMarkError,
} from './errors'

export { noopLogger, consoleLogger } from './observability/logger'
export type { Logger } from './observability/logger'
export type { AgentMarkEvent } from './observability/events'

export {
    executeAction,
    DEFAULT_ACTION_TIMEOUT_MS,
} from './runtime/action-executor'
export type { ExecuteOptions, ExecutionResult } from './runtime/action-executor'

// ── M1 Pass 2: SDK surface (Browser / Page / session persistence) ────────

export { Browser, createBrowser, Page } from './runtime'
export type {
    CreateBrowserOptions,
    PageSnapshot,
    PageNavigationOptions,
} from './runtime'

export {
    saveSessionToFile,
    loadSessionFromFile,
    SESSION_FORMAT_VERSION,
} from './runtime/session'
export type { SessionFile, StorageState } from './runtime/session'

// ── M2: PDF / document support (kind: 'document') ─────────────────────────

export {
    convertPdf,
    extractPdf,
    buildBodyFromPdf,
} from './pdf'
export type {
    ConvertPdfOptions,
    ExtractPdfOptions,
    BuildPdfBodyOptions,
    PdfDocument,
    PdfDocumentMeta,
    PdfPage,
    PdfTextItem,
    PdfBlock,
} from './pdf'

// ── v0.5: OCR + render backends (Tesseract / Mistral / Poppler / pdfjs) ──

export {
    PopplerRenderBackend,
    PdfjsRenderBackend,
    TesseractOcrBackend,
    MistralOcrBackend,
} from './pdf'
export type {
    PopplerRenderOptions,
    TesseractBackendOptions,
    MistralOcrOptions,
    RenderBackend,
    RenderPageOptions,
    RenderedPage,
    OcrBackend,
    OcrPageOptions,
    OcrPageResult,
    OcrPipelineOptions,
} from './pdf'

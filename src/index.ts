// @thinkfleet/agentmark — reference implementation of the agentmark spec
// MIT License | https://github.com/ThinkfleetAI/agentmark
// Spec: docs/specs/agentmark-v0.1.md

export { AGENTMARK_VERSION } from './types'
export type {
    Snapshot,
    SnapshotSource,
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

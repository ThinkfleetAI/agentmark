/**
 * Catalog of structured event names emitted by AgentMark.
 *
 * Event names follow `<subject>.<verb>` convention, dot-delimited.
 * Names are stable across releases and follow semver — renaming an event
 * requires a major version bump.
 *
 * Use this type to constrain event names in custom logger wrappers; AgentMark
 * itself accepts any string for forward-compatibility with vendor extensions.
 *
 * @example
 *   import { type AgentMarkEvent } from '@thinkfleet/agentmark'
 *   const events: AgentMarkEvent[] = ['snapshot.captured', 'action.execute.complete']
 */
export type AgentMarkEvent =
    // Snapshot lifecycle
    | 'snapshot.capture.start'
    | 'snapshot.captured'
    | 'snapshot.failed'

    // Action execution lifecycle
    | 'action.execute.start'
    | 'action.execute.complete'
    | 'action.execute.failed'
    | 'action.execute.skipped'

    // Page navigation
    | 'navigation.start'
    | 'navigation.complete'
    | 'navigation.failed'

    // Session persistence
    | 'session.save.start'
    | 'session.saved'
    | 'session.load.start'
    | 'session.loaded'
    | 'session.failed'

    // Wait strategies
    | 'wait.network_idle'
    | 'wait.mutation_stable'
    | 'wait.timeout'

    // Cookie / consent / challenge handling
    | 'cookie.banner.dismissed'
    | 'challenge.detected'
    | 'challenge.resolved'
    | 'challenge.failed'

/**
 * Desktop support — convertDesktop() + accessibility-tree capture backends.
 */

export { convertDesktop } from './desktop-converter'
export type { ConvertDesktopOptions } from './desktop-converter'

export { FixtureBackend } from './fixture-backend'
export type { FixtureBackendOptions } from './fixture-backend'

export type {
    DesktopCaptureBackend,
    CaptureDesktopOptions,
    DesktopCapture,
    DesktopElement,
    DesktopRole,
    DesktopTarget,
    ExecuteDesktopOptions,
    ExecuteDesktopAction,
    ExecuteDesktopResult,
    KeyModifier,
} from './types'

export { buildDesktopBody } from './body-builder'
export type { BuildDesktopBodyResult } from './body-builder'

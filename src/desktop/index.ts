/**
 * Desktop support — convertDesktop() + accessibility-tree capture backends.
 */

export { convertDesktop } from './desktop-converter'
export type { ConvertDesktopOptions, DesktopConversionResult } from './desktop-converter'

export { diffDesktopCaptures } from './diff'
export type {
    DesktopDiff,
    DesktopElementChange,
    DesktopElementSummary,
} from './diff'

export { FixtureBackend } from './fixture-backend'
export type { FixtureBackendOptions } from './fixture-backend'

export { WindowsUiaBackend } from './windows-uia-backend'
export type { WindowsUiaBackendOptions } from './windows-uia-backend'

export { MacosAxapiBackend } from './macos-axapi-backend'
export type { MacosAxapiBackendOptions } from './macos-axapi-backend'

export type {
    DesktopCaptureBackend,
    CaptureDesktopOptions,
    DesktopCapture,
    DesktopElement,
    DesktopRole,
    DesktopTarget,
    ExecuteDesktopOptions,
    ExecuteDesktopAction,
    ExecuteDesktopBatchOptions,
    ExecuteDesktopBatchResult,
    ExecuteDesktopResult,
    KeyModifier,
} from './types'

export { buildDesktopBody } from './body-builder'
export type { BuildDesktopBodyResult } from './body-builder'

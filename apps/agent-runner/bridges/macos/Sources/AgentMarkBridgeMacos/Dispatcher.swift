// Method routing. New methods land here; the same name/shape as the
// Windows bridge so the Node-side `MacosAxapiBackend` (Phase 0f') can
// mirror `WindowsUiaBackend` exactly.

import Foundation

final class Dispatcher {
    private let bridgeVersion: String

    // AXAPI is fine to call from the main thread; we don't currently
    // need a dedicated serial queue. If we ever do, this is where the
    // dispatch boundary goes.
    private lazy var capturer = AxapiCapturer()

    init(bridgeVersion: String) {
        self.bridgeVersion = bridgeVersion
    }

    func dispatch(request: JsonRpcRequest) throws -> Any {
        do {
            switch request.method {
            case "ping":
                return handlePing()
            case "capabilities":
                return handleCapabilities()
            case "list_windows":
                return try handleListWindows()
            case "capture":
                return try handleCapture(params: request.params)
            default:
                throw RpcError(
                    code: .methodNotFound,
                    message: "Unknown method: \(request.method). Supported: ping, capabilities, list_windows, capture.",
                    requestId: request.id
                )
            }
        } catch var rpcError as RpcError {
            rpcError.requestId = request.id
            throw rpcError
        }
    }

    private func handlePing() -> Any {
        return [
            "pong": true,
            "version": bridgeVersion,
            "arch": currentArchString(),
            "processId": ProcessInfo.processInfo.processIdentifier,
        ] as [String: Any]
    }

    private func handleCapabilities() -> Any {
        return [
            "bridge": "agentmark-bridge-macos",
            "version": bridgeVersion,
            "methods": ["ping", "capabilities", "list_windows", "capture"],
            "axapiProvider": "Accessibility (AXAPI)",
            "platform": "macos",
            "accessibilityGranted": AccessibilityPermission.isGranted,
        ] as [String: Any]
    }

    private func handleListWindows() throws -> Any {
        let windows = try capturer.listWindows()
        return ["windows": windows] as [String: Any]
    }

    private func handleCapture(params: JsonValue?) throws -> Any {
        var req = AxapiCapturer.CaptureRequest()
        if let p = params {
            if let s = p.string("processName") { req.processName = s }
            if let i = p.int("processId") { req.processId = i }
            if let s = p.string("windowTitle") { req.windowTitle = s }
            if let s = p.string("windowId") { req.windowId = s }
            if let i = p.int("maxDepth") { req.maxDepth = i }
            if let b = p.bool("includeHidden") { req.includeHidden = b }
            if let i = p.int("timeoutMs") { req.timeoutMs = i }
            if let i = p.int("maxElements") { req.maxElements = i }
        }
        return try capturer.capture(req)
    }
}

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
            case "execute":
                return try handleExecute(params: request.params)
            case "execute_batch":
                return try handleExecuteBatch(params: request.params)
            default:
                throw RpcError(
                    code: .methodNotFound,
                    message: "Unknown method: \(request.method). Supported: ping, capabilities, list_windows, capture, execute, execute_batch.",
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
            "methods": ["ping", "capabilities", "list_windows", "capture", "execute", "execute_batch"],
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

    private func handleExecute(params: JsonValue?) throws -> Any {
        guard let p = params else {
            throw RpcError(code: .invalidParams, message: "execute requires params.")
        }
        let req = try buildExecuteRequest(p)
        return try capturer.execute(req)
    }

    /// Run N actions in one in-process loop so the entire batch costs one
    /// stdio round-trip. `onError: stop` (default) aborts on the first
    /// failure; `onError: continue` runs the full array regardless.
    private func handleExecuteBatch(params: JsonValue?) throws -> Any {
        guard let p = params,
              let actionsAny = p.dict?["actions"],
              case .array(let actionArray) = JsonValue.fromAny(actionsAny) else {
            throw RpcError(code: .invalidParams, message: "execute_batch requires an `actions` array.")
        }

        let stopOnError = (p.string("onError") ?? "stop") != "continue"

        var results: [[String: Any]] = []
        results.reserveCapacity(actionArray.count)
        var allOk = true

        for actionAny in actionArray {
            let actionParam = JsonValue.fromAny(actionAny)
            let req: AxapiCapturer.ExecuteRequest
            do {
                req = try buildExecuteRequest(actionParam)
            } catch {
                results.append(["ok": false, "message": "\(error)"])
                allOk = false
                if stopOnError { break }
                continue
            }
            let r = try capturer.execute(req)
            // `capturer.execute` returns `[String: Any]` with `ok` / `message` / `newValue`.
            let normalized = r as? [String: Any] ?? [:]
            results.append(normalized)
            if let ok = normalized["ok"] as? Bool, !ok {
                allOk = false
                if stopOnError { break }
            }
        }

        return [
            "results": results,
            "allOk": allOk,
            "executedCount": results.count,
        ] as [String: Any]
    }

    private func buildExecuteRequest(_ p: JsonValue) throws -> AxapiCapturer.ExecuteRequest {
        guard let elementId = p.string("elementId"), !elementId.isEmpty else {
            throw RpcError(code: .invalidParams, message: "execute action requires `elementId`.")
        }
        var req = AxapiCapturer.ExecuteRequest()
        req.elementId = elementId
        req.actionType = p.string("actionType") ?? "click"
        req.text = p.string("text")
        req.value = p.string("value")
        req.checked = p.bool("checked")
        req.expanded = p.bool("expanded")
        req.key = p.string("key")
        if let modsAny = p.dict?["modifiers"], case .array(let arr) = JsonValue.fromAny(modsAny) {
            req.modifiers = arr.compactMap { $0 as? String }
        }
        req.clearFirst = p.bool("clearFirst") ?? false
        if let i = p.int("timeoutMs") { req.timeoutMs = i }
        return req
    }
}

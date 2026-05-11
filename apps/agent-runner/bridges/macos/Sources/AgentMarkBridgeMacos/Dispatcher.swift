// Method routing. New methods land here; the same name/shape as the
// Windows bridge so the Node-side `MacosAxapiBackend` (Phase 0f') can
// mirror `WindowsUiaBackend` exactly.

import Foundation

final class Dispatcher {
    private let bridgeVersion: String

    init(bridgeVersion: String) {
        self.bridgeVersion = bridgeVersion
    }

    func dispatch(request: JsonRpcRequest) throws -> Any {
        switch request.method {
        case "ping":
            return handlePing()
        case "capabilities":
            return handleCapabilities()
        default:
            throw RpcError(
                code: .methodNotFound,
                message: "Unknown method: \(request.method). Supported: ping, capabilities.",
                requestId: request.id
            )
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
            "methods": ["ping", "capabilities"],
            "axapiProvider": "Accessibility (AXAPI)",
            "platform": "macos",
        ] as [String: Any]
    }
}

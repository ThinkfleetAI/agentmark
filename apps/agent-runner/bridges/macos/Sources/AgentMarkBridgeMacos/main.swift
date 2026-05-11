// AgentMark macOS AXAPI Bridge
// ----------------------------
// Stdio JSON-RPC 2.0 server. Parent process (typically the Node-side
// `MacosAxapiBackend` running inside the AgentMark MCP server) launches
// this binary and talks to it over stdin/stdout. One line of JSON per
// message.
//
// Protocol — identical to the Windows bridge:
//   Request : { "jsonrpc": "2.0", "id": <any>, "method": "<name>", "params": {...} }
//   Response: { "jsonrpc": "2.0", "id": <same>, "result": {...} }   on success
//             { "jsonrpc": "2.0", "id": <same>, "error": { "code": N, "message": "..." } }  on failure
//
// All diagnostic output goes to stderr — never stdout — so the framing
// stays clean.
//
// Methods (this phase):
//   ping        — returns { pong, version, arch, processId }
//   capabilities— returns { bridge, version, methods, axapiProvider, platform }
//
// Future:
//   list_windows— enumerate top-level windows visible to AXAPI
//   capture     — walk AXAPI tree → DesktopCapture JSON
//   execute     — drive an action by element_id (AXPress / AXSetValue / etc.)
//
// AXAPI permission note: macOS guards Accessibility API access behind
// System Settings → Privacy & Security → Accessibility. The parent
// process (Claude Desktop, AgentMark MCP server) must be granted
// permission OR this bridge binary itself must be granted. We probe
// AXIsProcessTrusted() on startup and surface a clear error on first
// list_windows/capture if not granted.

import Foundation

let bridgeVersion = "0.4.0"

let stderr = FileHandle.standardError
stderr.write("[bridge] agentmark-bridge-macos starting (pid=\(ProcessInfo.processInfo.processIdentifier), arch=\(currentArchString()))\n".data(using: .utf8)!)

let dispatcher = Dispatcher(bridgeVersion: bridgeVersion)

// Read newline-delimited JSON from stdin until EOF.
while let line = readLine(strippingNewline: true) {
    let trimmed = stripBom(line.trimmingCharacters(in: .whitespacesAndNewlines))
    if trimmed.isEmpty { continue }

    do {
        let request = try JsonRpcRequest.decode(jsonString: trimmed)
        let result = try dispatcher.dispatch(request: request)
        let response = JsonRpcResponse.success(id: request.id, result: result)
        writeLine(try response.encode())
    } catch let rpcError as RpcError {
        let response = JsonRpcResponse.error(id: rpcError.requestId, code: rpcError.code, message: rpcError.message)
        writeLine((try? response.encode()) ?? "{}")
    } catch {
        // Last-resort fallback for genuinely unexpected exceptions.
        let response = JsonRpcResponse.error(
            id: .null,
            code: RpcErrorCode.internalError.rawValue,
            message: "Unhandled: \(error)"
        )
        writeLine((try? response.encode()) ?? "{}")
        stderr.write("[bridge] unhandled: \(error)\n".data(using: .utf8)!)
    }
}

stderr.write("[bridge] stdin closed; exiting\n".data(using: .utf8)!)

// MARK: - I/O helpers

func writeLine(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

/// Strips the U+FEFF byte-order mark some clients (PowerShell, certain
/// shells) prepend to the first stdin write. Keeps JSON parsing happy.
func stripBom(_ s: String) -> String {
    if s.first == "\u{FEFF}" {
        return String(s.dropFirst())
    }
    return s
}

func currentArchString() -> String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

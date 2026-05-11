# AgentMark Windows UIA Bridge

The Windows-side sidecar process for AgentMark Desktop. Walks the OS
accessibility tree via UIA (using [FlaUI](https://github.com/FlaUI/FlaUI),
MIT) and exposes capture/execute operations the Node-side
`WindowsUiaBackend` consumes through stdio JSON-RPC.

This is one implementation of the `DesktopCaptureBackend` interface
defined in `@thinkfleet/agentmark` v0.4. macOS (AXAPI) and Linux (AT-SPI)
bridges follow the same protocol.

## Build

Requires the .NET 8 SDK. From this directory:

```powershell
dotnet build
```

Output exe: `bin\Debug\net8.0-windows\agentmark-bridge-windows.exe`.

## Run + smoke test

The bridge speaks stdio JSON-RPC 2.0. One JSON message per line.

```powershell
.\bin\Debug\net8.0-windows\agentmark-bridge-windows.exe
```

It blocks waiting on stdin. Paste a `ping`:

```
{"jsonrpc":"2.0","id":1,"method":"ping"}
```

Expected response (single line, here pretty-printed):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "pong": true,
    "version": "0.4.0",
    "arch": "arm64",
    "processId": 12345
  }
}
```

Ctrl-Z then Enter closes stdin and the bridge exits cleanly.

## Protocol

All responses are JSON-RPC 2.0. Diagnostic output goes to stderr only —
stdout is reserved for framed JSON messages.

| Method | Status | Description |
|---|---|---|
| `ping` | Phase 0e1 ✅ | Liveness check, returns pong + bridge version |
| `capabilities` | Phase 0e1 ✅ | Lists supported methods and UIA provider info |
| `list_windows` | Phase 0e2 (planned) | Enumerate top-level windows visible to UIA |
| `capture` | Phase 0e2 (planned) | Walk a window's UIA tree → `DesktopCapture` JSON |
| `execute` | Phase 0e3 (planned) | Drive an action by element_id (click/type/select/etc.) |

## Architecture notes

- **Single-threaded for now.** UIA is COM-STA; once `capture` / `execute`
  land we marshal those calls onto a dedicated STA thread.
- **UTF-8 forced on both pipes.** Windows defaults will mangle non-ASCII
  in window titles / cell values otherwise.
- **All stderr goes to the parent process's stderr.** Useful for log
  aggregation in the AgentMark MCP server when this bridge is spawned
  as a subprocess.

## Security posture

This bridge runs as the logged-in user (never SYSTEM/admin). It can
only see/drive windows that user can already see/drive — no privilege
escalation. Stdio mode has zero network surface; only the parent
process that spawned this exe can write to its stdin.

A future `--transport=ws` mode (Phase 0f) will add a localhost-only
WebSocket transport with auth-token gating, origin-header rejection,
and process-identity verification for multi-consumer scenarios.

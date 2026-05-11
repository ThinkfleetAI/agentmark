# AgentMark macOS AXAPI Bridge

The macOS-side sidecar process for AgentMark Desktop. Mirrors the
Windows UIA bridge — same stdio JSON-RPC 2.0 protocol, same
`DesktopCaptureBackend` contract on the Node side. Uses the system
Accessibility framework (AXAPI) to walk and drive native macOS app UIs.

## Build

Requires the Swift toolchain (ships with Xcode Command Line Tools, or
`xcode-select --install`). From this directory:

```bash
swift build
```

Output binary: `.build/debug/agentmark-bridge-macos`.

For a release build with optimisations:

```bash
swift build -c release
# Binary at .build/release/agentmark-bridge-macos
```

## Run + smoke test

The bridge speaks stdio JSON-RPC 2.0. One JSON message per line.

```bash
./scripts/smoke-test.sh
```

That pipes two requests (`ping` + `capabilities`) into the binary,
validates the responses, prints the bridge's stderr diagnostics.

For interactive testing:

```bash
.build/debug/agentmark-bridge-macos
```

It blocks on stdin. Paste:

```
{"jsonrpc":"2.0","id":1,"method":"ping"}
```

Expected (single line):

```json
{"jsonrpc":"2.0","id":1,"result":{"pong":true,"version":"0.4.0","arch":"arm64","processId":12345}}
```

Ctrl-D closes stdin and the bridge exits cleanly.

## Protocol

All responses are JSON-RPC 2.0. Diagnostic output goes to stderr only —
stdout is reserved for framed JSON messages.

| Method | Status | Description |
|---|---|---|
| `ping` | ✅ this phase | Liveness check, returns pong + bridge version |
| `capabilities` | ✅ this phase | Lists supported methods + AXAPI provider info |
| `list_windows` | planned | Enumerate top-level AXAPI windows via NSWorkspace + AXUIElement |
| `capture` | planned | Walk a window's AXAPI tree → `DesktopCapture` JSON |
| `execute` | planned | Drive an action by element_id (AXPress / AXSetValue / etc.) |

The protocol — request/response envelopes, error codes, BOM-stripping —
is byte-identical to the Windows bridge. The Node-side
`MacosAxapiBackend` will be a near-exact mirror of `WindowsUiaBackend`.

## Accessibility permission

macOS guards AXAPI behind **System Settings → Privacy & Security →
Accessibility**. When the bridge starts walking trees (Phase 0e'2+),
the parent process (or this binary, if launched directly) must be
granted. The bridge will probe `AXIsProcessTrusted()` and surface a
clear `accessibilityNotGranted` JSON-RPC error if not.

For developer machines: grant the terminal you launch from (Terminal /
iTerm / Warp). For production / Claude Desktop integration: Claude
Desktop itself must be granted (it's the parent process that spawns
this bridge).

## Architecture

- **Single-threaded.** AXAPI calls are not strictly main-thread-only but
  CFRunLoop integration matters; for capture/execute we'll route through
  a dedicated serial DispatchQueue. For ping/capabilities the entry-point
  thread is fine.
- **UTF-8 only.** stdin / stdout treated as UTF-8 throughout; BOM stripped
  defensively from the first stdin write.
- **stderr for diagnostics, stdout for framed JSON.** Same discipline as
  the Windows bridge so log aggregation works in the AgentMark MCP server.

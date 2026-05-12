# AgentMark Installers

This directory builds **production installers** for the agentmark MCP
server + bridges, bundled with a pinned Node runtime so end users
don't need to install Node themselves.

## What ships

Each installer drops these files onto the target machine:

| Platform | Install path | Contents |
|---|---|---|
| macOS | `/opt/thinkfleet/agentmark/` | `node` (arm64 + x64 universal), `agentmark/` (npm package), `bridges/agentmark-bridge-macos` (Swift AXAPI binary), `bin/agentmark-mcp` launcher script |
| Windows | `C:\Program Files\ThinkFleet\AgentMark\` | `node.exe`, `agentmark\` (npm package), `bridges\agentmark-bridge-windows.exe` (.NET UIA), `agentmark-mcp.cmd` launcher (added to PATH) |

Both installers add an `agentmark-mcp` command to the user's PATH that
runs the bundled Node against the bundled agentmark package.

## What's NOT bundled

- **Playwright Chromium.** Adds ~150MB and most users won't need the
  browser-driving plugin. The installer wires up a post-install step
  that runs `playwright install chromium` only if the user opted in.
- **Activepieces backend.** That's a separate service the user
  configures via env vars when they want the cloud-backed Memory.

## Building

### macOS

Requires: macOS host, Xcode CLI tools, Swift 5.9+.

```sh
./packaging/scripts/build-macos.sh
# Produces: dist/installer/AgentMark-<version>-macos.pkg
```

### Windows

Requires: Windows host (or GitHub Actions windows-latest), .NET 8 SDK,
WiX Toolset 4.

```ps1
.\packaging\scripts\build-windows.ps1
# Produces: dist\installer\AgentMark-<version>-windows.msi
```

### Linux (future)

AppImage scaffolding lives in a follow-up PR.

## Code signing

Signing is **optional** in the build scripts — they detect required
secrets and run signing steps only when present. The full release
flow is meant to run in GitHub Actions, which injects certs from
encrypted secrets.

**macOS:** requires an Apple Developer ID Application certificate
imported into the runner's keychain. Set these GitHub secrets:

- `APPLE_DEVELOPER_ID` — Common Name of the cert (e.g.
  `Developer ID Application: ThinkFleet AI, Inc. (TEAMID)`)
- `APPLE_APP_NOTARIZATION_USER` — your App Store Connect Apple ID
- `APPLE_APP_NOTARIZATION_TEAM_ID` — 10-char team ID
- `APPLE_APP_NOTARIZATION_PASSWORD` — app-specific password
- `APPLE_CERT_P12_BASE64` — base64 of the .p12 file (export from
  Keychain Access)
- `APPLE_CERT_P12_PASSWORD` — password protecting the .p12

**Windows:** requires an Authenticode code-signing certificate.

- `WINDOWS_CERT_PFX_BASE64` — base64 of the .pfx
- `WINDOWS_CERT_PFX_PASSWORD` — password protecting the .pfx

Without these secrets, the build scripts skip signing and produce
unsigned artifacts (suitable for internal testing; macOS Gatekeeper +
Windows SmartScreen will warn end users).

## Release flow

Tag a release (e.g. `v0.12.0`). GitHub Actions builds all platforms
in parallel and uploads artifacts to the GitHub Release. See
`.github/workflows/release.yml`.

## Pinned versions

| Component | Version | Where |
|---|---|---|
| Node | 22.11.0 (LTS) | `packaging/scripts/common.sh:NODE_VERSION` |
| .NET | 8.0 | bridge `csproj` |
| Swift | 5.9+ | bridge `Package.swift` |
| WiX | 4.x | installed via `dotnet tool install --global wix` in the workflow |

Bumping Node: update `NODE_VERSION` in `common.sh`, then rebuild on
each platform.

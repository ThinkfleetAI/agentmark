// swift-tools-version:5.9
//
// AgentMark macOS bridge. Mirrors the Windows bridge architecture —
// stdio JSON-RPC 2.0 server, Node-side `MacosAxapiBackend` spawns this
// and proxies capture/execute calls. Phase 0e'1 here ships ping +
// capabilities; AXAPI capture/execute land in 0e'2/0e'3.

import PackageDescription

let package = Package(
    name: "AgentMarkBridgeMacos",
    platforms: [
        // AXAPI requires macOS; setting a recent baseline keeps the
        // Accessibility APIs we'll need (kAXMainAttribute etc.) safe.
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "agentmark-bridge-macos",
            targets: ["AgentMarkBridgeMacos"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "AgentMarkBridgeMacos",
            path: "Sources/AgentMarkBridgeMacos"
        ),
    ]
)

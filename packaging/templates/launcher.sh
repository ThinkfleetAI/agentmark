#!/usr/bin/env bash
# agentmark-mcp launcher (POSIX).
#
# Used in two install layouts:
#
#   macOS .pkg (installed at /opt/thinkfleet/agentmark/):
#     bin/agentmark-mcp         ← this script
#     node
#     agentmark/dist/src/mcp/cli.js
#     bridges/agentmark-bridge-macos
#
#   Linux AppImage (mounted at /tmp/.mount_xxx/):
#     usr/bin/agentmark-mcp     ← this script
#     usr/bin/node
#     usr/lib/agentmark/dist/src/mcp/cli.js
#     (no bridge — AT-SPI bridge not yet shipped)
#
# Resolves Node + the agentmark dist relative to its own path by
# probing both layouts so a single launcher script works for both.

set -e

# Resolve the directory this script lives in, following symlinks (the
# macOS .pkg symlinks this from /usr/local/bin).
SCRIPT_PATH="$0"
while [[ -L "$SCRIPT_PATH" ]]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
BIN_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# Try the macOS pkg layout first: launcher at <root>/bin/agentmark-mcp,
# node at <root>/node, agentmark at <root>/agentmark.
INSTALL_ROOT="$(cd "$BIN_DIR/.." && pwd)"
NODE="$INSTALL_ROOT/node"
ENTRY="$INSTALL_ROOT/agentmark/dist/src/mcp/cli.js"
BRIDGES_DIR="$INSTALL_ROOT/bridges"

# Fall back to the AppImage layout: launcher at <root>/usr/bin/
# agentmark-mcp, node at <root>/usr/bin/node, agentmark at
# <root>/usr/lib/agentmark.
if [[ ! -x "$NODE" || ! -f "$ENTRY" ]]; then
    INSTALL_ROOT="$(cd "$BIN_DIR/../.." && pwd)"
    NODE="$INSTALL_ROOT/usr/bin/node"
    ENTRY="$INSTALL_ROOT/usr/lib/agentmark/dist/src/mcp/cli.js"
    BRIDGES_DIR="$INSTALL_ROOT/usr/lib/agentmark/bridges"
fi

[[ -x "$NODE" ]] || { echo "agentmark-mcp: bundled Node not found at $NODE" >&2; exit 1; }
[[ -f "$ENTRY" ]] || { echo "agentmark-mcp: agentmark entry not found at $ENTRY" >&2; exit 1; }

# Point the desktop plugin at the bundled bridge if one exists on this
# platform. AppImage builds ship without a bridge today (no Linux
# AT-SPI bridge yet); leaving the env var unset is the right behavior
# — agentmark_desktop_open will return a clean OS-mismatch error.
if [[ -z "${AGENTMARK_BRIDGE_PATH:-}" ]]; then
    if [[ -x "$BRIDGES_DIR/agentmark-bridge-macos" ]]; then
        export AGENTMARK_BRIDGE_PATH="$BRIDGES_DIR/agentmark-bridge-macos"
    elif [[ -x "$BRIDGES_DIR/agentmark-bridge-linux" ]]; then
        export AGENTMARK_BRIDGE_PATH="$BRIDGES_DIR/agentmark-bridge-linux"
    fi
fi

exec "$NODE" "$ENTRY" "$@"

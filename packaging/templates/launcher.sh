#!/usr/bin/env bash
# agentmark-mcp launcher (POSIX).
#
# Installed at /opt/thinkfleet/agentmark/bin/agentmark-mcp; symlinked
# into /usr/local/bin by the .pkg post-install step. Resolves the
# bundle's Node + agentmark dist relative to its own path so the
# launcher is relocatable.

set -e

# Resolve the directory this script lives in, following symlinks.
SCRIPT_PATH="$0"
while [[ -L "$SCRIPT_PATH" ]]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
BIN_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
INSTALL_ROOT="$(cd "$BIN_DIR/.." && pwd)"

NODE="$INSTALL_ROOT/node"
ENTRY="$INSTALL_ROOT/agentmark/dist/src/mcp/cli.js"

# Tell the agentmark Desktop plugin where the bridge lives unless the
# operator overrode the path explicitly.
if [[ -z "${AGENTMARK_BRIDGE_PATH:-}" ]]; then
    export AGENTMARK_BRIDGE_PATH="$INSTALL_ROOT/bridges/agentmark-bridge-macos"
fi

exec "$NODE" "$ENTRY" "$@"

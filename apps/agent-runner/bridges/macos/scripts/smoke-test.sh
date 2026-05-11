#!/usr/bin/env bash
# Smoke test for agentmark-bridge-macos.
#
# Feeds two requests through stdin (ping + capabilities), asserts both
# come back with the expected shape, exits non-zero on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../.build/debug/agentmark-bridge-macos"

if [[ ! -x "$BIN" ]]; then
    echo "Bridge binary not built. Expected at $BIN" >&2
    echo "Run: cd $(dirname "$SCRIPT_DIR") && swift build" >&2
    exit 1
fi

echo "Smoke testing $BIN"
echo

# Two requests separated by newlines, then close stdin.
REQUESTS='{"jsonrpc":"2.0","id":1,"method":"ping"}
{"jsonrpc":"2.0","id":2,"method":"capabilities"}'

# Run with a 10-second wall-clock cap.
OUTPUT="$(echo "$REQUESTS" | "$BIN" 2>/tmp/agentmark-bridge-macos-stderr.log)" \
    || { echo "Bridge exited non-zero. stderr:"; cat /tmp/agentmark-bridge-macos-stderr.log; exit 1; }

LINES=()
while IFS= read -r line; do
    [[ -n "$line" ]] && LINES+=("$line")
done <<< "$OUTPUT"

if [[ ${#LINES[@]} -ne 2 ]]; then
    echo "Expected 2 response lines; got ${#LINES[@]}." >&2
    echo "Output was:" >&2
    printf '%s\n' "${LINES[@]}" >&2
    exit 1
fi

for L in "${LINES[@]}"; do echo "  -> $L"; done
echo

# Validate basic shape with grep — no jq dependency.
if ! grep -q '"pong":true' <<< "${LINES[0]}"; then
    echo "ping: expected result.pong=true" >&2
    exit 1
fi
if ! grep -q '"id":1' <<< "${LINES[0]}"; then
    echo "ping: id mismatch (expected 1)" >&2
    exit 1
fi
if ! grep -q '"bridge":"agentmark-bridge-macos"' <<< "${LINES[1]}"; then
    echo "capabilities: expected bridge=agentmark-bridge-macos" >&2
    exit 1
fi
if ! grep -q '"id":2' <<< "${LINES[1]}"; then
    echo "capabilities: id mismatch (expected 2)" >&2
    exit 1
fi

echo "SMOKE TEST PASSED"
echo "  bridge stderr:"
sed 's/^/    /' /tmp/agentmark-bridge-macos-stderr.log

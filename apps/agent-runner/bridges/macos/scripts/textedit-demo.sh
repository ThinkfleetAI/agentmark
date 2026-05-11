#!/usr/bin/env bash
# Live end-to-end demo: drive macOS TextEdit through the bridge.
#
# Sequence:
#   1. Ensure TextEdit is running with a new document
#   2. list_windows  -> find the TextEdit window
#   3. capture       -> locate the text_area element
#   4. execute type  -> write a message into the editor
#   5. capture       -> verify the text landed in element.value
#
# Requires Accessibility permission granted to the terminal you're
# running this from (System Settings -> Privacy & Security ->
# Accessibility).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../.build/debug/agentmark-bridge-macos"
TMP_FIFO="/tmp/agentmark-bridge-demo.$$"

if [[ ! -x "$BIN" ]]; then
    echo "Bridge not built. Run: swift build" >&2
    exit 1
fi

cleanup() { rm -f "$TMP_FIFO"; }
trap cleanup EXIT

# ── Step 1: ensure TextEdit is running with a document ─────────────────
echo "Launching TextEdit..."
osascript -e 'tell application "TextEdit" to activate' -e 'tell application "TextEdit" to make new document' >/dev/null 2>&1 || true
sleep 1

# ── Spawn the bridge with a bidirectional FIFO ─────────────────────────
mkfifo "$TMP_FIFO"
# Background the bridge with stdin from the FIFO and stdout into a file.
"$BIN" < "$TMP_FIFO" > /tmp/agentmark-bridge-out.$$ 2>/tmp/agentmark-bridge-err.$$ &
BRIDGE_PID=$!

# Open the FIFO for writing (keeps the pipe alive across calls).
exec 3>"$TMP_FIFO"

send_request() {
    echo "$1" >&3
    # Each response is a single line; wait for it to appear in the
    # output file.
    while ! tail -n 1 /tmp/agentmark-bridge-out.$$ 2>/dev/null | grep -q '"id":'"$2"; do
        sleep 0.05
    done
    tail -n 1 /tmp/agentmark-bridge-out.$$
}

teardown() {
    exec 3>&-  # close stdin to bridge
    wait $BRIDGE_PID 2>/dev/null || true
    cat /tmp/agentmark-bridge-err.$$ | sed 's/^/[bridge stderr] /'
    rm -f /tmp/agentmark-bridge-out.$$ /tmp/agentmark-bridge-err.$$
}
trap 'teardown; cleanup' EXIT

# ── Step 2: list_windows ───────────────────────────────────────────────
echo
echo "Step 2 -- list_windows..."
LIST=$(send_request '{"jsonrpc":"2.0","id":1,"method":"list_windows"}' 1)
WINDOW_ID=$(echo "$LIST" | python3 -c 'import sys,json; d=json.load(sys.stdin); w=[x for x in d["result"]["windows"] if x["processName"]=="TextEdit"]; print(w[0]["windowId"] if w else "")')
if [[ -z "$WINDOW_ID" ]]; then
    echo "TextEdit window not found. Visible processes:"
    echo "$LIST" | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(" ", w["processName"], "--", w["windowTitle"]) for w in d["result"]["windows"]]'
    exit 1
fi
echo "  found TextEdit window: $WINDOW_ID"

# ── Step 3: capture ────────────────────────────────────────────────────
echo
echo "Step 3 -- capture TextEdit..."
CAP=$(send_request "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"capture\",\"params\":{\"windowId\":\"$WINDOW_ID\",\"maxDepth\":8,\"maxElements\":400}}" 2)
echo "  treeDepth=$(echo "$CAP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["treeDepth"])')  elementCount=$(echo "$CAP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["elementCount"])')"

EDITOR_ID=$(echo "$CAP" | python3 - <<'PYEOF'
import sys, json
d = json.load(sys.stdin)
def find(node):
    if node.get("role") in ("text_area", "text_input"):
        return node["id"]
    for c in node.get("children", []) or []:
        r = find(c)
        if r: return r
    return None
print(find(d["result"]["root"]) or "")
PYEOF
)
if [[ -z "$EDITOR_ID" ]]; then
    echo "Could not find text_area element. Tree:"
    echo "$CAP" | python3 -m json.tool | head -100
    exit 1
fi
echo "  editor element_id: $EDITOR_ID"

# ── Step 4: execute type ───────────────────────────────────────────────
MESSAGE="Hello from AgentMark Desktop -- macOS bridge phase 0e3'"
echo
echo "Step 4 -- execute type..."
EXEC=$(send_request "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"execute\",\"params\":{\"elementId\":\"$EDITOR_ID\",\"actionType\":\"type\",\"text\":\"$MESSAGE\",\"clearFirst\":true}}" 3)
OK=$(echo "$EXEC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["ok"])')
echo "  ok: $OK"
echo "  message: $(echo "$EXEC" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r.get("message") or r.get("newValue") or "")')"

sleep 0.5

# ── Step 5: re-capture and verify ─────────────────────────────────────
echo
echo "Step 5 -- re-capture and verify..."
CAP2=$(send_request "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"capture\",\"params\":{\"windowId\":\"$WINDOW_ID\",\"maxDepth\":8,\"maxElements\":400}}" 4)
VALUE=$(echo "$CAP2" | python3 - <<PYEOF
import sys, json
d = json.load(sys.stdin)
def find(node, target):
    if node.get("id") == target:
        return node.get("value")
    for c in node.get("children", []) or []:
        r = find(c, target)
        if r is not None: return r
    return None
v = find(d["result"]["root"], "$EDITOR_ID")
print(v or "")
PYEOF
)
echo "  editor value: $VALUE"

if [[ "$VALUE" == *"Hello from AgentMark Desktop"* ]]; then
    echo
    echo "LIVE DEMO PASSED -- AgentMark Desktop drove real TextEdit end-to-end on macOS."
else
    echo
    echo "LIVE DEMO FAILED -- expected text not found in editor value."
    exit 1
fi

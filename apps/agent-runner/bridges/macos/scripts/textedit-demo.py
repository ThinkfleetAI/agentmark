#!/usr/bin/env python3
"""
Live end-to-end demo: drive macOS TextEdit through the bridge.

Sequence:
  1. Ensure TextEdit is running with a new document
  2. list_windows  -> find the TextEdit window
  3. capture       -> locate the text_area element
  4. execute type  -> write a message into the editor
  5. capture       -> verify the text landed in element.value

Requires Accessibility permission granted to the terminal you're
running this from (System Settings -> Privacy & Security ->
Accessibility).
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
BIN = SCRIPT_DIR.parent / ".build" / "debug" / "agentmark-bridge-macos"

if not BIN.exists():
    print(f"Bridge not built. Expected at {BIN}\nRun: swift build", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    # Step 1: ensure TextEdit is running with a doc.
    print("Launching TextEdit...")
    subprocess.run(
        [
            "osascript",
            "-e", 'tell application "TextEdit" to activate',
            "-e", 'tell application "TextEdit" to make new document',
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)

    # Spawn bridge with bidirectional pipes.
    bridge = subprocess.Popen(
        [str(BIN)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    next_id = 1

    def call(method: str, params: dict | None = None) -> dict:
        nonlocal next_id
        req = {"jsonrpc": "2.0", "id": next_id, "method": method}
        if params is not None:
            req["params"] = params
        next_id += 1
        bridge.stdin.write(json.dumps(req) + "\n")
        bridge.stdin.flush()
        line = bridge.stdout.readline()
        if not line:
            err = bridge.stderr.read()
            raise RuntimeError(f"Bridge closed unexpectedly. stderr:\n{err}")
        return json.loads(line)

    def find_editor(node: dict) -> str | None:
        if node.get("role") in ("text_area", "text_input"):
            return node["id"]
        for child in node.get("children") or []:
            found = find_editor(child)
            if found:
                return found
        return None

    def find_value(node: dict, target_id: str) -> str | None:
        if node.get("id") == target_id:
            return node.get("value")
        for child in node.get("children") or []:
            v = find_value(child, target_id)
            if v is not None:
                return v
        return None

    try:
        # Step 2: list_windows
        print()
        print("Step 2 -- list_windows...")
        list_resp = call("list_windows")
        windows = list_resp["result"]["windows"]
        textedit = next(
            (w for w in windows if w.get("processName") == "TextEdit"),
            None,
        )
        if textedit is None:
            print("TextEdit window not found. Visible processes:")
            for w in windows:
                print(f"  {w.get('processName'):25s} -- {w.get('windowTitle')}")
            return 1
        window_id = textedit["windowId"]
        print(f"  found TextEdit window: {window_id} ({textedit.get('windowTitle')})")

        # Step 3: capture
        print()
        print("Step 3 -- capture TextEdit...")
        cap = call("capture", {
            "windowId": window_id,
            "maxDepth": 8,
            "maxElements": 400,
        })
        if "error" in cap:
            print(f"  capture errored: {cap['error']}")
            return 1
        result = cap["result"]
        print(f"  treeDepth={result['treeDepth']}  elementCount={result['elementCount']}")
        editor_id = find_editor(result["root"])
        if not editor_id:
            print("  Could not find a text_area / text_input element. Tree top level:")
            for c in (result["root"].get("children") or [])[:10]:
                print(f"    [{c.get('role'):15s}] id={c.get('id'):20s} name={c.get('name')}")
            return 1
        print(f"  editor element_id: {editor_id}")

        # Step 4: execute type
        message = "Hello from AgentMark Desktop -- macOS bridge phase 0e3'"
        print()
        print("Step 4 -- execute type...")
        exec_resp = call("execute", {
            "elementId": editor_id,
            "actionType": "type",
            "text": message,
            "clearFirst": True,
        })
        if "error" in exec_resp:
            print(f"  execute errored: {exec_resp['error']}")
            return 1
        r = exec_resp["result"]
        print(f"  ok: {r.get('ok')}")
        if r.get("message"):
            print(f"  note: {r['message']}")
        if r.get("newValue"):
            preview = r["newValue"][:80]
            print(f"  newValue: {preview}")

        time.sleep(0.5)

        # Step 5: re-capture and verify
        print()
        print("Step 5 -- re-capture and verify...")
        cap2 = call("capture", {
            "windowId": window_id,
            "maxDepth": 8,
            "maxElements": 400,
        })
        value_after = find_value(cap2["result"]["root"], editor_id)
        print(f"  editor value after type: {repr(value_after)[:120]}")

        ok = value_after and "Hello from AgentMark Desktop" in value_after
        print()
        if ok:
            print("LIVE DEMO PASSED -- AgentMark Desktop drove real TextEdit end-to-end on macOS.")
            return 0
        print("LIVE DEMO FAILED -- expected text not found in editor value.")
        return 1
    finally:
        try:
            bridge.stdin.close()
            bridge.wait(timeout=5)
        except Exception:
            bridge.kill()
        stderr = bridge.stderr.read()
        if stderr:
            print()
            print("--- bridge stderr ---")
            for line in stderr.splitlines():
                print(f"  {line}")


if __name__ == "__main__":
    sys.exit(main())

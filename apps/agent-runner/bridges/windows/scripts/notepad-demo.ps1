# Live demo: drive Notepad end-to-end through the bridge.
#
# Sequence:
#   1. Launch Notepad (or attach if already open) and bring to foreground
#   2. list_windows  -> find the Notepad window
#   3. capture       -> get the element tree, locate the text editor
#   4. execute type  -> write a message into Notepad's edit area
#   5. capture       -> re-snapshot and prove the text actually landed
#
# Designed to be run from the VM's interactive PowerShell so UIA can
# see real windows (SSH session 2 can't).

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir '..\bin\Debug\net8.0-windows\agentmark-bridge-windows.exe'
if (-not (Test-Path $exe)) {
    Write-Error "Bridge exe not built. Expected at $exe."
    exit 1
}

# ── Step 1: ensure a Notepad window exists, foreground it ──────────────
Write-Host "Launching Notepad..."
Start-Process notepad
Start-Sleep -Milliseconds 800

# Spawn bridge
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [System.Diagnostics.Process]::Start($psi)

function Send-Request($p, $payload) {
    $p.StandardInput.WriteLine($payload)
    $p.StandardInput.Flush()
    return ($p.StandardOutput.ReadLine() | ConvertFrom-Json)
}

# ── Step 2: locate the Notepad window ──────────────────────────────────
Write-Host ""
Write-Host "Step 2 -- list_windows..."
$listResp = Send-Request $proc '{"jsonrpc":"2.0","id":1,"method":"list_windows"}'
$notepad = $listResp.result.windows | Where-Object { $_.processName -eq 'notepad' } | Select-Object -First 1
if (-not $notepad) {
    Write-Error "No notepad window visible to UIA. Open Notepad in the VM console first."
    $proc.StandardInput.Close(); $proc.WaitForExit(5000) | Out-Null
    exit 1
}
Write-Host "  found: $($notepad.windowTitle) ($($notepad.windowId))"

# ── Step 3: capture Notepad ────────────────────────────────────────────
Write-Host ""
Write-Host "Step 3 -- capture Notepad..."
$capPayload = '{"jsonrpc":"2.0","id":2,"method":"capture","params":{"windowId":"' + $notepad.windowId + '","maxDepth":8,"maxElements":400}}'
$capResp = Send-Request $proc $capPayload

if (-not $capResp.result) {
    Write-Error "capture failed: $(($capResp | ConvertTo-Json -Compress))"
    $proc.StandardInput.Close(); $proc.WaitForExit(5000) | Out-Null
    exit 1
}

$cap = $capResp.result
Write-Host "  treeDepth=$($cap.treeDepth)  elementCount=$($cap.elementCount)"

# Walk children looking for a text-area-style element (Notepad's editor
# surfaces as role: text_area). On Win 11, the actual edit control may
# be nested a level or two below the top-level window.
function Find-EditElement($node) {
    if ($null -eq $node) { return $null }
    if ($node.role -eq 'text_area' -or $node.role -eq 'text_input') { return $node }
    if ($node.children) {
        foreach ($child in $node.children) {
            $found = Find-EditElement $child
            if ($found) { return $found }
        }
    }
    return $null
}

$edit = Find-EditElement $cap.root
if (-not $edit) {
    Write-Error "Could not find a text_area / text_input element in Notepad's tree. Dump:"
    Write-Host ($cap.root | ConvertTo-Json -Depth 10)
    $proc.StandardInput.Close(); $proc.WaitForExit(5000) | Out-Null
    exit 1
}
Write-Host "  editor element_id : $($edit.id) (role=$($edit.role))"
Write-Host "  current value     : '$($edit.value)'"

# ── Step 4: type into the editor ───────────────────────────────────────
$message = "Hello from AgentMark Desktop -- phase 0e3 live demo"
Write-Host ""
Write-Host "Step 4 -- execute type into editor..."
$execPayload = '{"jsonrpc":"2.0","id":3,"method":"execute","params":{"elementId":"' + $edit.id + '","actionType":"type","text":"' + $message + '","clearFirst":true}}'
$execResp = Send-Request $proc $execPayload

if (-not $execResp.result.ok) {
    Write-Error "execute failed: $($execResp.result.message)"
    $proc.StandardInput.Close(); $proc.WaitForExit(5000) | Out-Null
    exit 1
}
Write-Host "  ok        : $($execResp.result.ok)"
Write-Host "  newValue  : $($execResp.result.newValue)"
if ($execResp.result.message) { Write-Host "  note      : $($execResp.result.message)" }

# Give the edit a moment to reflect.
Start-Sleep -Milliseconds 250

# ── Step 5: re-capture and prove the change ────────────────────────────
Write-Host ""
Write-Host "Step 5 -- re-capture and verify..."
$cap2Payload = '{"jsonrpc":"2.0","id":4,"method":"capture","params":{"windowId":"' + $notepad.windowId + '","maxDepth":8,"maxElements":400}}'
$cap2Resp = Send-Request $proc $cap2Payload
$edit2 = Find-EditElement $cap2Resp.result.root
Write-Host "  editor value after type : '$($edit2.value)'"

$ok = $edit2.value -and $edit2.value.Contains("Hello from AgentMark Desktop")
$proc.StandardInput.Close(); $proc.WaitForExit(5000) | Out-Null

Write-Host ""
if ($ok) {
    Write-Host "LIVE DEMO PASSED -- AgentMark Desktop drove real Notepad end-to-end." -ForegroundColor Green
} else {
    Write-Host "LIVE DEMO FAILED -- expected text not found after execute." -ForegroundColor Red
    exit 1
}

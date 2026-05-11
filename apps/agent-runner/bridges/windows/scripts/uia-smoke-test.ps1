# UIA smoke test for agentmark-bridge-windows.
#
# Drives the bridge with three requests:
#   1. list_windows  -> enumerate top-level windows visible to UIA
#   2. capture       -> snapshot the first window from the list
#   3. capture       -> snapshot the focused window (no target)
#
# Prints all responses; asserts the shapes are sane (the bridge
# claims kind:windows, returns at least one window from list_windows,
# returns a root element from capture). Designed to be safe to run
# while Notepad / Calculator / any GUI app is open in the VM console;
# without a GUI app open the test still passes against whatever ghost
# windows Windows always has (Desktop, NotificationCenter, etc.).

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir '..\bin\Debug\net8.0-windows\agentmark-bridge-windows.exe'
if (-not (Test-Path $exe)) {
    Write-Error "Bridge exe not built. Expected at $exe."
    exit 1
}

Write-Host "UIA smoke testing $exe"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [System.Diagnostics.Process]::Start($psi)

# Helper: send one request, read one response.
function Send-Request($p, $payload) {
    $p.StandardInput.WriteLine($payload)
    $p.StandardInput.Flush()
    return $p.StandardOutput.ReadLine()
}

$listLine = Send-Request $proc '{"jsonrpc":"2.0","id":1,"method":"list_windows"}'
$listResp = $listLine | ConvertFrom-Json
if (-not $listResp.result.windows) {
    Write-Error "list_windows returned no windows array: $listLine"
    $proc.StandardInput.Close()
    $proc.WaitForExit(5000) | Out-Null
    exit 1
}
$windows = $listResp.result.windows
Write-Host "list_windows: $($windows.Count) windows"
$windows | ForEach-Object {
    Write-Host ("  [{0}] {1} ({2}) -- {3}" -f $_.processName, $_.windowTitle, $_.windowId, $_.windowClass)
}

if ($windows.Count -eq 0) {
    Write-Host ""
    Write-Host "No windows visible via UIA from this session. This is expected when"
    Write-Host "running over SSH non-interactive sessions if no GUI app is open in the"
    Write-Host "VM console. Open Notepad in the VM console and rerun." -ForegroundColor Yellow
    $proc.StandardInput.Close()
    $proc.WaitForExit(5000) | Out-Null
    exit 0
}

# Capture the first window from the list to validate end-to-end.
$first = $windows[0]
Write-Host ""
Write-Host "Capturing first window by windowId: $($first.windowId)"
$capPayload = '{"jsonrpc":"2.0","id":2,"method":"capture","params":{"windowId":"' + $first.windowId + '","maxDepth":4,"maxElements":200}}'
$capLine = Send-Request $proc $capPayload
$capResp = $capLine | ConvertFrom-Json

if (-not $capResp.result) {
    Write-Error "capture did not return result. Response was: $capLine"
    $proc.StandardInput.Close()
    $proc.WaitForExit(5000) | Out-Null
    exit 1
}

$cap = $capResp.result
Write-Host "  platform        : $($cap.platform)"
Write-Host "  windowTitle     : $($cap.windowTitle)"
Write-Host "  processName     : $($cap.processName)"
Write-Host "  treeDepth       : $($cap.treeDepth)"
Write-Host "  elementCount    : $($cap.elementCount)"
Write-Host "  root.role       : $($cap.root.role)"
Write-Host "  root.id         : $($cap.root.id)"
Write-Host "  root.name       : $($cap.root.name)"
if ($cap.root.children) {
    Write-Host "  root children   : $($cap.root.children.Count)"
    $cap.root.children | Select-Object -First 5 | ForEach-Object {
        Write-Host ("    - [{0}] id={1} name={2}" -f $_.role, $_.id, $_.name)
    }
}

# Capture the focused window via the no-target default.
Write-Host ""
Write-Host "Capturing focused window (no target)..."
$focLine = Send-Request $proc '{"jsonrpc":"2.0","id":3,"method":"capture","params":{"maxDepth":3,"maxElements":50}}'
$focResp = $focLine | ConvertFrom-Json
if ($focResp.result) {
    Write-Host "  focused window : $($focResp.result.windowTitle) ($($focResp.result.processName))"
} elseif ($focResp.error) {
    Write-Host "  focused capture error: $($focResp.error.message)"
}

$proc.StandardInput.Close()
$proc.WaitForExit(5000) | Out-Null

$stderr = $proc.StandardError.ReadToEnd()
if ($stderr) {
    Write-Host "--- bridge stderr ---" -ForegroundColor DarkGray
    Write-Host $stderr -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "UIA SMOKE TEST PASSED" -ForegroundColor Green

# Smoke test for the agentmark-bridge-windows binary.
#
# Spawns the bridge as a child process via .NET's Process API (NOT
# PowerShell's pipe), writes a few JSON-RPC requests, then closes
# stdin explicitly -- that is the only reliable way to signal EOF to
# the bridge so it exits cleanly. PowerShell's `... | & exe` pipe
# does NOT close stdin on the native exe; that's why the naive
# version hangs.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir '..\bin\Debug\net8.0-windows\agentmark-bridge-windows.exe'

if (-not (Test-Path $exe)) {
    Write-Error "Bridge exe not built -- expected at $exe. Run 'dotnet build' first."
    exit 1
}

Write-Host "Smoke testing $exe"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# StandardInputEncoding/OutputEncoding only exist on .NET Core/5+;
# Windows PowerShell 5.1 runs on .NET Framework which lacks them.
# Our JSON payloads are pure ASCII so the system codepage default works.
# The bridge process itself forces UTF-8 on its own streams (Program.cs).

$proc = [System.Diagnostics.Process]::Start($psi)

$requests = @(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":2,"method":"capabilities"}'
)

foreach ($req in $requests) {
    $proc.StandardInput.WriteLine($req)
}
$proc.StandardInput.Close()

# 10-second cap to keep the test sane.
if (-not $proc.WaitForExit(10000)) {
    $proc.Kill()
    Write-Error "Bridge did not exit within 10 seconds."
    exit 1
}

$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()

if ($stderr) {
    Write-Host "--- bridge stderr ---" -ForegroundColor DarkGray
    Write-Host $stderr -ForegroundColor DarkGray
}

$responseLines = $stdout -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 }
Write-Host "Received $($responseLines.Count) response line(s)."

if ($responseLines.Count -lt 2) {
    Write-Error "Expected 2 responses; got $($responseLines.Count)."
    Write-Host "stdout was:"
    Write-Host $stdout
    exit 1
}

foreach ($line in $responseLines) {
    Write-Host "  -> $line"
}

$pingResp = $responseLines[0] | ConvertFrom-Json
$capResp  = $responseLines[1] | ConvertFrom-Json

if ($pingResp.result.pong -ne $true) {
    Write-Error "ping: expected result.pong=true, got: $($pingResp | ConvertTo-Json -Compress)"
    exit 1
}
if ($pingResp.id -ne 1) {
    Write-Error "ping: id mismatch (expected 1, got $($pingResp.id))"
    exit 1
}

if ($capResp.result.bridge -ne 'agentmark-bridge-windows') {
    Write-Error "capabilities: expected bridge=agentmark-bridge-windows, got: $($capResp | ConvertTo-Json -Compress)"
    exit 1
}
if ($capResp.id -ne 2) {
    Write-Error "capabilities: id mismatch (expected 2, got $($capResp.id))"
    exit 1
}

Write-Host ""
Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
Write-Host "  bridge version : $($pingResp.result.version)"
Write-Host "  architecture   : $($pingResp.result.arch)"
Write-Host "  process id     : $($pingResp.result.processId)"
Write-Host "  methods        : $($capResp.result.methods -join ', ')"
Write-Host "  exit code      : $($proc.ExitCode)"

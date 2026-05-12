<#
    Build the Windows .msi installer for the AgentMark MCP server +
    Windows UIA bridge.

    Pipeline:
      1. Build the npm package (pnpm build) — usually already done in CI.
      2. Build the .NET UIA bridge (dotnet publish, self-contained).
      3. Download the pinned Node binary (win-x64).
      4. Assemble the install staging directory.
      5. Run WiX 4 (`dotnet wix build`) to produce the .msi.
      6. Sign with signtool if WINDOWS_CERT_PFX_BASE64 is set.

    Output: dist\installer\AgentMark-<version>-windows.msi

    Designed for windows-latest GitHub Actions runners; works on a
    local Windows dev box too. Signing is conditional.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ──────────────────────────────────────────────────────────────────────
# Pinned versions
# ──────────────────────────────────────────────────────────────────────
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { '22.11.0' }
$BundleId = if ($env:BUNDLE_ID) { $env:BUNDLE_ID } else { 'ai.thinkfleet.agentmark' }
$DisplayName = if ($env:DISPLAY_NAME) { $env:DISPLAY_NAME } else { 'ThinkFleet AgentMark' }

# Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..\..')
$BuildDir = Join-Path $RepoRoot 'dist\installer-build\windows'
$StageDir = Join-Path $BuildDir 'stage'
$OutDir = Join-Path $RepoRoot 'dist\installer'

$PkgVersion = (node -e "console.log(require('$($RepoRoot.Path.Replace('\','/'))/package.json').version)")
$MsiOut = Join-Path $OutDir "AgentMark-$PkgVersion-windows.msi"

New-Item -ItemType Directory -Force -Path $BuildDir, $OutDir | Out-Null
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir, "$StageDir\agentmark", "$StageDir\bridges" | Out-Null

function Write-Section($msg) {
    Write-Host ''
    Write-Host "=== $msg ==="
}

# ──────────────────────────────────────────────────────────────────────
# 1. Build the npm package
# ──────────────────────────────────────────────────────────────────────
Write-Section 'Build npm package'
Set-Location $RepoRoot
pnpm install --frozen-lockfile
pnpm build

# ──────────────────────────────────────────────────────────────────────
# 2. Build the .NET UIA bridge (self-contained, win-x64)
# ──────────────────────────────────────────────────────────────────────
Write-Section 'Build Windows UIA bridge'
$BridgeProj = Join-Path $RepoRoot 'apps\agent-runner\bridges\windows\AgentMark.Bridge.Windows.csproj'
$BridgePublish = Join-Path $BuildDir 'bridge-publish'
dotnet publish $BridgeProj -c Release -r win-x64 --self-contained true -o $BridgePublish
$BridgeBin = Join-Path $BridgePublish 'agentmark-bridge-windows.exe'
if (-not (Test-Path $BridgeBin)) {
    throw "dotnet publish did not produce $BridgeBin"
}

# ──────────────────────────────────────────────────────────────────────
# 3. Download pinned Node
# ──────────────────────────────────────────────────────────────────────
Write-Section "Download Node v$NodeVersion"
$NodeZip = Join-Path $BuildDir 'node.zip'
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
$NodeExtract = Join-Path $BuildDir 'node-extract'
if (Test-Path $NodeExtract) { Remove-Item -Recurse -Force $NodeExtract }
Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract
$NodeExe = Join-Path $NodeExtract "node-v$NodeVersion-win-x64\node.exe"
if (-not (Test-Path $NodeExe)) {
    throw "Extracted Node binary not found at $NodeExe"
}

# ──────────────────────────────────────────────────────────────────────
# 4. Assemble staging tree
# ──────────────────────────────────────────────────────────────────────
Write-Section 'Assemble installer staging'

Copy-Item $NodeExe (Join-Path $StageDir 'node.exe')
Copy-Item $BridgeBin (Join-Path $StageDir 'bridges\agentmark-bridge-windows.exe')

# Bridge has companion DLLs (FlaUI, etc.) — copy the whole publish dir.
Get-ChildItem $BridgePublish -File | Where-Object { $_.Name -ne 'agentmark-bridge-windows.exe' } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $StageDir 'bridges')
}

# npm package
Copy-Item -Recurse (Join-Path $RepoRoot 'dist') (Join-Path $StageDir 'agentmark\dist')
Copy-Item -Recurse (Join-Path $RepoRoot 'schema') (Join-Path $StageDir 'agentmark\schema')
Copy-Item (Join-Path $RepoRoot 'package.json') (Join-Path $StageDir 'agentmark\package.json')

# Install production deps into staging. --ignore-scripts skips
# Playwright's Chromium download; we'll prompt for that post-install.
Set-Location (Join-Path $StageDir 'agentmark')
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
pnpm install --prod --ignore-scripts
Set-Location $RepoRoot

# Launcher batch file (added to PATH by the MSI).
Copy-Item (Join-Path $ScriptDir '..\templates\launcher.cmd') (Join-Path $StageDir 'agentmark-mcp.cmd')

# ──────────────────────────────────────────────────────────────────────
# 5. Build the .msi with WiX 4
# ──────────────────────────────────────────────────────────────────────
Write-Section 'Build MSI'
# Install wix as a dotnet tool if not already present.
$wixCheck = dotnet tool list --global | Select-String 'wix\s'
if (-not $wixCheck) {
    dotnet tool install --global wix
    $env:PATH = "$env:USERPROFILE\.dotnet\tools;$env:PATH"
}

# Stamp version into the WiX manifest.
$WxsTemplate = Join-Path $ScriptDir '..\templates\AgentMark.wxs'
$WxsStamped = Join-Path $BuildDir 'AgentMark.wxs'
(Get-Content $WxsTemplate -Raw) `
    -replace '__VERSION__', $PkgVersion `
    -replace '__BUNDLE_ID__', $BundleId `
    -replace '__DISPLAY_NAME__', $DisplayName `
    -replace '__STAGE_DIR__', ($StageDir -replace '\\', '\\\\') |
    Set-Content $WxsStamped

wix build -arch x64 -out $MsiOut $WxsStamped

# ──────────────────────────────────────────────────────────────────────
# 6. Sign with signtool (optional)
# ──────────────────────────────────────────────────────────────────────
if ($env:WINDOWS_CERT_PFX_BASE64 -and $env:WINDOWS_CERT_PFX_PASSWORD) {
    Write-Section 'Sign MSI'
    $PfxPath = Join-Path $BuildDir 'codesign.pfx'
    [System.IO.File]::WriteAllBytes($PfxPath, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_BASE64))

    # signtool ships with the Windows SDK; in CI the windows-latest image has it on PATH.
    & signtool sign /f $PfxPath /p $env:WINDOWS_CERT_PFX_PASSWORD `
        /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 `
        $MsiOut

    Remove-Item $PfxPath -Force
} else {
    Write-Host 'WINDOWS_CERT_PFX_BASE64 not set; skipping signing. SmartScreen will warn end users.'
}

Write-Section 'Done'
Write-Host "Installer: $MsiOut"
Get-Item $MsiOut | Select-Object Name, Length

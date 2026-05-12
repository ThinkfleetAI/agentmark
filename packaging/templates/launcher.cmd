@echo off
REM agentmark-mcp launcher (Windows).
REM
REM Installed at C:\Program Files\ThinkFleet\AgentMark\agentmark-mcp.cmd
REM (added to PATH by the MSI). Resolves the bundle's Node + agentmark
REM dist relative to its own path so the launcher is relocatable.

setlocal

set "INSTALL_ROOT=%~dp0"
REM Strip trailing backslash for cleaner output paths.
if "%INSTALL_ROOT:~-1%"=="\" set "INSTALL_ROOT=%INSTALL_ROOT:~0,-1%"

REM Point the desktop plugin at the bundled bridge unless overridden.
if "%AGENTMARK_BRIDGE_PATH%"=="" (
    set "AGENTMARK_BRIDGE_PATH=%INSTALL_ROOT%\bridges\agentmark-bridge-windows.exe"
)

"%INSTALL_ROOT%\node.exe" "%INSTALL_ROOT%\agentmark\dist\src\mcp\cli.js" %*

endlocal

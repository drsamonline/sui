# Sui — one-time Windows setup. Run this from the folder that contains package.json:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
#
# It checks Node, installs the workspace links, and proves the CLI runs.
# It does not install anything globally and does not touch your PATH.

$ErrorActionPreference = 'Stop'
Write-Host ''
Write-Host 'Sui — Windows setup' -ForegroundColor Cyan
Write-Host ''

# 1. Node 20 or newer
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  Node.js is not installed.' -ForegroundColor Red
  Write-Host '  Install the LTS from https://nodejs.org, then CLOSE this window,'
  Write-Host '  open a new PowerShell, and run this script again.'
  exit 1
}
$version = (node -v).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 20) {
  Write-Host "  Node $version is too old; Sui needs 20 or newer." -ForegroundColor Red
  Write-Host '  Install the LTS from https://nodejs.org and run this again.'
  exit 1
}
Write-Host "  Node $version  ok"

# 2. Are we in the right folder?
if (-not (Test-Path .\package.json)) {
  Write-Host '  package.json is not here.' -ForegroundColor Red
  Write-Host '  Open PowerShell in the folder that contains package.json — the easiest way'
  Write-Host '  is to type "powershell" in that folder''s address bar.'
  exit 1
}
Write-Host '  package.json   ok'

# 3. Workspace links. There are no third-party dependencies to download; this
#    only connects the project's own packages to each other.
Write-Host ''
Write-Host '  npm install (links the workspace packages, downloads nothing)'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host '  npm install failed. Copy the error above.' -ForegroundColor Red
  exit 1
}

# 4. Prove it runs.
Write-Host ''
Write-Host '  proving the CLI runs'
node .\apps\cli\bin\sui.js doctor | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host '  the CLI did not start. Copy the error above.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '  Ready.' -ForegroundColor Green
Write-Host ''
Write-Host '  From now on, run Sui with the wrapper in this folder:'
Write-Host ''
Write-Host '    .\sui.cmd doctor'
Write-Host '    .\sui.cmd start'
Write-Host '    .\sui.cmd catalog'
Write-Host ''
Write-Host '  (Use .\sui.cmd in CMD, .\sui.ps1 in PowerShell. Both work.)'
Write-Host '  Full walkthrough: docs\WINDOWS.md'
Write-Host ''

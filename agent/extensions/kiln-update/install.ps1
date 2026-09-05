#!/usr/bin/env pwsh
# Per-extension installer — Windows / PowerShell
# Installs npm dependencies for this extension. No-op if no package.json.
$ErrorActionPreference = "Stop"
# Drop npm_config_allow_scripts inherited from a parent npm/npx process:
# npm >=11 rejects it for project installs (EALLOWSCRIPTS). File config still applies.
Remove-Item Env:\npm_config_allow_scripts -ErrorAction SilentlyContinue
Remove-Item Env:\NPM_CONFIG_ALLOW_SCRIPTS -ErrorAction SilentlyContinue
$extDir = $PSScriptRoot
if (-not $extDir) { $extDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Test-Path "$extDir/package.json")) {
  Write-Host "  - no package.json — skipping" -ForegroundColor DarkGray
  exit 0
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "  x npm not found — install Node.js 22+" -ForegroundColor Red
  exit 1
}
if (Test-Path "$extDir/package-lock.json") {
  Write-Host "  - npm ci" -ForegroundColor DarkGray
  npm --prefix $extDir ci --no-audit --no-fund
} else {
  Write-Host "  - npm install" -ForegroundColor DarkGray
  npm --prefix $extDir install --no-audit --no-fund
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "  + done" -ForegroundColor Green

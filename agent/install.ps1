#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Pi custom-setup installer — Windows / PowerShell

  1) Install/update pi (@earendil-works/pi-coding-agent)
  2) Install pi packages  (pi-context-usage, @baretread/pi-forge)
  3) Install custom config (AGENTS.md, keybindings, extensions …)
  4) Install per-extension npm deps via each extension's install.ps1

  TUI inspired by https://pi.dev/install.ps1 — spinner when TTY, silent otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.ps1 -UseBasicParsing | iex"
  .\install.ps1 -RepoUrl https://github.com/asterxsk/kiln -Branch main
  .\install.ps1 -Target "$env:USERPROFILE\.pi\agent" -Yes
  .\install.ps1 -OverwriteSettings   # replace settings.json (asks by default)

.NOTES
  Safe to re-run. Managed files are force-overwritten; per-user files (settings.json, taste.md, etc.) are preserved
  unless -OverwriteSettings is passed or you answer Y when asked.
  Already-installed items are skipped; outdated global packages are updated.
  Only one timestamped backup (<target>.bak.*) is kept; the clone temp dir
  under ~/.pi/tmp/kiln-* is always removed.
#>

param(
  [string]$RepoUrl = $env:PI_CONFIG_REPO,
  [string]$Branch  = $(if ($env:PI_CONFIG_BRANCH) { $env:PI_CONFIG_BRANCH } else { "main" }),
  [string]$Target  = "",
  [switch]$SkipPi,
  [switch]$SkipPackages,
  [switch]$Yes,
  [switch]$Local,
  [switch]$OverwriteSettings,
  [switch]$KeepSettings
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:ClonedTmp = $null
$script:StartTime = Get-Date

$PiPackage     = "@earendil-works/pi-coding-agent"
$NodeMinimum   = [version]"22.19.0"
$Esc           = [char]27
$Cr            = [char]13
$PiHome        = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
$PiTmp         = Join-Path $PiHome ".pi/tmp"
try { New-Item -ItemType Directory -Path $PiTmp -Force | Out-Null } catch {}
$TmpLog        = Join-Path $PiTmp ("pi-setup-" + [Guid]::NewGuid().ToString("N").Substring(0,8) + ".log")
$DefaultRepo   = "https://github.com/asterxsk/kiln"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"
$env:GIT_ASKPASS = "echo"

# Ensure UTF-8 for glyphs (match pi.dev/install.ps1)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { chcp 65001 2>$null | Out-Null } catch {}

# ── VT / ANSI ───────────────────────────────────────────────────────────────
function Test-IsInteractive {
  return (-not [Console]::IsOutputRedirected) -and ($env:TERM -ne "dumb")
}
function Enable-VT {
  if (-not (Test-IsInteractive)) { return $false }
  # kernel32 only exists on Windows
  if (-not $IsWindows -and $env:OS -notmatch "Windows") { return $false }
  if ($null -ne $script:VTEnabled) { return $script:VTEnabled }
  try {
    if (-not ("VT.Native" -as [Type])) {
      Add-Type -Namespace VT -Name Native -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr h,out uint m);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(System.IntPtr h,uint m);
"@
    }
    $h = [VT.Native]::GetStdHandle(-11)
    [uint32]$m = 0
    $ok = [VT.Native]::GetConsoleMode($h,[ref]$m)
    if ($ok) { $ok = [VT.Native]::SetConsoleMode($h, ($m -bor 0x0004)) }
    $script:VTEnabled = $ok
    return $ok
  } catch { $script:VTEnabled = $false; return $false }
}
function Test-Ansi { return Enable-VT }
$HasAnsi = Test-Ansi

# ── palette (scalar vars, dot-free names; braces delimit) ───────────
if ($HasAnsi) {
  ${creset}="$Esc[0m"; ${cbold}="$Esc[1m"; ${cdim}="$Esc[2m"; ${cgreen}="$Esc[32m"
  ${cyellow}="$Esc[33m"; ${cred}="$Esc[31m"; ${ccyan}="$Esc[36m"; ${cgray}="$Esc[90m"
} else {
  ${creset}=""; ${cbold}=""; ${cdim}=""; ${cgreen}=""; ${cyellow}=""; ${cred}=""; ${ccyan}=""; ${cgray}=""
}

# ── title ───────────────────────────────────────────────────────────────────
function Write-Title {
  if ($HasAnsi) {
    [Console]::Write("${Esc}[1m  \u25C6 Pi Setup${Esc}[0m`n${Esc}[2m  custom agent config  \u00B7  pi + forge + extensions${Esc}[0m`n`n")
  } else {
    Write-Host ""
    Write-Host "  Pi Setup"
    Write-Host "  custom agent config  \xB7  pi + forge + extensions"
    Write-Host ""
  }
}

# ── spinner ─────────────────────────────────────────────────────────────────
$SpinnerFrames = @('\u280B','\u2819','\u2839','\u2838','\u283C','\u2830','\u2820','\u2826','\u2827','\u2807','\u280F')
# Fallback to ASCII if font missing — pi.dev uses same
$SpinnerFrames = @('⠋','⠙','⠹','⠸','⠼','⠰','⠠','⠦','⠧','⠇','⠏')
$SpinnerIdx = 0
function Get-Spinner { $s = $SpinnerFrames[$script:SpinnerIdx % $SpinnerFrames.Count]; $script:SpinnerIdx++; return $s }

function Write-Line($text) {
  if ($HasAnsi) { [Console]::Write("$text`n") } else { Write-Host $text }
}
function Write-StepLine($step, $label, $spin) {
  $prefix = "${cdim}[$step/4]${creset}"
  $frame  = if ($spin) { "${cyellow}$spin${creset}" } else { " " }
  $line   = " $frame $prefix $label"
  if ($HasAnsi -and (Test-IsInteractive)) {
    # \r + EL (\033[K) so each frame overwrites cleanly regardless of length
    [Console]::Write("$Cr${Esc}[K$line")
  } else {
    Write-Host $line
  }
}
function Clear-Line {
  if ($HasAnsi -and (Test-IsInteractive)) { [Console]::Write("$Cr${Esc}[K") }
}

# ── run with spinner ────────────────────────────────────────────────────────
function Invoke-NativeWithSpinner {
  # NOTE: the argument parameter must NOT be named $Args — $Args is an
  # automatic variable, and splatting @Args silently binds the (empty)
  # automatic instead of the parameter, dropping every argument.
  param([string]$Step, [string]$Label, [string]$FilePath, [string[]]$ArgumentList)
  # non-interactive: run synchronously, capture to log
  if (-not (Test-IsInteractive) -or -not $HasAnsi) {
    $out = & $FilePath @ArgumentList 2>&1
    $code = $LASTEXITCODE
    if ($out) { $out | ForEach-Object { Add-Content $TmpLog "$_" } }
    return $code
  }
  $script:SpinnerIdx = 0
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  # Quote args with spaces
  $psi.Arguments = ($ArgumentList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow  = $true
  $p = New-Object Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  while (-not $p.HasExited) {
    Write-StepLine $Step $Label (Get-Spinner)
    Start-Sleep -Milliseconds 80
  }
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  if ($stdout) { Add-Content $TmpLog $stdout }
  if ($stderr) { Add-Content $TmpLog $stderr }
  Clear-Line
  return $p.ExitCode
}

# ── helpers ─────────────────────────────────────────────────────────────────
function Resolve-Target {
  if ($Target) { return $Target }
  if ($env:PI_AGENT_DIR) { return $env:PI_AGENT_DIR }
  if ($IsWindows -or $env:OS -match "Windows") {
    return (Join-Path $env:USERPROFILE ".pi\agent")
  }
  $homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  return (Join-Path $homeDir ".pi/agent")
}

function Resolve-RepoUrl {
  if ($RepoUrl) { return $RepoUrl }
  # When piped via irm|iex, $PSScriptRoot is empty — don't probe, use default
  $isPiped = -not $PSScriptRoot
  if (-not $isPiped) {
    try {
      $here = $PSScriptRoot
      if (Test-Path (Join-Path $here ".git")) {
        $u = (git -C $here remote get-url origin 2>$null)
        if ($u) { return $u.Trim() }
      }
      $parent = Split-Path $here -Parent
      if (Test-Path (Join-Path $parent ".git")) {
        $u = (git -C $parent remote get-url origin 2>$null)
        if ($u) { return $u.Trim() }
      }
      if (Test-Path (Join-Path (Get-Location).Path ".git")) {
        $u = (git remote get-url origin 2>$null)
        if ($u) { return $u.Trim() }
      }
    } catch {}
  }
  return $DefaultRepo
}

function Resolve-SourceRoot {
  param([string]$Repo)
  # Local checkout detection (only when not piped or -Local forced)
  $checkLocal = $Local -or $PSScriptRoot
  if ($checkLocal) {
    $roots = @()
    if ($PSScriptRoot) { $roots += $PSScriptRoot; $roots += (Split-Path $PSScriptRoot -Parent); $roots += (Get-Location).Path }
    else { $roots += (Get-Location).Path }
    foreach ($r in $roots) {
      if ((Test-Path (Join-Path $r "extensions")) -and (Test-Path (Join-Path $r "AGENTS.md"))) { return $r }
      if (Test-Path (Join-Path $r "agent/extensions")) { return (Join-Path $r "agent") }
    }
    if ($Local) { throw "Local checkout not found (tried: $($roots -join ', '))" }
  }
  # Clone to ~/.pi/tmp — simple git clone, no account required, then copy agent folder.
  # Use a unique subdir per run so concurrent installs never clobber each other.
  if (-not (Test-Path $PiTmp)) { New-Item -ItemType Directory -Path $PiTmp -Force | Out-Null }
  $tmp = Join-Path $PiTmp ("kiln-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  Write-Line "${cdim}  → cloning $Repo (branch $Branch) → $tmp${creset}"
  $env:GIT_TERMINAL_PROMPT = "0"; $env:GIT_ASKPASS = "echo"; $env:GCM_INTERACTIVE = "never"
  $code = Invoke-NativeWithSpinner -Step "3" -Label "fetching config" -FilePath "git" -ArgumentList @("clone","--depth","1","--branch",$Branch,$Repo,$tmp)
  if ($code -ne 0) { throw "git clone failed (exit $code). See $TmpLog" }
  $script:ClonedTmp = $tmp
  if (Test-Path (Join-Path $tmp "agent")) { return (Join-Path $tmp "agent") }
  return $tmp
}

function Resolve-Npm {
  # "npm" resolves to npm.ps1 (a PowerShell shim) under Windows PowerShell.
  # npm.ps1 re-parses its own invocation line, which mangles arguments
  # passed via variables/splatting — always prefer the native npm.cmd.
  $cmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return "npm"
}

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try { $v = (node --version 2>$null).Trim().TrimStart('v').Split('-')[0]; return [version]$v } catch { return $null }
}

# Installed global version of a package ("" when not installed).
function Get-GlobalPkgVersion {
  param([string]$Name)
  try {
    $bin = Resolve-Npm
    $out = & $bin ls -g $Name --depth=0 2>$null | Out-String
    $m = [regex]::Match($out, [regex]::Escape($Name) + '@(\S+)')
    if ($m.Success) { return ($m.Groups[1].Value -replace '[^0-9A-Za-z.+-].*$','') }
  } catch {}
  return ""
}
# Latest registry version ("" when offline / unknown).
function Get-LatestPkgVersion {
  param([string]$Name)
  try {
    $bin = Resolve-Npm
    $v = ((& $bin view $Name version 2>$null | Out-String).Trim() -split '\s+')[0]
    if ($v -match '^[0-9][0-9A-Za-z.+-]*$') { return $v }
  } catch {}
  return ""
}
# Returns $true when the user wants settings.json overwritten.
function Test-WantOverwriteSettings {
  if ($OverwriteSettings) { return $true }
  if ($KeepSettings) { return $false }
  if ($Yes) { return $false }
  try {
    $ans = Read-Host "  settings.json exists. Overwrite with repo defaults? [y/N] (Recommended for first-time setup)"
    return ($ans -eq 'y' -or $ans -eq 'Y' -or $ans -eq 'yes' -or $ans -eq 'YES')
  } catch { return $false }
}

# ── MAIN ─────────────────────────────────────────────────────────────────────
"" | Set-Content $TmpLog
# Cleanup trap
$null = Register-EngineEvent PowerShell.Exiting -Action { if ($script:ClonedTmp -and (Test-Path $script:ClonedTmp)) { Remove-Item $script:ClonedTmp -Recurse -Force -ErrorAction SilentlyContinue } } -ErrorAction SilentlyContinue

Write-Title
$targetDir = Resolve-Target
$repoUrl   = Resolve-RepoUrl
$ok = $true

Write-Line "${cdim}  target  ${creset}$targetDir"
Write-Line "${cdim}  repo    ${creset}$repoUrl  ${cdim}($Branch)${creset}"
Write-Line "${cdim}  log     ${creset}$TmpLog`n"

# ── preflight ────────────────────────────────────────────────────────────────
$nodeVer = Test-Node
if (-not $nodeVer) {
  Write-Line "${cred}  ✖ Node.js not found. Install Node 22.19+ from https://nodejs.org${creset}"
  Write-Line "    then re-run this installer.`n"
  exit 1
}
if ($nodeVer -lt $NodeMinimum) {
  Write-Line "${cyellow}  ⚠ Node $nodeVer < $NodeMinimum — please upgrade to Node 22.19+${creset}"
  if (-not $Yes) { Write-Line "    continue anyway in 3s…"; Start-Sleep 3 }
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Line "${cred}  ✖ npm not found (Node installed but npm missing)${creset}"; exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Line "${cred}  ✖ git not found — required to fetch config${creset}"
  Write-Line "    install from https://git-scm.com/downloads`n"; exit 1
}
$npmVer = (npm --version 2>$null).Trim()
$gitVer = (git --version 2>$null).Trim()
Write-Line "${cdim}  node $nodeVer  ·  npm $npmVer  ·  $gitVer${creset}`n"
$NpmBin = Resolve-Npm

# ── [1/4] pi ────────────────────────────────────────────────────────────────
if ($SkipPi) {
  Write-Line " ${cgreen}✔${creset} ${cdim}[1/4]${creset} Install pi ${cdim}— skipped${creset}"
} elseif (Get-Command pi -ErrorAction SilentlyContinue) {
  $piInstalled = Get-GlobalPkgVersion $PiPackage
  if (-not $piInstalled) { $piInstalled = try { (pi --version 2>$null).Trim().TrimStart('v') } catch { "" } }
  $piLatest = Get-LatestPkgVersion $PiPackage
  if ($piInstalled -and $piLatest -and ($piInstalled -eq $piLatest)) {
    Write-Line " ${cgreen}✔${creset} ${cdim}[1/4]${creset} pi ${cdim}— already installed ($piInstalled), skipping${creset}"
  } elseif ($piInstalled -and -not $piLatest) {
    Write-Line " ${cgreen}✔${creset} ${cdim}[1/4]${creset} pi ${cdim}— already installed ($piInstalled), skipping version check (offline)${creset}"
  } else {
    if ($piInstalled -and $piLatest) { $label = "updating pi $piInstalled → $piLatest ($PiPackage)" } else { $label = "installing pi ($PiPackage)" }
    $code = Invoke-NativeWithSpinner -Step "1" -Label $label -FilePath $NpmBin -ArgumentList @("install","-g","$PiPackage@latest","--no-audit","--no-fund","--min-release-age=0")
    if ($code -eq 0) {
      $piVer = try { (pi --version 2>$null).Trim() } catch { "?" }
      Write-Line " ${cgreen}✔${creset} ${cdim}[1/4]${creset} $label ${cdim}— $piVer${creset}"
    } else {
      $isPerm = Select-String -Path $TmpLog -Pattern "EACCES|permission" -Quiet -ErrorAction SilentlyContinue
      if ($isPerm) {
        Write-Line " ${cred}✖${creset} ${cdim}[1/4]${creset} $label ${cred}permission denied${creset}"
        Write-Line "    ${cdim}try: npm config set prefix ~/.npm-global  or run as admin${creset}"
      } else {
        Write-Line " ${cred}✖${creset} ${cdim}[1/4]${creset} $label ${cred}failed (exit $code)${creset}  ${cdim}see $TmpLog${creset}"
      }
      $ok = $false
    }
  }
} else {
  $hasPi = $null -ne (Get-Command pi -ErrorAction SilentlyContinue)
  $label = if ($hasPi) { "updating pi ($PiPackage)" } else { "installing pi ($PiPackage)" }
  $code = Invoke-NativeWithSpinner -Step "1" -Label $label -FilePath $NpmBin -ArgumentList @("install","-g","$PiPackage@latest","--no-audit","--no-fund","--min-release-age=0")
  if ($code -eq 0) {
    $piVer = try { (pi --version 2>$null).Trim() } catch { "?" }
    Write-Line " ${cgreen}✔${creset} ${cdim}[1/4]${creset} $label ${cdim}— $piVer${creset}"
  } else {
    $isPerm = Select-String -Path $TmpLog -Pattern "EACCES|permission" -Quiet -ErrorAction SilentlyContinue
    if ($isPerm) {
      Write-Line " ${cred}✖${creset} ${cdim}[1/4]${creset} $label ${cred}permission denied${creset}"
      Write-Line "    ${cdim}try: npm config set prefix ~/.npm-global  or run as admin${creset}"
    } else {
      Write-Line " ${cred}✖${creset} ${cdim}[1/4]${creset} $label ${cred}failed (exit $code)${creset}  ${cdim}see $TmpLog${creset}"
    }
    $ok = $false
  }
}

# ── [2/4] pi packages ─────────────────────────────────────────────────────
if ($SkipPackages) {
  Write-Line " ${cgreen}✔${creset} ${cdim}[2/4]${creset} pi packages ${cdim}— skipped${creset}"
} else {
  $need = @()
  foreach ($pkgName in @("pi-context-usage","@baretread/pi-forge")) {
    $inst = Get-GlobalPkgVersion $pkgName
    $latest = Get-LatestPkgVersion $pkgName
    if ($inst -and $latest -and ($inst -eq $latest)) {
      Write-Line "${cdim}  · $pkgName@$inst already installed, skipping${creset}"
    } elseif ($inst -and -not $latest) {
      Write-Line "${cdim}  · $pkgName@$inst already installed, skipping version check (offline)${creset}"
    } else {
      if ($inst) { Write-Line "${cdim}  · $pkgName $inst → $(if ($latest) { $latest } else { 'latest' }) — will update${creset}" }
      $need += "$pkgName@latest"
    }
  }
  if ($need.Count -eq 0) {
    Write-Line " ${cgreen}✔${creset} ${cdim}[2/4]${creset} pi packages ${cdim}— already installed, skipping${creset}"
  } else {
  $label = "installing $($need -join ' ')"
  $code = Invoke-NativeWithSpinner -Step "2" -Label $label -FilePath $NpmBin -ArgumentList (@("install","-g") + $need + @("--no-audit","--no-fund"))
  if ($code -eq 0) {
    # Verify global ls (handles mise/nvm prefix quirks)
    $hasCtx = $null -ne (npm ls -g pi-context-usage 2>$null | Select-String "pi-context-usage")
    $hasForge = $null -ne (npm ls -g "@baretread/pi-forge" 2>$null | Select-String "pi-forge")
    if (-not $hasCtx -or -not $hasForge) {
      Write-Line " ${cyellow}⚠${creset} ${cdim}[2/4]${creset} pi packages installed but not in global ls — continuing${creset}"
    }
    Write-Line " ${cgreen}✔${creset} ${cdim}[2/4]${creset} pi packages ${cdim}— done${creset}"
  } else {
    Write-Line " ${cyellow}⚠${creset} ${cdim}[2/4]${creset} $label ${cyellow}exit $code — continuing (pi will auto-install)${creset}"
    Write-Line "    ${cdim}see $TmpLog${creset}"
  }
  }
}

# ── [3/4] custom config ───────────────────────────────────────────────────
try {
  $sourceRoot = Resolve-SourceRoot -Repo $repoUrl
  Write-Line "${cdim}  source  $sourceRoot${creset}"
  if (-not (Test-Path $sourceRoot)) { throw "source not found: $sourceRoot" }

  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

  # backup (managed files only: extensions + top-level config files).
  # Per-user data (settings.json, auth.json, sessions/, taste/, etc.) is never
  # touched by the installer, so it is deliberately NOT backed up.
  $bak = $null
  $hasExisting = (Test-Path (Join-Path $targetDir "AGENTS.md")) -or (Test-Path (Join-Path $targetDir "extensions"))
  if ($hasExisting) {
    $bak = "$targetDir.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
    Write-Line "${cdim}  backup  $targetDir/extensions → $bak${creset}"
    New-Item -ItemType Directory -Path $bak -Force | Out-Null
    foreach ($f in @("AGENTS.md","keybindings.json","README.md")) {
      $s = Join-Path $targetDir $f
      if (Test-Path $s) { Copy-Item $s (Join-Path $bak $f) -Force -ErrorAction SilentlyContinue }
    }
    $srcBakExt = Join-Path $targetDir "extensions"
    if (Test-Path $srcBakExt) {
      # NOTE: Copy-Item -Exclude only filters top-level items, not recursive
      # contents — copy per-extension while skipping node_modules/.git instead.
      $dstBakExt = Join-Path $bak "extensions"
      Get-ChildItem $srcBakExt -Directory | ForEach-Object {
        $d = Join-Path $dstBakExt $_.Name
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Get-ChildItem $_.FullName -Exclude @("node_modules",".git","bin") | ForEach-Object {
          Copy-Item $_.FullName $d -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }

  # only one backup at a time — delete older siblings, keep the newest
  if ($bak) {
    $bakKeep = Split-Path $bak -Leaf
    $bakBase = Split-Path $targetDir -Leaf
    $bakParent = Split-Path $targetDir -Parent
    Get-ChildItem $bakParent -Directory -Filter "$bakBase.bak.*" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne $bakKeep } |
      ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }

  $copied = 0
  $isSelfInstall = ($sourceRoot -eq $targetDir)
  if ($isSelfInstall) { Write-Line "${cdim}  source == target — skipping file copy (self-install)${creset}" }
  foreach ($f in @("AGENTS.md","keybindings.json","README.md")) {
    $s = Join-Path $sourceRoot $f
    if (-not (Test-Path $s)) { continue }
    $d = Join-Path $targetDir $f
    if ($isSelfInstall -or $s -eq $d) { $copied++; continue }
    Copy-Item $s $d -Force; $copied++
  }
  # settings.json: seed from repo defaults if missing; otherwise keep,
  # unless -OverwriteSettings is passed or the user answers Y.
  $repoSettings = Join-Path $sourceRoot "settings.json"
  $settings     = Join-Path $targetDir "settings.json"
  $settingsJustCreated = $false
  if ((-not (Test-Path $settings)) -and (Test-Path $repoSettings)) {
    Copy-Item $repoSettings $settings
    $settingsJustCreated = $true
    Write-Line "${cdim}  created settings.json from repo defaults${creset}"
  } elseif (Test-Path $settings) {
    if ((Test-WantOverwriteSettings) -and (Test-Path $repoSettings)) {
      if ($bak) { Copy-Item $settings (Join-Path $bak "settings.json") -Force -ErrorAction SilentlyContinue }
      Copy-Item $repoSettings $settings -Force
      $settingsJustCreated = $true
      Write-Line "${cdim}  overwrote settings.json from repo defaults${creset}"
    } else {
      Write-Line "${cdim}  kept existing settings.json${creset}"
    }
  }
  # ensure Pi extensions (forge + context) are registered — only on a freshly
  # seeded settings.json; an existing file is left completely untouched.
  if ($settingsJustCreated -and (Test-Path $settings) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
      $patch = "const fs=require('fs');const p=process.argv[1];try{let j=JSON.parse(fs.readFileSync(p,'utf8'));let need=['npm:pi-context-usage','npm:@baretread/pi-forge'];j.packages=j.packages||[];let c=false;for(let pkg of need){if(!j.packages.includes(pkg)){j.packages.push(pkg);c=true}}if(c){fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n');console.log('  patched settings.json packages -> forge + context') } }catch(e){}"
      node -e $patch $settings 2>$null | ForEach-Object { Write-Line "${cdim}  $_${creset}" }
    } catch {}
  }
  # taste.md / taste/ — user-specific, preserve if exists
  foreach ($preserve in @("taste.md","taste","taste.json")) {
    $p = Join-Path $targetDir $preserve
    $src = Join-Path $sourceRoot $preserve
    if (Test-Path $p) {
      Write-Line "${cdim}  kept existing $preserve${creset}"
    } elseif (Test-Path $src) {
      Copy-Item $src $p -Recurse -Force -Exclude @("node_modules",".git") -ErrorAction SilentlyContinue
    }
  }

  # extensions — skip stray .md files, handle spaces
  $srcExt = Join-Path $sourceRoot "extensions"
  $dstExt = Join-Path $targetDir "extensions"
  if (Test-Path $srcExt) {
    if ($isSelfInstall -or $srcExt -eq $dstExt) {
      # Self-install: extensions already in place — just count, don't delete/re-copy
      Get-ChildItem $srcExt -Directory | Where-Object { $_.Name -notlike "*.md" } | ForEach-Object { $copied++ }
    } else {
      if (-not (Test-Path $dstExt)) { New-Item -ItemType Directory -Path $dstExt -Force | Out-Null }
      Get-ChildItem $srcExt -Directory | ForEach-Object {
        if ($_.Name -like "*.md") { return }
        $dst = Join-Path $dstExt $_.Name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
        # NOTE: Copy-Item -Exclude only filters top-level items, not recursive
        # contents — copy per-item while skipping node_modules/.git instead.
        # (node_modules are rebuilt by each extension's installer in step 4;
        # copying them follows junctions and stalls the install.)
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Get-ChildItem $_.FullName -Exclude @("node_modules",".git") | ForEach-Object {
          Copy-Item $_.FullName $dst -Recurse -Force -ErrorAction SilentlyContinue
        }
        $copied++
      }
    }
  }

  # themes — exclude recursive .pi and nul device file
  $srcThemes = Join-Path $sourceRoot "themes"
  if ((Test-Path $srcThemes) -and -not $isSelfInstall -and $srcThemes -ne (Join-Path $targetDir "themes")) {
    $dstThemes = Join-Path $targetDir "themes"
    if (Test-Path $dstThemes) { Remove-Item $dstThemes -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $dstThemes -Force | Out-Null
    Get-ChildItem $srcThemes -Force | Where-Object { $_.Name -notin @(".pi","nul") } | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $dstThemes $_.Name) -Recurse -Force
    }
  }

  Write-Line " ${cgreen}✔${creset} ${cdim}[3/4]${creset} custom config ${cdim}— $copied items → $targetDir${creset}"
  # cleanup cloned temp — per spec: clone into ~/.pi/tmp, copy agent, delete temp
  if ($script:ClonedTmp -and (Test-Path $script:ClonedTmp)) {
    if ($script:ClonedTmp.StartsWith($PiTmp, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item $script:ClonedTmp -Recurse -Force -ErrorAction SilentlyContinue
      $script:ClonedTmp = $null
    }
  }
  # delete any leftover kiln-* temp dirs from interrupted runs
  Get-ChildItem $PiTmp -Directory -Filter "kiln-*" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $script:ClonedTmp } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  # repo README → alongside the agent dir (e.g. ~/.pi/README.md)
  $repoRoot = Split-Path $sourceRoot -Parent
  $targetParent = Split-Path $targetDir -Parent
  $repoReadme = Join-Path $repoRoot "README.md"
  if ((Test-Path $repoReadme) -and ($repoRoot -ne $targetParent)) {
    Copy-Item $repoReadme (Join-Path $targetParent "README.md") -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Line " ${cred}✖${creset} ${cdim}[3/4]${creset} custom config ${cred}failed:${creset} $($_.Exception.Message)"
  Write-Line "    ${cdim}$($_.ScriptStackTrace)${creset}"
  Write-Line "    ${cdim}see $TmpLog${creset}"
  $ok = $false
}

# ── [4/4] per-extension deps ──────────────────────────────────────────────
try {
  $extRoot = Join-Path $targetDir "extensions"
  $exts = @()
  if (Test-Path $extRoot) { $exts = Get-ChildItem $extRoot -Directory | Where-Object { $_.Name -notlike "*.md" } | Sort-Object Name }

  if ($exts.Count -eq 0) {
    Write-Line " ${cyellow}⚠${creset} ${cdim}[4/4]${creset} no extensions found at $extRoot"
  } else {
    $failed = @()
    $installed = 0
    $skipped = 0
    foreach ($ext in $exts) {
      $label = "extensions/$($ext.Name)"
      if (Test-Path (Join-Path $ext.FullName "node_modules")) {
        Write-Line " ${cdim}  · $label — already installed, skipping${creset}"
        $skipped++
        continue
      }
      $ps1 = Join-Path $ext.FullName "install.ps1"
      $sh  = Join-Path $ext.FullName "install.sh"
      $hasPkg = Test-Path (Join-Path $ext.FullName "package.json")

      if (-not $hasPkg -and -not (Test-Path $ps1)) {
        Write-Line " ${cdim}  · $label — no package.json, skipping${creset}"
        continue
      }

      if (Test-Path $ps1) {
        # prefer pwsh, fallback to powershell
        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
        if ($pwsh) { $code = Invoke-NativeWithSpinner -Step "4" -Label $label -FilePath $pwsh.Source -ArgumentList @("-NoProfile","-File",$ps1) }
        else { $code = Invoke-NativeWithSpinner -Step "4" -Label $label -FilePath "powershell" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$ps1) }
      } elseif (Test-Path $sh) {
        $code = Invoke-NativeWithSpinner -Step "4" -Label $label -FilePath "sh" -ArgumentList @($sh)
      } else {
        $npmArgs = if (Test-Path (Join-Path $ext.FullName "package-lock.json")) { @("--prefix",$ext.FullName,"ci","--no-audit","--no-fund") } else { @("--prefix",$ext.FullName,"install","--no-audit","--no-fund") }
        $code = Invoke-NativeWithSpinner -Step "4" -Label $label -FilePath $NpmBin -ArgumentList $npmArgs
      }

      if ($code -eq 0) {
        Write-Line " ${cgreen}✔${creset} ${cdim}[4/4]${creset} $label"
        $installed++
      } else {
        Write-Line " ${cred}✖${creset} ${cdim}[4/4]${creset} $label ${cred}failed (exit $code)${creset}"
        $failed += $ext.Name
      }
    }
    if ($failed.Count -eq 0) {
      Write-Line " ${cgreen}✔${creset} ${cdim}[4/4]${creset} extension deps ${cdim}— $installed installed, $skipped skipped${creset}"
    } else {
      Write-Line " ${cyellow}⚠${creset} ${cdim}[4/4]${creset} extension deps ${cyellow}$($failed.Count) failed:${creset} $($failed -join ', ')  ${cdim}see $TmpLog${creset}"
    }
  }
} catch {
  Write-Line " ${cred}✖${creset} ${cdim}[4/4]${creset} extension deps ${cred}failed:${creset} $($_.Exception.Message)"
  $ok = $false
}

# ── cleanup + summary ─────────────────────────────────────────────────────
if ($script:ClonedTmp -and (Test-Path $script:ClonedTmp)) {
  Remove-Item $script:ClonedTmp -Recurse -Force -ErrorAction SilentlyContinue
}

$elapsed = (Get-Date) - $script:StartTime
if ($elapsed.TotalSeconds -ge 60) { $elapsedFmt = "{0}m {1}s" -f [int]$elapsed.TotalMinutes, $elapsed.Seconds }
else { $elapsedFmt = "{0}s" -f [int]$elapsed.TotalSeconds }

Write-Line ""
if ($ok) {
  Write-Line "${cgreen}${cbold}  ✓ Setup complete${creset}  ${cdim}→ $targetDir · Kiln installed in $elapsedFmt${creset}"
  $piVer2 = try { (pi --version 2>$null).Trim() } catch { $null }
  if ($piVer2) { Write-Line "${cdim}  pi $piVer2  ·  run: pi${creset}" }
} else {
  Write-Line "${cyellow}${cbold}  ⚠ Setup finished with warnings${creset}  ${cdim}in $elapsedFmt · see $TmpLog${creset}"
}
Write-Line "${cdim}  log: $TmpLog${creset}`n"

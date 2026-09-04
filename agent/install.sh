#!/bin/sh
# Pi custom-setup installer — macOS / Linux / Git Bash
# 1) Install/update pi (@earendil-works/pi-coding-agent)
# 2) Install pi packages  (pi-context-usage, @baretread/pi-forge)
# 3) Install custom config (AGENTS.md, keybindings, extensions …)
# 4) Install per-extension npm deps via each extension's install.sh
#
# TUI inspired by https://pi.dev/install.sh — spinner when TTY, silent otherwise.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.sh | sh
#   ./install.sh --repo https://github.com/asterxsk/kiln --branch main
#   ./install.sh --target ~/.pi/agent --yes
#   ./install.sh --local  # force local checkout, skip clone
#
# Safe to re-run. Managed files are force-overwritten; per-user files
# (settings.json, taste.md, taste/, auth.json, trust.json, sessions/, etc.) are preserved
# (pass --overwrite-settings to replace settings.json — otherwise you are asked).
# Already-installed items are skipped; outdated global packages are updated.
# Only one timestamped backup (<target>.bak.*) is kept; the clone temp dir
# under ~/.pi/tmp/kiln-* is always removed.

set -eu

PI_PACKAGE="@earendil-works/pi-coding-agent"
NODE_MIN="22.19.0"
# Overridden at publish time; fallback is used only for local dev
DEFAULT_REPO="https://github.com/asterxsk/kiln"
# Disable credential prompts — public clone should never ask for GitHub login
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never 2>/dev/null || true
export GIT_ASKPASS=echo 2>/dev/null || true
REPO_URL="${PI_CONFIG_REPO:-}"
BRANCH="${PI_CONFIG_BRANCH:-main}"
TARGET="${PI_AGENT_DIR:-}"
SKIP_PI=0
SKIP_PACKAGES=0
ASSUME_YES=0
FORCE_LOCAL=0
SETTINGS_MODE="ask" # ask | overwrite | keep
CLONED_TMP=""
START_TS="$(date +%s 2>/dev/null || echo 0)"

# ── tmp + log under ~/.pi/tmp ────────────────────────────────────────────
mkdir -p "$HOME/.pi/tmp" 2>/dev/null || true
TMP_BASE="$HOME/.pi/tmp"
if command -v mktemp >/dev/null 2>&1; then
  TMP_LOG="$(mktemp "$TMP_BASE/pi-setup-XXXXXX.log" 2>/dev/null || echo "$TMP_BASE/pi-setup-$$.log")"
else
  TMP_LOG="$TMP_BASE/pi-setup-$$.log"
fi
: > "$TMP_LOG" 2>/dev/null || true
# shellcheck disable=SC2064
trap 'rm -f "$TMP_LOG.sp" 2>/dev/null; if [ -n "$CLONED_TMP" ] && [ -d "$CLONED_TMP" ]; then rm -rf "$CLONED_TMP"; fi' EXIT INT TERM

# ── args ────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    --skip-pi) SKIP_PI=1; shift;;
    --skip-packages) SKIP_PACKAGES=1; shift;;
    --local) FORCE_LOCAL=1; shift;;
    --overwrite-settings) SETTINGS_MODE="overwrite"; shift;;
    --keep-settings) SETTINGS_MODE="keep"; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    --help|-h) echo "Usage: $0 [--repo URL] [--branch BRANCH] [--target DIR] [--local] [--overwrite-settings|--keep-settings] [--yes]"; exit 0;;
    --) shift; break;;
    -*) echo "unknown arg: $1" >&2; exit 1;;
    *) break;;
  esac
done

# ── ANSI / VT ───────────────────────────────────────────────────────────────
ESC="$(printf '\033')"
CR="$(printf '\r')"
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then HAS_ANSI=1; else HAS_ANSI=0; fi
if [ "$HAS_ANSI" -eq 1 ]; then
  C_RESET="${ESC}[0m"; C_BOLD="${ESC}[1m"; C_DIM="${ESC}[2m"
  C_GREEN="${ESC}[32m"; C_YELLOW="${ESC}[33m"; C_RED="${ESC}[31m"
  C_CYAN="${ESC}[36m"; C_GRAY="${ESC}[90m"
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_GRAY=""
fi

# Spinner frames (braille). Kept as a real array so the index advances in the
# PARENT shell — calling get_spinner inside a $(...) subshell discarded the
# increment and froze the spinner on frame 0.
SPINNER_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠰ ⠠ ⠦ ⠧ ⠇ ⠏)
SPINNER_N=${#SPINNER_FRAMES[@]}
SPINNER_IDX=0

write_title() {
  if [ "$HAS_ANSI" -eq 1 ]; then
    printf "${ESC}[1m  \u25C6 Pi Setup${ESC}[0m\n${ESC}[2m  custom agent config  \u00B7  pi + forge + extensions${ESC}[0m\n\n"
  else
    printf "\n  Pi Setup\n  custom agent config  ·  pi + forge + extensions\n\n"
  fi
}

# ── spinner runner ──────────────────────────────────────────────────────────
# run_with_spinner STEP LABEL CMD...
# Synchronous when no TTY (curl|sh, CI, Windows Git Bash without VT).
# When TTY, shows spinner and overwrites line with \r.
run_with_spinner() {
  STEP="$1"; LABEL="$2"; shift 2
  : > "$TMP_LOG.sp" 2>/dev/null || true
  if [ "$HAS_ANSI" -eq 0 ]; then
    # plain run — no spinner, keep output quiet (append to log)
    set +e
    "$@" >"$TMP_LOG.sp" 2>&1; CODE=$?
    set -e
    cat "$TMP_LOG.sp" >> "$TMP_LOG" 2>/dev/null || true
    return $CODE
  fi
  # TTY: spinner
  SPINNER_IDX=0
  set +e
  "$@" >"$TMP_LOG.sp" 2>&1 &
  PID=$!
  set -e
  while kill -0 "$PID" 2>/dev/null; do
    SPIN="${SPINNER_FRAMES[$SPINNER_IDX]}"
    SPINNER_IDX=$(( (SPINNER_IDX + 1) % SPINNER_N ))
    # \r + Erase-in-Line so each frame overwrites cleanly regardless of length
    printf "${CR}${ESC}[K ${C_YELLOW}%s${C_RESET} ${C_DIM}[%s/4]${C_RESET} %s" "$SPIN" "$STEP" "$LABEL"
    sleep 0.08
  done
  set +e
  wait "$PID" 2>/dev/null; CODE=$?
  set -e
  cat "$TMP_LOG.sp" >> "$TMP_LOG" 2>/dev/null || true
  printf "${CR}${ESC}[K"
  return $CODE
}

# ── helpers ─────────────────────────────────────────────────────────────────
resolve_target() {
  if [ -n "$TARGET" ]; then printf "%s" "$TARGET"; return; fi
  # Git Bash on Windows: prefer Windows path if cygpath available
  if command -v cygpath >/dev/null 2>&1; then
    printf "%s" "$(cygpath -w "$HOME/.pi/agent" 2>/dev/null || echo "$HOME/.pi/agent")"
    return
  fi
  printf "%s/.pi/agent" "$HOME"
}

resolve_repo() {
  if [ -n "$REPO_URL" ]; then printf "%s" "$REPO_URL"; return; fi
  # Don't probe when piped (curl | sh) — $0 is sh/dash
  case "$0" in sh|dash|*\/sh|*\/dash|-) printf "%s" "$DEFAULT_REPO"; return;; esac
  HERE=""
  # Try to find a git checkout near the script
  _self=""
  case "$0" in /*|*/*) _self="$(cd "$(dirname "$0")" 2>/dev/null && pwd 2>/dev/null || echo "")";; esac
  for r in "$_self" "$(pwd)" "$(pwd)/agent"; do
    [ -z "$r" ] && continue
    if [ -d "$r/.git" ] || [ -d "$r/../.git" ]; then
      U="$(git -C "$r" remote get-url origin 2>/dev/null || true)"
      if [ -n "$U" ]; then printf "%s" "$U"; return; fi
    fi
  done
  printf "%s" "$DEFAULT_REPO"
}

resolve_source_root() {
  REPO="$1"
  # If forced local or script is inside a checkout, use it
  if [ "$FORCE_LOCAL" -eq 1 ]; then
    for r in "$(cd "$(dirname "$0")" 2>/dev/null && pwd 2>/dev/null || echo "")" "$(pwd)" "$(pwd)/agent"; do
      [ -z "$r" ] && continue
      if [ -d "$r/extensions" ] && [ -f "$r/AGENTS.md" ]; then printf "%s" "$r"; return 0; fi
      if [ -d "$r/agent/extensions" ]; then printf "%s" "$r/agent"; return 0; fi
    done
  else
    # When not piped, check for local checkout first to avoid clone
    case "$0" in sh|dash|*\/sh|*\/dash|-) :;; # piped — skip local check
      *)
        for r in "$(cd "$(dirname "$0")" 2>/dev/null && pwd 2>/dev/null || echo "")" "$(pwd)" "$(pwd)/agent"; do
          [ -z "$r" ] && continue
          if [ -d "$r/extensions" ] && [ -f "$r/AGENTS.md" ]; then printf "%s" "$r"; return 0; fi
          if [ -d "$r/agent/extensions" ]; then printf "%s" "$r/agent"; return 0; fi
        done
        ;;
    esac
  fi
  # Clone to ~/.pi/tmp — simple git clone, no account required, then copy agent folder.
  # Use a unique subdir per run so concurrent installs never clobber each other.
  mkdir -p "$TMP_BASE" 2>/dev/null || true
  if command -v mktemp >/dev/null 2>&1; then
    TMP="$(mktemp -d "$TMP_BASE/kiln-XXXXXX" 2>/dev/null || echo "$TMP_BASE/kiln-$$")"
  else
    TMP="$TMP_BASE/kiln-$$"
  fi
  mkdir -p "$TMP" 2>/dev/null || true
  CLONED_TMP="$TMP"
  printf "${C_DIM}  → cloning %s (branch %s) → %s${C_RESET}\n" "$REPO" "$BRANCH" "$TMP" >&2
  set +e
  run_with_spinner "3" "fetching config" env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo GCM_INTERACTIVE=never git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP"
  CODE=$?
  set -e
  if [ $CODE -ne 0 ]; then
    echo "git clone failed (exit $CODE) — see $TMP_LOG" >&2
    return 1
  fi
  if [ -d "$TMP/agent" ]; then printf "%s" "$TMP/agent"; else printf "%s" "$TMP"; fi
}

# Portable version compare: returns 0 if HAVE >= MIN
version_ge() {
  HAVE="$1"; MIN="$2"
  # Use node itself if available (most reliable), else awk
  if command -v node >/dev/null 2>&1; then
    node -e "const [h,m]=process.argv.slice(1).map(v=>v.split('.').map(Number));let ge=true;for(let i=0;i<Math.max(h.length,m.length);i++){const a=h[i]||0,b=m[i]||0;if(a>b)break;if(a<b){ge=false;break}}process.exit(ge?0:1)" "$HAVE" "$MIN" 2>/dev/null && return 0 || return 1
  fi
  # awk fallback
  printf "%s\n%s\n" "$HAVE" "$MIN" | awk -F. '
    NR==1{split($0,h,"."); next}
    {split($0,m,"."); for(i=1;i<=3;i++){a=h[i]+0; b=m[i]+0; if(a>b)exit 0; if(a<b)exit 1} exit 0}
  ' 2>/dev/null && return 0 || return 1
  # last resort: string compare
  [ "$HAVE" = "$MIN" ] && return 0
  [ "$(printf "%s\n%s" "$HAVE" "$MIN" | sort 2>/dev/null | head -n1)" = "$MIN" ] && return 0 || return 1
}

# Installed global version of a package ("" when not installed).
npm_global_ver() {
  npm ls -g "$1" --depth=0 2>/dev/null | grep -F "$1@" | sed -n 's|.*@\([0-9][0-9A-Za-z.+_-]*\).*|\1|p' | head -n1 | tr -d '\r\n '
}
# Latest registry version ("" when offline / unknown).
npm_latest_ver() {
  _v="$(npm view "$1" version 2>/dev/null | head -n1 | tr -d '\r\n ')"
  case "$_v" in [0-9]*) printf "%s" "$_v";; *) printf "";; esac
}
# Keep only the newest sibling backup (<target>.bak.*); delete the rest.
prune_backups() {
  _pb_keep="$(basename "$2")"
  for _pb_d in "$(dirname "$1")"/"$(basename "$1")".bak.*; do
    [ -e "$_pb_d" ] || continue
    [ "$(basename "$_pb_d")" = "$_pb_keep" ] && continue
    rm -rf "$_pb_d" 2>/dev/null || true
  done
}
# Remove stale clone dirs (~/.pi/tmp/kiln-*) except the active one.
sweep_stale_tmp() {
  for _sw_d in "$TMP_BASE"/kiln-*; do
    [ -e "$_sw_d" ] || continue
    [ -d "$_sw_d" ] || continue
    case "$CLONED_TMP" in "$_sw_d") continue;; esac
    rm -rf "$_sw_d" 2>/dev/null || true
  done
}
# Returns 0 when the user wants settings.json overwritten, 1 to keep.
want_overwrite_settings() {
  if [ "$SETTINGS_MODE" = "overwrite" ]; then return 0; fi
  if [ "$SETTINGS_MODE" = "keep" ]; then return 1; fi
  if [ "$ASSUME_YES" -eq 1 ]; then return 1; fi
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then return 1; fi
  printf "  settings.json exists. Overwrite with repo defaults? [y/N] (Recommended for first-time setup) "
  _ans=""; read -r _ans < /dev/tty 2>/dev/null || read -r _ans 2>/dev/null || _ans=""
  case "$_ans" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

# ── MAIN ─────────────────────────────────────────────────────────────────────
write_title

# Copy a tree excluding heavy/unwanted dirs (node_modules, .git).
# Uses rsync when available, else cp + prune.
# No-op when source and destination are the same path (self-install).
copy_tree() {
  _src="$1"; _dst="$2"
  if [ "$_src" = "$_dst" ]; then return 0; fi
  # Resolve canonical paths to catch ./ vs absolute same target
  _src_can="$(cd "$_src" 2>/dev/null && pwd 2>/dev/null || echo "$_src")"
  _dst_can="$(cd "$_dst" 2>/dev/null && pwd 2>/dev/null || echo "$_dst")"
  if [ "$_src_can" = "$_dst_can" ]; then return 0; fi
  rm -rf "$_dst" 2>/dev/null || true
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude node_modules --exclude '.git' "$_src/" "$_dst/" 2>/dev/null || \
      { cp -R "$_src" "$_dst" 2>/dev/null || true; rm -rf "$_dst/node_modules" "$_dst/.git" 2>/dev/null || true; }
  else
    cp -R "$_src" "$_dst" 2>/dev/null || true
    rm -rf "$_dst/node_modules" "$_dst/.git" 2>/dev/null || true
  fi
}

TARGET_DIR="$(resolve_target)"
REPO_URL="$(resolve_repo)"
OK=1

printf "${C_DIM}  target  ${C_RESET}%s\n" "$TARGET_DIR"
printf "${C_DIM}  repo    ${C_RESET}%s  ${C_DIM}(%s)${C_RESET}\n" "$REPO_URL" "$BRANCH"
printf "${C_DIM}  log     ${C_RESET}%s\n\n" "$TMP_LOG"

# ── preflight ────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  printf "${C_RED}  ✖ Node.js not found. Install Node %s+ from https://nodejs.org${C_RESET}\n" "$NODE_MIN"
  printf "    then re-run this installer.\n\n"
  exit 1
fi
NODE_VER="$(node --version 2>/dev/null | sed 's/^v//;s/[^0-9.].*//' | cut -d- -f1)"
if ! version_ge "$NODE_VER" "$NODE_MIN"; then
  printf "${C_YELLOW}  ⚠ Node %s < %s — please upgrade to Node %s+${C_RESET}\n" "$NODE_VER" "$NODE_MIN" "$NODE_MIN"
  if [ "$ASSUME_YES" -eq 0 ]; then printf "    continue anyway in 3s…\n"; sleep 3; fi
fi
if ! command -v npm >/dev/null 2>&1; then
  printf "${C_RED}  ✖ npm not found (Node installed but npm missing)${C_RESET}\n"; exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  printf "${C_RED}  ✖ git not found — required to fetch config${C_RESET}\n"
  printf "    install via xcode-select --install  or  sudo apt install git\n\n"; exit 1
fi
NPM_VER="$(npm --version 2>/dev/null | tr -d '\n' | tr -d '\r')"
GIT_VER="$(git --version 2>/dev/null | tr -d '\n' | tr -d '\r')"
printf "${C_DIM}  node %s  ·  npm %s  ·  %s${C_RESET}\n\n" "$NODE_VER" "$NPM_VER" "$GIT_VER"

# ── [1/4] pi ────────────────────────────────────────────────────────────────
if [ "$SKIP_PI" -eq 1 ]; then
  printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[1/4]${C_RESET} Install pi ${C_DIM}— skipped${C_RESET}\n"
elif command -v pi >/dev/null 2>&1; then
  PI_INSTALLED="$(npm_global_ver "$PI_PACKAGE")"
  if [ -z "$PI_INSTALLED" ]; then PI_INSTALLED="$(pi --version 2>/dev/null | tr -d '\n' | tr -d '\r' | sed 's/^v//')"; fi
  PI_LATEST="$(npm_latest_ver "$PI_PACKAGE")"
  if [ -n "$PI_INSTALLED" ] && [ -n "$PI_LATEST" ] && [ "$PI_INSTALLED" = "$PI_LATEST" ]; then
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[1/4]${C_RESET} pi ${C_DIM}— already installed (%s), skipping${C_RESET}\n" "$PI_INSTALLED"
  elif [ -n "$PI_INSTALLED" ] && [ -z "$PI_LATEST" ]; then
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[1/4]${C_RESET} pi ${C_DIM}— already installed (%s), skipping version check (offline)${C_RESET}\n" "$PI_INSTALLED"
  else
    if [ -n "$PI_INSTALLED" ] && [ -n "$PI_LATEST" ]; then LABEL="updating pi $PI_INSTALLED → $PI_LATEST ($PI_PACKAGE)"; else LABEL="installing pi ($PI_PACKAGE)"; fi
    set +e
    run_with_spinner "1" "$LABEL" npm install -g "$PI_PACKAGE@latest" --no-audit --no-fund --min-release-age=0
    CODE=$?
    set -e
    if [ $CODE -eq 0 ]; then
      PI_VER="$(pi --version 2>/dev/null | tr -d '\n' | tr -d '\r' || echo "?")"
      printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_DIM}— %s${C_RESET}\n" "$LABEL" "$PI_VER"
    else
      # Check for EACCES
      if grep -q "EACCES\|permission" "$TMP_LOG" 2>/dev/null; then
        printf " ${C_RED}✖${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_RED}failed (permission)${C_RESET}\n" "$LABEL"
        printf "    ${C_DIM}try: sudo npm install -g %s  or  npm config set prefix ~/.npm-global${C_RESET}\n" "$PI_PACKAGE"
      else
        printf " ${C_RED}✖${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_RED}failed (exit %s)${C_RESET}  ${C_DIM}see %s${C_RESET}\n" "$LABEL" "$CODE" "$TMP_LOG"
      fi
      printf "    ${C_DIM}see %s${C_RESET}\n" "$TMP_LOG"
      OK=0
    fi
  fi
else
  if command -v pi >/dev/null 2>&1; then LABEL="updating pi ($PI_PACKAGE)"; else LABEL="installing pi ($PI_PACKAGE)"; fi
  set +e
  run_with_spinner "1" "$LABEL" npm install -g "$PI_PACKAGE@latest" --no-audit --no-fund --min-release-age=0
  CODE=$?
  set -e
  if [ $CODE -eq 0 ]; then
    PI_VER="$(pi --version 2>/dev/null | tr -d '\n' | tr -d '\r' || echo "?")"
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_DIM}— %s${C_RESET}\n" "$LABEL" "$PI_VER"
  else
    # Check for EACCES
    if grep -q "EACCES\|permission" "$TMP_LOG" 2>/dev/null; then
      printf " ${C_RED}✖${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_RED}failed (permission)${C_RESET}\n" "$LABEL"
      printf "    ${C_DIM}try: sudo npm install -g %s  or  npm config set prefix ~/.npm-global${C_RESET}\n" "$PI_PACKAGE"
    else
      printf " ${C_RED}✖${C_RESET} ${C_DIM}[1/4]${C_RESET} %s ${C_RED}failed (exit %s)${C_RESET}  ${C_DIM}see %s${C_RESET}\n" "$LABEL" "$CODE" "$TMP_LOG"
    fi
    printf "    ${C_DIM}see %s${C_RESET}\n" "$TMP_LOG"
    OK=0
  fi
fi

# ── [2/4] pi packages ─────────────────────────────────────────────────────
if [ "$SKIP_PACKAGES" -eq 1 ]; then
  printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[2/4]${C_RESET} pi packages ${C_DIM}— skipped${C_RESET}\n"
else
  NEED=""
  for _pkg in pi-context-usage @baretread/pi-forge; do
    _inst="$(npm_global_ver "$_pkg")"
    _latest="$(npm_latest_ver "$_pkg")"
    if [ -n "$_inst" ] && [ -n "$_latest" ] && [ "$_inst" = "$_latest" ]; then
      printf "${C_DIM}  · %s@%s already installed, skipping${C_RESET}\n" "$_pkg" "$_inst"
    elif [ -n "$_inst" ] && [ -z "$_latest" ]; then
      printf "${C_DIM}  · %s@%s already installed, skipping version check (offline)${C_RESET}\n" "$_pkg" "$_inst"
    else
      if [ -n "$_inst" ]; then printf "${C_DIM}  · %s %s → %s — will update${C_RESET}\n" "$_pkg" "$_inst" "${_latest:-latest}"; fi
      NEED="$NEED $_pkg@latest"
    fi
  done
  if [ -z "$NEED" ]; then
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[2/4]${C_RESET} pi packages ${C_DIM}— already installed, skipping${C_RESET}\n"
  else
  LABEL="installing$NEED"
  set +e
  # shellcheck disable=SC2086
  run_with_spinner "2" "$LABEL" npm install -g $NEED --no-audit --no-fund
  CODE=$?
  set -e
  if [ $CODE -eq 0 ]; then
    # Verify packages are resolvable (handles npm global prefix quirks with mise/nvm)
    if ! npm ls -g pi-context-usage >/dev/null 2>&1 || ! npm ls -g @baretread/pi-forge >/dev/null 2>&1; then
      printf " ${C_YELLOW}⚠${C_RESET} ${C_DIM}[2/4]${C_RESET} pi packages installed but not in global ls — retrying with prefix check${C_RESET}\n"
    fi
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[2/4]${C_RESET} pi packages ${C_DIM}— done${C_RESET}\n"
  else
    printf " ${C_YELLOW}⚠${C_RESET} ${C_DIM}[2/4]${C_RESET} %s ${C_YELLOW}exit %s — continuing (pi will auto-install)${C_RESET}\n" "$LABEL" "$CODE"
    printf "    ${C_DIM}see %s${C_RESET}\n" "$TMP_LOG"
  fi
  fi
fi

# ── [3/4] custom config ───────────────────────────────────────────────────
set +e
# NOTE: no command substitution here — resolve_source_root records the clone
# dir in $CLONED_TMP, which would be lost in a $(...) subshell (that is why
# ~/.pi/tmp was never deleted after install).
resolve_source_root "$REPO_URL" >"$TMP_LOG.src"
SRC_CODE=$?
SOURCE_ROOT="$(cat "$TMP_LOG.src" 2>/dev/null || echo "")"
rm -f "$TMP_LOG.src" 2>/dev/null || true
set -e
if [ $SRC_CODE -ne 0 ] || [ -z "$SOURCE_ROOT" ] || [ ! -d "$SOURCE_ROOT" ]; then
  printf " ${C_RED}✖${C_RESET} ${C_DIM}[3/4]${C_RESET} custom config ${C_RED}failed:${C_RESET} source not found\n"
  printf "    ${C_DIM}see %s${C_RESET}\n" "$TMP_LOG"
  OK=0
else
  printf "${C_DIM}  source  %s${C_RESET}\n" "$SOURCE_ROOT"
  mkdir -p "$TARGET_DIR" 2>/dev/null || true

  # backup (managed files only: extensions + top-level config files).
  # Per-user data (settings.json, auth.json, sessions/, taste/, etc.) is never
  # touched by the installer, so it is deliberately NOT backed up.
  BAK=""
  if [ -f "$TARGET_DIR/AGENTS.md" ] || [ -d "$TARGET_DIR/extensions" ]; then
    BAK="$TARGET_DIR.bak.$(date +%Y%m%d-%H%M%S 2>/dev/null || echo $$)"
    printf "${C_DIM}  backup  %s/extensions → %s${C_RESET}\n" "$TARGET_DIR" "$BAK"
    set +e
    mkdir -p "$BAK" 2>/dev/null || true
    for f in AGENTS.md keybindings.json README.md version.txt; do
      [ -f "$TARGET_DIR/$f" ] && cp -f "$TARGET_DIR/$f" "$BAK/$f" 2>/dev/null || true
    done
    if [ -d "$TARGET_DIR/extensions" ]; then
      copy_tree "$TARGET_DIR/extensions" "$BAK/extensions" || printf "${C_YELLOW}  ⚠ backup extensions failed${C_RESET}\n"
    fi
    set -e
    prune_backups "$TARGET_DIR" "$BAK" # only one backup at a time
  fi

  COPIED=0
  set +e
  for f in AGENTS.md keybindings.json README.md version.txt; do
    if [ -f "$SOURCE_ROOT/$f" ]; then
      # Self-install: source == target — no copy needed, just count
      if [ "$SOURCE_ROOT/$f" = "$TARGET_DIR/$f" ] || [ "$SOURCE_ROOT" = "$TARGET_DIR" ]; then
        COPIED=$((COPIED+1))
      else
        cp -f "$SOURCE_ROOT/$f" "$TARGET_DIR/$f" 2>/dev/null && COPIED=$((COPIED+1)) || printf "${C_YELLOW}  ⚠ copy %s failed${C_RESET}\n" "$f"
      fi
    fi
  done
  # per-user files: seed from repo defaults if missing; otherwise keep,
  # unless --overwrite-settings is passed or the user answers Y.
  SETTINGS_JUST_CREATED=0
  if [ ! -f "$TARGET_DIR/settings.json" ] && [ -f "$SOURCE_ROOT/settings.json" ]; then
    if cp "$SOURCE_ROOT/settings.json" "$TARGET_DIR/settings.json" 2>/dev/null; then
      printf "${C_DIM}  created settings.json from repo defaults${C_RESET}\n"
      SETTINGS_JUST_CREATED=1
    fi
  elif [ -f "$TARGET_DIR/settings.json" ]; then
    if want_overwrite_settings && [ -f "$SOURCE_ROOT/settings.json" ]; then
      if [ -n "$BAK" ]; then cp -f "$TARGET_DIR/settings.json" "$BAK/settings.json" 2>/dev/null || true; fi
      if cp -f "$SOURCE_ROOT/settings.json" "$TARGET_DIR/settings.json" 2>/dev/null; then
        printf "${C_DIM}  overwrote settings.json from repo defaults${C_RESET}\n"
        SETTINGS_JUST_CREATED=1
      fi
    else
      printf "${C_DIM}  kept existing settings.json${C_RESET}\n"
    fi
  fi
  # ensure Pi extensions (forge + context) are registered — only on a freshly
  # seeded settings.json; an existing file is left completely untouched.
  if [ "$SETTINGS_JUST_CREATED" = "1" ] && [ -f "$TARGET_DIR/settings.json" ] && command -v node >/dev/null 2>&1; then
    node -e "const fs=require('fs');const p=process.argv[1];try{let j=JSON.parse(fs.readFileSync(p,'utf8'));let need=['npm:pi-context-usage','npm:@baretread/pi-forge'];j.packages=j.packages||[];let c=false;for(let pkg of need){if(!j.packages.includes(pkg)){j.packages.push(pkg);c=true}}if(c){fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n');console.log('  patched settings.json packages → forge + context') } }catch(e){}" "$TARGET_DIR/settings.json" 2>/dev/null || true
  fi
  # taste.md / taste/ — user-specific, preserve if exists
  for _preserve in taste.md taste taste.json; do
    if [ -f "$TARGET_DIR/$_preserve" ] || [ -d "$TARGET_DIR/$_preserve" ]; then
      printf "${C_DIM}  kept existing %s${C_RESET}\n" "$_preserve"
    elif [ -e "$SOURCE_ROOT/$_preserve" ]; then
      cp -R "$SOURCE_ROOT/$_preserve" "$TARGET_DIR/$_preserve" 2>/dev/null || true
    fi
  done
  # auth.json / trust.json / sessions etc. are never shipped in kiln, so no copy needed; they remain untouched

  # extensions — full sync (set +e so one bad copy doesn't abort)
  if [ -d "$SOURCE_ROOT/extensions" ]; then
    mkdir -p "$TARGET_DIR/extensions" 2>/dev/null || true
    for d in "$SOURCE_ROOT/extensions"/*; do
      [ -e "$d" ] || continue
      [ -d "$d" ] || continue
      # skip stray files like AGENTS.md inside extensions
      case "$(basename "$d")" in *.md) continue;; esac
      base="$(basename "$d")"
      copy_tree "$d" "$TARGET_DIR/extensions/$base" && COPIED=$((COPIED+1)) || printf "${C_YELLOW}  ⚠ copy extensions/%s failed${C_RESET}\n" "$base"
    done
  fi

  # themes if present — skip recursive .pi artifact and nul device file
  # Skip if source == target (self-install) — themes already in place
  if [ "$SOURCE_ROOT" != "$TARGET_DIR" ] && [ -d "$SOURCE_ROOT/themes" ]; then
    rm -rf "$TARGET_DIR/themes" 2>/dev/null || true
    mkdir -p "$TARGET_DIR/themes" 2>/dev/null || true
    # copy themes but exclude .pi and nul
    for t in "$SOURCE_ROOT/themes"/*; do
      [ -e "$t" ] || continue
      bn="$(basename "$t")"
      case "$bn" in .pi|nul) continue;; esac
      cp -R "$t" "$TARGET_DIR/themes/$bn" 2>/dev/null || printf "${C_YELLOW}  ⚠ copy themes/%s failed${C_RESET}\n" "$bn"
    done
    # also copy files at themes root
    for tf in "$SOURCE_ROOT/themes"/.* "$SOURCE_ROOT/themes"/*; do
      [ -f "$tf" ] || continue
      bn="$(basename "$tf")"
      case "$bn" in .|..|.pi|nul) continue;; esac
      cp -f "$tf" "$TARGET_DIR/themes/$bn" 2>/dev/null || true
    done
  fi
  set -e

  printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[3/4]${C_RESET} custom config ${C_DIM}— %s items → %s${C_RESET}\n" "$COPIED" "$TARGET_DIR"
  # cleanup cloned temp — per spec: clone into ~/.pi/tmp, copy agent, delete temp
  case "$CLONED_TMP" in
    "$TMP_BASE"/kiln-*) rm -rf "$CLONED_TMP" 2>/dev/null || true; CLONED_TMP="";;
  esac
  sweep_stale_tmp # delete any leftover kiln-* temp dirs
  # repo README → alongside the agent dir (e.g. ~/.pi/README.md)
  REPO_ROOT="$(cd "$SOURCE_ROOT/.." 2>/dev/null && pwd 2>/dev/null || echo "")"
  TARGET_PARENT="$(cd "$(dirname "$TARGET_DIR")" 2>/dev/null && pwd 2>/dev/null || echo "")"
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/README.md" ] && [ -n "$TARGET_PARENT" ] && [ "$REPO_ROOT" != "$TARGET_PARENT" ]; then
    cp -f "$REPO_ROOT/README.md" "$TARGET_PARENT/README.md" 2>/dev/null || true
  fi
fi

# ── [4/4] per-extension deps ──────────────────────────────────────────────
EXT_ROOT="$TARGET_DIR/extensions"
if [ ! -d "$EXT_ROOT" ]; then
  printf " ${C_YELLOW}⚠${C_RESET} ${C_DIM}[4/4]${C_RESET} no extensions found at %s\n" "$EXT_ROOT"
else
  FAILED=""
  INSTALLED=0
  SKIPPED=0
  set +e
  for ext in "$EXT_ROOT"/*; do
    [ -e "$ext" ] || continue
    [ -d "$ext" ] || continue
    case "$(basename "$ext")" in *.md) continue;; esac
    name="$(basename "$ext")"
    label="extensions/$name"
    if [ -d "$ext/node_modules" ]; then
      printf " ${C_DIM}  · %s — already installed, skipping${C_RESET}\n" "$label"
      SKIPPED=$((SKIPPED+1))
      continue
    fi
    has_pkg=0; [ -f "$ext/package.json" ] && has_pkg=1
    has_sh=0;  [ -f "$ext/install.sh" ] && has_sh=1

    if [ "$has_pkg" -eq 0 ] && [ "$has_sh" -eq 0 ]; then
      printf " ${C_DIM}  · %s — no package.json, skipping${C_RESET}\n" "$label"
      continue
    fi

    if [ "$has_sh" -eq 1 ]; then
      run_with_spinner "4" "$label" sh "$ext/install.sh"
      CODE=$?
    else
      if [ -f "$ext/package-lock.json" ]; then
        run_with_spinner "4" "$label" npm --prefix "$ext" ci --no-audit --no-fund
        CODE=$?
      else
        run_with_spinner "4" "$label" npm --prefix "$ext" install --no-audit --no-fund
        CODE=$?
      fi
    fi
    if [ $CODE -eq 0 ]; then
      printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[4/4]${C_RESET} %s\n" "$label"
      INSTALLED=$((INSTALLED+1))
    else
      printf " ${C_RED}✖${C_RESET} ${C_DIM}[4/4]${C_RESET} %s ${C_RED}failed (exit %s)${C_RESET}\n" "$label" "$CODE"
      FAILED="$FAILED $name"
    fi
  done
  set -e
  if [ -z "$FAILED" ]; then
    printf " ${C_GREEN}✔${C_RESET} ${C_DIM}[4/4]${C_RESET} extension deps ${C_DIM}— %s installed, %s skipped${C_RESET}\n" "$INSTALLED" "$SKIPPED"
  else
    # count without wc -w (no fork)
    CNT=0; for _ in $FAILED; do CNT=$((CNT+1)); done
    printf " ${C_YELLOW}⚠${C_RESET} ${C_DIM}[4/4]${C_RESET} extension deps ${C_YELLOW}%s failed:${C_RESET}%s  ${C_DIM}see %s${C_RESET}\n" "$CNT" "$FAILED" "$TMP_LOG"
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────
END_TS="$(date +%s 2>/dev/null || echo 0)"
ELAPSED=$((END_TS - START_TS))
[ "$ELAPSED" -lt 0 ] 2>/dev/null && ELAPSED=0
if [ "$ELAPSED" -ge 60 ]; then
  ELAPSED_FMT="$((ELAPSED / 60))m $((ELAPSED % 60))s"
else
  ELAPSED_FMT="${ELAPSED}s"
fi
printf "\n"
if [ "$OK" -eq 1 ]; then
  printf "${C_GREEN}${C_BOLD}  ✓ Setup complete${C_RESET}  ${C_DIM}→ %s · Kiln installed in %s${C_RESET}\n" "$TARGET_DIR" "$ELAPSED_FMT"
  if command -v pi >/dev/null 2>&1; then
    PI_VER2="$(pi --version 2>/dev/null | tr -d '\n' | tr -d '\r' || echo "")"
    if [ -n "$PI_VER2" ]; then printf "${C_DIM}  pi %s  ·  run: pi${C_RESET}\n" "$PI_VER2"; fi
  fi
else
  printf "${C_YELLOW}${C_BOLD}  ⚠ Setup finished with warnings${C_RESET}  ${C_DIM}in %s · see %s${C_RESET}\n" "$ELAPSED_FMT" "$TMP_LOG"
fi
printf "${C_DIM}  log: %s${C_RESET}\n\n" "$TMP_LOG"

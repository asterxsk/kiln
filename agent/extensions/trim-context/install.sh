#!/bin/sh
# Per-extension installer — macOS / Linux
# Installs npm dependencies for this extension. No-op if no package.json.
set -eu
# Drop npm_config_allow_scripts inherited from a parent npm/npx process:
# npm >=11 rejects it for project installs (EALLOWSCRIPTS). File config still applies.
unset npm_config_allow_scripts NPM_CONFIG_ALLOW_SCRIPTS 2>/dev/null || true
EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$EXT_DIR/package.json" ]; then
  echo "  · no package.json — skipping"
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "  ✖ npm not found — install Node.js 22+" >&2
  exit 1
fi
if [ -f "$EXT_DIR/package-lock.json" ]; then
  echo "  · npm ci"
  npm --prefix "$EXT_DIR" ci --no-audit --no-fund
else
  echo "  · npm install"
  npm --prefix "$EXT_DIR" install --no-audit --no-fund
fi
echo "  ✓ done"

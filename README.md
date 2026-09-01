# kiln — pi agent configuration

> Portable, minimal configuration for [pi](https://github.com/badlogic/pi-mono) — custom workflows, self-improving architecture, zero secrets.

[![pi >=0.84.4](https://img.shields.io/badge/pi-%3E%3D0.84.4-6e56ff)](https://github.com/badlogic/pi-mono)
[![node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933)](https://nodejs.org)
[![license MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#install)

**kiln** is an opinionated, versioned `~/.pi/agent` that replaces ad-hoc dotfile copying with a reproducible, idempotent installer. It ships curated extensions, a forge-themed TUI, and hardened install/update scripts that safely overwrite managed files while never clobbering your per-user state.

---

## Features

- **Curated extensions** — 11 self-contained pi extensions, each with its own `package.json` and `install.sh/ps1`
- **Safe installer** — `GIT_TERMINAL_PROMPT=0`, public HTTPS clone, atomic overwrites, preserved user files
- **Forge-first UX** — `theme: forge`, `tuiMode: fullscreen`, high thinking by default
- **Secret-free** — `auth.json`, `sessions/`, `trust.json`, `models-store.json`, `bin/`, `themes/.pi` are `.gitignore`'d
- **Cross-platform** — `install.sh` for macOS/Linux/Git Bash, `install.ps1` for PowerShell

### Extensions

| Extension | What it does |
|-----------|--------------|
| `modelconf` | Per-provider model browser, fuzzy filter, bulk glob, `enabledModels` persistence |
| `todo` | Agent todo list with overlay |
| `ask-user` | Structured user prompts |
| `background-terminals` | Long-lived terminal manager |
| `subagents` | Subagent orchestration (Claude/Codex/pi) |
| `file-search` | First-class `fd`/`rg` tools with binary auto-install |
| `pi-web-access` | Web search & fetch |
| `goal` | Goal-driven execution loop |
| `trim-context` | Context compaction |
| `status line` | Status line renderer |
| `shared` | Cross-extension utilities (timeouts, sessions, context) |

Each extension lives at `agent/extensions/{name}/index.ts`.

---

## Quick start

### One-line installer (recommended)

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.sh | sh
```

```powershell
# Windows PowerShell
powershell -c "irm https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.ps1 | iex"
```

What it does:
1. Installs/updates `pi` (`@earendil-works/pi-coding-agent`)
2. Installs `pi-context-usage` + `@baretread/pi-forge`
3. Clones `asterxsk/kiln` (no credential prompt) and copies managed files to `~/.pi/agent`, overwriting extensions/config but preserving `settings.json`, `taste.md`, etc.
4. Runs each extension's `install.sh/ps1` (`npm ci`)

Safe to re-run. Use `--help` for options (`--repo`, `--branch`, `--target`, `--local`, `--skip-pi`, `--skip-packages`, `--yes`).

### Manual install

```bash
git clone https://github.com/asterxsk/kiln.git ~/.pi/agent
# or overlay onto existing config
cp -r agent/extensions ~/.pi/agent/
cp agent/example-settings.json ~/.pi/agent/settings.json
cp agent/keybindings.json ~/.pi/agent/keybindings.json
cp agent/AGENTS.md ~/.pi/agent/AGENTS.md
```

Then create your local `settings.json`:

```bash
cp ~/.pi/agent/example-settings.json ~/.pi/agent/settings.json
# edit settings.json — add enabledModels, providers, etc. (never commit auth.json)
```

---

## Repository layout

```
.
├── README.md                    # ← you are here (GitHub-visible)
├── .gitignore
└── agent/
    ├── AGENTS.md                # behavioral guidelines (merged into every session)
    ├── README.md                # pointer → ../README.md
    ├── example-settings.json    # canonical settings — copy to settings.json
    ├── keybindings.json         # TUI keybindings
    ├── install.sh               # macOS/Linux installer
    ├── install.ps1              # Windows installer
    └── extensions/              # self-contained pi extensions
```

Tracked paths only: `agent/extensions`, `agent/example-settings.json`, `agent/keybindings.json`, `agent/AGENTS.md`, `agent/install.*`, `README.md`. Everything else is local-only.

---

## Configuration

`agent/example-settings.json` is the source of truth:

```json
{
  "theme": "forge",
  "tuiMode": "fullscreen",
  "defaultThinkingLevel": "high",
  "doubleEscapeAction": "tree",
  "packages": ["npm:pi-context-usage", "npm:@baretread/pi-forge"],
  "extensions": ["extensions/"],
  "themes": ["themes"]
}
```

Copy to `agent/settings.json` (gitignored) and customize. `settings.json` is **never** overwritten by the installer — nor are `taste.md`, `taste/`, `auth.json`, `trust.json`, `sessions/`, or other per-user files. All other managed files are force-overwritten on install/update, discarding untracked local edits.

---

## Keybindings

| Binding | Action |
|---------|--------|
| `enter` | submit |
| `shift+enter` | new line |
| `ctrl+enter` | follow-up message |
| `alt+s` | save models |

See `agent/keybindings.json` for full map.

---

## AGENTS.md

Behavioral guidelines for the agent: *think before coding*, *simplicity first*, *surgical changes*, *goal-driven execution*. This file is copied to `~/.pi/agent/AGENTS.md` and merged into every project session.

---

## Requirements

- `pi >= 0.84.4` (`npm i -g @earendil-works/pi-coding-agent`)
- `node >= 22.19.0` + `npm`, `git`
- Platform: macOS, Linux, Windows (Git Bash or PowerShell)

---

## Development

```bash
git clone https://github.com/asterxsk/kiln.git
cd kiln
./agent/install.sh --target /tmp/pi-test --skip-pi --skip-packages --yes
ls /tmp/pi-test/extensions
```

---

## License

MIT

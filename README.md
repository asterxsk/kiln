# kiln — pi agent configuration

> A compact-tuned, self-improving `~/.pi/agent` for [pi](https://github.com/badlogic/pi-mono): curated extensions, opinionated defaults, and an installer you can re-run without fear.

<p align="center">
  <a href="https://github.com/badlogic/pi-mono"><img src="https://badges.ws/badge/PI-0.84.4+-8b5cf6?style=for-the-badge&label_color=101418" alt="pi >=0.84.4" /></a>
  <a href="https://nodejs.org"><img src="https://badges.ws/badge/NODE-22.19+-8b5cf6?style=for-the-badge&label_color=101418" alt="node >=22.19" /></a>
  <a href="LICENSE"><img src="https://badges.ws/badge/LICENSE-MIT-8b5cf6?style=for-the-badge&label_color=101418" alt="license MIT" /></a>
  <a href="#quick-start"><img src="https://badges.ws/badge/PLATFORM-MACOS_%7C_LINUX_%7C_WINDOWS-8b5cf6?style=for-the-badge&label_color=101418" alt="platform" /></a>
</p>

Dotfiles rot. Extensions drift out of sync. A fresh machine means an afternoon of copy-paste archaeology. **kiln** fixes that: your whole agent setup — workflows, TUI, keybindings, eleven curated extensions — lives in one versioned repo with an idempotent installer. Run it on day one, re-run it on day one hundred; your state survives either way.

---

## Quick start

One line, then you're done:

```bash
npx @asterxsk/kiln --yes
```

What the installer does:

1. Installs or updates `pi` itself via the official script — `curl -fsSL https://pi.dev/install.sh | sh` on Linux/macOS, `powershell -c "irm https://pi.dev/install.ps1 | iex"` on Windows (never npm)
2. Installs the `pi-context-usage` and `pi-compact-tools` packages
3. Clones `asterxsk/kiln` over plain HTTPS (no credential prompts, ever) and copies the managed files into `~/.pi/agent` — extensions and config get overwritten; `settings.json` and `compact-tools.json` are seeded from the repo's defaults (and refreshed while still untouched), while `taste/` and secrets are left alone
4. Runs each extension's `install.sh` / `install.ps1` (`npm ci`)

**Safe to re-run.** It backs up the extensions and config files it replaces, leaves anything you've edited in `settings.json` / `compact-tools.json` alone, and accepts `--help` options (`--repo`, `--branch`, `--target`, `--local`, `--skip-pi`, `--skip-packages`, `--yes`) when you want control. The installer always clones the repo over plain HTTPS — no credential prompts, ever — so every install starts from the latest GitHub code (`--repo`/`--branch` for forks, `--local` for a local checkout).

### Publishing the npm package

```bash
npm login                    # once, as asterxsk
npm pack --dry-run           # review the file list — payload mirrors git, secrets must never appear
npm publish --access public  # ships bin/kiln.js + agent payload
```

Prefer to do it by hand?

```bash
git clone https://github.com/asterxsk/kiln.git
cp -r kiln/agent/extensions ~/.pi/agent/
cp kiln/agent/{AGENTS.md,keybindings.json,settings.json} ~/.pi/agent/
# then edit ~/.pi/agent/settings.json — models, providers, etc. (never commit auth.json)
```

---

## Features

- **Curated extensions** — 11 self-contained pi extensions, each with its own `package.json` and installer. No global dependency soup.
- **Safe installer** — public HTTPS clone, atomic overwrites, narrow backups of only the files it replaces. Your config is never collateral damage.
- **Compact-first UX** — `pi-compact-tools` (Claude / Codex / Compact tool rows), `theme: github-dark-pro`, fullscreen TUI, high thinking by default. Built for long sessions.
- **Secret-free by construction** — `auth.json`, `sessions/`, `trust.json`, `models-store.json`, `bin/`, and `themes/.pi` are `.gitignore`'d. The repo holds config, never credentials.
- **Cross-platform** — one Node installer for macOS, Linux, and Windows.

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

Each extension lives at `agent/extensions/{name}/index.ts` and installs independently.

---

## Repository layout

```
.
├── README.md                    # ← you are here (GitHub-visible)
├── .gitignore
└── agent/
    ├── AGENTS.md                # behavioral guidelines (merged into every session)
    ├── README.md                # pointer → ../README.md
    ├── settings.json            # canonical defaults (seeded once, then yours)
    ├── compact-tools.json       # tool-row style (defaults to codex)
    ├── keybindings.json         # TUI keybindings
    └── extensions/              # self-contained pi extensions
```

Tracked paths only: `agent/extensions`, `agent/settings.json`, `agent/keybindings.json`, `agent/compact-tools.json`, `agent/AGENTS.md`, `README.md`. Everything else is local-only.

---

## Configuration

`agent/settings.json` is the source of truth — a curated baseline with machine- and user-specific fields (default model/provider, hidden/enabled models, device id, disabled skills) stripped out. First install seeds it; after that the installer refreshes it only while it still matches the baseline exactly, so any edit you make is respected. The flavor in one glance:

```json
{
  "theme": "github-dark-pro",
  "tuiMode": "fullscreen",
  "defaultProjectTrust": "always",
  "packages": ["npm:pi-context-usage", "npm:pi-compact-tools"]
}
```

Your live copy at `~/.pi/agent/settings.json` is yours — pick your own models, favorites, and providers in it; kiln won't touch them once the file diverges from the baseline.

### Tool rows

`agent/compact-tools.json` seeds the `pi-compact-tools` style to `codex` on install. If you switch styles with `/compact-tools`, the installer keeps your choice on re-runs — it only (re)applies the default while the style is unchanged.

### Keybindings

| Keys | Action |
|------|--------|
| `enter` | submit |
| `shift+enter` | new line |
| `ctrl+enter` | follow-up message |
| `alt+s` | save models |

See `agent/keybindings.json` for the full map.

---

## AGENTS.md

The house rules, merged into every session: *think before coding*, *simplicity first*, *surgical changes*, *goal-driven execution*. Copied to `~/.pi/agent/AGENTS.md` on install — read it before sending the agent off to build things.

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
node bin/kiln.js --local --target /tmp/pi-test --skip-pi --skip-packages --yes
ls /tmp/pi-test/extensions
```

The `--target` flag installs into a scratch directory, so you can test installer changes without touching your live config.

---

## License

MIT

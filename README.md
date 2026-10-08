# kiln — pi agent configuration

> A compact-tuned, self-improving `~/.pi/agent` for [pi](https://github.com/badlogic/pi-mono): curated extensions, opinionated defaults, and an installer you can re-run without fear.

<p align="center">
  <a href="https://github.com/badlogic/pi-mono"><img src="https://badges.ws/badge/PI-0.84.4+-8b5cf6?style=for-the-badge&label_color=101418" alt="pi >=0.84.4" /></a>
  <a href="https://nodejs.org"><img src="https://badges.ws/badge/NODE-22.19+-8b5cf6?style=for-the-badge&label_color=101418" alt="node >=22.19" /></a>
  <a href="LICENSE"><img src="https://badges.ws/badge/LICENSE-MIT-8b5cf6?style=for-the-badge&label_color=101418" alt="license MIT" /></a>
  <a href="#quick-start"><img src="https://badges.ws/badge/PLATFORM-MACOS_%7C_LINUX_%7C_WINDOWS-8b5cf6?style=for-the-badge&label_color=101418" alt="platform" /></a>
</p>

Dotfiles rot. Extensions drift out of sync. A fresh machine means an afternoon of copy-paste archaeology. **kiln** fixes that: your whole agent setup — workflows, TUI, keybindings, fifteen curated extensions — lives in one versioned repo with an idempotent installer. Run it on day one, re-run it on day one hundred; your state survives either way.

---

## Quick start

One line, then you're done:

```bash
npx @asterxsk/kiln@latest
```

What the installer does:

1. Installs or updates `pi` itself via the official script — `curl -fsSL https://pi.dev/install.sh | sh` on Linux/macOS, `powershell -c "irm https://pi.dev/install.ps1 | iex"` on Windows (never npm)
2. Installs the `pi-context-usage` and `pi-compact-tools` packages
3. Clones `asterxsk/kiln` over plain HTTPS (no credential prompts, ever) and copies the managed files into `~/.pi/agent` — extensions are refreshed every run; agent config (`AGENTS.md`, `keybindings.json`, `settings.json`, `compact-tools.json`) is seeded on first install only and then never overwritten, while `taste/` and secrets are left alone
4. Runs each extension's `install.sh` / `install.ps1` (`npm ci`)

**Safe to re-run.** Extensions are refreshed; the agent config files (`AGENTS.md`, `keybindings.json`, `settings.json`, `compact-tools.json`) are seeded on first install only and then left alone. It backs up what it replaces and accepts `--help` options (`--repo`, `--branch`, `--target`, `--local`, `--skip-pi`, `--skip-packages`, `--yes`) when you want control. The installer always clones the repo over plain HTTPS — no credential prompts, ever — so every install starts from the latest GitHub code (`--repo`/`--branch` for forks, `--local` for a local checkout).

### Manual install

Prefer to wire it up yourself, without the installer:

```bash
git clone https://github.com/asterxsk/kiln.git
cp -r kiln/agent/extensions ~/.pi/agent/
cp kiln/agent/{AGENTS.md,keybindings.json,settings.json} ~/.pi/agent/
# then edit ~/.pi/agent/settings.json — models, providers, etc. (never commit auth.json)
```

---

## Features

- **Curated extensions** — fifteen self-contained pi extensions, each with its own `package.json` and installer. No global dependency soup.
- **Safe installer** — public HTTPS clone, atomic overwrites, narrow backups of only the files it replaces. Your config is never collateral damage.
- **Compact-first UX** — `pi-compact-tools` (Claude / Codex / Compact tool rows), `theme: github-dark-pro`, fullscreen TUI, high thinking by default. Built for long sessions.
- **Cross-session memory** — bounded global + project memory, with automatic end-of-turn reflection (see [Memory](#memory)).
- **Secret-free by construction** — `auth.json`, `sessions/`, `trust.json`, `models-store.json`, `bin/`, and `themes/.pi` are `.gitignore`'d. The repo holds config, never credentials.
- **Cross-platform** — one Node installer for macOS, Linux, and Windows.

---

## Extensions

| Extension | What it does |
|-----------|--------------|
| `ask-user` | The model asks a single multiple-choice question in a popup (arrow/number keys, inline "write my own answer" editor) |
| `background-terminals` | Start and manage long-running shell processes the model can read from, write to, and stop |
| `destructive` | Intercepts destructive `bash` / `powershell` calls (e.g. deletions) and asks first |
| `file-search` | First-class `fd` / `rg` tools, with automatic binary install |
| `goal` | Keeps the agent working until a stated goal is achieved |
| `kiln-update` | Slim kiln header for pi, plus a nudge when your install is behind GitHub |
| `memory` | Bounded cross-session memory — global + project `MEMORY.md` / `USER.md`, injected into the system prompt |
| `modelconf` | Per-provider model visibility manager — fuzzy filter, bulk glob, `enabledModels` persistence |
| `pi-web-access` | Web search and page fetch |
| `shared` | Cross-extension utilities (timeouts, sessions, context) |
| `skillsconf` | Per-skill visibility manager, with named packages for mass enable/disable |
| `statusline` | Custom status line / footer renderer |
| `subagents` | Subagent orchestration on one of three backends (Claude Code, Codex, pi) |
| `todo` | Agent todo list with a persistent overlay |
| `trim-context` | Aggressive context compaction (crush / amp / lsp style) so long sessions keep going |

Each extension lives at `agent/extensions/{name}/index.ts` and installs independently.

---

## Memory

The `memory` extension gives the agent bounded, curated cross-session memory (ported from the Hermes Agent framework). It has two axes:

- **scope** — `global` (shared across projects) or `project` (specific to the working directory)
- **target** — `memory` (the agent's own notes) or `user` (your profile)

Each pair is one markdown file — `MEMORY.md` / `USER.md` — under `~/.pi/agent/memories/` for global scope and `<project>/.pi/memories/` for project scope. Every store has a hard character budget and never auto-compacts: a write that would overflow is rejected, so the agent makes room itself. The rendered block is injected into the system prompt at session start.

When a turn finishes having done real work, the extension also gives the **same** agent one extra request to review the conversation and save anything durable through the `memory` tool — memory accumulates without you asking. A pure Q&A turn is skipped, and each turn reflects at most once, so it can't loop. Toggle it with `/memory-auto on|off`.

Global stores live at `~/.pi/agent/memories/` and project stores at `<project>/.pi/memories/`. These are personal and local: kiln neither tracks nor installs them, so keep them in your own backup.

---

## Configuration

`agent/settings.json` is the source of truth — a curated baseline with machine- and user-specific fields (default model/provider, hidden/enabled models, device id, disabled skills) stripped out. The installer seeds it on first install only; after that it is never touched, so your edits always stick. The flavor in one glance:

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

`agent/compact-tools.json` seeds the `pi-compact-tools` style to `codex` on first install only. After that it is never touched, so whatever you set with `/compact-tools` stays.

### Keybindings

| Keys | Action |
|------|--------|
| `enter` | submit |
| `shift+enter` | new line |
| `alt+f` | follow-up message |
| `alt+s` | save models |

See `agent/keybindings.json` for the full map.

### AGENTS.md

The house rules, merged into every session: *think before coding*, *simplicity first*, *surgical changes*, *goal-driven execution*. Copied to `~/.pi/agent/AGENTS.md` on install — read it before sending the agent off to build things.

---

## Repository layout

```
.
├── README.md               # ← you are here (GitHub-visible)
├── bin/kiln.js             # the installer (`npx @asterxsk/kiln`)
├── package.json
├── LICENSE
└── agent/                  # → ~/.pi/agent
    ├── AGENTS.md           # behavioral guidelines (merged into every session)
    ├── settings.json       # canonical defaults (seeded once, then yours)
    ├── compact-tools.json  # tool-row style (defaults to codex)
    ├── keybindings.json    # TUI keybindings
    ├── version.txt         # install version (drives kiln-update)
    └── extensions/         # self-contained pi extensions
```

Only `agent/extensions`, the `agent/*.md` / `agent/*.json` config, `agent/version.txt`, `bin/kiln.js`, and the root docs are tracked. Everything else — secrets, sessions, memories, caches, install scratch — stays local.

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

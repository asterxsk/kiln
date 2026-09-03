# kiln — pi agent configuration

> A forge-tuned, self-improving `~/.pi/agent` for [pi](https://github.com/badlogic/pi-mono): curated extensions, opinionated defaults, and an installer you can re-run without fear.

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
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.sh | sh
```

```powershell
# Windows PowerShell (5.1 or 7+)
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.ps1 -UseBasicParsing | iex"
```

What the installer does:

1. Installs or updates `pi` itself (`@earendil-works/pi-coding-agent`)
2. Installs the `pi-context-usage` and `@baretread/pi-forge` packages
3. Clones `asterxsk/kiln` over plain HTTPS (no credential prompts, ever) and copies the managed files into `~/.pi/agent` — extensions and config get overwritten, your `settings.json`, `taste/`, sessions, and secrets are left alone
4. Runs each extension's `install.sh` / `install.ps1` (`npm ci`)

**Safe to re-run.** It back ups the extensions and config files it replaces, never touches per-user state, and accepts `--help` options (`--repo`, `--branch`, `--target`, `--local`, `--skip-pi`, `--skip-packages`, `--yes`) when you want control.

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
- **Forge-first UX** — `theme: forge`, fullscreen TUI, high thinking by default. Built for long sessions.
- **Secret-free by construction** — `auth.json`, `sessions/`, `trust.json`, `models-store.json`, `bin/`, and `themes/.pi` are `.gitignore`'d. The repo holds config, never credentials.
- **Cross-platform** — `install.sh` for macOS/Linux/Git Bash, `install.ps1` for PowerShell.

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
    ├── settings.json            # canonical settings (the installer never overwrites yours)
    ├── keybindings.json         # TUI keybindings
    ├── install.sh               # macOS/Linux installer
    ├── install.ps1              # Windows installer
    └── extensions/              # self-contained pi extensions
```

Tracked paths only: `agent/extensions`, `agent/settings.json`, `agent/keybindings.json`, `agent/AGENTS.md`, `agent/install.*`, `README.md`. Everything else is local-only.

---

## Configuration

`agent/settings.json` is the source of truth. The flavor in one glance:

```json
{
  "theme": "forge",
  "tuiMode": "fullscreen",
  "defaultThinkingLevel": "high",
  "packages": ["npm:pi-context-usage", "npm:@baretread/pi-forge"]
}
```

Your live copy at `~/.pi/agent/settings.json` is yours — the installer patches the `packages` list in (so forge and context stay registered) and otherwise leaves it alone. See the full file for retry budgets, compaction, follow-up mode, and the rest.

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
./agent/install.sh --target /tmp/pi-test --skip-pi --skip-packages --yes
ls /tmp/pi-test/extensions
```

The `--target` flag installs into a scratch directory, so you can test installer changes without touching your live config.

---

## License

MIT

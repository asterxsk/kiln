# pi — agent configuration

Personal [pi](https://github.com/badlogic/pi-mono) agent setup. Minimal, portable, no secrets.

## What's included

Only these paths are tracked:

```
agent/
├── AGENTS.md                # behavioral guidelines for the agent
├── example-settings.json    # canonical settings (copy to settings.json)
├── keybindings.json         # TUI keybindings
└── extensions/              # self-contained pi extensions
    ├── ask-user
    ├── background-terminals
    ├── file-search
    ├── goal
    ├── modelconf            # per-provider model visibility, fuzzy search, bulk glob
    ├── pi-web-access
    ├── shared
    ├── status line
    ├── subagents
    ├── taste
    ├── todo
    └── trim-context
```

Everything else (`auth.json`, `trust.json`, `sessions/`, `pi-acp/`, `models-store.json`, `bin/`, `skills` symlinks, `themes/.pi`, `nul`) is local-only and `.gitignore`d — no path literals or secrets in this repo.

## Install

One-line installer (cross-platform TUI — installs/updates pi, the pi packages,
your config, and each extension's npm deps):

```powershell
# Windows (PowerShell)
powershell -c "irm https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.ps1 | iex"
```

```bash
# macOS / Linux (or Git Bash)
curl -fsSL https://raw.githubusercontent.com/asterxsk/kiln/main/agent/install.sh | sh
```

Manual install (clone as your pi config):

```bash
git clone https://github.com/asterxsk/kiln.git ~/.pi/agent

# or copy into an existing config
cp -r agent/extensions ~/.pi/agent/
cp agent/example-settings.json ~/.pi/agent/settings.json
cp agent/keybindings.json ~/.pi/agent/keybindings.json
cp agent/AGENTS.md ~/.pi/agent/AGENTS.md
```

Then create your local `settings.json` from the example:

```bash
cp ~/.pi/agent/example-settings.json ~/.pi/agent/settings.json
# edit settings.json — add enabledModels, auth, etc. (never commit auth.json)
```

## Settings

`example-settings.json` is the source of truth. Key options:

- `theme: forge` · `tuiMode: fullscreen`
- `packages: [pi-context-usage, @baretread/pi-forge]`
- `extensions: ["extensions/"]` · `themes: ["themes"]`
- `defaultThinkingLevel: high` · `doubleEscapeAction: tree`

Copy to `settings.json` and customize locally. `settings.json` is gitignored.

## Keybindings

| Binding | Action |
|---------|--------|
| `enter` | submit |
| `shift+enter` | new line |
| `ctrl+enter` | follow-up message |
| `alt+s` | save models |

See `keybindings.json`.

## Extensions

| Extension | Description |
|-----------|-------------|
| `modelconf` | Browse models per provider, fuzzy-filter, toggle hidden/visible, persist via `enabledModels` |
| `todo` | Agent todo list |
| `ask-user` | Structured user prompts |
| `background-terminals` | Long-lived terminal management |
| `subagents` | Subagent orchestration |
| `file-search` | File search tools |
| `pi-web-access` | Web search/fetch |
| `goal` | Goal-driven execution loop |

Each extension is `extensions/{name}/index.ts` with `package.json`.

## AGENTS.md

Behavioral guidelines: think before coding, simplicity first, surgical changes, goal-driven execution. Merged into every project session.

## Requirements

- pi `>= 0.84.4`

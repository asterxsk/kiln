# skillsconf

Per-skill visibility manager for pi, with **packages** (named groups) for mass enable/disable.

Disabled skills are stripped from the system prompt every turn (via `before_agent_start`),
so they cost zero context. Nothing is moved on disk — packages are just named lists
stored in settings.

```
/skillsconf
```

## Keybindings

- `↑` / `↓` or `j` / `k` — navigate; `Home`/`End` (`g`/`G`) jump
- `Space` — toggle the selected skill **or** the selected package (whole group on/off)
- `/` — fuzzy filter by name/description; `↑`/`↓` exit typing (filter kept) and
  move; `←`/`→` edit the query; `Esc` clears, `Enter` keeps filter
- `e` — toggle grouped view (packages + ungrouped skills) vs flat list of all skills
- `n` — new package (type a name, `Enter` creates, `Esc` cancels)
- `a` — on a package: enter assign mode (cursor jumps to skills, `Space` toggles
  membership, `Enter` done, `Esc` cancel without changing the package)
- `d` — delete what's under the cursor (package group, or skill files from disk)
  with a `y`/`n` confirm (`Esc` cancels)
- `s` — save to settings, stay open (`● unsaved — press s to save` clears; takes
  effect next turn)
- `Esc` / `q` — quit (`s` first if you want to keep changes); quitting with pending
  changes shows `changes discarded (not saved)`
Package rows show `(enabled/total)`: `◉` all on, `◍` partial, `○` all off / empty.
Each package row leads with an accent `▸` marker and bold name so it stands out
from skills.

Skills that belong to a package are hidden from the main list and managed via
their package row (grouped view). `e` switches to a flat list showing every
skill; `/` search and assign mode always see every skill, with a `⟨package⟩`
tag showing membership.

## Persistence

Writes `disabledSkills` and `skillPackages` in `~/.pi/agent/settings.json`:

- Nothing disabled + no packages → both keys removed to keep settings clean
- `skillPackages` maps package name → sorted member skill names (empty packages kept)
- Stale names (skills no longer on disk) are filtered on the next save

No reload happens on save — the prompt filter re-reads settings from disk every
turn, so changes apply from the next agent turn on. Physically deleted skills
vanish from the loaded list after `/reload`.

## Keyboard shortcut

`Ctrl+Alt+S` opens skillsconf when supported by the host.

## How filtering works

pi renders loaded skills as `<skill><name>…` blocks inside `<available_skills>`.
The extension removes the blocks whose `<name>` is in `disabledSkills` (verbatim block
surgery — kept blocks are byte-identical). When all skills are disabled, the whole
section including its intro is removed.

## Development

```bash
npx tsc --noEmit --project ./tsconfig.json
```

Tests are plain `node:assert` files (same style as `modelconf`):

```bash
npx tsc --project ./tsconfig.json --outDir /tmp/skillsconf-test
node --test /tmp/skillsconf-test/src/filter.test.js \
  /tmp/skillsconf-test/src/persistence.test.js \
  /tmp/skillsconf-test/src/ui/SkillConfView.test.js
```

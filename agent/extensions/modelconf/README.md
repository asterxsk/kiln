# modelconf

Per-provider model visibility manager for pi.

`/modelconf` opens a tab view — one tab per configured provider (providers that appear in `enabledModels` or have configured auth; falls back to all providers if none detected). Each tab shows `visible/total` counts. Switching tabs preserves per-provider cursor and filter state.

## Usage

```
/modelconf
```

Tab bar at top highlights the active provider `[provider vis/total]`. Models in the active tab are filtered and toggled independently — bulk operations are scoped to the active provider.

## Keybindings

- `Tab` / `Shift-Tab` — switch provider tab (also `←` / `→` as alternative when not in search)
- `/` — fuzzy search within active tab (filters `provider/modelId name`); `↑` / `↓` / `Home` / `End` navigate while typing, `Esc` clears filter, `Enter` keeps filter
- `Space` — toggle visibility of selected model (`◉` visible / `○` hidden), marks `● unsaved`
- `a` — add (show) whatever models are currently visible after search (whole tab when unfiltered)
- `x` — hide whatever models are currently visible after search (whole tab when unfiltered)
- `↑` / `↓` or `j` / `k` — navigate list; `Home` / `End` jump
- `Enter` — save draft to `enabledModels` (writes `undefined` / removes key when all visible, sorted array otherwise); notifies and triggers `ctx.reload()` when available
- `Esc` / `q` — close; if dirty, prompts `Discard changes? (y/N)`; `y` or `Esc` discards, `n` keeps editing. While filtered, first `Esc` clears filter.

### Empty states

- Fuzzy yields 0 in active tab → `No models match 'q' in <provider>` + `Press Esc to clear filter`

### Scrolling & layout

Visible rows are clamped to terminal height minus tab bar and chrome (`getAvailableHeight()` subtracts tab bar + dividers + optional search line, capped at 40 rows). Large catalogs paginate with a centered window around the cursor and a `(pos/total) in <provider>` indicator.

## Persistence

Writes `enabledModels` in `~/.pi/agent/settings.json`:

- All visible → `enabledModels` removed (`undefined`) to keep settings clean
- Some hidden → sorted array of `provider/modelId` ids (stale ids filtered on save)
- File missing → treated as all visible
- Parse error → treated as all visible; save recreates file safely

After save, a reload is triggered if `ctx.reload` is available; otherwise run `/reload` manually. The model picker (`/model`) reflects the new visibility.

## Keyboard shortcut

`Ctrl+Alt+M` opens modelconf when supported by the host (registered via `pi.registerShortcut("ctrl+alt+m")` with a try/catch guard for API differences).

## Persistence edge cases

- Stale ids in `enabledModels` are ignored for visibility but filtered on next save.
- Save with all visible deletes the key rather than writing a full list.
- Large providers (e.g. `opencode` with thousands of models) remain responsive — fuzzy filtering is scoped to the active tab and rendering is windowed.

## Example flow

1. `/modelconf` → opens tab view on first configured provider
2. `Tab` to `anthropic` tab → `/` type `mini` → fuzzy filters within that tab
3. `Space` toggles a model, `x` type `*free*` `Enter` excludes matches in that provider
4. `Enter` saves → `modelconf: saved N enabled models — reload to apply`

## Development

```bash
npx tsc --noEmit --project ./tsconfig.json
```

# kiln-update

Nudges you when your installed kiln is behind GitHub.

- On every session start it compares `~/.pi/agent/version.txt` with
  `agent/version.txt` on the `main` branch.
- On mismatch: `Kiln update available (X → Y) — to update kiln to the
  newest version, run: npx @asterxsk/kiln`
- Silent when up to date, offline, or timed out (5s).

## Manual check

`/kiln-update` — re-check on demand.

## Releasing a new version

1. Make your changes.
2. Bump `agent/version.txt` (e.g. `0.2.0` → `0.3.0`).
3. Push to GitHub. No `npm publish` needed — `kiln` installs from git,
   and every user gets the nudge on their next session.

## Opt out

`KILN_NO_UPDATE_CHECK=1`. Forks can point elsewhere with
`KILN_VERSION_URL=https://.../version.txt`.

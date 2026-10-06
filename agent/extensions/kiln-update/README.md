# kiln-update

A minimal kiln header for pi, and a nudge when your install is behind GitHub.

- Replaces the built-in startup header with:

  ```
  pi vX kiln vY
  skills N extensions N
  ```

- Press `ctrl+o` to expand the header and list every installed skill and
  extension.
- When `~/.pi/agent/version.txt` is behind `agent/version.txt` on `main`, the
  header also shows:

  ```
  Update Available. To update, run:
  run npx @asterxsk/kiln@latest
  ```

- Silent when up to date, offline, or timed out (5s).

## Manual check

`/kiln-update` — re-check on demand, refresh the header, and report the result.

## Releasing a new version

1. Make your changes.
2. Bump `agent/version.txt` (e.g. `0.2.0` → `0.3.0`).
3. Push to GitHub. No `npm publish` needed — `kiln` installs from git,
   and every user gets the nudge on their next session.

## Opt out

`KILN_NO_UPDATE_CHECK=1`. Forks can point elsewhere with
`KILN_VERSION_URL=https://.../version.txt`.

# kiln-update

A minimal kiln header for pi, and a nudge when your install is behind GitHub.

- Replaces the built-in startup header with:

  ```
   pi vX kiln vY
   skills N extensions N
   /btw · /destructive · /goal · /kiln-update · /ps · /search · /trim
   press ctrl-o to view more
  ```

  `pi` is cyan, `kiln` is a light red, and the versions and counts are gray.
  Every header line is indented one space.

- Below the counts, a wrapped line lists every functional extension slash
  command, separated by `·`. Settings menus (`modelconf`, `skillsconf`) and
  utility commands (`llama`, `todos`, `subagents`) are omitted, and the list
  wraps to the terminal width.

- The catalog is hidden by default. Press `ctrl+o` to expand it. A blank line
  sits above each group, and long lists wrap to the terminal width:

  ```
   pi vX kiln vY
   skills N extensions N
   /btw · /destructive · /goal · /kiln-update · /ps · /search · /trim

   [ctx]
   ~/.pi/agent/AGENTS.md, ~/AGENTS.md

   [skills]
   alpha, beta

   [extensions]
   extA, extB
  ```

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

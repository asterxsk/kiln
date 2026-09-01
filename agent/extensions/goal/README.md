# goal

Keep the agent working until a goal is achieved.

## Command

| Command | Action |
|---|---|
| `/goal <prompt>` | Runs the workflow below, looping until you confirm the goal is achieved |
| `/goal` | Prompts for the goal interactively, then runs the same workflow |

`/goal` with no argument opens an input dialog; if the dialog is cancelled or
left empty, nothing runs.

## Workflow

`/goal <prompt>` injects an instruction into the main agent that runs four
phases in order:

1. **Research** — web-search the goal to ground the design.
2. **Design** — follow the `brainstorming` skill; present the design for
   approval, then save the design doc to `docs/superpowers/specs/`.
3. **Plan** — follow the `writing-plans` skill; save a bite-sized plan to
   `docs/superpowers/plans/`.
4. **Implement and verify** — write the code, tests, and docs; run them and
   fix failures until the goal actually works.

### The loop

After the agent settles, `/goal` asks you what to do next:

- **Continue working toward the goal** — re-engages the agent to keep going,
  respecting the phase gates (it won't skip design approval).
- **Goal achieved - stop** — ends the loop.
- **Pause - stop checking** — ends the loop and leaves you to take over
  manually.

The loop runs in the interactive TUI (it needs to ask you). In RPC and
print/JSON modes there is no dialog, so the agent works a single pass and the
loop ends. The workflow always stops after Phase 2 and waits for you to approve
the design doc before planning and implementing.

## Files

- `index.ts` — registers the `/goal` command, builds the phase instruction,
  and re-engages the agent on `agent_settled`
- `README.md` — this file

Nothing is written into the extension folder; the design and plan land in the
project's `docs/superpowers/` tree (the skills' default locations).

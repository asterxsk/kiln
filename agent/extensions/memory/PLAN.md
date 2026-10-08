# memory: end-of-response auto-reflection

## Goal

When a response finishes, the **same agent** (same session, same context — not a
subagent) reviews the conversation so far and saves durable facts through the
existing `memory` tool. "Only if it needs to" is the agent's own call.

## Classification

Bounded change to the existing `memory` extension. No new store, tool, or write
path — reflection reuses the `memory` tool that already exists.

## Mechanism

- Hook `agent_before_settle` — pi's documented final actionable boundary. It can
  append session entries and request exactly one more model request.
- On a qualifying settle, append one hidden `custom_message` draft
  (`customType: "memory-reflection"`, `display: false`) holding the reflection
  instruction, and return `continue: true`.
- Pi commits the draft, then runs one more request in the same conversation.
  `convertToLlm` maps a custom message to a `user` turn, so the agent sees:

  > Before you finish: review this conversation. If it holds durable facts worth
  > remembering across sessions — user preferences, machine/environment details,
  > or project conventions/gotchas — call the `memory` tool now with the right
  > scope and target. Save nothing about transient task state. If nothing
  > qualifies, reply with no text.

- The agent then either calls `memory` or stops. Writes land in the same bounded
  stores under the same scope/target rules.

## Guards (no loops, no waste)

- **Once per user turn.** A `reflectDone` flag resets in `before_agent_start`
  (fires once per user prompt, never for a continuation). The boundary fires only
  while the flag is false, then sets it. So a turn gets at most one extra request.
- **Clean settles only.** Skip unless `outcome === "completed"` (not aborted/errored).
- **No redundancy.** Skip if the run already called the `memory` tool.
- **Hidden nudge.** `display: false`, so the user does not see the injected prompt.

## Prompt stability

The system-prompt memory snapshot stays frozen at session start — unchanged. The
nudge is an ordinary conversation message, so the cached prompt prefix is
untouched.

## Control

- **On by default**, matching "once a response is finished."
- `/memory-auto on|off` toggles it for the session.

## Files

```
memory/
  src/reflect.ts        instruction text + shouldReflect() gate (pure, testable)
  src/reflect.test.ts   gate tests
  index.ts              wire before_agent_start + agent_before_settle +
                        tool_execution_end + /memory-auto
  README.md             document the feature
```

## Decision (chosen)

**Only after turns that did work** — reflect only when the run made at least one
non-memory tool call. Pure Q&A turns are skipped. Still on by default and
toggleable with `/memory-auto on|off`.

Tradeoff to keep in mind: a preference stated in a no-tool turn is not reflected
on. Widen the gate (e.g. drop the `worked` condition) if that becomes a problem.

Other options considered: every response (on by default), every response but
opt-in, and once at session end.

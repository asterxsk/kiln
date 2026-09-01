# trim-context — crush/amp/lsp style context manager for pi

Aggressive context savings so pi behaves like `opencode` / `crush` / `amp`.

## What it does

| Layer | Hook | Behavior |
|---|---|---|
| **Caching** | `process.env.PI_CACHE_RETENTION=long` + `before_provider_request` | Forces 1h Anthropic / 24h OpenAI cache. Adds `cache_control: {type:"ephemeral", ttl:"1h"}` to system + last user block if pi's built-in misses. |
| **Output compression** | `tool_result` | Truncates any tool result >30KB or >400 lines to 30KB/400 lines (head 75% + tail 25%). Full output saved to `tmpdir/pi-trim-*/full-output.txt` and path is inlined. |
| **Trim context** | `context` (before each LLM call) | Keeps last `KEEP_RECENT_TURNS=6` turns verbatim. Older turns: strip `thinking` blocks, compress `toolResult` to 800 chars / 30 lines, bash tail to 20 lines, dedupe superseded `read` results, and if still >80k tokens, hard-prune oldest toolResults. |

This matches crush's `trimContext` and amp's `context pruning` — pi's default keeps 20k recent tokens until 184k/200k, this keeps ~6 turns fully and aggressively compresses the rest.

## Config

Edit `index.ts` `CONFIG` block:

```ts
KEEP_RECENT_TURNS: 6
IMMEDIATE_MAX_BYTES: 30*1024
IMMEDIATE_MAX_LINES: 400
OLD_MAX_CHARS: 800
OLD_MAX_LINES: 30
SOFT_TOKEN_LIMIT: 80_000
DEDUPE_READS: true
STRIP_OLD_THINKING: true
```

`settings.json` also tuned:
```json
"compaction": { "keepRecentTokens": 12000, "reserveTokens": 24000 }
```
(compacts earlier than pi default 20k/16k)

## Commands

- `/trimContext` — stats + config
- `/trim-context` — alias

Footer shows `cache:long keep:6t` while active.

## Verify

```bash
pi --no-session -p "test"   # should not throw
# in interactive pi:
# /trimContext  -> shows ~0 compressed initially, grows as you work
```

## How it saves vs vanilla pi

Vanilla pi: 5x reads of 10KB files = 50KB paid every turn until compaction at 184k.
With trim-context: same 5 reads = only last read kept fully, older 4 compressed to 1 line each + immediate truncation to 30KB. Typical saving: 60-80% input tokens on long sessions.

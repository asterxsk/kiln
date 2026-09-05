// Dedicated tests for the error extension (retry classification, backoff,
// chat collapsing, retry cap). Run with: node retry.test.mjs
import { strict as assert } from "node:assert";
import mod, {
  backoffMs,
  ERROR_DISPLAY_MS,
  ERROR_MAX_RETRIES,
  isRetriableError,
} from "./index.ts";

assert.equal(ERROR_MAX_RETRIES, 10, "max retries is 10");
assert.equal(ERROR_DISPLAY_MS, 5000, "display window is 5s");

// --- classification ---
assert.equal(isRetriableError("429 rate limit, try again later"), true);
assert.equal(isRetriableError("503 Service Unavailable / overloaded"), true);
assert.equal(isRetriableError("request timed out after 30000ms"), true);
assert.equal(isRetriableError("fetch failed: ECONNRESET"), true);
assert.equal(isRetriableError(""), true, "unknown failure defaults to retriable");
assert.equal(isRetriableError("401 invalid api key"), false);
assert.equal(isRetriableError("context window overflow: too many tokens"), false);
assert.equal(isRetriableError("user aborted the request"), false);
assert.equal(isRetriableError("model 'nope' not found"), false);

// --- backoff ---
assert.equal(backoffMs(1), 1000);
assert.equal(backoffMs(2), 2000);
assert.equal(backoffMs(3), 4000);
assert.equal(backoffMs(10), 10000, "backoff is capped");

// --- handler harness ---
function makeHarness() {
  const handlers = new Map();
  const sent = [];
  const uiCalls = [];
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    sendMessage(msg, opts) {
      sent.push({ msg, opts });
    },
  };
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (...a) => uiCalls.push(["notify", ...a]),
      setWidget: (...a) => uiCalls.push(["setWidget", ...a]),
      setStatus: (...a) => uiCalls.push(["setStatus", ...a]),
    },
  };
  mod(pi);
  const emit = async (event, e) => {
    let out;
    for (const h of handlers.get(event) ?? []) out = (await h(e, ctx)) ?? out;
    return out;
  };
  return { emit, sent, uiCalls };
}

const errMsg = (text) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage: text,
  content: [{ type: "text", text }],
});

// Collapsing preserves role/stopReason/errorMessage so Pi's own retry still works.
{
  const { emit } = makeHarness();
  const out = await emit("message_end", { message: errMsg("503 overloaded") });
  assert.ok(out?.message, "message_end returns a replacement");
  assert.equal(out.message.role, "assistant");
  assert.equal(out.message.stopReason, "error");
  assert.equal(out.message.errorMessage, "503 overloaded");
  assert.match(out.message.content[0].text, /dismissed/i);
}

// Retriable error -> agent_settled triggers one invisible retry turn.
{
  const { emit, sent } = makeHarness();
  await emit("message_end", { message: errMsg("503 overloaded") });
  await emit("agent_settled", {});
  assert.equal(sent.length, 1, "one retry nudge is sent");
  assert.equal(sent[0].opts.triggerTurn, true);
  assert.equal(sent[0].msg.display, false);
}

// Non-retriable error -> no retry.
{
  const { emit, sent } = makeHarness();
  await emit("message_end", { message: errMsg("401 invalid api key") });
  await emit("agent_settled", {});
  assert.equal(sent.length, 0, "auth errors are not retried");
}

// Budget exhausted after 10 consecutive errors -> no further retry.
{
  const { emit, sent } = makeHarness();
  for (let i = 0; i < 10; i++) {
    await emit("message_end", { message: errMsg("503 overloaded") });
  }
  await emit("agent_settled", {});
  assert.equal(sent.length, 0, "no retry after 10 attempts");
}

// Success resets the streak.
{
  const { emit, sent } = makeHarness();
  await emit("message_end", { message: errMsg("503 overloaded") });
  await emit("message_end", {
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
  });
  await emit("message_end", { message: errMsg("503 overloaded") });
  await emit("agent_settled", {});
  assert.equal(sent.length, 1, "streak resets after success");
}

console.log("error extension: all tests passed");

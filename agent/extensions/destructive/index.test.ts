import assert from "node:assert/strict";
import test from "node:test";
import destructive, { findDestructiveSegments, isDestructiveCommand } from "./index.ts";

function load() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let toolCall: ((event: any, ctx: any) => Promise<any>) | undefined;
  const pi = {
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (event: string, handler: any) => {
      if (event === "tool_call") toolCall = handler;
    },
  };
  destructive(pi as any);
  return { commands, toolCall: () => toolCall! };
}

test("isDestructiveCommand flags deletion commands", () => {
  assert.equal(isDestructiveCommand("rm -rf build"), true);
  assert.equal(isDestructiveCommand("sudo rm foo"), true);
  assert.equal(isDestructiveCommand("git branch -D topic"), true);
  assert.equal(isDestructiveCommand("git rm foo"), true);
  assert.equal(isDestructiveCommand("git stash drop"), true);
  assert.equal(isDestructiveCommand("git clean -fd"), true);
  assert.equal(isDestructiveCommand("ls -la && rm foo"), true);
  assert.equal(isDestructiveCommand("ls -la"), false);
  assert.equal(isDestructiveCommand("git status"), false);
});

test("isDestructiveCommand flags change-abandoning git commands", () => {
  assert.equal(isDestructiveCommand("git reset --hard"), true);
  assert.equal(isDestructiveCommand("git reset --hard HEAD~1"), true);
  assert.equal(isDestructiveCommand("git reset"), false);
  assert.equal(isDestructiveCommand("git reset --soft HEAD~1"), false);
  assert.equal(isDestructiveCommand("git restore ."), true);
  assert.equal(isDestructiveCommand("git restore --staged ."), false);
  assert.equal(isDestructiveCommand("git restore --staged --worktree ."), true);
  assert.equal(isDestructiveCommand("git checkout -- ."), true);
  assert.equal(isDestructiveCommand("git checkout HEAD -- file.txt"), true);
  assert.equal(isDestructiveCommand("git checkout ."), true);
  assert.equal(isDestructiveCommand("git checkout -f main"), true);
  assert.equal(isDestructiveCommand("git checkout main"), false);
  assert.equal(isDestructiveCommand("git checkout -b feature"), false);
});

test("findDestructiveSegments returns only the destructive pieces", () => {
  assert.deepEqual(findDestructiveSegments("rm -rf build"), ["rm -rf build"]);
  assert.deepEqual(findDestructiveSegments("ls -la && rm foo"), ["rm foo"]);
  assert.deepEqual(findDestructiveSegments("git status && git stash drop && npm test"), ["git stash drop"]);
  assert.deepEqual(findDestructiveSegments(["cd /repo", "npm ci", "rm -rf build", "git status"].join("\n")), [
    "rm -rf build",
  ]);
  assert.deepEqual(findDestructiveSegments("ls -la"), []);
});

test("prompt and reason show only the destructive segment(s)", async () => {
  const app = load();
  const prompts: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { select: async (message: string) => (prompts.push(message), "2. Deny") },
  };
  const command = ["cd /repo", "echo hi", "rm -rf build"].join("\n");

  const result = await app.toolCall()({ toolName: "bash", input: { command } }, ctx);

  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("rm -rf build"), "prompt shows the destructive line");
  assert.ok(!prompts[0].includes("cd /repo"), "prompt hides non-destructive lines");
  assert.ok(!prompts[0].includes("echo hi"), "prompt hides non-destructive lines");
  assert.equal(result.block, true);
  assert.match(result.reason, /rm -rf build/);
  assert.ok(!result.reason.includes("cd /repo"), "reason hides non-destructive lines");
});

test("guard is on by default and prompts for deletions", async () => {
  const app = load();
  let asked = false;
  const ctx = { hasUI: true, ui: { select: async () => (asked = true, "1. Allow") } };

  const result = await app.toolCall()({ toolName: "bash", input: { command: "rm foo" } }, ctx);
  assert.equal(result, undefined);
  assert.equal(asked, true, "guard on should prompt");
});

test("deny returns a block result", async () => {
  const app = load();
  const ctx = { hasUI: true, ui: { select: async () => "2. Deny" } };
  const result = await app.toolCall()({ toolName: "bash", input: { command: "rm foo" } }, ctx);
  assert.equal(result.block, true);
});

test("no UI blocks deletions by default", async () => {
  const app = load();
  const result = await app.toolCall()({ toolName: "bash", input: { command: "rm foo" } }, { hasUI: false, ui: {} });
  assert.equal(result.block, true);
});

test("/destructive toggles the guard on and off", async () => {
  const app = load();
  const handler = app.commands.get("destructive")!.handler;
  assert.ok(handler);
  const messages: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => messages.push(message),
      select: async () => "1. Allow",
    },
  };

  let asked = false;
  const probe = { hasUI: true, ui: { select: async () => (asked = true, "1. Allow") } };

  await handler("", ctx);
  assert.match(messages.at(-1)!, /disabled/);
  asked = false;
  assert.equal(await app.toolCall()({ toolName: "bash", input: { command: "rm foo" } }, probe), undefined);
  assert.equal(asked, false, "guard off should not prompt");

  await handler("", ctx);
  assert.match(messages.at(-1)!, /enabled/);
  asked = false;
  await app.toolCall()({ toolName: "bash", input: { command: "rm foo" } }, probe);
  assert.equal(asked, true, "guard on should prompt again");
});

test("non-destructive commands are never intercepted", async () => {
  const app = load();
  let asked = false;
  const ctx = { hasUI: true, ui: { select: async () => (asked = true, "1. Allow") } };
  const result = await app.toolCall()({ toolName: "bash", input: { command: "ls -la" } }, ctx);
  assert.equal(result, undefined);
  assert.equal(asked, false);
});

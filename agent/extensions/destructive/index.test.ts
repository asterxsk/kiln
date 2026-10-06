import assert from "node:assert/strict";
import test from "node:test";
import destructive, { isDestructiveCommand } from "./index.ts";

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

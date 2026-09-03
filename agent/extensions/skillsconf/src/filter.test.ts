import assert from "node:assert";
import { filterSkillsPrompt } from "./filter.js";

function samplePrompt(): string {
  return [
    "You are a coding agent.",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>alpha</name>",
    "    <description>First skill</description>",
    "    <location>/skills/alpha/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>beta</name>",
    "    <description>Second skill</description>",
    "    <location>/skills/beta/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>gamma</name>",
    "    <description>Third skill</description>",
    "    <location>/skills/gamma/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
    "",
    "Trailing instructions.",
  ].join("\n");
}

const base = samplePrompt();

// no disabled -> identical
assert.equal(filterSkillsPrompt(base, []), base);
assert.equal(filterSkillsPrompt(base, undefined), base);

// unknown name -> identical
assert.equal(filterSkillsPrompt(base, ["nope"]), base);

// disable one -> only its block removed, rest verbatim
const one = filterSkillsPrompt(base, ["beta"]);
assert.ok(!one.includes("<name>beta</name>"), "beta block removed");
assert.ok(one.includes("<name>alpha</name>"), "alpha kept");
assert.ok(one.includes("<name>gamma</name>"), "gamma kept");
assert.ok(one.includes("<available_skills>"), "wrapper kept");
assert.ok(one.includes("Trailing instructions."), "tail kept");
assert.ok(one.includes("You are a coding agent."), "head kept");

// disable two
const two = filterSkillsPrompt(base, ["alpha", "gamma"]);
assert.ok(!two.includes("<name>alpha</name>"));
assert.ok(!two.includes("<name>gamma</name>"));
assert.ok(two.includes("<name>beta</name>"));
assert.ok(two.includes("<available_skills>"));

// disable all -> whole section gone, no stray blank lines
const all = filterSkillsPrompt(base, ["alpha", "beta", "gamma"]);
assert.ok(!all.includes("<available_skills>"), "wrapper removed");
assert.ok(!all.includes("provide specialized instructions"), "intro removed");
assert.ok(!all.includes("<name>alpha</name>"));
assert.equal(all, "You are a coding agent.\n\nTrailing instructions.");

// prompt without a skills section -> identical
assert.equal(filterSkillsPrompt("plain prompt", ["alpha"]), "plain prompt");

// XML-escaped names match
const escaped = base.replace("<name>beta</name>", "<name>a&lt;b&gt;c</name>");
const escFiltered = filterSkillsPrompt(escaped, ["a<b>c"]);
assert.ok(!escFiltered.includes("a&lt;b&gt;c"), "escaped block removed");
assert.ok(escFiltered.includes("<name>alpha</name>"));

// Set input works
const viaSet = filterSkillsPrompt(base, new Set(["gamma"]));
assert.ok(!viaSet.includes("<name>gamma</name>"));
assert.ok(viaSet.includes("<name>alpha</name>"));

console.log("filter.test.ts: all assertions passed");

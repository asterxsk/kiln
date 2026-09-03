import assert from "node:assert";
import {
  cloneState,
  isDisabled,
  normalizeMembers,
  statesEqual,
  toggleMembership,
  togglePackage,
  toggleSkill,
} from "./persistence.js";
import type { SkillState } from "./persistence.js";

// isDisabled
assert.equal(isDisabled("a", undefined), false);
assert.equal(isDisabled("a", []), false);
assert.equal(isDisabled("a", ["a"]), true);
assert.equal(isDisabled("b", ["a"]), false);

// toggleSkill
assert.deepEqual(toggleSkill("a", undefined), ["a"]);
assert.deepEqual(toggleSkill("a", ["a"]), undefined);
assert.deepEqual(toggleSkill("b", ["a"]), ["a", "b"]);
assert.deepEqual(toggleSkill("a", ["a", "b"]), ["b"]);

// togglePackage: partial -> disable all; full -> enable all
assert.deepEqual(togglePackage(["a", "b"], undefined), ["a", "b"]);
assert.deepEqual(togglePackage(["a", "b"], ["a"]), ["a", "b"]);
assert.deepEqual(togglePackage(["a", "b"], ["a", "b"]), undefined);
// preserves unrelated disabled entries
assert.deepEqual(togglePackage(["a"], ["a", "z"]), ["z"]);
// empty package -> no change
assert.deepEqual(togglePackage([], ["a"]), ["a"]);
assert.equal(togglePackage([], undefined), undefined);

// toggleMembership
assert.deepEqual(toggleMembership(["a"], "b"), ["a", "b"]);
assert.deepEqual(toggleMembership(["a", "b"], "a"), ["b"]);
assert.deepEqual(toggleMembership([], "a"), ["a"]);

// normalizeMembers dedupes + sorts
assert.deepEqual(normalizeMembers(["b", "a", "b"]), ["a", "b"]);

// statesEqual
const s = (disabled: string[] | undefined, packages: SkillState["packages"]): SkillState => ({
  disabled,
  packages,
});
assert.equal(statesEqual(s(undefined, {}), s(undefined, {})), true);
assert.equal(statesEqual(s(["a"], {}), s(undefined, {})), false);
assert.equal(statesEqual(s(["b", "a"], {}), s(["a", "b"], {})), true);
assert.equal(
  statesEqual(s(undefined, { p: ["a"] }), s(undefined, { p: ["a", "a"] })),
  true,
);
assert.equal(
  statesEqual(s(undefined, { p: ["a"] }), s(undefined, { p: ["b"] })),
  false,
);
assert.equal(
  statesEqual(s(undefined, { p: ["a"] }), s(undefined, { q: ["a"] })),
  false,
);

// cloneState is a deep copy
const orig = s(["a"], { p: ["x"] });
const copy = cloneState(orig);
assert.equal(statesEqual(orig, copy), true);
copy.packages["p"].push("y");
(copy.disabled as string[]).push("z");
assert.equal(statesEqual(orig, copy), false);

console.log("persistence.test.ts: all assertions passed");

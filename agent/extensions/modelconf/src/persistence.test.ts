import { isVisible, toModelId, getVisibilityMap, toggleInEnabled, applyBulk } from "./persistence.js";
import type { ModelId } from "./persistence.js";
import assert from "node:assert";

const all = ["opencode/a","opencode/b","9router/c"] as unknown as ModelId[];

// isVisible (denylist: the list holds HIDDEN models)
assert.equal(isVisible("opencode/a" as ModelId, undefined, [...all]), true);
assert.equal(isVisible("opencode/a" as ModelId, [], [...all]), true);
assert.equal(isVisible("opencode/a" as ModelId, ["opencode/a"], [...all]), false);
assert.equal(isVisible("opencode/b" as ModelId, ["opencode/a"], [...all]), true);

// toModelId
assert.equal(toModelId({ provider: "opencode", id: "a" }), "opencode/a");

// getVisibilityMap
const vis = getVisibilityMap([{provider:"opencode",id:"a"},{provider:"opencode",id:"b"}], ["opencode/a"]);
assert.equal(vis.get("opencode/a" as ModelId), false);
assert.equal(vis.get("opencode/b" as ModelId), true);
const visAll = getVisibilityMap([{provider:"opencode",id:"a"},{provider:"opencode",id:"b"}], undefined);
assert.equal(visAll.get("opencode/a" as ModelId), true);
assert.equal(visAll.get("opencode/b" as ModelId), true);

// toggleInEnabled (denylist: toggling a visible model HIDES it and vice versa)
// undefined => hide just this one
assert.deepEqual(toggleInEnabled("opencode/a" as ModelId, undefined, [...all]), ["opencode/a"]);
// toggle visible => append exact id
assert.deepEqual(toggleInEnabled("9router/c" as ModelId, ["opencode/a"], [...all]), ["opencode/a","9router/c"]);
// toggle hidden => remove exact id
assert.deepEqual(toggleInEnabled("opencode/a" as ModelId, ["opencode/a","opencode/b"], [...all]), ["opencode/b"]);
// removing the last hidden id collapses to undefined (all visible)
assert.equal(toggleInEnabled("opencode/a" as ModelId, ["opencode/a"], [...all]), undefined);
// hidden via glob: showing removes the matching pattern so the model becomes visible
assert.equal(toggleInEnabled("opencode/a" as ModelId, ["*a"], [...all]), undefined);

// applyBulk exclude = hide (union into denylist, sorted)
assert.deepEqual(applyBulk(undefined, [...all], ["opencode/a" as ModelId], "exclude"), ["opencode/a"]);
assert.deepEqual(applyBulk(["opencode/a","opencode/b","9router/c"] as unknown as ModelId[], [...all], ["opencode/a" as ModelId], "exclude"), ["9router/c","opencode/a","opencode/b"]);

// applyBulk include = show (remove exact ids from denylist)
assert.deepEqual(applyBulk(["opencode/a","opencode/b"] as unknown as ModelId[], [...all], ["opencode/b" as ModelId], "include"), ["opencode/a"]);
assert.equal(applyBulk(undefined, [...all], [...all], "include"), undefined); // all visible => undefined
assert.deepEqual(applyBulk(["opencode/a","opencode/b","9router/c"] as unknown as ModelId[], [...all], [] as ModelId[], "include"), ["opencode/a","opencode/b","9router/c"]); // empty selection changes nothing
assert.deepEqual(applyBulk(["*luna*","opencode/a"] as unknown as ModelId[], [...all], ["opencode/a" as ModelId], "include"), ["*luna*"]); // exact-only removal keeps unrelated globs

console.log("persistence test pass");

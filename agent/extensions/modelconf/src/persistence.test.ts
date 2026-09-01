import { isVisible, toModelId, getVisibilityMap, toggleInEnabled, applyBulk } from "./persistence.js";
import type { ModelId } from "./persistence.js";
import assert from "node:assert";

const all = ["opencode/a","opencode/b","9router/c"] as unknown as ModelId[];

// isVisible
assert.equal(isVisible("opencode/a" as ModelId, undefined, [...all]), true);
assert.equal(isVisible("opencode/a" as ModelId, [], [...all]), false);
assert.equal(isVisible("opencode/a" as ModelId, ["opencode/a"], [...all]), true);
assert.equal(isVisible("opencode/b" as ModelId, ["opencode/a"], [...all]), false);

// toModelId
assert.equal(toModelId({ provider: "opencode", id: "a" }), "opencode/a");

// getVisibilityMap
const vis = getVisibilityMap([{provider:"opencode",id:"a"},{provider:"opencode",id:"b"}], ["opencode/a"]);
assert.equal(vis.get("opencode/a" as ModelId), true);
assert.equal(vis.get("opencode/b" as ModelId), false);
const visAll = getVisibilityMap([{provider:"opencode",id:"a"},{provider:"opencode",id:"b"}], undefined);
assert.equal(visAll.get("opencode/a" as ModelId), true);
assert.equal(visAll.get("opencode/b" as ModelId), true);

// toggleInEnabled
// undefined => materialize all except one
assert.deepEqual(toggleInEnabled("opencode/a" as ModelId, undefined, [...all]), ["opencode/b","9router/c"]);
// toggle off existing
assert.deepEqual(toggleInEnabled("opencode/a" as ModelId, ["opencode/a","opencode/b"], [...all]), ["opencode/b"]);
// toggle on new
assert.deepEqual(toggleInEnabled("9router/c" as ModelId, ["opencode/a"], [...all]), ["opencode/a","9router/c"]);

// applyBulk include
assert.deepEqual(applyBulk(undefined, [...all], ["opencode/a" as ModelId], "exclude"), ["opencode/b","9router/c"]);
assert.deepEqual(applyBulk(["opencode/a"], [...all], ["opencode/b" as ModelId], "include"), ["opencode/a","opencode/b"]);
assert.equal(applyBulk(undefined, [...all], [...all], "include"), undefined); // all visible => undefined
assert.equal(applyBulk(["opencode/a","opencode/b","9router/c"] as unknown as ModelId[] & string[], [...all], [] as ModelId[], "include"), undefined);

// applyBulk exclude
assert.deepEqual(applyBulk(["opencode/a","opencode/b","9router/c"], [...all], ["opencode/a" as ModelId], "exclude"), ["opencode/b","9router/c"]);

console.log("persistence test pass");

import assert from "node:assert";
import { ModelConfView } from "./ModelConfView.js";

function makeView(): any {
  const allModels = [
    { provider: "p", id: "a1", name: "a1" },
    { provider: "p", id: "a2", name: "a2" },
    { provider: "p", id: "b1", name: "b1" },
  ];
  const ids = allModels.map((m) => `${m.provider}/${m.id}`);
  const view = new ModelConfView({
    tui: { requestRender() {} },
    theme: {},
    keybindings: {},
    allModels,
    visibleSet: new Set(ids),
    enabledRaw: undefined,
    onDone: () => {},
    onPersist: async () => {},
    allIds: ids,
  });
  return view;
}

// 1. Arrow keys navigate the list while the search filter is being typed
//    (previously swallowed by the text input, so the cursor never moved).
{
  const v = makeView();
  v.handleInput("/");
  v.handleInput("a"); // matches a1, a2
  assert.equal(v.rowsToShow.length, 2);
  assert.equal(v.cursorIndex, 0);
  v.handleInput("\x1b[B"); // down
  assert.equal(v.cursorIndex, 1);
  v.handleInput("\x1b[A"); // up
  assert.equal(v.cursorIndex, 0);
  // navigation must not disturb the query text
  assert.equal(v.searchQuery, "a");
}

// 2. `x` immediately hides the currently visible (filtered) rows — no popup.
{
  const v = makeView();
  v.handleInput("/");
  v.handleInput("a1");
  assert.equal(v.rowsToShow.length, 1);
  v.handleInput("\r"); // keep filter, stop editing
  assert.equal(v.searchActive, false);
  v.handleInput("x");
  assert.deepEqual([...(v.draftEnabled ?? [])].sort(), ["p/a1"]);
}

// 3. `a` re-adds (shows) the currently visible rows.
{
  const v = makeView();
  v.handleInput("/");
  v.handleInput("a1");
  v.handleInput("\r");
  v.handleInput("x");
  assert.deepEqual([...(v.draftEnabled ?? [])].sort(), ["p/a1"]);
  v.handleInput("a");
  assert.equal(v.draftEnabled, undefined); // empty denylist collapses to undefined
}

// 4. With no filter, `x` hides the whole provider tab and `a` restores it.
{
  const v = makeView();
  assert.equal(v.rowsToShow.length, 3);
  v.handleInput("x");
  assert.deepEqual([...(v.draftEnabled ?? [])].sort(), ["p/a1", "p/a2", "p/b1"]);
  v.handleInput("a");
  assert.equal(v.draftEnabled, undefined);
}

console.log("ModelConfView keybind tests pass");

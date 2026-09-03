import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillConfView } from "./SkillConfView.js";
import type { SkillInfo } from "./SkillConfView.js";
import type { SkillPackages } from "../persistence.js";

const skills = [
  { name: "alpha", description: "First skill", filePath: "/s/alpha/SKILL.md" },
  { name: "beta", description: "Second skill", filePath: "/s/beta/SKILL.md" },
  { name: "gamma", description: "Third skill", filePath: "/s/gamma/SKILL.md" },
];

const tui = { requestRender() {}, terminal: { rows: 40 } };

function makeView(opts?: {
  disabledRaw?: string[];
  packagesRaw?: SkillPackages;
  skills?: SkillInfo[];
  onDone?: (saved: boolean, discarded?: boolean) => void;
  onPersist?: (disabled: string[] | undefined, packages: SkillPackages) => Promise<void>;
}) {
  let doneArgs: [boolean, boolean?] | null = null;
  let persisted: { disabled: string[] | undefined; packages: SkillPackages } | null = null;
  const view = new SkillConfView({
    tui,
    theme: undefined,
    keybindings: {},
    skills: opts?.skills ?? skills,
    disabledRaw: opts?.disabledRaw,
    packagesRaw: opts?.packagesRaw ?? {},
    onDone: (saved, discarded) => {
      doneArgs = [saved, discarded];
      opts?.onDone?.(saved, discarded);
    },
    onPersist: async (disabled, packages) => {
      persisted = { disabled, packages };
      await opts?.onPersist?.(disabled, packages);
    },
  });
  return {
    view,
    text: () => view.render(100).join("\n"),
    done: () => doneArgs,
    saved: () => persisted,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// --- initial render: packages first, then skills; disabled marked ---
{
  const v = makeView({ disabledRaw: ["beta"], packagesRaw: { web: ["alpha", "beta"] } });
  const t = v.text();
  assert.ok(t.includes("skillsconf"), "title");
  assert.ok(t.includes("web"), "package listed");
  assert.ok(t.includes("▸"), "package marker row");
  assert.ok(!t.includes("┌"), "no box outline on package rows");
  assert.ok(t.includes("PACKAGES (1)"), "packages header");
  assert.ok(t.includes("gamma"), "ungrouped skill listed");
  assert.ok(!t.includes("alpha First skill"), "packaged skill hidden from main list");
  assert.ok(!t.includes("beta Second skill"), "packaged skill hidden from main list");
  assert.ok(t.includes("2/3 enabled"), "enabled count (alpha+gamma)");
  assert.ok(!t.includes("unsaved"), "clean initially");
}

// --- space on a package mass-disables; esc reports not-saved ---
{
  const v = makeView({ packagesRaw: { web: ["alpha", "beta"] } });
  v.view.handleInput(" "); // cursor starts on package "web"
  assert.ok(v.text().includes("unsaved"), "dirty after package toggle");
  v.view.handleInput("\x1b"); // esc quits without saving
  assert.deepEqual(v.done(), [false, true], "esc reports discarded changes");
}

// --- space on a package with everything disabled re-enables ---
{
  let savedHolder: { disabled: string[] | undefined } | null = null;
  const v = makeView({
    disabledRaw: ["alpha", "beta"],
    packagesRaw: { web: ["alpha", "beta"] },
    onPersist: async (disabled) => {
      savedHolder = { disabled };
    },
  });
  v.view.handleInput(" "); // toggle package web -> enable all
  assert.ok(v.text().includes("3/3 enabled"), "all re-enabled");
  v.view.handleInput("s"); // s saves
  await tick();
  assert.deepEqual((savedHolder as { disabled: string[] | undefined } | null)?.disabled, undefined, "nothing disabled -> undefined");
}

// --- e toggles grouped view vs flat list ---
{
  const v = makeView({ packagesRaw: { web: ["alpha"] } });
  assert.ok(v.text().includes("web"), "packages shown by default");
  assert.ok(!v.text().includes("alpha First skill"), "member hidden in grouped view");
  v.view.handleInput("e");
  assert.ok(!v.text().includes("web"), "packages hidden after e");
  assert.ok(v.text().includes("alpha First skill"), "flat view shows every skill");
  v.view.handleInput("e");
  assert.ok(v.text().includes("web"), "packages shown again");
  assert.ok(!v.text().includes("alpha First skill"), "grouped again");
}

// --- filter finds packaged skills and shows their package ---
{
  const v = makeView({ packagesRaw: { web: ["alpha"] } });
  assert.ok(!v.text().includes("alpha First skill"), "member hidden before filter");
  v.view.handleInput("/");
  for (const ch of "alp") v.view.handleInput(ch);
  const t = v.text();
  assert.ok(t.includes("alpha First skill"), "filter finds packaged skill");
  assert.ok(t.includes("⟨web⟩"), "membership tag shown");
  v.view.handleInput("\x1b");
  assert.ok(!v.text().includes("alpha First skill"), "grouped again after clear");
}

// --- assign mode lists every skill including package members ---
{
  const v = makeView({ packagesRaw: { web: ["alpha"] } });
  v.view.handleInput("a"); // cursor is on package "web" -> assign mode
  const t = v.text();
  assert.ok(t.includes("assigning"), "assign mode banner");
  assert.ok(t.includes("alpha First skill"), "member visible in assign mode");
  assert.ok(t.includes("⟨web⟩"), "membership tag shown in assign mode");
  v.view.handleInput("\x1b"); // cancel assign
}

// --- n creates a package; a assigns skills to it ---
{
  const savedHolder: { current: { packages: SkillPackages } | null } = { current: null };
  const v = makeView({
    onPersist: async (_d, p) => {
      savedHolder.current = { packages: p };
    },
  });
  assert.ok(!v.text().includes("newpkg"), "no package yet");
  v.view.handleInput("n");
  for (const ch of "newpkg") v.view.handleInput(ch);
  v.view.handleInput("\r"); // confirm creation
  assert.ok(v.text().includes("newpkg"), "package created");
  v.view.handleInput("a"); // cursor is on newpkg -> assign mode
  assert.ok(v.text().includes("assigning"), "assign mode banner");
  v.view.handleInput(" "); // toggle membership of first skill (alpha)
  v.view.handleInput("\r"); // done assigning
  assert.ok(!v.text().includes("assigning"), "assign mode exited");
  v.view.handleInput("s"); // save
  await tick();
  assert.deepEqual(savedHolder.current?.packages["newpkg"], ["alpha"], "alpha assigned to newpkg");
}

// --- a on a skill (not a package) does not enter assign mode ---
{
  const v = makeView({});
  v.view.handleInput("j"); // move off... (no packages -> first entry is a skill)
  v.view.handleInput("a");
  assert.ok(!v.text().includes("assigning"), "no assign mode from skill row");
}

// --- / filters, Esc clears ---
{
  const v = makeView({});
  v.view.handleInput("/");
  for (const ch of "alp") v.view.handleInput(ch);
  const t = v.text();
  assert.ok(t.includes("alpha"), "match shown");
  assert.ok(!t.includes("gamma"), "non-match hidden");
  v.view.handleInput("\x1b");
  assert.ok(v.text().includes("gamma"), "filter cleared");
}

// --- space toggles a single skill ---
{
  const v = makeView({ packagesRaw: {} });
  v.view.handleInput("e"); // no-op (no packages); cursor on alpha
  v.view.handleInput(" ");
  assert.ok(v.text().includes("2/3 enabled"), "alpha disabled");
  v.view.handleInput("j");
  v.view.handleInput(" ");
  assert.ok(v.text().includes("1/3 enabled"), "beta disabled too");
}

// --- d on a package + y deletes it; save persists without it ---
{
  const savedHolder: { current: { packages: SkillPackages } | null } = { current: null };
  const v = makeView({
    packagesRaw: { web: ["alpha"], keep: ["beta"] },
    onPersist: async (_d, p) => {
      savedHolder.current = { packages: p };
    },
  });
  v.view.handleInput("d"); // cursor on package "web"
  assert.ok(v.text().includes('Delete package "web"?'), "confirm banner");
  v.view.handleInput("y");
  assert.ok(!v.text().includes("▸ web"), "package removed from list");
  assert.ok(v.text().includes("keep"), "other package kept");
  assert.ok(v.text().includes("alpha"), "member skill untouched");
  v.view.handleInput("s"); // save
  await tick();
  assert.deepEqual(Object.keys(savedHolder.current?.packages ?? {}), ["keep"]);
}

// --- d on a package + n cancels ---
{
  const v = makeView({ packagesRaw: { web: ["alpha"] } });
  v.view.handleInput("d");
  assert.ok(v.text().includes("Delete package"), "confirm banner");
  v.view.handleInput("n");
  assert.ok(v.text().includes("web"), "package kept after cancel");
  assert.ok(!v.text().includes("unsaved"), "no dirty flag after cancel");
}

// --- d on a skill + y deletes it from disk and cleans draft state ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillsconf-view-"));
  const skillDir = path.join(dir, "tmp-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# tmp");
  const savedHolder: { current: { packages: SkillPackages } | null } = { current: null };
  const v = makeView({
    skills: [
      ...skills,
      { name: "tmp-skill", description: "Temp", filePath: path.join(skillDir, "SKILL.md") },
    ],
    packagesRaw: { web: ["alpha", "tmp-skill"] },
    onPersist: async (_d, p) => {
      savedHolder.current = { packages: p };
    },
  });
  v.view.handleInput("e"); // flat view: packaged skills visible
  v.view.handleInput("G"); // jump to last entry (tmp-skill)
  v.view.handleInput("d");
  const t = v.text();
  assert.ok(t.includes('Delete skill "tmp-skill"'), "skill confirm banner");
  assert.ok(v.view.render(300).join("\n").includes(skillDir), "banner shows target path");
  v.view.handleInput("y");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(skillDir), false, "skill dir removed from disk");
  assert.ok(!v.text().includes("tmp-skill Temp"), "skill removed from list");
  v.view.handleInput("s"); // save
  await tick();
  assert.deepEqual(savedHolder.current?.packages["web"], ["alpha"], "member cleaned from package");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- s saves in place without closing; Enter does nothing ---
{
  let calls = 0;
  const v = makeView({
    onPersist: async () => {
      calls++;
    },
  });
  v.view.handleInput(" "); // dirty
  assert.ok(v.text().includes("unsaved"), "dirty before save");
  v.view.handleInput("s");
  await tick();
  assert.equal(calls, 1, "persist called once");
  assert.deepEqual(v.done(), null, "UI stays open");
  assert.ok(!v.text().includes("unsaved"), "dirty cleared");
  assert.ok(v.text().includes("saved — 2/3 enabled"), "saved notice");
  v.view.handleInput(" "); // dirty again
  v.view.handleInput("\r"); // Enter: no-op
  await tick();
  assert.equal(calls, 1, "Enter does not save");
  assert.deepEqual(v.done(), null, "Enter does not close");
  assert.ok(v.text().includes("unsaved"), "still dirty");
}

// --- s with nothing to save is a no-op ---
{
  let calls = 0;
  const v = makeView({
    onPersist: async () => {
      calls++;
    },
  });
  v.view.handleInput("s");
  await tick();
  assert.equal(calls, 0, "no persist when clean");
  assert.ok(v.text().includes("nothing to save"), "hint shown");
}

// --- n opens a boxed name input; typing shows inside the box ---
{
  const v = makeView({});
  v.view.handleInput("n");
  const n = v.text();
  assert.ok(n.includes("new package name"), "naming box title");
  assert.ok(n.includes("┌") && n.includes("└") && n.includes("│"), "input box outline");
  v.view.handleInput("x");
  assert.ok(v.text().includes("│ x"), "typed name visible in box");
  v.view.handleInput("\x1b"); // cancel
  assert.ok(!v.text().includes("new package name"), "box closed after cancel");
}

// --- arrow keys exit search typing, keep filter, move selection ---
{
  const v = makeView({
    disabledRaw: ["alpha"],
    skills: [
      { name: "alpha", description: "", filePath: "" },
      { name: "alpine", description: "", filePath: "" },
      { name: "beta", description: "", filePath: "" },
    ],
  });
  v.view.handleInput("/");
  for (const ch of "alp") v.view.handleInput(ch);
  v.view.handleInput("\x1b[B"); // down: exit typing, keep filter, cursor -> alpine
  assert.ok(v.text().includes('filter: "alp"'), "filter kept");
  assert.ok(!v.text().includes("beta"), "filter still applied");
  v.view.handleInput("x"); // normal mode: letters do nothing
  assert.ok(v.text().includes('filter: "alp"'), "typing ended");
  v.view.handleInput(" "); // toggles alpine (alpha already disabled)
  assert.ok(v.text().includes("1/3 enabled"), "moved selection toggled");
}

// --- left/right edit the query in search; do nothing in normal mode ---
{
  const v = makeView({});
  v.view.handleInput("/");
  for (const ch of "alp") v.view.handleInput(ch);
  v.view.handleInput("\x1b[D"); // left: stay typing, move text cursor
  v.view.handleInput("X");
  // (cursor marker sits between X and p in the raw render)
  assert.ok(v.text().includes("/ alX"), "left edits query, typing continues");
}
{
  const v = makeView({ disabledRaw: ["alpha"] });
  v.view.handleInput("\x1b[C"); // right: no-op in normal mode
  v.view.handleInput(" "); // still on alpha -> re-enabled
  assert.ok(v.text().includes("3/3 enabled"), "right does nothing in normal mode");
}

console.log("SkillConfView.test.ts: all assertions passed");

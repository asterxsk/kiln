import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSkillFiles, resolveSkillDeleteTarget } from "./delete-skill.js";

// resolve: SKILL.md -> parent dir
assert.equal(
  resolveSkillDeleteTarget(path.join("C:", "s", "foo", "SKILL.md")),
  path.join("C:", "s", "foo"),
);
// resolve: lone file -> itself
assert.equal(
  resolveSkillDeleteTarget(path.join("C:", "s", "solo.md")),
  path.join("C:", "s", "solo.md"),
);
// resolve: empty / relative -> null
assert.equal(resolveSkillDeleteTarget(""), null);
assert.equal(resolveSkillDeleteTarget("relative/SKILL.md"), null);

// delete: skill dir with SKILL.md (+ extra files) goes away entirely
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillsconf-del-"));
  const skillDir = path.join(dir, "my-skill");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test");
  fs.writeFileSync(path.join(skillDir, "scripts", "x.py"), "x");
  const removed = await deleteSkillFiles(path.join(skillDir, "SKILL.md"));
  assert.equal(removed, skillDir);
  assert.equal(fs.existsSync(skillDir), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// delete: lone .md file
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillsconf-del-"));
  const file = path.join(dir, "solo.md");
  fs.writeFileSync(file, "# test");
  assert.equal(await deleteSkillFiles(file), file);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// delete: missing path throws, touches nothing
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillsconf-del-"));
  await assert.rejects(deleteSkillFiles(path.join(dir, "nope", "SKILL.md")), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// delete: relative path refused
await assert.rejects(deleteSkillFiles("some/SKILL.md"), /non-absolute/);

// delete: type mismatch refused (non-SKILL.md path pointing at a directory)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillsconf-del-"));
  const sub = path.join(dir, "notmd");
  fs.mkdirSync(sub);
  await assert.rejects(deleteSkillFiles(sub), /expected a file/);
  assert.equal(fs.existsSync(sub), true, "refused delete leaves dir alone");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("delete-skill.test.ts: all assertions passed");

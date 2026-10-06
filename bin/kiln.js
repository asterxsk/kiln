#!/usr/bin/env node
// kiln installer (npm) — installs pi, the compact-tools + context packages, and the curated agent config.
//  1) Install/update pi via the official script (curl on Unix, irm on Windows — never npm)
//  2) Install pi packages (pi-context-usage, pi-compact-tools)
//  3) Install custom config (AGENTS.md, keybindings, extensions …)
//  4) Install per-extension npm deps via each extension's own installer
//
// Usage:
//   npx @asterxsk/kiln --yes
//   npm i -g @asterxsk/kiln && kiln --yes
//   bunx @asterxsk/kiln --yes
//   node bin/kiln.js --target /tmp/pi-test --skip-pi --skip-packages --yes
//
// Already-installed items are skipped; outdated global packages are updated.
// Only one timestamped backup (<target>.bak.*) is kept; the clone temp dir
// under ~/.pi/tmp/kiln-* is always removed.
//
// Safe to re-run. Managed files are force-overwritten; per-user state
// (taste.md, auth.json, sessions, etc.) is preserved. settings.json and
// compact-tools.json are seeded from repo defaults and refreshed while still
// untouched — once you edit them, kiln leaves them alone.
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const NODE_MIN = [22, 19, 0];
const DEFAULT_REPO = "https://github.com/asterxsk/kiln";
const DEFAULT_BRANCH = "main";
const PACKAGES = ["pi-context-usage@latest", "pi-compact-tools@latest"];
const SETTINGS_PACKAGES = ["npm:pi-context-usage", "npm:pi-compact-tools"];

const startTime = Date.now();
let clonedTmp = "";
let tmpLog = "";
let ok = true; // hard failures flip this; warnings don't

// npm >=11 rejects `npm_config_allow_scripts` inherited from a parent npm/npx
// process ("--allow-scripts is not allowed in project-scoped installs"). This
// happens when kiln itself runs under npx/npm exec and the user has
// `allow-scripts` in ~/.npmrc: npm forwards it as env to every child, so each
// per-extension `npm ci` fails with EALLOWSCRIPTS. Drop it; file-based config
// (~/.npmrc, per-package `allowScripts`) still applies to child npm processes.
for (const k of ["npm_config_allow_scripts", "NPM_CONFIG_ALLOW_SCRIPTS"]) delete process.env[k];

// ── summary buckets ─────────────────────────────────────────────────────
// Every completed item is recorded here; the final Summary prints them all.
const buckets = { skipped: [], updated: [], installed: [], "npm modules": [] };
const FRIENDLY = { "pi-context-usage": "context extension", "pi-compact-tools": "compact tools extension" };
function note(bucket, name) { buckets[bucket].push(name); }
function prettyPkg(spec) { return FRIENDLY[spec.replace(/^npm:/, "")] || spec; }

// ── args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    repo: process.env.PI_CONFIG_REPO || "",
    branch: process.env.PI_CONFIG_BRANCH || DEFAULT_BRANCH,
    target: process.env.PI_AGENT_DIR || "",
    skipPi: false, skipPackages: false, yes: false, local: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = argv[++i] ?? "";
    else if (a === "--branch") o.branch = argv[++i] ?? "";
    else if (a === "--target") o.target = argv[++i] ?? "";
    else if (a === "--skip-pi") o.skipPi = true;
    else if (a === "--skip-packages") o.skipPackages = true;
    else if (a === "--local") o.local = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: kiln [--repo URL] [--branch BRANCH] [--target DIR] [--local] [--skip-pi] [--skip-packages] [--yes]");
      process.exit(0);
    } else if (a === "--") break;
    else if (a.startsWith("-")) { console.error(`unknown arg: ${a}`); process.exit(1); }
  }
  if (!o.repo) o.repo = DEFAULT_REPO;
  return o;
}

// ── output ──────────────────────────────────────────────────────────────
const isTTY = !!process.stdout.isTTY && process.env.TERM !== "dumb";
const C = isTTY
  ? { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", gray: "\x1b[90m" }
  : { reset: "", bold: "", dim: "", green: "", yellow: "", red: "", cyan: "", gray: "" };
const line = (s) => process.stdout.write(s + "\n");
const log = (s) => { try { fs.appendFileSync(tmpLog, s + "\n"); } catch {} };
// Mid-run output: plain lines when piped, swallowed (→ log + summary) when live.
function detail(s) { try { log(String(s).replace(/\x1b\[[0-9;]*m/g, "")); } catch {} if (!isTTY) line(s); }

// ── forge art + live status ─────────────────────────────────────────────
const ART = [
  "     █▌  █▌",
  "  ██████████████",
  "     ██    ██",
  "     ██    ██",
  "     ██    ██",
  "     ██    ██ ",
];
// Phase 0 = ember (dim), phase 1 = stoked (bright). Non-TTY → plain art.
function artLines(phase) {
  if (!isTTY) return ART.slice();
  const m = phase ? 1 : 2; // bold vs dim
  const cream = `\x1b[${m};38;5;230m`, orange = `\x1b[${m};38;5;208m`, brown = `\x1b[${m};38;5;94m`, R = "\x1b[0m";
  return [
    `     ${cream}█▌${R}  ${cream}█▌${R}`,
    `  ${orange}██████████████${R}`,
    `     ${orange}██${R}    ${orange}██${R}`,
    `     ${orange}██${R}    ${orange}██${R}`,
    `     ${orange}██${R}    ${orange}██${R}`,
    `     ${brown}██    ██${R} `,
  ];
}
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠰", "⠠", "⠦", "⠧", "⠇", "⠏"];
let liveLabel = "", liveTimer = null, liveTickN = 0;
function liveDraw() {
  if (!isTTY) return;
  const rows = [...artLines(liveTickN % 10 < 5 ? 0 : 1), ` ${C.yellow}${SPIN[liveTickN % SPIN.length]}${C.reset} ${C.dim}${liveLabel}${C.reset}`];
  process.stdout.write("\x1b[7A");
  for (const r of rows) process.stdout.write(`\r\x1b[K${r}\n`);
}
function liveStart() {
  if (!isTTY) return;
  process.stdout.write("\n".repeat(7));
  liveTickN = 0;
  liveDraw();
  liveTimer = setInterval(() => { liveTickN++; liveDraw(); }, 100);
}
function liveSet(label) { liveLabel = label; }
function liveStop() {
  if (!isTTY) return;
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  liveTickN = 5; // stoked final frame
  liveDraw();
}

function title() {
  line("");
  line(`  ${C.bold}◆ Pi Setup${C.reset}`);
  line(`  ${C.dim}custom agent config  ·  pi + compact-tools + extensions${C.reset}`);
  if (!isTTY) for (const r of artLines(0)) line(`  ${r}`);
  line("");
}

// Run a command: the live status line shows it on TTY, plain lines when piped. Output always → log.
function runStep(step, label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    liveSet(`[${step}] ${label}`);
    if (!isTTY) line(`  · ${label}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...opts });
    child.stdout.on("data", (d) => log(d.toString().trimEnd()));
    child.stderr.on("data", (d) => log(d.toString().trimEnd()));
    child.on("error", (e) => { log(`spawn failed: ${e.message}`); resolve(1); });
    child.on("close", (code) => { resolve(code ?? 1); });
  });
}

function have(cmd) {
  try {
    if (process.platform === "win32") return spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;
    return spawnSync("sh", ["-c", `command -v "${cmd}"`], { stdio: "ignore" }).status === 0;
  } catch { return false; }
}
function cmdOut(cmd, args) {
  try { return spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim(); }
  catch { return ""; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Quote one shell word (cmd.exe + sh compatible for our controlled args).
const q = (a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function cmdOutShell(command) {
  try { return spawnSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: true }).stdout.trim(); }
  catch { return ""; }
}
// npm on Windows is npm.cmd (a batch shim) — it cannot be spawned directly,
// so run it through the shell as a single pre-quoted command string.
function npmStep(step, label, args) {
  if (process.platform === "win32") return runStep(step, label, "npm.cmd " + args.map(q).join(" "), [], { shell: true });
  return runStep(step, label, "npm", args);
}
// pi is also a cmd shim on Windows — same shell treatment.
function piOut(args) {
  if (process.platform === "win32") return cmdOutShell("pi " + args.map(q).join(" "));
  return cmdOut("pi", args);
}
function piStep(label, args) {
  if (process.platform === "win32") return runStep("pkg", label, "pi " + args.map(q).join(" "), [], { shell: true });
  return runStep("pkg", label, "pi", args);
}
// pi installs via its official script — curl on Unix, irm on Windows. Never npm.
function piInstallStep(step, label) {
  const cmd = process.platform === "win32"
    ? 'powershell -NoProfile -Command "irm https://pi.dev/install.ps1 | iex"'
    : "curl -fsSL https://pi.dev/install.sh | sh";
  return runStep(step, label, cmd, [], { shell: true });
}
const npmVer = process.platform === "win32" ? cmdOutShell("npm.cmd --version") : cmdOut("npm", ["--version"]);

// Installed global version of a package ("" when not installed).
function globalPkgVersion(name) {
  const out = process.platform === "win32"
    ? cmdOutShell(`npm.cmd ls -g "${name}" --depth=0`)
    : cmdOut("npm", ["ls", "-g", name, "--depth=0"]);
  const m = out.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "@(\\S+)"));
  return m ? m[1].replace(/[^0-9A-Za-z.+-].*$/, "") : "";
}
// Latest registry version ("" when offline / unknown).
function latestPkgVersion(name) {
  const out = process.platform === "win32"
    ? cmdOutShell(`npm.cmd view "${name}" version`)
    : cmdOut("npm", ["view", name, "version"]);
  const v = (out || "").split(/\s+/)[0].trim();
  return /^[0-9][0-9A-Za-z.+-]*$/.test(v) ? v : "";
}
// Structural equality that ignores object key order.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
// Keep only the newest sibling backup (<target>.bak.*); delete the rest.
function pruneBackups(targetDir, keep) {
  try {
    const parent = path.dirname(targetDir);
    const base = path.basename(targetDir);
    const keepBase = keep ? path.basename(keep) : "";
    for (const b of fs.readdirSync(parent)) {
      if (!b.startsWith(base + ".bak.")) continue;
      if (b === keepBase) continue;
      try { fs.rmSync(path.join(parent, b), { recursive: true, force: true }); } catch {}
    }
  } catch (e) { log(`prune backups failed: ${e.message}`); }
}
// Remove stale clone dirs (~/.pi/tmp/kiln-*) except the active one.
function sweepStaleCloneTmp(tmpBase, active) {
  try {
    for (const e of fs.readdirSync(tmpBase)) {
      if (!e.startsWith("kiln-")) continue;
      if (active && e === path.basename(active)) continue;
      try { fs.rmSync(path.join(tmpBase, e), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

// Recursive copy, excluding names (node_modules, .git). Returns false on error.
function copyTree(src, dst, exclude = new Set(["node_modules", ".git"])) {
  try {
    if (path.resolve(src) === path.resolve(dst)) return true;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (exclude.has(e.name)) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) { if (!copyTree(s, d, exclude)) return false; }
      else if (e.isFile()) fs.copyFileSync(s, d);
    }
    return true;
  } catch (e) { log(`copy failed ${src} → ${dst}: ${e.message}`); return false; }
}

function resolveTarget(opt) {
  if (opt) return opt;
  return path.join(os.homedir(), ".pi", "agent");
}

// Source root: always a fresh GitHub clone (never the bundled tarball — it goes
// stale). --local builds from a local checkout instead (dev only).
function resolveSourceRoot(args) {
  const pkgRoot = path.resolve(__dirname, ".."); // bin/ → package root
  if (args.local) {
    const cands = [path.join(pkgRoot, "agent"), pkgRoot, process.cwd(), path.join(process.cwd(), "agent")];
    for (const r of cands) {
      if (fs.existsSync(path.join(r, "extensions")) && fs.existsSync(path.join(r, "AGENTS.md"))) return r;
    }
    throw new Error(`local checkout not found (tried: ${cands.join(", ")})`);
  }
  if (!have("git")) throw new Error("git not found — kiln installs from GitHub (use --local for a local checkout)");
  const base = path.join(os.homedir(), ".pi", "tmp");
  fs.mkdirSync(base, { recursive: true });
  const tmp = path.join(base, "kiln-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(tmp, { recursive: true });
  liveSet(`cloning repo…`);
  detail(`  · cloning ${args.repo} (branch ${args.branch})`);
  const r = spawnSync("git", ["clone", "--depth", "1", "--branch", args.branch, args.repo, tmp],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" } });
  if (r.stdout) log(r.stdout.trimEnd());
  if (r.stderr) log(r.stderr.trimEnd());
  if (r.status !== 0) throw new Error(`git clone failed (exit ${r.status}). See ${tmpLog}`);
  clonedTmp = tmp;
  if (fs.existsSync(path.join(tmp, "agent"))) return path.join(tmp, "agent");
  return tmp;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpBase = path.join(os.homedir(), ".pi", "tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  tmpLog = path.join(tmpBase, `pi-setup-${crypto.randomBytes(4).toString("hex")}.log`);
  fs.writeFileSync(tmpLog, "");
  process.on("exit", () => { if (clonedTmp && clonedTmp.startsWith(path.join(tmpBase, "kiln-"))) fs.rmSync(clonedTmp, { recursive: true, force: true }); });

  title();
  const targetDir = resolveTarget(args.target);
  line(`${C.dim}  target  ${C.reset}${targetDir}`);
  line(`${C.dim}  repo    ${C.reset}${args.repo}  ${C.dim}(${args.branch})${C.reset}`);
  line(`${C.dim}  log     ${C.reset}${tmpLog}\n`);

  // ── preflight ──
  const nodeVer = process.versions.node.split("-")[0];
  const nv = nodeVer.split(".").map(Number);
  const nodeOk = nv[0] > NODE_MIN[0] || (nv[0] === NODE_MIN[0] && (nv[1] > NODE_MIN[1] || (nv[1] === NODE_MIN[1] && nv[2] >= NODE_MIN[2])));
  if (!nodeOk) {
    line(`${C.yellow}  ⚠ Node ${nodeVer} < ${NODE_MIN.join(".")} — please upgrade to Node ${NODE_MIN.join(".")}+${C.reset}`);
    if (!args.yes) { line("    continue anyway in 3s…"); await sleep(3000); }
  }
  if (!have("npm")) { line(`${C.red}  ✖ npm not found (Node installed but npm missing)${C.reset}`); process.exit(1); }
  line(`${C.dim}  node ${nodeVer}  ·  npm ${npmVer}  ·  ${cmdOut("git", ["--version"]) || "git n/a"}${C.reset}\n`);

  // git is required unless --local (every install clones GitHub latest)
  if (!have("git") && !args.local) { line(`${C.red}  ✖ git not found — kiln installs from GitHub (or re-run with --local)${C.reset}`); process.exit(1); }
  liveStart();

  // ── [1/4] pi ──
  if (args.skipPi) {
    detail(`  · Install pi — skipped`);
    note("skipped", "pi");
  } else if (have("pi")) {
    const installed = globalPkgVersion(PI_PACKAGE) || cmdOut("pi", ["--version"]).replace(/^[vV]/, "").trim();
    const latest = latestPkgVersion(PI_PACKAGE);
    if (installed && latest && installed === latest) {
      detail(`  · pi ${installed} — already installed, skipping`);
      note("skipped", "pi");
    } else if (installed && !latest) {
      detail(`  · pi ${installed} — already installed, skipping version check (offline)`);
      note("skipped", "pi");
    } else {
      const label = installed ? `updating pi ${installed} → ${latest || "latest"}` : `installing pi`;
      const code = await piInstallStep("1/4", label);
      if (code === 0) {
        detail(`  · ${label} — ${cmdOut("pi", ["--version"]) || "?"}`);
        note(installed ? "updated" : "installed", "pi");
      } else {
        detail(`  ✖ ${label} failed (exit ${code}) — see log`);
        note("updated", "pi (failed — see log)");
        ok = false;
      }
    }
  } else {
    const label = `installing pi`;
    const code = await piInstallStep("1/4", label);
    if (code === 0) {
      detail(`  · ${label} — ${cmdOut("pi", ["--version"]) || "?"}`);
      note("installed", "pi");
    } else {
      detail(`  ✖ ${label} failed (exit ${code}) — see log`);
      note("installed", "pi (failed — see log)");
      ok = false;
    }
  }
  // ── [2/4] pi packages (global best-effort; pi-side ensure runs after step 3) ──
  if (args.skipPackages) {
    detail(`  · pi packages — skipped`);
  } else {
    const bare = PACKAGES.map((p) => p.replace(/@latest$/, ""));
    const need = [];
    for (const name of bare) {
      const inst = globalPkgVersion(name);
      const latest = latestPkgVersion(name);
      if (inst && latest && inst === latest) {
        detail(`  · ${name}@${inst} already installed globally, skipping`);
      } else if (inst && !latest) {
        detail(`  · ${name}@${inst} already installed globally, skipping version check (offline)`);
      } else {
        if (inst) detail(`  · ${name} ${inst} → ${latest || "latest"} — will update globally`);
        need.push(`${name}@latest`);
      }
    }
    if (!need.length) {
      detail(`  · pi packages — already installed globally, skipping`);
    } else {
    const label = `installing ${need.join(" ")} (-g)`;
    const code = await npmStep("2/4", label, ["install", "-g", ...need, "--no-audit", "--no-fund"]);
    if (code === 0) detail(`  · pi packages — global install done`);
    else detail(`  ⚠ ${label} exit ${code} — continuing (pi-side ensure runs later)`);
    }
  }
  // ── [3/4] custom config ──
  try {
    const sourceRoot = resolveSourceRoot(args);
    detail(`  · source ${sourceRoot}`);
    fs.mkdirSync(targetDir, { recursive: true });
    let bak = "";
    if (fs.existsSync(path.join(targetDir, "AGENTS.md")) || fs.existsSync(path.join(targetDir, "extensions"))) {
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      bak = `${targetDir}.bak.${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      detail(`  · backup ${targetDir}/extensions → ${bak}`);
      fs.mkdirSync(bak, { recursive: true });
      for (const f of ["AGENTS.md", "keybindings.json", "README.md", "version.txt"]) {
        const s = path.join(targetDir, f);
        if (fs.existsSync(s)) try { fs.copyFileSync(s, path.join(bak, f)); } catch {}
      }
      const extSrc = path.join(targetDir, "extensions");
      if (fs.existsSync(extSrc)) {
        fs.mkdirSync(path.join(bak, "extensions"), { recursive: true });
        for (const e of fs.readdirSync(extSrc, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          copyTree(path.join(extSrc, e.name), path.join(bak, "extensions", e.name));
        }
      }
      pruneBackups(targetDir, bak); // only one backup at a time
    }

    let copied = 0;
    const selfInstall = path.resolve(sourceRoot) === path.resolve(targetDir);
    if (selfInstall) detail(`  · source == target — skipping file copy (self-install)`);
    for (const f of ["AGENTS.md", "keybindings.json", "README.md", "version.txt"]) {
      if (!fs.existsSync(path.join(sourceRoot, f))) continue;
      if (!selfInstall) fs.copyFileSync(path.join(sourceRoot, f), path.join(targetDir, f));
      copied++;
    }
    // settings.json: seed kiln's defaults, refresh while untouched, never stomp
    // user edits (any difference from the baseline counts as an edit).
    const settingsPath = path.join(targetDir, "settings.json");
    const repoSettings = path.join(sourceRoot, "settings.json");
    if (fs.existsSync(repoSettings)) {
      const baseline = JSON.parse(fs.readFileSync(repoSettings, "utf8"));
      baseline.packages = [...new Set([...(baseline.packages || []), ...SETTINGS_PACKAGES])];
      let current = null;
      if (fs.existsSync(settingsPath)) {
        try { current = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
      }
      if (current && !deepEqual(current, baseline)) {
        detail(`  · kept existing settings.json`);
        note("skipped", "settings.json");
      } else {
        fs.writeFileSync(settingsPath, JSON.stringify(baseline, null, 2) + "\n");
        detail(`  · settings.json — kiln defaults`);
        note(current ? "updated" : "installed", "settings.json");
      }
    }
    for (const t of ["taste.md", "taste", "taste.json"]) {
      const tp = path.join(targetDir, t);
      if (fs.existsSync(tp)) detail(`  · kept existing ${t}`);
      else if (fs.existsSync(path.join(sourceRoot, t))) {
        const s = path.join(sourceRoot, t);
        if (fs.statSync(s).isDirectory()) copyTree(s, tp, new Set());
        else fs.copyFileSync(s, tp);
      }
    }

    // compact-tools tool-row style: seed kiln's default, but never overwrite a
    // style the user switched to. Other keys they tuned are preserved either way.
    const repoCompact = path.join(sourceRoot, "compact-tools.json");
    if (fs.existsSync(repoCompact)) {
      const compactPath = path.join(targetDir, "compact-tools.json");
      let defaultStyle = "codex";
      try {
        const d = JSON.parse(fs.readFileSync(repoCompact, "utf8"));
        if (d && typeof d.style === "string") defaultStyle = d.style;
      } catch {}
      let current = null;
      if (fs.existsSync(compactPath)) {
        try {
          const e = JSON.parse(fs.readFileSync(compactPath, "utf8"));
          if (e && typeof e === "object" && !Array.isArray(e)) current = e;
        } catch {}
      }
      if (current && typeof current.style === "string" && current.style !== defaultStyle) {
        detail(`  · kept existing compact-tools.json (${current.style} style)`);
        note("skipped", "compact-tools.json");
      } else {
        fs.writeFileSync(compactPath, JSON.stringify({ ...(current || {}), style: defaultStyle }, null, 2) + "\n");
        detail(`  · compact-tools → ${defaultStyle} style`);
        note(current ? "updated" : "installed", "compact-tools.json");
      }
    }

    if (fs.existsSync(path.join(sourceRoot, "extensions"))) {
      fs.mkdirSync(path.join(targetDir, "extensions"), { recursive: true });
      for (const e of fs.readdirSync(path.join(sourceRoot, "extensions"), { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.endsWith(".md")) continue;
        const dst = path.join(targetDir, "extensions", e.name);
        const existed = fs.existsSync(dst);
        if (copyTree(path.join(sourceRoot, "extensions", e.name), dst)) { copied++; note(existed ? "updated" : "installed", e.name); }
        else detail(`  ⚠ copy extensions/${e.name} failed`);
      }
    }

    if (!selfInstall && fs.existsSync(path.join(sourceRoot, "themes"))) {
      fs.rmSync(path.join(targetDir, "themes"), { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "themes"), { recursive: true });
      for (const e of fs.readdirSync(path.join(sourceRoot, "themes"), { withFileTypes: true })) {
        if (e.name === ".pi" || e.name === "nul") continue;
        const s = path.join(sourceRoot, "themes", e.name), dd = path.join(targetDir, "themes", e.name);
        if (e.isDirectory()) copyTree(s, dd, new Set());
        else if (e.isFile()) try { fs.copyFileSync(s, dd); } catch {}
      }
    }

    detail(`  · custom config — ${copied} items → ${targetDir}`);
    if (clonedTmp) { fs.rmSync(clonedTmp, { recursive: true, force: true }); clonedTmp = ""; }
    sweepStaleCloneTmp(tmpBase, ""); // delete any leftover kiln-* temp dirs
    const repoReadme = path.resolve(sourceRoot, "..", "README.md");
    const parentReadme = path.resolve(targetDir, "..", "README.md");
    if (repoReadme !== parentReadme && fs.existsSync(repoReadme)) {
      try { fs.copyFileSync(repoReadme, parentReadme); } catch {}
    }
  } catch (e) {
    detail(`  ✖ custom config failed: ${e.message}`);
    ok = false;
  }
  // ── [4/4] per-extension deps ──
  const extRoot = path.join(targetDir, "extensions");
  if (!fs.existsSync(extRoot)) {
    detail(`  ⚠ no extensions found at ${extRoot}`);
  } else {
    const failed = [];
    let installed = 0, skipped = 0;
    for (const e of fs.readdirSync(extRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.endsWith(".md")) continue;
      const dir = path.join(extRoot, e.name), label = `extensions/${e.name}`;
      if (fs.existsSync(path.join(dir, "node_modules"))) {
        detail(`  · ${label} — already installed, skipping`);
        note("skipped", e.name);
        skipped++;
        continue;
      }
      const hasPkg = fs.existsSync(path.join(dir, "package.json"));
      const sh = path.join(dir, "install.sh"), ps1 = path.join(dir, "install.ps1");
      let code;
      if (process.platform === "win32" && fs.existsSync(ps1)) {
        const shell = have("pwsh") ? "pwsh" : "powershell";
        code = await runStep("4/4", label, shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
      } else if (process.platform !== "win32" && fs.existsSync(sh)) {
        code = await runStep("4/4", label, "sh", [sh]);
      } else if (hasPkg) {
        const a = ["--prefix", dir, fs.existsSync(path.join(dir, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"];
        code = await npmStep("4/4", label, a);
      } else {
        detail(`  · ${label} — no package.json, skipping`);
        continue;
      }
      if (code === 0) { detail(`  · ${label} — done`); if (hasPkg) note("npm modules", e.name); installed++; }
      else { detail(`  ✖ ${label} failed (exit ${code}) — see log`); note("npm modules", `${e.name} (failed — see log)`); failed.push(e.name); }
    }
    if (!failed.length) detail(`  · extension deps — ${installed} installed, ${skipped} skipped`);
    else detail(`  ⚠ extension deps ${failed.length} failed: ${failed.join(", ")} — see log`);
  }

  // ── pi package ensure (compact-tools + context actually registered with pi) ──
  // `pi list` is truth: global installs mean nothing to pi (it uses its own dir).
  const defaultDir = path.join(os.homedir(), ".pi", "agent");
  if (args.skipPackages) {
    for (const s of SETTINGS_PACKAGES) note("skipped", prettyPkg(s));
  } else if (!have("pi")) {
    detail(`  ⚠ pi binary not found — packages registered for next launch`);
    for (const s of SETTINGS_PACKAGES) note("skipped", prettyPkg(s));
  } else if (path.resolve(targetDir) !== path.resolve(defaultDir)) {
    detail(`  · custom target — packages registered for next launch`);
    for (const s of SETTINGS_PACKAGES) note("skipped", prettyPkg(s));
  } else {
    let list = "";
    try { list = piOut(["list"]); } catch { list = ""; }
    for (const spec of SETTINGS_PACKAGES) {
      const pretty = prettyPkg(spec);
      if (list.includes(spec)) { note("skipped", pretty); continue; }
      const code = await piStep(`pi install ${spec}`, ["install", spec]);
      let now = "";
      try { now = piOut(["list"]); } catch { now = ""; }
      if (code === 0 && now.includes(spec)) { detail(`  · ${pretty} — registered with pi`); note("installed", pretty); }
      else { detail(`  ✖ ${pretty} not registered — see log (pi retries on next launch)`); note("updated", `${pretty} (failed — see log)`); }
    }
  }

  // ── summary ──
  liveStop();
  const secs = Math.round((Date.now() - startTime) / 1000);
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  line("");
  if (ok) line(`${C.green}${C.bold}  ✓ Setup complete${C.reset}  ${C.dim}→ ${targetDir}${C.reset}`);
  else line(`${C.yellow}${C.bold}  ⚠ Setup finished with warnings${C.reset}  ${C.dim}see ${tmpLog}${C.reset}`);
  line("");
  line("Summary:");
  line("");
  for (const name of ["skipped", "updated", "installed", "npm modules"]) {
    line(`[${name}]`);
    const items = buckets[name];
    if (!items.length) line("(none)");
    else for (const item of items) line(item);
    line("");
  }
  line(`Done in ${elapsed}`);
  line(`${C.dim}  log: ${tmpLog}${C.reset}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(`\n  ✖ ${e.message}`); process.exit(1); });
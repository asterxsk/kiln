#!/usr/bin/env node
// kiln installer — cross-platform Node port of agent/install.sh + agent/install.ps1.
//  1) Install/update pi (@earendil-works/pi-coding-agent)
//  2) Install pi packages (pi-context-usage, @baretread/pi-forge)
//  3) Install custom config (AGENTS.md, keybindings, extensions …)
//  4) Install per-extension npm deps via each extension's own installer
//
// Usage:
//   npx @asterxsk/kiln --yes
//   npm i -g @asterxsk/kiln && kiln --yes
//   bunx @asterxsk/kiln --yes
//   node bin/kiln.js --target /tmp/pi-test --skip-pi --skip-packages --yes
//
// Safe to re-run. Managed files are force-overwritten; per-user files
// (settings.json, taste.md, auth.json, sessions, etc.) are preserved.
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
const PACKAGES = ["pi-context-usage@latest", "@baretread/pi-forge@latest"];
const SETTINGS_PACKAGES = ["npm:pi-context-usage", "npm:@baretread/pi-forge"];

const startTime = Date.now();
let clonedTmp = "";
let tmpLog = "";
let ok = true; // hard failures flip this; warnings don't

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

function title() {
  line("");
  line(`  ${C.bold}◆ Pi Setup${C.reset}`);
  line(`  ${C.dim}custom agent config  ·  pi + forge + extensions${C.reset}`);
  line("");
}

// Run a command: spinner on TTY, quiet otherwise. Output always → log.
function runStep(step, label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...opts });
    let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠰", "⠠", "⠦", "⠧", "⠇", "⠏"];
    let i = 0, timer = null;
    if (isTTY) {
      timer = setInterval(() => {
        process.stdout.write(`\r\x1b[K ${C.yellow}${frames[i++ % frames.length]}${C.reset} ${C.dim}[${step}/4]${C.reset} ${label}`);
      }, 80);
    }
    child.stdout.on("data", (d) => log(d.toString().trimEnd()));
    child.stderr.on("data", (d) => log(d.toString().trimEnd()));
    child.on("error", (e) => { log(`spawn failed: ${e.message}`); if (timer) clearInterval(timer); if (isTTY) process.stdout.write("\r\x1b[K"); resolve(1); });
    child.on("close", (code) => { if (timer) clearInterval(timer); if (isTTY) process.stdout.write("\r\x1b[K"); resolve(code ?? 1); });
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
const npmVer = process.platform === "win32" ? cmdOutShell("npm.cmd --version") : cmdOut("npm", ["--version"]);

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

// Source root: bundled payload (npm tarball or dev checkout) → else git clone.
function resolveSourceRoot(args) {
  const pkgRoot = path.resolve(__dirname, ".."); // bin/ → package root
  const cands = [path.join(pkgRoot, "agent"), pkgRoot, process.cwd(), path.join(process.cwd(), "agent")];
  for (const r of cands) {
      if (fs.existsSync(path.join(r, "extensions")) && fs.existsSync(path.join(r, "AGENTS.md"))) return r;
    }
    if (args.local) throw new Error(`local checkout not found (tried: ${cands.join(", ")})`);
  const base = path.join(os.homedir(), ".pi", "tmp");
  fs.mkdirSync(base, { recursive: true });
  const tmp = path.join(base, "kiln-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(tmp, { recursive: true });
  line(`${C.dim}  → cloning ${args.repo} (branch ${args.branch}) → ${tmp}${C.reset}`);
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

  // git is only needed when we must clone (no bundled payload and not --local)
  const pkgAgent = path.join(path.resolve(__dirname, ".."), "agent");
  const haveSource = fs.existsSync(path.join(pkgAgent, "extensions")) && fs.existsSync(path.join(pkgAgent, "AGENTS.md"));
  if (!have("git") && !haveSource && !args.local) { line(`${C.red}  ✖ git not found — required to fetch config${C.reset}`); process.exit(1); }

  // ── [1/4] pi ──
  if (args.skipPi) {
    line(` ${C.green}✔${C.reset} ${C.dim}[1/4]${C.reset} Install pi ${C.dim}— skipped${C.reset}`);
  } else {
    const label = have("pi") ? `updating pi (${PI_PACKAGE})` : `installing pi (${PI_PACKAGE})`;
    const code = await npmStep("1", label, ["install", "-g", `${PI_PACKAGE}@latest`, "--no-audit", "--no-fund", "--min-release-age=0"]);
    if (code === 0) {
      line(` ${C.green}✔${C.reset} ${C.dim}[1/4]${C.reset} ${label} ${C.dim}— ${cmdOut("pi", ["--version"]) || "?"}${C.reset}`);
    } else {
      line(` ${C.red}✖${C.reset} ${C.dim}[1/4]${C.reset} ${label} ${C.red}failed (exit ${code})${C.reset}  ${C.dim}see ${tmpLog}${C.reset}`);
      ok = false;
    }
  }
  // ── [2/4] pi packages ──
  if (args.skipPackages) {
    line(` ${C.green}✔${C.reset} ${C.dim}[2/4]${C.reset} pi packages ${C.dim}— skipped${C.reset}`);
  } else {
    const label = "installing pi-context-usage + @baretread/pi-forge";
    const code = await npmStep("2", label, ["install", "-g", ...PACKAGES, "--no-audit", "--no-fund"]);
    if (code === 0) line(` ${C.green}✔${C.reset} ${C.dim}[2/4]${C.reset} pi packages ${C.dim}— done${C.reset}`);
    else {
      line(` ${C.yellow}⚠${C.reset} ${C.dim}[2/4]${C.reset} ${label} ${C.yellow}exit ${code} — continuing (pi will auto-install)${C.reset}`);
      line(`    ${C.dim}see ${tmpLog}${C.reset}`);
    }
  }
  // ── [3/4] custom config ──
  try {
    const sourceRoot = resolveSourceRoot(args);
    line(`${C.dim}  source  ${sourceRoot}${C.reset}`);
    fs.mkdirSync(targetDir, { recursive: true });

    if (fs.existsSync(path.join(targetDir, "AGENTS.md")) || fs.existsSync(path.join(targetDir, "extensions"))) {
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const bak = `${targetDir}.bak.${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      line(`${C.dim}  backup  ${targetDir}/extensions → ${bak}${C.reset}`);
      fs.mkdirSync(bak, { recursive: true });
      for (const f of ["AGENTS.md", "keybindings.json", "README.md"]) {
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
    }

    let copied = 0;
    const selfInstall = path.resolve(sourceRoot) === path.resolve(targetDir);
    if (selfInstall) line(`${C.dim}  source == target — skipping file copy (self-install)${C.reset}`);
    for (const f of ["AGENTS.md", "keybindings.json", "README.md"]) {
      if (!fs.existsSync(path.join(sourceRoot, f))) continue;
      if (!selfInstall) fs.copyFileSync(path.join(sourceRoot, f), path.join(targetDir, f));
      copied++;
    }
    let freshSettings = false;
    if (!fs.existsSync(path.join(targetDir, "settings.json")) && fs.existsSync(path.join(sourceRoot, "settings.json"))) {
      fs.copyFileSync(path.join(sourceRoot, "settings.json"), path.join(targetDir, "settings.json"));
      line(`${C.dim}  created settings.json from repo defaults${C.reset}`);
      freshSettings = true;
    } else if (fs.existsSync(path.join(targetDir, "settings.json"))) {
      line(`${C.dim}  kept existing settings.json${C.reset}`);
    }
    if (freshSettings) {
      try {
        const p = path.join(targetDir, "settings.json");
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        j.packages = j.packages || [];
        let changed = false;
        for (const pkg of SETTINGS_PACKAGES) if (!j.packages.includes(pkg)) { j.packages.push(pkg); changed = true; }
        if (changed) { fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); line("  patched settings.json packages → forge + context"); }
      } catch {}
    }
    for (const t of ["taste.md", "taste", "taste.json"]) {
      const tp = path.join(targetDir, t);
      if (fs.existsSync(tp)) line(`${C.dim}  kept existing ${t}${C.reset}`);
      else if (fs.existsSync(path.join(sourceRoot, t))) {
        const s = path.join(sourceRoot, t);
        if (fs.statSync(s).isDirectory()) copyTree(s, tp, new Set());
        else fs.copyFileSync(s, tp);
      }
    }

    if (fs.existsSync(path.join(sourceRoot, "extensions"))) {
      fs.mkdirSync(path.join(targetDir, "extensions"), { recursive: true });
      for (const e of fs.readdirSync(path.join(sourceRoot, "extensions"), { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.endsWith(".md")) continue;
        if (copyTree(path.join(sourceRoot, "extensions", e.name), path.join(targetDir, "extensions", e.name))) copied++;
        else line(`${C.yellow}  ⚠ copy extensions/${e.name} failed${C.reset}`);
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

    line(` ${C.green}✔${C.reset} ${C.dim}[3/4]${C.reset} custom config ${C.dim}— ${copied} items → ${targetDir}${C.reset}`);
    if (clonedTmp) { fs.rmSync(clonedTmp, { recursive: true, force: true }); clonedTmp = ""; }
    const repoReadme = path.resolve(sourceRoot, "..", "README.md");
    const parentReadme = path.resolve(targetDir, "..", "README.md");
    if (repoReadme !== parentReadme && fs.existsSync(repoReadme)) {
      try { fs.copyFileSync(repoReadme, parentReadme); } catch {}
    }
  } catch (e) {
    line(` ${C.red}✖${C.reset} ${C.dim}[3/4]${C.reset} custom config ${C.red}failed:${C.reset} ${e.message}`);
    ok = false;
  }
  // ── [4/4] per-extension deps ──
  const extRoot = path.join(targetDir, "extensions");
  if (!fs.existsSync(extRoot)) {
    line(` ${C.yellow}⚠${C.reset} ${C.dim}[4/4]${C.reset} no extensions found at ${extRoot}`);
  } else {
    const failed = [];
    let installed = 0;
    for (const e of fs.readdirSync(extRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.endsWith(".md")) continue;
      const dir = path.join(extRoot, e.name), label = `extensions/${e.name}`;
      const hasPkg = fs.existsSync(path.join(dir, "package.json"));
      const sh = path.join(dir, "install.sh"), ps1 = path.join(dir, "install.ps1");
      let code;
      if (process.platform === "win32" && fs.existsSync(ps1)) {
        const shell = have("pwsh") ? "pwsh" : "powershell";
        code = await runStep("4", label, shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
      } else if (process.platform !== "win32" && fs.existsSync(sh)) {
        code = await runStep("4", label, "sh", [sh]);
      } else if (hasPkg) {
        const a = ["--prefix", dir, fs.existsSync(path.join(dir, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"];
        code = await npmStep("4", label, a);
      } else {
        line(` ${C.dim}  · ${label} — no package.json, skipping${C.reset}`);
        continue;
      }
      if (code === 0) { line(` ${C.green}✔${C.reset} ${C.dim}[4/4]${C.reset} ${label}`); installed++; }
      else { line(` ${C.red}✖${C.reset} ${C.dim}[4/4]${C.reset} ${label} ${C.red}failed (exit ${code})${C.reset}`); failed.push(e.name); }
    }
    if (!failed.length) line(` ${C.green}✔${C.reset} ${C.dim}[4/4]${C.reset} extension deps ${C.dim}— ${installed} installed${C.reset}`);
    else line(` ${C.yellow}⚠${C.reset} ${C.dim}[4/4]${C.reset} extension deps ${C.yellow}${failed.length} failed:${C.reset} ${failed.join(", ")}  ${C.dim}see ${tmpLog}${C.reset}`);
  }

  // ── summary ──
  const secs = Math.round((Date.now() - startTime) / 1000);
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  line("");
  if (ok) {
    line(`${C.green}${C.bold}  ✓ Setup complete${C.reset}  ${C.dim}→ ${targetDir} · Kiln installed in ${elapsed}${C.reset}`);
    const pv = cmdOut("pi", ["--version"]);
    if (pv) line(`${C.dim}  pi ${pv}  ·  run: pi${C.reset}`);
  } else {
    line(`${C.yellow}${C.bold}  ⚠ Setup finished with warnings${C.reset}  ${C.dim}in ${elapsed} · see ${tmpLog}${C.reset}`);
  }
  line(`${C.dim}  log: ${tmpLog}${C.reset}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(`\n  ✖ ${e.message}`); process.exit(1); });
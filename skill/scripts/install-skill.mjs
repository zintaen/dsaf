#!/usr/bin/env node
/**
 * DSAF — Zero-Clone Agent Skill Installer (`dsaf install-skill`).
 * Copies ONLY Tier 1 production skill files (`SKILL.md`, `references/`,
 * `resources/`, `scripts/`) into Claude Code, Cursor, Codex, Antigravity,
 * generic `.agents`, or a custom target directory without external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertPathWithinRoot } from "./ci-report.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = resolve(SCRIPT_DIR, "..");

const USER_AGENT_ROOTS = {
  claude: [".claude", "skills", "dsaf"],
  cursor: [".cursor", "skills", "dsaf"],
  codex: [".codex", "skills", "dsaf"],
  antigravity: [".gemini", "config", "skills", "dsaf"],
  agents: [".agents", "skills", "dsaf"],
};

const PROJECT_AGENT_ROOTS = {
  claude: [".claude", "skills", "dsaf"],
  cursor: [".cursor", "skills", "dsaf"],
  codex: [".codex", "skills", "dsaf"],
  antigravity: [".agent", "skills", "dsaf"],
  agents: [".agents", "skills", "dsaf"],
};

const TIER1_ITEMS = ["SKILL.md", "references", "resources", "scripts"];

function shouldCopyEntry(srcPath) {
  const base = String(srcPath || "").split(/[/\\]+/).filter(Boolean).pop() || "";
  return base !== ".DS_Store" && base !== "__pycache__" && base !== "node_modules";
}

function resolveTargets({ agent = "all", scope = "user", dir, cwd = process.cwd(), home = homedir() }) {
  const normScope = typeof scope === "string" ? scope.trim().toLowerCase() : scope;
  if (normScope !== "user" && normScope !== "project") {
    throw new Error(`Unsupported --scope '${scope}'. Expected 'user' or 'project'.`);
  }
  const roots = normScope === "user" ? USER_AGENT_ROOTS : PROJECT_AGENT_ROOTS;
  const parsedRequested = String(agent || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const key of parsedRequested) {
    if (key !== "all" && !Object.hasOwn(roots, key)) {
      throw new Error(`Unknown --agent '${key}'. Supported: ${Object.keys(roots).join(", ")}, all`);
    }
  }
  const requested = parsedRequested.includes("all") ? Object.keys(roots) : parsedRequested;
  if (requested.length === 0) {
    throw new Error("No valid agent selected. Pass --agent claude|cursor|codex|antigravity|agents|all.");
  }
  if (dir !== undefined) {
    if (typeof dir !== "string" || dir.trim().length === 0) {
      throw new Error("Parameter '--dir' must be a non-empty path.");
    }
    return [{ agent: "custom", scope: "custom", path: resolve(dir.trim()) }];
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0)) {
    throw new Error("Parameter '--cwd' must be a non-empty path.");
  }
  const base = normScope === "user" ? resolve(home) : resolve(cwd);
  const seen = new Set();
  const out = [];
  for (const key of requested) {
    if (!Object.hasOwn(roots, key)) {
      throw new Error(`Unknown --agent '${key}'. Supported: ${Object.keys(roots).join(", ")}, all`);
    }
    const dest = join(base, ...roots[key]);
    if (seen.has(dest)) continue;
    seen.add(dest);
    out.push({ agent: key, scope: normScope, path: dest });
  }
  return out;
}

function normForCompare(p) {
  return process.platform === "darwin" || process.platform === "win32" ? String(p).toLowerCase() : String(p);
}

function getDevIno(p) {
  try {
    const st = statSync(p);
    return st.ino ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}

function resolveCanonPath(p) {
  const abs = resolve(p);
  const missing = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    missing.unshift(basename(cur));
    cur = parent;
  }
  try {
    const realBase = typeof realpathSync.native === "function" ? realpathSync.native(cur) : realpathSync(cur);
    return join(realBase, ...missing);
  } catch {
    return abs;
  }
}

function isSameOrWithin(outerPath, innerPath) {
  const rel = relative(normForCompare(outerPath), normForCompare(innerPath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateInstallTarget(destPath, projectRoot = null) {
  const dest = resolve(destPath);
  if (dirname(dest) === dest) {
    throw new Error(`Refusing to overwrite filesystem root directory: ${dest}`);
  }
  const srcRoot = resolve(SKILL_SRC);
  const canonDest = resolveCanonPath(dest);
  const canonSrc = resolveCanonPath(srcRoot);
  if (normForCompare(canonDest) === normForCompare(canonSrc) || isSameOrWithin(canonDest, canonSrc)) {
    throw new Error(`Refusing to overwrite source skill directory or its ancestor: ${dest}`);
  }
  if (isSameOrWithin(canonSrc, canonDest)) {
    throw new Error(`Refusing to install inside source skill directory: ${dest}`);
  }
  // Inode guard catches case-insensitive mount points regardless of path casing
  const srcInodes = new Set();
  const srcSelfId = getDevIno(srcRoot);
  let anc = srcRoot;
  while (true) {
    const id = getDevIno(anc);
    if (id) srcInodes.add(id);
    const parent = dirname(anc);
    if (parent === anc) break;
    anc = parent;
  }
  const destId = getDevIno(dest);
  if (destId && srcInodes.has(destId)) {
    throw new Error(`Refusing to overwrite source skill directory or its ancestor: ${dest}`);
  }
  if (srcSelfId) {
    let probe = dest;
    while (true) {
      const pid = getDevIno(probe);
      if (pid && pid === srcSelfId) {
        throw new Error(`Refusing to install inside source skill directory: ${dest}`);
      }
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  let ancDir = dirname(dest);
  while (true) {
    let aLst = null;
    try {
      aLst = lstatSync(ancDir);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    if (aLst) {
      if (aLst.isSymbolicLink() && (!existsSync(ancDir) || !statSync(ancDir).isDirectory())) {
        throw new Error(`Refusing broken or non-directory ancestor in install path: ${ancDir}`);
      }
      if (!aLst.isSymbolicLink() && !aLst.isDirectory()) {
        throw new Error(`Refusing non-directory ancestor in install path: ${ancDir}`);
      }
    }
    const parent = dirname(ancDir);
    if (parent === ancDir) break;
    ancDir = parent;
  }
  try {
    const lst = lstatSync(dest);
    if (!lst.isDirectory() && !lst.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite existing non-directory file: ${dest}`);
    }
    if (lst.isSymbolicLink() && (!existsSync(dest) || !statSync(dest).isDirectory())) {
      throw new Error(`Refusing broken or non-directory symlink target: ${dest}`);
    }
  } catch (err) {
    if (err?.code === "ENOTDIR") {
      throw new Error(`Refusing non-directory ancestor in install path: ${dirname(dest)}`);
    }
    if (err?.code !== "ENOENT") throw err;
  }
  if (projectRoot) {
    assertPathWithinRoot(projectRoot, dest, dest, { allowEqual: false });
  }
  for (const rel of TIER1_ITEMS) {
    if (!existsSync(join(srcRoot, rel))) {
      throw new Error(`Missing required skill payload entry: ${rel}`);
    }
  }
  return dest;
}

function installSkillTo(destPath, { dryRun = false, projectRoot = null } = {}) {
  const dest = validateInstallTarget(destPath, projectRoot);
  const srcRoot = resolve(SKILL_SRC);
  if (!dryRun) {
    const parentDir = dirname(dest);
    mkdirSync(parentDir, { recursive: true });
    const stage = mkdtempSync(join(parentDir, ".dsaf-skill-stage-"));
    let backup = null;
    let movedOld = false;
    try {
      for (const rel of TIER1_ITEMS) {
        cpSync(join(srcRoot, rel), join(stage, rel), {
          recursive: true,
          filter: (p) => shouldCopyEntry(p),
        });
      }
      let destExists = false;
      try {
        lstatSync(dest);
        destExists = true;
      } catch {}
      if (destExists) {
        backup = join(parentDir, `.dsaf-skill-bak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        renameSync(dest, backup);
        movedOld = true;
      }
      renameSync(stage, dest);
      if (backup) {
        rmSync(backup, { recursive: true, force: true });
      }
    } catch (err) {
      if (movedOld && backup) {
        try {
          lstatSync(dest);
        } catch {
          try {
            renameSync(backup, dest);
          } catch {}
        }
      }
      throw err;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return {
    path: dest,
    installedItems: [...TIER1_ITEMS],
    dryRun,
  };
}

function installSkills(opts = {}) {
  const targets = resolveTargets(opts);
  const projectRoot = targets.some((t) => t.scope === "project") ? resolve(opts.cwd ?? process.cwd()) : null;
  for (const t of targets) {
    validateInstallTarget(t.path, t.scope === "project" ? projectRoot : null);
  }
  const results = [];
  for (const t of targets) {
    const installed = installSkillTo(t.path, {
      dryRun: Boolean(opts.dryRun),
      projectRoot: t.scope === "project" ? projectRoot : null,
    });
    results.push({ agent: t.agent, scope: t.scope, ...installed });
  }
  return results;
}

function printUsage() {
  console.log("Usage: dsaf install-skill [--agent claude|cursor|codex|antigravity|agents|all] [--scope user|project] [--cwd <dir>] [--dir <path>] [--dry-run] [--json] [--self-test] [--help]");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-install-skill-"));
  try {
    const dryResults = installSkills({ agent: "claude", scope: "project", cwd: scratch, dryRun: true });
    assert.equal(dryResults.length, 1);
    assert.equal(dryResults[0].dryRun, true);
    assert.ok(!existsSync(dryResults[0].path), "dry-run must not write files");

    const projResults = installSkills({ agent: "claude", scope: "project", cwd: scratch });
    assert.equal(projResults.length, 1);
    const claudeDir = join(scratch, ".claude", "skills", "dsaf");
    assert.equal(projResults[0].path, resolve(claudeDir));
    assert.ok(existsSync(join(claudeDir, "SKILL.md")));
    assert.ok(existsSync(join(claudeDir, "scripts", "recon.mjs")));
    assert.ok(existsSync(join(claudeDir, "resources", "preview-shell.html")));

    // Top-level entries must strictly match production Tier 1 payload
    const topEntries = readdirSync(claudeDir).sort();
    assert.deepEqual(topEntries, [...TIER1_ITEMS].sort());

    const customDir = join(scratch, "custom-agent", "dsaf");
    const customResults = installSkills({ dir: customDir });
    assert.equal(customResults.length, 1);
    assert.ok(existsSync(join(customDir, "SKILL.md")));

    const allProj = resolveTargets({ agent: "all", scope: "project", cwd: scratch });
    assert.equal(allProj.length, 5);
    assert.equal(resolveTargets({ agent: "claude,ALL", scope: "project", cwd: scratch }).length, 5);
    assert.equal(shouldCopyEntry("C:\\repo\\node_modules"), false, "Must filter Windows backslash paths");
    assert.equal(shouldCopyEntry("C:\\repo\\SKILL.md"), true);
    assert.throws(() => installSkillTo(resolve(SKILL_SRC, "..")), /ancestor/, "Must refuse parent/ancestor of SKILL_SRC");
    assert.throws(() => installSkillTo(join(SKILL_SRC, "scripts")), /inside source/, "Must refuse subdirectories inside SKILL_SRC");
    assert.throws(() => installSkillTo(join(SKILL_SRC, "scripts", "nested-tmp")), /inside source/, "Must refuse deep nested subdirectories inside SKILL_SRC");
    assert.throws(() => resolveTargets({ agent: "typo,all", scope: "project", cwd: scratch }), /Unknown --agent 'typo'/);
    assert.throws(() => resolveTargets({ agent: "constructor", scope: "project", cwd: scratch }), /Unknown --agent 'constructor'/);

    const r4Pre = join(scratch, "r4-prevalidate");
    mkdirSync(join(r4Pre, ".cursor/skills"), { recursive: true });
    symlinkSync(SKILL_SRC, join(r4Pre, ".cursor/skills/dsaf"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => installSkills({ agent: "all", scope: "project", cwd: r4Pre }), /Refusing to overwrite source skill directory/);
    assert.equal(existsSync(join(r4Pre, ".claude")), false, "--agent all must pre-validate all targets before touching disk");

    if (process.platform === "darwin" || process.platform === "win32") {
      const upperSkill = join(dirname(SKILL_SRC), basename(SKILL_SRC).toUpperCase());
      assert.throws(() => installSkillTo(upperSkill), /source skill directory/, "Case-variant SKILL_SRC must be refused");
      assert.throws(() => installSkillTo(join(upperSkill, "scripts")), /inside source/, "Case-variant nested path must be refused");
      const upperAnc = join(dirname(dirname(SKILL_SRC)), basename(dirname(SKILL_SRC)).toUpperCase());
      assert.throws(() => installSkillTo(upperAnc), /ancestor/, "Case-variant ancestor of SKILL_SRC must be refused");
    }

    // Round 15 regressions (R15-A1-01, R15-A1-02): refuse non-directory target file & reject empty/whitespace --dir/--cwd
    const r15ExistingFile = join(scratch, "do-not-delete.txt");
    writeFileSync(r15ExistingFile, "precious user content\n", "utf8");
    assert.throws(() => installSkillTo(r15ExistingFile), /Refusing to overwrite existing non-directory file/);
    assert.equal(readFileSync(r15ExistingFile, "utf8"), "precious user content\n", "Refused regular file target must remain intact");
    assert.throws(() => resolveTargets({ dir: "" }), /--dir.*non-empty/);
    assert.throws(() => resolveTargets({ dir: "   " }), /--dir.*non-empty/);
    assert.throws(() => resolveTargets({ scope: "project", cwd: "" }), /--cwd.*non-empty/);
    assert.throws(() => resolveTargets({ scope: "project", cwd: "   " }), /--cwd.*non-empty/);
    const selfScript = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [selfScript, "--dir", "", "--dry-run"], { cwd: scratch, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [selfScript, "--scope", "project", "--cwd", "", "--dry-run"], { cwd: scratch, encoding: "utf8" }).status, 2);

    // Round 18 regression (R18-A1-10): broken symlink ancestor .cursor -> /missing rejects BEFORE installing earlier agents
    const r18BrokenProj = join(scratch, "r18-broken-proj");
    mkdirSync(r18BrokenProj, { recursive: true });
    symlinkSync(join(scratch, "missing-cursor"), join(r18BrokenProj, ".cursor"));
    assert.throws(
      () => installSkills({ agent: "all", scope: "project", cwd: r18BrokenProj }),
      /broken or non-directory ancestor/
    );
    assert.equal(existsSync(join(r18BrokenProj, ".claude")), false, "Broken .cursor symlink must abort before writing .claude");

    // Round 22 regression (R22-A1-04): regular file blocking multi-level ancestor (.claude or --dir <file>/sub/dsaf) throws contextual error instead of ENOTDIR
    const r22BlockedProj = join(scratch, "r22-blocked-proj");
    mkdirSync(r22BlockedProj, { recursive: true });
    writeFileSync(join(r22BlockedProj, ".claude"), "file blocking .claude/skills/dsaf\n");
    assert.throws(
      () => installSkills({ agent: "claude", scope: "project", cwd: r22BlockedProj }),
      /non-directory ancestor/
    );
    const r22BlockingFile = join(scratch, "r22-blocking-file");
    writeFileSync(r22BlockingFile, "blocking file\n");
    assert.throws(
      () => installSkills({ agent: "claude", dir: join(r22BlockingFile, "sub", "dsaf") }),
      /non-directory ancestor/
    );
    // Round 24 (A1 HIGH-2 & A4 M9): project-scope symlink escape via .claude -> outside fails before mutating external dirs; case-normalized --scope
    const r24EscProj = join(scratch, "r24-esc-proj");
    const r24ExtDir = join(scratch, "r24-ext-dir");
    mkdirSync(r24EscProj, { recursive: true });
    mkdirSync(join(r24ExtDir, "skills/dsaf"), { recursive: true });
    writeFileSync(join(r24ExtDir, "skills/dsaf/PRECIOUS.txt"), "keep\n");
    symlinkSync(r24ExtDir, join(r24EscProj, ".claude"));
    assert.throws(
      () => installSkills({ agent: "claude", scope: "project", cwd: r24EscProj, dryRun: false }),
      /escapes/i
    );
    assert.equal(readFileSync(join(r24ExtDir, "skills/dsaf/PRECIOUS.txt"), "utf8"), "keep\n");
    assert.equal(resolveTargets({ agent: "claude", scope: "PROJECT", cwd: scratch })[0].scope, "project");
    for (const badCli of [
      ["--dir", scratch, "--scope", "bogus", "--agent", "bogus", "--dry-run"],
    ]) {
      assert.equal(spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...badCli], { encoding: "utf8" }).status, 2);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("INSTALL_SKILL_SELF_TEST_PASSED (user/project scopes + --dir + dry-run + Tier 1 isolation)");
  return 0;
}

function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      agent: { type: "string", default: "all" },
      scope: { type: "string", default: "user" },
      dir: { type: "string" },
      cwd: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const results = installSkills({
    agent: values.agent,
    scope: values.scope,
    dir: values.dir,
    cwd: values.cwd !== undefined ? values.cwd : process.cwd(),
    dryRun: values["dry-run"],
  });

  if (values.json) {
    process.stdout.write(JSON.stringify({ schema: "dsaf-install-skill/1", results }, null, 2) + "\n");
  } else {
    for (const r of results) {
      console.log(`${r.dryRun ? "[DRY-RUN] " : ""}Installed dsaf skill (${r.agent}/${r.scope}) -> ${r.path}`);
    }
    console.log("DSAF_SKILL_INSTALL_COMPLETE");
  }
}

function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const isEntry = Boolean(process.argv[1]) && canonPath(process.argv[1]) === canonPath(fileURLToPath(import.meta.url));
if (isEntry) {
  try {
    main();
  } catch (err) {
    console.error("ERROR:", err.message || err);
    process.exit(2);
  }
}
export { installSkills, resolveTargets };

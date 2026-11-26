#!/usr/bin/env node
/**
 * DSAF — Zero-Clone Agent Skill Installer (`dsaf install-skill`).
 * Copies ONLY Tier 1 production skill files (`SKILL.md`, `references/`,
 * `resources/`, `scripts/`) into Claude Code, Cursor, Codex, Antigravity,
 * generic `.agents`, or a custom target directory without external dependencies.
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
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
  const base = srcPath.split("/").pop() || "";
  return base !== ".DS_Store" && base !== "__pycache__" && base !== "node_modules";
}

function resolveTargets({ agent = "all", scope = "user", dir, cwd = process.cwd(), home = homedir() }) {
  if (dir) {
    return [{ agent: "custom", scope: "custom", path: resolve(dir) }];
  }
  if (scope !== "user" && scope !== "project") {
    throw new Error(`Unsupported --scope '${scope}'. Expected 'user' or 'project'.`);
  }
  const roots = scope === "user" ? USER_AGENT_ROOTS : PROJECT_AGENT_ROOTS;
  const base = scope === "user" ? resolve(home) : resolve(cwd);
  const requested = agent === "all" ? Object.keys(roots) : String(agent).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) {
    throw new Error("No valid agent selected. Pass --agent claude|cursor|codex|antigravity|agents|all.");
  }
  const seen = new Set();
  const out = [];
  for (const key of requested) {
    if (!roots[key]) {
      throw new Error(`Unknown --agent '${key}'. Supported: ${Object.keys(roots).join(", ")}, all`);
    }
    const dest = join(base, ...roots[key]);
    if (seen.has(dest)) continue;
    seen.add(dest);
    out.push({ agent: key, scope, path: dest });
  }
  return out;
}

function installSkillTo(destPath, { dryRun = false } = {}) {
  const dest = resolve(destPath);
  if (dest === resolve(SKILL_SRC)) {
    throw new Error(`Refusing to overwrite source skill directory itself: ${dest}`);
  }
  if (!dryRun) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const rel of TIER1_ITEMS) {
      const src = join(SKILL_SRC, rel);
      if (!existsSync(src)) {
        throw new Error(`Missing required skill payload entry: ${rel}`);
      }
      cpSync(src, join(dest, rel), {
        recursive: true,
        filter: (p) => shouldCopyEntry(p),
      });
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
  const results = [];
  for (const t of targets) {
    const installed = installSkillTo(t.path, { dryRun: Boolean(opts.dryRun) });
    results.push({ agent: t.agent, scope: t.scope, ...installed });
  }
  return results;
}

function printUsage() {
  console.log("Usage: dsaf install-skill [--agent claude|cursor|codex|antigravity|agents|all] [--scope user|project] [--cwd <dir>] [--dir <path>] [--dry-run] [--json]");
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("INSTALL_SKILL_SELF_TEST_PASSED (user/project scopes + --dir + dry-run + Tier 1 isolation)");
  return 0;
}

function main() {
  const { values } = parseArgs({
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
    cwd: values.cwd || process.cwd(),
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

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) {
  try {
    main();
  } catch (err) {
    console.error("ERROR:", err.message || err);
    process.exit(1);
  }
}
export { installSkills, resolveTargets };

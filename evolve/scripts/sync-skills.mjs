#!/usr/bin/env node
/**
 * DSAF v0.2.2 — Clean Validation & Multi-Agent Skill Sync Script (Node ESM).
 * Validates isolation & parity, removes OS metadata clutter, and syncs `skill/` (`dsaf`)
 * + `evolve/` (`dsaf-evolve`) into Antigravity / generic agent skill directories.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const TIER1_SRC = join(REPO_ROOT, "skill");
const TIER2_SRC = join(REPO_ROOT, "evolve");

function cleanJunk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.name === ".DS_Store" || e.name === "__pycache__") {
      rmSync(full, { recursive: true, force: true });
    } else if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") {
      cleanJunk(full);
    }
  }
}

function forceSymlink(target, linkPath) {
  try {
    const st = lstatSync(linkPath);
    if (st) rmSync(linkPath, { recursive: true, force: true });
  } catch {}
  symlinkSync(target, linkPath);
}

function main() {
  const { values } = parseArgs({
    options: {
      "install-local": { type: "boolean", default: false },
      "prune-legacy": { type: "boolean", default: false },
      "zip-out": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: node evolve/scripts/sync-skills.mjs [--install-local] [--prune-legacy] [--zip-out <dir>]");
    process.exit(0);
  }

  console.log("==> Cleaning OS metadata clutter...");
  cleanJunk(REPO_ROOT);

  console.log("==> Running full isolation & deterministic self-tests...");
  const check = spawnSync(process.execPath, [join(SCRIPT_DIR, "validate-isolation.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (check.status !== 0) process.exit(check.status || 1);

  if (values["install-local"]) {
    const home = homedir();
    const copyRoots = [join(home, ".gemini/config/skills"), join(home, ".agents/skills")];
    for (const root of copyRoots) {
      mkdirSync(root, { recursive: true });
      for (const [src, name] of [
        [TIER1_SRC, "dsaf"],
        [TIER2_SRC, "dsaf-evolve"],
      ]) {
        const dest = join(root, name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true });
      }
      if (values["prune-legacy"]) {
        rmSync(join(root, "ux-ui-audit"), { recursive: true, force: true });
        rmSync(join(root, "ux-ui-audit-evolve"), { recursive: true, force: true });
      }
    }

    for (const linkRoot of [join(home, ".claude/skills"), join(home, ".codex/skills")]) {
      if (!existsSync(linkRoot)) continue;
      forceSymlink("../../.agents/skills/dsaf", join(linkRoot, "dsaf"));
      forceSymlink("../../.agents/skills/dsaf-evolve", join(linkRoot, "dsaf-evolve"));
      if (values["prune-legacy"]) {
        rmSync(join(linkRoot, "ux-ui-audit"), { recursive: true, force: true });
        rmSync(join(linkRoot, "ux-ui-audit-evolve"), { recursive: true, force: true });
      }
    }
    console.log("LOCAL_SKILLS_SYNCED (dsaf + dsaf-evolve -> ~/.gemini/config/skills, ~/.agents/skills, ~/.claude/skills, ~/.codex/skills)");
  }

  if (values["zip-out"]) {
    const outDir = resolve(values["zip-out"]);
    mkdirSync(outDir, { recursive: true });
    const zipFile = join(outDir, "dsaf-skill.zip");
    rmSync(zipFile, { force: true });
    const z = spawnSync("zip", ["-rq", zipFile, "skill", "-x", "*/.DS_Store"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (z.status !== 0) {
      console.error("ERROR: zip failed:", z.stderr);
      process.exit(1);
    }
    console.log(`ZIP_BUILT: ${zipFile}`);
  }

  console.log("DSAF_SYNC_COMPLETE");
}

main();

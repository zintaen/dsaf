#!/usr/bin/env node
/**
 * DSAF v0.0.1 — Full Repo Isolation, Integrity & Schema Validation Gate (Node ESM).
 * Verifies Tier 1 (`skill/`) integrity, Tier 2 (`evolve/`) isolation, example retro records,
 * schema enums, zero `.DS_Store`, and optional host `~/.gitconfig` SHA-256 preservation.
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const EVOLVE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(EVOLVE_DIR, "..");
const SKILL_DIR = join(REPO_ROOT, "skill");

const PRIVATE_LEAK_RE = /(?:^|[^a-z])(audit\.example-private|[A-Za-z0-9._%+-]+@(?!gmail\.com|example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;

function runNode(scriptPath, args = []) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  if (res.status !== 0) process.exit(res.status || 1);
}

function scanDisallowedOsFiles(dir) {
  const hits = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.name === ".DS_Store" || e.name === "__pycache__") hits.push(full);
    else if (e.isDirectory()) hits.push(...scanDisallowedOsFiles(full));
  }
  return hits;
}

function main() {
  console.log("==> [1/4] Verifying Tier 1 skill/ integrity & all deterministic self-tests...");
  runNode(join(SKILL_DIR, "scripts/check-integrity.mjs"));

  console.log("==> [2/4] Verifying Tier 2 evolve/ scripts & example retro records...");
  runNode(join(EVOLVE_DIR, "scripts/mine-signals.mjs"), ["--self-test"]);
  const sampleJsonl = join(EVOLVE_DIR, "fixtures/example-feedback.jsonl");
  if (existsSync(sampleJsonl)) {
    runNode(join(EVOLVE_DIR, "scripts/mine-signals.mjs"), ["--input", sampleJsonl, "--format", "json"]);
    console.log("  SAMPLE_FEEDBACK_VALIDATED (evolve/fixtures/example-feedback.jsonl)");
  }

  console.log("==> [3/4] Checking package metadata consistency, JSON schema & clean tree...");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (pkg.version !== "0.0.1") {
    console.error(`ERROR: package.json version must match 0.0.1, found ${pkg.version}`);
    process.exit(1);
  }
  const schema = JSON.parse(readFileSync(join(EVOLVE_DIR, "references/feedback-schema.json"), "utf8"));
  if (!schema.required?.includes("mode") || !schema.properties?.category?.enum?.includes("ds_drift_signal")) {
    console.error("ERROR: feedback-schema.json missing DSAF v0.0.1 fields/enums");
    process.exit(1);
  }
  const junk = scanDisallowedOsFiles(REPO_ROOT);
  if (junk.length > 0) {
    console.error(`ERROR: OS/cache junk present: ${junk.join(", ")}`);
    process.exit(1);
  }

  const expectedGitSha = process.env.EXPECTED_GITCONFIG_SHA;
  if (expectedGitSha) {
    const gitCfg = join(homedir(), ".gitconfig");
    if (existsSync(gitCfg)) {
      const actual = createHash("sha256").update(readFileSync(gitCfg)).digest("hex");
      if (actual !== expectedGitSha) {
        console.error(`ERROR: ~/.gitconfig SHA-256 drifted! expected=${expectedGitSha} actual=${actual}`);
        process.exit(1);
      }
      console.log(`==> [4/4] GITCONFIG_SHA_OK (${actual})`);
    }
  } else {
    console.log("==> [4/4] Repo hygiene & schema invariants verified.");
  }

  console.log("ALL_DSAF_ISOLATION_AND_INTEGRITY_CHECKS_PASSED");
}

main();

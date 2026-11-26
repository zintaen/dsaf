#!/usr/bin/env node
/**
 * DSAF v0.3.0 — Full Repo Isolation, Integrity & Schema Validation Gate (Node ESM).
 * Verifies Tier 1 (`skill/`) integrity, Tier 2 (`evolve/`) isolation, CLI parity,
 * example retro records, leak guards (`/Users/`, `file:///`, private terms), zero
 * `.DS_Store`, and optional host `~/.gitconfig` SHA-256 preservation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";

const SCRIPT_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const EVOLVE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(EVOLVE_DIR, "..");
const SKILL_DIR = join(REPO_ROOT, "skill");

const PRIVATE_LEAK_RE = /(?:^|[^a-z])(audit\.example-private|\/(?:Users|home)\/[A-Za-z0-9._-]+\/|file:\/\/\/[A-Za-z0-9._/-]+|[A-Za-z0-9._%+-]+@(?!gmail\.com|example\.com|users\.noreply)[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;
const EXTRA_TERMS = String(process.env.DSAF_PRIVATE_TERMS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TEXT_EXTS = new Set([".md", ".mjs", ".js", ".json", ".jsonl", ".yml", ".yaml", ".html", ".css"]);

function runNode(scriptPath, args = [], opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  if (!opts.quiet) {
    process.stdout.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
  }
  if (res.status !== 0) process.exit(res.status || 1);
  return res.stdout || "";
}

function scanRepoTexts(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".DS_Store") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) scanRepoTexts(full, out);
    else if (TEXT_EXTS.has(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
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
    const calDir = join(EVOLVE_DIR, "fixtures/calibration");
    const mineArgs = ["--input", sampleJsonl, "--format", "json"];
    if (existsSync(calDir)) mineArgs.push("--scores-dir", calDir);
    runNode(join(EVOLVE_DIR, "scripts/mine-signals.mjs"), mineArgs);
    console.log("  SAMPLE_FEEDBACK_VALIDATED (evolve/fixtures/example-feedback.jsonl)");
  }

  console.log("==> [3/4] Checking CLI entry, version parity, schema & public leak guards...");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    console.error(`ERROR: invalid semver in package.json: ${pkg.version}`);
    process.exit(1);
  }
  const cliPath = join(REPO_ROOT, "bin/dsaf.mjs");
  if (!existsSync(cliPath)) {
    console.error("ERROR: missing bin/dsaf.mjs");
    process.exit(1);
  }
  const cliVer = runNode(cliPath, ["version"], { quiet: true }).trim();
  if (!cliVer.includes(pkg.version)) {
    console.error(`ERROR: bin/dsaf.mjs version mismatch (${cliVer} vs ${pkg.version})`);
    process.exit(1);
  }

  const skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const evolveMd = readFileSync(join(EVOLVE_DIR, "SKILL.md"), "utf8");
  const scorecardSrc = readFileSync(join(SKILL_DIR, "scripts/compute-scorecard.mjs"), "utf8");
  const diffSrc = readFileSync(join(SKILL_DIR, "scripts/audit-diff.mjs"), "utf8");
  if (!skillMd.includes(`v${pkg.version}`)) {
    console.error(`ERROR: skill/SKILL.md must reference v${pkg.version}`);
    process.exit(1);
  }
  if (!evolveMd.includes(`v${pkg.version}`)) {
    console.error(`ERROR: evolve/SKILL.md must reference v${pkg.version}`);
    process.exit(1);
  }
  if (!scorecardSrc.includes(`ENGINE_VERSION = "${pkg.version}"`)) {
    console.error(`ERROR: compute-scorecard.mjs ENGINE_VERSION must match ${pkg.version}`);
    process.exit(1);
  }
  if (!diffSrc.includes(`engine_version: "${pkg.version}"`)) {
    console.error(`ERROR: audit-diff.mjs engine_version must match ${pkg.version}`);
    process.exit(1);
  }

  // Verify pinned .evolve/STRATEGY.md (auto-evolve-strategy v1.2.0) & zero npm tarball leak
  const pinnedStrategy = join(REPO_ROOT, ".evolve/STRATEGY.md");
  if (!existsSync(pinnedStrategy) || !existsSync(join(REPO_ROOT, ".evolve/rules.md")) || !existsSync(join(REPO_ROOT, ".evolve/handoff.md"))) {
    console.error("ERROR: missing .evolve/ governance files (STRATEGY.md / rules.md / handoff.md)");
    process.exit(1);
  }
  const pinnedText = readFileSync(pinnedStrategy, "utf8");
  if (!pinnedText.startsWith("# Auto-evolve strategy") || !/Version 1\.2\.0\.\s+Canonical source:.*zintaen\/auto-evolve-strategy/.test(pinnedText)) {
    console.error("ERROR: .evolve/STRATEGY.md must match pinned zintaen/auto-evolve-strategy Version 1.2.0 header");
    process.exit(1);
  }
  const pkgFiles = Array.isArray(pkg.files) ? pkg.files : [];
  if (pkgFiles.some((f) => /^\.?evolve\/?$/i.test(String(f).trim()))) {
    console.error("ERROR: package.json#files must never publish .evolve/ or evolve/");
    process.exit(1);
  }

  // Schema & script version contract checks
  const verMap = [
    ["scripts/audit-pipeline.mjs", `engine_version: "${pkg.version}"`],
    ["scripts/init-evolve.mjs", `INIT_VERSION = "${pkg.version}"`],
    ["scripts/evolve-runner.mjs", `EVOLVE_RUNNER_VERSION = "${pkg.version}"`],
    ["scripts/generate-personas.mjs", `PERSONAS_VERSION = "${pkg.version}"`],
    ["scripts/mcp-server.mjs", `MCP_SERVER_VERSION = "${pkg.version}"`],
    ["scripts/setup.mjs", `SETUP_VERSION = "${pkg.version}"`],
    ["scripts/generate-html-report.mjs", `HTML_REPORT_VERSION = "${pkg.version}"`],
    ["scripts/doctor.mjs", `DOCTOR_VERSION = "${pkg.version}"`],
    ["scripts/ci-report.mjs", `CI_REPORT_VERSION = "${pkg.version}"`],
    ["scripts/fix-floor.mjs", `FIX_VERSION = "${pkg.version}"`],
    ["scripts/generate-guardrails.mjs", `GENERATOR_VERSION = "${pkg.version}"`],
  ];
  for (const [rel, marker] of verMap) {
    if (!readFileSync(join(SKILL_DIR, rel), "utf8").includes(marker)) {
      console.error(`ERROR: skill/${rel} missing version contract '${marker}'`);
      process.exit(1);
    }
  }
  for (const [rel, schemaId] of [
    ["scripts/compute-scorecard.mjs", "dsaf-scores/2"],
    ["scripts/audit-pipeline.mjs", "dsaf-audit/1"],
    ["scripts/generate-personas.mjs", "dsaf-personas/1"],
    ["scripts/init-evolve.mjs", "dsaf-init-rules/1"],
    ["scripts/audit-runtime.mjs", "dsaf-runtime/2"],
    ["scripts/setup.mjs", "dsaf-setup/1"],
  ]) {
    if (!readFileSync(join(SKILL_DIR, rel), "utf8").includes(schemaId)) {
      console.error(`ERROR: skill/${rel} missing schema contract '${schemaId}'`);
      process.exit(1);
    }
  }

  const schema = JSON.parse(readFileSync(join(EVOLVE_DIR, "references/feedback-schema.json"), "utf8"));
  if (!schema.required?.includes("mode") || !schema.properties?.category?.enum?.includes("ds_drift_signal")) {
    console.error("ERROR: feedback-schema.json missing DSAF fields/enums");
    process.exit(1);
  }

  for (const file of scanRepoTexts(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, file);
    if (rel === "evolve/scripts/validate-isolation.mjs" || rel === "skill/scripts/check-integrity.mjs") continue;
    const text = readFileSync(file, "utf8");
    const m = PRIVATE_LEAK_RE.exec(text);
    if (m) {
      console.error(`ERROR: private/host path or URL leak '${m[0]}' in ${rel}`);
      process.exit(1);
    }
    for (const term of EXTRA_TERMS) {
      if (text.toLowerCase().includes(term.toLowerCase())) {
        console.error(`ERROR: forbidden private term '${term}' in ${rel}`);
        process.exit(1);
      }
    }
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
    console.log("==> [4/4] Repo hygiene, CLI, version parity & schema invariants verified.");
  }

  console.log("ALL_DSAF_ISOLATION_AND_INTEGRITY_CHECKS_PASSED");
}

main();

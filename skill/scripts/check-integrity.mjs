#!/usr/bin/env node
/**
 * DSAF v0.3.0 — Tier 1 Skill Integrity & Self-Test Runner.
 * Verifies required structure, YAML frontmatter, relative markdown links, Canonical
 * Preview Shell attributes, zero contamination in `skill/`, and all 8 CLI self-tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPathSafe());
const SKILL_DIR = resolve(SCRIPT_DIR, "..");

function fileURLToPathSafe() {
  return decodeURIComponent(new URL(import.meta.url).pathname);
}

const REQUIRED_FILES = [
  "SKILL.md",
  "references/step0-intake.md",
  "references/scoring-model.md",
  "references/mode-system.md",
  "references/mode-conformance.md",
  "references/mode-product-ux.md",
  "references/mode-product-ui.md",
  "references/preview-shell-contract.md",
  "references/retro-capture.md",
  "resources/preview-shell.html",
  "scripts/audit-pipeline.mjs",
  "scripts/recon.mjs",
  "scripts/audit-tokens.mjs",
  "scripts/audit-figma-diff.mjs",
  "scripts/audit-runtime.mjs",
  "scripts/compute-scorecard.mjs",
  "scripts/audit-diff.mjs",
  "scripts/generate-guardrails.mjs",
  "scripts/ci-report.mjs",
  "scripts/dsaf-hook.mjs",
  "scripts/check-integrity.mjs",
];

const CONTAM_RE = /(evolve\/|benchmark\.md|\/(Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z0-9._%+-]+@(?!example\.com|users\.noreply)[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;
const EXTRA_TERMS = String(process.env.DSAF_PRIVATE_TERMS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function listAllFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".DS_Store" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}

function checkLinks(mdFiles) {
  const errors = [];
  const linkRe = /\[[^\]]+\]\((\.[^)#\s]+(?:#[^)\s]*)?)\)/g;
  for (const file of mdFiles) {
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(linkRe)) {
      const targetRel = m[1].split("#")[0];
      const targetAbs = resolve(dirname(file), targetRel);
      if (!existsSync(targetAbs)) {
        errors.push(`${relative(SKILL_DIR, file)}: broken link target ${targetRel}`);
      }
    }
  }
  return errors;
}

function main() {
  console.log("==> [1/4] Checking required Tier 1 files & SKILL.md frontmatter...");
  for (const rel of REQUIRED_FILES) {
    const abs = join(SKILL_DIR, rel);
    if (!existsSync(abs)) {
      console.error(`ERROR: missing required file skill/${rel}`);
      process.exit(1);
    }
  }
  const skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  if (!/^---\s*\nname:\s*dsaf\b/m.test(skillMd)) {
    console.error("ERROR: skill/SKILL.md must declare YAML frontmatter 'name: dsaf'");
    process.exit(1);
  }

  console.log("==> [2/4] Checking markdown links & Canonical Preview Shell contract...");
  const files = listAllFiles(SKILL_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const linkErrors = checkLinks(mdFiles);
  if (linkErrors.length > 0) {
    console.error("ERROR: broken relative markdown links:\n" + linkErrors.join("\n"));
    process.exit(1);
  }

  const shellHtml = readFileSync(join(SKILL_DIR, "resources/preview-shell.html"), "utf8");
  for (const marker of ['data-ux-shell-toolbar="v3.0"', 'data-uxs-group="view"', 'data-uxs-group="viewport"', 'data-uxs-group="theme"', 'data-uxs-group="state"', 'data-uxs-group="pins"', "uxs-state-select"]) {
    if (!shellHtml.includes(marker)) {
      console.error(`ERROR: preview-shell.html missing canonical marker '${marker}'`);
      process.exit(1);
    }
  }

  console.log("==> [3/4] Checking ZERO private/org/evolve contamination inside skill/...");
  for (const file of files) {
    const rel = relative(SKILL_DIR, file);
    if (rel === "scripts/check-integrity.mjs") continue;
    const text = readFileSync(file, "utf8");
    const m = CONTAM_RE.exec(text);
    if (m) {
      console.error(`ERROR: contamination '${m[0]}' detected inside skill/${rel}`);
      process.exit(1);
    }
    for (const term of EXTRA_TERMS) {
      if (text.toLowerCase().includes(term.toLowerCase())) {
        console.error(`ERROR: private term '${term}' detected inside skill/${rel}`);
        process.exit(1);
      }
    }
  }

  console.log("==> [4/4] Running deterministic CLI --self-test suites...");
  for (const script of [
    "recon.mjs",
    "ci-report.mjs",
    "dsaf-hook.mjs",
    "audit-tokens.mjs",
    "audit-figma-diff.mjs",
    "audit-runtime.mjs",
    "compute-scorecard.mjs",
    "audit-diff.mjs",
    "generate-guardrails.mjs",
    "audit-pipeline.mjs",
  ]) {
    const res = spawnSync(process.execPath, [join(SCRIPT_DIR, script), "--self-test"], { encoding: "utf8" });
    process.stdout.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    if (res.status !== 0) {
      console.error(`ERROR: ${script} --self-test failed with exit ${res.status}`);
      process.exit(1);
    }
  }

  console.log("SKILL_INTEGRITY_ALL_PASSED (v0.4.0)");
}

main();

#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Tier 1 Skill Integrity & Self-Test Runner.
 * Verifies required structure, YAML frontmatter, relative markdown links, Canonical
 * Preview Shell attributes, zero contamination in `skill/`, and all CLI self-tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDirectCliEntry } from "./ci-report.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");

const REQUIRED_FILES = [
  "SKILL.md",
  "references/step0-intake.md",
  "references/scoring-model.md",
  "references/mode-system.md",
  "references/mode-conformance.md",
  "references/mode-product-ux.md",
  "references/mode-product-ui.md",
  "references/preview-shell-contract.md",
  "resources/preview-shell.html",
  "scripts/audit-pipeline.mjs",
  "scripts/setup.mjs",
  "scripts/update-check.mjs",
  "scripts/update.mjs",
  "scripts/generate-html-report.mjs",
  "scripts/generate-personas.mjs",
  "scripts/fix-floor.mjs",
  "scripts/mcp-server.mjs",
  "scripts/recon.mjs",
  "scripts/audit-tokens.mjs",
  "scripts/audit-figma-diff.mjs",
  "scripts/audit-runtime.mjs",
  "scripts/compute-scorecard.mjs",
  "scripts/audit-diff.mjs",
  "scripts/generate-guardrails.mjs",
  "scripts/ci-report.mjs",
  "scripts/dsaf-hook.mjs",
  "scripts/install-skill.mjs",
  "scripts/doctor.mjs",
  "scripts/check-integrity.mjs",
];

const CONTAM_RE = /((?<![A-Za-z0-9_-])\.?evolve\/|benchmark\.md|(?<![A-Za-z0-9_.-])(?<!https?:\/\/[^\s"'<>()[\]{},;\\|`]*)(?:\/|(?:[A-Za-z]:)?\\{1,2})(?:Users|home)(?:\/|\\{1,2})[A-Za-z0-9._-]+(?=$|[\s"'<>()[\]{},;`:\/\\])|(?:^|[^a-z])file:\/\/[A-Za-z0-9._:/\\-]+|[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9.-]*\.(?:png|jpe?g|webp|svg|gif|avif|tar|tgz|zip)(?![A-Za-z0-9-]|\.[A-Za-z0-9])))(?!example\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])|users\.noreply\.github\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9]))(?!v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next|canary|dev|pre|preview|nightly|insiders|snapshot|experimental)(?:[.-](?:alpha|beta|rc|\d+))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![A-Za-z0-9-]|\.[A-Za-z0-9]))[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;
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
  const linkRe = /\[[^\]]+\]\((?!https?:|mailto:|tel:|data:|#|\/)([^)#\s]+(?:#[^)\s]*)?)\)/gi;
  for (const file of mdFiles) {
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(linkRe)) {
      const targetRel = m[1].split("#")[0];
      if (!targetRel) continue;
      const targetAbs = resolve(dirname(file), targetRel);
      const relFromSkill = relative(SKILL_DIR, targetAbs);
      if (relFromSkill === ".." || relFromSkill.startsWith(`..${sep}`) || isAbsolute(relFromSkill)) {
        errors.push(`${relative(SKILL_DIR, file)}: link escapes skill/ directory -> ${targetRel}`);
        continue;
      }
      if (!existsSync(targetAbs)) {
        errors.push(`${relative(SKILL_DIR, file)}: broken link target ${targetRel}`);
      }
    }
  }
  return errors;
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (values.help) {
    console.log("Usage: node skill/scripts/check-integrity.mjs [--help]");
    process.exit(0);
  }
  if (positionals.length > 0) {
    console.error(`Error: unexpected argument '${positionals[0]}'.`);
    process.exit(2);
  }

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
    const rel = relative(SKILL_DIR, file).replace(/\\/g, "/");
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
    "generate-personas.mjs",
    "generate-html-report.mjs",
    "ci-report.mjs",
    "dsaf-hook.mjs",
    "fix-floor.mjs",
    "install-skill.mjs",
    "doctor.mjs",
    "audit-tokens.mjs",
    "audit-figma-diff.mjs",
    "audit-runtime.mjs",
    "compute-scorecard.mjs",
    "audit-diff.mjs",
    "generate-guardrails.mjs",
    "audit-pipeline.mjs",
    "mcp-server.mjs",
    "setup.mjs",
    "update-check.mjs",
    "update.mjs",
  ]) {
    const res = spawnSync(process.execPath, [join(SCRIPT_DIR, script), "--self-test"], { encoding: "utf8" });
    process.stdout.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    if (res.status !== 0) {
      console.error(`ERROR: ${script} --self-test failed with exit ${res.status}`);
      process.exit(1);
    }
  }

  const binCliPath = resolve(SKILL_DIR, "../bin/dsaf.mjs");
  if (existsSync(binCliPath)) {
    const pkgVer = JSON.parse(readFileSync(resolve(SKILL_DIR, "../package.json"), "utf8")).version;
    const vRes = spawnSync(process.execPath, [binCliPath, "version"], { encoding: "utf8" });
    if (vRes.status !== 0 || !(vRes.stdout || "").includes(`v${pkgVer}`)) {
      console.error(`ERROR: bin/dsaf.mjs version failed (status=${vRes.status}, out=${vRes.stdout})`);
      process.exit(1);
    }
    const hRes = spawnSync(process.execPath, [binCliPath, "help"], { encoding: "utf8" });
    if (hRes.status !== 0 || !(hRes.stdout || "").includes("Usage: dsaf")) {
      console.error(`ERROR: bin/dsaf.mjs help failed (status=${hRes.status})`);
      process.exit(1);
    }
    const badRes = spawnSync(process.execPath, [binCliPath, "version", "--bogus"], { encoding: "utf8" });
    if (badRes.status !== 2) {
      console.error(`ERROR: bin/dsaf.mjs version --bogus must exit 2 (got ${badRes.status})`);
      process.exit(1);
    }
  }

  console.log("SKILL_INTEGRITY_ALL_PASSED (v0.9.3)");
}

if (isDirectCliEntry(import.meta.url)) main();

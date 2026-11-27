#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Full Repo Isolation, Integrity & Schema Validation Gate (Node ESM).
 * Verifies Tier 1 (`skill/`) integrity, CLI parity, pack-whitelist isolation,
 * calibration fixtures, leak guards (`/Users/`, `file:///`, private terms), zero
 * `.DS_Store`, and optional host `~/.gitconfig` SHA-256 preservation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderHtmlReport } from "../skill/scripts/generate-html-report.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SKILL_DIR = join(REPO_ROOT, "skill");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

const PRIVATE_LEAK_RE = /(?:(?<![A-Za-z0-9_.-])(?<!https?:\/\/[^\s"'<>()[\]{},;\\|`]*)(?:\/|(?:[A-Za-z]:)?\\{1,2})(?:Users|home)(?:\/|\\{1,2})[A-Za-z0-9._-]+(?=$|[\s"'<>()[\]{},;`:\/\\])|(?:^|[^a-z])(?:audit\.example-private|file:\/\/[A-Za-z0-9._:/\\-]+|[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9.-]*\.(?:png|jpe?g|webp|svg|gif|avif|tar|tgz|zip)(?![A-Za-z0-9-]|\.[A-Za-z0-9])))(?!gmail\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])|example\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])|users\.noreply\.github\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9]))(?!v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next|canary|dev|pre|preview|nightly|insiders|snapshot|experimental)(?:[.-](?:alpha|beta|rc|\d+))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![A-Za-z0-9-]|\.[A-Za-z0-9]))[A-Za-z0-9.-]+\.[A-Za-z]{2,}))/i;
const STRICT_PKG_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXTRA_TERMS = String(process.env.DSAF_PRIVATE_TERMS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TEXT_EXTS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".jsx", ".json", ".jsonl", ".yml", ".yaml", ".html", ".css", ".svg", ".xml", ".txt"]);

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
    if (["node_modules", ".git", ".DS_Store", "audit-output", "dsaf-audit-output", "draft", "coverage", ".tmp", ".tmp-action-smoke"].includes(e.name)) {
      continue;
    }
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

function expandGlobBraces(pattern, maxExpansions = 64) {
  const results = [];
  const queue = [pattern];
  while (queue.length > 0) {
    const cur = queue.shift();
    let openIdx = -1;
    let closeIdx = -1;
    let depth = 0;
    let hasTopComma = false;
    const commas = [];
    for (let i = 0; i < cur.length; i++) {
      const ch = cur[i];
      if (ch === "\\" && i + 1 < cur.length) {
        i++;
        continue;
      }
      if (ch === "{") {
        if (i > 0 && cur[i - 1] === "$") return null;
        if (depth === 0 && openIdx === -1) openIdx = i;
        depth++;
      } else if (ch === "}") {
        if (depth === 0) return null;
        depth--;
        if (depth === 0 && openIdx !== -1) {
          closeIdx = i;
          break;
        }
      } else if (ch === "," && depth === 1 && openIdx !== -1) {
        hasTopComma = true;
        commas.push(i);
      }
    }
    if (depth !== 0) return null;
    if (openIdx === -1) {
      results.push(cur);
      if (results.length > maxExpansions) return null;
      continue;
    }
    const prefix = cur.slice(0, openIdx);
    const suffix = cur.slice(closeIdx + 1);
    const alts = [];
    if (hasTopComma) {
      let prev = openIdx + 1;
      for (const cIdx of commas) {
        alts.push(cur.slice(prev, cIdx));
        prev = cIdx + 1;
      }
      alts.push(cur.slice(prev, closeIdx));
    } else {
      const inner = cur.slice(openIdx + 1, closeIdx);
      if (inner.includes("..")) {
        const seqM = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(inner);
        if (!seqM) return null;
        const [, rawStart, rawEnd, rawStep] = seqM;
        const stepNum = rawStep !== undefined ? Number(rawStep) : 1;
        if (!Number.isInteger(stepNum) || stepNum === 0) return null;
        const isNumStart = /^-?\d+$/.test(rawStart);
        const isNumEnd = /^-?\d+$/.test(rawEnd);
        if (isNumStart !== isNumEnd) return null;
        if (
          isNumStart &&
          (/^-?0\d/.test(rawStart) || /^-?0\d/.test(rawEnd) || (rawStep !== undefined && /^-?0\d/.test(rawStep)))
        ) {
          return null;
        }
        if (!isNumStart) {
          const isUpStart = rawStart >= "A" && rawStart <= "Z";
          const isUpEnd = rawEnd >= "A" && rawEnd <= "Z";
          if (isUpStart !== isUpEnd) return null;
        }
        const startVal = isNumStart ? Number(rawStart) : rawStart.charCodeAt(0);
        const endVal = isNumEnd ? Number(rawEnd) : rawEnd.charCodeAt(0);
        const dir = startVal <= endVal ? 1 : -1;
        const effStep = dir * Math.abs(stepNum);
        for (let v = startVal; dir > 0 ? v <= endVal : v >= endVal; v += effStep) {
          alts.push(isNumStart ? String(v) : String.fromCharCode(v));
          if (results.length + queue.length + alts.length > maxExpansions) return null;
        }
      } else {
        return null;
      }
    }
    for (const alt of alts) {
      queue.push(`${prefix}${alt}${suffix}`);
      if (results.length + queue.length > maxExpansions) return null;
    }
  }
  return results;
}

function compileMinimatchGlobToRegex(clean) {
  let re = "^";
  let i = 0;
  const n = clean.length;
  while (i < n) {
    const ch = clean[i];
    if (ch === "\\") {
      if (i + 1 < n) {
        re += clean[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i += 2;
      } else {
        re += "\\\\";
        i++;
      }
      continue;
    }
    if (ch === "[") {
      if (i + 1 >= n) return null;
      let j = i + 1;
      let out = "[";
      if (clean[j] === "!" || clean[j] === "^") {
        out += "^";
        j++;
      }
      if (j < n && clean[j] === "]") {
        out += "\\]";
        j++;
      }
      let closed = false;
      while (j < n) {
        const bc = clean[j];
        if (bc === "\\" && j + 1 < n) {
          out += clean[j + 1].replace(/[[\]\\^-]/g, "\\$&");
          j += 2;
          continue;
        }
        if (bc === "[" && clean[j + 1] === ":") {
          return null;
        }
        if (bc === "]") {
          out += "]";
          j++;
          closed = true;
          break;
        }
        if (bc === "[" || bc === "\\") out += `\\${bc}`;
        else out += bc;
        j++;
      }
      if (!closed) return null;
      re += out;
      i = j;
      continue;
    }
    if (ch === "*") {
      if (clean[i + 1] === "*") {
        while (clean[i + 1] === "*") i++;
        if (clean[i + 1] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else {
        re += "[^/]*";
        i++;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`${re}(?:/.*)?$`, "i");
}

export function globEntryMatchesPath(pattern, targetPath) {
  const rawClean = String(pattern || "").replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
  if (!rawClean || rawClean === ".") return true;
  if (/[!@+*?]\(/.test(rawClean)) return true;
  const expanded = expandGlobBraces(rawClean);
  if (!expanded) return true;
  const lowTarget = targetPath.toLowerCase();
  for (const cand of expanded) {
    if (/[!@+*?]\(/.test(cand)) return true;
    const clean = posix.normalize(cand).replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
    if (!clean || clean === "." || clean === ".." || clean.startsWith("../")) return true;
    if (/[!@+*?]\(/.test(clean)) return true;
    const lowClean = clean.toLowerCase();
    if (lowClean === lowTarget || lowTarget.startsWith(`${lowClean}/`)) return true;
    try {
      const rx = compileMinimatchGlobToRegex(clean);
      if (!rx || rx.test(targetPath)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function collectForbiddenPackProbes(repoRoot = REPO_ROOT) {
  const probes = new Set([
    "evolve",
    "evolve/SKILL.md",
    ".evolve",
    ".evolve/STRATEGY.md",
    "docs",
    "docs/index.html",
    "fixtures",
    "scripts",
    "examples",
  ]);
  const walk = (absDir) => {
    if (!existsSync(absDir)) return;
    const relDir = relative(repoRoot, absDir).replace(/\\/g, "/");
    if (relDir) probes.add(relDir);
    for (const e of readdirSync(absDir, { withFileTypes: true })) {
      if (e.name === ".DS_Store" || e.name === "node_modules" || e.name === ".git") continue;
      const full = join(absDir, e.name);
      const rel = relative(repoRoot, full).replace(/\\/g, "/");
      probes.add(rel);
      if (e.isDirectory()) walk(full);
    }
  };
  for (const top of ["docs", "fixtures", "scripts", "examples"]) {
    walk(join(repoRoot, top));
  }
  return [...probes];
}

export function isPackageFilesSafe(entries, forbiddenProbes = collectForbiddenPackProbes()) {
  if (!Array.isArray(entries)) return false;
  let hasPositive = false;
  for (const rawItem of entries) {
    if (typeof rawItem !== "string") return false;
    if (/[\r\n\\]/.test(rawItem)) return false;
    const rawEntry = rawItem.trim();
    if (!rawEntry) return false;
    const bangMatch = /^(!+)(.*)$/.exec(rawEntry);
    let entry = rawEntry;
    if (bangMatch) {
      if (bangMatch[1].length % 2 === 1) continue;
      entry = bangMatch[2];
    }
    if (!entry) return false;
    hasPositive = true;
    if (/(?:^|\/)\.\.(?:\/|$)/.test(entry)) return false;
    if (/(?:^|[/,{])(?:\.?evolve|docs|fixtures|scripts|examples)(?:[/,}]|$)/i.test(entry)) return false;
    if (forbiddenProbes.some((p) => globEntryMatchesPath(entry, p))) return false;
  }
  return hasPositive;
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
    console.log("Usage: node scripts/verify-repo.mjs [--help]");
    process.exit(0);
  }
  if (positionals.length > 0) {
    console.error(`Error: unexpected argument '${positionals[0]}'.`);
    process.exit(2);
  }

  console.log("==> [1/4] Verifying Tier 1 skill/ integrity & all deterministic self-tests...");
  const integrityPath = join(SKILL_DIR, "scripts/check-integrity.mjs");
  if (spawnSync(process.execPath, [integrityPath, "--help"], { encoding: "utf8" }).status !== 0) {
    console.error("ERROR: check-integrity.mjs --help must exit 0");
    process.exit(1);
  }
  if (spawnSync(process.execPath, [integrityPath, "--bogus"], { encoding: "utf8" }).status !== 2) {
    console.error("ERROR: check-integrity.mjs --bogus must exit 2");
    process.exit(1);
  }
  const valSelfPath = fileURLToPath(import.meta.url);
  if (spawnSync(process.execPath, [valSelfPath, "--help"], { encoding: "utf8" }).status !== 0) {
    console.error("ERROR: verify-repo.mjs --help must exit 0");
    process.exit(1);
  }
  if (spawnSync(process.execPath, [valSelfPath, "--bogus"], { encoding: "utf8" }).status !== 2) {
    console.error("ERROR: verify-repo.mjs --bogus must exit 2");
    process.exit(1);
  }
  runNode(integrityPath);

  console.log("==> [2/4] Verifying calibration/synthetic fixtures & zero legacy evolve trees...");
  if (existsSync(join(REPO_ROOT, "evolve")) || existsSync(join(REPO_ROOT, ".evolve"))) {
    console.error("ERROR: legacy evolve/ or .evolve/ directory still exists in repo");
    process.exit(1);
  }
  const calDirCheck = join(FIXTURES_DIR, "calibration");
  const synDirCheck = join(FIXTURES_DIR, "synthetic");
  if (!existsSync(calDirCheck) || !existsSync(synDirCheck)) {
    console.error("ERROR: missing fixtures/calibration or fixtures/synthetic directories");
    process.exit(1);
  }

  console.log("==> [3/4] Checking CLI entry, version parity, schema & public leak guards...");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !STRICT_PKG_SEMVER_RE.test(pkg.version)) {
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
  for (const trailingBad of [
    ["version", "--bogus"],
    ["help", "--bogus"],
  ]) {
    const res = spawnSync(process.execPath, [cliPath, ...trailingBad], { encoding: "utf8" });
    if (res.status !== 2) {
      console.error(`ERROR: bin/dsaf.mjs ${trailingBad.join(" ")} must exit 2 (got ${res.status})`);
      process.exit(1);
    }
  }

  const skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const scorecardSrc = readFileSync(join(SKILL_DIR, "scripts/compute-scorecard.mjs"), "utf8");
  const diffSrc = readFileSync(join(SKILL_DIR, "scripts/audit-diff.mjs"), "utf8");
  if (!skillMd.includes(`v${pkg.version}`)) {
    console.error(`ERROR: skill/SKILL.md must reference v${pkg.version}`);
    process.exit(1);
  }
  if (!scorecardSrc.includes(`ENGINE_VERSION = "${pkg.version}"`)) {
    console.error(`ERROR: compute-scorecard.mjs ENGINE_VERSION must match ${pkg.version}`);
    process.exit(1);
  }
  if (
    !diffSrc.includes(`engine_version: "${pkg.version}"`) &&
    !(diffSrc.includes(`DIFF_VERSION = "${pkg.version}"`) && diffSrc.includes("engine_version: DIFF_VERSION"))
  ) {
    console.error(`ERROR: audit-diff.mjs engine_version must match ${pkg.version}`);
    process.exit(1);
  }

  const forbiddenPackProbes = collectForbiddenPackProbes(REPO_ROOT);
  const pkgFiles = Array.isArray(pkg.files) ? pkg.files : [];
  if (!isPackageFilesSafe(pkgFiles, forbiddenPackProbes)) {
    console.error("ERROR: package.json#files must explicitly whitelist publishable files and never publish docs/, fixtures/, scripts/, or examples/");
    process.exit(1);
  }
  const blockedPatterns = [
    "**/*.mjs",
    "**/*.json",
    "**/*.css",
    "**/scripts/**",
    "**/d?cs/**",
    "**/.e*/**",
    "e*/scripts/*.mjs",
    "**/*.{mjs,md}",
    "[^b]*/**",
    "@(docs|bin)/**",
    "+(scripts)/**",
    "./!(bin)/**",
    "!!docs/**",
    "!!fixtures/**",
    "bin/../f*/**",
    "{d..f}ocs/**",
    "{d..f..2}ocs/**",
    "d{n..p}cs/**",
    "d[?o]cs/**",
    "d[*o]cs/**",
    "[]d]ocs/**",
    "[^]a]ocs/**",
    "[!]a]ocs/**",
    "[[:lower:]]ocs/**",
    "d\\ocs/**",
    "f\\ixtures/**",
    "\n!docs/**",
    "bin/\n!docs/**",
    "./{!,+}(bin)/**",
    "{,@}(docs)/**",
    "@{,(docs)}/**",
    "d{?,*}(o)cs/**",
    "d[a-{]cs/**/[.-}]*",
    "d[${o,]cs/**/*[a-z}]",
  ];
  if (
    !isPackageFilesSafe(["bin/", "skill/", "*.md"], forbiddenPackProbes) ||
    blockedPatterns.some((pat) => isPackageFilesSafe(["bin/", "skill/", pat], forbiddenPackProbes)) ||
    !globEntryMatchesPath("d\\ocs/**", "docs/index.html") ||
    !globEntryMatchesPath("f[i]xtures/case-{9..10..02}.json", "fixtures/case-09.json") ||
    !globEntryMatchesPath("f[i]xtures/case-{10..9..-02}.json", "fixtures/case-09.json") ||
    globEntryMatchesPath("fixtures/a[\\d].js", "fixtures/a5.js") ||
    !globEntryMatchesPath("fixtures/a[\\d].js", "fixtures/ad.js") ||
    isPackageFilesSafe(["bin/", "skill/", 123], forbiddenPackProbes)
  ) {
    console.error("ERROR: package.json#files glob matcher regression detected");
    process.exit(1);
  }

  const verMap = [
    ["scripts/audit-pipeline.mjs", `engine_version: "${pkg.version}"`],
    ["scripts/generate-personas.mjs", `PERSONAS_VERSION = "${pkg.version}"`],
    ["scripts/mcp-server.mjs", `MCP_SERVER_VERSION = "${pkg.version}"`],
    ["scripts/setup.mjs", `SETUP_VERSION = "${pkg.version}"`],
    ["scripts/generate-html-report.mjs", `HTML_REPORT_VERSION = "${pkg.version}"`],
    ["scripts/doctor.mjs", `DOCTOR_VERSION = "${pkg.version}"`],
    ["scripts/ci-report.mjs", `CI_REPORT_VERSION = "${pkg.version}"`],
    ["scripts/fix-floor.mjs", `FIX_VERSION = "${pkg.version}"`],
    ["scripts/generate-guardrails.mjs", `GENERATOR_VERSION = "${pkg.version}"`],
    ["scripts/update-check.mjs", `UPDATE_CHECK_VERSION = "${pkg.version}"`],
    ["scripts/update.mjs", `UPDATE_VERSION = "${pkg.version}"`],
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
    ["scripts/audit-runtime.mjs", "dsaf-runtime/2"],
    ["scripts/setup.mjs", "dsaf-setup/1"],
    ["scripts/update.mjs", "dsaf-update/1"],
  ]) {
    if (!readFileSync(join(SKILL_DIR, rel), "utf8").includes(schemaId)) {
      console.error(`ERROR: skill/${rel} missing schema contract '${schemaId}'`);
      process.exit(1);
    }
  }

  for (const f of readdirSync(calDirCheck).filter((n) => n.endsWith(".scores.json")).sort()) {
    const calDoc = JSON.parse(readFileSync(join(calDirCheck, f), "utf8"));
    if (calDoc.engine_version !== pkg.version) {
      console.error(`ERROR: calibration fixture ${f} engine_version (${calDoc.engine_version}) !== ${pkg.version}`);
      process.exit(1);
    }
    if (!Object.prototype.hasOwnProperty.call(calDoc, "review_provenance") || !Array.isArray(calDoc.waivers)) {
      console.error(`ERROR: calibration fixture ${f} missing review_provenance or waivers field`);
      process.exit(1);
    }
    if (calDoc.type === "system") {
      for (const [phaseKey, pMap] of Object.entries(calDoc.criteria || {})) {
        for (const [cid, entry] of Object.entries(pMap || {})) {
          if (!entry.check_type) {
            console.error(`ERROR: system calibration fixture ${f} ${phaseKey}.${cid} missing check_type`);
            process.exit(1);
          }
        }
      }
    }
  }

  if (Buffer.compare(readFileSync(join(SKILL_DIR, "resources/preview-shell.html")), readFileSync(join(REPO_ROOT, "docs/demo/preview-shell.html"))) !== 0) {
    console.error("ERROR: docs/demo/preview-shell.html differs from skill/resources/preview-shell.html");
    process.exit(1);
  }
  const sampleReportPath = join(REPO_ROOT, "docs/demo/sample-report.html");
  if (!existsSync(sampleReportPath)) {
    console.error("ERROR: missing docs/demo/sample-report.html");
    process.exit(1);
  }
  const sampleReportHtml = readFileSync(sampleReportPath, "utf8");
  const refReportHtml = renderHtmlReport({});
  if (!sampleReportHtml.includes(`DSAF v${pkg.version}`)) {
    console.error(`ERROR: docs/demo/sample-report.html missing version marker 'DSAF v${pkg.version}'`);
    process.exit(1);
  }
  const extractTags = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((m) => m[1]);
  const sampleStyles = extractTags(sampleReportHtml, "style");
  const refStyles = extractTags(refReportHtml, "style");
  if (sampleStyles.length === 0 || sampleStyles.length !== refStyles.length || sampleStyles.some((s, i) => s !== refStyles[i])) {
    console.error("ERROR: docs/demo/sample-report.html <style> drifted from skill/scripts/generate-html-report.mjs");
    process.exit(1);
  }
  const sampleScripts = extractTags(sampleReportHtml, "script");
  const refScripts = extractTags(refReportHtml, "script");
  if (sampleScripts.length === 0 || sampleScripts.length !== refScripts.length || sampleScripts.some((s, i) => s !== refScripts[i])) {
    console.error("ERROR: docs/demo/sample-report.html <script> drifted from skill/scripts/generate-html-report.mjs");
    process.exit(1);
  }

  for (const file of scanRepoTexts(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (rel === "scripts/verify-repo.mjs" || rel === "skill/scripts/check-integrity.mjs") continue;
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
    if (!existsSync(gitCfg)) {
      console.error(`ERROR: ~/.gitconfig missing (expected SHA-256 ${expectedGitSha})`);
      process.exit(1);
    }
    const actual = createHash("sha256").update(readFileSync(gitCfg)).digest("hex");
    if (actual !== expectedGitSha) {
      console.error(`ERROR: ~/.gitconfig SHA-256 drifted! expected=${expectedGitSha} actual=${actual}`);
      process.exit(1);
    }
    console.log(`==> [4/4] GITCONFIG_SHA_OK (${actual})`);
  } else {
    console.log("==> [4/4] Repo hygiene, CLI, version parity & schema invariants verified.");
  }

  console.log("ALL_DSAF_ISOLATION_AND_INTEGRITY_CHECKS_PASSED");
}

function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const isEntry = Boolean(process.argv[1]) && canonPath(process.argv[1]) === canonPath(fileURLToPath(import.meta.url));
if (isEntry) main();

#!/usr/bin/env node
/**
 * DSAF v0.3.0 — No-Silent-Regression Gate (`audit-diff`).
 * Compares two `dsaf-scores/2` JSON files across system, usability, or visual audits.
 * Exits 1 on any unapproved per-criterion score regression unless --allow-regressions is set.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

function loadScores(path) {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (parsed.schema !== "dsaf-scores/2" || !parsed.criteria?.before || !parsed.phases?.before) {
    throw new Error(`${path} is not a valid dsaf-scores/2 scorecard output`);
  }
  return parsed;
}

function majorOf(version) {
  return String(version ?? "0").split(".").slice(0, 2).join(".");
}

export function diffScorecards(baseline, current, currentPhase = "before") {
  const baseTotal = baseline.phases.before.total;
  const curPhaseObj = current.phases[currentPhase] || current.phases.before;
  const curCriteria = current.criteria[currentPhase] || current.criteria.before;
  const baseCriteria = baseline.criteria.before;

  if (baseline.type !== current.type) {
    throw new Error(`Cannot compare differing audit types: ${baseline.type} vs ${current.type}`);
  }

  const majorMismatch = majorOf(baseline.engine_version) !== majorOf(current.engine_version);
  const improvements = [];
  const regressions = [];

  for (const [cid, curEntry] of Object.entries(curCriteria)) {
    const baseEntry = baseCriteria[cid];
    if (!baseEntry || baseEntry.score === "N/A" || curEntry.score === "N/A") continue;
    const delta = curEntry.score - baseEntry.score;
    const volatility = curEntry.volatility || baseEntry.volatility || "FIXED";
    if (delta > 0) improvements.push({ id: cid, pre: baseEntry.score, post: curEntry.score, delta });
    else if (delta < 0) regressions.push({ id: cid, volatility, pre: baseEntry.score, post: curEntry.score, delta });
  }

  return {
    type: current.type,
    baselineTotal: baseTotal,
    currentTotal: curPhaseObj.total,
    baselineGrade: baseline.phases.before.grade,
    currentGrade: curPhaseObj.grade,
    majorMismatch,
    improvements,
    regressions,
  };
}

export function renderDiffMarkdown(diff) {
  const lines = [
    "# DSAF No-Silent-Regression Diff",
    "",
    `| Metric | Baseline | Current |`,
    `|---|---|---|`,
    `| Audit Type | \`${diff.type}\` | \`${diff.type}\` |`,
    `| Total Score | ${diff.baselineTotal ?? "N/A"} | ${diff.currentTotal ?? "N/A"} |`,
    `| Grade / Maturity | ${diff.baselineGrade} | ${diff.currentGrade} |`,
    "",
    `- Improvements: ${diff.improvements.length}`,
    `- Regressions: ${diff.regressions.length}`,
    "",
  ];
  if (diff.improvements.length > 0) {
    lines.push("## Improvements", "", "| Criterion | Pre | Post | Delta |", "|---|---:|---:|---:|");
    for (const r of diff.improvements) lines.push(`| \`${r.id}\` | ${r.pre} | ${r.post} | +${r.delta} |`);
    lines.push("");
  }
  if (diff.regressions.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    lines.push("## Regressions (Human Sign-Off Required)", "", "| Criterion | Pre | Post | Delta | Cause | Approver | Date | Tag | Notes |", "|---|---:|---:|---:|---|---|---|---|---|");
    for (const r of diff.regressions) {
      const note = r.volatility === "DYNAMIC" ? "DYNAMIC: `rubric-tightened` (`D-RT`) valid only if external standard shifted." : "FIXED: requires explicit override (`OVRD-*`) or rollback.";
      lines.push(`| \`${r.id}\` | ${r.pre} | ${r.post} | ${Math.abs(r.delta)} | unresolved | null | ${date} | UNRESOLVED | ${note} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function runSelfTest() {
  const makeDoc = (scores) => ({
    schema: "dsaf-scores/2",
    engine_version: "0.8.0",
    type: "system",
    phases: { before: { total: 80, grade: "L4" } },
    criteria: { before: scores },
  });
  const base = makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 1, volatility: "DYNAMIC" } });
  const improved = makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } });
  const regressed = makeDoc({ DS01: { score: 1, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } });

  const dOk = diffScorecards(base, improved);
  assert.equal(dOk.improvements.length, 1);
  assert.equal(dOk.regressions.length, 0);

  const dBad = diffScorecards(base, regressed);
  assert.equal(dBad.regressions.length, 1);
  assert.match(renderDiffMarkdown(dBad), /UNRESOLVED/);

  console.log("AUDIT_DIFF_SELF_TEST_PASSED (improvements + regression lock + override log)");
  return 0;
}

function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: "string" },
      current: { type: "string" },
      phase: { type: "string", default: "before" },
      out: { type: "string" },
      "allow-regressions": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/audit-diff.mjs --baseline <old.json> --current <new.json> [--phase before|after_track_a|after_track_b] [--allow-regressions] [--out <diff.md>] [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  if (!values.baseline || !values.current) {
    console.error("Error: --baseline and --current are required.");
    process.exit(2);
  }

  const diff = diffScorecards(loadScores(values.baseline), loadScores(values.current), values.phase);
  const md = renderDiffMarkdown(diff);
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), md, "utf8");
  }
  process.stdout.write(md);

  if (diff.regressions.length > 0 && !values["allow-regressions"]) {
    console.error(`[audit-diff] Blocked: ${diff.regressions.length} unresolved regression(s). Record override rows and pass --allow-regressions, or fix target.`);
    process.exit(1);
  }
  console.log(`[audit-diff] PASS (${diff.improvements.length} improvement(s), ${diff.regressions.length} allowed regression(s)).`);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntry) main();

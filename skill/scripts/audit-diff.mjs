#!/usr/bin/env node
/**
 * DSAF v0.9.3 — No-Silent-Regression Gate (`audit-diff`).
 * Compares two `dsaf-scores/2` JSON files across system, usability, or visual audits.
 * Exits 1 on any unapproved per-criterion score regression unless --allow-regressions is set.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertWritableOutputFile, isDirectCliEntry } from "./ci-report.mjs";

export const DIFF_VERSION = "0.9.3";

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function loadScores(path) {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!isPlainObject(parsed) || parsed.schema !== "dsaf-scores/2" || !isPlainObject(parsed.criteria?.before) || !isPlainObject(parsed.phases?.before)) {
    throw new Error(`${path} is not a valid dsaf-scores/2 scorecard output`);
  }
  return parsed;
}

function majorOf(version) {
  return String(version ?? "0").split(".").slice(0, 2).join(".");
}

export function diffScorecards(baseline, current, currentPhase = "before") {
  if (!isPlainObject(baseline) || baseline.schema !== "dsaf-scores/2" || !isPlainObject(baseline.phases?.before) || !isPlainObject(baseline.criteria?.before)) {
    throw new Error("Invalid baseline scorecard: expected dsaf-scores/2 object with phases.before and criteria.before objects.");
  }
  if (!isPlainObject(current) || current.schema !== "dsaf-scores/2") {
    throw new Error("Invalid current scorecard: expected dsaf-scores/2 object.");
  }
  const baseTotal = baseline.phases.before.total;
  const curPhases = isPlainObject(current.phases) ? current.phases : null;
  const curCriteriaRoot = isPlainObject(current.criteria) ? current.criteria : null;
  const hasPhase = Boolean(curPhases && Object.prototype.hasOwnProperty.call(curPhases, currentPhase));
  const hasCriteria = Boolean(curCriteriaRoot && Object.prototype.hasOwnProperty.call(curCriteriaRoot, currentPhase));
  const curPhaseObj = hasPhase ? curPhases[currentPhase] : null;
  const curCriteria = hasCriteria ? curCriteriaRoot[currentPhase] : null;
  if (!isPlainObject(curPhaseObj) || !isPlainObject(curCriteria)) {
    throw new Error(`Phase '${currentPhase}' does not exist in current scorecard.`);
  }
  const baseCriteria = baseline.criteria.before;

  if (baseline.type !== current.type) {
    throw new Error(`Cannot compare differing audit types: ${baseline.type} vs ${current.type}`);
  }

  const majorMismatch = majorOf(baseline.engine_version) !== majorOf(current.engine_version);
  const improvements = [];
  const regressions = [];

  for (const [cid, curEntry] of Object.entries(curCriteria)) {
    if (!Object.prototype.hasOwnProperty.call(baseCriteria, cid)) continue;
    const baseEntry = baseCriteria[cid];
    if (!isPlainObject(baseEntry)) {
      throw new Error(`Invalid baseline entry for criterion '${cid}': expected object.`);
    }
    if (baseEntry.score !== "N/A" && (typeof baseEntry.score !== "number" || !Number.isFinite(baseEntry.score))) {
      throw new Error(`Invalid baseline score for criterion '${cid}': expected finite number or 'N/A'.`);
    }
    if (!isPlainObject(curEntry) || (curEntry.score !== "N/A" && (typeof curEntry.score !== "number" || !Number.isFinite(curEntry.score)))) {
      throw new Error(`Invalid current score for criterion '${cid}': expected finite number or 'N/A'.`);
    }
    if (baseEntry.score === "N/A") continue;
    const volatility = baseEntry.volatility === "FIXED" ? "FIXED" : (curEntry.volatility || baseEntry.volatility || "FIXED");
    if (curEntry.score === "N/A") {
      regressions.push({ id: cid, volatility, pre: baseEntry.score, post: "N/A", delta: -baseEntry.score, reason: "Converted numeric score to N/A" });
      continue;
    }
    const delta = curEntry.score - baseEntry.score;
    if (delta > 0) improvements.push({ id: cid, pre: baseEntry.score, post: curEntry.score, delta });
    else if (delta < 0) regressions.push({ id: cid, volatility, pre: baseEntry.score, post: curEntry.score, delta });
  }
  for (const [cid, baseEntry] of Object.entries(baseCriteria)) {
    if (!isPlainObject(baseEntry)) {
      throw new Error(`Invalid baseline entry for criterion '${cid}': expected object.`);
    }
    if (baseEntry.score !== "N/A" && (typeof baseEntry.score !== "number" || !Number.isFinite(baseEntry.score))) {
      throw new Error(`Invalid baseline score for criterion '${cid}': expected finite number or 'N/A'.`);
    }
    if (baseEntry.score !== "N/A" && !Object.prototype.hasOwnProperty.call(curCriteria, cid)) {
      regressions.push({
        id: cid,
        volatility: baseEntry.volatility || "FIXED",
        pre: baseEntry.score,
        post: "missing",
        delta: -baseEntry.score,
        reason: "Criterion omitted in current scorecard",
      });
    }
  }

  const normBlockers = (arr) => [
    ...new Set((Array.isArray(arr) ? arr : []).filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean)),
  ];
  const baseBlockers = new Set(normBlockers(baseline.phases.before.hard_floor_blockers));
  const newBlockers = normBlockers(curPhaseObj.hard_floor_blockers).filter((b) => !baseBlockers.has(b));
  for (const nb of newBlockers) {
    regressions.push({
      id: `BLOCKER:${nb}`,
      volatility: "FIXED",
      pre: "clear",
      post: "blocked",
      delta: -1,
      reason: `Newly introduced Hard Floor blocker: ${nb}`,
    });
  }

  return {
    engine_version: DIFF_VERSION,
    type: current.type,
    baselineTotal: baseTotal,
    currentTotal: curPhaseObj.total,
    baselineGrade: baseline.phases.before.grade,
    currentGrade: curPhaseObj.grade,
    majorMismatch,
    newBlockers,
    improvements,
    regressions,
  };
}

export function renderDiffMarkdown(diff) {
  const escMdCell = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const lines = [
    "# DSAF No-Silent-Regression Diff",
    "",
  ];
  if (diff.majorMismatch) {
    lines.push("> ⚠️ **Engine Version Mismatch:** baseline and current scorecards come from different minor/major engine versions; cross-version deltas require manual review.", "");
  }
  lines.push(
    `| Metric | Baseline | Current |`,
    `|---|---|---|`,
    `| Audit Type | \`${escMdCell(diff.type)}\` | \`${escMdCell(diff.type)}\` |`,
    `| Total Score | ${diff.baselineTotal ?? "N/A"} | ${diff.currentTotal ?? "N/A"} |`,
    `| Grade / Maturity | ${escMdCell(diff.baselineGrade)} | ${escMdCell(diff.currentGrade)} |`,
    "",
    `- Improvements: ${diff.improvements.length}`,
    `- Regressions: ${diff.regressions.length}`,
    ""
  );
  if (diff.improvements.length > 0) {
    lines.push("## Improvements", "", "| Criterion | Pre | Post | Delta |", "|---|---:|---:|---:|");
    for (const r of diff.improvements) lines.push(`| \`${escMdCell(r.id)}\` | ${escMdCell(r.pre)} | ${escMdCell(r.post)} | +${r.delta} |`);
    lines.push("");
  }
  if (diff.regressions.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    lines.push("## Regressions (Human Sign-Off Required)", "", "| Criterion | Pre | Post | Delta | Cause | Approver | Date | Tag | Notes |", "|---|---:|---:|---:|---|---|---|---|---|");
    for (const r of diff.regressions) {
      const note =
        r.reason ||
        (r.volatility === "DYNAMIC"
          ? "DYNAMIC: `rubric-tightened` (`D-RT`) valid only if external standard shifted."
          : "FIXED: requires explicit override (`OVRD-*`) or rollback.");
      lines.push(`| \`${escMdCell(r.id)}\` | ${escMdCell(r.pre)} | ${escMdCell(r.post)} | ${r.delta} | unresolved | null | ${date} | UNRESOLVED | ${escMdCell(note)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function runSelfTest() {
  const makeDoc = (scores, ver = DIFF_VERSION, blockers = []) => ({
    schema: "dsaf-scores/2",
    engine_version: ver,
    type: "system",
    phases: { before: { total: 80, grade: "L4", hard_floor_blockers: blockers } },
    criteria: { before: scores },
  });
  const base = makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 1, volatility: "DYNAMIC" } });
  const improved = makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } });
  const regressed = makeDoc({ DS01: { score: 1, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } });

  const dOk = diffScorecards(base, improved);
  assert.equal(dOk.engine_version, DIFF_VERSION);
  assert.equal(dOk.improvements.length, 1);
  assert.equal(dOk.regressions.length, 0);

  const dBad = diffScorecards(base, regressed);
  assert.equal(dBad.regressions.length, 1);
  const badMd = renderDiffMarkdown(dBad);
  assert.match(badMd, /UNRESOLVED/);
  assert.match(badMd, /\| -1 \|/, "Must render signed negative delta");

  // Round 1 regressions: invalid --phase throws, numeric->N/A fails, new blocker fails, majorMismatch banner
  assert.throws(() => diffScorecards(base, improved, "after_track_a"));
  const naReg = diffScorecards(base, makeDoc({ DS01: { score: "N/A", volatility: "FIXED" }, DS02: { score: 1, volatility: "DYNAMIC" } }));
  assert.equal(naReg.regressions.length, 1);
  const blkReg = diffScorecards(base, makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 1, volatility: "DYNAMIC" } }, "0.8.0", ["F-NEW"]));
  assert.equal(blkReg.regressions.length, 1);
  assert.equal(blkReg.majorMismatch, true);
  assert.match(renderDiffMarkdown(blkReg), /Engine Version Mismatch/);

  // Round 7 regressions: prototype phase name ('toString') & malformed non-numeric score rejection
  assert.throws(() => diffScorecards(base, improved, "toString"), /does not exist/);
  assert.throws(
    () => diffScorecards(base, makeDoc({ DS01: { score: "bad", volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } })),
    /Invalid current score/
  );
  assert.throws(
    () => diffScorecards(makeDoc({ DS01: { score: null, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" } }), improved),
    /Invalid baseline score/
  );

  // Round 8 regressions: null/malformed omitted baseline entry & prototype key 'toString'
  assert.throws(
    () => diffScorecards(makeDoc({ DS01: null, DS02: { score: 2, volatility: "DYNAMIC" } }), improved),
    /Invalid baseline entry/
  );
  assert.throws(
    () => diffScorecards(makeDoc({ DS01: { score: 2, volatility: "FIXED" }, EXTRA: { score: "bad", volatility: "FIXED" } }), improved),
    /Invalid baseline score/
  );
  const protoOmit = diffScorecards(
    makeDoc({ DS01: { score: 2, volatility: "FIXED" }, DS02: { score: 2, volatility: "DYNAMIC" }, toString: { score: 2, volatility: "FIXED" } }),
    improved
  );
  assert.ok(protoOmit.regressions.some((r) => r.id === "toString"), "Omitted 'toString' criterion must still record regression");

  // Round 10 regressions (R10-A3-07): reject array/primitive criteria.before, null baseline, and array/null loadScores
  assert.throws(() => diffScorecards(makeDoc([]), regressed), /Invalid baseline scorecard/);
  assert.throws(() => diffScorecards(makeDoc(123), regressed), /Invalid baseline scorecard/);
  assert.throws(() => diffScorecards(null, improved), /Invalid baseline scorecard/);
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-diff-test-"));
  try {
    const nullJsonPath = join(scratch, "null.json");
    writeFileSync(nullJsonPath, "null", "utf8");
    assert.throws(() => loadScores(nullJsonPath), /not a valid dsaf-scores\/2 scorecard/);
    assert.throws(() => diffScorecards(improved, { ...improved, schema: "wrong" }, "before"), /dsaf-scores\/2/);
    assert.throws(() => diffScorecards({ ...improved, schema: "wrong" }, improved, "before"), /dsaf-scores\/2/);
    const fixedLock = diffScorecards(
      {
        schema: "dsaf-scores/2",
        type: "system",
        engine_version: "0.9.3",
        phases: { before: { total: 80, grade: "L4" } },
        criteria: { before: { DS01: { score: 2, volatility: "FIXED" } } },
      },
      {
        schema: "dsaf-scores/2",
        type: "system",
        engine_version: "0.9.3",
        phases: { before: { total: 70, grade: "L3" } },
        criteria: { before: { DS01: { score: 1, volatility: "DYNAMIC" } } },
      },
      "before"
    );
    assert.equal(fixedLock.regressions[0].volatility, "FIXED", "Baseline FIXED volatility must not be downgraded to DYNAMIC");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const diffSelfPath = fileURLToPath(import.meta.url);
  assert.equal(spawnSync(process.execPath, [diffSelfPath, "--alow-regressions"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", "a.json", "--current", "b.json", "--phase", "bogus"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", "   ", "--current", "b.json"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", "a.json", "--current", "b.json", "--out", "   "], { encoding: "utf8" }).status, 2);

  // Round 24 regressions (A4-H1 missing/dir inputs & symlink --out, A4-M9 uppercase --phase)
  const cliTmp = mkdtempSync(join(tmpdir(), "dsaf-diff-cli-"));
  try {
    const validScore = join(cliTmp, "score.json");
    writeFileSync(
      validScore,
      JSON.stringify({
        schema: "dsaf-scores/2",
        type: "system",
        engine_version: "0.9.3",
        phases: { before: { total: 80, grade: "L3" } },
        criteria: { before: { DS01: { score: 2, volatility: "FIXED" } } },
      })
    );
    const outSym = join(cliTmp, "out-sym.md");
    symlinkSync(join(cliTmp, "missing-out.md"), outSym);
    assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", join(cliTmp, "missing.json"), "--current", validScore], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", validScore, "--current", cliTmp], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", validScore, "--current", validScore, "--out", outSym], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", validScore, "--current", validScore, "--out", cliTmp], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [diffSelfPath, "--baseline", validScore, "--current", validScore, "--phase", " BEFORE "], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(cliTmp, { recursive: true, force: true });
  }

  // Round 28 (A4-L4): hard_floor_blockers sanitization & Markdown pipe/newline escaping
  const r28Diff = diffScorecards(
    makeDoc({ DS01: { score: 2, volatility: "FIXED" } }, DIFF_VERSION, []),
    makeDoc({ DS01: { score: 2, volatility: "FIXED" } }, DIFF_VERSION, ["", null, "F-1", "F-1", "F-2 | pipe\nbreak"]),
    "before"
  );
  assert.deepEqual(r28Diff.newBlockers, ["F-1", "F-2 | pipe\nbreak"], "R28 A4-L4: empty/null/duplicate blockers must be filtered and deduplicated");
  assert.equal(r28Diff.regressions.length, 2);
  const r28Md = renderDiffMarkdown(r28Diff);
  assert.ok(r28Md.includes("\\| pipe break"), "R28 A4-L4: pipe and newline in blocker note must be escaped");
  assert.ok(!r28Md.includes("\nbreak"), "R28 A4-L4: raw newline inside table row must not split row");

  console.log("AUDIT_DIFF_SELF_TEST_PASSED (improvements + regression lock + override log)");
  return 0;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        baseline: { type: "string" },
        current: { type: "string" },
        phase: { type: "string", default: "before" },
        out: { type: "string" },
        "allow-regressions": { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(2);
  }
  try {
    if (values.help) {
      console.log("Usage: node skill/scripts/audit-diff.mjs --baseline <old.json> --current <new.json> [--phase before|after_track_a|after_track_b] [--allow-regressions] [--out <diff.md>] [--self-test] [--help]");
      process.exit(0);
    }
    if (values["self-test"]) process.exit(runSelfTest());
    const cleanPhase = String(values.phase || "").trim().toLowerCase();
    if (!["before", "after_track_a", "after_track_b"].includes(cleanPhase)) {
      console.error(`Error: invalid --phase '${values.phase}'. Expected before|after_track_a|after_track_b.`);
      process.exit(2);
    }
    if (!values.baseline || !values.baseline.trim() || !values.current || !values.current.trim()) {
      console.error("Error: non-empty --baseline and --current are required.");
      process.exit(2);
    }
    const assertReadableScoreFile = (rawPath, flagName) => {
      const abs = resolve(rawPath);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        console.error(`Error: ${flagName} file not found: ${abs}`);
        process.exit(2);
      }
      return abs;
    };
    const absBaseline = assertReadableScoreFile(values.baseline, "--baseline");
    const absCurrent = assertReadableScoreFile(values.current, "--current");
    if (values.out !== undefined) {
      try {
        assertWritableOutputFile(values.out, "--out");
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
    }

    const diff = diffScorecards(loadScores(absBaseline), loadScores(absCurrent), cleanPhase);
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
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}

if (isDirectCliEntry(import.meta.url)) main();

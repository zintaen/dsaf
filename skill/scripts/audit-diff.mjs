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
import { assertWritableOutputFile, escMdCell, formatMdCodeSpan, isDirectCliEntry } from "./ci-report.mjs";

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
  if (baseTotal !== undefined && baseTotal !== null && (typeof baseTotal !== "number" || !Number.isFinite(baseTotal))) {
    throw new Error("Invalid baseline phase total: expected finite number or null.");
  }
  const curPhases = isPlainObject(current.phases) ? current.phases : null;
  const curCriteriaRoot = isPlainObject(current.criteria) ? current.criteria : null;
  const hasPhase = Boolean(curPhases && Object.prototype.hasOwnProperty.call(curPhases, currentPhase));
  const hasCriteria = Boolean(curCriteriaRoot && Object.prototype.hasOwnProperty.call(curCriteriaRoot, currentPhase));
  const curPhaseObj = hasPhase ? curPhases[currentPhase] : null;
  const curCriteria = hasCriteria ? curCriteriaRoot[currentPhase] : null;
  if (!isPlainObject(curPhaseObj) || !isPlainObject(curCriteria)) {
    throw new Error(`Phase '${currentPhase}' does not exist in current scorecard.`);
  }
  const curTotal = curPhaseObj.total;
  if (curTotal !== undefined && curTotal !== null && (typeof curTotal !== "number" || !Number.isFinite(curTotal))) {
    throw new Error("Invalid current phase total: expected finite number or null.");
  }
  const baseCriteria = baseline.criteria.before;

  const ALLOWED_TYPES = new Set(["usability", "visual", "system"]);
  if (typeof baseline.type !== "string" || !ALLOWED_TYPES.has(baseline.type)) {
    throw new Error(`Invalid baseline audit type: ${JSON.stringify(baseline.type)}. Expected 'usability', 'visual', or 'system'.`);
  }
  if (typeof current.type !== "string" || !ALLOWED_TYPES.has(current.type)) {
    throw new Error(`Invalid current audit type: ${JSON.stringify(current.type)}. Expected 'usability', 'visual', or 'system'.`);
  }
  if (baseline.type !== current.type) {
    throw new Error(`Cannot compare differing audit types: ${baseline.type} vs ${current.type}`);
  }
  const normProfile = (prof, label) => {
    if (prof === undefined || prof === null) return "";
    if (typeof prof !== "string" || !prof.trim()) {
      throw new Error(`Invalid ${label} profile: expected a non-empty string.`);
    }
    return prof.trim();
  };
  const baseProf = normProfile(baseline.profile, "baseline");
  const curProf = normProfile(current.profile, "current");
  if (baseProf && curProf && baseProf !== curProf) {
    throw new Error(`Cannot compare differing weight profiles: ${baseProf} vs ${curProf}`);
  }
  const validateWeightsObj = (w, label) => {
    if (w === undefined || w === null) return null;
    if (!isPlainObject(w)) {
      throw new Error(`Invalid ${label} weights: expected an object mapping pillar IDs to finite numbers.`);
    }
    for (const [k, v] of Object.entries(w)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`Invalid ${label} weight for '${k}': expected finite number.`);
      }
    }
    return w;
  };
  const baseWeights = validateWeightsObj(baseline.weights, "baseline");
  const curWeights = validateWeightsObj(current.weights, "current");
  if (baseWeights && curWeights) {
    const bKeys = Object.keys(baseWeights).sort();
    const cKeys = Object.keys(curWeights).sort();
    const sameWeights =
      bKeys.length === cKeys.length &&
      bKeys.every((k, idx) => k === cKeys[idx] && Math.abs(baseWeights[k] - curWeights[k]) <= 1e-6);
    if (!sameWeights) {
      throw new Error("Cannot compare scorecards with differing pillar weights.");
    }
  }

  const normVol = (v, label, cid) => {
    if (v === undefined || v === null) return "FIXED";
    if (typeof v !== "string") {
      throw new Error(`Invalid ${label} volatility for criterion '${cid}': expected 'FIXED' or 'DYNAMIC'.`);
    }
    const s = v.trim().toUpperCase();
    if (!s) return "FIXED";
    if (s !== "FIXED" && s !== "DYNAMIC") {
      throw new Error(`Invalid ${label} volatility for criterion '${cid}': expected 'FIXED' or 'DYNAMIC', got ${JSON.stringify(v)}.`);
    }
    return s;
  };
  const isValidScore = (s) => s === "N/A" || s === 0 || s === 1 || s === 2;
  const majorMismatch = majorOf(baseline.engine_version) !== majorOf(current.engine_version);
  const improvements = [];
  const regressions = [];

  for (const [cid, curEntry] of Object.entries(curCriteria)) {
    if (!isPlainObject(curEntry) || !isValidScore(curEntry.score)) {
      throw new Error(`Invalid current score for criterion '${cid}': expected 0, 1, 2, or 'N/A'.`);
    }
    normVol(curEntry.volatility, "current", cid);
    if (!Object.prototype.hasOwnProperty.call(baseCriteria, cid)) continue;
    const baseEntry = baseCriteria[cid];
    if (!isPlainObject(baseEntry)) {
      throw new Error(`Invalid baseline entry for criterion '${cid}': expected object.`);
    }
    if (!isValidScore(baseEntry.score)) {
      throw new Error(`Invalid baseline score for criterion '${cid}': expected 0, 1, 2, or 'N/A'.`);
    }
    const baseVol = normVol(baseEntry.volatility, "baseline", cid);
    if (baseEntry.score === "N/A") continue;
    const hasCurVol = curEntry.volatility !== undefined && curEntry.volatility !== null;
    const volatility = baseVol === "FIXED" ? "FIXED" : normVol(hasCurVol ? curEntry.volatility : baseVol, "current", cid);
    if (curEntry.score === "N/A") {
      const naDelta = baseEntry.score === 0 ? 0 : -baseEntry.score;
      regressions.push({ id: cid, volatility, pre: baseEntry.score, post: "N/A", delta: naDelta, reason: "Converted numeric score to N/A" });
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
    if (!isValidScore(baseEntry.score)) {
      throw new Error(`Invalid baseline score for criterion '${cid}': expected 0, 1, 2, or 'N/A'.`);
    }
    const baseVol = normVol(baseEntry.volatility, "baseline", cid);
    if (baseEntry.score !== "N/A" && !Object.prototype.hasOwnProperty.call(curCriteria, cid)) {
      const omitDelta = baseEntry.score === 0 ? 0 : -baseEntry.score;
      regressions.push({
        id: cid,
        volatility: baseVol,
        pre: baseEntry.score,
        post: "missing",
        delta: omitDelta,
        reason: "Criterion omitted in current scorecard",
      });
    }
  }

  const normBlockers = (arr, label) => {
    if (arr !== undefined && arr !== null && !Array.isArray(arr)) {
      throw new Error(`Invalid ${label}: expected an array.`);
    }
    return [...new Set((arr || []).filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))];
  };
  const baseBlockers = new Set(normBlockers(baseline.phases.before.hard_floor_blockers, "baseline hard_floor_blockers"));
  const newBlockers = normBlockers(curPhaseObj.hard_floor_blockers, "current hard_floor_blockers").filter((b) => !baseBlockers.has(b));
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
    `| Audit Type | ${formatMdCodeSpan(diff.type, true)} | ${formatMdCodeSpan(diff.type, true)} |`,
    `| Total Score | ${escMdCell(diff.baselineTotal ?? "N/A")} | ${escMdCell(diff.currentTotal ?? "N/A")} |`,
    `| Grade / Maturity | ${escMdCell(diff.baselineGrade)} | ${escMdCell(diff.currentGrade)} |`,
    "",
    `- Improvements: ${diff.improvements.length}`,
    `- Regressions: ${diff.regressions.length}`,
    ""
  );
  if (diff.improvements.length > 0) {
    lines.push("## Improvements", "", "| Criterion | Pre | Post | Delta |", "|---|---:|---:|---:|");
    for (const r of diff.improvements) lines.push(`| ${formatMdCodeSpan(r.id, true)} | ${escMdCell(r.pre)} | ${escMdCell(r.post)} | +${r.delta} |`);
    lines.push("");
  }
  if (diff.regressions.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    lines.push("## Regressions (Human Sign-Off Required)", "", "| Criterion | Pre | Post | Delta | Cause | Approver | Date | Tag | Notes |", "|---|---:|---:|---:|---|---|---|---|---|");
    for (const r of diff.regressions) {
      const note =
        r.reason ||
        (String(r.volatility || "").trim().toUpperCase() === "DYNAMIC"
          ? "DYNAMIC: `rubric-tightened` (`D-RT`) valid only if external standard shifted."
          : "FIXED: requires explicit override (`OVRD-*`) or rollback.");
      lines.push(`| ${formatMdCodeSpan(r.id, true)} | ${escMdCell(r.pre)} | ${escMdCell(r.post)} | ${r.delta} | unresolved | null | ${date} | UNRESOLVED | ${escMdCell(note)} |`);
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

  // Round 32 (A4-L1): non-finite baselineTotal/currentTotal rejected by diffScorecards + total escaped in renderDiffMarkdown
  const r32BadTotalBase = {
    schema: "dsaf-scores/2",
    type: "system",
    engine_version: DIFF_VERSION,
    phases: { before: { total: "80 | evil\n| broken", grade: "L3" } },
    criteria: { before: { DS01: { score: 2, volatility: "FIXED" } } },
  };
  const r32GoodCur = makeDoc({ DS01: { score: 2, volatility: "FIXED" } }, DIFF_VERSION, []);
  assert.throws(() => diffScorecards(r32BadTotalBase, r32GoodCur, "before"), /Invalid baseline phase total/i);
  assert.throws(() => diffScorecards(r32GoodCur, { ...r32GoodCur, phases: { before: { total: Infinity, grade: "L3" } } }, "before"), /Invalid current phase total/i);
  const r32EscMd = renderDiffMarkdown({
    ...r28Diff,
    baselineTotal: "80 | evil\n| broken",
    currentTotal: "90 | ok",
  });
  const totalRow = r32EscMd.split("\n").find((l) => l.startsWith("| Total Score |"));
  assert.ok(totalRow && !totalRow.includes("\n"), "R32 A4-L1: Total Score row must not split across lines");
  assert.match(totalRow, /80 \\\| evil \\\| broken \| 90 \\\| ok/, "R32 A4-L1: pipes in totals must be escaped");

  // Round 33 (A4-L3 lowercase dynamic volatility normalization & A4-L4 profile/weights mismatch rejection)
  const r33VolDiff = diffScorecards(
    makeDoc({ DS01: { score: 2, volatility: " dynamic " } }, DIFF_VERSION, []),
    makeDoc({ DS01: { score: 1, volatility: "Dynamic" } }, DIFF_VERSION, []),
    "before"
  );
  assert.equal(r33VolDiff.regressions[0].volatility, "DYNAMIC", "R33 A4-L3: lowercase/padded volatility must normalize to DYNAMIC");
  assert.ok(renderDiffMarkdown(r33VolDiff).includes("DYNAMIC: `rubric-tightened`"));

  assert.throws(
    () =>
      diffScorecards(
        { ...makeDoc({ DS01: { score: 2 } }), profile: "balanced" },
        { ...makeDoc({ DS01: { score: 2 } }), profile: "strict" },
        "before"
      ),
    /profile/i,
    "R33 A4-L4: differing weight profiles must reject"
  );
  assert.throws(
    () =>
      diffScorecards(
        { ...makeDoc({ DS01: { score: 2 } }), weights: { P1: 40, P2: 20, P3: 20, P4: 20 } },
        { ...makeDoc({ DS01: { score: 2 } }), weights: { P1: 25, P2: 25, P3: 25, P4: 25 } },
        "before"
      ),
    /weights/i,
    "R33 A4-L4: differing pillar weights must reject"
  );

  // Round 34 (A4-L3 whitespace volatility normalization & A4-L4 non-array hard_floor_blockers rejection):
  const r34WsVol = diffScorecards(
    makeDoc({ DS01: { score: 2, volatility: "   " } }, DIFF_VERSION, []),
    makeDoc({ DS01: { score: 1, volatility: "DYNAMIC" } }, DIFF_VERSION, []),
    "before"
  );
  assert.equal(r34WsVol.regressions[0].volatility, "FIXED", "R34 A4-L3: whitespace-only baseline volatility must normalize to FIXED");

  assert.throws(
    () =>
      diffScorecards(
        makeDoc({ DS01: { score: 2 } }, DIFF_VERSION, []),
        { ...makeDoc({ DS01: { score: 2 } }, DIFF_VERSION, []), phases: { before: { total: 80, grade: "L4", hard_floor_blockers: "F-NEW" } } },
        "before"
      ),
    /Invalid current hard_floor_blockers/i,
    "R34 A4-L4: malformed string hard_floor_blockers must throw"
  );
  assert.throws(
    () =>
      diffScorecards(
        { ...makeDoc({ DS01: { score: 2 } }, DIFF_VERSION, []), phases: { before: { total: 80, grade: "L4", hard_floor_blockers: {} } } },
        makeDoc({ DS01: { score: 2 } }, DIFF_VERSION, []),
        "before"
      ),
    /Invalid baseline hard_floor_blockers/i,
    "R34 A4-L4: malformed object hard_floor_blockers must throw"
  );

  // Round 36 (R35-A4-M2 invalid type/weights/profile, R35-A4-L1 out-of-range scores, extra curCriteria validation, zero-to-N/A delta):
  assert.throws(
    () => diffScorecards({ ...makeDoc({ DS01: { score: 2 } }), type: undefined }, { ...makeDoc({ DS01: { score: 2 } }), type: undefined }),
    /Invalid baseline audit type/i
  );
  assert.throws(
    () => diffScorecards({ ...makeDoc({ DS01: { score: 2 } }), weights: { P1: 100 } }, { ...makeDoc({ DS01: { score: 2 } }), weights: [] }),
    /Invalid current weights/i
  );
  assert.throws(
    () => diffScorecards({ ...makeDoc({ DS01: { score: 2 } }), profile: ["balanced"] }, makeDoc({ DS01: { score: 2 } })),
    /Invalid baseline profile/i
  );
  for (const badScore of [-5, 99, 1.5]) {
    assert.throws(() => diffScorecards(makeDoc({ DS01: { score: badScore } }), makeDoc({ DS01: { score: 2 } })), /Invalid baseline score/i);
  }
  assert.throws(
    () => diffScorecards(makeDoc({ DS01: { score: 2 } }), makeDoc({ DS01: { score: 2 }, EXTRA: null })),
    /Invalid current score/i
  );
  const zeroToNa = diffScorecards(makeDoc({ DS01: { score: 0 } }), makeDoc({ DS01: { score: "N/A" } }));
  assert.ok(Object.is(zeroToNa.regressions[0].delta, 0), "R36 A4-L1: 0 -> N/A regression delta must be signed +0 rather than -0");

  // Round 39 (R38-A4-L2 reject invalid volatility strings and non-strings while keeping whitespace->FIXED):
  for (const badVol of ["BOGUS", "maybe", 123, {}]) {
    assert.throws(
      () => diffScorecards(makeDoc({ DS01: { score: 2, volatility: badVol } }), makeDoc({ DS01: { score: 1 } })),
      /Invalid baseline volatility/i
    );
    assert.throws(
      () => diffScorecards(makeDoc({ DS01: { score: 2, volatility: "FIXED" } }), makeDoc({ DS01: { score: 1, volatility: badVol } })),
      /Invalid current volatility/i
    );
  }

  // Round 40 (R39-A4-M2 Markdown backslash-before-pipe, standalone CR, and multi-backtick code-span fencing):
  const r40Md = renderDiffMarkdown({
    ...r28Diff,
    type: "system`test",
    baselineGrade: "A\\|B\rNext",
    currentGrade: "C\\|D\r\nRow",
    improvements: [{ id: "U`01\\|x\rline", pre: "0", post: "2", delta: 1.5 }],
    regressions: [{ id: "DS``02\\|y\rrow", pre: "2", post: "1", delta: -1, volatility: "DYNAMIC" }],
  });
  for (const line of r40Md.split("\n").filter((l) => l.startsWith("|"))) {
    assert.equal(line.includes("\r"), false, "Table rows must not contain raw carriage returns");
  }
  const r40ImpRow = r40Md.split("\n").find((l) => l.includes("U`01"));
  assert.ok(r40ImpRow && r40ImpRow.includes("``U`01\\\\\\|x line``"), `Improvement ID must use multi-backtick fence and escaped \\\\|: ${r40ImpRow}`);
  const r40RegRow = r40Md.split("\n").find((l) => l.includes("DS``02"));
  assert.ok(r40RegRow && r40RegRow.includes("```DS``02\\\\\\|y row```"), `Regression ID must use 3-backtick fence and escaped \\\\|: ${r40RegRow}`);
  const r40GradeRow = r40Md.split("\n").find((l) => l.startsWith("| Grade / Maturity |"));
  assert.ok(r40GradeRow && r40GradeRow.includes("A\\\\\\|B Next") && r40GradeRow.includes("C\\\\\\|D Row"), `Grade row must escape \\| and CR: ${r40GradeRow}`);

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

#!/usr/bin/env node
/**
 * DSAF v0.3.0 — Two-Channel Closed-Loop Evolution Miner (Node ESM, zero external deps).
 * Channel 1: Reads domain-stripped retro records (~/.dsaf/feedback-log.jsonl), validates schema,
 *            rejects URL/PII/filesystem leaks, and clusters hypotheses by severity weight.
 * Channel 2: Scans calibration scorecard outputs (`dsaf-scores/2` JSONs) to surface
 *            dead criteria (0 everywhere), saturated criteria (100 everywhere), and band imbalance.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REQUIRED_FIELDS = [
  "id",
  "timestamp",
  "skill_version",
  "mode",
  "round",
  "language",
  "product_archetype",
  "ui_maturity",
  "data_tier",
  "category",
  "severity",
  "symptom",
  "root_cause_pointer",
  "candidate_hypothesis",
  "affected_artifact",
];

const ALLOWED_MODES = new Set(["system", "conformance", "product"]);
const ALLOWED_ROUNDS = new Set(["preflight", "system", "conformance", "usability", "visual", "full", "handoff"]);
const ALLOWED_LANGS = new Set(["en", "vi", "other"]);
const ALLOWED_MATURITY = new Set(["tier_1_crude", "tier_2_baseline", "tier_3_mature", "unknown"]);
const ALLOWED_TIERS = new Set(["tier_0_readonly", "tier_1_staging", "tier_2_sandbox", "tier_3_branch", "unknown"]);
const ALLOWED_CATEGORIES = new Set([
  "false_positive",
  "false_negative",
  "ds_drift_signal",
  "ambition_gap",
  "depth_or_persona_gap",
  "process_or_safety_friction",
  "design_taste_signal",
]);
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

const LEAK_PATTERNS = [
  /https?:\/\//i,
  /\/(Users|home)\/[A-Za-z0-9._-]+\//,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b[A-Za-z0-9_-]{3,}\.(internal|local|corp)\b/i,
];

export class FeedbackError extends Error {}

export function validateRecord(rec, lineNo, extraBlocklist = []) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    throw new FeedbackError(`Line ${lineNo}: expected JSON object.`);
  }
  const keys = Object.keys(rec);
  const missing = REQUIRED_FIELDS.filter((f) => !(f in rec));
  const extra = keys.filter((k) => !REQUIRED_FIELDS.includes(k));
  if (missing.length > 0) throw new FeedbackError(`Line ${lineNo}: missing fields ${missing.join(", ")}`);
  if (extra.length > 0) throw new FeedbackError(`Line ${lineNo}: unexpected fields ${extra.join(", ")}`);

  if (!/^FB-[0-9]{8}-[0-9]{3,}$/.test(String(rec.id))) throw new FeedbackError(`Line ${lineNo}: invalid id '${rec.id}'`);
  if (!ALLOWED_MODES.has(rec.mode)) throw new FeedbackError(`Line ${lineNo}: invalid mode '${rec.mode}'`);
  if (!ALLOWED_ROUNDS.has(rec.round)) throw new FeedbackError(`Line ${lineNo}: invalid round '${rec.round}'`);
  if (!ALLOWED_LANGS.has(rec.language)) throw new FeedbackError(`Line ${lineNo}: invalid language '${rec.language}'`);
  if (!ALLOWED_MATURITY.has(rec.ui_maturity)) throw new FeedbackError(`Line ${lineNo}: invalid ui_maturity '${rec.ui_maturity}'`);
  if (!ALLOWED_TIERS.has(rec.data_tier)) throw new FeedbackError(`Line ${lineNo}: invalid data_tier '${rec.data_tier}'`);
  if (!ALLOWED_CATEGORIES.has(rec.category)) throw new FeedbackError(`Line ${lineNo}: invalid category '${rec.category}'`);
  if (!(rec.severity in SEVERITY_WEIGHT)) throw new FeedbackError(`Line ${lineNo}: invalid severity '${rec.severity}'`);

  const serialized = JSON.stringify(rec);
  for (const pat of LEAK_PATTERNS) {
    const m = pat.exec(serialized);
    if (m) throw new FeedbackError(`Line ${lineNo} (${rec.id}): potential URL/path/PII leak matched '${m[0]}'`);
  }
  for (const term of extraBlocklist) {
    if (term && serialized.toLowerCase().includes(term.toLowerCase())) {
      throw new FeedbackError(`Line ${lineNo} (${rec.id}): blocked domain term matched '${term}'`);
    }
  }
}

export function loadFeedbackRecords(filePath, extraBlocklist = []) {
  const lines = readFileSync(resolve(filePath), "utf8").split(/\r?\n/);
  const records = [];
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new FeedbackError(`Line ${lineNo}: invalid JSON (${err.message})`);
    }
    validateRecord(obj, lineNo, extraBlocklist);
    records.push(obj);
  });
  return records;
}

export function mineFeedback(records) {
  const buckets = new Map();
  for (const r of records) {
    const key = `${r.category}|${r.mode}|${r.round}|${r.affected_artifact}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const clusters = [];
  for (const items of buckets.values()) {
    const priorityScore = items.reduce((s, x) => s + SEVERITY_WEIGHT[x.severity], 0);
    const highCount = items.filter((x) => x.severity === "high").length;
    clusters.push({
      category: items[0].category,
      mode: items[0].mode,
      round: items[0].round,
      affected_artifact: items[0].affected_artifact,
      count: items.length,
      high_severity_count: highCount,
      priority_score: priorityScore,
      languages: [...new Set(items.map((x) => x.language))].sort(),
      archetypes: [...new Set(items.map((x) => x.product_archetype))].sort(),
      signal_ids: items.map((x) => x.id),
      candidate_hypotheses: [...new Set(items.map((x) => x.candidate_hypothesis.trim()))],
      ready_for_atomic_experiment: items.length >= 2 || highCount >= 1,
    });
  }
  clusters.sort((a, b) => b.priority_score - a.priority_score || b.count - a.count || a.category.localeCompare(b.category));
  return { total_signals: records.length, cluster_count: clusters.length, clusters };
}

function collectScoreJsonFiles(dir) {
  const out = [];
  if (!dir || !existsSync(resolve(dir))) return out;
  function walk(cur) {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) out.push(full);
    }
  }
  walk(resolve(dir));
  return out;
}

export function mineCalibrationScores(scoresDir) {
  const files = collectScoreJsonFiles(scoresDir);
  const byCriterion = new Map();
  let cases = 0;

  for (const file of files) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (payload?.schema !== "dsaf-scores/2" || !payload.criteria?.before) continue;
    cases++;
    for (const [cid, entry] of Object.entries(payload.criteria.before)) {
      if (entry.score === "N/A") continue;
      if (!byCriterion.has(cid)) byCriterion.set(cid, { scores: [], proseOnlyCount: 0, cases: 0 });
      const b = byCriterion.get(cid);
      b.scores.push(entry.score);
      if (entry.bands && entry.bands.artifacts === 0 && entry.bands.verification === 0) b.proseOnlyCount++;
      b.cases++;
    }
  }

  const deadCriteria = [];
  const saturatedCriteria = [];
  const bandImbalance = [];
  for (const [id, b] of [...byCriterion.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const maxS = Math.max(...b.scores);
    const minS = Math.min(...b.scores);
    if (maxS === 0) deadCriteria.push({ id, cases: b.cases });
    if (minS === 2 && b.cases >= 3) saturatedCriteria.push({ id, cases: b.cases });
    if (b.proseOnlyCount === b.cases && b.cases >= 2) bandImbalance.push({ id, cases: b.cases });
  }
  return { casesScanned: cases, deadCriteria, saturatedCriteria, bandImbalance };
}

function renderMarkdown(feedbackReport, corpusReport) {
  const lines = ["# DSAF Evolution Backlog (Human-Gated)", ""];
  if (feedbackReport) {
    lines.push(
      `- **Field Signals Scanned:** ${feedbackReport.total_signals}`,
      `- **Distinct Hypothesis Clusters:** ${feedbackReport.cluster_count}`,
      "",
      "> Pick **at most ONE** hypothesis cluster per evolution cycle and validate it via blind A/B gates before modifying releases.",
      "",
      "| Rank | Priority | Signals | Category | Mode | Round | Artifact | Ready? | Candidate Hypothesis |",
      "|---|---|---|---|---|---|---|---|---|"
    );
    feedbackReport.clusters.forEach((c, i) => {
      const topH = c.candidate_hypotheses[0].replace(/\|/g, "/");
      lines.push(
        `| #${i + 1} | **${c.priority_score}** (${c.high_severity_count} high) | ${c.count} (\`${c.signal_ids.join(", ")}\`) | \`${c.category}\` | \`${c.mode}\` | \`${c.round}\` | \`${c.affected_artifact}\` | ${c.ready_for_atomic_experiment ? "YES" : "Monitor"} | ${topH} |`
      );
    });
    lines.push("");
  }
  if (corpusReport) {
    lines.push(
      "## Calibration Corpus Mining",
      "",
      `- **Scorecards Mined:** ${corpusReport.casesScanned}`,
      `- **Dead Criteria (score 0 across corpus):** ${corpusReport.deadCriteria.map((x) => x.id).join(", ") || "none"}`,
      `- **Saturated Criteria (score 2 across >= 3 runs):** ${corpusReport.saturatedCriteria.map((x) => x.id).join(", ") || "none"}`,
      `- **Prose-Only Band Imbalance Criteria:** ${corpusReport.bandImbalance.map((x) => x.id).join(", ") || "none"}`,
      ""
    );
  }
  return lines.join("\n");
}

function runSelfTest() {
  const sample = [
    {
      id: "FB-20261126-001",
      timestamp: "2026-11-26T08:00:00Z",
      skill_version: "0.0.1",
      mode: "conformance",
      round: "visual",
      language: "en",
      product_archetype: "b2b_saas",
      ui_maturity: "tier_2_baseline",
      data_tier: "tier_2_sandbox",
      category: "ds_drift_signal",
      severity: "high",
      symptom: "Inline hex checks missed @theme CSS definitions during token drift measurement.",
      root_cause_pointer: "extractNonTokenDeclarations only matched :root selectors.",
      candidate_hypothesis: "Skip @theme declaration blocks when counting hardcoded style drift.",
      affected_artifact: "audit-tokens.mjs",
    },
  ];
  validateRecord(sample[0], 1);
  const mined = mineFeedback(sample);
  assert.equal(mined.total_signals, 1);
  assert.equal(mined.clusters[0].ready_for_atomic_experiment, true);

  assert.throws(() => validateRecord({ ...sample[0], symptom: ["Visited https://private.corp.example", " and leaked url"].join("") }, 1), FeedbackError);
  assert.throws(() => validateRecord({ ...sample[0], symptom: ["Read ", "/", "Users/alice/secret/app.tsx directly"].join("") }, 1), FeedbackError);

  const scratch = mkdtempSync(join(tmpdir(), "dsaf-mine-test-"));
  try {
    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        join(scratch, `case-${i}.json`),
        JSON.stringify({
          schema: "dsaf-scores/2",
          criteria: { before: { DS01: { score: 0, bands: { prose: 10, artifacts: 0, verification: 0 } }, DS02: { score: 2, bands: { prose: 20, artifacts: 30, verification: 15 } } } },
        })
      );
    }
    const corpus = mineCalibrationScores(scratch);
    assert.equal(corpus.casesScanned, 3);
    assert.equal(corpus.deadCriteria[0].id, "DS01");
    assert.equal(corpus.saturatedCriteria[0].id, "DS02");
    assert.equal(corpus.bandImbalance[0].id, "DS01");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("MINE_SIGNALS_SELF_TEST_PASSED (retro schema + leak guard + calibration mining)");
  return 0;
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      "scores-dir": { type: "string" },
      blocklist: { type: "string", default: "" },
      format: { type: "string", default: "markdown" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node evolve/scripts/mine-signals.mjs [--input ~/.dsaf/feedback-log.jsonl] [--scores-dir <dir>] [--blocklist a,b] [--format markdown|json] [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  const blocklist = String(values.blocklist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let feedbackReport = null;
  if (values.input) {
    if (!existsSync(resolve(values.input))) {
      console.log(`No feedback log found at ${values.input}.`);
    } else {
      feedbackReport = mineFeedback(loadFeedbackRecords(values.input, blocklist));
    }
  }
  const corpusReport = values["scores-dir"] ? mineCalibrationScores(values["scores-dir"]) : null;
  if (!feedbackReport && !corpusReport) {
    console.error("Provide --input, --scores-dir, or --self-test.");
    process.exit(2);
  }

  if (values.format === "json") {
    console.log(JSON.stringify({ feedback: feedbackReport, calibration: corpusReport }, null, 2));
  } else {
    process.stdout.write(renderMarkdown(feedbackReport, corpusReport));
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntry) main();

#!/usr/bin/env node
/**
 * DSAF v0.4.0 — Deterministic Weighted Scorecard Calculator & Validator (Node ESM).
 * Zero external dependencies. Supports three audit types under schema `dsaf-scores/2`:
 * - `usability` (U01..U18, 6 pillars, Hard Floor)
 * - `visual`    (V01..V11, 6 pillars, Hard Floor)
 * - `system`    (DS01..DS12, 4 pillars, 3-band prose cap <= 40%, Maturity L0-L5, FIXED/DYNAMIC)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isBoilerplateReason } from "./ci-report.mjs";

export const ENGINE_VERSION = "0.4.0";

const USABILITY_PILLARS = [
  ["P1", "Onboarding & Value Clarity", ["U01", "U02", "U03"]],
  ["P2", "IA, Navigation & Mental Model", ["U04", "U05", "U06"]],
  ["P3", "Efficiency & Laws of UX", ["U07", "U08", "U09"]],
  ["P4", "Feedback, Errors & Recovery", ["U10", "U11", "U12", "U13"]],
  ["P5", "Consistency, Content & Trust", ["U14", "U15", "U16", "U17"]],
  ["P6", "WCAG 2.2 AA Accessibility (Hard Floor)", ["U18"]],
];

const VISUAL_PILLARS = [
  ["P1", "Hierarchy & 3-Second Focal Clarity", ["V01", "V02"]],
  ["P2", "Typography & Reading Rhythm", ["V03"]],
  ["P3", "Color, WCAG & APCA (Hard Floor)", ["V04", "V05"]],
  ["P4", "Grid, Spacing & Alignment", ["V06", "V07"]],
  ["P5", "Brand Craft, Anti-Slop & Motion", ["V08", "V09"]],
  ["P6", "3-Tier Design System & Resilience", ["V10", "V11"]],
];

const SYSTEM_PILLARS = [
  ["P1", "Foundations & Token Architecture", ["DS01", "DS02", "DS03"]],
  ["P2", "Component Architecture & Accessibility", ["DS04", "DS05", "DS06"]],
  ["P3", "Product Conformance & Drift", ["DS07", "DS08", "DS09"]],
  ["P4", "Governance, DX & AI Readiness", ["DS10", "DS11", "DS12"]],
];

const SYSTEM_VOLATILITY = {
  DS01: "FIXED",
  DS02: "DYNAMIC",
  DS03: "DYNAMIC",
  DS04: "FIXED",
  DS05: "FIXED",
  DS06: "FIXED",
  DS07: "FIXED",
  DS08: "FIXED",
  DS09: "FIXED",
  DS10: "FIXED",
  DS11: "FIXED",
  DS12: "DYNAMIC",
};

const WEIGHT_PRESETS = {
  usability: {
    dev_b2b: { P1: 10, P2: 20, P3: 25, P4: 20, P5: 10, P6: 15 },
    consumer_mobile: { P1: 20, P2: 15, P3: 20, P4: 15, P5: 15, P6: 15 },
    commerce_forms: { P1: 15, P2: 15, P3: 20, P4: 25, P5: 10, P6: 15 },
    content_docs: { P1: 15, P2: 25, P3: 15, P4: 10, P5: 20, P6: 15 },
    balanced: { P1: 15, P2: 18, P3: 20, P4: 18, P5: 14, P6: 15 },
  },
  visual: {
    dev_b2b: { P1: 20, P2: 20, P3: 18, P4: 20, P5: 10, P6: 12 },
    consumer_brand: { P1: 20, P2: 15, P3: 18, P4: 17, P5: 20, P6: 10 },
    content_docs: { P1: 18, P2: 27, P3: 18, P4: 15, P5: 10, P6: 12 },
    balanced: { P1: 18, P2: 18, P3: 18, P4: 18, P5: 14, P6: 14 },
  },
  system: {
    ds_core: { P1: 30, P2: 30, P3: 20, P4: 20 },
    product_conformance: { P1: 20, P2: 25, P3: 35, P4: 20 },
    balanced: { P1: 25, P2: 25, P3: 25, P4: 25 },
  },
};

const ALLOWED_SEVERITIES = new Set(["blocker", "major", "moderate", "minor"]);

export class ScorecardError extends Error {}

export function getSchema(auditType) {
  if (auditType === "usability") return { pillars: USABILITY_PILLARS, presets: WEIGHT_PRESETS.usability };
  if (auditType === "visual") return { pillars: VISUAL_PILLARS, presets: WEIGHT_PRESETS.visual };
  if (auditType === "system") return { pillars: SYSTEM_PILLARS, presets: WEIGHT_PRESETS.system };
  throw new ScorecardError(`Invalid audit type '${auditType}'. Expected 'usability', 'visual', or 'system'.`);
}

function resolveWeights(pillars, presets, profile, customWeights) {
  const weights = customWeights ? Object.fromEntries(Object.entries(customWeights).map(([k, v]) => [k, Number(v)])) : { ...(presets[profile || "balanced"] ?? {}) };
  const name = customWeights ? profile || "custom" : profile || "balanced";
  if (!customWeights && !presets[name]) {
    throw new ScorecardError(`Unknown weight profile '${name}'. Available: ${Object.keys(presets).sort().join(", ")}`);
  }
  const expected = new Set(pillars.map(([pid]) => pid));
  const actual = new Set(Object.keys(weights));
  if (expected.size !== actual.size || [...expected].some((k) => !actual.has(k))) {
    throw new ScorecardError(`Weights must define exact pillars ${[...expected].join(", ")}; got ${[...actual].join(", ")}`);
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-6) throw new ScorecardError(`Pillar weights must sum strictly to 100; got ${sum}`);
  if (Object.values(weights).some((v) => !Number.isFinite(v) || v < 0)) throw new ScorecardError("Pillar weights must be non-negative numbers.");
  return { profileName: name, weights };
}

function parseFindingSeverities(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ScorecardError("'finding_severities' must map Finding ID -> severity.");
  const out = {};
  for (const [fid, sev] of Object.entries(raw)) {
    const id = String(fid).trim();
    const s = String(sev).trim().toLowerCase();
    if (!id) throw new ScorecardError("Finding IDs in 'finding_severities' must be non-empty.");
    if (!ALLOWED_SEVERITIES.has(s)) throw new ScorecardError(`Invalid severity '${sev}' for ${id}.`);
    out[id] = s;
  }
  return out;
}

function validateBands(phaseName, cid, bands, score) {
  if (bands == null) return null;
  if (typeof bands !== "object" || Array.isArray(bands)) throw new ScorecardError(`${phaseName}.${cid}.bands must be an object.`);
  const prose = Number(bands.prose ?? 0);
  const artifacts = Number(bands.artifacts ?? 0);
  const verification = Number(bands.verification ?? 0);
  if (prose < 0 || prose > 40 || artifacts < 0 || artifacts > 40 || verification < 0 || verification > 20) {
    throw new ScorecardError(`${phaseName}.${cid}.bands out of bounds (prose<=40, artifacts<=40, verification<=20).`);
  }
  if (score === 2 && artifacts === 0 && verification === 0) {
    throw new ScorecardError(`${phaseName}.${cid} has score 2 from prose alone (artifacts=0, verification=0). 3-band cap restricts prose-only evidence to <= 1.`);
  }
  return { prose, artifacts, verification };
}

function validatePhaseScores(auditType, phaseName, scores, validIds, findingSeverities, requireAll) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new ScorecardError(`Phase '${phaseName}' must be a criterion score object.`);
  }
  const validSet = new Set(validIds);
  const unknown = Object.keys(scores).filter((k) => !validSet.has(k));
  if (unknown.length > 0) throw new ScorecardError(`Phase '${phaseName}' contains unknown criterion IDs: ${unknown.join(", ")}`);
  if (requireAll) {
    const missing = validIds.filter((k) => !(k in scores));
    if (missing.length > 0) throw new ScorecardError(`Phase '${phaseName}' is missing criteria: ${missing.join(", ")}`);
  }

  const normalized = {};
  for (const [cid, entry] of Object.entries(scores)) {
    if (!entry || typeof entry !== "object" || !("score" in entry)) {
      throw new ScorecardError(`${phaseName}.${cid} must be an object with 'score'.`);
    }
    const raw = entry.score;
    const volatility = entry.volatility || SYSTEM_VOLATILITY[cid] || "FIXED";
    if (typeof raw === "string" && raw.trim().toUpperCase() === "N/A") {
      const reason = String(entry.reason ?? "").trim();
      if (!reason) throw new ScorecardError(`${phaseName}.${cid} is 'N/A' without a non-empty 'reason'.`);
      normalized[cid] = { score: "N/A", findings: [], reason, secondary_impact: false, volatility, bands: null, check_type: entry.check_type || null };
      continue;
    }
    if (typeof raw === "boolean" || (raw !== 0 && raw !== 1 && raw !== 2)) {
      throw new ScorecardError(`${phaseName}.${cid} score must be 0, 1, 2, or 'N/A'; got ${JSON.stringify(raw)}`);
    }
    const findings = Array.isArray(entry.findings) ? entry.findings.map((x) => String(x).trim()).filter(Boolean) : null;
    if (!findings || (Array.isArray(entry.findings) && findings.length !== entry.findings.length)) {
      throw new ScorecardError(`${phaseName}.${cid}.findings must be an array of non-empty strings.`);
    }
    if (raw < 2 && findings.length === 0) {
      throw new ScorecardError(`${phaseName}.${cid} has score ${raw} (< 2) without linked Finding IDs.`);
    }
    const secondary = Boolean(entry.secondary_impact);
    if (raw > 0 && !secondary) {
      const blockerHits = findings.filter((fid) => findingSeverities[fid] === "blocker");
      if (blockerHits.length > 0) {
        throw new ScorecardError(`${phaseName}.${cid} links Blocker ${blockerHits.join(", ")} with score ${raw} (> 0) without 'secondary_impact: true'.`);
      }
    }
    const bands = auditType === "system" ? validateBands(phaseName, cid, entry.bands, raw) : null;
    normalized[cid] = {
      score: raw,
      findings,
      reason: String(entry.reason ?? "").trim(),
      secondary_impact: secondary,
      volatility,
      bands,
      check_type: entry.check_type || null,
    };
  }
  return normalized;
}

function validateCrossPhaseConsistency(phaseName, beforeScores, afterScores, allowedNewFindings) {
  const beforeFids = new Set(Object.values(beforeScores).flatMap((e) => e.findings));
  const afterFids = new Set(Object.values(afterScores).flatMap((e) => e.findings));
  const invented = [...afterFids].filter((fid) => !beforeFids.has(fid) && !allowedNewFindings.has(fid));
  if (invented.length > 0) {
    throw new ScorecardError(`${phaseName} cites unknown Finding ID(s) ${invented.join(", ")} absent from 'before' (and not in 'new_findings').`);
  }
  for (const fid of [...afterFids].filter((x) => beforeFids.has(x))) {
    for (const [cid, be] of Object.entries(beforeScores)) {
      if (!be.findings.includes(fid)) continue;
      const ae = afterScores[cid];
      if (ae.score !== "N/A" && !ae.findings.includes(fid) && !ae.reason) {
        throw new ScorecardError(`${phaseName}.${cid} silently dropped unfixed '${fid}' without resolving it or supplying a 'reason'.`);
      }
    }
  }
}

function gradeFor(auditType, total, blockers) {
  if (total == null) return "Insufficient Data";
  if (blockers.length > 0) return `Hard Floor Capped — Remediation Required (${blockers.join(", ")})`;
  if (auditType === "system") {
    if (total >= 90) return "L5 — Optimizing & Agent-Ready (External verification required for public L4/L5)";
    if (total >= 75) return "L4 — Measured & Enforced (Caps at L3 for unverified self-audits)";
    if (total >= 60) return "L3 — Built & Shipped";
    if (total >= 40) return "L2 — Defined Baseline";
    if (total >= 20) return "L1 — Documented / Mentioned";
    return "L0 — Ad-Hoc";
  }
  if (total >= 90) return "Grade A — Excellent / Production-Ready";
  if (total >= 75) return "Grade B — Good / Targeted Upgrades";
  if (total >= 60) return "Grade C — Fair / Noticeable Friction";
  if (total >= 40) return "Grade D — Weak / Needs Restructuring";
  return "Grade F — Critical / Redesign Recommended";
}

function evaluatePhase(auditType, pillars, weights, scores, blockers) {
  const pillarResults = [];
  let scoredWeightSum = 0;
  let weightedPointsSum = 0;

  for (const [pid, name, cids] of pillars) {
    const w = weights[pid];
    const numeric = cids.map((cid) => scores[cid].score).filter((s) => s !== "N/A");
    const maxRaw = 2 * numeric.length;
    const rawSum = numeric.reduce((a, b) => a + b, 0);
    const pct = maxRaw > 0 ? Number(((rawSum / maxRaw) * 100).toFixed(2)) : null;
    const contrib = maxRaw > 0 ? Number(((rawSum / maxRaw) * w).toFixed(2)) : null;
    if (maxRaw > 0) {
      scoredWeightSum += w;
      weightedPointsSum += (rawSum / maxRaw) * w;
    }
    pillarResults.push({ id: pid, name, weight: w, scored_criteria: numeric.length, total_criteria: cids.length, raw_sum: rawSum, max_raw: maxRaw, pct, weighted_points: contrib });
  }

  const normFactor = scoredWeightSum > 0 ? 100 / scoredWeightSum : 0;
  const criterionUnitPoints = {};
  for (let i = 0; i < pillars.length; i++) {
    const [, , cids] = pillars[i];
    const p = pillarResults[i];
    const exactStep = p.max_raw > 0 ? (p.weight / p.max_raw) * normFactor : null;
    const ptsPerStep = exactStep != null ? Number(exactStep.toFixed(2)) : null;
    p.pts_per_step = ptsPerStep;
    for (const cid of cids) {
      criterionUnitPoints[cid] = scores[cid].score === "N/A" ? { exact_step: null, pts_per_step: null, max_pts: null } : { exact_step: exactStep, pts_per_step: ptsPerStep, max_pts: Number((2 * exactStep).toFixed(2)) };
    }
  }

  const total = scoredWeightSum > 0 ? Number((weightedPointsSum * normFactor).toFixed(2)) : null;
  return {
    pillars: pillarResults,
    scored_weight_sum: Number(scoredWeightSum.toFixed(2)),
    total,
    hard_floor_blockers: blockers,
    grade: gradeFor(auditType, total, blockers),
    criterion_unit_points: criterionUnitPoints,
  };
}

function validateWaivers(rawWaivers) {
  if (rawWaivers == null) return [];
  if (!Array.isArray(rawWaivers)) throw new ScorecardError("'waivers' must be an array of { id, tier, reason, guard } entries.");
  const out = [];
  for (const w of rawWaivers) {
    if (!w || typeof w !== "object") throw new ScorecardError("Each waiver entry must be an object.");
    const id = String(w.id || w.ruleId || "").trim();
    const tier = String(w.tier || "reflex").trim().toLowerCase();
    const reason = String(w.reason || "").trim();
    if (!id) throw new ScorecardError("Waiver entry missing 'id' / 'ruleId'.");
    if (tier === "floor") throw new ScorecardError(`Waiver '${id}' rejected: Floor rules are never waivable.`);
    if (isBoilerplateReason(reason)) {
      throw new ScorecardError(`Waiver '${id}' rejected: Reflex waiver requires a concrete reason (>= 12 chars, non-boilerplate).`);
    }
    out.push({ id, tier, reason, guard: String(w.guard || "").trim() || null });
  }
  return out;
}

function validateProvenance(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ScorecardError("'review_provenance' must be an object.");
  const method = String(raw.method || "").trim().toLowerCase();
  if (method !== "dual-agent" && method !== "single-context") {
    throw new ScorecardError("'review_provenance.method' must be 'dual-agent' or 'single-context'.");
  }
  const reason = String(raw.reason || "").trim() || null;
  if (method === "single-context" && !reason) {
    throw new ScorecardError("'single-context' review_provenance requires a non-empty 'reason'.");
  }
  return {
    method,
    reason,
    agent_a: raw.agent_a ? String(raw.agent_a) : null,
    agent_b: raw.agent_b ? String(raw.agent_b) : null,
  };
}

export function compute(payload) {
  const auditType = payload?.type;
  const { pillars, presets } = getSchema(auditType);
  const validIds = pillars.flatMap(([, , cids]) => cids);
  const { profileName, weights } = resolveWeights(pillars, presets, payload.profile, payload.custom_weights);
  const findingSeverities = parseFindingSeverities(payload.finding_severities);
  const waivers = validateWaivers(payload.waivers);
  const reviewProvenance = validateProvenance(payload.review_provenance);
  const allowedNewFindings = new Set((payload.new_findings || []).map((x) => String(x).trim()).filter(Boolean));
  if (!payload.before) throw new ScorecardError("Input JSON must include 'before'.");

  const beforeScores = validatePhaseScores(auditType, "before", payload.before, validIds, findingSeverities, true);
  const blockersMap = payload.hard_floor_blockers || {};
  const getBlockers = (k) => (Array.isArray(blockersMap[k]) ? blockersMap[k].map((x) => String(x).trim()) : []);

  const phases = { before: evaluatePhase(auditType, pillars, weights, beforeScores, getBlockers("before")) };
  const mergedScores = { before: beforeScores };

  for (const key of ["after_track_a", "after_track_b"]) {
    if (payload[key] && Object.keys(payload[key]).length > 0) {
      const overrides = validatePhaseScores(auditType, key, payload[key], validIds, findingSeverities, false);
      const merged = { ...beforeScores, ...overrides };
      validateCrossPhaseConsistency(key, beforeScores, merged, allowedNewFindings);
      mergedScores[key] = merged;
      phases[key] = evaluatePhase(auditType, pillars, weights, merged, getBlockers(key));
    }
  }

  const deltas = {};
  const criterionDeltas = {};
  const baseTotal = phases.before.total;
  const unitPts = phases.before.criterion_unit_points;
  for (const key of ["after_track_a", "after_track_b"]) {
    if (phases[key] && baseTotal != null && phases[key].total != null) {
      deltas[key] = Number((phases[key].total - baseTotal).toFixed(2));
      const cmap = {};
      for (const cid of validIds) {
        const bs = beforeScores[cid].score;
        const as = mergedScores[key][cid].score;
        const exact = unitPts[cid].exact_step;
        cmap[cid] = bs === "N/A" || as === "N/A" || exact == null ? null : Number(((as - bs) * exact).toFixed(2));
      }
      criterionDeltas[key] = cmap;
    }
  }

  return {
    schema: "dsaf-scores/2",
    engine_version: ENGINE_VERSION,
    generated: new Date().toISOString(),
    type: auditType,
    profile: profileName,
    weights,
    review_provenance: reviewProvenance,
    waivers,
    phases,
    deltas,
    criterion_deltas: criterionDeltas,
    criteria: mergedScores,
  };
}

export function renderMarkdown(res) {
  const hasA = Boolean(res.phases.after_track_a);
  const hasB = Boolean(res.phases.after_track_b);
  const lines = [`### Deterministic Weighted Scorecard (${res.type.toUpperCase()} · Profile: \`${res.profile}\`)`, ""];
  if (res.review_provenance) {
    const p = res.review_provenance;
    if (p.method === "single-context") {
      lines.push(`> ⚠️ DEGRADED: single-context (${p.reason})`, "");
    } else {
      lines.push(`> Method: dual-agent${p.agent_a || p.agent_b ? ` (A: ${p.agent_a || "visual"} · B: ${p.agent_b || "probes"})` : ""}`, "");
    }
  }
  const hdr = ["Pillar", "Weight", "Pts/Step (+1)", "Before"];
  if (hasA) hdr.push("Track A (Pragmatic)");
  if (hasB) hdr.push("Track B (North-Star)");
  lines.push(`| ${hdr.join(" | ")} |`, `|${hdr.map(() => "---").join("|")}|`);

  const fmtP = (p) => (p.pct == null ? "N/A" : `${p.weighted_points.toFixed(2)} / ${p.weight.toFixed(0)} (${p.pct.toFixed(1)}%)`);
  res.phases.before.pillars.forEach((bp, idx) => {
    const row = [`**${bp.id} — ${bp.name}**`, `${bp.weight.toFixed(0)}%`, bp.pts_per_step != null ? `+${bp.pts_per_step.toFixed(2)}` : "N/A", fmtP(bp)];
    if (hasA) row.push(fmtP(res.phases.after_track_a.pillars[idx]));
    if (hasB) row.push(fmtP(res.phases.after_track_b.pillars[idx]));
    lines.push(`| ${row.join(" | ")} |`);
  });

  const totRow = ["**TOTAL (0–100)**", "**100%**", "—", `**${res.phases.before.total?.toFixed(2) ?? "N/A"}**`];
  if (hasA) totRow.push(`**${res.phases.after_track_a.total?.toFixed(2)}** (${res.deltas.after_track_a >= 0 ? "+" : ""}${res.deltas.after_track_a.toFixed(2)})`);
  if (hasB) totRow.push(`**${res.phases.after_track_b.total?.toFixed(2)}** (${res.deltas.after_track_b >= 0 ? "+" : ""}${res.deltas.after_track_b.toFixed(2)})`);
  lines.push(`| ${totRow.join(" | ")} |`);

  const gradeRow = ["**Grade / Maturity**", "—", "—", res.phases.before.grade];
  if (hasA) gradeRow.push(res.phases.after_track_a.grade);
  if (hasB) gradeRow.push(res.phases.after_track_b.grade);
  lines.push(`| ${gradeRow.join(" | ")} |`, "");
  return lines.join("\n") + "\n";
}

function runSelfTest() {
  // 1. Weights sum check
  for (const t of ["usability", "visual", "system"]) {
    const { presets } = getSchema(t);
    for (const [k, w] of Object.entries(presets)) {
      const s = Object.values(w).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(s - 100) < 1e-6, `${t}.${k} sums to ${s}`);
    }
  }

  // 2. Usability Dual-Track + Hard Floor + unrounded exact step math (10/6*2 == 3.33)
  const uBefore = {};
  for (let i = 1; i <= 18; i++) {
    const id = `U${String(i).padStart(2, "0")}`;
    if (i === 18) uBefore[id] = { score: 0, findings: ["F-01"] };
    else if (i === 17) uBefore[id] = { score: "N/A", reason: "Local utility" };
    else if (i === 2) uBefore[id] = { score: 0, findings: ["F-02"] };
    else uBefore[id] = { score: 2, findings: [] };
  }
  const uRes = compute({
    type: "usability",
    profile: "dev_b2b",
    finding_severities: { "F-01": "blocker", "F-02": "major" },
    hard_floor_blockers: { before: ["F-01"], after_track_a: [], after_track_b: [] },
    before: uBefore,
    after_track_a: { U18: { score: 2, findings: [] }, U02: { score: 2, findings: [] } },
  });
  assert.match(uRes.phases.before.grade, /Hard Floor Capped/);
  assert.equal(uRes.criterion_deltas.after_track_a.U02, 3.33);
  assert.equal(uRes.phases.after_track_a.total, 100);

  // 3. System 3-band prose-inflation cap
  const sysBase = {};
  for (let i = 1; i <= 12; i++) sysBase[`DS${String(i).padStart(2, "0")}`] = { score: 2, findings: [], bands: { prose: 20, artifacts: 30, verification: 15 } };
  const sRes = compute({ type: "system", profile: "ds_core", before: sysBase });
  assert.equal(sRes.phases.before.total, 100);
  assert.match(sRes.phases.before.grade, /^L5/);

  assert.throws(() =>
    compute({
      type: "system",
      before: { ...sysBase, DS01: { score: 2, findings: [], bands: { prose: 35, artifacts: 0, verification: 0 } } },
    })
  );

  // 4. Reject deduction without finding ID & reject silently dropped finding
  assert.throws(() => compute({ type: "visual", before: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`V${String(i + 1).padStart(2, "0")}`, { score: 1, findings: [] }])) }));
  assert.throws(() =>
    compute({
      type: "visual",
      before: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`V${String(i + 1).padStart(2, "0")}`, i < 2 ? { score: 1, findings: ["V-09"] } : { score: 2, findings: [] }])),
      after_track_a: { V01: { score: 2, findings: [] } },
    })
  );

  // 5. 3-tier waiver enforcement & review provenance rendering
  const cleanVisualBefore = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`V${String(i + 1).padStart(2, "0")}`, { score: 2, findings: [] }]));
  assert.throws(() =>
    compute({
      type: "visual",
      before: cleanVisualBefore,
      waivers: [{ id: "dsaf/no-transition-all", tier: "floor", reason: "Legacy CSS library forces transition: all globally" }],
    })
  );
  const waivedRes = compute({
    type: "visual",
    before: cleanVisualBefore,
    waivers: [{ id: "dsaf/hardcoded-color", tier: "reflex", reason: "Partner co-brand SVG banner keeps locked external hex" }],
    review_provenance: { method: "single-context", reason: "no subagent runner exposed" },
  });
  assert.equal(waivedRes.waivers.length, 1);
  assert.match(renderMarkdown(waivedRes), /⚠️ DEGRADED: single-context/);

  console.log("COMPUTE_SCORECARD_SELF_TEST_PASSED (usability + visual + system 3-band cap + blocker + cross-phase + waivers)");
  return 0;
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      format: { type: "string", default: "markdown" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/compute-scorecard.mjs --input <scorecard-input.json> [--format markdown|json] [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  if (!values.input) {
    console.error("Error: --input is required unless --self-test is passed.");
    process.exit(2);
  }
  try {
    const payload = JSON.parse(readFileSync(resolve(values.input), "utf8"));
    const result = compute(payload);
    process.stdout.write(values.format === "json" ? JSON.stringify(result, null, 2) + "\n" : renderMarkdown(result));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntry) main();

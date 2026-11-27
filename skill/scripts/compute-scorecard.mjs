#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Deterministic Weighted Scorecard Calculator & Validator (Node ESM).
 * Zero external dependencies. Supports three audit types under schema `dsaf-scores/2`:
 * - `usability` (U01..U18, 6 pillars, Hard Floor)
 * - `visual`    (V01..V11, 6 pillars, Hard Floor)
 * - `system`    (DS01..DS12, 4 pillars, 3-band prose cap <= 40%, Maturity L0-L5, FIXED/DYNAMIC)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isBoilerplateReason, isDirectCliEntry, RULE_CATALOG } from "./ci-report.mjs";

export const ENGINE_VERSION = "0.9.3";

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

const SYSTEM_CHECK_TYPE = {
  DS01: "AUTO",
  DS02: "AUTO",
  DS03: "AUTO",
  DS04: "AUTO",
  DS05: "AUTO",
  DS06: "AUTO",
  DS07: "AUTO",
  DS08: "AUTO",
  DS09: "AUTO+MANUAL",
  DS10: "AUTO",
  DS11: "AUTO+MANUAL",
  DS12: "AUTO",
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
  const hasCustom = customWeights !== undefined && customWeights !== null;
  if (hasCustom) {
    if (typeof customWeights !== "object" || Array.isArray(customWeights)) {
      throw new ScorecardError("custom_weights must be an object mapping pillar IDs to numbers.");
    }
    for (const [k, v] of Object.entries(customWeights)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ScorecardError(`Custom weight for '${k}' must be a finite number; got ${JSON.stringify(v)}.`);
      }
    }
  }
  const name = customWeights ? profile || "custom" : profile || "balanced";
  const hasPreset = !customWeights && Object.prototype.hasOwnProperty.call(presets, name);
  const weights = customWeights
    ? Object.fromEntries(Object.entries(customWeights).map(([k, v]) => [k, v]))
    : hasPreset
    ? { ...presets[name] }
    : {};
  if (!customWeights && !hasPreset) {
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
  if (raw == null) return Object.create(null);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ScorecardError("'finding_severities' must map Finding ID -> severity.");
  const out = Object.create(null);
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
  const rawProse = bands.prose ?? 0;
  const rawArt = bands.artifacts ?? 0;
  const rawVer = bands.verification ?? 0;
  if (typeof rawProse !== "number" || typeof rawArt !== "number" || typeof rawVer !== "number") {
    throw new ScorecardError(`${phaseName}.${cid}.bands values must be numbers.`);
  }
  if (!Number.isFinite(rawProse) || !Number.isFinite(rawArt) || !Number.isFinite(rawVer)) {
    throw new ScorecardError(`${phaseName}.${cid}.bands values must be finite numbers.`);
  }
  if (rawProse < 0 || rawProse > 40 || rawArt < 0 || rawArt > 40 || rawVer < 0 || rawVer > 20) {
    throw new ScorecardError(`${phaseName}.${cid}.bands out of bounds (prose<=40, artifacts<=40, verification<=20).`);
  }
  if (score === 2 && rawArt === 0 && rawVer === 0) {
    throw new ScorecardError(`${phaseName}.${cid} has score 2 from prose alone (artifacts=0, verification=0). 3-band cap restricts prose-only evidence to <= 1.`);
  }
  return { prose: rawProse, artifacts: rawArt, verification: rawVer };
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
    const volatility =
      auditType === "system" && SYSTEM_VOLATILITY[cid]
        ? SYSTEM_VOLATILITY[cid]
        : entry.volatility || SYSTEM_VOLATILITY[cid] || "FIXED";
    if (typeof raw === "string" && raw.trim().toUpperCase() === "N/A") {
      const reason = String(entry.reason ?? "").trim();
      if (!reason) throw new ScorecardError(`${phaseName}.${cid} is 'N/A' without a non-empty 'reason'.`);
      normalized[cid] = {
        score: "N/A",
        findings: [],
        reason,
        secondary_impact: false,
        volatility,
        bands: null,
        check_type: entry.check_type || (auditType === "system" ? SYSTEM_CHECK_TYPE[cid] || null : null),
      };
      continue;
    }
    if (typeof raw === "boolean" || (raw !== 0 && raw !== 1 && raw !== 2)) {
      throw new ScorecardError(`${phaseName}.${cid} score must be 0, 1, 2, or 'N/A'; got ${JSON.stringify(raw)}`);
    }
    const rawFindings = entry.findings;
    if (!Array.isArray(rawFindings) || !rawFindings.every((x) => typeof x === "string" && x.trim().length > 0)) {
      throw new ScorecardError(`${phaseName}.${cid}.findings must be an array of non-empty strings.`);
    }
    const findings = rawFindings.map((x) => x.trim());
    if (raw < 2 && findings.length === 0) {
      throw new ScorecardError(`${phaseName}.${cid} has score ${raw} (< 2) without linked Finding IDs.`);
    }
    const secondary = Boolean(entry.secondary_impact);
    if (secondary && raw !== 1) {
      throw new ScorecardError(
        `${phaseName}.${cid} cannot set 'secondary_impact: true' with score ${raw === 2 ? "2 (Pass)" : "0 (Fail)"}; score must be 1 (Partial).`
      );
    }
    if (raw === 2) {
      const disqualifyingHits = findings.filter((fid) =>
        ["blocker", "major", "moderate"].includes(findingSeverities[fid])
      );
      if (disqualifyingHits.length > 0) {
        throw new ScorecardError(
          `${phaseName}.${cid} has score 2 (Pass) with disqualifying ${disqualifyingHits.map((fid) => `${fid}(${findingSeverities[fid]})`).join(", ")}.`
        );
      }
    } else if (raw > 0 && !secondary) {
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
      check_type: entry.check_type || (auditType === "system" ? SYSTEM_CHECK_TYPE[cid] || null : null),
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
    const normId = id.toLowerCase();
    const tier = String(w.tier || "reflex").trim().toLowerCase();
    const reason = String(w.reason || "").trim();
    if (!id) throw new ScorecardError("Waiver entry missing 'id' / 'ruleId'.");
    if (tier !== "floor" && tier !== "reflex" && tier !== "finish") {
      throw new ScorecardError(`Waiver '${id}' has unsupported tier '${tier}'. Expected 'reflex' or 'finish'.`);
    }
    const catalogKey = normId.includes("/") ? normId : `dsaf/${normId}`;
    const catalogEntry = Object.prototype.hasOwnProperty.call(RULE_CATALOG, normId)
      ? RULE_CATALOG[normId]
      : Object.prototype.hasOwnProperty.call(RULE_CATALOG, catalogKey)
      ? RULE_CATALOG[catalogKey]
      : null;
    if (tier === "floor" || catalogEntry?.tier === "floor") {
      throw new ScorecardError(`Waiver '${id}' rejected: Floor rules are never waivable.`);
    }
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

function parseHardFloorBlockers(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScorecardError("hard_floor_blockers must be an object keyed by phase (before, after_track_a, after_track_b).");
  }
  const allowedPhases = new Set(["before", "after_track_a", "after_track_b"]);
  const out = {};
  for (const [phase, list] of Object.entries(raw)) {
    if (!allowedPhases.has(phase)) {
      throw new ScorecardError(`hard_floor_blockers contains unknown phase key '${phase}'.`);
    }
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
      throw new ScorecardError(`hard_floor_blockers.${phase} must be an array of string finding IDs.`);
    }
    out[phase] = list.map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

const HARD_FLOOR_CRITERIA = {
  usability: ["U18"],
  visual: ["V05"],
  system: ["DS06", "DS02"],
};

function deriveHardFloorBlockers(auditType, scores, findingSeverities, explicitBlockers = []) {
  const out = [];
  const seen = new Set();
  for (const b of explicitBlockers) {
    if (b && !seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  for (const cid of HARD_FLOOR_CRITERIA[auditType] || []) {
    const entry = scores[cid];
    if (!entry || entry.score !== 0) continue;
    for (const fid of entry.findings || []) {
      if (findingSeverities[fid] === "blocker" && !seen.has(fid)) {
        seen.add(fid);
        out.push(fid);
      }
    }
  }
  return out;
}

export function compute(payload) {
  const auditType = payload?.type;
  const { pillars, presets } = getSchema(auditType);
  const validIds = pillars.flatMap(([, , cids]) => cids);
  const { profileName, weights } = resolveWeights(pillars, presets, payload.profile, payload.custom_weights);
  const findingSeverities = parseFindingSeverities(payload.finding_severities);
  const waivers = validateWaivers(payload.waivers);
  const reviewProvenance = validateProvenance(payload.review_provenance);
  if (
    payload.new_findings !== undefined &&
    (!Array.isArray(payload.new_findings) ||
      !payload.new_findings.every((x) => typeof x === "string" && x.trim().length > 0))
  ) {
    throw new ScorecardError("new_findings must be an array of non-empty strings.");
  }
  const allowedNewFindings = new Set((payload.new_findings || []).map((x) => x.trim()));
  if (!payload.before) throw new ScorecardError("Input JSON must include 'before'.");

  const beforeScores = validatePhaseScores(auditType, "before", payload.before, validIds, findingSeverities, true);
  const blockersMap = parseHardFloorBlockers(payload.hard_floor_blockers);
  const getBlockers = (k) => blockersMap[k] || [];
  const beforeBlockers = deriveHardFloorBlockers(auditType, beforeScores, findingSeverities, getBlockers("before"));
  const beforeFids = new Set(Object.values(beforeScores).flatMap((e) => e.findings));

  const phases = { before: evaluatePhase(auditType, pillars, weights, beforeScores, beforeBlockers) };
  const mergedScores = { before: beforeScores };

  for (const key of ["after_track_a", "after_track_b"]) {
    const phaseVal = payload[key];
    if (phaseVal !== undefined && phaseVal !== null) {
      if (typeof phaseVal !== "object" || Array.isArray(phaseVal)) {
        throw new ScorecardError(`'${key}' must be an object mapping criterion IDs to entries.`);
      }
      if (Object.keys(phaseVal).length > 0) {
      const overrides = validatePhaseScores(auditType, key, payload[key], validIds, findingSeverities, false);
      const merged = { ...beforeScores, ...overrides };
      validateCrossPhaseConsistency(key, beforeScores, merged, allowedNewFindings);
      const afterFids = new Set(Object.values(merged).flatMap((e) => e.findings));
      let phaseBlockers;
      if (!Object.prototype.hasOwnProperty.call(blockersMap, key)) {
        phaseBlockers = deriveHardFloorBlockers(
          auditType,
          merged,
          findingSeverities,
          beforeBlockers.filter((b) => afterFids.has(b) || !beforeFids.has(b))
        );
      } else {
        const explicitPhaseBlockers = getBlockers(key);
        const missing = beforeBlockers.filter((b) => afterFids.has(b) && !explicitPhaseBlockers.includes(b));
        if (missing.length > 0) {
          throw new ScorecardError(
            `${key}: hard_floor_blockers omits unresolved baseline blocker(s): ${missing.join(", ")}`
          );
        }
        phaseBlockers = deriveHardFloorBlockers(auditType, merged, findingSeverities, explicitPhaseBlockers);
      }
      mergedScores[key] = merged;
      phases[key] = evaluatePhase(auditType, pillars, weights, merged, phaseBlockers);
      }
    }
  }

  const deltas = {};
  const criterionDeltas = {};
  const baseTotal = phases.before.total;
  const beforeUnits = phases.before.criterion_unit_points;
  for (const key of ["after_track_a", "after_track_b"]) {
    if (phases[key] && baseTotal != null && phases[key].total != null) {
      deltas[key] = Number((phases[key].total - baseTotal).toFixed(2));
      const cmap = {};
      const afterUnits = phases[key].criterion_unit_points;
      for (const cid of validIds) {
        const bs = beforeScores[cid].score;
        const as = mergedScores[key][cid].score;
        const bExact = beforeUnits[cid]?.exact_step;
        const aExact = afterUnits[cid]?.exact_step;
        cmap[cid] =
          bs === "N/A" || as === "N/A" || bExact == null || aExact == null
            ? null
            : Number((as * aExact - bs * bExact).toFixed(2));
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
  const escMdCell = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const escMdInline = (v) => String(v ?? "").replace(/\r?\n/g, " ");
  const hasA = Boolean(res.phases.after_track_a);
  const hasB = Boolean(res.phases.after_track_b);
  const lines = [
    `### Deterministic Weighted Scorecard (${escMdInline(res.type.toUpperCase())} · Profile: \`${escMdInline(res.profile).replace(/`/g, "\\`")}\`)`,
    "",
  ];
  if (res.review_provenance) {
    const p = res.review_provenance;
    if (p.method === "single-context") {
      lines.push(`> ⚠️ DEGRADED: single-context (${escMdInline(p.reason)})`, "");
    } else {
      lines.push(
        `> Method: dual-agent${p.agent_a || p.agent_b ? ` (A: ${escMdInline(p.agent_a || "visual")} · B: ${escMdInline(p.agent_b || "probes")})` : ""}`,
        ""
      );
    }
  }
  const hdr = ["Pillar", "Weight", "Pts/Step (+1)", "Before"];
  if (hasA) hdr.push("Track A (Pragmatic)");
  if (hasB) hdr.push("Track B (North-Star)");
  lines.push(`| ${hdr.join(" | ")} |`, `|${hdr.map(() => "---").join("|")}|`);

  const fmtWeight = (w) => (Number.isInteger(w) ? String(w) : Number(w.toFixed(2)).toString());
  const fmtP = (p) => (p.pct == null ? "N/A" : `${p.weighted_points.toFixed(2)} / ${fmtWeight(p.weight)} (${p.pct.toFixed(1)}%)`);
  res.phases.before.pillars.forEach((bp, idx) => {
    const row = [`**${bp.id} — ${bp.name}**`, `${fmtWeight(bp.weight)}%`, bp.pts_per_step != null ? `+${bp.pts_per_step.toFixed(2)}` : "N/A", fmtP(bp)];
    if (hasA) row.push(fmtP(res.phases.after_track_a.pillars[idx]));
    if (hasB) row.push(fmtP(res.phases.after_track_b.pillars[idx]));
    lines.push(`| ${row.join(" | ")} |`);
  });

  const presentPhases = [res.phases.before, res.phases.after_track_a, res.phases.after_track_b].filter(Boolean);
  const posSums = presentPhases.map((ph) => ph.scored_weight_sum).filter((x) => x != null && x > 0);
  const uniformPartialSum =
    posSums.length === presentPhases.length && new Set(posSums.map(fmtWeight)).size === 1 && posSums[0] < 100
      ? posSums[0]
      : null;
  const weightCell = uniformPartialSum != null ? `**100%** (norm from ${fmtWeight(uniformPartialSum)}%)` : "**100%**";
  const fmtDelta = (d) => (d == null ? "N/A" : `${d >= 0 ? "+" : ""}${d.toFixed(2)}`);
  const normSuffix = (ph) =>
    uniformPartialSum == null && ph?.scored_weight_sum != null && ph.scored_weight_sum > 0 && ph.scored_weight_sum < 100
      ? ` (norm from ${fmtWeight(ph.scored_weight_sum)}%)`
      : "";
  const totRow = [
    "**TOTAL (0–100)**",
    weightCell,
    "—",
    `**${res.phases.before.total != null ? res.phases.before.total.toFixed(2) : "N/A"}**${normSuffix(res.phases.before)}`,
  ];
  if (hasA) {
    const tA = res.phases.after_track_a.total != null ? res.phases.after_track_a.total.toFixed(2) : "N/A";
    totRow.push(
      (res.deltas.after_track_a != null ? `**${tA}** (${fmtDelta(res.deltas.after_track_a)})` : `**${tA}**`) +
        normSuffix(res.phases.after_track_a)
    );
  }
  if (hasB) {
    const tB = res.phases.after_track_b.total != null ? res.phases.after_track_b.total.toFixed(2) : "N/A";
    totRow.push(
      (res.deltas.after_track_b != null ? `**${tB}** (${fmtDelta(res.deltas.after_track_b)})` : `**${tB}**`) +
        normSuffix(res.phases.after_track_b)
    );
  }
  lines.push(`| ${totRow.join(" | ")} |`);

  const gradeRow = ["**Grade / Maturity**", "—", "—", escMdCell(res.phases.before.grade)];
  if (hasA) gradeRow.push(escMdCell(res.phases.after_track_a.grade));
  if (hasB) gradeRow.push(escMdCell(res.phases.after_track_b.grade));
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

  // 3. System 3-band prose-inflation cap & check_type normalization
  const sysBase = {};
  for (let i = 1; i <= 12; i++) sysBase[`DS${String(i).padStart(2, "0")}`] = { score: 2, findings: [], bands: { prose: 20, artifacts: 30, verification: 15 } };
  const sRes = compute({ type: "system", profile: "ds_core", before: sysBase });
  assert.equal(sRes.phases.before.total, 100);
  assert.match(sRes.phases.before.grade, /^L5/);
  assert.equal(sRes.criteria.before.DS01.check_type, "AUTO");
  assert.equal(sRes.criteria.before.DS09.check_type, "AUTO+MANUAL");
  assert.equal(sRes.criteria.before.DS11.check_type, "AUTO+MANUAL");

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

  // 6. Round 1 regressions: Floor waiver bypass with omitted/reflex tier, null before total Markdown, NaN bands, empty blocker, non-numeric custom weights
  assert.throws(() =>
    compute({
      type: "visual",
      before: cleanVisualBefore,
      waivers: [{ id: "dsaf/no-transition-all", reason: "Attempting floor waiver by omitting tier field" }],
    })
  );
  assert.throws(() =>
    compute({
      type: "visual",
      before: cleanVisualBefore,
      waivers: [{ id: "dsaf/no-transition-all", tier: "reflex", reason: "Attempting floor waiver disguised as reflex" }],
    })
  );
  const allNaVisual = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`V${String(i + 1).padStart(2, "0")}`, { score: "N/A", reason: "Baseline pending" }]));
  const naRes = compute({ type: "visual", before: allNaVisual, after_track_a: { V01: { score: 2, findings: [] } } });
  assert.match(renderMarkdown(naRes), /\*\*N\/A\*\*/);
  assert.throws(() =>
    compute({
      type: "system",
      before: { ...sysBase, DS01: { score: 2, findings: [], bands: { prose: "bad", artifacts: "none", verification: "none" } } },
    })
  );
  const wsBlocker = compute({ type: "visual", hard_floor_blockers: { before: ["  "] }, before: cleanVisualBefore });
  assert.doesNotMatch(wsBlocker.phases.before.grade, /Hard Floor Capped/);
  assert.throws(() => compute({ type: "system", custom_weights: { P1: 100, P2: null, P3: 0, P4: 0 }, before: sysBase }));
  assert.throws(() =>
    compute({
      type: "visual",
      before: cleanVisualBefore,
      waivers: [{ id: "DSAF/NO-TRANSITION-ALL", tier: "reflex", reason: "Attempting floor bypass with uppercase rule ID" }],
    })
  );

  // 7. Round 4 regressions: unresolved Hard Floor blockers carry forward or reject explicit empty override
  const blockerBefore = {
    ...cleanVisualBefore,
    V02: { score: 0, findings: ["F-01"] },
    V03: { score: 0, findings: ["F-02"] },
  };
  const carryRes = compute({
    type: "visual",
    before: blockerBefore,
    after_track_a: { V03: { score: 2, findings: [] } },
    finding_severities: { "F-01": "blocker", "F-02": "major" },
    hard_floor_blockers: { before: ["F-01"] },
  });
  assert.deepEqual(carryRes.phases.after_track_a.hard_floor_blockers, ["F-01"], "Omitted after_track_a blockers must carry forward unresolved F-01");
  assert.match(carryRes.phases.after_track_a.grade, /Hard Floor Capped/, "Carry-forward blocker must still cap grade");
  assert.throws(
    () =>
      compute({
        type: "visual",
        before: blockerBefore,
        after_track_a: { V03: { score: 2, findings: [] } },
        finding_severities: { "F-01": "blocker", "F-02": "major" },
        hard_floor_blockers: { before: ["F-01"], after_track_a: [] },
      }),
    /hard_floor_blockers omits unresolved baseline blocker/,
    "Explicit empty after_track_a blocker array with active F-01 must throw ScorecardError"
  );

  // 8. Round 5 regressions: hard_floor_blockers schema validation
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, hard_floor_blockers: { before: "F-01" } }),
    ScorecardError,
    "String phase value in hard_floor_blockers must throw ScorecardError"
  );
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, hard_floor_blockers: ["F-01"] }),
    ScorecardError,
    "Array hard_floor_blockers root must throw ScorecardError"
  );
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, hard_floor_blockers: { before: ["F-01"], after_track_a: null } }),
    ScorecardError,
    "Non-array phase value in hard_floor_blockers must throw ScorecardError"
  );

  // 9. Round 6 regressions: strict string arrays for findings and new_findings
  const badFindingBefore = structuredClone(cleanVisualBefore);
  badFindingBefore.V01 = { score: 1, findings: [null] };
  assert.throws(
    () => compute({ type: "visual", before: badFindingBefore }),
    ScorecardError,
    "Non-string null item in entry.findings must throw ScorecardError"
  );
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, new_findings: "F-01" }),
    ScorecardError,
    "Non-array truthy new_findings must throw ScorecardError"
  );

  // 10. Round 7 regressions: strict non-object/non-null validation for custom_weights & after_track_*
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, after_track_a: true }),
    ScorecardError,
    "Boolean after_track_a must throw ScorecardError"
  );
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, after_track_a: [] }),
    ScorecardError,
    "Array after_track_a must throw ScorecardError"
  );
  assert.throws(
    () => compute({ type: "visual", before: cleanVisualBefore, custom_weights: false }),
    ScorecardError,
    "Boolean custom_weights must throw ScorecardError"
  );

  // 11. Round 8 regressions: prototype profile / waiver id lookup hardening
  assert.throws(
    () => compute({ type: "visual", profile: "constructor", before: cleanVisualBefore }),
    /Unknown weight profile 'constructor'/,
    "Prototype property profile 'constructor' must fail cleanly with ScorecardError"
  );
  const r8ProtoWaiver = compute({
    type: "visual",
    before: cleanVisualBefore,
    waivers: [{ ruleId: "toString", tier: "reflex", reason: "Legacy third-party chart wrapper element requires custom override" }],
  });
  assert.equal(r8ProtoWaiver.waivers.length, 1);

  // 12. Round 10 regression (R10-A3-10): JSON '__proto__' key in finding_severities must enforce blocker constraint
  const protoSev = JSON.parse('{"__proto__": "blocker"}');
  const protoBlockerBefore = structuredClone(cleanVisualBefore);
  protoBlockerBefore.V01 = { score: 1, findings: ["__proto__"] };
  assert.throws(
    () => compute({ type: "visual", finding_severities: protoSev, before: protoBlockerBefore }),
    ScorecardError,
    "JSON '__proto__' blocker finding severity must enforce score === 0"
  );

  // 13. Round 20 regressions (R20-A3-L11, R20-A3-L12): canonical SYSTEM_VOLATILITY cannot be overridden & invalid CLI flag exits 2 cleanly
  const r20SysBefore = structuredClone(sysBase);
  r20SysBefore.DS01 = { score: 1, findings: ["D-1"], volatility: "DYNAMIC" };
  const r20SysRes = compute({ type: "system", before: r20SysBefore });
  assert.equal(r20SysRes.criteria.before.DS01.volatility, "FIXED", "Canonical SYSTEM_VOLATILITY[DS01] must stay FIXED");

  const scSelfPath = fileURLToPath(import.meta.url);
  assert.equal(spawnSync(process.execPath, [scSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [scSelfPath, "--input", "   "], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [scSelfPath, "--input", "a.json", "--format", "bogus"], { encoding: "utf8" }).status, 2);
  const scTmpDir = mkdtempSync(`${tmpdir()}/dsaf-sc-test-`);
  try {
    assert.equal(spawnSync(process.execPath, [scSelfPath, "--input", `${scTmpDir}/missing.json`], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [scSelfPath, "--input", scTmpDir], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(scTmpDir, { recursive: true, force: true });
  }

  // 14. Round 26 regression (A4-M1): score=2 rejects blocker (even secondary_impact:true), major, moderate, and standalone secondary_impact
  for (const [label, patch] of [
    ["blocker+secondary", { score: 2, findings: ["F-BLK"], secondary_impact: true }],
    ["major", { score: 2, findings: ["F-MAJ"] }],
    ["moderate", { score: 2, findings: ["F-MOD"] }],
    ["secondary-only", { score: 2, findings: [], secondary_impact: true }],
  ]) {
    const r26Before = structuredClone(cleanVisualBefore);
    r26Before.V01 = patch;
    assert.throws(
      () =>
        compute({
          type: "visual",
          finding_severities: { "F-BLK": "blocker", "F-MAJ": "major", "F-MOD": "moderate", "F-MIN": "minor" },
          before: r26Before,
        }),
      ScorecardError,
      `score: 2 must reject ${label}`
    );
  }
  const r26OkBefore = structuredClone(cleanVisualBefore);
  r26OkBefore.V01 = { score: 2, findings: ["F-MIN"] };
  r26OkBefore.V02 = { score: 1, findings: ["F-BLK"], secondary_impact: true };
  assert.doesNotThrow(() =>
    compute({
      type: "visual",
      finding_severities: { "F-BLK": "blocker", "F-MIN": "minor" },
      before: r26OkBefore,
    })
  );

  // Round 27 (A4-L2): fractional custom_weights format accurately in Markdown
  const r27FracRes = compute({
    type: "system",
    custom_weights: { P1: 33.33, P2: 33.33, P3: 33.34, P4: 0 },
    before: sysBase,
  });
  const r27Md = renderMarkdown(r27FracRes);
  assert.ok(r27Md.includes("33.34%"), "Fractional custom_weights must render exact 33.34% weight");
  assert.ok(r27Md.includes("33.34 / 33.34 (100.0%)"), "Fractional custom_weights must not truncate denominator to 33");

  // Round 28 (A4-M1 derived Hard Floor blockers & A4-L3 renderMarkdown normalization edge cases)
  const r28U18Fail = compute({
    type: "usability",
    profile: "balanced",
    finding_severities: { "F-A11Y": "blocker" },
    before: {
      ...Object.fromEntries(getSchema("usability").pillars.flatMap(([, , cids]) => cids).map((c) => [c, { score: 2, findings: [] }])),
      U18: { score: 0, findings: ["F-A11Y"] },
    },
  });
  assert.deepEqual(r28U18Fail.phases.before.hard_floor_blockers, ["F-A11Y"], "R28 A4-M1: primary blocker on U18=0 must auto-enforce Hard Floor blocker");
  assert.match(r28U18Fail.phases.before.grade, /^Hard Floor Capped.*F-A11Y/);

  const uIds = getSchema("usability").pillars.flatMap(([, , cids]) => cids);
  const r28AllNaBefore = compute({
    type: "usability",
    profile: "balanced",
    before: Object.fromEntries(uIds.map((c) => [c, { score: "N/A", findings: [], reason: "Not applicable in empty baseline" }])),
    after_track_a: Object.fromEntries(uIds.map((c) => [c, { score: 2, findings: [] }])),
  });
  const r28AllNaMd = renderMarkdown(r28AllNaBefore);
  assert.ok(!r28AllNaMd.includes("norm from 0%"), "R28 A4-L3: all-N/A before phase must not render norm from 0%");

  const r28MixedAfterNorm = compute({
    type: "usability",
    profile: "balanced",
    before: Object.fromEntries(uIds.map((c) => [c, { score: 2, findings: [] }])),
    after_track_a: { ...Object.fromEntries(uIds.map((c) => [c, { score: 2, findings: [] }])), U18: { score: "N/A", findings: [], reason: "Excluded in track" } },
  });
  const r28MixedMd = renderMarkdown(r28MixedAfterNorm);
  assert.match(r28MixedMd, /norm from 85%/, "R28 A4-L3: after_track_a partial weight sum must show norm from 85%");

  // R29 regressions (A4-M1: secondary_impact=true forbidden on score 0; A4-L1: renderMarkdown table/inline escaping)
  assert.throws(
    () =>
      compute({
        type: "usability",
        profile: "balanced",
        finding_severities: { "F-A11Y": "blocker" },
        before: {
          ...Object.fromEntries(uIds.map((c) => [c, { score: 2, findings: [] }])),
          U18: { score: 0, findings: ["F-A11Y"], secondary_impact: true },
        },
      }),
    /cannot set 'secondary_impact: true' with score 0/,
    "R29 A4-M1: secondary_impact=true on score 0 must throw ScorecardError instead of bypassing Hard Floor capping"
  );
  const vIds = getSchema("visual").pillars.flatMap(([, , cids]) => cids);
  const r29PipeScore = compute({
    type: "visual",
    profile: "balanced",
    finding_severities: { "F-2 | pipe\nbreak": "blocker" },
    before: {
      ...Object.fromEntries(vIds.map((c) => [c, { score: 2, findings: [] }])),
      V05: { score: 0, findings: ["F-2 | pipe\nbreak"] },
    },
  });
  const r29PipeMd = renderMarkdown(r29PipeScore);
  const r29GradeLine = r29PipeMd.split("\n").find((ln) => ln.includes("**Grade / Maturity**"));
  assert.ok(r29GradeLine && r29GradeLine.includes("F-2 \\| pipe break"), "R29 A4-L1: blocker pipe and newline must be escaped on single Grade / Maturity row");

  console.log("COMPUTE_SCORECARD_SELF_TEST_PASSED (usability + visual + system 3-band cap + blocker + cross-phase + waivers)");
  return 0;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        input: { type: "string" },
        format: { type: "string", default: "markdown" },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (values.help) {
    console.log("Usage: node skill/scripts/compute-scorecard.mjs --input <scorecard-input.json> [--format markdown|json] [--self-test] [--help]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  if (!values.input || !values.input.trim()) {
    console.error("Error: non-empty --input <scorecard-input.json> is required unless --self-test is passed.");
    process.exit(2);
  }
  const cleanFmt = String(values.format || "").toLowerCase();
  if (cleanFmt !== "markdown" && cleanFmt !== "json") {
    console.error(`Error: invalid --format '${values.format}'. Expected markdown|json.`);
    process.exit(2);
  }
  const absInput = resolve(values.input);
  if (!existsSync(absInput) || !statSync(absInput).isFile()) {
    console.error(`Error: --input file not found: ${absInput}`);
    process.exit(2);
  }
  try {
    const payload = JSON.parse(readFileSync(absInput, "utf8"));
    const result = compute(payload);
    process.stdout.write(cleanFmt === "json" ? JSON.stringify(result, null, 2) + "\n" : renderMarkdown(result));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}

if (isDirectCliEntry(import.meta.url)) main();

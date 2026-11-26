#!/usr/bin/env node
/**
 * DSAF v0.9.2 — Supervised Repository Evolution Runner (`dsaf evolve`).
 * Executes governance-checked verification and bounded Floor remediation loops
 * using `.dsaf/rules.json`, `.dsaf/STOP` / `.evolve/STOP` kill switches,
 * A9.4 atomic numbered `.dsaf/lease.<n>` ownership leases, `.dsaf/personas.json`,
 * and circuit breakers. Zero external dependencies.
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scanTarget } from "./audit-tokens.mjs";
import { checkTarget } from "./dsaf-hook.mjs";
import { applyFloorFixes } from "./fix-floor.mjs";
import { initEvolve } from "./init-evolve.mjs";

export const EVOLVE_RUNNER_VERSION = "0.9.2";

function readJsonSafe(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function getHighestLeaseInfo(dsafDir) {
  if (!existsSync(dsafDir)) return { n: 0, file: null, line: null, owner: "none", integration: "main", expiresMs: 0, unreadable: false };
  let highestN = 0;
  let highestFile = null;
  for (const name of readdirSync(dsafDir)) {
    const m = /^lease\.(\d+)$/.exec(name);
    if (!m) continue;
    const num = Number.parseInt(m[1], 10);
    if (num > highestN) {
      highestN = num;
      highestFile = join(dsafDir, name);
    }
  }
  if (!highestFile) {
    return { n: 0, file: null, line: null, owner: "none", integration: "main", expiresMs: 0, unreadable: false };
  }
  try {
    const line = readFileSync(highestFile, "utf8").split(/\r?\n/)[0].trim();
    const parts = Object.fromEntries(
      line
        .split("|")
        .map((seg) => seg.trim())
        .map((seg) => {
          const idx = seg.indexOf(":");
          return idx === -1 ? [seg, ""] : [seg.slice(0, idx).trim().toLowerCase(), seg.slice(idx + 1).trim()];
        })
    );
    const owner = parts.owner || "unknown";
    const integration = parts.integration || "main";
    const expiresMs = parts.expires ? Date.parse(parts.expires) || 0 : 0;
    return { n: highestN, file: highestFile, line, owner, integration, expiresMs, unreadable: false };
  } catch {
    // Per A9.4: an unreadable highest lease counts as held.
    return { n: highestN, file: highestFile, line: null, owner: "unreadable", integration: "main", expiresMs: Number.MAX_SAFE_INTEGER, unreadable: true };
  }
}

export function acquireLease(absTarget, sessionId = `dsaf-${process.pid}`, integrationBranch = "main") {
  const dsafDir = join(absTarget, ".dsaf");
  mkdirSync(dsafDir, { recursive: true });
  const current = getHighestLeaseInfo(dsafDir);
  const nowMs = Date.now();
  const isLiveHeld =
    current.unreadable ||
    (current.owner !== "none" && (current.expiresMs === 0 || current.expiresMs > nowMs));
  if (isLiveHeld) {
    return {
      acquired: false,
      owner: current.owner,
      file: current.file,
      integration: current.integration,
      n: current.n,
    };
  }
  const nextN = current.n + 1;
  const nextFile = join(dsafDir, `lease.${nextN}`);
  const hbIso = new Date(nowMs).toISOString();
  const expIso = new Date(nowMs + 60 * 60 * 1000).toISOString();
  const integration = current.file ? current.integration || integrationBranch : integrationBranch;
  const line = `owner: ${sessionId} | heartbeat: ${hbIso} | expires: ${expIso} | integration: ${integration}\n`;
  try {
    writeFileSync(nextFile, line, { encoding: "utf8", flag: "wx" });
    return { acquired: true, owner: sessionId, file: nextFile, integration, n: nextN, line: line.trim() };
  } catch (err) {
    return { acquired: false, owner: "race_contended", file: nextFile, integration, n: nextN, error: err?.message };
  }
}

export function releaseLease(lease) {
  if (!lease?.acquired || !lease.file || !existsSync(lease.file)) return false;
  const nowIso = new Date().toISOString();
  const releasedLine = `owner: none | heartbeat: ${nowIso} | expires: ${nowIso} | integration: ${lease.integration || "main"}\n`;
  writeFileSync(lease.file, releasedLine, "utf8");
  return true;
}

export function readGovernanceStatus(targetDir = ".") {
  const absTarget = resolve(targetDir);
  const rulesPath = join(absTarget, ".dsaf", "rules.json");
  const rules = readJsonSafe(rulesPath);
  if (!rules) {
    return {
      version: EVOLVE_RUNNER_VERSION,
      target: absTarget,
      initialized: false,
      status: "uninitialized",
      canRun: false,
      killSwitchActive: false,
      circuitBreakerTripped: false,
      circuitBreaker: { consecutiveFailures: 0, maxConsecutiveFailures: 2 },
      lease: null,
      personaCount: 0,
    };
  }

  const killSwitchRel = rules.killSwitchFile || ".dsaf/STOP";
  const altKillSwitchRel = rules.altKillSwitchFile || ".evolve/STOP";
  const breakerRel = rules.circuitBreakerFile || ".dsaf/circuit-breaker.json";
  const killSwitchPath = resolve(absTarget, killSwitchRel);
  const altKillSwitchPath = resolve(absTarget, altKillSwitchRel);
  const breakerPath = resolve(absTarget, breakerRel);
  const killSwitchActive = existsSync(killSwitchPath) || existsSync(altKillSwitchPath);

  const breakerRaw = readJsonSafe(breakerPath) || {
    schema: "dsaf-circuit-breaker/1",
    consecutiveFailures: 0,
    lastStatus: "ready",
    lastBaseline: null,
    history: [],
  };
  const consecutiveFailures = Number(breakerRaw.consecutiveFailures || 0);
  const maxConsecutiveFailures = Number(rules.budgets?.maxConsecutiveFailures ?? 2);
  const circuitBreakerTripped = consecutiveFailures >= maxConsecutiveFailures;

  const leaseInfo = getHighestLeaseInfo(join(absTarget, ".dsaf"));
  const leaseHeld =
    leaseInfo.unreadable ||
    (leaseInfo.owner !== "none" && (leaseInfo.expiresMs === 0 || leaseInfo.expiresMs > Date.now()));

  const personasDoc = readJsonSafe(join(absTarget, ".dsaf", "personas.json"));
  const personaCount = Number(personasDoc?.personaCount || personasDoc?.personas?.length || 0);

  const status = killSwitchActive
    ? "halted_kill_switch"
    : circuitBreakerTripped
    ? "halted_circuit_breaker"
    : leaseHeld
    ? "lease_held"
    : "ready";

  return {
    version: EVOLVE_RUNNER_VERSION,
    target: absTarget,
    initialized: true,
    repository: rules.repository || basename(absTarget),
    mode: rules.mode || "P",
    surfaceMode: rules.surfaceMode || "Operate",
    loopMode: rules.loopMode || "focused",
    strategyVersion: rules.strategyVersion || EVOLVE_RUNNER_VERSION,
    upstreamStrategy: rules.upstreamStrategy || "zintaen/auto-evolve-strategy v1.2.0",
    killSwitchFile: killSwitchRel,
    killSwitchActive,
    circuitBreakerFile: breakerRel,
    circuitBreakerTripped,
    lease: {
      n: leaseInfo.n,
      owner: leaseInfo.owner,
      held: leaseHeld,
      integration: leaseInfo.integration,
    },
    personaCount,
    circuitBreaker: {
      consecutiveFailures,
      maxConsecutiveFailures,
      lastStatus: breakerRaw.lastStatus || "ready",
      lastBaseline: breakerRaw.lastBaseline || null,
      updatedAt: breakerRaw.updatedAt || null,
    },
    budgets: rules.budgets || { maxFilesPerRound: 5, maxConsecutiveFailures: 2, allowWaiverFloor: false },
    gates: rules.gates || { floorMax: 0, apcaBodyMin: 60, apcaLargeMin: 45, minTapTargetPx: 44, allowHardcodedColors: false },
    protectedFilesCount: Array.isArray(rules.protectedFiles) ? rules.protectedFiles.length : 0,
    canRun: status === "ready",
    status,
  };
}

function measureBaseline(absTarget, dsCss = []) {
  const hookRes = checkTarget(absTarget, { tier: "all", dsCss });
  const tokRes = scanTarget(absTarget);
  return {
    floor: hookRes.counts.floor,
    reflex: hookRes.counts.reflex,
    waived: hookRes.counts.waived,
    unusedIgnores: hookRes.counts.unusedIgnores,
    hardcodedColorHits: tokRes.drift.hardcodedColorHits,
    importantOverrides: tokRes.drift.importantOverrides,
    orphanCssVariableCount: tokRes.drift.orphanCssVariableCount,
    tokenCompliancePct: tokRes.drift.tokenCompliancePct,
  };
}

export function runEvolveCycle(targetDir = ".", options = {}) {
  const absTarget = resolve(targetDir);
  const gov = readGovernanceStatus(absTarget);
  if (!gov.initialized) {
    return {
      ok: false,
      version: EVOLVE_RUNNER_VERSION,
      target: absTarget,
      status: "uninitialized",
      reason: "Workspace has no .dsaf/rules.json; run `dsaf init .` first.",
      governance: gov,
    };
  }

  if (gov.killSwitchActive) {
    return {
      ok: false,
      version: EVOLVE_RUNNER_VERSION,
      target: absTarget,
      status: "halted_kill_switch",
      reason: `Kill switch present at ${gov.killSwitchFile} or .evolve/STOP; remove file to resume.`,
      governance: gov,
    };
  }

  if (gov.circuitBreakerTripped && !options.resetBreaker) {
    return {
      ok: false,
      version: EVOLVE_RUNNER_VERSION,
      target: absTarget,
      status: "halted_circuit_breaker",
      reason: `Circuit breaker open (${gov.circuitBreaker.consecutiveFailures}/${gov.circuitBreaker.maxConsecutiveFailures} consecutive failures); pass --reset-breaker after resolving defects.`,
      governance: gov,
    };
  }

  let lease = null;
  if (!options.dryRun) {
    lease = acquireLease(absTarget, options.sessionId || `dsaf-${process.pid}`, gov.lease?.integration || "main");
    if (!lease.acquired) {
      return {
        ok: false,
        version: EVOLVE_RUNNER_VERSION,
        target: absTarget,
        status: "lease_held",
        reason: `Active lease.${lease.n} held by '${lease.owner}'; wait or inspect .dsaf/lease.${lease.n}.`,
        governance: gov,
      };
    }
  }

  try {
    const breakerAbs = resolve(absTarget, gov.circuitBreakerFile);
    const existingBreaker = readJsonSafe(breakerAbs) || {
      schema: "dsaf-circuit-breaker/1",
      consecutiveFailures: 0,
      lastStatus: "ready",
      lastBaseline: null,
      history: [],
    };
    let consecutiveFailures = options.resetBreaker ? 0 : Number(existingBreaker.consecutiveFailures || 0);
    const prevBaseline = existingBreaker.lastBaseline;

    const maxRounds = Math.max(1, Math.min(5, Number(options.maxRounds || 1)));
    const maxFilesPerRound = Number(gov.budgets?.maxFilesPerRound || 5);
    const before = measureBaseline(absTarget, options.dsCss);
    const rounds = [];
    let current = before;

    for (let r = 1; r <= maxRounds; r++) {
      // C3 step 3: re-check kill switch before every round step
      if (existsSync(resolve(absTarget, gov.killSwitchFile)) || existsSync(resolve(absTarget, ".evolve/STOP"))) {
        return {
          ok: false,
          version: EVOLVE_RUNNER_VERSION,
          target: absTarget,
          status: "halted_kill_switch",
          reason: "Kill switch detected at step boundary.",
          governance: gov,
        };
      }
      let fixSummary = null;
      if (options.applyFloorFixes && !options.dryRun && current.floor > 0) {
        fixSummary = applyFloorFixes(absTarget, {
          dryRun: false,
          backup: Boolean(options.backup),
          maxFiles: maxFilesPerRound,
          dsCss: options.dsCss,
        });
      }
      const after = measureBaseline(absTarget, options.dsCss);
      rounds.push({
        round: r,
        beforeFloor: current.floor,
        afterFloor: after.floor,
        filesModified: fixSummary ? fixSummary.filesModified : 0,
        patchesApplied: fixSummary ? fixSummary.patchesApplied : 0,
        tokenCompliancePct: after.tokenCompliancePct,
      });
      current = after;
      if (current.floor === 0 || !options.applyFloorFixes || options.dryRun || (fixSummary && fixSummary.filesModified === 0)) {
        break;
      }
    }

    const floorGateOk = current.floor <= Number(gov.gates?.floorMax ?? 0);
    const colorGateOk = gov.gates?.allowHardcodedColors === true || current.hardcodedColorHits === 0;
    const regressed = Boolean(
      prevBaseline &&
        (current.floor > prevBaseline.floor ||
          (gov.gates?.allowHardcodedColors === false && current.hardcodedColorHits > prevBaseline.hardcodedColorHits))
    );

    const cyclePassed = floorGateOk && !regressed;
    if (cyclePassed) consecutiveFailures = 0;
    else consecutiveFailures += 1;

    const maxFail = Number(gov.budgets?.maxConsecutiveFailures ?? 2);
    const nextStatus = consecutiveFailures >= maxFail ? "halted_circuit_breaker" : cyclePassed ? "passed" : "gate_failed";

    if (!options.dryRun) {
      const nowIso = new Date().toISOString();
      const nextHistory = [
        ...(Array.isArray(existingBreaker.history) ? existingBreaker.history : []).slice(-19),
        {
          timestamp: nowIso,
          beforeFloor: before.floor,
          afterFloor: current.floor,
          hardcodedColorHits: current.hardcodedColorHits,
          tokenCompliancePct: current.tokenCompliancePct,
          passed: cyclePassed,
          regressed,
        },
      ];
      mkdirSync(join(absTarget, ".dsaf"), { recursive: true });
      writeFileSync(
        breakerAbs,
        JSON.stringify(
          {
            schema: "dsaf-circuit-breaker/1",
            updatedAt: nowIso,
            consecutiveFailures,
            lastStatus: nextStatus,
            lastBaseline: current,
            history: nextHistory,
          },
          null,
          2
        ) + "\n",
        "utf8"
      );

      const handoffPath = join(absTarget, ".dsaf", "handoff.md");
      if (existsSync(handoffPath)) {
        const logLine = `- ${nowIso} | dsaf evolve round (${lease ? `lease.${lease.n}` : "dry-run"}): floor ${before.floor}->${current.floor}, hardcoded=${current.hardcodedColorHits}, compliance=${current.tokenCompliancePct}%, personas=${gov.personaCount}, status=${nextStatus}\n`;
        appendFileSync(handoffPath, logLine, "utf8");
      }
    }

    return {
      ok: cyclePassed,
      version: EVOLVE_RUNNER_VERSION,
      target: absTarget,
      dryRun: Boolean(options.dryRun),
      status: nextStatus,
      floorGateOk,
      colorGateOk,
      regressed,
      consecutiveFailures,
      maxConsecutiveFailures: maxFail,
      personaCount: gov.personaCount,
      leaseNumber: lease?.n || null,
      before,
      after: current,
      rounds,
    };
  } finally {
    if (lease) releaseLease(lease);
  }
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-evolve-runner-test-"));
  try {
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src/app.css"), ":root { --ink: #14243D; }\n.btn { color: var(--ink); transition: all 150ms ease; }\n", "utf8");

    // 1. Uninitialized returns clean status
    assert.equal(readGovernanceStatus(scratch).initialized, false);
    assert.equal(runEvolveCycle(scratch).status, "uninitialized");

    // 2. Initialize governance and verify ready status + personas count
    initEvolve({ targetDir: scratch });
    const st1 = readGovernanceStatus(scratch);
    assert.equal(st1.initialized, true);
    assert.equal(st1.status, "ready");
    assert.equal(st1.canRun, true);
    assert.ok(st1.personaCount >= 6);

    // 3. Kill switch (.dsaf/STOP and .evolve/STOP) halts execution cleanly
    writeFileSync(join(scratch, ".dsaf/STOP"), "manual stop\n", "utf8");
    assert.equal(readGovernanceStatus(scratch).status, "halted_kill_switch");
    assert.equal(runEvolveCycle(scratch).status, "halted_kill_switch");
    rmSync(join(scratch, ".dsaf/STOP"));

    mkdirSync(join(scratch, ".evolve"), { recursive: true });
    writeFileSync(join(scratch, ".evolve/STOP"), "manual stop\n", "utf8");
    assert.equal(readGovernanceStatus(scratch).status, "halted_kill_switch");
    rmSync(join(scratch, ".evolve"), { recursive: true, force: true });

    // 4. Active A9.4 numbered lease blocks concurrent session cleanly
    const heldLease = acquireLease(scratch, "other-session");
    assert.equal(heldLease.acquired, true);
    assert.equal(readGovernanceStatus(scratch).status, "lease_held");
    assert.equal(runEvolveCycle(scratch).status, "lease_held");
    releaseLease(heldLease);
    assert.equal(readGovernanceStatus(scratch).status, "ready");

    // 5. Dry-run verify catches Floor=1 and trips breaker after maxConsecutiveFailures (non-dry runs)
    const dryRes = runEvolveCycle(scratch, { dryRun: true });
    assert.equal(dryRes.ok, false);
    assert.equal(dryRes.after.floor, 1);

    // Run twice without --apply-floor-fixes to trip breaker (maxConsecutiveFailures=2)
    runEvolveCycle(scratch, { dryRun: false });
    const tripRes = runEvolveCycle(scratch, { dryRun: false });
    assert.equal(tripRes.status, "halted_circuit_breaker");
    assert.equal(runEvolveCycle(scratch, { applyFloorFixes: true }).status, "halted_circuit_breaker");

    // 6. Reset breaker + --apply-floor-fixes brings Floor 1->0 and releases numbered lease + logs handoff
    const healed = runEvolveCycle(scratch, { applyFloorFixes: true, resetBreaker: true, maxRounds: 2 });
    assert.equal(healed.ok, true);
    assert.equal(healed.before.floor, 1);
    assert.equal(healed.after.floor, 0);
    assert.equal(healed.status, "passed");
    assert.ok(healed.leaseNumber >= 2);
    assert.equal(readGovernanceStatus(scratch).lease.held, false);
    assert.match(readFileSync(join(scratch, ".dsaf/handoff.md"), "utf8"), /floor 1->0/);

    console.log("DSAF_EVOLVE_RUNNER_SELF_TEST_PASSED (init + .dsaf/.evolve STOP + A9.4 lease.<n> + circuit-breaker + Floor 1->0 remediation)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isEntrypoint) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "apply-floor-fixes": { type: "boolean", default: false },
      backup: { type: "boolean", default: false },
      "max-rounds": { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
      "reset-breaker": { type: "boolean", default: false },
      "ds-css": { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      [
        `DSAF v${EVOLVE_RUNNER_VERSION} — Supervised Repository Evolution Runner`,
        "Usage:",
        "  dsaf evolve [target] [--status] [--verify] [--apply-floor-fixes] [--backup] [--max-rounds <n>] [--dry-run] [--reset-breaker] [--ds-css <path>] [--json]",
        "  dsaf evolve --self-test",
      ].join("\n")
    );
    process.exit(0);
  }

  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const target = positionals[0] || ".";
  if (values.status && !values.verify && !values["apply-floor-fixes"]) {
    const st = readGovernanceStatus(target);
    if (values.json) console.log(JSON.stringify(st, null, 2));
    else console.log(`DSAF_EVOLVE_STATUS v${EVOLVE_RUNNER_VERSION}: ${st.status} (initialized=${st.initialized}, canRun=${st.canRun})`);
    process.exit(st.initialized ? 0 : 1);
  }

  const res = runEvolveCycle(target, {
    applyFloorFixes: Boolean(values["apply-floor-fixes"]),
    backup: Boolean(values.backup),
    maxRounds: Number.parseInt(values["max-rounds"], 10) || 1,
    dryRun: Boolean(values["dry-run"]),
    resetBreaker: Boolean(values["reset-breaker"]),
    dsCss: values["ds-css"],
  });

  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`DSAF_EVOLVE v${EVOLVE_RUNNER_VERSION}: status=${res.status} ok=${res.ok} floor=${res.before?.floor ?? "?"}->${res.after?.floor ?? "?"}`);
  }
  process.exit(res.ok ? 0 : 1);
}

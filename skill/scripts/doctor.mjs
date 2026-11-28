#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Read-Only Diagnostic & Drift Inspector (`dsaf doctor`).
 * Zero external dependencies. Checks:
 * 1. CLI & generated guardrail version parity
 * 2. Token files & DESIGN/AGENTS doc mtime freshness
 * 3. Edit-time agent hook configuration
 * 4. CI regression gate workflow presence
 * 5. Optional Chromium/Playwright & axe-core discoverability
 * 6. Active Floor defects & stale `dsaf-ignore` waivers across UI files
 * 7. CLI & npm update freshness (cached 24h / `--offline` safe)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { probeRuntimeDeps } from "./audit-runtime.mjs";
import { scanTarget } from "./audit-tokens.mjs";
import { assertWritableOutputFile, isDirectCliEntry } from "./ci-report.mjs";
import { checkTarget, discoverExternalDsCss, installAgentHook } from "./dsaf-hook.mjs";
import { hasDesignTokenEvidence } from "./recon.mjs";
import { checkLatestVersion, compareSemver, readCachedUpdate } from "./update-check.mjs";

export const DOCTOR_VERSION = "0.9.3";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "storybook-static",
  "_audit",
  "_vendor",
  "_site",
  "src-tauri",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "coverage",
  "playwright-report",
  "test-results",
  "audit-output",
  "dsaf-audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

const AUTH_OR_TEST_TOKEN_RE = /(?:^|[._-])(?:auth|csrf|jwt|oauth|session|refresh|access|api|secret|bearer|test|mock|fixture)(?:$|[._-])/i;

function isTokenFileRel(rel) {
  const base = rel.split("/").pop() || "";
  if (AUTH_OR_TEST_TOKEN_RE.test(base)) return false;
  if (/(?:^|\/)(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|secrets|bearer)\/.+\.json$/i.test(rel)) {
    return false;
  }
  return (
    (/\.tokens\.json$/i.test(rel) ||
      /(^|\/)(?:design[-_]?)?(?:tokens?|variables)(?:[._-][^/]*)?\.(?:css|scss|json)$/i.test(rel) ||
      /(^|\/)(?:tokens|design-tokens)\/(?:.+\/)?[^/]+\.(?:css|scss|json)$/i.test(rel)) &&
    !/(^|\/)(?:tests?|fixtures|__fixtures__|_audit|storybook-static)\//i.test(rel) &&
    !/(?:^|\/)(?:package|tsconfig[^/]*|.*schema.*|meta)\.json$/i.test(rel)
  );
}

function isDsafReportJson(absPath) {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return false;
    if (st.size <= 2_000_000) {
      const parsed = JSON.parse(readFileSync(absPath, "utf8"));
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.schema === "string" && /^dsaf-/i.test(parsed.schema));
    }
    const buf = Buffer.alloc(1024);
    const fd = openSync(absPath, "r");
    try {
      const n = readSync(fd, buf, 0, 1024, 0);
      const head = buf.slice(0, n).toString("utf8");
      return /"schema"\s*:\s*"dsaf-/i.test(head);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findTokenFiles(root, maxDirs = 10_000, maxMatches = 500) {
  const matches = [];
  const queue = [root];
  let visitedDirs = 0;
  while (queue.length > 0 && visitedDirs < maxDirs && matches.length < maxMatches) {
    const dir = queue.shift();
    visitedDirs++;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (matches.length >= maxMatches) break;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory() && e.name.startsWith(".") && ![".claude", ".cursor", ".codex", ".github", ".dsaf-guardrails"].includes(e.name)) {
        continue;
      }
      const full = join(dir, e.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (/(^|\/)(?:ios\/App\/App\/public|android\/app\/src\/main\/assets\/public)\//i.test(rel)) continue;
      if (e.isDirectory()) queue.push(full);
      else if (e.isFile() && isTokenFileRel(rel)) {
        if (/\.json$/i.test(rel)) {
          if (isDsafReportJson(full)) continue;
          try {
            if (statSync(full).size > 2_000_000) continue;
            const rawJson = readFileSync(full, "utf8");
            if (!hasDesignTokenEvidence(rawJson).valid) continue;
          } catch {
            continue;
          }
        }
        matches.push(rel);
      }
    }
  }
  return matches.sort();
}

function resolveDoctorScope(root, rawScope) {
  if (rawScope === undefined || rawScope === null) {
    return { cleanScope: "", scopedRoot: root };
  }
  if (typeof rawScope !== "string" || rawScope.trim().length === 0) {
    throw new Error("Parameter '--scope' must be a non-empty relative path.");
  }
  const trimmed = rawScope.trim().replace(/\\/g, "/");
  const segs = trimmed.split("/").filter(Boolean);
  if (!trimmed.startsWith("/") && segs.length > 0 && segs.every((s) => s === ".")) {
    return { cleanScope: "", scopedRoot: root };
  }
  const scopedRoot = resolve(root, trimmed);
  if (!existsSync(scopedRoot) || !statSync(scopedRoot).isDirectory()) {
    throw new Error(`Scope directory not found: ${scopedRoot}`);
  }
  const nativeReal = (p) => (realpathSync.native ? realpathSync.native(p) : realpathSync(p));
  const normCase = (p) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const realRoot = nativeReal(root);
  const realScoped = nativeReal(scopedRoot);
  const relScope = relative(normCase(realRoot), normCase(realScoped));
  if (relScope === ".." || relScope.startsWith(`..${sep}`) || isAbsolute(relScope)) {
    throw new Error(`Scope directory escapes target root: ${rawScope}`);
  }
  if (!relScope) {
    return { cleanScope: "", scopedRoot: root };
  }
  const canonicalRel = relative(realRoot, realScoped).replace(/\\/g, "/");
  const cleanScope =
    canonicalRel === ".." || canonicalRel.startsWith("../") || isAbsolute(canonicalRel)
      ? relScope.replace(/\\/g, "/")
      : canonicalRel;
  if (!cleanScope) {
    return { cleanScope: "", scopedRoot: root };
  }
  return { cleanScope, scopedRoot: join(root, cleanScope) };
}

export function runDoctor(targetDir = ".", options = {}) {
  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw new Error("Target directory must be a non-empty path.");
  }
  const rawDsCss =
    options.dsCss === undefined || options.dsCss === null ? [] : Array.isArray(options.dsCss) ? options.dsCss : [options.dsCss];
  if (rawDsCss.some((x) => typeof x !== "string" || x.trim().length === 0 || x.split(",").some((p) => p.trim().length === 0))) {
    throw new Error("Parameter '--ds-css' must be a non-empty file path.");
  }
  const root = resolve(targetDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Target directory not found: ${root}`);
  }
  const { cleanScope, scopedRoot } = resolveDoctorScope(root, options.scope);
  if (rawDsCss.length > 0) {
    discoverExternalDsCss(scopedRoot, rawDsCss);
  }
  const currentVersion = options.version || DOCTOR_VERSION;
  const checks = [];

  const isRegularFile = (p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  };

  // 1. CLI & guardrail parity
  const guardrailPaths = [".dsaf-guardrails/check-design-discipline.mjs", ".dsaf-guardrails/AGENTS-dsaf-rules.md"].filter((p) =>
    isRegularFile(join(root, p))
  );
  if (guardrailPaths.length === 0) {
    checks.push({
      id: "cli_and_guardrail_parity",
      status: "WARN",
      detail: "No .dsaf-guardrails/ files found in target.",
      fix: "npx @zintaen/dsaf guardrails --out .dsaf-guardrails --stack tailwind",
    });
  } else {
    const versions = new Set();
    for (const gp of guardrailPaths) {
      try {
        const m = readFileSync(join(root, gp), "utf8").match(/DSAF[^\n]*?\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/i);
        if (m) versions.add(m[1]);
      } catch {}
    }
    const stale = [...versions].filter((v) => v !== currentVersion);
    checks.push(
      versions.size === 0 || stale.length > 0
        ? {
            id: "cli_and_guardrail_parity",
            status: "WARN",
            detail:
              versions.size === 0
                ? `Could not parse DSAF version from .dsaf-guardrails/ (installed CLI is v${currentVersion}).`
                : `Generated guardrails pinned to v${stale.join(", ")} (installed CLI is v${currentVersion}).`,
            fix: "npx @zintaen/dsaf guardrails --out .dsaf-guardrails --stack tailwind",
          }
        : {
            id: "cli_and_guardrail_parity",
            status: "OK",
            detail: `Guardrails match CLI v${currentVersion}.`,
            fix: null,
          }
    );
  }

  // 2. Token & DESIGN/AGENTS doc freshness
  const tokenFiles = findTokenFiles(root);
  const designDoc = [".dsaf-guardrails/AGENTS-dsaf-rules.md", "DESIGN.md", "AGENTS.md"].find((p) => isRegularFile(join(root, p)));
  if (tokenFiles.length === 0) {
    checks.push({
      id: "tokens_and_docs_freshness",
      status: "WARN",
      detail: "No dedicated DTCG/CSS token files detected.",
      fix: "npx @zintaen/dsaf audit . --out ./audit-output",
    });
  } else if (guardrailPaths.length > 0) {
    const newestTokMs = Math.max(...tokenFiles.map((tf) => statSync(join(root, tf)).mtimeMs));
    const oldestGuardMs = Math.min(...guardrailPaths.map((gp) => statSync(join(root, gp)).mtimeMs));
    if (newestTokMs > oldestGuardMs + 2000) {
      checks.push({
        id: "tokens_and_docs_freshness",
        status: "WARN",
        detail: `${tokenFiles.length} token file(s) modified after .dsaf-guardrails/.`,
        fix: "npx @zintaen/dsaf guardrails --out .dsaf-guardrails --stack tailwind",
      });
    } else {
      checks.push({
        id: "tokens_and_docs_freshness",
        status: "OK",
        detail: `${tokenFiles.length} token file(s) in sync${designDoc ? ` (${designDoc})` : ""}.`,
        fix: null,
      });
    }
  } else {
    checks.push({
      id: "tokens_and_docs_freshness",
      status: "OK",
      detail: `${tokenFiles.length} token file(s) present${designDoc ? ` (${designDoc})` : ""}.`,
      fix: null,
    });
  }

  // 3. Edit-time agent hook
  const hookCandidates = [".claude/settings.json", ".cursor/hooks.json", ".codex/dsaf-hook.json", ".codex/hooks.json"];
  const installedHooks = [];
  for (const hc of hookCandidates) {
    const abs = join(root, hc);
    if (!isRegularFile(abs)) continue;
    try {
      const raw = readFileSync(abs, "utf8");
      if (/dsaf-hook|(?:\bdsaf(?:\.mjs)?|@zintaen\/dsaf(?:@[^\s"'`]+)?)\s+hook\b/i.test(raw)) {
        installedHooks.push(hc);
      }
    } catch {}
  }
  checks.push(
    installedHooks.length > 0
      ? {
          id: "edit_time_hook",
          status: "OK",
          detail: `Edit-time Floor hook active in ${installedHooks.join(", ")}.`,
          fix: null,
        }
      : {
          id: "edit_time_hook",
          status: "WARN",
          detail: "No edit-time DSAF hook found (.claude / .cursor / .codex).",
          fix: "npx @zintaen/dsaf hook install --agent claude --dir .",
        }
  );

  // 4. CI regression workflow presence (read directly so large repos do not hit walkRepo file cap)
  const wfDir = join(root, ".github", "workflows");
  let wfFiles = [];
  try {
    if (existsSync(wfDir) && statSync(wfDir).isDirectory()) {
      wfFiles = readdirSync(wfDir)
        .filter((name) => /\.(ya?ml)$/i.test(name))
        .sort()
        .map((name) => `.github/workflows/${name}`);
    }
  } catch {}
  const dsafWorkflow = wfFiles.find((wf) => {
    try {
      const raw = readFileSync(join(root, wf), "utf8");
      const active = raw.replace(/(?:^|[ \t])#.*$/gm, "");
      return /(?:(?<![A-Za-z0-9_@./-])zintaen\/dsaf@|check-design-discipline|dsaf-regression-gate|audit-(?:pipeline|tokens|runtime|diff|figma-diff)\.mjs|dsaf-hook\.mjs|(?:\bdsaf(?:\.mjs)?|@zintaen\/dsaf(?:@[^\s"'`]+)?)\s+(?:audit|check|tokens|hook|doctor|runtime|diff|figma-diff|scorecard)\b)/i.test(active);
    } catch {
      return false;
    }
  });
  checks.push(
    dsafWorkflow
      ? {
          id: "ci_regression_gate",
          status: "OK",
          detail: `CI gate configured in ${dsafWorkflow}.`,
          fix: null,
        }
      : {
          id: "ci_regression_gate",
          status: "WARN",
          detail: "No GitHub Actions workflow running DSAF checks found.",
          fix: "Copy .dsaf-guardrails/dsaf-regression-gate.yml into .github/workflows/",
        }
  );

  // 5. Runtime deps (Playwright & axe-core)
  const runtimeProbe = probeRuntimeDeps(cleanScope ? [scopedRoot, root] : [root]);
  checks.push(
    runtimeProbe.playwrightAvailable
      ? {
          id: "runtime_deps",
          status: "OK",
          detail: `Playwright reachable (axe-core: ${runtimeProbe.axeAvailable ? "yes" : "not found — optional"}).`,
          fix: null,
        }
      : {
          id: "runtime_deps",
          status: "WARN",
          detail: "Playwright not resolved in ancestor node_modules (static CLI audits still run zero-dep).",
          fix: "npm install -D playwright axe-core && npx playwright install chromium",
        }
  );

  // 6. Waiver & Floor hygiene via shared dsaf-hook checkTarget + audit-tokens reconciliation
  const relHookFile = (f) => relative(root, resolve(scopedRoot, String(f || ""))).replace(/\\/g, "/") || ".";
  const hookRes = checkTarget(scopedRoot, {
    tier: "all",
    dsCss: rawDsCss,
    reportUnusedIgnores: true,
  });
  const tokRes = scanTarget(root, {
    ...(cleanScope ? { scope: cleanScope } : {}),
    reportUnusedIgnores: true,
  });
  const tokActive = (tokRes.ciFindings?.active || []).map((f) => ({ ...f, file: relHookFile(f.file) }));
  const tokWaived = (tokRes.ciFindings?.waived || []).map((w) => ({ ...w, file: relHookFile(w.file) }));
  const tokUnused = (tokRes.ciFindings?.unusedIgnores || []).map((u) => ({ ...u, file: relHookFile(u.file) }));
  const hookActive = (hookRes.active || []).map((f) => ({ ...f, file: relHookFile(f.file) }));
  const hookWaived = (hookRes.waived || []).map((w) => ({ ...w, file: relHookFile(w.file) }));
  const hookUnused = (hookRes.unusedIgnores || []).map((u) => ({ ...u, file: relHookFile(u.file) }));
  const REJECTED_WAIVER_RULES = new Set(["dsaf/floor-waiver-rejected", "dsaf/waiver-reason-weak"]);
  const rejectedTarget = (f) => f.targetRuleId || f.message?.match(/'(dsaf\/[^']+)'/)?.[1] || "";

  const hookHandledLocs = new Set([
    ...hookWaived.map((w) => `${w.file}:${w.waiverLine || w.line}:${w.ruleId}`),
    ...hookActive.filter((f) => REJECTED_WAIVER_RULES.has(f.ruleId)).map((f) => `${f.file}:${f.line}:${rejectedTarget(f)}`),
  ]);
  const tokHandledLocs = new Set([
    ...tokWaived.map((w) => `${w.file}:${w.waiverLine || w.line}:${w.ruleId}`),
    ...tokActive.filter((f) => REJECTED_WAIVER_RULES.has(f.ruleId)).map((f) => `${f.file}:${f.line}:${rejectedTarget(f)}`),
  ]);

  const hookFloorKeys = new Set();
  const hookRejectedKeys = new Set();
  const unusedSeen = new Set();
  const sampleSet = new Set();
  let floorHits = 0;
  let rejectedWaivers = 0;

  for (const f of hookActive) {
    if (f.ruleId === "dsaf/unused-ignore") continue;
    const key = `${f.file}:${f.line}:${f.ruleId}`;
    if (f.ruleId === "dsaf/floor-waiver-rejected") {
      rejectedWaivers++;
      hookRejectedKeys.add(key);
      sampleSet.add(`${f.file}:${f.line} ${f.ruleId}`);
    } else if (f.tier === "floor") {
      floorHits++;
      hookFloorKeys.add(key);
      sampleSet.add(`${f.file}:${f.line} ${f.ruleId}`);
    }
  }
  for (const f of tokActive) {
    if (f.ruleId === "dsaf/unused-ignore") continue;
    const key = `${f.file}:${f.line}:${f.ruleId}`;
    if (f.ruleId === "dsaf/floor-waiver-rejected") {
      if (hookRejectedKeys.has(key)) continue;
      rejectedWaivers++;
      sampleSet.add(`${f.file}:${f.line} ${f.ruleId}`);
    } else if (f.tier === "floor") {
      if (hookFloorKeys.has(key)) continue;
      floorHits++;
      sampleSet.add(`${f.file}:${f.line} ${f.ruleId}`);
    }
  }
  for (const u of hookUnused) {
    if (tokHandledLocs.has(`${u.file}:${u.line}:${u.targetRuleId || ""}`)) continue;
    unusedSeen.add(`${u.file}:${u.line}:${u.targetRuleId || ""}`);
    sampleSet.add(`${u.file}:${u.line} ${u.ruleId}`);
  }
  for (const u of tokUnused) {
    if (hookHandledLocs.has(`${u.file}:${u.line}:${u.targetRuleId || ""}`)) continue;
    unusedSeen.add(`${u.file}:${u.line}:${u.targetRuleId || ""}`);
    sampleSet.add(`${u.file}:${u.line} ${u.ruleId}`);
  }
  const unusedIgnores = unusedSeen.size;
  const sampleIssues = [...sampleSet].slice(0, 8);
  const totalScanned = Math.max(hookRes.filesScanned, tokRes.filesScanned?.uiAndStyle || 0);
  if (floorHits > 0 || rejectedWaivers > 0) {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "ACTION",
      detail: `Scanned ${totalScanned} UI file(s): ${floorHits} Floor finding(s), ${rejectedWaivers} rejected Floor waiver(s), ${unusedIgnores} unused ignore(s).`,
      samples: sampleIssues,
      fix: "npx @zintaen/dsaf hook check . --tier all --report-unused-ignores",
    });
  } else if (unusedIgnores > 0) {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "WARN",
      detail: `Scanned ${totalScanned} UI file(s): 0 Floor findings, ${unusedIgnores} unused dsaf-ignore directive(s).`,
      samples: sampleIssues,
      fix: "Remove stale dsaf-ignore directives flagged by --report-unused-ignores",
    });
  } else {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "OK",
      detail: `Scanned ${totalScanned} UI file(s): 0 Floor findings, 0 stale waivers.`,
      fix: null,
    });
  }

  // 7. CLI & npm update freshness
  const upd = options.updateStatus || readCachedUpdate(currentVersion, options.cachePath);
  if (upd.outdated && upd.latestVersion) {
    checks.push({
      id: "cli_update_freshness",
      status: "WARN",
      detail: `Installed DSAF v${currentVersion} is behind npm latest v${upd.latestVersion}.`,
      fix: "npx @zintaen/dsaf@latest update",
    });
  } else if (upd.ok && upd.latestVersion) {
    const verCmp = compareSemver(currentVersion, upd.latestVersion);
    const verRelation = verCmp !== null && verCmp > 0 ? "is ahead of npm latest" : "matches latest";
    checks.push({
      id: "cli_update_freshness",
      status: "OK",
      detail: `CLI v${currentVersion} ${verRelation} v${upd.latestVersion} (${upd.fromCache ? "cached" : "online"}).`,
      fix: null,
    });
  } else {
    checks.push({
      id: "cli_update_freshness",
      status: "OK",
      detail: `CLI v${currentVersion} (${options.offline ? "offline mode" : upd.reason || "update cache unavailable"}).`,
      fix: null,
    });
  }

  const summary = {
    ok: checks.filter((c) => c.status === "OK").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    action: checks.filter((c) => c.status === "ACTION").length,
  };

  return {
    schema: "dsaf-doctor/1",
    version: currentVersion,
    target: root,
    passed: summary.action === 0,
    summary,
    checks,
  };
}

export function renderDoctorText(report) {
  const lines = [`DSAF Doctor v${report.version} — Target: ${report.target}`, ""];
  for (const c of report.checks) {
    lines.push(`[${c.status.padEnd(6)}] ${c.id.padEnd(28)} ${c.detail}`);
    if (c.samples?.length) lines.push(`         samples: ${c.samples.slice(0, 4).join(", ")}`);
    if (c.fix) lines.push(`         fix:     ${c.fix}`);
  }
  lines.push("", `Summary: OK=${report.summary.ok} WARN=${report.summary.warn} ACTION=${report.summary.action}`);
  return lines.join("\n") + "\n";
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-doctor-test-"));
  try {
    // 1. Healthy project with matching guardrails, hook, CI, clean CSS
    const good = join(scratch, "healthy");
    mkdirSync(join(good, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(good, ".github/workflows"), { recursive: true });
    mkdirSync(join(good, "src"), { recursive: true });
    writeFileSync(join(good, "src/tokens.css"), ":root { --ink: #111827; }\n");
    writeFileSync(join(good, ".dsaf-guardrails/check-design-discipline.mjs"), `// Generated by DSAF v${DOCTOR_VERSION}\n`);
    writeFileSync(join(good, ".dsaf-guardrails/AGENTS-dsaf-rules.md"), `# DSAF (v${DOCTOR_VERSION})\n`);
    writeFileSync(join(good, ".github/workflows/ci.yml"), "name: CI\nrun: npx @zintaen/dsaf tokens .\n");
    writeFileSync(join(good, "src/app.css"), ".btn { color: var(--ink); }\n");
    installAgentHook({ agent: "codex", dir: good });
    const cacheUp = join(scratch, "cache-up.json");
    writeFileSync(cacheUp, JSON.stringify({ latestVersion: DOCTOR_VERSION, checkedAt: new Date().toISOString() }));

    const rGood = runDoctor(good, { cachePath: cacheUp });
    assert.equal(rGood.schema, "dsaf-doctor/1");
    assert.equal(rGood.passed, true);
    assert.equal(rGood.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "edit_time_hook").status, "OK", "Must detect .codex/hooks.json");
    assert.equal(rGood.checks.find((c) => c.id === "ci_regression_gate").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "cli_update_freshness").status, "OK");

    // 2. Stale guardrails, newer tokens, missing hook, active Floor violation -> ACTION, outdated CLI -> WARN
    const bad = join(scratch, "drifted");
    mkdirSync(join(bad, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(bad, "src"), { recursive: true });
    const gPath = join(bad, ".dsaf-guardrails/check-design-discipline.mjs");
    writeFileSync(gPath, "// Generated by DSAF v0.2.0\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(gPath, past, past);
    writeFileSync(join(bad, "src/tokens.css"), ":root { --ink: #111827; }\n");
    writeFileSync(join(bad, "src/bad.css"), ".btn { transition: all 200ms; }\n");
    const cacheOutdated = join(scratch, "cache-old.json");
    writeFileSync(cacheOutdated, JSON.stringify({ latestVersion: "9.9.9", checkedAt: new Date().toISOString() }));

    const rBad = runDoctor(bad, { cachePath: cacheOutdated });
    assert.equal(rBad.passed, false);
    assert.equal(rBad.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "tokens_and_docs_freshness").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "edit_time_hook").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "ACTION");
    assert.equal(rBad.checks.find((c) => c.id === "cli_update_freshness").status, "WARN");

    // 3. Round 2 regressions: nested tokens/*.json discovery, AGENTS-dsaf-rules.md parens version parse,
    // valid Reflex waivers not flagged as unused ignores
    const r2Doc = join(scratch, "r2-healthy");
    mkdirSync(join(r2Doc, "tokens"), { recursive: true });
    mkdirSync(join(r2Doc, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(r2Doc, "src"), { recursive: true });
    writeFileSync(join(r2Doc, "tokens/color.json"), JSON.stringify({ bg: { $type: "color", $value: "#ffffff" } }));
    writeFileSync(
      join(r2Doc, ".dsaf-guardrails/AGENTS-dsaf-rules.md"),
      "# DSAF Design System Discipline Rules (v0.9.1, Mode C, Stack: tailwind)\n"
    );
    writeFileSync(
      join(r2Doc, "src/mail.css"),
      [
        "/* dsaf-ignore dsaf/hardcoded-color -- brand email gradient fallback */",
        ".mail { color: #1d4ed8; }",
      ].join("\n")
    );
    writeFileSync(
      join(r2Doc, "src/Nudge.tsx"),
      [
        "// dsaf-ignore dsaf/off-grid-spacing -- 1px optical icon alignment nudge",
        `export const Nudge = () => <span style={{ margin: "13px" }} />;`,
      ].join("\n")
    );
    const r2Res = runDoctor(r2Doc, { cachePath: cacheUp, version: DOCTOR_VERSION });
    assert.equal(r2Res.checks.find((c) => c.id === "tokens_and_docs_freshness").status, "OK", "Must discover tokens/color.json");
    assert.equal(r2Res.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "WARN", "Must parse v0.9.1 inside AGENTS-dsaf-rules.md parens");
    assert.equal(r2Res.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "OK", "Valid Reflex waivers must pass without false unused-ignore warnings");

    // 4. Round 3 regressions: multi-DTCG Floor count, >1500-file workflow check, --scope, dsaf-audit-output skip
    const r3Doc = join(scratch, "r3-doctor");
    mkdirSync(join(r3Doc, "assets"), { recursive: true });
    mkdirSync(join(r3Doc, ".github/workflows"), { recursive: true });
    mkdirSync(join(r3Doc, "dsaf-audit-output"), { recursive: true });
    mkdirSync(join(r3Doc, "apps/web/src"), { recursive: true });
    mkdirSync(join(r3Doc, "apps/legacy/tokens"), { recursive: true });
    for (let i = 0; i < 1510; i++) {
      writeFileSync(join(r3Doc, `assets/f${i}.txt`), "x");
    }
    writeFileSync(join(r3Doc, ".github/workflows/ci.yml"), "name: CI\nrun: dsaf audit .\n");
    writeFileSync(join(r3Doc, "dsaf-audit-output/tokens.json"), JSON.stringify({ bg: { $type: "color", $value: "#ffffff" } }));
    writeFileSync(join(r3Doc, "apps/web/src/ok.css"), ".btn { color: var(--ink); }\n");
    writeFileSync(join(r3Doc, "apps/web/src/auth-token.json"), JSON.stringify({ token: "x" }));
    writeFileSync(
      join(r3Doc, "apps/legacy/tokens/color.json"),
      JSON.stringify({
        light: {
          surface: { default: { $type: "color", $value: "#ffffff" } },
          text: {
            primary: { $type: "color", $value: "#f8fafc" },
            muted: { $type: "color", $value: "#e2e8f0" },
          },
        },
        dark: {
          surface: { default: { $type: "color", $value: "#0b0f19" } },
          text: { primary: { $type: "color", $value: "#111827" } },
        },
      })
    );
    const r3Full = runDoctor(r3Doc, { cachePath: cacheUp, offline: true });
    assert.equal(r3Full.checks.find((c) => c.id === "ci_regression_gate").status, "OK", "Must detect .github/workflows beyond 1500-file cap");
    assert.equal(r3Full.checks.find((c) => c.id === "tokens_and_docs_freshness").status, "OK", "Must find apps/legacy tokens but skip dsaf-audit-output");
    assert.match(
      r3Full.checks.find((c) => c.id === "tokens_and_docs_freshness").detail,
      /^1 token file\(s\)/,
      "Must count only apps/legacy/tokens/color.json (skipping dsaf-audit-output and auth-token.json)"
    );
    assert.match(
      r3Full.checks.find((c) => c.id === "waiver_and_floor_hygiene").detail,
      /3 Floor finding\(s\)/,
      "All 3 DTCG contrast Floor errors at line 1 must be counted"
    );
    const r3Scoped = runDoctor(r3Doc, { cachePath: cacheUp, offline: true, scope: "apps/web" });
    assert.equal(r3Scoped.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "OK", "--scope apps/web must ignore apps/legacy Floor errors");

    // 5. Round 4 regressions: --scope path normalization between audit-tokens and dsaf-hook
    const r4ScopeDir = join(scratch, "r4-scope");
    mkdirSync(join(r4ScopeDir, "apps/web/src"), { recursive: true });
    mkdirSync(join(r4ScopeDir, "apps/web/tokens"), { recursive: true });
    writeFileSync(
      join(r4ScopeDir, "apps/web/src/Nudge.tsx"),
      [
        "// dsaf-ignore dsaf/off-grid-spacing -- 1px optical icon alignment nudge",
        "export const Nudge = () => <span style={{ margin: '13px' }} />;",
      ].join("\n")
    );
    writeFileSync(
      join(r4ScopeDir, "apps/web/src/bad.css"),
      ["/* dsaf-ignore dsaf/no-outline-none-naked -- skip */", ".x:focus { outline: none; }"].join("\n")
    );
    writeFileSync(
      join(r4ScopeDir, "apps/web/src/stale.css"),
      ["/* dsaf-ignore dsaf/important-override -- no violation here */", ".ok { color: var(--ink); }"].join("\n")
    );
    writeFileSync(
      join(r4ScopeDir, "apps/web/tokens/color.json"),
      JSON.stringify({
        light: {
          surface: { default: { $type: "color", $value: "#ffffff" } },
          text: { primary: { $type: "color", $value: "#f8fafc" } },
        },
      })
    );
    const r4Res = runDoctor(r4ScopeDir, { cachePath: cacheUp, offline: true, scope: "apps/web" });
    const r4Hygiene = r4Res.checks.find((c) => c.id === "waiver_and_floor_hygiene");
    assert.equal(r4Hygiene.status, "ACTION");
    assert.match(r4Hygiene.detail, /2 Floor finding\(s\), 1 rejected Floor waiver\(s\), 1 unused ignore\(s\)/);
    assert.ok(r4Hygiene.samples.every((s) => s.startsWith("apps/web/")), `All scoped samples must be normalized relative to root: ${JSON.stringify(r4Hygiene.samples)}`);
    assert.ok(!r4Hygiene.samples.some((s) => s.includes("Nudge.tsx")), "Valid audit-tokens Reflex waiver must not emit unused-ignore under --scope");

    // 6. Round 5 regression: valid waiver + stale ignore on the SAME line must still report 1 unused ignore
    const r5SameLineDir = join(scratch, "r5-same-line");
    mkdirSync(join(r5SameLineDir, "src"), { recursive: true });
    writeFileSync(
      join(r5SameLineDir, "src/dual.css"),
      ".x { color: #ff00aa; } /* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback */ /* dsaf-ignore dsaf/off-grid-spacing -- stale unused ignore comment */\n"
    );
    const r5SameRes = runDoctor(r5SameLineDir, { cachePath: cacheUp, offline: true });
    assert.equal(r5SameRes.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "WARN");
    assert.match(
      r5SameRes.checks.find((c) => c.id === "waiver_and_floor_hygiene").detail,
      /1 unused dsaf-ignore directive\(s\)/,
      "Stale ignore sharing a line with a handled waiver must not be suppressed"
    );

    // 7. Round 8 regression: prerelease guardrail version drift detection
    const r8PreDir = join(scratch, "r8-prerelease");
    mkdirSync(join(r8PreDir, ".dsaf-guardrails"), { recursive: true });
    writeFileSync(join(r8PreDir, ".dsaf-guardrails/check-design-discipline.mjs"), `// DSAF v${DOCTOR_VERSION}-rc.1\n`);
    writeFileSync(join(r8PreDir, ".dsaf-guardrails/AGENTS-dsaf-rules.md"), `# DSAF v${DOCTOR_VERSION}-rc.1\n`);
    const r8PreRes = runDoctor(r8PreDir, { cachePath: cacheUp, offline: true });
    const r8Parity = r8PreRes.checks.find((c) => c.id === "cli_and_guardrail_parity");
    assert.equal(r8Parity.status, "WARN", "Prerelease guardrail version must flag drift against stable CLI");
    assert.match(r8Parity.detail, new RegExp(`v${DOCTOR_VERSION.replaceAll(".", "\\.")}-rc\\.1`));

    // 8. Round 10 regression (R10-A1-03): --scope must reject parent traversal & escaping symlinks
    const r10Outside = join(scratch, "r10-doc-outside");
    mkdirSync(r10Outside, { recursive: true });
    symlinkSync(r10Outside, join(r4ScopeDir, "escape-link"));
    assert.throws(() => runDoctor(join(r4ScopeDir, "apps"), { scope: "..", offline: true }), /escapes target root/);
    assert.throws(() => runDoctor(r4ScopeDir, { scope: "escape-link", offline: true }), /escapes target root/);

    // 9. Round 11 regression (R11-A1-04): --scope "/" must reject escape; intra-repo absolute path must work cleanly
    assert.throws(() => runDoctor(r4ScopeDir, { scope: "/", offline: true }), /escapes target root/);
    const r11AbsDoc = runDoctor(r4ScopeDir, { scope: join(r4ScopeDir, "apps/web"), cachePath: cacheUp, offline: true });
    assert.equal(
      r11AbsDoc.checks.find((c) => c.id === "waiver_and_floor_hygiene").status,
      "ACTION",
      "Intra-repo absolute --scope must scan apps/web cleanly"
    );

    // 10. Round 12 regression (R12-A1-01): symlinked target + canonical realpath --scope must not emit ../ traversal samples
    const r12DocLink = join(scratch, "r12-doc-link");
    symlinkSync(r4ScopeDir, r12DocLink);
    const r12RealWeb = realpathSync(join(r4ScopeDir, "apps/web"));
    const r12RealRoot = realpathSync(r4ScopeDir);
    const r12ScopedRes = runDoctor(r12DocLink, { scope: r12RealWeb, cachePath: cacheUp, offline: true });
    const r12ScopedHygiene = r12ScopedRes.checks.find((c) => c.id === "waiver_and_floor_hygiene");
    assert.ok(r12ScopedHygiene.samples.length > 0 && r12ScopedHygiene.samples.every((s) => s.startsWith("apps/web/")));
    const r12RootRes = runDoctor(r12DocLink, { scope: r12RealRoot, cachePath: cacheUp, offline: true });
    const r12RootHygiene = r12RootRes.checks.find((c) => c.id === "waiver_and_floor_hygiene");
    assert.ok(r12RootHygiene.samples.length > 0 && r12RootHygiene.samples.every((s) => !s.startsWith("../")));

    // 11. Round 13 regression (R13-A1-02): auto-update workflow and commented workflows must not satisfy ci_regression_gate
    const r13AutoUpOnly = join(scratch, "r13-autoup-only");
    mkdirSync(join(r13AutoUpOnly, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(r13AutoUpOnly, ".github/workflows/dsaf-auto-update.yml"),
      "name: DSAF Auto Update\non:\n  schedule:\n    - cron: '0 9 * * 1'\njobs:\n  update:\n    steps:\n      - run: npx -y @zintaen/dsaf@latest update . --all-agents --json\n"
    );
    assert.equal(
      runDoctor(r13AutoUpOnly, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "ci_regression_gate").status,
      "WARN",
      "Auto-update workflow alone must not satisfy ci_regression_gate"
    );
    writeFileSync(
      join(r13AutoUpOnly, ".github/workflows/comment-only.yml"),
      "name: Lint\non: push\njobs:\n  lint:\n    steps:\n      - run: echo ok # npx @zintaen/dsaf check .\n      # uses: zintaen/dsaf@v0\n"
    );
    assert.equal(
      runDoctor(r13AutoUpOnly, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "ci_regression_gate").status,
      "WARN",
      "Commented-out DSAF workflow must not satisfy ci_regression_gate"
    );
    writeFileSync(
      join(r13AutoUpOnly, ".github/workflows/gate.yml"),
      "name: DSAF\non: pull_request\njobs:\n  dsaf:\n    steps:\n      - uses: zintaen/dsaf@v0\n"
    );
    assert.equal(
      runDoctor(r13AutoUpOnly, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "ci_regression_gate").status,
      "OK",
      "Workflow using zintaen/dsaf@v0 must satisfy ci_regression_gate"
    );

    // 12. Round 14 regressions (R14-A1-01, R14-A1-04): DSAF tokens.json artifacts & auth/*/tokens.json exclusions + non-dir .github/workflows guard
    const r14Rep = join(scratch, "r14-report-art");
    mkdirSync(join(r14Rep, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(r14Rep, "src"), { recursive: true });
    mkdirSync(join(r14Rep, "reports"), { recursive: true });
    mkdirSync(join(r14Rep, "auth/google"), { recursive: true });
    writeFileSync(join(r14Rep, ".dsaf-guardrails/AGENTS-dsaf-rules.md"), `# DSAF v${DOCTOR_VERSION}\n`);
    const oldMs = Date.now() - 10_000;
    writeFileSync(join(r14Rep, "src/tokens.css"), ":root { --fg: #0f172a; }\n");
    utimesSync(join(r14Rep, "src/tokens.css"), oldMs / 1000, oldMs / 1000);
    utimesSync(join(r14Rep, ".dsaf-guardrails/AGENTS-dsaf-rules.md"), (oldMs + 500) / 1000, (oldMs + 500) / 1000);
    writeFileSync(join(r14Rep, "reports/tokens.json"), JSON.stringify({ schema: "dsaf-tokens/2", drift: {} }));
    writeFileSync(join(r14Rep, "auth/google/tokens.json"), JSON.stringify({ access: "secret" }));
    mkdirSync(join(r14Rep, ".github"), { recursive: true });
    writeFileSync(join(r14Rep, ".github/workflows"), "not-a-directory\n");
    const r14Doc = runDoctor(r14Rep, { cachePath: cacheUp, offline: true });
    const r14TokChk = r14Doc.checks.find((c) => c.id === "tokens_and_docs_freshness");
    assert.equal(r14TokChk.status, "OK", "reports/tokens.json artifact must not trigger guardrail staleness");
    assert.match(r14TokChk.detail, /^1 token file\(s\) in sync/, "Only src/tokens.css should count as a project token file");
    assert.equal(r14Doc.checks.find((c) => c.id === "ci_regression_gate").status, "WARN", "Non-directory .github/workflows must yield WARN instead of ENOTDIR");

    const r14NoTok = join(scratch, "r14-no-tok");
    mkdirSync(join(r14NoTok, "auth/google"), { recursive: true });
    writeFileSync(join(r14NoTok, "auth/google/tokens.json"), JSON.stringify({ access: "secret" }));
    assert.equal(
      runDoctor(r14NoTok, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "tokens_and_docs_freshness").status,
      "WARN",
      "auth/google/tokens.json alone must not satisfy tokens_and_docs_freshness"
    );

    // Round 15 regression (R15-A1-04): versioned @zintaen/dsaf@latest hook recognition & EISDIR guards on guardrail/hook paths
    const r15DocDir = join(scratch, "r15-dir-paths");
    mkdirSync(join(r15DocDir, ".dsaf-guardrails/check-design-discipline.mjs"), { recursive: true });
    mkdirSync(join(r15DocDir, ".claude/settings.json"), { recursive: true });
    mkdirSync(join(r15DocDir, ".cursor"), { recursive: true });
    writeFileSync(join(r15DocDir, ".cursor/hooks.json"), JSON.stringify({ cmd: "npx -y @zintaen/dsaf@latest hook stdin --tier floor" }));
    const r15Doc = runDoctor(r15DocDir, { cachePath: cacheUp, offline: true });
    assert.equal(r15Doc.checks.find((c) => c.id === "edit_time_hook").status, "OK", "Versioned @zintaen/dsaf@latest hook must satisfy edit_time_hook");
    assert.equal(r15Doc.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "WARN", "Directory at guardrail script path must WARN without EISDIR crash");

    const r15PinnedDir = join(scratch, "r15-pinned-hook");
    mkdirSync(join(r15PinnedDir, ".claude"), { recursive: true });
    writeFileSync(join(r15PinnedDir, ".claude/settings.json"), JSON.stringify({ cmd: `npx -y @zintaen/dsaf@${DOCTOR_VERSION} hook stdin` }));
    assert.equal(runDoctor(r15PinnedDir, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "edit_time_hook").status, "OK");

    // Round 16 regression (R16-A1-05): --out "" / "   " / <existing-dir> must fail upfront with exit 2
    const docSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r15PinnedDir, "--out", "", "--offline", "--json"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r15PinnedDir, "--out", "   ", "--offline", "--json"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r15PinnedDir, "--out", r15PinnedDir, "--offline", "--json"], { encoding: "utf8" }).status, 2);

    // Round 17 regressions (R17-A1-07, R17-A1-16): reject empty/whitespace --scope, --ds-css, and empty positional target
    assert.throws(() => runDoctor(r15PinnedDir, { scope: "   ", cachePath: cacheUp, offline: true }), /Parameter '--scope' must be a non-empty/);
    assert.throws(() => runDoctor(r15PinnedDir, { scope: "", cachePath: cacheUp, offline: true }), /Parameter '--scope' must be a non-empty/);
    assert.throws(() => runDoctor(r15PinnedDir, { dsCss: [""], cachePath: cacheUp, offline: true }), /Parameter '--ds-css' must be a non-empty/);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r15PinnedDir, "--ds-css", "", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r15PinnedDir, "--scope", "   ", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [docSelfPath, "", "--offline"], { encoding: "utf8" }).status, 2);

    // Round 18 regressions (R18-A1-04, R18-A1-06, R18-A1-11):
    // 1. String dsCss passed programmatically must reach checkTarget()
    const r18DocDir = join(scratch, "r18-doc-dscss");
    mkdirSync(join(r18DocDir, "src"), { recursive: true });
    writeFileSync(join(r18DocDir, "src/btn.css"), ".btn:focus { outline: none; }\n");
    const r18ExtDs = join(scratch, "r18-ext-ds.css");
    writeFileSync(r18ExtDs, ".btn:focus-within { box-shadow: 0 0 0 2px #000000; }\n");
    assert.equal(
      runDoctor(r18DocDir, { cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "waiver_and_floor_hygiene").status,
      "ACTION"
    );
    assert.equal(
      runDoctor(r18DocDir, { dsCss: r18ExtDs, cachePath: cacheUp, offline: true }).checks.find((c) => c.id === "waiver_and_floor_hygiene").status,
      "OK"
    );

    // 2. CLI rejects invalid target, empty --ds-css, and extra positionals BEFORE mutating HOME/.dsaf/update-check.json
    const r18Home = join(scratch, "r18-clean-home");
    mkdirSync(r18Home, { recursive: true });
    for (const cliBad of [
      [join(scratch, "missing-doc-target")],
      [r18DocDir, "--ds-css", ""],
      [r18DocDir, r18DocDir],
    ]) {
      const badRun = spawnSync(process.execPath, [docSelfPath, ...cliBad], {
        env: { ...process.env, HOME: r18Home, DSAF_NO_UPDATE_CHECK: "0" },
        encoding: "utf8",
      });
      assert.equal(badRun.status, 2);
    }
    assert.equal(existsSync(join(r18Home, ".dsaf/update-check.json")), false, "Failed CLI prechecks must never write HOME update-check.json");

    // Round 19 regression (R19-A1-05): broken symlink --out / ancestor rejects BEFORE writing HOME/.dsaf/update-check.json
    const r19DocHome = join(scratch, "r19-doc-home");
    mkdirSync(r19DocHome, { recursive: true });
    symlinkSync(join(scratch, "missing-out-dir"), join(scratch, "broken-doc-dir"));
    const brokenOutRun = spawnSync(process.execPath, [docSelfPath, r18DocDir, "--out", join(scratch, "broken-doc-dir/report.json")], {
      env: { ...process.env, HOME: r19DocHome, DSAF_NO_UPDATE_CHECK: "0" },
      encoding: "utf8",
    });
    assert.equal(brokenOutRun.status, 2);
    assert.equal(existsSync(join(r19DocHome, ".dsaf/update-check.json")), false);

    // Round 21 regressions (R21-A1-L5, R21-A1-L7, R21-A1-L8):
    // 1. Ahead-of-latest cache wording must not claim 'matches latest'
    const r21AheadCache = join(scratch, "r21-ahead-cache.json");
    writeFileSync(
      r21AheadCache,
      JSON.stringify({ schema: "dsaf-update-cache/1", latestVersion: "0.0.1", checkedAt: new Date().toISOString() })
    );
    const r21AheadRes = runDoctor(r18DocDir, { cachePath: r21AheadCache, offline: true });
    const r21AheadDetail = r21AheadRes.checks.find((c) => c.id === "cli_update_freshness").detail;
    assert.match(r21AheadDetail, /is ahead of npm latest v0\.0\.1/);
    assert.doesNotMatch(r21AheadDetail, /matches latest/);

    // 2. --scope probes runtime deps inside <scope>/node_modules first
    const r21Mono = join(scratch, "r21-mono");
    mkdirSync(join(r21Mono, "apps/web/node_modules/playwright"), { recursive: true });
    writeFileSync(join(r21Mono, "apps/web/package.json"), JSON.stringify({ name: "web-app", private: true }));
    writeFileSync(join(r21Mono, "apps/web/node_modules/playwright/package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }));
    writeFileSync(join(r21Mono, "apps/web/node_modules/playwright/index.cjs"), "exports.chromium = {};\n");
    const r21MonoDoc = runDoctor(r21Mono, { scope: "apps/web", cachePath: cacheUp, offline: true });
    assert.equal(r21MonoDoc.checks.find((c) => c.id === "runtime_deps").status, "OK");

    // 3. Regular file blocking nested --out parent gives clean contextual error (not raw ENOTDIR)
    const r21FileBlk = join(scratch, "r21-file-block.txt");
    writeFileSync(r21FileBlk, "blocking file\n");
    const r21OutBlkRun = spawnSync(process.execPath, [docSelfPath, r18DocDir, "--offline", "--out", join(r21FileBlk, "doc.json")], {
      encoding: "utf8",
    });
    assert.equal(r21OutBlkRun.status, 2);
    assert.match(r21OutBlkRun.stderr, /is not a directory/);
    assert.doesNotMatch(r21OutBlkRun.stderr, /ENOTDIR/);

    // 4. Round 23 regression (#5): CI=true / CI=1 suppresses online update check and disk cache writes
    for (const ciVal of ["true", "1"]) {
      const ciCache = join(scratch, `r23-doc-ci-${ciVal}.json`);
      const ciRun = spawnSync(process.execPath, [docSelfPath, good, "--json"], {
        env: { ...process.env, HOME: r19DocHome, CI: ciVal, DSAF_NO_UPDATE_CHECK: "", DSAF_UPDATE_CACHE: ciCache },
        encoding: "utf8",
      });
      assert.equal(ciRun.status, 0);
      assert.equal(existsSync(ciCache), false);
      const ciReport = JSON.parse(ciRun.stdout);
      assert.doesNotMatch(ciReport.checks.find((c) => c.id === "cli_update_freshness").detail, /\(online\)/);
    }

    // 5. Round 25 regressions (A1-H1 live leaf symlink & symlinked ancestor escape on --out)
    const r25DocSecret = join(scratch, "r25-doc-secret.json");
    const r25DocLiveSym = join(scratch, "r25-doc-live-sym.json");
    writeFileSync(r25DocSecret, '{"untouched":true}');
    symlinkSync(r25DocSecret, r25DocLiveSym);
    assert.equal(spawnSync(process.execPath, [docSelfPath, r18DocDir, "--offline", "--out", r25DocLiveSym], { encoding: "utf8" }).status, 2);
    assert.equal(readFileSync(r25DocSecret, "utf8"), '{"untouched":true}');

    const r25EscOutDir = join(scratch, "r25-esc-outside");
    const r25EscTarget = join(r25EscOutDir, "doc.json");
    const r25DocRepo = join(scratch, "r25-doc-repo");
    mkdirSync(r25EscOutDir, { recursive: true });
    mkdirSync(r25DocRepo, { recursive: true });
    writeFileSync(r25EscTarget, '{"untouched":true}');
    symlinkSync(r25EscOutDir, join(r25DocRepo, "linked-dir"));
    assert.equal(
      spawnSync(process.execPath, [docSelfPath, r25DocRepo, "--offline", "--out", join(r25DocRepo, "linked-dir/doc.json")], { encoding: "utf8" }).status,
      2
    );
    assert.equal(readFileSync(r25EscTarget, "utf8"), '{"untouched":true}');

    const r25DocCliSym = join(scratch, "r25-doc-cli-sym.mjs");
    symlinkSync(docSelfPath, r25DocCliSym);
    assert.equal(spawnSync(process.execPath, [r25DocCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 36 (R35-A1-M2): non-design config JSON files matching token/variable names must not satisfy tokens_and_docs_freshness
    const r36NoTok = join(scratch, "r36-non-design-json");
    mkdirSync(join(r36NoTok, "src"), { recursive: true });
    writeFileSync(join(r36NoTok, "src/token-config.json"), JSON.stringify({ ttl: 600, prefix: "pg" }));
    writeFileSync(join(r36NoTok, "src/variables.json"), JSON.stringify({ PORT: 3000 }));
    writeFileSync(join(r36NoTok, "src/tokenizer.json"), JSON.stringify({ mode: "bpe" }));
    const r36NoTokDoc = runDoctor(r36NoTok, { cachePath: cacheUp, offline: true });
    assert.equal(
      r36NoTokDoc.checks.find((c) => c.id === "tokens_and_docs_freshness").status,
      "WARN",
      "R36 A1-M2: non-design JSON config files must not be misclassified as design-token files"
    );

    console.log("DOCTOR_SELF_TEST_PASSED (guardrail parity + token mtime + hook/CI checks + Floor/waiver hygiene + update freshness)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
      scope: { type: "string" },
      "ds-css": { type: "string", multiple: true, default: [] },
      offline: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/doctor.mjs [target-dir] [--scope <subdir>] [--ds-css <path>] [--offline] [--json] [--out <file>] [--self-test] [--help]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  if (positionals.length > 1) {
    throw new Error(`Unexpected extra positional argument '${positionals[1]}'. Pass a single [target-dir].`);
  }
  if (positionals.length > 0 && positionals[0].trim().length === 0) {
    throw new Error("Target directory must be a non-empty path.");
  }
  const target = positionals.length > 0 ? positionals[0] : ".";
  const absRoot = resolve(target);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new Error(`Target directory not found: ${absRoot}`);
  }
  const { scopedRoot } = resolveDoctorScope(absRoot, values.scope);
  const cliDsCss = values["ds-css"] || [];
  if (cliDsCss.some((x) => typeof x !== "string" || x.trim().length === 0 || x.split(",").some((p) => p.trim().length === 0))) {
    throw new Error("Parameter '--ds-css' must be a non-empty file path.");
  }
  if (cliDsCss.length > 0) {
    discoverExternalDsCss(scopedRoot, cliDsCss);
  }
  if (values.out !== undefined) {
    assertWritableOutputFile(values.out, "--out", { rootDir: absRoot });
  }
  const noUpdateCheck =
    Boolean(values.offline) ||
    process.env.DSAF_NO_UPDATE_CHECK === "1" ||
    process.env.DSAF_NO_UPDATE_CHECK === "true" ||
    process.env.CI === "true" ||
    process.env.CI === "1";
  const updateStatus = await checkLatestVersion({
    currentVersion: DOCTOR_VERSION,
    cacheOnly: noUpdateCheck,
    timeoutMs: 1200,
  });
  const report = runDoctor(target, {
    scope: values.scope,
    dsCss: values["ds-css"],
    offline: noUpdateCheck,
    updateStatus,
  });
  const jsonStr = JSON.stringify(report, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), jsonStr, "utf8");
  }
  process.stdout.write(values.json ? jsonStr : renderDoctorText(report));
  process.exit(report.passed ? 0 : 1);
}

if (isDirectCliEntry(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

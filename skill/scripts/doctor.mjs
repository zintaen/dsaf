#!/usr/bin/env node
/**
 * DSAF v0.5.0 — Read-Only Diagnostic & Drift Inspector (`dsaf doctor`).
 * Zero external dependencies. Checks:
 * 1. CLI & generated guardrail version parity
 * 2. Token files & DESIGN/AGENTS doc mtime freshness
 * 3. Edit-time agent hook configuration
 * 4. CI regression gate workflow presence
 * 5. Optional Chromium/Playwright & axe-core discoverability
 * 6. Active Floor defects & stale `dsaf-ignore` waivers across UI files
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { probeRuntimeDeps } from "./audit-runtime.mjs";
import { checkTarget, installAgentHook } from "./dsaf-hook.mjs";

export const DOCTOR_VERSION = "0.8.0";

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
  "audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

function walkRepo(root, maxFiles = 1500) {
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < maxFiles) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory() && e.name.startsWith(".") && ![".claude", ".cursor", ".codex", ".github", ".dsaf-guardrails"].includes(e.name)) {
        continue;
      }
      const full = join(dir, e.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (/(^|\/)(?:ios\/App\/App\/public|android\/app\/src\/main\/assets\/public)\//i.test(rel)) continue;
      if (e.isDirectory()) queue.push(full);
      else files.push(full);
    }
  }
  return files;
}

export function runDoctor(targetDir = ".", options = {}) {
  const root = resolve(targetDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Target directory not found: ${root}`);
  }
  const currentVersion = options.version || DOCTOR_VERSION;
  const allFiles = walkRepo(root);
  const relFiles = allFiles.map((f) => relative(root, f).replace(/\\/g, "/"));
  const checks = [];

  // 1. CLI & guardrail parity
  const guardrailPaths = [".dsaf-guardrails/check-design-discipline.mjs", ".dsaf-guardrails/AGENTS-dsaf-rules.md"].filter((p) =>
    existsSync(join(root, p))
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
      const m = readFileSync(join(root, gp), "utf8").match(/DSAF[^(]*v(\d+\.\d+\.\d+)|DSAF v(\d+\.\d+\.\d+)/);
      if (m) versions.add(m[1] || m[2]);
    }
    const stale = [...versions].filter((v) => v !== currentVersion);
    checks.push(
      stale.length > 0
        ? {
            id: "cli_and_guardrail_parity",
            status: "WARN",
            detail: `Generated guardrails pinned to v${stale.join(", ")} (installed CLI is v${currentVersion}).`,
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
  const tokenFiles = relFiles.filter((r) => /(\.tokens\.json|(^|\/)(?:tokens?|variables)[^/]*\.(?:css|scss|json))$/i.test(r) && !/(^|\/)(?:tests?|fixtures|_audit|storybook-static)\//i.test(r));
  const designDoc = [".dsaf-guardrails/AGENTS-dsaf-rules.md", "DESIGN.md", "AGENTS.md"].find((p) => existsSync(join(root, p)));
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
  const hookCandidates = [".claude/settings.json", ".cursor/hooks.json", ".codex/hooks.json"];
  const installedHooks = [];
  for (const hc of hookCandidates) {
    const abs = join(root, hc);
    if (!existsSync(abs)) continue;
    const raw = readFileSync(abs, "utf8");
    if (raw.includes("dsaf-hook") || raw.includes("@zintaen/dsaf hook") || raw.includes("dsaf hook")) {
      installedHooks.push(hc);
    }
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

  // 4. CI regression workflow presence
  const wfFiles = relFiles.filter((r) => /^\.github\/workflows\/.+\.(ya?ml)$/i.test(r));
  const dsafWorkflow = wfFiles.find((wf) => {
    const raw = readFileSync(join(root, wf), "utf8");
    return /dsaf|check-design-discipline|dsaf-regression-gate/i.test(raw);
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
  const runtimeProbe = probeRuntimeDeps([root]);
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

  // 6. Waiver & Floor hygiene via shared dsaf-hook checkTarget
  const hookRes = checkTarget(root, { tier: "floor", reportUnusedIgnores: true });
  let floorHits = 0;
  let unusedIgnores = hookRes.counts.unusedIgnores || 0;
  let rejectedWaivers = 0;
  const sampleIssues = [];
  for (const f of hookRes.active) {
    if (f.ruleId === "dsaf/floor-waiver-rejected") rejectedWaivers++;
    if (f.ruleId === "dsaf/unused-ignore") {
      if (!hookRes.unusedIgnores?.length) unusedIgnores++;
    } else if (f.tier === "floor") {
      floorHits++;
    }
    if (sampleIssues.length < 8) sampleIssues.push(`${f.file}:${f.line} ${f.ruleId}`);
  }
  if (floorHits > 0 || rejectedWaivers > 0) {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "ACTION",
      detail: `Scanned ${hookRes.filesScanned} UI file(s): ${floorHits} Floor finding(s), ${rejectedWaivers} rejected Floor waiver(s), ${unusedIgnores} unused ignore(s).`,
      samples: sampleIssues,
      fix: "npx @zintaen/dsaf hook check . --tier floor --report-unused-ignores",
    });
  } else if (unusedIgnores > 0) {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "WARN",
      detail: `Scanned ${hookRes.filesScanned} UI file(s): 0 Floor findings, ${unusedIgnores} unused dsaf-ignore directive(s).`,
      samples: sampleIssues,
      fix: "Remove stale dsaf-ignore directives flagged by --report-unused-ignores",
    });
  } else {
    checks.push({
      id: "waiver_and_floor_hygiene",
      status: "OK",
      detail: `Scanned ${hookRes.filesScanned} UI file(s): 0 Floor findings, 0 stale waivers.`,
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
    installAgentHook({ agent: "claude", dir: good });

    const rGood = runDoctor(good);
    assert.equal(rGood.schema, "dsaf-doctor/1");
    assert.equal(rGood.passed, true);
    assert.equal(rGood.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "edit_time_hook").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "ci_regression_gate").status, "OK");
    assert.equal(rGood.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "OK");

    // 2. Stale guardrails, newer tokens, missing hook, active Floor violation -> ACTION
    const bad = join(scratch, "drifted");
    mkdirSync(join(bad, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(bad, "src"), { recursive: true });
    const gPath = join(bad, ".dsaf-guardrails/check-design-discipline.mjs");
    writeFileSync(gPath, "// Generated by DSAF v0.2.0\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(gPath, past, past);
    writeFileSync(join(bad, "src/tokens.css"), ":root { --ink: #111827; }\n");
    writeFileSync(join(bad, "src/bad.css"), ".btn { transition: all 200ms; }\n");

    const rBad = runDoctor(bad);
    assert.equal(rBad.passed, false);
    assert.equal(rBad.checks.find((c) => c.id === "cli_and_guardrail_parity").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "tokens_and_docs_freshness").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "edit_time_hook").status, "WARN");
    assert.equal(rBad.checks.find((c) => c.id === "waiver_and_floor_hygiene").status, "ACTION");

    console.log("DOCTOR_SELF_TEST_PASSED (guardrail parity + token mtime + hook/CI checks + Floor/waiver hygiene)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/doctor.mjs [target-dir] [--json] [--out <file>] [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  const target = positionals[0] || ".";
  const report = runDoctor(target);
  const jsonStr = JSON.stringify(report, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), jsonStr, "utf8");
  }
  process.stdout.write(values.json ? jsonStr : renderDoctorText(report));
  process.exit(report.passed ? 0 : 1);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

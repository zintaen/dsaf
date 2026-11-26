#!/usr/bin/env node
/**
 * DSAF v0.7.0 — Universal Repo Auto-Evolution Bootstrap (`dsaf init`).
 * Scaffolds `.dsaf/` governance (pinned STRATEGY.md, rules.json circuit breakers,
 * decision-queue.md, strategy-feedback.md, handoff.md) plus optional edit-time
 * hooks, CI guardrails, and workflow files. Zero external dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeDirectory } from "./recon.mjs";
import { installAgentHook } from "./dsaf-hook.mjs";
import { generateGuardrails } from "./generate-guardrails.mjs";

export const INIT_VERSION = "0.7.0";

const RESOURCE_STRATEGY_PATH = decodeURIComponent(
  new URL("../resources/evolve-strategy.md", import.meta.url).pathname
);

function normalizeRel(baseDir, filePath) {
  return relative(baseDir, filePath).replace(/\\/g, "/");
}

function buildStrategyContent(repoName, mode, surfaceMode) {
  const baseBody = existsSync(RESOURCE_STRATEGY_PATH)
    ? readFileSync(RESOURCE_STRATEGY_PATH, "utf8").trim()
    : "# DSAF Repository Auto-Evolution Strategy\n";
  return [
    `<!-- Bootstrapped by @zintaen/dsaf v${INIT_VERSION} -->`,
    `<!-- Repo: ${repoName} | Mode: ${mode} | Surface: ${surfaceMode} -->`,
    "",
    baseBody,
    "",
  ].join("\n");
}

function buildRulesConfig({ repoName, recon, mode, guardrailsEnabled, hooksInstalled }) {
  const surfaceMode = recon?.surfaceMode || "Operate";
  const detectedTokens = Array.isArray(recon?.samples?.tokenFiles)
    ? recon.samples.tokenFiles.slice(0, 20)
    : Array.isArray(recon?.tokenFiles)
    ? recon.tokenFiles.slice(0, 20)
    : [];
  const protectedFiles = [
    ".dsaf/STRATEGY.md",
    ".dsaf/rules.json",
    ".dsaf-guardrails/**",
    ...detectedTokens,
  ];
  return {
    schema: "dsaf-init-rules/1",
    strategyVersion: INIT_VERSION,
    repository: repoName,
    mode,
    surfaceMode,
    loopMode: "focused",
    killSwitchFile: ".dsaf/STOP",
    circuitBreakerFile: ".dsaf/circuit-breaker.json",
    budgets: {
      maxFilesPerRound: 5,
      maxConsecutiveFailures: 2,
      allowWaiverFloor: false,
    },
    gates: {
      floorMax: 0,
      apcaBodyMin: 60,
      apcaLargeMin: 45,
      minTapTargetPx: 44,
      allowHardcodedColors: false,
    },
    protectedFiles: [...new Set(protectedFiles)],
    integrations: {
      guardrails: Boolean(guardrailsEnabled),
      hooks: hooksInstalled,
    },
  };
}

function buildDecisionQueue(repoName) {
  return [
    `# DSAF Decision Queue — ${repoName}`,
    "",
    "Ambiguous design-system choices, protected-file edits (`.dsaf/rules.json#protectedFiles`), and multi-track UI decisions are queued here before altering shared foundations (Principle C4).",
    "",
    "## Pending Decisions",
    "",
    "_No pending decisions. Add entries as `- [ ] <ID>: <question & options>` when autonomous verification pauses._",
    "",
  ].join("\n");
}

function buildStrategyFeedback(repoName) {
  return [
    `# DSAF Strategy Feedback — ${repoName}`,
    "",
    "Domain-stripped rule friction, false-positive edge cases, and precision refinements discovered during local evolution runs (Principle C8).",
    "",
    "## Observations",
    "",
    "_Log findings here as `<date> | <script> | <observed friction> | <proposed fix>`._",
    "",
  ].join("\n");
}

function buildHandoff({ repoName, mode, surfaceMode, hooksInstalled, guardrailsEnabled }) {
  return [
    `# DSAF Evolve Handoff — ${repoName}`,
    "",
    `- **Engine Version:** ${INIT_VERSION}`,
    `- **Detected Mode:** ${mode} | **Surface:** ${surfaceMode}`,
    `- **Loop Mode:** focused (create \`.dsaf/STOP\` to halt cleanly at next checkpoint)`,
    `- **Edit-Time Hooks:** ${hooksInstalled.length > 0 ? hooksInstalled.join(", ") : "not installed (pass --with-hook)"}`,
    `- **CI Guardrails:** ${guardrailsEnabled ? "enabled (.dsaf-guardrails/)" : "not generated (pass --with-guardrails)"}`,
    "",
    "## Verification Baseline Commands",
    "",
    "```bash",
    "npx @zintaen/dsaf hook check . --tier floor",
    "npx @zintaen/dsaf tokens . --json",
    "npx @zintaen/dsaf audit . --out ./audit-output",
    "```",
    "",
    "## Current Iteration Log",
    "",
    "- Initialized `.dsaf/` governance workspace. Ready for Step 0 recon & Red-to-Green fix cycle (C2).",
    "",
  ].join("\n");
}

function writeManagedFile(absPath, content, { dryRun, force }, created, skipped, baseDir) {
  const rel = normalizeRel(baseDir, absPath);
  if (existsSync(absPath) && !force) {
    skipped.push(rel);
    return;
  }
  if (!dryRun) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  created.push(rel);
}

export function initEvolve(options = {}) {
  const absTarget = resolve(options.targetDir || ".");
  if (!existsSync(absTarget)) {
    throw new Error(`Target directory not found: ${absTarget}`);
  }

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const withHook = Boolean(options.withHook);
  const agent = options.agent || "claude";
  const withGuardrails = Boolean(options.withGuardrails);
  const withWorkflow = Boolean(options.withWorkflow);
  const requestedMode = options.mode && options.mode !== "auto" ? options.mode : null;

  const recon = analyzeDirectory(absTarget);
  const mode = requestedMode || recon.recommendedMode || "P";
  const surfaceMode = recon.surfaceMode || "Operate";
  const repoName = basename(absTarget);

  const hooksInstalled = [];
  const hookFiles = [];
  if (withHook) {
    const agents = agent === "all" ? ["claude", "cursor", "codex"] : [agent];
    for (const ag of agents) {
      if (!dryRun) {
        const res = installAgentHook({ agent: ag, dir: absTarget, local: false });
        hooksInstalled.push(ag);
        hookFiles.push(normalizeRel(absTarget, res.file));
      } else {
        hooksInstalled.push(ag);
      }
    }
  }

  const guardrailFiles = [];
  if (withGuardrails && !dryRun) {
    const frameworks = (recon.stack?.frameworks || []).map((f) => String(f).toLowerCase());
    const stack =
      Boolean(recon.stack?.hasTailwindTheme) || frameworks.some((f) => f.includes("tailwind"))
        ? "tailwind"
        : "css";
    const generated = generateGuardrails({
      outDir: join(absTarget, ".dsaf-guardrails"),
      stack,
      mode,
    });
    for (const p of generated) guardrailFiles.push(normalizeRel(absTarget, p));
  }

  const created = [];
  const skipped = [];
  const dsafDir = join(absTarget, ".dsaf");
  const rulesObj = buildRulesConfig({
    repoName,
    recon,
    mode,
    guardrailsEnabled: withGuardrails,
    hooksInstalled,
  });

  writeManagedFile(
    join(dsafDir, "STRATEGY.md"),
    buildStrategyContent(repoName, mode, surfaceMode),
    { dryRun, force },
    created,
    skipped,
    absTarget
  );
  writeManagedFile(
    join(dsafDir, "rules.json"),
    JSON.stringify(rulesObj, null, 2) + "\n",
    { dryRun, force },
    created,
    skipped,
    absTarget
  );
  writeManagedFile(
    join(dsafDir, "decision-queue.md"),
    buildDecisionQueue(repoName),
    { dryRun, force },
    created,
    skipped,
    absTarget
  );
  writeManagedFile(
    join(dsafDir, "strategy-feedback.md"),
    buildStrategyFeedback(repoName),
    { dryRun, force },
    created,
    skipped,
    absTarget
  );
  writeManagedFile(
    join(dsafDir, "handoff.md"),
    buildHandoff({
      repoName,
      mode,
      surfaceMode,
      hooksInstalled,
      guardrailsEnabled: withGuardrails,
    }),
    { dryRun, force },
    created,
    skipped,
    absTarget
  );

  let workflowFile = null;
  if (withWorkflow) {
    const wfPath = join(absTarget, ".github/workflows/dsaf-gate.yml");
    const wfBody = [
      "name: DSAF Evolution Gate",
      "on:",
      "  pull_request:",
      "  push:",
      "    branches: [main]",
      "jobs:",
      "  dsaf:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - uses: zintaen/dsaf@v${INIT_VERSION}`,
      "        with:",
      "          target: .",
      '          fail-on-floor: "true"',
      '          upload-sarif: "true"',
      "",
    ].join("\n");
    writeManagedFile(wfPath, wfBody, { dryRun, force }, created, skipped, absTarget);
    workflowFile = normalizeRel(absTarget, wfPath);
  }

  return {
    schema: "dsaf-init/1",
    version: INIT_VERSION,
    target: absTarget,
    repository: repoName,
    mode,
    surfaceMode,
    dryRun,
    created,
    skipped,
    hookFiles,
    guardrailFiles,
    workflowFile,
  };
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-init-test-"));
  try {
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src/tokens.css"), ":root { --surface: #FFFDF8; --ink: #45210E; }\n", "utf8");
    writeFileSync(join(scratch, "src/Button.tsx"), "export function Button() { return <button type=\"button\">Save</button>; }\n", "utf8");

    const dry = initEvolve({ targetDir: scratch, dryRun: true, withHook: true, withGuardrails: true, withWorkflow: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created.length, 6);
    assert.equal(existsSync(join(scratch, ".dsaf/rules.json")), false, "dry-run must not write files");

    const full = initEvolve({ targetDir: scratch, withHook: true, agent: "claude", withGuardrails: true, withWorkflow: true });
    assert.equal(full.dryRun, false);
    assert.ok(full.created.includes(".dsaf/STRATEGY.md"));
    assert.ok(full.created.includes(".dsaf/rules.json"));
    assert.ok(full.created.includes(".dsaf/decision-queue.md"));
    assert.ok(full.created.includes(".dsaf/strategy-feedback.md"));
    assert.ok(full.created.includes(".dsaf/handoff.md"));
    assert.ok(full.created.includes(".github/workflows/dsaf-gate.yml"));
    assert.equal(full.guardrailFiles.length, 3);
    assert.equal(full.hookFiles.length, 1);

    const parsedRules = JSON.parse(readFileSync(join(scratch, ".dsaf/rules.json"), "utf8"));
    assert.equal(parsedRules.schema, "dsaf-init-rules/1");
    assert.equal(parsedRules.strategyVersion, INIT_VERSION);
    assert.equal(parsedRules.budgets.allowWaiverFloor, false);
    assert.equal(parsedRules.killSwitchFile, ".dsaf/STOP");
    assert.match(readFileSync(join(scratch, ".github/workflows/dsaf-gate.yml"), "utf8"), /fail-on-floor/);

    // Existing custom rules must be preserved unless --force is passed
    writeFileSync(join(scratch, ".dsaf/decision-queue.md"), "# Custom Queue\n", "utf8");
    const second = initEvolve({ targetDir: scratch, withWorkflow: true });
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 6);
    assert.equal(readFileSync(join(scratch, ".dsaf/decision-queue.md"), "utf8"), "# Custom Queue\n");

    const forced = initEvolve({ targetDir: scratch, force: true });
    assert.equal(forced.created.length, 5);
    assert.match(readFileSync(join(scratch, ".dsaf/decision-queue.md"), "utf8"), /DSAF Decision Queue/);

    console.log("DSAF_INIT_SELF_TEST_PASSED");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function printUsage() {
  console.log(
    "Usage: dsaf init [targetDir] [--with-hook] [--agent claude|cursor|codex|all] [--with-guardrails] [--with-workflow] [--mode auto|S|C|P] [--dry-run] [--force] [--json] [--self-test]"
  );
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isEntrypoint) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "with-hook": { type: "boolean", default: false },
      agent: { type: "string", default: "claude" },
      "with-guardrails": { type: "boolean", default: false },
      "with-workflow": { type: "boolean", default: false },
      mode: { type: "string", default: "auto" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const res = initEvolve({
    targetDir: positionals[0] || ".",
    withHook: values["with-hook"],
    agent: values.agent,
    withGuardrails: values["with-guardrails"],
    withWorkflow: values["with-workflow"],
    mode: values.mode,
    dryRun: values["dry-run"],
    force: values.force,
  });

  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`DSAF_INIT v${res.version} (${res.dryRun ? "DRY RUN" : "APPLIED"}): ${res.repository} [Mode ${res.mode}, ${res.surfaceMode}]`);
    console.log(`  Created (${res.created.length}): ${res.created.join(", ") || "none"}`);
    if (res.skipped.length > 0) console.log(`  Skipped (${res.skipped.length}): ${res.skipped.join(", ")}`);
    if (res.hookFiles.length > 0) console.log(`  Hooks: ${res.hookFiles.join(", ")}`);
    if (res.guardrailFiles.length > 0) console.log(`  Guardrails: ${res.guardrailFiles.join(", ")}`);
  }
}

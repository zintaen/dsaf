#!/usr/bin/env node
/**
 * DSAF v0.3.0 — Unified Tier 0 Read-Only One-Click Audit Pipeline (Node ESM).
 * Chains `recon`, `tokens`, optional live/Storybook `runtime`, optional 3-vertex
 * `figma-diff`, and optional `audit-diff` into `audit-summary.json` + Markdown.
 * Strictly Tier 0 Read-Only on target repos; writes only inside explicit `--out`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scanTarget } from "./audit-tokens.mjs";
import { compareVertices, renderMarkdown as renderFigmaMarkdown } from "./audit-figma-diff.mjs";

const SCRIPT_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));

function runSubScript(scriptName, args) {
  return spawnSync(process.execPath, [join(SCRIPT_DIR, scriptName), ...args], {
    encoding: "utf8",
  });
}

export function runAuditPipeline(opts = {}) {
  const target = resolve(opts.target || ".");
  if (!existsSync(target)) throw new Error(`Audit target not found: ${target}`);
  const outDir = opts.outDir ? resolve(opts.outDir) : null;
  if (outDir) mkdirSync(outDir, { recursive: true });

  // 1. Step 0 Read-Only Recon
  const reconArgs = [target];
  const reconPath = outDir ? join(outDir, "recon.json") : null;
  if (reconPath) reconArgs.push("--out", reconPath);
  const reconRes = runSubScript("recon.mjs", reconArgs);
  if (reconRes.status !== 0) {
    throw new Error(`recon failed: ${reconRes.stderr || reconRes.stdout}`);
  }
  const recon = JSON.parse(reconPath ? readFileSync(reconPath, "utf8") : reconRes.stdout);

  // 2. Token & Drift Audit
  const tokens = scanTarget(target, {
    includeDemos: Boolean(opts.includeDemos),
    scope: opts.scope || undefined,
  });
  const tokensPath = outDir ? join(outDir, "tokens.json") : null;
  if (tokensPath) writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + "\n", "utf8");

  // 3. Optional Runtime Audit
  let runtime = null;
  let runtimePassed = true;
  let runtimeFileForDiff = null;
  if (opts.url || opts.storybook) {
    const rtArgs = [];
    if (opts.url) rtArgs.push(opts.url, "--live");
    if (opts.storybook) rtArgs.push("--storybook", opts.storybook);
    if (opts.routes) rtArgs.push("--routes", opts.routes);
    if (opts.axePath) rtArgs.push("--axe", opts.axePath);
    if (opts.executablePath) rtArgs.push("--executable-path", opts.executablePath);
    if (opts.themeToggle) rtArgs.push("--theme-toggle", opts.themeToggle);
    const rtPath = outDir ? join(outDir, "runtime.json") : null;
    if (rtPath) {
      rtArgs.push("--out", rtPath);
      runtimeFileForDiff = rtPath;
    } else {
      rtArgs.push("--json");
    }
    const rtRes = runSubScript("audit-runtime.mjs", rtArgs);
    runtimePassed = rtRes.status === 0;
    const rawRt = rtPath && existsSync(rtPath) ? readFileSync(rtPath, "utf8") : rtRes.stdout;
    if (rawRt && rawRt.trim().startsWith("{")) {
      runtime = JSON.parse(rawRt);
    } else if (!runtimePassed) {
      throw new Error(`runtime audit failed: ${rtRes.stderr || rtRes.stdout}`);
    }
  }

  // 4. Optional 3-Vertex Figma Triangulation
  let figmaDiff = null;
  if (opts.figmaPath) {
    figmaDiff = compareVertices({
      figmaPath: opts.figmaPath,
      tokensArg: opts.scope ? join(target, opts.scope) : target,
      codeConnectDir: opts.codeConnectDir || null,
      runtimePath: runtimeFileForDiff,
      prefix: opts.prefix || null,
    });
    if (outDir) {
      writeFileSync(join(outDir, "figma-diff.json"), JSON.stringify(figmaDiff, null, 2) + "\n", "utf8");
      writeFileSync(join(outDir, "figma-diff.md"), renderFigmaMarkdown(figmaDiff), "utf8");
    }
  }

  // 5. Optional Regression Diff
  let regressionDiff = null;
  let regressionPassed = true;
  if (opts.baselinePath && opts.currentPath) {
    const diffArgs = ["--baseline", resolve(opts.baselinePath), "--current", resolve(opts.currentPath)];
    const diffOutPath = outDir ? join(outDir, "audit-diff.md") : null;
    if (diffOutPath) diffArgs.push("--out", diffOutPath);
    const diffRes = runSubScript("audit-diff.mjs", diffArgs);
    regressionPassed = diffRes.status === 0;
    regressionDiff = {
      passed: regressionPassed,
      output: (diffRes.stdout || "").trim(),
      reportFile: diffOutPath,
    };
  }

  const summary = {
    schema: "dsaf-audit/1",
    engine_version: "0.3.0",
    generated: new Date().toISOString(),
    dataTier: "tier_0_readonly",
    target,
    passed: runtimePassed && regressionPassed,
    recon: {
      recommendedMode: recon.recommendedMode,
      topologyLabel: recon.topologyLabel,
      estimatedMaturity: recon.estimatedMaturity,
      filesScanned: recon.filesScanned,
      t2MockRequired: recon.t2MockRequired,
      frameworks: recon.stack?.frameworks || [],
      designSystemPackages: recon.stack?.designSystemPackages || [],
    },
    tokens: {
      target: tokens.target,
      filesScanned: tokens.filesScanned,
      dtcgTokenCount: tokens.dtcg?.tokenCount ?? 0,
      drift: tokens.drift,
    },
    runtime: runtime
      ? {
          allPassed: Boolean(runtime.allPassed),
          axeLoaded: Boolean(runtime.axeLoaded),
          filesCount: runtime.files?.length ?? 0,
          computedVarsSampled: runtime.files?.[0]?.computedVars ? Object.keys(runtime.files[0].computedVars).length : 0,
        }
      : null,
    figmaDiff: figmaDiff
      ? {
          summary: figmaDiff.summary,
          codeConnect: figmaDiff.codeConnect
            ? {
                files: figmaDiff.codeConnect.codeConnectFiles,
                mappedComponentsCount: figmaDiff.codeConnect.mappedComponentsCount,
              }
            : null,
          shippedSummary: figmaDiff.shippedSummary,
        }
      : null,
    regressionDiff,
  };

  if (outDir) {
    writeFileSync(join(outDir, "audit-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    writeFileSync(join(outDir, "audit-summary.md"), renderAuditMarkdown(summary), "utf8");
  }
  return summary;
}

export function renderAuditMarkdown(summary) {
  const d = summary.tokens.drift;
  const r = summary.recon;
  const lines = [
    "# DSAF Unified Audit Summary (`v0.3.0` · Tier 0 Read-Only)",
    "",
    `- **Target:** \`${summary.target}\``,
    `- **Topology / Maturity:** \`Mode ${r.recommendedMode}\` (${r.topologyLabel}) | \`${r.estimatedMaturity}\` | \`T2-Mock required: ${r.t2MockRequired}\``,
    `- **Pipeline Status:** ${summary.passed ? "PASS" : "FAIL"}`,
    "",
    "## Codebase Tokens & Drift",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Scanned UI/Style Files | ${summary.tokens.filesScanned.uiAndStyle} (DTCG JSON: ${summary.tokens.filesScanned.tokenJson}, Demo skipped: ${d.demoFilesSkipped.length}, Server OG skipped: ${d.serverImageFiles.length}) |`,
    `| Color Token Compliance | ${d.tokenCompliancePct ?? "N/A"}% (\`var()\`=${d.colorTokenRefs} vs hardcoded=${d.hardcodedColorHits}) |`,
    `| CSS Orphans | ${d.orphanCssVariableCount} (semantic=${d.semanticOrphanCount}, palette/scale=${d.paletteScaleUnusedCount}) |`,
    `| \`!important\` / Off-Grid Spacing | ${d.importantOverrides} / ${d.offGridSpacingHits} |`,
    `| Tailwind Arbitrary / Primitive | colors=${d.tailwind.arbitraryColors}, spacing=${d.tailwind.arbitrarySpacing}, primitive=${d.tailwind.primitiveColors} |`,
  ];
  if (d.recommendedScope) lines.push(`| Recommended App Scope | \`${d.recommendedScope}\` |`);
  lines.push("");

  if (summary.runtime) {
    lines.push(
      "## Live Runtime Verification",
      "",
      `- **Status:** ${summary.runtime.allPassed ? "PASS" : "FAIL"} | Pages: ${summary.runtime.filesCount} | \`axe-core\`: ${summary.runtime.axeLoaded} | Computed Root Vars: ${summary.runtime.computedVarsSampled}`,
      ""
    );
  }
  if (summary.figmaDiff) {
    const fs = summary.figmaDiff.summary;
    lines.push(
      "## 3-Vertex Figma Triangulation",
      "",
      `- **Coverage:** ${fs.triangulationCoveragePct ?? "N/A"}% (${fs.matchedCount}/${fs.figmaVariables}) | Value Drift: ${fs.valueDriftCount} | Design-Only: ${fs.designOnlyCount} | Code-Only: ${fs.codeOnlyCount}`,
      ""
    );
  }
  if (summary.regressionDiff) {
    lines.push(
      "## No-Silent-Regression Diff",
      "",
      `- **Status:** ${summary.regressionDiff.passed ? "PASS" : "FAIL"}`,
      ""
    );
  }
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-pipeline-test-"));
  try {
    const repoDir = join(scratch, "demo-ds-app");
    const outDir = join(scratch, "audit-out");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "demo"), { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "demo-app", dependencies: { react: "^19.0.0", tailwindcss: "^4.0.0" } })
    );
    writeFileSync(
      join(repoDir, "src/tokens.css"),
      `:root { --brand-primary: #1d4ed8; --gray-100: #f3f4f6; }\n.cta { color: var(--brand-primary); }\n`
    );
    writeFileSync(
      join(repoDir, "demo/old-prototype.html"),
      `<div style="color:#ff00aa;padding:13px !important;">demo</div>`
    );
    const figmaPath = join(scratch, "figma.json");
    writeFileSync(figmaPath, JSON.stringify({ "brand/primary": "#1d4ed8" }));

    const summary = runAuditPipeline({
      target: repoDir,
      figmaPath,
      outDir,
    });
    assert.equal(summary.schema, "dsaf-audit/1");
    assert.equal(summary.engine_version, "0.3.0");
    assert.equal(summary.passed, true);
    assert.equal(summary.tokens.drift.hardcodedColorHits, 0);
    assert.deepEqual(summary.tokens.drift.demoFilesSkipped, ["demo/old-prototype.html"]);
    assert.equal(summary.figmaDiff.summary.matchedCount, 1);
    assert.ok(existsSync(join(outDir, "audit-summary.json")));
    assert.ok(existsSync(join(outDir, "audit-summary.md")));
    assert.ok(existsSync(join(outDir, "recon.json")));
    assert.ok(existsSync(join(outDir, "tokens.json")));
    assert.ok(existsSync(join(outDir, "figma-diff.json")));

    console.log("AUDIT_PIPELINE_SELF_TEST_PASSED (recon + scoped tokens + figma-diff + markdown summary)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      routes: { type: "string" },
      figma: { type: "string" },
      "code-connect": { type: "string" },
      prefix: { type: "string" },
      storybook: { type: "string" },
      baseline: { type: "string" },
      current: { type: "string" },
      axe: { type: "string" },
      "executable-path": { type: "string" },
      "theme-toggle": { type: "string" },
      "include-demos": { type: "boolean", default: false },
      scope: { type: "string" },
      out: { type: "string" },
      format: { type: "string", default: "markdown" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-pipeline.mjs <target> [--url <url>] [--routes /,/about] [--figma <vars.json>] [--code-connect <dir>] [--prefix <str>] [--storybook <url|index.json>] [--baseline <a.json> --current <b.json>] [--include-demos] [--scope <subdir>] [--out <dir>] [--format markdown|json] [--self-test]"
    );
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  const target = positionals[0];
  if (!target) {
    console.error("Error: <target> directory is required unless --self-test is passed.");
    process.exit(2);
  }

  const summary = runAuditPipeline({
    target,
    url: values.url,
    routes: values.routes,
    figmaPath: values.figma,
    codeConnectDir: values["code-connect"],
    prefix: values.prefix,
    storybook: values.storybook,
    baselinePath: values.baseline,
    currentPath: values.current,
    axePath: values.axe,
    executablePath: values["executable-path"],
    themeToggle: values["theme-toggle"],
    includeDemos: values["include-demos"],
    scope: values.scope,
    outDir: values.out,
  });

  process.stdout.write(values.format === "json" ? JSON.stringify(summary, null, 2) + "\n" : renderAuditMarkdown(summary));
  process.exit(summary.passed ? 0 : 1);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

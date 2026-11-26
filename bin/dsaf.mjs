#!/usr/bin/env node
/**
 * DSAF CLI — Single entry point for Design System & Product UX/UI audits.
 * Dispatches cleanly to Tier 1 skill/scripts/* and Tier 2 evolve/scripts/* tools.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BIN_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const REPO_ROOT = resolve(BIN_DIR, "..");

const COMMANDS = {
  audit: { script: "skill/scripts/audit-pipeline.mjs", desc: "One-click Tier 0 Read-Only audit pipeline (recon + tokens + runtime + figma + diff)" },
  init: { script: "skill/scripts/init-evolve.mjs", desc: "Bootstrap .dsaf/ auto-evolution governance (C1-C10), hooks & CI guardrails" },
  fix: { script: "skill/scripts/fix-floor.mjs", desc: "Dry-run preview or apply safe bounded Floor remediations (--apply --backup)" },
  evolve: { script: "skill/scripts/evolve-runner.mjs", desc: "Supervised .dsaf/ evolution runner with kill-switch & circuit breaker" },
  mcp: { script: "skill/scripts/mcp-server.mjs", desc: "Zero-dep JSON-RPC 2.0 stdio MCP server exposing 8 read-only audit tools" },
  recon: { script: "skill/scripts/recon.mjs", desc: "Read-only topology & T2-Mock recon (Mode S / C / P)" },
  tokens: { script: "skill/scripts/audit-tokens.mjs", desc: "W3C DTCG validator, Light/Dark parity & CSS/Tailwind drift" },
  "figma-diff": { script: "skill/scripts/audit-figma-diff.mjs", desc: "Compare Figma MCP variables & Code Connect against DTCG/CSS" },
  runtime: { script: "skill/scripts/audit-runtime.mjs", desc: "Playwright APCA/WCAG, keyboard map, Storybook, screenshot & N-of-1 verifier" },
  scorecard: { script: "skill/scripts/compute-scorecard.mjs", desc: "Deterministic weighted scorecard & blocker calculator" },
  diff: { script: "skill/scripts/audit-diff.mjs", desc: "No-silent-regression diff verifier with override logging" },
  guardrails: { script: "skill/scripts/generate-guardrails.mjs", desc: "Generate runnable CI & AI-agent design guardrails" },
  "install-skill": { script: "skill/scripts/install-skill.mjs", desc: "Install Tier 1 DSAF skill into Claude/Cursor/Codex/Antigravity" },
  hook: { script: "skill/scripts/dsaf-hook.mjs", desc: "Edit-time agent Floor/Reflex hook checker & installer" },
  doctor: { script: "skill/scripts/doctor.mjs", desc: "Inspect guardrail/token/hook/waiver drift & runtime setup" },
  integrity: { script: "skill/scripts/check-integrity.mjs", desc: "Tier 1 skill integrity & self-test runner" },
  verify: { script: "evolve/scripts/validate-isolation.mjs", desc: "Full repo isolation, schema & version parity gate" },
  mine: { script: "evolve/scripts/mine-signals.mjs", desc: "Aggregate retro signals & calibration metrics" },
  sync: { script: "evolve/scripts/sync-skills.mjs", desc: "Install/sync local dsaf + dsaf-evolve IDE skills" },
};

function getPkg() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

function printHelp() {
  const pkg = getPkg();
  console.log(`DSAF v${pkg.version} — Design System & Product UX/UI Audit Framework\n`);
  console.log("Usage: dsaf <command> [args...]\n");
  console.log("Commands:");
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${info.desc}`);
  }
  console.log("  version      Print installed DSAF CLI version");
  console.log("  help         Show this help message\n");
  console.log("Examples:");
  console.log("  dsaf audit ./my-app --out ./audit-output --sarif ./dsaf.sarif");
  console.log("  dsaf init ./my-app --with-hook --with-guardrails");
  console.log("  dsaf fix ./my-app/src --dry-run");
  console.log("  dsaf evolve ./my-app --status --json");
  console.log("  dsaf mcp");
  console.log("  dsaf recon ./my-app");
  console.log("  dsaf tokens ./my-app --json --report-unused-ignores");
  console.log("  dsaf hook check ./my-app/src --tier floor");
  console.log("  dsaf hook install --agent claude --dir ./my-app");
  console.log("  dsaf install-skill --agent claude --scope user");
  console.log("  dsaf doctor ./my-app");
  console.log("  dsaf guardrails --out ./my-app/.dsaf-guardrails --stack tailwind");
  console.log("  dsaf runtime ./draft/preview.html --screenshot ./preview.png --pins");
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exit(0);
  }
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    console.log(`dsaf v${getPkg().version}`);
    process.exit(0);
  }
  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`Unknown DSAF command: '${cmd}'\n`);
    printHelp();
    process.exit(2);
  }
  const res = spawnSync(process.execPath, [join(REPO_ROOT, entry.script), ...rest], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}

main();

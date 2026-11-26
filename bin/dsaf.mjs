#!/usr/bin/env node
/**
 * DSAF CLI — Single entry point for Design System & Product UX/UI audits.
 * Dispatches cleanly to Tier 1 skill/scripts/* and Tier 2 evolve/scripts/* tools.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BIN_DIR = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const REPO_ROOT = resolve(BIN_DIR, "..");

const COMMANDS = {
  check: { script: "skill/scripts/audit-pipeline.mjs", defaultArgs: ["--compact"], defaultTarget: ".", desc: "Fast 1-command UI, token & persona check on your project" },
  setup: { script: "skill/scripts/setup.mjs", desc: "Install DSAF agent skill, wire MCP config & optional CI gate" },
  audit: { script: "skill/scripts/audit-pipeline.mjs", desc: "Full Tier 0 Read-Only audit pipeline (JSON / Markdown / --html / SARIF)" },
  fix: { script: "skill/scripts/fix-floor.mjs", desc: "Dry-run preview or apply safe Floor fixes (--apply --backup)" },
  init: { script: "skill/scripts/init-evolve.mjs", desc: "Bootstrap .dsaf/ auto-evolution governance (v1.2.0) & personas" },
  personas: { script: "skill/scripts/generate-personas.mjs", desc: "Generate uncapped signal-driven user personas (.dsaf/personas.json)" },
  evolve: { script: "skill/scripts/evolve-runner.mjs", desc: "Supervised .dsaf/ evolution runner with kill-switch & lease" },
  mcp: { script: "skill/scripts/mcp-server.mjs", desc: "Stdio MCP server (9 tools) + `dsaf mcp install` client configurator" },
  recon: { script: "skill/scripts/recon.mjs", desc: "Read-only topology & Surface Mode recon (Mode S / C / P)" },
  tokens: { script: "skill/scripts/audit-tokens.mjs", desc: "W3C DTCG validator, Light/Dark parity & CSS/Tailwind drift" },
  "figma-diff": { script: "skill/scripts/audit-figma-diff.mjs", desc: "Compare Figma variables / DTCG tokens against live CSS runtime" },
  runtime: { script: "skill/scripts/audit-runtime.mjs", desc: "Playwright APCA/WCAG, keyboard map, Storybook, screenshot & interaction checks" },
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
  console.log(`DSAF v${pkg.version} — Design System & Product UX/UI Audit CLI\n`);
  console.log("Quick Start:");
  console.log("  npx @zintaen/dsaf check .                   Check your repo in one command");
  console.log("  npx @zintaen/dsaf setup --agent claude      Install AI skill + wire MCP server");
  console.log("  npx @zintaen/dsaf fix . --dry-run           Preview safe accessibility/CSS fixes");
  console.log("  npx @zintaen/dsaf audit . --html report.html  Export an editorial HTML report\n");
  console.log("Usage: dsaf <command|path> [args...]\n");
  console.log("All Commands:");
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(14)} ${info.desc}`);
  }
  console.log("  version        Print installed DSAF CLI version");
  console.log("  help           Show this help message");
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

  let entry = COMMANDS[cmd];
  let passArgs = [...rest];

  if (!entry) {
    if (!cmd.startsWith("-") && existsSync(resolve(cmd))) {
      entry = COMMANDS.check;
      passArgs = [cmd, ...rest];
    } else {
      console.error(`Unknown DSAF command: '${cmd}'\n`);
      printHelp();
      process.exit(2);
    }
  }

  if (entry === COMMANDS.check) {
    const hasPositional = passArgs.some((a) => !a.startsWith("-"));
    const asksHelp = passArgs.includes("-h") || passArgs.includes("--help") || passArgs.includes("--self-test");
    if (!asksHelp) {
      if (!hasPositional) passArgs.unshift(entry.defaultTarget);
      if (!passArgs.includes("--compact") && !passArgs.includes("--format")) {
        passArgs.push(...entry.defaultArgs);
      }
    }
  }

  const res = spawnSync(process.execPath, [join(REPO_ROOT, entry.script), ...passArgs], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}

main();

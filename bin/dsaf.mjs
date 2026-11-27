#!/usr/bin/env node
/**
 * DSAF CLI — Single entry point for Design System & Product UX/UI audits.
 * Dispatches cleanly to `skill/scripts/*` and repo verification tools.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntry } from "../skill/scripts/ci-report.mjs";
import { maybeNotifyUpdate } from "../skill/scripts/update-check.mjs";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BIN_DIR, "..");

const COMMANDS = {
  check: { script: "skill/scripts/audit-pipeline.mjs", defaultArgs: ["--compact"], defaultTarget: ".", desc: "Fast 1-command UI, token & persona check on your project" },
  setup: { script: "skill/scripts/setup.mjs", desc: "Install DSAF agent skill, wire MCP config & optional hooks/CI/auto-update" },
  update: { script: "skill/scripts/update.mjs", desc: "Check or apply DSAF CLI, skill, guardrail & workflow updates" },
  upgrade: { script: "skill/scripts/update.mjs", desc: "Alias for `dsaf update`" },
  audit: { script: "skill/scripts/audit-pipeline.mjs", desc: "Full Tier 0 Read-Only audit pipeline (JSON / Markdown / --html / SARIF)" },
  fix: { script: "skill/scripts/fix-floor.mjs", desc: "Dry-run preview or apply safe Floor fixes (--apply --backup)" },
  personas: { script: "skill/scripts/generate-personas.mjs", desc: "Generate uncapped signal-driven user personas (.dsaf/personas.json)" },
  mcp: { script: "skill/scripts/mcp-server.mjs", desc: "Stdio MCP server (8 tools) + `dsaf mcp install` client configurator" },
  recon: { script: "skill/scripts/recon.mjs", desc: "Read-only topology & Surface Mode recon (Mode S / C / P)" },
  tokens: { script: "skill/scripts/audit-tokens.mjs", desc: "W3C DTCG validator, Light/Dark parity & CSS/Tailwind drift" },
  "figma-diff": { script: "skill/scripts/audit-figma-diff.mjs", desc: "Compare Figma variables / DTCG tokens against live CSS runtime" },
  runtime: { script: "skill/scripts/audit-runtime.mjs", desc: "Playwright APCA/WCAG, keyboard map, Storybook, screenshot & interaction checks" },
  scorecard: { script: "skill/scripts/compute-scorecard.mjs", desc: "Deterministic weighted scorecard & blocker calculator" },
  diff: { script: "skill/scripts/audit-diff.mjs", desc: "No-silent-regression diff verifier with override logging" },
  guardrails: { script: "skill/scripts/generate-guardrails.mjs", desc: "Generate runnable CI & AI-agent design guardrails" },
  "install-skill": { script: "skill/scripts/install-skill.mjs", desc: "Install Tier 1 DSAF skill into Claude/Cursor/Codex/Antigravity/Agents" },
  hook: { script: "skill/scripts/dsaf-hook.mjs", desc: "Edit-time agent Floor/Reflex hook checker & installer" },
  doctor: { script: "skill/scripts/doctor.mjs", desc: "Inspect guardrail/token/hook/waiver drift & runtime setup" },
  integrity: { script: "skill/scripts/check-integrity.mjs", desc: "Tier 1 skill integrity & self-test runner" },
  verify: { script: "scripts/verify-repo.mjs", desc: "Full repo isolation, schema & version parity gate" },
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
  console.log("Usage: dsaf <command|path> [args...] [--help|-h]\n");
  console.log("All Commands:");
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(14)} ${info.desc}`);
  }
  console.log("  version        Print installed DSAF CLI version");
  console.log("  help           Show this help message");
}

const CHECK_VALUE_FLAGS = new Set([
  "--scope",
  "--out",
  "--sarif",
  "--html",
  "--format",
  "--url",
  "--routes",
  "--cdp",
  "--target",
  "--figma",
  "--code-connect",
  "--prefix",
  "--storybook",
  "--baseline",
  "--current",
  "--axe",
  "--executable-path",
  "--theme-toggle",
  "--ds-css",
  "--preview-href",
]);

function inspectCheckArgs(args) {
  let hasPositional = false;
  let hasFormat = false;
  let asksHelp = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      if (i + 1 < args.length) hasPositional = true;
      break;
    }
    if (a === "-h" || a === "--help" || a === "--self-test") {
      asksHelp = true;
      continue;
    }
    if (a === "--compact" || a === "--json" || a === "--github" || a === "--format" || a.startsWith("--format=")) {
      hasFormat = true;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (!a.includes("=") && CHECK_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    hasPositional = true;
  }
  return { hasPositional, hasFormat, asksHelp };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (process.argv.length < 3 || cmd === "help" || cmd === "-h" || cmd === "--help") {
    if (cmd && rest.length > 0) {
      console.error(`Error: unexpected argument '${rest[0]}' for '${cmd}'. Run 'dsaf help' for usage.`);
      process.exit(2);
    }
    printHelp();
    await maybeNotifyUpdate({ currentVersion: getPkg().version, command: "help", argv: rest });
    process.exit(0);
  }
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    if (rest.length > 0) {
      console.error(`Error: unexpected argument '${rest[0]}' for '${cmd}'. Run 'dsaf help' for usage.`);
      process.exit(2);
    }
    console.log(`dsaf v${getPkg().version}`);
    process.exit(0);
  }

  let effectiveCmd = cmd;
  let entry = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  let passArgs = [...rest];

  if (!entry) {
    if (!cmd || cmd.trim().length === 0) {
      console.error(`Unknown DSAF command: '${cmd}'\n`);
      printHelp();
      process.exit(2);
    }
    const candidate = resolve(cmd);
    if (!cmd.startsWith("-") && existsSync(candidate)) {
      if (!statSync(candidate).isDirectory()) {
        console.error(`Target shorthand '${cmd}' is a file, not a directory. Pass a project directory (or use 'dsaf tokens ${cmd}' / 'dsaf runtime ${cmd}').`);
        process.exit(2);
      }
      effectiveCmd = "check";
      entry = COMMANDS.check;
      passArgs = [cmd, ...rest];
    } else {
      console.error(`Unknown DSAF command: '${cmd}'\n`);
      printHelp();
      process.exit(2);
    }
  }

  const scriptPath = join(REPO_ROOT, entry.script);
  if (!existsSync(scriptPath)) {
    console.error(`Command '${effectiveCmd}' (${entry.script}) is only available in the full DSAF source repository (Tier 2 maintainer tools are excluded from npm installs).`);
    process.exit(2);
  }

  if (entry === COMMANDS.check) {
    const info = inspectCheckArgs(passArgs);
    if (!info.asksHelp) {
      if (!info.hasFormat) passArgs.unshift(...entry.defaultArgs);
      if (!info.hasPositional) passArgs.unshift(entry.defaultTarget);
    }
  }

  const res = spawnSync(process.execPath, [scriptPath, ...passArgs], {
    stdio: "inherit",
  });
  if (res.error) {
    console.error("ERROR:", res.error.message);
    process.exit(1);
  }
  if (res.signal) {
    process.exit(res.signal === "SIGINT" ? 130 : res.signal === "SIGTERM" ? 143 : 1);
  }
  if (res.status !== 2) {
    await maybeNotifyUpdate({ currentVersion: getPkg().version, command: effectiveCmd, argv: passArgs });
  }
  process.exit(res.status ?? 1);
}

if (isDirectCliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * DSAF v0.9.2 — One-Command Onboarding Setup (`dsaf setup`).
 * Installs the Tier 1 agent skill, wires MCP JSON config for AI coding clients,
 * and optionally bootstraps `.dsaf/` governance + CI guardrails in a target repo.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { initEvolve } from "./init-evolve.mjs";
import { installSkills } from "./install-skill.mjs";
import { installMcpConfig } from "./mcp-server.mjs";

export const SETUP_VERSION = "0.9.2";

export function runSetup(options = {}) {
  const cwd = resolve(options.targetDir || process.cwd());
  const home = resolve(options.home || homedir());
  const agent = options.agent || "claude";
  const scope = options.scope === "project" ? "project" : "user";
  const dryRun = Boolean(options.dryRun);

  const skillResults = options.noSkill
    ? []
    : installSkills({
        agent,
        scope,
        cwd,
        home,
        dryRun,
      });

  const mcpAgent = agent === "agents" ? null : agent;
  const mcpResults =
    options.noMcp || !mcpAgent
      ? []
      : installMcpConfig({
          agent: mcpAgent,
          scope,
          cwd,
          home,
          dryRun,
        });

  let initResult = null;
  if (options.withInit || options.withCi) {
    initResult = initEvolve({
      targetDir: cwd,
      withHook: true,
      agent: agent === "all" ? "all" : ["claude", "cursor", "codex"].includes(agent) ? agent : "claude",
      withGuardrails: true,
      withWorkflow: Boolean(options.withCi),
      dryRun,
    });
  }

  return {
    schema: "dsaf-setup/1",
    version: SETUP_VERSION,
    agent,
    scope,
    target: cwd,
    dryRun,
    skills: skillResults,
    mcp: mcpResults,
    init: initResult
      ? {
          mode: initResult.mode,
          surfaceMode: initResult.surfaceMode,
          created: initResult.created,
          workflowFile: initResult.workflowFile,
        }
      : null,
  };
}

function printUsage() {
  console.log(
    [
      `DSAF v${SETUP_VERSION} — One-Command Onboarding Setup`,
      "Usage:",
      "  dsaf setup [target] [--agent claude|cursor|codex|antigravity|all] [--scope user|project] [--with-init] [--with-ci] [--no-skill] [--no-mcp] [--dry-run] [--json]",
      "  dsaf setup --self-test",
    ].join("\n")
  );
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-setup-test-"));
  try {
    const fakeHome = join(scratch, "home");
    const repoDir = join(scratch, "app");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "demo", dependencies: { react: "^19.0.0" } }));
    writeFileSync(join(repoDir, "src/Button.tsx"), "export function Button() { return <button type=\"button\">Save</button>; }\n");

    const dryRes = runSetup({ targetDir: repoDir, home: fakeHome, agent: "claude", scope: "user", withInit: true, dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.skills.length, 1);
    assert.equal(dryRes.mcp.length, 1);
    assert.equal(existsSync(join(fakeHome, ".claude/skills/dsaf/SKILL.md")), false);

    const applied = runSetup({
      targetDir: repoDir,
      home: fakeHome,
      agent: "claude",
      scope: "user",
      withInit: true,
      withCi: true,
    });
    assert.equal(applied.schema, "dsaf-setup/1");
    assert.equal(applied.version, SETUP_VERSION);
    assert.ok(existsSync(join(fakeHome, ".claude/skills/dsaf/SKILL.md")));
    const mcpCfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
    assert.deepEqual(mcpCfg.mcpServers.dsaf, { command: "npx", args: ["-y", "@zintaen/dsaf", "mcp"] });
    assert.ok(existsSync(join(repoDir, ".dsaf/STRATEGY.md")));
    assert.ok(existsSync(join(repoDir, ".github/workflows/dsaf-gate.yml")));

    console.log("DSAF_SETUP_SELF_TEST_PASSED (skill + mcp + optional .dsaf init & CI)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string", default: "claude" },
      scope: { type: "string", default: "user" },
      "no-skill": { type: "boolean", default: false },
      "no-mcp": { type: "boolean", default: false },
      "with-init": { type: "boolean", default: false },
      "with-ci": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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

  const res = runSetup({
    targetDir: positionals[0] || process.cwd(),
    agent: values.agent,
    scope: values.scope,
    noSkill: values["no-skill"],
    noMcp: values["no-mcp"],
    withInit: values["with-init"],
    withCi: values["with-ci"],
    dryRun: values["dry-run"],
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else {
    console.log(`DSAF Setup v${res.version}${res.dryRun ? " (DRY RUN)" : ""}`);
    for (const s of res.skills) console.log(`  Skill (${s.agent}/${s.scope}): ${s.path}`);
    for (const m of res.mcp) console.log(`  MCP (${m.agent}/${m.scope}): ${m.path}`);
    if (res.init) console.log(`  Repo governance: Mode ${res.init.mode} (${res.init.created.length} files created)`);
    console.log("Next: run `npx @zintaen/dsaf check` inside your project directory.");
  }
}

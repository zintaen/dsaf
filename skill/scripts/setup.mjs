#!/usr/bin/env node
/**
 * DSAF v0.9.3 — One-Command Onboarding Setup (`dsaf setup`).
 * Installs the Tier 1 agent skill, wires MCP JSON config for AI coding clients,
 * and optionally adds edit-time hooks, CI guardrails, `.github/workflows/dsaf-gate.yml`,
 * and `.github/workflows/dsaf-auto-update.yml`. Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertPathWithinRoot } from "./ci-report.mjs";
import { installAgentHook } from "./dsaf-hook.mjs";
import { generateGuardrails } from "./generate-guardrails.mjs";
import { installSkills } from "./install-skill.mjs";
import { installMcpConfig } from "./mcp-server.mjs";
import { analyzeDirectory } from "./recon.mjs";

export const SETUP_VERSION = "0.9.3";

const VALID_AGENTS = new Set(["claude", "cursor", "codex", "antigravity", "agents", "all"]);

function validateHookConfigFiles(absTarget, agents = []) {
  const hookFileMap = {
    claude: ".claude/settings.json",
    cursor: ".cursor/hooks.json",
    codex: ".codex/hooks.json",
  };
  for (const ag of agents) {
    if (!Object.prototype.hasOwnProperty.call(hookFileMap, ag)) continue;
    const rel = hookFileMap[ag];
    const cfgPath = join(absTarget, rel);
    let lst = null;
    try {
      lst = lstatSync(cfgPath);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      if (err?.code === "ENOTDIR") {
        throw new Error(`Hook config parent for '${rel}' is not a directory: ${dirname(cfgPath)}`);
      }
      throw err;
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing symlinked hook config '${rel}': ${cfgPath}`);
    }
    assertPathWithinRoot(absTarget, cfgPath, rel, { allowEqual: false });
    if (!statSync(cfgPath).isFile()) {
      throw new Error(`Existing hook config '${rel}' is not a regular file: ${cfgPath}`);
    }
    const raw = readFileSync(cfgPath, "utf8");
    if (!raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in existing ${rel}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Existing ${rel} must contain a JSON object.`);
    }
  }
}

function assertPathAvailable(absPath, expectDir, label, stopDir) {
  const checkSegWithin = (segPath, allowEqual) => {
    if (stopDir) assertPathWithinRoot(stopDir, segPath, label, { allowEqual });
  };
  if (stopDir) {
    const lexRel = relative(resolve(stopDir), resolve(absPath));
    if (!lexRel || lexRel.startsWith("..") || isAbsolute(lexRel)) {
      throw new Error(`Destination path '${label}' escapes repository root: ${absPath}`);
    }
    const segs = lexRel.split(/[\\/]+/).filter(Boolean);
    let curSeg = resolve(stopDir);
    for (let idx = 0; idx < segs.length - 1; idx++) {
      curSeg = join(curSeg, segs[idx]);
      let pLst = null;
      try {
        pLst = lstatSync(curSeg);
      } catch (err) {
        if (err?.code === "ENOTDIR") {
          throw new Error(`Destination parent for '${label}' is not a directory: ${dirname(curSeg)}`);
        }
        if (err?.code !== "ENOENT") throw err;
      }
      if (!pLst) break;
      if (pLst.isSymbolicLink()) {
        if (!existsSync(curSeg)) {
          throw new Error(`Destination parent for '${label}' is a broken symlink: ${curSeg}`);
        }
        checkSegWithin(curSeg, true);
        if (!statSync(curSeg).isDirectory()) {
          throw new Error(`Destination parent for '${label}' is not a directory: ${curSeg}`);
        }
      } else if (!pLst.isDirectory()) {
        throw new Error(`Destination parent for '${label}' is not a directory: ${curSeg}`);
      }
    }
  }
  let targetLst = null;
  try {
    targetLst = lstatSync(absPath);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (targetLst) {
    if (targetLst.isSymbolicLink()) {
      if (!existsSync(absPath)) {
        throw new Error(`Destination path '${label}' is a broken symlink: ${absPath}`);
      }
      throw new Error(
        expectDir
          ? `Refusing symlinked destination directory '${label}': ${absPath}`
          : `Refusing symlinked destination file '${label}': ${absPath}`
      );
    }
    checkSegWithin(absPath, false);
    const st = statSync(absPath);
    if (expectDir && !st.isDirectory()) {
      throw new Error(`Destination directory '${label}' is blocked by an existing file: ${absPath}`);
    }
    if (!expectDir && !st.isFile()) {
      throw new Error(`Destination file '${label}' is not a regular file: ${absPath}`);
    }
  }
}

function buildCiWorkflowYml() {
  return [
    `# Generated by @zintaen/dsaf v${SETUP_VERSION}`,
    "name: DSAF Gate",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "permissions:",
    "  contents: read",
    "  security-events: write",
    "  pull-requests: write",
    "jobs:",
    "  dsaf:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: zintaen/dsaf@v0",
    "        with:",
    "          target: .",
    '          fail-on-floor: "true"',
    '          upload-sarif: "true"',
    "",
  ].join("\n");
}

function buildAutoUpdateWorkflowYml() {
  return [
    `# Generated by @zintaen/dsaf v${SETUP_VERSION}`,
    "name: DSAF Auto-Update",
    "",
    "on:",
    "  schedule:",
    '    - cron: "17 3 * * 1"',
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "",
    "jobs:",
    "  dsaf-update:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: actions/setup-node@v7",
    "        with:",
    '          node-version: "22"',
    "      - name: Check and apply DSAF guardrail, persona & skill updates",
    "        run: npx -y @zintaen/dsaf@latest update . --all-agents --json",
    "      - name: Open or update pull request if DSAF files changed",
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    '          PATHS=()',
    '          for p in .dsaf .dsaf-guardrails .claude .cursor .codex .agent .agents .mcp.json; do',
    '            [ -e "$p" ] && PATHS+=("$p")',
    '          done',
    '          if [ "${#PATHS[@]}" -eq 0 ] || [ -z "$(git status --porcelain -- "${PATHS[@]}")" ]; then',
    '            echo "DSAF configuration is already up to date."',
    "            exit 0",
    "          fi",
    "          # Note: .github/workflows is excluded because default GITHUB_TOKEN lacks 'workflows' permission.",
    '          BASE_BRANCH="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo "${GITHUB_REF_NAME:-}")"',
    '          git config user.name "github-actions[bot]"',
    '          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
    '          BRANCH="chore/dsaf-auto-update"',
    '          git checkout -B "$BRANCH"',
    '          git add -- "${PATHS[@]}"',
    '          if git diff --cached --quiet; then',
    '            echo "No staged DSAF changes to commit."',
    "            exit 0",
    "          fi",
    '          git commit -m "chore(dsaf): update DSAF guardrails, personas & skills"',
    '          git fetch origin "$BRANCH" 2>/dev/null || true',
    '          git push -u origin "$BRANCH" --force-with-lease',
    '          if [ -n "$(gh pr list --state open --head "$BRANCH" --json number --jq \'.[0].number\')" ]; then',
    '            echo "Existing DSAF auto-update PR updated."',
    "          else",
    '            if [ -n "$BASE_BRANCH" ]; then',
    '              gh pr create --base "$BASE_BRANCH" --head "$BRANCH" \\',
    '                --title "chore(dsaf): update DSAF guardrails, personas & skills" \\',
    '                --body "Automated weekly sync via \\`dsaf update --all-agents\\`. Custom personas in \\`.dsaf/personas.custom.json\\` were preserved."',
    "            else",
    '              gh pr create --head "$BRANCH" \\',
    '                --title "chore(dsaf): update DSAF guardrails, personas & skills" \\',
    '                --body "Automated weekly sync via \\`dsaf update --all-agents\\`. Custom personas in \\`.dsaf/personas.custom.json\\` were preserved."',
    "            fi",
    "          fi",
    "",
  ].join("\n");
}

export function runSetup(options = {}) {
  if (options.targetDir !== undefined && (typeof options.targetDir !== "string" || options.targetDir.trim().length === 0)) {
    throw new Error("Target directory must be a non-empty path.");
  }
  const cwd = resolve(options.targetDir ?? process.cwd());
  const home = resolve(options.home || homedir());
  const agent = options.agent === undefined ? "claude" : options.agent;
  if (typeof agent !== "string" || agent.trim().length === 0) {
    throw new Error(`Unsupported --agent '${agent}'. Expected claude|cursor|codex|antigravity|agents|all.`);
  }
  const agentList = agent.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (agentList.length === 0 || agentList.some((a) => !VALID_AGENTS.has(a))) {
    throw new Error(`Unsupported --agent '${agent}'. Expected claude|cursor|codex|antigravity|agents|all.`);
  }
  const rawScope = options.scope === undefined ? "user" : options.scope;
  const scope = typeof rawScope === "string" ? rawScope.trim().toLowerCase() : rawScope;
  if (scope !== "user" && scope !== "project") {
    throw new Error(`Unsupported --scope '${rawScope}'. Expected 'user' or 'project'.`);
  }
  const dryRun = Boolean(options.dryRun);
  const withHook = Boolean(options.withHook);
  const withCi = Boolean(options.withCi);
  const withAutoUpdate = Boolean(options.withAutoUpdate);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Target directory not found: ${cwd}`);
  }

  const mcpList = agentList.filter((a) => a !== "agents");
  const mcpAgent = mcpList.length === 0 ? null : mcpList.join(",");
  if (!dryRun && !options.noSkill) {
    installSkills({
      agent,
      scope,
      cwd,
      home,
      dryRun: true,
    });
  }
  if (!dryRun && !options.noMcp && mcpAgent) {
    installMcpConfig({
      agent: mcpAgent,
      scope,
      cwd,
      home,
      dryRun: true,
    });
  }

  const hookAgents = withHook
    ? agentList.includes("all")
      ? ["claude", "cursor", "codex"]
      : [...new Set(agentList.filter((a) => ["claude", "cursor", "codex"].includes(a)))]
    : [];
  if (withHook) {
    validateHookConfigFiles(cwd, hookAgents);
    for (const ha of hookAgents) {
      const previewPath = ha === "claude" ? ".claude/settings.json" : ha === "cursor" ? ".cursor/hooks.json" : ".codex/hooks.json";
      assertPathAvailable(join(cwd, previewPath), false, previewPath, cwd);
    }
  }
  const guardDir = join(cwd, ".dsaf-guardrails");
  const expectedGuardNames = ["check-design-discipline.mjs", "dsaf-regression-gate.yml", "AGENTS-dsaf-rules.md"];
  if (withCi) {
    assertPathAvailable(guardDir, true, ".dsaf-guardrails", cwd);
    for (const f of expectedGuardNames) {
      assertPathAvailable(join(guardDir, f), false, `.dsaf-guardrails/${f}`, cwd);
    }
    assertPathAvailable(join(cwd, ".github/workflows/dsaf-gate.yml"), false, ".github/workflows/dsaf-gate.yml", cwd);
  }
  if (withAutoUpdate) {
    assertPathAvailable(join(cwd, ".github/workflows/dsaf-auto-update.yml"), false, ".github/workflows/dsaf-auto-update.yml", cwd);
  }

  const skillResults = options.noSkill
    ? []
    : installSkills({
        agent,
        scope,
        cwd,
        home,
        dryRun,
      });

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

  let ciResult = null;
  if (withHook || withCi || withAutoUpdate) {
    const recon = analyzeDirectory(cwd);
    const mode = recon.recommendedMode || "P";
    const surfaceMode = recon.surfaceMode || "persuade";
    const created = [];
    const skipped = [];

    if (withHook) {
      for (const ha of hookAgents) {
        const previewPath = ha === "claude" ? ".claude/settings.json" : ha === "cursor" ? ".cursor/hooks.json" : ".codex/hooks.json";
        if (dryRun) {
          created.push(previewPath);
        } else {
          const hr = installAgentHook({ agent: ha, dir: cwd });
          created.push(relative(cwd, hr.file).replace(/\\/g, "/"));
        }
      }
    }

    let workflowFile = null;
    if (withCi) {
      const missingGuardNames = expectedGuardNames.filter((f) => !existsSync(join(guardDir, f)));
      if (!dryRun && missingGuardNames.length > 0) {
        const frameworks = (recon.stack?.frameworks || []).map((f) => String(f).toLowerCase());
        const stack =
          Boolean(recon.stack?.hasTailwindTheme) || frameworks.some((f) => f.includes("tailwind"))
            ? "tailwind"
            : "css";
        const tmpGuard = mkdtempSync(join(tmpdir(), "dsaf-guard-merge-"));
        try {
          generateGuardrails({ outDir: tmpGuard, stack, mode });
          mkdirSync(guardDir, { recursive: true });
          for (const f of missingGuardNames) {
            const dest = join(guardDir, f);
            writeFileSync(dest, readFileSync(join(tmpGuard, f), "utf8"), "utf8");
            created.push(`.dsaf-guardrails/${f}`);
          }
          for (const f of expectedGuardNames) {
            if (!missingGuardNames.includes(f)) skipped.push(`.dsaf-guardrails/${f}`);
          }
        } finally {
          rmSync(tmpGuard, { recursive: true, force: true });
        }
      } else {
        for (const f of expectedGuardNames) {
          const relG = `.dsaf-guardrails/${f}`;
          if (missingGuardNames.includes(f)) created.push(relG);
          else skipped.push(relG);
        }
      }
      const wfRel = ".github/workflows/dsaf-gate.yml";
      const wfPath = join(cwd, wfRel);
      if (existsSync(wfPath)) {
        skipped.push(wfRel);
      } else {
        if (!dryRun) {
          mkdirSync(dirname(wfPath), { recursive: true });
          writeFileSync(wfPath, buildCiWorkflowYml(), "utf8");
        }
        created.push(wfRel);
      }
      workflowFile = wfRel;
    }

    let autoUpdateWorkflowFile = null;
    if (withAutoUpdate) {
      const auRel = ".github/workflows/dsaf-auto-update.yml";
      const auPath = join(cwd, auRel);
      if (existsSync(auPath)) {
        skipped.push(auRel);
      } else {
        if (!dryRun) {
          mkdirSync(dirname(auPath), { recursive: true });
          writeFileSync(auPath, buildAutoUpdateWorkflowYml(), "utf8");
        }
        created.push(auRel);
      }
      autoUpdateWorkflowFile = auRel;
    }

    ciResult = {
      mode,
      surfaceMode,
      created,
      skipped,
      workflowFile,
      autoUpdateWorkflowFile,
    };
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
    ci: ciResult,
  };
}

function printUsage() {
  console.log(
    [
      `DSAF v${SETUP_VERSION} — One-Command Onboarding Setup`,
      "Usage:",
      "  dsaf setup [target] [--agent claude|cursor|codex|antigravity|agents|all] [--scope user|project] [--with-hook] [--with-ci] [--with-auto-update] [--no-skill] [--no-mcp] [--dry-run] [--json] [--help]",
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

    const dryRes = runSetup({ targetDir: repoDir, home: fakeHome, agent: "claude", scope: "user", withHook: true, withCi: true, dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.skills.length, 1);
    assert.equal(dryRes.mcp.length, 1);
    assert.ok(dryRes.ci && dryRes.ci.created.includes(".claude/settings.json"));
    assert.equal(existsSync(join(fakeHome, ".claude/skills/dsaf/SKILL.md")), false);
    assert.equal(existsSync(join(repoDir, ".github/workflows/dsaf-gate.yml")), false);

    const applied = runSetup({
      targetDir: repoDir,
      home: fakeHome,
      agent: "claude",
      scope: "user",
      withHook: true,
      withCi: true,
      withAutoUpdate: true,
    });
    assert.equal(applied.schema, "dsaf-setup/1");
    assert.equal(applied.version, SETUP_VERSION);
    assert.ok(existsSync(join(fakeHome, ".claude/skills/dsaf/SKILL.md")));
    const mcpCfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf8"));
    assert.deepEqual(mcpCfg.mcpServers.dsaf, { command: "npx", args: ["-y", "@zintaen/dsaf@latest", "mcp"] });
    assert.ok(existsSync(join(repoDir, ".claude/settings.json")));
    assert.ok(existsSync(join(repoDir, ".dsaf-guardrails/check-design-discipline.mjs")));
    assert.ok(existsSync(join(repoDir, ".github/workflows/dsaf-gate.yml")));
    assert.ok(existsSync(join(repoDir, ".github/workflows/dsaf-auto-update.yml")));
    assert.equal(existsSync(join(repoDir, ".dsaf/STRATEGY.md")), false, "Auto-evolve STRATEGY.md must not be created");
    assert.throws(() => runSetup({ targetDir: repoDir, home: fakeHome, scope: "projct" }), /Unsupported --scope/);

    // Case-normalized --scope
    const caseRes = runSetup({ targetDir: repoDir, home: fakeHome, agent: "claude", scope: "USER", dryRun: true });
    assert.equal(caseRes.scope, "user");

    // Multi-agent hook + CI setup
    const agCursorDir = join(scratch, "ag-cursor");
    mkdirSync(join(agCursorDir, "src"), { recursive: true });
    writeFileSync(join(agCursorDir, "src/App.tsx"), "export const App = () => null;\n");
    const agCursor = runSetup({ targetDir: agCursorDir, home: fakeHome, agent: "antigravity,cursor", scope: "project", withHook: true, withCi: true });
    assert.equal(existsSync(join(agCursorDir, ".cursor/hooks.json")), true, "cursor hook must be installed");
    assert.equal(existsSync(join(agCursorDir, ".claude/settings.json")), false, "unrequested claude hook must not be installed");
    assert.equal(agCursor.skills.length, 2);

    const claudeCursorDir = join(scratch, "claude-cursor");
    mkdirSync(join(claudeCursorDir, "src"), { recursive: true });
    writeFileSync(join(claudeCursorDir, "src/App.tsx"), "export const App = () => null;\n");
    const ccRes = runSetup({ targetDir: claudeCursorDir, home: fakeHome, agent: "claude,cursor", scope: "project", withHook: true });
    assert.equal(existsSync(join(claudeCursorDir, ".claude/settings.json")), true);
    assert.equal(existsSync(join(claudeCursorDir, ".cursor/hooks.json")), true);
    assert.ok(ccRes.ci.created.includes(".claude/settings.json") && ccRes.ci.created.includes(".cursor/hooks.json"));

    const threeDir = join(scratch, "three-hooks");
    mkdirSync(join(threeDir, "src"), { recursive: true });
    writeFileSync(join(threeDir, "src/App.tsx"), "export const App = () => null;\n");
    runSetup({ targetDir: threeDir, home: fakeHome, agent: "claude,cursor,codex", scope: "project", withHook: true });
    assert.equal(existsSync(join(threeDir, ".codex/hooks.json")), true, "3-agent setup must install codex hook too");

    const cleanHome = join(scratch, "untouched-home");
    mkdirSync(cleanHome, { recursive: true });
    assert.throws(
      () => runSetup({ targetDir: join(scratch, "does-not-exist"), home: cleanHome, agent: "claude", scope: "user", withCi: true }),
      /Target directory not found/
    );
    assert.equal(existsSync(join(cleanHome, ".claude")), false, "Invalid targetDir must not mutate home");

    const allDry = runSetup({ targetDir: claudeCursorDir, home: fakeHome, agent: "claude,all", scope: "project", dryRun: true });
    assert.equal(allDry.skills.length, 5);

    const r4FileTarget = join(scratch, "regular-file.txt");
    writeFileSync(r4FileTarget, "not a dir");
    assert.throws(
      () => runSetup({ targetDir: join(scratch, "missing-proj"), home: fakeHome, agent: "claude", scope: "project" }),
      /Target directory not found/
    );
    assert.throws(
      () => runSetup({ targetDir: r4FileTarget, home: fakeHome, agent: "claude", scope: "project" }),
      /Target directory not found/
    );
    const badMcpProj = join(scratch, "bad-mcp-proj");
    mkdirSync(badMcpProj, { recursive: true });
    writeFileSync(join(badMcpProj, ".mcp.json"), "{ invalid json");
    assert.throws(
      () => runSetup({ targetDir: badMcpProj, home: fakeHome, agent: "claude", scope: "project" }),
      /Existing MCP config is not valid JSON/
    );
    assert.equal(existsSync(join(badMcpProj, ".claude")), false, "Malformed .mcp.json must abort before writing skills");

    const badHookSetup = join(scratch, "bad-hook-setup");
    mkdirSync(join(badHookSetup, ".cursor"), { recursive: true });
    writeFileSync(join(badHookSetup, ".cursor/hooks.json"), "{ invalid");
    assert.throws(
      () => runSetup({ targetDir: badHookSetup, home: fakeHome, agent: "claude,cursor", scope: "project", withHook: true }),
      /Invalid JSON in existing \.cursor\/hooks\.json/
    );
    assert.equal(existsSync(join(badHookSetup, ".claude")), false);
    assert.equal(existsSync(join(badHookSetup, ".mcp.json")), false);

    assert.throws(() => runSetup({ targetDir: repoDir, home: fakeHome, agent: "" }), /Unsupported --agent/);
    assert.throws(() => runSetup({ targetDir: repoDir, home: fakeHome, scope: "" }), /Unsupported --scope/);
    const setupSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [setupSelfPath, repoDir, "--agent", "", "--dry-run"], { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [setupSelfPath, repoDir, "--scope", "", "--dry-run"], { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [setupSelfPath, "", "--dry-run"], { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" }).status, 2);

    const r18UserHome = join(scratch, "r18-user-home");
    mkdirSync(r18UserHome, { recursive: true });
    for (const badTarget of [join(scratch, "missing-user-target"), r4FileTarget]) {
      assert.throws(() => runSetup({ targetDir: badTarget, home: r18UserHome, agent: "claude", scope: "user" }), /Target directory not found/);
      assert.equal(spawnSync(process.execPath, [setupSelfPath, badTarget, "--agent", "claude", "--scope", "user"], { env: { ...process.env, HOME: r18UserHome }, encoding: "utf8" }).status, 2);
    }
    assert.equal(existsSync(join(r18UserHome, ".claude")), false);
    assert.equal(existsSync(join(r18UserHome, ".claude.json")), false);
    assert.equal(spawnSync(process.execPath, [setupSelfPath, repoDir, repoDir, "--dry-run"], { env: { ...process.env, HOME: r18UserHome }, encoding: "utf8" }).status, 2);

    const r19Home = join(scratch, "r19-home");
    const r19Repo = join(scratch, "r19-broken-hook-repo");
    mkdirSync(r19Home, { recursive: true });
    mkdirSync(join(r19Repo, "src"), { recursive: true });
    writeFileSync(join(r19Repo, "src/app.css"), ".ok { opacity: 1; }\n");
    symlinkSync(join(scratch, "missing-cursor-target"), join(r19Repo, ".cursor"));
    for (const dr of [true, false]) {
      assert.throws(
        () => runSetup({ targetDir: r19Repo, home: r19Home, agent: "claude,cursor", scope: "user", withHook: true, dryRun: dr }),
        /broken/
      );
    }
    assert.equal(existsSync(join(r19Home, ".claude")), false);
    assert.equal(existsSync(join(r19Home, ".claude.json")), false);
    const helpOut = spawnSync(process.execPath, [setupSelfPath, "--help"], { encoding: "utf8" }).stdout;
    assert.match(helpOut, /antigravity\|agents\|all/);

    const r22BlockedRepo = join(scratch, "r22-blocked-repo");
    mkdirSync(r22BlockedRepo, { recursive: true });
    writeFileSync(join(r22BlockedRepo, ".claude"), "blocking file\n");
    assert.throws(
      () => runSetup({ targetDir: r22BlockedRepo, agent: "claude", scope: "project" }),
      /non-directory ancestor/
    );

    // Round 24 (A1 HIGH-2): project-scope symlink escape via .agents -> outside must fail before writing outside
    const r24Proj = join(scratch, "r24-symlink-proj");
    const r24Ext = join(scratch, "r24-ext");
    mkdirSync(r24Proj, { recursive: true });
    mkdirSync(r24Ext, { recursive: true });
    symlinkSync(r24Ext, join(r24Proj, ".agents"));
    assert.throws(
      () => runSetup({ targetDir: r24Proj, home: fakeHome, agent: "agents", scope: "project" }),
      /escapes/i
    );
    assert.equal(existsSync(join(r24Ext, "skills")), false, "Project-scope .agents symlink escape must not write outside targetDir");

    // Round 27 (A1-L1): partial .dsaf-guardrails/* reports pre-existing files in ci.skipped for both dryRun=true and dryRun=false
    const r27PartialCiRepo = join(scratch, "r27-partial-ci");
    mkdirSync(join(r27PartialCiRepo, ".dsaf-guardrails"), { recursive: true });
    writeFileSync(join(r27PartialCiRepo, ".dsaf-guardrails/check-design-discipline.mjs"), "// existing\n");
    const r27CiDry = runSetup({ targetDir: r27PartialCiRepo, home: fakeHome, agent: "claude", scope: "project", noSkill: true, noMcp: true, withCi: true, dryRun: true });
    const r27CiApply = runSetup({ targetDir: r27PartialCiRepo, home: fakeHome, agent: "claude", scope: "project", noSkill: true, noMcp: true, withCi: true, dryRun: false });
    assert.deepEqual(r27CiDry.ci.skipped, [".dsaf-guardrails/check-design-discipline.mjs"]);
    assert.deepEqual(r27CiApply.ci.skipped, [".dsaf-guardrails/check-design-discipline.mjs"]);

    // Round 28 (A1-M1): intra-repo symlinked hook config must fail upfront in both --dry-run and apply before mutating HOME or earlier hooks
    const r28SymProj = join(scratch, "r28-sym-proj");
    const r28Home = join(scratch, "r28-sym-home");
    mkdirSync(join(r28SymProj, ".claude"), { recursive: true });
    mkdirSync(join(r28SymProj, ".cursor"), { recursive: true });
    mkdirSync(r28Home, { recursive: true });
    writeFileSync(join(r28SymProj, "shared-hooks.json"), "{}\n");
    symlinkSync(join(r28SymProj, "shared-hooks.json"), join(r28SymProj, ".cursor/hooks.json"));
    assert.throws(
      () => runSetup({ targetDir: r28SymProj, agent: "claude,cursor", scope: "user", home: r28Home, withHook: true, dryRun: true }),
      /symlink/i,
      "R28 A1-M1: --dry-run must reject intra-repo symlinked hook config upfront"
    );
    assert.throws(
      () => runSetup({ targetDir: r28SymProj, agent: "claude,cursor", scope: "user", home: r28Home, withHook: true, dryRun: false }),
      /symlink/i,
      "R28 A1-M1: apply must reject intra-repo symlinked hook config before mutating HOME or .claude/settings.json"
    );
    assert.equal(existsSync(join(r28Home, ".claude/skills/dsaf/SKILL.md")), false, "R28 A1-M1: HOME must stay clean on pre-flight failure");
    assert.equal(existsSync(join(r28SymProj, ".claude/settings.json")), false, "R28 A1-M1: earlier hook config must not be written on pre-flight failure");

    // R30 (A1-M1 & A1-L2): intra-repo leaf symlink at .mcp.json and intra-repo directory symlink at .dsaf-guardrails must fail upfront in dryRun and apply
    const r30SymMcpProj = join(scratch, "r30-sym-mcp-proj");
    mkdirSync(r30SymMcpProj, { recursive: true });
    writeFileSync(join(r30SymMcpProj, "package.json"), '{"name":"r30-app"}\n');
    symlinkSync(join(r30SymMcpProj, "package.json"), join(r30SymMcpProj, ".mcp.json"));
    for (const dr of [true, false]) {
      assert.throws(
        () => runSetup({ targetDir: r30SymMcpProj, home: fakeHome, agent: "claude", scope: "project", withHook: true, dryRun: dr }),
        /symlink/i
      );
    }
    assert.equal(readFileSync(join(r30SymMcpProj, "package.json"), "utf8"), '{"name":"r30-app"}\n');
    assert.equal(existsSync(join(r30SymMcpProj, ".claude/settings.json")), false);

    const r30SymGuardProj = join(scratch, "r30-sym-guard-proj");
    mkdirSync(join(r30SymGuardProj, "src"), { recursive: true });
    writeFileSync(join(r30SymGuardProj, "package.json"), '{"name":"r30-guard-app"}\n');
    symlinkSync(join(r30SymGuardProj, "src"), join(r30SymGuardProj, ".dsaf-guardrails"));
    for (const dr of [true, false]) {
      assert.throws(
        () => runSetup({ targetDir: r30SymGuardProj, home: fakeHome, agent: "claude", scope: "project", noSkill: true, noMcp: true, withCi: true, dryRun: dr }),
        /symlinked destination directory/i
      );
    }
    assert.equal(existsSync(join(r30SymGuardProj, "src/check-design-discipline.mjs")), false);

    console.log("DSAF_SETUP_SELF_TEST_PASSED (skill + mcp + optional hooks & CI)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function canonPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const isEntry = Boolean(process.argv[1]) && canonPath(process.argv[1]) === canonPath(fileURLToPath(import.meta.url));
if (isEntry) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        agent: { type: "string", default: "claude" },
        scope: { type: "string", default: "user" },
        "no-skill": { type: "boolean", default: false },
        "no-mcp": { type: "boolean", default: false },
        "with-hook": { type: "boolean", default: false },
        "with-ci": { type: "boolean", default: false },
        "with-auto-update": { type: "boolean", default: false },
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

    if (positionals.length > 1) {
      throw new Error(`Unexpected extra positional argument '${positionals[1]}'. Pass a single [target].`);
    }
    if (positionals.length > 0 && positionals[0].trim().length === 0) {
      throw new Error("Target directory must be a non-empty path.");
    }
    const res = runSetup({
      targetDir: positionals.length > 0 ? positionals[0] : process.cwd(),
      agent: values.agent,
      scope: values.scope,
      noSkill: values["no-skill"],
      noMcp: values["no-mcp"],
      withHook: values["with-hook"],
      withCi: values["with-ci"],
      withAutoUpdate: values["with-auto-update"],
      dryRun: values["dry-run"],
    });

    if (values.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else {
      console.log(`DSAF Setup v${res.version}${res.dryRun ? " (DRY RUN)" : ""}`);
      for (const s of res.skills) console.log(`  Skill (${s.agent}/${s.scope}): ${s.path}`);
      for (const m of res.mcp) console.log(`  MCP (${m.agent}/${m.scope}): ${m.path}`);
      if (res.ci) console.log(`  CI & hooks: Mode ${res.ci.mode} (${res.ci.created.length} files created)`);
      console.log("Next: run `npx @zintaen/dsaf check` inside your project directory.");
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

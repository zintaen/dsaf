#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Universal Repo Auto-Distribution & Upgrade Tool (`dsaf update`).
 * Inspects and safely updates any repository using DSAF:
 * - Installed CLI vs npm `latest`
 * - Installed agent skills (Claude, Cursor, Codex, Antigravity, `.agents`)
 * - `.dsaf/personas.json` (preserving `.dsaf/personas.custom.json`)
 * - `.dsaf-guardrails/` scanner & CI rules
 * - `.github/workflows/` semver pins (preserving floating `@v0` channel)
 * - Project/User MCP JSON configs (`@zintaen/dsaf@latest`)
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateGuardrails } from "./generate-guardrails.mjs";
import { generatePersonas } from "./generate-personas.mjs";
import { installSkills, resolveTargets } from "./install-skill.mjs";
import { installMcpConfig, resolveMcpTargets } from "./mcp-server.mjs";
import { assertPathWithinRoot } from "./ci-report.mjs";
import { analyzeDirectory } from "./recon.mjs";
import { checkLatestVersion, compareSemver, parseSemver } from "./update-check.mjs";

export const UPDATE_VERSION = "0.9.3";

function relPath(base, target) {
  return relative(base, target).replace(/\\/g, "/") || ".";
}

function readJsonObjectStrict(absPath, label = absPath) {
  let lst;
  try {
    lst = lstatSync(absPath);
  } catch (err) {
    if (err?.code === "ENOTDIR") {
      throw new Error(`Existing ${label} parent path is not a directory: ${dirname(absPath)}`);
    }
    throw err;
  }
  if (lst.isSymbolicLink() && !existsSync(absPath)) {
    throw new Error(`Existing ${label} is a broken symlink: ${absPath}`);
  }
  if (!statSync(absPath).isFile()) {
    throw new Error(`Existing ${label} is not a regular file: ${absPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new Error(`Existing ${label} is invalid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing ${label} must be a JSON object.`);
  }
  return parsed;
}

function isOlderSemver(ver, target = UPDATE_VERSION) {
  const clean = String(ver || "").trim();
  if (!/^[vV]?\d/.test(clean) || !parseSemver(clean)) return false;
  const cmp = compareSemver(clean, target);
  return cmp !== null && cmp < 0;
}

function canonicalCompareKey(p) {
  let cur = resolve(p);
  const trailing = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    trailing.unshift(basename(cur));
    cur = parent;
  }
  let canon = cur;
  try {
    canon = (realpathSync.native || realpathSync)(cur);
  } catch {
    canon = resolve(cur);
  }
  const full = trailing.length > 0 ? join(canon, ...trailing) : canon;
  return process.platform === "darwin" || process.platform === "win32" ? full.toLowerCase() : full;
}

function isRegularFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function collectSkillTargets({ absTarget, scope, allAgents, home }) {
  const targets = [];
  const seenPaths = new Set();
  const scopesToScan =
    scope === "user"
      ? ["user"]
      : allAgents && !scope
      ? ["project", "user"]
      : [scope || "project"];

  for (const sc of scopesToScan) {
    for (const entry of resolveTargets({ agent: "all", scope: sc, cwd: absTarget, home })) {
      const canonEntry = canonicalCompareKey(entry.path);
      if (seenPaths.has(canonEntry)) continue;
      seenPaths.add(canonEntry);
      const skillMd = join(entry.path, "SKILL.md");
      if (!isRegularFile(skillMd)) continue;
      const body = readFileSync(skillMd, "utf8");
      const m =
        body.match(/DSAF\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/i) ||
        body.match(/version:\s*"?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)"?/i);
      const installedVersion = m ? m[1] : "unknown";
      const outdated = installedVersion === "unknown" || isOlderSemver(installedVersion, UPDATE_VERSION);
      targets.push({
        agent: entry.agent,
        scope: entry.scope,
        path: entry.path,
        displayPath: sc === "project" ? relPath(absTarget, entry.path) : entry.path,
        installedVersion,
        targetVersion: UPDATE_VERSION,
        status: outdated ? "outdated" : "up_to_date",
      });
    }
  }
  return targets;
}

function stripWorkflowRefDelims(rawRef) {
  let ref = String(rawRef || "");
  while (ref.length > 0 && (/[,;:)\]}\`&|]$/.test(ref) || (ref.endsWith(".") && !ref.endsWith("..")))) {
    ref = ref.slice(0, -1);
  }
  return ref;
}

function rewriteWorkflowPins(raw, targetVersion = UPDATE_VERSION) {
  let next = String(raw || "");
  next = next.replace(
    /(?<![A-Za-z0-9_@./-])zintaen\/dsaf(\/[A-Za-z0-9._/-]+)?@([vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=[\s"'#,;:)\]}\`&|]|\.(?:[\s,;:)\]}\`"'#&|]|$)|$)/g,
    (full, sub, ref) => (isOlderSemver(ref, targetVersion) ? `zintaen/dsaf${sub || ""}@v${targetVersion}` : full)
  );
  next = next.replace(
    /(?<![A-Za-z0-9_@./-])@zintaen\/dsaf@([vV]?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=[\s"'#,;:)\]}\`&|]|\.(?:[\s,;:)\]}\`"'#&|]|$)|$)/g,
    (full, ref) => (isOlderSemver(ref, targetVersion) ? `@zintaen/dsaf@${targetVersion}` : full)
  );
  return next;
}

function collectWorkflowTargets(absTarget) {
  const wfDir = join(absTarget, ".github", "workflows");
  try {
    if (!existsSync(wfDir) || !statSync(wfDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const items = [];
  for (const name of readdirSync(wfDir).sort()) {
    if (!/\.(ya?ml)$/i.test(name)) continue;
    const full = join(wfDir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const rel = relPath(absTarget, full);
    const raw = readFileSync(full, "utf8");
    const actionRefs = [...raw.matchAll(/(?<![A-Za-z0-9_@./-])zintaen\/dsaf(?:\/[A-Za-z0-9._/-]+)?@([^\s"'#,;:)\]}\`&|]+)/g)]
      .map((m) => stripWorkflowRefDelims(m[1]))
      .filter(Boolean);
    const npmRefs = [...raw.matchAll(/(?<![A-Za-z0-9_@./-])@zintaen\/dsaf@([^\s"'#,;:)\]}\`&|]+)/g)]
      .map((m) => stripWorkflowRefDelims(m[1]))
      .filter(Boolean);
    const refs = [...actionRefs, ...npmRefs];
    if (refs.length === 0) continue;

    const pinnedOlder = [];
    let hasFloatingV0 = false;
    for (const ref of actionRefs) {
      if (ref === "v0") {
        hasFloatingV0 = true;
        continue;
      }
      if (isOlderSemver(ref, UPDATE_VERSION)) {
        pinnedOlder.push(ref);
      }
    }
    for (const ref of npmRefs) {
      if (isOlderSemver(ref, UPDATE_VERSION)) {
        pinnedOlder.push(`npm:${ref}`);
      }
    }

    items.push({
      file: rel,
      fullPath: full,
      refs,
      hasFloatingV0,
      pinnedOlder,
      status: pinnedOlder.length > 0 ? "outdated" : "up_to_date",
      note: pinnedOlder.length > 0
        ? `Pinned older action/CLI ref(s): ${pinnedOlder.join(", ")}`
        : hasFloatingV0
        ? "Floating @v0 channel preserved"
        : "Up to date",
    });
  }
  return items;
}

function collectMcpTargets({ absTarget, scope, allAgents, home }) {
  const items = [];
  const seenPaths = new Set();
  const scopesToScan =
    scope === "user"
      ? ["user"]
      : allAgents && !scope
      ? ["project", "user"]
      : [scope || "project"];

  for (const sc of scopesToScan) {
    for (const entry of resolveMcpTargets({ agent: "all", scope: sc, cwd: absTarget, home })) {
      const canonEntry = canonicalCompareKey(entry.path);
      if (seenPaths.has(canonEntry)) continue;
      seenPaths.add(canonEntry);
      let lst = null;
      try {
        lst = lstatSync(entry.path);
      } catch (err) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") continue;
        throw err;
      }
      const displayPath = sc === "project" ? relPath(absTarget, entry.path) : entry.path;
      if (lst.isSymbolicLink() && !existsSync(entry.path)) {
        throw new Error(`Existing ${displayPath} is a broken symlink: ${entry.path}`);
      }
      if (!statSync(entry.path).isFile()) {
        throw new Error(`Existing ${displayPath} is not a regular file: ${entry.path}`);
      }
      const rawContent = readFileSync(entry.path, "utf8").trim();
      const parsed = rawContent ? readJsonObjectStrict(entry.path, displayPath) : {};
      if (
        parsed.mcpServers !== undefined &&
        (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))
      ) {
        throw new Error(`Existing ${displayPath} 'mcpServers' must be a JSON object.`);
      }
      const dsafCfg = parsed?.mcpServers?.dsaf;
      if (!dsafCfg || !Array.isArray(dsafCfg.args)) continue;
      const spec = dsafCfg.args.find((a) => typeof a === "string" && a.startsWith("@zintaen/dsaf")) || "";
      const m = spec.match(/^@zintaen\/dsaf@(v?\d+\.\d+\.\d+.*)$/i);
      const outdated = Boolean(m && isOlderSemver(m[1], UPDATE_VERSION));
      items.push({
        agent: entry.agent,
        scope: entry.scope,
        path: entry.path,
        displayPath,
        packageSpec: spec,
        status: outdated ? "outdated" : "up_to_date",
      });
    }
  }
  return items;
}

function inspectPersonas(absTarget) {
  const personasPath = join(absTarget, ".dsaf", "personas.json");
  try {
    lstatSync(personasPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
  const personasDoc = readJsonObjectStrict(personasPath, ".dsaf/personas.json");
  const personasVer = typeof personasDoc?.version === "string" ? personasDoc.version : null;
  const personasDepth = ["quick", "auto", "deep"].includes(personasDoc?.depth) ? personasDoc.depth : null;
  const personasMaxCap = typeof personasDoc?.maxCap === "number" && personasDoc.maxCap > 0 ? personasDoc.maxCap : null;
  const surfaceMode = typeof personasDoc?.surfaceMode === "string" ? personasDoc.surfaceMode : null;
  const mode = typeof personasDoc?.recommendedMode === "string" ? personasDoc.recommendedMode : null;

  const cmp = personasVer ? compareSemver(personasVer, UPDATE_VERSION) : null;
  const personasNewer = cmp !== null && cmp > 0;
  const needsPersonasUpdate =
    !personasNewer && (!personasVer || !parseSemver(personasVer) || isOlderSemver(personasVer, UPDATE_VERSION));

  return {
    present: true,
    version: personasVer,
    depth: personasDepth,
    maxCap: personasMaxCap,
    mode,
    surfaceMode,
    needsPersonasUpdate,
    status: needsPersonasUpdate ? "outdated" : "up_to_date",
  };
}

function inspectGuardrails(absTarget) {
  const guardDir = join(absTarget, ".dsaf-guardrails");
  const checkerPath = join(guardDir, "check-design-discipline.mjs");
  const rulesPath = join(guardDir, "AGENTS-dsaf-rules.md");
  const ymlPath = join(guardDir, "dsaf-regression-gate.yml");
  const existing = [checkerPath, rulesPath, ymlPath].filter((p) => isRegularFile(p));
  if (existing.length === 0) return null;

  const versions = new Set();
  let detectedStack = null;
  let detectedMode = null;
  for (const p of existing) {
    const raw = readFileSync(p, "utf8");
    const m = raw.match(/DSAF[^\n]*?\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/i);
    if (m) versions.add(m[1]);
    if (!detectedStack) {
      const sm = raw.match(/Stack:\s*(tailwind|react|css)/i);
      if (sm) detectedStack = sm[1].toLowerCase();
    }
    if (!detectedMode) {
      const mm = raw.match(/Mode\s+([SCP])\b/);
      if (mm) detectedMode = mm[1];
    }
  }
  const staleVersions = [...versions].filter((v) => !parseSemver(v) || compareSemver(v, UPDATE_VERSION) < 0);
  const hasNewerVersion = [...versions].some((v) => {
    const cmp = compareSemver(v, UPDATE_VERSION);
    return cmp !== null && cmp > 0;
  });
  const outdated = !hasNewerVersion && (staleVersions.length > 0 || versions.size === 0 || existing.length < 3);

  return {
    present: true,
    versions: [...versions],
    stack: detectedStack,
    mode: detectedMode,
    status: outdated ? "outdated" : "up_to_date",
  };
}

function assertWritableTargetType(absPath, expectDir, label, stopDir) {
  if (stopDir) {
    assertPathWithinRoot(stopDir, absPath, label, { allowEqual: false });
  }
  let cur = dirname(absPath);
  while (stopDir && cur && cur !== stopDir && cur.startsWith(stopDir)) {
    let lst = null;
    try {
      lst = lstatSync(cur);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    }
    if (lst) {
      if (lst.isSymbolicLink() && (!existsSync(cur) || !statSync(cur).isDirectory())) {
        throw new Error(`Destination parent for '${label}' is not a valid directory: ${cur}`);
      }
      if (!lst.isSymbolicLink() && !lst.isDirectory()) {
        throw new Error(`Destination parent for '${label}' is not a directory: ${cur}`);
      }
      break;
    }
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  let targetLst = null;
  try {
    targetLst = lstatSync(absPath);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (targetLst) {
    if (targetLst.isSymbolicLink()) {
      throw new Error(`Refusing symlinked destination path '${label}': ${absPath}`);
    }
    const st = statSync(absPath);
    if (expectDir && !st.isDirectory()) {
      throw new Error(`Destination directory '${label}' is blocked by an existing file: ${absPath}`);
    }
    if (!expectDir && st.isDirectory()) {
      throw new Error(`Destination file '${label}' is a directory: ${absPath}`);
    }
  }
}

function inspectLocalUpdateState(targetDir = ".", opts = {}) {
  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw new Error("Target directory must be a non-empty path.");
  }
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) {
    throw new Error(`Target directory not found: ${absTarget}`);
  }
  const home = resolve(opts.home || homedir());
  let scope = null;
  if (opts.scope !== undefined && opts.scope !== null) {
    const normScope = typeof opts.scope === "string" ? opts.scope.trim().toLowerCase() : opts.scope;
    if (normScope !== "project" && normScope !== "user") {
      throw new Error(`Unsupported --scope '${opts.scope}'. Expected 'project' or 'user'.`);
    }
    scope = normScope;
  }
  const allAgents = Boolean(opts.allAgents);
  const skills = collectSkillTargets({ absTarget, scope, allAgents, home });
  const personas = inspectPersonas(absTarget);
  const guardrails = inspectGuardrails(absTarget);
  const workflows = collectWorkflowTargets(absTarget);
  const mcpConfigs = collectMcpTargets({ absTarget, scope, allAgents, home });
  return { absTarget, home, skills, personas, guardrails, workflows, mcpConfigs };
}

function planAndValidateApply({ absTarget, home, before }) {
  let personaUpdatePlan = null;
  if (before.personas?.status === "outdated") {
    const dsafDir = join(absTarget, ".dsaf");
    const recon = analyzeDirectory(absTarget);
    const mode = before.personas.mode || recon.recommendedMode || "P";
    const surfaceMode = before.personas.surfaceMode || recon.surfaceMode || "persuade";
    const personaReport = generatePersonas(absTarget, {
      depth: before.personas.depth || "auto",
      ...(before.personas.maxCap != null ? { max: before.personas.maxCap } : {}),
      recon: { ...recon, recommendedMode: mode, surfaceMode: String(surfaceMode).toLowerCase() },
      relativeTarget: ".",
    });
    personaUpdatePlan = { dsafDir, personaReport };
  }
  let guardrailUpdatePlan = null;
  if (before.guardrails?.status === "outdated") {
    const recon = analyzeDirectory(absTarget);
    const frameworks = (recon.stack?.frameworks || []).map((f) => String(f).toLowerCase());
    const inferredStack =
      Boolean(recon.stack?.hasTailwindTheme) || frameworks.some((f) => f.includes("tailwind")) ? "tailwind" : "css";
    const stack = before.guardrails.stack || inferredStack;
    const mode = before.guardrails.mode || recon.recommendedMode || "C";
    guardrailUpdatePlan = { stack, mode };
  }

  if (personaUpdatePlan) {
    assertWritableTargetType(personaUpdatePlan.dsafDir, true, ".dsaf", absTarget);
    assertWritableTargetType(join(personaUpdatePlan.dsafDir, "personas.json"), false, ".dsaf/personas.json", absTarget);
  }
  if (guardrailUpdatePlan) {
    const guardDir = join(absTarget, ".dsaf-guardrails");
    assertWritableTargetType(guardDir, true, ".dsaf-guardrails", absTarget);
    for (const gf of ["check-design-discipline.mjs", "dsaf-regression-gate.yml", "AGENTS-dsaf-rules.md"]) {
      assertWritableTargetType(join(guardDir, gf), false, `.dsaf-guardrails/${gf}`, absTarget);
    }
  }
  for (const s of before.skills) {
    if (s.status === "outdated" && s.scope === "project") {
      assertWritableTargetType(s.path, true, s.path, absTarget);
    }
  }
  for (const wf of before.workflows) {
    if (wf.status !== "outdated") continue;
    assertWritableTargetType(wf.fullPath, false, wf.file, absTarget);
    if (!existsSync(wf.fullPath) || !statSync(wf.fullPath).isFile()) {
      throw new Error(`Destination workflow file '${wf.file}' is not a regular file: ${wf.fullPath}`);
    }
  }
  for (const mcp of before.mcpConfigs) {
    if (mcp.status !== "outdated") continue;
    assertWritableTargetType(mcp.path, false, mcp.displayPath, mcp.scope === "project" ? absTarget : null);
    installMcpConfig({
      agent: mcp.agent,
      scope: mcp.scope,
      cwd: absTarget,
      home,
      packageTag: "latest",
      dryRun: true,
    });
  }
  return { personaUpdatePlan, guardrailUpdatePlan };
}

function countLocalOutdated(localState) {
  let c = localState.skills.filter((s) => s.status === "outdated").length;
  if (localState.personas?.status === "outdated") c++;
  if (localState.guardrails?.status === "outdated") c++;
  c += localState.workflows.filter((w) => w.status === "outdated").length;
  c += localState.mcpConfigs.filter((m) => m.status === "outdated").length;
  return c;
}

export async function inspectProjectUpdates(targetDir = ".", opts = {}) {
  const local = inspectLocalUpdateState(targetDir, opts);
  const cli = await checkLatestVersion({
    currentVersion: opts.currentVersion || UPDATE_VERSION,
    cacheOnly: Boolean(opts.offline),
    forceRefresh: !opts.offline && Boolean(opts.refresh),
    cachePath: opts.cachePath,
    fetchImpl: opts.fetchImpl,
  });

  const outdatedCount = (cli.outdated ? 1 : 0) + countLocalOutdated(local);

  return {
    schema: "dsaf-update/1",
    version: UPDATE_VERSION,
    target: local.absTarget,
    cli,
    skills: local.skills,
    personas: local.personas,
    guardrails: local.guardrails,
    workflows: local.workflows,
    mcpConfigs: local.mcpConfigs,
    outdatedCount,
  };
}

export async function runUpdate(targetDir = ".", opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const checkOnly = Boolean(opts.check);

  // Pre-validate all local targets, personas, guardrails, workflows, and MCP targets BEFORE any npm fetch or cache write
  const localBefore = inspectLocalUpdateState(targetDir, opts);
  const { absTarget, home } = localBefore;
  const applyPlan = !checkOnly ? planAndValidateApply({ absTarget, home, before: localBefore }) : { personaUpdatePlan: null, guardrailUpdatePlan: null };

  const cli = await checkLatestVersion({
    currentVersion: opts.currentVersion || UPDATE_VERSION,
    cacheOnly: Boolean(opts.offline),
    forceRefresh: !opts.offline && Boolean(opts.refresh),
    cachePath: opts.cachePath,
    fetchImpl: opts.fetchImpl,
  });
  const before = {
    schema: "dsaf-update/1",
    version: UPDATE_VERSION,
    target: absTarget,
    cli,
    skills: localBefore.skills,
    personas: localBefore.personas,
    guardrails: localBefore.guardrails,
    workflows: localBefore.workflows,
    mcpConfigs: localBefore.mcpConfigs,
    outdatedCount: (cli.outdated ? 1 : 0) + countLocalOutdated(localBefore),
  };
  const { personaUpdatePlan, guardrailUpdatePlan } = applyPlan;
  const updated = [];
  const preserved = [];

  if (!checkOnly) {
    // 1. Refresh installed outdated skills
    for (const s of before.skills) {
      if (s.status !== "outdated") continue;
      installSkills({
        agent: s.agent,
        scope: s.scope,
        cwd: absTarget,
        home,
        dryRun,
      });
      updated.push(`skill:${s.agent}:${s.scope} (${s.installedVersion} -> v${UPDATE_VERSION})`);
    }

    // 2. Refresh .dsaf/personas.json while preserving .dsaf/personas.custom.json
    if (personaUpdatePlan) {
      const { dsafDir, personaReport } = personaUpdatePlan;
      if (!dryRun) {
        writeFileSync(join(dsafDir, "personas.json"), JSON.stringify(personaReport, null, 2) + "\n", "utf8");
      }
      updated.push(`.dsaf/personas.json (${before.personas.version || "old"} -> v${UPDATE_VERSION})`);
      if (existsSync(join(dsafDir, "personas.custom.json"))) {
        preserved.push(".dsaf/personas.custom.json");
      }
    }

    // 3. Refresh .dsaf-guardrails/ while preserving stack & mode
    if (guardrailUpdatePlan) {
      const { stack, mode } = guardrailUpdatePlan;
      if (!dryRun) {
        generateGuardrails({
          outDir: join(absTarget, ".dsaf-guardrails"),
          stack,
          mode,
        });
      }
      updated.push(`.dsaf-guardrails (${before.guardrails.versions.join(",") || "stale"} -> v${UPDATE_VERSION})`);
    }

    // 4. Refresh explicit semver workflow pins (keep @v0 floating channel untouched!)
    for (const wf of before.workflows) {
      if (wf.hasFloatingV0 && wf.pinnedOlder.length === 0) {
        preserved.push(`${wf.file} (@v0)`);
      }
      if (wf.status !== "outdated") continue;
      const raw = readFileSync(wf.fullPath, "utf8");
      const nextRaw = rewriteWorkflowPins(raw, UPDATE_VERSION);
      if (nextRaw !== raw) {
        if (!dryRun) writeFileSync(wf.fullPath, nextRaw, "utf8");
        updated.push(`${wf.file} (${wf.pinnedOlder.join(",")} -> v${UPDATE_VERSION})`);
      }
    }

    // 5. Refresh outdated pinned MCP configs to @latest
    for (const mcp of before.mcpConfigs) {
      if (mcp.status !== "outdated") continue;
      installMcpConfig({
        agent: mcp.agent,
        scope: mcp.scope,
        cwd: absTarget,
        home,
        packageTag: "latest",
        dryRun,
      });
      updated.push(`mcp:${mcp.agent}:${mcp.scope} (${mcp.packageSpec} -> @zintaen/dsaf@latest)`);
    }
  }

  let effectiveOutdatedCount = before.outdatedCount;
  let snapshot = before;
  if (!checkOnly && !dryRun) {
    const afterLocal = await inspectProjectUpdates(absTarget, { ...opts, offline: true, refresh: false });
    effectiveOutdatedCount =
      (before.cli.outdated ? 1 : 0) + (afterLocal.outdatedCount - (afterLocal.cli.outdated ? 1 : 0));
    snapshot = { ...afterLocal, cli: before.cli };
  }

  return {
    ...snapshot,
    outdatedCount: effectiveOutdatedCount,
    beforeOutdatedCount: before.outdatedCount,
    mode: checkOnly ? "check" : dryRun ? "dry-run" : "applied",
    updated,
    preserved: [...new Set(preserved)],
  };
}

function renderUpdateText(res) {
  const lines = [
    `DSAF Update v${res.version} (${res.mode.toUpperCase()}) — Target: ${res.target}`,
    `CLI: installed v${res.cli.currentVersion}${
      res.cli.latestVersion
        ? ` | npm latest v${res.cli.latestVersion}${res.cli.outdated ? " [OUTDATED — run: npm i -g @zintaen/dsaf@latest]" : " [OK]"}`
        : ` (${res.cli.reason || "offline"})`
    }`,
  ];
  if (res.skills.length > 0) {
    lines.push(`Agent Skills: ${res.skills.map((s) => `${s.displayPath} (${s.installedVersion}:${s.status})`).join(", ")}`);
  }
  if (res.personas) {
    lines.push(`Personas (.dsaf/personas.json): ${res.personas.status} (v${res.personas.version || "?"})`);
  }
  if (res.guardrails) {
    lines.push(`Guardrails (.dsaf-guardrails/): ${res.guardrails.status} (v${res.guardrails.versions.join(",") || "?"})`);
  }
  if (res.workflows.length > 0) {
    lines.push(`Workflows: ${res.workflows.map((w) => `${w.file} [${w.status}]`).join(", ")}`);
  }
  if (res.mcpConfigs.length > 0) {
    lines.push(`MCP Configs: ${res.mcpConfigs.map((m) => `${m.displayPath} (${m.packageSpec}:${m.status})`).join(", ")}`);
  }
  if (res.updated.length > 0) lines.push(`Updated (${res.updated.length}): ${res.updated.join("; ")}`);
  if (res.preserved.length > 0) lines.push(`Preserved: ${res.preserved.join(", ")}`);
  lines.push(`Outdated items detected: ${res.outdatedCount}`);
  return lines.join("\n") + "\n";
}

async function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-update-test-"));
  try {
    const repo = join(scratch, "ext-repo");
    const fakeHome = join(scratch, "home");
    mkdirSync(join(repo, ".dsaf"), { recursive: true });
    mkdirSync(join(repo, ".dsaf-guardrails"), { recursive: true });
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    mkdirSync(join(repo, ".claude/skills/dsaf"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(fakeHome, { recursive: true });

    writeFileSync(join(repo, "src/app.css"), ":root { --ink: #111827; }\n.btn { color: var(--ink); }\n");
    writeFileSync(join(repo, ".claude/skills/dsaf/SKILL.md"), "---\nname: dsaf\n---\n# DSAF v0.9.1\n");
    writeFileSync(
      join(repo, ".dsaf/personas.custom.json"),
      JSON.stringify([{ name: "Custom Domain Reviewer", axis: "Custom Compliance" }])
    );
    writeFileSync(join(repo, ".dsaf/personas.json"), JSON.stringify({ schema: "dsaf-personas/1", version: "0.9.1", recommendedMode: "C", surfaceMode: "Operate", personas: [] }));
    writeFileSync(join(repo, ".dsaf-guardrails/check-design-discipline.mjs"), "// Generated by DSAF v0.9.1\n");
    writeFileSync(join(repo, ".dsaf-guardrails/AGENTS-dsaf-rules.md"), "# DSAF Rules (v0.9.1, Mode C, Stack: tailwind)\n");
    writeFileSync(join(repo, ".dsaf-guardrails/dsaf-regression-gate.yml"), "# Generated by DSAF v0.9.1\n");
    writeFileSync(join(repo, ".github/workflows/dsaf-pin.yml"), "steps:\n  - uses: zintaen/dsaf@v0.9.1\n");
    writeFileSync(join(repo, ".github/workflows/dsaf-floating.yml"), "steps:\n  - uses: zintaen/dsaf@v0\n");
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { dsaf: { command: "npx", args: ["-y", "@zintaen/dsaf@0.9.1", "mcp"] } } })
    );

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "0.9.9" }),
    });
    const cachePath = join(scratch, "cache.json");

    // 1. Check only finds all outdated components & does not mutate
    const checked = await runUpdate(repo, {
      check: true,
      home: fakeHome,
      cachePath,
      fetchImpl: mockFetch,
    });
    assert.ok(checked.outdatedCount >= 6, `Expected >=6 outdated components, got ${checked.outdatedCount}`);
    assert.equal(checked.updated.length, 0);
    assert.match(readFileSync(join(repo, ".github/workflows/dsaf-pin.yml"), "utf8"), /v0\.9\.1/);

    // 2. Dry-run previews updates without modifying disk
    const dry = await runUpdate(repo, { dryRun: true, home: fakeHome, cachePath, fetchImpl: mockFetch });
    assert.ok(dry.updated.length >= 5);
    assert.match(readFileSync(join(repo, ".github/workflows/dsaf-pin.yml"), "utf8"), /v0\.9\.1/);

    // 3. Apply updates safely & preserve custom personas & @v0 floating pin
    const applied = await runUpdate(repo, { home: fakeHome, cachePath, fetchImpl: mockFetch });
    assert.ok(applied.updated.length >= 5);
    const updatedPersonas = JSON.parse(readFileSync(join(repo, ".dsaf/personas.json"), "utf8"));
    assert.equal(updatedPersonas.version, UPDATE_VERSION);
    assert.ok(updatedPersonas.personas.some((p) => p.name === "Custom Domain Reviewer"));
    assert.match(readFileSync(join(repo, ".claude/skills/dsaf/SKILL.md"), "utf8"), new RegExp(`v${UPDATE_VERSION.replaceAll(".", "\\.")}`));
    assert.match(readFileSync(join(repo, ".dsaf-guardrails/check-design-discipline.mjs"), "utf8"), new RegExp(`v${UPDATE_VERSION.replaceAll(".", "\\.")}`));
    assert.match(readFileSync(join(repo, ".github/workflows/dsaf-pin.yml"), "utf8"), new RegExp(`zintaen/dsaf@v${UPDATE_VERSION.replaceAll(".", "\\.")}`));
    assert.match(readFileSync(join(repo, ".github/workflows/dsaf-floating.yml"), "utf8"), /zintaen\/dsaf@v0\b/);
    const updatedMcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    assert.deepEqual(updatedMcp.mcpServers.dsaf.args, ["-y", "@zintaen/dsaf@latest", "mcp"]);

    // 4. Re-inspect offline
    const afterReinspect = await inspectProjectUpdates(repo, {
      home: fakeHome,
      cachePath: join(scratch, "fresh-cache.json"),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: UPDATE_VERSION }) }),
    });
    assert.equal(afterReinspect.outdatedCount, 0, "All updated project items must now report up-to-date");

    // 5. Corrupt .dsaf/personas.json rejects strictly, prerelease & custom refs, depth/maxCap & surfaceMode preservation
    const r2Repo = join(scratch, "r2-repo");
    mkdirSync(join(r2Repo, ".dsaf"), { recursive: true });
    mkdirSync(join(r2Repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(r2Repo, ".dsaf/personas.json"), "{ invalid-json");
    await assert.rejects(() => inspectProjectUpdates(r2Repo, { offline: true }), /invalid JSON/);

    writeFileSync(
      join(r2Repo, ".dsaf/personas.json"),
      JSON.stringify({ schema: "dsaf-personas/1", version: "0.9.1", depth: "quick", maxCap: 4, surfaceMode: "Read", personas: [] })
    );
    writeFileSync(
      join(r2Repo, ".github/workflows/ci.yml"),
      [
        "steps:",
        "  - uses: zintaen/dsaf@v0.9.1-rc-1+build.1",
        "  - uses: zintaen/dsaf@v0.10.0_custom",
        "  - run: npx -y @zintaen/dsaf@0.9.1 check .",
      ].join("\n") + "\n"
    );
    const r2Applied = await runUpdate(r2Repo, {
      offline: true,
      cachePath: join(scratch, "fresh-cache.json"),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: UPDATE_VERSION }) }),
    });
    assert.equal(r2Applied.outdatedCount, 0);
    const r2Wf = readFileSync(join(r2Repo, ".github/workflows/ci.yml"), "utf8");
    assert.match(r2Wf, new RegExp(`uses: zintaen/dsaf@v${UPDATE_VERSION.replaceAll(".", "\\.")}\\n`));
    assert.match(r2Wf, /uses: zintaen\/dsaf@v0\.10\.0_custom/);
    assert.match(r2Wf, new RegExp(`npx -y @zintaen/dsaf@${UPDATE_VERSION.replaceAll(".", "\\.")} check \\.`));
    const r2Personas = JSON.parse(readFileSync(join(r2Repo, ".dsaf/personas.json"), "utf8"));
    assert.equal(r2Personas.depth, "quick");
    assert.equal(r2Personas.maxCap, 4);
    assert.equal(r2Personas.surfaceMode, "read", "Existing personas.surfaceMode must be preserved when regenerating personas.json");
    assert.equal(r2Applied.personas.status, "up_to_date");
    assert.equal(r2Applied.workflows[0].status, "up_to_date");

    // 6. Newer personas/guardrails never downgraded, malformed personas.custom.json aborts BEFORE mutating skill files or fetching remote
    const r5Repo = join(scratch, "r5-newer");
    mkdirSync(join(r5Repo, ".dsaf"), { recursive: true });
    mkdirSync(join(r5Repo, ".dsaf-guardrails"), { recursive: true });
    writeFileSync(join(r5Repo, ".dsaf/personas.json"), JSON.stringify({ schema: "dsaf-personas/1", version: "9.9.9", personas: [] }));
    writeFileSync(join(r5Repo, ".dsaf-guardrails/check-design-discipline.mjs"), "// DSAF v9.9.9\n");
    const r5Check = await inspectProjectUpdates(r5Repo, { offline: true });
    assert.equal(r5Check.personas.status, "up_to_date");
    assert.equal(r5Check.guardrails.status, "up_to_date");

    const r7Repo = join(scratch, "r7-malformed-personas");
    mkdirSync(join(r7Repo, ".dsaf"), { recursive: true });
    mkdirSync(join(r7Repo, "src"), { recursive: true });
    writeFileSync(join(r7Repo, "src/App.tsx"), "export const App = () => <h1>Hello</h1>;\n");
    installSkills({ agent: "claude", scope: "project", cwd: r7Repo });
    writeFileSync(join(r7Repo, ".claude/skills/dsaf/SKILL.md"), "---\nname: dsaf\n---\nDSAF v0.9.1\n");
    writeFileSync(join(r7Repo, ".dsaf/personas.json"), JSON.stringify({ schema: "dsaf-personas/1", version: "0.9.1", personas: [] }));
    writeFileSync(join(r7Repo, ".dsaf/personas.custom.json"), "{ invalid-personas-json");
    let fetchCalls = 0;
    const r18CacheFile = join(scratch, "r18-home/.dsaf/update-check.json");
    await assert.rejects(
      () =>
        runUpdate(r7Repo, {
          home: join(scratch, "r18-home"),
          cachePath: r18CacheFile,
          fetchImpl: async () => {
            fetchCalls++;
            throw new Error("should not fetch");
          },
        }),
      SyntaxError
    );
    assert.equal(fetchCalls, 0);
    assert.equal(existsSync(r18CacheFile), false);
    assert.match(readFileSync(join(r7Repo, ".claude/skills/dsaf/SKILL.md"), "utf8"), /DSAF v0\.9\.1/);

    // 7. Symlink & case dedupe, delimiters (&, |, ;, ), ], `), subpath action pins, repo-root escape, mcpServers array rejection
    const r9RealRepo = join(scratch, "r9-real-repo");
    const r9LinkRepo = join(scratch, "r9-link-repo");
    mkdirSync(r9RealRepo, { recursive: true });
    installSkills({ agent: "claude", scope: "project", cwd: r9RealRepo });
    writeFileSync(
      join(r9RealRepo, ".mcp.json"),
      JSON.stringify({ mcpServers: { dsaf: { command: "npx", args: ["-y", "@zintaen/dsaf@0.9.1", "mcp"] } } })
    );
    symlinkSync(r9RealRepo, r9LinkRepo);
    const r9SymCheck = await inspectProjectUpdates(r9LinkRepo, { home: r9RealRepo, allAgents: true, offline: true });
    assert.equal(r9SymCheck.skills.length, 1);
    assert.equal(r9SymCheck.mcpConfigs.length, 1);
    const r9Done = await runUpdate(r9RealRepo, { home: r9RealRepo, allAgents: true, offline: true });
    assert.equal(r9Done.mcpConfigs[0].status, "up_to_date");

    // Round 24 (A1 L1, A1 L2, A4 M9): workflow shell operators && / |, mcpServers: [], case-normalized --scope
    const r24WfRepo = join(scratch, "r24-wf-ops");
    mkdirSync(join(r24WfRepo, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(r24WfRepo, ".github/workflows/ci.yml"),
      "steps:\n  - run: npx @zintaen/dsaf@0.9.1&&echo ok\n  - run: npx @zintaen/dsaf@0.9.1|cat\n  - uses: zintaen/dsaf/action@v0.9.1\n"
    );
    const r24WfRes = await runUpdate(r24WfRepo, { offline: true, home: fakeHome });
    assert.equal(r24WfRes.outdatedCount, 0);
    const r24WfAfter = readFileSync(join(r24WfRepo, ".github/workflows/ci.yml"), "utf8");
    assert.match(r24WfAfter, new RegExp(`@zintaen/dsaf@${UPDATE_VERSION.replaceAll(".", "\\.")}&&echo ok`));
    assert.match(r24WfAfter, new RegExp(`@zintaen/dsaf@${UPDATE_VERSION.replaceAll(".", "\\.")}\\|cat`));
    assert.match(r24WfAfter, new RegExp(`zintaen/dsaf/action@v${UPDATE_VERSION.replaceAll(".", "\\.")}`));

    const r24BadMcp = join(scratch, "r24-bad-mcp");
    mkdirSync(join(r24BadMcp, ".cursor"), { recursive: true });
    writeFileSync(join(r24BadMcp, ".cursor/mcp.json"), '{"mcpServers": []}');
    await assert.rejects(() => inspectProjectUpdates(r24BadMcp, { offline: true, home: fakeHome }), /mcpServers/);

    const r24DirPersonas = join(scratch, "r24-dir-personas");
    mkdirSync(join(r24DirPersonas, ".dsaf/personas.json"), { recursive: true });
    await assert.rejects(() => inspectProjectUpdates(r24DirPersonas, { offline: true, home: fakeHome }), /not a regular file/);

    const r23SymUp = join(scratch, "r23-sym-up");
    mkdirSync(join(r23SymUp, ".dsaf-guardrails"), { recursive: true });
    const r23OutGuard = join(scratch, "r23-out-guard.mjs");
    writeFileSync(r23OutGuard, "// Generated by DSAF v0.9.1\n");
    symlinkSync(r23OutGuard, join(r23SymUp, ".dsaf-guardrails/check-design-discipline.mjs"));
    await assert.rejects(() => runUpdate(r23SymUp, { offline: true, dryRun: false, home: scratch }), /escapes/i);

    const updateSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r24WfRepo, "--scope", "PROJECT", "--offline", "--check"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r24WfRepo, "--scope", "", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, "", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r24WfRepo, r24WfRepo, "--offline", "--check"], { encoding: "utf8" }).status, 2);

    // Round 26 regression (A1-M1): intra-repo live symlink under .dsaf-guardrails fails upfront on --dry-run and apply without mutating skills/personas
    const r26IntraSymRepo = join(scratch, "r26-intra-sym");
    mkdirSync(join(r26IntraSymRepo, ".claude/skills/dsaf"), { recursive: true });
    writeFileSync(join(r26IntraSymRepo, ".claude/skills/dsaf/SKILL.md"), "---\nname: dsaf\ndescription: v0.0.1\n---\nold\n");
    mkdirSync(join(r26IntraSymRepo, ".dsaf"), { recursive: true });
    writeFileSync(join(r26IntraSymRepo, ".dsaf/personas.json"), JSON.stringify({ version: "0.0.1", personas: [{ id: "p1", name: "Old" }] }));
    mkdirSync(join(r26IntraSymRepo, ".dsaf-guardrails"), { recursive: true });
    writeFileSync(join(r26IntraSymRepo, "real-guard.mjs"), "// DSAF Guardrail v0.0.1\n");
    symlinkSync(join(r26IntraSymRepo, "real-guard.mjs"), join(r26IntraSymRepo, ".dsaf-guardrails/check-design-discipline.mjs"));
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r26IntraSymRepo, "--scope", "project", "--dry-run", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r26IntraSymRepo, "--scope", "project", "--offline"], { encoding: "utf8" }).status, 2);
    assert.match(readFileSync(join(r26IntraSymRepo, ".claude/skills/dsaf/SKILL.md"), "utf8"), /v0\.0\.1/);
    assert.equal(JSON.parse(readFileSync(join(r26IntraSymRepo, ".dsaf/personas.json"), "utf8")).version, "0.0.1");

    const r26IntraDirSymRepo = join(scratch, "r26-intra-dir-sym");
    mkdirSync(join(r26IntraDirSymRepo, ".claude/skills/dsaf"), { recursive: true });
    writeFileSync(join(r26IntraDirSymRepo, ".claude/skills/dsaf/SKILL.md"), "---\nname: dsaf\ndescription: v0.0.1\n---\nold\n");
    mkdirSync(join(r26IntraDirSymRepo, "real-gr-dir"), { recursive: true });
    writeFileSync(join(r26IntraDirSymRepo, "real-gr-dir/check-design-discipline.mjs"), "// DSAF Guardrail v0.0.1\n");
    symlinkSync(join(r26IntraDirSymRepo, "real-gr-dir"), join(r26IntraDirSymRepo, ".dsaf-guardrails"));
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r26IntraDirSymRepo, "--scope", "project", "--dry-run", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r26IntraDirSymRepo, "--scope", "project", "--offline"], { encoding: "utf8" }).status, 2);
    assert.match(readFileSync(join(r26IntraDirSymRepo, ".claude/skills/dsaf/SKILL.md"), "utf8"), /v0\.0\.1/);

    // R30 (A1-M1): intra-repo live leaf symlink at .mcp.json must still inspect via --check, but fail upfront on --dry-run and apply without mutating target or skills/personas
    const r30McpSymRepo = join(scratch, "r30-mcp-sym-repo");
    mkdirSync(join(r30McpSymRepo, ".claude/skills/dsaf"), { recursive: true });
    writeFileSync(join(r30McpSymRepo, ".claude/skills/dsaf/SKILL.md"), "---\nname: dsaf\ndescription: v0.0.1\n---\nold\n");
    mkdirSync(join(r30McpSymRepo, ".dsaf"), { recursive: true });
    writeFileSync(join(r30McpSymRepo, ".dsaf/personas.json"), JSON.stringify({ version: "0.0.1", personas: [{ id: "p1", name: "Old" }] }));
    const r30SharedMcp = join(r30McpSymRepo, "shared-mcp.json");
    const r30OrigMcp = JSON.stringify({ mcpServers: { dsaf: { command: "npx", args: ["-y", "@zintaen/dsaf@0.9.1", "mcp"] } } }, null, 2) + "\n";
    writeFileSync(r30SharedMcp, r30OrigMcp);
    symlinkSync(r30SharedMcp, join(r30McpSymRepo, ".mcp.json"));
    const r30Check = await inspectProjectUpdates(r30McpSymRepo, { offline: true, scope: "project", home: fakeHome });
    assert.ok(r30Check.mcpConfigs.some((m) => m.status === "outdated"), "R30 A1-M1: --check should report outdated symlinked MCP config");
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r30McpSymRepo, "--scope", "project", "--dry-run", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [updateSelfPath, r30McpSymRepo, "--scope", "project", "--offline"], { encoding: "utf8" }).status, 2);
    assert.equal(readFileSync(r30SharedMcp, "utf8"), r30OrigMcp);
    assert.match(readFileSync(join(r30McpSymRepo, ".claude/skills/dsaf/SKILL.md"), "utf8"), /v0\.0\.1/);
    assert.equal(JSON.parse(readFileSync(join(r30McpSymRepo, ".dsaf/personas.json"), "utf8")).version, "0.0.1");

    console.log("DSAF_UPDATE_SELF_TEST_PASSED (CLI check + skills + personas preserve + guardrails + workflows + MCP)");
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
        check: { type: "boolean", default: false },
        "fail-if-outdated": { type: "boolean", default: false },
        "all-agents": { type: "boolean", default: false },
        scope: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });

    if (values.help) {
      console.log(
        "Usage: dsaf update [target] [--check] [--fail-if-outdated] [--all-agents] [--scope project|user] [--dry-run] [--offline] [--json] [--self-test] [--help]"
      );
      process.exit(0);
    }
    if (values["self-test"]) {
      process.exit(await runSelfTest());
    }
    let cliScope = null;
    if (values.scope !== undefined) {
      const normScope = values.scope.trim().toLowerCase();
      if (normScope !== "project" && normScope !== "user") {
        console.error(`Unsupported --scope '${values.scope}'. Expected 'project' or 'user'.`);
        process.exit(2);
      }
      cliScope = normScope;
    }
    if (positionals.length > 1) {
      console.error(`ERROR: Unexpected extra positional argument '${positionals[1]}'. Pass a single [target].`);
      process.exit(2);
    }
    if (positionals.length > 0 && positionals[0].trim().length === 0) {
      console.error("ERROR: Target directory must be a non-empty path.");
      process.exit(2);
    }

    const res = await runUpdate(positionals.length > 0 ? positionals[0] : ".", {
      check: Boolean(values.check),
      allAgents: Boolean(values["all-agents"]),
      scope: cliScope,
      dryRun: Boolean(values["dry-run"]),
      offline: Boolean(values.offline),
    });

    if (values.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else {
      process.stdout.write(renderUpdateText(res));
    }

    if (values["fail-if-outdated"] && res.outdatedCount > 0) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

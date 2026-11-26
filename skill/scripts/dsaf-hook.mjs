#!/usr/bin/env node
/**
 * DSAF v0.4.0 — Edit-Time Agent Design Hook & Floor/Reflex Static Checker.
 * Zero external dependencies. Supports:
 * - `dsaf hook check <file-or-dir> [--tier floor|all] [--sarif <f>] [--github] [--report-unused-ignores] [--json]`
 * - `dsaf hook stdin [--tier floor|all]` (PostToolUse Edit|Write hook for Claude / Cursor / Codex)
 * - `dsaf hook install [--agent claude|cursor|codex] [--dir <project>] [--local]`
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  applyIgnores,
  CI_REPORT_VERSION,
  formatGithubAnnotations,
  formatSarif,
  maskRangePreservingLines,
  offsetToLine,
  stripCommentsPreservingLines,
  stripTokenBlocksPreservingLines,
} from "./ci-report.mjs";

const UI_EXTS = new Set([".css", ".scss", ".html", ".tsx", ".jsx", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
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

function extractCssRuleBlocks(cleanedCss) {
  const blocks = [];
  let idx = 0;
  let depth = 0;
  let headerStart = 0;
  const stack = [];

  while (idx < cleanedCss.length) {
    const ch = cleanedCss[idx];
    if (ch === "{") {
      const selector = cleanedCss.slice(headerStart, idx).trim();
      const inStartingStyle = stack.some((s) => /@starting-style\b/i.test(s.selector)) || /@starting-style\b/i.test(selector);
      depth++;
      stack.push({ selector, bodyStart: idx + 1, selectorStart: headerStart, inStartingStyle });
      headerStart = idx + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) {
        blocks.push({
          selector: top.selector,
          selectorStart: top.selectorStart,
          bodyStart: top.bodyStart,
          bodyEnd: idx,
          inStartingStyle: top.inStartingStyle,
          body: cleanedCss.slice(top.bodyStart, idx),
        });
      }
      depth = Math.max(0, depth - 1);
      headerStart = idx + 1;
    } else if (ch === ";") {
      headerStart = idx + 1;
    }
    idx++;
  }
  return blocks;
}

function maskSvgAndStyleTokens(raw, isStyle) {
  let clean = stripCommentsPreservingLines(raw);
  if (isStyle) {
    clean = stripTokenBlocksPreservingLines(clean);
  }
  const chars = clean.split("");
  for (const m of clean.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
    maskRangePreservingLines(chars, m.index, m.index + m[0].length);
  }
  return chars.join("");
}

export function scanUiContent(raw, filePath, options = {}) {
  const tier = options.tier || "floor";
  const ext = extname(filePath).toLowerCase();
  if (!UI_EXTS.has(ext)) {
    return { file: filePath, active: [], waived: [], unusedIgnores: [], counts: { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 } };
  }

  const isStyle = ext === ".css" || ext === ".scss";
  const cleanComments = stripCommentsPreservingLines(raw);
  const findings = [];

  // Extract CSS sources: either whole CSS/SCSS file, or `<style>...</style>` blocks inside HTML/Vue/Svelte/Astro
  const cssSlices = [];
  if (isStyle) {
    cssSlices.push({ text: cleanComments, baseOffset: 0 });
  } else {
    for (const m of cleanComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const tagEnd = m[0].indexOf(">") + 1;
      cssSlices.push({ text: m[1], baseOffset: m.index + tagEnd });
    }
  }

  for (const slice of cssSlices) {
    // 1. Floor: transition: all / transition-property: all
    for (const m of slice.text.matchAll(/\btransition(?:-property)?\s*:\s*([^;}\n]*)/gi)) {
      if (/(?<![a-z-])all(?![a-z-])/i.test(m[1])) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, slice.baseOffset + m.index),
          ruleId: "dsaf/no-transition-all",
          tier: "floor",
          severity: "error",
          message: `Disallowed \`transition: ${m[1].trim()}\`; transition explicit composited properties instead.`,
        });
      }
      // 2. Floor: layout-reflow transitions (width, height, top, left) — avoids line-height/max-width via lookarounds
      const layoutHit = /(?<![a-z-])(width|height|top|left)(?![a-z-])/i.exec(m[1]);
      if (layoutHit) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, slice.baseOffset + m.index),
          ruleId: "dsaf/no-layout-transition",
          tier: "floor",
          severity: "error",
          message: `Disallowed layout transition on \`${layoutHit[1]}\`; animate \`transform\` or \`opacity\`.`,
        });
      }
    }

    // 3. Floor: 100vw horizontal overflow trap
    for (const m of slice.text.matchAll(/\b(?:min-|max-)?width\s*:\s*100vw\b/gi)) {
      findings.push({
        file: filePath,
        line: offsetToLine(cleanComments, slice.baseOffset + m.index),
        ruleId: "dsaf/no-100vw",
        tier: "floor",
        severity: "error",
        message: "Disallowed `100vw` width; use `100%` with `overflow-x: clip` to prevent scrollbar overflow.",
      });
    }

    // 4. Floor: outline: none / 0 without visible focus replacement in the same block
    for (const blk of extractCssRuleBlocks(slice.text)) {
      if (/:focus:not\(:focus-visible\)/i.test(blk.selector)) continue;
      const outMatch = /\boutline\s*:\s*(?:none|0)\b/i.exec(blk.body);
      if (outMatch) {
        const hasReplacement = /\b(?:box-shadow|border(?:-color|-width)?|outline-offset)\s*:/i.test(blk.body);
        if (!hasReplacement) {
          findings.push({
            file: filePath,
            line: offsetToLine(cleanComments, slice.baseOffset + blk.bodyStart + outMatch.index),
            ruleId: "dsaf/no-outline-none-naked",
            tier: "floor",
            severity: "error",
            message: `Focus \`${outMatch[0]}\` on \`${blk.selector || "(rule)"}\` without visible focus ring/border replacement.`,
          });
        }
      }

      // 6. Floor: hidden reveal containers at rest without `.js` gate or `@starting-style`
      if (/(?:^|[\s,])(?:\.reveal|\[data-reveal\])/i.test(blk.selector) && !/\.js\b/i.test(blk.selector) && !blk.inStartingStyle) {
        const opMatch = /\bopacity\s*:\s*0(?:\s*;|\s*$)/i.exec(blk.body);
        if (opMatch) {
          findings.push({
            file: filePath,
            line: offsetToLine(cleanComments, slice.baseOffset + blk.bodyStart + opMatch.index),
            ruleId: "dsaf/no-hidden-at-rest",
            tier: "floor",
            severity: "error",
            message: `Selector \`${blk.selector}\` sets \`opacity: 0\` at rest without a \`.js\` scope or \`@starting-style\`.`,
          });
        }
      }
    }
  }

  // Non-CSS markup / JSX checks
  if (!isStyle) {
    // 1b. Tailwind transition-all
    for (const m of cleanComments.matchAll(/(?:^|[\s"'`:])(transition-all)\b/g)) {
      findings.push({
        file: filePath,
        line: offsetToLine(cleanComments, m.index),
        ruleId: "dsaf/no-transition-all",
        tier: "floor",
        severity: "error",
        message: "Disallowed Tailwind utility `transition-all`; use `transition-colors` or `transition-transform`.",
      });
    }
    // 3b. Tailwind w-[100vw]
    for (const m of cleanComments.matchAll(/(?:^|[\s"'`:])(?:w|min-w|max-w)-\[100vw\]/g)) {
      findings.push({
        file: filePath,
        line: offsetToLine(cleanComments, m.index),
        ruleId: "dsaf/no-100vw",
        tier: "floor",
        severity: "error",
        message: "Disallowed Tailwind `w-[100vw]`; use `w-full`.",
      });
    }
    // 4b. Tailwind outline-none without focus replacement on the same attribute/line
    for (const m of cleanComments.matchAll(/class(?:Name)?\s*=\s*(["'`])([^"'`\n]+)\1/g)) {
      const classes = m[2];
      if (/\boutline-none\b/.test(classes) && !/(?:focus-visible:|focus:)?(?:ring-|outline(?:-|\s|$)|border-)/.test(classes.replace(/\boutline-none\b/g, ""))) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, m.index),
          ruleId: "dsaf/no-outline-none-naked",
          tier: "floor",
          severity: "error",
          message: "Tailwind `outline-none` without paired `focus-visible:ring-*` or focus `outline-*`.",
        });
      }
    }
    // 5. Floor: <video autoplay> without muted
    for (const m of cleanComments.matchAll(/<video\b([^>]*)>/gi)) {
      if (/\bautoplay\b/i.test(m[1]) && !/\bmuted\b/i.test(m[1])) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, m.index),
          ruleId: "dsaf/no-autoplay-unmuted",
          tier: "floor",
          severity: "error",
          message: "Autoplaying `<video>` must include `muted` (and `playsinline`).",
        });
      }
    }
  }

  // Reflex checks (when tier === "all")
  if (tier === "all") {
    const surface = maskSvgAndStyleTokens(raw, isStyle);
    const nonVars = surface.replace(/--[a-zA-Z0-9_-]+\s*:[^;}\n]+;?/g, (seg) =>
      seg.replace(/[^\n]/g, " ")
    );
    const nonTwHex = nonVars.replace(/-\[#[^\]\s]+\]/g, (seg) => seg.replace(/[^\n]/g, " "));
    if (isStyle) {
      for (const m of nonTwHex.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        findings.push({
          file: filePath,
          line: offsetToLine(nonTwHex, m.index),
          ruleId: "dsaf/hardcoded-color",
          tier: "reflex",
          severity: "warning",
          message: `Hardcoded color \`${m[0]}\` outside token block; bind to \`var(--*)\`.`,
        });
      }
    }
    for (const m of surface.matchAll(/!important\b/g)) {
      findings.push({
        file: filePath,
        line: offsetToLine(surface, m.index),
        ruleId: "dsaf/important-override",
        tier: "reflex",
        severity: "warning",
        message: "Disallowed `!important` override outside spec rules.",
      });
    }
    for (const m of surface.matchAll(/(?:^|[\s"'`])(?:bg|text|border|fill|stroke|ring|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap)-\[(?:#[0-9a-fA-F]{3,8}|\d+(?:\.\d+)?px)\]/g)) {
      findings.push({
        file: filePath,
        line: offsetToLine(surface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[0].trim()}\`; bind to theme tokens.`,
      });
    }
  }

  const applied = applyIgnores(findings, raw, filePath, { reportUnusedIgnores: Boolean(options.reportUnusedIgnores) });
  return { file: filePath, ...applied };
}

export function checkFile(filePath, options = {}) {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`File not found: ${abs}`);
  }
  const raw = readFileSync(abs, "utf8");
  const rel = options.displayPath || filePath;
  return scanUiContent(raw, rel, options);
}

function collectUiFiles(targetPath) {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) throw new Error(`Target not found: ${abs}`);
  const st = statSync(abs);
  if (st.isFile()) return [{ full: abs, rel: targetPath.replace(/\\/g, "/") }];

  const out = [];
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory() && e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (UI_EXTS.has(extname(e.name).toLowerCase())) {
        const rel = relative(abs, full).replace(/\\/g, "/");
        if (!/(\.test\.|\.spec\.|__tests__\/|(^|\/)(?:tests?|fixtures|evolve)\/|\.min\.|\.bundle\.)/i.test(rel)) {
          out.push({ full, rel });
        }
      }
    }
  }
  walk(abs);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function runHookStdin(rawStdin, options = {}) {
  if (!rawStdin || !rawStdin.trim()) return {};
  let payload;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    return {};
  }
  const filePath = payload?.tool_input?.file_path || payload?.file_path;
  if (typeof filePath !== "string" || !filePath) return {};
  if (!UI_EXTS.has(extname(filePath).toLowerCase()) || !existsSync(filePath)) return {};

  const res = checkFile(filePath, {
    tier: options.tier || "floor",
    displayPath: basename(filePath),
    reportUnusedIgnores: Boolean(options.reportUnusedIgnores),
  });
  const blocking = res.active.filter((f) => (options.tier === "all" ? f.tier === "floor" || f.tier === "reflex" : f.tier === "floor"));
  if (blocking.length === 0) return {};

  const lines = blocking.slice(0, 10).map((f) => `- [${f.tier.toUpperCase()}] ${f.ruleId} (line ${f.line}): ${f.message}`);
  const more = blocking.length > 10 ? `\n  (+${blocking.length - 10} more)` : "";
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `DSAF edit-time Floor check on ${basename(filePath)}: ${blocking.length} finding(s).\n${lines.join("\n")}${more}\nFix Floor violations before finishing (Floor rules cannot be waived).`,
    },
  };
}

export function installAgentHook({ agent = "claude", dir = ".", local = false } = {}) {
  const projectDir = resolve(dir);
  const scriptPath = decodeURIComponent(new URL(import.meta.url).pathname);
  const cmd = local ? `node ${JSON.stringify(scriptPath)} stdin` : "npx -y @zintaen/dsaf hook stdin";

  let relTarget;
  if (agent === "claude") relTarget = ".claude/settings.json";
  else if (agent === "cursor") relTarget = ".cursor/hooks.json";
  else if (agent === "codex") relTarget = ".codex/hooks.json";
  else throw new Error(`Unsupported agent '${agent}'. Expected claude, cursor, or codex.`);

  const targetFile = join(projectDir, relTarget);
  mkdirSync(dirname(targetFile), { recursive: true });
  let cfg = {};
  if (existsSync(targetFile)) {
    try {
      cfg = JSON.parse(readFileSync(targetFile, "utf8"));
    } catch {
      throw new Error(`Existing ${relTarget} is not valid JSON.`);
    }
  }

  if (!cfg.hooks || typeof cfg.hooks !== "object") cfg.hooks = {};
  if (!Array.isArray(cfg.hooks.PostToolUse)) cfg.hooks.PostToolUse = [];

  const isDsafMatcher = (entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && (h.command.includes("dsaf-hook.mjs") || h.command.includes("@zintaen/dsaf hook")));

  const newEntry = {
    matcher: "Edit|Write",
    hooks: [
      {
        type: "command",
        command: cmd,
        timeout: 5,
        statusMessage: "DSAF edit-time Floor check",
      },
    ],
  };

  const existingIdx = cfg.hooks.PostToolUse.findIndex(isDsafMatcher);
  if (existingIdx >= 0) cfg.hooks.PostToolUse[existingIdx] = newEntry;
  else cfg.hooks.PostToolUse.push(newEntry);

  writeFileSync(targetFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { agent, file: targetFile, command: cmd };
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-hook-test-"));
  try {
    // 1. Floor violations & safe non-violations (line-height, :focus:not(:focus-visible))
    const badCss = join(scratch, "bad.css");
    writeFileSync(
      badCss,
      [
        ".ok { transition: opacity 150ms ease; line-height: 1.5; max-width: 100%; }",
        ".ok:focus:not(:focus-visible) { outline: none; }",
        "/* dsaf-ignore dsaf/no-transition-all -- trying to ignore floor */",
        ".card { transition: all 200ms; width: 100vw; }",
        ".btn:focus-visible { outline: 0; }",
        ".reveal { opacity: 0; }",
      ].join("\n")
    );
    const badRes = checkFile(badCss, { tier: "floor", displayPath: "bad.css" });
    const ids = new Set(badRes.active.map((f) => f.ruleId));
    assert.ok(ids.has("dsaf/no-transition-all"), "Must flag transition: all");
    assert.ok(ids.has("dsaf/floor-waiver-rejected"), "Must reject floor waiver");
    assert.ok(ids.has("dsaf/no-100vw"), "Must flag 100vw");
    assert.ok(ids.has("dsaf/no-outline-none-naked"), "Must flag naked outline: 0");
    assert.ok(ids.has("dsaf/no-hidden-at-rest"), "Must flag .reveal { opacity: 0 }");
    assert.ok(!ids.has("dsaf/no-layout-transition"), "Must NOT false-positive on line-height");

    // 2. HTML <video autoplay> without muted
    const badHtml = join(scratch, "hero.html");
    writeFileSync(badHtml, `<video autoplay loop src="clip.mp4"></video><video autoplay muted playsinline src="ok.mp4"></video>`);
    const htmlRes = checkFile(badHtml, { tier: "floor", displayPath: "hero.html" });
    assert.equal(htmlRes.active.length, 1);
    assert.equal(htmlRes.active[0].ruleId, "dsaf/no-autoplay-unmuted");

    // 3. Clean CSS passes with 0 findings (including @starting-style)
    const cleanCss = join(scratch, "clean.css");
    writeFileSync(
      cleanCss,
      `:root { --accent: #1d4ed8; }\n.btn { color: var(--accent); transition: transform 150ms ease; }\n.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n@starting-style { .reveal { opacity: 0; } }\n`
    );
    const cleanRes = checkFile(cleanCss, { tier: "all", displayPath: "clean.css" });
    assert.equal(cleanRes.active.length, 0, "Clean CSS must pass --tier all cleanly");

    // 4. Stdin hook payload
    const hookOut = runHookStdin(JSON.stringify({ tool_input: { file_path: badCss } }));
    assert.match(hookOut.hookSpecificOutput.additionalContext, /DSAF edit-time Floor check/);

    // 5. Idempotent install
    const repo = join(scratch, "proj");
    mkdirSync(repo, { recursive: true });
    const i1 = installAgentHook({ agent: "claude", dir: repo });
    const i2 = installAgentHook({ agent: "claude", dir: repo });
    const cfg = JSON.parse(readFileSync(i2.file, "utf8"));
    assert.equal(i1.file, i2.file);
    assert.equal(cfg.hooks.PostToolUse.length, 1, "Idempotent hook install must not duplicate entries");

    console.log("DSAF_HOOK_SELF_TEST_PASSED (Floor/Reflex rules + waiver rejection + stdin hook + idempotent install)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseFlagArgs(argv) {
  const positionals = [];
  const flags = { tier: "floor", agent: "claude", dir: ".", local: false, json: false, github: false, reportUnusedIgnores: false, sarif: null, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") flags.tier = argv[++i] || "floor";
    else if (a === "--agent") flags.agent = argv[++i] || "claude";
    else if (a === "--dir") flags.dir = argv[++i] || ".";
    else if (a === "--sarif") flags.sarif = argv[++i];
    else if (a === "--local") flags.local = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--github") flags.github = true;
    else if (a === "--report-unused-ignores") flags.reportUnusedIgnores = true;
    else if (a === "--self-test") flags.selfTest = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else positionals.push(a);
  }
  return { positionals, flags };
}

function main() {
  const { positionals, flags } = parseFlagArgs(process.argv.slice(2));
  if (flags.help || (!flags.selfTest && positionals.length === 0)) {
    console.log(
      [
        `DSAF v${CI_REPORT_VERSION} — Edit-Time Design Hook`,
        "Usage:",
        "  dsaf hook check <file-or-dir> [--tier floor|all] [--sarif <file>] [--github] [--report-unused-ignores] [--json]",
        "  dsaf hook stdin [--tier floor|all]",
        "  dsaf hook install [--agent claude|cursor|codex] [--dir <project>] [--local]",
        "  dsaf hook --self-test",
      ].join("\n")
    );
    process.exit(0);
  }
  if (flags.selfTest) process.exit(runSelfTest());

  const [sub, ...rest] = positionals;
  if (sub === "stdin") {
    const raw = readFileSync(0, "utf8");
    const out = runHookStdin(raw, { tier: flags.tier, reportUnusedIgnores: flags.reportUnusedIgnores });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  if (sub === "install") {
    const res = installAgentHook({ agent: flags.agent, dir: flags.dir, local: flags.local });
    console.log(`DSAF_HOOK_INSTALLED: agent=${res.agent} file=${res.file} command=${res.command}`);
    process.exit(0);
  }

  const target = sub === "check" ? rest[0] || "." : sub;
  const files = collectUiFiles(target);
  const allActive = [];
  const allWaived = [];
  const allUnused = [];
  for (const f of files) {
    const r = checkFile(f.full, {
      tier: flags.tier,
      displayPath: f.rel,
      reportUnusedIgnores: flags.reportUnusedIgnores,
    });
    allActive.push(...r.active);
    allWaived.push(...r.waived);
    allUnused.push(...r.unusedIgnores);
  }

  const counts = {
    floor: allActive.filter((x) => x.tier === "floor").length,
    reflex: allActive.filter((x) => x.tier === "reflex").length,
    finish: allActive.filter((x) => x.tier === "finish").length,
    waived: allWaived.length,
    unusedIgnores: allUnused.length,
  };
  const blockingCount = flags.tier === "all" ? counts.floor + counts.reflex : counts.floor;
  const passed = blockingCount === 0;

  if (flags.sarif) {
    const outPath = resolve(flags.sarif);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(formatSarif(allActive, { toolVersion: CI_REPORT_VERSION }), null, 2) + "\n", "utf8");
  }

  if (flags.github) {
    const ann = formatGithubAnnotations(allActive);
    if (ann) console.log(ann);
  } else if (flags.json) {
    console.log(JSON.stringify({ schema: "dsaf-hook/1", target, tier: flags.tier, passed, counts, active: allActive, waived: allWaived, unusedIgnores: allUnused }, null, 2));
  } else {
    console.log(`DSAF_HOOK_CHECK: files=${files.length} floor=${counts.floor} reflex=${counts.reflex} waived=${counts.waived} unusedIgnores=${counts.unusedIgnores}`);
    for (const f of allActive.slice(0, 30)) {
      console.log(`  [${f.tier.toUpperCase()}] ${f.file}:${f.line} ${f.ruleId} — ${f.message}`);
    }
    console.log(passed ? "DSAF_HOOK_PASSED" : "DSAF_HOOK_FAILED");
  }

  process.exit(passed ? 0 : 1);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

#!/usr/bin/env node
/**
 * DSAF v0.9.1 — Safe, Bounded Floor Auto-Remediator (`dsaf fix`).
 * Deterministically patches verified Floor defects (`dsaf/no-transition-all`,
 * `dsaf/no-100vw`, `dsaf/no-outline-none-naked`, `dsaf/no-autoplay-unmuted`)
 * while respecting `.dsaf/rules.json` protectedFiles and dry-run previews.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, relative } from "node:path";
import { parseArgs } from "node:util";
import { offsetToLine, stripCommentsPreservingLines } from "./ci-report.mjs";
import { checkTarget, collectUiFiles, extractCssRuleBlocks } from "./dsaf-hook.mjs";

export const FIX_VERSION = "0.9.1";

const ALLOWED_FIXED_RULES = new Set([
  "dsaf/no-transition-all",
  "dsaf/no-100vw",
  "dsaf/no-outline-none-naked",
  "dsaf/no-autoplay-unmuted",
]);

function findRulesContext(startDir) {
  let cur = resolve(startDir || ".");
  for (let i = 0; i <= 5; i++) {
    const candidate = join(cur, ".dsaf", "rules.json");
    if (existsSync(candidate)) {
      try {
        return { rootDir: cur, rules: JSON.parse(readFileSync(candidate, "utf8")) };
      } catch {
        return { rootDir: cur, rules: null };
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function globToRegex(pattern) {
  const norm = String(pattern || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const esc = norm
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DBLSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DBLSTAR__/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

function isProtectedPath(absFile, rulesCtx) {
  if (!rulesCtx?.rules?.protectedFiles || !Array.isArray(rulesCtx.rules.protectedFiles)) return false;
  const relFromRoot = relative(rulesCtx.rootDir, absFile).replace(/\\/g, "/");
  for (const pat of rulesCtx.rules.protectedFiles) {
    const cleanPat = String(pat || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!cleanPat) continue;
    if (relFromRoot === cleanPat || relFromRoot.startsWith(`${cleanPat.replace(/\/+$/, "")}/`)) return true;
    if (globToRegex(cleanPat).test(relFromRoot)) return true;
  }
  return false;
}

function maskCommentPositions(raw) {
  return stripCommentsPreservingLines(raw);
}

function applyReplacements(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  const nonOverlapping = [];
  let lastStart = Infinity;
  for (const ed of sorted) {
    if (ed.end <= lastStart) {
      nonOverlapping.push(ed);
      lastStart = ed.start;
    }
  }
  let out = src;
  for (const ed of nonOverlapping) {
    out = out.slice(0, ed.start) + ed.replacement + out.slice(ed.end);
  }
  return { content: out, applied: nonOverlapping.reverse() };
}

function isSimpleFocusSelector(sel) {
  if (!sel || sel.includes("{") || sel.includes("}")) return false;
  if (/&|::(?:before|after|placeholder|selection)\b/i.test(sel)) return false;
  return true;
}

function buildFocusReplacementEdits(sliceText, raw, baseOffset, activeOutlineLines, cleanComments) {
  const edits = [];
  const skipped = [];
  const blocks = extractCssRuleBlocks(sliceText);
  for (const blk of blocks) {
    const outMatch = /\boutline\s*:\s*(?:none|0)\b/i.exec(blk.body);
    if (!outMatch) continue;
    const ruleLine = offsetToLine(cleanComments, baseOffset + blk.bodyStart + outMatch.index);
    if (!activeOutlineLines.has(ruleLine)) continue;

    const bodyStartAbs = baseOffset + blk.bodyStart;
    const bodyEndAbs = baseOffset + blk.bodyEnd;
    const rawSpan = raw.slice(baseOffset + blk.selectorStart, bodyStartAbs - 1);
    const leadingWs = rawSpan.length - rawSpan.trimStart().length;
    const trailingWs = rawSpan.length - rawSpan.trimEnd().length;
    const selStartAbs = baseOffset + blk.selectorStart + leadingWs;
    const selEndAbs = bodyStartAbs - 1 - trailingWs;
    const rawSelector = raw.slice(selStartAbs, selEndAbs);
    const branches = rawSelector.split(",").map((s) => s.trim()).filter(Boolean);
    if (branches.length === 0 || branches.some((b) => !isSimpleFocusSelector(b))) {
      skipped.push({ line: ruleLine, ruleId: "dsaf/no-outline-none-naked", reason: "complex selector — review manually" });
      continue;
    }

    const blockEndAbs = bodyEndAbs + 1;
    const isDirectFocusVisible = branches.every((b) => /:focus-visible\b/i.test(b));

    if (isDirectFocusVisible) {
      const mAbsStart = bodyStartAbs + outMatch.index;
      const semiIdx = raw.indexOf(";", mAbsStart);
      const repEnd = semiIdx !== -1 && semiIdx < bodyEndAbs ? semiIdx + 1 : mAbsStart + outMatch[0].length;
      edits.push({
        start: mAbsStart,
        end: repEnd,
        replacement: "outline: 2px solid var(--focus, currentColor); outline-offset: 2px;",
        ruleId: "dsaf/no-outline-none-naked",
        line: ruleLine,
        summary: "Replace bare outline removal on :focus-visible with visible ring",
      });
      continue;
    }

    const focusVisibleSelectors = [];
    const rewrittenBranches = [];
    let abort = false;
    for (const br of branches) {
      if (/:focus:not\(:focus-visible\)/i.test(br)) {
        rewrittenBranches.push(br);
      } else if (/:focus\b/i.test(br)) {
        rewrittenBranches.push(br.replace(/:focus\b/gi, ":focus:not(:focus-visible)"));
        focusVisibleSelectors.push(br.replace(/:focus\b/gi, ":focus-visible"));
      } else if (!/:focus-visible\b/i.test(br)) {
        rewrittenBranches.push(br);
        focusVisibleSelectors.push(`${br}:focus-visible`);
      } else {
        abort = true;
      }
    }

    if (abort || focusVisibleSelectors.length === 0) {
      skipped.push({ line: ruleLine, ruleId: "dsaf/no-outline-none-naked", reason: "ambiguous focus selector — review manually" });
      continue;
    }

    const uniqueFv = [...new Set(focusVisibleSelectors)];
    const indentMatch = raw.slice(0, selStartAbs).match(/(?:^|\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : "";
    const fvRule = `\n${indent}${uniqueFv.join(", ")} { outline: 2px solid var(--focus, currentColor); outline-offset: 2px; }`;

    edits.push({
      start: selStartAbs,
      end: selEndAbs,
      replacement: rewrittenBranches.join(", "),
      ruleId: "dsaf/no-outline-none-naked",
      line: ruleLine,
      summary: `Scope outline suppression to :focus:not(:focus-visible) and add ${uniqueFv.join(", ")}`,
    });
    edits.push({
      start: blockEndAbs,
      end: blockEndAbs,
      replacement: fvRule,
      ruleId: "dsaf/no-outline-none-naked",
      line: ruleLine,
      summary: `Insert visible :focus-visible fallback for ${uniqueFv.join(", ")}`,
    });
  }
  return { edits, skipped };
}

function buildFileFixPlan(absFile, relDisplay, activeFindings, ruleFilter) {
  const raw = readFileSync(absFile, "utf8");
  const cleanComments = maskCommentPositions(raw);
  const ext = extname(absFile).toLowerCase();
  const isStyle = ext === ".css" || ext === ".scss";

  const wantedFindings = activeFindings.filter((f) => ALLOWED_FIXED_RULES.has(f.ruleId) && (!ruleFilter || ruleFilter.has(f.ruleId)));
  if (wantedFindings.length === 0) {
    return null;
  }

  const lineSet = (ruleId) => new Set(wantedFindings.filter((f) => f.ruleId === ruleId).map((f) => f.line));
  const edits = [];
  const skipped = [];

  const cssSlices = [];
  if (isStyle) {
    cssSlices.push({ text: cleanComments, baseOffset: 0 });
  } else {
    for (const m of cleanComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const tagEnd = m[0].indexOf(">") + 1;
      cssSlices.push({ text: m[1], baseOffset: m.index + tagEnd });
    }
  }

  const transLines = lineSet("dsaf/no-transition-all");
  const vwLines = lineSet("dsaf/no-100vw");
  const outLines = lineSet("dsaf/no-outline-none-naked");
  const videoLines = lineSet("dsaf/no-autoplay-unmuted");

  for (const slice of cssSlices) {
    if (transLines.size > 0) {
      for (const m of slice.text.matchAll(/\b(transition(?:-property)?)\s*:\s*([^;}\n]*)/gi)) {
        if (!/(?<![a-z-])all(?![a-z-])/i.test(m[2])) continue;
        const ln = offsetToLine(cleanComments, slice.baseOffset + m.index);
        if (!transLines.has(ln)) continue;
        const prop = m[1].toLowerCase();
        const val = m[2].trim();
        let replacement = null;
        if (prop === "transition-property" && /^all$/i.test(val)) {
          replacement = `${m[1]}: color, background-color, border-color, opacity, transform`;
        } else if (prop === "transition") {
          const allMatch = /^all(?:\s+(.+))?$/i.exec(val);
          if (allMatch) {
            const rest = allMatch[1] ? allMatch[1].trim() : "";
            if (!rest) {
              replacement = "transition-property: color, background-color, border-color, opacity, transform";
            } else if (!rest.includes(",")) {
              replacement = `transition: color ${rest}, background-color ${rest}, border-color ${rest}, opacity ${rest}, transform ${rest}`;
            }
          }
        }
        if (replacement) {
          edits.push({
            start: slice.baseOffset + m.index,
            end: slice.baseOffset + m.index + m[0].length,
            replacement,
            ruleId: "dsaf/no-transition-all",
            line: ln,
            summary: `Replace transition all with explicit composited/color properties`,
          });
        } else {
          skipped.push({ line: ln, ruleId: "dsaf/no-transition-all", reason: "multi-value transition shorthand" });
        }
      }
    }

    if (vwLines.size > 0) {
      for (const m of slice.text.matchAll(/\b((?:min-|max-)?width)\s*:\s*100vw\b/gi)) {
        const ln = offsetToLine(cleanComments, slice.baseOffset + m.index);
        if (!vwLines.has(ln)) continue;
        edits.push({
          start: slice.baseOffset + m.index,
          end: slice.baseOffset + m.index + m[0].length,
          replacement: `${m[1]}: 100%`,
          ruleId: "dsaf/no-100vw",
          line: ln,
          summary: `Replace ${m[1]}: 100vw with ${m[1]}: 100%`,
        });
      }
    }

    if (outLines.size > 0) {
      const fPlan = buildFocusReplacementEdits(slice.text, raw, slice.baseOffset, outLines, cleanComments);
      edits.push(...fPlan.edits);
      skipped.push(...fPlan.skipped);
    }
  }

  if (!isStyle) {
    if (transLines.size > 0) {
      for (const m of cleanComments.matchAll(/(?:^|[\s"'`:])(transition-all)\b/g)) {
        const ln = offsetToLine(cleanComments, m.index);
        if (!transLines.has(ln)) continue;
        const tokIdx = m[0].lastIndexOf("transition-all");
        const start = m.index + tokIdx;
        edits.push({
          start,
          end: start + "transition-all".length,
          replacement: "transition-colors",
          ruleId: "dsaf/no-transition-all",
          line: ln,
          summary: "Replace Tailwind transition-all with transition-colors",
        });
      }
    }

    if (vwLines.size > 0) {
      for (const m of cleanComments.matchAll(/(?:^|[\s"'`:])((?:min-|max-)?w)-\[100vw\]/g)) {
        const ln = offsetToLine(cleanComments, m.index);
        if (!vwLines.has(ln)) continue;
        const tok = `${m[1]}-[100vw]`;
        const tokIdx = m[0].lastIndexOf(tok);
        const start = m.index + tokIdx;
        edits.push({
          start,
          end: start + tok.length,
          replacement: `${m[1]}-full`,
          ruleId: "dsaf/no-100vw",
          line: ln,
          summary: `Replace ${tok} with ${m[1]}-full`,
        });
      }
    }

    if (outLines.size > 0) {
      for (const m of cleanComments.matchAll(/class(?:Name)?\s*=\s*(["'`])([^"'`\n]+)\1/g)) {
        const ln = offsetToLine(cleanComments, m.index);
        if (!outLines.has(ln)) continue;
        const classes = m[2];
        if (!/\boutline-none\b/.test(classes) || /(?:focus-visible:|focus:)?(?:ring-|outline(?:-|\s|$)|border-)/.test(classes.replace(/\boutline-none\b/g, ""))) {
          continue;
        }
        const tokIdx = classes.search(/\boutline-none\b/);
        if (tokIdx === -1) continue;
        const innerOffset = m[0].indexOf(m[2]);
        const start = m.index + innerOffset + tokIdx;
        edits.push({
          start,
          end: start + "outline-none".length,
          replacement: "outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          ruleId: "dsaf/no-outline-none-naked",
          line: ln,
          summary: "Pair Tailwind outline-none with focus-visible:ring-2 focus-visible:ring-offset-2",
        });
      }
    }

    if (videoLines.size > 0) {
      for (const m of cleanComments.matchAll(/<video\b([^>]*)>/gi)) {
        const ln = offsetToLine(cleanComments, m.index);
        if (!videoLines.has(ln)) continue;
        if (/\bautoplay\b/i.test(m[1]) && !/\bmuted\b/i.test(m[1])) {
          const insertAt = m.index + "<video".length;
          const extra = /\bplaysinline\b/i.test(m[1]) ? " muted" : " muted playsinline";
          edits.push({
            start: insertAt,
            end: insertAt,
            replacement: extra,
            ruleId: "dsaf/no-autoplay-unmuted",
            line: ln,
            summary: "Add muted playsinline to autoplaying <video>",
          });
        }
      }
    }
  }

  if (edits.length === 0 && skipped.length === 0) return null;
  const { content: newContent, applied } = applyReplacements(raw, edits);
  return {
    file: absFile,
    rel: relDisplay,
    patchCount: applied.length,
    patches: applied.map(({ ruleId, line, summary }) => ({ ruleId, line, summary })),
    skipped,
    changed: newContent !== raw,
    newContent,
  };
}

export function planFloorFixes(target = ".", options = {}) {
  const absTarget = resolve(target);
  const startDir = existsSync(absTarget) && statSync(absTarget).isFile() ? dirname(absTarget) : absTarget;
  const rulesCtx = options.ignoreProtected ? null : findRulesContext(startDir);
  const ruleFilter = Array.isArray(options.rules) && options.rules.length > 0 ? new Set(options.rules) : null;
  const maxFiles = typeof options.maxFiles === "number" && options.maxFiles > 0 ? options.maxFiles : Infinity;

  const baseline = checkTarget(target, { tier: "floor", dsCss: options.dsCss });
  const uiFiles = collectUiFiles(target);
  const absByRel = new Map(uiFiles.map((f) => [f.rel, f.full]));

  const findingsByFile = new Map();
  for (const f of baseline.active) {
    if (f.tier !== "floor") continue;
    if (!findingsByFile.has(f.file)) findingsByFile.set(f.file, []);
    findingsByFile.get(f.file).push(f);
  }

  const filePlans = [];
  const protectedSkipped = [];
  const manualSkipped = [];

  for (const [relOrPath, findings] of findingsByFile.entries()) {
    const absFile = absByRel.get(relOrPath) || resolve(relOrPath);
    if (!existsSync(absFile) || !statSync(absFile).isFile()) continue;
    if (!options.ignoreProtected && isProtectedPath(absFile, rulesCtx)) {
      protectedSkipped.push({ file: relOrPath, findingsCount: findings.length, reason: "protectedFiles match in .dsaf/rules.json" });
      continue;
    }
    const plan = buildFileFixPlan(absFile, relOrPath, findings, ruleFilter);
    if (!plan) continue;
    if (plan.skipped.length > 0) {
      manualSkipped.push(...plan.skipped.map((s) => ({ file: relOrPath, ...s })));
    }
    if (plan.changed) {
      if (filePlans.length < maxFiles) {
        filePlans.push(plan);
      } else {
        manualSkipped.push({ file: relOrPath, ruleId: "budget", line: 0, reason: `exceeded maxFiles=${maxFiles} cap` });
      }
    }
  }

  return {
    version: FIX_VERSION,
    target: absTarget,
    dryRun: true,
    beforeFloor: baseline.counts.floor,
    filesWithFloor: findingsByFile.size,
    filesPlanned: filePlans.length,
    patchesPlanned: filePlans.reduce((n, f) => n + f.patchCount, 0),
    protectedSkipped,
    manualSkipped,
    files: filePlans,
  };
}

export function applyFloorFixes(target = ".", options = {}) {
  const plan = planFloorFixes(target, options);
  if (options.dryRun) return plan;

  const modified = [];
  const backups = [];
  for (const fp of plan.files) {
    if (options.backup) {
      const bakPath = `${fp.file}.dsaf.bak`;
      copyFileSync(fp.file, bakPath);
      backups.push(bakPath);
    }
    writeFileSync(fp.file, fp.newContent, "utf8");
    modified.push({ file: fp.rel, patchesApplied: fp.patchCount, patches: fp.patches });
  }

  const post = checkTarget(target, { tier: "floor", dsCss: options.dsCss });
  return {
    version: FIX_VERSION,
    target: plan.target,
    dryRun: false,
    beforeFloor: plan.beforeFloor,
    afterFloor: post.counts.floor,
    filesModified: modified.length,
    patchesApplied: modified.reduce((n, f) => n + f.patchesApplied, 0),
    backups,
    protectedSkipped: plan.protectedSkipped,
    manualSkipped: plan.manualSkipped,
    files: modified,
  };
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-fix-test-"));
  try {
    mkdirSync(join(scratch, ".dsaf"), { recursive: true });
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(
      join(scratch, ".dsaf/rules.json"),
      JSON.stringify({ schema: "dsaf-init-rules/1", protectedFiles: ["src/protected.css"] }),
      "utf8"
    );

    const protectedCss = join(scratch, "src/protected.css");
    const appCss = join(scratch, "src/app.css");
    const appTsx = join(scratch, "src/App.tsx");
    const heroHtml = join(scratch, "src/hero.html");

    writeFileSync(protectedCss, ".lock { transition: all 200ms; }\n", "utf8");
    writeFileSync(
      appCss,
      [
        ".card { transition: all 150ms ease; width: 100vw; }",
        ".btn:focus { outline: none; }",
        ".pair-a:focus, .pair-b:focus { outline: 0; }",
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      appTsx,
      'export function App() { return <button className="transition-all w-[100vw] outline-none">Go</button>; }\n',
      "utf8"
    );
    writeFileSync(heroHtml, '<video autoplay loop src="clip.mp4"></video>\n', "utf8");

    // 1. Dry-run must not modify files and must respect protectedFiles
    const dryRes = planFloorFixes(scratch);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.beforeFloor, 9);
    assert.equal(dryRes.protectedSkipped.length, 1);
    assert.equal(dryRes.filesPlanned, 3);
    assert.match(readFileSync(appCss, "utf8"), /outline: none/);

    // 2. Apply with --backup resolves all editable Floor defects cleanly while keeping protected.css untouched
    const applied = applyFloorFixes(scratch, { backup: true });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.filesModified, 3);
    assert.equal(applied.backups.length, 3);
    assert.equal(applied.afterFloor, 1, "Only protected.css should remain with 1 Floor defect");
    assert.equal(readFileSync(protectedCss, "utf8"), ".lock { transition: all 200ms; }\n");
    assert.ok(existsSync(`${appCss}.dsaf.bak`));
    assert.match(readFileSync(appTsx, "utf8"), /focus-visible:ring-2/);
    assert.match(readFileSync(heroHtml, "utf8"), /muted playsinline/);

    // Clean check without protected file confirms 0 Floor left in editable files
    rmSync(protectedCss);
    assert.equal(checkTarget(scratch, { tier: "floor" }).counts.floor, 0);

    console.log("DSAF_FIX_SELF_TEST_PASSED (dry-run + protectedFiles + backup + CSS/Tailwind/video remediation)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(decodeURIComponent(new URL(import.meta.url).pathname));
if (isEntrypoint) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      backup: { type: "boolean", default: false },
      rule: { type: "string", multiple: true, default: [] },
      "max-files": { type: "string" },
      "ignore-protected": { type: "boolean", default: false },
      "ds-css": { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      [
        `DSAF v${FIX_VERSION} — Safe Floor Auto-Remediator`,
        "Usage:",
        "  dsaf fix <target> [--dry-run] [--apply] [--backup] [--rule <id>] [--max-files <n>] [--ignore-protected] [--ds-css <path>] [--json]",
        "  dsaf fix --self-test",
      ].join("\n")
    );
    process.exit(0);
  }

  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  const target = positionals[0] || ".";
  const maxFiles = values["max-files"] ? Number.parseInt(values["max-files"], 10) : Infinity;
  const doApply = Boolean(values.apply) && !values["dry-run"];

  const out = doApply
    ? applyFloorFixes(target, {
        dryRun: false,
        backup: values.backup,
        rules: values.rule,
        maxFiles,
        ignoreProtected: values["ignore-protected"],
        dsCss: values["ds-css"],
      })
    : planFloorFixes(target, {
        rules: values.rule,
        maxFiles,
        ignoreProtected: values["ignore-protected"],
        dsCss: values["ds-css"],
      });

  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
  } else if (out.dryRun) {
    console.log(`DSAF_FIX v${FIX_VERSION} (DRY-RUN): beforeFloor=${out.beforeFloor} plannedFiles=${out.filesPlanned} plannedPatches=${out.patchesPlanned} protectedSkipped=${out.protectedSkipped.length}`);
    for (const f of out.files) {
      console.log(`  ${f.rel} (${f.patchCount} patch(es))`);
      for (const p of f.patches) console.log(`    - L${p.line} [${p.ruleId}] ${p.summary}`);
    }
  } else {
    console.log(`DSAF_FIX v${FIX_VERSION} (APPLIED): beforeFloor=${out.beforeFloor} afterFloor=${out.afterFloor} filesModified=${out.filesModified} patchesApplied=${out.patchesApplied}`);
  }
  process.exit(out.dryRun || out.afterFloor === 0 ? 0 : 1);
}

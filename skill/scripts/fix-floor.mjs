#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Safe, Bounded Floor Auto-Remediator (`dsaf fix`).
 * Deterministically patches verified Floor defects (`dsaf/no-transition-all`,
 * `dsaf/no-100vw`, `dsaf/no-outline-none-naked`, `dsaf/no-autoplay-unmuted`)
 * while respecting `.dsaf/rules.json` protectedFiles and dry-run previews.
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { extractRealStyleBlocks, isDirectCliEntry, maskRangePreservingLines, offsetToLine, splitTopLevelCommas, stripCommentsPreservingLines } from "./ci-report.mjs";
import {
  analyzeTailwindOutline,
  checkTarget,
  collectUiFiles,
  createCascadeLayerComparator,
  createFocusSafetyChecker,
  discoverExternalDsCss,
  extractClassAttributes,
  extractCssRuleBlocks,
  extractSubjectSelector,
  extractTailwindClassSpans,
  extractVideoTags,
  findOutlineRemovals,
  getTwUtilityPart,
  hasVisibleFocusIndicator,
  isInvisibleTwFocusUtility,
  isUnmutedAutoplayVideo,
  maskAtApplyDeclsPreservingLines,
  maskCssQuotedStringsPreservingLines,
  splitTailwindVariants,
  stripCssParens,
  stripNotPseudo,
  stripQuotedAttrValues,
  TW_TRANS_ALL_CORE,
  TW_VARIANT_SEG,
  TW_VW_CORE,
} from "./dsaf-hook.mjs";

export const FIX_VERSION = "0.9.3";

const ALLOWED_FIXED_RULES = new Set([
  "dsaf/no-transition-all",
  "dsaf/no-100vw",
  "dsaf/no-outline-none-naked",
  "dsaf/no-autoplay-unmuted",
]);

function findRulesContexts(startDir) {
  const contexts = [];
  const seen = new Set();
  let cur = resolve(startDir || ".");
  while (true) {
    const candidate = join(cur, ".dsaf", "rules.json");
    if (existsSync(candidate) && !seen.has(cur)) {
      seen.add(cur);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (err) {
        throw new Error(`Invalid JSON in ${candidate}: ${err.message}`);
      }
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, "protectedFiles")) {
        if (!Array.isArray(parsed.protectedFiles) || parsed.protectedFiles.some((x) => typeof x !== "string")) {
          throw new Error(`Invalid .dsaf/rules.json in ${candidate}: protectedFiles must be an array of strings.`);
        }
      }
      contexts.push({ rootDir: cur, rules: parsed });
    }
    if (existsSync(join(cur, ".git"))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return contexts;
}

function globToRegex(pattern) {
  const norm = String(pattern || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const esc = norm
    .replace(/\?/g, "__QMARK__")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "__DBLSTARSLASH__")
    .replace(/\*\*/g, "__DBLSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DBLSTARSLASH__/g, "(?:.*/)?")
    .replace(/__DBLSTAR__/g, ".*")
    .replace(/__QMARK__/g, "[^/]");
  return new RegExp(`^${esc}$`, "i");
}

function canonPathSimple(p) {
  try {
    return (realpathSync.native || realpathSync)(p);
  } catch {
    return resolve(p);
  }
}

function isWithinRootDir(rootDir, candidatePath) {
  const rel = relative(canonPathSimple(rootDir), canonPathSimple(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function isProtectedPath(absFile, rulesCtx) {
  if (!rulesCtx?.rules?.protectedFiles) return false;
  if (!Array.isArray(rulesCtx.rules.protectedFiles) || rulesCtx.rules.protectedFiles.some((x) => typeof x !== "string")) {
    throw new Error(`Invalid .dsaf/rules.json in ${rulesCtx.rootDir}: protectedFiles must be an array of strings.`);
  }
  const candidates = [];
  const rawRel = relative(rulesCtx.rootDir, absFile).replace(/\\/g, "/");
  candidates.push(rawRel);
  const realRel = relative(canonPathSimple(rulesCtx.rootDir), canonPathSimple(absFile)).replace(/\\/g, "/");
  if (realRel !== rawRel) candidates.push(realRel);
  for (const pat of rulesCtx.rules.protectedFiles) {
    const cleanPat = pat.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!cleanPat) continue;
    for (const relFromRoot of candidates) {
      if (relFromRoot === ".." || relFromRoot.startsWith("../") || isAbsolute(relFromRoot)) continue;
      const base = basename(relFromRoot);
      if (relFromRoot === cleanPat || relFromRoot.startsWith(`${cleanPat.replace(/\/+$/, "")}/`)) return true;
      if (globToRegex(cleanPat).test(relFromRoot)) return true;
      if (!cleanPat.includes("/") && (base.toLowerCase() === cleanPat.toLowerCase() || globToRegex(cleanPat).test(base))) return true;
    }
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
  if (!sel || sel.includes("{") || sel.includes("}") || sel.includes("#{") || sel.startsWith("@")) return false;
  if (/["']/.test(sel)) return false;
  if (/&|::|(?<!\\):(?:before|after|first-line|first-letter)\b/i.test(sel)) return false;
  if (/(?<!\\):focus-within\b/i.test(sel)) return false;
  const withoutFocusNot = sel.replace(/(?<!\\)(?::focus)?:not\(:focus-visible\)/gi, ":focus");
  if (/(?<!\\):(?:is|where|not|has)\(/i.test(withoutFocusNot)) return false;
  return true;
}

function findCssDeclEnd(body, startIdx) {
  let q = null;
  let p = 0;
  for (let i = startIdx; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      if (ch === "\\" && i + 1 < body.length) {
        i++;
        continue;
      }
      if (ch === q || ch === "\n") q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === "(") {
      p++;
    } else if (ch === ")") {
      p = Math.max(0, p - 1);
    } else if (ch === ";" && p === 0) {
      return i + 1;
    }
  }
  return -1;
}

function buildFocusReplacementEdits(sliceText, raw, baseOffset, activeOutlineLines, cleanComments, externalCssBlocks = [], opts = {}) {
  const edits = [];
  const skipped = [];
  const blocks = Array.isArray(opts.blocks) ? opts.blocks : extractCssRuleBlocks(sliceText);
  const allCandidateBlocks = Array.isArray(opts.docBlocks) ? opts.docBlocks : [...blocks, ...(Array.isArray(externalCssBlocks) ? externalCssBlocks : [])];
  const isSelectorSafeForOutlineNone = typeof opts.checker === "function" ? opts.checker : createFocusSafetyChecker(blocks, externalCssBlocks);
  const getBlockOrder = (b) => (typeof b?.docBodyStart === "number" ? b.docBodyStart : typeof b?.bodyStart === "number" ? b.bodyStart : null);

  for (const blk of blocks) {
    const outMatches = findOutlineRemovals(blk.body);
    if (outMatches.length === 0) continue;
    const matchedLines = outMatches.map((m) => offsetToLine(cleanComments, baseOffset + blk.bodyStart + m.index));
    if (!matchedLines.some((ln) => activeOutlineLines.has(ln))) continue;
    const ruleLine = [...matchedLines].reverse().find((ln) => activeOutlineLines.has(ln)) ?? matchedLines[matchedLines.length - 1];
    const effSel = blk.resolvedSelector || blk.selector;
    const borderSupp = isSelectorSafeForOutlineNone.getBorderSuppression ? isSelectorSafeForOutlineNone.getBorderSuppression(effSel, blk) : {};
    if (hasVisibleFocusIndicator(blk.body, effSel, borderSupp) || isSelectorSafeForOutlineNone(effSel, blk)) continue;

    const bodyStartAbs = baseOffset + blk.bodyStart;
    const bodyEndAbs = baseOffset + blk.bodyEnd;
    const cleanSpan = sliceText.slice(blk.selectorStart, blk.bodyStart - 1);
    const leadingWs = cleanSpan.length - cleanSpan.trimStart().length;
    const trailingWs = cleanSpan.length - cleanSpan.trimEnd().length;
    const selStartAbs = baseOffset + blk.selectorStart + leadingWs;
    const selEndAbs = bodyStartAbs - 1 - trailingWs;
    if (/\/\*|\/\//.test(raw.slice(selStartAbs, selEndAbs))) {
      skipped.push({ line: ruleLine, ruleId: "dsaf/no-outline-none-naked", reason: "selector contains inline comment — review manually" });
      continue;
    }
    const rawSelector = cleanSpan.trim();
    const branches = splitTopLevelCommas(rawSelector);
    if (branches.length === 0 || branches.some((b) => !isSimpleFocusSelector(b))) {
      skipped.push({ line: ruleLine, ruleId: "dsaf/no-outline-none-naked", reason: "complex selector — review manually" });
      continue;
    }

    const blockEndAbs = bodyEndAbs + 1;
    const splitSelectorCompounds = (sel) => {
      const comps = [];
      let p = 0, b = 0, q = null, start = 0;
      const str = String(sel || "").trim();
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (q) {
          if (ch === "\\" && i + 1 < str.length) { i++; continue; }
          if (ch === q) q = null;
          continue;
        }
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === "(") p++;
        else if (ch === ")") p = Math.max(0, p - 1);
        else if (ch === "[") b++;
        else if (ch === "]") b = Math.max(0, b - 1);
        else if (p === 0 && b === 0 && /[\s>+~]/.test(ch)) {
          const seg = str.slice(start, i).trim();
          if (seg) comps.push(seg);
          while (i + 1 < str.length && /[\s>+~]/.test(str[i + 1])) i++;
          start = i + 1;
        }
      }
      const tail = str.slice(start).trim();
      if (tail) comps.push(tail);
      return comps;
    };
    const replaceFocusOutsideNot = (sel, repSuffix) => {
      const str = String(sel || "");
      let out = "";
      let i = 0;
      let q = null;
      while (i < str.length) {
        const ch = str[i];
        if (q) {
          out += ch;
          if (ch === "\\" && i + 1 < str.length) { out += str[i + 1]; i += 2; continue; }
          if (ch === q) q = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") { q = ch; out += ch; i++; continue; }
        if (str.slice(i, i + 5).toLowerCase() === ":not(") {
          let depth = 1, nq = null, j = i + 5;
          while (j < str.length && depth > 0) {
            const c = str[j];
            if (nq) {
              if (c === "\\" && j + 1 < str.length) j++;
              else if (c === nq) nq = null;
            } else if (c === '"' || c === "'") nq = c;
            else if (c === "(") depth++;
            else if (c === ")") depth--;
            j++;
          }
          out += str.slice(i, j);
          i = j;
          continue;
        }
        if (str[i] === ":" && !(i > 0 && str[i - 1] === "\\") && /^:focus(?![a-z-])/i.test(str.slice(i))) {
          out += repSuffix;
          i += 6;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    };
    const hasFocusOutsideNot = (sel) => /(?<!\\):focus(?![a-z-])/i.test(stripNotPseudo(sel));
    const countFocusOutsideNot = (sel) => (stripNotPseudo(sel).match(/(?<!\\):focus(?![a-z-])/gi) || []).length;
    const isGuardedFocusBranch = (br) => {
      if (/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(br))) return false;
      const comps = splitSelectorCompounds(br);
      const focusComps = comps.filter((c) => hasFocusOutsideNot(c));
      if (focusComps.length === 0) return /(?<!\\):not\(:focus-visible\)/i.test(extractSubjectSelector(br));
      return focusComps.every((c) => /(?<!\\):not\(:focus-visible\)/i.test(c));
    };
    const replaceBranchFocus = (br, repSuffix) => replaceFocusOutsideNot(br, repSuffix);
    const resBranches = splitTopLevelCommas(blk.resolvedSelector || blk.selector || "").map((rb) => rb.trim()).filter(Boolean);
    const rawBranches = branches.map((rb) => rb.trim()).filter(Boolean);
    const isDirectFocusVisible = resBranches.length > 0 && resBranches.every((b) => /(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(b)));

    if (isDirectFocusVisible) {
      for (let idx = 0; idx < outMatches.length; idx++) {
        const om = outMatches[idx];
        const mAbsStart = bodyStartAbs + om.index;
        const declEndRel = findCssDeclEnd(blk.body, om.index);
        const repEnd =
          declEndRel !== -1
            ? bodyStartAbs + declEndRel
            : mAbsStart + om.matchText.length + blk.body.slice(om.index + om.matchText.length).trimEnd().length;
        const isLast = idx === outMatches.length - 1;
        edits.push({
          start: mAbsStart,
          end: repEnd,
          replacement: isLast ? "outline: 2px solid var(--focus, currentColor); outline-offset: 2px;" : "",
          ruleId: "dsaf/no-outline-none-naked",
          line: offsetToLine(cleanComments, mAbsStart),
          findingCount: isLast ? 1 : 0,
          summary: isLast ? "Replace bare outline removal on :focus-visible with visible ring" : "Remove duplicate bare outline removal",
        });
      }
      continue;
    }

    const sumResFocus = resBranches.reduce((acc, rb) => acc + countFocusOutsideNot(rb), 0);
    const sumRawFocus = rawBranches.reduce((acc, rb) => acc + countFocusOutsideNot(rb), 0);
    const hasFocusAncestor =
      Boolean(blk.resolvedSelector && blk.resolvedSelector !== blk.selector) &&
      rawBranches.length > 0 &&
      resBranches.length > 0 &&
      sumResFocus * rawBranches.length > sumRawFocus * resBranches.length;
    if (hasFocusAncestor) {
      skipped.push({
        line: ruleLine,
        ruleId: "dsaf/no-outline-none-naked",
        reason: "nested rule inside :focus ancestor — review manually",
      });
      continue;
    }

    const focusVisibleSelectors = [];
    const plainFocusFvTargets = new Set();
    const nonRewrittenFv = new Set();
    const rewrittenBranches = [];
    let abort = false;
    for (const br of branches) {
      if (isGuardedFocusBranch(br)) {
        rewrittenBranches.push(br);
      } else if (hasFocusOutsideNot(br)) {
        if (/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(br))) {
          abort = true;
          break;
        }
        const targetFv = replaceBranchFocus(br, ":focus-visible");
        rewrittenBranches.push(replaceBranchFocus(br, ":focus:not(:focus-visible)"));
        focusVisibleSelectors.push(targetFv);
        plainFocusFvTargets.add(targetFv);
      } else if (!/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(br))) {
        rewrittenBranches.push(br);
        const targetFv = `${br}:focus-visible`;
        focusVisibleSelectors.push(targetFv);
        nonRewrittenFv.add(targetFv);
      } else {
        abort = true;
      }
    }

    if (abort || focusVisibleSelectors.length === 0) {
      skipped.push({ line: ruleLine, ruleId: "dsaf/no-outline-none-naked", reason: "ambiguous focus selector — review manually" });
      continue;
    }

    const bodyChars = blk.body.split("");
    for (const om of outMatches) {
      const declEndRel = findCssDeclEnd(blk.body, om.index);
      const stop = declEndRel !== -1 ? declEndRel : blk.body.length;
      for (let k = om.index; k < stop; k++) {
        if (bodyChars[k] !== "\n") bodyChars[k] = " ";
      }
    }
    const bodyWithoutOutline = bodyChars.join("").trim();
    const hasOtherStylesOrNested = bodyWithoutOutline.length > 0 || (typeof blk.fullBody === "string" && blk.fullBody !== blk.body);
    const hasImportantOutline = outMatches.some((o) => o.isImportant);
    const hasNonFocusBranch = branches.some((b) => !hasFocusOutsideNot(b));
    if (hasImportantOutline && (hasOtherStylesOrNested || hasNonFocusBranch)) {
      skipped.push({
        line: ruleLine,
        ruleId: "dsaf/no-outline-none-naked",
        reason: "!important outline reset cannot be overridden cleanly — review manually",
      });
      continue;
    }

    const uniqueFv = [...new Set(focusVisibleSelectors)];
    const indentMatch = raw.slice(0, selStartAbs).match(/(?:^|\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : "";

    const newSel = rewrittenBranches.join(", ");
    const normSel = (s) => String(s || "").replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim().toLowerCase();
    const collapseFocusFv = (s) =>
      normSel(s)
        .replace(/(?<!\\):focus(?=:focus-visible(?![a-z-]))/gi, "")
        .replace(/((?<!\\):focus-visible):focus(?![a-z-])/gi, "$1");
    const rewriteBranchToFv = (br) =>
      hasFocusOutsideNot(br) ? replaceBranchFocus(br, ":focus-visible") : `${br}:focus-visible`;
    const resolvedTargetsForFv = (fvSel) => {
      if (!blk.resolvedSelector || blk.resolvedSelector === blk.selector) return [fvSel];
      if (resBranches.length === rawBranches.length) {
        const matched = [];
        for (let bi = 0; bi < rawBranches.length; bi++) {
          if (normSel(rewriteBranchToFv(rawBranches[bi])) === normSel(fvSel)) {
            matched.push(rewriteBranchToFv(resBranches[bi]));
          }
        }
        if (matched.length > 0) return matched;
      }
      const fvCleanTail = normSel(fvSel.replace(/^&+/, ""));
      const tailMatches = resBranches.map(rewriteBranchToFv).filter((rf) => normSel(rf).endsWith(fvCleanTail));
      return tailMatches.length > 0 ? tailMatches : [fvSel];
    };
    const conditionsCover = (otherBlk, targetBlk) => {
      const reqConds = Array.isArray(otherBlk?.conditions) ? otherBlk.conditions : [];
      if (reqConds.length === 0) return true;
      const targetConds = new Set(Array.isArray(targetBlk?.conditions) ? targetBlk.conditions : []);
      return reqConds.every((c) => targetConds.has(c));
    };
    const supSet = new Set();
    const impSupSet = new Set();
    for (const om of outMatches) {
      for (const sp of om.suppressedProps || []) {
        supSet.add(sp);
        if (om.isImportant) impSupSet.add(sp);
      }
    }
    const suppressedProps = [...supSet];
    const importantSuppressedProps = [...impSupSet];
    const canRewriteSelector = !hasOtherStylesOrNested && newSel !== rawSelector;
    const hasApplyFocusRemoval = outMatches.some((om) => om.fromApplyFocus);
    const blkOrder = getBlockOrder(blk);
    const externalBlockSet = new Set(Array.isArray(externalCssBlocks) ? externalCssBlocks : []);
    const compareCascadeLayerOrder =
      typeof isSelectorSafeForOutlineNone.compareLayerOrder === "function"
        ? isSelectorSafeForOutlineNone.compareLayerOrder
        : createCascadeLayerComparator([
            ...(Array.isArray(externalCssBlocks) ? externalCssBlocks : []),
            ...allCandidateBlocks,
          ]);
    const hasExistingFv = (fvSel) => {
      const targets = resolvedTargetsForFv(fvSel).map(collapseFocusFv);
      const keepsPlainFocus = !canRewriteSelector || nonRewrittenFv.has(fvSel);
      const mustFollowBlk = !canRewriteSelector && (plainFocusFvTargets.has(fvSel) || hasApplyFocusRemoval);
      const visOpts = keepsPlainFocus ? { suppressedProps, importantSuppressedProps } : {};
      return targets.every((tNorm) =>
        allCandidateBlocks.some((other) => {
          if (other === blk || !conditionsCover(other, blk)) return false;
          const layerCmp = compareCascadeLayerOrder(other, blk);
          const isOtherExternal = externalBlockSet.has(other);
          const otherOrder = getBlockOrder(other);
          const sameLayerEarlier =
            mustFollowBlk &&
            layerCmp === 0 &&
            !isOtherExternal &&
            otherOrder !== null &&
            blkOrder !== null &&
            otherOrder <= blkOrder;
          const outlineUnrecoverable = importantSuppressedProps.length > 0 && (layerCmp > 0 || sameLayerEarlier);
          const requireImportantOutlineOnly =
            (importantSuppressedProps.length === 0 && (layerCmp < 0 || sameLayerEarlier)) ||
            (isOtherExternal && mustFollowBlk && layerCmp === 0);
          return splitTopLevelCommas(other.resolvedSelector || other.selector || "").some((os) => {
            const trimOs = os.trim();
            if (collapseFocusFv(trimOs) !== tNorm) return false;
            const otherBorderSupp = isSelectorSafeForOutlineNone.getBorderSuppression
              ? isSelectorSafeForOutlineNone.getBorderSuppression(trimOs, other, keepsPlainFocus ? blk : null)
              : {};
            return hasVisibleFocusIndicator(other.body, trimOs, {
              ...visOpts,
              requireImportantOutlineOnly,
              outlineUnrecoverable,
              ...otherBorderSupp,
            });
          });
        })
      );
    };
    const missingFv = uniqueFv.filter((fvSel) => !hasExistingFv(fvSel));
    const fvRule = `\n${indent}${missingFv.join(", ")} { outline: 2px solid var(--focus, currentColor); outline-offset: 2px; }`;
    if (canRewriteSelector) {
      edits.push({
        start: selStartAbs,
        end: selEndAbs,
        replacement: newSel,
        ruleId: "dsaf/no-outline-none-naked",
        line: ruleLine,
        findingCount: 1,
        summary:
          missingFv.length === 0
            ? `Scope outline suppression to :focus:not(:focus-visible) (existing ${uniqueFv.join(", ")} preserved)`
            : missingFv.length < uniqueFv.length
            ? `Scope outline suppression to :focus:not(:focus-visible) and add ${missingFv.join(", ")}`
            : `Scope outline suppression to :focus:not(:focus-visible) and add ${uniqueFv.join(", ")}`,
      });
    }
    if (missingFv.length > 0) {
      edits.push({
        start: blockEndAbs,
        end: blockEndAbs,
        replacement: fvRule,
        ruleId: "dsaf/no-outline-none-naked",
        line: ruleLine,
        findingCount: canRewriteSelector ? 0 : 1,
        summary: `Insert visible :focus-visible fallback for ${missingFv.join(", ")}`,
      });
    }
  }
  return { edits, skipped };
}

function buildFileFixPlan(absFile, relDisplay, activeFindings, ruleFilter, externalCssBlocks = []) {
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

  const markupOpts = isStyle
    ? null
    : {
        isMarkupSfc: /\.(?:html?|vue|svelte|astro)$/i.test(absFile),
        braceExprs: /\.(?:svelte|astro)$/i.test(absFile),
        mustacheExprs: /\.vue$/i.test(absFile),
        isAstro: /\.astro$/i.test(absFile),
      };
  const cssSlices = [];
  const styleRanges = [];
  if (isStyle) {
    cssSlices.push({ text: cleanComments, baseOffset: 0, isScoped: false });
  } else {
    for (const blk of extractRealStyleBlocks(cleanComments, null, markupOpts)) {
      cssSlices.push({ text: blk.text, baseOffset: blk.bodyStart, isScoped: Boolean(blk.isScoped) });
      styleRanges.push([blk.openStart, blk.closeEnd]);
    }
  }
  let nonStyleClean = cleanComments;
  if (!isStyle && styleRanges.length > 0) {
    const nChars = cleanComments.split("");
    for (const [rs, re] of styleRanges) maskRangePreservingLines(nChars, rs, re);
    nonStyleClean = nChars.join("");
  }

  const transLines = lineSet("dsaf/no-transition-all");
  const vwLines = lineSet("dsaf/no-100vw");
  const outLines = lineSet("dsaf/no-outline-none-naked");
  const videoLines = lineSet("dsaf/no-autoplay-unmuted");

  const parsedSlices = cssSlices.map((slice) => ({
    slice,
    cssBlocks: extractCssRuleBlocks(slice.text).map((b) => ({ ...b, docBodyStart: slice.baseOffset + b.bodyStart })),
  }));
  const allUnscopedDocBlocks = parsedSlices.filter((p) => !p.slice.isScoped).flatMap((p) => p.cssBlocks);
  const allScopedDocBlocks = parsedSlices.filter((p) => p.slice.isScoped).flatMap((p) => p.cssBlocks);
  const unscopedChecker = createFocusSafetyChecker(allUnscopedDocBlocks, externalCssBlocks);
  const scopedChecker =
    allScopedDocBlocks.length > 0
      ? createFocusSafetyChecker([...allScopedDocBlocks, ...allUnscopedDocBlocks], externalCssBlocks)
      : unscopedChecker;

  for (const { slice, cssBlocks } of parsedSlices) {
    const isSelectorSafeForOutlineNone = slice.isScoped ? scopedChecker : unscopedChecker;

    for (const blk of cssBlocks) {
      const effSel = blk.resolvedSelector || blk.selector;
      const bodyOffset = slice.baseOffset + blk.bodyStart;
      const maskedBody = maskCssQuotedStringsPreservingLines(blk.body);
      const cssDeclBody = maskAtApplyDeclsPreservingLines(maskedBody);

      if (transLines.size > 0) {
        for (const m of cssDeclBody.matchAll(/(?<![a-zA-Z0-9_$-])(transition(?:-property)?)\s*:\s*((?:[^#\n{};]|#\{[^{}\n]*\}|#(?!\{))*)/gi)) {
          if (!/(?<![a-zA-Z0-9_$-])all(?![a-zA-Z0-9_-])/i.test(stripCssParens(m[2]))) continue;
          const ln = offsetToLine(cleanComments, bodyOffset + m.index);
          if (!transLines.has(ln)) continue;
          // Skip multiline declarations cleanly instead of rewriting only the first line.
          const restInBody = cssDeclBody.slice(m.index + m[0].length);
          const nextNonWs = /^\s*(\S?)/.exec(restInBody)?.[1] || "";
          const terminatedHere = nextNonWs === ";" || nextNonWs === "";
          const prop = m[1].toLowerCase();
          const val = blk.body.slice(m.index + m[0].indexOf(m[2]), m.index + m[0].length).trim();
          let replacement = null;
          if (terminatedHere) {
            if (prop === "transition-property" && /^all(?:\s*!\s*important)?$/i.test(val)) {
              const imp = /\s*!\s*important$/i.test(val) ? " !important" : "";
              replacement = `${m[1]}: color, background-color, border-color, opacity, transform${imp}`;
            } else if (prop === "transition") {
              const allMatch = /^all(?:\s+(.+))?$/i.exec(val);
              if (allMatch) {
                let rest = allMatch[1] ? allMatch[1].trim() : "";
                let imp = "";
                const impM = /\s*!\s*important$/i.exec(rest);
                if (impM) {
                  imp = " !important";
                  rest = rest.slice(0, impM.index).trim();
                }
                if (!rest) {
                  replacement = `transition-property: color, background-color, border-color, opacity, transform${imp}`;
                } else if (splitTopLevelCommas(rest).length === 1) {
                  replacement = `transition: color ${rest}, background-color ${rest}, border-color ${rest}, opacity ${rest}, transform ${rest}${imp}`;
                }
              }
            }
          }
          if (replacement) {
            edits.push({
              start: bodyOffset + m.index,
              end: bodyOffset + m.index + m[0].trimEnd().length,
              replacement,
              ruleId: "dsaf/no-transition-all",
              line: ln,
              summary: `Replace transition all with explicit composited/color properties`,
            });
          } else {
            skipped.push({
              line: ln,
              ruleId: "dsaf/no-transition-all",
              reason: terminatedHere ? "multi-value transition shorthand" : "multiline transition declaration — review manually",
            });
          }
        }
      }

      if (vwLines.size > 0) {
        for (const m of cssDeclBody.matchAll(/(?<![a-zA-Z0-9_$-])((?:min-|max-)?(?:width|inline-size))\s*:\s*100vw\b/gi)) {
          const ln = offsetToLine(cleanComments, bodyOffset + m.index);
          if (!vwLines.has(ln)) continue;
          edits.push({
            start: bodyOffset + m.index,
            end: bodyOffset + m.index + m[0].length,
            replacement: `${m[1]}: 100%`,
            ruleId: "dsaf/no-100vw",
            line: ln,
            summary: `Replace ${m[1]}: 100vw with ${m[1]}: 100%`,
          });
        }
      }

      if (transLines.size > 0 || vwLines.size > 0 || outLines.size > 0) {
        const applyMatches = [...maskedBody.matchAll(/(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)].map((am) => {
          const appRelStart = am.index + am[0].indexOf(am[1]);
          const rawAppText = String(blk.body || "").slice(appRelStart, appRelStart + am[1].length);
          return {
            appBase: bodyOffset + appRelStart,
            rawAppText,
            appText: maskCssQuotedStringsPreservingLines(rawAppText, "_"),
          };
        });
        const applyTransRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?)(${TW_TRANS_ALL_CORE})(!?)(?=$|[\\s;])`, "g");
        const applyVwRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?)(${TW_VW_CORE})(!?)(?=$|[\\s;])`, "g");
        for (let amIdx = 0; amIdx < applyMatches.length; amIdx++) {
          const { appBase, rawAppText, appText } = applyMatches[amIdx];
          const prevApplyText = applyMatches
            .slice(0, amIdx)
            .map((x) => x.appText)
            .join(" ");
          const afterApplyText = applyMatches
            .slice(amIdx + 1)
            .map((x) => x.appText)
            .join(" ");
          if (transLines.size > 0) {
            for (const tm of appText.matchAll(applyTransRe)) {
              const tokStart = appBase + tm.index;
              const ln = offsetToLine(cleanComments, tokStart);
              if (!transLines.has(ln)) continue;
              const fullLen = tm[0].length;
              const rawPref = rawAppText.slice(tm.index, tm.index + tm[1].length);
              const rawCore = rawAppText.slice(tm.index + tm[1].length, tm.index + tm[1].length + tm[2].length);
              const rawSuf = rawAppText.slice(tm.index + tm[1].length + tm[2].length, tm.index + fullLen);
              if (/^(?:transition-all|transition-\[all\]|\[transition(?:-property)?:all\])$/i.test(rawCore)) {
                edits.push({
                  start: tokStart,
                  end: tokStart + fullLen,
                  replacement: `${rawPref}transition-colors${rawSuf}`,
                  ruleId: "dsaf/no-transition-all",
                  line: ln,
                  summary: `Replace @apply ${rawCore} with transition-colors`,
                });
              } else {
                skipped.push({
                  line: ln,
                  ruleId: "dsaf/no-transition-all",
                  reason: `arbitrary @apply transition (${rawPref}${rawCore}${rawSuf}) — review manually`,
                });
              }
            }
          }
          if (vwLines.size > 0) {
            for (const vm of appText.matchAll(applyVwRe)) {
              const tokStart = appBase + vm.index;
              const ln = offsetToLine(cleanComments, tokStart);
              if (!vwLines.has(ln)) continue;
              const fullLen = vm[0].length;
              const rawPref = rawAppText.slice(vm.index, vm.index + vm[1].length);
              const rawCore = rawAppText.slice(vm.index + vm[1].length, vm.index + vm[1].length + vm[2].length);
              const rawSuf = rawAppText.slice(vm.index + vm[1].length + vm[2].length, vm.index + fullLen);
              const stdM = /^((?:min-|max-)?w)-(?:\[100vw\]|screen)$/i.exec(rawCore);
              const arbM = /^\[((?:min-|max-)?(?:width|inline-size)):100vw\]$/i.exec(rawCore);
              if (stdM) {
                edits.push({
                  start: tokStart,
                  end: tokStart + fullLen,
                  replacement: `${rawPref}${stdM[1]}-full${rawSuf}`,
                  ruleId: "dsaf/no-100vw",
                  line: ln,
                  summary: `Replace @apply ${rawPref}${rawCore} with ${rawPref}${stdM[1]}-full`,
                });
              } else if (arbM) {
                edits.push({
                  start: tokStart,
                  end: tokStart + fullLen,
                  replacement: `${rawPref}[${arbM[1]}:100%]${rawSuf}`,
                  ruleId: "dsaf/no-100vw",
                  line: ln,
                  summary: `Replace @apply ${rawPref}${rawCore} with ${rawPref}[${arbM[1]}:100%]`,
                });
              } else {
                skipped.push({
                  line: ln,
                  ruleId: "dsaf/no-100vw",
                  reason: `arbitrary @apply 100vw utility (${rawPref}${rawCore}${rawSuf}) — review manually`,
                });
              }
            }
          }
          if (outLines.size > 0) {
            const appOut = analyzeTailwindOutline(appText, afterApplyText, prevApplyText);
            const appUncovered = appOut.uncovered || (appOut.firstRemoval ? [appOut.firstRemoval] : []);
            if (appOut.hasRemoval && appOut.naked && appUncovered.length > 0) {
              const firstLn = offsetToLine(cleanComments, appBase + appOut.firstRemoval.tokIdx);
              const anyInOutLines = appUncovered.some((u) => outLines.has(offsetToLine(cleanComments, appBase + u.tokIdx))) || outLines.has(firstLn);
              const ignoreApplyOutline = !/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(effSel));
              const applyBorderSupp = isSelectorSafeForOutlineNone.getBorderSuppression ? isSelectorSafeForOutlineNone.getBorderSuppression(effSel, blk) : {};
              const selfCovered = hasVisibleFocusIndicator(blk.body, effSel, { ignoreApplyOutline, ...applyBorderSupp }) || isSelectorSafeForOutlineNone(effSel, blk);
              const targetCovered = isSelectorSafeForOutlineNone(effSel, blk, { targetOnly: true });
              const effectiveUncovered = anyInOutLines
                ? appUncovered.filter((u) => (u.targetPrefixes && u.targetPrefixes.size > 0 ? !targetCovered : !selfCovered))
                : [];
              if (effectiveUncovered.length > 0) {
                const seenTargetPrefs = new Set();
                for (const rem of effectiveUncovered) {
                  const uLn = offsetToLine(cleanComments, appBase + rem.tokIdx);
                  const rawTokStr = rawAppText.slice(rem.tokIdx, rem.tokIdx + rem.tokStr.length);
                  const remInfo = splitTailwindVariants(rem.tokStr);
                  if (remInfo.targetPrefixes.size > 0 && [...remInfo.targetPrefixes].some((tp) => tp.startsWith("["))) {
                    skipped.push({
                      line: uLn,
                      ruleId: "dsaf/no-outline-none-naked",
                      reason: `arbitrary descendant/child outline removal (${rawTokStr}) — review focus ring manually`,
                    });
                    continue;
                  }
                  const targetPref =
                    remInfo.targetPrefixes.size > 0
                      ? rem.tokStr
                          .split(":")
                          .slice(0, -1)
                          .map((p) => p.replace(/^!+/, ""))
                          .filter((p) => p === "*" || p === "**")
                          .map((p) => `${p}:`)
                          .join("")
                      : "";
                  if (seenTargetPrefs.has(targetPref)) continue;
                  const isFocusRule = /(?<!\\):focus(?:-visible)?(?![a-z-])/i.test(stripNotPseudo(effSel));
                  const allApplyToks = applyMatches.flatMap((am) => am.appText.trim().split(/\s+/).filter(Boolean));
                  const conflictingRingTok = allApplyToks.find((tok) => {
                    const util = getTwUtilityPart(tok).toLowerCase();
                    if (!/^ring(?:-|$)/i.test(util) || /^ring-(?:offset-|inset\b)/i.test(util)) return false;
                    if (!isInvisibleTwFocusUtility(tok)) return false;
                    const info = splitTailwindVariants(tok);
                    const tokHasImp = /(?:^|:)!|!$/.test(tok);
                    const isRingWidthOnly = /^ring-(?:0|\[0(?:px|rem|em)?\])$/i.test(util);
                    if (info.focusKind !== "focus" && info.focusKind !== "focus-visible" && !isFocusRule && !(info.focusKind === null && (tokHasImp || !isRingWidthOnly))) return false;
                    if (info.targetPrefixes.size !== remInfo.targetPrefixes.size || ![...info.targetPrefixes].every((x) => remInfo.targetPrefixes.has(x))) {
                      return false;
                    }
                    const aCond = info.condPrefixes;
                    const bCond = remInfo.condPrefixes;
                    if ((aCond.has("dark") && bCond.has("light")) || (aCond.has("light") && bCond.has("dark"))) return false;
                    for (const c of aCond) {
                      if (bCond.has(`not-${c}`)) return false;
                    }
                    for (const c of bCond) {
                      if (aCond.has(`not-${c}`)) return false;
                    }
                    return true;
                  });
                  if (conflictingRingTok) {
                    skipped.push({
                      line: uLn,
                      ruleId: "dsaf/no-outline-none-naked",
                      reason: `conflicting @apply focus ring suppression (${conflictingRingTok}) — review focus ring manually`,
                    });
                    continue;
                  }
                  seenTargetPrefs.add(targetPref);
                  const insertPos = appBase + rem.tokIdx + rem.tokStr.length;
                  edits.push({
                    start: insertPos,
                    end: insertPos,
                    replacement: ` ${targetPref}focus-visible:ring-2 ${targetPref}focus-visible:ring-offset-2`,
                    ruleId: "dsaf/no-outline-none-naked",
                    line: uLn,
                    summary: `Pair @apply ${rawTokStr} with ${targetPref}focus-visible:ring-2 ${targetPref}focus-visible:ring-offset-2`,
                  });
                }
              }
            }
          }
        }
      }
    }

    if (outLines.size > 0) {
      const fPlan = buildFocusReplacementEdits(slice.text, raw, slice.baseOffset, outLines, cleanComments, externalCssBlocks, {
        blocks: cssBlocks,
        docBlocks: slice.isScoped ? [...allScopedDocBlocks, ...allUnscopedDocBlocks] : allUnscopedDocBlocks,
        checker: isSelectorSafeForOutlineNone,
      });
      edits.push(...fPlan.edits);
      skipped.push(...fPlan.skipped);
    }
  }

  if (!isStyle) {
    const twSpanTransRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?)(${TW_TRANS_ALL_CORE})(!?)(?=$|[\\s;])`, "g");
    const twSpanVwRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?)(${TW_VW_CORE})(!?)(?=$|[\\s;])`, "g");
    const tailwindSpans = (transLines.size > 0 || vwLines.size > 0) ? extractTailwindClassSpans(nonStyleClean, { ...markupOpts, includeAllCvaArgs: true }) : [];
    if (transLines.size > 0) {
      const seenTrans = new Set();
      for (const span of tailwindSpans) {
        const maskedContent = maskCssQuotedStringsPreservingLines(span.content, "_");
        for (const m of maskedContent.matchAll(twSpanTransRe)) {
          const absOff = span.contentStart + m.index;
          if (seenTrans.has(absOff)) continue;
          const ln = offsetToLine(nonStyleClean, absOff);
          if (!transLines.has(ln)) continue;
          seenTrans.add(absOff);
          const rawPref = span.content.slice(m.index, m.index + m[1].length);
          const rawCore = span.content.slice(m.index + m[1].length, m.index + m[1].length + m[2].length);
          const rawSuf = span.content.slice(m.index + m[1].length + m[2].length, m.index + m[0].length);
          if (/^(?:transition-all|transition-\[all\]|\[transition(?:-property)?:all\])$/i.test(rawCore)) {
            edits.push({
              start: absOff,
              end: absOff + m[0].length,
              replacement: `${rawPref}transition-colors${rawSuf}`,
              ruleId: "dsaf/no-transition-all",
              line: ln,
              summary: `Replace Tailwind ${rawPref}${rawCore}${rawSuf} with ${rawPref}transition-colors${rawSuf}`,
            });
          } else {
            skipped.push({
              line: ln,
              ruleId: "dsaf/no-transition-all",
              reason: `arbitrary Tailwind transition (${rawPref}${rawCore}${rawSuf}) — review manually`,
            });
          }
        }
      }
    }

    if (vwLines.size > 0) {
      const seenVw = new Set();
      for (const span of tailwindSpans) {
        const maskedContent = maskCssQuotedStringsPreservingLines(span.content, "_");
        for (const m of maskedContent.matchAll(twSpanVwRe)) {
          const absOff = span.contentStart + m.index;
          if (seenVw.has(absOff)) continue;
          const ln = offsetToLine(nonStyleClean, absOff);
          if (!vwLines.has(ln)) continue;
          seenVw.add(absOff);
          const rawPref = span.content.slice(m.index, m.index + m[1].length);
          const rawCore = span.content.slice(m.index + m[1].length, m.index + m[1].length + m[2].length);
          const rawSuf = span.content.slice(m.index + m[1].length + m[2].length, m.index + m[0].length);
          const stdM = /^((?:min-|max-)?w)-(?:\[100vw\]|screen)$/i.exec(rawCore);
          const arbM = /^\[((?:min-|max-)?(?:width|inline-size)):100vw\]$/i.exec(rawCore);
          if (stdM) {
            edits.push({
              start: absOff,
              end: absOff + m[0].length,
              replacement: `${rawPref}${stdM[1]}-full${rawSuf}`,
              ruleId: "dsaf/no-100vw",
              line: ln,
              summary: `Replace ${rawPref}${rawCore}${rawSuf} with ${rawPref}${stdM[1]}-full${rawSuf}`,
            });
          } else if (arbM) {
            edits.push({
              start: absOff,
              end: absOff + m[0].length,
              replacement: `${rawPref}[${arbM[1]}:100%]${rawSuf}`,
              ruleId: "dsaf/no-100vw",
              line: ln,
              summary: `Replace ${rawPref}${rawCore}${rawSuf} with ${rawPref}[${arbM[1]}:100%]${rawSuf}`,
            });
          } else {
            skipped.push({
              line: ln,
              ruleId: "dsaf/no-100vw",
              reason: `arbitrary Tailwind 100vw utility (${rawPref}${rawCore}${rawSuf}) — review manually`,
            });
          }
        }
      }
    }

    if (outLines.size > 0) {
      for (const attr of extractTailwindClassSpans(nonStyleClean, { ...markupOpts, includeAllCvaArgs: true })) {
        const maskedContent = maskCssQuotedStringsPreservingLines(attr.content, "_");
        const maskedSiblings = maskCssQuotedStringsPreservingLines(attr.siblingClasses || "", "_");
        const twOut = analyzeTailwindOutline(maskedContent, maskedSiblings);
        const twUncovered = twOut.uncovered || (twOut.firstRemoval ? [twOut.firstRemoval] : []);
        if (!twOut.hasRemoval || !twOut.naked || twUncovered.length === 0) continue;
        const firstLn = offsetToLine(nonStyleClean, attr.contentStart + twOut.firstRemoval.tokIdx);
        const anyInOutLines = twUncovered.some((u) => outLines.has(offsetToLine(nonStyleClean, attr.contentStart + u.tokIdx))) || outLines.has(firstLn);
        if (!anyInOutLines) continue;
        const seenTargetPrefs = new Set();
        for (const rem of twUncovered) {
          const { tokStr, tokIdx } = rem;
          const origTokStr = attr.content.slice(tokIdx, tokIdx + tokStr.length);
          const start = attr.contentStart + tokIdx;
          const ln = offsetToLine(nonStyleClean, start);
          const remInfo = splitTailwindVariants(tokStr);
          if (remInfo.targetPrefixes.size > 0 && [...remInfo.targetPrefixes].some((tp) => tp.startsWith("["))) {
            skipped.push({
              line: ln,
              ruleId: "dsaf/no-outline-none-naked",
              reason: `arbitrary descendant/child outline removal (${origTokStr}) — review focus ring manually`,
            });
            continue;
          }
          const targetPref =
            remInfo.targetPrefixes.size > 0
              ? tokStr
                  .split(":")
                  .slice(0, -1)
                  .map((p) => p.replace(/^!+/, ""))
                  .filter((p) => p === "*" || p === "**")
                  .map((p) => `${p}:`)
                  .join("")
              : "";
          if (seenTargetPrefs.has(targetPref)) continue;
          const allAttrToks = `${maskedContent} ${maskedSiblings}`.trim().split(/\s+/).filter(Boolean);
          const conflictingRingTok = allAttrToks.find((tok) => {
            const util = getTwUtilityPart(tok).toLowerCase();
            if (!/^ring(?:-|$)/i.test(util) || /^ring-(?:offset-|inset\b)/i.test(util)) return false;
            if (!isInvisibleTwFocusUtility(tok)) return false;
            const info = splitTailwindVariants(tok);
            const tokHasImp = /(?:^|:)!|!$/.test(tok);
            const isRingWidthOnly = /^ring-(?:0|\[0(?:px|rem|em)?\])$/i.test(util);
            if (info.focusKind !== "focus" && info.focusKind !== "focus-visible" && !(info.focusKind === null && (tokHasImp || !isRingWidthOnly))) return false;
            if (info.targetPrefixes.size !== remInfo.targetPrefixes.size || ![...info.targetPrefixes].every((x) => remInfo.targetPrefixes.has(x))) {
              return false;
            }
            const aCond = info.condPrefixes;
            const bCond = remInfo.condPrefixes;
            if ((aCond.has("dark") && bCond.has("light")) || (aCond.has("light") && bCond.has("dark"))) return false;
            for (const c of aCond) {
              if (bCond.has(`not-${c}`)) return false;
            }
            for (const c of bCond) {
              if (aCond.has(`not-${c}`)) return false;
            }
            return true;
          });
          if (conflictingRingTok) {
            skipped.push({
              line: ln,
              ruleId: "dsaf/no-outline-none-naked",
              reason: `conflicting focus ring suppression (${conflictingRingTok}) — review focus ring manually`,
            });
            continue;
          }
          seenTargetPrefs.add(targetPref);
          edits.push({
            start,
            end: start + origTokStr.length,
            replacement: `${origTokStr} ${targetPref}focus-visible:ring-2 ${targetPref}focus-visible:ring-offset-2`,
            ruleId: "dsaf/no-outline-none-naked",
            line: ln,
            summary: `Pair Tailwind ${origTokStr} with ${targetPref}focus-visible:ring-2 ${targetPref}focus-visible:ring-offset-2`,
          });
        }
      }
    }

    if (videoLines.size > 0) {
      const isJsxFile = ext === ".tsx" || ext === ".jsx";
      const playsAttr = isJsxFile ? "playsInline" : "playsinline";
      for (const vt of extractVideoTags(nonStyleClean, { ...markupOpts, caseSensitive: ext !== ".html" })) {
        const ln = offsetToLine(nonStyleClean, vt.start);
        if (!videoLines.has(ln)) continue;
        if (isUnmutedAutoplayVideo(vt.attrs)) {
          const cleanAttrs = stripQuotedAttrValues(vt.attrs);
          if (/(?:^|\s)(?:(?:(?:v-bind|bind)?:)?muted\s*=\s*\{|(?:v-bind|bind)?:muted(?=\s|=|\/|$)|\{\s*muted\s*\})/i.test(cleanAttrs)) {
            skipped.push({ line: ln, ruleId: "dsaf/no-autoplay-unmuted", reason: "reactive muted expression — update manually" });
            continue;
          }
          const insertAt = vt.start + "<video".length;
          const extra = /(?:^|\s)(?:(?:(?:v-bind|bind)?:)?playsinline(?=\s|=|\/|$)|\{\s*playsinline\s*\})/i.test(cleanAttrs)
            ? " muted"
            : ` muted ${playsAttr}`;
          edits.push({
            start: insertAt,
            end: insertAt,
            replacement: extra,
            ruleId: "dsaf/no-autoplay-unmuted",
            line: ln,
            summary: extra === " muted" ? "Add muted to autoplaying <video>" : `Add muted ${playsAttr} to autoplaying <video>`,
          });
        }
      }
    }
  }

  const patchedCounts = new Map();
  for (const e of edits) {
    const key = `${e.ruleId}:${e.line}`;
    const weight = typeof e.findingCount === "number" ? e.findingCount : 1;
    if (weight > 0) {
      patchedCounts.set(key, (patchedCounts.get(key) || 0) + weight);
    }
  }
  const skippedCounts = new Map();
  for (const s of skipped) {
    const key = `${s.ruleId}:${s.line}`;
    skippedCounts.set(key, (skippedCounts.get(key) || 0) + 1);
  }
  const findingCounts = new Map();
  for (const f of wantedFindings) {
    const key = `${f.ruleId}:${f.line}`;
    findingCounts.set(key, (findingCounts.get(key) || 0) + 1);
  }
  for (const [key, totalCount] of findingCounts.entries()) {
    const covered = (patchedCounts.get(key) || 0) + (skippedCounts.get(key) || 0);
    if (totalCount > covered) {
      const f = wantedFindings.find((item) => `${item.ruleId}:${item.line}` === key);
      for (let extra = 0; extra < totalCount - covered; extra++) {
        skipped.push({
          ruleId: f.ruleId,
          line: f.line,
          reason: "requires manual remediation (inline style, CSS-in-JS, or non-autofixable pattern)",
        });
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
  const rootContexts = options.ignoreProtected ? [] : findRulesContexts(startDir);
  const dirRulesCache = new Map();
  const getRulesContextsForDir = (dir) => {
    if (dirRulesCache.has(dir)) return dirRulesCache.get(dir);
    const ctxs = findRulesContexts(dir);
    dirRulesCache.set(dir, ctxs);
    return ctxs;
  };
  const normalizedRules = [];
  if (Array.isArray(options.rules)) {
    for (const r of options.rules) {
      const rawR = String(r ?? "").trim().toLowerCase();
      if (!rawR) {
        throw new Error(`Invalid --rule '${r}'. Expected one of: ${[...ALLOWED_FIXED_RULES].join(", ")}`);
      }
      const norm = rawR.includes("/") ? rawR : `dsaf/${rawR}`;
      if (!ALLOWED_FIXED_RULES.has(norm)) {
        throw new Error(`Unknown --rule '${r}'. Expected one of: ${[...ALLOWED_FIXED_RULES].join(", ")}`);
      }
      normalizedRules.push(norm);
    }
  }
  const ruleFilter = normalizedRules.length > 0 ? new Set(normalizedRules) : null;
  let maxFiles = Infinity;
  if (options.maxFiles !== undefined) {
    if (typeof options.maxFiles !== "number" || (options.maxFiles !== Infinity && (!Number.isInteger(options.maxFiles) || options.maxFiles < 0))) {
      throw new Error(`Invalid maxFiles budget '${options.maxFiles}'. Expected a non-negative integer.`);
    }
    maxFiles = options.maxFiles;
  }

  const externalCssBlocks = options.dsCss === false ? [] : discoverExternalDsCss(startDir, options.dsCss ?? []);
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

  const targetIsDir = existsSync(absTarget) && statSync(absTarget).isDirectory();
  const rootCheckBase = targetIsDir ? absTarget : dirname(absTarget);

  for (const [relOrPath, findings] of findingsByFile.entries()) {
    const absFile = absByRel.get(relOrPath) || resolve(relOrPath);
    let lst = null;
    try {
      lst = lstatSync(absFile);
    } catch {
      continue;
    }
    if (!existsSync(absFile) || !statSync(absFile).isFile()) continue;
    const realFile = canonPathSimple(absFile);
    const escapesTargetRoot = targetIsDir && !isWithinRootDir(rootCheckBase, realFile);
    if (lst.isSymbolicLink() || realFile !== resolve(canonPathSimple(dirname(absFile)), basename(absFile))) {
      // Fall through to detailed symlink checks below when a symlink is involved (either leaf or ancestor)
    }
    const checkProtect = (cand) =>
      !options.ignoreProtected &&
      [...rootContexts, ...getRulesContextsForDir(dirname(cand))].some((ctx) => isProtectedPath(cand, ctx));
    const isProtected = checkProtect(absFile) || checkProtect(realFile);
    if (isProtected || escapesTargetRoot || lst.isSymbolicLink()) {
      const reason = isProtected
        ? "protectedFiles match in .dsaf/rules.json"
        : escapesTargetRoot
        ? "symlink target escapes target root"
        : "refusing to modify file via symlink";
      protectedSkipped.push({ file: relOrPath, findingsCount: findings.length, reason });
      continue;
    }
    if (targetIsDir && !isWithinRootDir(absTarget, absFile)) {
      protectedSkipped.push({ file: relOrPath, findingsCount: findings.length, reason: "path escapes target root" });
      continue;
    }
    const plan = buildFileFixPlan(absFile, relOrPath, findings, ruleFilter, externalCssBlocks);
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
  const pathExistsAnyType = (p) => {
    try {
      lstatSync(p);
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  };
  for (const fp of plan.files) {
    if (lstatSync(fp.file).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlinked file: ${fp.file}`);
    }
    if (options.backup) {
      let bakPath = `${fp.file}.dsaf.bak`;
      if (pathExistsAnyType(bakPath)) {
        const stamp = Date.now();
        let n = 0;
        do {
          bakPath = `${fp.file}.dsaf.${stamp}${n > 0 ? `-${n}` : ""}.bak`;
          n++;
        } while (pathExistsAnyType(bakPath));
      }
      writeFileSync(bakPath, readFileSync(fp.file), { flag: "wx" });
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
      JSON.stringify({ protectedFiles: ["src/protected.css"] }),
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

    // 3. Round 1 regressions: nested CSS outline, :focus-within/:is() untouched, leading comment comma preserved,
    // transition: all !important valid, --rule bare prefix, TSX <video> playsInline, --max-files 0, deep protected path
    const regFix = join(scratch, "reg-fix");
    mkdirSync(join(regFix, "a/b/c/d/e/f/tokens"), { recursive: true });
    mkdirSync(join(regFix, ".dsaf"), { recursive: true });
    writeFileSync(
      join(regFix, ".dsaf/rules.json"),
      JSON.stringify({ protectedFiles: ["**/tokens/*.css"] })
    );
    const tokRoot = join(regFix, "tokens/base.css");
    mkdirSync(dirname(tokRoot), { recursive: true });
    writeFileSync(tokRoot, ".tok { transition: all 200ms; }\n");
    const nestedFixCss = join(regFix, "a/b/c/d/e/f/nested.css");
    writeFileSync(
      nestedFixCss,
      [
        ".btn:focus-visible {",
        "  & .icon { color: #111; }",
        "  outline: none;",
        "}",
        "/* Primary, secondary */",
        ".act:focus { outline: none; }",
        ".keep:focus-within { outline: none; }",
        ":is(a, button):focus { outline: none; }",
        ".imp { transition: all 200ms ease !important; }",
      ].join("\n")
    );
    const tsxVid = join(regFix, "a/b/c/d/e/f/Vid.tsx");
    writeFileSync(tsxVid, `export function V(){ return <video autoPlay onEnded={() => ok()} src="v.mp4" />; }\n`);
    assert.equal(planFloorFixes(nestedFixCss, { maxFiles: 0 }).filesPlanned, 0, "maxFiles=0 must plan 0 files");
    assert.equal(planFloorFixes(tokRoot).protectedSkipped.length, 1, "**/tokens/*.css must protect root tokens/base.css");
    const partialPlan = planFloorFixes(nestedFixCss, { rules: ["no-100vw"] });
    assert.equal(partialPlan.filesPlanned, 0, "Bare rule IDs without dsaf/ must normalize");
    const regApplied = applyFloorFixes(join(regFix, "a/b/c/d/e/f"), { backup: true });
    const patchedCss = readFileSync(nestedFixCss, "utf8");
    assert.match(patchedCss, /& \.icon \{ color: #111; \}/, "Must preserve nested block");
    assert.match(patchedCss, /\/\* Primary, secondary \*\//, "Must preserve leading comment");
    assert.match(patchedCss, /\.keep:focus-within \{ outline: none; \}/, "Must not corrupt :focus-within");
    assert.match(patchedCss, /:is\(a, button\):focus \{ outline: none; \}/, "Must leave :is() untouched");
    assert.match(patchedCss, /transform 200ms ease !important;/, "!important must appear once at end");
    assert.match(readFileSync(tsxVid, "utf8"), /<video muted playsInline autoPlay onEnded/, "TSX <video> must receive camelCase playsInline");

    // 4. Round 2 regressions: ? wildcard in protectedFiles, !important/comment `;` on :focus-visible,
    // multiline transition + multiline comment preservation, bare focus-visible:ring & transition-all-fast
    const r2Fix = join(scratch, "r2-fix");
    mkdirSync(join(r2Fix, ".dsaf"), { recursive: true });
    mkdirSync(join(r2Fix, "src"), { recursive: true });
    writeFileSync(
      join(r2Fix, ".dsaf/rules.json"),
      JSON.stringify({ protectedFiles: ["?.css", "src/v?.css"] })
    );
    writeFileSync(join(r2Fix, "src/v1.css"), ".prot { transition: all 200ms; }\n");
    const r2Css = join(r2Fix, "src/edge.css");
    writeFileSync(
      r2Css,
      [
        ".imp-fv:focus-visible { outline: none !important }",
        ".cmt-fv:focus-visible { outline: none /* fix; later */ }",
        ".zero-fv:focus-visible { outline: 0px; }",
        ".multi-ln {\n  transition: all\n    200ms ease;\n}",
        ".multi-cmt {\n  transition: all 200ms /* multi\n  line comment */;\n}",
      ].join("\n")
    );
    const r2Tsx = join(r2Fix, "src/Edge.tsx");
    writeFileSync(r2Tsx, `<div className="transition-all-fast outline-none focus-visible:ring" />\n`);
    const r2Applied = applyFloorFixes(r2Fix);
    assert.equal(r2Applied.protectedSkipped.length, 1, "src/v?.css must protect src/v1.css without throwing on ?.css");
    const r2Patched = readFileSync(r2Css, "utf8");
    assert.match(r2Patched, /\.imp-fv:focus-visible \{ outline: 2px solid var\(--focus, currentColor\); outline-offset: 2px; \}/);
    assert.match(r2Patched, /\.cmt-fv:focus-visible \{ outline: 2px solid var\(--focus, currentColor\); outline-offset: 2px; \/\* fix; later \*\/ \}/);
    assert.match(r2Patched, /\.zero-fv:focus-visible \{ outline: 2px solid/);
    assert.match(r2Patched, /\.multi-ln \{\n  transition: all\n    200ms ease;\n\}/, "Multiline transition must stay uncorrupted");
    assert.match(r2Patched, /transform 200ms \/\* multi\n  line comment \*\/;/, "Multiline comment after transition must stay intact");
    assert.equal(readFileSync(r2Tsx, "utf8"), `<div className="transition-all-fast outline-none focus-visible:ring" />\n`, "Unflagged classes must stay untouched");

    // 5. Round 3 regressions: quoted video attrs, \nw-[100vw], multiline/template outline-none, multi outline resets, ::backdrop
    const r3Fix = join(scratch, "r3-fix");
    mkdirSync(join(r3Fix, "src"), { recursive: true });
    const r3Css = join(r3Fix, "src/r3.css");
    writeFileSync(
      r3Css,
      [
        ".multi-fv:focus-visible {",
        "  outline: none;",
        "  outline: 0;",
        "}",
        "dialog::backdrop { outline: none; }",
      ].join("\n")
    );
    const r3Tsx = join(r3Fix, "src/R3.tsx");
    writeFileSync(
      r3Tsx,
      [
        `<video src="/videos/autoplay-hero.mp4"></video>`,
        `<video autoplay poster="/img/muted.jpg" src="a.mp4"></video>`,
        `<div className="\nw-[100vw]\n" />`,
        "<button className={`px-4 outline-none`}>Go</button>",
      ].join("\n")
    );
    const r3Res = applyFloorFixes(r3Fix);
    assert.equal(r3Res.afterFloor, 1, "Only unfixable dialog::backdrop Floor finding should remain");
    assert.equal(r3Res.manualSkipped.length, 1, "dialog::backdrop must be safely skipped");
    const r3CssAfter = readFileSync(r3Css, "utf8");
    assert.doesNotMatch(r3CssAfter, /\.multi-fv[^{]*\{[^}]*outline:\s*(?:none|0)\b/, "No bare outline reset may remain in .multi-fv");
    assert.match(r3CssAfter, /\.multi-fv:focus-visible\s*\{[\s\S]*outline:\s*2px solid/, ".multi-fv must receive visible focus ring");
    assert.doesNotMatch(r3CssAfter, /dialog::backdrop:focus-visible/, "Must not generate invalid ::backdrop:focus-visible selector");
    const r3TsxAfter = readFileSync(r3Tsx, "utf8");
    assert.match(r3TsxAfter, /<video src="\/videos\/autoplay-hero\.mp4">/, "Quoted autoplay filename must remain untouched");
    assert.match(r3TsxAfter, /<video muted playsInline autoplay poster="\/img\/muted\.jpg"/, "Quoted muted filename must still receive muted playsInline");
    assert.match(r3TsxAfter, /\bw-full\b/, "w-[100vw] after leading newline must fix to w-full");
    assert.match(r3TsxAfter, /outline-none focus-visible:ring-2/, "Template className outline-none must receive ring");

    // 5. Round 4 regressions: compound outline without semicolon, same-line safe/bad focus split, non-outline :focus body preserved, template/offset TW
    const r4Fix = join(scratch, "r4-fix");
    mkdirSync(join(r4Fix, "src"), { recursive: true });
    const r4Css = join(r4Fix, "src/r4.css");
    const r4Tsx = join(r4Fix, "src/R4.tsx");
    writeFileSync(
      r4Css,
      [
        ".r4-no-semi:focus-visible { outline: 0 solid var(--ring) }",
        "#main-content:focus { outline: none; } .r4-bad:focus { outline: none; }",
        ".r4-card:focus { background: var(--focus-bg); outline: none; }",
      ].join("\n")
    );
    writeFileSync(
      r4Tsx,
      [
        '<button className={`px-4 ${active ? "bg-blue" : ""} outline-none focus-visible:ring-offset-2`}>Go</button>',
        "<div className=\"!transition-all !w-[100vw]\" />",
      ].join("\n")
    );
    const r4Res = applyFloorFixes(r4Fix);
    assert.equal(r4Res.afterFloor, 0, "All Round 4 CSS and TSX Floor issues must fix cleanly to 0");
    assert.equal(r4Res.manualSkipped.length, 0);
    const r4CssAfter = readFileSync(r4Css, "utf8");
    assert.doesNotMatch(r4CssAfter, /var\(--ring\)/, "Compound outline without semicolon must not leave trailing var(--ring)");
    assert.match(r4CssAfter, /#main-content:focus\s*\{\s*outline:\s*none;\s*\}/, "Safe #main-content:focus on same line must remain untouched");
    assert.match(r4CssAfter, /\.r4-bad:focus:not\(:focus-visible\)/, "Flagged .r4-bad:focus on same line must scope safely");
    assert.match(r4CssAfter, /\.r4-card:focus\s*\{\s*background:\s*var\(--focus-bg\)/, "Non-outline :focus declaration must preserve :focus selector");
    assert.match(r4CssAfter, /\.r4-card:focus-visible\s*\{[\s\S]*outline:\s*2px solid/, ".r4-card must gain :focus-visible outline rule");
    const r4TsxAfter = readFileSync(r4Tsx, "utf8");
    assert.match(r4TsxAfter, /!transition-colors/, "!transition-all must fix to !transition-colors");
    assert.match(r4TsxAfter, /!w-full/, "!w-[100vw] must fix to !w-full");

    // 6. Round 5 regressions: @supports/@media untouched, @apply fixed, !important skipped cleanly on base selector,
    // trailing ! tailwind & cn() fixed, monorepo nested protectedFiles honored
    const r5Fix = join(scratch, "r5-fix");
    mkdirSync(join(r5Fix, "packages/design/.dsaf"), { recursive: true });
    mkdirSync(join(r5Fix, "packages/design/src"), { recursive: true });
    mkdirSync(join(r5Fix, "src"), { recursive: true });
    writeFileSync(
      join(r5Fix, "packages/design/.dsaf/rules.json"),
      JSON.stringify({ protectedFiles: ["src/tokens.css"] })
    );
    const r5MonoProtected = join(r5Fix, "packages/design/src/tokens.css");
    writeFileSync(r5MonoProtected, ".mono-prot { transition: all 200ms; }\n");
    const r5Css = join(r5Fix, "src/r5.css");
    writeFileSync(
      r5Css,
      [
        "@supports (transition: all 1s) { .sup-a { transition: all 200ms; } }",
        "@media (min-width: 100vw) { .hero { width: 100vw; } }",
        ".apply-btn { @apply transition-all w-[100vw] outline-none; }",
        ".imp-base { outline: none !important; }",
      ].join("\n")
    );
    const r5Tsx = join(r5Fix, "src/R5.tsx");
    writeFileSync(
      r5Tsx,
      [
        '<button className="outline-none!">Bang</button>',
        '<button className={cn("px-4 outline-none", ok && "bg-blue-500")}>Cn</button>',
      ].join("\n")
    );
    const r5Res = applyFloorFixes(r5Fix);
    assert.equal(r5Res.protectedSkipped.length, 1, "Nested package .dsaf/rules.json must protect packages/design/src/tokens.css");
    assert.equal(readFileSync(r5MonoProtected, "utf8"), ".mono-prot { transition: all 200ms; }\n");
    assert.equal(r5Res.manualSkipped.length, 1, "!important on base .imp-base must be skipped manually");
    assert.equal(r5Res.afterFloor, 2, "Only protected tokens.css and manual .imp-base may remain");
    const r5CssAfter = readFileSync(r5Css, "utf8");
    assert.match(r5CssAfter, /^@supports \(transition: all 1s\) \{ \.sup-a \{ transition: color 200ms,/m);
    assert.match(r5CssAfter, /^@media \(min-width: 100vw\) \{ \.hero \{ width: 100%; \} \}/m);
    assert.match(r5CssAfter, /\.apply-btn \{ @apply transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2; \}/);
    const r5TsxAfter = readFileSync(r5Tsx, "utf8");
    assert.match(r5TsxAfter, /className="outline-none! focus-visible:ring-2 focus-visible:ring-offset-2"/);
    assert.match(r5TsxAfter, /cn\("px-4 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"/);

    // 7. Round 6 regressions: cubic-bezier transition + ! important, multiline @apply, nested-bracket variant,
    // single-colon :before, multiline no-semi outline, base selector no phantom no-op patch,
    // package .dsaf/rules.json never shadows repo-root protectedFiles
    const r6Fix = join(scratch, "r6-fix");
    mkdirSync(join(r6Fix, ".dsaf"), { recursive: true });
    mkdirSync(join(r6Fix, "packages/ui/.dsaf"), { recursive: true });
    mkdirSync(join(r6Fix, "packages/ui/src"), { recursive: true });
    writeFileSync(join(r6Fix, ".dsaf/rules.json"), JSON.stringify({ protectedFiles: ["packages/ui/src/root-protected.css"] }));
    writeFileSync(join(r6Fix, "packages/ui/.dsaf/rules.json"), JSON.stringify({ protectedFiles: ["src/other.css"] }));
    writeFileSync(join(r6Fix, "packages/ui/src/root-protected.css"), ".rp { transition: all 100ms; }\n");
    const r6Css = join(r6Fix, "packages/ui/src/comp.css");
    writeFileSync(
      r6Css,
      [
        ".cb { transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1) ! important; }",
        ".ml { @apply flex\n  transition-all\n  w-[100vw]; }",
        ".nv { @apply [&[data-state=open]]:transition-all; }",
        ".nosemi:focus {\n  outline: none\n}",
        ".base-btn { outline: none; }",
        ".pseudo:before { outline: none; }",
      ].join("\n")
    );
    const r6Plan = planFloorFixes(r6Fix);
    const compPlan = r6Plan.files.find((f) => f.rel.endsWith("comp.css"));
    assert.ok(compPlan, "comp.css plan must exist");
    const baseBtnPatches = compPlan.patches.filter((p) => p.line === 9);
    assert.equal(baseBtnPatches.length, 1, "Base .base-btn must emit only :focus-visible insertion without phantom selector no-op patch");
    assert.ok(baseBtnPatches[0].summary.startsWith("Insert visible"), "Base .base-btn patch must be :focus-visible rule insertion");
    const r6Applied = applyFloorFixes(r6Fix);
    assert.equal(r6Applied.protectedSkipped.length, 1, "Root .dsaf/rules.json protectedFiles must not be shadowed by package .dsaf/rules.json");
    assert.equal(readFileSync(join(r6Fix, "packages/ui/src/root-protected.css"), "utf8"), ".rp { transition: all 100ms; }\n");
    assert.equal(r6Applied.afterFloor, 2, "Only root-protected.css and manual .pseudo:before may remain");
    const r6After = readFileSync(r6Css, "utf8");
    assert.match(r6After, /cubic-bezier\(0\.4, 0, 0\.2, 1\) !important;/);
    assert.match(r6After, /@apply flex\s+transition-colors\s+w-full;/);
    assert.match(r6After, /@apply \[&\[data-state=open\]\]:transition-colors;/);
    assert.match(r6After, /\.nosemi:focus:not\(:focus-visible\)\s*\{\s*outline: none\s*\}/);
    assert.match(r6After, /\.nosemi:focus-visible\s*\{[\s\S]*outline: 2px solid/);

    // 8. Round 7 regressions: container/named-group @apply variants, sibling @apply focus-visible:ring-2, Vue :muted="false" manual skip
    const r7Fix = join(scratch, "r7-fix");
    mkdirSync(join(r7Fix, "src"), { recursive: true });
    writeFileSync(
      join(r7Fix, "src/comp.css"),
      [
        ".r7-a { @apply @md:transition-all @[600px]:w-[100vw]; }",
        ".r7-b { @apply outline-none; @apply focus-visible:ring-2; }",
      ].join("\n")
    );
    writeFileSync(join(r7Fix, "src/App.vue"), '<template><video autoplay :muted="false" /></template>\n');
    const r7Applied = applyFloorFixes(r7Fix);
    assert.equal(r7Applied.manualSkipped.length, 1, "Vue :muted=\"false\" must be skipped manually instead of inserting duplicate muted");
    assert.equal(r7Applied.afterFloor, 1, "Only manual Vue :muted=\"false\" may remain after fixing @md:/@[600px]:");
    const r7CssAfter = readFileSync(join(r7Fix, "src/comp.css"), "utf8");
    assert.match(r7CssAfter, /\.r7-a \{ @apply @md:transition-colors @\[600px\]:w-full; \}/);
    assert.match(r7CssAfter, /\.r7-b \{ @apply outline-none; @apply focus-visible:ring-2; \}/);

    // 9. Round 8 regressions: Svelte {playsinline}, Vue :playsinline, SCSS #{$dur}, :focus:hover idempotency, quoted data-[state="open"]
    const r8Fix = join(scratch, "r8-fix");
    mkdirSync(join(r8Fix, "src"), { recursive: true });
    writeFileSync(join(r8Fix, "src/V.svelte"), "<video autoplay {playsinline}></video>\n");
    writeFileSync(join(r8Fix, "src/V.vue"), '<template><video autoplay :playsinline="true" /></template>\n');
    writeFileSync(
      join(r8Fix, "src/r8.scss"),
      [
        ".card { transition: all #{$dur} ease; }",
        ".hov:focus:hover { outline: none; }",
        '.q { @apply data-[state="open"]:transition-all; }',
        ".app-pair:focus-visible { @apply outline-2 outline-none; }",
      ].join("\n") + "\n"
    );
    const r8Applied1 = applyFloorFixes(r8Fix);
    assert.equal(r8Applied1.afterFloor, 0, "All Round 8 Floor violations must auto-fix cleanly");
    const svelteAfter = readFileSync(join(r8Fix, "src/V.svelte"), "utf8");
    const vueAfter = readFileSync(join(r8Fix, "src/V.vue"), "utf8");
    assert.equal(svelteAfter.match(/playsinline/gi).length, 1, "Svelte {playsinline} must not receive duplicate playsinline");
    assert.equal(vueAfter.match(/playsinline/gi).length, 1, "Vue :playsinline=\"true\" must not receive duplicate playsinline");
    const r8ScssAfter = readFileSync(join(r8Fix, "src/r8.scss"), "utf8");
    assert.match(r8ScssAfter, /\.card \{ transition: color #\{\$dur\} ease, background-color #\{\$dur\} ease,/);
    assert.match(r8ScssAfter, /\.hov:focus-visible:hover \{/);
    assert.match(r8ScssAfter, /@apply data-\[state="open"\]:transition-colors;/);
    assert.match(r8ScssAfter, /@apply outline-2 outline-none focus-visible:ring-2 focus-visible:ring-offset-2;/);
    const r8Applied2 = applyFloorFixes(r8Fix);
    assert.equal(r8Applied2.patchesApplied, 0, "fix-floor must be idempotent after Round 8 fixes");

    // 10. Round 9 regressions (R9-A2-09, R9-A2-14): :not(:focus-visible) comma safety & reverse-cascade preservation without duplicate rule
    const r9Fix = join(scratch, "r9-fix");
    mkdirSync(join(r9Fix, "src"), { recursive: true });
    writeFileSync(
      join(r9Fix, "src/r9.css"),
      [
        ".btn:focus-visible { outline: 2px solid var(--ring); }",
        ".btn:focus { outline: none; }",
        ".a:not(:focus-visible), .b:focus { outline: none; }",
      ].join("\n") + "\n"
    );
    const r9Res = applyFloorFixes(r9Fix);
    assert.equal(r9Res.afterFloor, 0);
    const r9CssAfter = readFileSync(join(r9Fix, "src/r9.css"), "utf8");
    assert.equal((r9CssAfter.match(/\.btn:focus-visible\b/g) || []).length, 1, "Existing custom .btn:focus-visible rule must not be duplicated");
    assert.match(r9CssAfter, /\.btn:focus:not\(:focus-visible\) \{ outline: none; \}/);
    assert.match(r9CssAfter, /\.a:not\(:focus-visible\), \.b:focus:not\(:focus-visible\) \{ outline: none; \}/);
    assert.match(r9CssAfter, /\.b:focus-visible \{ outline: 2px solid/);

    // 11. Round 10 regressions (R10-A2-07, R10-A2-12, R10-A2-18): inline-comment selector skip, mixed comma per-branch fv dedupe, multiline !important outline
    const r10Fix = join(scratch, "r10-fix");
    mkdirSync(join(r10Fix, "src"), { recursive: true });
    writeFileSync(
      join(r10Fix, "src/r10.css"),
      [
        ".a:focus-visible { outline: 2px solid var(--ring); }",
        ".a:focus, .b:focus { outline: none; }",
        ".c:focus {",
        "  outline: 2px solid",
        "    transparent !important;",
        "}",
      ].join("\n") + "\n"
    );
    writeFileSync(join(r10Fix, "src/comment-sel.css"), ".btn/* primary */:focus { outline: none; }\n");
    const r10Res = applyFloorFixes(r10Fix);
    assert.equal(r10Res.manualSkipped.length, 1, "Inline comment inside compound focus selector must be skipped safely");
    assert.equal(r10Res.afterFloor, 1, "Only manual comment-sel.css Floor defect may remain");
    const r10CssAfter = readFileSync(join(r10Fix, "src/r10.css"), "utf8");
    assert.equal((r10CssAfter.match(/\.a:focus-visible/g) || []).length, 1, "Existing .a:focus-visible must not be duplicated when inserting .b:focus-visible");
    assert.match(r10CssAfter, /\.b:focus-visible \{ outline: 2px solid/);
    assert.match(r10CssAfter, /\.c:focus:not\(:focus-visible\)/, "Multiline !important outline shorthand must be scoped instead of skipped");
    assert.match(r10CssAfter, /\.c:focus-visible \{ outline: 2px solid/);
    assert.equal(
      readFileSync(join(r10Fix, "src/comment-sel.css"), "utf8"),
      ".btn/* primary */:focus { outline: none; }\n",
      "Selector containing inline comment must not be corrupted into descendant combinator"
    );

    // Round 11 regressions (R11-A2-03, R11-A2-12, R11-A2-13, R11-A2-21):
    const r11Fix = join(scratch, "r11-fix");
    mkdirSync(join(r11Fix, "src"), { recursive: true });
    writeFileSync(join(r11Fix, "src/child.tsx"), "<div className=\"*:outline-none\"><button>Hi</button></div>\n");
    writeFileSync(join(r11Fix, "src/arb.tsx"), "<div className=\"[&_button]:outline-none\"><button>Hi</button></div>\n");
    writeFileSync(
      join(r11Fix, "src/app.css"),
      [
        ".wrap { @apply *:outline-none; }",
        ".btn:focus-visible { @apply outline-none outline-2; }",
        ".card {",
        "  .btn:focus-visible { outline: 2px solid var(--ring); }",
        "  .btn:focus { outline: none; }",
        "}",
        ".box > button:focus { outline: none; }",
        ".box>button:focus-visible { outline: 2px solid var(--ring); }",
      ].join("\n") + "\n"
    );
    const r11Plan = planFloorFixes(r11Fix);
    assert.equal(r11Plan.manualSkipped.some((sk) => /arbitrary descendant/i.test(sk.reason)), true, "Arbitrary [&_button]:outline-none must be skipped for manual review");
    const r11Applied = applyFloorFixes(r11Fix, { dryRun: false });
    assert.match(readFileSync(join(r11Fix, "src/child.tsx"), "utf8"), /\*:focus-visible:ring-2 \*:focus-visible:ring-offset-2/);
    assert.match(readFileSync(join(r11Fix, "src/app.css"), "utf8"), /@apply \*:outline-none \*:focus-visible:ring-2 \*:focus-visible:ring-offset-2;/);
    assert.equal((readFileSync(join(r11Fix, "src/app.css"), "utf8").match(/\.btn:focus-visible/g) || []).length, 2, "Nested .card .btn:focus-visible must not be duplicated");
    assert.equal(r11Applied.afterFloor, 1, "Only manual-skip [&_button]:outline-none remains in Floor after applying safe fixes");
    assert.equal(planFloorFixes(r11Fix).patchesPlanned, 0, "Zero remaining auto-fix patches after apply");

    // Round 12 regressions (R12-A2-01, R12-A2-05, R12-A2-09, R12-A2-10):
    const r12Fix = join(scratch, "r12-fix");
    mkdirSync(join(r12Fix, "src"), { recursive: true });
    writeFileSync(join(r12Fix, "src/notfv.css"), ".nav:not(:focus-visible) a { outline: none; }\nmain:focus button { outline: none; }\n");
    writeFileSync(
      join(r12Fix, "src/darkmedia.css"),
      ".btn:focus { outline: none; }\n@media (prefers-color-scheme: dark) {\n  .btn:focus-visible { outline: 2px solid #93c5fd; }\n}\n"
    );
    writeFileSync(join(r12Fix, "src/multi.tsx"), '<div className="*:outline-none outline-none"><button>Hi</button></div>\n');
    writeFileSync(join(r12Fix, "src/mix.tsx"), '<div className="[&_button]:outline-none outline-none"><button>Hi</button></div>\n');
    writeFileSync(join(r12Fix, "src/vid.svelte"), '<video autoplay bind:muted src="clip.mp4"></video>\n');
    const r12Pass1 = applyFloorFixes(r12Fix, { dryRun: false });
    const notfvAfter = readFileSync(join(r12Fix, "src/notfv.css"), "utf8");
    assert.doesNotMatch(notfvAfter, /\.nav:not\(:focus-visible\) a\s*\{[^}]*2px solid/);
    assert.match(notfvAfter, /\.nav:not\(:focus-visible\) a:focus-visible \{ outline: 2px solid/);
    assert.match(notfvAfter, /main:focus:not\(:focus-visible\) button \{ outline: none; \}/);
    assert.match(notfvAfter, /main:focus-visible button \{ outline: 2px solid/);
    const darkAfter = readFileSync(join(r12Fix, "src/darkmedia.css"), "utf8");
    assert.match(darkAfter, /\.btn:focus:not\(:focus-visible\)/);
    assert.equal((darkAfter.match(/\.btn:focus-visible/g) || []).length, 2, "Conditional @media :focus-visible must not suppress unconditional fallback insertion");
    const r12Pass2 = applyFloorFixes(r12Fix, { dryRun: false });
    assert.equal(r12Pass2.patchesApplied, 0, "Second pass of fix-floor must be 100% idempotent");
    assert.equal(r12Pass1.afterFloor, 1, "Only manual [&_button]:outline-none remains in Floor; multi.tsx and notfv.css converge in 1 pass");
    assert.equal(readFileSync(join(r12Fix, "src/vid.svelte"), "utf8"), '<video autoplay bind:muted src="clip.mp4"></video>\n');

    // Round 13 regressions (R13-A2-01, R13-A2-13, R13-A2-14):
    const r13Fix = join(scratch, "r13-fix");
    mkdirSync(join(r13Fix, "src"), { recursive: true });
    writeFileSync(
      join(r13Fix, "src/Safe.tsx"),
      [
        'export const B = ({ v }: { v: string }) => <button className={v === "outline-none" ? "px-4" : "py-2"}>Go</button>;',
        'export const D = ({ v }: { v: string }) => <div data-class="transition-all" data-testid="w-[100vw]">{v === "outline-none" && "x"}</div>;',
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r13Fix, "src/Helper.tsx"),
      'export const Helper = () => <div className={cn("px-4", "transition-all w-[100vw]")} />;\n'
    );
    writeFileSync(
      join(r13Fix, "src/Mixed.css"),
      ".other:focus-visible { outline-color: var(--ring); }\n.btn:focus, .other { outline: none; }\n"
    );
    const r13Applied = applyFloorFixes(r13Fix, { dryRun: false });
    assert.equal(r13Applied.afterFloor, 0, "Mixed comma rule with incomplete :focus-visible outline-color must converge to 0 in 1 pass");
    assert.equal(
      readFileSync(join(r13Fix, "src/Safe.tsx"), "utf8"),
      [
        'export const B = ({ v }: { v: string }) => <button className={v === "outline-none" ? "px-4" : "py-2"}>Go</button>;',
        'export const D = ({ v }: { v: string }) => <div data-class="transition-all" data-testid="w-[100vw]">{v === "outline-none" && "x"}</div>;',
      ].join("\n") + "\n",
      "Ternary/&& condition operands and data-* attributes must remain 100% untouched"
    );
    assert.match(readFileSync(join(r13Fix, "src/Helper.tsx"), "utf8"), /transition-colors w-full/);
    assert.match(readFileSync(join(r13Fix, "src/Mixed.css"), "utf8"), /\.btn:focus-visible,\s*\.other:focus-visible/);

    // Round 14 regressions (R14-A2-02, R14-A2-03, R14-A2-05, R14-A2-11):
    const r14Fix = join(scratch, "r14-fix");
    mkdirSync(join(r14Fix, "src"), { recursive: true });
    writeFileSync(
      join(r14Fix, "src/SafeObj.tsx"),
      [
        'export const O = ({ variant, mode, size }: any) => (',
        '  <button className={clsx({ "px-4": variant === "outline-none", "py-2": mode === "transition-all", "w-full": size === "w-[100vw]" })} />',
        ');',
      ].join("\n") + "\n"
    );
    writeFileSync(join(r14Fix, "src/Escaped.css"), ".md\\:focus\\:outline-none:focus { outline-style: none; }\n");
    writeFileSync(join(r14Fix, "src/TwTarget.css"), ".card { @apply *:outline-none focus-visible:ring-2; }\n");
    writeFileSync(
      join(r14Fix, "src/TwChildSk.css"),
      ".card { @apply [&_button]:outline-none; }\n.card:focus-visible { outline: 2px solid var(--ring); }\n"
    );
    writeFileSync(
      join(r14Fix, "src/DoubleFv.css"),
      ".btn:focus { outline: none; }\n.btn:focus:focus-visible { outline: 2px solid var(--ring); }\n"
    );
    const r14Applied = applyFloorFixes(r14Fix, { dryRun: false });
    assert.match(readFileSync(join(r14Fix, "src/SafeObj.tsx"), "utf8"), /variant === "outline-none"/, "Object map comparisons must remain untouched");
    assert.match(readFileSync(join(r14Fix, "src/Escaped.css"), "utf8"), /\.md\\:focus\\:outline-none:focus:not\(:focus-visible\)/);
    assert.match(readFileSync(join(r14Fix, "src/Escaped.css"), "utf8"), /\.md\\:focus\\:outline-none:focus-visible \{ outline: 2px solid/);
    assert.match(readFileSync(join(r14Fix, "src/TwTarget.css"), "utf8"), /@apply \*:outline-none \*:focus-visible:ring-2 \*:focus-visible:ring-offset-2\b/);
    assert.equal(readFileSync(join(r14Fix, "src/DoubleFv.css"), "utf8"), ".btn:focus { outline: none; }\n.btn:focus:focus-visible { outline: 2px solid var(--ring); }\n");
    assert.ok(
      r14Applied.manualSkipped.some((s) => s.file === "src/TwChildSk.css" && /\[&_button\]:outline-none/.test(s.reason)),
      "Arbitrary [&_button]:outline-none under parent :focus-visible must be reported in manualSkipped"
    );

    // Round 15 regression (R15-A2-04): outline: revert on :focus-visible must leave zero fixes and untouched file
    const r15RevertDir = join(scratch, "r15-revert");
    mkdirSync(join(r15RevertDir, "src"), { recursive: true });
    const revertCss = ".btn { outline: none; }\n.btn:focus-visible { outline: revert; }\n";
    writeFileSync(join(r15RevertDir, "src/Revert.css"), revertCss);
    const r15Plan = planFloorFixes(r15RevertDir);
    assert.equal(r15Plan.patchesPlanned, 0, "outline: revert on :focus-visible must produce 0 planned fixes");
    applyFloorFixes(r15RevertDir, { dryRun: false });
    assert.equal(readFileSync(join(r15RevertDir, "src/Revert.css"), "utf8"), revertCss, "outline: revert file must remain untouched");

    // Round 16 regressions (R16-A2-04, R16-A2-06, R16-A2-11, R16-A2-14):
    const r16SafeDir = join(scratch, "r16-safe");
    mkdirSync(join(r16SafeDir, "src"), { recursive: true });
    writeFileSync(join(r16SafeDir, "src/Hero.tsx"), 'export const Hero = () => <Video autoPlay src="/hero.mp4" />;\n');
    writeFileSync(
      join(r16SafeDir, "src/Btn.tsx"),
      'export const Btn = () => <button className="before:content-[\'transition-all\'] after:content-[\'w-[100vw]\'] focus-visible:outline-none focus:ring-2">Go</button>;\n'
    );
    writeFileSync(
      join(r16SafeDir, "src/Mix.css"),
      '.btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--ring) 80%, rgba(0, 0, 0, 0)); }\n'
    );
    assert.equal(planFloorFixes(r16SafeDir).patchesPlanned, 0, "<Video />, arbitrary content-[...], focus:ring-2, and color-mix() must not produce edits");

    // Round 17 regressions (R17-A2-F1, R17-A2-F2):
    // F1: content: "transition: all 200ms; width: 100vw; outline: none;" must never be rewritten
    const r17StrDir = join(scratch, "r17-string-literal");
    mkdirSync(join(r17StrDir, "src"), { recursive: true });
    writeFileSync(join(r17StrDir, "src/badge.css"), '.badge::after { content: "transition: all 200ms; width: 100vw; outline: none;"; }\n');
    assert.equal(planFloorFixes(r17StrDir).patchesPlanned, 0, "F1 CSS quoted content strings must never be rewritten");

    // F2: multi-branch rule .a, .b { outline: none; } when .a:focus-visible already exists must only emit .b:focus-visible
    const r17FvDir = join(scratch, "r17-fv-dup");
    mkdirSync(join(r17FvDir, "src"), { recursive: true });
    writeFileSync(
      join(r17FvDir, "src/focus.css"),
      ".a:focus-visible { outline: 2px solid var(--ring); }\n.a, .b { outline: none; }\n"
    );
    const r17FvPlan = planFloorFixes(r17FvDir);
    assert.equal(r17FvPlan.patchesPlanned, 1);
    const r17PatchedCss = r17FvPlan.files[0].newContent;
    assert.match(r17PatchedCss, /\.a:focus-visible \{ outline: 2px solid var\(--ring\); \}/);
    assert.doesNotMatch(r17PatchedCss, /\.a:focus-visible, \.b:focus-visible/);
    assert.match(r17PatchedCss, /\.b:focus-visible \{ outline: 2px solid/);

    // Round 18 regressions (R18-A2-07, R18-A2-19): reverse-cascade :focus with sibling declarations must patch; dsCss: "" must reject
    const r18RevDir = join(scratch, "r18-rev-cascade");
    mkdirSync(join(r18RevDir, "src"), { recursive: true });
    writeFileSync(
      join(r18RevDir, "src/focus.css"),
      ".a:focus-visible { outline: 2px solid blue; }\n.a:focus { background: #eee; outline: none; }\n"
    );
    const r18RevPlan = planFloorFixes(r18RevDir);
    assert.equal(r18RevPlan.beforeFloor, 1);
    assert.equal(r18RevPlan.patchesPlanned, 1);
    assert.throws(() => planFloorFixes(r18RevDir, { dsCss: "" }), /cannot be empty/);

    // Round 19 regression (R19-A2-07): conflicting Tailwind focus-visible:ring-0 skips duplicate patch cleanly
    const r19Ring0Dir = join(scratch, "r19-ring0");
    mkdirSync(join(r19Ring0Dir, "src"), { recursive: true });
    writeFileSync(join(r19Ring0Dir, "src/Btn.tsx"), 'export const Btn = () => <button className="outline-none focus-visible:ring-0">Go</button>;\n');
    const r19Ring0Plan = planFloorFixes(r19Ring0Dir);
    assert.equal(r19Ring0Plan.patchesPlanned, 0, "Conflicting focus-visible:ring-0 must skip focus-visible:ring-2 patch");
    assert.equal(r19Ring0Plan.manualSkipped.length >= 1, true);
    assert.equal(readFileSync(join(r19Ring0Dir, "src/Btn.tsx"), "utf8").includes("focus-visible:ring-2"), false);

    // Round 20 regression (R20-A2-M10): @apply focus-visible:ring-0 and focus-visible:ring-[color:transparent] skip conflicting patches cleanly
    const r20RingDir = join(scratch, "r20-ring-cancel");
    mkdirSync(join(r20RingDir, "src"), { recursive: true });
    writeFileSync(join(r20RingDir, "src/Btn.tsx"), 'export const Btn = () => <button className="outline-none focus-visible:ring-[color:transparent]">Go</button>;\n');
    writeFileSync(join(r20RingDir, "src/Btn.css"), ".btn { @apply outline-none focus-visible:ring-0; }\n");
    const r20RingPlan = planFloorFixes(r20RingDir);
    assert.equal(r20RingPlan.patchesPlanned, 0);
    assert.equal(r20RingPlan.manualSkipped.length >= 2, true);

    // Round 22 regression (R22-A2-L1): quote- and paren-aware declaration end scan handles ';' inside CSS string values on :focus-visible
    const r22SemiDir = join(scratch, "r22-semi-fv");
    mkdirSync(join(r22SemiDir, "src"), { recursive: true });
    writeFileSync(
      join(r22SemiDir, "src/Fv.css"),
      ".a:focus-visible { outline: 0px solid var(--x, ';'); color: red; }\n"
    );
    const r22SemiPlan = planFloorFixes(r22SemiDir);
    assert.equal(r22SemiPlan.patchesPlanned, 1);
    const r22Patched = r22SemiPlan.files[0].newContent;
    assert.match(r22Patched, /outline: 2px solid var\(--focus, currentColor\); outline-offset: 2px; color: red;/);
    assert.doesNotMatch(r22Patched, /';'\)/);

    const fixSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [fixSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [fixSelfPath, scratch, "--max-files", "abc"], { encoding: "utf8" }).status, 2);

    // Round 23 regressions (#16, #17, #18, #40)
    const r23DocDir = join(scratch, "r23-doc");
    mkdirSync(r23DocDir, { recursive: true });
    const r23DocOrig = "export const Doc = () => (<><button title='Example: class=\"outline-none\"'>Tip</button><p>Avoid class=\"transition-all w-[100vw]\"</p><code>{'<video autoplay src=\"a.mp4\" />'}</code></>);\n";
    writeFileSync(join(r23DocDir, "Doc.tsx"), r23DocOrig);
    writeFileSync(join(r23DocDir, "App.css"), '.a { @apply before:content-["a transition-all b"]; }\n');
    const r23DocApply = applyFloorFixes(r23DocDir, { apply: true });
    assert.equal(r23DocApply.filesModified, 0);
    assert.equal(readFileSync(join(r23DocDir, "Doc.tsx"), "utf8"), r23DocOrig);

    const r23FocusDir = join(scratch, "r23-focus-semi");
    mkdirSync(r23FocusDir, { recursive: true });
    writeFileSync(
      join(r23FocusDir, "Fv.css"),
      ".btn:focus-visible { outline: 2px solid var(--ring); }\n.btn:focus { outline: 0 solid var(--x, ';'); }\n"
    );
    const r23FocusPlan = planFloorFixes(r23FocusDir);
    assert.equal(r23FocusPlan.patchesPlanned, 1);
    const r23Patched = r23FocusPlan.files[0].newContent;
    assert.match(r23Patched, /:focus:not\(:focus-visible\)/);
    assert.equal((r23Patched.match(/:focus-visible\s*\{/g) || []).length, 1);

    for (const badFixCli of [
      ["", "--json"],
      ["--json"],
      ["   "],
      [join(r23DocDir, "App.css"), "--ds-css", ""],
      [join(r23DocDir, "App.css"), "--ds-css", join(r23DocDir, "missing.css")],
      [join(r23DocDir, "App.css"), "--rule", ""],
      [join(r23DocDir, "App.css"), "--rule", "bogus"],
      [join(r23DocDir, "App.css"), "extra", "--json"],
    ]) {
      assert.equal(spawnSync(process.execPath, [fixSelfPath, ...badFixCli], { encoding: "utf8" }).status, 2);
    }

    // Round 24 regressions (A2-H1 quoted Tw strings, A2-H2 basename protectedFiles, A1-M2 invalid protectedFiles, A2-M5 [outline:none])
    const r24FixDir = join(scratch, "r24-fix");
    mkdirSync(join(r24FixDir, ".dsaf"), { recursive: true });
    mkdirSync(join(r24FixDir, "nested/deep"), { recursive: true });
    writeFileSync(join(r24FixDir, ".dsaf/rules.json"), JSON.stringify({ protectedFiles: ["tokens.css"] }));
    const r24ProtTok = join(r24FixDir, "nested/deep/tokens.css");
    writeFileSync(r24ProtTok, ".tok { transition: all 200ms; }\n");
    const r24Cmp = join(r24FixDir, "nested/Cmp.tsx");
    const r24CmpSrc = `<><button className="before:content-['transition-all'] after:content-['outline-none'] px-2">A</button><button className="[outline:none]">B</button></>\n`;
    writeFileSync(r24Cmp, r24CmpSrc);
    const r24FixRes = applyFloorFixes(r24FixDir);
    assert.equal(r24FixRes.protectedSkipped.length, 1, "R24 A2-H2: basename tokens.css must be protected");
    assert.equal(readFileSync(r24ProtTok, "utf8"), ".tok { transition: all 200ms; }\n");
    const r24CmpAfter = readFileSync(r24Cmp, "utf8");
    assert.match(r24CmpAfter, /before:content-\['transition-all'\] after:content-\['outline-none'\]/, "R24 A2-H1: quoted Tailwind content strings must remain untouched");
    assert.match(r24CmpAfter, /\[outline:none\] focus-visible:ring-2 focus-visible:ring-offset-2/, "R24 A2-M5: [outline:none] must be paired cleanly");
    writeFileSync(join(r24FixDir, ".dsaf/rules.json"), JSON.stringify({ protectedFiles: "not-an-array" }));
    assert.throws(() => planFloorFixes(r24FixDir), /protectedFiles must be an array of strings/);

    // Round 25 regressions (A2-H3 bind:muted={false}, A2-H5 <style> in string, A2-M1 Svelte sibling class:focus-visible:ring-2, A4-L1 isDirectCliEntry)
    const r25FixDir = join(scratch, "r25-fix");
    mkdirSync(r25FixDir, { recursive: true });
    writeFileSync(
      join(r25FixDir, "App.svelte"),
      [
        '<script>const ex = "<style>.a { transition: all; }</style>";</script>',
        '<button class="outline-none" class:focus-visible:ring-2={true}>Ok</button>',
        '<video autoplay bind:muted={false} src="a.mp4"></video>',
      ].join("\n") + "\n"
    );
    const r25FixPlan = planFloorFixes(r25FixDir);
    assert.equal(r25FixPlan.filesPlanned, 0, "R25: fake <style>, Svelte sibling class:focus-visible:ring-2={true}, and bind:muted={false} skip must leave 0 auto-patches");
    assert.equal(
      r25FixPlan.manualSkipped.some((s) => s.ruleId === "dsaf/no-autoplay-unmuted"),
      true,
      "R25 A2-H3: bind:muted={false} must be skipped cleanly instead of duplicating muted attr"
    );
    const r25FixSelfPath = fileURLToPath(import.meta.url);
    const fixSymCli = join(scratch, "fix-sym.mjs");
    symlinkSync(r25FixSelfPath, fixSymCli);
    assert.equal(spawnSync(process.execPath, [fixSymCli, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regressions (A2-H4 TW v4 functional/uppercase variants, A2-M5 cva/cn outline-none, A2-L16 inline-size: 100vw)
    const r26FixDir = join(scratch, "r26-fix");
    mkdirSync(r26FixDir, { recursive: true });
    writeFileSync(
      join(r26FixDir, "comp.tsx"),
      'export const b = cva("inline-flex outline-none");\nexport const c = cn("px-4 outline-none");\nexport const d = () => <div className="supports-(display:grid):transition-all group-hover/MyCard:transition-all group/MyCard:outline-none" />;\n'
    );
    writeFileSync(join(r26FixDir, "style.css"), ".hero { inline-size: 100vw; }\n");
    const r26FixPlan = applyFloorFixes(r26FixDir, { dryRun: false });
    assert.equal(r26FixPlan.afterFloor, 0, "R26 fix-floor must resolve cva/cn outline-none, TW v4 variants, and inline-size: 100vw");
    assert.match(readFileSync(join(r26FixDir, "style.css"), "utf8"), /inline-size:\s*100%/);
    assert.match(readFileSync(join(r26FixDir, "comp.tsx"), "utf8"), /supports-\(display:grid\):transition-colors/);

    // Round 27 (A2-H4 symlink escape / protectedFiles bypass / dangling .dsaf.bak symlink; A2-L1 manualSkipped for CSS-in-JS & inline style)
    const r27SymProj = join(scratch, "r27-sym-proj");
    const r27OutVictim = join(scratch, "r27-outside-victim.css");
    const r27DanglingBakTarget = join(scratch, "r27-bak-victim.txt");
    mkdirSync(join(r27SymProj, "src"), { recursive: true });
    mkdirSync(join(r27SymProj, "protected-dir"), { recursive: true });
    mkdirSync(join(r27SymProj, ".dsaf"), { recursive: true });
    writeFileSync(r27OutVictim, ".v { outline: none; }\n");
    writeFileSync(join(r27SymProj, "protected-dir/tokens.css"), ".t { outline: none; }\n");
    writeFileSync(join(r27SymProj, ".dsaf/rules.json"), JSON.stringify({ protectedFiles: ["protected-dir/**"] }));
    writeFileSync(join(r27SymProj, "src/ok.css"), ".ok { transition: all 200ms; }\n");
    symlinkSync(r27DanglingBakTarget, join(r27SymProj, "src/ok.css.dsaf.bak"));
    symlinkSync(r27OutVictim, join(r27SymProj, "src/leak.css"));
    symlinkSync(join(r27SymProj, "protected-dir/tokens.css"), join(r27SymProj, "src/bypass.css"));
    const r27FixRes = applyFloorFixes(r27SymProj, { dryRun: false, backup: true });
    assert.equal(r27FixRes.filesModified, 1, "Only regular src/ok.css must be modified");
    assert.equal(readFileSync(r27OutVictim, "utf8"), ".v { outline: none; }\n", "External symlink target must not be overwritten");
    assert.equal(readFileSync(join(r27SymProj, "protected-dir/tokens.css"), "utf8"), ".t { outline: none; }\n", "protectedFiles must not be bypassed via symlink");
    assert.equal(existsSync(r27DanglingBakTarget), false, "Dangling .dsaf.bak symlink must not create outside target");

    const r27ManualDir = join(scratch, "r27-manual-dir");
    mkdirSync(r27ManualDir, { recursive: true });
    writeFileSync(join(r27ManualDir, "styled.tsx"), "export const B = styled.div`outline: none; transition: all 200ms; width: 100vw;`;\n");
    writeFileSync(join(r27ManualDir, "inline.tsx"), 'export const I = () => <div style={{ outline: "none", transition: "all 200ms", width: "100vw" }} />;\n');
    writeFileSync(join(r27ManualDir, "page.html"), '<button style="outline: none; transition: all 200ms; width: 100vw;">Go</button>\n');
    const r27ManualPlan = planFloorFixes(r27ManualDir, { dryRun: true });
    assert.equal(r27ManualPlan.beforeFloor, 9);
    assert.equal(r27ManualPlan.filesPlanned, 0);
    assert.equal(r27ManualPlan.manualSkipped.length, 9, "Un-autofixable inline/CSS-in-JS Floor findings must populate manualSkipped");

    // Round 28 regressions (A2-H2 cva variants remediation, A2-L2 same-line size-[100vw] manualSkipped accounting)
    const r28Dir = join(scratch, "r28-fix");
    mkdirSync(r28Dir, { recursive: true });
    writeFileSync(
      join(r28Dir, "cva.tsx"),
      'export const btn = cva("px-4 py-2", { variants: { variant: { bad: "transition-all w-[100vw] outline-none" } } });\nexport const M = () => <div className="w-[100vw] size-[100vw]" />;\n'
    );
    const r28Plan = applyFloorFixes(r28Dir, { dryRun: true });
    assert.equal(r28Plan.beforeFloor, 5, "R28 A2-H2/L2: 3 cva Floor + 2 same-line 100vw Floor findings");
    assert.equal(r28Plan.manualSkipped.length, 1, "R28 A2-L2: unpatched size-[100vw] on same line as w-[100vw] must appear in manualSkipped");
    assert.equal(r28Plan.manualSkipped[0].ruleId, "dsaf/no-100vw");
    assert.equal(r28Plan.manualSkipped[0].line, 2);
    const r28Applied = applyFloorFixes(r28Dir, { dryRun: false });
    assert.match(readFileSync(join(r28Dir, "cva.tsx"), "utf8"), /transition-colors w-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2/, "R28 A2-H2: cva variants must be patched cleanly");
    assert.equal(r28Applied.afterFloor, 1, "Only manual size-[100vw] remains unpatched");

    // Round 29 (A2-M3, A2-M6, A2-H2)
    const r29Dir = join(scratch, "r29-fix");
    mkdirSync(r29Dir, { recursive: true });
    writeFileSync(join(r29Dir, "mix.html"), '<style>button:focus { outline: none; }</style><div style="outline: none;">X</div>\n');
    writeFileSync(join(r29Dir, "comb.css"), ".btn:focus > .label { outline: none; }\n.guard:focus:not(:focus-visible) > .label { outline: none; }\n");
    writeFileSync(join(r29Dir, "Btn.svelte"), '<button on:click|preventDefault|stopPropagation={go} class="transition-all">Go</button>\n');
    const r29Plan = planFloorFixes(r29Dir, { dryRun: true });
    assert.equal(r29Plan.beforeFloor, 4, "R29: 2 mix.html + 1 .btn:focus > .label + 1 Btn.svelte (guarded combinator ignored)");
    const mixPlan = r29Plan.files.find((p) => p.rel.endsWith("mix.html"));
    assert.ok(mixPlan, "mix.html should appear in r29Plan.files");
    assert.equal(mixPlan.skipped.length, 1, "R29 A2-M3: same-line inline outline:none must still appear in file skipped");
    assert.equal(r29Plan.manualSkipped.length, 1, "R29 A2-M3: same-line inline outline:none must still appear in manualSkipped");
    assert.equal(r29Plan.manualSkipped[0].line, 1);
    const r29Applied = applyFloorFixes(r29Dir, { dryRun: false });
    const combCssOut = readFileSync(join(r29Dir, "comb.css"), "utf8");
    assert.match(combCssOut, /\.btn:focus:not\(:focus-visible\) > \.label/, "R29 A2-M6: must scope ancestor :focus before combinator");
    assert.match(combCssOut, /\.btn:focus-visible > \.label \{/, "R29 A2-M6: must emit reachable .btn:focus-visible > .label");
    assert.match(readFileSync(join(r29Dir, "Btn.svelte"), "utf8"), /transition-colors/, "R29 A2-H2: Svelte chained modifiers element patched");
    assert.equal(r29Applied.afterFloor, 1, "Only manual inline style='outline: none' in mix.html remains");

    // Round 30 (A2-L6): multi-<style> focus check across unscoped styles (0 edits), while <style scoped> must not cover unscoped <style>
    const r30Dir = join(scratch, "r30-fix");
    mkdirSync(r30Dir, { recursive: true });
    writeFileSync(
      join(r30Dir, "safe.html"),
      "<style>.btn:focus { outline: none; }</style>\n<style>.btn:focus-visible { outline: 2px solid var(--ring); }</style>\n"
    );
    writeFileSync(
      join(r30Dir, "Scoped.vue"),
      "<style>.btn:focus { outline: none; }</style>\n<style scoped>.btn:focus-visible { outline: 2px solid var(--ring); }</style>\n"
    );
    const r30Plan = planFloorFixes(r30Dir, { dryRun: true });
    assert.equal(r30Plan.beforeFloor, 1, "R30 A2-L6: only Scoped.vue unscoped <style> must fail");
    assert.equal(r30Plan.filesPlanned, 1);
    assert.ok(r30Plan.files[0].rel.endsWith("Scoped.vue"));

    // Round 31 regressions (A2-H2 nested :focus ancestor, A2-M5 border:none base, A2-M6 cross-<style>, A2-M7 multi-decl ruleLine, A2-M8 non-zero ring-opacity-75)
    const r31Dir = join(scratch, "r31-fix");
    mkdirSync(r31Dir, { recursive: true });
    writeFileSync(
      join(r31Dir, "nested-anc.css"),
      ".btn:focus { .label { outline: none; } }\n.fv-only:focus-visible { .label { outline: none; } }\n.card {\n  .item:focus { outline: none; }\n}\n"
    );
    writeFileSync(
      join(r31Dir, "border-supp.css"),
      ".b1 { border: none; }\n.b1:focus { outline: none; border-color: blue; }\n.b2 { border: none; }\n.b2:focus { outline: none; }\n.b2:focus-visible { border-color: blue; }\n"
    );
    writeFileSync(
      join(r31Dir, "cross.html"),
      "<style>.safe:focus, .bad:focus { outline: none; }</style>\n<style>.safe:focus-visible { outline: 2px solid blue; }</style>\n"
    );
    writeFileSync(
      join(r31Dir, "multi-decl.css"),
      ".m:focus {\n  outline-style: none;\n  outline-width: 0;\n}\n"
    );
    writeFileSync(
      join(r31Dir, "OpacityBtn.tsx"),
      'export const A = () => <button className="outline-none focus:ring-opacity-75" />;\nexport const B = () => <button className="outline-none focus:ring-opacity-0" />;\n'
    );
    const r31Plan = planFloorFixes(r31Dir, { dryRun: true });
    const nestedPlan = r31Plan.files.find((f) => f.rel.endsWith("nested-anc.css"));
    assert.ok(nestedPlan, "R31 A2-H2: nested-anc.css must be planned");
    assert.equal(nestedPlan.skipped.length, 1, "R31 A2-H2: .btn:focus { .label } must be manually skipped once");
    assert.match(nestedPlan.skipped[0].reason, /nested rule inside :focus ancestor/i);
    assert.equal(nestedPlan.patchCount, 3, "R31 A2-H2: in-place :focus-visible replacement + .card .item:focus rewrite/insert");

    const r31Apply = applyFloorFixes(r31Dir, { dryRun: false });
    const nestedOut = readFileSync(join(r31Dir, "nested-anc.css"), "utf8");
    assert.doesNotMatch(nestedOut, /\.label:focus-visible/, "R31 A2-H2: must NOT insert .label:focus-visible inside .btn:focus");
    assert.match(nestedOut, /\.fv-only:focus-visible \{ \.label \{ outline: 2px solid/, "R31 A2-H2: .fv-only:focus-visible { .label } replaces in place");
    assert.match(nestedOut, /\.item:focus:not\(:focus-visible\)[\s\S]*\.item:focus-visible \{ outline: 2px solid/, "R31 A2-H2: .card { .item:focus } still patches cleanly");
    const r31Pass2 = applyFloorFixes(r31Dir, { dryRun: false });
    assert.equal(readFileSync(join(r31Dir, "nested-anc.css"), "utf8"), nestedOut, "R31 A2-H2: second pass must be idempotent");
    assert.equal(r31Pass2.files.length, 0);

    const crossOut = readFileSync(join(r31Dir, "cross.html"), "utf8");
    assert.match(crossOut, /\.bad:focus-visible \{/, "R31 A2-M6: inserts missing .bad:focus-visible");
    assert.equal((crossOut.match(/\.safe:focus-visible/g) || []).length, 1, "R31 A2-M6: must NOT duplicate .safe:focus-visible across <style>");

    const borderOut = readFileSync(join(r31Dir, "border-supp.css"), "utf8");
    assert.match(borderOut, /\.b1:focus-visible \{ outline: 2px solid/, "R31 A2-M5: b1:focus border-color only on base border:none is suppressed -> inserts visible outline");
    assert.match(borderOut, /\.b2:focus-visible \{ outline: 2px solid/, "R31 A2-M5: b2:focus-visible { border-color } alone is suppressed -> inserts visible outline");

    const multiPlan = r31Plan.files.find((f) => f.rel.endsWith("multi-decl.css"));
    assert.equal(multiPlan.skipped.length, 0, "R31 A2-M7: multi-declaration outline removal must produce 0 spurious skipped");

    const opOut = readFileSync(join(r31Dir, "OpacityBtn.tsx"), "utf8");
    assert.match(opOut, /outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus:ring-opacity-75/, "R31 A2-M8: ring-opacity-75 must patch");
    assert.match(opOut, /outline-none focus:ring-opacity-0/, "R31 A2-M8: ring-opacity-0 must stay skipped");
    assert.equal(r31Apply.afterFloor, 2, "R31: only nested .btn:focus { .label } + focus:ring-opacity-0 remain Floor");

    // Round 32 regressions (A2-H1 @apply arbitrary utilities must patch validly without duplicate CSS collision)
    const r32Dir = join(scratch, "r32-fix");
    mkdirSync(r32Dir, { recursive: true });
    writeFileSync(
      join(r32Dir, "apply-arb.css"),
      ".card { @apply [width:100vw] [min-width:100vw] [transition:all] [outline:none]; }\n"
    );
    const r32Apply = applyFloorFixes(r32Dir, { dryRun: false });
    const r32CssOut = readFileSync(join(r32Dir, "apply-arb.css"), "utf8");
    assert.equal(r32Apply.afterFloor, 0, "R32 A2-H1: @apply arbitrary utilities must fix cleanly to afterFloor=0");
    assert.match(
      r32CssOut,
      /@apply \[width:100%\] \[min-width:100%\] transition-colors \[outline:none\] focus-visible:ring-2 focus-visible:ring-offset-2;/,
      "R32 A2-H1: @apply [width:100vw]/[min-width:100vw]/[transition:all]/[outline:none] must patch without corrupting bracket syntax"
    );

    // Round 33 regressions (A2-H2 & A2-L8: markup transition-[all] + [width:100vw] + safe skip for complex variants)
    const r33Dir = join(scratch, "r33-fix");
    mkdirSync(r33Dir, { recursive: true });
    writeFileSync(
      join(r33Dir, "card.tsx"),
      '<button className="hover:transition-[all] [width:100vw] transition-[all_200ms] outline-none focus-visible:shadow-[0_0_0_2px_#005fcc]" />\n'
    );
    const r33Apply = applyFloorFixes(r33Dir, { dryRun: false });
    const r33Out = readFileSync(join(r33Dir, "card.tsx"), "utf8");
    assert.match(r33Out, /hover:transition-colors \[width:100%\] transition-\[all_200ms\]/, "R33 A2-H2/L8: exact transition-[all]/[width:100vw] patched while complex transition-[all_200ms] skipped");
    assert.equal(r33Apply.afterFloor, 1, "R33 A2-H2/M6/L8: only skipped transition-[all_200ms] remains Floor (shadow-[...] focus ring accepted)");
    assert.ok(r33Apply.manualSkipped.some((sk) => sk.ruleId === "dsaf/no-transition-all" && /transition-\[all_200ms\]/.test(sk.reason)));

    // Round 34 (A2-M5 cross-file --ds-css @layer order & hierarchical sub-layers, A2-L4 w-screen, A2-L6 @apply transition-[all]):
    const r34DsCssDir = join(scratch, "r34-dscss");
    mkdirSync(r34DsCssDir, { recursive: true });
    const r34DsCssFile = join(r34DsCssDir, "ds.css");
    writeFileSync(
      r34DsCssFile,
      `${"/* pad */\n".repeat(12)}@layer base { .btn:focus-visible { outline: 2px solid blue; } }\n`
    );
    writeFileSync(
      join(r34DsCssDir, "app.css"),
      "@layer utilities { .btn:focus { outline: none; color: red; } }\n"
    );
    const r34CrossApply = applyFloorFixes(join(r34DsCssDir, "app.css"), { dryRun: false, dsCss: [r34DsCssFile] });
    assert.equal(r34CrossApply.afterFloor, 0, "R34 A2-M5: cross-file lower @layer base must not falsely satisfy higher @layer utilities");
    assert.match(readFileSync(join(r34DsCssDir, "app.css"), "utf8"), /\.btn:focus-visible \{ outline: 2px solid/);

    writeFileSync(
      join(r34DsCssDir, "utils.css"),
      ".a { @apply transition-[all] w-screen min-w-screen max-w-screen; }\n"
    );
    writeFileSync(
      join(r34DsCssDir, "Page.tsx"),
      'export const Page = () => <div className="sm:w-screen min-w-screen max-w-screen w-screen-md" />;\n'
    );
    const r34UtilApply = applyFloorFixes(join(r34DsCssDir, "utils.css"), { dryRun: false });
    assert.equal(r34UtilApply.afterFloor, 0, "R34 A2-L4/L6: @apply transition-[all] and w-screen/min-w-screen/max-w-screen fix to 0");
    assert.match(readFileSync(join(r34DsCssDir, "utils.css"), "utf8"), /@apply transition-colors w-full min-w-full max-w-full;/);
    const r34PageApply = applyFloorFixes(join(r34DsCssDir, "Page.tsx"), { dryRun: false });
    assert.equal(r34PageApply.afterFloor, 0, "R34 A2-L4: markup w-screen variants fix cleanly while w-screen-md stays untouched");
    assert.match(readFileSync(join(r34DsCssDir, "Page.tsx"), "utf8"), /sm:w-full min-w-full max-w-full w-screen-md/);

    // Round 36 (R35-A2-H1 lower-layer unrelated !important & R35-A2-H4 conditional ring killer conflict):
    const r36FixDir = join(scratch, "r36-fix");
    mkdirSync(r36FixDir, { recursive: true });
    writeFileSync(
      join(r36FixDir, "layer.css"),
      "@layer base, components;\n@layer base { .btn:focus-visible { outline: 2px solid blue; box-shadow: none !important; } }\n@layer components { .btn:focus { color: red; outline: none; } }\n"
    );
    const r36LayerPlan = applyFloorFixes(join(r36FixDir, "layer.css"), { dryRun: false });
    assert.equal(r36LayerPlan.afterFloor, 0, "R36 A2-H1: fix-floor must add :focus-visible in @layer components instead of trusting lower @layer box-shadow: none !important");
    assert.match(readFileSync(join(r36FixDir, "layer.css"), "utf8"), /:focus-visible\s*\{\s*outline:\s*2px solid/);

    writeFileSync(
      join(r36FixDir, "RingKill.tsx"),
      'export const Btn = () => <button className="focus:outline-none dark:focus-visible:ring-0" />;\n'
    );
    const r36RingPlan = planFloorFixes(join(r36FixDir, "RingKill.tsx"));
    assert.equal(r36RingPlan.patchesPlanned, 0, "R36 A2-H4: dark:focus-visible:ring-0 must skip auto-patching incomplete focus-visible:ring-2");
    assert.ok(r36RingPlan.manualSkipped.some((s) => /conflicting focus ring suppression/i.test(s.reason)));

    // Round 38 (R37-A2-M2 @apply dark:focus-visible:ring-0 + ring-transparent + R37-A2-M1 earlier box-shadow):
    const r38FixDir = join(scratch, "r38-fix");
    mkdirSync(r38FixDir, { recursive: true });
    writeFileSync(join(r38FixDir, "apply-dark.css"), ".btn { @apply outline-none dark:focus-visible:ring-0; }\n");
    const r38ApplyDark = planFloorFixes(join(r38FixDir, "apply-dark.css"));
    assert.equal(r38ApplyDark.patchesPlanned, 0, "R38 A2-M2: @apply dark:focus-visible:ring-0 must skip auto-patching");
    assert.ok(r38ApplyDark.manualSkipped.some((s) => /conflicting @apply focus ring suppression/i.test(s.reason)));

    writeFileSync(join(r38FixDir, "RingTrans.tsx"), 'export const Btn = () => <button className="outline-none ring-transparent">x</button>;\n');
    const r38RingTrans = planFloorFixes(join(r38FixDir, "RingTrans.tsx"));
    assert.equal(r38RingTrans.patchesPlanned, 0, "R38 A2-M2: unconditional ring-transparent must skip auto-patching");
    assert.ok(r38RingTrans.manualSkipped.some((s) => /conflicting focus ring suppression/i.test(s.reason)));

    writeFileSync(join(r38FixDir, "RingZero.tsx"), 'export const Btn = () => <button className="outline-none ring-0">x</button>;\n');
    const r38RingZero = applyFloorFixes(join(r38FixDir, "RingZero.tsx"), { dryRun: false });
    assert.equal(r38RingZero.afterFloor, 0, "R38 A2-M2: unconditional ring-0 should still patch cleanly with focus-visible:ring-2");

    writeFileSync(
      join(r38FixDir, "boxshadow-order.css"),
      ".btn:focus-visible { box-shadow: 0 0 0 3px #1d4ed8; }\n.btn:focus { outline: none; background: #eee; }\n"
    );
    assert.equal(planFloorFixes(join(r38FixDir, "boxshadow-order.css")).patchesPlanned, 0, "R38 A2-M1: earlier :focus-visible box-shadow must prevent duplicate rule insertion");

    // Round 39 (R38-A2-H1/H2 focus suppression awareness in fix-floor):
    writeFileSync(
      join(r38FixDir, "apply-border-imp.css"),
      ".btn { border: 0 !important; outline: none; }\n.btn:focus-visible { @apply border-2 border-blue-500; }\n"
    );
    const r39ApplyBorder = applyFloorFixes(join(r38FixDir, "apply-border-imp.css"), { dryRun: false });
    assert.equal(r39ApplyBorder.afterFloor, 0, "R39 A2-H1: fix-floor must patch .btn:focus-visible blocked by base border: 0 !important");

    console.log("DSAF_FIX_SELF_TEST_PASSED (dry-run + protectedFiles + backup + CSS/Tailwind/video remediation)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isDirectCliEntry(import.meta.url)) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
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
    }));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(
      [
        `DSAF v${FIX_VERSION} — Safe Floor Auto-Remediator`,
        "Usage:",
        "  dsaf fix <target> [--dry-run] [--apply] [--backup] [--rule <id>] [--max-files <n>] [--ignore-protected] [--ds-css <path>] [--json] [--help]",
        "  dsaf fix --self-test",
      ].join("\n")
    );
    process.exit(0);
  }

  if (values["self-test"]) {
    process.exit(runSelfTest());
  }

  if (positionals.length > 1) {
    console.error(`ERROR: Unexpected extra positional argument '${positionals[1]}'. Pass a single <target>.`);
    process.exit(2);
  }
  const target = positionals[0];
  if (!target || !target.trim()) {
    console.error("ERROR: Non-empty <target> file or directory is required unless --self-test is passed.");
    process.exit(2);
  }
  const absCliTarget = resolve(target);
  if (!existsSync(absCliTarget)) {
    console.error(`ERROR: Target not found: ${absCliTarget}`);
    process.exit(2);
  }
  for (const val of values["ds-css"] || []) {
    if (typeof val !== "string" || !val.trim() || val.split(",").some((s) => !s.trim())) {
      console.error("ERROR: Option '--ds-css' requires non-empty file path(s).");
      process.exit(2);
    }
  }
  if ((values["ds-css"] || []).length > 0) {
    try {
      const dsBase = statSync(absCliTarget).isDirectory() ? absCliTarget : dirname(absCliTarget);
      discoverExternalDsCss(dsBase, values["ds-css"]);
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  for (const r of values.rule || []) {
    const rawR = String(r ?? "").trim().toLowerCase();
    const norm = rawR && !rawR.includes("/") ? `dsaf/${rawR}` : rawR;
    if (!rawR || !ALLOWED_FIXED_RULES.has(norm)) {
      console.error(`ERROR: Invalid --rule '${r}'. Expected one of: ${[...ALLOWED_FIXED_RULES].join(", ")}`);
      process.exit(2);
    }
  }
  let maxFiles = Infinity;
  if (values["max-files"] !== undefined) {
    if (!/^\d+$/.test(values["max-files"].trim())) {
      console.error(`ERROR: Invalid --max-files '${values["max-files"]}'. Expected a non-negative integer.`);
      process.exit(2);
    }
    maxFiles = Number.parseInt(values["max-files"].trim(), 10);
  }

  try {
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
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}

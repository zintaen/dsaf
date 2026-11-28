#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Edit-Time Agent Design Hook & Floor/Reflex Static Checker.
 * Zero external dependencies. Supports:
 * - `dsaf hook check <file-or-dir> [--tier floor|reflex|all] [--sarif <f>] [--github] [--report-unused-ignores] [--json]`
 * - `dsaf hook stdin [--tier floor|reflex|all] [--ds-css <path>]` (PostToolUse Edit|Write hook)
 * - `dsaf hook install [--agent claude|cursor|codex] [--dir <project>] [--local]`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  applyIgnores,
  assertWritableOutputFile,
  blankCssCustomPropDeclsPreservingLines,
  blankStyledTemplateCustomPropsPreservingLines,
  canStartJsTemplateLiteral,
  CI_REPORT_VERSION,
  computeJsOuterStringSpans,
  computeMarkupJsOuterStringSpans,
  endsWithGenericTaggedTemplate,
  extractImportantStyleSurfacePreservingLines,
  extractRealStyleBlocks,
  findCssInJsTemplateRanges,
  findHardcodedColorFunctions,
  findSvelteStyleDirectives,
  findSvgBlockRanges,
  formatGithubAnnotations,
  formatSarif,
  isDirectCliEntry,
  isRealOpenTagAttrPos as ciIsRealOpenTagAttrPos,
  isTokenizedColorFn,
  isValidJsObjKeyPos,
  maskCssQuotedStringsPreservingLines,
  maskProseAndDocStringsPreservingLines,
  maskRangePreservingLines,
  offsetToLine,
  scanMarkupContexts,
  skipJsRegexInExpr,
  splitTopLevelCommas,
  stripCommentsPreservingLines,
  stripCssCommentsInTemplatePreservingLines,
  stripTokenBlocksPreservingLines,
  stripTrailingTsCastEnd as ciStripTrailingTsCastEnd,
} from "./ci-report.mjs";

export { maskCssQuotedStringsPreservingLines };

const UI_EXTS = new Set([".css", ".scss", ".html", ".tsx", ".jsx", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "storybook-static",
  "_audit",
  "_vendor",
  "_site",
  "src-tauri",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "coverage",
  "playwright-report",
  "test-results",
  "audit-output",
  "dsaf-audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

function resolveNestedSelector(parentResolved, rawChildSelector) {
  const child = String(rawChildSelector || "").trim();
  if (!child) return parentResolved || "";
  if (child.startsWith("@")) return parentResolved || "";
  if (!parentResolved) return child;
  const pBranches = splitTopLevelCommas(parentResolved);
  const cBranches = splitTopLevelCommas(child);
  const out = [];
  for (const p of pBranches) {
    for (const c of cBranches) {
      out.push(c.includes("&") ? c.replace(/&/g, () => p) : `${p} ${c}`);
    }
  }
  return out.join(", ");
}

export function extractCssRuleBlocks(cleanedCss) {
  const blocks = [];
  let idx = 0;
  let headerStart = 0;
  let quote = null;
  let interpDepth = 0;
  let parenDepth = 0;
  const stack = [];
  const layerTree = { orderIndex: 0, children: new Map() };
  let anonLayerSeq = 0;
  const registerLayerPath = (segs) => {
    if (!Array.isArray(segs) || segs.length === 0) return [];
    let cur = layerTree;
    for (const seg of segs) {
      let child = cur.children.get(seg);
      if (!child) {
        child = { orderIndex: cur.children.size, children: new Map() };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    return segs;
  };
  const currentLayerPath = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].layerPath && stack[k].layerPath.length > 0) return stack[k].layerPath;
    }
    return [];
  };

  while (idx < cleanedCss.length) {
    const ch = cleanedCss[idx];
    if (quote) {
      if (ch === "\\" && idx + 1 < cleanedCss.length) idx++;
      else if (ch === quote || ch === "\n") quote = null;
      idx++;
      continue;
    }
    if (ch === "\\" && idx + 1 < cleanedCss.length) {
      idx += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      idx++;
      continue;
    }
    if (ch === "(" && interpDepth === 0) {
      parenDepth++;
    } else if (ch === ")" && interpDepth === 0) {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === "{") {
      if (interpDepth > 0 || (idx > 0 && cleanedCss[idx - 1] === "#")) {
        interpDepth++;
        idx++;
        continue;
      }
      parenDepth = 0;
      const header = cleanedCss.slice(headerStart, idx);
      const selector = header.trim();
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const isKeyframesRule = /^@(?:-webkit-|-moz-)?keyframes\b/i.test(selector);
      const inKeyframes = Boolean(parent?.inKeyframes) || isKeyframesRule;
      const inStartingStyle = Boolean(parent?.inStartingStyle) || /@starting-style\b/i.test(selector);
      const isConditionalRule =
        /^@(?:media|supports|container|document|scope)\b/i.test(selector) &&
        !/^@media\s+(?:all|screen)\s*$/i.test(selector);
      const normCond = selector.replace(/\s+/g, " ").trim().toLowerCase();
      const parentConditions = parent?.conditions || [];
      const conditions = isConditionalRule ? [...parentConditions, normCond] : [...parentConditions];
      const isLayerBlock = /^@layer\b/i.test(selector);
      let layerPath = parent?.layerPath ? [...parent.layerPath] : [];
      let layerName = parent?.layerName || null;
      if (isLayerBlock) {
        const rawLayer = selector.replace(/^@layer\b/i, "").replace(/\s+/g, "").trim();
        const segs = rawLayer
          ? rawLayer.split(".").map((s) => s.trim()).filter(Boolean)
          : [`__anon_${++anonLayerSeq}`];
        const pref = currentLayerPath();
        layerPath = registerLayerPath([...pref, ...(segs.length > 0 ? segs : [`__anon_${++anonLayerSeq}`])]);
        layerName = layerPath.join(".");
      }
      const resolvedSelector = parent?.inKeyframes ? selector : resolveNestedSelector(parent?.resolvedSelector || "", selector);
      stack.push({
        selector,
        resolvedSelector,
        bodyStart: idx + 1,
        selectorStart: headerStart,
        inStartingStyle,
        inKeyframes,
        conditions,
        layerName,
        layerPath,
        nestedSpans: [],
      });
      headerStart = idx + 1;
    } else if (ch === "}") {
      if (interpDepth > 0) {
        interpDepth--;
        idx++;
        continue;
      }
      const top = stack.pop();
      if (top) {
        if (stack.length > 0) {
          stack[stack.length - 1].nestedSpans.push([top.selectorStart, idx + 1]);
        }
        const fullBody = cleanedCss.slice(top.bodyStart, idx);
        let body = fullBody;
        if (top.nestedSpans.length > 0) {
          const chars = fullBody.split("");
          for (const [nStart, nEnd] of top.nestedSpans) {
            const relStart = Math.max(0, nStart - top.bodyStart);
            const relEnd = Math.min(fullBody.length, nEnd - top.bodyStart);
            maskRangePreservingLines(chars, relStart, relEnd);
          }
          body = chars.join("");
        }
        blocks.push({
          selector: top.selector,
          resolvedSelector: top.resolvedSelector || top.selector,
          selectorStart: top.selectorStart,
          bodyStart: top.bodyStart,
          bodyEnd: idx,
          inStartingStyle: top.inStartingStyle,
          inKeyframes: top.inKeyframes,
          conditions: top.conditions,
          layer: top.layerName,
          layerPath: top.layerPath || [],
          layerTree,
          body,
          fullBody,
        });
      }
      headerStart = idx + 1;
      parenDepth = 0;
    } else if (ch === ";") {
      if (interpDepth === 0 && parenDepth === 0) {
        const stmt = cleanedCss.slice(headerStart, idx).trim();
        if (/^@layer\s+[\s\S]+$/i.test(stmt)) {
          const pref = currentLayerPath();
          for (const rawItem of stmt.replace(/^@layer\s+/i, "").split(",")) {
            const segs = rawItem
              .replace(/\s+/g, "")
              .trim()
              .split(".")
              .map((s) => s.trim())
              .filter(Boolean);
            if (segs.length === 0) continue;
            registerLayerPath([...pref, ...segs]);
          }
        }
        headerStart = idx + 1;
      }
    }
    idx++;
  }
  return blocks;
}

export function extractVideoTags(source, options = {}) {
  const out = [];
  const s = String(source || "");
  const ctx = options.markupCtx || scanMarkupContexts(s, options);
  for (const t of ctx.openTags) {
    const matchTag = options.caseSensitive ? t.rawTag === "video" : t.tag === "video";
    if (!matchTag) continue;
    const nameEnd = t.start + 1 + t.rawTag.length;
    out.push({ start: t.start, end: t.end, attrs: s.slice(nameEnd, t.end - 1) });
  }
  return out;
}

export function stripQuotedAttrValues(attrs) {
  const s = String(attrs || "");
  const chars = s.split("");
  let braceDepth = 0;
  let exprStart = -1;
  let exprQuote = null;
  let lastSig = "";
  const parenStack = [];
  const tplStack = [];
  let attrQuote = null;
  let attrStart = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (attrQuote) {
      if (attrQuote === "`" && ch === "\\" && i + 1 < s.length) {
        if (chars[i + 1] !== "\n") chars[i + 1] = " ";
        chars[i] = " ";
        i++;
        continue;
      }
      if (ch === attrQuote) {
        if (attrStart !== -1) {
          const prefix = s.slice(Math.max(0, attrStart - 32), attrStart);
          const inner = s.slice(attrStart + 1, i).trim();
          if (
            /(?:^|\s)(?:v-bind|bind)?:(?:muted|autoplay)\s*=\s*$/i.test(prefix) &&
            /^(?:true|false|0|null|undefined|''|""|``)$/i.test(inner)
          ) {
            for (let k = attrStart + 1; k < i; k++) chars[k] = s[k];
          }
          attrStart = -1;
        }
        attrQuote = null;
      } else if (ch !== "\n") {
        chars[i] = " ";
      }
      continue;
    }
    if (exprQuote) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (exprQuote === "`" && ch === "$" && i + 1 < s.length && s[i + 1] === "{") {
        tplStack.push(0);
        exprQuote = null;
        lastSig = "{";
        i++;
        continue;
      }
      if (ch === exprQuote || (exprQuote !== "`" && ch === "\n")) {
        exprQuote = null;
        lastSig = ch;
      }
      continue;
    }
    if (braceDepth > 0) {
      const reEnd = skipJsRegexInExpr(s, i, lastSig, exprStart + 1);
      if (reEnd !== -1 && reEnd <= s.length) {
        lastSig = "/";
        i = reEnd - 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") exprQuote = ch;
      else if (tplStack.length > 0 && ch === "{") {
        tplStack[tplStack.length - 1]++;
        lastSig = "{";
      } else if (tplStack.length > 0 && ch === "}") {
        if (tplStack[tplStack.length - 1] === 0) {
          tplStack.pop();
          exprQuote = "`";
        } else {
          tplStack[tplStack.length - 1]--;
          lastSig = "}";
        }
      } else if (ch === "{") {
        braceDepth++;
        lastSig = "{";
      } else if (ch === "}") {
        braceDepth--;
        lastSig = "}";
        if (braceDepth === 0 && exprStart !== -1) {
          const inner = s.slice(exprStart + 1, i).trim();
          if (!/^(?:true|false|0|null|undefined|""|''|``|muted|autoplay|playsinline)$/i.test(inner)) {
            for (let k = exprStart + 1; k < i; k++) {
              if (chars[k] !== "\n") chars[k] = " ";
            }
          }
          exprStart = -1;
          parenStack.length = 0;
        }
      } else if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(exprStart + 1, i - 16), i)));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      continue;
    }
    if (ch === "{") {
      braceDepth = 1;
      exprStart = i;
      lastSig = "{";
      parenStack.length = 0;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      attrQuote = ch;
      attrStart = i;
    }
  }
  return chars.join("");
}

const FALSY_ATTR_LITERAL_RE = "(?:false|0|null|undefined|''|\"\"|``)";
export function isUnmutedAutoplayVideo(attrs) {
  const cleanAttrs = stripQuotedAttrValues(attrs);
  const autoFalsyRe = new RegExp(
    `(?:^|\\s)(?:(?:(?:v-bind|bind)?:)?autoplay\\s*=\\s*\\{\\s*${FALSY_ATTR_LITERAL_RE}\\s*\\}|(?:v-bind|bind)?:autoplay\\s*=\\s*["']\\s*(?:false|0|null|undefined|''|"")\\s*["'])`,
    "i"
  );
  const mutedFalsyRe = new RegExp(
    `(?:^|\\s)(?:(?:(?:v-bind|bind)?:)?muted\\s*=\\s*\\{\\s*${FALSY_ATTR_LITERAL_RE}\\s*\\}|(?:v-bind|bind)?:muted\\s*=\\s*["']\\s*(?:false|0|null|undefined|''|"")\\s*["'])`,
    "i"
  );
  const hasAuto =
    /(?:^|\s)(?:(?:v-bind|bind)?:)?autoplay(?=\s|=|\/|$)|\{\s*autoplay\s*\}/i.test(cleanAttrs) &&
    !autoFalsyRe.test(cleanAttrs);
  if (!hasAuto) return false;
  if (mutedFalsyRe.test(cleanAttrs)) return true;
  return !/(?:^|\s)(?:(?:(?:v-bind|bind)?:)?muted(?=\s|=|\/|$)|\{\s*muted\s*\})/i.test(cleanAttrs);
}

function maskSvgAndStyleTokens(raw, isStyle, markupOpts = null, markupCtx = null) {
  let clean = stripCommentsPreservingLines(raw);
  if (isStyle) {
    return stripTokenBlocksPreservingLines(clean);
  }
  const chars = clean.split("");
  const ctx = markupCtx || scanMarkupContexts(clean, markupOpts || {});
  for (const blk of extractRealStyleBlocks(clean, ctx, markupOpts || {})) {
    const strippedStyle = stripTokenBlocksPreservingLines(blk.text);
    for (let k = 0; k < strippedStyle.length && blk.bodyStart + k < blk.bodyEnd; k++) {
      chars[blk.bodyStart + k] = strippedStyle[k];
    }
  }
  const cleanAfterStyle = chars.join("");
  const svgCtx = cleanAfterStyle === clean ? ctx : scanMarkupContexts(cleanAfterStyle, markupOpts || {});
  for (const r of findSvgBlockRanges(cleanAfterStyle, { ...(markupOpts || {}), markupCtx: svgCtx })) {
    maskRangePreservingLines(chars, r.start, r.end);
  }
  return chars.join("");
}

function findAncestorDsCssFiles(startDir, maxLevels = 3, maxFiles = 6, maxBytes = 512 * 1024) {
  const found = [];
  const seen = new Set();
  let cur = resolve(startDir || ".");
  for (let lvl = 0; lvl <= maxLevels && found.length < maxFiles; lvl++) {
    const nm = join(cur, "node_modules");
    if (existsSync(nm)) {
      let entries = [];
      try {
        entries = readdirSync(nm, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (found.length >= maxFiles) break;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith("@")) {
          const scopeDir = join(nm, entry.name);
          let pkgs = [];
          try {
            pkgs = readdirSync(scopeDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const pkg of pkgs) {
            if (found.length >= maxFiles) break;
            if (!/^(?:design|ui)/i.test(pkg.name)) continue;
            const distDir = join(scopeDir, pkg.name, "dist");
            if (!existsSync(distDir)) continue;
            try {
              for (const f of readdirSync(distDir, { withFileTypes: true })) {
                if (found.length >= maxFiles) break;
                if (!f.name.endsWith(".css")) continue;
                const full = join(distDir, f.name);
                if (!seen.has(full) && statSync(full).size <= maxBytes) {
                  seen.add(full);
                  found.push(full);
                }
              }
            } catch {
              /* ignore unreadable dist */
            }
          }
        } else if (/design-system/i.test(entry.name)) {
          const distDir = join(nm, entry.name, "dist");
          if (existsSync(distDir)) {
            try {
              for (const f of readdirSync(distDir, { withFileTypes: true })) {
                if (found.length >= maxFiles) break;
                if (!f.name.endsWith(".css")) continue;
                const full = join(distDir, f.name);
                if (!seen.has(full) && statSync(full).size <= maxBytes) {
                  seen.add(full);
                  found.push(full);
                }
              }
            } catch {
              /* ignore unreadable dist */
            }
          }
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

export const OUTLINE_REMOVAL_RE =
  /(?<![a-zA-Z0-9_$-])(?:outline\s*:\s*(?:none|0(?:px|rem|em)?(?![a-zA-Z0-9_.-])|[^;}\n]*\btransparent\b(?![a-zA-Z0-9_-])|[^;}\n]*\bnone\b(?![a-zA-Z0-9_-])|[^;}\n]*\b0(?:px|rem|em)?(?![a-zA-Z0-9_.-]))|outline-style\s*:\s*(?:none|hidden)(?![a-zA-Z0-9_-])|outline-width\s*:\s*0(?:px|rem|em)?(?![a-zA-Z0-9_-])|outline-color\s*:\s*(?:transparent|none)(?![a-zA-Z0-9_-]))/i;

export function stripCssParens(val) {
  let s = String(val || "").replace(/!\s*important\b/gi, "").trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, " ");
  }
  return s.trim();
}

function stripBalancedCssFns(src, fnNameRe) {
  const s = String(src || "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    fnNameRe.lastIndex = i;
    const m = fnNameRe.exec(s);
    if (!m) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, m.index));
    let j = m.index + m[0].length;
    let depth = 1;
    let q = null;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (q) {
        if (c === "\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      j++;
    }
    out.push(" var(--_) ");
    i = j;
  }
  return out.join("");
}

function hasBaseZeroAlphaColor(raw) {
  const s = stripBalancedCssFns(String(raw || ""), /\b(?:var|env)\s*\(/gi);
  if (/(?<![a-zA-Z0-9_-])#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)(?![0-9a-f_-])/i.test(s)) return true;
  const zeroTokRe = /^(?:0(?:\.0+)?%?|\.0+%?|none)$/i;
  const fnRe = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi;
  let m;
  while ((m = fnRe.exec(s)) !== null) {
    const fnName = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let i = openIdx + 1;
    const commaPositions = [];
    const slashPositions = [];
    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 1) {
        if (ch === ",") commaPositions.push(i);
        else if (ch === "/") slashPositions.push(i);
      }
      i++;
    }
    if (depth !== 0) continue;
    const closeIdx = i - 1;
    if (slashPositions.length > 0) {
      const lastSlash = slashPositions[slashPositions.length - 1];
      const alphaStr = s.slice(lastSlash + 1, closeIdx).trim();
      if (zeroTokRe.test(alphaStr)) return true;
    }
    if ((fnName === "rgb" || fnName === "rgba" || fnName === "hsl" || fnName === "hsla") && commaPositions.length > 0) {
      const args = [];
      let prev = openIdx + 1;
      for (const cp of commaPositions) {
        args.push(s.slice(prev, cp).trim());
        prev = cp + 1;
      }
      args.push(s.slice(prev, closeIdx).trim());
      const lastArg = args[args.length - 1];
      const hasVarArg = args.slice(0, -1).some((a) => /\bvar\(--_\)/i.test(a));
      if (
        (args.length === 4 ||
          (args.length === 2 && hasVarArg) ||
          (args.length === 3 && hasVarArg && (fnName === "rgba" || fnName === "hsla"))) &&
        zeroTokRe.test(lastArg)
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseOuterZeroAlphaCall(raw) {
  const s = String(raw || "").trim();
  const m = /^(color-mix|light-dark)\s*\(/i.exec(s);
  if (!m) return null;
  const openIdx = s.indexOf("(", m.index);
  let depth = 0;
  let q = null;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && i + 1 < s.length) i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i === s.length - 1 ? { fn: m[1].toLowerCase(), body: s.slice(openIdx + 1, i) } : null;
      }
    }
  }
  return null;
}

function parseColorMixStopZeroAlpha(rawStop) {
  const s = String(rawStop || "").trim();
  if (!s) return { colorPart: "", pct: null };
  const toks = [];
  let cur = "";
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "\\" && i + 1 < s.length) cur += s[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === "(") {
      depth++;
      cur += c;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (cur) {
        toks.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) toks.push(cur);
  let pct = null;
  const rem = [];
  for (const tok of toks) {
    const pm = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/.exec(tok);
    if (pm && pct === null) {
      pct = Math.max(0, Number.parseFloat(pm[1]));
    } else {
      rem.push(tok);
    }
  }
  if (pct === null && rem.length >= 2 && /^(?:calc|min|max|clamp|var|env)\s*\(/i.test(rem[rem.length - 1])) {
    pct = "dynamic";
  }
  return { colorPart: rem.join(" ").trim(), pct };
}

function evalZeroAlphaInMode(rawExpr, depth = 0, mode = "light") {
  const t = String(rawExpr || "").replace(/!\s*important\b/gi, "").trim();
  if (!t || depth > 8) return false;
  if (/^transparent$/i.test(t)) return true;
  const outer = parseOuterZeroAlphaCall(t);
  if (outer?.fn === "light-dark") {
    const args = splitTopLevelCommas(outer.body);
    if (args.length === 2) {
      return evalZeroAlphaInMode(mode === "dark" ? args[1] : args[0], depth + 1, mode);
    }
    return false;
  }
  if (outer?.fn === "color-mix") {
    const args = splitTopLevelCommas(outer.body);
    if (args.length === 3) {
      const s1 = parseColorMixStopZeroAlpha(args[1]);
      const s2 = parseColorMixStopZeroAlpha(args[2]);
      let w1;
      let w2;
      if (s1.pct === "dynamic" || s2.pct === "dynamic") {
        w1 = s1.pct === "dynamic" ? 100 : s1.pct ?? 50;
        w2 = s2.pct === "dynamic" ? 100 : s2.pct ?? 50;
      } else if (s1.pct !== null && s2.pct !== null) {
        w1 = s1.pct;
        w2 = s2.pct;
      } else if (s1.pct !== null) {
        w1 = s1.pct;
        w2 = Math.max(0, 100 - s1.pct);
      } else if (s2.pct !== null) {
        w2 = s2.pct;
        w1 = Math.max(0, 100 - s2.pct);
      } else {
        w1 = 50;
        w2 = 50;
      }
      const vis1 = w1 > 0 && Boolean(s1.colorPart) && !evalZeroAlphaInMode(s1.colorPart, depth + 1, mode);
      const vis2 = w2 > 0 && Boolean(s2.colorPart) && !evalZeroAlphaInMode(s2.colorPart, depth + 1, mode);
      return !vis1 && !vis2;
    }
    return false;
  }
  return hasBaseZeroAlphaColor(t);
}

export function hasZeroAlphaColor(raw) {
  const s = String(raw || "");
  const mixLdRe = /\b(?:color-mix|light-dark)\s*\(/gi;
  const out = [];
  let i = 0;
  while (i < s.length) {
    mixLdRe.lastIndex = i;
    const m = mixLdRe.exec(s);
    if (!m) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, m.index));
    let j = m.index + m[0].length;
    let depth = 1;
    let q = null;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (q) {
        if (c === "\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      j++;
    }
    const callText = s.slice(m.index, j);
    if (evalZeroAlphaInMode(callText, 0, "light") || evalZeroAlphaInMode(callText, 0, "dark")) {
      return true;
    }
    out.push(" var(--_) ");
    i = j;
  }
  return hasBaseZeroAlphaColor(out.join(""));
}

function classifyOutlineDecl(propLower, rawVal) {
  const isImportant = /!\s*important\b/i.test(rawVal);
  const raw = String(rawVal || "");
  const cleaned = stripCssParens(raw);
  const tokens = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  if (propLower === "outline-style") {
    const inv = tokens.length === 0 || tokens.some((t) => /^(?:none|hidden|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["style"] : [] };
  }
  if (propLower === "outline-width") {
    const inv = tokens.length === 0 || tokens.some((t) => /^(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["width"] : [] };
  }
  if (propLower === "outline-color") {
    const inv = hasZeroAlphaColor(raw) || tokens.length === 0 || tokens.some((t) => /^(?:transparent|none|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["color"] : [] };
  }
  if (tokens.length === 1 && /^revert(?:-layer)?$/i.test(tokens[0])) {
    return { state: "visible", isImportant, suppressedProps: [] };
  }
  const badStyle = tokens.some((t) => /^(?:none|hidden|initial|inherit|unset)$/i.test(t));
  const zeroWidth = tokens.some((t) => /^(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?$/i.test(t));
  const badColor = hasZeroAlphaColor(raw) || tokens.some((t) => /^(?:transparent|initial|inherit|unset)$/i.test(t));
  const hasVisibleStyleKw = tokens.some((t) => /^(?:solid|dashed|dotted|double|groove|ridge|inset|outset|auto)$/i.test(t));
  const hasDynamicVal = /\bvar\s*\(|#\{|\$[a-zA-Z0-9_-]+/i.test(raw);
  const missingStyle = !hasVisibleStyleKw && !hasDynamicVal;
  const suppressedProps = [];
  if (badStyle || missingStyle || ((zeroWidth || (badColor && !/\bvar\s*\(/i.test(raw))) && !hasVisibleStyleKw)) {
    suppressedProps.push("style");
  }
  if (zeroWidth) suppressedProps.push("width");
  if (badColor) suppressedProps.push("color");
  const inv = tokens.length === 0 || badStyle || zeroWidth || badColor || missingStyle;
  return { state: inv ? "invisible" : "visible", isImportant, suppressedProps };
}

function normalizeOutlineCssProp(propKey) {
  const lk = String(propKey || "").trim().toLowerCase();
  if (lk === "outline") return "outline";
  if (lk === "outlinestyle" || lk === "outline-style") return "outline-style";
  if (lk === "outlinewidth" || lk === "outline-width") return "outline-width";
  if (lk === "outlinecolor" || lk === "outline-color") return "outline-color";
  return null;
}

function classifyBorderDecl(propLower, rawVal) {
  const isImportant = /!\s*important\b/i.test(rawVal);
  const raw = String(rawVal || "");
  const cleaned = stripCssParens(raw);
  const tokens = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  const zeroAlpha = hasZeroAlphaColor(raw);
  if (propLower === "border-style") {
    const inv = tokens.length === 0 || tokens.some((t) => /^(?:none|hidden|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["style"] : [] };
  }
  if (propLower === "border-width") {
    const inv = tokens.length === 0 || tokens.some((t) => /^(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["width"] : [] };
  }
  if (propLower === "border-color") {
    const inv = zeroAlpha || tokens.length === 0 || tokens.some((t) => /^(?:transparent|none|initial|inherit|unset)$/i.test(t));
    return { state: inv ? "invisible" : "visible", isImportant, suppressedProps: inv ? ["color"] : [] };
  }
  const badStyle = tokens.some((t) => /^(?:none|hidden|initial|inherit|unset)$/i.test(t));
  const zeroWidth = tokens.some((t) => /^(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?$/i.test(t));
  const badColor = zeroAlpha || tokens.some((t) => /^(?:transparent|initial|inherit|unset)$/i.test(t));
  const hasVisibleStyleKw = tokens.some((t) => /^(?:solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(t));
  const hasDynamicVal = /\bvar\s*\(|#\{|\$[a-zA-Z0-9_-]+/i.test(raw);
  const missingStyle = !hasVisibleStyleKw && !hasDynamicVal;
  const suppressedProps = [];
  if (badStyle || missingStyle || ((zeroWidth || (badColor && !/\bvar\s*\(/i.test(raw))) && !hasVisibleStyleKw)) {
    suppressedProps.push("style");
  }
  if (zeroWidth) suppressedProps.push("width");
  if (badColor) suppressedProps.push("color");
  const inv = tokens.length === 0 || badStyle || zeroWidth || badColor || missingStyle;
  return { state: inv ? "invisible" : "visible", isImportant, suppressedProps };
}

export function maskAtApplyDeclsPreservingLines(cssBody) {
  return String(cssBody || "").replace(
    /(?<![a-zA-Z0-9_$-])@apply\s+(?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+;?/gi,
    (m) => m.replace(/[^\n]/g, " ")
  );
}

export function findOutlineRemovals(body) {
  const masked = maskAtApplyDeclsPreservingLines(maskCssQuotedStringsPreservingLines(body));
  const out = [];
  for (const m of masked.matchAll(/(?<![a-zA-Z0-9_$-])(outline|outline-style|outline-width|outline-color)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const prop = m[1].toLowerCase();
    const rawVal = m[2];
    const info = classifyOutlineDecl(prop, rawVal);
    if (info.state === "invisible") {
      out.push({
        index: m.index,
        end: m.index + m[0].length,
        matchText: m[0].trimEnd(),
        prop,
        value: rawVal.trim(),
        isImportant: info.isImportant,
        suppressedProps: info.suppressedProps,
      });
    }
  }
  return out;
}

export function stripNotPseudo(sel) {
  const str = String(sel || "");
  let out = "";
  let i = 0;
  while (i < str.length) {
    if (str.slice(i, i + 5).toLowerCase() === ":not(") {
      let depth = 1;
      let q = null;
      let j = i + 5;
      while (j < str.length && depth > 0) {
        const c = str[j];
        if (q) {
          if (c === "\\" && j + 1 < str.length) j++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") {
          q = c;
        } else if (c === "(") {
          depth++;
        } else if (c === ")") {
          depth--;
        }
        j++;
      }
      i = j;
      continue;
    }
    out += str[i];
    i++;
  }
  return out;
}

export function extractSubjectSelector(sel) {
  const str = String(sel || "").trim();
  let paren = 0;
  let br = 0;
  let q = null;
  let lastSplit = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) {
      if (ch === "\\" && i + 1 < str.length) {
        i++;
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") br++;
    else if (ch === "]") br = Math.max(0, br - 1);
    else if (paren === 0 && br === 0 && /[\s>+~]/.test(ch)) {
      lastSplit = i;
    }
  }
  return str.slice(lastSplit + 1).trim();
}

export function splitTailwindVariants(token) {
  const clean = String(token || "").trim().replace(/^!+|!+$/g, "");
  const parts = [];
  let cur = "";
  let br = 0;
  let par = 0;
  let q = null;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && i + 1 < clean.length) {
        cur += clean[++i];
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === "[") {
      br++;
      cur += ch;
    } else if (ch === "]") {
      br = Math.max(0, br - 1);
      cur += ch;
    } else if (ch === "(") {
      par++;
      cur += ch;
    } else if (ch === ")") {
      par = Math.max(0, par - 1);
      cur += ch;
    } else if (ch === ":" && br === 0 && par === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  parts.pop();
  let focusKind = null;
  let hasInner = null;
  const condPrefixes = new Set();
  const targetPrefixes = new Set();
  let isSafeNotFocusVisible = false;
  const isTargetVariant = (v) => {
    if (v === "*" || v === "**") return true;
    if (!(v.startsWith("[") && v.endsWith("]"))) return false;
    const inner = v.slice(1, -1).replace(/"[^"]*"|'[^']*'/g, "");
    if (inner.trimStart().startsWith("@")) return false;
    let stripped = "";
    let brDepth = 0;
    let parDepth = 0;
    for (let j = 0; j < inner.length; j++) {
      const c = inner[j];
      if (c === "\\" && j + 1 < inner.length) {
        j++;
        continue;
      }
      if (c === "[") brDepth++;
      else if (c === "]") brDepth = Math.max(0, brDepth - 1);
      else if (c === "(") parDepth++;
      else if (c === ")") parDepth = Math.max(0, parDepth - 1);
      else if (brDepth === 0 && parDepth === 0) stripped += c;
    }
    return /(?:_|[>+~]|\s)/.test(stripped);
  };
  const unwrapOuterIsWhereLoop = (sel) => {
    let cur = String(sel || "").trim();
    while (true) {
      const m = /^:(is|where)\(/i.exec(cur);
      if (!m) break;
      let d = 1;
      let q = null;
      let k = m[0].length;
      while (k < cur.length && d > 0) {
        const ch = cur[k];
        if (q) {
          if (ch === "\\" && k + 1 < cur.length) k++;
          else if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") {
          q = ch;
        } else if (ch === "(") {
          d++;
        } else if (ch === ")") {
          d--;
          if (d === 0) break;
        }
        k++;
      }
      if (d !== 0 || k !== cur.length - 1) break;
      cur = cur.slice(m[0].length, k).trim();
    }
    return cur;
  };
  const extractTopLevelHasFocusArgs = (selStr) => {
    const str = String(selStr || "");
    const hasFocusArgs = [];
    const stripSpans = [];
    let q = null;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (q) {
        if (ch === "\\" && i + 1 < str.length) { i++; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === ":" && !(i > 0 && str[i - 1] === "\\") && /^:has\(/i.test(str.slice(i))) {
        const openIdx = i + 4;
        let depth = 1;
        let k = openIdx + 1;
        let nq = null;
        while (k < str.length && depth > 0) {
          const c = str[k];
          if (nq) {
            if (c === "\\" && k + 1 < str.length) { k += 2; continue; }
            if (c === nq) nq = null;
          } else if (c === '"' || c === "'") {
            nq = c;
          } else if (c === "(") {
            depth++;
          } else if (c === ")") {
            depth--;
            if (depth === 0) break;
          }
          k++;
        }
        if (depth === 0) {
          const arg = str.slice(openIdx + 1, k);
          if (/(?<!\\):focus(?:-visible|-within)?(?![a-z-])/i.test(stripNotPseudo(arg))) {
            hasFocusArgs.push(arg);
            stripSpans.push([i, k + 1]);
          }
          i = k;
          continue;
        }
      }
    }
    let outsideHasStr = "";
    let last = 0;
    for (const [s0, e0] of stripSpans) {
      outsideHasStr += str.slice(last, s0);
      last = e0;
    }
    outsideHasStr += str.slice(last);
    return { hasFocusArgs, outsideHasStr };
  };
  const isNotFvVariant = (v) => {
    const lv = v.toLowerCase();
    if (lv === "not-focus-visible" || lv === "not-[:focus-visible]" || lv === "not-(:focus-visible)") return true;
    if (!(lv.startsWith("[") && lv.endsWith("]")) || isTargetVariant(v)) return false;
    const body = lv.slice(1, -1);
    return /(?<!\\):not\(:focus-visible\)/i.test(body) && !/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(body));
  };
  const isTargetNotFvGuarded = (v) => {
    const lv = v.toLowerCase();
    if (!(lv.startsWith("[") && lv.endsWith("]"))) return false;
    const subj = extractSubjectSelector(lv.slice(1, -1).replace(/_/g, " "));
    return /(?<!\\):not\(:focus-visible\)/i.test(subj) && !/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(subj));
  };
  const splitTargetInnerSuffix = (rawInner) => {
    let br = 0;
    let par = 0;
    let q = null;
    let lastSplit = -1;
    for (let j = 0; j < rawInner.length; j++) {
      const c = rawInner[j];
      if (q) {
        if (c === "\\" && j + 1 < rawInner.length) j++;
        else if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === "[") {
        br++;
      } else if (c === "]") {
        br = Math.max(0, br - 1);
      } else if (c === "(") {
        par++;
      } else if (c === ")") {
        par = Math.max(0, par - 1);
      } else if (br === 0 && par === 0 && /(?:_|[>+~]|\s)/.test(c)) {
        lastSplit = j;
      }
    }
    return {
      prefix: rawInner.slice(0, lastSplit + 1),
      suffix: rawInner.slice(lastSplit + 1),
    };
  };
  for (const rawV of parts) {
    const v = rawV.replace(/^!+/, "");
    const lv = v.toLowerCase();
    if (/^focus-visible$/i.test(v)) {
      focusKind = "focus-visible";
    } else if (/^focus$/i.test(v)) {
      if (!focusKind) focusKind = "focus";
    } else if (/^focus-within$/i.test(v)) {
      if (!focusKind) focusKind = "focus-within";
    } else {
      const hasM = /^has-(?:\[(.*:focus(?:-visible|-within)?.*)\]|\((.*:focus(?:-visible|-within)?.*)\))$/i.exec(v);
      const hasShorthandM = !hasM ? /^has-(focus(?:-visible|-within)?)$/i.exec(v) : null;
      if (hasM || hasShorthandM) {
        if (!focusKind) {
          focusKind = "has-focus";
          hasInner = hasM ? (hasM[1] ?? hasM[2]) : `:${hasShorthandM[1].toLowerCase()}`;
        }
      } else if (isTargetVariant(v)) {
        const targNotFv = isTargetNotFvGuarded(v);
        isSafeNotFocusVisible = targNotFv;
        if (!targNotFv && lv.startsWith("[") && lv.endsWith("]") && !lv.slice(1, -1).trimStart().startsWith("@")) {
          const { prefix, suffix } = splitTargetInnerSuffix(lv.slice(1, -1));
          const sufNoNot = stripNotPseudo(suffix);
          const sufHasHoverOrActive = /(?<!\\):(?:hover|active)(?![a-zA-Z0-9_-])/i.test(sufNoNot);
          const sufHasFv = /(?<!\\):focus-visible(?![a-z-])/i.test(sufNoNot);
          const sufHasF = !sufHasFv && /(?<!\\):focus(?![a-z-])/i.test(sufNoNot);
          if (!sufHasHoverOrActive && (sufHasFv || sufHasF)) {
            if (sufHasFv) focusKind = "focus-visible";
            else if (!focusKind) focusKind = "focus";
            const cleanSuffix = suffix.replace(/(?<!\\):focus(?:-visible)?(?![a-z-])/gi, "");
            targetPrefixes.add(`[${prefix}${cleanSuffix}]`);
          } else {
            targetPrefixes.add(lv);
          }
        } else {
          targetPrefixes.add(lv);
        }
      } else if (v.startsWith("[") && v.endsWith("]") && !v.slice(1, -1).trimStart().startsWith("@")) {
        if (isNotFvVariant(v)) isSafeNotFocusVisible = true;
        const inner = lv.slice(1, -1).trim();
        const innerNoNot = stripNotPseudo(inner);
        const hasExt = extractTopLevelHasFocusArgs(innerNoNot);
        const outsideHasFv = /(?<!\\):focus-visible(?![a-z-])/i.test(hasExt.outsideHasStr);
        const outsideHasF = !outsideHasFv && /(?<!\\):focus(?![a-z-])/i.test(hasExt.outsideHasStr);
        const outsideHasFw = !outsideHasFv && !outsideHasF && /(?<!\\):focus-within(?![a-z-])/i.test(hasExt.outsideHasStr);
        if (hasExt.hasFocusArgs.length > 0 && !outsideHasFv && !outsideHasF && !outsideHasFw) {
          if (!focusKind) {
            focusKind = "has-focus";
            hasInner = hasExt.hasFocusArgs.join(",");
          }
          const rawHasExt = extractTopLevelHasFocusArgs(inner);
          const remRaw = rawHasExt.outsideHasStr.trim();
          if (remRaw.replace(/[&\s,]/g, "") !== "") {
            condPrefixes.add(`[${remRaw}]`);
          }
        } else {
          const innerHasFv = /(?<!\\):focus-visible(?![a-z-])/i.test(innerNoNot);
          const innerHasF = !innerHasFv && /(?<!\\):focus(?![a-z-])/i.test(innerNoNot);
          const innerHasFw = !innerHasFv && !innerHasF && /(?<!\\):focus-within(?![a-z-])/i.test(innerNoNot);
          if (innerHasFv || innerHasF || innerHasFw) {
            if (innerHasFv) focusKind = "focus-visible";
            else if (!focusKind) focusKind = innerHasF ? "focus" : "focus-within";
            const hasPureFocusBranch = splitTopLevelCommas(inner).some((br) => {
              const brNoAmp = br.trim().replace(/^&+/, "").trim();
              const unwrapped = unwrapOuterIsWhereLoop(brNoAmp);
              return splitTopLevelCommas(unwrapped).some((sub) => {
                const subNoAmp = unwrapOuterIsWhereLoop(sub.trim().replace(/^&+/, "").trim());
                return subNoAmp.replace(/(?<!\\):focus(?:-visible|-within)?(?![a-z-])/gi, "").replace(/[&\s,]/g, "") === "";
              });
            });
            if (!hasPureFocusBranch) {
              const remKey = `[${inner.replace(/(?<!\\):focus(?:-visible|-within)?(?![a-z-])/gi, "")}]`;
              condPrefixes.add(remKey);
            }
          } else {
            condPrefixes.add(lv);
          }
        }
      } else {
        if (isNotFvVariant(v)) isSafeNotFocusVisible = true;
        condPrefixes.add(lv);
      }
    }
  }
  return { focusKind, hasInner, condPrefixes, targetPrefixes, isSafeNotFocusVisible: isSafeNotFocusVisible && focusKind !== "focus-visible" };
}

const TW_NESTED_BRACKET = "\\[(?:[^\\[\\]\\s`;]|\\[[^\\[\\]\\s`;]*\\])+\\]";
const TW_NESTED_PAREN = "\\((?:[^()\\s`;]|\\([^()\\s`;]*\\))+\\)";
export const TW_VARIANT_SEG = `(?:(?:\\*{1,2}|@?${TW_NESTED_BRACKET}|@?[a-zA-Z0-9_-]+(?:-(?:${TW_NESTED_BRACKET}|${TW_NESTED_PAREN}))?)(?:/[a-zA-Z0-9_-]+)?):`;
export const TW_TRANS_ALL_CORE = `(?:transition-all|transition-\\[[^\\]\\s\`;]*?(?<![a-zA-Z0-9-])all(?![a-zA-Z0-9-])[^\\]\\s\`;]*\\]|\\[transition(?:-property)?:[^\\]\\s\`;]*?(?<![a-zA-Z0-9-])all(?![a-zA-Z0-9-])[^\\]\\s\`;]*\\])`;
export const TW_VW_CORE = `(?:(?:min-|max-)?w-screen(?![a-zA-Z0-9_-])|(?:min-|max-)?(?:w|size)-\\[[^\\]\\s\`;]*?(?<![a-zA-Z0-9]|[a-zA-Z0-9]-)100vw(?![a-zA-Z0-9]|-[a-zA-Z])[^\\]\\s\`;]*\\]|\\[(?:min-|max-)?(?:width|inline-size):[^\\]\\s\`;]*?(?<![a-zA-Z0-9]|[a-zA-Z0-9]-)100vw(?![a-zA-Z0-9]|-[a-zA-Z])[^\\]\\s\`;]*\\])`;
const TW_SHADOW_VIS_BODY = `(?:shadow-${TW_NESTED_BRACKET}|\\[box-shadow:[^\\]\\s\`;]+\\])`;
const TW_ZERO_LEN_OR_NONE = "(?:(?:length|color):)?(?:(?:0(?:\\.0+)?|\\.0+)(?:px|rem|em|vw|vh|%)?|none|hidden|transparent)";
const TW_ZERO_ALPHA_MOD = "(?:\\/(?:(?:0(?:\\.0+)?|\\.0+)%?|\\[(?:0(?:\\.0+)?|\\.0+)%?\\]))";
const TW_OUTLINE_REM_BODY = `(?:outline-(?:none|0|hidden|transparent|opacity-(?:0+(?:\\.0+)?|\\[(?:0+(?:\\.0+)?|\\.0+)%?\\])|${TW_NESTED_BRACKET}${TW_ZERO_ALPHA_MOD}?|(?!offset-)[^\\s"'\`;/]+${TW_ZERO_ALPHA_MOD})|\\[outline(?:-(?:style|width|color))?:(?:${TW_ZERO_LEN_OR_NONE}|[^\\]\\s\`;]+)\\])`;
const TW_VAL_CHAR = "(?:[a-zA-Z0-9_/.#%-]|\\[[^\\s\"'`;\\]]+\\]|\\([^\\s\"'`;)]+\\))+";
const TW_BORDER_VIS_BODY =
  `(?:border(?![a-zA-Z0-9_-])|border-(?!none\\b|0\\b|transparent\\b|hidden\\b|collapse\\b|separate\\b|spacing-|opacity-|\\[${TW_ZERO_LEN_OR_NONE}\\])${TW_VAL_CHAR}|\\[border(?:-[trblxyse])?(?:-(?:style|width|color))?:(?!${TW_ZERO_LEN_OR_NONE}\\])[^\\]\\s\`;]+\\])`;
const TW_RING_VIS_BODY =
  `(?:(?:inset-)?ring(?![a-zA-Z0-9_-])|(?:inset-)?ring-(?!0\\b|none\\b|transparent\\b|offset-|inset\\b|opacity-|\\[${TW_ZERO_LEN_OR_NONE}\\])${TW_VAL_CHAR})`;
const TW_OUTLINE_VIS_BODY =
  `(?:outline(?![a-zA-Z0-9_-])|outline-(?!none\\b|0\\b|hidden\\b|transparent\\b|offset-|opacity-|\\[${TW_ZERO_LEN_OR_NONE}\\])${TW_VAL_CHAR}|\\[outline(?:-(?:style|width|color))?:(?!${TW_ZERO_LEN_OR_NONE}\\])[^\\]\\s\`;]+\\])`;
const TW_ARB_COLOR_PREFIX_RE =
  "(?:bg|text|border(?:-(?:t|r|b|l|x|y|s|e))?|divide|fill|stroke|(?:inset-)?ring(?:-offset)?|from|to|via|accent|outline|decoration|shadow|caret|placeholder)";

function parseSimpleCompoundAtoms(rawSel) {
  const s = String(rawSel || "")
    .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
    .trim()
    .toLowerCase();
  if (!s) return [];
  const atoms = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "*") {
      i++;
      continue;
    }
    if (ch === "[") {
      let q = null;
      let k = i + 1;
      while (k < s.length) {
        const bc = s[k];
        if (q) {
          if (bc === "\\" && k + 1 < s.length) k++;
          else if (bc === q) q = null;
        } else if (bc === '"' || bc === "'") q = bc;
        else if (bc === "]") {
          k++;
          break;
        }
        k++;
      }
      atoms.push(s.slice(i, k).replace(/\s+/g, " "));
      i = k;
      continue;
    }
    if (ch === "." || ch === "#") {
      const m = /^[.#](?:\\.|[a-z0-9_-])+/i.exec(s.slice(i));
      if (!m) return null;
      atoms.push(m[0]);
      i += m[0].length;
      continue;
    }
    if (ch === ":") {
      if (s[i + 1] === ":") return null;
      const m = /^:[a-z0-9_-]+(?:\([^)]*\))?/i.exec(s.slice(i));
      if (!m) return null;
      if (/^:(?:is|where|not|has)\(/i.test(m[0])) return null;
      atoms.push(m[0]);
      i += m[0].length;
      continue;
    }
    if (/[a-z_-]/i.test(ch) && i === 0) {
      const m = /^[a-z][a-z0-9_-]*/i.exec(s);
      if (!m) return null;
      atoms.push(`tag:${m[0]}`);
      i += m[0].length;
      continue;
    }
    return null;
  }
  return atoms;
}

function selectorCoversSubject(repSubj, remSubj) {
  const repClean = String(repSubj || "")
    .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
    .trim()
    .toLowerCase();
  const remClean = String(remSubj || "")
    .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
    .trim()
    .toLowerCase();
  if (!repClean || repClean === "*") return true;
  if (repClean === remClean) return true;
  const repAtoms = parseSimpleCompoundAtoms(repClean);
  const remAtoms = parseSimpleCompoundAtoms(remClean);
  if (!repAtoms || !remAtoms || repAtoms.length === 0) return false;
  const remSet = new Set(remAtoms);
  return repAtoms.every((a) => remSet.has(a));
}

function unwrapOuterIsWhere(sel) {
  const trS = String(sel || "").trim();
  const m = /^:(is|where)\(/i.exec(trS);
  if (!m) return null;
  let d = 1;
  let q = null;
  let k = m[0].length;
  while (k < trS.length && d > 0) {
    const ch = trS[k];
    if (q) {
      if (ch === "\\" && k + 1 < trS.length) k++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === "(") {
      d++;
    } else if (ch === ")") {
      d--;
      if (d === 0) break;
    }
    k++;
  }
  if (d !== 0 || k !== trS.length - 1) return null;
  return trS.slice(m[0].length, k);
}

function hasTopLevelCssCombinator(selPart) {
  const str = String(selPart || "").trim();
  let p = 0;
  let b = 0;
  let q = null;
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
    else if (p === 0 && b === 0 && /[\s>+~]/.test(ch)) return true;
  }
  return false;
}

function expandTopLevelIsWhereBranches(sel, maxBranches = 24) {
  const s = String(sel || "");
  if (!/:(?:is|where)\(/i.test(s)) return [s];
  let q = null;
  let brack = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (q) {
      if (ch === "\\" && i + 1 < s.length) { i += 2; continue; }
      if (ch === q) q = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "[") { brack++; i++; continue; }
    if (ch === "]" && brack > 0) { brack--; i++; continue; }
    if (brack === 0 && ch === ":") {
      const mIs = /^:(is|where)\(/i.exec(s.slice(i));
      if (mIs) {
        const openIdx = i + mIs[0].length - 1;
        let d = 1;
        let pq = null;
        let pbr = 0;
        let k = openIdx + 1;
        while (k < s.length && d > 0) {
          const pc = s[k];
          if (pq) {
            if (pc === "\\" && k + 1 < s.length) k++;
            else if (pc === pq) pq = null;
          } else if (pc === "\\" && k + 1 < s.length) {
            k++;
          } else if (pc === '"' || pc === "'") {
            pq = pc;
          } else if (pc === "[") {
            pbr++;
          } else if (pc === "]" && pbr > 0) {
            pbr--;
          } else if (pbr === 0) {
            if (pc === "(") d++;
            else if (pc === ")") d--;
          }
          k++;
        }
        if (d === 0) {
          const closeIdx = k - 1;
          const inner = s.slice(openIdx + 1, closeIdx);
          const parts = splitTopLevelCommas(inner).map((pt) => pt.trim()).filter(Boolean);
          if (parts.length >= 2) {
            const prefix = s.slice(0, i);
            const suffix = s.slice(closeIdx + 1);
            const nonCombPrefix = prefix.length > 0 && !/[\s>+~]$/.test(prefix);
            if (!(nonCombPrefix && parts.some((pt) => hasTopLevelCssCombinator(pt)))) {
              if (parts.length > maxBranches) return [s];
              const expanded = [];
              for (const pt of parts) {
                const candidate = `${prefix}${pt}${suffix}`;
                const sub = expandTopLevelIsWhereBranches(candidate, maxBranches - expanded.length);
                for (const item of sub) {
                  expanded.push(item);
                  if (expanded.length > maxBranches) return [s];
                }
              }
              return expanded.length > 0 ? expanded : [s];
            }
          }
          i = closeIdx + 1;
          continue;
        }
      } else {
        const mFn = /^:[a-z-]+\(/i.exec(s.slice(i));
        if (mFn) {
          const openIdx = i + mFn[0].length - 1;
          let d = 1;
          let pq = null;
          let pbr = 0;
          let k = openIdx + 1;
          while (k < s.length && d > 0) {
            const pc = s[k];
            if (pq) {
              if (pc === "\\" && k + 1 < s.length) k++;
              else if (pc === pq) pq = null;
            } else if (pc === "\\" && k + 1 < s.length) {
              k++;
            } else if (pc === '"' || pc === "'") {
              pq = pc;
            } else if (pc === "[") {
              pbr++;
            } else if (pc === "]" && pbr > 0) {
              pbr--;
            } else if (pbr === 0) {
              if (pc === "(") d++;
              else if (pc === ")") d--;
            }
            k++;
          }
          if (d === 0) {
            i = k;
            continue;
          }
        }
      }
    }
    i++;
  }
  return [s];
}

function branchSubjectsCoversTarget(repBranchSubj, remTargetSubj) {
  const tr = String(repBranchSubj || "")
    .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
    .trim()
    .toLowerCase();
  const remTr = String(remTargetSubj || "")
    .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
    .trim()
    .toLowerCase();
  const repInner = unwrapOuterIsWhere(tr);
  if (repInner !== null) {
    return splitTopLevelCommas(repInner).some((ib) => branchSubjectsCoversTarget(extractSubjectSelector(ib.trim()), remTr));
  }
  const remInner = unwrapOuterIsWhere(remTr);
  if (remInner !== null) {
    const remBranches = splitTopLevelCommas(remInner).map((ib) => ib.trim()).filter(Boolean);
    return remBranches.length > 0 && remBranches.every((ib) => branchSubjectsCoversTarget(tr, extractSubjectSelector(ib)));
  }
  return selectorCoversSubject(tr, remTr);
}

function isArbitraryFocusSpecInvisible(utilName, inner) {
  const rawDecoded = String(inner || "").replace(/_/g, " ").trim();
  if (!rawDecoded) return true;
  const hintM = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(rawDecoded);
  const valStr = hintM ? hintM[2].trim() : rawDecoded;
  if (hasZeroAlphaColor(valStr)) return true;
  if (/^(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|none|hidden|transparent|initial|inherit|unset)$/i.test(valStr)) {
    return true;
  }
  const lowerProp = String(utilName || "").toLowerCase();
  if (/^(?:outline|border(?:-[trblxyse])?|(?:inset-)?ring)$/.test(lowerProp)) {
    const stripped = stripCssParens(valStr);
    const tokens = stripped ? stripped.split(/\s+/).filter(Boolean) : [];
    if (
      tokens.some((t) =>
        /^(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|none|hidden|transparent|initial|inherit|unset)$/i.test(t)
      )
    ) {
      return true;
    }
  }
  return false;
}

export function getTwUtilityPart(tok) {
  const rawTok = String(tok || "").trim();
  let br = 0;
  let par = 0;
  let q = null;
  let lastColon = -1;
  for (let i = 0; i < rawTok.length; i++) {
    const c = rawTok[i];
    if (q) {
      if (c === "\\" && i + 1 < rawTok.length) i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "[") br++;
    else if (c === "]") br = Math.max(0, br - 1);
    else if (c === "(") par++;
    else if (c === ")") par = Math.max(0, par - 1);
    else if (c === ":" && br === 0 && par === 0) lastColon = i;
  }
  return (lastColon === -1 ? rawTok : rawTok.slice(lastColon + 1)).replace(/^!+|!+$/g, "");
}

export function isInvisibleTwFocusUtility(tok) {
  const util = getTwUtilityPart(tok);
  if (/^border-(?:t|r|b|l|x|y|s|e)-(?:0|none|hidden|transparent|\[(?:(?:length|color):)?(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|none|hidden|transparent)\])$/i.test(util)) {
    return true;
  }
  if (/^(?:(?:inset-)?ring|border|outline)-(?:0|none|hidden|transparent)$/i.test(util)) {
    return true;
  }
  if (/^(?:(?:inset-)?ring|border|outline)-\[(?:(?:length|color):)?(?:(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?|none|hidden|transparent)\]$/i.test(util)) {
    return true;
  }
  if (/^(?:(?:inset-)?ring|border|outline)-opacity-(?:0+(?:\.0+)?|\[(?:0+(?:\.0+)?|\.0+)%?\])$/i.test(util)) return true;
  if (/\/(?:(?:0(?:\.0+)?|\.0+)%?|\[(?:0(?:\.0+)?|\.0+)%?\])$/.test(util)) return true;
  const arbPropM = /^\[(outline|border(?:-[trblxyse])?|(?:inset-)?ring)(?:-(?:style|width|color))?:([^\]]+)\]$/i.exec(util);
  if (arbPropM) {
    return isArbitraryFocusSpecInvisible(arbPropM[1], arbPropM[2]);
  }
  const propM = /^(outline|border(?:-[trblxyse])?|(?:inset-)?ring)(?=-|$)/i.exec(util);
  const utilProp = propM ? propM[1] : "";
  for (const bm of util.matchAll(/\[([^\]]+)\]/g)) {
    if (isArbitraryFocusSpecInvisible(utilProp, bm[1])) return true;
  }
  if (/^shadow-none$/i.test(util)) return true;
  const shadowBracketM = /^(?:shadow-\[([^\]]+)\]|\[box-shadow:([^\]]+)\])$/i.exec(util);
  if (shadowBracketM) {
    const rawShadow = (shadowBracketM[1] || shadowBracketM[2] || "").replace(/_/g, " ").trim();
    if (!rawShadow) return true;
    const layers = splitTopLevelCommas(rawShadow).filter(Boolean);
    return layers.length === 0 || !layers.some((l) => isBoxShadowLayerVisible(l));
  }
  return false;
}

function isTwOutlineRemoval(tok) {
  const util = getTwUtilityPart(tok);
  if (/^outline-offset-/i.test(util)) return false;
  if (/^outline-/i.test(util) || /^\[outline(?:-(?:style|width|color))?:/i.test(util)) {
    return isInvisibleTwFocusUtility(tok);
  }
  return false;
}

function hasArgCoversTargets(hasInner, targetPrefixes) {
  if (!hasInner || !targetPrefixes || targetPrefixes.size === 0) return false;
  const decoded = String(hasInner).replace(/_/g, " ");
  const hasUniversalStar = targetPrefixes.has("*") || targetPrefixes.has("**");
  const arbSubjects = [...targetPrefixes]
    .filter((tp) => tp.startsWith("[") && tp.endsWith("]"))
    .map((tp) => extractSubjectSelector(tp.slice(1, -1).replace(/_/g, " ").replace(/^&+/, "")).toLowerCase())
    .filter(Boolean);
  for (const br of splitTopLevelCommas(decoded)) {
    const cleanBr = stripNotPseudo(br).trim();
    if (/(?<!\\):(?:hover|active)(?![a-zA-Z0-9_-])/i.test(cleanBr)) continue;
    if (!/:focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/i.test(cleanBr)) continue;
    const withoutFocus = cleanBr
      .replace(/:focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
      .replace(/^[>+~\s]+/, "")
      .trim();
    if (!withoutFocus || withoutFocus === "*") return true;
    if (hasUniversalStar) continue;
    const hbSubj = extractSubjectSelector(withoutFocus).toLowerCase();
    if (arbSubjects.length > 0 && arbSubjects.every((as) => branchSubjectsCoversTarget(hbSubj, as))) {
      return true;
    }
  }
  return false;
}

function stripTrailingTwAlphaModifier(util) {
  const s = String(util || "");
  let br = 0;
  let par = 0;
  let splitIdx = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[") br++;
    else if (ch === "]") br = Math.max(0, br - 1);
    else if (ch === "(") par++;
    else if (ch === ")") par = Math.max(0, par - 1);
    else if (ch === "/" && br === 0 && par === 0) splitIdx = i;
  }
  if (splitIdx === -1) return { bare: s, alphaMod: "" };
  return { bare: s.slice(0, splitIdx), alphaMod: s.slice(splitIdx + 1) };
}

function classifyTwRingOrBorder(tok) {
  const util = getTwUtilityPart(tok).toLowerCase();
  const isArbitraryProp = /^\[/.test(util);
  if (/^shadow(?:-|$)/.test(util) || /^\[box-shadow:/.test(util)) {
    if (/^shadow-none$/.test(util) || isInvisibleTwFocusUtility(tok)) {
      return { family: "shadow", side: "", isArbitraryProp, killsWidth: true, killsStyle: true, killsColor: true, setsWidth: false, setsStyle: false, setsColor: false };
    }
    if (/^shadow-\[/.test(util) || /^\[box-shadow:/.test(util)) {
      return { family: "shadow", side: "", isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: false, setsWidth: true, setsStyle: true, setsColor: true };
    }
    return null;
  }
  const arbPm = /^\[(inset-ring|ring|border|outline)(?:-(t|r|b|l|x|y|s|e))?(?:-(style|width|color))?:([^\]]+)\]$/.exec(util);
  const pm = arbPm ? [arbPm[0], arbPm[1]] : /^(inset-ring|ring|border|outline)(?:-|$)/.exec(util);
  if (!pm) return null;
  const family = pm[1];
  const sideM = arbPm ? null : family === "border" ? /^border-(t|r|b|l|x|y|s|e)(?=-|$)/.exec(util) : null;
  const side = arbPm && arbPm[2] ? arbPm[2] : sideM ? sideM[1] : "";
  const subProp = arbPm && arbPm[3] ? arbPm[3] : null;
  if (!arbPm) {
    if ((family === "ring" || family === "inset-ring") && /^(?:inset-)?ring-(?:offset-|inset\b)/i.test(util)) return null;
    if (family === "border" && /^border-(?:collapse|separate|spacing-)/i.test(util)) return null;
    if (family === "outline" && /^outline-offset-/i.test(util)) return null;
  }
  if (isInvisibleTwFocusUtility(tok)) {
    if (arbPm) {
      const inner = arbPm[4].replace(/_/g, " ").trim();
      const hasZeroCol = hasZeroAlphaColor(inner) || /\btransparent\b/i.test(inner);
      const hasNoneKw = /(?:^|\s)(?:none|hidden)(?=$|\s)/i.test(inner);
      const hasZeroLen = /(?:^|\s)(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?(?=$|\s)/i.test(inner);
      const killsColor = subProp === "color" || (!subProp && hasZeroCol);
      const killsStyle = subProp === "style" || (!subProp && hasNoneKw);
      const killsWidth = subProp === "width" || (!subProp && (hasZeroLen || hasNoneKw || (!hasZeroCol && !hasNoneKw)));
      return { family, side, isArbitraryProp, killsWidth, killsStyle, killsColor, setsWidth: false, setsStyle: false, setsColor: false };
    }
    if (/^(?:(?:inset-)?ring|border|outline)-opacity-/i.test(util)) {
      if (/^(?:(?:inset-)?ring|border|outline)-opacity-(?:0(?:\.0+)?|\.0+|\[(?:0(?:\.0+)?|\.0+)%?\])$/i.test(util)) {
        return { family, side, isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: true, setsWidth: false, setsStyle: false, setsColor: false };
      }
      return null;
    }
    const { bare: noAlphaMod, alphaMod } = stripTrailingTwAlphaModifier(util);
    const hasZeroMod = Boolean(alphaMod) && /^(?:0(?:\.0+)?|\.0+|\[(?:0(?:\.0+)?|\.0+)%?\])$/.test(alphaMod);
    const isTransparentKw = /^(?:(?:inset-)?ring|border|outline)(?:-[trblxyse])?-transparent$/i.test(noAlphaMod);
    const isNoneStyleKw = /^(?:(?:inset-)?ring|border|outline)(?:-[trblxyse])?-(?:none|hidden)$/i.test(noAlphaMod);
    const isZeroWidthKw = /^(?:(?:inset-)?ring|border|outline)(?:-[trblxyse])?-(?:0|none|hidden)$/i.test(noAlphaMod);
    let killsWidth = isZeroWidthKw;
    let killsStyle = isNoneStyleKw;
    let killsColor = isTransparentKw || hasZeroMod;
    const bm = /\[([^\]]+)\]/.exec(noAlphaMod);
    if (bm) {
      const inner = bm[1].replace(/_/g, " ").trim().replace(/^[a-z-]+:\s*/i, "");
      if (hasZeroAlphaColor(inner) || /\btransparent\b/i.test(inner)) killsColor = true;
      if (/(?:^|\s)(?:none|hidden)(?=$|\s)/i.test(inner)) killsStyle = true;
      if (/(?:^|\s)(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|%)?(?=$|\s)|(?:^|\s)(?:none|hidden)(?=$|\s)/i.test(inner)) killsWidth = true;
      if (!killsWidth && !killsColor && !killsStyle) killsWidth = true;
    }
    if (!killsWidth && !killsColor && !killsStyle) killsWidth = true;
    return { family, side, isArbitraryProp, killsWidth, killsStyle, killsColor, setsWidth: false, setsStyle: false, setsColor: false };
  }
  if (arbPm) {
    if (subProp === "style") return { family, side, isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: false, setsWidth: false, setsStyle: true, setsColor: false };
    if (subProp === "width") return { family, side, isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: false, setsWidth: true, setsStyle: false, setsColor: false };
    if (subProp === "color") return { family, side, isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: false, setsWidth: false, setsStyle: false, setsColor: true };
    const inner = arbPm[4].replace(/_/g, " ").trim();
    const tokens = stripCssParens(inner).split(/\s+/).filter(Boolean);
    const hasStyleKw = tokens.some((t) => /^(?:solid|dashed|dotted|double|groove|ridge|inset|outset|auto)$/i.test(t));
    const hasLen = /^length:/i.test(inner) || tokens.some((t) => /^(?:\d|\.\d)/.test(t));
    const hasCol = /^color:/i.test(inner) || tokens.some((t) => !/^(?:length:|\d|\.\d|solid|dashed|dotted|double|groove|ridge|inset|outset|auto)$/i.test(t));
    return {
      family,
      side,
      isArbitraryProp,
      killsWidth: false,
      killsStyle: false,
      killsColor: false,
      setsWidth: hasLen || tokens.length === 0,
      setsStyle: hasStyleKw || ((family === "ring" || family === "inset-ring") && hasLen) || tokens.length === 0,
      setsColor: hasCol,
    };
  }
  const { bare } = stripTrailingTwAlphaModifier(util);
  let setsWidth = false;
  let setsStyle = false;
  let setsColor = false;
  if (family === "ring" || family === "inset-ring") {
    const ringTail = bare.replace(/^(?:inset-)?ring/, "");
    if (/^(?:-(?:1|2|4|8|\d+))?$/i.test(ringTail) || /^-\(length:--[^)]+\)$/i.test(ringTail)) {
      setsWidth = true;
      setsStyle = true;
    } else if (/^-\[([^\]]+)\]$/.test(ringTail)) {
      const inner = ringTail.slice(2, -1).replace(/_/g, " ").trim();
      const tokens = stripCssParens(inner).split(/\s+/).filter(Boolean);
      const hasLen = /^length:/i.test(inner) || tokens.some((t) => /^(?:\d|\.\d)/.test(t));
      const hasCol = /^color:/i.test(inner) || tokens.some((t) => !/^(?:length:|\d|\.\d)/.test(t));
      setsWidth = hasLen || tokens.length === 0;
      setsStyle = setsWidth;
      setsColor = hasCol;
    } else {
      setsColor = true;
    }
  } else if (family === "outline") {
    if (/^outline(?:-\d+)?$/i.test(bare) || /^outline-\(length:--[^)]+\)$/i.test(bare)) {
      setsWidth = true;
      setsStyle = true;
    } else if (/^outline-(?:solid|dashed|dotted|double)$/i.test(bare)) {
      setsStyle = true;
    } else if (/^outline-\[([^\]]+)\]$/.test(bare)) {
      const inner = bare.slice(9, -1).replace(/_/g, " ").trim();
      const tokens = stripCssParens(inner).split(/\s+/).filter(Boolean);
      const hasLen = /^length:/i.test(inner) || tokens.some((t) => /^(?:\d|\.\d)/.test(t));
      const hasStyleKw = tokens.some((t) => /^(?:solid|dashed|dotted|double|auto)$/i.test(t));
      const hasCol = /^color:/i.test(inner) || tokens.some((t) => !/^(?:length:|\d|\.\d|solid|dashed|dotted|double|auto)/i.test(t));
      setsWidth = hasLen || tokens.length === 0;
      setsStyle = hasStyleKw || tokens.length === 0;
      setsColor = hasCol;
    } else {
      setsColor = true;
    }
  } else {
    if (/^border(?:-(?:t|r|b|l|x|y|s|e))?$/i.test(bare) || /^border(?:-(?:t|r|b|l|x|y|s|e))?-\(length:--[^)]+\)$/i.test(bare)) {
      setsWidth = true;
      setsStyle = true;
    } else if (/^border(?:-(?:t|r|b|l|x|y|s|e))?-\d+$/i.test(bare)) {
      setsWidth = true;
    } else if (/^border(?:-(?:t|r|b|l|x|y|s|e))?-(?:solid|dashed|dotted|double)$/i.test(bare)) {
      setsStyle = true;
    } else if (/^border(?:-[trblxyse])?-\[([^\]]+)\]$/.test(bare)) {
      const inner = bare.replace(/^border(?:-[trblxyse])?-\[/, "").slice(0, -1).replace(/_/g, " ").trim();
      const tokens = stripCssParens(inner).split(/\s+/).filter(Boolean);
      const hasLen = /^length:/i.test(inner) || tokens.some((t) => /^(?:\d|\.\d)/.test(t));
      const hasStyleKw = tokens.some((t) => /^(?:solid|dashed|dotted|double)$/i.test(t));
      const hasCol = /^color:/i.test(inner) || tokens.some((t) => !/^(?:length:|\d|\.\d|solid|dashed|dotted|double)/i.test(t));
      setsWidth = hasLen || tokens.length === 0;
      setsStyle = hasStyleKw || tokens.length === 0;
      setsColor = hasCol;
    } else {
      setsColor = true;
    }
  }
  return { family, side, isArbitraryProp, killsWidth: false, killsStyle: false, killsColor: false, setsWidth, setsStyle, setsColor };
}

export function analyzeTailwindOutline(classes, extraReplacementClasses = "", prevSameRuleClasses = "", options = {}) {
  const s = String(classes || "");
  const forceMainImportant = Boolean(options?.forceMainImportant);
  const twOutlineRemovalAllRe = new RegExp(`(?:^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_OUTLINE_REM_BODY}!?)(?=$|[\\s;])`, "g");
  const twFocusReplacementRe = new RegExp(
    `(?:^|\\s)(!?(?:${TW_VARIANT_SEG})+!?(?:${TW_RING_VIS_BODY}|${TW_OUTLINE_VIS_BODY}|${TW_BORDER_VIS_BODY}|${TW_SHADOW_VIS_BODY})!?)(?=$|[\\s;])`,
    "g"
  );
  const twRingBorderAllRe = new RegExp(
    `(?:^|\\s)(!?(?:${TW_VARIANT_SEG})*!?(?:(?:inset-ring|ring|border|outline|shadow)(?:-[^\\s"'\`;]+)?|\\[(?:inset-ring|ring|border(?:-[trblxyse])?|outline|box-shadow)(?:-(?:style|width|color))?:[^\\]\\s\`;]+\\])!?)(?=$|[\\s;])`,
    "g"
  );
  const removals = [];
  for (const m of s.matchAll(twOutlineRemovalAllRe)) {
    const tokStr = m[1];
    if (!isTwOutlineRemoval(tokStr)) continue;
    const tokIdx = m.index + m[0].lastIndexOf(tokStr);
    removals.push({
      tokStr,
      tokIdx,
      isImportant: forceMainImportant || /(?:^|:)!|!$/.test(tokStr),
      ...splitTailwindVariants(tokStr),
    });
  }
  if (removals.length === 0) return { hasRemoval: false, naked: false, firstRemoval: null, uncovered: [] };
  const SOURCE_RANK = { prev: 0, main: 1, after: 2 };
  const cmpPos = (a, b) => {
    const sr = (SOURCE_RANK[a.fromSource] ?? 1) - (SOURCE_RANK[b.fromSource] ?? 1);
    return sr !== 0 ? sr : a.tokIdx - b.tokIdx;
  };
  const replacements = [];
  const rbEvents = [];
  const collectRepls = (chunk, fromSource) => {
    const chunkStr = String(chunk || "");
    if (!chunkStr) return;
    const impMain = fromSource === "main" && forceMainImportant;
    for (const m of chunkStr.matchAll(twFocusReplacementRe)) {
      const tok = m[1];
      if (isInvisibleTwFocusUtility(tok)) continue;
      const info = splitTailwindVariants(tok);
      if (info.focusKind !== "focus" && info.focusKind !== "focus-visible" && info.focusKind !== "focus-within" && info.focusKind !== "has-focus") continue;
      const tokIdx = m.index + m[0].lastIndexOf(tok);
      replacements.push({
        tokIdx,
        fromSource,
        isImportant: impMain || /(?:^|:)!|!$/.test(tok),
        isOutlineProp: /(?:^|:)!?(?:outline(?:-|$|!)|\[outline(?:-(?:style|width|color))?:)/i.test(tok),
        rbInfo: classifyTwRingOrBorder(tok),
        ...info,
      });
    }
    for (const m of chunkStr.matchAll(twRingBorderAllRe)) {
      const tok = m[1];
      const rbInfo = classifyTwRingOrBorder(tok);
      if (!rbInfo) continue;
      const info = splitTailwindVariants(tok);
      const tokIdx = m.index + m[0].lastIndexOf(tok);
      rbEvents.push({
        tokIdx,
        fromSource,
        isImportant: impMain || /(?:^|:)!|!$/.test(tok),
        ...rbInfo,
        ...info,
      });
    }
  };
  collectRepls(s, "main");
  collectRepls(prevSameRuleClasses, "prev");
  collectRepls(extraReplacementClasses, "after");
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const condSubset = (sub, sup) => [...sub].every((c) => sup.has(c));
  const BORDER_SIDE_MAP = {
    "": ["t", "r", "b", "l"],
    x: ["l", "r"],
    y: ["t", "b"],
    t: ["t"],
    r: ["r"],
    b: ["b"],
    l: ["l"],
    s: ["l"],
    e: ["r"],
  };
  const condsConflict = (aConds, bConds) => {
    if (!aConds || !bConds || aConds.size === 0 || bConds.size === 0) return false;
    if ((aConds.has("dark") && bConds.has("light")) || (aConds.has("light") && bConds.has("dark"))) return true;
    for (const c of aConds) {
      if (bConds.has(`not-${c}`)) return true;
    }
    for (const c of bConds) {
      if (aConds.has(`not-${c}`)) return true;
    }
    return false;
  };
  const isRingFamily = (f) => f === "ring" || f === "inset-ring";
  const findConditionalKillers = (rep, rem = null) => {
    const rb = rep.rbInfo;
    if (!rb) return [];
    const reqConds = new Set([...rep.condPrefixes, ...(rem?.condPrefixes || [])]);
    const sameMetaAnyCond = (ev) => {
      const crossShadowKill =
        isRingFamily(rb.family) && ev.family === "shadow" && (ev.killsWidth || ev.killsStyle || ev.killsColor);
      if (ev.family !== rb.family && !crossShadowKill) return false;
      if (!sameSet(ev.targetPrefixes, rep.targetPrefixes)) return false;
      if (ev.focusKind === rep.focusKind) return true;
      if (rep.focusKind === "focus" && ev.focusKind === "focus-visible") return true;
      if (ev.focusKind === null) return true;
      return ev.focusKind === "focus" && ev.isImportant && !rep.isImportant;
    };
    const evsAll = rbEvents.filter(sameMetaAnyCond);
    const beatsCond = (a, b) => {
      if (a.isImportant !== b.isImportant) return a.isImportant;
      const focusRank = (fk) => (fk === "focus-visible" ? 2 : fk === "focus" ? 1 : 0);
      const ra = focusRank(a.focusKind);
      const rbRank = focusRank(b.focusKind);
      if (ra !== rbRank) return ra > rbRank;
      const bMoreSpec = condSubset(a.condPrefixes, b.condPrefixes) && b.condPrefixes.size > a.condPrefixes.size;
      if (bMoreSpec) return false;
      const aMoreSpec = condSubset(b.condPrefixes, a.condPrefixes) && a.condPrefixes.size > b.condPrefixes.size;
      if (aMoreSpec) return true;
      if (b.family === "shadow" && isRingFamily(a.family) && !a.isArbitraryProp) return false;
      return cmpPos(a, b) > 0;
    };
    const setterCoversRep = (ev) =>
      ev.focusKind === rep.focusKind ||
      ev.focusKind === null ||
      (rep.focusKind === "focus" && ev.focusKind === "focus-visible");
    const reqSides = rb.family === "border" ? BORDER_SIDE_MAP[rb.side] || BORDER_SIDE_MAP[""] : [null];
    const extraKillConds = [];
    for (const kEv of evsAll) {
      if (!kEv.killsWidth && !kEv.killsStyle && !kEv.killsColor) continue;
      if (condSubset(kEv.condPrefixes, rep.condPrefixes)) continue;
      if (condsConflict(kEv.condPrefixes, reqConds)) continue;
      const combinedConds = new Set([...reqConds, ...kEv.condPrefixes]);
      if (kEv.family === "shadow" && isRingFamily(rb.family)) {
        const hasShadowRestorer = evsAll.some(
          (se) =>
            ((isRingFamily(se.family) && se.setsWidth && se.setsStyle) ||
              (se.family === "shadow" && se.setsWidth && se.setsStyle && se.setsColor)) &&
            setterCoversRep(se) &&
            condSubset(se.condPrefixes, combinedConds) &&
            beatsCond(se, kEv)
        );
        if (!hasShadowRestorer) extraKillConds.push(combinedConds);
        continue;
      }
      const sideMatches = (ev, sideKey) => !sideKey || (BORDER_SIDE_MAP[ev.side] || BORDER_SIDE_MAP[""]).includes(sideKey);
      let kIsRestored = true;
      for (const sideKey of reqSides) {
        if (!sideMatches(kEv, sideKey)) continue;
        for (const [kFlag, sFlag] of [
          ["killsWidth", "setsWidth"],
          ["killsStyle", "setsStyle"],
          ["killsColor", "setsColor"],
        ]) {
          if (!kEv[kFlag]) continue;
          const hasRestorer = evsAll.some(
            (se) =>
              se.family === rb.family &&
              se[sFlag] &&
              sideMatches(se, sideKey) &&
              setterCoversRep(se) &&
              condSubset(se.condPrefixes, combinedConds) &&
              beatsCond(se, kEv)
          );
          if (!hasRestorer) {
            kIsRestored = false;
            break;
          }
        }
        if (!kIsRestored) break;
      }
      if (!kIsRestored) extraKillConds.push(combinedConds);
    }
    return extraKillConds;
  };
  const isRingBorderRepCancelled = (rep) => {
    const rb = rep.rbInfo;
    if (!rb) return false;
    const sameMeta = (ev) => {
      const crossShadowKill =
        isRingFamily(rb.family) && ev.family === "shadow" && (ev.killsWidth || ev.killsStyle || ev.killsColor);
      if (ev.family !== rb.family && !crossShadowKill) return false;
      if (!sameSet(ev.targetPrefixes, rep.targetPrefixes)) return false;
      if (!condSubset(ev.condPrefixes, rep.condPrefixes)) return false;
      if (ev.focusKind === rep.focusKind) return true;
      if (rep.focusKind === "focus" && ev.focusKind === "focus-visible") return true;
      if (ev.focusKind === null) return true;
      return ev.focusKind === "focus" && ev.isImportant && !rep.isImportant;
    };
    const focusRank = (fk) => (fk === "focus-visible" ? 2 : fk === "focus" ? 1 : 0);
    const beats = (a, b) => {
      if (a.isImportant !== b.isImportant) return a.isImportant;
      const ra = focusRank(a.focusKind);
      const rbRank = focusRank(b.focusKind);
      if (ra !== rbRank) return ra > rbRank;
      const bMoreSpec = condSubset(a.condPrefixes, b.condPrefixes) && b.condPrefixes.size > a.condPrefixes.size;
      if (bMoreSpec) return false;
      const aMoreSpec = condSubset(b.condPrefixes, a.condPrefixes) && a.condPrefixes.size > b.condPrefixes.size;
      if (aMoreSpec) return true;
      if (b.family === "shadow" && isRingFamily(a.family) && !a.isArbitraryProp) return false;
      return cmpPos(a, b) > 0;
    };
    const setterCoversRep = (ev) =>
      ev.focusKind === rep.focusKind ||
      ev.focusKind === null ||
      (rep.focusKind === "focus" && ev.focusKind === "focus-visible");
    const isKillUnrestored = (evsList, killFlag, setFlag, sideKey = null) => {
      const sideOk = (ev) => !sideKey || (BORDER_SIDE_MAP[ev.side] || BORDER_SIDE_MAP[""]).includes(sideKey);
      const killers = evsList.filter((ev) => ev.family === rb.family && ev[killFlag] && sideOk(ev));
      return killers.some(
        (kEv) => !evsList.some((se) => se.family === rb.family && se[setFlag] && sideOk(se) && setterCoversRep(se) && beats(se, kEv))
      );
    };
    const isShadowKillUnrestored = (evsList) => {
      if (!isRingFamily(rb.family)) return false;
      const killers = evsList.filter((ev) => ev.family === "shadow" && (ev.killsWidth || ev.killsStyle || ev.killsColor));
      return killers.some(
        (kEv) =>
          !evsList.some(
            (se) =>
              ((isRingFamily(se.family) && se.setsWidth && se.setsStyle) ||
                (se.family === "shadow" && se.setsWidth && se.setsStyle && se.setsColor)) &&
              setterCoversRep(se) &&
              beats(se, kEv)
          )
      );
    };
    const hasLiveSetter = (evsList, setFlag, killFlag, sideKey = null) => {
      const sideOk = (ev) => !sideKey || (BORDER_SIDE_MAP[ev.side] || BORDER_SIDE_MAP[""]).includes(sideKey);
      return evsList.some(
        (ev) =>
          ev.family === rb.family &&
          ev[setFlag] &&
          sideOk(ev) &&
          setterCoversRep(ev) &&
          !(rep.isImportant && !ev.isImportant && ev.focusKind !== null) &&
          !evsList.some(
            (kEv) =>
              kEv.family === rb.family &&
              kEv[killFlag] &&
              sideOk(kEv) &&
              beats(kEv, ev) &&
              !evsList.some((re) => re.family === rb.family && re[setFlag] && sideOk(re) && setterCoversRep(re) && beats(re, kEv))
          )
      );
    };
    const evs = rbEvents.filter(sameMeta);
    if (rb.family === "border") {
      const reqSides = BORDER_SIDE_MAP[rb.side] || BORDER_SIDE_MAP[""];
      const okAllSides = reqSides.every(
        (sideKey) =>
          hasLiveSetter(evs, "setsWidth", "killsWidth", sideKey) &&
          !isKillUnrestored(evs, "killsWidth", "setsWidth", sideKey) &&
          !isKillUnrestored(evs, "killsStyle", "setsStyle", sideKey) &&
          !isKillUnrestored(evs, "killsColor", "setsColor", sideKey)
      );
      return !okAllSides;
    }
    if (isShadowKillUnrestored(evs)) return true;
    if (isKillUnrestored(evs, "killsWidth", "setsWidth")) return true;
    if (isKillUnrestored(evs, "killsStyle", "setsStyle")) return true;
    if (isKillUnrestored(evs, "killsColor", "setsColor")) return true;
    if (!hasLiveSetter(evs, "setsWidth", "killsWidth")) return true;
    if (rb.family === "outline" && !hasLiveSetter(evs, "setsStyle", "killsStyle")) return true;
    return false;
  };
  const coversRemoval = (rep, rem, depth = 0) => {
    let wrapperMatch = false;
    if (rem.targetPrefixes.size > 0) {
      wrapperMatch =
        rep.targetPrefixes.size === 0 &&
        (rep.focusKind === "focus-within" || (rep.focusKind === "has-focus" && hasArgCoversTargets(rep.hasInner, rem.targetPrefixes)));
      const sameTargetMatch = rep.focusKind !== "focus-within" && rep.focusKind !== "has-focus" && sameSet(rep.targetPrefixes, rem.targetPrefixes);
      if (!wrapperMatch && !sameTargetMatch) return false;
    } else {
      if (rep.targetPrefixes.size > 0) return false;
      if (rep.focusKind === "has-focus") return false;
    }
    if (rem.focusKind === "focus-visible" && !wrapperMatch && rep.isOutlineProp && rep.focusKind !== "focus-visible") return false;
    if (rep.focusKind !== "focus" && rep.focusKind !== "focus-visible" && rep.focusKind !== "focus-within" && rep.focusKind !== "has-focus") return false;
    if (rem.isImportant && rep.isOutlineProp && !rep.isImportant) return false;
    if (
      !wrapperMatch &&
      rep.isOutlineProp &&
      rep.focusKind === rem.focusKind &&
      !(rep.isImportant && !rem.isImportant) &&
      (rep.fromSource === "prev" || (rep.fromSource === "main" && rep.tokIdx < rem.tokIdx))
    ) {
      return false;
    }
    if (isRingBorderRepCancelled(rep)) return false;
    for (const c of rep.condPrefixes) {
      if (!rem.condPrefixes.has(c)) return false;
    }
    if (!wrapperMatch && rep.rbInfo && depth < 3) {
      const extraCondsList = findConditionalKillers(rep, rem);
      for (const combinedConds of extraCondsList) {
        const subRem = { ...rem, condPrefixes: combinedConds };
        if (!replacements.some((altRep) => altRep !== rep && coversRemoval(altRep, subRem, depth + 1))) {
          return false;
        }
      }
    }
    return true;
  };
  const uncovered = removals.filter((rem) => !rem.isSafeNotFocusVisible && !replacements.some((rep) => coversRemoval(rep, rem)));
  return {
    hasRemoval: true,
    naked: uncovered.length > 0,
    firstRemoval: uncovered[0] || removals[0],
    uncovered,
  };
}

function findJsBalancedDelim(srcStr, openIdx, openCh, closeCh, allowRegex = true) {
  let depth = 1;
  let q = null;
  let lastSig = openCh;
  const parenStack = [];
  for (let k = openIdx + 1; k < srcStr.length; k++) {
    const c = srcStr[k];
    if (q) {
      if (c === "\\" && k + 1 < srcStr.length) {
        k++;
        continue;
      }
      if (q === "`" && c === "$" && srcStr[k + 1] === "{") {
        const se = findJsBalancedDelim(srcStr, k + 1, "{", "}", true);
        if (se === -1) return -1;
        k = se;
        lastSig = "}";
        continue;
      }
      if (c === q || (q !== "`" && c === "\n")) {
        q = null;
        lastSig = c;
      }
      continue;
    }
    if (allowRegex) {
      const reEnd = skipJsRegexInExpr(srcStr, k, lastSig, openIdx + 1);
      if (reEnd !== -1) {
        k = reEnd - 1;
        lastSig = "/";
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return k;
    }
    if (!q) {
      if (c === "(") {
        if (allowRegex) {
          parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(srcStr.slice(Math.max(openIdx + 1, k - 16), k)));
        }
        lastSig = "(";
      } else if (c === ")") {
        lastSig = allowRegex && parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
  }
  return -1;
}

export function extractSvelteClassDirectives(src, markupCtx = null) {
  const s = String(src || "");
  const ctx = markupCtx || scanMarkupContexts(s, { isMarkupSfc: true, braceExprs: true });
  const findInnermostSvelteTag = (idx) => {
    let best = null;
    for (const t of ctx.openTags) {
      if (idx > t.start && idx < t.end && (!best || t.start >= best.start)) best = t;
    }
    if (!best) return null;
    if (best.attrValueSpans.some(([as, ae]) => idx >= as && idx < ae)) return null;
    if (best.exprSpans.some((ex) => idx >= ex.innerStart && idx < ex.innerEnd)) return null;
    return best;
  };
  const out = [];
  let searchFrom = 0;
  for (const sm of s.matchAll(/(?<![a-zA-Z0-9_-])class:/g)) {
    if (sm.index < searchFrom) continue;
    const enc = findInnermostSvelteTag(sm.index);
    if (!enc) continue;
    const clsStart = sm.index + "class:".length;
    let k = clsStart;
    let brack = 0;
    let q = null;
    while (k < enc.end) {
      const c = s[k];
      if (q) {
        if (c === "\\" && k + 1 < enc.end) { k += 2; continue; }
        if (c === q || c === "\n") q = null;
        k++;
        continue;
      }
      if (brack > 0) {
        if (c === '"' || c === "'") { q = c; k++; continue; }
        if (c === "[") { brack++; k++; continue; }
        if (c === "]") { brack--; k++; continue; }
        if (c === "{") {
          const be = findJsBalancedDelim(s, k, "{", "}");
          if (be === -1 || be >= enc.end) { k = -1; break; }
          k = be + 1;
          continue;
        }
        if (/\s/.test(c)) break;
        k++;
        continue;
      }
      if (c === "[") { brack++; k++; continue; }
      if (c === "/" && (s[k + 1] === ">" || /^\s*>/.test(s.slice(k + 1, enc.end)))) break;
      if (/[\s=>]/.test(c)) break;
      k++;
    }
    if (k <= clsStart || brack !== 0 || q !== null) continue;
    const cls = s.slice(clsStart, k);
    let p = k;
    while (p < enc.end && /\s/.test(s[p])) p++;
    let rhs = "";
    let endPos = k;
    if (s[p] === "=") {
      p++;
      while (p < enc.end && /\s/.test(s[p])) p++;
      if (s[p] !== "{") continue;
      const closeB = findJsBalancedDelim(s, p, "{", "}");
      if (closeB === -1 || closeB >= enc.end) continue;
      rhs = s.slice(p + 1, closeB).trim();
      endPos = closeB + 1;
    }
    out.push({ tag: enc, cls, clsStart, rhs, index: sm.index, end: endPos });
    searchFrom = endPos;
  }
  return out;
}

export function extractClassAttributes(src, options = {}) {
  const s = String(src || "");
  const out = [];
  const attrRanges = [];
  let cursor = 0;

  const findQuotedEnd = (openIdx, allowMultiline = false, limit = s.length, allowBackslashEscape = true) => {
    const q = s[openIdx];
    let i = openIdx + 1;
    const stop = Math.min(limit, s.length);
    while (i < stop) {
      const ch = s[i];
      if (allowBackslashEscape && ch === "\\" && i + 1 < stop) {
        i += 2;
        continue;
      }
      if (ch === q) return i;
      if (ch === "\n" && !allowMultiline) return -1;
      i++;
    }
    return -1;
  };

  const scanTemplateInfo = (openIdx) => {
    let i = openIdx + 1;
    let quasi = "";
    const exprSpans = [];
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\" && i + 1 < s.length) {
        quasi += ch + s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && i + 1 < s.length && s[i + 1] === "{") {
        const exprStart = i + 2;
        let bd = 1;
        let tq = null;
        let lastSig = "{";
        const parenStack = [];
        let j = exprStart;
        quasi += "  ";
        while (j < s.length && bd > 0) {
          const tc = s[j];
          if (tq) {
            if (tc === "\\" && j + 1 < s.length) {
              quasi += s[j + 1] === "\n" ? " \n" : "  ";
              j += 2;
              continue;
            }
            if (tc === tq || (tq !== "`" && tc === "\n")) {
              tq = null;
              lastSig = tc;
            }
            quasi += tc === "\n" ? "\n" : " ";
            j++;
            continue;
          }
          const reEnd = skipJsRegexInExpr(s, j, lastSig, exprStart);
          if (reEnd !== -1) {
            for (let rk = j; rk < reEnd; rk++) quasi += s[rk] === "\n" ? "\n" : " ";
            lastSig = "/";
            j = reEnd;
            continue;
          }
          if (tc === '"' || tc === "'" || tc === "`") tq = tc;
          else if (tc === "{") { bd++; lastSig = "{"; }
          else if (tc === "}") { bd--; lastSig = "}"; }
          else if (tc === "(") {
            parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(exprStart, j - 16), j)));
            lastSig = "(";
          } else if (tc === ")") {
            lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
          } else if (!/\s/.test(tc)) {
            lastSig = tc;
          }
          if (bd > 0) quasi += tc === "\n" ? "\n" : " ";
          j++;
        }
        if (bd > 0) return { endIdx: -1, quasi: "", exprSpans: [] };
        quasi += " ";
        exprSpans.push([exprStart, j - 1]);
        i = j;
        continue;
      }
      if (ch === "`") {
        return { endIdx: i, quasi, exprSpans };
      }
      quasi += ch;
      i++;
    }
    return { endIdx: -1, quasi: "", exprSpans: [] };
  };

  const findBalancedDelimEnd = (openIdx, openCh, closeCh) => {
    let depth = 1;
    let q = null;
    let lastSig = openCh;
    const parenStack = [];
    let i = openIdx + 1;
    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < s.length) {
          i += 2;
          continue;
        }
        if (q === "`" && ch === "$" && i + 1 < s.length && s[i + 1] === "{") {
          const subEnd = findBalancedDelimEnd(i + 1, "{", "}");
          if (subEnd === -1) return -1;
          lastSig = "}";
          i = subEnd + 1;
          continue;
        }
        if (ch === q || (q !== "`" && ch === "\n")) { q = null; lastSig = ch; }
        i++;
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, i, lastSig, openIdx + 1);
      if (reEnd !== -1) {
        lastSig = "/";
        i = reEnd;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") q = ch;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
      if (!q) {
        if (ch === "(") {
          parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(openIdx + 1, i - 16), i)));
          lastSig = "(";
        } else if (ch === ")") {
          lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        } else if (!/\s/.test(ch)) {
          lastSig = ch;
        }
      }
      i++;
    }
    return -1;
  };

  const splitTopLevelSpan = (start, end, sepChar) => {
    const parts = [];
    let partStart = start;
    let paren = 0;
    let br = 0;
    let brace = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    let i = start;
    while (i < end) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < end) {
          i += 2;
          continue;
        }
        if (q === "`" && ch === "$" && i + 1 < end && s[i + 1] === "{") {
          const subEnd = findBalancedDelimEnd(i + 1, "{", "}");
          if (subEnd === -1 || subEnd >= end) break;
          lastSig = "}";
          i = subEnd + 1;
          continue;
        }
        if (ch === q || (q !== "`" && ch === "\n")) { q = null; lastSig = ch; }
        i++;
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, i, lastSig, start);
      if (reEnd !== -1 && reEnd <= end) {
        lastSig = "/";
        i = reEnd;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") q = ch;
      else if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(start, i - 16), i)));
        lastSig = "(";
        paren++;
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        paren = Math.max(0, paren - 1);
      } else if (ch === "[") { br++; lastSig = ch; }
      else if (ch === "]") { br = Math.max(0, br - 1); lastSig = ch; }
      else if (ch === "{") { brace++; lastSig = ch; }
      else if (ch === "}") { brace = Math.max(0, brace - 1); lastSig = ch; }
      else if (paren === 0 && br === 0 && brace === 0 && ch === sepChar) {
        if (sepChar === "+" && (s[i + 1] === "+" || s[i + 1] === "=" || s[i - 1] === "+")) {
          i += s[i + 1] === "+" ? 2 : 1;
          lastSig = "+";
          continue;
        }
        parts.push([partStart, i]);
        partStart = i + 1;
        lastSig = ch;
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      i++;
    }
    parts.push([partStart, end]);
    return parts;
  };

  const scanFallbackLiterals = (start, end, results) => {
    let i = start;
    let lastSig = "";
    const parenStack = [];
    while (i < end) {
      const ch = s[i];
      const reEnd = skipJsRegexInExpr(s, i, lastSig, start);
      if (reEnd !== -1 && reEnd <= end) {
        lastSig = "/";
        i = reEnd;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const endQ = findQuotedEnd(i);
        if (endQ === -1 || endQ >= end) break;
        const prevEq = /(?:===|!==|==|!=)\s*$/.test(s.slice(start, i));
        const nextEq = /^\s*(?:===|!==|==|!=)(?!=)/.test(s.slice(endQ + 1, end));
        if (!prevEq && !nextEq) {
          results.push({
            contentStart: i + 1,
            contentEnd: endQ,
            content: s.slice(i + 1, endQ),
            quote: ch,
            unconditional: false,
          });
        }
        lastSig = ch;
        i = endQ + 1;
        continue;
      }
      if (ch === "`") {
        const tpl = scanTemplateInfo(i);
        if (tpl.endIdx === -1 || tpl.endIdx >= end) break;
        const prevEq = /(?:===|!==|==|!=)\s*$/.test(s.slice(start, i));
        const nextEq = /^\s*(?:===|!==|==|!=)(?!=)/.test(s.slice(tpl.endIdx + 1, end));
        if (!prevEq && !nextEq) {
          results.push({
            contentStart: i + 1,
            contentEnd: tpl.endIdx,
            content: tpl.quasi,
            quote: "`",
            unconditional: false,
          });
        }
        for (const [es, ee] of tpl.exprSpans) {
          scanFallbackLiterals(es, ee, results);
        }
        lastSig = "`";
        i = tpl.endIdx + 1;
        continue;
      }
      if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(start, i - 16), i)));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      i++;
    }
  };

  const hasTopLevelConditionalOp = (start, end) => {
    let paren = 0;
    let br = 0;
    let brace = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    let i = start;
    while (i < end) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < end) {
          i += 2;
          continue;
        }
        if (q === "`" && ch === "$" && i + 1 < end && s[i + 1] === "{") {
          const subEnd = findBalancedDelimEnd(i + 1, "{", "}");
          if (subEnd === -1 || subEnd >= end) break;
          lastSig = "}";
          i = subEnd + 1;
          continue;
        }
        if (ch === q || (q !== "`" && ch === "\n")) { q = null; lastSig = ch; }
        i++;
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, i, lastSig, start);
      if (reEnd !== -1 && reEnd <= end) {
        lastSig = "/";
        i = reEnd;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") q = ch;
      else if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(start, i - 16), i)));
        lastSig = "(";
        paren++;
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        paren = Math.max(0, paren - 1);
      } else if (ch === "[") { br++; lastSig = ch; }
      else if (ch === "]") { br = Math.max(0, br - 1); lastSig = ch; }
      else if (ch === "{") { brace++; lastSig = ch; }
      else if (ch === "}") { brace = Math.max(0, brace - 1); lastSig = ch; }
      else if (paren === 0 && br === 0 && brace === 0) {
        if ((ch === "?" && s[i + 1] !== ".") || (ch === "&" && s[i + 1] === "&") || (ch === "|" && s[i + 1] === "|")) {
          return true;
        }
        if (!/\s/.test(ch)) lastSig = ch;
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      i++;
    }
    return false;
  };

  const hasComparisonOp = (bs, be) => {
    let p = 0;
    let b = 0;
    let br = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    for (let k = bs; k < be; k++) {
      const c = s[k];
      if (q) {
        if (c === "\\" && k + 1 < be) {
          k++;
          continue;
        }
        if (q === "`" && c === "$" && k + 1 < be && s[k + 1] === "{") {
          const subEnd = findBalancedDelimEnd(k + 1, "{", "}");
          if (subEnd === -1 || subEnd >= be) break;
          lastSig = "}";
          k = subEnd;
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, k, lastSig, bs);
      if (reEnd !== -1 && reEnd <= be) {
        lastSig = "/";
        k = reEnd - 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(bs, k - 16), k)));
        lastSig = "(";
        p++;
      } else if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        p = Math.max(0, p - 1);
      } else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0) {
        if ((c === "=" && s[k + 1] === "=") || (c === "!" && s[k + 1] === "=")) return true;
        if ((c === "<" || c === ">") && !(c === ">" && k > bs && s[k - 1] === "=")) return true;
        if (c === "i" && /^\binstanceof\b/.test(s.slice(k, Math.min(be, k + 12))) && (k === bs || !/[A-Za-z0-9_$]/.test(s[k - 1]))) {
          return true;
        }
        if (!/\s/.test(c)) lastSig = c;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    return false;
  };

  const hasTopLevelAndOp = (bs, be) => {
    let p = 0;
    let b = 0;
    let br = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    for (let k = bs; k < be; k++) {
      const c = s[k];
      if (q) {
        if (c === "\\" && k + 1 < be) {
          k++;
          continue;
        }
        if (q === "`" && c === "$" && k + 1 < be && s[k + 1] === "{") {
          const subEnd = findBalancedDelimEnd(k + 1, "{", "}");
          if (subEnd === -1 || subEnd >= be) break;
          lastSig = "}";
          k = subEnd;
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, k, lastSig, bs);
      if (reEnd !== -1 && reEnd <= be) {
        lastSig = "/";
        k = reEnd - 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(bs, k - 16), k)));
        lastSig = "(";
        p++;
      } else if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        p = Math.max(0, p - 1);
      } else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0 && c === "&" && s[k + 1] === "&") {
        return true;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    return false;
  };

  const scanExpr = (start, end, isCond, results) => {
    let l = start;
    let r = end;
    while (true) {
      while (l < r && /\s/.test(s[l])) l++;
      while (r > l && /\s/.test(s[r - 1])) r--;
      const tailMatch = /\s*\.\s*(?:filter\s*\(\s*Boolean\s*\)|join\s*\(\s*(?:"\s+"|'\s+'|`\s+`)\s*\)|trim\s*\(\s*\))\s*$/.exec(s.slice(l, r));
      if (tailMatch && tailMatch[0].length < r - l) {
        r -= tailMatch[0].length;
        continue;
      }
      const nextR = ciStripTrailingTsCastEnd(s, l, r, (s0, oi, oc, cc) => findBalancedDelimEnd(oi, oc, cc));
      if (nextR !== r) {
        r = nextR;
        continue;
      }
      if (l < r && s[l] === "(" && findBalancedDelimEnd(l, "(", ")") === r - 1) {
        l++;
        r--;
        continue;
      }
      break;
    }
    if (l >= r) return;

    if ((s[l] === '"' || s[l] === "'") && findQuotedEnd(l) === r - 1) {
      results.push({
        contentStart: l + 1,
        contentEnd: r - 1,
        content: s.slice(l + 1, r - 1),
        quote: s[l],
        unconditional: !isCond,
      });
      return;
    }
    if (s[l] === "`") {
      const tpl = scanTemplateInfo(l);
      if (tpl.endIdx === r - 1) {
        results.push({
          contentStart: l + 1,
          contentEnd: tpl.endIdx,
          content: tpl.quasi,
          quote: "`",
          unconditional: !isCond,
        });
        for (const [es, ee] of tpl.exprSpans) {
          scanExpr(es, ee, isCond, results);
        }
        return;
      }
    }
    if (hasTopLevelConditionalOp(l, r)) {
      const splitByPrecedence = () => {
        const findTernaryPair = () => {
          let qPos = -1;
          let tDepth = 0;
          let paren = 0;
          let br = 0;
          let brace = 0;
          let q = null;
          let lastSig = "";
          const parenStack = [];
          let k = l;
          while (k < r) {
            const c = s[k];
            if (q) {
              if (c === "\\" && k + 1 < r) {
                k += 2;
                continue;
              }
              if (q === "`" && c === "$" && k + 1 < r && s[k + 1] === "{") {
                const subEnd = findBalancedDelimEnd(k + 1, "{", "}");
                if (subEnd === -1 || subEnd >= r) break;
                lastSig = "}";
                k = subEnd + 1;
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
              k++;
              continue;
            }
            const reEnd = skipJsRegexInExpr(s, k, lastSig, l);
            if (reEnd !== -1 && reEnd <= r) {
              lastSig = "/";
              k = reEnd;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(l, k - 16), k)));
              lastSig = "(";
              paren++;
            } else if (c === ")") {
              lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
              paren = Math.max(0, paren - 1);
            } else if (c === "[") { br++; lastSig = c; }
            else if (c === "]") { br = Math.max(0, br - 1); lastSig = c; }
            else if (c === "{") { brace++; lastSig = c; }
            else if (c === "}") { brace = Math.max(0, brace - 1); lastSig = c; }
            else if (paren === 0 && br === 0 && brace === 0) {
              if (c === "?" && s[k + 1] !== "?" && s[k + 1] !== ".") {
                if (qPos === -1) qPos = k;
                tDepth++;
                lastSig = c;
              } else if (c === ":" && tDepth > 0) {
                tDepth--;
                if (tDepth === 0 && qPos !== -1) {
                  return [
                    [qPos + 1, k],
                    [k + 1, r],
                  ];
                }
                lastSig = c;
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            } else if (!/\s/.test(c)) {
              lastSig = c;
            }
            k++;
          }
          return [];
        };
        const tSpans = findTernaryPair();
        if (tSpans.length > 0) return tSpans;

        const findOps = (mode) => {
          const ops = [];
          let paren = 0;
          let br = 0;
          let brace = 0;
          let q = null;
          let lastSig = "";
          const parenStack = [];
          let k = l;
          while (k < r) {
            const c = s[k];
            if (q) {
              if (c === "\\" && k + 1 < r) {
                k += 2;
                continue;
              }
              if (q === "`" && c === "$" && k + 1 < r && s[k + 1] === "{") {
                const subEnd = findBalancedDelimEnd(k + 1, "{", "}");
                if (subEnd === -1 || subEnd >= r) break;
                lastSig = "}";
                k = subEnd + 1;
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
              k++;
              continue;
            }
            const reEnd = skipJsRegexInExpr(s, k, lastSig, l);
            if (reEnd !== -1 && reEnd <= r) {
              lastSig = "/";
              k = reEnd;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(l, k - 16), k)));
              lastSig = "(";
              paren++;
            } else if (c === ")") {
              lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
              paren = Math.max(0, paren - 1);
            } else if (c === "[") { br++; lastSig = c; }
            else if (c === "]") { br = Math.max(0, br - 1); lastSig = c; }
            else if (c === "{") { brace++; lastSig = c; }
            else if (c === "}") { brace = Math.max(0, brace - 1); lastSig = c; }
            else if (paren === 0 && br === 0 && brace === 0) {
              if (mode === "or" && ((c === "|" && s[k + 1] === "|") || (c === "?" && s[k + 1] === "?"))) {
                ops.push([k, k + 2]);
                lastSig = c;
                k += 2;
                continue;
              } else if (mode === "and" && c === "&" && s[k + 1] === "&") {
                ops.push([k, k + 2]);
                lastSig = c;
                k += 2;
                continue;
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            } else if (!/\s/.test(c)) {
              lastSig = c;
            }
            k++;
          }
          return ops;
        };
        for (const mode of ["or", "and"]) {
          const ops = findOps(mode);
          if (ops.length > 0) {
            if (mode === "and") {
              return [[ops[ops.length - 1][1], r]];
            }
            const spans = [];
            let cur = l;
            for (const [os, oe] of ops) {
              if (!hasComparisonOp(cur, os) || hasTopLevelAndOp(cur, os)) spans.push([cur, os]);
              cur = oe;
            }
            if (!hasComparisonOp(cur, r) || hasTopLevelAndOp(cur, r)) spans.push([cur, r]);
            return spans;
          }
        }
        return [];
      };
      const branches = splitByPrecedence();
      if (branches.length > 0) {
        for (const [bs, be] of branches) {
          const brLits = [];
          scanExpr(bs, be, false, brLits);
          if (brLits.length > 0) {
            const brUncond = brLits.filter((x) => x.unconditional);
            for (const lit of brLits) {
              const peers = lit.unconditional ? brUncond.filter((u) => u !== lit) : brUncond;
              const peerStr = peers.map((x) => x.content).filter(Boolean).join(" ");
              lit.localSiblingClasses = [lit.localSiblingClasses, peerStr].filter(Boolean).join(" ");
              lit.unconditional = false;
              results.push(lit);
            }
          }
        }
        return;
      }
      scanFallbackLiterals(l, r, results);
      return;
    }
    if (s[l] === "[" && findBalancedDelimEnd(l, "[", "]") === r - 1) {
      for (const [ps, pe] of splitTopLevelSpan(l + 1, r - 1, ",")) {
        scanExpr(ps, pe, isCond, results);
      }
      return;
    }
    if (s[l] === "{" && findBalancedDelimEnd(l, "{", "}") === r - 1) {
      for (const [es, ee] of splitTopLevelSpan(l + 1, r - 1, ",")) {
        let eL = es;
        let eR = ee;
        while (eL < eR && /\s/.test(s[eL])) eL++;
        while (eR > eL && /\s/.test(s[eR - 1])) eR--;
        if (eL >= eR || s.startsWith("...", eL)) continue;
        let colonIdx = -1;
        let p = 0;
        let b = 0;
        let br = 0;
        let kq = null;
        let lastSigObj = "";
        const objParenStack = [];
        for (let k = eL; k < eR; k++) {
          const kc = s[k];
          if (kq) {
            if (kq === "`" && kc === "$" && k + 1 < eR && s[k + 1] === "{") {
              const se = findBalancedDelimEnd(k + 1, "{", "}");
              if (se === -1 || se >= eR) break;
              lastSigObj = "}";
              k = se;
              continue;
            }
            if (kc === "\\" && k + 1 < eR) {
              k++;
              continue;
            }
            if (kc === kq || (kq !== "`" && kc === "\n")) { kq = null; lastSigObj = kc; }
            continue;
          }
          const reEnd = skipJsRegexInExpr(s, k, lastSigObj, eL);
          if (reEnd !== -1 && reEnd <= eR) {
            lastSigObj = "/";
            k = reEnd - 1;
            continue;
          }
          if (kc === '"' || kc === "'" || kc === "`") kq = kc;
          else if (kc === "(") {
            objParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(eL, k - 16), k)));
            lastSigObj = "(";
            p++;
          } else if (kc === ")") {
            lastSigObj = objParenStack.length > 0 && objParenStack.pop() ? "control)" : ")";
            p = Math.max(0, p - 1);
          } else if (kc === "[") { b++; lastSigObj = kc; }
          else if (kc === "]") { b = Math.max(0, b - 1); lastSigObj = kc; }
          else if (kc === "{") { br++; lastSigObj = kc; }
          else if (kc === "}") { br = Math.max(0, br - 1); lastSigObj = kc; }
          else if (kc === ":" && p === 0 && b === 0 && br === 0) {
            colonIdx = k;
            break;
          } else if (!/\s/.test(kc)) {
            lastSigObj = kc;
          }
        }
        if (colonIdx === -1) continue;
        let ks = eL;
        let ke = colonIdx;
        while (ks < ke && /\s/.test(s[ks])) ks++;
        while (ke > ks && /\s/.test(s[ke - 1])) ke--;
        let vs = colonIdx + 1;
        let ve = eR;
        while (vs < ve && /\s/.test(s[vs])) vs++;
        while (ve > vs && /\s/.test(s[ve - 1])) ve--;
        const rhsTrim = s.slice(vs, ve).trim();
        if (rhsTrim === "false" || rhsTrim === "null" || rhsTrim === "undefined" || rhsTrim === "0" || rhsTrim === '""' || rhsTrim === "''") {
          continue;
        }
        const entryCond = isCond || rhsTrim !== "true";
        if (s[ks] === "[" && findBalancedDelimEnd(ks, "[", "]") === ke - 1) {
          scanExpr(ks + 1, ke - 1, entryCond, results);
        } else if (s[ks] === '"' || s[ks] === "'" || s[ks] === "`") {
          scanExpr(ks, ke, entryCond, results);
        } else if (ks < ke && /^[A-Za-z0-9_$-]+$/.test(s.slice(ks, ke))) {
          results.push({
            contentStart: ks,
            contentEnd: ke,
            content: s.slice(ks, ke),
            quote: "",
            unconditional: !entryCond,
          });
        }
      }
      return;
    }
    const helperMatch = /^(?:cn|clsx|cx|twMerge|twJoin|classNames|classnames)\s*\(/.exec(s.slice(l, r));
    if (helperMatch) {
      const openP = l + helperMatch[0].length - 1;
      if (findBalancedDelimEnd(openP, "(", ")") === r - 1) {
        for (const [ps, pe] of splitTopLevelSpan(openP + 1, r - 1, ",")) {
          scanExpr(ps, pe, isCond, results);
        }
        return;
      }
    }
    const addParts = splitTopLevelSpan(l, r, "+");
    if (addParts.length > 1) {
      for (const [ps, pe] of addParts) {
        scanExpr(ps, pe, isCond, results);
      }
      return;
    }
    if (hasComparisonOp(l, r)) return;
    scanFallbackLiterals(l, r, results);
  };

  const collectExprLits = (exprStart, exprEnd) => {
    const exprLits = [];
    scanExpr(exprStart, exprEnd, false, exprLits);
    return exprLits;
  };

  const ctx = options.markupCtx || scanMarkupContexts(s, options);
  const svelteSiblingsByTag = new Map();
  let activeTagForEmit = null;
  let attrGroupSeq = 0;
  let activeAttrGroupId = 0;
  const entriesByTag = new Map();
  const emitEntryToOut = (tagObj, entryObj) => {
    const tagged = { ...entryObj, _attrGroup: activeAttrGroupId };
    out.push(tagged);
    if (!tagObj) return;
    let list = entriesByTag.get(tagObj);
    if (!list) {
      list = [];
      entriesByTag.set(tagObj, list);
    }
    list.push(tagged);
  };
  if (options.isMarkupSfc && options.braceExprs) {
    for (const dir of extractSvelteClassDirectives(s, ctx)) {
      if (dir.rhs === "" || dir.rhs === "true") {
        let arr = svelteSiblingsByTag.get(dir.tag);
        if (!arr) {
          arr = [];
          svelteSiblingsByTag.set(dir.tag, arr);
        }
        arr.push(dir.cls);
      }
    }
  }
  const joinSibs = (...parts) => parts.filter(Boolean).join(" ").trim();

  const emitExprLits = (exprLits, extraUncond = "") => {
    const dirSib = activeTagForEmit ? (svelteSiblingsByTag.get(activeTagForEmit) || []).join(" ") : "";
    const combinedExtra = joinSibs(extraUncond, dirSib);
    const uncond = exprLits.filter((x) => x.unconditional);
    const uncondJoined = [
      ...uncond.map((x) => x.content),
      ...(combinedExtra ? [combinedExtra] : []),
    ]
      .filter(Boolean)
      .join(" ");
    for (const lit of exprLits) {
      const siblingClasses = lit.unconditional
        ? [
            ...uncond.filter((u) => u !== lit).map((u) => u.content),
            lit.localSiblingClasses || "",
            ...(combinedExtra ? [combinedExtra] : []),
          ]
            .filter(Boolean)
            .join(" ")
        : [uncondJoined, lit.localSiblingClasses || ""].filter(Boolean).join(" ");
      emitEntryToOut(activeTagForEmit, {
        contentStart: lit.contentStart,
        contentEnd: lit.contentEnd,
        content: lit.content,
        quote: lit.quote,
        unconditional: lit.unconditional,
        siblingClasses,
      });
    }
  };

  const pushExprRange = (exprStart, exprEnd, extraUncond = "") => {
    emitExprLits(collectExprLits(exprStart, exprEnd), extraUncond);
  };

  const findInnermostOpenTag = (idx) => {
    let best = null;
    for (const t of ctx.openTags) {
      if (t.start < idx && idx < t.end) {
        if (!best || t.end - t.start < best.end - best.start) best = t;
      }
    }
    return best;
  };
  const inAnySpan = (idx, spans) => {
    for (const [ss, se] of spans) {
      if (idx >= ss && idx < se) return true;
    }
    return false;
  };
  const isHelperBlockedPos = (idx) => {
    if (inAnySpan(idx, ctx.proseSpans) || inAnySpan(idx, ctx.jsStringSpans)) return true;
    for (const t of ctx.openTags) {
      if (idx > t.start && idx < t.end && inAnySpan(idx, t.attrValueSpans)) return true;
    }
    return false;
  };

  for (const m of s.matchAll(/(?<![a-zA-Z0-9_-])class(?:Name|:list)?\s*=\s*/g)) {
    if (m.index < cursor) continue;
    const tag = findInnermostOpenTag(m.index);
    if (!tag) continue;
    if (inAnySpan(m.index, tag.attrValueSpans)) continue;
    if (tag.exprSpans.some((ex) => m.index >= ex.start && m.index < ex.end)) continue;
    let i = m.index + m[0].length;
    while (i < s.length && /\s/.test(s[i])) i++;
    const ch = s[i];
    const isBoundAttr = m.index > 0 && s[m.index - 1] === ":";
    const outerLimit = tag.end;
    const tagDirSibs = (svelteSiblingsByTag.get(tag) || []).join(" ");
    activeAttrGroupId = ++attrGroupSeq;
    if (ch === '"' || ch === "'") {
      const endQ = findQuotedEnd(i, true, outerLimit, false);
      if (endQ === -1) continue;
      const attrContent = s.slice(i + 1, endQ);
      if (isBoundAttr) {
        activeTagForEmit = tag;
        pushExprRange(i + 1, endQ);
        activeTagForEmit = null;
      } else if (attrContent.includes("{")) {
        const segs = [];
        let segStart = i + 1;
        let k = i + 1;
        let attrBr = 0;
        let cssStrQ = null;
        while (k < endQ) {
          const sk = s[k];
          if (cssStrQ) {
            if (sk === "\\" && k + 1 < endQ) {
              k += 2;
              continue;
            }
            if (sk === cssStrQ || sk === "\n") cssStrQ = null;
            k++;
            continue;
          }
          if (sk === '"' || sk === "'") {
            if (attrBr > 0) cssStrQ = sk;
            k++;
            continue;
          }
          if (sk === "[") {
            attrBr++;
            k++;
            continue;
          }
          if (sk === "]") {
            attrBr = Math.max(0, attrBr - 1);
            k++;
            continue;
          }
          if (sk === "{" && attrBr === 0) {
            const braceEnd = findBalancedDelimEnd(k, "{", "}");
            if (braceEnd !== -1 && braceEnd < endQ) {
              if (k > segStart) segs.push({ kind: "static", start: segStart, end: k });
              segs.push({ kind: "expr", start: k + 1, end: braceEnd });
              k = braceEnd + 1;
              segStart = k;
              continue;
            }
          }
          k++;
        }
        if (segStart < endQ) segs.push({ kind: "static", start: segStart, end: endQ });
        const hasBalancedExpr = segs.some((seg) => seg.kind === "expr");
        if (!hasBalancedExpr) {
          emitEntryToOut(tag, {
            contentStart: i + 1,
            contentEnd: endQ,
            content: attrContent,
            quote: ch,
            siblingClasses: tagDirSibs,
          });
        } else {
          const staticSegs = segs
            .filter((seg) => seg.kind === "static")
            .map((seg) => ({ ...seg, content: s.slice(seg.start, seg.end) }));
          const allStatic = staticSegs.map((seg) => seg.content).join(" ").trim();
          const exprGroups = segs
            .filter((seg) => seg.kind === "expr")
            .map((seg) => ({ ...seg, lits: collectExprLits(seg.start, seg.end) }));
          const allUncondExpr = exprGroups
            .flatMap((g) => g.lits.filter((x) => x.unconditional).map((x) => x.content))
            .join(" ")
            .trim();
          for (const st of staticSegs) {
            if (!st.content.trim()) continue;
            const otherStatic = joinSibs(
              staticSegs.filter((x) => x !== st).map((x) => x.content).join(" "),
              allUncondExpr,
              tagDirSibs
            );
            emitEntryToOut(tag, {
              contentStart: st.start,
              contentEnd: st.end,
              content: st.content,
              quote: ch,
              siblingClasses: otherStatic,
            });
          }
          activeTagForEmit = tag;
          for (const eg of exprGroups) {
            const otherExprUncond = exprGroups
              .filter((g) => g !== eg)
              .flatMap((g) => g.lits.filter((x) => x.unconditional).map((x) => x.content))
              .join(" ")
              .trim();
            const combinedExtra = joinSibs(allStatic, otherExprUncond);
            emitExprLits(eg.lits, combinedExtra);
          }
          activeTagForEmit = null;
        }
      } else {
        emitEntryToOut(tag, {
          contentStart: i + 1,
          contentEnd: endQ,
          content: attrContent,
          quote: ch,
          siblingClasses: tagDirSibs,
        });
      }
      cursor = endQ + 1;
      attrRanges.push([i + 1, endQ]);
      continue;
    }
    if (ch !== "{") continue;
    const closeBrace = findBalancedDelimEnd(i, "{", "}");
    if (closeBrace === -1 || closeBrace >= outerLimit) continue;
    activeTagForEmit = tag;
    pushExprRange(i + 1, closeBrace);
    activeTagForEmit = null;
    attrRanges.push([i + 1, closeBrace]);
    cursor = closeBrace + 1;
  }
  for (const tagEntries of entriesByTag.values()) {
    const attrGroups = new Map();
    for (const e of tagEntries) {
      const gid = e._attrGroup || 0;
      let g = attrGroups.get(gid);
      if (!g) {
        g = [];
        attrGroups.set(gid, g);
      }
      g.push(e);
    }
    if (attrGroups.size > 1) {
      const uncondByGroup = new Map();
      for (const [gid, g] of attrGroups.entries()) {
        uncondByGroup.set(
          gid,
          g.filter((e) => e.unconditional !== false).map((e) => e.content).filter(Boolean).join(" ")
        );
      }
      for (const [gid, g] of attrGroups.entries()) {
        const otherAttrUncond = [...uncondByGroup.entries()]
          .filter(([ogid, txt]) => ogid !== gid && txt)
          .map(([, txt]) => txt)
          .join(" ");
        if (!otherAttrUncond) continue;
        for (const e of g) {
          e.siblingClasses = joinSibs(e.siblingClasses, otherAttrUncond);
        }
      }
    }
    for (const e of tagEntries) delete e._attrGroup;
  }
  if (options.includeHelpers) {
    const insideAttr = (idx) => attrRanges.some(([rs, re]) => idx >= rs && idx < re);
    const findTopLevelColonInSpan = (l, r) => {
      let p = 0;
      let b = 0;
      let br = 0;
      let q = null;
      let ls = "";
      const pSt = [];
      for (let k = l; k < r; k++) {
        const kc = s[k];
        if (q) {
          if (q === "`" && kc === "$" && k + 1 < r && s[k + 1] === "{") {
            const se = findBalancedDelimEnd(k + 1, "{", "}");
            if (se === -1 || se >= r) break;
            ls = "}";
            k = se;
            continue;
          }
          if (kc === "\\" && k + 1 < r) {
            k++;
            continue;
          }
          if (kc === q || (q !== "`" && kc === "\n")) {
            q = null;
            ls = kc;
          }
          continue;
        }
        const reEnd = skipJsRegexInExpr(s, k, ls, l);
        if (reEnd !== -1 && reEnd <= r) {
          ls = "/";
          k = reEnd - 1;
          continue;
        }
        if (kc === '"' || kc === "'" || kc === "`") q = kc;
        else if (kc === "(") {
          pSt.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(l, k - 16), k)));
          ls = "(";
          p++;
        } else if (kc === ")") {
          ls = pSt.length > 0 && pSt.pop() ? "control)" : ")";
          p = Math.max(0, p - 1);
        } else if (kc === "[") {
          b++;
          ls = kc;
        } else if (kc === "]") {
          b = Math.max(0, b - 1);
          ls = kc;
        } else if (kc === "{") {
          br++;
          ls = kc;
        } else if (kc === "}") {
          br = Math.max(0, br - 1);
          ls = kc;
        } else if (kc === ":" && p === 0 && b === 0 && br === 0) {
          return k;
        } else if (!/\s/.test(kc)) {
          ls = kc;
        }
      }
      return -1;
    };
    const scanCvaVariantArg = (ns, ne, baseSib) => {
      let l = ns;
      let r = ne;
      while (l < r && /\s/.test(s[l])) l++;
      while (r > l && /\s/.test(s[r - 1])) r--;
      if (l >= r) return;
      if (s[l] === "{" && findBalancedDelimEnd(l, "{", "}") === r - 1) {
        for (const [es, ee] of splitTopLevelSpan(l + 1, r - 1, ",")) {
          let eL = es;
          let eR = ee;
          while (eL < eR && /\s/.test(s[eL])) eL++;
          while (eR > eL && /\s/.test(s[eR - 1])) eR--;
          if (eL >= eR || s.startsWith("...", eL)) continue;
          const cIdx = findTopLevelColonInSpan(eL, eR);
          if (cIdx === -1) continue;
          const rawKey = s.slice(eL, cIdx).trim().replace(/^["']|["']$/g, "");
          if (rawKey === "defaultVariants") continue;
          scanCvaVariantArg(cIdx + 1, eR, baseSib);
        }
        return;
      }
      if (s[l] === "[" && findBalancedDelimEnd(l, "[", "]") === r - 1) {
        for (const [es, ee] of splitTopLevelSpan(l + 1, r - 1, ",")) {
          scanCvaVariantArg(es, ee, baseSib);
        }
        return;
      }
      emitExprLits(collectExprLits(l, r), baseSib);
    };
    let helperCursor = 0;
    for (const hm of s.matchAll(/(?<![a-zA-Z0-9_$.])(?:cn|clsx|cx|twMerge|twJoin|classNames|classnames|cva)\s*\(/g)) {
      if (hm.index < helperCursor || insideAttr(hm.index) || isHelperBlockedPos(hm.index)) continue;
      if (/\bfunction\s+$/.test(s.slice(Math.max(0, hm.index - 20), hm.index))) continue;
      const openP = hm.index + hm[0].length - 1;
      const closeP = findBalancedDelimEnd(openP, "(", ")");
      if (closeP === -1) continue;
      const args = splitTopLevelSpan(openP + 1, closeP, ",");
      const isCva = /^cva\b/.test(hm[0]);
      if (isCva && options.includeAllCvaArgs) {
        const baseGroup = args.length > 0 ? collectExprLits(args[0][0], args[0][1]) : [];
        const baseUncond = baseGroup.filter((x) => x.unconditional).map((x) => x.content).join(" ").trim();
        if (baseGroup.length > 0) emitExprLits(baseGroup, "");
        for (const [as, ae] of args.slice(1)) {
          scanCvaVariantArg(as, ae, baseUncond);
        }
      } else {
        const argSlice = isCva ? args.slice(0, 1) : args;
        const argGroups = argSlice.map(([ps, pe]) => collectExprLits(ps, pe));
        for (let gIdx = 0; gIdx < argGroups.length; gIdx++) {
          const otherArgsUncond = argGroups
            .filter((_, idx) => idx !== gIdx)
            .flatMap((g) => g.filter((x) => x.unconditional).map((x) => x.content))
            .join(" ")
            .trim();
          emitExprLits(argGroups[gIdx], otherArgsUncond);
        }
      }
      helperCursor = closeP + 1;
    }
  }
  return out;
}

export function extractTailwindClassSpans(src, options = {}) {
  return extractClassAttributes(src, { ...options, includeHelpers: true });
}

export function buildTailwindScanSurfacePreservingLines(surface, isStyle = false, markupOpts = null, styleTagRanges = []) {
  const s = String(surface || "");
  let twSurface;
  if (isStyle) {
    twSurface = maskCssQuotedStringsPreservingLines(s);
  } else {
    const opts = markupOpts || {};
    const ctx = scanMarkupContexts(s, opts);
    const chars = s.split("").map((c) => (c === "\n" ? "\n" : " "));
    const copySlice = (start, end, overrideText = null) => {
      const txt = overrideText !== null ? overrideText : s.slice(start, end);
      for (let k = 0; k < txt.length && start + k < chars.length; k++) {
        if (chars[start + k] !== "\n" && txt[k] !== " ") chars[start + k] = txt[k];
      }
    };
    for (const [s0, e0] of styleTagRanges || []) {
      copySlice(s0, e0, maskCssQuotedStringsPreservingLines(s.slice(s0, e0)));
    }
    for (const sp of extractTailwindClassSpans(s, { ...opts, markupCtx: ctx, includeAllCvaArgs: true })) {
      if (sp.contentStart >= 0 && sp.contentEnd > sp.contentStart) {
        const override =
          typeof sp.content === "string" && sp.content.length === sp.contentEnd - sp.contentStart ? sp.content : null;
        copySlice(sp.contentStart, sp.contentEnd, override);
      }
    }
    if (opts.isMarkupSfc && opts.braceExprs) {
      for (const dir of extractSvelteClassDirectives(s, ctx)) {
        if (dir.clsStart >= 0 && dir.cls) {
          copySlice(dir.clsStart, dir.clsStart + dir.cls.length);
        }
      }
    }
    twSurface = chars.join("");
  }
  return twSurface.replace(
    /(?<![a-zA-Z0-9_-])content-\[(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')\]/g,
    (seg) => seg.replace(/[^\n]/g, " ")
  );
}

function isBoxShadowLayerVisible(layer) {
  const tr = String(layer || "").trim();
  if (!tr || /^(?:none|0|initial|inherit|unset)$/i.test(tr)) return false;
  if (hasZeroAlphaColor(tr)) return false;
  if (/\btransparent\b/i.test(stripCssParens(tr))) return false;
  const rawTokens = [];
  let cur = "";
  let pd = 0;
  for (let i = 0; i < tr.length; i++) {
    const ch = tr[i];
    if (ch === "(") {
      pd++;
      cur += ch;
    } else if (ch === ")") {
      pd = Math.max(0, pd - 1);
      cur += ch;
    } else if (/\s/.test(ch) && pd === 0) {
      if (cur) {
        rawTokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) rawTokens.push(cur);
  const nonColorTokens = rawTokens.filter((t) => {
    if (/^inset$/i.test(t)) return false;
    if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;
    if (/^currentcolor$/i.test(t)) return false;
    if (/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i.test(t)) return false;
    return true;
  });
  const isStaticZeroLen = (t) => /^[-+]?(?:0(?:\.0+)?|\.0+)(?:px|rem|em|vw|vh|vmin|vmax|pt|pc|in|cm|mm|ch|ex|%)?$/i.test(t);
  const isStaticNumLen = (t) => /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|vw|vh|vmin|vmax|pt|pc|in|cm|mm|ch|ex|%)?$/i.test(t);
  let maxZeroRun = 0;
  let curZeroRun = 0;
  let sawNonZeroLen = false;
  let sawDynamicLen = false;
  for (const t of nonColorTokens) {
    if (isStaticZeroLen(t)) {
      curZeroRun++;
      if (curZeroRun > maxZeroRun) maxZeroRun = curZeroRun;
    } else if (isStaticNumLen(t)) {
      curZeroRun = 0;
      sawNonZeroLen = true;
    } else if (/^(?:calc|min|max|clamp)\s*\(/i.test(t)) {
      curZeroRun = 0;
      sawDynamicLen = true;
    } else if (/^var\s*\(/i.test(t)) {
      if (curZeroRun < 4 && /--[a-z0-9_-]*(?:width|size|spread|blur|radius|offset)\b/i.test(t)) {
        sawDynamicLen = true;
      }
      curZeroRun = 0;
    } else {
      curZeroRun = 0;
    }
  }
  if (!sawNonZeroLen && !sawDynamicLen && maxZeroRun >= 2) return false;
  return true;
}

function computeSelectorSpecificity(sel) {
  const str = String(sel || "").trim();
  let a = 0;
  let b = 0;
  let c = 0;
  const maxSpecOf = (argStr) => {
    let best = [0, 0, 0];
    for (const part of splitTopLevelCommas(argStr)) {
      const sp = computeSelectorSpecificity(part);
      if (compareSpecificity(sp, best) > 0) best = sp;
    }
    return best;
  };
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/[\s>+~*]/.test(ch) || ch === "&") {
      i++;
      continue;
    }
    if (ch === "[") {
      b++;
      i++;
      let q = null;
      while (i < str.length) {
        const bc = str[i];
        if (q) {
          if (bc === "\\" && i + 1 < str.length) i += 2;
          else {
            if (bc === q) q = null;
            i++;
          }
        } else if (bc === '"' || bc === "'") {
          q = bc;
          i++;
        } else if (bc === "]") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === "#") {
      a++;
      i++;
      while (i < str.length) {
        if (str[i] === "\\" && i + 1 < str.length) { i += 2; continue; }
        if (!/[a-zA-Z0-9_-]/.test(str[i]) && str.charCodeAt(i) < 128) break;
        i++;
      }
      continue;
    }
    if (ch === ".") {
      b++;
      i++;
      while (i < str.length) {
        if (str[i] === "\\" && i + 1 < str.length) { i += 2; continue; }
        if (!/[a-zA-Z0-9_-]/.test(str[i]) && str.charCodeAt(i) < 128) break;
        i++;
      }
      continue;
    }
    if (ch === ":") {
      const isDouble = str[i + 1] === ":";
      i += isDouble ? 2 : 1;
      const nameStart = i;
      while (i < str.length && /[a-zA-Z0-9_-]/.test(str[i])) i++;
      const pname = str.slice(nameStart, i).toLowerCase();
      let arg = null;
      if (str[i] === "(") {
        let d = 1;
        let pq = null;
        const argStart = i + 1;
        i++;
        while (i < str.length && d > 0) {
          const pc = str[i];
          if (pq) {
            if (pc === "\\" && i + 1 < str.length) i += 2;
            else {
              if (pc === pq) pq = null;
              i++;
            }
          } else if (pc === '"' || pc === "'") {
            pq = pc;
            i++;
          } else if (pc === "(") {
            d++;
            i++;
          } else if (pc === ")") {
            d--;
            if (d === 0) break;
            i++;
          } else {
            i++;
          }
        }
        arg = str.slice(argStart, i);
        if (str[i] === ")") i++;
      }
      if (isDouble) {
        c++;
      } else if (pname === "where") {
        // :where(...) always has zero specificity
      } else if ((pname === "is" || pname === "not" || pname === "has") && arg !== null) {
        const best = maxSpecOf(arg);
        a += best[0];
        b += best[1];
        c += best[2];
      } else if ((pname === "nth-child" || pname === "nth-last-child") && arg !== null) {
        b++;
        const ofM = /\bof\s+([\s\S]+)$/i.exec(arg);
        if (ofM) {
          const best = maxSpecOf(ofM[1]);
          a += best[0];
          b += best[1];
          c += best[2];
        }
      } else {
        b++;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < str.length) {
      i += 2;
      continue;
    }
    if (/[a-zA-Z_-]/.test(ch)) {
      c++;
      while (i < str.length) {
        if (str[i] === "\\" && i + 1 < str.length) { i += 2; continue; }
        if (!/[a-zA-Z0-9_|-]/.test(str[i]) && str.charCodeAt(i) < 128) break;
        i++;
      }
      continue;
    }
    i++;
  }
  return [a, b, c];
}

function compareSpecificity(spA, spB) {
  for (let i = 0; i < 3; i++) {
    if ((spA[i] || 0) !== (spB[i] || 0)) return (spA[i] || 0) > (spB[i] || 0) ? 1 : -1;
  }
  return 0;
}

function makeBorderSideState() {
  return {
    style: { state: null, imp: false, offset: -1, candWinsImportant: false },
    width: { state: null, imp: false, offset: -1, candWinsImportant: false },
    color: { state: null, imp: false, offset: -1, candWinsImportant: false },
    styleInvNormalOff: -1,
    widthInvNormalOff: -1,
    colorInvNormalOff: -1,
  };
}

function expandBorderSideChars(side = "") {
  if (side === "x") return ["l", "r"];
  if (side === "y") return ["t", "b"];
  if (side === "s") return ["l"];
  if (side === "e") return ["r"];
  if (side === "t" || side === "r" || side === "b" || side === "l") return [side];
  return ["t", "r", "b", "l"];
}

function collectRingTupleState(initTuple = null) {
  return (
    initTuple || {
      width: { state: null, imp: false, offset: -1, candWinsImportant: false },
      color: { state: null, imp: false, offset: -1, candWinsImportant: false },
      widthInvNormalOff: -1,
      colorInvNormalOff: -1,
      saw: false,
    }
  );
}

function collectBorderTupleState(maskedBody, initTuple = null, baseOffset = 0, impFilter = "all", candMeta = null) {
  const borderTuple = initTuple || {
    style: { state: null, imp: false, offset: -1, candWinsImportant: false },
    width: { state: null, imp: false, offset: -1, candWinsImportant: false },
    color: { state: null, imp: false, offset: -1, candWinsImportant: false },
    styleInvNormalOff: -1,
    widthInvNormalOff: -1,
    colorInvNormalOff: -1,
    sides: {
      t: makeBorderSideState(),
      r: makeBorderSideState(),
      b: makeBorderSideState(),
      l: makeBorderSideState(),
    },
    sawBorder: false,
  };
  if (!borderTuple.sides) {
    borderTuple.sides = {
      t: makeBorderSideState(),
      r: makeBorderSideState(),
      b: makeBorderSideState(),
      l: makeBorderSideState(),
    };
  }
  const setTargetComp = (targetObj, comp, state, imp, off) => {
    if (!imp && state === "invisible") {
      targetObj[`${comp}InvNormalOff`] = Math.max(targetObj[`${comp}InvNormalOff`] ?? -1, off);
    }
    const cur = targetObj[comp];
    if (cur.state !== null && cur.imp && !imp) return;
    targetObj[comp] = {
      state,
      imp,
      offset: off,
      candWinsImportant: candMeta ? Boolean(candMeta.candWinsImportant) : Boolean(cur.candWinsImportant),
    };
  };
  const setBorderComp = (comp, state, imp, off, side = "") => {
    if (!side) setTargetComp(borderTuple, comp, state, imp, off);
    for (const sCh of expandBorderSideChars(side)) {
      setTargetComp(borderTuple.sides[sCh], comp, state, imp, off);
    }
  };
  const SIDE_WORD_MAP = { top: "t", right: "r", bottom: "b", left: "l" };
  for (const bm of String(maskedBody || "").matchAll(/(?<![a-zA-Z0-9_$-])border(?:-(top|right|bottom|left))?(?:-(style|width|color))?\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const side = bm[1] ? SIDE_WORD_MAP[bm[1].toLowerCase()] || "" : "";
    const sub = bm[2] ? bm[2].toLowerCase() : "";
    const bProp = sub ? `border-${sub}` : "border";
    const bInfo = classifyBorderDecl(bProp, bm[3]);
    if (impFilter === "normal-only" && bInfo.isImportant) continue;
    if (impFilter === "important-only" && !bInfo.isImportant) continue;
    borderTuple.sawBorder = true;
    const off = baseOffset + bm.index;
    if (bProp === "border-style") setBorderComp("style", bInfo.state, bInfo.isImportant, off, side);
    else if (bProp === "border-width") setBorderComp("width", bInfo.state, bInfo.isImportant, off, side);
    else if (bProp === "border-color") setBorderComp("color", bInfo.state, bInfo.isImportant, off, side);
    else {
      const bSup = new Set(bInfo.suppressedProps);
      setBorderComp("style", bSup.has("style") ? "invisible" : "visible", bInfo.isImportant, off, side);
      setBorderComp("width", bSup.has("width") ? "invisible" : "visible", bInfo.isImportant, off, side);
      setBorderComp("color", bSup.has("color") ? "invisible" : "visible", bInfo.isImportant, off, side);
    }
  }
  return borderTuple;
}

function collectRuleBorderAndShadowFromRawBody(rawBody, options = {}) {
  const {
    borderTuple = collectBorderTupleState(""),
    ringTuple = collectRingTupleState(),
    insetRingTuple = collectRingTupleState(),
    baseOffset = 0,
    impFilter = "all",
    candWinsImportant = false,
    allowFocusVariants = false,
    treatFocusMatch = false,
    applyKillersOnly = false,
  } = options;
  const rawStr = String(rawBody || "");
  const masked = maskCssQuotedStringsPreservingLines(rawStr);
  const cssDeclOnly = maskAtApplyDeclsPreservingLines(masked);
  const setTargetComp = (targetObj, comp, state, imp, off) => {
    if (impFilter === "normal-only" && imp) return;
    if (impFilter === "important-only" && !imp) return;
    if (!imp && state === "invisible") {
      targetObj[`${comp}InvNormalOff`] = Math.max(targetObj[`${comp}InvNormalOff`] ?? -1, off);
    }
    const cur = targetObj[comp];
    if (cur.state !== null && cur.imp && !imp) return;
    targetObj[comp] = {
      state,
      imp,
      offset: off,
      candWinsImportant: candWinsImportant || Boolean(cur.candWinsImportant),
    };
  };
  const setBorderComp = (comp, state, imp, off, side = "") => {
    if (!side) setTargetComp(borderTuple, comp, state, imp, off);
    for (const sCh of expandBorderSideChars(side)) {
      setTargetComp(borderTuple.sides[sCh], comp, state, imp, off);
    }
  };
  const setRingComp = (targetTuple, comp, state, imp, off) => {
    targetTuple.saw = true;
    setTargetComp(targetTuple, comp, state, imp, off);
  };

  const SIDE_WORD_MAP = { top: "t", right: "r", bottom: "b", left: "l" };
  const events = [];
  for (const bm of cssDeclOnly.matchAll(/(?<![a-zA-Z0-9_$-])border(?:-(top|right|bottom|left))?(?:-(style|width|color))?\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const side = bm[1] ? SIDE_WORD_MAP[bm[1].toLowerCase()] || "" : "";
    const sub = bm[2] ? bm[2].toLowerCase() : "";
    const bProp = sub ? `border-${sub}` : "border";
    const bInfo = classifyBorderDecl(bProp, bm[3]);
    if (impFilter === "normal-only" && bInfo.isImportant) continue;
    if (impFilter === "important-only" && !bInfo.isImportant) continue;
    events.push({ kind: "css-border", offset: baseOffset + bm.index, side, bProp, bInfo });
  }
  for (const bm of cssDeclOnly.matchAll(/(?<![a-zA-Z0-9_$-])box-shadow\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const imp = /!\s*important\b/i.test(bm[1]);
    if (impFilter === "normal-only" && imp) continue;
    if (impFilter === "important-only" && !imp) continue;
    const cleanBox = bm[1].replace(/!\s*important\b/gi, "").trim();
    const vis = Boolean(
      cleanBox &&
        !/^(?:none|0|initial|inherit|unset)$/i.test(cleanBox) &&
        splitTopLevelCommas(cleanBox).some((layer) => isBoxShadowLayerVisible(layer))
    );
    events.push({ kind: "box", offset: baseOffset + bm.index, imp, vis, fromRingFamily: null });
  }

  const applyMask = maskCssQuotedStringsPreservingLines(rawStr, "_");
  for (const am of masked.matchAll(/(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const appStart = am.index + am[0].indexOf(am[1]);
    const rawStmt = applyMask.slice(appStart, appStart + am[1].length);
    const stmtImp = /\s*!\s*important\s*$/i.test(rawStmt);
    const appNoImp = stmtImp ? rawStmt.replace(/\s*!\s*important\s*$/i, "") : rawStmt;
    let tokSeq = 0;
    for (const rawTok of appNoImp.trim().split(/\s+/).filter(Boolean)) {
      const info = splitTailwindVariants(rawTok);
      if (info.targetPrefixes.size > 0 || info.condPrefixes.size > 0) continue;
      if (info.focusKind !== null && (!allowFocusVariants || (info.focusKind !== "focus" && info.focusKind !== "focus-visible"))) {
        continue;
      }
      if (info.focusKind === null && treatFocusMatch === false && allowFocusVariants === false) {
        continue;
      }
      const rb = classifyTwRingOrBorder(rawTok);
      if (!rb) continue;
      const tokImp = stmtImp || /(?:^|:)!|!$/.test(rawTok);
      if (impFilter === "normal-only" && tokImp) continue;
      if (impFilter === "important-only" && !tokImp) continue;
      const off = baseOffset + am.index + tokSeq++ * 0.0001;
      if (rb.family === "border") {
        const isKiller = rb.killsWidth || rb.killsStyle || rb.killsColor;
        const isSetter = rb.setsWidth || rb.setsStyle || rb.setsColor;
        if (isKiller || (!applyKillersOnly && isSetter)) {
          events.push({ kind: "tw-border", offset: off, imp: tokImp, rb, isKiller });
        }
      } else if (rb.family === "ring" || rb.family === "inset-ring") {
        const isKiller = rb.killsWidth || rb.killsStyle || rb.killsColor;
        const isSetter = rb.setsWidth || rb.setsColor;
        if (isKiller || (!applyKillersOnly && isSetter)) {
          events.push({ kind: "tw-ring", offset: off, imp: tokImp, rb });
        }
        if (rb.killsWidth || rb.killsStyle) {
          events.push({ kind: "box", offset: off, imp: tokImp, vis: false, fromRingFamily: rb.family });
        }
      } else if (rb.family === "shadow") {
        const isKiller = rb.killsWidth;
        const isSetter = rb.setsWidth && rb.setsStyle && rb.setsColor;
        if (isKiller) {
          events.push({ kind: "box", offset: off, imp: tokImp, vis: false, fromRingFamily: null });
        } else if (!applyKillersOnly && isSetter) {
          events.push({ kind: "box", offset: off, imp: tokImp, vis: true, fromRingFamily: null });
        }
      }
    }
  }

  events.sort((a, b) => a.offset - b.offset);
  const boxDecls = [];
  for (const ev of events) {
    if (ev.kind === "box") {
      boxDecls.push({ vis: ev.vis, imp: ev.imp, offset: ev.offset, candWinsImportant, fromRingFamily: ev.fromRingFamily || null });
      continue;
    }
    if (ev.kind === "css-border") {
      borderTuple.sawBorder = true;
      const { bProp, bInfo, offset, side } = ev;
      if (bProp === "border-style") setBorderComp("style", bInfo.state, bInfo.isImportant, offset, side);
      else if (bProp === "border-width") setBorderComp("width", bInfo.state, bInfo.isImportant, offset, side);
      else if (bProp === "border-color") setBorderComp("color", bInfo.state, bInfo.isImportant, offset, side);
      else {
        const bSup = new Set(bInfo.suppressedProps);
        setBorderComp("style", bSup.has("style") ? "invisible" : "visible", bInfo.isImportant, offset, side);
        setBorderComp("width", bSup.has("width") ? "invisible" : "visible", bInfo.isImportant, offset, side);
        setBorderComp("color", bSup.has("color") ? "invisible" : "visible", bInfo.isImportant, offset, side);
      }
      continue;
    }
    if (ev.kind === "tw-border") {
      borderTuple.sawBorder = true;
      const { rb, imp, offset } = ev;
      if (rb.killsStyle) setBorderComp("style", "invisible", imp, offset, rb.side);
      else if (!applyKillersOnly && rb.setsStyle) setBorderComp("style", "visible", imp, offset, rb.side);
      if (rb.killsWidth) setBorderComp("width", "invisible", imp, offset, rb.side);
      else if (!applyKillersOnly && rb.setsWidth) setBorderComp("width", "visible", imp, offset, rb.side);
      if (rb.killsColor) setBorderComp("color", "invisible", imp, offset, rb.side);
      else if (!applyKillersOnly && rb.setsColor) setBorderComp("color", "visible", imp, offset, rb.side);
      continue;
    }
    if (ev.kind === "tw-ring") {
      const { rb, imp, offset } = ev;
      const tgt = rb.family === "inset-ring" ? insetRingTuple : ringTuple;
      if (rb.killsWidth || rb.killsStyle) setRingComp(tgt, "width", "invisible", imp, offset);
      else if (!applyKillersOnly && rb.setsWidth) setRingComp(tgt, "width", "visible", imp, offset);
      if (rb.killsColor) setRingComp(tgt, "color", "invisible", imp, offset);
      else if (!applyKillersOnly && rb.setsColor) setRingComp(tgt, "color", "visible", imp, offset);
    }
  }
  for (const comp of ["style", "width", "color"]) {
    const sideStates = ["t", "r", "b", "l"].map((sCh) => borderTuple.sides[sCh][comp]);
    if (sideStates.every((st) => st.state === "invisible")) {
      const allImp = sideStates.every((st) => st.imp);
      const maxOff = Math.max(...sideStates.map((st) => st.offset));
      setTargetComp(borderTuple, comp, "invisible", allImp, maxOff);
    }
  }
  return { borderTuple, boxDecls, ringTuple, insetRingTuple };
}

export function hasVisibleFocusIndicator(body, selector = "", options = {}) {
  const rawBody = String(body || "");
  const maskedBody = maskCssQuotedStringsPreservingLines(rawBody);
  const cssDeclBody = maskAtApplyDeclsPreservingLines(maskedBody);
  const selBranches = splitTopLevelCommas(selector).filter(Boolean);
  const isFocusSelector =
    Boolean(options.treatAsFocusSelector) ||
    (selBranches.length > 0 &&
      selBranches.every((b) => /(?<!\\)(?::focus(?:-visible|-within)?\b|:has\([^;]*:focus)/i.test(stripNotPseudo(extractSubjectSelector(b)))));
  const { borderTuple, boxDecls, ringTuple, insetRingTuple } = collectRuleBorderAndShadowFromRawBody(rawBody, {
    allowFocusVariants: true,
    treatFocusMatch: isFocusSelector,
    applyKillersOnly: true,
  });
  let winBox = null;
  let lastInvNormalBoxOff = -1;
  let winPureBox = null;
  let lastInvNormalPureBoxOff = -1;
  for (const bd of boxDecls) {
    if (!bd.imp && !bd.vis) lastInvNormalBoxOff = Math.max(lastInvNormalBoxOff, bd.offset);
    if (!winBox || bd.imp || !winBox.imp) {
      winBox = { imp: bd.imp, vis: bd.vis, offset: bd.offset };
    }
    if (!bd.fromRingFamily) {
      if (!bd.imp && !bd.vis) lastInvNormalPureBoxOff = Math.max(lastInvNormalPureBoxOff, bd.offset);
      if (!winPureBox || bd.imp || !winPureBox.imp) {
        winPureBox = { imp: bd.imp, vis: bd.vis, offset: bd.offset };
      }
    }
  }
  const pureBoxImpSup =
    options.pureBoxShadowImportantSuppressed !== undefined
      ? Boolean(options.pureBoxShadowImportantSuppressed)
      : Boolean(options.boxShadowImportantSuppressed);
  const pureBoxUnrecov =
    options.pureBoxShadowUnrecoverable !== undefined
      ? Boolean(options.pureBoxShadowUnrecoverable)
      : Boolean(options.boxShadowUnrecoverable);
  const pureBoxSrcSup =
    options.pureBoxShadowSuppressedBySrc !== undefined
      ? Boolean(options.pureBoxShadowSuppressedBySrc)
      : Boolean(options.boxShadowSuppressedBySrc);
  const extSideImp = options.borderSideImportantSuppressed || {};
  const extSideNorm = options.borderSideSuppressed || {};
  const extSideUnrec = options.borderSideUnrecoverable || {};
  const borderNeedsImp = Boolean(options.requireImportantOnly || (options.requireImportantOutlineOnly && options.borderSuppressedBySrc));
  const checkCssSideBorderVisible = (sCh) => {
    const sBt = borderTuple.sides?.[sCh] || borderTuple;
    if ((options.borderUnrecoverableProps || []).length > 0 || (extSideUnrec[sCh] || []).length > 0) return false;
    const effComp = (comp) => {
      const a = borderTuple[comp];
      const b = sBt[comp];
      if (!b || b.state === null) return a;
      if (!a || a.state === null) return b;
      if (a.imp && !b.imp) return a;
      if (b.imp && !a.imp) return b;
      return b.offset >= a.offset ? b : a;
    };
    const eComps = ["style", "width", "color"].map(effComp);
    if (eComps.some((c) => c.state === "invisible") || !eComps.some((c) => c.state === "visible")) return false;
    const reqNorm = new Set([...(options.borderSuppressedProps || []), ...(extSideNorm[sCh] || [])]);
    const reqImp = new Set([...(options.borderImportantSuppressedProps || []), ...(extSideImp[sCh] || [])]);
    for (const req of reqNorm) {
      if (effComp(req)?.state !== "visible") return false;
    }
    for (const req of reqImp) {
      const ec = effComp(req);
      if (ec?.state !== "visible" || !ec?.imp) return false;
    }
    if (borderNeedsImp && !eComps.some((c) => c.state === "visible" && c.imp)) return false;
    return true;
  };
  if (isFocusSelector) {
    if (winBox) {
      const boxNeedsImp = Boolean(options.requireImportantOnly || (options.requireImportantOutlineOnly && options.boxShadowSuppressedBySrc));
      const boxImpAllowed = !boxNeedsImp || winBox.imp;
      const notBlockedBySup = !options.boxShadowUnrecoverable && (!options.boxShadowImportantSuppressed || winBox.imp);
      if (winBox.vis && boxImpAllowed && notBlockedBySup) {
        return true;
      }
    }
    if (borderTuple.sawBorder) {
      const allSideVisible = ["style", "width", "color"].every((c) => borderTuple[c].state !== "invisible") &&
        ["style", "width", "color"].some((c) => borderTuple[c].state === "visible") &&
        !(options.borderUnrecoverableProps || []).length &&
        !(options.borderSuppressedProps || []).some((req) => borderTuple[req]?.state !== "visible") &&
        !(options.borderImportantSuppressedProps || []).some((req) => borderTuple[req]?.state !== "visible" || !borderTuple[req]?.imp) &&
        (!borderNeedsImp || ["style", "width", "color"].some((c) => borderTuple[c].state === "visible" && borderTuple[c].imp));
      if (allSideVisible || ["t", "r", "b", "l"].some(checkCssSideBorderVisible)) {
        return true;
      }
    }
  }
  const applyReG = /(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi;
  const applyMaskedBody = maskCssQuotedStringsPreservingLines(rawBody, "_");
  const applyMatches = [...maskedBody.matchAll(applyReG)];
  const events = [];
  if (applyMatches.length > 0) {
    const nonOutlineEntries = [];
    const appOutlineRemRe = new RegExp(`(?:^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_OUTLINE_REM_BODY}!?)(?=$|[\\s;])`, "g");
    const appOutlineVisRe = new RegExp(`(?:^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_OUTLINE_VIS_BODY}!?(?=$|[\\s;]))`, "g");
    const sameRuleBoxImpSup = Boolean(winPureBox && !winPureBox.vis && winPureBox.imp);
    const sameRuleBoxImpOff = sameRuleBoxImpSup ? winPureBox.offset : -1;
    const extBorderImpSet = new Set(options.borderImportantSuppressedProps || []);
    const extBorderNormSet = new Set(options.borderSuppressedProps || []);
    const borderUnrecoverable = (options.borderUnrecoverableProps || []).length > 0;
    const borderNeedsImpReq = Boolean(options.requireImportantOnly || (options.requireImportantOutlineOnly && options.borderSuppressedBySrc));
    for (const am of applyMatches) {
      const appStart = am.index + am[0].indexOf(am[1]);
      const rawStmt = applyMaskedBody.slice(appStart, appStart + am[1].length);
      const stmtImp = /\s*!\s*important\s*$/i.test(rawStmt);
      const appNoImp = stmtImp ? rawStmt.replace(/\s*!\s*important\s*$/i, "") : rawStmt;
      for (const rawTok of appNoImp.trim().split(/\s+/).filter(Boolean)) {
        const info = splitTailwindVariants(rawTok);
        if (info.targetPrefixes.size > 0) continue;
        if (options.forWrapperChildFocus && (info.focusKind === "focus" || info.focusKind === "focus-visible")) continue;
        const util = getTwUtilityPart(rawTok).toLowerCase();
        if (/^(?:outline(?:-|$)|\[outline(?:-(?:style|width|color))?:)/i.test(util)) continue;
        const isKiller = isInvisibleTwFocusUtility(rawTok);
        let tok = isFocusSelector && !info.focusKind ? `focus-visible:${rawTok}` : rawTok;
        if (stmtImp && !/(?:^|:)!|!$/.test(tok)) tok = `!${tok}`;
        const tokHasImp = /(?:^|:)!|!$/.test(tok);
        const rb = classifyTwRingOrBorder(rawTok);
        const isRingOrShadow = rb
          ? rb.family === "ring" || rb.family === "inset-ring" || rb.family === "shadow"
          : /^(?:(?:inset-)?ring|shadow)(?:-|$)/i.test(util);
        const isBorderUtil = rb ? rb.family === "border" : /^border(?:-|$)/i.test(util);
        const isRingFamily = rb ? rb.family === "ring" : /^ring(?:-|$)/i.test(util);
        const isInsetRingFamily = rb ? rb.family === "inset-ring" : /^inset-ring(?:-|$)/i.test(util);
        const tokNeedsImp =
          Boolean(options.requireImportantOnly) ||
          (Boolean(options.requireImportantOutlineOnly) &&
            (((isRingFamily && options.ringSuppressedBySrc) ||
              (isInsetRingFamily && options.insetRingSuppressedBySrc) ||
              (isRingOrShadow && pureBoxSrcSup)) ||
              (isBorderUtil && Boolean(options.borderSuppressedBySrc))));
        if (!isKiller && tokNeedsImp && !tokHasImp) continue;
        if (!isKiller && isRingOrShadow) {
          if (pureBoxUnrecov) continue;
          if (pureBoxImpSup && !tokHasImp) continue;
          if (sameRuleBoxImpSup && (!tokHasImp || appStart < sameRuleBoxImpOff)) continue;
          if (!tokHasImp && lastInvNormalPureBoxOff > appStart) continue;
          if (isRingFamily && rb) {
            if ((options.ringUnrecoverableProps || []).length > 0) continue;
            nonOutlineEntries.push({ tok, isBorderCand: false, isRingCand: true, appStart, tokHasImp, rb });
            continue;
          }
          if (isInsetRingFamily && rb) {
            if ((options.insetRingUnrecoverableProps || []).length > 0) continue;
            nonOutlineEntries.push({ tok, isBorderCand: false, isInsetRingCand: true, appStart, tokHasImp, rb });
            continue;
          }
        }
        const coversFocus = isKiller || isFocusSelector || info.focusKind === "focus" || info.focusKind === "focus-visible";
        if (!coversFocus) continue;
        if (!isKiller && isBorderUtil && rb) {
          if (borderUnrecoverable) continue;
          nonOutlineEntries.push({ tok, isBorderCand: true, appStart, tokHasImp, rb });
        } else {
          nonOutlineEntries.push({ tok, isBorderCand: false });
        }
      }
      for (const m of appNoImp.matchAll(appOutlineRemRe)) {
        const tok = m[1];
        if (!isTwOutlineRemoval(tok)) continue;
        const info = splitTailwindVariants(tok);
        if (info.condPrefixes.size === 0 && info.targetPrefixes.size === 0 && (isFocusSelector || info.focusKind === null || info.focusKind === "focus" || info.focusKind === "focus-visible")) {
          events.push({
            offset: appStart + m.index,
            kind: "apply-outline",
            state: "invisible",
            isImportant: stmtImp || /(?:^|:)!|!$/.test(tok),
            spec: info.focusKind === "focus-visible" ? 2 : info.focusKind === "focus" ? 1 : 0,
            rb: classifyTwRingOrBorder(tok),
          });
        }
      }
      if (!options.ignoreApplyOutline && !options.outlineUnrecoverable) {
        for (const m of appNoImp.matchAll(appOutlineVisRe)) {
          const tok = m[1];
          if (isInvisibleTwFocusUtility(tok)) continue;
          const info = splitTailwindVariants(tok);
          if (options.forWrapperChildFocus && (info.focusKind === "focus" || info.focusKind === "focus-visible")) continue;
          if (info.condPrefixes.size === 0 && info.targetPrefixes.size === 0 && (isFocusSelector || info.focusKind === "focus" || info.focusKind === "focus-visible")) {
            events.push({
              offset: appStart + m.index,
              kind: "apply-outline",
              state: "visible",
              isImportant: stmtImp || /(?:^|:)!|!$/.test(tok),
              spec: info.focusKind === "focus-visible" ? 2 : info.focusKind === "focus" ? 1 : 0,
              rb: classifyTwRingOrBorder(tok),
            });
          }
        }
      }
    }
    const validateRingGroup = (cands, sameTuple, extNormArr, extImpArr, extUnrecArr, needsImpReq) => {
      if (cands.length === 0) return { valid: true, impComps: new Set() };
      if ((extUnrecArr || []).length > 0) return { valid: false, impComps: new Set() };
      const extNormSet = new Set(extNormArr || []);
      const extImpSet = new Set(extImpArr || []);
      const reqImpComps = new Set(extImpArr || []);
      for (const [comp, setFlag] of [
        ["width", "setsWidth"],
        ["color", "setsColor"],
      ]) {
        const extImp = extImpSet.has(comp);
        const extNorm = extNormSet.has(comp);
        const btComp = sameTuple[comp];
        const sameImp = btComp.state === "invisible" && btComp.imp;
        const sameImpOff = sameImp ? btComp.offset : -1;
        const sameNormOff = sameTuple[`${comp}InvNormalOff`] ?? -1;
        if (sameImp) reqImpComps.add(comp);
        const hasAnySupp = extImp || extNorm || sameImp || sameNormOff >= 0 || (needsImpReq && comp === "width");
        if (!hasAnySupp) continue;
        const twRestored = cands.some((c) => {
          if (!c.rb[setFlag]) return false;
          if ((extImp || needsImpReq) && !c.tokHasImp) return false;
          if (sameImp && (!c.tokHasImp || c.appStart < sameImpOff)) return false;
          if (!sameImp && sameNormOff > c.appStart && !c.tokHasImp) return false;
          return true;
        });
        if (!twRestored) return { valid: false, impComps: reqImpComps };
      }
      return { valid: true, impComps: reqImpComps };
    };
    const ringRes = validateRingGroup(
      nonOutlineEntries.filter((e) => e.isRingCand),
      ringTuple,
      options.ringSuppressedProps,
      options.ringImportantSuppressedProps,
      options.ringUnrecoverableProps,
      Boolean(options.requireImportantOnly || (options.requireImportantOutlineOnly && options.ringSuppressedBySrc))
    );
    const insetRingRes = validateRingGroup(
      nonOutlineEntries.filter((e) => e.isInsetRingCand),
      insetRingTuple,
      options.insetRingSuppressedProps,
      options.insetRingImportantSuppressedProps,
      options.insetRingUnrecoverableProps,
      Boolean(options.requireImportantOnly || (options.requireImportantOutlineOnly && options.insetRingSuppressedBySrc))
    );
    const borderTokenCands = nonOutlineEntries.filter((e) => e.isBorderCand);
    const validBorderSides = new Set();
    if (borderTokenCands.length > 0 && !borderUnrecoverable) {
      const touchedSides = new Set(borderTokenCands.flatMap((c) => expandBorderSideChars(c.rb.side)));
      for (const sCh of touchedSides) {
        if ((extSideUnrec[sCh] || []).length > 0) continue;
        const sideCands = borderTokenCands.filter((c) => expandBorderSideChars(c.rb.side).includes(sCh));
        const sImpSet = new Set([...extBorderImpSet, ...(extSideImp[sCh] || [])]);
        const sNormSet = new Set([...extBorderNormSet, ...(extSideNorm[sCh] || [])]);
        const sBt = borderTuple.sides?.[sCh] || borderTuple;
        let sideOk = true;
        for (const [comp, setFlag] of [
          ["style", "setsStyle"],
          ["width", "setsWidth"],
          ["color", "setsColor"],
        ]) {
          const extImp = sImpSet.has(comp);
          const extNorm = sNormSet.has(comp);
          const allComp = borderTuple[comp];
          const sideComp = sBt[comp];
          const sameImp = (sideComp.state === "invisible" && sideComp.imp) || (allComp.state === "invisible" && allComp.imp);
          const sameImpOff = Math.max(
            sideComp.state === "invisible" && sideComp.imp ? sideComp.offset : -1,
            allComp.state === "invisible" && allComp.imp ? allComp.offset : -1
          );
          const sameNormOff = Math.max(sBt[`${comp}InvNormalOff`] ?? -1, borderTuple[`${comp}InvNormalOff`] ?? -1);
          const hasAnySupp = extImp || extNorm || sameImp || sameNormOff >= 0;
          if (!hasAnySupp) continue;
          const cssRestored =
            isFocusSelector &&
            ((sideComp.state === "visible" && (!extImp || sideComp.imp) && (!borderNeedsImpReq || sideComp.imp)) ||
              (allComp.state === "visible" && sideComp.state !== "invisible" && (!extImp || allComp.imp) && (!borderNeedsImpReq || allComp.imp)));
          if (cssRestored) continue;
          const twRestored = sideCands.some((c) => {
            if (!c.rb[setFlag]) return false;
            if (extImp && !c.tokHasImp) return false;
            if (sameImp && (!c.tokHasImp || c.appStart < sameImpOff)) return false;
            if (!sameImp && sameNormOff > c.appStart && !c.tokHasImp) return false;
            return true;
          });
          if (!twRestored) {
            sideOk = false;
            break;
          }
        }
        if (sideOk) validBorderSides.add(sCh);
      }
    }
    const nonOutlineTwTokens = nonOutlineEntries
      .filter((e) => {
        if (e.isRingCand) {
          if (!ringRes.valid) return false;
          const needsImp =
            (e.rb.setsWidth && ringRes.impComps.has("width")) ||
            (e.rb.setsColor && ringRes.impComps.has("color"));
          return !(needsImp && !e.tokHasImp);
        }
        if (e.isInsetRingCand) {
          if (!insetRingRes.valid) return false;
          const needsImp =
            (e.rb.setsWidth && insetRingRes.impComps.has("width")) ||
            (e.rb.setsColor && insetRingRes.impComps.has("color"));
          return !(needsImp && !e.tokHasImp);
        }
        if (!e.isBorderCand) return true;
        const cSides = expandBorderSideChars(e.rb.side);
        if (!cSides.some((sCh) => validBorderSides.has(sCh))) return false;
        const extAnyImp = cSides
          .filter((sCh) => validBorderSides.has(sCh))
          .some((sCh) => {
            const sBt = borderTuple.sides?.[sCh] || borderTuple;
            const sImpSet = new Set([...extBorderImpSet, ...(extSideImp[sCh] || [])]);
            return (
              (e.rb.setsStyle && (sImpSet.has("style") || (sBt.style.state === "invisible" && sBt.style.imp) || (borderTuple.style.state === "invisible" && borderTuple.style.imp))) ||
              (e.rb.setsWidth && (sImpSet.has("width") || (sBt.width.state === "invisible" && sBt.width.imp) || (borderTuple.width.state === "invisible" && borderTuple.width.imp))) ||
              (e.rb.setsColor && (sImpSet.has("color") || (sBt.color.state === "invisible" && sBt.color.imp) || (borderTuple.color.state === "invisible" && borderTuple.color.imp)))
            );
          });
        return !(extAnyImp && !e.tokHasImp);
      })
      .map((e) => e.tok);
    if (nonOutlineTwTokens.length > 0 && !analyzeTailwindOutline(`outline-none ${nonOutlineTwTokens.join(" ")}`).naked) {
      return true;
    }
  }

  if (options.outlineUnrecoverable) return false;
  for (const m of cssDeclBody.matchAll(/(?<![a-zA-Z0-9_$-])(outline|outline-style|outline-width|outline-color)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
    const prop = m[1].toLowerCase();
    const info = classifyOutlineDecl(prop, m[2]);
    if (options.applyFocusOnly && info.state === "visible") continue;
    events.push({
      offset: m.index,
      kind: "css-outline",
      prop,
      info,
    });
  }
  events.sort((a, b) => a.offset - b.offset);

  const tuple = {
    style: { state: null, imp: false, spec: 0 },
    width: { state: null, imp: false, spec: 0 },
    color: { state: null, imp: false, spec: 0 },
  };
  const setComp = (comp, state, imp, spec = 0) => {
    const cur = tuple[comp];
    if (cur.state !== null) {
      if (cur.imp && !imp) return;
      if (cur.imp === imp && spec < cur.spec) return;
    }
    tuple[comp] = { state, imp, spec };
  };
  let sawOutline = false;
  for (const ev of events) {
    sawOutline = true;
    if (ev.kind === "apply-outline") {
      if (ev.state === "invisible") {
        if (!ev.rb || ev.rb.killsStyle) setComp("style", "invisible", ev.isImportant, ev.spec);
        if (!ev.rb || ev.rb.killsWidth) setComp("width", "invisible", ev.isImportant, ev.spec);
        if (!ev.rb || ev.rb.killsColor) setComp("color", "invisible", ev.isImportant, ev.spec);
      } else {
        if (!ev.rb || ev.rb.setsStyle) setComp("style", "visible", ev.isImportant, ev.spec);
        if (!ev.rb || ev.rb.setsWidth) setComp("width", "visible", ev.isImportant, ev.spec);
        if (!ev.rb || ev.rb.setsColor) setComp("color", "visible", ev.isImportant, ev.spec);
      }
      continue;
    }
    const { prop, info } = ev;
    if (prop === "outline-style") {
      setComp("style", info.state, info.isImportant, 0);
    } else if (prop === "outline-width") {
      setComp("width", info.state, info.isImportant, 0);
    } else if (prop === "outline-color") {
      setComp("color", info.state, info.isImportant, 0);
    } else {
      const sup = new Set(info.suppressedProps);
      setComp("style", sup.has("style") ? "invisible" : "visible", info.isImportant, 0);
      setComp("width", sup.has("width") ? "invisible" : "visible", info.isImportant, 0);
      setComp("color", sup.has("color") ? "invisible" : "visible", info.isImportant, 0);
    }
  }
  if (!sawOutline) return false;
  const comps = [tuple.style, tuple.width, tuple.color];
  if (comps.some((c) => c.state === "invisible") || !comps.some((c) => c.state === "visible")) {
    return false;
  }
  for (const req of options.suppressedProps || []) {
    if (tuple[req] && tuple[req].state !== "visible") return false;
  }
  for (const req of options.importantSuppressedProps || []) {
    if (tuple[req] && (!tuple[req].imp || tuple[req].state !== "visible")) return false;
  }
  if (options.requireImportantOnly || options.requireImportantOutlineOnly) {
    if (!comps.some((c) => c.state === "visible" && c.imp)) return false;
    if (comps.some((c) => c.state === "visible" && !c.imp)) return false;
  }
  return true;
}

export function discoverExternalDsCss(startDir = ".", explicitPaths = []) {
  const paths = [];
  const seen = new Set();
  if (typeof explicitPaths === "string" && !explicitPaths.trim()) {
    throw new Error("External DS CSS file path cannot be empty.");
  }
  for (const rawP of Array.isArray(explicitPaths) ? explicitPaths : explicitPaths ? [explicitPaths] : []) {
    if (typeof rawP !== "string" || !rawP.trim()) {
      throw new Error("External DS CSS file path cannot be empty.");
    }
    const parts = String(rawP).split(",").map((part) => part.trim());
    if (parts.some((p) => !p)) {
      throw new Error(`External DS CSS list contains an empty path: ${rawP}`);
    }
    for (const p of parts) {
      const candCwd = resolve(p);
      const candStart = resolve(startDir || ".", p);
      const chosen = existsSync(candCwd) ? candCwd : candStart;
      if (!existsSync(chosen) || !statSync(chosen).isFile()) {
        throw new Error(`External DS CSS file not found: ${p}`);
      }
      if (!seen.has(chosen)) {
        seen.add(chosen);
        paths.push(chosen);
      }
    }
  }
  for (const autoP of findAncestorDsCssFiles(startDir)) {
    if (!seen.has(autoP)) {
      seen.add(autoP);
      paths.push(autoP);
    }
  }

  const focusBlocks = [];
  let extSeq = 0;
  for (const p of paths) {
    let raw = "";
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const clean = stripCommentsPreservingLines(raw);
    for (const blk of extractCssRuleBlocks(clean)) {
      const sel = blk.resolvedSelector || blk.selector;
      const hasFocusSel = /(?<!\\)(?::focus(?:-visible|-within)?(?![a-z-])|:has\([^;]*:focus(?:-visible)?\b)/i.test(sel);
      const hasFocusOrSuppDecl =
        /@apply\b/i.test(blk.body) ||
        /(?<![a-zA-Z0-9_$-])(?:outline(?:-(?:style|width|color))?|border(?:-(?:top|right|bottom|left|inline|block|x|y|s|e)(?:-(?:start|end))?)?(?:-(?:style|width|color))?|box-shadow)\s*:/i.test(
          blk.body
        );
      if (hasFocusSel || hasFocusOrSuppDecl) {
        focusBlocks.push({
          selector: sel,
          resolvedSelector: sel,
          body: blk.body,
          bodyStart: blk.bodyStart,
          docBodyStart: ++extSeq,
          conditions: blk.conditions || [],
          layer: blk.layer ?? null,
          layerPath: blk.layerPath ?? null,
          layerTree: blk.layerTree ?? null,
          layerRank: blk.layerRank ?? Infinity,
          layerOrder: blk.layerOrder ?? null,
          source: p,
        });
      }
    }
  }
  return focusBlocks;
}

export function createCascadeLayerComparator(orderedBlocks = []) {
  const mkNode = () => ({ orderIndex: 0, children: new Map(), edges: new Map(), firstSeen: new Map() });
  const mergedTree = mkNode();
  const treeIds = new Map();
  let nextTreeId = 1;
  const canReach = (edges, start, target) => {
    if (start === target) return true;
    const seen = new Set([start]);
    const q = [start];
    while (q.length > 0) {
      const cur = q.shift();
      const nexts = edges.get(cur);
      if (!nexts) continue;
      for (const nxt of nexts) {
        if (nxt === target) return true;
        if (!seen.has(nxt)) {
          seen.add(nxt);
          q.push(nxt);
        }
      }
    }
    return false;
  };
  const addEdge = (node, fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    if (canReach(node.edges, toKey, fromKey)) return;
    let nexts = node.edges.get(fromKey);
    if (!nexts) {
      nexts = new Set();
      node.edges.set(fromKey, nexts);
    }
    nexts.add(toKey);
  };
  const mergeNode = (srcNode, dstNode, treeId) => {
    const entries = [...srcNode.children.entries()].sort((a, b) => a[1].orderIndex - b[1].orderIndex);
    const orderedKeys = [];
    for (const [seg, srcChild] of entries) {
      const mergedKey = seg.startsWith("__anon_") ? `${seg}__t${treeId}` : seg;
      orderedKeys.push(mergedKey);
      let dstChild = dstNode.children.get(mergedKey);
      if (!dstChild) {
        dstChild = mkNode();
        dstNode.children.set(mergedKey, dstChild);
        dstNode.firstSeen.set(mergedKey, dstNode.firstSeen.size);
      }
      mergeNode(srcChild, dstChild, treeId);
    }
    for (let i = 0; i + 1 < orderedKeys.length; i++) {
      addEdge(dstNode, orderedKeys[i], orderedKeys[i + 1]);
    }
  };
  const ensurePath = (lp, treeId = 0) => {
    let cur = mergedTree;
    for (const seg of lp) {
      const key = seg.startsWith("__anon_") && treeId ? `${seg}__t${treeId}` : seg;
      let child = cur.children.get(key);
      if (!child) {
        child = mkNode();
        cur.children.set(key, child);
        cur.firstSeen.set(key, cur.firstSeen.size);
      }
      cur = child;
    }
  };
  for (const b of orderedBlocks) {
    const lt = b?.layerTree;
    if (lt) {
      if (!treeIds.has(lt)) {
        const tid = nextTreeId++;
        treeIds.set(lt, tid);
        mergeNode(lt, mergedTree, tid);
      }
      continue;
    }
    const lp = Array.isArray(b?.layerPath)
      ? b.layerPath
      : b?.layer
      ? String(b.layer)
          .split(".")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (lp.length > 0) ensurePath(lp, 0);
  }
  const assignTopoOrder = (node) => {
    const keys = [...node.children.keys()];
    if (keys.length === 0) return;
    const inDeg = new Map();
    for (const k of keys) inDeg.set(k, 0);
    for (const [u, nexts] of node.edges.entries()) {
      if (!node.children.has(u)) continue;
      for (const v of nexts) {
        if (node.children.has(v)) inDeg.set(v, (inDeg.get(v) || 0) + 1);
      }
    }
    const bySeen = (a, b) => (node.firstSeen.get(a) ?? 0) - (node.firstSeen.get(b) ?? 0);
    const ready = keys.filter((k) => inDeg.get(k) === 0).sort(bySeen);
    let idx = 0;
    const placed = new Set();
    while (ready.length > 0) {
      const k = ready.shift();
      placed.add(k);
      node.children.get(k).orderIndex = idx++;
      const nexts = node.edges.get(k);
      if (nexts) {
        for (const v of nexts) {
          if (!inDeg.has(v)) continue;
          const nd = inDeg.get(v) - 1;
          inDeg.set(v, nd);
          if (nd === 0) {
            ready.push(v);
            ready.sort(bySeen);
          }
        }
      }
    }
    for (const k of keys.sort(bySeen)) {
      if (!placed.has(k)) node.children.get(k).orderIndex = idx++;
      assignTopoOrder(node.children.get(k));
    }
  };
  assignTopoOrder(mergedTree);
  const getTuple = (blk) => {
    const lp = Array.isArray(blk?.layerPath)
      ? blk.layerPath
      : blk?.layer
      ? String(blk.layer)
          .split(".")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (lp.length === 0) return [];
    const tid = blk?.layerTree ? treeIds.get(blk.layerTree) : 0;
    const tuple = [];
    let cur = mergedTree;
    for (const seg of lp) {
      const key = seg.startsWith("__anon_") && tid ? `${seg}__t${tid}` : seg;
      const child = cur?.children.get(key);
      if (!child) {
        tuple.push(-1);
        cur = null;
      } else {
        tuple.push(child.orderIndex);
        cur = child;
      }
    }
    return tuple;
  };
  return (candBlk, refBlk) => {
    const a = getTuple(candBlk);
    const b = getTuple(refBlk);
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? 1 : -1;
  };
}

export function createFocusSafetyChecker(cssBlocks, externalBlocks = []) {
  const combinedFocusBlocks = [...cssBlocks, ...(Array.isArray(externalBlocks) ? externalBlocks : [])];
  const externalBlockSet = new Set(Array.isArray(externalBlocks) ? externalBlocks : []);
  const externalOrderMap = new Map();
  if (Array.isArray(externalBlocks)) {
    externalBlocks.forEach((b, idx) => externalOrderMap.set(b, idx + 1));
  }
  const compareCascadeLayerOrder = createCascadeLayerComparator([
    ...(Array.isArray(externalBlocks) ? externalBlocks : []),
    ...cssBlocks,
  ]);
  const SKIP_FOCUS_RE =
    /(?:^|[\s,])(?:#(?:main|content|main-content|app)|main|\[tabindex\s*=\s*["']?-1["']?\])(?::focus(?:-visible)?)?$/i;
  const WRAPPER_FOCUS_RE =
    /(?:^|[._-])(?:positioner|popup|listbox|menu-list|combobox-list|select-list|time-picker-list)(?=$|[^A-Za-z0-9_-])/i;
  const hasVisibleBackgroundDecl = (body) => {
    let win = null;
    const maskedBody = maskCssQuotedStringsPreservingLines(String(body || ""));
    for (const m of maskedBody.matchAll(/(?<![a-zA-Z0-9_$-])(background|background-color)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
      const imp = /!\s*important\b/i.test(m[2]);
      if (!win || imp || !win.imp) {
        win = { prop: m[1].toLowerCase(), val: m[2], imp };
      }
    }
    if (!win) return false;
    const raw = win.val.replace(/!\s*important\b/gi, "").trim();
    if (!raw) return false;
    if (/(?:url|gradient)\s*\(/i.test(raw)) return true;
    if (hasZeroAlphaColor(raw)) return false;
    const stripped = stripCssParens(raw);
    const tokens = stripped ? stripped.split(/\s+/).filter(Boolean) : [];
    if (win.prop === "background-color") {
      return tokens.length > 0 && !tokens.every((t) => /^(?:none|transparent|initial|inherit|unset)$/i.test(t));
    }
    return tokens.some((t) => !/^(?:none|transparent|initial|inherit|unset)$/i.test(t));
  };
  const conditionsCover = (candidateBlk, targetBlk) => {
    const reqConds = Array.isArray(candidateBlk?.conditions) ? candidateBlk.conditions : [];
    if (reqConds.length === 0) return true;
    const targetConds = new Set(Array.isArray(targetBlk?.conditions) ? targetBlk.conditions : []);
    return reqConds.every((c) => targetConds.has(c));
  };
  const getBlockBranches = (other) => splitTopLevelCommas(other.resolvedSelector || other.selector || "");
  const normSel = (sel) => String(sel || "").replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim().toLowerCase();
  const collapseFocusFv = (sel) =>
    normSel(sel)
      .replace(/(?<!\\):focus(?=:focus-visible(?![a-z-]))/gi, "")
      .replace(/((?<!\\):focus-visible):focus(?![a-z-])/gi, "$1");
  const getBlkOutlineSuppression = (blk) => {
    const blkBody = blk?.body || "";
    const maskedBlkBody = maskCssQuotedStringsPreservingLines(blkBody);
    const removals = findOutlineRemovals(blkBody);
    const supSet = new Set(removals.flatMap((r) => r.suppressedProps));
    const impSupSet = new Set(removals.filter((r) => r.isImportant).flatMap((r) => r.suppressedProps));
    const blkApplies = [...maskedBlkBody.matchAll(/(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)].map((m) => {
      const off = m.index + m[0].indexOf(m[1]);
      return blkBody.slice(off, off + m[1].length);
    });
    let hasApplyFocusOrFvRemoval = false;
    if (blkApplies.length > 0) {
      const twAppRemRe = new RegExp(`(?:^|[\\s"'\`])(!?(?:${TW_VARIANT_SEG})*!?${TW_OUTLINE_REM_BODY}!?)(?=$|[\\s"'\`;])`, "g");
      for (const rawStmt of blkApplies) {
        const stmtImp = /\s*!\s*important\s*$/i.test(rawStmt);
        const appNoImp = stmtImp ? rawStmt.replace(/\s*!\s*important\s*$/i, "") : rawStmt;
        for (const m of appNoImp.matchAll(twAppRemRe)) {
          const tok = m[1];
          if (!isTwOutlineRemoval(tok)) continue;
          const info = splitTailwindVariants(tok);
          if (info.condPrefixes.size > 0 || (info.targetPrefixes && info.targetPrefixes.size > 0)) continue;
          if (info.focusKind === "focus" || info.focusKind === "focus-visible") {
            hasApplyFocusOrFvRemoval = true;
          }
          if (info.focusKind === "focus-visible" || info.focusKind === "focus" || info.focusKind === null) {
            const rb = classifyTwRingOrBorder(tok);
            const kStyle = rb ? rb.killsStyle : true;
            const kWidth = rb ? rb.killsWidth : true;
            const kColor = rb ? rb.killsColor : true;
            if (kStyle) supSet.add("style");
            if (kWidth) supSet.add("width");
            if (kColor) supSet.add("color");
            if (stmtImp || /(?:^|:)!|!$/.test(tok)) {
              if (kStyle) impSupSet.add("style");
              if (kWidth) impSupSet.add("width");
              if (kColor) impSupSet.add("color");
            }
          }
        }
      }
    }
    return {
      suppressedProps: [...supSet],
      importantSuppressedProps: [...impSupSet],
      hasApplyFocusOrFvRemoval,
    };
  };
  const getBlockOrder = (b) => (typeof b?.docBodyStart === "number" ? b.docBodyStart : typeof b?.bodyStart === "number" ? b.bodyStart : null);
  const compareBlockOrder = (a, b) => {
    const aExt = externalBlockSet.has(a);
    const bExt = externalBlockSet.has(b);
    if (aExt !== bExt) return aExt ? -1 : 1;
    const ao = getBlockOrder(a) ?? (aExt ? externalOrderMap.get(a) ?? 0 : 0);
    const bo = getBlockOrder(b) ?? (bExt ? externalOrderMap.get(b) ?? 0 : 0);
    return ao - bo;
  };
  const splitSelectorChain = (sel) => {
    const segs = [];
    const combs = [];
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
        let comb = " ";
        while (i < str.length && /[\s>+~]/.test(str[i])) {
          if (str[i] === ">" || str[i] === "+" || str[i] === "~") comb = str[i];
          i++;
        }
        if (seg) {
          segs.push(seg);
          combs.push(comb);
        }
        start = i;
        i--;
      }
    }
    const tail = str.slice(start).trim();
    if (tail) segs.push(tail);
    else if (combs.length >= segs.length) combs.pop();
    return { segs, combs };
  };
  const splitSelectorCompounds = (sel) => splitSelectorChain(sel).segs;
  const selectorCoversBranchChain = (broadBase, narrowBase) => {
    const { segs: bSegs, combs: bCombs } = splitSelectorChain(broadBase);
    const { segs: nSegs, combs: nCombs } = splitSelectorChain(narrowBase);
    if (bSegs.length === 0 || nSegs.length < bSegs.length) return false;
    if (!branchSubjectsCoversTarget(bSegs[bSegs.length - 1], nSegs[nSegs.length - 1])) return false;
    if (bSegs.length === 1) return true;
    const matchAt = (bi, ni) => {
      if (bi === 0) return true;
      const bc = bCombs[bi - 1];
      const bTarget = bSegs[bi - 1];
      if (bc === ">" || bc === "+") {
        if (ni - 1 < 0 || nCombs[ni - 1] !== bc) return false;
        return branchSubjectsCoversTarget(bTarget, nSegs[ni - 1]) && matchAt(bi - 1, ni - 1);
      }
      if (bc === "~") {
        for (let k = ni - 1; k >= 0; k--) {
          if (nCombs[k] !== "+" && nCombs[k] !== "~") break;
          if (branchSubjectsCoversTarget(bTarget, nSegs[k]) && matchAt(bi - 1, k)) return true;
        }
        return false;
      }
      for (let k = ni - 1; k >= 0; k--) {
        const nc = nCombs[k];
        if (nc === " " || nc === ">") {
          if (branchSubjectsCoversTarget(bTarget, nSegs[k]) && matchAt(bi - 1, k)) return true;
        }
      }
      return false;
    };
    return matchAt(bSegs.length - 1, nSegs.length - 1);
  };
  const extractNonFocusNotClauses = (sel) => {
    const clauses = new Set();
    const str = String(sel || "");
    let q = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (q) {
        if (c === "\\" && i + 1 < str.length) i++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ":" && !(i > 0 && str[i - 1] === "\\") && str.slice(i, i + 5).toLowerCase() === ":not(") {
        let depth = 1;
        let j = i + 5;
        let nq = null;
        while (j < str.length && depth > 0) {
          const nc = str[j];
          if (nq) {
            if (nc === "\\" && j + 1 < str.length) { j += 2; continue; }
            if (nc === nq) nq = null;
          } else if (nc === '"' || nc === "'") { nq = nc; }
          else if (nc === "(") depth++;
          else if (nc === ")") {
            depth--;
            if (depth === 0) break;
          }
          j++;
        }
        if (depth === 0) {
          const inner = str.slice(i + 5, j).replace(/\s+/g, " ").trim().toLowerCase();
          if (!/^:focus(?:-visible|-within)?$/i.test(inner)) {
            clauses.add(`:not(${inner})`);
          }
          i = j;
        }
      }
    }
    return clauses;
  };
  const getTwFocusApplyKinds = (b) => {
    const kinds = new Set();
    const rawBody = String(b?.body || "");
    if (!/@apply\b/i.test(rawBody)) return kinds;
    const masked = maskCssQuotedStringsPreservingLines(rawBody, "_");
    for (const am of masked.matchAll(/(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
      const stmt = am[1].replace(/\s*!\s*important\s*$/i, "");
      for (const tok of stmt.trim().split(/\s+/).filter(Boolean)) {
        const info = splitTailwindVariants(tok);
        if (info.targetPrefixes.size > 0) continue;
        if (info.focusKind === "focus" || info.focusKind === "focus-visible" || info.focusKind === "focus-within" || info.focusKind === "has-focus") {
          kinds.add(info.focusKind);
        }
      }
    }
    return kinds;
  };
  const hasTwFocusApply = (b) => getTwFocusApplyKinds(b).size > 0;
  const maskSelectorBrackets = (sel) => {
    let out = "";
    let br = 0;
    let q = null;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (q) {
        if (ch === "\\" && i + 1 < sel.length) {
          out += "  ";
          i++;
          continue;
        }
        if (ch === q) q = null;
        out += " ";
        continue;
      }
      if (ch === "\\" && i + 1 < sel.length) {
        out += ch + sel[i + 1];
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        out += " ";
        continue;
      }
      if (ch === "[") br++;
      else if (ch === "]" && br > 0) br--;
      out += br > 0 || ch === "]" ? " " : ch;
    }
    return out;
  };
  const stripFocusPseudosOutsideBrackets = (sel) => {
    const isPureFocusStr = (part) => {
      const stripped = stripPureFocusWrappers(String(part || "").trim());
      return stripped.replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "").trim() === "";
    };
    const stripPureFocusWrappers = (input) => {
      let cur = String(input || "");
      let changed = true;
      while (changed) {
        changed = false;
        let out = "";
        let br = 0;
        let q = null;
        for (let i = 0; i < cur.length; i++) {
          const ch = cur[i];
          if (q) {
            out += ch;
            if (ch === "\\" && i + 1 < cur.length) {
              out += cur[i + 1];
              i++;
            } else if (ch === q) {
              q = null;
            }
            continue;
          }
          if (ch === "\\" && i + 1 < cur.length) {
            out += ch + cur[i + 1];
            i++;
            continue;
          }
          if (ch === '"' || ch === "'") {
            q = ch;
            out += ch;
            continue;
          }
          if (ch === "[") {
            br++;
            out += ch;
            continue;
          }
          if (ch === "]" && br > 0) {
            br--;
            out += ch;
            continue;
          }
          if (br === 0 && ch === ":") {
            const wm = /^:(?:is|where)\(/i.exec(cur.slice(i, i + 8));
            if (wm) {
              const openP = i + wm[0].length - 1;
              let depth = 1;
              let pq = null;
              let pbr = 0;
              let k = openP + 1;
              while (k < cur.length && depth > 0) {
                const pc = cur[k];
                if (pq) {
                  if (pc === "\\" && k + 1 < cur.length) k++;
                  else if (pc === pq) pq = null;
                } else if (pc === "\\" && k + 1 < cur.length) {
                  k++;
                } else if (pc === '"' || pc === "'") {
                  pq = pc;
                } else if (pc === "[") {
                  pbr++;
                } else if (pc === "]" && pbr > 0) {
                  pbr--;
                } else if (pbr === 0) {
                  if (pc === "(") depth++;
                  else if (pc === ")") depth--;
                }
                k++;
              }
              if (depth === 0) {
                const closeP = k - 1;
                const inner = cur.slice(openP + 1, closeP);
                const branches = splitTopLevelCommas(inner);
                if (branches.some((b) => b.trim().length > 0 && isPureFocusStr(b))) {
                  changed = true;
                  i = closeP;
                  continue;
                }
              }
            }
          }
          out += ch;
        }
        cur = out;
      }
      return cur;
    };
    const withoutWrappers = stripPureFocusWrappers(sel);
    const masked = maskSelectorBrackets(withoutWrappers);
    const re = /(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      out += withoutWrappers.slice(last, m.index);
      last = m.index + m[0].length;
    }
    out += withoutWrappers.slice(last);
    return out.trim();
  };
  const parseFocusMeta = (branchSel) => {
    const rawStr = String(branchSel || "");
    const notClauses = extractNonFocusNotClauses(rawStr);
    const noNot = collapseFocusFv(stripNotPseudo(rawStr));
    const outerNoNot = maskSelectorBrackets(noNot);
    const hasFv = /(?<!\\):focus-visible(?![a-z-])/i.test(outerNoNot);
    const hasFocus = /(?<!\\):focus(?![a-z-])/i.test(outerNoNot) && !hasFv;
    const hasFw = /(?<!\\):focus-within(?![a-z-])/i.test(outerNoNot);
    const hasHover = /(?<!\\):hover(?![a-zA-Z0-9_-])/i.test(outerNoNot);
    const hasActive = /(?<!\\):active(?![a-zA-Z0-9_-])/i.test(outerNoNot);
    const base = stripFocusPseudosOutsideBrackets(noNot);
    const spec = computeSelectorSpecificity(branchSel);
    return { noNot, hasFv, hasFocus, hasFw, hasHover, hasActive, base, spec, notClauses };
  };
  const notClausesCover = (broadNot, narrowNot) =>
    !broadNot || broadNot.size === 0 || [...broadNot].every((nc) => narrowNot && narrowNot.has(nc));
  const parseBoxShadowDecls = (candBody) => {
    const out = [];
    for (const bm of candBody.matchAll(/(?<![a-zA-Z0-9_$-])box-shadow\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
      const imp = /!\s*important\b/i.test(bm[1]);
      const cleanBox = bm[1].replace(/!\s*important\b/gi, "").trim();
      const vis = Boolean(
        cleanBox &&
          !/^(?:none|0|initial|inherit|unset)$/i.test(cleanBox) &&
          splitTopLevelCommas(cleanBox).some((layer) => isBoxShadowLayerVisible(layer))
      );
      out.push({ vis, imp });
    }
    return out;
  };
  const createOutlineTupleState = () => ({
    style: { state: null, candWinsImportant: false },
    width: { state: null, candWinsImportant: false },
    color: { state: null, candWinsImportant: false },
  });
  const collectOutlineTupleFromRawBody = (rawBody, { outlineTuple, impFilter = "all", candWinsImportant = false }) => {
    const body = String(rawBody || "");
    const maskedBody = maskCssQuotedStringsPreservingLines(body);
    const applyEvents = [];
    const applyRe = /(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi;
    const rawNoApply = maskedBody.replace(/(?<![a-zA-Z0-9_$-])@apply\s+(?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+;?/gi, (m) => m.replace(/[^\n]/g, " "));
    for (const m of rawNoApply.matchAll(/(?<![a-zA-Z0-9_$-])(outline|outline-style|outline-width|outline-color)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
      const prop = m[1].toLowerCase();
      const info = classifyOutlineDecl(prop, m[2]);
      if (impFilter === "normal-only" && info.isImportant) continue;
      if (impFilter === "important-only" && !info.isImportant) continue;
      applyEvents.push({ offset: m.index, kind: "css", prop, info });
    }
    const appOutlineVisRe = new RegExp(`(?:^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_OUTLINE_VIS_BODY}!?(?=$|[\\s;]))`, "g");
    for (const am of maskedBody.matchAll(applyRe)) {
      const appStart = am.index + am[0].indexOf(am[1]);
      const rawStmt = body.slice(appStart, appStart + am[1].length);
      const stmtImp = /\s*!\s*important\s*$/i.test(rawStmt);
      const appNoImp = stmtImp ? rawStmt.replace(/\s*!\s*important\s*$/i, "") : rawStmt;
      let tokCursor = 0;
      for (const rawTok of appNoImp.split(/\s+/).filter(Boolean)) {
        const tokPos = appNoImp.indexOf(rawTok, tokCursor);
        if (tokPos !== -1) tokCursor = tokPos + rawTok.length;
        const tok = rawTok.replace(/;+$/, "");
        if (!tok) continue;
        const info = splitTailwindVariants(tok);
        if (info.condPrefixes.size > 0 || (info.targetPrefixes && info.targetPrefixes.size > 0)) continue;
        if (info.focusKind !== null && info.focusKind !== "focus" && info.focusKind !== "focus-visible") continue;
        const isImp = stmtImp || /(?:^|:)!|!$/.test(tok);
        if (impFilter === "normal-only" && isImp) continue;
        if (impFilter === "important-only" && !isImp) continue;
        const rb = classifyTwRingOrBorder(tok);
        if (isTwOutlineRemoval(tok)) {
          applyEvents.push({
            offset: appStart + Math.max(0, tokPos),
            kind: "tw",
            state: "invisible",
            styleFlag: rb ? rb.killsStyle : true,
            widthFlag: rb ? rb.killsWidth : true,
            colorFlag: rb ? rb.killsColor : true,
          });
        } else {
          appOutlineVisRe.lastIndex = 0;
          if (appOutlineVisRe.test(` ${tok}`) && !isInvisibleTwFocusUtility(tok)) {
            applyEvents.push({
              offset: appStart + Math.max(0, tokPos),
              kind: "tw",
              state: "visible",
              styleFlag: rb ? rb.setsStyle : true,
              widthFlag: rb ? rb.setsWidth : true,
              colorFlag: rb ? rb.setsColor : true,
            });
          }
        }
      }
    }
    applyEvents.sort((a, b) => a.offset - b.offset);
    const setComp = (comp, st) => {
      outlineTuple[comp] = {
        state: st,
        candWinsImportant: st === "invisible" ? Boolean(candWinsImportant) : false,
      };
    };
    for (const ev of applyEvents) {
      if (ev.kind === "tw") {
        if (ev.styleFlag) setComp("style", ev.state);
        if (ev.widthFlag) setComp("width", ev.state);
        if (ev.colorFlag) setComp("color", ev.state);
      } else {
        const { prop, info } = ev;
        if (prop === "outline-style") setComp("style", info.state);
        else if (prop === "outline-width") setComp("width", info.state);
        else if (prop === "outline-color") setComp("color", info.state);
        else {
          const sup = new Set(info.suppressedProps);
          setComp("style", sup.has("style") ? "invisible" : "visible");
          setComp("width", sup.has("width") ? "invisible" : "visible");
          setComp("color", sup.has("color") ? "invisible" : "visible");
        }
      }
    }
  };
  const getBorderSuppressionForRule = (selBranch, blk = null, srcBlk = null, isSubgroupCheck = false) => {
    const blkMeta = parseFocusMeta(selBranch);
    const base = blkMeta.base;
    const blkOrder = getBlockOrder(blk) ?? 0;
    const blkTwFocusKinds = !blkMeta.hasFv && !blkMeta.hasFocus && !blkMeta.hasFw ? getTwFocusApplyKinds(blk) : new Set();
    const blkHasTwFocusApply = blkTwFocusKinds.size > 0;
    const effBlkSpec = blkHasTwFocusApply ? [blkMeta.spec[0], blkMeta.spec[1] + 1, blkMeta.spec[2]] : blkMeta.spec;
    const blkSubjHasPseudoEl = /(?<!\\)::[a-z-]/i.test(extractSubjectSelector(stripNotPseudo(selBranch)));

    const exactCands = [];
    const narrowerFocusCands = [];
    for (const cand of combinedFocusBlocks) {
      if (!conditionsCover(cand, blk)) continue;
      if (cand === blk) continue;
      const isForcedSrc = Boolean(srcBlk && cand === srcBlk);
      const candOrder = getBlockOrder(cand) ?? 0;
      const layerCmp = compareCascadeLayerOrder(cand, blk);
      const branches = getBlockBranches(cand);
      let bestExact = null;
      let fallbackForced = null;
      const bestNarrowBySubBase = new Map();
      for (const cbRaw of branches) {
        const cbSubjNoNot = extractSubjectSelector(stripNotPseudo(cbRaw));
        if (!blkSubjHasPseudoEl && /(?<!\\)::[a-z-]/i.test(cbSubjNoNot)) continue;
        if (/(?:disabled\b|aria-disabled\s*=\s*["']?true)/i.test(cbRaw)) continue;
        if ((blkMeta.hasFv || blkMeta.hasFocus) && /(?<!\\):not\(:focus-visible\)/i.test(cbRaw)) continue;
        const cbMeta = parseFocusMeta(cbRaw);
        if (!isForcedSrc && isPointerGatedCandidate(cbMeta.noNot, blkMeta.hasHover, blkMeta.hasActive)) continue;
        const isBaseRule = !cbMeta.hasFv && !cbMeta.hasFocus && !cbMeta.hasFw;
        const focusCovers =
          (blkMeta.hasFv && (cbMeta.hasFv || cbMeta.hasFocus)) ||
          (blkMeta.hasFocus && (cbMeta.hasFocus || cbMeta.hasFv)) ||
          (blkMeta.hasFw && cbMeta.hasFw) ||
          (blkHasTwFocusApply && (cbMeta.hasFv || cbMeta.hasFocus || (blkTwFocusKinds.has("focus-within") && cbMeta.hasFw)));
        const specCmp = compareSpecificity(cbMeta.spec, cbMeta.hasFv || cbMeta.hasFocus ? effBlkSpec : blkMeta.spec);
        const orderCmp = compareBlockOrder(cand, blk);
        const candWinsNormal = layerCmp > 0 || (layerCmp === 0 && (specCmp > 0 || (specCmp === 0 && orderCmp > 0)));
        const candWinsImportant = layerCmp < 0 || (layerCmp === 0 && (specCmp > 0 || (specCmp === 0 && orderCmp > 0)));
        const item = { cand, cbRaw, cbMeta, candOrder, layerCmp, specCmp, orderCmp, candWinsNormal, candWinsImportant, focusCovers };
        if (
          base &&
          cbMeta.base &&
          (cbMeta.base === base || selectorCoversBranchChain(cbMeta.base, base)) &&
          notClausesCover(cbMeta.notClauses, blkMeta.notClauses) &&
          (isBaseRule || focusCovers)
        ) {
          if (
            !bestExact ||
            item.specCmp > bestExact.specCmp ||
            (item.specCmp === bestExact.specCmp && compareSpecificity(item.cbMeta.spec, bestExact.cbMeta.spec) > 0)
          ) {
            bestExact = item;
          }
        } else if (isForcedSrc && !fallbackForced) {
          fallbackForced = item;
        }
        if (
          !isSubgroupCheck &&
          base &&
          cbMeta.base &&
          cbMeta.base !== base &&
          (focusCovers || isBaseRule) &&
          (candWinsNormal || candWinsImportant) &&
          selectorCoversBranchChain(base, cbMeta.base) &&
          notClausesCover(blkMeta.notClauses, cbMeta.notClauses)
        ) {
          const prev = bestNarrowBySubBase.get(cbMeta.base);
          if (
            !prev ||
            item.specCmp > prev.specCmp ||
            (item.specCmp === prev.specCmp && compareSpecificity(item.cbMeta.spec, prev.cbMeta.spec) > 0)
          ) {
            bestNarrowBySubBase.set(cbMeta.base, item);
          }
        }
      }
      const chosenExact = bestExact || fallbackForced;
      if (chosenExact) exactCands.push(chosenExact);
      for (const nItem of bestNarrowBySubBase.values()) narrowerFocusCands.push(nItem);
    }

    const ascNormalCmp = (a, b) => compareCascadeLayerOrder(a.cand, b.cand) || compareSpecificity(a.cbMeta.spec, b.cbMeta.spec) || compareBlockOrder(a.cand, b.cand);
    const ascImpCmp = (a, b) => -compareCascadeLayerOrder(a.cand, b.cand) || compareSpecificity(a.cbMeta.spec, b.cbMeta.spec) || compareBlockOrder(a.cand, b.cand);

    const inheritedBorder = collectBorderTupleState("");
    const inheritedRing = collectRingTupleState();
    const inheritedInsetRing = collectRingTupleState();
    const inheritedOutline = createOutlineTupleState();
    for (const item of exactCands.filter((x) => !x.candWinsNormal).sort(ascNormalCmp)) {
      collectRuleBorderAndShadowFromRawBody(item.cand.body || "", {
        borderTuple: inheritedBorder,
        ringTuple: inheritedRing,
        insetRingTuple: inheritedInsetRing,
        impFilter: "normal-only",
        allowFocusVariants: true,
        treatFocusMatch: true,
      });
      if (item.cand !== srcBlk) {
        collectOutlineTupleFromRawBody(item.cand.body || "", {
          outlineTuple: inheritedOutline,
          impFilter: "normal-only",
        });
      }
    }

    const overridingBorder = collectBorderTupleState("");
    const overridingRing = collectRingTupleState();
    const overridingInsetRing = collectRingTupleState();
    const overridingOutline = createOutlineTupleState();
    let overridingWinBox = null;
    let overridingPureWinBox = null;
    for (const item of exactCands.filter((x) => x.candWinsNormal).sort(ascNormalCmp)) {
      const { boxDecls } = collectRuleBorderAndShadowFromRawBody(item.cand.body || "", {
        borderTuple: overridingBorder,
        ringTuple: overridingRing,
        insetRingTuple: overridingInsetRing,
        impFilter: "normal-only",
        allowFocusVariants: true,
        treatFocusMatch: true,
      });
      if (item.cand !== srcBlk) {
        collectOutlineTupleFromRawBody(item.cand.body || "", {
          outlineTuple: overridingOutline,
          impFilter: "normal-only",
        });
      }
      for (const bd of boxDecls) {
        if (!bd.imp) overridingWinBox = bd;
        if (!bd.imp && !bd.fromRingFamily) overridingPureWinBox = bd;
      }
    }

    const impBorder = collectBorderTupleState("");
    const impRing = collectRingTupleState();
    const impInsetRing = collectRingTupleState();
    const impOutline = createOutlineTupleState();
    let winBoxImp = null;
    let pureWinBoxImp = null;
    for (const item of [...exactCands].sort(ascImpCmp)) {
      const { boxDecls } = collectRuleBorderAndShadowFromRawBody(item.cand.body || "", {
        borderTuple: impBorder,
        ringTuple: impRing,
        insetRingTuple: impInsetRing,
        impFilter: "important-only",
        candWinsImportant: item.candWinsImportant,
        allowFocusVariants: true,
        treatFocusMatch: true,
      });
      if (item.cand !== srcBlk) {
        collectOutlineTupleFromRawBody(item.cand.body || "", {
          outlineTuple: impOutline,
          impFilter: "important-only",
          candWinsImportant: item.candWinsImportant,
        });
      }
      for (const bd of boxDecls) {
        if (bd.imp) winBoxImp = { ...bd, candWinsImportant: item.candWinsImportant };
        if (bd.imp && !bd.fromRingFamily) pureWinBoxImp = { ...bd, candWinsImportant: item.candWinsImportant };
      }
    }

    const extraOutlineSupSet = new Set(["style", "width", "color"].filter((c) => inheritedOutline[c].state === "invisible"));
    const extraOutlineImpSupSet = new Set(["style", "width", "color"].filter((c) => overridingOutline[c].state === "invisible"));
    let extraOutlineUnrecoverable = false;
    for (const c of ["style", "width", "color"]) {
      if (impOutline[c].state === "invisible") {
        extraOutlineImpSupSet.add(c);
        if (impOutline[c].candWinsImportant) extraOutlineUnrecoverable = true;
      }
    }

    const borderSupSet = new Set(["style", "width", "color"].filter((c) => inheritedBorder[c].state === "invisible"));
    const borderImpSupSet = new Set(["style", "width", "color"].filter((c) => overridingBorder[c].state === "invisible"));
    const borderUnrecovSet = new Set();
    for (const c of ["style", "width", "color"]) {
      if (impBorder[c].state === "invisible") {
        borderImpSupSet.add(c);
        if (impBorder[c].candWinsImportant) borderUnrecovSet.add(c);
      }
    }
    const sideSup = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    const sideImpSup = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    const sideUnrecov = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    for (const sCh of ["t", "r", "b", "l"]) {
      for (const c of ["style", "width", "color"]) {
        if (inheritedBorder.sides[sCh][c].state === "invisible") sideSup[sCh].add(c);
        if (overridingBorder.sides[sCh][c].state === "invisible") sideImpSup[sCh].add(c);
        if (impBorder.sides[sCh][c].state === "invisible") {
          sideImpSup[sCh].add(c);
          if (impBorder.sides[sCh][c].candWinsImportant) sideUnrecov[sCh].add(c);
        }
      }
    }
    const ringSupSet = new Set(["width", "color"].filter((c) => inheritedRing[c].state === "invisible"));
    const ringImpSupSet = new Set(["width", "color"].filter((c) => overridingRing[c].state === "invisible"));
    const ringUnrecovSet = new Set();
    for (const c of ["width", "color"]) {
      if (impRing[c].state === "invisible") {
        ringImpSupSet.add(c);
        if (impRing[c].candWinsImportant) ringUnrecovSet.add(c);
      }
    }
    const insetRingSupSet = new Set(["width", "color"].filter((c) => inheritedInsetRing[c].state === "invisible"));
    const insetRingImpSupSet = new Set(["width", "color"].filter((c) => overridingInsetRing[c].state === "invisible"));
    const insetRingUnrecovSet = new Set();
    for (const c of ["width", "color"]) {
      if (impInsetRing[c].state === "invisible") {
        insetRingImpSupSet.add(c);
        if (impInsetRing[c].candWinsImportant) insetRingUnrecovSet.add(c);
      }
    }
    let boxShadowImportantSuppressed = Boolean((overridingWinBox && !overridingWinBox.vis) || (winBoxImp && !winBoxImp.vis));
    let boxShadowUnrecoverable = Boolean(winBoxImp && !winBoxImp.vis && winBoxImp.candWinsImportant);
    let pureBoxShadowImportantSuppressed = Boolean((overridingPureWinBox && !overridingPureWinBox.vis) || (pureWinBoxImp && !pureWinBoxImp.vis));
    let pureBoxShadowUnrecoverable = Boolean(pureWinBoxImp && !pureWinBoxImp.vis && pureWinBoxImp.candWinsImportant);

    if (!isSubgroupCheck && narrowerFocusCands.length > 0) {
      const refBlk = srcBlk || blk;
      const { suppressedProps: refSupProps, importantSuppressedProps: refImpSupProps } = getBlkOutlineSuppression(refBlk);
      const refHasImpSup = refImpSupProps.length > 0;
      const refOrder = getBlockOrder(refBlk) ?? 0;
      const bySubBase = new Map();
      for (const item of narrowerFocusCands) {
        const list = bySubBase.get(item.cbMeta.base) || [];
        list.push(item);
        bySubBase.set(item.cbMeta.base, list);
      }
      const getRefSpecForSubBase = (subBase) => {
        if (refBlk === blk) return blkMeta.spec;
        let bestSpec = null;
        for (const rb of getBlockBranches(refBlk)) {
          const rbMeta = parseFocusMeta(rb);
          if (rbMeta.base && (rbMeta.base === subBase || selectorCoversBranchChain(rbMeta.base, subBase))) {
            if (!bestSpec || compareSpecificity(rbMeta.spec, bestSpec) > 0) bestSpec = rbMeta.spec;
          }
        }
        return bestSpec || blkMeta.spec;
      };
      for (const subItems of bySubBase.values()) {
        const subHasOwnFocus = subItems.some((subItem) => {
          if (!subItem.focusCovers) return false;
          const refLayerCmp = compareCascadeLayerOrder(subItem.cand, refBlk);
          const refSpecCmp = compareSpecificity(subItem.cbMeta.spec, getRefSpecForSubBase(subItem.cbMeta.base));
          const refOrderCmp = compareBlockOrder(subItem.cand, refBlk);
          const subRequireImpOutline = refHasImpSup || refLayerCmp < 0 || (refLayerCmp === 0 && (refSpecCmp < 0 || (refSpecCmp === 0 && refOrderCmp < 0)));
          const subOutlineUnrecov = refHasImpSup && (refLayerCmp > 0 || (refLayerCmp === 0 && (refSpecCmp < 0 || (refSpecCmp === 0 && refOrderCmp <= 0))));
          const subBorderSupp = getBorderSuppressionForRule(subItem.cbRaw, subItem.cand, null, true);
          return hasVisibleFocusIndicator(subItem.cand.body, subItem.cbRaw, {
            ...subBorderSupp,
            suppressedProps: [...new Set([...refSupProps, ...(subBorderSupp.extraOutlineSuppressedProps || [])])],
            importantSuppressedProps: [...new Set([...refImpSupProps, ...(subBorderSupp.extraOutlineImportantSuppressedProps || [])])],
            requireImportantOutlineOnly: subRequireImpOutline,
            outlineUnrecoverable: subOutlineUnrecov || Boolean(subBorderSupp.extraOutlineUnrecoverable),
          });
        });
        if (subHasOwnFocus) continue;

        const subNormBorder = collectBorderTupleState("");
        const subNormRing = collectRingTupleState();
        const subNormInsetRing = collectRingTupleState();
        const subNormOutline = createOutlineTupleState();
        let subNormBox = null;
        let subNormPureBox = null;
        for (const item of [...subItems].sort(ascNormalCmp)) {
          if (!item.candWinsNormal) continue;
          const { boxDecls } = collectRuleBorderAndShadowFromRawBody(item.cand.body || "", {
            borderTuple: subNormBorder,
            ringTuple: subNormRing,
            insetRingTuple: subNormInsetRing,
            impFilter: "normal-only",
            allowFocusVariants: true,
            treatFocusMatch: true,
          });
          if (item.cand !== srcBlk) {
            collectOutlineTupleFromRawBody(item.cand.body || "", {
              outlineTuple: subNormOutline,
              impFilter: "normal-only",
            });
          }
          for (const bd of boxDecls) {
            if (!bd.imp) subNormBox = bd;
            if (!bd.imp && !bd.fromRingFamily) subNormPureBox = bd;
          }
        }
        const subImpBorder = collectBorderTupleState("");
        const subImpRing = collectRingTupleState();
        const subImpInsetRing = collectRingTupleState();
        const subImpOutline = createOutlineTupleState();
        let subImpBox = null;
        let subImpPureBox = null;
        for (const item of [...subItems].sort(ascImpCmp)) {
          const { boxDecls } = collectRuleBorderAndShadowFromRawBody(item.cand.body || "", {
            borderTuple: subImpBorder,
            ringTuple: subImpRing,
            insetRingTuple: subImpInsetRing,
            impFilter: "important-only",
            candWinsImportant: item.candWinsImportant,
            allowFocusVariants: true,
            treatFocusMatch: true,
          });
          if (item.cand !== srcBlk) {
            collectOutlineTupleFromRawBody(item.cand.body || "", {
              outlineTuple: subImpOutline,
              impFilter: "important-only",
              candWinsImportant: item.candWinsImportant,
            });
          }
          for (const bd of boxDecls) {
            if (bd.imp) subImpBox = { ...bd, candWinsImportant: item.candWinsImportant };
            if (bd.imp && !bd.fromRingFamily) subImpPureBox = { ...bd, candWinsImportant: item.candWinsImportant };
          }
        }
        for (const c of ["style", "width", "color"]) {
          if (subNormOutline[c].state === "invisible") extraOutlineImpSupSet.add(c);
          if (subImpOutline[c].state === "invisible") {
            extraOutlineImpSupSet.add(c);
            if (subImpOutline[c].candWinsImportant) extraOutlineUnrecoverable = true;
          }
        }
        for (const c of ["style", "width", "color"]) {
          if (subNormBorder[c].state === "invisible") borderImpSupSet.add(c);
          if (subImpBorder[c].state === "invisible") {
            borderImpSupSet.add(c);
            if (subImpBorder[c].candWinsImportant) borderUnrecovSet.add(c);
          }
          for (const sCh of ["t", "r", "b", "l"]) {
            if (subNormBorder.sides[sCh][c].state === "invisible") sideImpSup[sCh].add(c);
            if (subImpBorder.sides[sCh][c].state === "invisible") {
              sideImpSup[sCh].add(c);
              if (subImpBorder.sides[sCh][c].candWinsImportant) sideUnrecov[sCh].add(c);
            }
          }
        }
        for (const c of ["width", "color"]) {
          if (subNormRing[c].state === "invisible") ringImpSupSet.add(c);
          if (subImpRing[c].state === "invisible") {
            ringImpSupSet.add(c);
            if (subImpRing[c].candWinsImportant) ringUnrecovSet.add(c);
          }
          if (subNormInsetRing[c].state === "invisible") insetRingImpSupSet.add(c);
          if (subImpInsetRing[c].state === "invisible") {
            insetRingImpSupSet.add(c);
            if (subImpInsetRing[c].candWinsImportant) insetRingUnrecovSet.add(c);
          }
        }
        if (subNormBox && !subNormBox.vis) boxShadowImportantSuppressed = true;
        if (subImpBox && !subImpBox.vis) {
          boxShadowImportantSuppressed = true;
          if (subImpBox.candWinsImportant) boxShadowUnrecoverable = true;
        }
        if (subNormPureBox && !subNormPureBox.vis) pureBoxShadowImportantSuppressed = true;
        if (subImpPureBox && !subImpPureBox.vis) {
          pureBoxShadowImportantSuppressed = true;
          if (subImpPureBox.candWinsImportant) pureBoxShadowUnrecoverable = true;
        }
      }
    }

    let boxShadowSuppressedBySrc = false;
    let pureBoxShadowSuppressedBySrc = false;
    let borderSuppressedBySrc = false;
    let ringSuppressedBySrc = false;
    let insetRingSuppressedBySrc = false;
    if (srcBlk && srcBlk !== blk) {
      const { borderTuple: srcBorder, boxDecls: srcBoxes, ringTuple: srcRing, insetRingTuple: srcInsetRing } = collectRuleBorderAndShadowFromRawBody(srcBlk.body || "", {
        allowFocusVariants: true,
        treatFocusMatch: true,
      });
      borderSuppressedBySrc =
        srcBorder.sawBorder &&
        (["style", "width", "color"].some((c) => srcBorder[c].state === "invisible") ||
          ["t", "r", "b", "l"].some((sCh) => ["style", "width", "color"].some((c) => srcBorder.sides[sCh][c].state === "invisible")));
      let srcWinBox = null;
      let srcPureWinBox = null;
      for (const bd of srcBoxes) {
        if (!srcWinBox || bd.imp || !srcWinBox.imp) srcWinBox = bd;
        if (!bd.fromRingFamily && (!srcPureWinBox || bd.imp || !srcPureWinBox.imp)) srcPureWinBox = bd;
      }
      boxShadowSuppressedBySrc = Boolean(srcWinBox && !srcWinBox.vis);
      pureBoxShadowSuppressedBySrc = Boolean(srcPureWinBox && !srcPureWinBox.vis);
      ringSuppressedBySrc = srcRing.saw && ["width", "color"].some((c) => srcRing[c].state === "invisible");
      insetRingSuppressedBySrc = srcInsetRing.saw && ["width", "color"].some((c) => srcInsetRing[c].state === "invisible");
    }
    return {
      borderSuppressedProps: [...borderSupSet],
      borderImportantSuppressedProps: [...borderImpSupSet],
      borderUnrecoverableProps: [...borderUnrecovSet],
      borderSideSuppressed: { t: [...sideSup.t], r: [...sideSup.r], b: [...sideSup.b], l: [...sideSup.l] },
      borderSideImportantSuppressed: { t: [...sideImpSup.t], r: [...sideImpSup.r], b: [...sideImpSup.b], l: [...sideImpSup.l] },
      borderSideUnrecoverable: { t: [...sideUnrecov.t], r: [...sideUnrecov.r], b: [...sideUnrecov.b], l: [...sideUnrecov.l] },
      ringSuppressedProps: [...ringSupSet],
      ringImportantSuppressedProps: [...ringImpSupSet],
      ringUnrecoverableProps: [...ringUnrecovSet],
      insetRingSuppressedProps: [...insetRingSupSet],
      insetRingImportantSuppressedProps: [...insetRingImpSupSet],
      insetRingUnrecoverableProps: [...insetRingUnrecovSet],
      boxShadowImportantSuppressed,
      boxShadowUnrecoverable,
      boxShadowSuppressedBySrc,
      pureBoxShadowImportantSuppressed,
      pureBoxShadowUnrecoverable,
      pureBoxShadowSuppressedBySrc,
      borderSuppressedBySrc,
      ringSuppressedBySrc,
      insetRingSuppressedBySrc,
      extraOutlineSuppressedProps: [...extraOutlineSupSet],
      extraOutlineImportantSuppressedProps: [...extraOutlineImpSupSet],
      extraOutlineUnrecoverable,
    };
  };
  const replaceFocusOutsideNot = (part, repSuffix) => {
    const str = String(part || "");
    let out = "";
    let i = 0, q = null;
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
  const isBranchGuardedNotFocusVisible = (sel) => {
    if (/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(sel))) return false;
    const comps = splitSelectorCompounds(sel);
    const focusComps = comps.filter((c) => /(?<!\\):focus(?![a-z-])/i.test(stripNotPseudo(c)));
    if (focusComps.length === 0) return /(?<!\\):not\(:focus-visible\)/i.test(extractSubjectSelector(sel));
    return focusComps.every((c) => /(?<!\\):not\(:focus-visible\)/i.test(c));
  };
  const hasBranchSiblingFocusVisible = (p, blk = null, specOverride = null) => {
    const rawSubj = extractSubjectSelector(p);
    const pSubj = stripNotPseudo(rawSubj);
    const pNoNot = stripNotPseudo(p);
    const pMeta = parseFocusMeta(p);
    const hasFvInBranch = /(?<!\\):focus-visible(?![a-z-])/i.test(pNoNot);
    const hasSubjFv = /(?<!\\):focus-visible(?![a-z-])/i.test(pSubj);
    const hasSubjFocus = /(?<!\\):focus(?![a-z-])/i.test(pSubj) && !hasSubjFv;
    const hasFocusInBranch = /(?<!\\):focus(?![a-z-])/i.test(pNoNot) && !hasFvInBranch;
    const isPlainFocus = hasFocusInBranch;
    const hasAncestorFocus =
      (hasFvInBranch && !hasSubjFv) ||
      (hasFocusInBranch && !/(?<!\\):focus(?![a-z-])/i.test(pSubj)) ||
      /(?<!\\):focus-within(?![a-z-])/i.test(pNoNot);
    const allowBaseCoverage = !hasAncestorFocus;
    const pSubjHasPseudoEl = /(?<!\\)::[a-z-]/i.test(pSubj);
    const prefixPart = p.slice(0, p.length - rawSubj.length);
    const targetSel = collapseFocusFv(
      hasFvInBranch
        ? p.trim()
        : hasSubjFocus
        ? `${prefixPart}${rawSubj.replace(/(?<!\\):focus(?![a-z-])/gi, ":focus-visible")}`
        : hasFocusInBranch
        ? `${replaceFocusOutsideNot(prefixPart, ":focus-visible")}${rawSubj}`
        : `${p.replace(/(?<!\\):focus(?:-visible)?\s*$/i, "").trim()}:focus-visible`
    );
    const targetPlainFocusSel =
      !hasFvInBranch && !hasFocusInBranch
        ? collapseFocusFv(`${p.replace(/(?<!\\):focus(?:-visible)?\s*$/i, "").trim()}:focus`)
        : null;
    const { suppressedProps, importantSuppressedProps, hasApplyFocusOrFvRemoval } = getBlkOutlineSuppression(blk);
    const blkHasTwFocusApply = !pMeta.hasFv && !pMeta.hasFocus && !pMeta.hasFw && hasTwFocusApply(blk);
    const effPSpec = specOverride || (blkHasTwFocusApply ? [pMeta.spec[0], pMeta.spec[1] + 1, pMeta.spec[2]] : pMeta.spec);
    const blkOrder = getBlockOrder(blk);
    const blkHasImportantSup = importantSuppressedProps.length > 0;
    const directCovered = combinedFocusBlocks.some((other) => {
      if (other === blk) return false;
      if (!conditionsCover(other, blk)) return false;
      const layerCmp = compareCascadeLayerOrder(other, blk);
      const isOtherExternal = externalBlockSet.has(other);
      const otherOrder = getBlockOrder(other);
      const otherHasTwFocus = allowBaseCoverage && hasTwFocusApply(other);
      const isEarlierOnSameLayer =
        (layerCmp === 0 &&
          (isPlainFocus || hasFvInBranch || hasApplyFocusOrFvRemoval) &&
          ((otherOrder !== null && blkOrder !== null && otherOrder <= blkOrder) || isOtherExternal)) ||
        (isOtherExternal && layerCmp === 0 && isPlainFocus);
      return getBlockBranches(other).some((os) => {
        const trimSel = os.trim();
        const normTrim = collapseFocusFv(trimSel);
        let effOtherSpec = null;
        let applyFocusOnly = false;
        if (normTrim === targetSel || (isOtherExternal && targetPlainFocusSel && normTrim === targetPlainFocusSel)) {
          effOtherSpec = computeSelectorSpecificity(trimSel);
        } else if (allowBaseCoverage && pMeta.base) {
          if (/(?:disabled\b|aria-disabled\s*=\s*["']?true)/i.test(trimSel)) return false;
          const osSubjNoNot = extractSubjectSelector(stripNotPseudo(trimSel));
          if (!pSubjHasPseudoEl && /(?<!\\)::[a-z-]/i.test(osSubjNoNot)) return false;
          const osMeta = parseFocusMeta(trimSel);
          if (isPointerGatedCandidate(osMeta.noNot, pMeta.hasHover, pMeta.hasActive)) return false;
          if (
            !osMeta.base ||
            (osMeta.base !== pMeta.base && !selectorCoversBranchChain(osMeta.base, pMeta.base)) ||
            !notClausesCover(osMeta.notClauses, pMeta.notClauses)
          ) {
            return false;
          }
          if (osMeta.hasFv) {
            effOtherSpec = osMeta.spec;
          } else if (otherHasTwFocus && !osMeta.hasFv && !osMeta.hasFocus && !osMeta.hasFw) {
            effOtherSpec = [osMeta.spec[0], osMeta.spec[1] + 1, osMeta.spec[2]];
            applyFocusOnly = true;
          } else {
            return false;
          }
        } else {
          return false;
        }
        const specCmp = compareSpecificity(effOtherSpec, effPSpec);
        const otherLosesNormalOutline = layerCmp < 0 || (layerCmp === 0 && (specCmp < 0 || (specCmp === 0 && isEarlierOnSameLayer)));
        const otherLosesImpOutline = layerCmp > 0 || (layerCmp === 0 && (specCmp < 0 || (specCmp === 0 && isEarlierOnSameLayer)));
        const outlineUnrecoverable = blkHasImportantSup && otherLosesImpOutline;
        const requireImportantOutlineOnly = !blkHasImportantSup && otherLosesNormalOutline;
        const bSupp = getBorderSuppressionForRule(trimSel, other, blk);
        return hasVisibleFocusIndicator(other.body, trimSel, {
          ...bSupp,
          suppressedProps: [...new Set([...suppressedProps, ...(bSupp.extraOutlineSuppressedProps || [])])],
          importantSuppressedProps: [...new Set([...importantSuppressedProps, ...(bSupp.extraOutlineImportantSuppressedProps || [])])],
          requireImportantOutlineOnly,
          outlineUnrecoverable: outlineUnrecoverable || Boolean(bSupp.extraOutlineUnrecoverable),
          ...(applyFocusOnly ? { applyFocusOnly: true } : {}),
        });
      });
    });
    if (directCovered) return true;
    if (!specOverride) {
      const expandedBranches = expandTopLevelIsWhereBranches(p);
      if (expandedBranches.length > 1) {
        return expandedBranches.every((subP) => hasBranchSiblingFocusVisible(subP, blk, effPSpec));
      }
    }
    return false;
  };
  const hasBranchItemHighlightRule = (p, blk = null) => {
    const base = p.replace(/(?<!\\):focus(?:-visible)?\s*$/i, "").trim().toLowerCase();
    if (!base) return false;
    const targets = new Set([
      `${base}[data-highlighted]`,
      `${base}[data-focused]`,
      `${base}[aria-selected="true"]`,
      `${base}[aria-selected='true']`,
    ]);
    return cssBlocks.some(
      (other) =>
        conditionsCover(other, blk) &&
        getBlockBranches(other).some((os) => {
          const trimSel = os.trim();
          return (
            targets.has(trimSel.toLowerCase()) &&
            (hasVisibleFocusIndicator(other.body, "", {
              treatAsFocusSelector: true,
              ...getBorderSuppressionForRule(trimSel, other, blk),
            }) ||
              hasVisibleBackgroundDecl(other.body))
          );
        })
    );
  };
  const extractTrueAncestorSegments = (selBranch) => {
    const segs = [];
    const combs = [];
    let paren = 0;
    let br = 0;
    let quote = null;
    let segStart = 0;
    let i = 0;
    const str = String(selBranch || "").trim();
    while (i < str.length) {
      const ch = str[i];
      if (quote) {
        if (ch === "\\" && i + 1 < str.length) i += 2;
        else {
          if (ch === quote) quote = null;
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "[") br++;
      else if (ch === "]") br = Math.max(0, br - 1);
      else if (paren === 0 && br === 0 && /[\s>~+]/.test(ch)) {
        const piece = str.slice(segStart, i).trim();
        let comb = " ";
        while (i < str.length && /[\s>~+]/.test(str[i])) {
          if (str[i] === ">" || str[i] === "+" || str[i] === "~") comb = str[i];
          i++;
        }
        if (piece) {
          segs.push(piece);
          combs.push(comb);
        }
        segStart = i;
        continue;
      }
      i++;
    }
    const tail = str.slice(segStart).trim();
    if (tail) segs.push(tail);
    const ancestors = [];
    for (let k = segs.length - 2; k >= 0; k--) {
      if (combs[k] === "+" || combs[k] === "~") continue;
      ancestors.push(segs[k]);
    }
    if (ancestors.length >= 2 && combs.every((c) => c === " " || c === ">")) {
      ancestors.unshift(segs.slice(0, -1).join(" "));
    }
    return ancestors;
  };

  const isPointerGatedCandidate = (cleanS, pHasHover, pHasActive) =>
    (!pHasHover && /(?<!\\):hover(?![a-zA-Z0-9_-])/i.test(cleanS)) ||
    (!pHasActive && /(?<!\\):active(?![a-zA-Z0-9_-])/i.test(cleanS));

  const hasBranchParentFocusWithin = (p, blk = null) => {
    const pClean = stripNotPseudo(p);
    const pHasHover = /(?<!\\):hover(?![a-zA-Z0-9_-])/i.test(pClean);
    const pHasActive = /(?<!\\):active(?![a-zA-Z0-9_-])/i.test(pClean);
    const extractHasArgs = (selStr) => {
      const args = [];
      let searchPos = 0;
      while (searchPos < selStr.length) {
        const sub = selStr.slice(searchPos);
        const hm = /:has\(/i.exec(sub);
        if (!hm) break;
        const openIdx = searchPos + hm.index + hm[0].length - 1;
        let depth = 1;
        let k = openIdx + 1;
        let q = null;
        while (k < selStr.length && depth > 0) {
          const c = selStr[k];
          if (q) {
            if (c === "\\" && k + 1 < selStr.length) k++;
            else if (c === q) q = null;
          } else if (c === '"' || c === "'") q = c;
          else if (c === "(") depth++;
          else if (c === ")") depth--;
          k++;
        }
        if (depth === 0) args.push(selStr.slice(openIdx + 1, k - 1));
        searchPos = k;
      }
      return args;
    };
    const hasArgCoversSubject = (hasArg, targetSel, allowUniversal = true) => {
      for (const br of splitTopLevelCommas(hasArg)) {
        const trimBr = br.trim();
        if (isPointerGatedCandidate(trimBr, pHasHover, pHasActive)) continue;
        if (!/(?<!\\):focus(?:-visible)?(?![a-zA-Z0-9_-])/i.test(trimBr)) continue;
        const brSubjectRaw = extractSubjectSelector(trimBr);
        if (!/(?<!\\):focus(?:-visible)?(?![a-zA-Z0-9_-])/i.test(brSubjectRaw)) continue;
        const bareFocusBr = trimBr.replace(/(?<!\\):focus(?:-visible)?(?![a-zA-Z0-9_-])/gi, "").trim();
        const withoutComb = bareFocusBr.replace(/^[>+~\s]+/, "").trim();
        if (allowUniversal && (!withoutComb || withoutComb === "*")) return true;
        if (targetSel && withoutComb && withoutComb !== "*") {
          const brSubjNoFocus = brSubjectRaw.replace(/(?<!\\):focus(?:-visible)?(?![a-zA-Z0-9_-])/gi, "").trim().toLowerCase();
          if (branchSubjectsCoversTarget(brSubjNoFocus, targetSel)) return true;
        }
      }
      return false;
    };
    const bareBase = p.replace(/(?<!\\):focus(?:-visible)?\s*$/i, "").trim().toLowerCase();
    if (bareBase && /[.#\[]/.test(bareBase)) {
      if (
        combinedFocusBlocks.some(
          (other) =>
            conditionsCover(other, blk) &&
            getBlockBranches(other).some((os) => {
              const s = os.trim();
              const cleanS = stripNotPseudo(s);
              if (isPointerGatedCandidate(cleanS, pHasHover, pHasActive)) return false;
              const topNoHas = cleanS.replace(/:has\([^;]*\)/gi, "");
              if (isPointerGatedCandidate(topNoHas, pHasHover, pHasActive)) return false;
              const hasArgs = extractHasArgs(extractSubjectSelector(cleanS));
              return (
                hasArgs.length > 0 &&
                hasArgs.some((ha) => hasArgCoversSubject(ha, bareBase, false)) &&
                hasVisibleFocusIndicator(other.body, s, {
                  forWrapperChildFocus: true,
                  ...getBorderSuppressionForRule(s, other, blk),
                })
              );
            })
        )
      ) {
        return true;
      }
    }
    const ancestors = extractTrueAncestorSegments(p);
    if (ancestors.length === 0) return false;
    const stripWrapperHas = (selStr) => {
      const s0 = String(selStr || "");
      let out = "";
      let si = 0;
      while (si < s0.length) {
        if (s0.slice(si, si + 5).toLowerCase() === ":has(") {
          let d = 1;
          let sq = null;
          let k = si + 5;
          while (k < s0.length && d > 0) {
            const c = s0[k];
            if (sq) {
              if (c === "\\" && k + 1 < s0.length) k++;
              else if (c === sq) sq = null;
            } else if (c === '"' || c === "'") sq = c;
            else if (c === "(") d++;
            else if (c === ")") d--;
            k++;
          }
          if (d === 0) {
            si = k;
            continue;
          }
        }
        out += s0[si];
        si++;
      }
      return out;
    };
    const subjectCore = extractSubjectSelector(p)
      .replace(/(?<!\\):focus(?:-visible)?(?![a-zA-Z0-9_-])/gi, "")
      .trim()
      .toLowerCase();
    return combinedFocusBlocks.some(
      (other) =>
        conditionsCover(other, blk) &&
        getBlockBranches(other).some((os) => {
          const s = os.trim();
          const cleanS = stripNotPseudo(s);
          if (isPointerGatedCandidate(cleanS, pHasHover, pHasActive)) return false;
          const cleanSubj = extractSubjectSelector(cleanS);
          const hasFocusWithin = /(?<!\\):focus-within(?![a-zA-Z0-9_-])/i.test(cleanSubj);
          const hasFocusHas = /:has\(/i.test(cleanSubj);
          if (!hasFocusWithin && !hasFocusHas) return false;
          const wrapHostBase = stripWrapperHas(cleanSubj)
            .replace(/(?<!\\):focus(?:-visible|-within)?(?![a-zA-Z0-9_-])/gi, "")
            .trim()
            .toLowerCase();
          if (!wrapHostBase || !ancestors.some((anc) => branchSubjectsCoversTarget(wrapHostBase, anc))) {
            return false;
          }
          if (
            !hasVisibleFocusIndicator(other.body, s, {
              forWrapperChildFocus: true,
              ...getBorderSuppressionForRule(s, other, blk),
            })
          ) {
            return false;
          }
          if (hasFocusWithin) return true;
          return extractHasArgs(cleanSubj).some((ha) => hasArgCoversSubject(ha, subjectCore));
        })
    );
  };
  const isBranchTargetOnlySafe = (p, blk = null, allowHasWrapper = true) => {
    const pClean = stripNotPseudo(p);
    const pHasHover = /(?<!\\):hover(?![a-zA-Z0-9_-])/i.test(pClean);
    const pHasActive = /(?<!\\):active(?![a-zA-Z0-9_-])/i.test(pClean);
    const selfWrapRe = allowHasWrapper
      ? /(?<!\\)(?::focus-within(?![a-z-])|:has\(\s*(?:[>*]+\s*)*:focus(?:-visible)?\s*\))/i
      : /(?<!\\):focus-within(?![a-z-])/i;
    if (
      selfWrapRe.test(pClean) &&
      !isPointerGatedCandidate(pClean, pHasHover, pHasActive) &&
      blk &&
      hasVisibleFocusIndicator(blk.body || "", p, {
        ignoreApplyOutline: true,
        forWrapperChildFocus: true,
        ...getBorderSuppressionForRule(p, blk, null),
      })
    ) {
      return true;
    }
    const pSubj = stripNotPseudo(extractSubjectSelector(p));
    const isPlainFocus = /(?<!\\):focus(?![a-z-])/i.test(pSubj) && !/(?<!\\):focus-visible(?![a-z-])/i.test(pSubj);
    const { suppressedProps, importantSuppressedProps, hasApplyFocusOrFvRemoval } = getBlkOutlineSuppression(blk);
    const base = normSel(p.replace(/(?<!\\):focus(?:-visible)?\s*$/i, ""));
    if (!base) return false;
    const escBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapPat = allowHasWrapper
      ? `^${escBase}(?::focus-within\\b|:has\\(\\s*(?:[>*]+\\s*)*:focus(?:-visible)?\\s*\\))$`
      : `^${escBase}:focus-within\\b$`;
    const wrapRe = new RegExp(wrapPat, "i");
    const blkOrder = getBlockOrder(blk);
    const blkHasImportantSup = importantSuppressedProps.length > 0;
    const externalSet = new Set(Array.isArray(externalBlocks) ? externalBlocks : []);
    return combinedFocusBlocks.some(
      (other) => {
        if (!conditionsCover(other, blk)) return false;
        const layerCmp = compareCascadeLayerOrder(other, blk);
        const isOtherExternal = externalSet.has(other);
        const otherOrder = getBlockOrder(other);
        const sameLayerEarlier =
          layerCmp === 0 &&
          !isOtherExternal &&
          (isPlainFocus || hasApplyFocusOrFvRemoval) &&
          otherOrder !== null &&
          blkOrder !== null &&
          otherOrder <= blkOrder;
        const outlineUnrecoverable = blkHasImportantSup && (layerCmp > 0 || sameLayerEarlier);
        const requireImportantOutlineOnly = !blkHasImportantSup && (layerCmp < 0 || sameLayerEarlier);
        return getBlockBranches(other).some((os) => {
          const s = os.trim();
          const cleanS = stripNotPseudo(s);
          if (isPointerGatedCandidate(cleanS, pHasHover, pHasActive)) return false;
          return (
            wrapRe.test(normSel(cleanS)) &&
            hasVisibleFocusIndicator(other.body, s, {
              suppressedProps,
              importantSuppressedProps,
              requireImportantOutlineOnly,
              outlineUnrecoverable,
              forWrapperChildFocus: true,
              ...getBorderSuppressionForRule(s, other, blk),
            })
          );
        });
      }
    );
  };
  const checker = (selStr, blk = null, opts = {}) => {
    const parts = splitTopLevelCommas(selStr);
    if (parts.length === 0) return false;
    if (opts && opts.targetOnly) {
      return parts.every((p) => isBranchTargetOnlySafe(p, blk, true));
    }
    return parts.every((p) => {
      const rawSubj = extractSubjectSelector(p);
      const pSubj = stripNotPseudo(rawSubj);
      const hasDirectFvOnSubj = /(?<!\\):focus-visible(?![a-z-])/i.test(pSubj);
      if (isBranchGuardedNotFocusVisible(p) || SKIP_FOCUS_RE.test(p)) {
        return true;
      }
      if (!hasDirectFvOnSubj && WRAPPER_FOCUS_RE.test(rawSubj)) return true;
      if (!hasDirectFvOnSubj && isBranchTargetOnlySafe(p, blk, false)) return true;
      if (hasBranchSiblingFocusVisible(p, blk)) return true;
      if (hasBranchParentFocusWithin(p, blk)) return true;
      if (hasBranchItemHighlightRule(p, blk)) return true;
      return false;
    });
  };
  checker.getBorderSuppression = (selStr, blk = null, srcBlk = null) => {
    const parts = splitTopLevelCommas(selStr);
    if (parts.length === 0) {
      return {
        borderSuppressedProps: [],
        borderImportantSuppressedProps: [],
        borderUnrecoverableProps: [],
        boxShadowImportantSuppressed: false,
        boxShadowUnrecoverable: false,
        boxShadowSuppressedBySrc: false,
        borderSuppressedBySrc: false,
      };
    }
    const supSet = new Set();
    const impSet = new Set();
    const unrecovSet = new Set();
    const sideSup = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    const sideImpSup = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    const sideUnrecov = { t: new Set(), r: new Set(), b: new Set(), l: new Set() };
    const ringSup = new Set();
    const ringImpSup = new Set();
    const ringUnrecov = new Set();
    const insetRingSup = new Set();
    const insetRingImpSup = new Set();
    const insetRingUnrecov = new Set();
    let boxShadowImportantSuppressed = false;
    let boxShadowUnrecoverable = false;
    let boxShadowSuppressedBySrc = false;
    let pureBoxShadowImportantSuppressed = false;
    let pureBoxShadowUnrecoverable = false;
    let pureBoxShadowSuppressedBySrc = false;
    let borderSuppressedBySrc = false;
    let ringSuppressedBySrc = false;
    let insetRingSuppressedBySrc = false;
    for (const p of parts) {
      const res = getBorderSuppressionForRule(p, blk, srcBlk);
      for (const s of res.borderSuppressedProps) supSet.add(s);
      for (const s of res.borderImportantSuppressedProps) impSet.add(s);
      for (const s of res.borderUnrecoverableProps || []) unrecovSet.add(s);
      for (const sCh of ["t", "r", "b", "l"]) {
        for (const s of res.borderSideSuppressed?.[sCh] || []) sideSup[sCh].add(s);
        for (const s of res.borderSideImportantSuppressed?.[sCh] || []) sideImpSup[sCh].add(s);
        for (const s of res.borderSideUnrecoverable?.[sCh] || []) sideUnrecov[sCh].add(s);
      }
      for (const s of res.ringSuppressedProps || []) ringSup.add(s);
      for (const s of res.ringImportantSuppressedProps || []) ringImpSup.add(s);
      for (const s of res.ringUnrecoverableProps || []) ringUnrecov.add(s);
      for (const s of res.insetRingSuppressedProps || []) insetRingSup.add(s);
      for (const s of res.insetRingImportantSuppressedProps || []) insetRingImpSup.add(s);
      for (const s of res.insetRingUnrecoverableProps || []) insetRingUnrecov.add(s);
      if (res.boxShadowImportantSuppressed) boxShadowImportantSuppressed = true;
      if (res.boxShadowUnrecoverable) boxShadowUnrecoverable = true;
      if (res.boxShadowSuppressedBySrc) boxShadowSuppressedBySrc = true;
      if (res.pureBoxShadowImportantSuppressed) pureBoxShadowImportantSuppressed = true;
      if (res.pureBoxShadowUnrecoverable) pureBoxShadowUnrecoverable = true;
      if (res.pureBoxShadowSuppressedBySrc) pureBoxShadowSuppressedBySrc = true;
      if (res.borderSuppressedBySrc) borderSuppressedBySrc = true;
      if (res.ringSuppressedBySrc) ringSuppressedBySrc = true;
      if (res.insetRingSuppressedBySrc) insetRingSuppressedBySrc = true;
    }
    return {
      borderSuppressedProps: [...supSet],
      borderImportantSuppressedProps: [...impSet],
      borderUnrecoverableProps: [...unrecovSet],
      borderSideSuppressed: { t: [...sideSup.t], r: [...sideSup.r], b: [...sideSup.b], l: [...sideSup.l] },
      borderSideImportantSuppressed: { t: [...sideImpSup.t], r: [...sideImpSup.r], b: [...sideImpSup.b], l: [...sideImpSup.l] },
      borderSideUnrecoverable: { t: [...sideUnrecov.t], r: [...sideUnrecov.r], b: [...sideUnrecov.b], l: [...sideUnrecov.l] },
      ringSuppressedProps: [...ringSup],
      ringImportantSuppressedProps: [...ringImpSup],
      ringUnrecoverableProps: [...ringUnrecov],
      insetRingSuppressedProps: [...insetRingSup],
      insetRingImportantSuppressedProps: [...insetRingImpSup],
      insetRingUnrecoverableProps: [...insetRingUnrecov],
      boxShadowImportantSuppressed,
      boxShadowUnrecoverable,
      boxShadowSuppressedBySrc,
      pureBoxShadowImportantSuppressed,
      pureBoxShadowUnrecoverable,
      pureBoxShadowSuppressedBySrc,
      borderSuppressedBySrc,
      ringSuppressedBySrc,
      insetRingSuppressedBySrc,
    };
  };
  checker.compareLayerOrder = compareCascadeLayerOrder;
  return checker;
}

export function scanUiContent(raw, filePath, options = {}) {
  const tier = String(options.tier || "floor").toLowerCase();
  const includeFloor = tier !== "reflex";
  const includeReflex = tier === "all" || tier === "reflex";
  const ext = extname(filePath).toLowerCase();
  if (!UI_EXTS.has(ext)) {
    return { file: filePath, active: [], waived: [], unusedIgnores: [], counts: { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 } };
  }

  const isStyle = ext === ".css" || ext === ".scss";
  const cleanComments = stripCommentsPreservingLines(raw);
  const findings = [];
  const findBal = (srcStr, openIdx, openCh, closeCh, allowRegex = true) => {
    let depth = 1;
    let q = null;
    let lastSig = openCh;
    const parenStack = [];
    for (let k = openIdx + 1; k < srcStr.length; k++) {
      const c = srcStr[k];
      if (q) {
        if (c === "\\" && k + 1 < srcStr.length) { k++; continue; }
        if (q === "`" && c === "$" && srcStr[k + 1] === "{") {
          const se = findBal(srcStr, k + 1, "{", "}", true);
          if (se === -1) return -1;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) {
          q = null;
          lastSig = c;
        }
        continue;
      }
      if (allowRegex) {
        const reEnd = skipJsRegexInExpr(srcStr, k, lastSig, openIdx + 1);
        if (reEnd !== -1) {
          k = reEnd - 1;
          lastSig = "/";
          continue;
        }
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) return k;
      }
      if (!q) {
        if (c === "(") {
          if (allowRegex) parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(srcStr.slice(Math.max(openIdx + 1, k - 16), k)));
          lastSig = "(";
        } else if (c === ")") {
          lastSig = allowRegex && parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        } else if (!/\s/.test(c)) {
          lastSig = c;
        }
      }
    }
    return -1;
  };
  const stripOuterBalancedParens = (rawExpr) => {
    let e = String(rawExpr || "").trim();
    while (e.startsWith("(") && e.endsWith(")")) {
      let p = 0;
      let q = null;
      let lastSig = "(";
      let closedAtEnd = false;
      for (let k = 0; k < e.length; k++) {
        const c = e[k];
        if (q) {
          if (c === "\\" && k + 1 < e.length) { k++; continue; }
          if (q === "`" && c === "$" && k + 1 < e.length && e[k + 1] === "{") {
            const se = findBal(e, k + 1, "{", "}");
            if (se === -1) break;
            k = se;
            lastSig = "}";
            continue;
          }
          if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
          continue;
        }
        const reEnd = skipJsRegexInExpr(e, k, lastSig, 0);
        if (reEnd !== -1 && reEnd <= e.length) { k = reEnd - 1; lastSig = "/"; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (c === "(") { p++; lastSig = "("; }
        else if (c === ")") {
          p--;
          lastSig = ")";
          if (p === 0) {
            closedAtEnd = k === e.length - 1;
            break;
          }
        } else if (!/\s/.test(c)) lastSig = c;
      }
      if (!closedAtEnd) break;
      e = e.slice(1, -1).trim();
    }
    return e;
  };
  const stripTrailingTsCastEnd = (str, start, end) =>
    ciStripTrailingTsCastEnd(str, start, end, (s0, oi, oc, cc) => findBal(s0, oi, oc, cc));
  const splitTopLevelLogical = (expr, op) => {
    const parts = [];
    let start = 0;
    let p = 0;
    let b = 0;
    let br = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    for (let k = 0; k < expr.length; k++) {
      const c = expr[k];
      if (q) {
        if (c === "\\" && k + 1 < expr.length) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < expr.length && expr[k + 1] === "{") {
          const se = findBal(expr, k + 1, "{", "}");
          if (se === -1) break;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(expr, k, lastSig, 0);
      if (reEnd !== -1 && reEnd <= expr.length) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(0, k - 16), k)));
        p++;
        lastSig = "(";
      } else if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        p = Math.max(0, p - 1);
      } else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0 && expr.startsWith(op, k)) {
        parts.push(expr.slice(start, k));
        start = k + op.length;
        lastSig = op[op.length - 1];
        k += op.length - 1;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    parts.push(expr.slice(start));
    return parts;
  };
  const findTopLevelBoolEq = (expr) => {
    let p = 0;
    let b = 0;
    let br = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    for (let k = 0; k < expr.length; k++) {
      const c = expr[k];
      if (q) {
        if (c === "\\" && k + 1 < expr.length) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < expr.length && expr[k + 1] === "{") {
          const se = findBal(expr, k + 1, "{", "}");
          if (se === -1) break;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(expr, k, lastSig, 0);
      if (reEnd !== -1 && reEnd <= expr.length) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(0, k - 16), k)));
        p++;
        lastSig = "(";
      } else if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        p = Math.max(0, p - 1);
      } else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0 && (c === "=" || c === "!") && expr[k + 1] === "=") {
        const opLen = expr[k + 2] === "=" ? 3 : 2;
        const op = expr.slice(k, k + opLen);
        const lhs = expr.slice(0, k).trim();
        const rhs = expr.slice(k + opLen).trim();
        if (rhs === "true" || rhs === "false") {
          return { side: lhs, neg: (op.startsWith("=") && rhs === "false") || (op.startsWith("!") && rhs === "true") };
        }
        if (lhs === "true" || lhs === "false") {
          return { side: rhs, neg: (op.startsWith("=") && lhs === "false") || (op.startsWith("!") && lhs === "true") };
        }
        return null;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    return null;
  };
  const hasTopLevelBinaryOp = (expr) => {
    let p = 0;
    let b = 0;
    let br = 0;
    let q = null;
    let lastSig = "";
    const parenStack = [];
    for (let k = 0; k < expr.length; k++) {
      const c = expr[k];
      if (q) {
        if (c === "\\" && k + 1 < expr.length) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < expr.length && expr[k + 1] === "{") {
          const se = findBal(expr, k + 1, "{", "}");
          if (se === -1) break;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(expr, k, lastSig, 0);
      if (reEnd !== -1 && reEnd <= expr.length) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(0, k - 16), k)));
        p++;
        lastSig = "(";
      } else if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
        p = Math.max(0, p - 1);
      } else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0) {
        if (k > 0 && ((c === "=" && expr[k + 1] === "=") || (c === "!" && expr[k + 1] === "=") || (c === "?" && expr[k + 1] === "?") || c === "<" || (c === ">" && expr[k - 1] !== "="))) {
          return true;
        }
        if (k > 0 && (c === "i" || c === "a") && /^(?:instanceof|in)\b/.test(expr.slice(k, k + 12)) && !/[A-Za-z0-9_$]/.test(expr[k - 1])) {
          return true;
        }
        if (!/\s/.test(c)) lastSig = c;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    return false;
  };

  // Extract CSS sources: either whole CSS/SCSS file, or `<style>...</style>` blocks inside HTML/Vue/Svelte/Astro
  const markupOpts = isStyle
    ? null
    : {
        isMarkupSfc: /\.(?:html?|vue|svelte|astro)$/i.test(filePath),
        braceExprs: /\.(?:svelte|astro)$/i.test(filePath),
        mustacheExprs: /\.vue$/i.test(filePath),
        isAstro: /\.astro$/i.test(filePath),
      };
  const fullMarkupCtx = !isStyle ? scanMarkupContexts(cleanComments, markupOpts) : null;
  const cssSlices = [];
  const styleRanges = [];
  if (isStyle) {
    cssSlices.push({ text: cleanComments, baseOffset: 0, isScoped: false });
  } else {
    for (const blk of extractRealStyleBlocks(cleanComments, fullMarkupCtx, markupOpts)) {
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

  const checkCssDeclsFloor = (body, baseOff, effSelector, blk, isSelectorSafeForOutlineNone) => {
    const inKeyframes = Boolean(blk?.inKeyframes);
    const maskedBody = maskCssQuotedStringsPreservingLines(body);
    const cssDeclBody = maskAtApplyDeclsPreservingLines(maskedBody);
    // 1 & 2. Floor: transition: all & layout-reflow transitions (width, height, top, left) scoped inside declaration bodies
    for (const m of cssDeclBody.matchAll(/(?<![a-zA-Z0-9_$-])transition(?:-property)?\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))*)/gi)) {
      const declOffset = baseOff + m.index;
      const strippedTrans = stripCssParens(m[1]);
      if (/(?<![a-zA-Z0-9_$-])all(?![a-zA-Z0-9_-])/i.test(strippedTrans)) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, declOffset),
          ruleId: "dsaf/no-transition-all",
          tier: "floor",
          severity: "error",
          message: `Disallowed \`transition: ${m[1].trim()}\`; transition explicit composited properties instead.`,
        });
      }
      const layoutHit = /(?<![a-zA-Z0-9_$-])(width|height|top|left)(?![a-zA-Z0-9_-])/i.exec(strippedTrans);
      if (layoutHit) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, declOffset),
          ruleId: "dsaf/no-layout-transition",
          tier: "floor",
          severity: "error",
          message: `Disallowed layout transition on \`${layoutHit[1]}\`; animate \`transform\` or \`opacity\`.`,
        });
      }
    }

    // 3. Floor: 100vw horizontal overflow trap (width / inline-size & CSS math functions; excludes @media & CSS custom prop names)
    for (const m of cssDeclBody.matchAll(/(?<![a-zA-Z0-9_$-])((?:min-|max-)?(?:width|inline-size))\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)) {
      const cleanVwVal = m[2].replace(/--[a-zA-Z0-9_-]+/g, " ");
      if (/(?:^|[\s,(*/+-])100vw(?=$|[\s,)*/+-]|!\s*important)/i.test(cleanVwVal)) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, baseOff + m.index),
          ruleId: "dsaf/no-100vw",
          tier: "floor",
          severity: "error",
          message: "Disallowed `100vw` width; use `100%` with `overflow-x: clip` to prevent scrollbar overflow.",
        });
      }
    }

    // Tailwind @apply utilities inside CSS/SCSS rule bodies
    const applyMaskedBody = maskCssQuotedStringsPreservingLines(String(body || ""), "_");
    const applyMatches = [...maskedBody.matchAll(/(?<![a-zA-Z0-9_$-])@apply\s+((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/gi)].map((am) => {
      const appRelStart = am.index + am[0].indexOf(am[1]);
      const appText = applyMaskedBody.slice(appRelStart, appRelStart + am[1].length);
      const stmtImp = /\s*!\s*important\s*$/i.test(appText);
      const cleanAppText = stmtImp ? appText.replace(/\s*!\s*important\s*$/i, "") : appText;
      return {
        appBase: baseOff + appRelStart,
        appText,
        cleanAppText,
        stmtImp,
      };
    });
    const formatSiblingApply = (entry) => {
      if (!entry.stmtImp) return entry.cleanAppText;
      return entry.cleanAppText
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => (/(?:^|:)!|!$/.test(tok) ? tok : `!${tok}`))
        .join(" ");
    };
    const applyTransRe = new RegExp(`(?<=^|\\s)!?(?:${TW_VARIANT_SEG})*!?${TW_TRANS_ALL_CORE}!?(?=$|[\\s;])`, "g");
    const applyVwRe = new RegExp(`(?<=^|\\s)!?(?:${TW_VARIANT_SEG})*!?${TW_VW_CORE}!?(?=$|[\\s;])`, "g");
    for (let amIdx = 0; amIdx < applyMatches.length; amIdx++) {
      const { appBase, appText, cleanAppText, stmtImp } = applyMatches[amIdx];
      const afterApplyText = applyMatches
        .slice(amIdx + 1)
        .map(formatSiblingApply)
        .join(" ");
      const prevApplyText = applyMatches
        .slice(0, amIdx)
        .map(formatSiblingApply)
        .join(" ");
      for (const tm of appText.matchAll(applyTransRe)) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, appBase + tm.index),
          ruleId: "dsaf/no-transition-all",
          tier: "floor",
          severity: "error",
          message: `Disallowed Tailwind \`@apply ${tm[0].trim()}\`; use \`transition-colors\` or \`transition-transform\`.`,
        });
      }
      for (const vm of appText.matchAll(applyVwRe)) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, appBase + vm.index),
          ruleId: "dsaf/no-100vw",
          tier: "floor",
          severity: "error",
          message: "Disallowed Tailwind `@apply w-[100vw]`; use `w-full`.",
        });
      }
      const appTwOutline = !inKeyframes
        ? analyzeTailwindOutline(cleanAppText, afterApplyText, prevApplyText, { forceMainImportant: stmtImp })
        : { hasRemoval: false, naked: false, uncovered: [] };
      const appUncovered = appTwOutline.uncovered || (appTwOutline.firstRemoval ? [appTwOutline.firstRemoval] : []);
      if (appTwOutline.hasRemoval) {
        if (appTwOutline.naked && appUncovered.length > 0) {
          const ignoreApplyOutline = !/(?<!\\):focus-visible(?![a-z-])/i.test(stripNotPseudo(effSelector));
          const borderSupp = isSelectorSafeForOutlineNone.getBorderSuppression ? isSelectorSafeForOutlineNone.getBorderSuppression(effSelector, blk) : {};
          const selfCovered = hasVisibleFocusIndicator(body, effSelector, { ignoreApplyOutline, ...borderSupp }) || isSelectorSafeForOutlineNone(effSelector, blk);
          const targetCovered = isSelectorSafeForOutlineNone(effSelector, blk, { targetOnly: true });
          const effectiveUncovered = appUncovered.filter((u) =>
            u.targetPrefixes && u.targetPrefixes.size > 0 ? !targetCovered : !selfCovered
          );
          if (effectiveUncovered.length > 0) {
            findings.push({
              file: filePath,
              line: offsetToLine(cleanComments, appBase + effectiveUncovered[0].tokIdx),
              ruleId: "dsaf/no-outline-none-naked",
              tier: "floor",
              severity: "error",
              message: "Tailwind `@apply outline-none`/`outline-0` without paired `focus-visible:ring-*` or focus `outline-*`.",
            });
          }
        } else if (!appTwOutline.naked && appTwOutline.firstRemoval && !(appTwOutline.firstRemoval.targetPrefixes?.size > 0)) {
          const borderSupp = isSelectorSafeForOutlineNone.getBorderSuppression ? isSelectorSafeForOutlineNone.getBorderSuppression(effSelector, blk) : {};
          const selfCovered = hasVisibleFocusIndicator(body, effSelector, { ignoreApplyOutline: false, ...borderSupp }) || isSelectorSafeForOutlineNone(effSelector, blk);
          if (!selfCovered) {
            findings.push({
              file: filePath,
              line: offsetToLine(cleanComments, appBase + appTwOutline.firstRemoval.tokIdx),
              ruleId: "dsaf/no-outline-none-naked",
              tier: "floor",
              severity: "error",
              message: "Tailwind `@apply outline-none`/`outline-0` paired ring is suppressed by CSS `box-shadow`/`border` declaration.",
            });
          }
        }
      }
    }

    // 4. Floor: outline: none / 0 / style: none / width: 0 / transparent without visible replacement
    const outRemovals = !inKeyframes ? findOutlineRemovals(cssDeclBody) : [];
    if (outRemovals.length > 0) {
      const outMatch = outRemovals[outRemovals.length - 1];
      const borderSupp = isSelectorSafeForOutlineNone.getBorderSuppression ? isSelectorSafeForOutlineNone.getBorderSuppression(effSelector, blk) : {};
      const hasReplacement = hasVisibleFocusIndicator(body, effSelector, borderSupp);
      if (!hasReplacement && !isSelectorSafeForOutlineNone(effSelector, blk)) {
        findings.push({
          file: filePath,
          line: offsetToLine(cleanComments, baseOff + outMatch.index),
          ruleId: "dsaf/no-outline-none-naked",
          tier: "floor",
          severity: "error",
          message: `Focus \`${outMatch.matchText}\` on \`${effSelector || "(rule)"}\` without visible focus ring/border replacement.`,
        });
      }
    }

    // 6. Floor: hidden reveal containers at rest without `.js` gate or `@starting-style`
    if (effSelector) {
      const selectorBranches = splitTopLevelCommas(effSelector);
      const hasUncoveredReveal = selectorBranches.some((b) => {
        const cleanB = stripNotPseudo(b);
        return (
          /(?:\.reveal(?![a-z0-9_-])|\[data-reveal(?:[\]=~|^$*\s]))/i.test(cleanB) &&
          !/\.js(?![a-z0-9_-])/i.test(cleanB)
        );
      });
      if (hasUncoveredReveal && !blk?.inStartingStyle && !inKeyframes) {
        const opMatch = /(?<![a-zA-Z0-9_$-])opacity\s*:\s*(?:0(?:\.0+)?|\.0+)%?(?:\s*!\s*important)?(?:\s*;|\s*$)/i.exec(maskedBody);
        if (opMatch) {
          findings.push({
            file: filePath,
            line: offsetToLine(cleanComments, baseOff + opMatch.index),
            ruleId: "dsaf/no-hidden-at-rest",
            tier: "floor",
            severity: "error",
            message: `Selector \`${effSelector}\` sets \`opacity: 0\` at rest without a \`.js\` scope or \`@starting-style\`.`,
          });
        }
      }
    }
  };

  if (includeFloor) {
    const parsedSlices = cssSlices.map((slice) => ({
      slice,
      cssBlocks: extractCssRuleBlocks(slice.text).map((b) => ({ ...b, docBodyStart: slice.baseOffset + b.bodyStart })),
    }));
    const allUnscopedDocBlocks = parsedSlices.filter((p) => !p.slice.isScoped).flatMap((p) => p.cssBlocks);
    const allScopedDocBlocks = parsedSlices.filter((p) => p.slice.isScoped).flatMap((p) => p.cssBlocks);
    const externalBlocks = Array.isArray(options.externalCssBlocks) ? options.externalCssBlocks : [];
    const unscopedChecker = createFocusSafetyChecker(allUnscopedDocBlocks, externalBlocks);
    const scopedChecker =
      allScopedDocBlocks.length > 0
        ? createFocusSafetyChecker([...allScopedDocBlocks, ...allUnscopedDocBlocks], externalBlocks)
        : unscopedChecker;
    for (const { slice, cssBlocks } of parsedSlices) {
      const isSelectorSafeForOutlineNone = slice.isScoped ? scopedChecker : unscopedChecker;

      for (const blk of cssBlocks) {
        const effSelector = blk.resolvedSelector || blk.selector;
        checkCssDeclsFloor(blk.body, slice.baseOffset + blk.bodyStart, effSelector, blk, isSelectorSafeForOutlineNone);
      }
    }

    // Non-CSS markup / JSX checks (with <style> blocks masked to prevent duplicate findings on @apply)
    if (!isStyle) {
    const markupCtx = styleRanges.length > 0 ? scanMarkupContexts(nonStyleClean, markupOpts) : fullMarkupCtx;
    const inTagSpan = (idx, spans) => spans.some(([ss, se]) => idx >= ss && idx < se);
    const isRealOpenTagAttrPos = (idx) => ciIsRealOpenTagAttrPos(markupCtx, idx);
    const tailwindSpans = extractTailwindClassSpans(nonStyleClean, { ...markupOpts, markupCtx, includeAllCvaArgs: true });
    // 1b. Tailwind transition-all / transition-[all] / [transition:all]
    const twSpanTransRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_TRANS_ALL_CORE})(!?)(?=$|[\\s;])`, "g");
    const seenTransOffsets = new Set();
    for (const span of tailwindSpans) {
      const maskedSpan = maskCssQuotedStringsPreservingLines(span.content, "_");
      for (const m of maskedSpan.matchAll(twSpanTransRe)) {
        const absOff = span.contentStart + m.index;
        if (seenTransOffsets.has(absOff)) continue;
        seenTransOffsets.add(absOff);
        findings.push({
          file: filePath,
          line: offsetToLine(nonStyleClean, absOff),
          ruleId: "dsaf/no-transition-all",
          tier: "floor",
          severity: "error",
          message: "Disallowed Tailwind utility `transition-all`; use `transition-colors` or `transition-transform`.",
        });
      }
    }
    // 3b. Tailwind w-[100vw] / math 100vw / [inline-size:100vw]
    const twSpanVwRe = new RegExp(`(?<=^|\\s)(!?(?:${TW_VARIANT_SEG})*!?${TW_VW_CORE})(!?)(?=$|[\\s;])`, "g");
    const seenVwOffsets = new Set();
    for (const span of tailwindSpans) {
      const maskedSpan = maskCssQuotedStringsPreservingLines(span.content, "_");
      for (const m of maskedSpan.matchAll(twSpanVwRe)) {
        const absOff = span.contentStart + m.index;
        if (seenVwOffsets.has(absOff)) continue;
        seenVwOffsets.add(absOff);
        findings.push({
          file: filePath,
          line: offsetToLine(nonStyleClean, absOff),
          ruleId: "dsaf/no-100vw",
          tier: "floor",
          severity: "error",
          message: "Disallowed Tailwind `100vw` width utility; use `w-full`.",
        });
      }
    }
    // 4b. Tailwind outline-none / outline-0 / outline-hidden / [outline:none] without visible replacement
    const extractedAttrs = extractTailwindClassSpans(nonStyleClean, { ...markupOpts, markupCtx, includeAllCvaArgs: true });
    for (const attr of extractedAttrs) {
      const maskedContent = maskCssQuotedStringsPreservingLines(attr.content, "_");
      const maskedSiblings = maskCssQuotedStringsPreservingLines(attr.siblingClasses || "", "_");
      const twOut = analyzeTailwindOutline(maskedContent, maskedSiblings);
      if (twOut.hasRemoval && twOut.naked) {
        findings.push({
          file: filePath,
          line: offsetToLine(nonStyleClean, attr.contentStart + twOut.firstRemoval.tokIdx),
          ruleId: "dsaf/no-outline-none-naked",
          tier: "floor",
          severity: "error",
          message: "Tailwind `outline-none`/`outline-0` without paired `focus-visible:ring-*` or focus `outline-*`.",
        });
      }
    }
    if (ext === ".svelte") {
      const isStaticallyFalsySvelteExpr = (rawExpr) => {
        const stripOuter = (str) => {
          let s0 = String(str || "").trim();
          while (s0) {
            const cut = stripTrailingTsCastEnd(s0, 0, s0.length);
            if (cut !== s0.length) {
              s0 = s0.slice(0, cut).trim();
              continue;
            }
            if (s0.startsWith("(") && findBal(s0, 0, "(", ")") === s0.length - 1) {
              s0 = s0.slice(1, -1).trim();
              continue;
            }
            break;
          }
          return s0;
        };
        const e = stripOuter(rawExpr);
        if (!e) return false;
        if (/^(?:false|null|undefined|0|""|''|``|!true|!1|!\s*\[\s*\])$/.test(e)) return true;
        const topAnds = [];
        let q = null;
        let p = 0;
        let b = 0;
        let br = 0;
        let qPos = -1;
        let colPos = -1;
        let td = 0;
        let lastSig = "";
        let partStart = 0;
        for (let k = 0; k < e.length; k++) {
          const c = e[k];
          if (q) {
            if (c === "\\" && k + 1 < e.length) { k++; continue; }
            if (q === "`" && c === "$" && e[k + 1] === "{") {
              const se = findBal(e, k + 1, "{", "}");
              if (se === -1) break;
              k = se;
              continue;
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
            continue;
          }
          const reEnd = skipJsRegexInExpr(e, k, lastSig, 0);
          if (reEnd !== -1) { k = reEnd - 1; lastSig = "/"; continue; }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "(") { p++; lastSig = c; }
          else if (c === ")") { p = Math.max(0, p - 1); lastSig = c; }
          else if (c === "[") { b++; lastSig = c; }
          else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
          else if (c === "{") { br++; lastSig = c; }
          else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
          else if (p === 0 && b === 0 && br === 0) {
            if (c === "?" && e[k + 1] !== "?" && e[k + 1] !== ".") {
              if (qPos === -1) qPos = k;
              td++;
            } else if (c === ":" && td > 0) {
              td--;
              if (td === 0) colPos = k;
            } else if (c === "&" && e[k + 1] === "&" && td === 0) {
              topAnds.push(e.slice(partStart, k));
              partStart = k + 2;
              k++;
            }
            if (!/\s/.test(c)) lastSig = c;
          } else if (!/\s/.test(c)) lastSig = c;
        }
        if (qPos !== -1 && colPos !== -1) {
          return isStaticallyFalsySvelteExpr(e.slice(qPos + 1, colPos)) && isStaticallyFalsySvelteExpr(e.slice(colPos + 1));
        }
        if (topAnds.length > 0) {
          topAnds.push(e.slice(partStart));
          return topAnds.some((seg) => isStaticallyFalsySvelteExpr(seg));
        }
        return false;
      };
      const svelteClassDirsByTag = new Map();
      for (const dir of extractSvelteClassDirectives(nonStyleClean, markupCtx)) {
        if (isStaticallyFalsySvelteExpr(dir.rhs)) continue;
        let arr = svelteClassDirsByTag.get(dir.tag);
        if (!arr) {
          arr = [];
          svelteClassDirsByTag.set(dir.tag, arr);
        }
        arr.push({ cls: dir.cls, rhs: dir.rhs, index: dir.index });
      }
      const dirTwVwRe = new RegExp(`^!?(?:${TW_VARIANT_SEG})*!?${TW_VW_CORE}!?(?:$|\\s)`, "i");
      const dirTwTransRe = new RegExp(`^!?(?:${TW_VARIANT_SEG})*!?${TW_TRANS_ALL_CORE}!?$`);
      for (const [enc, dirs] of svelteClassDirsByTag.entries()) {
        for (const dir of dirs) {
          if (isTwOutlineRemoval(dir.cls)) {
            const sibAttrClasses = extractedAttrs
              .filter((a) => a.unconditional !== false && a.contentStart > enc.start && a.contentStart < enc.end)
              .map((a) => maskCssQuotedStringsPreservingLines(a.content, "_"));
            const sibDirectiveClasses = dirs
              .filter(
                (other) =>
                  other !== dir &&
                  (other.rhs === "" || other.rhs === "true" || (dir.rhs !== "" && other.rhs === dir.rhs))
              )
              .map((other) => other.cls);
            const sibClasses = [...sibAttrClasses, ...sibDirectiveClasses].filter(Boolean).join(" ");
            const twOut = analyzeTailwindOutline(dir.cls, sibClasses);
            if (twOut.hasRemoval && twOut.naked) {
              findings.push({
                file: filePath,
                line: offsetToLine(nonStyleClean, dir.index),
                ruleId: "dsaf/no-outline-none-naked",
                tier: "floor",
                severity: "error",
                message: "Svelte `class:outline-none`/`outline-0` without paired `focus-visible:ring-*` or focus `outline-*`.",
              });
            }
          } else if (dirTwTransRe.test(dir.cls)) {
            findings.push({
              file: filePath,
              line: offsetToLine(nonStyleClean, dir.index),
              ruleId: "dsaf/no-transition-all",
              tier: "floor",
              severity: "error",
              message: "Disallowed Svelte `class:transition-all`; transition explicit composited properties instead.",
            });
          } else if (dirTwVwRe.test(dir.cls)) {
            findings.push({
              file: filePath,
              line: offsetToLine(nonStyleClean, dir.index),
              ruleId: "dsaf/no-100vw",
              tier: "floor",
              severity: "error",
              message: "Disallowed Svelte `class:w-[100vw]`; use `w-full`.",
            });
          }
        }
      }
    }
    // 5b. CSS-in-JS templates, HTML style="...", JSX/Vue style={{...}} / :style, and Svelte style:* Floor checks
    {
      const skipTsGen = (srcStr, startCur) => {
        let cur = startCur;
        while (cur < srcStr.length && /\s/.test(srcStr[cur])) cur++;
        if (cur >= srcStr.length || srcStr[cur] !== "<") return { cur, ok: true };
        let angle = 0;
        let brace = 0;
        let q = null;
        const limit = Math.min(srcStr.length, cur + 800);
        while (cur < limit) {
          const c = srcStr[cur];
          if (q) {
            if (c === "\\" && cur + 1 < limit) { cur += 2; continue; }
            if (c === q || (q !== "`" && c === "\n")) q = null;
            cur++;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") { q = c; cur++; continue; }
          if (c === "{") brace++;
          else if (c === "}") brace = Math.max(0, brace - 1);
          else if (c === "<" && brace === 0) angle++;
          else if (c === ">" && srcStr[cur - 1] !== "=" && brace === 0) {
            angle--;
            if (angle === 0) { cur++; break; }
          } else if (c === ";" && brace === 0 && angle <= 0) break;
          cur++;
        }
        if (angle !== 0) return { cur: startCur, ok: false };
        while (cur < srcStr.length && /\s/.test(srcStr[cur])) cur++;
        return { cur, ok: true };
      };
      const VW_WIDTH_KEYS = new Set([
        "width",
        "minwidth",
        "maxwidth",
        "min-width",
        "max-width",
        "inlinesize",
        "mininlinesize",
        "maxinlinesize",
        "inline-size",
        "min-inline-size",
        "max-inline-size",
      ]);
      const checkJsPropFloor = (propKey, rawVal, valOffset) => {
        const lowerKey = String(propKey || "").toLowerCase();
        if (lowerKey === "transition" || lowerKey === "transitionproperty" || lowerKey === "transition-property") {
          const stripped = stripCssParens(rawVal);
          if (/(?<![a-zA-Z0-9_$-])all(?![a-zA-Z0-9_-])/i.test(stripped)) {
            findings.push({
              file: filePath,
              line: offsetToLine(cleanComments, valOffset),
              ruleId: "dsaf/no-transition-all",
              tier: "floor",
              severity: "error",
              message: `Disallowed inline style \`transition: ${rawVal.trim()}\`; transition explicit composited properties instead.`,
            });
          }
          const lHit = /(?<![a-zA-Z0-9_$-])(width|height|top|left)(?![a-zA-Z0-9_-])/i.exec(stripped);
          if (lHit) {
            findings.push({
              file: filePath,
              line: offsetToLine(cleanComments, valOffset),
              ruleId: "dsaf/no-layout-transition",
              tier: "floor",
              severity: "error",
              message: `Disallowed layout transition on \`${lHit[1]}\`; animate \`transform\` or \`opacity\`.`,
            });
          }
        } else if (VW_WIDTH_KEYS.has(lowerKey)) {
          const cleanVwVal = rawVal.replace(/--[a-zA-Z0-9_-]+/g, " ");
          if (/(?:^|[\s,(*/+-])100vw(?=$|[\s,)*/+-]|!\s*important)/i.test(cleanVwVal)) {
            findings.push({
              file: filePath,
              line: offsetToLine(cleanComments, valOffset),
              ruleId: "dsaf/no-100vw",
              tier: "floor",
              severity: "error",
              message: "Disallowed `100vw` width; use `100%` with `overflow-x: clip` to prevent scrollbar overflow.",
            });
          }
        } else {
          const cssProp = normalizeOutlineCssProp(lowerKey);
          if (cssProp) {
            const info = classifyOutlineDecl(cssProp, rawVal);
            if (info.state === "invisible") {
              findings.push({
                file: filePath,
                line: offsetToLine(cleanComments, valOffset),
                ruleId: "dsaf/no-outline-none-naked",
                tier: "floor",
                severity: "error",
                message: `Bare \`${cssProp}: ${rawVal.trim()}\` in inline style without visible \`:focus-visible\` replacement.`,
              });
            }
          }
        }
      };
      const FOCUS_COND_RE = /(?:focus|keyboard|showring|ringvisible)/i;
      const classifyFocusCondition = (rawExpr, depth = 0) => {
        if (depth > 16) return "none";
        let cur = String(rawExpr || "").trim();
        while (cur.length > 0) {
          const cutEnd = stripTrailingTsCastEnd(cur, 0, cur.length);
          const next = stripOuterBalancedParens(cur.slice(0, cutEnd));
          if (next === cur) break;
          cur = next;
        }
        if (!cur) return "none";
        const orParts = splitTopLevelLogical(cur, "||");
        if (orParts.length > 1) {
          const kinds = orParts.map((part) => classifyFocusCondition(part, depth + 1));
          if (kinds.includes("positive") && !kinds.includes("negative")) return "positive";
          if (kinds.every((k) => k === "negative")) return "negative";
          return "none";
        }
        const andParts = splitTopLevelLogical(cur, "&&");
        if (andParts.length > 1) {
          const kinds = andParts.map((part) => classifyFocusCondition(part, depth + 1));
          if (kinds.includes("positive") && !kinds.includes("negative")) return "positive";
          if (kinds.includes("negative") && !kinds.includes("positive")) return "negative";
          return "none";
        }
        const eqInfo = findTopLevelBoolEq(cur);
        if (eqInfo) {
          const innerKind = classifyFocusCondition(eqInfo.side, depth + 1);
          if (innerKind === "none") return "none";
          return eqInfo.neg ? (innerKind === "positive" ? "negative" : "positive") : innerKind;
        }
        if (cur.startsWith("!") && !cur.startsWith("!=") && !hasTopLevelBinaryOp(cur.slice(1))) {
          const innerKind = classifyFocusCondition(cur.slice(1), depth + 1);
          if (innerKind === "positive") return "negative";
          if (innerKind === "negative") return "positive";
          return "none";
        }
        return FOCUS_COND_RE.test(cur) ? "positive" : "none";
      };
      const extractJsStyleExprValues = (exprStr, exprOffset, outlineCssProp = null, opts = {}) => {
        const out = [];
        let condHasVisibleOutline = false;
        let hasConditionalFalsy = false;
        const isOutlineProp = Boolean(outlineCssProp);
        const forCssBody = Boolean(opts.forCssBody);
        const findBalLocal = (str, openIdx, openCh, closeCh, limit) => {
          let d = 1;
          let q = null;
          let lastSig = openCh;
          const parenStack = [];
          for (let k = openIdx + 1; k < limit; k++) {
            const c = str[k];
            if (q) {
              if (c === "\\" && k + 1 < limit) { k++; continue; }
              if (q === "`" && c === "$" && k + 1 < limit && str[k + 1] === "{") {
                const se = findBalLocal(str, k + 1, "{", "}", limit);
                if (se === -1) return -1;
                k = se;
                lastSig = "}";
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) {
                q = null;
                lastSig = c;
              }
              continue;
            }
            const reEnd = skipJsRegexInExpr(str, k, lastSig, openIdx + 1);
            if (reEnd !== -1 && reEnd <= limit) {
              k = reEnd - 1;
              lastSig = "/";
              continue;
            }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === openCh) d++;
            else if (c === closeCh) { d--; if (d === 0) return k; }
            if (!q) {
              if (c === "(") {
                parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(openIdx + 1, k - 16), k)));
                lastSig = "(";
              } else if (c === ")") {
                lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            }
          }
          return -1;
        };
        const trimExpr = (l, r) => {
          while (true) {
            while (l < r && /\s/.test(exprStr[l])) l++;
            while (r > l && /\s/.test(exprStr[r - 1])) r--;
            const nextR = stripTrailingTsCastEnd(exprStr, l, r);
            if (nextR !== r) {
              r = nextR;
              continue;
            }
            if (l < r && exprStr[l] === "(" && findBalLocal(exprStr, l, "(", ")", r) === r - 1) {
              l++;
              r--;
              continue;
            }
            break;
          }
          return [l, r];
        };
        const hasTopComp = (bs, be) => {
          let p = 0, b = 0, br = 0, q = null, lastSig = "";
          const parenStack = [];
          for (let k = bs; k < be; k++) {
            const c = exprStr[k];
            if (q) {
              if (c === "\\" && k + 1 < be) { k++; continue; }
              if (q === "`" && c === "$" && k + 1 < be && exprStr[k + 1] === "{") {
                const se = findBalLocal(exprStr, k + 1, "{", "}", be);
                if (se === -1) break;
                k = se;
                lastSig = "}";
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
              continue;
            }
            const reEnd = skipJsRegexInExpr(exprStr, k, lastSig, bs);
            if (reEnd !== -1 && reEnd <= be) { k = reEnd - 1; lastSig = "/"; continue; }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(exprStr.slice(Math.max(bs, k - 16), k)));
              lastSig = "(";
              p++;
            } else if (c === ")") {
              lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
              p = Math.max(0, p - 1);
            } else if (c === "[") { b++; lastSig = c; }
            else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
            else if (c === "{") { br++; lastSig = c; }
            else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
            else if (p === 0 && b === 0 && br === 0) {
              if ((c === "=" && exprStr[k + 1] === "=") || (c === "!" && exprStr[k + 1] === "=")) return true;
              if ((c === "<" || c === ">") && !(c === ">" && k > bs && exprStr[k - 1] === "=")) return true;
              if (c === "i" && /^instanceof\b/.test(exprStr.slice(k, Math.min(be, k + 12))) && (k === bs || !/[A-Za-z0-9_$]/.test(exprStr[k - 1]))) return true;
              if (!/\s/.test(c)) lastSig = c;
            } else if (!/\s/.test(c)) {
              lastSig = c;
            }
          }
          return false;
        };
        const hasTopAnd = (bs, be) => {
          let p = 0, b = 0, br = 0, q = null, lastSig = "";
          const parenStack = [];
          for (let k = bs; k < be; k++) {
            const c = exprStr[k];
            if (q) {
              if (c === "\\" && k + 1 < be) { k++; continue; }
              if (q === "`" && c === "$" && k + 1 < be && exprStr[k + 1] === "{") {
                const se = findBalLocal(exprStr, k + 1, "{", "}", be);
                if (se === -1) break;
                k = se;
                lastSig = "}";
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
              continue;
            }
            const reEnd = skipJsRegexInExpr(exprStr, k, lastSig, bs);
            if (reEnd !== -1 && reEnd <= be) { k = reEnd - 1; lastSig = "/"; continue; }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(exprStr.slice(Math.max(bs, k - 16), k)));
              lastSig = "(";
              p++;
            } else if (c === ")") {
              lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
              p = Math.max(0, p - 1);
            } else if (c === "[") { b++; lastSig = c; }
            else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
            else if (c === "{") { br++; lastSig = c; }
            else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
            else if (p === 0 && b === 0 && br === 0 && c === "&" && exprStr[k + 1] === "&") return true;
            else if (!/\s/.test(c)) lastSig = c;
          }
          return false;
        };
        const mergeFocusBranch = (b1, b2) =>
          b1 === "unfocused" || b2 === "unfocused" ? "unfocused" : b1 === "focused" || b2 === "focused" ? "focused" : "none";
        const visitExpr = (start, end, underCond, focusBranch = "none") => {
          const [l, r] = trimExpr(start, end);
          if (l >= r) return;
          let qPos = -1;
          let colonPos = -1;
          let tDepth = 0;
          {
            let p = 0, b = 0, br = 0, q = null, lastSig = "";
            const parenStack = [];
            for (let k = l; k < r; k++) {
              const c = exprStr[k];
              if (q) {
                if (c === "\\" && k + 1 < r) { k++; continue; }
                if (q === "`" && c === "$" && k + 1 < r && exprStr[k + 1] === "{") {
                  const se = findBalLocal(exprStr, k + 1, "{", "}", r);
                  if (se === -1) break;
                  k = se;
                  lastSig = "}";
                  continue;
                }
                if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
                continue;
              }
              const reEnd = skipJsRegexInExpr(exprStr, k, lastSig, l);
              if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
              if (c === '"' || c === "'" || c === "`") q = c;
              else if (c === "(") {
                parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(exprStr.slice(Math.max(l, k - 16), k)));
                lastSig = "(";
                p++;
              } else if (c === ")") {
                lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
                p = Math.max(0, p - 1);
              } else if (c === "[") { b++; lastSig = c; }
              else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
              else if (c === "{") { br++; lastSig = c; }
              else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
              else if (p === 0 && b === 0 && br === 0) {
                if (c === "?" && exprStr[k + 1] !== "?" && exprStr[k + 1] !== ".") {
                  if (qPos === -1) qPos = k;
                  tDepth++;
                  lastSig = c;
                } else if (c === ":" && tDepth > 0) {
                  tDepth--;
                  if (tDepth === 0) { colonPos = k; break; }
                  lastSig = c;
                } else if (!/\s/.test(c)) {
                  lastSig = c;
                }
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            }
          }
          if (qPos !== -1 && colonPos !== -1) {
            const focusKind = classifyFocusCondition(exprStr.slice(l, qPos));
            const isFocusTest = focusKind !== "none";
            const isNegatedFocus = focusKind === "negative";
            const trueBranch = isFocusTest ? (isNegatedFocus ? "unfocused" : "focused") : focusBranch;
            const falseBranch = isFocusTest ? (isNegatedFocus ? "focused" : "unfocused") : focusBranch;
            const beforeLen = out.length;
            visitExpr(qPos + 1, colonPos, true, trueBranch);
            visitExpr(colonPos + 1, r, true, falseBranch);
            if (isOutlineProp && (trueBranch === "focused" || falseBranch === "focused")) {
              const added = out.slice(beforeLen);
              if (added.some((v) => v.focusBranch === "focused" && classifyOutlineDecl(outlineCssProp, v.val).state === "visible")) {
                condHasVisibleOutline = true;
              }
            }
            return;
          }
          const orOps = [];
          const andOps = [];
          {
            let p = 0, b = 0, br = 0, q = null, lastSig = "";
            const parenStack = [];
            for (let k = l; k < r; k++) {
              const c = exprStr[k];
              if (q) {
                if (c === "\\" && k + 1 < r) { k++; continue; }
                if (q === "`" && c === "$" && k + 1 < r && exprStr[k + 1] === "{") {
                  const se = findBalLocal(exprStr, k + 1, "{", "}", r);
                  if (se === -1) break;
                  k = se;
                  lastSig = "}";
                  continue;
                }
                if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
                continue;
              }
              const reEnd = skipJsRegexInExpr(exprStr, k, lastSig, l);
              if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
              if (c === '"' || c === "'" || c === "`") q = c;
              else if (c === "(") {
                parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(exprStr.slice(Math.max(l, k - 16), k)));
                lastSig = "(";
                p++;
              } else if (c === ")") {
                lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
                p = Math.max(0, p - 1);
              } else if (c === "[") { b++; lastSig = c; }
              else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
              else if (c === "{") { br++; lastSig = c; }
              else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
              else if (p === 0 && b === 0 && br === 0) {
                if ((c === "|" && exprStr[k + 1] === "|") || (c === "?" && exprStr[k + 1] === "?")) {
                  orOps.push([k, k + 2]);
                  lastSig = c;
                  k++;
                } else if (c === "&" && exprStr[k + 1] === "&") {
                  andOps.push([k, k + 2]);
                  lastSig = c;
                  k++;
                } else if (!/\s/.test(c)) {
                  lastSig = c;
                }
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            }
          }
          if (orOps.length > 0) {
            let cur = l;
            for (const [os, oe] of orOps) {
              if (!hasTopComp(cur, os) || hasTopAnd(cur, os)) visitExpr(cur, os, true, focusBranch);
              cur = oe;
            }
            if (!hasTopComp(cur, r) || hasTopAnd(cur, r)) visitExpr(cur, r, true, focusBranch);
            return;
          }
          if (andOps.length > 0) {
            hasConditionalFalsy = true;
            visitExpr(andOps[andOps.length - 1][1], r, true, focusBranch);
            return;
          }
          const plusParts = [];
          {
            let p = 0, b = 0, br = 0, q = null, partStart = l, lastSig = "";
            const parenStack = [];
            for (let k = l; k < r; k++) {
              const c = exprStr[k];
              if (q) {
                if (c === "\\" && k + 1 < r) { k++; continue; }
                if (q === "`" && c === "$" && k + 1 < r && exprStr[k + 1] === "{") {
                  const se = findBalLocal(exprStr, k + 1, "{", "}", r);
                  if (se === -1) break;
                  k = se;
                  lastSig = "}";
                  continue;
                }
                if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
                continue;
              }
              const reEnd = skipJsRegexInExpr(exprStr, k, lastSig, l);
              if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
              if (c === '"' || c === "'" || c === "`") q = c;
              else if (c === "(") {
                parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(exprStr.slice(Math.max(l, k - 16), k)));
                lastSig = "(";
                p++;
              } else if (c === ")") {
                lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
                p = Math.max(0, p - 1);
              } else if (c === "[") { b++; lastSig = c; }
              else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
              else if (c === "{") { br++; lastSig = c; }
              else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
              else if (p === 0 && b === 0 && br === 0 && c === "+" && exprStr[k + 1] !== "+" && exprStr[k - 1] !== "+") {
                plusParts.push([partStart, k]);
                partStart = k + 1;
                lastSig = c;
              } else if (!/\s/.test(c)) {
                lastSig = c;
              }
            }
            if (plusParts.length > 0) plusParts.push([partStart, r]);
          }
          if (plusParts.length > 1) {
            let combos = [{ val: "", offset: exprOffset + l, itemCond: underCond, focusBranch, hasLit: false }];
            for (const [ps, pe] of plusParts) {
              const sub = extractJsStyleExprValues(exprStr.slice(ps, pe), exprOffset + ps, null, { forCssBody: true });
              const rawPart = exprStr.slice(ps, pe).trim();
              if (sub.values.length === 0) {
                if (sub.hasConditionalFalsy || /^(?:null|undefined|false)$/i.test(rawPart)) continue;
              }
              const alts = [];
              const seenV = new Set();
              if (sub.values.length > 0) {
                for (const sv of sub.values) {
                  if (!seenV.has(sv.val)) {
                    seenV.add(sv.val);
                    alts.push({
                      text: sv.val,
                      offset: sv.offset,
                      underCond: Boolean(sv.underCond),
                      focusBranch: sv.focusBranch || "none",
                      hasLit: true,
                    });
                    if (alts.length >= 8) break;
                  }
                }
              } else {
                alts.push({ text: "var(--_)", offset: exprOffset + ps, underCond: false, focusBranch: "none", hasLit: false });
              }
              const nextCombos = [];
              for (const cb of combos) {
                for (const alt of alts) {
                  nextCombos.push({
                    val: cb.val + alt.text,
                    offset: alts.length > 1 || !cb.hasLit ? alt.offset : cb.offset,
                    itemCond: cb.itemCond || alt.underCond,
                    focusBranch: mergeFocusBranch(cb.focusBranch, alt.focusBranch),
                    hasLit: cb.hasLit || alt.hasLit,
                  });
                  if (nextCombos.length >= 24) break;
                }
                if (nextCombos.length >= 24) break;
              }
              combos = nextCombos;
            }
            for (const cb of combos) {
              if (!cb.hasLit) continue;
              if (cb.itemCond && !cb.val.trim()) hasConditionalFalsy = true;
              if (isOutlineProp && cb.focusBranch === "focused" && classifyOutlineDecl(outlineCssProp, cb.val).state === "visible") {
                condHasVisibleOutline = true;
              }
              out.push({ val: cb.val, offset: cb.offset, underCond: cb.itemCond, focusBranch: cb.focusBranch });
            }
            return;
          }
          const firstC = exprStr[l];
          if (firstC === '"' || firstC === "'") {
            let k = l + 1;
            while (k < r) {
              if (exprStr[k] === "\\" && k + 1 < r) { k += 2; continue; }
              if (exprStr[k] === firstC) break;
              k++;
            }
            if (k === r - 1) {
              const sVal = exprStr.slice(l + 1, k);
              if (underCond && !sVal.trim()) hasConditionalFalsy = true;
              out.push({ val: sVal, offset: exprOffset + l + 1, underCond, focusBranch });
            }
            return;
          }
          if (firstC === "`") {
            let k = l + 1;
            let staticBuf = "";
            let closedOk = false;
            const pieces = [];
            while (k < r) {
              const c = exprStr[k];
              if (c === "\\" && k + 1 < r) { staticBuf += c + exprStr[k + 1]; k += 2; continue; }
              if (c === "$" && exprStr[k + 1] === "{") {
                const se = findBalLocal(exprStr, k + 1, "{", "}", r);
                if (se === -1) return;
                if (staticBuf) {
                  pieces.push({ kind: "str", text: staticBuf });
                  staticBuf = "";
                }
                pieces.push({ kind: "slot", inner: exprStr.slice(k + 2, se), offset: exprOffset + k + 2 });
                k = se + 1;
                continue;
              }
              if (c === "`") {
                if (k === r - 1) closedOk = true;
                break;
              }
              staticBuf += c;
              k++;
            }
            if (!closedOk) return;
            if (staticBuf || pieces.length === 0) pieces.push({ kind: "str", text: staticBuf });
            let combos = [{ val: "", offset: exprOffset + l + 1, itemCond: underCond, focusBranch }];
            for (const pc of pieces) {
              if (pc.kind === "str") {
                for (const cb of combos) cb.val += pc.text;
                continue;
              }
              const sub = extractJsStyleExprValues(pc.inner, pc.offset, null, { forCssBody: true });
              let alts = [];
              if (sub.values.length > 0) {
                const seenV = new Set();
                for (const sv of sub.values) {
                  if (!seenV.has(sv.val)) {
                    seenV.add(sv.val);
                    alts.push({
                      text: sv.val,
                      offset: sv.offset,
                      underCond: Boolean(sv.underCond),
                      focusBranch: sv.focusBranch || "none",
                    });
                    if (alts.length >= 8) break;
                  }
                }
              } else {
                alts = [{ text: "var(--_)", offset: pc.offset, underCond: false, focusBranch: "none" }];
              }
              const nextCombos = [];
              for (const cb of combos) {
                for (const alt of alts) {
                  nextCombos.push({
                    val: cb.val + alt.text,
                    offset: alts.length > 1 || cb.offset === exprOffset + l + 1 ? alt.offset : cb.offset,
                    itemCond: cb.itemCond || alt.underCond,
                    focusBranch: mergeFocusBranch(cb.focusBranch, alt.focusBranch),
                  });
                  if (nextCombos.length >= 24) break;
                }
                if (nextCombos.length >= 24) break;
              }
              combos = nextCombos;
            }
            for (const cb of combos) {
              if (cb.itemCond && !cb.val.trim()) hasConditionalFalsy = true;
              if (isOutlineProp && cb.focusBranch === "focused" && classifyOutlineDecl(outlineCssProp, cb.val).state === "visible") {
                condHasVisibleOutline = true;
              }
              out.push({ val: cb.val, offset: cb.offset, underCond: cb.itemCond, focusBranch: cb.focusBranch });
            }
            return;
          }
          const bare = exprStr.slice(l, r).trim();
          if (/^(?:0(?:\.0+)?|\.0+)$/.test(bare)) {
            out.push({ val: bare, offset: exprOffset + l, underCond, focusBranch });
          } else if (forCssBody && /^\d+(?:\.\d+)?$/.test(bare) && Number(bare) > 0) {
            out.push({ val: `${bare}px`, offset: exprOffset + l, underCond, focusBranch });
          } else if (forCssBody && /^(?:null|undefined|false)$/i.test(bare)) {
            if (underCond) hasConditionalFalsy = true;
          } else if (forCssBody && bare && !hasTopComp(l, r)) {
            out.push({ val: "var(--_)", offset: exprOffset + l, underCond, focusBranch });
          } else if (isOutlineProp && underCond && focusBranch === "focused" && /^[A-Za-z_$][\w$.]*$/.test(bare) && !/^(?:undefined|null|false|true|NaN)$/.test(bare)) {
            condHasVisibleOutline = true;
          }
        };
        visitExpr(0, exprStr.length, false, "none");
        return { values: out, condHasVisibleOutline, hasConditionalFalsy };
      };
      const checkJsPropWithExpr = (propKey, rhsStr, valOffset, allowCondOutline = true, forceSkipInvisible = false) => {
        const outlineCssProp = normalizeOutlineCssProp(propKey);
        const { values, condHasVisibleOutline } = extractJsStyleExprValues(rhsStr, valOffset, outlineCssProp);
        for (const item of values) {
          if (outlineCssProp && (forceSkipInvisible || (allowCondOutline && item.focusBranch === "unfocused" && condHasVisibleOutline))) {
            const info = classifyOutlineDecl(outlineCssProp, item.val);
            if (info.state === "invisible") continue;
          }
          checkJsPropFloor(propKey, item.val, item.offset);
        }
      };
      const tryParseFocusSpreadTernary = (spStart, spEnd) => {
        const trimSpan = (a, b) => {
          let l = a, r = b;
          while (true) {
            while (l < r && /\s/.test(nonStyleClean[l])) l++;
            while (r > l && /\s/.test(nonStyleClean[r - 1])) r--;
            const nextR = stripTrailingTsCastEnd(nonStyleClean, l, r);
            if (nextR !== r) {
              r = nextR;
              continue;
            }
            if (l < r && nonStyleClean[l] === "(" && findBal(nonStyleClean, l, "(", ")") === r - 1) {
              l++;
              r--;
              continue;
            }
            break;
          }
          return [l, r];
        };
        const [sl, sr] = trimSpan(spStart, spEnd);
        if (sl >= sr) return null;
        let qPos = -1, colonPos = -1, tDepth = 0;
        let p = 0, b = 0, br = 0, q = null, lastSig = "";
        const parenStack = [];
        for (let k = sl; k < sr; k++) {
          const c = nonStyleClean[k];
          if (q) {
            if (c === "\\" && k + 1 < sr) { k++; continue; }
            if (q === "`" && c === "$" && k + 1 < sr && nonStyleClean[k + 1] === "{") {
              const se = findBal(nonStyleClean, k + 1, "{", "}");
              if (se === -1 || se >= sr) break;
              k = se;
              lastSig = "}";
              continue;
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
            continue;
          }
          const reEnd = skipJsRegexInExpr(nonStyleClean, k, lastSig, sl);
          if (reEnd !== -1 && reEnd <= sr) { k = reEnd - 1; lastSig = "/"; continue; }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "(") {
            parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(sl, k - 16), k)));
            lastSig = "(";
            p++;
          } else if (c === ")") {
            lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
            p = Math.max(0, p - 1);
          } else if (c === "[") { b++; lastSig = c; }
          else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
          else if (c === "{") { br++; lastSig = c; }
          else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
          else if (p === 0 && b === 0 && br === 0) {
            if (c === "?" && nonStyleClean[k + 1] !== "?" && nonStyleClean[k + 1] !== ".") {
              if (qPos === -1) qPos = k;
              tDepth++;
              lastSig = c;
            } else if (c === ":" && tDepth > 0) {
              tDepth--;
              if (tDepth === 0) { colonPos = k; break; }
              lastSig = c;
            } else if (!/\s/.test(c)) lastSig = c;
          } else if (!/\s/.test(c)) lastSig = c;
        }
        if (qPos === -1 || colonPos === -1) return null;
        const focusKind = classifyFocusCondition(nonStyleClean.slice(sl, qPos));
        if (focusKind === "none") return null;
        const isNeg = focusKind === "negative";
        const [fS, fE] = isNeg ? trimSpan(colonPos + 1, sr) : trimSpan(qPos + 1, colonPos);
        const [uS, uE] = isNeg ? trimSpan(qPos + 1, colonPos) : trimSpan(colonPos + 1, sr);
        const extractArmObj = (aS, aE) => {
          const [el, er] = trimSpan(aS, aE);
          if (el < er && nonStyleClean[el] === "{" && findBal(nonStyleClean, el, "{", "}") === er - 1) {
            return parseJsObjectEntries(el + 1, er - 1);
          }
          return [];
        };
        const fEnts = extractArmObj(fS, fE);
        const uEnts = extractArmObj(uS, uE);
        let focusedHasVisibleOutline = false;
        let focusedHasNonOutlineVisible = false;
        for (const ent of fEnts) {
          const outCss = normalizeOutlineCssProp(ent.key);
          if (outCss) {
            if (
              extractJsStyleExprValues(ent.rhs, ent.rhsStart, outCss).values.some(
                (v) => classifyOutlineDecl(outCss, v.val).state === "visible"
              )
            ) {
              focusedHasVisibleOutline = true;
            }
          } else {
            const kebab = ent.key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
            if (kebab === "box-shadow" || kebab.startsWith("border")) {
              if (
                extractJsStyleExprValues(ent.rhs, ent.rhsStart, null).values.some((v) =>
                  hasVisibleFocusIndicator(`${kebab}: ${v.val};`, "", { treatAsFocusSelector: true })
                )
              ) {
                focusedHasNonOutlineVisible = true;
              }
            }
          }
        }
        const focusedHasVisible = focusedHasVisibleOutline || focusedHasNonOutlineVisible;
        return [
          ...fEnts.map((fe) =>
            focusedHasNonOutlineVisible && normalizeOutlineCssProp(fe.key) ? { ...fe, skipInvisibleOutline: true } : fe
          ),
          ...uEnts.map((ue) =>
            focusedHasVisible && normalizeOutlineCssProp(ue.key) ? { ...ue, skipInvisibleOutline: true } : ue
          ),
        ];
      };
      const parseJsObjectEntries = (spanStart, spanEnd) => {
        const entries = [];
        const len = spanEnd;
        let cur = spanStart;
        while (cur < len) {
          while (cur < len && /[\s,]/.test(nonStyleClean[cur])) cur++;
          if (cur >= len) break;
          if (nonStyleClean[cur] === "." && nonStyleClean.startsWith("...", cur)) {
            const spreadStart = cur + 3;
            const nestedObjs = [];
            let lastSigSp = "";
            let pDepthSp = 0;
            let bDepthSp = 0;
            const spParenStack = [];
            let endedWithComma = false;
            while (cur < len) {
              const c = nonStyleClean[cur];
              const reEnd = skipJsRegexInExpr(nonStyleClean, cur, lastSigSp, spanStart);
              if (reEnd !== -1 && reEnd <= len) { lastSigSp = "/"; cur = reEnd; continue; }
              if (c === '"' || c === "'" || c === "`") {
                const q = c; cur++;
                while (cur < len) {
                  if (nonStyleClean[cur] === "\\" && cur + 1 < len) { cur += 2; continue; }
                  if (q === "`" && nonStyleClean[cur] === "$" && cur + 1 < len && nonStyleClean[cur + 1] === "{") {
                    const se = findBal(nonStyleClean, cur + 1, "{", "}");
                    if (se !== -1) { cur = se + 1; continue; }
                  }
                  if (nonStyleClean[cur] === q || (q !== "`" && nonStyleClean[cur] === "\n")) break;
                  cur++;
                }
                lastSigSp = q;
              } else if (c === "{") {
                const b = findBal(nonStyleClean, cur, "{", "}");
                if (b !== -1) {
                  const isBlockOrFnBody =
                    lastSigSp === "=>" ||
                    lastSigSp === ")" ||
                    lastSigSp === "control)" ||
                    /(?:^|[^\w$])(?:else|try|finally|do)\s*$/.test(nonStyleClean.slice(Math.max(spanStart, cur - 16), cur));
                  if (!isBlockOrFnBody) {
                    nestedObjs.push([cur + 1, b]);
                  }
                  cur = b;
                }
                lastSigSp = "}";
              } else if (c === "(") {
                spParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(spanStart, cur - 16), cur)));
                pDepthSp++;
                lastSigSp = "(";
              } else if (c === ")") {
                lastSigSp = spParenStack.length > 0 && spParenStack.pop() ? "control)" : ")";
                pDepthSp = Math.max(0, pDepthSp - 1);
              } else if (c === "[") {
                bDepthSp++;
                lastSigSp = "[";
              } else if (c === "]") {
                bDepthSp = Math.max(0, bDepthSp - 1);
                lastSigSp = "]";
              } else if (c === "," && pDepthSp === 0 && bDepthSp === 0) {
                endedWithComma = true;
                break;
              } else if (c === "=" && nonStyleClean[cur + 1] === ">") {
                lastSigSp = "=>";
                cur++;
              } else if (!/\s/.test(c)) {
                lastSigSp = c;
              }
              cur++;
            }
            const spreadEnd = cur;
            if (endedWithComma) cur++;
            for (const subEnt of collectStyleSpanEntries(spreadStart, spreadEnd, false)) {
              entries.push(subEnt);
            }
            continue;
          }
          let rawKey = "";
          if (nonStyleClean[cur] === '"' || nonStyleClean[cur] === "'") {
            const q = nonStyleClean[cur];
            const kStart = cur + 1;
            cur++;
            while (cur < len) {
              if (nonStyleClean[cur] === "\\" && cur + 1 < len) { cur += 2; continue; }
              if (nonStyleClean[cur] === q) break;
              cur++;
            }
            rawKey = nonStyleClean.slice(kStart, cur);
            if (cur < len && nonStyleClean[cur] === q) cur++;
          } else if (nonStyleClean[cur] === "[") {
            const kEnd = findBal(nonStyleClean, cur, "[", "]");
            if (kEnd === -1 || kEnd >= len) break;
            rawKey = nonStyleClean.slice(cur, kEnd + 1);
            cur = kEnd + 1;
          } else {
            const kStart = cur;
            while (cur < len && /[A-Za-z0-9_$-]/.test(nonStyleClean[cur])) cur++;
            rawKey = nonStyleClean.slice(kStart, cur);
          }
          while (cur < len && /\s/.test(nonStyleClean[cur])) cur++;
          if (cur >= len || nonStyleClean[cur] !== ":") {
            let lastSigSk = "";
            const skParenStack = [];
            while (cur < len) {
              const c = nonStyleClean[cur];
              const reEnd = skipJsRegexInExpr(nonStyleClean, cur, lastSigSk, spanStart);
              if (reEnd !== -1 && reEnd <= len) { lastSigSk = "/"; cur = reEnd; continue; }
              if (c === '"' || c === "'" || c === "`") {
                let q = c; cur++;
                while (cur < len) {
                  if (nonStyleClean[cur] === "\\" && cur + 1 < len) { cur += 2; continue; }
                  if (nonStyleClean[cur] === q || (q !== "`" && nonStyleClean[cur] === "\n")) break;
                  cur++;
                }
                lastSigSk = q;
              } else if (c === "{") { const b = findBal(nonStyleClean, cur, "{", "}"); if (b !== -1) cur = b; lastSigSk = "}"; }
              else if (c === "(") {
                skParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(spanStart, cur - 16), cur)));
                const p = findBal(nonStyleClean, cur, "(", ")"); if (p !== -1) cur = p;
                lastSigSk = skParenStack.pop() ? "control)" : ")";
              } else if (c === "[") { const a = findBal(nonStyleClean, cur, "[", "]"); if (a !== -1) cur = a; lastSigSk = "]"; }
              else if (c === ",") { cur++; break; }
              else if (!/\s/.test(c)) { lastSigSk = c; }
              cur++;
            }
            continue;
          }
          cur++;
          while (cur < len && /\s/.test(nonStyleClean[cur])) cur++;
          const rhsStart = cur;
          let pD = 0, bD = 0, kD = 0, q = null, lastSigRhs = ":";
          const rhsParenStack = [];
          while (cur < len) {
            const c = nonStyleClean[cur];
            if (q) {
              if (c === "\\" && cur + 1 < len) { cur += 2; continue; }
              if (q === "`" && c === "$" && cur + 1 < len && nonStyleClean[cur + 1] === "{") {
                const se = findBal(nonStyleClean, cur + 1, "{", "}");
                if (se === -1 || se >= len) break;
                lastSigRhs = "}";
                cur = se + 1;
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSigRhs = c; }
              cur++;
              continue;
            }
            const reEnd = skipJsRegexInExpr(nonStyleClean, cur, lastSigRhs, rhsStart);
            if (reEnd !== -1 && reEnd <= len) {
              lastSigRhs = "/";
              cur = reEnd;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") { q = c; cur++; continue; }
            if (c === "(") {
              rhsParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(rhsStart, cur - 16), cur)));
              lastSigRhs = "(";
              pD++;
            } else if (c === ")") {
              if (pD === 0) break;
              lastSigRhs = rhsParenStack.length > 0 && rhsParenStack.pop() ? "control)" : ")";
              pD--;
            } else if (c === "[") { bD++; lastSigRhs = c; }
            else if (c === "]") { if (bD === 0) break; bD--; lastSigRhs = c; }
            else if (c === "{") { kD++; lastSigRhs = c; }
            else if (c === "}") { if (kD === 0) break; kD--; lastSigRhs = c; }
            else if (c === "," && pD === 0 && bD === 0 && kD === 0) break;
            else if (!/\s/.test(c)) lastSigRhs = c;
            cur++;
          }
          entries.push({ key: rawKey, rhsStart, rhsEnd: cur, rhs: nonStyleClean.slice(rhsStart, cur).trim() });
          if (cur < len && nonStyleClean[cur] === ",") cur++;
        }
        return entries;
      };
      const collectStyleSpanEntries = (spanStart, spanEnd, allowBareSpanFallback = true) => {
        let l = spanStart;
        let r = spanEnd;
        while (true) {
          while (l < r && /\s/.test(nonStyleClean[l])) l++;
          while (r > l && /\s/.test(nonStyleClean[r - 1])) r--;
          const nextR = stripTrailingTsCastEnd(nonStyleClean, l, r);
          if (nextR !== r) {
            r = nextR;
            continue;
          }
          if (l < r && nonStyleClean[l] === "(" && findBal(nonStyleClean, l, "(", ")") === r - 1) {
            l++;
            r--;
            continue;
          }
          break;
        }
        if (l >= r) return [];
        if (nonStyleClean[l] === "{" && findBal(nonStyleClean, l, "{", "}") === r - 1) {
          return parseJsObjectEntries(l + 1, r - 1);
        }
        if (nonStyleClean[l] === "[" && findBal(nonStyleClean, l, "[", "]") === r - 1) {
          const outEnts = [];
          let elemStart = l + 1;
          let k = l + 1;
          let q = null, p = 0, b = 0, br = 0, lastSigArr = "";
          const arrPStack = [];
          while (k < r - 1) {
            const c = nonStyleClean[k];
            if (q) {
              if (c === "\\" && k + 1 < r - 1) { k += 2; continue; }
              if (q === "`" && c === "$" && k + 1 < r - 1 && nonStyleClean[k + 1] === "{") {
                const se = findBal(nonStyleClean, k + 1, "{", "}");
                if (se !== -1 && se < r - 1) { lastSigArr = "}"; k = se + 1; continue; }
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSigArr = c; }
              k++;
              continue;
            }
            const reEnd = skipJsRegexInExpr(nonStyleClean, k, lastSigArr, elemStart);
            if (reEnd !== -1 && reEnd <= r - 1) { lastSigArr = "/"; k = reEnd; continue; }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              arrPStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(l + 1, k - 16), k)));
              p++;
              lastSigArr = "(";
            } else if (c === ")") {
              p = Math.max(0, p - 1);
              lastSigArr = arrPStack.length > 0 && arrPStack.pop() ? "control)" : ")";
            } else if (c === "[") { b++; lastSigArr = c; }
            else if (c === "]") { b = Math.max(0, b - 1); lastSigArr = c; }
            else if (c === "{") { br++; lastSigArr = c; }
            else if (c === "}") { br = Math.max(0, br - 1); lastSigArr = c; }
            else if (c === "," && p === 0 && b === 0 && br === 0) {
              outEnts.push(...collectStyleSpanEntries(elemStart, k, false));
              elemStart = k + 1;
              lastSigArr = "";
            } else if (!/\s/.test(c)) {
              lastSigArr = c;
            }
            k++;
          }
          outEnts.push(...collectStyleSpanEntries(elemStart, r - 1, false));
          return outEnts;
        }
        const directTernEnts = tryParseFocusSpreadTernary(l, r);
        if (directTernEnts) return directTernEnts;

        // Check top-level outer ternary or logical operators (&& / || / ??) before scanning object literals
        let qPos = -1, colonPos = -1, tDepth = 0;
        const logicSplits = [];
        {
          let p = 0, b = 0, br = 0, q = null, lastSigL = "";
          const lParenStack = [];
          for (let k = l; k < r; k++) {
            const c = nonStyleClean[k];
            if (q) {
              if (c === "\\" && k + 1 < r) { k++; continue; }
              if (q === "`" && c === "$" && k + 1 < r && nonStyleClean[k + 1] === "{") {
                const se = findBal(nonStyleClean, k + 1, "{", "}");
                if (se === -1 || se >= r) break;
                k = se;
                lastSigL = "}";
                continue;
              }
              if (c === q || (q !== "`" && c === "\n")) { q = null; lastSigL = c; }
              continue;
            }
            const reEnd = skipJsRegexInExpr(nonStyleClean, k, lastSigL, l);
            if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSigL = "/"; continue; }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(") {
              lParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(l, k - 16), k)));
              p++;
              lastSigL = "(";
            } else if (c === ")") {
              p = Math.max(0, p - 1);
              lastSigL = lParenStack.length > 0 && lParenStack.pop() ? "control)" : ")";
            } else if (c === "[") { b++; lastSigL = c; }
            else if (c === "]") { b = Math.max(0, b - 1); lastSigL = c; }
            else if (c === "{") { br++; lastSigL = c; }
            else if (c === "}") { br = Math.max(0, br - 1); lastSigL = c; }
            else if (p === 0 && b === 0 && br === 0) {
              if (c === "?" && nonStyleClean[k + 1] !== "?" && nonStyleClean[k + 1] !== ".") {
                if (qPos === -1) qPos = k;
                tDepth++;
                lastSigL = c;
              } else if (c === ":" && tDepth > 0) {
                tDepth--;
                if (tDepth === 0) { colonPos = k; break; }
                lastSigL = c;
              } else if (
                tDepth === 0 &&
                ((c === "&" && nonStyleClean[k + 1] === "&") ||
                  (c === "|" && nonStyleClean[k + 1] === "|") ||
                  (c === "?" && nonStyleClean[k + 1] === "?"))
              ) {
                logicSplits.push(k);
                lastSigL = c;
                k++;
              } else if (!/\s/.test(c)) lastSigL = c;
            } else if (!/\s/.test(c)) lastSigL = c;
          }
        }
        if (qPos !== -1 && colonPos !== -1) {
          return [
            ...collectStyleSpanEntries(qPos + 1, colonPos, false),
            ...collectStyleSpanEntries(colonPos + 1, r, false),
          ];
        }
        if (logicSplits.length > 0) {
          const outEnts = [];
          let segS = l;
          for (const opIdx of logicSplits) {
            outEnts.push(...collectStyleSpanEntries(segS, opIdx, false));
            segS = opIdx + 2;
          }
          outEnts.push(...collectStyleSpanEntries(segS, r, false));
          return outEnts;
        }

        const objRanges = [];
        let k = l;
        let q = null;
        let lastSigObj = "";
        const objSpParenStack = [];
        while (k < r) {
          const c = nonStyleClean[k];
          if (q) {
            if (c === "\\" && k + 1 < r) { k += 2; continue; }
            if (q === "`" && c === "$" && k + 1 < r && nonStyleClean[k + 1] === "{") {
              const se = findBal(nonStyleClean, k + 1, "{", "}");
              if (se !== -1 && se < r) { lastSigObj = "}"; k = se + 1; continue; }
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSigObj = c; }
            k++;
            continue;
          }
          const reEnd = skipJsRegexInExpr(nonStyleClean, k, lastSigObj, l);
          if (reEnd !== -1 && reEnd <= r) {
            lastSigObj = "/";
            k = reEnd;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "{") {
            const endB = findBal(nonStyleClean, k, "{", "}");
            if (endB !== -1 && endB < r) {
              const isBlockOrFnBody =
                lastSigObj === "=>" ||
                lastSigObj === ")" ||
                lastSigObj === "control)" ||
                /(?:^|[^\w$])(?:else|try|finally|do)\s*$/.test(nonStyleClean.slice(Math.max(l, k - 16), k));
              if (!isBlockOrFnBody) {
                objRanges.push([k + 1, endB]);
              }
              lastSigObj = "}";
              k = endB + 1;
              continue;
            }
            lastSigObj = "{";
          } else if (c === "(") {
            objSpParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(l, k - 16), k)));
            lastSigObj = "(";
          } else if (c === ")") {
            lastSigObj = objSpParenStack.length > 0 && objSpParenStack.pop() ? "control)" : ")";
          } else if (c === "=" && nonStyleClean[k + 1] === ">") {
            lastSigObj = "=>";
            k++;
          } else if (!/\s/.test(c)) {
            lastSigObj = c;
          }
          k++;
        }
        if (objRanges.length === 0 && allowBareSpanFallback) objRanges.push([l, r]);
        const outEnts = [];
        for (const [os, oe] of objRanges) {
          outEnts.push(...parseJsObjectEntries(os, oe));
        }
        return outEnts;
      };
      const scanJsStyleObjectSpan = (spanStart, spanEnd) => {
        for (const ent of collectStyleSpanEntries(spanStart, spanEnd, true)) {
          const lk = ent.key.toLowerCase();
          if (
            lk === "transition" || lk === "transitionproperty" || lk === "transition-property" ||
            VW_WIDTH_KEYS.has(lk) ||
            Boolean(normalizeOutlineCssProp(ent.key))
          ) {
            checkJsPropWithExpr(ent.key, nonStyleClean.slice(ent.rhsStart, ent.rhsEnd), ent.rhsStart, true, Boolean(ent.skipInvisibleOutline));
          }
        }
      };
      const scanCssInJsObjectSpan = (spanStart, spanEnd) => {
        const nodes = [];
        const collectObj = (sStart, sEnd, selectorPath, conds, inKeyframes) => {
          const entries = parseJsObjectEntries(sStart, sEnd);
          const decls = [];
          for (const ent of entries) {
            if (ent.rhs.startsWith("{") && ent.rhs.endsWith("}")) {
              const subOpen = nonStyleClean.indexOf("{", ent.rhsStart);
              const subClose = findBal(nonStyleClean, subOpen, "{", "}");
              if (subClose !== -1 && subClose <= ent.rhsEnd) {
                const rawSel = ent.key.trim();
                const isKf = inKeyframes || /^@(?:-webkit-|-moz-)?keyframes\b/i.test(rawSel);
                const isCond = /^@(?:media|supports|container|document|scope)\b/i.test(rawSel) && !/^@media\s+(?:all|screen)\s*$/i.test(rawSel);
                const nextConds = isCond ? [...conds, rawSel.replace(/\s+/g, " ").toLowerCase()] : conds;
                const nextSel = rawSel.startsWith("@") ? selectorPath : resolveNestedSelector(selectorPath || ".dsaf-styled-root", rawSel);
                collectObj(subOpen + 1, subClose, nextSel, nextConds, isKf);
              }
              continue;
            }
            decls.push(ent);
          }
          nodes.push({ selector: selectorPath || ".dsaf-styled-root", conds, inKeyframes, decls, startOffset: sStart });
        };
        collectObj(spanStart, spanEnd, ".dsaf-styled-root", [], false);
        const FOCUS_PROP_SET = new Set([
          "box-shadow",
          "border",
          "border-style",
          "border-width",
          "border-color",
          "outline",
          "outline-style",
          "outline-width",
          "outline-color",
        ]);
        const isVisFocusPropVal = (kebabProp, rawValStr) => {
          if (kebabProp.startsWith("outline")) return classifyOutlineDecl(kebabProp, rawValStr).state === "visible";
          if (kebabProp.startsWith("border")) return classifyBorderDecl(kebabProp, rawValStr).state === "visible";
          return hasVisibleFocusIndicator(`${kebabProp}: ${rawValStr};`, "", { treatAsFocusSelector: true });
        };
        const objNodeToCssBody = (decls) =>
          decls
            .filter((d) => !(d.skipInvisibleOutline && normalizeOutlineCssProp(d.key)))
            .map((d) => {
              const kebab = d.key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
              const outlineCssProp = normalizeOutlineCssProp(d.key);
              const vals = extractJsStyleExprValues(d.rhs, d.rhsStart, outlineCssProp, { forCssBody: true });
              if (FOCUS_PROP_SET.has(kebab)) {
                if (vals.hasConditionalFalsy) {
                  if (kebab.startsWith("outline")) {
                    const badBranch = vals.values.find((v) => !isVisFocusPropVal(kebab, v.val));
                    return badBranch ? `${kebab}: ${badBranch.val};` : "";
                  }
                  return "";
                }
                if (vals.values.length === 0) return "";
                if (vals.values.some((v) => v.underCond)) {
                  const badBranch = vals.values.find((v) => !isVisFocusPropVal(kebab, v.val));
                  return `${kebab}: ${(badBranch || vals.values[0]).val};`;
                }
                return `${kebab}: ${vals.values[0].val};`;
              }
              const valStr = vals.values.map((v) => v.val).join(" ").trim();
              if (!valStr) return "";
              return `${kebab}: ${valStr};`;
            })
            .filter(Boolean)
            .join(" ");
        const objBlocks = nodes.map((node) => ({
          selector: node.selector,
          resolvedSelector: node.selector,
          body: objNodeToCssBody(node.decls),
          bodyStart: node.startOffset,
          conditions: node.conds,
          inKeyframes: node.inKeyframes,
          inStartingStyle: false,
        }));
        const safeFromTree = createFocusSafetyChecker(
          objBlocks,
          Array.isArray(options.externalCssBlocks) ? options.externalCssBlocks : []
        );
        for (let ni = 0; ni < nodes.length; ni++) {
          const node = nodes[ni];
          const blkObj = objBlocks[ni];
          const selfBody = blkObj.body;
          for (const ent of node.decls) {
            const lk = ent.key.toLowerCase();
            if (
              lk === "transition" || lk === "transitionproperty" || lk === "transition-property" ||
              VW_WIDTH_KEYS.has(lk)
            ) {
              checkJsPropWithExpr(ent.key, nonStyleClean.slice(ent.rhsStart, ent.rhsEnd), ent.rhsStart, true, Boolean(ent.skipInvisibleOutline));
              continue;
            }
            const cssProp = normalizeOutlineCssProp(ent.key);
            if (cssProp && !node.inKeyframes) {
              const { values, condHasVisibleOutline } = extractJsStyleExprValues(nonStyleClean.slice(ent.rhsStart, ent.rhsEnd), ent.rhsStart, cssProp);
              for (const item of values) {
                if ((ent.skipInvisibleOutline || (item.underCond && condHasVisibleOutline)) && classifyOutlineDecl(cssProp, item.val).state === "invisible") continue;
                const info = classifyOutlineDecl(cssProp, item.val);
                if (info.state === "invisible") {
                  if (hasVisibleFocusIndicator(selfBody, node.selector) || safeFromTree(node.selector, blkObj)) continue;
                  findings.push({
                    file: filePath,
                    line: offsetToLine(cleanComments, item.offset),
                    ruleId: "dsaf/no-outline-none-naked",
                    tier: "floor",
                    severity: "error",
                    message: `Focus \`${cssProp}: ${item.val.trim()}\` on \`${node.selector}\` without visible focus ring/border replacement.`,
                  });
                }
              }
            }
          }
        }
      };

      const splitCommaTop = (str, lStart, lEnd) => {
        const parts = [];
        let partStart = lStart;
        let p = 0, b = 0, br = 0, q = null, lastSig = "";
        const parenStack = [];
        for (let k = lStart; k < lEnd; k++) {
          const c = str[k];
          if (q) {
            if (c === "\\" && k + 1 < lEnd) { k++; continue; }
            if (q === "`" && c === "$" && k + 1 < lEnd && str[k + 1] === "{") {
              const se = findBal(str, k + 1, "{", "}");
              if (se === -1 || se >= lEnd) break;
              k = se;
              lastSig = "}";
              continue;
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
            continue;
          }
          const reEnd = skipJsRegexInExpr(str, k, lastSig, lStart);
          if (reEnd !== -1 && reEnd <= lEnd) { k = reEnd - 1; lastSig = "/"; continue; }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "(") {
            parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(lStart, k - 16), k)));
            lastSig = "(";
            p++;
          } else if (c === ")") {
            lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
            p = Math.max(0, p - 1);
          } else if (c === "[") { b++; lastSig = c; }
          else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
          else if (c === "{") { br++; lastSig = c; }
          else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
          else if (c === "," && p === 0 && b === 0 && br === 0) {
            parts.push([partStart, k]);
            partStart = k + 1;
            lastSig = c;
          } else if (!/\s/.test(c)) lastSig = c;
        }
        parts.push([partStart, lEnd]);
        return parts;
      };
      const scanTopObjectLiterals = (str, lStart, lEnd) => {
        let foundObj = false;
        let q = null, lastSig = "";
        const parenStack = [];
        for (let k = lStart; k < lEnd; k++) {
          const c = str[k];
          if (q) {
            if (c === "\\" && k + 1 < lEnd) { k++; continue; }
            if (q === "`" && c === "$" && k + 1 < lEnd && str[k + 1] === "{") {
              const se = findBal(str, k + 1, "{", "}");
              if (se === -1 || se >= lEnd) break;
              k = se;
              lastSig = "}";
              continue;
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
            continue;
          }
          const reEnd = skipJsRegexInExpr(str, k, lastSig, lStart);
          if (reEnd !== -1 && reEnd <= lEnd) { k = reEnd - 1; lastSig = "/"; continue; }
          if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "(") {
            parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(lStart, k - 16), k)));
            lastSig = "(";
          } else if (c === ")") {
            lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
          } else if (c === "{") {
            const closeB = findBal(str, k, "{", "}");
            if (closeB !== -1 && closeB < lEnd) {
              if (!isAlreadyScannedStyledSpan(k, closeB + 1)) {
                scanCssInJsObjectSpan(k + 1, closeB);
                foundObj = true;
              }
              k = closeB;
              lastSig = "}";
            } else {
              lastSig = "{";
            }
          } else if (!/\s/.test(c)) lastSig = c;
        }
        return foundObj;
      };
      const scanBlockReturnsForObjects = (str, bStart, bEnd) => {
        let q = null, lastSig = "";
        const parenStack = [];
        for (let k = bStart; k < bEnd; k++) {
          const c = str[k];
          if (q) {
            if (c === "\\" && k + 1 < bEnd) { k++; continue; }
            if (q === "`" && c === "$" && k + 1 < bEnd && str[k + 1] === "{") {
              const se = findBal(str, k + 1, "{", "}");
              if (se === -1 || se >= bEnd) break;
              k = se;
              lastSig = "}";
              continue;
            }
            if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
            continue;
          }
          const reOuter = skipJsRegexInExpr(str, k, lastSig, bStart);
          if (reOuter !== -1 && reOuter <= bEnd) { k = reOuter - 1; lastSig = "/"; continue; }
          if (c === '"' || c === "'" || c === "`") { q = c; continue; }
          if (c === "(") {
            parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(bStart, k - 16), k)));
            lastSig = "(";
            continue;
          }
          if (c === ")") {
            lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
            continue;
          }
          if (c === "r" && str.startsWith("return", k)) {
            const prevCh = k > bStart ? str[k - 1] : "";
            const nextCh = str[k + 6] || "";
            if (!/[A-Za-z0-9_$]/.test(prevCh) && !/[A-Za-z0-9_$]/.test(nextCh)) {
              const exprS = k + 6;
              let exprE = exprS;
              let pD = 0, bD = 0, brD = 0, rq = null, rLastSig = "return";
              const rParenStack = [];
              while (exprE < bEnd) {
                const ec = str[exprE];
                if (rq) {
                  if (ec === "\\" && exprE + 1 < bEnd) { exprE += 2; continue; }
                  if (rq === "`" && ec === "$" && exprE + 1 < bEnd && str[exprE + 1] === "{") {
                    const se = findBal(str, exprE + 1, "{", "}");
                    if (se === -1 || se >= bEnd) break;
                    exprE = se + 1;
                    rLastSig = "}";
                    continue;
                  }
                  if (ec === rq || (rq !== "`" && ec === "\n")) { rq = null; rLastSig = ec; }
                  exprE++;
                  continue;
                }
                const reInner = skipJsRegexInExpr(str, exprE, rLastSig, exprS);
                if (reInner !== -1 && reInner <= bEnd) { exprE = reInner; rLastSig = "/"; continue; }
                if (ec === '"' || ec === "'" || ec === "`") rq = ec;
                else if (ec === "(") {
                  rParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(exprS, exprE - 16), exprE)));
                  rLastSig = "(";
                  pD++;
                } else if (ec === ")") {
                  if (pD === 0) break;
                  pD--;
                  rLastSig = rParenStack.length > 0 && rParenStack.pop() ? "control)" : ")";
                } else if (ec === "[") { bD++; rLastSig = ec; }
                else if (ec === "]") { if (bD === 0) break; bD--; rLastSig = ec; }
                else if (ec === "{") { brD++; rLastSig = ec; }
                else if (ec === "}") { if (brD === 0) break; brD--; rLastSig = ec; }
                else if (ec === ";" && pD === 0 && bD === 0 && brD === 0) break;
                else if (!/\s/.test(ec)) rLastSig = ec;
                exprE++;
              }
              scanTopObjectLiterals(str, exprS, exprE);
              k = exprE;
              lastSig = ";";
              continue;
            }
          }
          if (!/\s/.test(c)) lastSig = c;
        }
      };
      const scanCssInJsCallArgs = (argsStart, argsEnd) => {
        for (const [as, ae] of splitCommaTop(nonStyleClean, argsStart, argsEnd)) {
          let l = as, r = ae;
          while (true) {
            while (l < r && /\s/.test(nonStyleClean[l])) l++;
            while (r > l && /\s/.test(nonStyleClean[r - 1])) r--;
            if (l < r && nonStyleClean[l] === "(" && findBal(nonStyleClean, l, "(", ")") === r - 1) {
              l++;
              r--;
              continue;
            }
            break;
          }
          if (l >= r) continue;
          let arrowIdx = -1;
          {
            let p = 0, b = 0, br = 0, q = null, lastSig = "";
            const parenStack = [];
            for (let k = l; k < r - 1; k++) {
              const c = nonStyleClean[k];
              if (q) {
                if (c === "\\" && k + 1 < r) { k++; continue; }
                if (q === "`" && c === "$" && k + 1 < r && nonStyleClean[k + 1] === "{") {
                  const se = findBal(nonStyleClean, k + 1, "{", "}");
                  if (se === -1 || se >= r) break;
                  k = se;
                  lastSig = "}";
                  continue;
                }
                if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
                continue;
              }
              const reArrow = skipJsRegexInExpr(nonStyleClean, k, lastSig, l);
              if (reArrow !== -1 && reArrow <= r) { k = reArrow - 1; lastSig = "/"; continue; }
              if (c === '"' || c === "'" || c === "`") q = c;
              else if (c === "(") {
                parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nonStyleClean.slice(Math.max(l, k - 16), k)));
                lastSig = "(";
                p++;
              } else if (c === ")") {
                lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
                p = Math.max(0, p - 1);
              } else if (c === "[") { b++; lastSig = c; }
              else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
              else if (c === "{") { br++; lastSig = c; }
              else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
              else if (p === 0 && b === 0 && br === 0 && c === "=" && nonStyleClean[k + 1] === ">") {
                arrowIdx = k;
                break;
              } else if (!/\s/.test(c)) lastSig = c;
            }
          }
          if (arrowIdx !== -1) {
            let bl = arrowIdx + 2;
            let br = r;
            let bodyWrapped = false;
            while (true) {
              while (bl < br && /\s/.test(nonStyleClean[bl])) bl++;
              while (br > bl && /\s/.test(nonStyleClean[br - 1])) br--;
              if (bl < br && nonStyleClean[bl] === "(" && findBal(nonStyleClean, bl, "(", ")") === br - 1) {
                bl++;
                br--;
                bodyWrapped = true;
                continue;
              }
              break;
            }
            if (bl < br && nonStyleClean[bl] === "{" && findBal(nonStyleClean, bl, "{", "}") === br - 1) {
              if (bodyWrapped) {
                if (!isAlreadyScannedStyledSpan(bl, br)) scanCssInJsObjectSpan(bl + 1, br - 1);
              } else {
                scanBlockReturnsForObjects(nonStyleClean, bl + 1, br - 1);
              }
            } else {
              scanTopObjectLiterals(nonStyleClean, bl, br);
            }
            continue;
          }
          if (nonStyleClean[l] === "{" && findBal(nonStyleClean, l, "{", "}") === r - 1) {
            if (!isAlreadyScannedStyledSpan(l, r)) scanCssInJsObjectSpan(l + 1, r - 1);
          } else {
            scanTopObjectLiterals(nonStyleClean, l, r);
          }
        }
      };

      // A. CSS-in-JS tagged templates (`styled.div`...``, `styled(Comp).attrs(...)`...``, `css`...``, `createGlobalStyle`...``)
      const isInNonCodeCssInJsCtx = (idx) =>
        inTagSpan(idx, markupCtx.proseSpans) ||
        inTagSpan(idx, markupCtx.jsStringSpans) ||
        markupCtx.openTags.some((t) => idx > t.start && idx < t.end && inTagSpan(idx, t.attrValueSpans));
      const styledRe = /(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b)\s*/g;
      const styledTemplateRanges = [];
      const styledObjCallRanges = [];
      const isAlreadyScannedStyledSpan = (sOff, eOff) =>
        styledObjCallRanges.some(([os, oe]) => sOff >= os && eOff <= oe) ||
        styledTemplateRanges.some((r) => sOff >= r.start && eOff <= r.end);
      for (const m of nonStyleClean.matchAll(styledRe)) {
        if (isInNonCodeCssInJsCtx(m.index)) continue;
        let cur = m.index + m[0].length;
        if (/^styled(?:\s|$)/.test(m[0]) && nonStyleClean[cur] === "(") {
          const endStyledArg = findBal(nonStyleClean, cur, "(", ")");
          if (endStyledArg === -1) continue;
          cur = endStyledArg + 1;
          while (cur < nonStyleClean.length && /\s/.test(nonStyleClean[cur])) cur++;
        }
        while (cur < nonStyleClean.length) {
          const chainM = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(nonStyleClean.slice(cur, cur + 64));
          if (!chainM) break;
          cur += chainM[0].length;
          const gC = skipTsGen(nonStyleClean, cur);
          if (!gC.ok) { cur = -1; break; }
          cur = gC.cur;
          if (nonStyleClean[cur] === "(") {
            const endP = findBal(nonStyleClean, cur, "(", ")");
            if (endP === -1) { cur = -1; break; }
            cur = endP + 1;
            while (cur < nonStyleClean.length && /\s/.test(nonStyleClean[cur])) cur++;
          }
        }
        if (cur === -1) continue;
        const gRes = skipTsGen(nonStyleClean, cur);
        if (!gRes.ok) continue;
        cur = gRes.cur;
        if (nonStyleClean[cur] === "(") {
          const endObj = findBal(nonStyleClean, cur, "(", ")");
          if (endObj !== -1) {
            scanCssInJsCallArgs(cur + 1, endObj);
            styledObjCallRanges.push([m.index, endObj + 1]);
          }
          continue;
        }
        if (nonStyleClean[cur] !== "`") continue;
        const tStart = cur + 1;
        let ti = tStart;
        const exprSpans = [];
        let tEnd = -1;
        while (ti < nonStyleClean.length) {
          const c = nonStyleClean[ti];
          if (c === "\\" && ti + 1 < nonStyleClean.length) { ti += 2; continue; }
          if (c === "$" && nonStyleClean[ti + 1] === "{") {
            const eEnd = findBal(nonStyleClean, ti + 1, "{", "}");
            if (eEnd === -1) break;
            exprSpans.push([ti, eEnd + 1]);
            ti = eEnd + 1;
            continue;
          }
          if (c === "`") { tEnd = ti; break; }
          ti++;
        }
        if (tEnd !== -1) {
          styledTemplateRanges.push({ start: tStart, end: tEnd, exprSpans });
        }
      }
      const unwrapStyledInterpolationExpr = (exprRaw, baseOff, depth = 0) => {
        if (depth > 8) return [{ expr: exprRaw, offset: baseOff }];
        let l = 0;
        let r = exprRaw.length;
        while (true) {
          while (l < r && /\s/.test(exprRaw[l])) l++;
          while (r > l && /\s/.test(exprRaw[r - 1])) r--;
          const tsEnd = ciStripTrailingTsCastEnd(exprRaw, l, r);
          if (tsEnd !== r) {
            r = tsEnd;
            continue;
          }
          if (l < r && exprRaw[l] === "(" && findBal(exprRaw, l, "(", ")") === r - 1) {
            l++;
            r--;
            continue;
          }
          break;
        }
        if (l >= r) return [];
        const cur = exprRaw.slice(l, r);
        const curOff = baseOff + l;
        let bodyRel = -1;
        let pCur = 0;
        if (/^async\s+(?=[A-Za-z_$(])/.test(cur)) {
          const am = /^async\s+/.exec(cur);
          pCur = am[0].length;
        }
        if (cur[pCur] === "(") {
          const pEnd = findBal(cur, pCur, "(", ")");
          if (pEnd !== -1) {
            let afterP = pEnd + 1;
            while (afterP < cur.length && /\s/.test(cur[afterP])) afterP++;
            if (cur[afterP] === ":") {
              let k = afterP + 1;
              let pq = null, pd = 0, pb = 0, pbr = 0, pa = 0;
              while (k < cur.length) {
                const c = cur[k];
                if (pq) {
                  if (c === "\\" && k + 1 < cur.length) { k += 2; continue; }
                  if (c === pq || (pq !== "`" && c === "\n")) pq = null;
                  k++;
                  continue;
                }
                if (c === '"' || c === "'" || c === "`") pq = c;
                else if (c === "(") pd++;
                else if (c === ")") pd = Math.max(0, pd - 1);
                else if (c === "[") pb++;
                else if (c === "]") pb = Math.max(0, pb - 1);
                else if (c === "{") pbr++;
                else if (c === "}") pbr = Math.max(0, pbr - 1);
                else if (c === "<" && pd === 0 && pb === 0 && pbr === 0) pa++;
                else if (c === ">" && cur[k - 1] !== "=" && pd === 0 && pb === 0 && pbr === 0) {
                  if (pa > 0) pa--;
                  else break;
                } else if (c === "=" && cur[k + 1] === ">" && pd === 0 && pb === 0 && pbr === 0 && pa === 0) {
                  bodyRel = k + 2;
                  break;
                }
                k++;
              }
            } else if (cur[afterP] === "=" && cur[afterP + 1] === ">") {
              bodyRel = afterP + 2;
            }
          }
        } else {
          const idArrow = /^[A-Za-z_$][\w$]*\s*=>/.exec(cur.slice(pCur));
          if (idArrow) bodyRel = pCur + idArrow[0].length;
        }
        if (bodyRel !== -1) {
          while (bodyRel < cur.length && /\s/.test(cur[bodyRel])) bodyRel++;
          if (cur[bodyRel] === "{") {
            const bEnd = findBal(cur, bodyRel, "{", "}");
            if (bEnd !== -1) {
              const outRets = [];
              let rq = null, rLast = "{", rp = 0, rb = 0, rbr = 0;
              const rPStack = [];
              for (let k = bodyRel + 1; k < bEnd; k++) {
                const c = cur[k];
                if (rq) {
                  if (c === "\\" && k + 1 < bEnd) { k++; continue; }
                  if (rq === "`" && c === "$" && cur[k + 1] === "{") {
                    const se = findBal(cur, k + 1, "{", "}");
                    if (se !== -1 && se < bEnd) { k = se; rLast = "}"; continue; }
                  }
                  if (c === rq || (rq !== "`" && c === "\n")) { rq = null; rLast = c; }
                  continue;
                }
                const reE = skipJsRegexInExpr(cur, k, rLast, bodyRel + 1);
                if (reE !== -1 && reE <= bEnd) { k = reE - 1; rLast = "/"; continue; }
                if (c === '"' || c === "'" || c === "`") rq = c;
                else if (c === "(") { rPStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(cur.slice(Math.max(bodyRel + 1, k - 16), k))); rp++; rLast = "("; }
                else if (c === ")") { rp = Math.max(0, rp - 1); rLast = rPStack.pop() ? "control)" : ")"; }
                else if (c === "[") { rb++; rLast = "["; }
                else if (c === "]") { rb = Math.max(0, rb - 1); rLast = "]"; }
                else if (c === "{") { rbr++; rLast = "{"; }
                else if (c === "}") { rbr = Math.max(0, rbr - 1); rLast = "}"; }
                else if (rp === 0 && rb === 0 && c === "r" && cur.startsWith("return", k)) {
                  const prevC = k > bodyRel + 1 ? cur[k - 1] : "";
                  const nextC = cur[k + 6] || "";
                  if (!/[A-Za-z0-9_$]/.test(prevC) && !/[A-Za-z0-9_$]/.test(nextC)) {
                    let rs = k + 6;
                    while (rs < bEnd && /\s/.test(cur[rs])) rs++;
                    let re = rs, ep = 0, eb = 0, ebr = 0, eq = null, eLast = "return";
                    const ePStack = [];
                    while (re < bEnd) {
                      const ec = cur[re];
                      if (eq) {
                        if (ec === "\\" && re + 1 < bEnd) { re += 2; continue; }
                        if (eq === "`" && ec === "$" && cur[re + 1] === "{") {
                          const se = findBal(cur, re + 1, "{", "}");
                          if (se !== -1 && se < bEnd) { re = se + 1; eLast = "}"; continue; }
                        }
                        if (ec === eq || (eq !== "`" && ec === "\n")) { eq = null; eLast = ec; }
                        re++;
                        continue;
                      }
                      const re2 = skipJsRegexInExpr(cur, re, eLast, rs);
                      if (re2 !== -1 && re2 <= bEnd) { re = re2; eLast = "/"; continue; }
                      if (ec === '"' || ec === "'" || ec === "`") eq = ec;
                      else if (ec === "(") { ePStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(cur.slice(Math.max(rs, re - 16), re))); ep++; eLast = "("; }
                      else if (ec === ")") { if (ep === 0) break; ep--; eLast = ePStack.pop() ? "control)" : ")"; }
                      else if (ec === "[") { eb++; eLast = "["; }
                      else if (ec === "]") { if (eb === 0) break; eb--; eLast = "]"; }
                      else if (ec === "{") { ebr++; eLast = "{"; }
                      else if (ec === "}") { if (ebr === 0) break; ebr--; eLast = "}"; }
                      else if (ec === ";" && ep === 0 && eb === 0 && ebr === 0) break;
                      else if (!/\s/.test(ec)) eLast = ec;
                      re++;
                    }
                    if (re > rs) {
                      outRets.push(...unwrapStyledInterpolationExpr(cur.slice(rs, re), curOff + rs, depth + 1));
                    }
                    k = re;
                    rLast = ";";
                    continue;
                  }
                } else if (!/\s/.test(c)) rLast = c;
              }
              return outRets;
            }
          }
          return unwrapStyledInterpolationExpr(cur.slice(bodyRel), curOff + bodyRel, depth + 1);
        }
        return [{ expr: cur, offset: curOff }];
      };

      // Process innermost-safe CSS-in-JS template slices (masking child ${...} spans; inject dynamic value tokens only inside declaration values)
      for (const tr of styledTemplateRanges) {
        const innerChars = nonStyleClean.slice(tr.start, tr.end).split("");
        const tplExprMeta = [];
        for (const [es, ee] of tr.exprSpans) {
          const sRel = es - tr.start;
          const eRel = ee - tr.start;
          let lastDelim = sRel - 1;
          while (lastDelim >= 0 && innerChars[lastDelim] !== "{" && innerChars[lastDelim] !== "}" && innerChars[lastDelim] !== ";") {
            lastDelim--;
          }
          const segBefore = innerChars.slice(lastDelim + 1, sRel).join("");
          const inDeclVal = /^\s*(?:--[a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*(?!:|hover\b|focus\b|focus-visible\b|focus-within\b|active\b|disabled\b|visited\b|checked\b|has\(|is\(|where\(|not\()/i.test(
            segBefore
          );
          const nlRel = innerChars.indexOf("\n", sRel);
          const segEnd = nlRel === -1 || nlRel > eRel ? eRel : nlRel;
          maskRangePreservingLines(innerChars, sRel, eRel);
          if (inDeclVal) {
            const tok = segEnd - sRel >= 8 ? "var(--_)" : segEnd - sRel >= 2 ? "$_" : "";
            for (let k = 0; k < tok.length; k++) innerChars[sRel + k] = tok[k];
          }
          tplExprMeta.push({ es, ee, sRel, eRel, inDeclVal });
        }
        const WRAP_PRE = ".dsaf-styled-root{";
        const commentFreeTpl = stripCssCommentsInTemplatePreservingLines(innerChars.join(""));
        const wrapped = `${WRAP_PRE}${commentFreeTpl}}`;
        const cBlocks = extractCssRuleBlocks(wrapped);
        const safeFocus = createFocusSafetyChecker(cBlocks, Array.isArray(options.externalCssBlocks) ? options.externalCssBlocks : []);
        for (const blk of cBlocks) {
          const effSel = blk.resolvedSelector || blk.selector;
          checkCssDeclsFloor(blk.body, tr.start + blk.bodyStart - WRAP_PRE.length, effSel, blk, safeFocus);
        }
        const findContainingTplBlock = (sRelPos) => {
          const wPos = WRAP_PRE.length + sRelPos;
          let best = null;
          for (const b of cBlocks) {
            if (wPos >= b.bodyStart && wPos <= b.bodyEnd && (!best || b.bodyEnd - b.bodyStart <= best.bodyEnd - best.bodyStart)) {
              best = b;
            }
          }
          return best || cBlocks[0] || { selector: ".dsaf-styled-root", resolvedSelector: ".dsaf-styled-root", body: "", inKeyframes: false, inStartingStyle: false };
        };
        for (const meta of tplExprMeta) {
          const rawExpr = nonStyleClean.slice(meta.es + 2, meta.ee - 1);
          const containingBlk = findContainingTplBlock(meta.sRel);
          const effSel = containingBlk.resolvedSelector || containingBlk.selector;
          if (meta.inDeclVal) {
            let declStart = meta.sRel - 1;
            while (declStart >= 0 && commentFreeTpl[declStart] !== "{" && commentFreeTpl[declStart] !== "}" && commentFreeTpl[declStart] !== ";") {
              declStart--;
            }
            let declEnd = meta.eRel;
            while (declEnd < commentFreeTpl.length && commentFreeTpl[declEnd] !== "{" && commentFreeTpl[declEnd] !== "}" && commentFreeTpl[declEnd] !== ";") {
              declEnd++;
            }
            const preDecl = commentFreeTpl.slice(declStart + 1, meta.sRel);
            const colIdx = preDecl.indexOf(":");
            if (colIdx === -1) continue;
            const propName = preDecl.slice(0, colIdx).trim().toLowerCase();
            if (!propName || propName.startsWith("--")) continue;
            const staticPrefix = preDecl.slice(colIdx + 1);
            const staticSuffix = commentFreeTpl.slice(meta.eRel, declEnd);
            const isTransProp = propName === "transition" || propName === "transition-property";
            const isWidthProp = VW_WIDTH_KEYS.has(propName);
            const cssOutlineProp = normalizeOutlineCssProp(propName);
            if (!isTransProp && !isWidthProp && (!cssOutlineProp || containingBlk.inKeyframes)) continue;
            const staticPlaceholderVal = `${staticPrefix} var(--_) ${staticSuffix}`;
            const staticTransAll = isTransProp && /(?<![a-zA-Z0-9_$-])all(?![a-zA-Z0-9_-])/i.test(stripCssParens(staticPlaceholderVal));
            const staticLayoutTrans = isTransProp && /(?<![a-zA-Z0-9_$-])(width|height|top|left)(?![a-zA-Z0-9_-])/i.test(stripCssParens(staticPlaceholderVal));
            const static100vw = isWidthProp && /(?:^|[\s,(*/+-])100vw(?=$|[\s,)*/+-]|!\s*important)/i.test(staticPlaceholderVal.replace(/--[a-zA-Z0-9_-]+/g, " "));
            const staticInvOutline = Boolean(cssOutlineProp) && classifyOutlineDecl(cssOutlineProp, staticPlaceholderVal).state === "invisible";
            for (const { expr, offset } of unwrapStyledInterpolationExpr(rawExpr, meta.es + 2)) {
              const { values, condHasVisibleOutline } = extractJsStyleExprValues(expr, offset, cssOutlineProp);
              for (const item of values) {
                const composedVal = `${staticPrefix}${item.val}${staticSuffix}`;
                if (isTransProp) {
                  const strippedTrans = stripCssParens(composedVal);
                  if (!staticTransAll && /(?<![a-zA-Z0-9_$-])all(?![a-zA-Z0-9_-])/i.test(strippedTrans)) {
                    findings.push({
                      file: filePath,
                      line: offsetToLine(cleanComments, item.offset),
                      ruleId: "dsaf/no-transition-all",
                      tier: "floor",
                      severity: "error",
                      message: `Disallowed inline style \`transition: ${composedVal.trim()}\`; transition explicit composited properties instead.`,
                    });
                  }
                  const lHit = !staticLayoutTrans ? /(?<![a-zA-Z0-9_$-])(width|height|top|left)(?![a-zA-Z0-9_-])/i.exec(strippedTrans) : null;
                  if (lHit) {
                    findings.push({
                      file: filePath,
                      line: offsetToLine(cleanComments, item.offset),
                      ruleId: "dsaf/no-layout-transition",
                      tier: "floor",
                      severity: "error",
                      message: `Disallowed layout transition on \`${lHit[1]}\`; animate \`transform\` or \`opacity\`.`,
                    });
                  }
                } else if (isWidthProp && !static100vw) {
                  const cleanVwVal = composedVal.replace(/--[a-zA-Z0-9_-]+/g, " ");
                  if (/(?:^|[\s,(*/+-])100vw(?=$|[\s,)*/+-]|!\s*important)/i.test(cleanVwVal)) {
                    findings.push({
                      file: filePath,
                      line: offsetToLine(cleanComments, item.offset),
                      ruleId: "dsaf/no-100vw",
                      tier: "floor",
                      severity: "error",
                      message: "Disallowed `100vw` width; use `100%` with `overflow-x: clip` to prevent scrollbar overflow.",
                    });
                  }
                } else if (cssOutlineProp && !staticInvOutline) {
                  if (item.focusBranch === "unfocused" && condHasVisibleOutline && classifyOutlineDecl(cssOutlineProp, composedVal).state === "invisible") {
                    continue;
                  }
                  if (classifyOutlineDecl(cssOutlineProp, composedVal).state === "invisible") {
                    const borderSupp = safeFocus.getBorderSuppression ? safeFocus.getBorderSuppression(effSel, containingBlk) : {};
                    if (!hasVisibleFocusIndicator(containingBlk.body || "", effSel, borderSupp) && !safeFocus(effSel, containingBlk)) {
                      findings.push({
                        file: filePath,
                        line: offsetToLine(cleanComments, item.offset),
                        ruleId: "dsaf/no-outline-none-naked",
                        tier: "floor",
                        severity: "error",
                        message: `Focus \`${cssOutlineProp}: ${composedVal.trim()}\` on \`${effSel}\` without visible focus ring/border replacement.`,
                      });
                    }
                  }
                }
              }
            }
          } else if (!/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+|\s*\()|css\s*(?:\(|`)|createGlobalStyle\s*(?:\(|`))/.test(rawExpr)) {
            for (const { expr, offset } of unwrapStyledInterpolationExpr(rawExpr, meta.es + 2)) {
              const { values } = extractJsStyleExprValues(expr, offset, null);
              for (const item of values) {
                if (!item.val || !item.val.includes(":")) continue;
                const cleanLit = blankCssCustomPropDeclsPreservingLines(stripCssCommentsInTemplatePreservingLines(item.val));
                if (/\{/.test(cleanLit)) {
                  const subBlocks = extractCssRuleBlocks(`${WRAP_PRE}${cleanLit}}`);
                  const subSafeFocus = createFocusSafetyChecker(
                    [...cBlocks, ...subBlocks],
                    Array.isArray(options.externalCssBlocks) ? options.externalCssBlocks : []
                  );
                  for (const sb of subBlocks) {
                    const sbSel = sb.resolvedSelector || sb.selector;
                    checkCssDeclsFloor(sb.body, item.offset + sb.bodyStart - WRAP_PRE.length, sbSel, sb, subSafeFocus);
                  }
                } else {
                  checkCssDeclsFloor(cleanLit, item.offset, effSel, containingBlk, safeFocus);
                }
              }
            }
          }
        }
      }

      // B. Native HTML/Vue/Svelte inline `style="..."` attributes
      const externalBlocks = Array.isArray(options.externalCssBlocks) ? options.externalCssBlocks : [];
      const noopSafeFocus = () => false;
      for (const am of nonStyleClean.matchAll(/(?<![a-zA-Z0-9_:-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (!isRealOpenTagAttrPos(am.index)) continue;
        const val = am[1] !== undefined ? am[1] : am[2];
        const qChar = am[1] !== undefined ? '"' : "'";
        const valStart = am.index + am[0].indexOf(qChar) + 1;
        if (!val.includes("{")) {
          const cleanedDecl = blankCssCustomPropDeclsPreservingLines(val);
          checkCssDeclsFloor(cleanedDecl, valStart, "", { inKeyframes: false, inStartingStyle: false }, noopSafeFocus);
        } else {
          let segStart = 0;
          let bD = 0, pD = 0, q = null;
          const processStyleSeg = (segStartIdx, segEndIdx) => {
            const seg = val.slice(segStartIdx, segEndIdx);
            const colonIdx = seg.indexOf(":");
            if (colonIdx === -1) return;
            const rawProp = seg.slice(0, colonIdx).trim();
            if (!rawProp || rawProp.startsWith("--")) return;
            const rhsRaw = seg.slice(colonIdx + 1);
            if (!rhsRaw.includes("{")) {
              checkCssDeclsFloor(seg, valStart + segStartIdx, "", { inKeyframes: false, inStartingStyle: false }, noopSafeFocus);
              return;
            }
            const segChars = seg.split("");
            const interps = [];
            for (let k = colonIdx + 1; k < seg.length; k++) {
              if (seg[k] === "{") {
                const closeB = findBal(seg, k, "{", "}");
                if (closeB === -1) break;
                interps.push({ start: k, end: closeB + 1, innerExpr: seg.slice(k + 1, closeB) });
                maskRangePreservingLines(segChars, k, closeB + 1);
                const tok = closeB - k >= 7 ? "var(--_)" : closeB - k >= 1 ? "$_" : "";
                for (let r = 0; r < tok.length; r++) segChars[k + r] = tok[r];
                k = closeB;
              }
            }
            const outlineProp = normalizeOutlineCssProp(rawProp);
            const hasStaticRhs = segChars.slice(colonIdx + 1).join("").replace(/var\(--_\)|\$_/g, "").trim().length > 0;
            if (outlineProp === "outline" && hasStaticRhs && interps.length > 0) {
              for (const ip of interps) {
                const exprOff = valStart + segStartIdx + ip.start + 1;
                const { values } = extractJsStyleExprValues(ip.innerExpr, exprOff, outlineProp);
                const buildComposed = (branchVal) => {
                  const parts = [];
                  let pCur = colonIdx + 1;
                  for (const oIp of interps) {
                    parts.push(seg.slice(pCur, oIp.start));
                    parts.push(oIp === ip ? branchVal : "var(--_)");
                    pCur = oIp.end;
                  }
                  parts.push(seg.slice(pCur));
                  return parts.join("");
                };
                const composedItems = values.map((item) => ({
                  ...item,
                  composedVal: buildComposed(item.val),
                }));
                const composedHasVisibleFocus = composedItems.some(
                  (ci) => ci.focusBranch === "focused" && classifyOutlineDecl(outlineProp, ci.composedVal).state === "visible"
                );
                for (const ci of composedItems) {
                  if (
                    ci.underCond &&
                    composedHasVisibleFocus &&
                    ci.focusBranch !== "focused" &&
                    classifyOutlineDecl(outlineProp, ci.composedVal).state === "invisible"
                  ) {
                    continue;
                  }
                  checkJsPropFloor(rawProp, ci.composedVal, ci.offset);
                }
              }
            } else {
              for (const ip of interps) {
                checkJsPropWithExpr(rawProp, ip.innerExpr, valStart + segStartIdx + ip.start + 1, true);
              }
            }
            const staticSeg = segChars.join("");
            if (staticSeg.trim()) {
              checkCssDeclsFloor(staticSeg, valStart + segStartIdx, "", { inKeyframes: false, inStartingStyle: false }, noopSafeFocus);
            }
          };
          let lastSigS = "";
          const sParenStack = [];
          for (let i = 0; i <= val.length; i++) {
            const ch = i < val.length ? val[i] : ";";
            if (i < val.length && q) {
              if (ch === "\\" && i + 1 < val.length) { i++; continue; }
              if (bD > 0 && q === "`" && ch === "$" && i + 1 < val.length && val[i + 1] === "{") {
                const se = findBal(val, i + 1, "{", "}");
                if (se !== -1) { i = se; lastSigS = "}"; continue; }
              }
              if (ch === q || (q !== "`" && ch === "\n")) { q = null; lastSigS = ch; }
              continue;
            }
            if (i < val.length && bD > 0) {
              const reEnd = skipJsRegexInExpr(val, i, lastSigS, segStart);
              if (reEnd !== -1 && reEnd <= val.length) { lastSigS = "/"; i = reEnd - 1; continue; }
            }
            if (i < val.length && (ch === '"' || ch === "'" || ch === "`")) { q = ch; continue; }
            if (i < val.length && ch === "{") { bD++; lastSigS = "{"; }
            else if (i < val.length && ch === "}") { bD = Math.max(0, bD - 1); lastSigS = "}"; }
            else if (i < val.length && ch === "(") {
              if (bD > 0) sParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(val.slice(Math.max(segStart, i - 16), i)));
              pD++;
              lastSigS = "(";
            } else if (i < val.length && ch === ")") {
              pD = Math.max(0, pD - 1);
              lastSigS = bD > 0 && sParenStack.length > 0 && sParenStack.pop() ? "control)" : ")";
            } else if (ch === ";" && bD === 0 && pD === 0) {
              processStyleSeg(segStart, i);
              segStart = i + 1;
              lastSigS = "";
            } else if (i < val.length && !/\s/.test(ch)) {
              lastSigS = ch;
            }
          }
        }
      }

      // C. JSX `style={{...}}`, `sx={{...}}`, `css={{...}}`, Vue `:style="{...}"` / `v-bind:style="{...}"`, and Svelte `style:*={...}`
      for (const sm of nonStyleClean.matchAll(/(?<![a-zA-Z0-9_-])style\s*=\s*\{/g)) {
        if (!isRealOpenTagAttrPos(sm.index)) continue;
        const openBrace = nonStyleClean.indexOf("{", sm.index);
        const closeBrace = findBal(nonStyleClean, openBrace, "{", "}");
        if (closeBrace !== -1) scanJsStyleObjectSpan(openBrace + 1, closeBrace);
      }
      for (const sm of nonStyleClean.matchAll(/(?<![a-zA-Z0-9_-])(?:sx|css)\s*=\s*\{/g)) {
        if (!isRealOpenTagAttrPos(sm.index)) continue;
        const openBrace = nonStyleClean.indexOf("{", sm.index);
        const closeBrace = findBal(nonStyleClean, openBrace, "{", "}");
        if (closeBrace !== -1) scanCssInJsCallArgs(openBrace + 1, closeBrace);
      }
      for (const vm of nonStyleClean.matchAll(/(?:^|\s)(?::|v-bind:)style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const attrOff = vm.index + vm[0].search(/[:v]/i);
        if (!isRealOpenTagAttrPos(attrOff)) continue;
        const vVal = vm[1] !== undefined ? vm[1] : vm[2];
        const qChar = vm[1] !== undefined ? '"' : "'";
        const vStart = vm.index + vm[0].indexOf(qChar) + 1;
        scanJsStyleObjectSpan(vStart, vStart + vVal.length);
      }
      for (const dm of nonStyleClean.matchAll(/(?<![a-zA-Z0-9_-])style:(transition(?:-property)?|(?:min-|max-)?(?:width|inline-size)|outline(?:-(?:style|width|color))?)(?:\|important)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/gi)) {
        if (!isRealOpenTagAttrPos(dm.index)) continue;
        const rawProp = dm[1];
        if (dm[2] !== undefined || dm[3] !== undefined) {
          const dVal = dm[2] ?? dm[3] ?? "";
          const qChar = dm[2] !== undefined ? '"' : "'";
          const dStart = dm.index + dm[0].indexOf(qChar) + 1;
          if (!dVal.includes("{")) {
            checkJsPropFloor(rawProp, dVal, dStart);
          } else {
            const interps = [];
            for (let k = 0; k < dVal.length; k++) {
              if (dVal[k] === "{") {
                const closeB = findBal(dVal, k, "{", "}");
                if (closeB === -1) break;
                interps.push({ start: k, end: closeB + 1, innerExpr: dVal.slice(k + 1, closeB) });
                k = closeB;
              }
            }
            if (interps.length === 0) {
              checkJsPropFloor(rawProp, dVal, dStart);
            } else if (
              interps.length === 1 &&
              !dVal.slice(0, interps[0].start).trim() &&
              !dVal.slice(interps[0].end).trim()
            ) {
              checkJsPropWithExpr(rawProp, interps[0].innerExpr, dStart + interps[0].start + 1, true);
            } else {
              const outlineProp = normalizeOutlineCssProp(rawProp);
              for (const ip of interps) {
                const { values } = extractJsStyleExprValues(ip.innerExpr, dStart + ip.start + 1, outlineProp, { forCssBody: true });
                const buildComposed = (branchVal) => {
                  const parts = [];
                  let pCur = 0;
                  for (const oIp of interps) {
                    parts.push(dVal.slice(pCur, oIp.start));
                    parts.push(oIp === ip ? branchVal : "var(--_)");
                    pCur = oIp.end;
                  }
                  parts.push(dVal.slice(pCur));
                  return parts.join("");
                };
                const composedItems = values.map((item) => ({
                  ...item,
                  composedVal: buildComposed(item.val),
                }));
                const composedHasVisibleFocus =
                  Boolean(outlineProp) &&
                  composedItems.some(
                    (ci) => ci.focusBranch === "focused" && classifyOutlineDecl(outlineProp, ci.composedVal).state === "visible"
                  );
                for (const ci of composedItems) {
                  if (
                    outlineProp &&
                    ci.underCond &&
                    composedHasVisibleFocus &&
                    ci.focusBranch !== "focused" &&
                    classifyOutlineDecl(outlineProp, ci.composedVal).state === "invisible"
                  ) {
                    continue;
                  }
                  checkJsPropFloor(rawProp, ci.composedVal, ci.offset);
                }
              }
            }
          }
        } else {
          const openBrace = dm.index + dm[0].length - 1;
          const closeBrace = findBal(nonStyleClean, openBrace, "{", "}");
          if (closeBrace !== -1) {
            checkJsPropWithExpr(rawProp, nonStyleClean.slice(openBrace + 1, closeBrace), openBrace + 1, true);
          }
        }
      }
    }
    // 5. Floor: <video autoplay> without muted
    for (const vt of extractVideoTags(nonStyleClean, { ...markupOpts, markupCtx, caseSensitive: !/\.html?$/i.test(filePath) })) {
      if (isUnmutedAutoplayVideo(vt.attrs)) {
        findings.push({
          file: filePath,
          line: offsetToLine(nonStyleClean, vt.start),
          ruleId: "dsaf/no-autoplay-unmuted",
          tier: "floor",
          severity: "error",
          message: "Autoplaying `<video>` must include `muted` (and `playsinline`).",
        });
      }
    }
    }
  }

  // Reflex checks (when tier === "reflex" or "all")
  if (includeReflex) {
    const surface = maskSvgAndStyleTokens(raw, isStyle, markupOpts, fullMarkupCtx);
    let nonVars;
    let reflexSurfCtx = null;
    if (isStyle) {
      nonVars = blankCssCustomPropDeclsPreservingLines(surface);
    } else {
      const nvChars = surface.split("");
      reflexSurfCtx = surface === cleanComments ? fullMarkupCtx : scanMarkupContexts(surface, markupOpts);
      for (const blk of extractRealStyleBlocks(surface, reflexSurfCtx, markupOpts)) {
        const sliceRep = blankCssCustomPropDeclsPreservingLines(surface.slice(blk.bodyStart, blk.bodyEnd));
        for (let k = 0; k < sliceRep.length && blk.bodyStart + k < blk.bodyEnd; k++) {
          nvChars[blk.bodyStart + k] = sliceRep[k];
        }
      }
      for (const attrMatch of surface.matchAll(/(?<![a-zA-Z0-9_:-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (!ciIsRealOpenTagAttrPos(reflexSurfCtx, attrMatch.index)) continue;
        const val = attrMatch[1] !== undefined ? attrMatch[1] : attrMatch[2];
        const qChar = attrMatch[1] !== undefined ? '"' : "'";
        const attrStart = attrMatch.index + attrMatch[0].indexOf(qChar) + 1;
        const attrRep = blankCssCustomPropDeclsPreservingLines(val, { allowBracedExpr: true });
        for (let k = 0; k < attrRep.length && attrStart + k < attrStart + val.length; k++) {
          nvChars[attrStart + k] = attrRep[k];
        }
      }
      if (ext === ".svelte") {
        for (const sd of findSvelteStyleDirectives(surface)) {
          if (sd.isCustomProp && ciIsRealOpenTagAttrPos(reflexSurfCtx, sd.start)) {
            maskRangePreservingLines(nvChars, sd.valStart, sd.valEnd);
          }
        }
      }
      const nvBase = blankStyledTemplateCustomPropsPreservingLines(nvChars.join(""));
      const nvOutChars = nvBase.split("");
      const nvOuterStrSpans = computeMarkupJsOuterStringSpans(nvBase, markupOpts, markupOpts ? scanMarkupContexts(nvBase, markupOpts) : null);
      const isInsideNvStr = (idx) => nvOuterStrSpans.some(([s0, e0]) => idx > s0 && idx < e0);
      const blankCustomPropRe = /(["'])--[a-zA-Z0-9_-]+\1\s*:/g;
      let cpm;
      while ((cpm = blankCustomPropRe.exec(nvBase)) !== null) {
        if (isInsideNvStr(cpm.index) || !isValidJsObjKeyPos(nvBase, cpm.index)) continue;
        let j = cpm.index + cpm[0].length;
        let p = 0, b = 0, k = 0, q = null, lastSig = ":";
        const cParenStack = [];
        while (j < nvBase.length) {
          const ch = nvBase[j];
          if (q) {
            if (ch === "\\" && j + 1 < nvBase.length) { j += 2; continue; }
            if (q === "`" && ch === "$" && j + 1 < nvBase.length && nvBase[j + 1] === "{") {
              const se = findBal(nvBase, j + 1, "{", "}");
              if (se !== -1) { j = se + 1; lastSig = "}"; continue; }
            }
            if (ch === q || (q !== "`" && ch === "\n")) { q = null; lastSig = ch; }
            j++;
            continue;
          }
          const reEnd = skipJsRegexInExpr(nvBase, j, lastSig, cpm.index);
          if (reEnd !== -1 && reEnd <= nvBase.length) { lastSig = "/"; j = reEnd; continue; }
          if (ch === '"' || ch === "'" || ch === "`") q = ch;
          else if (ch === "(") {
            cParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(nvBase.slice(Math.max(cpm.index, j - 16), j)));
            p++; lastSig = "(";
          } else if (ch === ")") {
            if (p === 0 && b === 0 && k === 0) break;
            p--; lastSig = cParenStack.length > 0 && cParenStack.pop() ? "control)" : ")";
          } else if (ch === "[") { b++; lastSig = ch; }
          else if (ch === "]") { if (b === 0 && p === 0 && k === 0) break; b--; lastSig = ch; }
          else if (ch === "{") { k++; lastSig = ch; }
          else if (ch === "}") { if (k === 0 && p === 0 && b === 0) break; k--; lastSig = ch; }
          else if ((ch === "," || ch === ";") && p === 0 && b === 0 && k === 0) { j++; break; }
          else if (ch === "\n" && p === 0 && b === 0 && k === 0) {
            let la = j + 1;
            while (la < nvBase.length && /[ \t\r\n]/.test(nvBase[la])) la++;
            const nextSlice = nvBase.slice(la, la + 2);
            const beforeNl = nvBase.slice(cpm.index + cpm[0].length, j).trimEnd();
            const prevEndsCont =
              beforeNl.length > 0 &&
              (/(?:&&|\|\||\?\?)$/.test(beforeNl) || (/[?:+]$/.test(beforeNl) && !/\+\+$/.test(beforeNl)));
            if (!prevEndsCont && (!/^(?:\?\.|&&|\|\||\?\?|[?:+])/.test(nextSlice) || nextSlice === "?.")) break;
          } else if (!/\s/.test(ch)) lastSig = ch;
          j++;
        }
        maskRangePreservingLines(nvOutChars, cpm.index, j);
        blankCustomPropRe.lastIndex = Math.max(blankCustomPropRe.lastIndex, j);
      }
      nonVars = nvOutChars.join("");
    }
    const styleTagRanges = [];
    if (!isStyle) {
      const twSurfCtx = reflexSurfCtx || (surface === cleanComments ? fullMarkupCtx : scanMarkupContexts(surface, markupOpts));
      for (const blk of extractRealStyleBlocks(surface, twSurfCtx, markupOpts)) {
        styleTagRanges.push([blk.bodyStart, blk.bodyEnd]);
      }
    }
    const twSurface = buildTailwindScanSurfacePreservingLines(surface, isStyle, markupOpts, styleTagRanges);
    const twArbColorRe = new RegExp(
      `(?<=^|[\\s"'\`:!])(${TW_ARB_COLOR_PREFIX_RE}-\\[(?:color:)?(?:#[^\\]\\s]+|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color-mix|color|light-dark)\\([^\\]\\s]+\\))\\]!?|\\[(?:color|background-color|background|border-color|outline-color|fill|stroke|accent-color|caret-color):(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color-mix|color|light-dark)\\([^\\]\\s]+\\))\\]!?)`,
      "g"
    );
    const twArbSpaceRe =
      /(?<=^|[\s"'`:!])(-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded(?:-[a-z]+)?|(?:min-|max-)?(?:w|h|size)|inset(?:-[xy])?|top|right|bottom|left|start|end)-\[-?\d+(?:\.\d+)?px\]!?|\[(?:padding|margin|gap|row-gap|column-gap|width|height|min-width|max-width|min-height|max-height|inset|top|right|bottom|left|border-radius)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?:\s*-?\d+(?:\.\d+)?px\]!?)/g;
    const nonTwChars = nonVars.split("");
    for (const m of twSurface.matchAll(twArbColorRe)) {
      maskRangePreservingLines(nonTwChars, m.index, m.index + m[0].length);
    }
    const nonTwHex = nonTwChars.join("");
    const maskCssUrlsAndHeaders = (cssStr, maskHeaders = true) => {
      const chars = cssStr.split("");
      for (const um of cssStr.matchAll(/\burl\(\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^)]*)\)/gi)) {
        maskRangePreservingLines(chars, um.index, um.index + um[0].length);
      }
      if (maskHeaders) {
        let hStart = 0;
        let q = null;
        let interpDepth = 0;
        for (let i = 0; i < cssStr.length; i++) {
          const c = cssStr[i];
          if (q) {
            if (c === "\\" && i + 1 < cssStr.length) {
              i++;
              continue;
            }
            if (c === q || c === "\n") q = null;
            continue;
          }
          if (c === "\\" && i + 1 < cssStr.length) {
            i++;
            continue;
          }
          if (c === '"' || c === "'") {
            q = c;
            continue;
          }
          if (c === "{") {
            if (interpDepth > 0 || (i > 0 && cssStr[i - 1] === "#")) {
              interpDepth++;
            } else {
              const hdr = cssStr.slice(hStart, i);
              if (hdr.includes("#")) maskRangePreservingLines(chars, hStart, i);
              hStart = i + 1;
            }
          } else if (c === ";") {
            if (interpDepth === 0) hStart = i + 1;
          } else if (c === "}") {
            if (interpDepth > 0) interpDepth--;
            else hStart = i + 1;
          }
        }
      }
      return chars.join("");
    };
    let declColorSurface = "";
    if (isStyle) {
      declColorSurface = maskCssQuotedStringsPreservingLines(maskCssUrlsAndHeaders(nonTwHex, true));
    } else {
      const nonTwCtx = scanMarkupContexts(nonTwHex, markupOpts || {});
      const impStyleOnly = extractImportantStyleSurfacePreservingLines(nonTwHex, false, { ...(markupOpts || {}), markupCtx: nonTwCtx });
      const impChars = maskCssUrlsAndHeaders(impStyleOnly, false).split("");
      for (const sb of extractRealStyleBlocks(nonTwHex, nonTwCtx, markupOpts || {})) {
        const maskedHdrSlice = maskCssUrlsAndHeaders(impStyleOnly.slice(sb.bodyStart, sb.bodyEnd), true);
        for (let k = 0; k < maskedHdrSlice.length && sb.bodyStart + k < sb.bodyEnd; k++) {
          impChars[sb.bodyStart + k] = maskedHdrSlice[k];
        }
      }
      for (const tr of findCssInJsTemplateRanges(nonTwHex, nonTwCtx)) {
        const maskedTplHdr = maskCssUrlsAndHeaders(impStyleOnly.slice(tr.contentStart, tr.contentEnd), true);
        for (let k = 0; k < maskedTplHdr.length && tr.contentStart + k < tr.contentEnd; k++) {
          impChars[tr.contentStart + k] = maskedTplHdr[k];
        }
      }
      declColorSurface = impChars.join("");
    }
    const hexSpansInFile = [];
    for (const m of declColorSurface.matchAll(/(?<=^|[:,\s("'=/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F_-])/g)) {
      hexSpansInFile.push([m.index, m.index + m[0].length]);
      findings.push({
        file: filePath,
        line: offsetToLine(declColorSurface, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded color \`${m[0]}\` outside token block; bind to \`var(--*)\`.`,
      });
    }
    for (const m of findHardcodedColorFunctions(declColorSurface)) {
      if (isTokenizedColorFn(m.text)) continue;
      if (/^color-mix\(/i.test(m.text) && hexSpansInFile.some(([hs, he]) => hs >= m.index && he <= m.index + m.text.length)) {
        continue;
      }
      findings.push({
        file: filePath,
        line: offsetToLine(declColorSurface, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded functional color \`${m.text}\` outside token block; bind to \`var(--*)\`.`,
      });
    }
    const impSurface = extractImportantStyleSurfacePreservingLines(nonVars, isStyle, markupOpts || {});
    for (const m of impSurface.matchAll(/!\s*important\b/gi)) {
      findings.push({
        file: filePath,
        line: offsetToLine(surface, m.index),
        ruleId: "dsaf/important-override",
        tier: "reflex",
        severity: "warning",
        message: "Disallowed `!important` override outside spec rules.",
      });
    }
    for (const m of twSurface.matchAll(twArbColorRe)) {
      findings.push({
        file: filePath,
        line: offsetToLine(twSurface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[1]}\`; bind to theme tokens.`,
      });
    }
    for (const m of twSurface.matchAll(twArbSpaceRe)) {
      findings.push({
        file: filePath,
        line: offsetToLine(twSurface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[1]}\`; bind to theme tokens.`,
      });
    }
  }

  const evaluatedRules = [
    ...(includeFloor
      ? [
          "dsaf/no-transition-all",
          "dsaf/no-layout-transition",
          "dsaf/no-100vw",
          "dsaf/no-outline-none-naked",
          "dsaf/no-autoplay-unmuted",
          "dsaf/no-hidden-at-rest",
        ]
      : []),
    ...(includeReflex ? ["dsaf/hardcoded-color", "dsaf/important-override", "dsaf/tailwind-arbitrary"] : []),
  ];
  const applied = applyIgnores(findings, raw, filePath, {
    reportUnusedIgnores: Boolean(options.reportUnusedIgnores),
    evaluatedRules,
  });
  return { file: filePath, ...applied };
}

export function checkFile(filePath, options = {}) {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`File not found: ${abs}`);
  }
  const raw = readFileSync(abs, "utf8");
  const rel = options.displayPath || filePath;
  const externalCssBlocks =
    Array.isArray(options.externalCssBlocks)
      ? options.externalCssBlocks
      : options.dsCss === false
      ? []
      : discoverExternalDsCss(dirname(abs), options.dsCss ?? []);
  return scanUiContent(raw, rel, { ...options, externalCssBlocks });
}

export function collectUiFiles(targetPath, options = {}) {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) throw new Error(`Target not found: ${abs}`);
  const st = statSync(abs);
  if (st.isFile()) return [{ full: abs, rel: targetPath.replace(/\\/g, "/") }];
  const includeDemos = Boolean(options.includeDemos);

  const out = [];
  const ciFs = process.platform === "darwin" || process.platform === "win32";
  const safeReal = (p) => {
    try {
      return (realpathSync.native || realpathSync)(p);
    } catch {
      return null;
    }
  };
  const rootReal = safeReal(abs) || abs;
  const isInsideRoot = (candidateReal) => {
    if (!candidateReal) return false;
    const relPath = relative(ciFs ? rootReal.toLowerCase() : rootReal, ciFs ? candidateReal.toLowerCase() : candidateReal);
    return relPath === "" || (!(relPath === ".." || relPath.startsWith(`..${sep}`)) && !isAbsolute(relPath));
  };
  const visitedDirs = new Set();
  function walk(dir) {
    const realDir = safeReal(dir);
    if (!isInsideRoot(realDir)) return;
    const visitKey = ciFs ? realDir.toLowerCase() : realDir;
    if (visitedDirs.has(visitKey)) return;
    visitedDirs.add(visitKey);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        if (!isInsideRoot(safeReal(full))) continue;
        try {
          const fst = statSync(full);
          isDir = fst.isDirectory();
          isFile = fst.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!e.name.startsWith(".")) walk(full);
        continue;
      }
      if (!isFile) continue;
      if (UI_EXTS.has(extname(e.name).toLowerCase())) {
        const rel = relative(abs, full).replace(/\\/g, "/");
        const skipDemoDirs = includeDemos ? "" : "|demos?|demo\\d+|examples?|samples?";
        const skipRe = new RegExp(
          `(\\.test\\.|\\.spec\\.|__tests__\\/|(?:^|\\/)(?:tests?|fixtures|__fixtures__|storybook-static|_audit|_vendor${skipDemoDirs}|ios\\/App\\/App\\/public|android\\/app\\/src\\/main\\/assets\\/public|src-tauri\\/target)\\/|\\.min\\.(?:css|js)$|\\.bundle\\.(?:css|js|mjs)$)`,
          "i"
        );
        if (!skipRe.test(rel)) {
          out.push({ full, rel });
        }
      }
    }
  }
  walk(abs);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function runHookStdin(rawStdin, options = {}) {
  if (
    (typeof options.dsCss === "string" && options.dsCss.trim().length > 0) ||
    (Array.isArray(options.dsCss) && options.dsCss.length > 0)
  ) {
    discoverExternalDsCss(process.cwd(), options.dsCss);
  }
  if (!rawStdin || !rawStdin.trim()) return {};
  let payload;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    return {};
  }
  const rawFilePath = payload?.tool_input?.file_path || payload?.file_path;
  if (typeof rawFilePath !== "string" || !rawFilePath) return {};
  const filePath = payload?.cwd ? resolve(String(payload.cwd), rawFilePath) : resolve(rawFilePath);
  if (!UI_EXTS.has(extname(filePath).toLowerCase()) || !existsSync(filePath)) return {};
  let isRegular = false;
  try {
    isRegular = statSync(filePath).isFile();
  } catch {
    return {};
  }
  if (!isRegular) return {};

  let res;
  try {
    res = checkFile(filePath, {
      tier: options.tier || "floor",
      displayPath: basename(filePath),
      reportUnusedIgnores: Boolean(options.reportUnusedIgnores),
      dsCss: options.dsCss,
    });
  } catch {
    return {};
  }
  const optTier = String(options.tier || "floor").toLowerCase();
  const blocking = res.active.filter((f) =>
    optTier === "all" ? f.tier === "floor" || f.tier === "reflex" : optTier === "reflex" ? f.tier === "reflex" : f.tier === "floor"
  );
  if (blocking.length === 0) return {};

  const lines = blocking.slice(0, 10).map((f) => `- [${f.tier.toUpperCase()}] ${f.ruleId} (line ${f.line}): ${f.message}`);
  const more = blocking.length > 10 ? `\n  (+${blocking.length - 10} more)` : "";
  const hasFloor = blocking.some((f) => f.tier === "floor");
  const advice = hasFloor
    ? "Fix Floor violations before finishing (Floor rules cannot be waived)."
    : "Resolve or document Reflex warnings with concrete dsaf-ignore rationale.";
  const tierLabel = optTier === "all" ? "Floor/Reflex" : optTier === "reflex" ? "Reflex" : "Floor";
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `DSAF edit-time ${tierLabel} check on ${basename(filePath)}: ${blocking.length} finding(s).\n${lines.join("\n")}${more}\n${advice}`,
    },
  };
}

export function installAgentHook({ agent = "claude", dir = ".", local = false } = {}) {
  const projectDir = resolve(dir);
  const scriptPath = fileURLToPath(import.meta.url);
  const cmd = local ? `node ${JSON.stringify(scriptPath)} stdin` : "npx -y @zintaen/dsaf hook stdin";

  let relTarget;
  if (agent === "claude") relTarget = ".claude/settings.json";
  else if (agent === "cursor") relTarget = ".cursor/hooks.json";
  else if (agent === "codex") relTarget = ".codex/hooks.json";
  else throw new Error(`Unsupported agent '${agent}'. Expected claude, cursor, or codex.`);

  const targetFile = join(projectDir, relTarget);
  assertWritableOutputFile(targetFile, relTarget, { rootDir: projectDir });
  mkdirSync(dirname(targetFile), { recursive: true });
  let cfg = {};
  if (existsSync(targetFile)) {
    const rawCfg = readFileSync(targetFile, "utf8").trim();
    if (rawCfg) {
      try {
        cfg = JSON.parse(rawCfg);
      } catch {
        throw new Error(`Existing ${relTarget} is not valid JSON.`);
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        throw new Error(`Existing ${relTarget} must be a JSON object.`);
      }
    }
  }

  if (!cfg.hooks || typeof cfg.hooks !== "object" || Array.isArray(cfg.hooks)) cfg.hooks = {};
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

    // 3. Clean CSS passes with 0 findings (including @starting-style, skip-link target, sibling :focus-visible & parent :focus-within)
    const cleanCss = join(scratch, "clean.css");
    writeFileSync(
      cleanCss,
      [
        ":root { --accent: #1d4ed8; }",
        ".btn { color: var(--accent); transition: transform 150ms ease; }",
        ".btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
        "#main-content:focus { outline: none; }",
        ".editor { outline: none; }",
        ".editor:focus-visible { outline: 2px solid var(--accent); }",
        ".picker:focus-within { outline: 2px solid var(--accent); }",
        ".picker select:focus { outline: none; }",
        "@starting-style { .reveal { opacity: 0; } }",
      ].join("\n")
    );
    const cleanRes = checkFile(cleanCss, { tier: "all", displayPath: "clean.css" });
    assert.equal(cleanRes.active.length, 0, "Clean CSS + valid focus patterns must pass --tier all cleanly");

    // 3a. Multi-branch comma selectors must satisfy EVERY branch individually
    const mixedCss = join(scratch, "mixed-focus.css");
    writeFileSync(
      mixedCss,
      [
        ".picker:focus-within { outline: 2px solid #1d4ed8; }",
        ".picker select:focus, .orphan-input:focus { outline: none; }",
        ".editor:focus-visible { outline: 2px solid #1d4ed8; }",
        ".editor, .naked-btn { outline: none; }",
        ".box-a:focus-within, .box-b:focus-within { box-shadow: 0 0 0 2px #1d4ed8; }",
        ".box-a input:focus, .box-b input:focus { outline: none; }",
      ].join("\n")
    );
    const mixedRes = checkFile(mixedCss, { tier: "floor", displayPath: "mixed-focus.css" });
    assert.equal(mixedRes.active.length, 2, "Must flag comma selectors where at least one branch lacks focus indicator");

    // 3b. checkTarget must exclude ios/App/App/public, _audit, storybook-static, playwright-report, test-results
    const subProj = join(scratch, "sub-proj");
    mkdirSync(join(subProj, "web/ios/App/App/public/assets"), { recursive: true });
    mkdirSync(join(subProj, "_audit"), { recursive: true });
    mkdirSync(join(subProj, "playwright-report"), { recursive: true });
    mkdirSync(join(subProj, "test-results"), { recursive: true });
    mkdirSync(join(subProj, "web/src"), { recursive: true });
    writeFileSync(join(subProj, "web/ios/App/App/public/assets/index.css"), ".x{transition:all 1s}");
    writeFileSync(join(subProj, "_audit/probe.css"), ".x{transition:all 1s}");
    writeFileSync(join(subProj, "playwright-report/index.html"), "<style>.x{transition:all 1s}</style>");
    writeFileSync(join(subProj, "test-results/trace.css"), ".x{transition:all 1s}");
    writeFileSync(join(subProj, "web/src/ok.css"), ".x{transition:opacity 150ms}");
    assert.equal(checkTarget(subProj, { tier: "floor" }).passed, true, "Must skip built WebView, _audit, playwright-report & test-results");

    // 3c. External DS focus awareness (--ds-css + auto-discovered node_modules/@acme/design/dist/*.css)
    const dsProj = join(scratch, "ds-proj");
    mkdirSync(join(dsProj, "src"), { recursive: true });
    mkdirSync(join(dsProj, "node_modules/@acme/design/dist"), { recursive: true });
    const explicitDs = join(scratch, "explicit-ds.css");
    writeFileSync(
      explicitDs,
      ".ds-field:focus-within { outline: 2px solid #14243D; }\n.ds-combo:has(input:focus-visible) { box-shadow: 0 0 0 2px #F4BA17; }\n"
    );
    writeFileSync(
      join(dsProj, "node_modules/@acme/design/dist/styles.css"),
      ".pkg-field:focus-within { outline: 2px solid #14243D; }\n"
    );
    writeFileSync(
      join(dsProj, "src/app.css"),
      ".ds-field input:focus { outline: none; }\n.ds-combo input:focus { outline: none; }\n.orphan input:focus { outline: none; }\n"
    );
    const explicitRes = checkTarget(join(dsProj, "src"), { tier: "floor", dsCss: [explicitDs] });
    assert.equal(explicitRes.counts.floor, 1, "Explicit --ds-css must satisfy .ds-field & .ds-combo while still flagging .orphan");
    writeFileSync(
      join(dsProj, "src/app.css"),
      ".pkg-field input:focus { outline: none; }\n"
    );
    const autoDsRes = checkTarget(join(dsProj, "src"), { tier: "floor" });
    assert.equal(autoDsRes.counts.floor, 0, "Auto-discovered node_modules/@acme/design/dist/styles.css must satisfy .pkg-field input:focus");

    // 3d. CSS Nesting (&) + :has(> .input:focus-visible) + Base UI [data-highlighted] & popup positioners
    const nestedCss = join(scratch, "nested-baseui.css");
    writeFileSync(
      nestedCss,
      [
        ".cs-input-group {",
        "  border: 1px solid #7d889b;",
        "  &:has(> .cs-input:focus-visible, .cs-multi-input:focus-visible) { outline: 2px solid #14243D; }",
        "  & > .cs-input:focus-visible { outline: none; }",
        "}",
        ".cs-chart-plot {",
        "  & .recharts-surface:focus { outline: none; }",
        "  & .recharts-surface:focus-visible { outline: 2px solid #14243D; }",
        "}",
        ".cs-combobox-positioner { outline: 0; }",
        ".cs-combobox-item {",
        "  outline: 0;",
        "  &[data-highlighted] { background: #eef1f5; }",
        "}",
        ".cs-data-table-scroll { overflow: auto; &:focus-visible { outline: 0; } }",
        ".cs-data-table:has(> .cs-data-table-scroll:focus-visible) { outline: 2px solid #14243D; }",
        ".naked-nested { &:focus { outline: none; } }",
      ].join("\n")
    );
    const nestedRes = checkFile(nestedCss, { tier: "floor", displayPath: "nested-baseui.css" });
    assert.equal(nestedRes.counts.floor, 1, "Must recognize nested :has/:focus-visible & [data-highlighted] while flagging .naked-nested:focus");

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

    // 6. Round 1 regressions: nested outline line offset, --btn-transition / border-width: 100vw,
    // static border / box-shadow: none / outline-0, nested .js .reveal, JSX <video> expressions, --tier=all
    const regHookCss = join(scratch, "reg-hook.css");
    writeFileSync(
      regHookCss,
      [
        ":root { --btn-transition: all; --drawer-width: 100vw; }",
        ".ok-border { border-width: 100vw; }",
        ".js { .reveal { opacity: 0; } }",
        ".btn:focus-visible {\n  & .icon { color: #111; }\n  outline: none;\n}",
        "input { border: 1px solid #ccc; outline: none; }",
        ".ghost:focus { outline: none; box-shadow: none; }",
      ].join("\n")
    );
    const regHookRes = checkFile(regHookCss, { tier: "floor", displayPath: "reg-hook.css" });
    assert.equal(regHookRes.counts.floor, 3, "Must flag nested outline (L6), input border+outline (L7), and ghost box-shadow:none (L8), without FP on custom props/border-width/.js .reveal");
    assert.equal(regHookRes.active[0].line, 6, "Nested rule line number must match actual file line 6");

    const regHookTsx = join(scratch, "reg-hook.tsx");
    writeFileSync(
      regHookTsx,
      [
        `export function V() {`,
        `  return (`,
        `    <div>`,
        `      <video autoPlay={false} src="a.mp4" />`,
        `      <video autoPlay onEnded={() => ok()} muted src="b.mp4" />`,
        `      <video autoPlay muted={false} src="c.mp4" />`,
        `      <button className="border-gray-300 outline-none">A</button>`,
        `      <button className="focus:outline-0">B</button>`,
        `      <button className="hover:bg-[#ef4444]">C</button>`,
        `    </div>`,
        `  );`,
        `}`,
      ].join("\n")
    );
    const regTsxRes = checkFile(regHookTsx, { tier: "all", displayPath: "reg-hook.tsx" });
    assert.equal(regTsxRes.counts.floor, 3, "Must catch muted={false}, border-gray-300+outline-none, and focus:outline-0 without FP on autoPlay={false} or onEnded arrow");
    assert.equal(regTsxRes.counts.reflex, 1, "Must catch hover:bg-[#ef4444] under --tier all");
    assert.equal(parseFlagArgs(["check", ".", "--tier=all"]).flags.tier, "all");
    assert.deepEqual(runHookStdin(JSON.stringify({ tool_input: { file_path: scratch } })), {}, "Directory path in stdin hook must fail open");

    // 7. Round 2 regressions: quoted braces, custom-prop & cascade focus order, outline: 0px, nested :has(:is),
    // BEM --tier all, bare focus-visible:ring, transition-all-fast, url(#fade), Array hooks, bare --sarif validation
    const r2Css = join(scratch, "r2-hook.css");
    writeFileSync(
      r2Css,
      [
        '.badge::after { content: "}"; outline: none; }',
        ".custom-shadow:focus { --btn-box-shadow: 0 2px 4px #000; outline: none; }",
        ".cascade-ok:focus-visible { outline: none; outline: 2px solid var(--ring); }",
        ".cascade-bad:focus-visible { outline: 2px solid var(--ring); outline: none; }",
        ".zero-px:focus-visible { outline: 0px; }",
        ".btn--primary:hover { color: #ff00aa; }",
        ".icon { clip-path: url(#fade); }",
      ].join("\n")
    );
    const r2ExtCss = join(scratch, "r2-ext-ds.css");
    writeFileSync(r2ExtCss, ".ds-nested:has(:is(input, select):focus-visible) { border-color: #14243D; }\n");
    writeFileSync(join(scratch, "r2-nested-consumer.css"), ".ds-nested input:focus-visible { outline: none; }\n");
    assert.equal(
      checkFile(join(scratch, "r2-nested-consumer.css"), { tier: "floor", dsCss: [r2ExtCss] }).counts.floor,
      0,
      "External --ds-css :has(:is(...):focus-visible) must satisfy nested focus wrapper"
    );
    const r2Res = checkFile(r2Css, { tier: "all", displayPath: "r2-hook.css" });
    assert.equal(r2Res.counts.floor, 4, "Quoted brace (L1), custom-prop focus (L2), cascade-bad (L4), and outline: 0px (L5) must all fail while cascade-ok (L3) passes");
    assert.equal(r2Res.counts.reflex, 1, "BEM .btn--primary:hover #ff00aa must be flagged without flagging url(#fade)");

    const r2Tsx = join(scratch, "r2-hook.tsx");
    writeFileSync(
      r2Tsx,
      [
        `<button className="outline-none focus-visible:ring">Ring</button>`,
        `<div className="transition-all-fast" />`,
        `<div className="\ntransition-all\n" />`,
      ].join("\n")
    );
    const r2TsxRes = checkFile(r2Tsx, { tier: "all", displayPath: "r2-hook.tsx" });
    assert.equal(r2TsxRes.counts.floor, 1, "Only exact transition-all on L4 must trigger; bare focus-visible:ring and transition-all-fast must pass");
    assert.equal(r2TsxRes.active[0].line, 4, "Tailwind transition-all after leading newline must report line 4");
    assert.throws(() => parseFlagArgs(["check", ".", "--sarif"]), /--sarif/);
    const arrHookProj = join(scratch, "arr-hook-proj");
    mkdirSync(join(arrHookProj, ".claude"), { recursive: true });
    writeFileSync(join(arrHookProj, ".claude/settings.json"), JSON.stringify({ hooks: [] }));
    installAgentHook({ agent: "claude", dir: arrHookProj });
    assert.ok(Array.isArray(JSON.parse(readFileSync(join(arrHookProj, ".claude/settings.json"), "utf8")).hooks.PostToolUse));

    // 8. Round 3 regressions: outline shorthand/outline-color, quoted video attrs, &--primary, multiline transition,
    // reveal variants, template className, skips/has boundary, quoted header/url("#fade"), single-file SARIF path
    const r3HookDir = join(scratch, "r3-hook/sub");
    mkdirSync(join(r3HookDir, "../src"), { recursive: true });
    mkdirSync(join(scratch, "r3-hook/dsaf-audit-output"), { recursive: true });
    writeFileSync(join(scratch, "r3-hook/dsaf-audit-output/skip.css"), ".bad { transition: all 200ms; }\n");
    const r3Css = join(scratch, "r3-hook/src/r3.css");
    writeFileSync(
      r3Css,
      [
        ".a:focus-visible { outline: 0 none; }",
        ".b:focus-visible { outline: 0 solid transparent; }",
        ".c:focus-visible { outline: none; outline-color: var(--ring); }",
        ".d:focus-visible { outline: none; outline-style: solid; outline-color: var(--ring); }",
        ".mt { transition: opacity 150ms ease,\n  width 200ms ease; }",
        '[data-reveal="up"] { opacity: 0; }',
        "section.reveal { opacity: 0 !important; }",
        "main:focus button { outline: none; }",
        "#app:focus-within { outline: none; }",
        ".card:has(.input-icon:focus-visible) { outline: 2px solid blue; }",
        ".input:focus-visible { outline: none; }",
        '.btn { &--primary:hover { color: #ff00aa; } }',
        '.icon { clip-path: url("#fade"); }',
        '.bg { background: #123456 url("x-{1}.png"); }',
        '#feed[data-x="a;b"] { color: var(--ink); }',
      ].join("\n")
    );
    const r3HookCssRes = checkFile(r3Css, { tier: "all", displayPath: "src/r3.css" });
    assert.equal(r3HookCssRes.counts.floor, 9, "Must catch compound 0 none, 0 transparent, outline-color without style, multiline width transition, both reveals, main:focus button, #app:focus-within, unrelated :has");
    assert.equal(r3HookCssRes.active.filter((f) => f.ruleId === "dsaf/hardcoded-color").length, 2, "Must catch &--primary #ff00aa and url({) #123456 while skipping url(#fade) & #feed[data-x]");
    assert.ok(!r3HookCssRes.active.some((f) => /#feed|#fade/i.test(f.message)), "Must not flag url(#fade) or #feed");
    const r3Tsx = join(scratch, "r3-hook/src/r3.tsx");
    writeFileSync(
      r3Tsx,
      [
        `<video src="/videos/autoplay-hero.mp4"></video>`,
        `<video autoplay poster="/img/muted.jpg" src="a.mp4"></video>`,
        "<button className={`px-4\noutline-none`}>Go</button>",
      ].join("\n")
    );
    const r3HookTsxRes = checkFile(r3Tsx, { tier: "all", displayPath: "src/r3.tsx" });
    assert.equal(r3HookTsxRes.counts.floor, 2);
    assert.equal(r3HookTsxRes.active.find((f) => f.ruleId === "dsaf/no-outline-none-naked")?.line, 4);
    assert.equal(checkTarget(join(scratch, "r3-hook")).filesScanned, 2, "Must skip dsaf-audit-output");

    // 9. Round 4 regressions: :has() tag boundary, template/quoted className & offset/transparent TW, outline-style/width/transparent & reverse order,
    // nested color-mix, <video> JSX expr strings, .transition:not(.all) vs @apply & !tw, url("/icons/#fade"), .js-animate.reveal
    const r4CleanCss = [
      '.transition:not(.all):has(.top) { opacity: 1; }',
      '.cm:focus-within { outline: 2px solid color-mix(in oklch, var(--accent), transparent 20%); }',
      '.cm input:focus { outline: none; }',
      '.hcm:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 2px var(--ring); }',
      '.icon { background: url("/icons/#fade"); }',
      '.js .reveal-ok { opacity: 0; }',
    ].join("\n");
    const r4CleanRes = scanUiContent(r4CleanCss, "clean.css", { tier: "all" });
    assert.equal(r4CleanRes.counts.floor + r4CleanRes.counts.reflex, 0, "Nested color-mix, Windows HCM, .transition selector, url(/icons/#fade), and .js .reveal-ok must pass");

    const r4DirtyCss = [
      '.field:has(textarea:focus-visible) { outline: 2px solid #14243D; }',
      'a:focus { outline: none; }',
      '.card:has(.icon-button:focus-visible) { outline: 2px solid #14243D; }',
      'button:focus { outline: none; }',
      '.s1:focus-visible { outline-style: none; }',
      '.s2:focus-visible { outline-width: 0; }',
      '.s3:focus-visible { outline: 2px solid transparent; }',
      '.rev:focus-visible { outline: 2px solid blue; }',
      '.rev:focus { outline: none; }',
      '.app { @apply !transition-all !w-[100vw] outline-none; }',
      '.js-animate.reveal { opacity: 0; }',
      '.js .ok, .reveal-bad[data-reveal] { opacity: 0; }',
    ].join("\n");
    const r4DirtyRes = scanUiContent(r4DirtyCss, "dirty.css");
    assert.equal(r4DirtyRes.counts.floor, 11, "Must catch :has suffix slips, outline-style/width/transparent, reverse :focus order, @apply 3 Floor issues, and reveal edge cases");

    const r4Tsx = [
      '<button className={`px-4 ${active ? "bg-blue" : ""} outline-none`}>Go</button>',
      "<button className=\"before:content-['*'] outline-none\">Go</button>",
      '<button className="outline-none focus-visible:ring-offset-2">A</button>',
      '<button className="outline-none focus-visible:outline-offset-2">B</button>',
      '<button className="outline-none focus-visible:ring-transparent">C</button>',
      '<div className="!transition-all !w-[100vw] !outline-none" />',
      '<video aria-label={`Enable autoplay in settings`} src="a.mp4" />',
      '<video autoPlay aria-label={`Video muted by default`} src="b.mp4" />',
    ].join("\n");
    const r4TsxRes = scanUiContent(r4Tsx, "App.tsx");
    assert.equal(r4TsxRes.counts.floor, 9, "Must catch template/quoted className, non-visible ring/outline offset/transparent, !tw utilities, and JSX video expr masking");

    // 10. Round 5 regressions: focus-gated box-shadow, independent outline longhands, reordered outline & transparent color,
    // !important sibling override, bare-tag :has() safety boundary, <style> @apply non-duplication, cn()/variants/outline-hidden/! tw,
    // SCSS $vars, negative/! tw spacing, multiline CSS custom properties
    const r5CssBad = [
      "button { box-shadow: 0 1px 3px rgba(0,0,0,0.12); outline: none; }",
      ".a:focus-visible { outline-style: none; outline-color: var(--ring); }",
      ".b:focus-visible { outline-width: 0; outline-style: solid; }",
      ".c:focus-visible { outline-width: 0; outline-color: var(--ring); }",
      ".d:focus-visible { outline-color: transparent; outline-style: solid; }",
      ".e:focus-visible { outline: 0; outline-style: solid; }",
      ".f:focus-visible { outline-color: transparent; }",
      ".g:focus-visible { outline: 2px none #1d4ed8; }",
      ".h:focus-visible { outline: solid 0; }",
      ".imp { outline: none !important; }",
      ".imp:focus-visible { outline: 2px solid blue; }",
      ".ds-combo:has(input:focus-visible) { outline: 2px solid blue; }",
      "input:focus { outline: none; }",
    ].join("\n");
    assert.equal(scanUiContent(r5CssBad, "r5bad.css").counts.floor, 11, "Must catch static box-shadow, longhand/reordered outline, !important sibling override, and bare input:focus");

    const r5CssCleanFloor = [
      ".ok-imp { outline: none !important; }",
      ".ok-imp:focus-visible { outline: 2px solid blue !important; }",
    ].join("\n");
    assert.equal(scanUiContent(r5CssCleanFloor, "r5clean-imp.scss").counts.floor, 0);

    const r5ScssClean = ".scss-ok { $transition: all; $width: 100vw; $outline: none; --card-shadow:\n  0 2px 8px #111111; box-shadow: var(--card-shadow); }\n";
    assert.equal(scanUiContent(r5ScssClean, "r5clean.scss", { tier: "all" }).counts.floor, 0);
    assert.equal(scanUiContent(r5ScssClean, "r5clean.scss", { tier: "all" }).counts.reflex, 0);

    const r5Vue = "<style>\n.card { @apply transition-all w-[100vw] md:transition-all sm:w-[100vw]; }\n</style>\n";
    assert.equal(scanUiContent(r5Vue, "Comp.vue").counts.floor, 4, "Must scan <style> @apply once without duplicate HTML scan");

    const r5Tsx = [
      '<button className={cn("px-4 outline-none", active && "bg-blue-500")}>Go</button>',
      '<button className="dark:outline-none">C</button>',
      '<button className="md:focus:outline-none">D</button>',
      '<button className="outline-none focus-visible:outline-hidden">A</button>',
      '<button className="focus:outline-2 focus-visible:outline-none">B</button>',
      '<button className="outline-none!">E</button>',
      '<div className="!bg-[#ef4444] !p-[13px] -mt-[13px]" />',
    ].join("\n");
    const r5TsxRes = scanUiContent(r5Tsx, "R5.tsx", { tier: "all" });
    assert.equal(r5TsxRes.counts.floor, 6, "Must catch cn(), variant prefixes, outline-hidden, focus-visible conflict, and trailing !");
    assert.equal(r5TsxRes.counts.reflex, 3, "Must catch !bg-[#...], !p-[13px], and -mt-[13px]");

    // 11. Round 6 regressions: SCSS #{} selector & gradient hex, sibling focus-visible missing width/style, descendant .popup button:focus,
    // conditional variant dark:focus-visible:ring-2, nested-bracket arbitrary variant, className concat/cn sibling, var(--dur_all), evaluatedRules
    const r6CssBad = [
      ".btn { outline: none; } .btn:focus-visible { outline-color: var(--ring); }",
      ".btn2 { outline: 0; } .btn2:focus-visible { outline-style: solid; }",
      ".ok-sub:focus { outline: none; } .ok-sub:focus-visible { outline: 2px solid var(--ring); }",
      ".popup button:focus { outline: none; }",
      ".listbox > a:focus { outline: none; }",
      ".popup:focus { outline: none; }",
      ".t-var { transition: var(--dur_all) var(--nav_left) ease; }",
      ".btn-#{$variant}:focus { outline: none; }",
      ".grad { background: linear-gradient(#ff00aa, #{$end}); }",
      "/* dsaf-ignore dsaf/off-grid-spacing -- optical nudge measured by audit-tokens */",
      ".ok { margin: 13px; }",
    ].join("\n");
    const r6CssRes = scanUiContent(r6CssBad, "r6.scss", { tier: "all", reportUnusedIgnores: true });
    assert.equal(r6CssRes.counts.floor, 5, "Must catch missing outline width/style in sibling, .popup button, .listbox > a, and SCSS #{variant}:focus while keeping var(--dur_all) and .popup:focus safe");
    assert.equal(r6CssRes.counts.reflex, 1, "linear-gradient(#ff00aa, #{$end}) must flag #ff00aa");
    assert.equal(r6CssRes.unusedIgnores.length, 0, "dsaf-hook must not flag dsaf/off-grid-spacing as unused-ignore");
    assert.equal(
      scanUiContent("/* dsaf-ignore dsaf/important-override -- host theme */ .a { color: #ff00aa !important; }\n", "w.css", { tier: "floor", reportUnusedIgnores: true }).unusedIgnores.length,
      0,
      "--tier floor must not flag Reflex dsaf-ignore as unused"
    );

    const r6Tsx = [
      '<button className={"px-4 outline-none " + extra}>A</button>',
      '<button className={`px-4 outline-none ` + extra}>B</button>',
      '<button className={cn("inline-flex outline-none", "focus-visible:ring-2 focus-visible:ring-offset-2", extra)}>C</button>',
      '<button className={cn("outline-none", active && "focus-visible:ring-2")}>D</button>',
      '<button className="outline-none dark:focus-visible:ring-2">E</button>',
      '<button className="[&[data-state=open]]:outline-none">F</button>',
      '<div className="hover:[&[data-state=open]]:transition-all" />',
      '<button className="dark:outline-none dark:focus-visible:ring-2">G</button>',
    ].join("\n");
    const r6TsxRes = scanUiContent(r6Tsx, "R6.tsx", { tier: "all" });
    assert.equal(r6TsxRes.counts.floor, 6, "Must catch concat/conditional cn/conditional replacement/nested-bracket variants while allowing paired cn() and matching dark: variants");

    // Round 7 regressions: container/modifier/important TW variants, operator precedence, Vue :class & :muted, Svelte {muted},
    // :has() direct vs descendant, sibling combinators, sibling @apply & :focus-visible { @apply ring-2 }, scoped !important
    const r7SafeTsx = [
      '<button className="outline-none !focus-visible:ring-2">@Important</button>',
      '<button className="group-hover/item:outline-none group-hover/item:focus-visible:ring-2">Group</button>',
      '<div className="@md:w-full">Safe</div>',
      '<div :class="[\'px-4 outline-none\', \'focus-visible:ring-2\']">VueSafe</div>',
      '<video autoplay :muted="true" />',
      '<video :autoplay="false" />',
      '<video autoplay {muted} />',
      'const visible = !important; export const C = () => <div aria-hidden={!important} style={{ color: "var(--fg)" }}>ok</div>;',
    ].join("\n");
    const r7SafeTsxRes = scanUiContent(r7SafeTsx, "R7Safe.tsx", { tier: "all" });
    assert.equal(r7SafeTsxRes.counts.floor, 0, "Safe R7 TSX/Vue/Svelte patterns must have 0 Floor issues");
    assert.equal(r7SafeTsxRes.counts.reflex, 0, "Boolean !important in JS must produce 0 Reflex !important issues");

    const r7BadTsx = [
      '<button className={ok ? "outline-none" : "a" + " focus-visible:ring-2"}>Precedence</button>',
      '<button :class="ok ? \'outline-none\' : \'focus-visible:ring-2\'">VueBad</button>',
      '<video autoplay :muted="false" />',
      '<div className="hover:group-hover/item:outline-none" />',
      '<div style={{ color: "red !important" }} />',
    ].join("\n");
    const r7BadTsxRes = scanUiContent(r7BadTsx, "R7Bad.tsx", { tier: "all" });
    assert.equal(r7BadTsxRes.counts.floor, 4, "Must catch operator precedence, Vue conditional :class, :muted=\"false\", and slash-variant outline-none");
    assert.equal(r7BadTsxRes.counts.reflex, 1, "Must still catch !important inside JSX style={{...}}");

    const r7SafeCss = [
      ".app-safe { @apply @md:transition-colors @[600px]:w-full; }",
      ".app-sib { @apply outline-none; @apply focus-visible:ring-2; }",
      ".fv-app:focus { outline: none; }",
      ".fv-app:focus-visible { @apply ring-2 ring-offset-2; }",
      ".ok-parent .btn:focus { outline: none; }",
      ".ok-parent:focus-within { outline: 2px solid var(--ring); }",
      ".nest { --sh: 0 2px color-mix(in srgb, #123456 50%, var(--a, rgb(1,2,3))); }",
    ].join("\n");
    const r7SafeCssRes = scanUiContent(r7SafeCss, "r7safe.css", { tier: "all" });
    assert.equal(r7SafeCssRes.counts.floor, 0, "Sibling @apply ring-2 and :focus-visible { @apply ring-2 } must be safe");
    assert.equal(r7SafeCssRes.counts.reflex, 0, "Nested-paren custom prop hex must not trigger hardcoded-color");

    const r7BadCss = [
      ".bad-app { @apply @md:transition-all group-hover/item:w-[100vw]; }",
      ".card:focus { outline: none; }",
      ".page:has(.card .input:focus-visible) { outline: 2px solid var(--ring); }",
      ".header + button:focus { outline: none; }",
      ".header:focus-within { outline: 2px solid var(--ring); }",
      ".dark-only:focus { outline: none; }",
      ".dark-only:focus-visible { @apply dark:ring-2; }",
    ].join("\n");
    const r7BadCssRes = scanUiContent(r7BadCss, "r7bad.css", { tier: "all" });
    assert.equal(r7BadCssRes.counts.floor, 5, "Must flag @md:transition-all, group-hover/item:w-[100vw], indirect :has(.card .input:focus-visible), sibling .header + button:focus, and dark-only @apply ring-2");

    // Round 8 regressions: scoped :has() subject check, base descendant :focus-within, @apply outline pairing/importance,
    // quoted data-[state='open'], :focus:hover sibling, template ${cn(...)} unconditional args
    const r8Safe = [
      '<button className="data-[state=\'open\']:outline-none data-[state=\'open\']:focus-visible:ring-2">Q</button>',
      '<button className={`${cn("outline-none", "focus-visible:ring-2")}`}>Tpl</button>',
    ].join("\n");
    assert.equal(scanUiContent(r8Safe, "R8Safe.tsx", { tier: "all" }).counts.floor, 0);

    const r8BadTsx = [
      '<button className="data-[state=\'open\']:outline-none">BadQuote</button>',
      '<button className={`${ok ? "outline-none" : "focus-visible:ring-2"}`}>TplCond</button>',
    ].join("\n");
    assert.equal(scanUiContent(r8BadTsx, "R8Bad.tsx", { tier: "all" }).counts.floor, 2);

    const r8SafeCss = [
      ".field input { outline: none; }",
      ".field:focus-within { box-shadow: 0 0 0 2px blue; }",
      ".toolbar button:focus { outline: none; }",
      ".toolbar:has(button:focus-visible) { box-shadow: 0 0 0 2px blue; }",
      ".hov:focus:hover { outline: none; }",
      ".hov:focus-visible:hover { outline: 2px solid blue; }",
      ".imp-ring { @apply !outline-none; }",
      ".imp-ring:focus-visible { @apply outline-2 ring-2; }",
      ".v4-bang { @apply !outline-none; }",
      ".v4-bang:focus-visible { @apply outline-2!; }",
      ".ring-in-rule:focus-visible { @apply outline-none ring-2; }",
      ".q-var { @apply data-[state=\"open\"]:transition-colors; }",
    ].join("\n");
    assert.equal(scanUiContent(r8SafeCss, "r8safe.css", { tier: "all" }).counts.floor, 0);

    const r8BadCss = [
      ".toolbar button:focus { outline: none; }",
      ".toolbar:has(input:focus-visible) { box-shadow: 0 0 0 2px blue; }",
      ".a { @apply focus:outline-2 focus-visible:outline-none; }",
      ".b:focus-visible { @apply outline-2 outline-none; }",
      ".c { @apply !outline-none; }",
      ".c:focus-visible { outline: 2px solid blue; }",
      ".d { @apply outline-none; }",
      ".d:focus-visible { outline-color: var(--ring); }",
      '.bad-tw { @apply data-[state="open"]:transition-all; }',
    ].join("\n");
    assert.equal(scanUiContent(r8BadCss, "r8bad.css", { tier: "all" }).counts.floor, 6);

    // Round 9 regressions (R9-A2-03, R9-A2-06, R9-A2-07, R9-A2-08, R9-A2-09, R9-A2-15):
    // @apply cascade/sibling order, HTML fragment string before real JSX button, nested @keyframes,
    // :not(:focus-visible), multi-modifier focus-visible:dark:ring-2, escaped newline in template expr, data-style exclusion
    const r9BadCss = [
      ".a:focus-visible { outline: 2px solid var(--ring); }",
      ".a { @apply focus-visible:outline-none; }",
      ".b:focus-visible { outline: 2px solid var(--ring); }",
      ".b { @apply focus:outline-none; }",
      ".c { @apply focus-visible:outline-none; }",
      ".c:focus-visible { outline-color: var(--ring); }",
      ".d:focus-visible { outline: 2px solid var(--ring); @apply outline-none; }",
    ].join("\n");
    assert.equal(scanUiContent(r9BadCss, "r9bad.css", { tier: "all" }).counts.floor, 4, "All 4 @apply cascade/sibling override cases must fail Floor");

    const r9SafeCss = [
      ".reveal { @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } }",
      ".btn:not(:focus-visible) { outline: none; }",
      ".e:focus-visible { @apply outline-none; outline: 2px solid var(--ring); }",
    ].join("\n");
    assert.equal(scanUiContent(r9SafeCss, "r9safe.scss", { tier: "all" }).counts.floor, 0, "Nested @keyframes, :not(:focus-visible), and later CSS outline override must pass");

    const r9FragTsx = [
      "const tag = '<div class=\"';",
      "export const B = () => <button className=\"outline-none\">Go</button>;",
      '<button className="dark:outline-none focus-visible:dark:ring-2">Ok</button>',
      '<div data-style="color: #ff00aa !important" />',
      'export const Tpl = () => <button className={`${"a\\\nb"} outline-none`}>Tpl</button>;',
    ].join("\n");
    const r9FragRes = scanUiContent(r9FragTsx, "r9.tsx", { tier: "all" });
    assert.equal(r9FragRes.counts.floor, 2, "Must catch real outline-none after JS HTML fragment and multiline escaped template continuation");
    assert.equal(r9FragRes.counts.reflex, 0, "data-style !important must not trigger");
    const r9TplAttrs = extractClassAttributes('const x = <button className={`${"a\\\nb"} outline-none`}>T</button>;');
    assert.equal(r9TplAttrs.length, 2, "Template wrapper + nested expr literal produce 2 spans");
    assert.equal(r9TplAttrs[0].content.split("\n").length, 2, "Escaped newline inside template expr must preserve line count");

    // Round 10 regressions (R10-A2-03..06, R10-A2-11): focus-visible:!ring-2, @apply focus-visible:outline-none + resting outline:,
    // !outline-none / outline-none! vs focus-visible:outline-2, *: / **: child/descendant variants,
    // Svelte conditional class="{...}", multiline template HTML fragment, data-class exclusion, ancestor :not(:focus-visible)
    const r10SafeCss = ".btn { outline: none; @apply focus-visible:!ring-2; }\n";
    assert.equal(scanUiContent(r10SafeCss, "r10safe.css", { tier: "all" }).counts.floor, 0, "focus-visible:!ring-2 must cover outline: none");

    const r10BadCss = [
      ".a { @apply focus-visible:outline-none; outline: 2px solid var(--ring); }",
      ".b { @apply focus:outline-none; outline: 2px solid var(--ring); }",
      ".c { @apply !outline-none focus-visible:outline-2; }",
      ".d { @apply *:transition-all *:w-[100vw] *:outline-none; }",
      ".nav:not(:focus-visible) a:focus { outline: none; }",
    ].join("\n");
    assert.equal(
      scanUiContent(r10BadCss, "r10bad.css", { tier: "all" }).counts.floor,
      7,
      "Must flag @apply focus-visible/focus outline-none beating resting outline, !important @apply outline-none, *: variants, and ancestor :not(:focus-visible)"
    );

    const r10Markup = [
      '<button class="px-4 outline-none {active ? \'focus-visible:ring-2\' : \'\'}">SvelteMix</button>',
      '<button class="{ok ? \'outline-none\' : \'focus-visible:ring-2\'}">SvelteTernary</button>',
      '<div className="*:outline-none" />',
      '<div className="**:outline-none" />',
      '<button className="!outline-none focus-visible:outline-2">Imp1</button>',
      '<button className="outline-none! focus-visible:outline-2">Imp2</button>',
      '<div data-class="outline-none">Meta</div>',
      "const htmlFrag = `\n  <div class=\"\n`;\nexport const RealBtn = () => <button className=\"outline-none\">Go</button>;",
    ].join("\n");
    assert.equal(
      scanUiContent(r10Markup, "R10.tsx", { tier: "all" }).counts.floor,
      7,
      "Must catch Svelte dynamic class= mixes, */** variants, !outline-none/outline-none!, and multiline template fragment recovery while ignoring data-class="
    );
    assert.equal(
      scanUiContent('<div data-class="outline-none">Meta</div>', "DataClass.tsx", { tier: "all" }).counts.floor,
      0,
      "data-class must not trigger outline-none"
    );

    // Round 11 regressions (R11-A2-02..05, R11-A2-10..12, R11-A2-21):
    assert.equal(scanUiContent('<button className="outline-none! focus-visible:outline-2!">Go</button>', "A.tsx").counts.floor, 0);
    assert.equal(scanUiContent('.btn { @apply !outline-none focus-visible:outline-2!; }', "a.css").counts.floor, 0);
    for (const zeroRep of ["focus-visible:ring-[0px]", "focus-visible:ring-inset", "focus-visible:outline-[0px]", "focus-visible:outline-[none]"]) {
      assert.equal(analyzeTailwindOutline(`outline-none ${zeroRep}`).naked, true, `${zeroRep} must remain naked`);
    }
    assert.equal(analyzeTailwindOutline("*:outline-none focus-visible:ring-2").naked, true);
    assert.equal(analyzeTailwindOutline("**:outline-none focus-visible:ring-2").naked, true);
    assert.equal(analyzeTailwindOutline("[&_button]:outline-none focus-visible:ring-2").naked, true);
    assert.equal(analyzeTailwindOutline("focus-within:ring-2 *:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("has-[:focus-visible]:ring-2 *:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("not-focus-visible:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("focus:not-focus-visible:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("[&:not(:focus-visible)]:outline-none").naked, false);
    assert.equal(scanUiContent('<button className={["px-4", "outline-none", "focus-visible:ring-2"].filter(Boolean).join(" ")}>Go</button>', "A.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button className={["px-4", "outline-none", "focus-visible:ring-2"].join(" ")}>Go</button>', "A.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button class:list={["px-4 outline-none", { active }]}>Go</button>', "Btn.astro").counts.floor, 1);
    assert.equal(scanUiContent('<button class:outline-none={isFlat}>Go</button>', "Btn.svelte").counts.floor, 1);
    assert.equal(scanUiContent('<button class="focus-visible:ring-2" class:outline-none={isFlat}>Go</button>', "BtnOk.svelte").counts.floor, 0);
    assert.equal(scanUiContent('<button class={active ? "focus-visible:ring-2" : ""} class:outline-none={isFlat}>Go</button>', "BtnCond.svelte").counts.floor, 1);
    assert.equal(scanUiContent(".nav:not(:focus-visible) a { border: 1px solid #ccc; outline: none; }", "a.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus-visible { outline: transparent; outline-color: var(--ring); }", "a.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus-visible { @apply outline-none outline-2; }", "a.css").counts.floor, 0);
    assert.equal(scanUiContent(".btn:focus-visible { @apply outline-2 outline-none; }", "a.css").counts.floor, 1);
    assert.equal(scanUiContent(".card > button:focus { outline: none; }\n.card>button:focus-visible { outline: 2px solid var(--ring); }\n", "a.css").counts.floor, 0);

    // Round 12 regressions (R12-A2-01..06, R12-A2-08..10, R12-A2-13, R12-A2-14, R12-A2-17, R12-A2-18):
    assert.equal(
      scanUiContent(".nav:not(:focus-visible) a { outline: none; }\n.nav:not(:focus-visible) a:focus-visible { outline: 2px solid var(--ring); }", "r12.css").counts.floor,
      0
    );
    assert.equal(scanUiContent(".btn:focus-visible { outline: 2px #1d4ed8; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn { outline: none; }\n.btn:focus-visible { outline: 2px; }", "r12.css").counts.floor, 2);
    assert.equal(scanUiContent(".btn { outline: none; }\n.btn:focus-visible { outline: 2px; }", "r12.css").counts.floor > 0, true);
    assert.equal(scanUiContent(".btn:focus-visible { outline: 2px; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus-visible { outline: #1d4ed8; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus-visible { outline: var(--ring); }", "r12.css").counts.floor, 0);
    assert.equal(scanUiContent(".card, .btn:focus { border: 1px solid #ccc; outline: none; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".card { outline: none; @apply *:focus-visible:ring-2; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".card:focus-visible { outline: none; @apply *:outline-2; }", "r12.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus { outline: none; border: 1px solid #000; border-style: none; }", "r12.css").counts.floor, 1);
    assert.equal(analyzeTailwindOutline("outline-none has-[:focus-visible]:ring-2").naked, true);
    assert.equal(analyzeTailwindOutline("has-[input:focus-visible]:ring-2 [&_button]:outline-none").naked, true);
    assert.equal(analyzeTailwindOutline("has-[button:focus-visible]:ring-2 [&_button]:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("has-[input:focus-visible]:ring-2 *:outline-none").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:border-[0px]").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:border-hidden").naked, true);
    assert.equal(analyzeTailwindOutline("outline-[0px]").naked, true);
    assert.equal(analyzeTailwindOutline("outline-[none]").naked, true);
    assert.equal(
      scanUiContent(".btn:focus { outline: none; }\n@media (prefers-color-scheme: dark) { .btn:focus-visible { outline: 2px solid #93c5fd; } }", "r12.css").counts.floor,
      1
    );
    assert.equal(
      scanUiContent(".btn:focus { outline: none; }\n@media (min-width: 1024px) { .btn:focus-visible { outline: 2px solid var(--ring); } }", "r12.css").counts.floor,
      1
    );
    assert.equal(
      scanUiContent("const Box = styled.div`transition: all 200ms; width: 100vw; &:focus { outline: none; }`;", "Box.tsx").counts.floor,
      3
    );
    assert.equal(
      scanUiContent("const SafeBox = styled.div`transition: opacity 200ms; width: 100%; &:focus { outline: none; } &:focus-visible { outline: 2px solid var(--ring); }`;", "Safe.tsx").counts.floor,
      0
    );
    assert.equal(scanUiContent('<div style="transition: all 200ms; width: 100vw; outline: none;">Hi</div>', "a.html").counts.floor, 3);
    assert.equal(scanUiContent('export const A = () => <div style={{ transition: "all 200ms", width: "100vw", outline: "none" }} />;', "A.tsx").counts.floor, 3);
    assert.equal(scanUiContent('<video autoplay bind:muted src="clip.mp4"></video>', "V.svelte").counts.floor, 0);
    assert.deepEqual(
      analyzeTailwindOutline("[&_button]:outline-none outline-none").uncovered.map((u) => u.tokStr),
      ["[&_button]:outline-none", "outline-none"]
    );
    assert.equal(
      scanUiContent(".before\\:content-\\[\\'\\*\\'\\]:focus { outline: none; transition: all 200ms; }\n:not(.js) .reveal { opacity: 0; }", "r12.css").counts.floor,
      3
    );
    assert.equal(scanUiContent('export const B = ({ ok }: any) => <button className={ok ? cn("outline-none", "focus-visible:ring-2") : "px-4"}>Go</button>;', "B.tsx").counts.floor, 0);
    assert.equal(scanUiContent('export const B = ({ ok }: any) => <button className={cn("px-4", ok && cn("outline-none", "focus-visible:ring-2"))}>Go</button>;', "B.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button class="focus-visible:ring-2" disabled={count < 5} class:outline-none={isFlat}>Go</button>', "Btn.svelte").counts.floor, 0);
    assert.equal(scanUiContent('<template><div :style="{ color: flag ? --retries : \'red !important\' }" /></template>', "V.vue", { tier: "all" }).counts.reflex, 1);
    assert.equal(scanUiContent('<div className="border-b-[#ff00aa] divide-[#123456] shadow-[#112233] caret-[#445566]" />', "Tw.tsx", { tier: "all" }).counts.reflex, 4);

    const r12BrokenSymDir = join(scratch, "r12-broken-sym");
    mkdirSync(join(r12BrokenSymDir, "src"), { recursive: true });
    writeFileSync(join(r12BrokenSymDir, "src/ok.css"), ".a { transition: all 200ms; }\n");
    symlinkSync(join(r12BrokenSymDir, "src/nonexistent.css"), join(r12BrokenSymDir, "src/broken.css"));
    const r12SymRes = checkTarget(r12BrokenSymDir);
    assert.equal(r12SymRes.counts.floor, 1, "Broken symlink must be skipped gracefully in collectUiFiles");

    // Round 13 regressions (R13-A2-01..05, R13-A2-10..13):
    assert.equal(scanUiContent('export const B = ({ v }: { v: string }) => <button className={v === "outline-none" ? "px-4" : "py-2"}>Go</button>;', "r13cond.tsx").counts.floor, 0);
    assert.equal(scanUiContent('export const B = ({ v }: { v: string }) => <button className={v === "outline-none" && "px-4"}>Go</button>;', "r13and.tsx").counts.floor, 0);
    assert.equal(scanUiContent('export const C = ({ type, dir }: any) => <button style={{ transition: type === "all" ? "opacity 200ms" : "transform 200ms", outline: dir === "none" ? "2px solid blue" : "1px solid gray" }} />;', "r13st.tsx").counts.floor, 0);
    assert.equal(scanUiContent('const Btn1 = styled.button({ outline: "none", "&:focus-visible": { outline: "2px solid var(--ring)" } });\nconst Btn2 = styled.button({ "&:focus:not(:focus-visible)": { outline: "none" } });\nconst Btn3 = styled.button({ "&:focus-visible": { outline: "none", boxShadow: "0 0 0 2px var(--ring)" } });', "r13obj.tsx").counts.floor, 0);
    assert.equal(scanUiContent('const Box = styled.div`outline: none; &:focus-visible { outline: ${({ theme }) => theme.focusRing}; }`;', "r13tpl.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<div style:width={"100vw"}>A</div>\n<button style:outline-style={"none"}>B</button>', "r13svbad.svelte").counts.floor, 2);
    assert.equal(scanUiContent('<button style:outline={focusRing}>A</button>\n<button style:outline={"2px solid"}>B</button>\n<div style:transition={mode === "all" ? "opacity 200ms" : "transform 200ms"}>C</div>', "r13svok.svelte").counts.floor, 0);
    assert.equal(analyzeTailwindOutline("has-[:focus-visible]:ring-2 *:focus-visible:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("focus-within:ring-2 *:focus-visible:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("has-[button:focus-visible]:ring-2 [&_button]:focus-visible:outline-none").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:outline-[2px_solid_var(--ring)]").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-(--focus-ring)").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)").naked, false);
    assert.equal(analyzeTailwindOutline("[&:nth-child(2n+1)]:outline-none focus-visible:ring-2").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-[transparent]").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:border-[transparent]").naked, true);
    assert.equal(analyzeTailwindOutline("[&:hover_button]:outline-none focus-visible:ring-2").naked, true);
    assert.equal(scanUiContent(".field:hover:focus-within { outline: 2px solid var(--ring); }\n.field input:focus { outline: none; }", "r13hov.css").counts.floor, 1);
    assert.equal(scanUiContent(".card:not(:has(.btn:focus-visible)) { outline: 1px solid #ccc; }\n.btn:focus { outline: none; }", "r13not.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus { outline: none; }\n@scope (.panel) { .btn:focus-visible { outline: 2px solid var(--ring); } }", "r13scope.css").counts.floor, 1);
    assert.equal(scanUiContent('export const Meta = () => <div data-class="transition-all" data-testid="w-[100vw]" />;', "r13data.tsx").counts.floor, 0);
    assert.equal(scanUiContent('export const Helper = () => cn("px-4 transition-all w-[100vw]");', "r13hlp.tsx").counts.floor, 2);

    const r13ExtDsDir = join(scratch, "r13-ext-ds");
    mkdirSync(r13ExtDsDir, { recursive: true });
    writeFileSync(join(r13ExtDsDir, "ds.css"), "@media (prefers-color-scheme: dark) {\n  .ds-field:focus-within { outline: 2px solid #93c5fd; }\n}\n");
    writeFileSync(join(r13ExtDsDir, "app.css"), ".ds-field input:focus { outline: none; }\n");
    assert.equal(checkTarget(join(r13ExtDsDir, "app.css"), { dsCss: [join(r13ExtDsDir, "ds.css")] }).counts.floor, 1, "Conditional @media external DS CSS must not suppress unconditional consumer Floor error");

    // Round 14 regressions (R14-A2-02..11, R14-A2-14, R14-A2-17):
    assert.equal(
      scanUiContent(
        '<button className={clsx({ "px-4": variant === "outline-none", "py-2": mode === "transition-all", "w-full": size === "w-[100vw]" })}>Go</button>\n<button className={variant === "outline-none"}>Go</button>',
        "r14objmap.tsx"
      ).counts.floor,
      0,
      "Object class maps & bare comparisons must not scan RHS comparison literals"
    );
    assert.equal(
      scanUiContent(
        '<template><button :class="{ \'px-4\': variant === \'outline-none\', \'py-2\': mode === \'transition-all\' }">Go</button></template>',
        "r14vue.vue"
      ).counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        '<button className={v === "flat" && "outline-none" || "px-4"} />\n<div style={{ transition: mode === "flat" && "all 200ms" || "opacity 200ms", width: full === true && "100vw" || "100%" }} />',
        "r14andor.tsx"
      ).counts.floor,
      3,
      "Higher-precedence && comparisons inside || must still evaluate RHS class/style values"
    );
    assert.equal(
      scanUiContent(
        ".dark\\:focus\\:outline-none { outline: none; }\n.dark\\:focus\\:outline-none:focus-visible { outline: 2px solid var(--ring); }\n.sm\\:focus-visible\\:ring { outline: none; }\n.sm\\:focus-visible\\:ring:focus-visible { outline: 2px solid var(--ring); }\n",
        "r14esc.css"
      ).counts.floor,
      0,
      "Escaped \\:focus and \\:focus-visible class names must not match pseudo-classes"
    );
    assert.equal(
      scanUiContent(
        [
          'const A = styled.div(({ theme }) => ({ transition: "all 200ms", width: "100vw", outline: "none" }));',
          'const B = styled.div({ display: "flex" }, { transition: "all 200ms", width: "100vw", outline: "none" });',
          'const C = styled.div((props) => { return { transition: "all 200ms", width: "100vw", outline: "none" }; });',
        ].join("\n"),
        "r14styledargs.tsx"
      ).counts.floor,
      9,
      "Destructured arrow, multi-arg, and block-return styled.div() must all be scanned"
    );
    assert.equal(
      scanUiContent(
        [
          ".card1 { @apply *:outline-none focus-visible:ring-2; }",
          ".card2 { @apply *:outline-none; }\n.card2:focus-visible { outline: 2px solid var(--ring); }",
          ".card3 { @apply [&_button]:outline-none; }\n.card3:focus-visible { outline: 2px solid var(--ring); }",
        ].join("\n"),
        "r14twtarget.css"
      ).counts.floor,
      3,
      "Parent self focus ring must not satisfy child *:outline-none / [&_button]:outline-none"
    );
    assert.equal(
      scanUiContent(".card-ok { @apply *:outline-none; }\n.card-ok:focus-within { outline: 2px solid var(--ring); }\n", "r14twok.css").counts.floor,
      0,
      "Parent :focus-within with visible indicator covers *:outline-none"
    );
    assert.equal(
      scanUiContent(
        [
          "const Btn1 = styled.button`\n  ${resetStyles}\n  &:focus { outline: none; }\n  &:focus-visible { outline: 2px solid var(--ring); }\n`;",
          "const Btn2 = styled.button`\n  outline: none;\n  ${baseStyles}\n  &:focus-visible { outline: 2px solid var(--ring); }\n`;",
        ].join("\n"),
        "r14tplmix.tsx"
      ).counts.floor,
      0,
      "Standalone ${mixin} inside styled template must not corrupt selector matching"
    );
    assert.equal(
      scanUiContent(
        '<button style={{ outlineWidth: isFocused ? "2px" : 0, outlineColor: isFocused ? "#1d4ed8" : "transparent", outlineOffset: 0 }} />\nconst B = styled.button({ outlineWidth: isFocused ? "2px" : 0 });\n<button style:outline-width={isFocused ? "2px" : "0"}>Go</button>',
        "r14outprop.svelte"
      ).counts.floor,
      0,
      "Conditional outlineWidth/outlineColor and outlineOffset: 0 must not false-positive"
    );
    assert.equal(
      scanUiContent(
        [
          ".a:focus-visible { outline: none; border: none; border-color: var(--ring); }",
          ".b:focus-visible { outline: none; border: 0; border-color: #1d4ed8; }",
          ".c:focus-visible { outline: none; border-width: 0; border-style: solid; }",
          ".d:focus-visible { outline: none; border-style: none !important; border: 2px solid #000; }",
          ".e:focus-visible { outline: none; border: 2px #1d4ed8; }",
        ].join("\n"),
        "r14borderbad.css"
      ).counts.floor,
      5,
      "Incomplete/overridden border tuples on :focus-visible must be flagged"
    );
    assert.equal(
      scanUiContent(".input:focus-visible { outline: none; border-color: var(--focus); }\n", "r14borderok.css").counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        [
          ".field1:focus-within:hover { outline: 2px solid var(--ring); }\n.field1 input:focus { outline: none; }",
          ".card1:hover:has(.btn1:focus-visible) { outline: 2px solid var(--ring); }\n.btn1:focus { outline: none; }",
          ".card2:has(.btn2:focus-visible):hover { outline: 2px solid var(--ring); }\n.btn2:focus { outline: none; }",
          ".card3:has(.btn3:focus-visible:hover) { outline: 2px solid var(--ring); }\n.btn3:focus { outline: none; }",
        ].join("\n"),
        "r14hover.css"
      ).counts.floor,
      4,
      "Hover-gated :focus-within / :has() indicators must fail"
    );
    assert.equal(
      scanUiContent(
        [
          'const A = styled.button({ outline: "none", "&:focus-visible": { outlineColor: "var(--ring)" } });',
          'const B = styled.button({ outline: "none !important", "&:focus-visible": { outline: "2px solid var(--ring)" } });',
          'const C = styled.button({ "&:focus-visible": { outline: "2px solid var(--ring)" }, "&:focus": { outline: "none" } });',
        ].join("\n"),
        "r14objfocus.tsx"
      ).counts.floor,
      3,
      "CSS-in-JS object focus checking must enforce suppressedProps, !important, and object key order"
    );
    assert.equal(
      scanUiContent(
        ".btn {\n  &:focus {\n    outline: none;\n    &:focus-visible { outline: 2px solid var(--ring); }\n  }\n}\n.btn2:focus { outline: none; }\n.btn2:focus:focus-visible { outline: 2px solid var(--ring); }\n",
        "r14nestfv.css"
      ).counts.floor,
      0,
      "Nested &:focus { &:focus-visible } and :focus:focus-visible must count as safe :focus-visible replacement"
    );
    assert.equal(
      scanUiContent(".panel:not(.reveal) { opacity: 0; }\n.card:not([data-reveal]) { opacity: 0; }\n", "r14revealnot.css").counts.floor,
      0,
      ":not(.reveal) and :not([data-reveal]) must not false-positive dsaf/no-hidden-at-rest"
    );

    // Round 15 regressions (R15-A2-01, R15-A2-04, R15-A2-05, R15-A2-06, R15-A2-07, R15-A2-10, R15-A2-11):
    assert.equal(
      scanUiContent(
        [
          'const StyledBtn = styled(Button, { shouldForwardProp: (p) => p !== "active" })`transition: all 200ms; width: 100vw; outline: none;`;',
          'const StyledObj = styled(Button, { shouldForwardProp: (p) => p !== "active" })({ transition: "all 200ms", width: "100vw", outline: "none" });',
        ].join("\n"),
        "r15styled.tsx"
      ).counts.floor,
      6,
      "Nested parens inside styled(Comp, { shouldForwardProp }) must scan all 6 Floor violations"
    );
    assert.equal(
      scanUiContent(".btn { outline: none; }\n.btn:focus-visible { outline: revert; }\n", "r15revert.css").counts.floor,
      0,
      "outline: revert on :focus-visible must be treated as visible focus ring"
    );
    assert.equal(
      scanUiContent(
        [
          ".a:focus-visible { outline: 2px solid rgba(0, 0, 0, 0); }",
          ".b:focus-visible { outline-color: rgba(0, 0, 0, 0); }",
          ".c:focus-visible { outline: 2px solid #0000; }",
          ".d:focus-visible { outline: 2px solid #00000000; }",
          ".e:focus-visible { outline: 2px solid oklch(0.5 0.2 250 / 0); }",
          ".f:focus-visible { outline: none; border: 2px solid #0000; }",
          ".g:focus-visible { outline: none; border: 2px solid oklch(0.5 0.2 250 / 0); }",
          ".h:focus-visible { outline: none; box-shadow: 0 0 0 2px transparent; }",
          ".i:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0); }",
          ".j:focus-visible { outline: none; box-shadow: none !important; box-shadow: 0 0 0 2px var(--ring); }",
          ".k:focus-visible { outline: none; box-shadow: none ! important; }",
        ].join("\n"),
        "r15zeroalpha.css"
      ).counts.floor,
      11,
      "Zero-alpha outline/border/box-shadow and !important box-shadow resets must fail dsaf/no-outline-none-naked"
    );
    assert.equal(
      scanUiContent(
        [
          ".menu-item { outline: none; }\n.menu-item[data-highlighted] { border: none; }",
          ".menu-item2 { outline: none; }\n.menu-item2[data-highlighted] { background: transparent; }",
          ".tab { outline: none; }\n.tab[aria-selected='true'] { --tab-background: var(--surface-active); }",
          ".menu-item3:focus { outline: none; }\n.menu-item3[data-highlighted] { outline: none; }",
        ].join("\n"),
        "r15itemhighlight.css"
      ).counts.floor,
      5,
      "Invisible declarations and CSS custom props inside item highlight rules must not suppress outline-none"
    );
    assert.equal(
      scanUiContent(
        [
          'const A = styled.button(({ theme }) => ({ outline: "none", "&:focus-visible": { outline: theme.focusRing } }));',
          'const B = styled.button(({ theme }) => ({ outline: "none", "&:focus-visible": { boxShadow: theme.focusShadow } }));',
          'const C = styled.button({ outline: 0, "&:focus-visible": { outlineStyle: "solid", outlineWidth: 2 } });',
        ].join("\n"),
        "r15objok.tsx"
      ).counts.floor,
      0,
      "Dynamic theme focus tokens and numeric outlineWidth: 2 in CSS-in-JS objects must pass"
    );
    assert.equal(
      scanUiContent(
        [
          'const D = styled.button(({ active }) => ({ "&:focus-visible": { outline: "none", boxShadow: active ? "0 0 0 2px blue" : "none" } }));',
          'const E = styled.div({ "&:has(input:focus-visible)": { outline: "2px solid blue" }, "& button:focus": { outline: "none" } });',
          'const F = styled.div({ "& .other:focus-within": { outline: "2px solid blue" }, "& .btn:focus": { outline: "none" } });',
        ].join("\n"),
        "r15objbad.tsx"
      ).counts.floor,
      3,
      "Conditional boxShadow: ... : none and unrelated :has() / :focus-within siblings in CSS-in-JS objects must fail"
    );
    for (const twBad of [
      "[&_button]:outline-none has-[button:hover:focus-visible]:ring-2",
      "outline-none focus-visible:border-b-0",
      "outline-none focus-visible:border-t-transparent",
      "outline-none focus-visible:ring-blue-500/0",
      "outline-none focus-visible:outline-blue-500/0",
      "outline-none focus-visible:border-blue-500/0",
      "outline-none focus-visible:ring-opacity-0",
    ]) {
      assert.equal(analyzeTailwindOutline(twBad).naked, true, `Tailwind pattern must be flagged naked: ${twBad}`);
    }
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:border").naked, false, "Bare focus-visible:border must be accepted");
    assert.equal(
      scanUiContent(
        `<div style="width: {full ? '100vw' : '100%'}; transition: {ok ? 'all 200ms' : 'opacity 200ms'}" class:transition-all={ok} />`,
        "r15svelte.svelte"
      ).counts.floor,
      3,
      "Svelte interpolated style=... and class:transition-all must catch all 3 Floor violations"
    );

    // Round 16 regressions (R16-A2-01..06, R16-A2-08, R16-A2-10, R16-A2-11, R16-A2-14, R16-A2-19):
    const r16SvgSelfClosing = [
      "export function Chart() {",
      "  return (",
      "    <div>",
      '      <svg ref={chartRef} className="w-full h-64" />',
      '      <div className="bg-[#ef4444]" style={{ outline: "none", transition: "all 200ms", color: "#ff00aa !important" }}>Drift</div>',
      '      <svg viewBox="0 0 24 24"><path d="M0 0" /></svg>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const r16SvgRes = scanUiContent(r16SvgSelfClosing, "r16svg.tsx", { tier: "all" });
    assert.equal(r16SvgRes.counts.floor, 2, "Self-closing <svg /> must not blank intervening UI Floor rules");
    assert.equal(r16SvgRes.counts.reflex >= 2, true, "Self-closing <svg /> must not blank intervening bg-[#...] / !important Reflex rules");

    assert.equal(
      scanUiContent(
        [
          '<button style={{ outline: isFlat ? "none" : undefined }} />',
          '<button style={{ outline: isFlat ? "none" : null }} />',
          '<button style={{ outline: isFlat ? "none" : false }} />',
          'const B = styled.button(({ flat }) => ({ outline: flat ? "none" : undefined }));',
        ].join("\n"),
        "r16falsy.tsx"
      ).counts.floor,
      4,
      "Conditional outline none paired with undefined/null/false must fail Floor in TSX"
    );
    assert.equal(
      scanUiContent('<button style:outline={isFlat ? "none" : null}>Go</button>', "r16falsy.svelte").counts.floor,
      1,
      "Conditional Svelte style:outline none paired with null must fail Floor"
    );

    for (const twBad of [
      "[&_button]:outline-none has-[button.primary:focus-visible]:ring-2",
      "[&_button]:outline-none has-[button[data-active]:focus-visible]:ring-2",
      "focus-visible:outline-transparent",
      "outline-none focus-visible:ring-[length:0px]",
      "outline-none focus-visible:outline-[color:transparent]",
      "outline-none focus-visible:ring-[0.0px]",
    ]) {
      assert.equal(analyzeTailwindOutline(twBad).naked, true, `Tailwind bypass must fail: ${twBad}`);
    }
    for (const twGood of [
      "[&_button.primary]:outline-none has-[button:focus-visible]:ring-2",
      "focus-visible:outline-none focus:ring-2",
    ]) {
      assert.equal(analyzeTailwindOutline(twGood).naked, false, `Valid Tailwind focus must pass: ${twGood}`);
    }
    assert.equal(
      scanUiContent(
        [
          ".toolbar button:focus { outline: none; } .toolbar:has(button.primary:focus-visible) { outline: 2px solid blue; }",
          ".card:has(.btn.primary:focus-visible) { outline: 2px solid blue; } .btn:focus { outline: none; }",
          ".card:has(input.btn2:focus-visible) { outline: 2px solid blue; } .btn2:focus { outline: none; }",
          "main:focus .b1 { border: 1px solid #ccc; outline: none; }",
          ".panel:focus-within .b2 { border: 1px solid #ccc; outline: none; }",
          ".card:has(input:focus) .b3 { box-shadow: 0 1px 2px #000; outline: none; }",
          ".reveal { opacity: 0 ! important; }",
          ".btn3:focus-visible { outline: .0px solid var(--ring); }",
        ].join("\n"),
        "r16cssbad.css"
      ).counts.floor,
      8
    );
    assert.equal(
      scanUiContent(
        ".toolbar button.primary:focus { outline: none; }\n.toolbar:has(button:focus-visible) { outline: 2px solid blue; }\n",
        "r16cssgood.css"
      ).counts.floor,
      0
    );
    assert.equal(scanUiContent('export const Hero = () => <Video autoPlay src="/hero.mp4" />;\n', "Hero.tsx").counts.floor, 0);
    assert.equal(
      scanUiContent(
        [
          "<button style=\"outline: 2px solid {active ? '#1d4ed8' : '#64748b'}\">Go</button>",
          "<button style=\"outline: {active ? '2px' : '3px'} solid var(--ring)\">Go2</button>",
        ].join("\n"),
        "r16svelteoutline.svelte"
      ).counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        [
          ".btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--ring) 80%, rgba(0, 0, 0, 0)); }",
          ".btn2:focus-visible { outline: 2px solid color-mix(in srgb, var(--ring) 80%, #0000); }",
          ".btn3:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 80%, rgba(0, 0, 0, 0)); }",
          ".btn4:focus-visible { outline: 2px solid var(--ring, rgba(0, 0, 0, 0)); }",
        ].join("\n"),
        "r16colormix.css"
      ).counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        '<div style:padding|important="13px" style:width|important="100vw" style:transition|important="all 200ms" style:outline|important="none">Hi</div>',
        "r16svelteimp.svelte"
      ).counts.floor,
      3
    );
    assert.equal(
      scanUiContent(
        '<button className="before:content-[\'transition-all\'] after:content-[\'w-[100vw]\']">Go</button>',
        "r16arbcontent.tsx"
      ).counts.floor,
      0
    );

    // Round 17 regressions (R17-A2 H1-H9):
    assert.equal(
      scanUiContent('.badge::after { content: "transition: all 200ms; width: 100vw; outline: none;"; }\n', "r17h1.css").counts.floor,
      0,
      "H1: quoted CSS strings in content: must not trigger Floor FPs"
    );
    assert.equal(
      scanUiContent('.b:focus-visible { content: "outline: 2px solid blue; box-shadow: 0 0 0 2px blue;"; outline: none; }\n', "r17h1b.css").counts.floor,
      1,
      "H1: quoted CSS strings in content: must not act as visible focus replacement"
    );
    assert.equal(
      scanUiContent('.hero { background: url(data:image/png;base64,abc); }\n.c { @apply outline-none before:content-["x"] focus-visible:outline-2; }\n', "r17h1c.css").counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        [
          '<button className="outline-[0px_solid_red]">a</button>',
          '<button className="outline-[2px_solid_transparent]">b</button>',
          '<button className="outline-[#0000]">c</button>',
          '<button className="outline-none focus-visible:outline-[2px_solid_transparent]">d</button>',
          '<button className="outline-none focus-visible:outline-[0px_solid_red]">e</button>',
          '<button className="outline-none focus-visible:outline-[2px_none_#000]">f</button>',
          '<button className="outline-none focus-visible:border-[2px_solid_transparent]">g</button>',
          '<button className="outline-none focus-visible:border-[0_solid_red]">h</button>',
        ].join("\n"),
        "r17h2.tsx"
      ).counts.floor,
      8,
      "H2: multi-token & alpha-hex arbitrary Tailwind outline/border removals must fail Floor"
    );
    assert.equal(
      scanUiContent(
        [
          ".btn1 { @apply focus-visible:outline-2 focus-visible:outline-none; }",
          ".btn2:focus-visible { @apply outline-2 outline-none; }",
          ".btn3 { @apply focus-visible:outline-2; @apply focus-visible:outline-none; }",
        ].join("\n"),
        "r17h3.css"
      ).counts.floor,
      3,
      "H3: later @apply outline removal must override preceding focus-visible:outline-2"
    );
    assert.equal(
      scanUiContent(".btn-ok { @apply focus-visible:ring-2 focus-visible:outline-none; }\n.btn-ok2 { @apply focus-visible:outline-none; @apply focus-visible:outline-2; }\n", "r17h3ok.css").counts.floor,
      0
    );
    assert.equal(hasZeroAlphaColor("rgba(var(--rgb, rgb(0, 0, 0)), 0)"), true, "H4: nested fallback inside var() must still detect zero alpha");
    assert.equal(
      scanUiContent(".a { outline: none; }\n.a:focus-visible { outline: 2px solid rgba(var(--rgb, rgb(0, 0, 0)), 0); }\n", "r17h4.css").counts.floor,
      2
    );
    assert.equal(
      scanUiContent(".a:focus-visible { outline: none; box-shadow: 0 0 0 0 var(--ring); }\n", "r17h5.css").counts.floor,
      1,
      "H5: zero blur & zero spread box-shadow 0 0 0 0 var(--ring) must not pass as focus ring"
    );
    assert.equal(
      scanUiContent(".ok:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ring); }\n", "r17h5ok.css").counts.floor,
      0
    );
    assert.equal(
      scanUiContent(
        [
          "export const A = ({ full, ok, flat }: any) => (",
          "  <div style={{",
          '    width: `${full ? "100vw" : "100%"}`,',
          '    transition: `${ok ? "all" : "opacity"} 200ms`,',
          '    outline: `${flat ? "none" : "2px solid blue"}`',
          "  }} />",
          ");",
        ].join("\n"),
        "r17h6.tsx"
      ).counts.floor,
      3,
      "H6: JSX template literal interpolations must catch 100vw, transition all, and non-focus-gated outline none"
    );
    assert.equal(
      scanUiContent(
        'export const F = ({ isFocused }: any) => <button style={{ outline: `${isFocused ? "2px" : "0"} solid blue` }} />;',
        "r17h6ok.tsx"
      ).counts.floor,
      0,
      "H6: focus-gated template outline toggle must pass Floor"
    );
    assert.equal(
      scanUiContent('<div style:width="{full ? \'100vw\' : \'100%\'}" />', "r17h7bad.svelte").counts.floor,
      1,
      "H7: Svelte quoted style:width with {expr} must catch 100vw"
    );
    assert.equal(
      scanUiContent(
        '<div style:transition="{mode === \'all\' ? \'opacity 200ms\' : \'transform 200ms\'}" />\n<div style:outline="{active ? \'1px solid\' : \'2px dashed\'}" />',
        "r17h7ok.svelte"
      ).counts.floor,
      0,
      "H7: Svelte quoted style:transition/outline comparison & visible branches must not false-positive"
    );
    assert.equal(
      scanUiContent(
        'export const B = ({ x }: any) => <button className={/"/.test(x) ? "outline-none" : "px-4"}>Go</button>;\nexport const B2 = ({ x }: any) => <div style={{ width: /"/.test(x) ? "100vw" : "100%" }} />;',
        "r17h8.tsx"
      ).counts.floor,
      2,
      "H8: JS regex literals containing quotes must not break className or style extraction"
    );
    assert.equal(
      scanUiContent('<div class:w-[100vw]={full} class:min-w-[100vw]={full} class:max-w-[100vw]={false} />', "r17h9.svelte").counts.floor,
      2,
      "H9: Svelte class:w-[100vw] and min-w-[100vw] must flag Floor while falsy max-w ignores"
    );
    assert.throws(() => parseFlagArgs(["check", ".", "--ds-css", ""]), /non-empty/);
    assert.throws(() => discoverExternalDsCss(".", [""]), /cannot be empty/);

    // Round 18 regressions (A2 #2,#3,#4,#5,#6,#11,#14,#15,#19)
    assert.equal(
      scanUiContent(`<div style="--c: {/'/.test(x) ? '1' : '2'}; width: 100vw; transition: all 200ms; outline: none;" />\n`, "r18a.svelte").counts.floor,
      3,
      "R18 #2: Svelte style='...' splitter skips regex quotes inside {...}"
    );
    for (const twBad of [
      "outline-none focus-visible:ring-opacity-50",
      "outline-none focus-visible:ring-[2px_solid_transparent]",
      "outline-none focus-visible:ring-[0px_#1d4ed8]",
      "outline-none focus-visible:ring-2 focus-visible:ring-transparent",
      "outline-none focus-visible:ring-2 focus-visible:ring-0",
      "outline-none focus-visible:ring-transparent focus-visible:ring-2",
    ]) {
      assert.equal(analyzeTailwindOutline(twBad).naked, true, `R18 #3: must reject invisible ring utility set: ${twBad}`);
    }
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus-visible:ring-blue-500").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-transparent focus-visible:ring-2 focus-visible:ring-blue-500").naked, false);
    assert.equal(
      scanUiContent('<div style={{ ...(full && { width: "100vw", outline: "none" }) }} />\n', "r18spread.tsx").counts.floor,
      2,
      "R18 #4: parseJsObjectEntries must inspect spread object literals"
    );
    assert.equal(
      scanUiContent('<div style={{ outline: "2px" + " solid blue", width: "100" + "vw" }} />\n', "r18plus.tsx").counts.floor,
      1,
      "R18 #4: + concatenation joins static outline/width parts"
    );
    assert.equal(
      scanUiContent('<div style={{ outline: "2px solid " + (isFocused ? "blue" : "transparent") }} />\n', "r18pluscond.tsx").counts.floor,
      0,
      "R18 #4: + concatenation with conditional focus outline must not false-positive"
    );
    assert.equal(
      scanUiContent('.item { outline: none; }\n.item[data-highlighted] { content: "background: #1d4ed8;"; }\n', "r18contentfn.css").counts.floor,
      1,
      "R18 #5: quoted content: background string must not satisfy focus indicator"
    );
    assert.equal(
      scanUiContent('.btn { content: "@apply !outline-none"; outline: none; }\n.btn:focus-visible { outline: 2px solid blue; }\n', "r18contentfp.css").counts.floor,
      0,
      "R18 #5: quoted content: @apply !outline-none string must not suppress :focus-visible"
    );
    assert.equal(
      scanUiContent(".card:focus-within .unrelated { outline: 2px solid blue; }\n.card input:focus { outline: none; }\n", "r18within.css").counts.floor,
      1,
      "R18 #6: descendant :focus-within on unrelated element must not cover ancestor input"
    );
    assert.equal(
      scanUiContent('.tip::after { content: "#ff00aa rgb(255, 0, 0) !important"; }\n', "r18reflex.css", { tier: "all" }).active.length,
      0,
      "R18 #11: CSS content: strings must not trigger hardcoded-color or important-override"
    );
    assert.equal(
      scanUiContent('<div style={{ "--x": cond ?\n  "red !important"\n  : "blue" }} />\n', "r18var.tsx", { tier: "all" }).counts.reflex,
      0,
      "R18 #11: multiline JS custom property ternary must be blanked without leaking !important"
    );
    assert.equal(
      scanUiContent("const s = 'a=`';\nconst html = `\n  <div class=\"\n`;\nexport const B = () => <button className=\"outline-none\">Go</button>;\n", "r18tpl.tsx").counts.floor,
      1,
      "R18 #14: backtick inside single-quoted JS string must not start multiline template literal"
    );
    assert.equal(hasZeroAlphaColor("oklch(calc(min(0.5, 0.6)) 0.2 250 / 0)"), true);
    assert.equal(hasZeroAlphaColor("rgba(var(--rg), 255, 0)"), true);
    assert.equal(hasZeroAlphaColor("rgb(0 0 0 / none)"), true);
    writeFileSync(join(scratch, "r18empty.css"), ".a { color: red; }\n");
    assert.throws(() => checkFile(join(scratch, "r18empty.css"), { dsCss: "" }), /empty/i);
    assert.throws(() => checkTarget(join(scratch, "r18empty.css"), { dsCss: "" }), /empty/i);

    // Round 19 regressions (R19-A2-01,03,04,05,06,14):
    assert.equal(
      scanUiContent('<div style={{ "--x": `hello ${world}` }} />', "r19var.tsx", { tier: "all" }).counts.floor,
      0,
      "R19 #1: --var template interpolation in --tier all must not throw ReferenceError"
    );
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:outline-2 focus-visible:outline-blue-500/0").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:outline-2 focus-visible:outline-opacity-0").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:border-2 focus-visible:border-x-0 focus-visible:border-y-0").naked, true);
    assert.equal(hasZeroAlphaColor("hsl(var(--h), 100%, 0%)"), false);
    assert.equal(hasZeroAlphaColor("rgb(var(--r), var(--g), 0)"), false);
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: 2px solid hsl(var(--h), 100%, 0%); }", "r19hsl.css").counts.floor,
      0,
      "R19 #4: opaque 3-arg hsl/rgb with var() and 0 3rd channel must stay visible"
    );
    assert.equal(
      scanUiContent(".card:has(.btn:focus-visible) .unrelated { outline: 2px solid blue; }\n.btn:focus { outline: none; }\n", "r19has.css").counts.floor,
      1,
      "R19 #5: :has() on ancestor must not suppress subject :focus { outline: none }"
    );
    assert.equal(
      scanUiContent('<button style={{ outline: isFocused ? "none" : "2px solid blue" }} />', "r19inv.tsx").counts.floor,
      1,
      "R19 #6: inverted focus-gated outline must flag none on focused branch"
    );
    assert.equal(
      scanUiContent('<button style={{ ...(isFocused ? { outline: "2px solid blue" } : { outline: "none" }) }} />', "r19sp.tsx").counts.floor,
      0,
      "R19 #6: spread focus ternary with visible focused branch must pass"
    );
    assert.equal(
      scanUiContent('const q = gql`\n  <div class="\n`;\nexport const B = () => <button className="outline-none">Go</button>;\n', "r19gql.tsx").counts.floor,
      1,
      "R19 #14: non-whitelisted tagged template unclosed quote must not swallow later outline-none"
    );

    // Round 20 regression (R20-A4-M2): --tier reflex scans and gates strictly on Reflex rules without running Floor rules
    const r20RefDir = join(scratch, "r20-reflex-tier");
    mkdirSync(r20RefDir, { recursive: true });
    writeFileSync(join(r20RefDir, "mix.css"), ".a:focus { outline: none; }\n.b { color: #ff00aa !important; }\n");
    writeFileSync(join(r20RefDir, "floorOnly.css"), ".a:focus { outline: none; }\n");
    const r20RefOnly = checkTarget(join(r20RefDir, "floorOnly.css"), { tier: "reflex" });
    assert.equal(r20RefOnly.passed, true);
    assert.equal(r20RefOnly.counts.floor, 0);
    assert.equal(r20RefOnly.counts.reflex, 0);
    const r20RefMix = checkTarget(join(r20RefDir, "mix.css"), { tier: "reflex" });
    assert.equal(r20RefMix.passed, false);
    assert.equal(r20RefMix.counts.floor, 0);
    assert.equal(r20RefMix.counts.reflex, 2);
    const r20StdinRef = runHookStdin(JSON.stringify({ file_path: join(r20RefDir, "floorOnly.css") }), { tier: "reflex" });
    assert.deepEqual(r20StdinRef, {});

    // Round 20 Area 2 regressions (R20-A2-H1,H2,H3,H4,H5,H7,L14,L15):
    assert.equal(scanUiContent(".btn { @apply outline-none focus-visible:ring-2 focus-visible:ring-0; }", "r20a.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn { @apply outline-none focus-visible:border-2 focus-visible:border-x-0 focus-visible:border-y-0; }", "r20b.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn { outline: none; }\n.btn:focus-visible { @apply ring-2 ring-0; }", "r20c.css").counts.floor, 1);
    assert.equal(analyzeTailwindOutline("outline-none focus:ring-2 focus-visible:ring-0").naked, true);
    assert.equal(scanUiContent('<button style={{ outline: (!isFocused) ? "2px solid blue" : "none" }} />', "r20p1.tsx").counts.floor, 1);
    assert.equal(scanUiContent('<button style={{ ...((!isFocused) ? { outline: "2px solid blue" } : { outline: "none" }) }} />', "r20p2.tsx").counts.floor, 1);
    assert.equal(scanUiContent('<button style={{ outline: (!isFocused) ? "none" : "2px solid blue" }} />', "r20p3.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<video autoPlay onEnded={() => /"/.test(x)} src="a.mp4" />', "r20vid.tsx").counts.floor, 1);
    assert.equal(
      scanUiContent('export const A = () => <div>{`\n  <div class="\n`}</div>;\nexport const B = () => <button className="outline-none">Go</button>;', "r20t1.tsx").counts.floor,
      1
    );
    assert.equal(
      scanUiContent('const q = gql<User>`\n  <div class="\n`;\nexport const B = () => <button className="outline-none">Go</button>;', "r20t2.tsx").counts.floor,
      1
    );
    assert.equal(
      scanUiContent('const B = styled.button(({ isFocused }) => ({ ...(isFocused ? { outline: "2px solid blue" } : { outline: "none" }) }));', "r20st.tsx").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('export const B = ({ isFocused }: any) => <button style={isFocused ? { outline: "2px solid blue" } : { outline: "none" }} />;', "r20top.tsx").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<button style={{ ...(isFocused ? { outline: "none", border: "2px solid blue" } : { outline: "none" }) }} />', "r20brd.tsx").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<div\n  title=\'Use "--x": val\'\n  style={{ color: "red !important" }}\n/>', "r20str.tsx", { tier: "all" }).counts.reflex,
      1
    );
    assert.equal(
      scanUiContent('const B = styled.div`--custom: #ff00aa !important; color: var(--fg);`;', "r20l14.tsx", { tier: "all" }).counts.reflex,
      0
    );

    // Round 21 regressions (R21-A2-H1, R21-A2-H2, R21-A2-M1, R21-A2-M3, R21-A2-M5, R21-A2-L1):
    assert.equal(scanUiContent('<button style={{ outline: !!isFocused ? "2px solid blue" : "none" }} />', "r21h1a.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button style={{ ...(!!isFocused ? { outline: "2px solid blue" } : { outline: "none" }) }} />', "r21h1b.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button style={{ outline: !!isFocused ? "none" : "2px solid blue" }} />', "r21h1c.tsx").counts.floor, 1);
    assert.equal(
      scanUiContent('const q = gql<{ id: string }>`\n  <div class="\n`;\nexport const B = () => <button className="outline-none">Go</button>;', "r21h2.tsx").counts.floor,
      1
    );
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 !focus:ring-0").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus:ring-0!").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus:ring-0").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 !focus:ring-0 !focus-visible:ring-2").naked, false);
    assert.equal(
      scanUiContent('<div :style="[isFocused ? { outline: \'2px solid blue\' } : { outline: \'none\' }]" />', "r21l1a.vue").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<button style={active ? (isFocused ? { outline: "2px solid blue" } : { outline: "none" }) : {}} />', "r21l1b.tsx").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<div style="--x: {active ? \'#ff00aa !important\' : \'#112233\'}; color: var(--x);" />', "r21m5.svelte", { tier: "reflex" }).counts.reflex,
      0
    );
    assert.equal(
      scanUiContent('const G = styled.div`&::after { content: "${y ? \'a"\' : \'c\'}"; } --custom: #ff00aa !important;`;', "r21m3a.tsx", { tier: "reflex" }).counts.reflex,
      0
    );
    assert.equal(
      scanUiContent('const H = styled.div`--custom: "${y ? \'a"\' : \'c\'}"; color: #ff00aa !important;`;', "r21m3b.tsx", { tier: "reflex" }).counts.reflex,
      2
    );

    // Round 22 regressions (R22-A2-H1, R22-A2-H2, R22-A2-M1, R22-A2-M2, R22-A2-M3, R22-A2-M5):
    // H1: leading negation in compound logical guard (!loading && isFocused) must not flip arm polarity
    assert.equal(scanUiContent('<button style={{ outline: !loading && isFocused ? "2px solid blue" : "none" }} />', "r22h1a.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button style={{ outline: !loading && isFocused ? "none" : "2px solid blue" }} />', "r22h1b.tsx").counts.floor, 1);
    assert.equal(scanUiContent('<button style={{ outline: !(loading || isFocused) ? "none" : "2px solid blue" }} />', "r22h1c.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button style={{ outline: (!isFocused) && ready ? "none" : "2px solid blue" }} />', "r22h1d.tsx").counts.floor, 0);

    // H2: indented JSX prose backtick must not open multiline template literal & swallow dsaf-ignore
    assert.equal(
      scanUiContent('<p>\n  `literal backtick in JSX prose\n</p>\n{/* dsaf-ignore dsaf/important-override -- approved editorial badge */}\n<div style={{ color: "red !important" }} />', "r22h2.tsx", { tier: "all" }).counts.reflex,
      0
    );

    // M1: Svelte style:--* custom property directive masking (quoted & expression)
    assert.equal(
      scanUiContent('<div style:--accent="red !important" style:--ring={active ? "red !important" : "blue"} />', "r22m1.svelte", { tier: "reflex" }).counts.reflex,
      0
    );

    // M2: JSX prose comma/semicolon before "--fake-x": must not swallow later real !important
    assert.equal(
      scanUiContent('export const P = () => <p>Syntax; "--fake-b": <span style={{ color: "#112233 !important" }} /></p>;', "r22m2.tsx", { tier: "reflex" }).counts.reflex,
      2
    );

    // M3: Trailing TS 'as' / 'satisfies' type assertions must unwrap cleanly
    assert.equal(
      scanUiContent('<button style={(isFocused ? { outline: "2px solid blue" } : { outline: "none" }) as React.CSSProperties} />', "r22m3a.tsx").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<button style={{ width: (full ? "100vw" : "100%") as any }} />', "r22m3b.tsx").counts.floor,
      1
    );

    // M5: Nested css`...` inside styled`...` ${...} masks content strings & keeps real !important
    assert.equal(
      scanUiContent('const B = styled.div`${(p) => p.hot ? css`content: "!important";` : ""}`;', "r22m5a.tsx", { tier: "reflex" }).counts.reflex,
      0
    );
    assert.equal(
      scanUiContent('const B = styled.div`${(p) => p.hot ? css`color: red !important;` : ""}`;', "r22m5b.tsx", { tier: "reflex" }).counts.reflex,
      1
    );

    const hookSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [hookSelfPath, "--bogus"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [hookSelfPath, "check", scratch, "--bogus"], { encoding: "utf8" }).status, 2);

    // Round 23 regressions (#15, #16, #18, #23, #24, #25, #26, #39)
    assert.equal(scanUiContent(".popup-trigger:focus { outline: none; }\n", "r23pop.css").counts.floor, 1);
    assert.equal(
      scanUiContent(
        "export const Doc = () => (<><button title='Example: class=\"outline-none\"'>Tip</button><p>Avoid class=\"transition-all w-[100vw]\"</p><code>{'<video autoplay src=\"a.mp4\" />'}</code></>);\n",
        "r23doc.tsx"
      ).counts.floor,
      0
    );
    assert.equal(scanUiContent('.a { @apply before:content-["a transition-all b"]; }\n', "r23app.css").counts.floor, 0);
    assert.equal(scanUiContent("<button style:outline=\"{isFocused ? '2px' : '0'} solid blue\">Go</button>", "r23sv1.svelte").counts.floor, 0);
    assert.equal(scanUiContent('<button style="outline: {isFocused ? \'2px\' : \'0\'} solid blue">Go</button>', "r23sv2.svelte").counts.floor, 0);
    assert.equal(scanUiContent('export const A = () => <button className={(v === "outline-none" ? "px-4" : "py-2") as string}>Go</button>;', "r23cast1.tsx").counts.floor, 0);
    assert.equal(scanUiContent('export const B = () => <button className={clsx({ "px-4": v === "transition-all" }) as string}>Go</button>;', "r23cast2.tsx").counts.floor, 0);
    assert.equal(scanUiContent('<button class:transition-all={x === "}" ? false : false}>Ok</button>', "r23sv3.svelte").counts.floor, 0);
    assert.equal(scanUiContent("<button class:outline-none={true} class:focus-visible:ring-2={true}>Ok</button>", "r23sv4.svelte").counts.floor, 0);
    assert.equal(scanUiContent('.a::before { content: "p-[12px] bg-[#ff00aa]"; }\n', "r23arb.css", { tier: "all" }).counts.reflex, 0);
    for (const cliBad of [
      ["check", scratch, "--tier", ""],
      ["install", "--dir", scratch, "--agent", ""],
      ["install", "--dir", scratch, "--agent", "bogus"],
      ["check", ""],
      ["check", "   "],
      ["check", scratch, "extra"],
    ]) {
      assert.equal(spawnSync(process.execPath, [hookSelfPath, ...cliBad], { encoding: "utf8" }).status, 2);
    }

    // Round 24 regressions (A2-H1/H4/M3/M5/M6/L1)
    assert.equal(scanUiContent('export const A = ({ cls }: any) => <button className={cls === "transition-all" ? "px-2" : "py-2"}>Ok</button>;', "r24h1a.tsx").counts.floor, 0);
    assert.equal(scanUiContent(`<button className="before:content-['transition-all'] after:content-['w-[100vw]'] before:content-['outline-none'] px-2">Ok</button>`, "r24h1b.tsx").counts.floor, 0);
    assert.equal(scanUiContent(".b:focus { outline: none; }\n.b:focus-within { box-shadow: 0 0 0 2px blue; }\n", "r24h4a.css").counts.floor, 0);
    assert.equal(scanUiContent(".b:focus { outline: none !important; }\n.b:focus-within { outline: 2px solid blue; }\n", "r24h4imp.css").counts.floor, 1);
    assert.equal(scanUiContent(".b:focus { outline-style: none; }\n.b:focus-within { outline-color: blue; }\n", "r24h4part.css").counts.floor, 1);
    assert.equal(scanUiContent(".b:focus-within { outline: 2px solid blue; }\n.b:focus { outline: none; }\n", "r24h4b.css").counts.floor, 1);
    const sarifSym = join(scratch, "sarif-sym.json");
    symlinkSync(join(scratch, "nonexistent-target.json"), sarifSym);
    assert.equal(spawnSync(process.execPath, [hookSelfPath, "check", scratch, "--sarif", sarifSym], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [hookSelfPath, "check", scratch, "--sarif", scratch], { encoding: "utf8" }).status, 2);
    assert.equal(scanUiContent('<><div title=\'Example: style="outline: none"\'>Tip</div><p>style="width: 100vw" p-[12px] bg-[#ff00aa]</p><code>{"<div className=\\"p-[12px] bg-[#ff00aa]\\">"}</code></>\n', "r24m3.tsx", { tier: "all" }).active.length, 0);
    assert.equal(scanUiContent(".a { inline-size: calc(100vw - 16px); }\n.b { min-width: min(100%, 100vw); }\n", "r24m5a.css").counts.floor, 2);
    assert.equal(scanUiContent('<div style={{ inlineSize: "calc(100vw - 8px)" }} className="w-[calc(100vw-8px)] [outline:none]" />', "r24m5b.tsx").counts.floor, 3);
    assert.equal(scanUiContent('<div class="px-2 [&_svg{stroke:red}]:outline-none" />', "r24m6.html").counts.floor, 1);
    assert.equal(scanUiContent('<><video autoplay={0} /><video autoplay="" src="a.mp4" /></>\n', "r24l1a.tsx").counts.floor, 1);
    assert.equal(scanUiContent('<template><video autoplay :muted="0" /></template>\n', "r24l1b.vue").counts.floor, 1);
    assert.equal(scanUiContent('<template><video :autoplay="0" /></template>\n', "r24l1c.vue").counts.floor, 0);

    // Round 25 regressions (A2-H1..H5, A2-M1..M4, A2-L1, A4-H1/L1)
    assert.equal(scanUiContent('<div className="w-[min(100%,_100vw)]" />\n', "r25h1.tsx").counts.floor, 1);
    assert.equal(scanUiContent(".a { @apply [inline-size:calc(100vw_-_8px)]; }\n", "r25h1.css").counts.floor, 1);
    assert.equal(scanUiContent('<div class:w-[calc(100vw_-_8px)]={ok} />\n', "r25h1.svelte").counts.floor, 1);

    for (const twColorOnly of [
      "outline-none focus-visible:outline-blue-500",
      "outline-none focus-visible:[outline-color:blue]",
      "outline-none focus-visible:[outline-width:2px]",
      "outline-none focus-visible:[outline-style:solid]",
      "outline-none focus-visible:ring-blue-500",
      "outline-none ring-0 focus-visible:ring-blue-500",
      "outline-none border-0 focus-visible:border-blue-500",
      "outline-none focus-visible:border-blue-500",
    ]) {
      assert.equal(analyzeTailwindOutline(twColorOnly).naked, true, `R25 A2-H2: incomplete TW focus ring must fail: ${twColorOnly}`);
    }
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:outline-2").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus-visible:ring-blue-500").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:[outline-style:solid] focus-visible:[outline-width:2px]").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-transparent focus-visible:ring-2").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-transparent focus-visible:ring-2 focus-visible:ring-blue-500").naked, false);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-(color:--focus-ring)").naked, true);
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-(length:--focus-ring-w) focus-visible:ring-(color:--focus-ring)").naked, false);
    assert.equal(scanUiContent(".btn { border: 0; }\n.btn:focus { outline: none; }\n.btn:focus-visible { border-color: blue; }\n", "r25b1.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn { border: 0; }\n.btn:focus-visible { outline: none; border-color: blue; }\n", "r25b2.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn { border: 1px solid #ccc; }\n.btn:focus { outline: none; }\n.btn:focus-visible { border-color: blue; }\n", "r25b3.css").counts.floor, 0);
    assert.equal(scanUiContent(".btn { border: 0; }\n.btn:focus { outline: none; }\n.btn:focus-visible { border: 2px solid blue; }\n", "r25b4.css").counts.floor, 0);

    assert.equal(scanUiContent('<video autoplay bind:muted={false} src="a.mp4" />\n', "r25vid1.svelte").counts.floor, 1);
    assert.equal(scanUiContent('<video bind:autoplay={0} src="a.mp4" />\n', "r25vid2.svelte").counts.floor, 0);
    assert.equal(
      scanUiContent('---\nconst ex = \'<button class="outline-none">fake</button>\';\n---\n<button class="focus-visible:ring-2">real</button>\n', "r25.astro").counts.floor,
      0
    );
    const r25FakeStyle = scanUiContent(
      '<script>const ex = "<style>.a { transition: all; }</style>";</script>\n<p>style="color:red !important"</p>\n<img alt="#ff00aa" />\n',
      "r25fake.html",
      { tier: "all" }
    );
    assert.equal(r25FakeStyle.counts.floor, 0);
    assert.equal(r25FakeStyle.counts.reflex, 0);
    assert.equal(
      scanUiContent('<div class:[&>svg]:outline-none={active} /><button class="outline-none" class:focus-visible:ring-2={true}>Ok</button>\n', "r25sv.svelte").counts.floor,
      1
    );
    assert.equal(scanUiContent(".btn:has(:focus-visible) { box-shadow: 0 0 0 2px blue; }\n.btn:focus { outline: none; }\n", "r25has.css").counts.floor, 1);
    assert.equal(scanUiContent(".card:focus-within { @apply focus-visible:ring-2; }\n.card input:focus { outline: none; }\n", "r25wrap.css").counts.floor, 1);
    assert.equal(
      spawnSync(process.execPath, [hookSelfPath, "stdin", "--ds-css", join(scratch, "missing-ds.css")], { input: "", encoding: "utf8" }).status,
      2
    );
    const r25SarifSecret = join(scratch, "sarif-secret.json");
    const r25SarifLiveSym = join(scratch, "sarif-live-sym.json");
    writeFileSync(r25SarifSecret, "{}");
    symlinkSync(r25SarifSecret, r25SarifLiveSym);
    assert.equal(spawnSync(process.execPath, [hookSelfPath, "check", scratch, "--sarif", r25SarifLiveSym], { encoding: "utf8" }).status, 2);
    const r25HookCliSym = join(scratch, "hook-cli-sym.mjs");
    symlinkSync(hookSelfPath, r25HookCliSym);
    assert.equal(spawnSync(process.execPath, [r25HookCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regressions (A2-H4 TW v4 variants, A2-M5 cva/cn outline-none, A2-M6 compound :focus-within, A2-M7 .125rem, A2-M8 opacity: .0, A2-M10 content-[...], A2-M11 Vue :style '--x')
    assert.equal(
      scanUiContent('<div className="supports-(display:grid):transition-all has-(>input):w-[100vw] supports-(outline-style:auto):outline-none group-hover/MyCard:transition-all" /><button className="group/MyCard:outline-none" />', "r26h4.tsx").counts.floor,
      5
    );
    assert.equal(scanUiContent('<button className="supports-(outline-style:auto):outline-none" />', "r26h4b.tsx").counts.floor, 1);
    assert.equal(scanUiContent('<button className="group/MyCard:outline-none" />', "r26h4c.tsx").counts.floor, 1);
    assert.equal(
      scanUiContent('const b = cva("inline-flex outline-none"); const c = cn("px-4 outline-none"); const ok = cn("outline-none", "focus-visible:ring-2");', "r26m5.tsx").counts.floor,
      2
    );
    assert.equal(
      scanUiContent(".card.is-disabled .btn:focus { outline: none; }\n.other.card:focus-within { outline: 2px solid blue; }", "r26m6.css").counts.floor,
      1
    );
    assert.equal(
      scanUiContent('<button className="outline-none focus-visible:outline-[.125rem_solid_#1d4ed8] mr-1" /><button className="outline-none focus-visible:ring-[.125rem]" />', "r26m7.tsx").counts.floor,
      0
    );
    assert.equal(scanUiContent(".reveal { opacity: .0; }", "r26m8.css").counts.floor, 1);
    assert.equal(
      scanUiContent('<button className="before:content-[\'bg-[#ff00aa]\'] after:content-[\'p-[13px]\']" />', "r26m10.tsx", { tier: "all" }).counts.reflex,
      0
    );
    assert.equal(
      scanUiContent('<template><div :style="{ \'--x\': \'#ff00aa !important\' }" /></template>', "r26m11.vue", { tier: "all" }).counts.reflex,
      0
    );

    // Round 27 regressions (A2-H1..H3, A2-H5..H7)
    assert.equal(
      scanUiContent('export const A = () => <div><span>/*</span><button className="outline-none" /></div>;\nexport const B = () => <div><span>path // note</span> <button className="outline-none" /></div>;', "r27h1.tsx").counts.floor,
      2
    );
    assert.equal(
      scanUiContent('const ok = a > 0; styled(Box)`background: url(x); /* just prose`\nexport const Btn = () => <button className="outline-none" />;', "r27h2.tsx").counts.floor,
      1
    );
    assert.equal(
      scanUiContent('const Box = styled.div`\n  /* transition: all 200ms; width: 100vw; outline: none; color: #ff00aa !important; */\n  color: var(--fg);\n`;', "r27h3a.tsx", { tier: "all" }).active.length,
      0
    );
    const r27WaiverCssInJs = scanUiContent(
      'const Box = styled.div`\n  /* dsaf-ignore dsaf/important-override -- needed to override legacy third-party utility */\n  color: #111111 !important;\n`;',
      "r27h3b.tsx",
      { tier: "all" }
    );
    assert.equal(r27WaiverCssInJs.active.length, 1);
    assert.equal(r27WaiverCssInJs.active[0].ruleId, "dsaf/hardcoded-color");
    assert.equal(r27WaiverCssInJs.waived.length, 1);

    const r27HookSymProj = join(scratch, "r27-hook-sym-proj");
    const r27HookOut = join(scratch, "r27-hook-outside.json");
    mkdirSync(join(r27HookSymProj, ".claude"), { recursive: true });
    writeFileSync(r27HookOut, '{"keep":true}\n');
    symlinkSync(r27HookOut, join(r27HookSymProj, ".claude/settings.json"));
    assert.throws(() => installAgentHook({ agent: "claude", dir: r27HookSymProj }), /symlink|escapes/i);
    assert.equal(readFileSync(r27HookOut, "utf8"), '{"keep":true}\n');

    assert.equal(
      scanUiContent('@supports (background: url(data:image/png;base64,AAAA)) {\n  .btn { outline: none; }\n}\n.btn:focus-visible { outline: 2px solid currentColor; }', "r27h6.css").counts.floor,
      0
    );
    assert.equal(
      scanUiContent('<a href="https://example.com/?q=bg-[#ff00aa]" data-testid="bg-[#ff00aa] p-[13px] bg-red-500">x</a>\nconst isDark = theme === "bg-[#111111]";', "r27h7a.tsx", { tier: "all" }).counts.reflex,
      0
    );
    assert.equal(
      scanUiContent('const v = cva("px-2", { variants: { tone: { danger: "bg-[#ff00aa] p-[13px]" } } });', "r27h7b.tsx", { tier: "all" }).counts.reflex,
      2
    );

    // Round 28 regressions (A2-H2 cva variant Floor rules, A2-M2 --sarif rootDir confinement)
    const r28CvaFloor = scanUiContent(
      'export const btn = cva("px-4 py-2", {\n  variants: {\n    variant: { bad: "transition-all w-[100vw] outline-none" },\n    size: { sm: "p-[13px] bg-[#ff00aa]" },\n  },\n});',
      "r28-cva.tsx",
      { tier: "all" }
    );
    assert.equal(r28CvaFloor.counts.floor, 3, "R28 A2-H2: cva variants must trigger all 3 Floor rules");
    assert.equal(r28CvaFloor.counts.reflex, 2);

    const r28SarifProj = join(scratch, "r28-sarif-proj");
    const r28SarifOutside = join(scratch, "r28-sarif-outside");
    mkdirSync(join(r28SarifProj, "out"), { recursive: true });
    mkdirSync(r28SarifOutside, { recursive: true });
    writeFileSync(join(r28SarifProj, "ok.css"), ".ok { color: var(--fg); }\n");
    symlinkSync(r28SarifOutside, join(r28SarifProj, "out/sym"));
    const r28HookSelfPath = fileURLToPath(import.meta.url);
    assert.equal(
      spawnSync(process.execPath, [r28HookSelfPath, "check", r28SarifProj, "--sarif", join(r28SarifProj, "out/sym/evil.sarif")], { encoding: "utf8" }).status,
      2,
      "R28 A2-M2: dsaf-hook --sarif must reject symlink dir escape out of target root"
    );
    assert.equal(existsSync(join(r28SarifOutside, "evil.sarif")), false);

    // Round 29 regressions (A2-H1, A2-H2, A2-M4, A2-M5, A2-M6, A2-M7)
    assert.equal(
      scanUiContent(
        [
          '<p>styled.div`outline: none; transition: all 1s;`</p>',
          'const s = "styled.div({ outline: \'none\', width: \'100vw\' })";',
          '<div title="styled.div({ outline: \'none\' })">Hi</div>',
        ].join("\n"),
        "r29h1.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R29 A2-H1: styled.* inside prose/JS string/attr must not trigger Floor"
    );
    const r29SvelteRes = scanUiContent(
      '<button on:click|preventDefault|stopPropagation={go} class="outline-none transition-all p-[13px] text-[#abcdef]" style="padding: 13px; color: #112233">Go</button>',
      "r29Btn.svelte",
      { tier: "all", surfaceMode: "operate" }
    );
    assert.equal(r29SvelteRes.counts.floor, 2, "R29 A2-H2: Svelte chained modifiers must still catch Floor findings");
    assert.ok(r29SvelteRes.counts.reflex >= 2, "R29 A2-H2: Svelte chained modifiers must still catch Reflex findings");
    assert.equal(
      scanUiContent('const Btn = styled.button((p) => /"/.test(p.x) ? { outline: "none" } : {});', "r29m4a.tsx", { surfaceMode: "operate" }).counts.floor,
      1,
      "R29 A2-M4: regex containing double quote before object return must not swallow Floor"
    );
    assert.equal(
      scanUiContent('const Btn = styled.button((p) => /`/.test(p.x) ? { outline: "none" } : {});', "r29m4b.tsx", { surfaceMode: "operate" }).counts.floor,
      1,
      "R29 A2-M4: regex containing backtick before object return must not swallow Floor"
    );
    assert.equal(
      scanUiContent(
        '<style data-x="a>b">--x: red !important;</style>\n<style>.a { content: "</style>"; --x: red !important; }</style>\n',
        "r29m5.html",
        { tier: "all" }
      ).counts.reflex,
      0,
      "R29 A2-M5: custom property declarations inside <style data-x='a>b'> or with '</style>' CSS string must stay blanked"
    );
    assert.equal(
      scanUiContent(".btn:focus > .label { outline: none; }\n.btn:focus-visible > .label { outline: 2px solid blue; }\n", "r29m6a.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R29 A2-M6: combinator focus rule covered by .btn:focus-visible > .label must pass Floor"
    );
    assert.equal(
      scanUiContent(".btn:focus:not(:focus-visible) > .label { outline: none; }\n", "r29m6b.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R29 A2-M6: combinator focus rule guarded with :not(:focus-visible) on ancestor must pass Floor"
    );
    assert.equal(
      scanUiContent(".parent:not(:focus-visible) .child:focus { outline: none; }\n", "r29m6c.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R29 A2-M6: unguarded .child:focus with :not(:focus-visible) on unrelated ancestor must fail Floor"
    );
    assert.equal(
      scanUiContent(".a { color: var(--fg) ! important; background: var(--bg) !IMPORTANT; }\n", "r29m7.css", { tier: "all" }).counts.reflex,
      2,
      "R29 A2-M7: ! important whitespace and case variants must be caught"
    );

    // Round 30 regressions (A2-H1 fn JSX //, A2-M2 SVG strings, A2-L6 multi-<style> focus check)
    assert.equal(
      scanUiContent(
        'export function Card() {\n  return (\n    <div>\n      // Route A\n      <button className="transition-all" />\n    </div>\n  );\n}\n',
        "r30h1.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R30 A2-H1: JSX inside function brace with // prose must flag transition-all"
    );
    const r30SvgStrRes = scanUiContent(
      'const open = "<svg>";\nexport const C = () => <button style={{ color: "#ff00aa !important" }} className="transition-all p-[13px]" />;\nconst close = "</svg>";\n',
      "r30m2.tsx",
      { tier: "all", surfaceMode: "operate" }
    );
    assert.equal(r30SvgStrRes.counts.floor, 1, "R30 A2-M2: <svg> string literals must not mask Floor findings");
    assert.ok(r30SvgStrRes.counts.reflex >= 1, "R30 A2-M2: <svg> string literals must not mask Reflex colors");
    assert.equal(
      scanUiContent(
        "<style>.btn:focus { outline: none; }</style>\n<style>.btn:focus-visible { outline: 2px solid var(--ring); }</style>\n",
        "r30l6.html",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R30 A2-L6: focus-visible in second unscoped <style> must cover first <style>"
    );
    assert.equal(
      scanUiContent(
        "<style>.btn:focus { outline: none; }</style>\n<style scoped>.btn:focus-visible { outline: 2px solid var(--ring); }</style>\n",
        "r30l6.vue",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R30 A2-L6: <style scoped> must NOT cover unscoped <style> focus removal"
    );

    // Round 31 regressions (A2-H1 async generic, A2-M4 masked tw tpl comparison, A2-M6 cross-<style> docBodyStart, A2-M8 non-zero ring-opacity)
    assert.equal(
      scanUiContent(
        'export const A = ({ v }: { v: string }) => <div className={`btn ${v === "bg-[#ef4444]" ? "bg-surface" : ""}`} />;\n',
        "r31m4a.tsx",
        { tier: "all" }
      ).counts.reflex,
      0,
      "R31 A2-M4: comparison string inside template expression must not trigger dsaf/tailwind-arbitrary"
    );
    assert.equal(
      scanUiContent(
        'export const B = ({ ok }: { ok: boolean }) => <div className={`btn ${ok ? "bg-[#ef4444]" : ""}`} />;\n',
        "r31m4b.tsx",
        { tier: "all" }
      ).counts.reflex,
      1,
      "R31 A2-M4: real ternary Tailwind arbitrary class inside template expression must still trigger"
    );
    assert.equal(isInvisibleTwFocusUtility("focus:ring-opacity-75"), false, "R31 A2-M8: ring-opacity-75 is visible");
    assert.equal(isInvisibleTwFocusUtility("focus:ring-opacity-[0.5]"), false, "R31 A2-M8: ring-opacity-[0.5] is visible");
    assert.equal(isInvisibleTwFocusUtility("focus:ring-opacity-0"), true, "R31 A2-M8: ring-opacity-0 is invisible");
    assert.equal(isInvisibleTwFocusUtility("focus:ring-opacity-[0%]"), true, "R31 A2-M8: ring-opacity-[0%] is invisible");
    assert.equal(isInvisibleTwFocusUtility("focus:ring-opacity-[0.0]"), true, "R31 A2-M8: ring-opacity-[0.0] is invisible");
    assert.equal(
      scanUiContent(
        'const f = async <Foo>(x: Foo): Promise<Foo> => x;\nexport const B = () => cva("p-[13px]");\nexport const C = () => <Foo><span /></Foo>;\n',
        "r31h1.tsx",
        { tier: "all" }
      ).counts.reflex,
      1,
      "R31 A2-H1: async generic + Promise return type must not pair with later <Foo></Foo>"
    );
    assert.equal(
      scanUiContent(
        `<style>\n/* ${"a".repeat(160)} */\n.btn:focus { outline: none; }\n</style>\n<style>.btn:focus-visible { outline: 2px solid blue; }</style>\n`,
        "r31m6a.html",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R31 A2-M6: short second <style> with smaller slice offset must still follow long first <style>"
    );
    assert.equal(
      scanUiContent(
        `<style>\n/* ${"a".repeat(160)} */\n.btn:focus-visible { outline: 2px solid blue; }\n</style>\n<style>.btn:focus { outline: none; }</style>\n`,
        "r31m6b.html",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R31 A2-M6: .btn:focus in second <style> must still override long first <style>"
    );

    // Round 32 regressions (A2-H1 @apply arbitrary syntax, A2-H2 Windows backslash HTML attrs, A2-M3 SFC <style> @theme/@property, A2-M4 url("#..."), A2-M5 TSX call-sig & style prose)
    const r32ApplyRes = scanUiContent(
      ".card { @apply [width:100vw] [transition:all] [outline:none]; }\n",
      "r32h1.css",
      { surfaceMode: "operate" }
    );
    assert.deepEqual(
      r32ApplyRes.active.filter((f) => f.tier === "floor").map((f) => f.ruleId).sort(),
      ["dsaf/no-100vw", "dsaf/no-outline-none-naked", "dsaf/no-transition-all"],
      "R32 A2-H1: @apply arbitrary utilities must be scanned once via Tailwind @apply path without duplicate raw CSS matches"
    );
    assert.equal(
      scanUiContent('<div data-win="\\" onclick="alert(1)"><button class="outline-none" /></div>', "r32h2.html", { surfaceMode: "operate" }).counts.floor,
      1,
      "R32 A2-H2: backslash before closing quote in HTML attribute must not escape quote"
    );
    assert.equal(
      scanUiContent('export const A = () => <><div data-win="\\" /><button className="outline-none" /></>;', "r32h2.tsx", { surfaceMode: "operate" }).counts.floor,
      1,
      "R32 A2-H2: backslash before closing quote in JSX attribute must not escape quote"
    );
    assert.equal(
      scanUiContent('<div style:color="\\" style:margin="x"><button class="outline-none" /></div>', "r32h2.svelte", { surfaceMode: "operate" }).counts.floor,
      1,
      "R32 A2-H2: backslash before closing quote in Svelte style directive must not escape quote"
    );
    assert.equal(
      scanUiContent('<div data-win="\\" className="outline-none transition-all" /><video data-win="\\" autoPlay src="/x.mp4" /><svg data-win="\\"><path fill="#ff00aa" /></svg>', "r32h2b.tsx", { surfaceMode: "operate" }).counts.floor,
      3,
      "R32 A2-H2: trailing backslash before quote must not swallow outline-none, transition-all, or autoPlay"
    );
    assert.equal(
      scanUiContent(
        '<style>@theme { --color-brand: #ff00aa; @apply bg-[#ff00aa] p-[12px]; .nested { color: red !important; } } @property --glow { syntax: "<color>"; initial-value: #112233 !important; inherits: false; }</style>',
        "r32m3a.vue",
        { tier: "all" }
      ).counts.reflex,
      0,
      "R32 A2-M3: @theme and @property inside Vue <style> must stay exempted"
    );
    assert.equal(
      scanUiContent(
        '<style>@theme { --color-brand: #112233; @apply bg-[#ff00aa]; } .a { color: red !important; @apply p-[13px]; }</style>',
        "r32m3b.vue",
        { tier: "all" }
      ).counts.reflex,
      2,
      "R32 A2-M3: regular rules following @theme inside Vue <style> must still be scanned"
    );
    assert.equal(
      scanUiContent('.a { background: url("foo#112233)bar.svg"); border-color: #445566; }\n', "r32m4.css", { tier: "all" }).counts.reflex,
      1,
      "R32 A2-M4: quoted url() containing ) after #hex must not prematurely end url() suppression"
    );
    const r32CallSigSrc =
      'interface I { <Item>(x: Item): void; }\nexport const A = () => <div className="bg-surface">style="--x: 1" style:--y="2"</div>;\nexport const B = () => <div style={{ color: "red !important" }} />;\nexport const C = () => <Item><span /></Item>;\n';
    assert.equal(
      scanUiContent(r32CallSigSrc, "r32m5.tsx", { tier: "all" }).active.filter((f) => f.ruleId === "dsaf/important-override").length,
      1,
      "R32 A2-M5: interface call signature and prose style= / style:--y= text must not confuse TSX Reflex scanner"
    );

    // Round 33 regressions (A2-H2 transition-[all] + [transition:all] + _all_, A2-H3 @layer cascade, A2-M6 not-(:focus-visible) & shadow-[...])
    assert.equal(
      scanUiContent(
        '<button class="transition-[all] [transition:all_200ms] transition-[color,_all]" /><Comp class:transition-[all]={x} />',
        "r33h2.svelte",
        { surfaceMode: "operate" }
      ).counts.floor,
      4,
      "R33 A2-H2: must detect transition-[all], [transition:all_200ms], transition-[color,_all], and Svelte class:transition-[all]"
    );
    assert.equal(
      scanUiContent(
        '<button class="transition-[all-scroll] transition-colors" />',
        "r33h2-neg.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R33 A2-H2: transition-[all-scroll] must not false-positive"
    );
    assert.equal(
      scanUiContent(
        '@layer overrides, reset;\n@layer reset { button:focus { outline: none; } }\n@layer overrides { button:focus-visible { outline: 2px solid #005fcc; } }\n',
        "r33h3-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R33 A2-H3: @layer reset (higher rank via @layer overrides, reset) must NOT be satisfied by earlier-declared lower-rank @layer overrides"
    );
    assert.equal(
      scanUiContent(
        '@layer base, overrides;\n@layer overrides { button:focus-visible { outline: 2px solid #005fcc; } }\n@layer base { button:focus { outline: none; } }\n',
        "r33h3-good.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R33 A2-H3: @layer overrides (higher rank) before @layer base satisfies focus-visible indicator"
    );
    assert.equal(
      scanUiContent(
        '<div class="not-(:focus-visible):outline-none [&_button:not(:focus-visible)]:outline-none" />\n<button class="outline-none focus-visible:shadow-[0_0_0_2px_#005fcc]" />\n<a class="outline-none focus-visible:[box-shadow:0_0_0_2px_var(--focus)]" />\n',
        "r33m6-good.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R33 A2-M6: not-(:focus-visible), [&_button:not(:focus-visible)], and visible focus-visible shadow-[...] must be allowed"
    );
    assert.equal(
      scanUiContent(
        '<div class="not-focus-visible:[&_button]:outline-none" />\n<div class="[&:not(:focus-visible)_button]:outline-none" />\n<button class="outline-none focus-visible:shadow-none" />\n<button class="outline-none focus-visible:shadow-[0_0_0_0_transparent]" />\n<button class="outline-none focus-visible:shadow-[0_0_0_2px_#005fcc] focus-visible:shadow-none" />\n',
        "r33m6-bad.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      5,
      "R33 A2-M6: parent-guarded target selectors & invisible/cancelled shadow focus rings must still fail Floor"
    );

    // Round 34 (A2-M1 hierarchical CSS @layer sub-layers/parent-child, A2-M2 Vue :class & Astro class:list siblings, A2-L3 extended tailwind-arbitrary & [color:#...], A2-L4 w-screen):
    assert.equal(
      scanUiContent(
        "@layer base, utilities;\n@layer utilities.sub { .btn:focus-visible { outline: 2px solid blue; } }\n@layer base.sub { .btn:focus { outline: none; } }\n",
        "r34-layer-sub-ok.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R34 A2-M1: @layer utilities.sub must outrank @layer base.sub when @layer base, utilities;"
    );
    assert.equal(
      scanUiContent(
        "@layer base {\n  @layer sub { .btn:focus { outline: none; } }\n  .btn:focus-visible { outline: 2px solid blue; }\n}\n",
        "r34-layer-parent-ok.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R34 A2-M1: parent @layer base rule must outrank child @layer base.sub"
    );
    assert.equal(
      scanUiContent(
        "@layer base {\n  @layer sub { .btn:focus-visible { outline: 2px solid blue; } }\n  .btn:focus { outline: none; }\n}\n",
        "r34-layer-parent-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R34 A2-M1: parent @layer base :focus { outline: none } must fail when overriding @layer base.sub :focus-visible"
    );
    assert.equal(
      scanUiContent("<template><button class=\"outline-none\" :class=\"['focus-visible:ring-2']\">Hi</button></template>", "r34-vue1.vue").counts.floor,
      0,
      "R34 A2-M2: Vue :class array unconditional literal must share siblingClasses with class"
    );
    assert.equal(
      scanUiContent("<template><button class=\"outline-none\" v-bind:class=\"['focus-visible:ring-2']\">Hi</button></template>", "r34-vue2.vue").counts.floor,
      0,
      "R34 A2-M2: Vue v-bind:class unconditional literal must share siblingClasses with class"
    );
    assert.equal(
      scanUiContent("<button class=\"outline-none\" class:list={['focus-visible:ring-2']}>Hi</button>", "r34-astro.astro").counts.floor,
      0,
      "R34 A2-M2: Astro class:list unconditional literal must share siblingClasses with class"
    );
    assert.equal(
      scanUiContent("<template><button class=\"outline-none\" :class=\"{ 'focus-visible:ring-2': isReady }\">Hi</button></template>", "r34-vue-cond.vue").counts.floor,
      1,
      "R34 A2-M2: Vue conditional object :class must NOT satisfy static class outline-none"
    );
    const r34ArbRes = scanUiContent(
      'export const A = () => <div className="text-[oklch(0.6_0.2_250)] [color:#ff00aa] [padding:13px] w-[317px] size-[24px] m-[-5px]" />;',
      "r34-arb.tsx",
      { tier: "all" }
    );
    assert.equal(r34ArbRes.counts.reflex, 6, "R34 A2-L3: extended tailwind-arbitrary color/property/sizing/negative px");
    const r34CssApplyColor = scanUiContent(".a { @apply [color:#ff00aa] [padding:13px]; }\n", "r34-apply-col.css", { tier: "all" });
    assert.deepEqual(
      r34CssApplyColor.active.map((f) => f.ruleId).sort(),
      ["dsaf/tailwind-arbitrary", "dsaf/tailwind-arbitrary"],
      "R34 A2-L3: @apply [color:#ff00aa] must emit tailwind-arbitrary without hardcoded-color double-count"
    );
    assert.equal(
      scanUiContent('export const A = () => <div className="w-screen min-w-screen max-w-screen w-screen-md" />;', "r34-wscreen.tsx").counts.floor,
      3,
      "R34 A2-L4: w-screen, min-w-screen, max-w-screen fail Floor while w-screen-md passes"
    );

    // Round 36 (R35-A2-H1..H4 & M2 focus/layer/box-shadow/variant-kill regressions):
    assert.equal(
      scanUiContent(
        "@layer base, components;\n@layer base { .btn:focus-visible { outline: 2px solid blue; box-shadow: none !important; } }\n@layer components { .btn:focus { outline: none; } }\n",
        "r36-h1-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R36 A2-H1: unrelated box-shadow: none !important in lower @layer must NOT waive higher @layer outline: none"
    );
    assert.equal(
      scanUiContent(
        "@layer base, components;\n@layer base { .btn:focus-visible { outline: 2px solid blue !important; } }\n@layer components { .btn:focus { outline: none; } }\n",
        "r36-h1-good.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R36 A2-H1: genuine outline !important in lower @layer must satisfy higher @layer normal outline: none"
    );
    assert.equal(
      scanUiContent(
        "@layer base, components;\n@layer components { .card:focus { outline: none; } }\n@layer base { .card:focus-within { outline: 2px solid blue; } }\n",
        "r36-h2-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R36 A2-H2: lower @layer base :focus-within must NOT waive higher @layer components :focus outline: none"
    );
    assert.equal(
      scanUiContent(
        "@layer components, base;\n@layer components { .card:focus { outline: none; } }\n@layer base { .card:focus-within { outline: 2px solid blue; } }\n",
        "r36-h2-good.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R36 A2-H2: higher @layer base :focus-within must waive lower @layer components :focus outline: none"
    );
    assert.equal(
      scanUiContent(
        ".btn:focus { outline: none; box-shadow: none !important; }\n.btn:focus-visible { box-shadow: 0 0 0 2px blue; }\n",
        "r36-h3.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R36 A2-H3: box-shadow: none !important on :focus must invalidate non-important :focus-visible box-shadow"
    );
    assert.equal(
      analyzeTailwindOutline("focus:outline-none focus-visible:ring-2 dark:focus-visible:ring-0").naked,
      true,
      "R36 A2-H4: dark:focus-visible:ring-0 conditional killer must fail unconditional focus-visible:ring-2"
    );
    assert.equal(
      analyzeTailwindOutline("dark:focus:outline-none focus-visible:ring-2 dark:focus-visible:ring-0").naked,
      true,
      "R36 A2-H4: dark:focus:outline-none must fail when dark:focus-visible:ring-0 cancels ring-2"
    );
    assert.equal(
      analyzeTailwindOutline("focus:outline-none focus-visible:ring-2 dark:focus-visible:ring-0 dark:focus-visible:outline-2").naked,
      false,
      "R36 A2-H4: dark fallback outline-2 restores dark mode alongside light focus-visible:ring-2"
    );
    const r36ExtDir = join(scratch, "r36-ext-layer");
    mkdirSync(r36ExtDir, { recursive: true });
    writeFileSync(join(r36ExtDir, "ds.css"), "@layer reset, components;\n@layer reset { .list:focus-within { outline: 2px solid blue; } }\n");
    writeFileSync(join(r36ExtDir, "app.css"), "@layer components { .list:focus { outline: none; } }\n");
    const r36ExtCheck = checkTarget(join(r36ExtDir, "app.css"), { dsCss: [join(r36ExtDir, "ds.css")] });
    assert.equal(
      r36ExtCheck.counts.floor,
      1,
      "R36 A2-M2: external DS @layer reset must NOT outrank local @layer components"
    );

    // Round 37 (R36-A2-M2 @layer/sibling :focus-visible override + R36-A2-M1 Vue TS cast):
    assert.equal(
      scanUiContent(
        "@layer reset, components;\n@layer reset { .btn:focus-visible { outline: none; } }\n@layer components { .btn:focus-visible { outline: 2px solid blue; } }\n",
        "r37-layer-ok.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R37 A2-M2: higher @layer components :focus-visible outline must satisfy lower @layer reset :focus-visible"
    );
    assert.equal(
      scanUiContent(
        "@layer components, reset;\n@layer reset { .btn:focus-visible { outline: none; } }\n@layer components { .btn:focus-visible { outline: 2px solid blue; } }\n",
        "r37-layer-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R37 A2-M2: lower @layer components without !important must fail @layer reset :focus-visible suppression"
    );
    assert.equal(
      scanUiContent(
        ".b, .b:focus-visible { outline: none; }\n.b:focus-visible { outline: 2px solid blue; }\n",
        "r37-grouped-ok.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R37 A2-M2: grouped reset restoring :focus-visible on later rule must pass"
    );
    assert.equal(
      scanUiContent(
        ".b:focus-visible { outline: 2px solid blue; }\n.b:focus-visible { outline: none; }\n",
        "r37-order-bad.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R37 A2-M2: earlier non-important :focus-visible must NOT satisfy later same-layer suppression"
    );
    assert.equal(
      scanUiContent(
        ".b:focus-visible { outline: 2px solid blue !important; }\n.b:focus-visible { outline: none; }\n",
        "r37-imp-ok.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R37 A2-M2: earlier !important :focus-visible must still satisfy later non-important suppression"
    );
    const r37VueRes = scanUiContent(
      [
        '<script setup lang="ts">',
        'const el = <HTMLElement>document.getElementById("x");',
        "const B = styled.button`outline: none; transition: all 200ms;`;",
        "</script>",
        '<template><div class="ok">ok</div></template>',
      ].join("\n"),
      "App.vue",
      { surfaceMode: "operate" }
    );
    assert.equal(r37VueRes.counts.floor, 2, "R37 A2-M1: SFC <script lang='ts'> cast must not mask styled.button Floor violations");

    // Round 38 (R37-A2-H1 @apply ring killers + R37-A2-M1 box-shadow/border unaffected by :focus outline:none):
    assert.equal(
      scanUiContent(".btn { @apply outline-none focus-visible:ring-2 !ring-0; }", "r38-h1-imp.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R38 A2-H1: @apply outline-none focus-visible:ring-2 !ring-0 must fail dsaf/no-outline-none-naked"
    );
    assert.equal(
      scanUiContent(".btn { @apply outline-none focus-visible:ring-2 ring-transparent; }", "r38-h1-trans.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R38 A2-H1: @apply outline-none focus-visible:ring-2 ring-transparent must fail dsaf/no-outline-none-naked"
    );
    assert.equal(
      scanUiContent(".btn { @apply outline-none focus-visible:ring-2 dark:focus-visible:ring-0; }", "r38-h1-dark.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R38 A2-H1: @apply outline-none focus-visible:ring-2 dark:focus-visible:ring-0 must fail dsaf/no-outline-none-naked"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { box-shadow: 0 0 0 3px #1d4ed8; }\n.btn:focus { outline: none; }\n", "r38-m1-order.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R38 A2-M1: earlier :focus-visible box-shadow satisfies later :focus { outline: none }"
    );
    assert.equal(
      scanUiContent("@layer components { .btn:focus-visible { box-shadow: 0 0 0 3px #1d4ed8; } }\n.btn:focus { outline: none; }\n", "r38-m1-layer.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R38 A2-M1: lower-layer :focus-visible box-shadow satisfies unlayered :focus { outline: none }"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { box-shadow: 0 0 0 3px #1d4ed8; }\n.btn:focus { outline: none; box-shadow: none; }\n", "r38-m1-suppressed.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R38 A2-M1: later :focus { box-shadow: none } still suppresses earlier non-important :focus-visible box-shadow"
    );
    assert.equal(
      scanUiContent(".btn { box-shadow: none; }\n.btn:focus-visible { box-shadow: 0 0 0 3px #1d4ed8; }\n.btn:focus { outline: none; }\n", "r38-m1-base-reset.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R38 A2-M1: base .btn { box-shadow: none } overridden by :focus-visible box-shadow satisfies :focus { outline: none }"
    );

    // Round 39 (R38-A2-H1 @apply border/shadow resets & R38-A2-H2 later/higher-spec/important suppressions):
    assert.equal(
      scanUiContent(".btn { border: 0 !important; outline: none; }\n.btn:focus-visible { @apply border-2 border-blue-500; }\n", "r39-h1a.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H1: inherited border: 0 !important must block non-important @apply border-2"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; border: 0 !important; @apply border-2; }\n", "r39-h1b.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H1: same-rule border: 0 !important must block non-important @apply border-2"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; box-shadow: none !important; @apply ring-2; }\n", "r39-h1c.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H1: same-rule box-shadow: none !important must block non-important @apply ring-2"
    );
    assert.equal(
      scanUiContent(".btn { border: 0 !important; outline: none; }\n.btn:focus-visible { @apply !border !border-solid !border-blue-500; }\n", "r39-h1d.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R39 A2-H1: !important @apply border/solid/color overrides base border: 0 !important"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; box-shadow: 0 0 0 2px #00f; }\n.btn:focus-visible { box-shadow: none; }\n", "r39-h2a.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H2: later :focus-visible box-shadow: none suppresses earlier box-shadow focus indicator"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; border: 2px solid #00f; }\n.btn:focus-visible { border: 0; }\n", "r39-h2b.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H2: later :focus-visible border: 0 suppresses earlier border focus indicator"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; @apply ring-2; }\n#app .btn:focus-visible { box-shadow: none; }\n", "r39-h2c.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H2: higher-specificity #app .btn:focus-visible box-shadow: none suppresses .btn:focus-visible @apply ring-2"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; @apply ring-2; }\n#app .btn:focus-visible { box-shadow: none; outline: 2px solid #00f; }\n", "r39-h2d.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R39 A2-H2: higher-specificity #app .btn:focus-visible with its own outline keeps Floor 0"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { border: 0 !important; }\n.btn:focus-visible { outline: none; border: 2px solid #00f; }\n", "r39-h2e.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H2: earlier :focus-visible border: 0 !important suppresses later non-important border"
    );
    assert.equal(
      scanUiContent(".btn:focus { outline: none; }\n.btn:focus-visible { border: 2px solid #00f; }\n.btn:focus-visible { border: 0; }\n", "r39-h2f.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R39 A2-H2: sibling :focus-visible overridden by later border: 0 fails Floor"
    );
    assert.equal(
      scanUiContent(".btn:focus-visible { outline: none; box-shadow: 0 0 0 2px #00f; }\n.btn:focus:not(:focus-visible) { box-shadow: none; }\n", "r39-h2g.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R39 A2-H2: mouse-only :focus:not(:focus-visible) box-shadow: none must not suppress :focus-visible"
    );

    // Round 40 (R39-A2-H1 quoted @apply strings, H2 comma-selector branch order, M3 non-trailing :focus*, M4 bracket/alpha '/', M5 focusRank > media):
    assert.equal(
      scanUiContent('.btn { outline: none; @apply before:content-["a focus-visible:ring-2 b"]; }\n', "r40-h1-ring.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R40 A2-H1: quoted focus-visible:ring-2 inside before:content-[...] must not satisfy outline: none"
    );
    assert.equal(
      scanUiContent('.btn { outline: none; @apply before:content-["a focus-visible:outline-2 b"]; }\n', "r40-h1-outline.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R40 A2-H1: quoted focus-visible:outline-2 inside before:content-[...] must not satisfy outline: none"
    );
    assert.equal(
      scanUiContent('.btn { outline: none; @apply focus-visible:ring-2 before:content-["a focus-visible:ring-0 b"]; }\n', "r40-h1-killer.css", { surfaceMode: "operate" }).counts.floor,
      0,
      "R40 A2-H1: quoted focus-visible:ring-0 inside before:content-[...] must not cancel valid focus-visible:ring-2"
    );
    assert.equal(
      scanUiContent("#app .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px blue; }\n#app .btn, #app .btn:focus-visible { box-shadow: none; }\n", "r40-h2-comma.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R40 A2-H2: comma-selector with second :focus-visible branch suppressing box-shadow must fail regardless of comma order"
    );
    assert.equal(
      scanUiContent('.btn:focus-visible[data-open="true"] { outline: none; box-shadow: 0 0 0 2px blue; }\n.btn[data-open="true"] { box-shadow: none !important; }\n', "r40-m3-attr.css", { surfaceMode: "operate" }).counts.floor,
      1,
      "R40 A2-M3: :focus-visible followed by [data-open='true'] must still match suppression on .btn[data-open='true']"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:outline-[2px_solid_oklch(0.6_0.2_250/0.8)]").naked,
      false,
      "R40 A2-M4: arbitrary outline-[...oklch(.../0.8)] slash alpha inside brackets must pass"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:ring-[2px_rgb(0_0_0/0.5)]").naked,
      false,
      "R40 A2-M4: arbitrary ring-[...rgb(.../0.5)] slash alpha inside brackets must pass"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:border-[2px_solid_hsl(220_90%_50%/0.8)]").naked,
      false,
      "R40 A2-M4: arbitrary border-[...hsl(.../0.8)] slash alpha inside brackets must pass"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:ring-2 md:ring-0").naked,
      false,
      "R40 A2-M5: base media variant md:ring-0 must not override focus-visible:ring-2"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none md:ring-0 focus-visible:ring-2").naked,
      false,
      "R40 A2-M5: leading md:ring-0 must not override focus-visible:ring-2"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:ring-2 md:focus-visible:ring-0").naked,
      true,
      "R40 A2-M5: md:focus-visible:ring-0 at same focusRank must still fail focus-visible:ring-2"
    );
    assert.equal(
      analyzeTailwindOutline("outline-none focus-visible:ring-2 md:!ring-0").naked,
      true,
      "R40 A2-M5: important md:!ring-0 must still override focus-visible:ring-2"
    );

    // Round 41 (R40-A2-H1 outline alpha-0 utilities, R40-A2-H2 external DS :focus-visible/:focus cascade, R40-A2-L1 $& in nested parent):
    assert.equal(analyzeTailwindOutline("outline-blue-500/0").naked, true, "R41 A2-H1: outline-blue-500/0 must fail naked outline check");
    assert.equal(analyzeTailwindOutline("focus:outline-red-500/0%").naked, true, "R41 A2-H1: focus:outline-red-500/0% must fail");
    assert.equal(analyzeTailwindOutline("outline-[#000]/0").naked, true, "R41 A2-H1: outline-[#000]/0 must fail");
    assert.equal(analyzeTailwindOutline("outline-opacity-0").naked, true, "R41 A2-H1: outline-opacity-0 must fail");
    assert.equal(analyzeTailwindOutline("outline-blue-500/0 focus-visible:ring-2").naked, false, "R41 A2-H1: outline-blue-500/0 with focus-visible:ring-2 must pass");
    assert.equal(analyzeTailwindOutline("outline-offset-0").naked, false, "R41 A2-H1: outline-offset-0 must not false-positive");

    const r41ExtDir = join(scratch, "r41-ext-fv");
    mkdirSync(r41ExtDir, { recursive: true });
    writeFileSync(
      join(r41ExtDir, "ds.css"),
      ".btn:focus-visible { outline: 2px solid #1d4ed8; }\n.imp:focus-visible { outline: 2px solid #1d4ed8 !important; }\n"
    );
    writeFileSync(join(r41ExtDir, "base.css"), ".btn { outline: none; }\n");
    writeFileSync(join(r41ExtDir, "focus-conflict.css"), ".btn:focus { outline: none; }\n");
    writeFileSync(join(r41ExtDir, "imp-ok.css"), ".imp:focus { outline: none; }\n");
    assert.equal(checkTarget(join(r41ExtDir, "base.css"), { dsCss: [join(r41ExtDir, "ds.css")] }).counts.floor, 0, "R41 A2-H2: external :focus-visible must satisfy unlayered base outline: none");
    assert.equal(checkTarget(join(r41ExtDir, "focus-conflict.css"), { dsCss: [join(r41ExtDir, "ds.css")] }).counts.floor, 1, "R41 A2-H2: non-important external :focus-visible must NOT override later local :focus { outline: none }");
    assert.equal(checkTarget(join(r41ExtDir, "imp-ok.css"), { dsCss: [join(r41ExtDir, "ds.css")] }).counts.floor, 0, "R41 A2-H2: !important external :focus-visible must satisfy local :focus { outline: none }");

    const r41DollarNest = extractCssRuleBlocks('[data-price="$&"] { &:focus { outline: none; } }');
    assert.ok(
      r41DollarNest.some((b) => b.resolvedSelector === '[data-price="$&"]:focus'),
      "R41 A2-L1: literal $& in parent selector must not expand replace pattern"
    );

    // Round 42 (R41-A2-M1 :focus + :not(:focus-visible) border suppression, R41-A2-M2 comma-branch specificity, R41-A2-M3 external partial @layer topo order):
    assert.equal(
      scanUiContent(
        ".btn:focus { outline: none; box-shadow: 0 0 0 2px #1d4ed8; }\n.btn:focus:not(:focus-visible) { box-shadow: none; }\n",
        "r42-focus-not-fv.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R42 A2-M1: :focus:not(:focus-visible) { box-shadow: none } must not suppress :focus keyboard ring"
    );
    assert.equal(
      scanUiContent(
        "#app .other:focus, .btn:focus { outline: none; box-shadow: 0 0 0 2px #1d4ed8; }\n.btn.primary:focus { box-shadow: none; outline: 2px solid #000000; }\n",
        "r42-branch-spec.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R42 A2-M2: comma-grouped refBlk must compare matching branch .btn:focus [0,2,0], not summed list specificity"
    );
    const r42ExtLayerDir = join(scratch, "r42-ext-layer-topo");
    mkdirSync(r42ExtLayerDir, { recursive: true });
    writeFileSync(join(r42ExtLayerDir, "ds.css"), "@layer components { .btn:focus-visible { outline: 2px solid #1d4ed8; } }\n");
    writeFileSync(join(r42ExtLayerDir, "app.css"), "@layer base, components;\n@layer base { .btn:focus { outline: none; } }\n");
    assert.equal(
      checkTarget(join(r42ExtLayerDir, "app.css"), { dsCss: [join(r42ExtLayerDir, "ds.css")] }).counts.floor,
      0,
      "R42 A2-M3: app @layer base, components must outrank external @layer components even when DS omits base"
    );

    // Round 43 (R42-A2-H3 compareCascadeLayerOrder, R42-A2-M9 broader base border suppression, R42-A2-H4 @apply CSS box-shadow suppression, R42-A3-M12 includeDemos):
    assert.equal(
      scanUiContent(
        "@layer a, b, c;\n@layer c { .x:focus-visible { box-shadow: 0 0 0 2px #1d4ed8; } }\n@layer b { .x:focus-visible { box-shadow: none; } }\n@layer a { .x:focus-visible { outline: none; box-shadow: 0 0 0 2px #000000; } }\n",
        "r43-multi-layer.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R43 A2-H3: @layer c must beat @layer b even when @layer c precedes @layer b in source order"
    );
    assert.equal(
      scanUiContent(
        "@layer a, b, c;\n@layer c { .x:focus-visible { box-shadow: none; } }\n@layer b { .x:focus-visible { box-shadow: 0 0 0 2px #1d4ed8; } }\n@layer a { .x:focus-visible { outline: none; box-shadow: 0 0 0 2px #000000; } }\n",
        "r43-multi-layer-kill.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R43 A2-H3: @layer c killer must beat @layer b restoration even when @layer c appears earlier"
    );
    assert.equal(
      scanUiContent(
        ".btn { border: 0 !important; }\nbutton.btn:focus-visible { outline: none; border: 2px solid #1d4ed8; }\n",
        "r43-broad-border-imp.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R43 A2-M9: broader base .btn { border: 0 !important } must suppress button.btn:focus-visible border"
    );
    assert.equal(
      scanUiContent(
        ".btn { border: 0; }\nbutton.btn:focus-visible { outline: none; border: 2px solid #1d4ed8; }\n",
        "r43-broad-border-norm.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R43 A2-M9: higher-specificity button.btn:focus-visible border must override non-important broader .btn { border: 0 }"
    );
    assert.equal(
      scanUiContent(
        ".btn { @apply outline-none focus-visible:ring-2; box-shadow: none !important; }\n",
        "r43-apply-box-sup.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R43 A2-H4: non-naked @apply ring suppressed by CSS box-shadow: none !important must fail Floor"
    );
    const r43DemoDir = join(scratch, "r43-demo-flag");
    mkdirSync(join(r43DemoDir, "demos"), { recursive: true });
    writeFileSync(join(r43DemoDir, "demos/card.css"), ".card:focus { outline: none; }\n");
    assert.equal(checkTarget(r43DemoDir).counts.floor, 0, "R43 A3-M12: default checkTarget must skip demos/");
    assert.equal(checkTarget(r43DemoDir, { includeDemos: true }).counts.floor, 1, "R43 A3-M12: includeDemos: true must scan demos/");

    // Round 44 (R43-A2-H5 shadow vs ring, R43-A2-H6 @apply border/shadow suppression, R43-A2-H7 [outline:...], R43-A2-M8 focus-visible:[border:...]):
    assert.equal(analyzeTailwindOutline("shadow-none outline-none focus-visible:ring-2").naked, false, "R44 A2-H5: base shadow-none overridden by focus-visible:ring-2 must remain valid");
    assert.equal(analyzeTailwindOutline("!shadow-none outline-none focus-visible:ring-2").naked, true, "R44 A2-H5: !shadow-none cancels focus-visible:ring-2");
    assert.equal(analyzeTailwindOutline("[box-shadow:none]! outline-none focus-visible:ring-2").naked, true, "R44 A2-H5: [box-shadow:none]! cancels focus-visible:ring-2");
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus-visible:shadow-none").naked, true, "R44 A2-H5: focus-visible:shadow-none cancels focus-visible:ring-2");
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 focus-visible:[box-shadow:none]").naked, true, "R44 A2-H5: focus-visible:[box-shadow:none] cancels focus-visible:ring-2");
    assert.equal(analyzeTailwindOutline("outline-none focus-visible:ring-2 dark:focus-visible:[box-shadow:none]").naked, true, "R44 A2-H5: dark:focus-visible:[box-shadow:none] cancels focus-visible:ring-2 in dark mode");
    assert.equal(analyzeTailwindOutline("!shadow-none outline-none !focus-visible:ring-2").naked, false, "R44 A2-H5: !focus-visible:ring-2 beats !shadow-none");

    assert.equal(
      scanUiContent(
        ".btn { @apply border-0 !important; }\n.btn:focus-visible { outline: none; border: 2px solid #1d4ed8; }\n",
        "r44-apply-border0.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R44 A2-H6: base @apply border-0 !important must suppress focus-visible border"
    );
    assert.equal(
      scanUiContent(
        ".btn:focus-visible { outline: none; @apply border-none !important; border: 2px solid #1d4ed8; }\n",
        "r44-apply-bordernone-self.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R44 A2-H6: same-rule @apply border-none !important must block CSS border indicator"
    );
    assert.equal(
      scanUiContent(
        ".btn { @apply shadow-none !important; }\n.btn:focus-visible { @apply outline-none focus-visible:ring-2; }\n",
        "r44-apply-shadownone.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R44 A2-H6: base @apply shadow-none !important must suppress focus-visible:ring-2"
    );
    const r44ArbOutlineUnrecovRes = scanUiContent(
      ".btn { @apply outline-none focus-visible:[outline:2px_solid_#1d4ed8]; outline: none !important; }\n",
      "r44-apply-arb-outline-unrecov.css",
      { surfaceMode: "operate" }
    );
    assert.equal(
      r44ArbOutlineUnrecovRes.counts.floor,
      2,
      "R44 A2-H7: @apply focus-visible:[outline:...] must fail alongside unrecoverable CSS outline: none !important"
    );
    assert.ok(r44ArbOutlineUnrecovRes.active.some((f) => /@apply outline-none/i.test(f.message)));
    assert.ok(r44ArbOutlineUnrecovRes.active.some((f) => /outline: none !important/i.test(f.message)));
    assert.equal(
      scanUiContent(
        ".btn { @apply outline-none focus-visible:[outline-color:#1d4ed8]; }\n",
        "r44-apply-arb-outline-coloronly.css",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R44 A2-H7: @apply focus-visible:[outline-color:#1d4ed8] alone must not count as full outline"
    );
    assert.equal(
      scanUiContent(
        '<button className="outline-none focus-visible:[border:2px_solid_#1d4ed8]">Go</button>\n',
        "r44-tw-arb-border-vis.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      0,
      "R44 A2-M8: focus-visible:[border:2px_solid_#1d4ed8] must be accepted as visible border replacement"
    );
    assert.equal(
      scanUiContent(
        '<button className="outline-none focus-visible:[border:2px_solid_transparent]">Go</button>\n',
        "r44-tw-arb-border-trans.tsx",
        { surfaceMode: "operate" }
      ).counts.floor,
      1,
      "R44 A2-M8: focus-visible:[border:2px_solid_transparent] must still fail Floor"
    );

    // Round 45 (TW v4 untyped (--var) color classification + statement-level @apply ... !important + base-rule @apply outline-none):
    for (const [label, twSnippet] of [
      ["outline-(--brand)", '<button className="outline-none focus-visible:outline-(--brand)">Go</button>\n'],
      ["ring-0 + ring-(--brand)", '<button className="outline-none focus-visible:ring-0 focus-visible:ring-(--brand)">Go</button>\n'],
      ["border-0 + border-(--brand)", '<button className="outline-none focus-visible:border-0 focus-visible:border-(--brand)">Go</button>\n'],
    ]) {
      assert.equal(
        scanUiContent(twSnippet, "r45-twv4-bad.tsx", { tier: "floor" }).counts.floor,
        1,
        `R45 A2-H1: untyped TW v4 color utility ${label} must not satisfy width/style`
      );
    }
    for (const [label, twSnippet] of [
      ["outline-2 outline-solid outline-(--brand)", '<button className="outline-none outline-transparent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-(--brand)">Go</button>\n'],
      ["ring-2 ring-(--brand)", '<button className="outline-none ring-transparent focus-visible:ring-2 focus-visible:ring-(--brand)">Go</button>\n'],
      ["outline-(length:--w)", '<button className="outline-none focus-visible:outline-(length:--focus-width)">Go</button>\n'],
    ]) {
      assert.equal(
        scanUiContent(twSnippet, "r45-twv4-ok.tsx", { tier: "floor" }).counts.floor,
        0,
        `R45 A2-H1: explicit width+style + TW v4 ${label} must pass Floor`
      );
    }
    for (const [label, cssSnippet] of [
      ["same-rule !outline-none + outline", ".btn { @apply !outline-none; outline: 2px solid #1d4ed8; }\n"],
      ["same-rule @apply outline-none !important + outline", ".btn { @apply outline-none !important; outline: 2px solid #1d4ed8; }\n"],
      ["base @apply outline-none !important + :focus-visible outline", ".btn { @apply outline-none !important; }\n.btn:focus-visible { outline: 2px solid #1d4ed8; }\n"],
      ["@apply outline-none !important + second non-imp @apply", ".btn { @apply outline-none !important;\n  @apply focus-visible:outline-2; }\n"],
    ]) {
      assert.equal(
        scanUiContent(cssSnippet, "r45-apply-imp-bad.css", { tier: "floor" }).counts.floor,
        1,
        `R45 A2-H2: ${label} must fail Floor`
      );
    }
    assert.equal(
      scanUiContent(".btn { @apply outline-none; outline: 2px solid #1d4ed8; }\n", "r45-apply-nonimp-ok.css", { tier: "floor" }).counts.floor,
      0,
      "R45 A2-H2: non-important base @apply outline-none followed by CSS outline must pass Floor"
    );
    assert.equal(
      scanUiContent(".btn { @apply outline-none focus-visible:outline-2 !important; }\n", "r45-apply-same-stmt-imp-ok.css", { tier: "floor" }).counts.floor,
      0,
      "R45 A2-H2: statement-level !important applying to both outline-none and focus-visible:outline-2 must pass Floor"
    );

    // Round 46 (A2-H1 color-mix/light-dark zero-alpha focus ring + A2-M3 TW arbitrary color/color-mix/light-dark):
    for (const [label, fname, snippet, expFloor] of [
      ["color-mix 0% transparent outline", "r46-cm-outline.css", ".b:focus { outline: none; }\n.b:focus-visible { outline: 2px solid color-mix(in srgb, red 0%, transparent); }\n", 2],
      ["color-mix transparent transparent box-shadow", "r46-cm-shadow.css", ".b:focus { outline: none; }\n.b:focus-visible { box-shadow: 0 0 0 2px color-mix(in oklch, transparent, transparent); }\n", 1],
      ["light-dark(transparent, #1d4ed8) outline", "r46-ld-outline.css", ".b:focus { outline: none; }\n.b:focus-visible { outline: 2px solid light-dark(transparent, #1d4ed8); }\n", 2],
      ["TW arb outline color-mix zero", "r46-tw-cm.tsx", '<button className="outline-none focus-visible:outline-[2px_solid_color-mix(in_srgb,red_0%,transparent)]">Go</button>\n', 1],
      ["TW arb shadow light-dark transparent", "r46-tw-ld.tsx", '<button className="outline-none focus-visible:shadow-[0_0_0_2px_light-dark(transparent,transparent)]">Go</button>\n', 1],
    ]) {
      assert.equal(scanUiContent(snippet, fname, { tier: "floor" }).counts.floor, expFloor, `R46 A2-H1: ${label} must fail Floor`);
    }
    for (const [label, fname, snippet] of [
      ["visible color-mix outline", "r46-cm-ok.css", ".b:focus { outline: none; }\n.b:focus-visible { outline: 2px solid color-mix(in srgb, #1d4ed8 80%, transparent); }\n"],
      ["visible light-dark outline", "r46-ld-ok.css", ".b:focus { outline: none; }\n.b:focus-visible { outline: 2px solid light-dark(#1d4ed8, #93c5fd); }\n"],
      ["visible color-mix(var) outline", "r46-cm-var-ok.css", ".b:focus { outline: none; }\n.b:focus-visible { outline: 2px solid color-mix(in srgb, var(--ring) 80%, transparent); }\n"],
    ]) {
      assert.equal(scanUiContent(snippet, fname, { tier: "floor" }).counts.floor, 0, `R46 A2-H1: ${label} must pass Floor`);
    }
    const r46TwArbRes = scanUiContent(
      '<div className="bg-[color(display-p3_1_0.2_0.1)] bg-[color-mix(in_srgb,#ef4444_50%,#1d4ed8)] bg-[color-mix(in_srgb,red_50%,blue)] bg-[light-dark(red,blue)]" />\n',
      "r46-tw-arb.tsx",
      { tier: "all" }
    );
    assert.equal(r46TwArbRes.counts.reflex, 4, "R46 A2-M3: color()/color-mix()/light-dark() TW arbitrary utils must emit 4 findings");
    assert.ok(r46TwArbRes.active.every((f) => f.ruleId === "dsaf/tailwind-arbitrary"));

    // Round 47 (A2-H1 @apply focus suppression, A2-H2 arbitrary TW focus variants, A2-H3 inset-ring, A2-M5 sibling base @apply / :where coverage):
    for (const [label, fname, snippet, expFloor] of [
      ["@apply focus-visible:border-2 suppressed by :focus border:0 !important", "r47-h1-border.css", ".btn { @apply outline-none focus-visible:border-2 focus-visible:border-blue-500; }\n.btn:focus { border: 0 !important; }\n", 1],
      ["@apply focus-visible:ring-2 suppressed by :focus-visible box-shadow:none !important", "r47-h1-ring.css", ".btn { @apply outline-none focus-visible:ring-2 focus-visible:ring-blue-500; }\n.btn:focus-visible { box-shadow: none !important; }\n", 1],
      ["TW [&:hover:focus-visible]:ring-2 conditional only", "r47-h2-hover.tsx", '<button className="outline-none [&:hover:focus-visible]:ring-2 [&:hover:focus-visible]:ring-blue-500">Go</button>\n', 1],
      ["TW [&:focus:not(:focus-visible)]:ring-2 not keyboard safe", "r47-h2-notfv.tsx", '<button className="outline-none [&:focus:not(:focus-visible)]:ring-2">Go</button>\n', 1],
      ["TW inset-ring-blue-500 color only without width", "r47-h3-col.tsx", '<button className="outline-none focus-visible:inset-ring-blue-500">Go</button>\n', 1],
      ["TW inset-ring-2 killed by inset-ring-0", "r47-h3-kill.tsx", '<button className="outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-0">Go</button>\n', 1],
      ["TW inset-ring-2 killed by shadow-none", "r47-h3-shadow.tsx", '<button className="outline-none focus-visible:inset-ring-2 focus-visible:shadow-none">Go</button>\n', 1],
      ["CSS .btn static outline does NOT cover .btn:focus", "r47-m5-static.css", ".btn:focus { outline: none; }\n.btn { outline: 2px solid #1d4ed8; }\n", 1],
      ["CSS lower-specificity .btn:focus-visible does NOT cover a.btn:focus", "r47-m5-lowspec.css", "a.btn:focus { outline: none; }\n.btn:focus-visible { outline: 2px solid #1d4ed8; }\n", 1],
      ["CSS .btn:focus-visible does NOT cover :where(.btn, .link):focus", "r47-m5-multi.css", ":where(.btn, .link):focus { outline: none; }\n.btn:focus-visible { outline: 2px solid #1d4ed8; }\n", 1],
    ]) {
      assert.equal(scanUiContent(snippet, fname, { tier: "floor" }).counts.floor, expFloor, `R47: ${label} must fail Floor`);
    }
    for (const [label, fname, snippet] of [
      ["TW [&:focus-visible]:ring-2", "r47-h2-ok1.tsx", '<button className="outline-none [&:focus-visible]:ring-2 [&:focus-visible]:ring-blue-500">Go</button>\n'],
      ["TW [&:focus]:outline-2", "r47-h2-ok2.tsx", '<button className="outline-none [&:focus]:outline-2 [&:focus]:outline-blue-600">Go</button>\n'],
      ["TW [&_input]:outline-none [&:focus-within]:ring-2", "r47-h2-ok3.tsx", '<div className="[&_input]:outline-none [&:focus-within]:ring-2 [&:focus-within]:ring-blue-500"><input /></div>\n'],
      ["TW [&_button]:outline-none [&_button:focus-visible]:ring-2", "r47-h2-ok4.tsx", '<div className="[&_button]:outline-none [&_button:focus-visible]:ring-2"><button>Go</button></div>\n'],
      ["TW [&:focus:not(:focus-visible)]:outline-none", "r47-h2-ok5.tsx", '<button className="[&:focus:not(:focus-visible)]:outline-none">Go</button>\n'],
      ["TW focus-visible:inset-ring-2 focus-visible:inset-ring-blue-500", "r47-h3-ok1.tsx", '<button className="outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-blue-500">Go</button>\n'],
      ["TW focus-visible:inset-ring", "r47-h3-ok2.tsx", '<button className="outline-none focus-visible:inset-ring">Go</button>\n'],
      ["TW focus-visible:inset-ring-2 unaffected by ring-0", "r47-h3-ok3.tsx", '<button className="outline-none focus-visible:inset-ring-2 focus-visible:ring-0">Go</button>\n'],
      ["CSS .btn:focus covered by .btn { @apply focus-visible:ring-2 }", "r47-m5-ok1.css", ".btn:focus { outline: none; }\n.btn { @apply focus-visible:ring-2 focus-visible:ring-blue-500; }\n"],
      ["CSS :where(.btn):focus covered by .btn:focus-visible", "r47-m5-ok2.css", ":where(.btn):focus { outline: none; }\n.btn:focus-visible { outline: 2px solid #1d4ed8; }\n"],
      ["CSS .btn:focus-visible earlier higher-spec covers :where(.btn):focus", "r47-m5-ok3.css", ".btn:focus-visible { outline: 2px solid #1d4ed8; }\n:where(.btn):focus { outline: none; }\n"],
    ]) {
      assert.equal(scanUiContent(snippet, fname, { tier: "floor" }).counts.floor, 0, `R47: ${label} must pass Floor`);
    }

    // Round 48 regressions (A1-M1, A2-H1..H5, A2-M1..M2):
    const r48Tmp = mkdtempSync(join(tmpdir(), "dsaf-r48-hook-"));
    try {
      // A1-M1: escaping file/dir symlinks skipped in directory walk, explicit file symlink still allowed
      const r48Out = join(r48Tmp, "outside");
      const r48Repo = join(r48Tmp, "repo");
      mkdirSync(join(r48Out, "sub"), { recursive: true });
      mkdirSync(join(r48Repo, "src"), { recursive: true });
      writeFileSync(join(r48Out, "leak.css"), ".bad:focus { outline: none; color: #ff00aa; }\n");
      writeFileSync(join(r48Out, "sub/dir-leak.css"), ".dir-bad:focus { outline: none; }\n");
      writeFileSync(join(r48Repo, "src/ok.css"), ".ok:focus-visible { outline: 2px solid var(--focus); }\n");
      symlinkSync(join(r48Out, "leak.css"), join(r48Repo, "src/leak-link.css"));
      symlinkSync(join(r48Out, "sub"), join(r48Repo, "src/ext-dir"));
      assert.equal(collectUiFiles(r48Repo).length, 1, "R48 A1-M1: collectUiFiles must ignore symlinks escaping target root");
      const r48DirRes = checkTarget(r48Repo, { tier: "all" });
      assert.equal(r48DirRes.filesScanned, 1);
      assert.equal(r48DirRes.passed, true);
      const r48FileRes = checkTarget(join(r48Repo, "src/leak-link.css"), { tier: "all" });
      assert.equal(r48FileRes.filesScanned, 1);
      assert.equal(r48FileRes.counts.floor, 1);
      assert.equal(r48FileRes.counts.reflex, 1);

      // A2-H1: external --ds-css suppressions propagate to local Floor focus checks
      const r48ExtDir = join(r48Tmp, "ext-ds");
      mkdirSync(r48ExtDir, { recursive: true });
      const extCssPath = join(r48ExtDir, "ext.css");
      writeFileSync(extCssPath, ".ext-btn { border: 0 !important; }\n.ext-btn2:focus-visible { outline: none !important; }\n.ext-btn3 { outline: none !important; }\n");
      const localBtnCss = join(r48ExtDir, "btn.css");
      writeFileSync(localBtnCss, ".ext-btn:focus { outline: none; }\n.ext-btn:focus-visible { border: 2px solid var(--ring); }\n");
      assert.equal(checkTarget(localBtnCss, { tier: "floor", dsCss: [extCssPath] }).counts.floor, 1, "R48 A2-H1: external border:0 !important must defeat local focus-visible border");
      const localBtn2Css = join(r48ExtDir, "btn2.css");
      writeFileSync(localBtn2Css, ".ext-btn2:focus { outline: none; }\n.ext-btn2:focus-visible { outline: 2px solid var(--ring); }\n");
      assert.equal(checkTarget(localBtn2Css, { tier: "floor", dsCss: [extCssPath] }).counts.floor, 1, "R48 A2-H1: external outline:none !important must defeat local focus-visible outline");
      const localBtn2ImpCss = join(r48ExtDir, "btn2-imp.css");
      writeFileSync(localBtn2ImpCss, ".ext-btn2:focus { outline: none; }\n.ext-btn2:focus-visible { outline: 2px solid var(--ring) !important; }\n");
      assert.equal(checkTarget(localBtn2ImpCss, { tier: "floor", dsCss: [extCssPath] }).counts.floor, 0, "R48 A2-H1: local !important focus-visible outline recovers over earlier external outline:none !important");
      const localBtn3Css = join(r48ExtDir, "btn3.css");
      writeFileSync(localBtn3Css, ".ext-btn3:focus { outline: none; }\n.ext-btn3:focus-visible { outline: 2px solid var(--ring); }\n");
      assert.equal(checkTarget(localBtn3Css, { tier: "floor", dsCss: [extCssPath] }).counts.floor, 1, "R48 A2-H1: external base outline:none !important must defeat local non-important focus-visible outline");
    } finally {
      rmSync(r48Tmp, { recursive: true, force: true });
    }

    // A2-H2: @apply ring/inset-ring family isolation & directional/4-side border suppression
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { @apply ring-2 ring-blue-500; }\n.a { @apply ring-0 !important; }\n", "r48h2a.css").counts.floor, 1);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { @apply inset-ring-2 inset-ring-blue-500; }\n.a { @apply ring-0 !important; }\n", "r48h2b.css").counts.floor, 0);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { @apply inset-ring-2 inset-ring-blue-500; }\n.a { @apply inset-ring-0 !important; }\n", "r48h2c.css").counts.floor, 1);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { @apply inset-ring-2 inset-ring-blue-500; }\n.a { box-shadow: none !important; }\n", "r48h2d.css").counts.floor, 1);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { border-top: 2px solid var(--ring); }\n.a { border-top: 0 !important; }\n", "r48h2e.css").counts.floor, 1);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { border-top: 2px solid var(--ring); }\n.a { border-bottom: 0 !important; }\n", "r48h2f.css").counts.floor, 0);
    assert.equal(scanUiContent(".a:focus { outline: none; }\n.a:focus-visible { @apply border-2 border-blue-500; }\n.a { @apply border-x-0 border-y-0 !important; }\n", "r48h2g.css").counts.floor, 1);

    // A2-H3: @apply focus-visible:outline-* works even when plain outline on base selector wouldn't count
    assert.equal(scanUiContent(".btn:focus { outline: none; }\n.btn { @apply focus-visible:outline-2 focus-visible:outline-offset-2; }\n", "r48h3a.css").counts.floor, 0);
    assert.equal(scanUiContent(".btn:focus { outline: none; }\n.btn { outline: 2px solid #1d4ed8; }\n", "r48h3b.css").counts.floor, 1);

    // A2-H4: styled.div interpolations (arrow fn, block return, whole-decl, focus-conditional outline)
    assert.equal(scanUiContent('const A = styled.div`transition: ${(p) => (p.fast ? "all 150ms" : "opacity 150ms")};`;', "r48h4a.tsx").counts.floor >= 1, true);
    assert.equal(scanUiContent('const B = styled.div`width: ${(p) => { return "100vw"; }};`;', "r48h4b.tsx").counts.floor >= 1, true);
    assert.equal(scanUiContent('const C = styled.div`${(p) => (p.flat ? "outline: none;" : "")}`;', "r48h4c.tsx").counts.floor >= 1, true);
    assert.equal(scanUiContent('const D = styled.div`outline: ${(p) => (p.isFocused ? "2px solid blue" : "none")};`;', "r48h4d.tsx").counts.floor, 0);

    // A2-H5: Tailwind :is()/:where()/has-(...)/[&:has(...)] focus-visible variants
    for (const [label, cls] of [
      ["[&:is(:focus-visible)]", "outline-none [&:is(:focus-visible)]:ring-2"],
      ["[&:where(:focus-visible)]", "outline-none [&:where(:focus-visible)]:ring-2"],
    ]) {
      assert.equal(scanUiContent(`<button className="${cls}">Go</button>`, "r48h5.tsx").counts.floor, 0, `R48 A2-H5: ${label} must pass Floor`);
    }
    assert.equal(scanUiContent('<div className="[&>input]:outline-none has-(>input:focus-visible):ring-2"><input /></div>', "r48h5-has1.tsx").counts.floor, 0, "R48 A2-H5: has-(>input:focus-visible) wrapper covers child removal");
    assert.equal(scanUiContent('<div className="[&_button]:outline-none [&:has(button:focus-visible)]:ring-2"><button>Go</button></div>', "r48h5-has2.tsx").counts.floor, 0, "R48 A2-H5: [&:has(button:focus-visible)] wrapper covers child removal");
    assert.equal(scanUiContent('<button className="outline-none has-(>input:focus-visible):ring-2">Go</button>', "r48h5-neg.tsx").counts.floor, 1, "R48 A2-H5: has-focus must NOT cover own outline-none");

    // A2-M1: combinator & non-focus :not(...) strictness
    assert.equal(scanUiContent(".nav > .btn:focus { outline: none; }\n.nav + .btn:focus-visible { outline: 2px solid var(--ring); }\n", "r48m1a.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:focus { outline: none; }\n.btn:not(.primary):focus-visible { outline: 2px solid var(--ring); }\n", "r48m1b.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:not(.disabled):focus { outline: none; }\n.btn:focus-visible { outline: 2px solid var(--ring); }\n", "r48m1c-neg.css").counts.floor, 1);
    assert.equal(scanUiContent(".btn:not(.disabled):focus { outline: none; }\n.btn:focus-visible { outline: 2px solid var(--ring) !important; }\n", "r48m1c-ok.css").counts.floor, 0);
    assert.equal(scanUiContent(".nav > .btn:focus { outline: none; }\n.nav .btn:focus-visible { outline: 2px solid var(--ring); }\n", "r48m1d-ok.css").counts.floor, 0);

    // A2-M2: Reflex dsaf/hardcoded-color on functional colors & UI files + waivers
    assert.equal(scanUiContent(".a { color: rgb(10, 20, 30); border-color: oklch(0.6 0.2 250); background: color-mix(in oklch, red 50%, transparent); }\n", "r48m2a.css", { tier: "all" }).counts.reflex, 3);
    assert.equal(scanUiContent(".a { background: color-mix(in oklch, #ff00aa 50%, transparent); }\n", "r48m2b.css", { tier: "all" }).counts.reflex, 1);
    assert.equal(scanUiContent(".a { color: oklch(from var(--brand) l c h); background: color-mix(in oklch, var(--bg) 80%, transparent); }\n", "r48m2c.css", { tier: "all" }).counts.reflex, 0);
    assert.equal(scanUiContent('<div style={{ color: "#ff00aa", background: "rgb(10, 20, 30)" }} />', "r48m2d.tsx", { tier: "all" }).counts.reflex, 2);
    assert.equal(scanUiContent('const C = styled.div`color: oklch(0.6 0.2 250);`;', "r48m2e.tsx", { tier: "all" }).counts.reflex, 1);
    assert.equal(scanUiContent("<style>.x { color: #112233; }</style>\n<div>ok</div>\n", "r48m2f.svelte", { tier: "all" }).counts.reflex, 1);
    const r48WaivedColor = scanUiContent(
      '/* dsaf-ignore dsaf/hardcoded-color -- approved brand showcase swatch */\nconst Sw = () => <div style={{ color: "#ff00aa" }} />;\n',
      "r48m2g.tsx",
      { tier: "all", reportUnusedIgnores: true }
    );
    assert.equal(r48WaivedColor.counts.reflex, 0);
    assert.equal(r48WaivedColor.unusedIgnores.length, 0);

    // Round 49 regressions (R49-A2-H2, R49-A2-M1, R49-A2-M2):
    const r49Tmp = mkdtempSync(join(tmpdir(), "dsaf-r49-hook-"));
    try {
      // R49-A2-H2: sequential external --ds-css rules cancel earlier external focus-visible indicator
      const extSeqCss = join(r49Tmp, "seq-ds.css");
      writeFileSync(extSeqCss, ".btn:focus-visible { outline: 2px solid #005fcc; }\n.btn:focus-visible { outline: none; }\n.card:focus-visible { box-shadow: 0 0 0 2px #005fcc; }\n.card:focus-visible { box-shadow: none; }\n");
      const localSeqCss = join(r49Tmp, "local.css");
      writeFileSync(localSeqCss, ".btn { outline: none; }\n.card { outline: none; }\n");
      assert.equal(checkTarget(localSeqCss, { tier: "floor", dsCss: [extSeqCss] }).counts.floor, 2, "R49 A2-H2: sequential external suppressions must defeat earlier external focus-visible");
      const inMemExt = [
        { selector: ".btn:focus-visible", resolvedSelector: ".btn:focus-visible", body: "outline: 2px solid #005fcc;", conditions: [], source: "mem.css" },
        { selector: ".btn:focus-visible", resolvedSelector: ".btn:focus-visible", body: "outline: none;", conditions: [], source: "mem.css" },
      ];
      assert.equal(scanUiContent(".btn { outline: none; }\n", "mem-local.css", { externalCssBlocks: inMemExt }).counts.floor, 1, "R49 A2-H2: in-memory external blocks without bodyStart must preserve array order");
    } finally {
      rmSync(r49Tmp, { recursive: true, force: true });
    }

    // R49-A2-M1: :is(:focus-visible), :where(:focus-visible), :is(:focus, :focus-visible), :is(:where(:focus-visible))
    for (const [label, src, fname] of [
      [":is(:focus-visible)", ".btn:focus { outline: none; }\n.btn:is(:focus-visible) { outline: 2px solid #005fcc; }\n", "r49m1a.css"],
      [":where(:focus-visible)", ".btn:focus { outline: none; }\n.btn:where(:focus-visible) { box-shadow: 0 0 0 2px #005fcc; }\n", "r49m1b.css"],
      [":is(:focus,:focus-visible)", ".btn:focus { outline: none; }\n.btn:is(:focus, :focus-visible) { outline: 2px solid #005fcc; }\n", "r49m1c.css"],
      [":is(:where(:focus-visible))", ".btn:focus { outline: none; }\n.btn:is(:where(:focus-visible)) { box-shadow: 0 0 0 2px #005fcc; }\n", "r49m1d.css"],
      ["nested scss :is(:focus-visible)", ".btn { &:focus { outline: none; } &:is(:focus-visible) { outline: 2px solid #005fcc; } }\n", "r49m1e.scss"],
      ["styled-components &:is(:focus-visible)", "const B = styled.button`&:focus { outline: none; } &:is(:focus-visible) { outline: 2px solid blue; }`;", "r49m1f.tsx"],
    ]) {
      assert.equal(scanUiContent(src, fname, { tier: "all" }).counts.floor, 0, `R49 A2-M1: ${label} must pass Floor`);
    }
    assert.equal(scanUiContent(".btn:focus { outline: none; }\n.btn:is(.primary:focus-visible) { outline: 2px solid #005fcc; }\n", "r49m1-neg.css").counts.floor, 1, "R49 A2-M1: :is(.primary:focus-visible) must NOT falsely cover unclassed .btn");

    // R49-A2-M2: Tailwind v4 has-focus-visible / has-focus / has-focus-within shorthands
    for (const [label, cls] of [
      ["has-focus-visible", "*:focus:outline-none has-focus-visible:ring-2"],
      ["has-focus", "*:focus:outline-none has-focus:ring-2"],
      ["has-focus-within", "*:focus:outline-none has-focus-within:ring-2"],
    ]) {
      assert.equal(scanUiContent(`<div className="${cls}"><input /></div>`, "r49m2.tsx").counts.floor, 0, `R49 A2-M2: ${label} must pass Floor`);
    }
    assert.equal(scanUiContent('<button className="outline-none has-focus-visible:ring-2">Go</button>', "r49m2-neg.tsx").counts.floor, 1, "R49 A2-M2: has-focus-visible must NOT cover self outline-none");

    // Round 50 regressions (R50-A2-M3 cumulative :is/:where split-branch coverage + R50-A2-M4 sx={{}} / css={{}} Floor & Reflex):
    for (const [label, src] of [
      ["same-rule split", ":is(button, a):focus { outline: none; }\nbutton:focus-visible, a:focus-visible { outline: 2px solid var(--ring); }\n"],
      ["separate rules", ":is(button, a):focus { outline: none; }\nbutton:focus-visible { outline: 2px solid var(--ring); }\na:focus-visible { outline: 2px solid var(--ring); }\n"],
      ["inner :focus list", ":is(.a:focus, .b:focus) { outline: none; }\n.a:focus-visible { outline: 2px solid var(--ring); }\n.b:focus-visible { outline: 2px solid var(--ring); }\n"],
      [":where zero-spec", ":where(#cta, a):focus { outline: none; }\n#cta:focus-visible { outline: 2px solid var(--ring); }\na:focus-visible { outline: 2px solid var(--ring); }\n"],
    ]) {
      assert.equal(scanUiContent(src, "r50m3.css").counts.floor, 0, `R50 A2-M3: ${label} must pass Floor`);
    }
    assert.equal(
      scanUiContent(":is(button, a):focus { outline: none; }\nbutton:focus-visible { outline: 2px solid var(--ring); }\n", "r50m3-neg1.css").counts.floor,
      1,
      "R50 A2-M3: partial split coverage must still fail"
    );
    assert.equal(
      scanUiContent(":is(#cta, a):focus { outline: none; }\n#cta:focus-visible { outline: 2px solid var(--ring); }\na:focus-visible { outline: 2px solid var(--ring); }\n", "r50m3-neg2.css").counts.floor,
      1,
      "R50 A2-M3: :is(#cta, a):focus specificity (1,1,0) must beat a:focus-visible (0,1,1)"
    );
    assert.equal(
      scanUiContent("button:focus-visible, a:focus-visible { outline: 2px solid var(--ring); }\n:is(button, a):focus { outline: none; }\n", "r50m3-neg3.css").counts.floor,
      1,
      "R50 A2-M3: earlier equal-specificity split focus-visible rules must still lose"
    );

    const r50SxAll = scanUiContent(
      'export const B = () => <Button sx={{ "&:focus": { outline: "none" }, width: "100vw", color: "#ff00aa !important" }} />;\n',
      "r50m4a.tsx",
      { tier: "all" }
    );
    assert.deepEqual(
      r50SxAll.active.map((f) => f.ruleId).sort(),
      ["dsaf/hardcoded-color", "dsaf/important-override", "dsaf/no-100vw", "dsaf/no-outline-none-naked"],
      "R50 A2-M4: sx={{}} must enforce Floor and Reflex rules"
    );
    assert.equal(
      scanUiContent('export const B = () => <Button sx={{ "&:focus": { outline: "none" }, "&:focus-visible": { outline: "2px solid var(--ring)" } }} />;\n', "r50m4b.tsx").counts.floor,
      0,
      "R50 A2-M4: sx={{}} with sibling &:focus-visible ring must pass Floor"
    );
    assert.equal(
      scanUiContent('export const B = () => <Button sx={[baseSx, { "&:focus": { outline: "none" } }]} />;\n', "r50m4c.tsx").counts.floor,
      1,
      "R50 A2-M4: sx={[...]} array form must flag naked focus outline: none"
    );
    assert.equal(
      scanUiContent('export const B = () => <Button sx={(t: any) => ({ "&:focus": { outline: "none" } })} />;\n', "r50m4d.tsx").counts.floor,
      1,
      "R50 A2-M4: sx={(t) => ({...})} callback form must flag naked focus outline: none"
    );
    const r50CssAll = scanUiContent(
      'export const D = () => <div css={{ "&:focus": { outline: 0 }, transition: "all 0.2s", background: "#112233" }} />;\n',
      "r50m4e.tsx",
      { tier: "all" }
    );
    assert.deepEqual(
      r50CssAll.active.map((f) => f.ruleId).sort(),
      ["dsaf/hardcoded-color", "dsaf/no-outline-none-naked", "dsaf/no-transition-all"],
      "R50 A2-M4: css={{}} must enforce Floor and Reflex rules"
    );
    assert.equal(
      scanUiContent('export const D = () => <div css={css({ "&:focus": { outline: "none" } })} />;\n', "r50m4f.tsx").counts.floor,
      1,
      "R50 A2-M4: css={css({...})} must not double-report Floor violations"
    );
    assert.equal(
      scanUiContent('export const D = () => <Box sx={{ "& #ace": { color: "var(--ink)" } }} />;\n', "r50m4g.tsx", { tier: "all" }).counts.reflex,
      0,
      "R50 A2-M4: #ace selector key inside sx={{}} must not trigger dsaf/hardcoded-color"
    );

    console.log("DSAF_HOOK_SELF_TEST_PASSED (Floor/Reflex rules + waiver rejection + stdin hook + idempotent install)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseFlagArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      tier: { type: "string", default: "floor" },
      agent: { type: "string", default: "claude" },
      dir: { type: "string", default: "." },
      sarif: { type: "string" },
      "ds-css": { type: "string", multiple: true, default: [] },
      local: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      github: { type: "boolean", default: false },
      "report-unused-ignores": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  for (const flagName of ["tier", "agent", "dir", "sarif"]) {
    if (typeof values[flagName] === "boolean") {
      throw new Error(`Option '--${flagName}' requires a string value.`);
    }
  }
  if (!String(values.dir || "").trim()) {
    throw new Error("Option '--dir' requires a non-empty directory path.");
  }
  if (values.sarif !== undefined && !String(values.sarif).trim()) {
    throw new Error("Option '--sarif' requires a non-empty file path.");
  }
  if (values.tier !== undefined && !String(values.tier).trim()) {
    throw new Error("Option '--tier' requires a non-empty value ('floor', 'reflex', or 'all').");
  }
  const tier = String(values.tier || "floor").toLowerCase();
  if (tier !== "floor" && tier !== "reflex" && tier !== "all") {
    throw new Error(`Invalid --tier '${values.tier}'. Expected 'floor', 'reflex', or 'all'.`);
  }
  if (values.agent !== undefined && !String(values.agent).trim()) {
    throw new Error("Option '--agent' requires a non-empty value ('claude', 'cursor', or 'codex').");
  }
  const cleanAgent = String(values.agent || "claude").toLowerCase();
  if (!["claude", "cursor", "codex"].includes(cleanAgent)) {
    throw new Error(`Unsupported agent '${values.agent}'. Expected claude, cursor, or codex.`);
  }
  const dsCss = [];
  for (const val of values["ds-css"] || []) {
    if (typeof val !== "string" || !val.trim()) {
      throw new Error("Option '--ds-css' requires a non-empty file path.");
    }
    const parts = val.split(",").map((s) => s.trim());
    if (parts.some((s) => !s)) {
      throw new Error("Option '--ds-css' contains an empty file path.");
    }
    dsCss.push(...parts);
  }
  return {
    positionals,
    flags: {
      tier,
      agent: cleanAgent,
      dir: values.dir || ".",
      local: Boolean(values.local),
      json: Boolean(values.json),
      github: Boolean(values.github),
      reportUnusedIgnores: Boolean(values["report-unused-ignores"]),
      sarif: values.sarif || null,
      dsCss,
      selfTest: Boolean(values["self-test"]),
      help: Boolean(values.help),
    },
  };
}

export function checkTarget(target, options = {}) {
  const tier = options.tier || "floor";
  const reportUnusedIgnores = Boolean(options.reportUnusedIgnores);
  const absTarget = resolve(target);
  const startDir = existsSync(absTarget) && statSync(absTarget).isFile() ? dirname(absTarget) : absTarget;
  const externalCssBlocks =
    options.dsCss === false ? [] : discoverExternalDsCss(startDir, options.dsCss ?? []);
  const files = collectUiFiles(target, { includeDemos: Boolean(options.includeDemos) });
  const allActive = [];
  const allWaived = [];
  const allUnused = [];
  for (const f of files) {
    const r = checkFile(f.full, {
      tier,
      displayPath: f.rel,
      reportUnusedIgnores,
      externalCssBlocks,
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
  const blockingCount = tier === "all" ? counts.floor + counts.reflex : tier === "reflex" ? counts.reflex : counts.floor;
  return {
    filesScanned: files.length,
    passed: blockingCount === 0,
    counts,
    active: allActive,
    waived: allWaived,
    unusedIgnores: allUnused,
  };
}

function main() {
  let positionals;
  let flags;
  try {
    ({ positionals, flags } = parseFlagArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(2);
  }
  if (flags.help || (!flags.selfTest && positionals.length === 0)) {
    console.log(
      [
        `DSAF v${CI_REPORT_VERSION} — Edit-Time Design Hook`,
        "Usage:",
        "  dsaf hook check <file-or-dir> [--tier floor|reflex|all] [--ds-css <path>] [--sarif <file>] [--github] [--report-unused-ignores] [--json] [--help]",
        "  dsaf hook stdin [--tier floor|reflex|all] [--ds-css <path>]",
        "  dsaf hook install [--agent claude|cursor|codex] [--dir <project>] [--local]",
        "  dsaf hook --self-test",
      ].join("\n")
    );
    process.exit(0);
  }
  if (flags.selfTest) process.exit(runSelfTest());

  const [sub, ...rest] = positionals;
  if (sub === "stdin") {
    if (rest.length > 0) {
      console.error(`ERROR: Unexpected extra argument '${rest[0]}' for 'stdin'.`);
      process.exit(2);
    }
    try {
      let raw = "";
      try {
        raw = readFileSync(0, "utf8");
      } catch {
        raw = "";
      }
      const out = runHookStdin(raw, { tier: flags.tier, reportUnusedIgnores: flags.reportUnusedIgnores, dsCss: flags.dsCss });
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  if (sub === "install") {
    if (rest.length > 0) {
      console.error(`ERROR: Unexpected extra argument '${rest[0]}' for 'install'.`);
      process.exit(2);
    }
    try {
      const res = installAgentHook({ agent: flags.agent, dir: flags.dir, local: flags.local });
      console.log(`DSAF_HOOK_INSTALLED: agent=${res.agent} file=${res.file} command=${res.command}`);
      process.exit(0);
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  let target;
  if (sub === "check") {
    if (rest.length === 0 || !String(rest[0] || "").trim()) {
      console.error("ERROR: Non-empty <file-or-dir> target is required for 'dsaf hook check'.");
      process.exit(2);
    }
    if (rest.length > 1) {
      console.error(`ERROR: Unexpected extra positional argument '${rest[1]}'. Pass a single <file-or-dir>.`);
      process.exit(2);
    }
    target = rest[0];
  } else {
    if (!String(sub || "").trim()) {
      console.error("ERROR: Non-empty <file-or-dir> target is required.");
      process.exit(2);
    }
    if (rest.length > 0) {
      console.error(`ERROR: Unexpected extra positional argument '${rest[0]}'. Pass a single <file-or-dir>.`);
      process.exit(2);
    }
    target = sub;
  }

  const absTarget = resolve(target);
  if (!existsSync(absTarget)) {
    console.error(`ERROR: Target not found: ${absTarget}`);
    process.exit(2);
  }
  if (flags.sarif) {
    try {
      const targetRoot = statSync(absTarget).isFile() ? dirname(absTarget) : absTarget;
      assertWritableOutputFile(flags.sarif, "--sarif", { rootDir: targetRoot });
    } catch (err) {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  let checkRes;
  try {
    checkRes = checkTarget(target, {
      tier: flags.tier,
      reportUnusedIgnores: flags.reportUnusedIgnores,
      dsCss: flags.dsCss,
    });
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { filesScanned, passed, counts, active: allActive, waived: allWaived, unusedIgnores: allUnused } = checkRes;

  const isFileTarget = existsSync(absTarget) && statSync(absTarget).isFile();
  const repoRoot = isFileTarget ? dirname(absTarget) : absTarget;
  const outputFindings = isFileTarget ? allActive.map((f) => ({ ...f, file: absTarget })) : allActive;

  if (flags.sarif) {
    const outPath = resolve(flags.sarif);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(formatSarif(outputFindings, { toolVersion: CI_REPORT_VERSION, repoRoot }), null, 2) + "\n", "utf8");
  }

  if (flags.github) {
    const ann = formatGithubAnnotations(outputFindings, { repoRoot });
    if (ann) console.log(ann);
  } else if (flags.json) {
    console.log(JSON.stringify({ schema: "dsaf-hook/1", target, tier: flags.tier, passed, counts, active: allActive, waived: allWaived, unusedIgnores: allUnused }, null, 2));
  } else {
    console.log(`DSAF_HOOK_CHECK: files=${filesScanned} floor=${counts.floor} reflex=${counts.reflex} waived=${counts.waived} unusedIgnores=${counts.unusedIgnores}`);
    for (const f of allActive.slice(0, 30)) {
      console.log(`  [${f.tier.toUpperCase()}] ${f.file}:${f.line} ${f.ruleId} — ${f.message}`);
    }
    console.log(passed ? "DSAF_HOOK_PASSED" : "DSAF_HOOK_FAILED");
  }

  process.exit(passed ? 0 : 1);
}

if (isDirectCliEntry(import.meta.url)) main();

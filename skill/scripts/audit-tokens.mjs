#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Deterministic W3C DTCG Token Validator & Codebase Drift Scanner.
 * Zero external dependencies. Validates $value/$type/{alias}/$ref tokens, Light/Dark
 * mode parity, token-level WCAG 2.2 + APCA-W3 contrast, and scans stylesheets/UI
 * components for hardcoded color drift, property-scoped spacing drift, !important
 * overrides, authored orphan CSS variables (excluding Tailwind @theme & JS refs),
 * Tailwind arbitrary/primitive drift, and emits SARIF 2.1.0 / GitHub annotations.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { apcaContrast, wcagContrast } from "./audit-runtime.mjs";
import { buildTailwindScanSurfacePreservingLines, maskAtApplyDeclsPreservingLines } from "./dsaf-hook.mjs";
import {
  applyIgnores,
  assertWritableOutputFile,
  blankCssCustomPropDeclsPreservingLines,
  blankStyledTemplateCustomPropsPreservingLines,
  CI_REPORT_VERSION,
  computeJsOuterStringSpans,
  computeMarkupJsOuterStringSpans,
  extractImportantStyleSurfacePreservingLines,
  extractRealStyleBlocks,
  findHardcodedColorFunctions,
  findSvelteStyleDirectives,
  findSvgBlockRanges,
  formatGithubAnnotations,
  formatSarif,
  isDirectCliEntry,
  isRealOpenTagAttrPos,
  isTokenizedColorFn,
  isValidJsObjKeyPos,
  maskCssQuotedStringsPreservingLines,
  maskMarkupProsePreservingLines,
  maskProseAndDocStringsPreservingLines,
  maskRangePreservingLines,
  offsetToLine,
  scanMarkupContexts,
  skipJsRegexInExpr,
  stripCommentsPreservingLines,
  stripCssCommentsInTemplatePreservingLines,
  stripTokenBlocksPreservingLines,
  stripTrailingTsCastEnd,
} from "./ci-report.mjs";
import { hasDesignTokenEvidence } from "./recon.mjs";

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

const CODE_EXTS = new Set([".css", ".scss", ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html"]);

const isFrameworkInternalVar = (v) =>
  /^--(tw|radix|next|vite|sb|storybook|chakra|mui|mantine|antd|wp|_+)-?|^--[a-z]{1,2}_/i.test(v);

const SPACING_RADIUS_CSS_PROP_RE =
  /^(?:(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block|start|end)(?:-[a-z]+)?)?|border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius)$/i;

const SPACING_RADIUS_JS_PROP_NAMES =
  "(?:padding(?:Top|Right|Bottom|Left|Inline(?:Start|End)?|Block(?:Start|End)?|-top|-right|-bottom|-left|-inline(?:-start|-end)?|-block(?:-start|-end)?)?|margin(?:Top|Right|Bottom|Left|Inline(?:Start|End)?|Block(?:Start|End)?|-top|-right|-bottom|-left|-inline(?:-start|-end)?|-block(?:-start|-end)?)?|gap|rowGap|row-gap|columnGap|column-gap|border(?:TopLeft|TopRight|BottomLeft|BottomRight|StartStart|StartEnd|EndStart|EndEnd)?Radius|border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius)";
const SPACING_RADIUS_JS_PROP_RE = new RegExp(
  `(?:(['"])${SPACING_RADIUS_JS_PROP_NAMES}\\1|(?<![a-zA-Z0-9_$-])${SPACING_RADIUS_JS_PROP_NAMES})\\s*:\\s*(["'\`]?)([^"'\`,;}\\n]+)\\2`,
  "g"
);

const PX_VALUE_RE = /(?<![\w.])(\d+(?:\.\d+)?|\.\d+)px\b/g;

function getNodeExtModes(node) {
  const ext = node?.$extensions ?? node?.extensions;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return null;
  const raw = ext.mode ?? ext.modes ?? ext["com.figma.mode"] ?? ext["org.designtokens.mode"];
  return raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0 ? raw : null;
}

function hasNonMetaObjectChild(node) {
  return Object.entries(node).some(
    ([k, v]) =>
      !k.startsWith("$") &&
      k !== "type" &&
      k !== "description" &&
      k !== "extensions" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
  );
}

function hasNestedTokenDescendant(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$") || k === "extensions") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (
        Object.prototype.hasOwnProperty.call(v, "$value") ||
        Object.prototype.hasOwnProperty.call(v, "value") ||
        (Boolean(getNodeExtModes(v)) && !hasNonMetaObjectChild(v)) ||
        hasNestedTokenDescendant(v)
      ) {
        return true;
      }
    }
  }
  return false;
}

function lookupGroupSegTarget(node, seg) {
  if (!node || typeof node !== "object" || Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, seg)) {
    return null;
  }
  return node[seg];
}

function parseExtendsRefSegs(rawRef) {
  if (typeof rawRef !== "string") return null;
  const trimmed = rawRef.trim();
  if (/^\{[^}]+\}$/.test(trimmed)) {
    const segs = trimmed.slice(1, -1).trim().split(".").filter(Boolean);
    return segs.length > 0 ? segs : null;
  }
  if (trimmed.startsWith("#/")) {
    const segs = trimmed
      .slice(2)
      .split("/")
      .filter(Boolean)
      .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
    return segs.length > 0 ? segs : null;
  }
  return null;
}

function isTokenLeafObject(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      (Object.prototype.hasOwnProperty.call(obj, "$value") ||
        Object.prototype.hasOwnProperty.call(obj, "$ref") ||
        (Boolean(getNodeExtModes(obj)) && !hasNonMetaObjectChild(obj)) ||
        (Object.prototype.hasOwnProperty.call(obj, "value") && !hasNestedTokenDescendant(obj)))
  );
}

function isMetaOnlyTokenOverride(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  const legacyMeta = new Set(["type", "description", "extensions"]);
  return keys.every((k) => k.startsWith("$") || legacyMeta.has(k));
}

function mergeExtensionObjects(baseExt, localExt) {
  const outExt = { ...structuredClone(baseExt), ...structuredClone(localExt) };
  for (const mk of ["mode", "modes", "com.figma.mode", "org.designtokens.mode"]) {
    if (
      baseExt[mk] &&
      typeof baseExt[mk] === "object" &&
      !Array.isArray(baseExt[mk]) &&
      localExt[mk] &&
      typeof localExt[mk] === "object" &&
      !Array.isArray(localExt[mk])
    ) {
      outExt[mk] = { ...structuredClone(baseExt[mk]), ...structuredClone(localExt[mk]) };
    }
  }
  return outExt;
}

function mergeResolvedDtcgGroups(baseNode, localNode) {
  const out = {};
  for (const [k, v] of Object.entries(baseNode)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : v;
  }
  for (const [k, v] of Object.entries(localNode)) {
    if (k === "$extends") continue;
    const baseVal = out[k];
    if (
      baseVal &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      if (isTokenLeafObject(baseVal) && (isTokenLeafObject(v) || isMetaOnlyTokenOverride(v))) {
        const mergedLeaf = { ...structuredClone(baseVal), ...structuredClone(v) };
        if (
          baseVal.$extensions &&
          typeof baseVal.$extensions === "object" &&
          !Array.isArray(baseVal.$extensions) &&
          v.$extensions &&
          typeof v.$extensions === "object" &&
          !Array.isArray(v.$extensions)
        ) {
          mergedLeaf.$extensions = mergeExtensionObjects(baseVal.$extensions, v.$extensions);
        }
        if (
          baseVal.extensions &&
          typeof baseVal.extensions === "object" &&
          !Array.isArray(baseVal.extensions) &&
          v.extensions &&
          typeof v.extensions === "object" &&
          !Array.isArray(v.extensions)
        ) {
          mergedLeaf.extensions = mergeExtensionObjects(baseVal.extensions, v.extensions);
        }
        if (Object.prototype.hasOwnProperty.call(v, "$value")) {
          delete mergedLeaf.$ref;
          delete mergedLeaf.value;
        } else if (Object.prototype.hasOwnProperty.call(v, "value")) {
          delete mergedLeaf.$value;
          delete mergedLeaf.$ref;
        }
        if (Object.prototype.hasOwnProperty.call(v, "$ref")) {
          delete mergedLeaf.$value;
          delete mergedLeaf.value;
        }
        out[k] = mergedLeaf;
      } else if (!isTokenLeafObject(v) && !isTokenLeafObject(baseVal)) {
        out[k] = mergeResolvedDtcgGroups(baseVal, v);
      } else {
        out[k] = structuredClone(v);
      }
    } else {
      out[k] = v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : v;
    }
  }
  return out;
}

const DTCG_EXTENDS_ISSUES = Symbol("dtcgExtendsIssues");

export function resolveDtcgExtends(root, issuesOut = null) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return root;
  const memo = new WeakMap();
  const partialInherited = new WeakMap();
  const seenIssueKeys = new Set();
  const recordExtendsIssue = (type, path, target) => {
    if (!Array.isArray(issuesOut)) return;
    const key = `${type}\0${path}\0${target}`;
    if (seenIssueKeys.has(key)) return;
    seenIssueKeys.add(key);
    issuesOut.push({ type, path, target });
  };
  const resolveGroupPath = (segs, stack, callerPathSegs = []) => {
    const resolveRawPath = (candSegs) => {
      let cur = root;
      let curResolved = false;
      let inheritedCur = null;
      for (let sIdx = 0; sIdx < candSegs.length; sIdx++) {
        const seg = candSegs[sIdx];
        if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
        if (stack.has(cur)) {
          const localChild = lookupGroupSegTarget(cur, seg);
          const ownInherited = partialInherited.get(cur) || null;
          const effectiveInheritedParent =
            inheritedCur && ownInherited && typeof inheritedCur === "object" && typeof ownInherited === "object"
              ? mergeResolvedDtcgGroups(inheritedCur, ownInherited)
              : ownInherited || inheritedCur;
          const inheritedChild = effectiveInheritedParent ? lookupGroupSegTarget(effectiveInheritedParent, seg) : null;
          if (localChild && stack.has(localChild)) {
            cur = localChild;
            inheritedCur =
              inheritedChild && typeof inheritedChild === "object" && !Array.isArray(inheritedChild)
                ? inheritedChild
                : null;
            curResolved = false;
            continue;
          }
          if (
            localChild &&
            inheritedChild &&
            typeof localChild === "object" &&
            typeof inheritedChild === "object" &&
            !Array.isArray(localChild) &&
            !Array.isArray(inheritedChild)
          ) {
            const resLocal = resolveGroup(localChild, stack, candSegs.slice(0, sIdx + 1));
            if (!isTokenLeafObject(inheritedChild) && !isTokenLeafObject(resLocal)) {
              cur = mergeResolvedDtcgGroups(inheritedChild, resLocal);
            } else if (isTokenLeafObject(inheritedChild) && (isTokenLeafObject(resLocal) || isMetaOnlyTokenOverride(resLocal))) {
              cur = mergeResolvedDtcgGroups({ _: inheritedChild }, { _: resLocal })._;
            } else {
              cur = resLocal;
            }
            inheritedCur = null;
            curResolved = true;
            continue;
          }
          if (localChild !== null) {
            cur = localChild;
            inheritedCur = null;
            curResolved = false;
          } else if (inheritedChild !== null) {
            cur = inheritedChild;
            inheritedCur = null;
            curResolved = true;
          } else {
            return null;
          }
          continue;
        }
        const resolvedCur = curResolved ? cur : resolveGroup(cur, stack, candSegs.slice(0, sIdx));
        inheritedCur = null;
        cur = lookupGroupSegTarget(resolvedCur, seg);
        curResolved = true;
        if (cur === null) return null;
      }
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
      return { node: curResolved || stack.has(cur) ? cur : resolveGroup(cur, stack, candSegs), segs: candSegs };
    };
    const callerMode =
      callerPathSegs.length > 0 && /^(?:light|dark)$/i.test(callerPathSegs[0]) ? callerPathSegs[0] : null;
    if (callerMode && segs.length > 0 && !/^(?:light|dark)$/i.test(segs[0])) {
      const scopedHit = resolveRawPath([callerMode, ...segs]);
      if (scopedHit) return scopedHit;
    }
    return resolveRawPath(segs);
  };
  const resolveGroup = (node, stack = new Set(), pathSegs = []) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    if (memo.has(node)) return memo.get(node);
    if (stack.has(node)) return node;
    stack.add(node);
    let hitCycle = false;
    let resolvedBase = null;
    if (typeof node.$extends === "string") {
      const groupPath = pathSegs.length > 0 ? pathSegs.join(".") : "(root)";
      const segs = parseExtendsRefSegs(node.$extends);
      if (!segs) {
        recordExtendsIssue("unresolved_extends", groupPath, node.$extends);
      } else {
        const hit = resolveGroupPath(segs, stack, pathSegs);
        if (!hit) {
          recordExtendsIssue("unresolved_extends", groupPath, node.$extends);
        } else if (stack.has(hit.node)) {
          hitCycle = true;
          recordExtendsIssue("circular_extends", groupPath, node.$extends);
        } else {
          resolvedBase = resolveGroup(hit.node, stack, hit.segs);
          partialInherited.set(node, resolvedBase);
        }
      }
    }
    let localCopy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$extends") continue;
      localCopy[k] =
        v && typeof v === "object" && !Array.isArray(v) && !k.startsWith("$")
          ? resolveGroup(v, stack, [...pathSegs, k])
          : v;
    }
    if (resolvedBase) {
      if (typeof node.$extensions === "object" && node.$extensions) {
        localCopy.$extensions = structuredClone(node.$extensions);
      }
      if (typeof node.extensions === "object" && node.extensions) {
        localCopy.extensions = structuredClone(node.extensions);
      }
      localCopy = mergeResolvedDtcgGroups(resolvedBase, localCopy);
    }
    partialInherited.delete(node);
    stack.delete(node);
    if (!hitCycle) memo.set(node, localCopy);
    return localCopy;
  };
  return resolveGroup(root, new Set(), []);
}

function prepareFileTreeForMerge(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const cloned = structuredClone(json);
  const getOwnType = (n) =>
    Object.prototype.hasOwnProperty.call(n, "$type") && typeof n.$type === "string"
      ? n.$type
      : Object.prototype.hasOwnProperty.call(n, "type") && typeof n.type === "string"
      ? n.type
      : null;
  const materialize = (node, inheritedType, isRoot = false) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const ownType = getOwnType(node);
    const nextType = ownType ?? inheritedType;
    const hasLeaf =
      Object.prototype.hasOwnProperty.call(node, "$value") ||
      Object.prototype.hasOwnProperty.call(node, "value") ||
      Object.prototype.hasOwnProperty.call(node, "$ref") ||
      Boolean(getNodeExtModes(node) && !hasNonMetaObjectChild(node));
    if (hasLeaf) {
      if (!ownType && nextType != null) node.$type = nextType;
      return;
    }
    if (!isRoot && !ownType && nextType != null) {
      node.$type = nextType;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "$root" && v && typeof v === "object" && !Array.isArray(v)) {
        materialize(v, nextType, false);
        continue;
      }
      if (k.startsWith("$") || k === "extensions") continue;
      if ((k === "type" || k === "description") && (v == null || typeof v !== "object")) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        materialize(v, nextType, false);
      }
    }
  };
  materialize(cloned, null, true);
  delete cloned.$type;
  if (typeof cloned.type === "string") delete cloned.type;
  return cloned;
}

function mergeRawDtcgTrees(target, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return target;
  for (const [k, v] of Object.entries(incoming)) {
    const existing = target[k];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !k.startsWith("$") &&
      k !== "extensions" &&
      !isTokenLeafObject(existing) &&
      !isTokenLeafObject(v)
    ) {
      const exType = Object.prototype.hasOwnProperty.call(existing, "$type")
        ? existing.$type
        : typeof existing.type === "string"
        ? existing.type
        : null;
      const inType = Object.prototype.hasOwnProperty.call(v, "$type")
        ? v.$type
        : typeof v.type === "string"
        ? v.type
        : null;
      if (exType !== inType) {
        delete existing.$type;
        if (typeof existing.type === "string") delete existing.type;
        const cleanV = { ...v };
        delete cleanV.$type;
        if (typeof cleanV.type === "string") delete cleanV.type;
        mergeRawDtcgTrees(existing, cleanV);
      } else {
        mergeRawDtcgTrees(existing, v);
      }
    } else if (!Object.prototype.hasOwnProperty.call(target, k)) {
      target[k] = v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : v;
    }
  }
  return target;
}

function flattenTokensFromExpanded(expandedSource, extendsIssues = []) {
  const tokens = [];
  function walk(node, path = [], inheritedType = null) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const hasDollarVal = Object.prototype.hasOwnProperty.call(node, "$value");
    const rawLegacyVal = node.value;
    const siblingHasToken = Object.entries(node).some(
      ([k, v]) =>
        k !== "value" &&
        !k.startsWith("$") &&
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        (Object.prototype.hasOwnProperty.call(v, "$value") ||
          Object.prototype.hasOwnProperty.call(v, "value") ||
          hasNestedTokenDescendant(v))
    );
    const hasLegacyLeafVal =
      !siblingHasToken &&
      Object.prototype.hasOwnProperty.call(node, "value") &&
      (rawLegacyVal === null ||
        typeof rawLegacyVal !== "object" ||
        Array.isArray(rawLegacyVal) ||
        (!Object.prototype.hasOwnProperty.call(rawLegacyVal, "$value") &&
          !Object.prototype.hasOwnProperty.call(rawLegacyVal, "value") &&
          !hasNestedTokenDescendant(rawLegacyVal)));
    const hasValue = hasDollarVal || hasLegacyLeafVal;
    const hasRef = Object.prototype.hasOwnProperty.call(node, "$ref");
    const hasDollarType = Object.prototype.hasOwnProperty.call(node, "$type");
    const hasLegacyType = Object.prototype.hasOwnProperty.call(node, "type") && typeof node.type === "string";
    const nextType = hasDollarType ? node.$type : hasLegacyType ? node.type : inheritedType;
    const hasExtModeLeaf = path.length > 0 && Boolean(getNodeExtModes(node)) && !hasNonMetaObjectChild(node);
    if (hasValue || hasRef || hasExtModeLeaf) {
      tokens.push({
        path: path.join("."),
        type: nextType ?? null,
        value: hasDollarVal ? node.$value : hasLegacyLeafVal ? node.value : null,
        ref: hasRef ? node.$ref : null,
        description: node.$description ?? (typeof node.description === "string" ? node.description : null),
        rawExtensions: node.$extensions ?? node.extensions ?? null,
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "$root" && v && typeof v === "object") {
        walk(v, [...path], nextType);
        continue;
      }
      if (k.startsWith("$")) continue;
      if ((k === "type" || k === "description") && (v == null || typeof v !== "object")) continue;
      walk(v, [...path, k], nextType);
    }
  }
  walk(expandedSource);
  Object.defineProperty(tokens, DTCG_EXTENDS_ISSUES, { value: extendsIssues, enumerable: false, configurable: true });
  return tokens;
}

function flattenTokens(source) {
  const extendsIssues = [];
  const expandedSource = resolveDtcgExtends(source, extendsIssues);
  return flattenTokensFromExpanded(expandedSource, extendsIssues);
}

function aliasTarget(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^\{([^}]+)\}$/);
  return m ? m[1].trim().replace(/\.\$root$/i, "") : null;
}

function pointerTarget(ref, byPath) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return typeof ref === "string" ? ref : null;
  const segs = ref
    .slice(2)
    .split("/")
    .filter(Boolean)
    .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (let i = segs.length; i > 0; i--) {
    if (i < segs.length && segs[i] !== "$value") continue;
    const candidate = segs.slice(0, i).filter((seg) => seg !== "$root").join(".");
    if (byPath.has(candidate)) return candidate;
  }
  const cleanSegs = segs.filter((seg, idx) => seg !== "$root" && !(idx === segs.length - 1 && idx > 0 && seg === "$value"));
  return cleanSegs.join(".");
}

function collectRefsWithModeHints(val, byPath, inheritedMode = null) {
  const direct = aliasTarget(val);
  if (direct) return [{ target: direct, modeKey: inheritedMode }];
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/\{([^{}\s:;,"'()]+)\}/.test(trimmed)) {
      const outer = /^light-dark\s*\(/i.test(trimmed) ? parseOuterCssCall(trimmed) : null;
      if (outer?.fn === "light-dark") {
        const args = splitCssTopLevel(outer.body, ",");
        if (args.length === 2) {
          return [
            ...collectRefsWithModeHints(args[0], byPath, "light"),
            ...collectRefsWithModeHints(args[1], byPath, "dark"),
          ];
        }
      }
      const out = [];
      let masked = trimmed;
      let cursor = 0;
      while (cursor < masked.length) {
        const lm = /\blight-dark\s*\(/i.exec(masked.slice(cursor));
        if (!lm) break;
        const absStart = cursor + lm.index;
        if (absStart > 0 && /[a-zA-Z0-9_-]/.test(masked[absStart - 1])) {
          cursor = absStart + lm[0].length;
          continue;
        }
        const openP = masked.indexOf("(", absStart);
        let depth = 0;
        let closeP = -1;
        for (let k = openP; k < masked.length; k++) {
          if (masked[k] === "(") depth++;
          else if (masked[k] === ")") {
            depth--;
            if (depth === 0) {
              closeP = k;
              break;
            }
          }
        }
        if (closeP !== -1) {
          const innerBody = masked.slice(openP + 1, closeP);
          const args = splitCssTopLevel(innerBody, ",");
          if (args.length === 2) {
            out.push(
              ...collectRefsWithModeHints(args[0], byPath, "light"),
              ...collectRefsWithModeHints(args[1], byPath, "dark")
            );
            masked = masked.slice(0, absStart) + " ".repeat(closeP + 1 - absStart) + masked.slice(closeP + 1);
            cursor = closeP + 1;
            continue;
          }
        }
        cursor = absStart + lm[0].length;
      }
      for (const rm of masked.matchAll(/\{([^{}\s:;,"'()]+)\}/g)) {
        const clean = rm[1].trim().replace(/\.\$root$/i, "");
        if (clean) out.push({ target: clean, modeKey: inheritedMode });
      }
      return out;
    }
    return [];
  }
  if (Array.isArray(val)) return val.flatMap((item) => collectRefsWithModeHints(item, byPath, inheritedMode));
  if (val && typeof val === "object") {
    const refT = val.$ref ? pointerTarget(val.$ref, byPath) : null;
    const nested = Object.entries(val)
      .filter(([k]) => k !== "$ref")
      .flatMap(([, item]) => collectRefsWithModeHints(item, byPath, inheritedMode));
    return refT ? [{ target: refT, modeKey: inheritedMode }, ...nested] : nested;
  }
  return [];
}

function collectRefsInValue(val, byPath) {
  return collectRefsWithModeHints(val, byPath, null).map((e) => e.target);
}

export function validateDtcgTokens(source) {
  const tokens = Array.isArray(source) ? source : flattenTokens(source);
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  const baseRefsByPath = new Map();
  const refsByPath = new Map();
  const modeNames = new Set();
  const extModeRefsByPath = new Map();
  let hasLightModeTokens = false;
  let hasDarkModeTokens = false;
  for (const t of tokens) {
    if (/(?:^|\.)light(?:\.|$)/i.test(t.path)) hasLightModeTokens = true;
    if (/(?:^|\.)dark(?:\.|$)/i.test(t.path)) hasDarkModeTokens = true;
    const valRefs = collectRefsWithModeHints(t.value, byPath, null);
    const refT = t.ref ? pointerTarget(t.ref, byPath) : null;
    const baseRefs = refT ? [...valRefs, { target: refT, modeKey: null }] : [...valRefs];
    baseRefsByPath.set(t.path, baseRefs);
    const extMode = getTokenExtModes(t);
    const extModeEntries = [];
    if (extMode) {
      for (const [mk, mv] of Object.entries(extMode)) {
        const mkLow = mk.toLowerCase();
        if (mkLow === "light") hasLightModeTokens = true;
        if (mkLow === "dark") hasDarkModeTokens = true;
        modeNames.add(mkLow);
        const modeHint = mkLow === "light" || mkLow === "dark" ? mkLow : null;
        for (const rEntry of collectRefsWithModeHints(mv, byPath, modeHint)) {
          extModeEntries.push({ target: rEntry.target, modeKey: rEntry.modeKey || modeHint });
        }
      }
    }
    extModeRefsByPath.set(t.path, extModeEntries);
    refsByPath.set(t.path, [...baseRefs.map((e) => e.target), ...extModeEntries.map((e) => e.target)]);
  }

  const typeByPath = new Map();
  const issues = [...(Array.isArray(tokens[DTCG_EXTENDS_ISSUES]) ? tokens[DTCG_EXTENDS_ISSUES] : [])];
  const circularSeen = new Set();

  const actualModePrefixes = new Set(["light", "dark"]);
  for (const k of byPath.keys()) {
    const mm = /(?:^|\.)(light|dark)(?:\.|$)/i.exec(k);
    if (mm) actualModePrefixes.add(mm[1]);
  }
  const collectScopedModeHits = (target, modePrefix) => {
    const hits = [];
    const pref = `${modePrefix}.${target}`;
    if (byPath.has(pref)) hits.push(pref);
    for (let dotIdx = target.indexOf("."); dotIdx !== -1; dotIdx = target.indexOf(".", dotIdx + 1)) {
      const mid = `${target.slice(0, dotIdx)}.${modePrefix}.${target.slice(dotIdx + 1)}`;
      if (byPath.has(mid)) hits.push(mid);
    }
    const suf = `${target}.${modePrefix}`;
    if (byPath.has(suf)) hits.push(suf);
    return hits;
  };
  const collectMatchingModes = (target, wantLower) => {
    const seen = new Set();
    const ordered = [...actualModePrefixes].filter((m) => m.toLowerCase() === wantLower);
    const out = [];
    for (const mp of ordered) {
      for (const h of collectScopedModeHits(target, mp)) {
        if (!seen.has(h)) {
          seen.add(h);
          out.push(h);
        }
      }
    }
    return out;
  };
  const resolveRefTargets = (target, callerPath = "", explicitMode = null, requireFullModeParity = false) => {
    if (!target) return [];
    if (/(?:^|\.)(?:light|dark)\./i.test(target)) {
      return byPath.has(target) ? [target] : [];
    }
    const callerModeM = /(?:^|\.)(light|dark)(?:\.|$)/i.exec(String(callerPath || ""));
    const callerMode = explicitMode || (callerModeM ? callerModeM[1] : null);
    if (callerMode) {
      const exactScoped = collectScopedModeHits(target, callerMode);
      const fallbackScoped = collectMatchingModes(target, callerMode.toLowerCase());
      const scoped = [...new Set([...exactScoped, ...fallbackScoped])];
      if (scoped.length > 0) return scoped;
      return byPath.has(target) ? [target] : [];
    }
    if (byPath.has(target)) return [target];
    const lightHits = collectMatchingModes(target, "light");
    const darkHits = collectMatchingModes(target, "dark");
    if (
      requireFullModeParity &&
      ((hasLightModeTokens && lightHits.length === 0) || (hasDarkModeTokens && darkHits.length === 0))
    ) {
      return [];
    }
    return [...new Set([...lightHits, ...darkHits])];
  };

  function resolveType(tok, stack = []) {
    if (typeByPath.has(tok.path)) return typeByPath.get(tok.path);
    if (stack.includes(tok.path)) return tok.type ?? null;
    const valRefTarget =
      tok.value && typeof tok.value === "object" && typeof tok.value.$ref === "string"
        ? pointerTarget(tok.value.$ref, byPath)
        : null;
    const target = aliasTarget(tok.value) ?? valRefTarget ?? (tok.ref ? pointerTarget(tok.ref, byPath) : null);
    const targets = target ? resolveRefTargets(target, tok.path) : [];
    const nextTarget = targets.find((rt) => !stack.includes(rt));
    let resolved = null;
    if (nextTarget) {
      resolved = resolveType(byPath.get(nextTarget), [...stack, tok.path]);
    } else if (tok.type == null && tok.value === null && !tok.ref) {
      for (const entry of extModeRefsByPath.get(tok.path) ?? []) {
        const modeTargets = resolveRefTargets(entry.target, tok.path, entry.modeKey);
        const mt = modeTargets.find((rt) => rt !== tok.path && !stack.includes(rt));
        if (!mt) continue;
        const candType = resolveType(byPath.get(mt), [...stack, tok.path]);
        if (candType) {
          resolved = candType;
          break;
        }
      }
    }
    const finalType = tok.type ?? resolved ?? null;
    typeByPath.set(tok.path, finalType);
    return finalType;
  }

  for (const t of tokens) resolveType(t);

  const unresolvedSeen = new Set();
  for (const t of tokens) {
    for (const entry of baseRefsByPath.get(t.path) ?? []) {
      if (resolveRefTargets(entry.target, t.path, entry.modeKey, true).length === 0) {
        const uk = `${t.path}\0${entry.target}`;
        if (!unresolvedSeen.has(uk)) {
          unresolvedSeen.add(uk);
          issues.push({ type: "unresolved_reference", path: t.path, target: entry.target });
        }
      }
    }
    for (const entry of extModeRefsByPath.get(t.path) ?? []) {
      if (resolveRefTargets(entry.target, t.path, entry.modeKey, false).length === 0) {
        const uk = `${t.path}\0${entry.target}`;
        if (!unresolvedSeen.has(uk)) {
          unresolvedSeen.add(uk);
          issues.push({ type: "unresolved_reference", path: t.path, target: entry.target });
        }
      }
    }
  }

  function runCycleCheck(graphRefs, activeMode = null, extModeOverridePaths = null) {
    const fullyExplored = new Set();
    function detectCycles(path, stack = []) {
      if (stack.includes(path)) {
        const cycle = [...stack.slice(stack.indexOf(path)), path];
        const key = [...cycle.slice(0, -1)].sort().join(">");
        if (!circularSeen.has(key)) {
          circularSeen.add(key);
          issues.push({ type: "circular_reference", path: cycle[cycle.length - 2] ?? path, target: path, cycle });
        }
        return;
      }
      if (fullyExplored.has(path)) return;
      const fromExtMode = Boolean(extModeOverridePaths && extModeOverridePaths.has(path));
      const callerOwnMode = /(?:^|\.)(light|dark)(?:\.|$)/i.test(path);
      const refMode = fromExtMode ? activeMode : callerOwnMode ? null : activeMode;
      for (const entry of graphRefs.get(path) ?? []) {
        const effMode = entry.modeKey || refMode;
        for (const rt of resolveRefTargets(entry.target, path, effMode)) {
          detectCycles(rt, [...stack, path]);
        }
      }
      fullyExplored.add(path);
    }
    for (const t of tokens) detectCycles(t.path);
  }

  runCycleCheck(baseRefsByPath, null);
  for (const modeName of modeNames) {
    const extModeOverridePaths = new Set();
    const modeRefs = new Map(
      tokens.map((t) => {
        const extMode = getTokenExtModes(t);
        if (extMode) {
          const matchedKey = Object.keys(extMode).find((mk) => mk.toLowerCase() === modeName);
          if (matchedKey !== undefined) {
            extModeOverridePaths.add(t.path);
            const mh = modeName === "light" || modeName === "dark" ? modeName : null;
            return [t.path, collectRefsWithModeHints(extMode[matchedKey], byPath, mh)];
          }
        }
        return [t.path, baseRefsByPath.get(t.path) ?? []];
      })
    );
    const modeHint = modeName === "light" || modeName === "dark" ? modeName : null;
    runCycleCheck(modeRefs, modeHint, extModeOverridePaths);
  }
  for (const t of tokens) {
    if (!typeByPath.get(t.path)) {
      issues.push({ type: "missing_type", path: t.path });
    }
  }

  const aliases = tokens.filter((t) => (refsByPath.get(t.path)?.length ?? 0) > 0);
  const componentScoped = tokens.filter((t) => /(component|button|input|card|dialog|modal|badge|toast|table|nav|tabs)/i.test(t.path));
  const MODERN_SPACE_RE = /^(oklch|oklab|display-p3|display-p3-linear|a98-rgb|prophoto-rgb|rec2020|lab|lch|xyz-d50|xyz-d65)$/i;
  const modernColors = tokens.filter(
    (t) =>
      (typeof t.value === "string" && /(oklch|display-p3|color\(p3|lab\(|oklab\()/i.test(t.value)) ||
      (t.value && typeof t.value === "object" && MODERN_SPACE_RE.test(String(t.value.colorSpace || "")))
  );
  const described = tokens.filter((t) => Boolean(t.description));
  const blockingIssues = issues.filter((i) => i.type !== "missing_type");

  return {
    tokenCount: tokens.length,
    typedCount: tokens.filter((t) => Boolean(typeByPath.get(t.path))).length,
    describedCount: described.length,
    aliasCount: aliases.length,
    componentScopedCount: componentScoped.length,
    modernColorCount: modernColors.length,
    blockingIssues,
    missingTypeIssues: issues.filter((i) => i.type === "missing_type"),
  };
}

function parseHexToRgba(hex) {
  const s = hex.slice(1).toLowerCase();
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), 1];
  }
  if (s.length === 4) {
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
      parseInt(s[3] + s[3], 16) / 255,
    ];
  }
  if (s.length === 6) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 1];
  }
  if (s.length === 8) {
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
      parseInt(s.slice(6, 8), 16) / 255,
    ];
  }
  return null;
}

function parseHexToRgb(hex) {
  const rgba = parseHexToRgba(hex);
  return rgba ? [rgba[0], rgba[1], rgba[2]] : null;
}

function normalizeHexKey(hex) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return null;
  const s = hex.slice(1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) return `#${s.slice(0, 6)}`;
  return null;
}

function getTokenExtModes(tok) {
  const ext = tok?.rawExtensions;
  const raw = ext?.mode ?? ext?.modes ?? ext?.["com.figma.mode"] ?? ext?.["org.designtokens.mode"];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function unwrapModeEntry(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (Object.prototype.hasOwnProperty.call(entry, "$value")) return entry.$value;
    if (Object.prototype.hasOwnProperty.call(entry, "value") && typeof entry.unit !== "string") return entry.value;
  }
  return entry;
}

function getModeKey(extModes, modeName) {
  if (!extModes || typeof extModes !== "object" || Array.isArray(extModes)) return null;
  const target = String(modeName || "").toLowerCase();
  for (const k of Object.keys(extModes)) {
    if (k.toLowerCase() === target) return k;
  }
  return null;
}

function resolveTokenModeValue(tTok, mode) {
  if (!tTok) return null;
  const extModes = getTokenExtModes(tTok);
  const modeKey = mode ? getModeKey(extModes, mode) : null;
  if (modeKey !== null) {
    return unwrapModeEntry(extModes[modeKey]);
  }
  return tTok.value ?? (tTok.ref ? { $ref: tTok.ref } : null);
}

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function linearSrgbChannelToSrgb255(c) {
  const clamped = clamp01(c);
  const enc = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(clamp01(enc) * 255);
}

function oklabToLinSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function oklabToSrgb(L, a, b) {
  const [lr, lg, lb] = oklabToLinSrgb(L, a, b);
  return [linearSrgbChannelToSrgb255(lr), linearSrgbChannelToSrgb255(lg), linearSrgbChannelToSrgb255(lb)];
}

function oklchToSrgb(L, C, hueDeg) {
  const cPos = Math.max(0, Number(C));
  const hRad = (Number(hueDeg) * Math.PI) / 180;
  return oklabToSrgb(L, cPos * Math.cos(hRad), cPos * Math.sin(hRad));
}

function hslToSrgbFloat(hDeg, sPct, lPct) {
  const h = (((Number(hDeg) % 360) + 360) % 360) / 360;
  const s = clamp01(Number(sPct));
  const l = clamp01(Number(lPct));
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}

function hslToSrgb(hDeg, sPct, lPct) {
  return hslToSrgbFloat(hDeg, sPct, lPct).map((c) => Math.round(clamp01(c) * 255));
}

function parseCssAngleDeg(tok) {
  const s = String(tok || "").trim();
  const nm = /^([-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(s);
  if (nm) {
    const val = Number.parseFloat(nm[1]);
    const unit = (nm[2] || "deg").toLowerCase();
    if (unit === "rad") return (val * 180) / Math.PI;
    if (unit === "grad") return val * 0.9;
    if (unit === "turn") return val * 360;
    return val;
  }
  if (/^(?:calc|min|max|clamp)\s*\(/i.test(s)) {
    return evalCssNumericExpr(s, null, "angle");
  }
  return null;
}

function parseCssAlpha(tok) {
  const s = String(tok || "").trim();
  if (/^none$/i.test(s)) return NaN;
  const am = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(%?)$/.exec(s);
  if (am) {
    const isPct = am[1] === "%";
    const n = Number.parseFloat(isPct ? s.slice(0, -1) : s);
    return Number.isFinite(n) ? (isPct ? n / 100 : n) : null;
  }
  if (/^(?:calc|min|max|clamp)\s*\(/i.test(s)) {
    return evalCssNumericExpr(s, 1, "scalar");
  }
  return null;
}

function linSrgbChannelToSrgbFloat(c) {
  const s = c < 0 ? -1 : 1;
  const a = Math.abs(c);
  return a > 0.0031308 ? s * (1.055 * Math.pow(a, 1 / 2.4) - 0.055) : 12.92 * c;
}

function linSrgbToXyzD65(lr, lg, lb) {
  return [
    0.4123907992659595 * lr + 0.357584339383878 * lg + 0.1804807884018343 * lb,
    0.21263900587151036 * lr + 0.715168678767756 * lg + 0.07219231536073371 * lb,
    0.01933081871559185 * lr + 0.11919477979462599 * lg + 0.9505321522496607 * lb,
  ];
}

function xyzD65ToLinSrgb(X, Y, Z) {
  return [
    +3.2409699419045213 * X - 1.5373831775700935 * Y - 0.4986107602930033 * Z,
    -0.9692436362808798 * X + 1.8759675015077206 * Y + 0.0415550574071756 * Z,
    +0.0556300796969936 * X - 0.2039769588889765 * Y + 1.0569715142428786 * Z,
  ];
}

function xyzD65ToSrgb(X, Y, Z) {
  const [lr, lg, lb] = xyzD65ToLinSrgb(X, Y, Z);
  return [linearSrgbChannelToSrgb255(lr), linearSrgbChannelToSrgb255(lg), linearSrgbChannelToSrgb255(lb)];
}

function xyzD50ToD65(X, Y, Z) {
  return [
    +0.9554734527042182 * X - 0.0230985368742614 * Y + 0.0632593086610217 * Z,
    -0.0283697069632081 * X + 1.0099954580058226 * Y + 0.0210413989669430 * Z,
    +0.0123140016883199 * X - 0.0205076964334779 * Y + 1.3303659366080753 * Z,
  ];
}

function linSrgbChannelInv(c) {
  const sgn = c < 0 ? -1 : 1;
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : sgn * Math.pow((a + 0.055) / 1.055, 2.4);
}

function labToXyzD65(L, a, b) {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xr = Math.pow(fx, 3) > epsilon ? Math.pow(fx, 3) : (116 * fx - 16) / kappa;
  const yr = L > kappa * epsilon ? Math.pow((L + 16) / 116, 3) : L / kappa;
  const zr = Math.pow(fz, 3) > epsilon ? Math.pow(fz, 3) : (116 * fz - 16) / kappa;
  return xyzD50ToD65(xr * (0.3457 / 0.3585), yr * 1.0, zr * ((1 - 0.3457 - 0.3585) / 0.3585));
}

export function labToSrgb(L, a, b) {
  return xyzD65ToSrgb(...labToXyzD65(L, a, b));
}

function hwbToSrgbFloat(hDeg, wPct, bPct) {
  const w = Math.max(0, wPct);
  const b = Math.max(0, bPct);
  if (w + b >= 1) {
    const v = clamp01(w / (w + b));
    return [v, v, v];
  }
  const base = hslToSrgbFloat(hDeg, 1, 0.5);
  return base.map((c) => clamp01(c * (1 - w - b) + w));
}

export function hwbToSrgb(hDeg, wPct, bPct) {
  return hwbToSrgbFloat(hDeg, wPct, bPct).map((c) => Math.round(clamp01(c) * 255));
}

function colorSpaceComponentsToXyzD65(csName, c0, c1, c2) {
  const cs = String(csName || "srgb").toLowerCase();
  if (cs === "srgb") {
    return linSrgbToXyzD65(linSrgbChannelInv(c0), linSrgbChannelInv(c1), linSrgbChannelInv(c2));
  }
  if (cs === "srgb-linear") {
    return linSrgbToXyzD65(c0, c1, c2);
  }
  if (cs === "display-p3" || cs === "display-p3-linear") {
    const [r, g, b] = cs === "display-p3-linear" ? [c0, c1, c2] : [linSrgbChannelInv(c0), linSrgbChannelInv(c1), linSrgbChannelInv(c2)];
    return [
      0.4865709486482162 * r + 0.2656676931690931 * g + 0.1982172852343625 * b,
      0.2289745640697488 * r + 0.6917385218365064 * g + 0.0792869140937450 * b,
      0.0451133818589026 * g + 1.0439443689009760 * b,
    ];
  }
  if (cs === "a98-rgb") {
    const inv = (v) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), 563 / 256);
    const [r, g, b] = [inv(c0), inv(c1), inv(c2)];
    return [
      0.5766690429101305 * r + 0.1855582379065463 * g + 0.1882286462349947 * b,
      0.2973449752505360 * r + 0.6273635662554661 * g + 0.0752914584939979 * b,
      0.0270313613864123 * r + 0.0706888525358272 * g + 0.9913375368376388 * b,
    ];
  }
  if (cs === "prophoto-rgb") {
    const inv = (v) => {
      const s = v < 0 ? -1 : 1;
      const a = Math.abs(v);
      return a <= 16 / 512 ? v / 16 : s * Math.pow(a, 1.8);
    };
    const [r, g, b] = [inv(c0), inv(c1), inv(c2)];
    return xyzD50ToD65(
      0.7977604896723027 * r + 0.1351858371757403 * g + 0.0313493495815248 * b,
      0.2880711282292934 * r + 0.7118432178101014 * g + 0.0000856539606052 * b,
      0.8251046025104601 * b
    );
  }
  if (cs === "rec2020") {
    const alpha = 1.09929682680944;
    const beta = 0.018053968510807;
    const inv = (v) => {
      const s = v < 0 ? -1 : 1;
      const a = Math.abs(v);
      return a < beta * 4.5 ? v / 4.5 : s * Math.pow((a + alpha - 1) / alpha, 1 / 0.45);
    };
    const [r, g, b] = [inv(c0), inv(c1), inv(c2)];
    return [
      0.6369580483012914 * r + 0.1446169035862083 * g + 0.1688809751641721 * b,
      0.2627002120112671 * r + 0.6779980715188708 * g + 0.0593017164698619 * b,
      0.0280726930490874 * g + 1.0609850577107910 * b,
    ];
  }
  if (cs === "xyz" || cs === "xyz-d65") {
    return [c0, c1, c2];
  }
  if (cs === "xyz-d50") {
    return xyzD50ToD65(c0, c1, c2);
  }
  return null;
}

export function colorSpaceComponentsToLinSrgb(csName, c0, c1, c2) {
  const cs = String(csName || "srgb").toLowerCase();
  if (cs === "srgb-linear") return [c0, c1, c2];
  const xyz = colorSpaceComponentsToXyzD65(cs, c0, c1, c2);
  return xyz ? xyzD65ToLinSrgb(xyz[0], xyz[1], xyz[2]) : null;
}

export function colorSpaceInSrgbGamutToRgba(csName, c0, c1, c2, alpha = 1) {
  const lin = colorSpaceComponentsToLinSrgb(csName, c0, c1, c2);
  if (!lin) return null;
  const [lr, lg, lb] = lin;
  if (lr < -0.005 || lr > 1.005 || lg < -0.005 || lg > 1.005 || lb < -0.005 || lb > 1.005) {
    return null;
  }
  return [linearSrgbChannelToSrgb255(lr), linearSrgbChannelToSrgb255(lg), linearSrgbChannelToSrgb255(lb), alpha];
}

export function wideColorInSrgbGamutToRgba(csName, c0, c1, c2, alpha = 1) {
  const cs = String(csName || "").toLowerCase();
  if (cs === "lab" || cs === "lch" || cs === "hwb") {
    let xyz;
    if (cs === "lab") {
      xyz = labToXyzD65(c0, c1, c2);
    } else if (cs === "lch") {
      const cPos = Math.max(0, c1);
      const hr = (c2 * Math.PI) / 180;
      xyz = labToXyzD65(c0, cPos * Math.cos(hr), cPos * Math.sin(hr));
    } else {
      const w = c1 / 100;
      const b = c2 / 100;
      let sr, sg, sb;
      if (w + b >= 1) {
        const v = w / (w + b);
        sr = sg = sb = v;
      } else {
        const base = hslToSrgbFloat(c0, 1, 0.5);
        sr = base[0] * (1 - w - b) + w;
        sg = base[1] * (1 - w - b) + w;
        sb = base[2] * (1 - w - b) + w;
      }
      xyz = linSrgbToXyzD65(linSrgbChannelInv(sr), linSrgbChannelInv(sg), linSrgbChannelInv(sb));
    }
    const [lr, lg, lb] = xyzD65ToLinSrgb(xyz[0], xyz[1], xyz[2]);
    if (lr < -0.005 || lr > 1.005 || lg < -0.005 || lg > 1.005 || lb < -0.005 || lb > 1.005) {
      return null;
    }
    return [linearSrgbChannelToSrgb255(lr), linearSrgbChannelToSrgb255(lg), linearSrgbChannelToSrgb255(lb), alpha];
  }
  return colorSpaceInSrgbGamutToRgba(cs, c0, c1, c2, alpha);
}

export function colorSpaceComponentsToSrgb(csName, c0, c1, c2) {
  const cs = String(csName || "srgb").toLowerCase();
  if (cs === "srgb") {
    return [Math.round(clamp01(c0) * 255), Math.round(clamp01(c1) * 255), Math.round(clamp01(c2) * 255)];
  }
  const lin = colorSpaceComponentsToLinSrgb(cs, c0, c1, c2);
  return lin ? [linearSrgbChannelToSrgb255(lin[0]), linearSrgbChannelToSrgb255(lin[1]), linearSrgbChannelToSrgb255(lin[2])] : null;
}

const CSS_NAMED_COLORS = Object.freeze({
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
  beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
  chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
  cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
  darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1", darkviolet: "9400d3",
  deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969", dodgerblue: "1e90ff",
  firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff", gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080", green: "008000",
  greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c",
  indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa", lavenderblush: "fff0f5",
  lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080", lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3", lightgreen: "90ee90", lightgrey: "d3d3d3", lightpink: "ffb6c1",
  lightsalmon: "ffa07a", lightseagreen: "20b2aa", lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899",
  lightsteelblue: "b0c4de", lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6",
  magenta: "ff00ff", maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3",
  mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc",
  mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5",
  navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23",
  orange: "ffa500", orangered: "ff4500", orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98",
  paleturquoise: "afeeee", palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f",
  pink: "ffc0cb", plum: "dda0dd", powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399",
  red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072",
  sandybrown: "f4a460", seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0",
  skyblue: "87ceeb", slateblue: "6a5acd", slategray: "708090", slategrey: "708090", snow: "fffafa",
  springgreen: "00ff7f", steelblue: "4682b4", tan: "d2b48c", teal: "008080", thistle: "d8bfd8",
  tomato: "ff6347", turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3", white: "ffffff",
  whitesmoke: "f5f5f5", yellow: "ffff00", yellowgreen: "9acd32",
});

function parseOuterCssCall(str) {
  const s = String(str || "").trim();
  const m = /^([a-z-]+)\s*\(/i.exec(s);
  if (!m) return null;
  const openIdx = s.indexOf("(");
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) {
        if (i !== s.length - 1) return null;
        return { fn: m[1].toLowerCase(), body: s.slice(openIdx + 1, i).trim() };
      }
    }
  }
  return null;
}

export function splitCssTopLevel(str, sep = ",") {
  const s = String(str || "");
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && s[i] === sep) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

export function splitCssTopLevelSpaces(str) {
  const s = String(str || "").trim();
  if (!s) return [];
  const parts = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") {
      if (start === -1) start = i;
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(ch)) {
      if (start !== -1) {
        parts.push(s.slice(start, i));
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) parts.push(s.slice(start));
  return parts;
}

export function evalCssNumericExpr(rawExpr, pctScale = 1, kind = "scalar") {
  const s = String(rawExpr || "").trim();
  if (!s) return null;
  const angleMul = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };
  if (kind === "scalar" && !/[()+\-*/]|^(?:calc|min|max|clamp)\b/i.test(s)) {
    const pm = /^([-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(%?)$/.exec(s);
    if (!pm) return null;
    const n = Number.parseFloat(pm[1]);
    if (!Number.isFinite(n)) return null;
    if (pm[2] === "%") return pctScale === null ? null : (n / 100) * pctScale;
    return n;
  }
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    const ch = s[i];
    if (ch === "(" || ch === ")" || ch === "," || ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "sym", val: ch });
      i++;
      continue;
    }
    const nm = /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?:%|deg|rad|grad|turn)?/i.exec(s.slice(i));
    if (nm && nm[0]) {
      const rawTok = nm[0];
      const lower = rawTok.toLowerCase();
      let v;
      if (lower.endsWith("%")) {
        if (pctScale === null) return null;
        v = (Number.parseFloat(lower.slice(0, -1)) / 100) * pctScale;
      } else {
        const um = /(deg|rad|grad|turn)$/i.exec(lower);
        if (um) {
          if (kind !== "angle") return null;
          v = Number.parseFloat(lower.slice(0, um.index)) * angleMul[um[1].toLowerCase()];
        } else {
          v = Number.parseFloat(lower);
        }
      }
      if (!Number.isFinite(v)) return null;
      tokens.push({ type: "num", val: v });
      i += rawTok.length;
      continue;
    }
    const fm = /^[a-z-]+/i.exec(s.slice(i));
    if (fm) {
      tokens.push({ type: "id", val: fm[0].toLowerCase() });
      i += fm[0].length;
      continue;
    }
    return null;
  }
  let pos = 0;
  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++];
  const parseExpr = () => {
    let left = parseTerm();
    if (left === null) return null;
    while (peek()?.type === "sym" && (peek().val === "+" || peek().val === "-")) {
      const op = consume().val;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
      if (!Number.isFinite(left)) return null;
    }
    return left;
  };
  const parseTerm = () => {
    let left = parseFactor();
    if (left === null) return null;
    while (peek()?.type === "sym" && (peek().val === "*" || peek().val === "/")) {
      const op = consume().val;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/") {
        if (right === 0) return null;
        left /= right;
      } else {
        left *= right;
      }
      if (!Number.isFinite(left)) return null;
    }
    return left;
  };
  const parseFactor = () => {
    const tk = peek();
    if (!tk) return null;
    if (tk.type === "sym" && (tk.val === "+" || tk.val === "-")) {
      consume();
      const sub = parseFactor();
      return sub === null ? null : tk.val === "-" ? -sub : sub;
    }
    if (tk.type === "num") {
      consume();
      return tk.val;
    }
    if (tk.type === "sym" && tk.val === "(") {
      consume();
      const val = parseExpr();
      if (val === null || peek()?.type !== "sym" || peek().val !== ")") return null;
      consume();
      return val;
    }
    if (tk.type === "id") {
      const fn = consume().val;
      if (fn === "e" && peek()?.val !== "(") return Math.E;
      if (fn === "pi" && peek()?.val !== "(") return Math.PI;
      if (peek()?.type !== "sym" || peek().val !== "(") return null;
      consume();
      const args = [];
      while (true) {
        const aVal = parseExpr();
        if (aVal === null) return null;
        args.push(aVal);
        if (peek()?.type === "sym" && peek().val === ",") {
          consume();
          continue;
        }
        if (peek()?.type === "sym" && peek().val === ")") {
          consume();
          break;
        }
        return null;
      }
      if (fn === "calc" && args.length === 1) return args[0];
      if (fn === "min" && args.length >= 1) return Math.min(...args);
      if (fn === "max" && args.length >= 1) return Math.max(...args);
      if (fn === "clamp" && args.length === 3) return Math.max(args[0], Math.min(args[2], args[1]));
      return null;
    }
    return null;
  };
  const out = parseExpr();
  return pos === tokens.length && out !== null && Number.isFinite(out) ? out : null;
}

function srgb255ToXyzD65(r255, g255, b255) {
  const lr = linSrgbChannelInv(r255 / 255);
  const lg = linSrgbChannelInv(g255 / 255);
  const lb = linSrgbChannelInv(b255 / 255);
  return [
    0.4123907992659595 * lr + 0.357584339383878 * lg + 0.1804807884018343 * lb,
    0.21263900587151036 * lr + 0.715168678767756 * lg + 0.07219231536073371 * lb,
    0.01933081871559185 * lr + 0.11919477979462599 * lg + 0.9505321522496607 * lb,
  ];
}

function xyzD65ToD50(x, y, z) {
  return [
    1.0479298208405488 * x + 0.022946793341019088 * y - 0.05019222954313557 * z,
    0.029627815688159344 * x + 0.990434484573249 * y - 0.01707382502938514 * z,
    -0.009243058152591178 * x + 0.015055144896577895 * y + 0.7518742899580008 * z,
  ];
}

function spaceToXyzD65(cs, c0, c1, c2) {
  const k0 = Number.isNaN(c0) ? 0 : c0;
  const k1 = Number.isNaN(c1) ? 0 : c1;
  const k2 = Number.isNaN(c2) ? 0 : c2;
  if (cs === "oklab") {
    return linSrgbToXyzD65(...oklabToLinSrgb(k0, k1, k2));
  }
  if (cs === "oklch") {
    const cPos = Math.max(0, k1);
    const hr = (k2 * Math.PI) / 180;
    return linSrgbToXyzD65(...oklabToLinSrgb(k0, cPos * Math.cos(hr), cPos * Math.sin(hr)));
  }
  if (cs === "lab") {
    return labToXyzD65(k0, k1, k2);
  }
  if (cs === "lch") {
    const cPos = Math.max(0, k1);
    const hr = (k2 * Math.PI) / 180;
    return labToXyzD65(k0, cPos * Math.cos(hr), cPos * Math.sin(hr));
  }
  if (cs === "hsl") {
    const [r, g, b] = hslToSrgbFloat(k0, k1 / 100, k2 / 100);
    return colorSpaceComponentsToXyzD65("srgb", r, g, b);
  }
  if (cs === "hwb") {
    const [r, g, b] = hwbToSrgbFloat(k0, k1 / 100, k2 / 100);
    return colorSpaceComponentsToXyzD65("srgb", r, g, b);
  }
  return colorSpaceComponentsToXyzD65(cs, k0, k1, k2);
}

function xyzD65ToSpace(cs, x, y, z) {
  const [lr, lg, lb] = xyzD65ToLinSrgb(x, y, z);
  const [r, g, b] = [linSrgbChannelToSrgbFloat(lr), linSrgbChannelToSrgbFloat(lg), linSrgbChannelToSrgbFloat(lb)];
  if (cs === "srgb") return [r, g, b];
  if (cs === "srgb-linear") return [lr, lg, lb];
  if (cs === "xyz" || cs === "xyz-d65") return [x, y, z];
  if (cs === "xyz-d50") return xyzD65ToD50(x, y, z);
  if (cs === "display-p3" || cs === "display-p3-linear") {
    const enc = (c) => {
      if (cs === "display-p3-linear") return c;
      const s = c < 0 ? -1 : 1;
      const a = Math.abs(c);
      return a > 0.0031308 ? s * (1.055 * Math.pow(a, 1 / 2.4) - 0.055) : 12.92 * c;
    };
    return [
      enc(2.493496911941425 * x - 0.9313836179191239 * y - 0.40271078445071684 * z),
      enc(-0.8294889695615747 * x + 1.7626640603183463 * y + 0.023624685841943577 * z),
      enc(0.03584583024378447 * x - 0.07617238926804182 * y + 0.9568845240076872 * z),
    ];
  }
  if (cs === "a98-rgb") {
    const enc = (c) => (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), 256 / 563);
    return [
      enc(2.0415879038107465 * x - 0.5650069742788596 * y - 0.34473135077832956 * z),
      enc(-0.9692436362808795 * x + 1.8759675015077202 * y + 0.04155505740717557 * z),
      enc(0.013444280632031142 * x - 0.11836239223101838 * y + 1.0151749943912054 * z),
    ];
  }
  if (cs === "prophoto-rgb") {
    const [x50, y50, z50] = xyzD65ToD50(x, y, z);
    const enc = (c) => {
      const s = c < 0 ? -1 : 1;
      const a = Math.abs(c);
      return a >= 1 / 512 ? s * Math.pow(a, 1 / 1.8) : 16 * c;
    };
    return [
      enc(1.3457989731028281 * x50 - 0.25558010007997534 * y50 - 0.05110628506753401 * z50),
      enc(-0.5446224939028347 * x50 + 1.5082327413132781 * y50 + 0.02053603239147973 * z50),
      enc(1.2119675456389454 * z50),
    ];
  }
  if (cs === "rec2020") {
    const alpha = 1.09929682680944;
    const beta = 0.018053968510807;
    const enc = (c) => {
      const s = c < 0 ? -1 : 1;
      const a = Math.abs(c);
      return a > beta ? s * (alpha * Math.pow(a, 0.45) - (alpha - 1)) : 4.5 * c;
    };
    return [
      enc(1.7166511879712674 * x - 0.35567078377639233 * y - 0.25336628137365974 * z),
      enc(-0.6666843518324892 * x + 1.6164812366349395 * y + 0.01576854581391113 * z),
      enc(0.017639857445310783 * x - 0.042770613257808524 * y + 0.9421031212354738 * z),
    ];
  }
  if (cs === "oklab" || cs === "oklch") {
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const ca = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const cb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    if (cs === "oklab") return [L, ca, cb];
    const C = Math.hypot(ca, cb);
    const h = C <= 1e-6 ? NaN : ((Math.atan2(cb, ca) * 180) / Math.PI + 360) % 360;
    return [L, C, h];
  }
  if (cs === "lab" || cs === "lch") {
    const [x50, y50, z50] = xyzD65ToD50(x, y, z);
    const kappa = 24389 / 27;
    const eps = 216 / 24389;
    const xr = x50 / (0.3457 / 0.3585);
    const yr = y50;
    const zr = z50 / ((1 - 0.3457 - 0.3585) / 0.3585);
    const f = (t) => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
    const fx = f(xr);
    const fy = f(yr);
    const fz = f(zr);
    const L = 116 * fy - 16;
    const ca = 500 * (fx - fy);
    const cb = 200 * (fy - fz);
    if (cs === "lab") return [L, ca, cb];
    const C = Math.hypot(ca, cb);
    const h = C <= 1e-4 ? NaN : ((Math.atan2(cb, ca) * 180) / Math.PI + 360) % 360;
    return [L, C, h];
  }
  if (cs === "hsl" || cs === "hwb") {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = NaN;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
      h = ((h % 360) + 360) % 360;
    }
    if (cs === "hwb") return [h, min * 100, (1 - max) * 100];
    const l = (max + min) / 2;
    const denom = 1 - Math.abs(2 * l - 1);
    const s = d === 0 || denom <= 1e-9 ? 0 : d / denom;
    if (s <= 1e-6 || l <= 1e-6 || l >= 1 - 1e-6) h = NaN;
    return [h, s * 100, l * 100];
  }
  return null;
}

function convertSpaceColor(col, targetCs) {
  if (col.cs === targetCs) return [...col.comps];
  const xyz = spaceToXyzD65(col.cs, col.comps[0], col.comps[1], col.comps[2]);
  if (!xyz) return null;
  const out = xyzD65ToSpace(targetCs, xyz[0], xyz[1], xyz[2]);
  if (!out) return null;
  const ANALOGOUS_CATS = {
    srgb: ["r", "g", "b"],
    "srgb-linear": ["r", "g", "b"],
    "display-p3": ["r", "g", "b"],
    "display-p3-linear": ["r", "g", "b"],
    "a98-rgb": ["r", "g", "b"],
    "prophoto-rgb": ["r", "g", "b"],
    rec2020: ["r", "g", "b"],
    xyz: ["x", "y", "z"],
    "xyz-d50": ["x", "y", "z"],
    "xyz-d65": ["x", "y", "z"],
    lab: ["L", "a", "b_opp"],
    oklab: ["L", "a", "b_opp"],
    lch: ["L", "C", "H"],
    oklch: ["L", "C", "H"],
    hsl: ["H", "C", "L"],
    hwb: ["H", null, null],
  };
  const srcCats = ANALOGOUS_CATS[col.cs];
  const dstCats = ANALOGOUS_CATS[targetCs];
  if (srcCats && dstCats) {
    for (let i = 0; i < 3; i++) {
      const cat = srcCats[i];
      if (!cat || !Number.isNaN(col.comps[i])) continue;
      const dstIdx = dstCats.indexOf(cat);
      if (dstIdx !== -1) out[dstIdx] = NaN;
    }
  }
  return out;
}

function interpolateHue(h1, h2, w1, w2, method = "shorter") {
  if (Number.isNaN(h1) && Number.isNaN(h2)) return NaN;
  if (Number.isNaN(h1)) return h2;
  if (Number.isNaN(h2)) return h1;
  let a = ((h1 % 360) + 360) % 360;
  let b = ((h2 % 360) + 360) % 360;
  if (method === "shorter") {
    if (b - a > 180) a += 360;
    else if (b - a < -180) b += 360;
  } else if (method === "longer") {
    const diff = b - a;
    if (diff > 0 && diff < 180) a += 360;
    else if (diff > -180 && diff <= 0) b += 360;
  } else if (method === "increasing") {
    if (b < a) b += 360;
  } else if (method === "decreasing") {
    if (a < b) a += 360;
  }
  return (((a * w1 + b * w2) % 360) + 360) % 360;
}

function parseCssColorToSpaceColor(trimmed, mode = null) {
  const s = String(trimmed || "").trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === "transparent") return { cs: "srgb", comps: [0, 0, 0], alpha: 0 };
  if (/^#[0-9a-f]+$/i.test(s)) {
    const hx = parseHexToRgba(s);
    return hx ? { cs: "srgb", comps: [hx[0] / 255, hx[1] / 255, hx[2] / 255], alpha: hx[3] } : null;
  }
  if (Object.prototype.hasOwnProperty.call(CSS_NAMED_COLORS, low)) {
    const hx = parseHexToRgba("#" + CSS_NAMED_COLORS[low]);
    return hx ? { cs: "srgb", comps: [hx[0] / 255, hx[1] / 255, hx[2] / 255], alpha: hx[3] } : null;
  }
  const outer = parseOuterCssCall(s);
  if (!outer) return null;
  const { fn, body } = outer;

  if (fn === "light-dark") {
    const args = splitCssTopLevel(body, ",");
    if (args.length !== 2) return null;
    return parseCssColorToSpaceColor(mode === "dark" ? args[1] : args[0], mode);
  }

  if (fn === "color-mix") {
    const args = splitCssTopLevel(body, ",");
    if (args.length !== 3) return null;
    const methodToks = args[0].toLowerCase().split(/\s+/).filter(Boolean);
    if (methodToks[0] !== "in" || !methodToks[1]) return null;
    const cs = methodToks[1];
    let hueMethod = "shorter";
    if (methodToks.length > 2) {
      if (methodToks.length !== 4 || methodToks[3] !== "hue" || !/^(?:shorter|longer|increasing|decreasing)$/.test(methodToks[2])) {
        return null;
      }
      hueMethod = methodToks[2];
    }
    const parseMixStop = (stopStr) => {
      const sp = splitCssTopLevelSpaces(stopStr);
      if (sp.length < 1) return null;
      const tryPct = (tok) => {
        const em = evalCssNumericExpr(tok, 100, "scalar");
        return em !== null && (tok.includes("%") || /^(?:calc|min|max|clamp)\s*\(/i.test(tok)) ? em : null;
      };
      let pct = null;
      let colStr = stopStr;
      if (sp.length >= 2) {
        const pLast = tryPct(sp[sp.length - 1]);
        const pFirst = pLast === null ? tryPct(sp[0]) : null;
        if (pLast !== null) {
          pct = pLast;
          colStr = sp.slice(0, -1).join(" ");
        } else if (pFirst !== null) {
          pct = pFirst;
          colStr = sp.slice(1).join(" ");
        }
      }
      const col = parseCssColorToSpaceColor(colStr, mode);
      return col ? { col, pct } : null;
    };
    const s1 = parseMixStop(args[1]);
    const s2 = parseMixStop(args[2]);
    if (!s1 || !s2) return null;
    let p1 = s1.pct;
    let p2 = s2.pct;
    if (p1 === null && p2 === null) {
      p1 = 50;
      p2 = 50;
    } else if (p1 === null) {
      p1 = 100 - p2;
    } else if (p2 === null) {
      p2 = 100 - p1;
    }
    if (p1 < 0 || p2 < 0 || p1 + p2 <= 0) return null;
    const pSum = p1 + p2;
    const alphaMult = pSum < 100 ? pSum / 100 : 1;
    const w2 = p2 / pSum;
    const w1 = 1 - w2;
    const v1 = convertSpaceColor(s1.col, cs);
    const v2 = convertSpaceColor(s2.col, cs);
    if (!v1 || !v2) return null;
    let a1 = s1.col.alpha;
    let a2 = s2.col.alpha;
    if (Number.isNaN(a1) && Number.isNaN(a2)) {
      return { cs, comps: [0, 0, 0], alpha: 0 };
    }
    if (Number.isNaN(a1)) a1 = a2;
    if (Number.isNaN(a2)) a2 = a1;
    const aMix = a1 * w1 + a2 * w2;
    if (aMix <= 0) return { cs, comps: [0, 0, 0], alpha: 0 };
    const hueIdx = cs === "oklch" || cs === "lch" ? 2 : cs === "hsl" || cs === "hwb" ? 0 : -1;
    const res = [0, 1, 2].map((idx) => {
      if (idx === hueIdx) return interpolateHue(v1[idx], v2[idx], w1, w2, hueMethod);
      let c1 = v1[idx];
      let c2 = v2[idx];
      if (Number.isNaN(c1) && Number.isNaN(c2)) return NaN;
      if (Number.isNaN(c1)) c1 = c2;
      if (Number.isNaN(c2)) c2 = c1;
      return (c1 * a1 * w1 + c2 * a2 * w2) / aMix;
    });
    return { cs, comps: res, alpha: clamp01(aMix * alphaMult) };
  }

  if (!/^(?:oklch|oklab|rgba?|hsla?|hwb|lab|lch|color)$/.test(fn)) return null;
  const slashParts = splitCssTopLevel(body, "/");
  if (slashParts.length > 2) return null;
  let mainStr = slashParts[0];
  let alpha = 1;
  if (slashParts.length === 2) {
    const aVal = parseCssAlpha(slashParts[1]);
    if (aVal === null) return null;
    alpha = Number.isNaN(aVal) ? NaN : clamp01(aVal);
  }
  const commaParts = splitCssTopLevel(mainStr, ",");
  const hasCommas = commaParts.length > 1;
  const parts = hasCommas ? commaParts : splitCssTopLevelSpaces(mainStr);
  if (fn === "color") {
    if (parts.length !== 4) return null;
    const cs = parts[0].toLowerCase();
    const vals = parts.slice(1).map((p) => {
      if (/^none$/i.test(p)) return NaN;
      const v = evalCssNumericExpr(p, 1, "scalar");
      return v !== null && Number.isFinite(v) ? v : null;
    });
    if (vals.some((v) => v === null)) return null;
    if (!colorSpaceComponentsToLinSrgb(cs, 0, 0, 0)) return null;
    return { cs, comps: vals, alpha };
  }
  if (fn === "rgb" || fn === "rgba" || fn === "hsl" || fn === "hsla" || fn === "hwb") {
    if (fn !== "hwb" && hasCommas && parts.length === 4 && slashParts.length === 1) {
      const aVal = parseCssAlpha(parts[3]);
      if (aVal === null) return null;
      alpha = Number.isNaN(aVal) ? NaN : clamp01(aVal);
    } else if (parts.length !== 3) {
      return null;
    }
    if (fn === "rgb" || fn === "rgba") {
      const ch = parts.slice(0, 3).map((p) => {
        if (/^none$/i.test(p)) return NaN;
        const v = evalCssNumericExpr(p, 255, "scalar");
        return v !== null && Number.isFinite(v) ? clamp01(v / 255) : null;
      });
      return ch.every((v) => v !== null) ? { cs: "srgb", comps: ch, alpha } : null;
    }
    const h = /^none$/i.test(parts[0]) ? NaN : parseCssAngleDeg(parts[0]);
    const p1v = /^none$/i.test(parts[1]) ? NaN : evalCssNumericExpr(parts[1], 100, "scalar");
    const p2v = /^none$/i.test(parts[2]) ? NaN : evalCssNumericExpr(parts[2], 100, "scalar");
    if (h === null || p1v === null || p2v === null || (!Number.isNaN(p1v) && !Number.isFinite(p1v)) || (!Number.isNaN(p2v) && !Number.isFinite(p2v))) {
      return null;
    }
    return { cs: fn === "hwb" ? "hwb" : "hsl", comps: [h, p1v, p2v], alpha };
  }
  if (parts.length !== 3) return null;
  const parseUnitOrPct = (p, pctScale) => {
    if (/^none$/i.test(p)) return NaN;
    const n = evalCssNumericExpr(p, pctScale, "scalar");
    return n !== null && Number.isFinite(n) ? n : null;
  };
  if (fn === "lab" || fn === "lch") {
    const L = parseUnitOrPct(parts[0], 100);
    if (L === null) return null;
    if (fn === "lab") {
      const a = parseUnitOrPct(parts[1], 125);
      const b = parseUnitOrPct(parts[2], 125);
      if (a === null || b === null) return null;
      return { cs: "lab", comps: [L, a, b], alpha };
    }
    const rawC = parseUnitOrPct(parts[1], 150);
    const h = /^none$/i.test(parts[2]) ? NaN : parseCssAngleDeg(parts[2]);
    if (rawC === null || h === null) return null;
    return { cs: "lch", comps: [L, Number.isNaN(rawC) ? NaN : Math.max(0, rawC), h], alpha };
  }
  const L = parseUnitOrPct(parts[0], 1);
  if (L === null) return null;
  if (fn === "oklab") {
    const a = parseUnitOrPct(parts[1], 0.4);
    const b = parseUnitOrPct(parts[2], 0.4);
    if (a === null || b === null) return null;
    return { cs: "oklab", comps: [L, a, b], alpha };
  }
  const C = parseUnitOrPct(parts[1], 0.4);
  const h = /^none$/i.test(parts[2]) ? NaN : parseCssAngleDeg(parts[2]);
  if (C === null || h === null) return null;
  return { cs: "oklch", comps: [L, Number.isNaN(C) ? NaN : Math.max(0, C), h], alpha };
}

export function parseCssColorToRgba(trimmed, mode = null) {
  const sp = parseCssColorToSpaceColor(trimmed, mode);
  if (!sp) return null;
  const alpha = Number.isNaN(sp.alpha) ? 0 : sp.alpha;
  const c0 = Number.isNaN(sp.comps[0]) ? 0 : sp.comps[0];
  const c1 = Number.isNaN(sp.comps[1]) ? 0 : sp.comps[1];
  const c2 = Number.isNaN(sp.comps[2]) ? 0 : sp.comps[2];
  const cs = sp.cs;
  if (cs === "srgb") {
    return [Math.round(clamp01(c0) * 255), Math.round(clamp01(c1) * 255), Math.round(clamp01(c2) * 255), alpha];
  }
  if (cs === "oklch") return [...oklchToSrgb(c0, c1, c2), alpha];
  if (cs === "oklab") return [...oklabToSrgb(c0, c1, c2), alpha];
  if (cs === "lab") return [...labToSrgb(c0, c1, c2), alpha];
  if (cs === "lch") {
    const hr = (c2 * Math.PI) / 180;
    return [...labToSrgb(c0, Math.max(0, c1) * Math.cos(hr), Math.max(0, c1) * Math.sin(hr)), alpha];
  }
  if (cs === "hsl") return [...hslToSrgb(c0, c1 / 100, c2 / 100), alpha];
  if (cs === "hwb") return [...hwbToSrgb(c0, c1 / 100, c2 / 100), alpha];
  const rgb = colorSpaceComponentsToSrgb(cs, c0, c1, c2);
  return rgb ? [...rgb, alpha] : null;
}

const modePrefixCache = new WeakMap();
function getModePrefixes(byPath) {
  let cached = modePrefixCache.get(byPath);
  if (cached) return cached;
  const set = new Set(["light", "dark"]);
  for (const k of byPath.keys()) {
    const mm = /(?:^|\.)(light|dark)(?:\.|$)/i.exec(k);
    if (mm) set.add(mm[1]);
  }
  cached = [...set];
  modePrefixCache.set(byPath, cached);
  return cached;
}

function selectLightDarkBranches(cssStr, mode) {
  let cur = String(cssStr || "");
  let safety = 0;
  while (safety++ < 32) {
    let foundIdx = -1;
    let searchPos = 0;
    while (searchPos < cur.length) {
      const m = /\blight-dark\s*\(/i.exec(cur.slice(searchPos));
      if (!m) break;
      const cand = searchPos + m.index;
      if (cand > 0 && /[a-zA-Z0-9_-]/.test(cur[cand - 1])) {
        searchPos = cand + m[0].length;
        continue;
      }
      foundIdx = cand;
      break;
    }
    if (foundIdx === -1) return cur;
    const openP = cur.indexOf("(", foundIdx);
    let depth = 0;
    let closeP = -1;
    for (let k = openP; k < cur.length; k++) {
      if (cur[k] === "(") depth++;
      else if (cur[k] === ")") {
        depth--;
        if (depth === 0) {
          closeP = k;
          break;
        }
      }
    }
    if (closeP === -1) return null;
    const body = cur.slice(openP + 1, closeP);
    const args = splitCssTopLevel(body, ",");
    if (args.length !== 2) return null;
    const picked = (mode === "dark" ? args[1] : args[0]).trim();
    cur = `${cur.slice(0, foundIdx)}${picked}${cur.slice(closeP + 1)}`;
  }
  return cur;
}

function resolveColorRgba(val, byPath, stack = [], mode = null) {
  const pickModeTarget = (t) => {
    if (!t) return null;
    if ((mode === "light" || mode === "dark") && !/^(?:light|dark)\./i.test(t)) {
      const prefixes = getModePrefixes(byPath).filter((mp) => mp.toLowerCase() === mode);
      for (const mp of prefixes) {
        const pref = `${mp}.${t}`;
        if (byPath.has(pref) && !stack.includes(pref)) return pref;
        for (let dotIdx = t.indexOf("."); dotIdx !== -1; dotIdx = t.indexOf(".", dotIdx + 1)) {
          const mid = `${t.slice(0, dotIdx)}.${mp}.${t.slice(dotIdx + 1)}`;
          if (byPath.has(mid) && !stack.includes(mid)) return mid;
        }
        const suf = `${t}.${mp}`;
        if (byPath.has(suf) && !stack.includes(suf)) return suf;
      }
    }
    return byPath.has(t) && !stack.includes(t) ? t : null;
  };
  if (typeof val === "string") {
    const target = aliasTarget(val);
    const picked = pickModeTarget(target);
    if (picked) {
      const tTok = byPath.get(picked);
      return resolveColorRgba(resolveTokenModeValue(tTok, mode), byPath, [...stack, picked], mode);
    }
    const trimmed = val.trim();
    if (/^#[0-9a-f]+$/i.test(trimmed)) {
      const rgba = parseHexToRgba(trimmed);
      if (rgba) return rgba;
    }
    const ldCall = /^light-dark\s*\(/i.test(trimmed) ? parseOuterCssCall(trimmed) : null;
    if (ldCall?.fn === "light-dark") {
      const ldArgs = splitCssTopLevel(ldCall.body, ",");
      if (ldArgs.length === 2) {
        return resolveColorRgba(mode === "dark" ? ldArgs[1] : ldArgs[0], byPath, stack, mode);
      }
      return null;
    }
    let expanded = trimmed;
    if (/\blight-dark\s*\(/i.test(expanded)) {
      const ldSelected = selectLightDarkBranches(expanded, mode);
      if (ldSelected === null) return null;
      expanded = ldSelected;
    }
    if (/\{[^}]+\}/.test(expanded)) {
      let failedRef = false;
      expanded = expanded.replace(/\{([^}]+)\}/g, (full, inner) => {
        const pt = pickModeTarget(inner.trim().replace(/\.\$root$/i, ""));
        if (!pt) {
          failedRef = true;
          return full;
        }
        const rgba = resolveColorRgba(`{${pt}}`, byPath, stack, mode);
        if (!rgba) {
          failedRef = true;
          return full;
        }
        return `rgb(${rgba[0]} ${rgba[1]} ${rgba[2]} / ${rgba[3]})`;
      });
      if (failedRef) return null;
    }
    return parseCssColorToRgba(expanded, mode);
  }
  if (val && typeof val === "object") {
    if (val.$ref) {
      const pt = pickModeTarget(pointerTarget(val.$ref, byPath));
      if (pt) {
        const tTok = byPath.get(pt);
        return resolveColorRgba(resolveTokenModeValue(tTok, mode), byPath, [...stack, pt], mode);
      }
    }
    if (Array.isArray(val.components) && val.components.length >= 3) {
      const cs = String(val.colorSpace || "srgb").toLowerCase();
      const alpha = typeof val.alpha === "number" && Number.isFinite(val.alpha) ? clamp01(val.alpha) : 1;
      const nums = val.components.slice(0, 3).map((n) => (n === "none" ? 0 : n));
      if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      if (cs === "oklch") return [...oklchToSrgb(nums[0], nums[1], nums[2]), alpha];
      if (cs === "oklab") return [...oklabToSrgb(nums[0], nums[1], nums[2]), alpha];
      if (cs === "hsl") return [...hslToSrgb(nums[0], nums[1] / 100, nums[2] / 100), alpha];
      if (cs === "hwb") return [...hwbToSrgb(nums[0], nums[1] / 100, nums[2] / 100), alpha];
      if (cs === "lab") return [...labToSrgb(nums[0], nums[1], nums[2]), alpha];
      if (cs === "lch") {
        const cPos = Math.max(0, nums[1]);
        const hr = (nums[2] * Math.PI) / 180;
        return [...labToSrgb(nums[0], cPos * Math.cos(hr), cPos * Math.sin(hr)), alpha];
      }
      if (cs !== "srgb") {
        const converted = colorSpaceComponentsToSrgb(cs, nums[0], nums[1], nums[2]);
        if (converted) return [...converted, alpha];
        if (typeof val.hex === "string" && val.hex.trim()) {
          const hexRgba = parseHexToRgba(val.hex.trim()) || parseCssColorToRgba(val.hex.trim());
          if (hexRgba) {
            return [
              hexRgba[0],
              hexRgba[1],
              hexRgba[2],
              typeof val.alpha === "number" && Number.isFinite(val.alpha) ? clamp01(val.alpha) : hexRgba[3],
            ];
          }
        }
        return null;
      }
      const isLegacy255 = nums.every((n) => n >= 0 && n <= 255) && nums.some((n) => n > 2);
      const scale = isLegacy255 ? 1 : 255;
      const clampChan = (n) => Math.max(0, Math.min(255, Math.round(n * scale)));
      return [clampChan(nums[0]), clampChan(nums[1]), clampChan(nums[2]), alpha];
    }
  }
  return null;
}

export function analyzeDtcgModesAndContrast(source) {
  const tokens = Array.isArray(source) ? source : flattenTokens(source);
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  const lightKeys = new Set();
  const darkKeys = new Set();
  const resolvedColors = [];
  const invariantTokens = [];

  const splitCamel = (str) =>
    String(str || "")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
  const fgBaseRe = /(?:^|[._-])(?:text|fg|foreground|ink|title|heading|subtitle|caption|copy)(?:$|[._-])/;
  const bgRe = /(?:^|[._-])(?:bg|background|surface|canvas|card|panel)(?:$|[._-])/;
  const onRoleRe =
    /(?:^|[._-])on[-_]([a-z0-9-]+?)(?:\.|$)|(?:^|[._-])on(primary|secondary|accent|brand|danger|error|warning|success|info|surface|background|bg|card|panel|inverse|dark|light)(?:\.|$)/;
  const extractCompSlug = (rolePath) => {
    const cm = /(?:^|\.)components?\.([a-z0-9_.-]+)$/i.exec(String(rolePath || ""));
    if (!cm) return null;
    const segs = cm[1].split(".").filter(Boolean);
    if (segs.length < 2) return null;
    const ROLE_SEG_RE =
      /^(?:bg|background|surface|fill|container|canvas|text|fg|foreground|ink|label|icon|title|heading|subtitle|caption|copy|border|stroke|outline|ring|divider|shadow|placeholder|on[-_].+)(?:$|[-_])/i;
    const ri = segs.findIndex((seg, idx) => idx >= 1 && ROLE_SEG_RE.test(seg));
    return (ri >= 1 ? segs.slice(0, ri) : segs.slice(0, -1)).join(".").toLowerCase();
  };
  const stripCompSlug = (normPath) => {
    const cm = /(?:^|\.)components?\.([a-z0-9_.-]+)$/i.exec(normPath);
    if (!cm) return normPath;
    const comp = extractCompSlug(normPath);
    if (!comp) return normPath;
    const compIdx = cm[1].toLowerCase().indexOf(comp);
    const rest = compIdx !== -1 ? cm[1].slice(compIdx + comp.length).replace(/^\./, "") : cm[1];
    return rest || normPath;
  };
  const isFgPath = (p) => {
    const roleSlice = stripCompSlug(splitCamel(p));
    return fgBaseRe.test(roleSlice) || onRoleRe.test(roleSlice);
  };
  const leafModeParentRe =
    /(?:^|[._-])(?:bg|background|surface|canvas|card|panel|text|fg|foreground|ink|border|stroke|outline|ring|divider|shadow|icon|theme|mode)(?:$|[._-])/;

  for (const tok of tokens) {
    const extModes = getTokenExtModes(tok);
    const lightExtKey = getModeKey(extModes, "light");
    const darkExtKey = getModeKey(extModes, "dark");
    const hasThemeExtMode = Boolean(lightExtKey || darkExtKey);
    const pushResolved = (modeName, rgba, isInv) => {
      if (rgba) resolvedColors.push({ path: tok.path, mode: modeName, rgb: [rgba[0], rgba[1], rgba[2]], alpha: rgba[3], isInvariant: isInv });
    };
    if (hasThemeExtMode) {
      const lightVal = lightExtKey ? unwrapModeEntry(extModes[lightExtKey]) : tok.value ?? (tok.ref ? { $ref: tok.ref } : null);
      const darkVal = darkExtKey ? unwrapModeEntry(extModes[darkExtKey]) : tok.value ?? (tok.ref ? { $ref: tok.ref } : null);
      const lightRgba = lightVal != null ? resolveColorRgba(lightVal, byPath, [tok.path], "light") : null;
      const darkRgba = darkVal != null ? resolveColorRgba(darkVal, byPath, [tok.path], "dark") : null;
      const sameRgba = Boolean(
        lightRgba &&
          darkRgba &&
          lightRgba[0] === darkRgba[0] &&
          lightRgba[1] === darkRgba[1] &&
          lightRgba[2] === darkRgba[2] &&
          lightRgba[3] === darkRgba[3]
      );
      if (lightExtKey) {
        lightKeys.add(tok.path);
        pushResolved("light", lightRgba, false);
      } else if (tok.value != null || tok.ref) {
        lightKeys.add(tok.path);
        pushResolved("light", lightRgba, sameRgba);
      }
      if (darkExtKey) {
        darkKeys.add(tok.path);
        pushResolved("dark", darkRgba, false);
      } else if (tok.value != null || tok.ref) {
        darkKeys.add(tok.path);
        pushResolved("dark", darkRgba, sameRgba);
      }
      continue;
    }

    const parts = tok.path.split(".");
    const lowerPaths = getLowerTokenPathSet(byPath);
    const modeIdx = parts.findIndex((seg, sIdx) => {
      const low = seg.toLowerCase();
      if (low !== "light" && low !== "dark") return false;
      if (sIdx < parts.length - 1) return true;
      const tokType = String(tok.type || "").toLowerCase();
      if (NON_THEME_DTCG_LEAF_TYPES.has(tokType)) return false;
      const parentPath = splitCamel(parts.slice(0, sIdx).join("."));
      if (parentPath && !leafModeParentRe.test(parentPath) && !onRoleRe.test(parentPath)) {
        return false;
      }
      const opp = low === "light" ? "dark" : "light";
      return lowerPaths.has([...parts.slice(0, sIdx), opp].join(".").toLowerCase());
    });
    let mode = "default";
    if (modeIdx !== -1) {
      mode = parts[modeIdx].toLowerCase();
      const modeKeyPath = [...parts.slice(0, modeIdx), ...parts.slice(modeIdx + 1)].join(".");
      if (mode === "light") lightKeys.add(modeKeyPath);
      else darkKeys.add(modeKeyPath);
    }

    if (mode === "default") {
      const baseVal = tok.value ?? (tok.ref ? { $ref: tok.ref } : null);
      const lRgba = baseVal != null ? resolveColorRgba(baseVal, byPath, [tok.path], "light") : null;
      const dRgba = baseVal != null ? resolveColorRgba(baseVal, byPath, [tok.path], "dark") : null;
      const differsByMode = Boolean(
        lRgba &&
          dRgba &&
          (lRgba[0] !== dRgba[0] || lRgba[1] !== dRgba[1] || lRgba[2] !== dRgba[2] || lRgba[3] !== dRgba[3])
      );
      if (differsByMode) {
        lightKeys.add(tok.path);
        darkKeys.add(tok.path);
        pushResolved("light", lRgba, false);
        pushResolved("dark", dRgba, false);
      } else if (lRgba && !dRgba) {
        lightKeys.add(tok.path);
        pushResolved("light", lRgba, false);
      } else if (dRgba && !lRgba) {
        darkKeys.add(tok.path);
        pushResolved("dark", dRgba, false);
      } else {
        invariantTokens.push(tok);
      }
    } else {
      pushResolved(mode, resolveColorRgba(tok.value ?? (tok.ref ? { $ref: tok.ref } : null), byPath, [tok.path], mode), false);
    }
  }

  const hasModes = lightKeys.size > 0 || darkKeys.size > 0;

  for (const tok of invariantTokens) {
    const baseVal = tok.value ?? (tok.ref ? { $ref: tok.ref } : null);
    const pushResolved = (modeName, rgba, isInv) => {
      if (rgba) resolvedColors.push({ path: tok.path, mode: modeName, rgb: [rgba[0], rgba[1], rgba[2]], alpha: rgba[3], isInvariant: isInv });
    };
    if (hasModes) {
      const inLight = lightKeys.has(tok.path);
      const inDark = darkKeys.has(tok.path);
      if (!inLight && !inDark) {
        const lightRgba = resolveColorRgba(baseVal, byPath, [tok.path], "light");
        const darkRgba = resolveColorRgba(baseVal, byPath, [tok.path], "dark");
        const actuallyInvariant = Boolean(
          lightRgba && darkRgba && lightRgba[0] === darkRgba[0] && lightRgba[1] === darkRgba[1] && lightRgba[2] === darkRgba[2] && lightRgba[3] === darkRgba[3]
        );
        pushResolved("light", lightRgba, actuallyInvariant);
        pushResolved("dark", darkRgba, actuallyInvariant);
      } else {
        if (!inLight) {
          if (inDark) lightKeys.add(tok.path);
          pushResolved("light", resolveColorRgba(baseVal, byPath, [tok.path], "light"), true);
        }
        if (!inDark) {
          if (inLight) darkKeys.add(tok.path);
          pushResolved("dark", resolveColorRgba(baseVal, byPath, [tok.path], "dark"), true);
        }
      }
    } else {
      pushResolved("default", resolveColorRgba(baseVal, byPath, [tok.path], null), true);
    }
  }

  const missingInDark = [...lightKeys].filter((k) => !darkKeys.has(k)).sort();
  const missingInLight = [...darkKeys].filter((k) => !lightKeys.has(k)).sort();
  const inverseSegRe = /(?:^|[._-])invers(?:e|ed)(?:$|[._-])/;
  const nonFillRe = /(?:^|[._-])(?:border|stroke|outline|ring|divider|shadow|icon)(?:$|[._-])/;
  const isNonFillPath = (p) => nonFillRe.test(stripCompSlug(splitCamel(p)));
  const primitiveNamespaceRe = /(?:^|\.)(?:primitives?|palettes?|raw|scales?)(?:\.|$)/i;
  const numericScaleStepRe = /(?:^|[._-])(?:25|50|75|[1-9]00|950)(?:$|[._-])/;
  const subRoleRe = /(?:^|[._-])(container|subtle|soft|muted|tint|wash|lighter|darker|light|dark)(?=$|[._-])/gi;
  const stripModePath = (rawPath, mode, isInvariant) => {
    const np = splitCamel(rawPath);
    if (!isInvariant && (mode === "light" || mode === "dark")) {
      return np.replace(new RegExp(`(^|\\.)${mode}(?:\\.|$)`), (m, pre) => (pre && m.endsWith(".") ? pre : ""));
    }
    return np;
  };
  const sameStrSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const modeFlags = new Map();
  for (const mName of ["default", "light", "dark"]) {
    const modeCols = resolvedColors.filter((c) => {
      if (c.mode !== mName) return false;
      const np = splitCamel(c.path);
      return !primitiveNamespaceRe.test(c.path) && !numericScaleStepRe.test(np);
    });
    const compFgs = new Set();
    const compBgs = new Set();
    const nonSurfaceBgs = [];
    const dedicatedOnSpecs = [];
    const roleHasNonSurfaceBg = new Set();
    for (const c of modeCols) {
      if (isFgPath(c.path) || isNonFillPath(c.path)) continue;
      const np = splitCamel(c.path);
      if (bgRe.test(np)) continue;
      const rp = stripModePath(c.path, c.mode, c.isInvariant);
      nonSurfaceBgs.push({
        rolePath: rp,
        subRoles: [...rp.matchAll(subRoleRe)].map((mm) => mm[1].toLowerCase()),
      });
    }
    for (const c of modeCols) {
      const rp = stripModePath(c.path, c.mode, c.isInvariant);
      const comp = extractCompSlug(rp);
      if (isFgPath(c.path)) {
        if (comp) compFgs.add(comp);
        const onM = onRoleRe.exec(splitCamel(c.path));
        const rawRole = onM ? (onM[1] || onM[2]).replace(/_/g, "-") : null;
        if (rawRole && !/^(?:surface|background|bg|canvas|light|dark|inverse|inversed)$/.test(rawRole)) {
          const escRole = rawRole.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[._-]");
          const roleRe = new RegExp(`(?:^|[._-])${escRole}(?:$|[._-])`, "i");
          const subRoles = new Set([...rawRole.matchAll(subRoleRe)].map((mm) => mm[1].toLowerCase()));
          const hasNonSurfaceMatch =
            !bgRe.test(rawRole) &&
            nonSurfaceBgs.some((bgEntry) => roleRe.test(bgEntry.rolePath) && bgEntry.subRoles.every((sr) => subRoles.has(sr)));
          const roleKey = `${rawRole}|${[...subRoles].sort().join(",")}`;
          if (hasNonSurfaceMatch) roleHasNonSurfaceBg.add(roleKey);
          dedicatedOnSpecs.push({
            roleRe,
            subRoles,
            hasNonSurfaceMatch,
          });
        }
      } else if (!isNonFillPath(c.path)) {
        if (comp) compBgs.add(comp);
      }
    }
    const compPaired = new Set([...compFgs].filter((x) => compBgs.has(x)));
    modeFlags.set(mName, {
      hasExplicitDark: modeCols.some((c) => bgRe.test(splitCamel(c.path)) && /(?:^|[._-])dark(?:$|[._-])/.test(stripModePath(c.path, c.mode, c.isInvariant))),
      hasExplicitLight: modeCols.some((c) => bgRe.test(splitCamel(c.path)) && /(?:^|[._-])light(?:$|[._-])/.test(stripModePath(c.path, c.mode, c.isInvariant))),
      hasNonDarkBg: modeCols.some((c) => {
        const np = splitCamel(c.path);
        const rp = stripModePath(c.path, c.mode, c.isInvariant);
        return !isFgPath(c.path) && !isNonFillPath(c.path) && bgRe.test(np) && !/(?:^|[._-])dark(?:$|[._-])/.test(rp);
      }),
      hasNonLightBg: modeCols.some((c) => {
        const np = splitCamel(c.path);
        const rp = stripModePath(c.path, c.mode, c.isInvariant);
        return !isFgPath(c.path) && !isNonFillPath(c.path) && bgRe.test(np) && !/(?:^|[._-])light(?:$|[._-])/.test(rp);
      }),
      hasDarkFg: modeCols.some((c) => {
        const rp = stripModePath(c.path, c.mode, c.isInvariant);
        return isFgPath(c.path) && /(?:^|[._-])(?:dark|on[-_]?dark)(?:$|[._-])/.test(rp);
      }),
      hasLightFg: modeCols.some((c) => {
        const rp = stripModePath(c.path, c.mode, c.isInvariant);
        return isFgPath(c.path) && /(?:^|[._-])(?:light|on[-_]?light)(?:$|[._-])/.test(rp);
      }),
      hasOnCard: modeCols.some((c) => isFgPath(c.path) && /(?:^|[._-])on[-_]?card(?:$|[._-])/.test(splitCamel(c.path))),
      hasOnPanel: modeCols.some((c) => isFgPath(c.path) && /(?:^|[._-])on[-_]?panel(?:$|[._-])/.test(splitCamel(c.path))),
      compPaired,
      dedicatedOnSpecs,
      roleHasNonSurfaceBg,
    });
  }
  const pairs = [];
  const modeCounts = new Map();
  for (const fg of resolvedColors) {
    if (!isFgPath(fg.path)) continue;
    if (primitiveNamespaceRe.test(fg.path)) continue;
    const fgNormPath = splitCamel(fg.path);
    const fgRolePath = stripModePath(fg.path, fg.mode, fg.isInvariant);
    const fgComp = extractCompSlug(fgRolePath);
    if (isNonFillPath(fg.path) || numericScaleStepRe.test(fgNormPath)) continue;
    const onM = onRoleRe.exec(fgNormPath);
    const onRoleRaw = onM ? (onM[1] || onM[2]).replace(/_/g, "-") : null;
    const onSubRoles = new Set(
      onRoleRaw ? [...onRoleRaw.matchAll(subRoleRe)].map((m) => m[1].toLowerCase()) : []
    );
    const fgInverse = inverseSegRe.test(fgNormPath) || Boolean(onRoleRaw && /(?:^|-)invers(?:e|ed)(?:$|-)/.test(onRoleRaw));
    const fgHasDark = /(?:^|[._-])(?:dark|on[-_]?dark)(?:$|[._-])/.test(fgRolePath);
    const fgHasLight = /(?:^|[._-])(?:light|on[-_]?light)(?:$|[._-])/.test(fgRolePath);
    const mFlags = modeFlags.get(fg.mode) || {
      hasExplicitDark: false,
      hasExplicitLight: false,
      hasNonDarkBg: false,
      hasNonLightBg: false,
      hasDarkFg: false,
      hasLightFg: false,
      hasOnCard: false,
      hasOnPanel: false,
      compPaired: new Set(),
      dedicatedOnSpecs: [],
      roleHasNonSurfaceBg: new Set(),
    };
    for (const bg of resolvedColors) {
      if (fg.path === bg.path || isFgPath(bg.path) || fg.mode !== bg.mode) continue;
      if ((bg.alpha ?? 1) < 1) continue;
      if (primitiveNamespaceRe.test(bg.path)) continue;
      const bgNormPath = splitCamel(bg.path);
      if (isNonFillPath(bg.path)) continue;
      if (numericScaleStepRe.test(bgNormPath)) {
        const bgStepM = numericScaleStepRe.exec(bgNormPath);
        if (!onRoleRaw || !bgStepM || !onRoleRaw.includes(bgStepM[0].replace(/^[._-]+|[._-]+$/g, ""))) continue;
      }
      const bgRolePath = stripModePath(bg.path, bg.mode, bg.isInvariant);
      const bgComp = extractCompSlug(bgRolePath);
      if (fgComp && bgComp && fgComp !== bgComp) continue;
      if (fgComp && mFlags.compPaired.has(fgComp) && bgComp !== fgComp) continue;
      if (!fgComp && bgComp && mFlags.compPaired.has(bgComp)) continue;
      const bgInverse = inverseSegRe.test(bgNormPath);
      if (fgInverse !== bgInverse && onRoleRaw !== "inverse") continue;
      const bgHasDark = /(?:^|[._-])dark(?:$|[._-])/.test(bgRolePath);
      const bgHasLight = /(?:^|[._-])light(?:$|[._-])/.test(bgRolePath);
      const bgSubRoleSet = new Set([...bgRolePath.matchAll(subRoleRe)].map((m) => m[1].toLowerCase()));
      const hasDedicatedBgFg = () =>
        mFlags.dedicatedOnSpecs.some(
          (spec) =>
            !(spec.hasNonSurfaceMatch && bgRe.test(bgNormPath)) &&
            spec.roleRe.test(bgRolePath) &&
            sameStrSet(bgSubRoleSet, spec.subRoles)
        );
      if (onRoleRaw) {
        if (/^(?:surface|background|bg|canvas)$/.test(onRoleRaw)) {
          if (!bgRe.test(bgNormPath)) continue;
          if (mFlags.hasOnCard && /(?:^|[._-])card(?:$|[._-])/.test(bgRolePath)) continue;
          if (mFlags.hasOnPanel && /(?:^|[._-])panel(?:$|[._-])/.test(bgRolePath)) continue;
          if (hasDedicatedBgFg()) continue;
          if (bgHasDark && !fgHasDark && (mFlags.hasNonDarkBg || mFlags.hasDarkFg)) continue;
          if (bgHasLight && fgHasDark) continue;
          if (bgHasLight && !fgHasLight && bg.mode === "dark" && (mFlags.hasNonLightBg || mFlags.hasLightFg)) continue;
        } else if (onRoleRaw === "light" || onRoleRaw === "dark") {
          if (!bgRe.test(bgNormPath)) continue;
          if (
            onRoleRaw === "light" &&
            (bgHasDark ||
              (bg.mode === "dark" && !bgHasLight && !bg.isInvariant) ||
              ((bg.mode === "default" || bg.isInvariant) && mFlags.hasExplicitLight && !bgHasLight))
          ) {
            continue;
          }
          if (
            onRoleRaw === "dark" &&
            (bgHasLight || ((bg.mode !== "dark" || bg.isInvariant) && !bgHasDark))
          ) {
            continue;
          }
        } else {
          const escRole = onRoleRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[._-]");
          const roleRe = new RegExp(`(?:^|[._-])${escRole}(?:$|[._-])`, "i");
          if (!roleRe.test(bgRolePath)) continue;
          const bgSubRoles = [...bgRolePath.matchAll(subRoleRe)].map((m) => m[1].toLowerCase());
          if (bgSubRoles.some((sr) => !onSubRoles.has(sr))) continue;
          const roleKey = `${onRoleRaw}|${[...onSubRoles].sort().join(",")}`;
          if (!bgRe.test(onRoleRaw) && mFlags.roleHasNonSurfaceBg.has(roleKey) && bgRe.test(bgNormPath)) continue;
        }
      } else {
        if (!bgRe.test(bgNormPath)) continue;
        if (hasDedicatedBgFg()) continue;
        if (bgHasDark && !fgHasDark && (mFlags.hasNonDarkBg || mFlags.hasDarkFg)) continue;
        if (bgHasLight && fgHasDark) continue;
        if (bgHasLight && !fgHasLight && bg.mode === "dark" && (mFlags.hasNonLightBg || mFlags.hasLightFg)) continue;
        if (fgHasDark && mFlags.hasExplicitDark && !bgHasDark) continue;
        if (fgHasLight && mFlags.hasExplicitLight && !bgHasLight) continue;
      }
      const mCount = modeCounts.get(fg.mode) || 0;
      if (mCount >= 5000) continue;
      modeCounts.set(fg.mode, mCount + 1);
      const fgAlpha = fg.alpha ?? 1;
      const effFgRgb =
        fgAlpha >= 1
          ? fg.rgb
          : [
              Math.round(fg.rgb[0] * fgAlpha + bg.rgb[0] * (1 - fgAlpha)),
              Math.round(fg.rgb[1] * fgAlpha + bg.rgb[1] * (1 - fgAlpha)),
              Math.round(fg.rgb[2] * fgAlpha + bg.rgb[2] * (1 - fgAlpha)),
            ];
      const wcagRatio = Number(wcagContrast(effFgRgb, bg.rgb).toFixed(2));
      const apcaLc = apcaContrast(effFgRgb, bg.rgb);
      pairs.push({
        mode: fg.mode,
        fg: fg.path,
        bg: bg.path,
        wcagRatio,
        apcaLc,
        wcagPassAA: wcagRatio >= 4.5,
        apcaPassBody: Math.abs(apcaLc) >= 60,
      });
    }
  }

  const failingPairs = pairs.filter((p) => !p.wcagPassAA);
  const sortedForSample = [...failingPairs, ...pairs.filter((p) => p.wcagPassAA)];

  return {
    parity: {
      hasModes,
      lightCount: lightKeys.size,
      darkCount: darkKeys.size,
      missingInDark,
      missingInLight,
    },
    contrast: {
      pairsEvaluated: pairs.length,
      wcagFailures: failingPairs.length,
      apcaWarnings: pairs.filter((p) => !p.apcaPassBody).length,
      failingPairs,
      samplePairs: sortedForSample.slice(0, 12),
    },
  };
}

const HEX_COLOR_RE = /(?<=^|[:,\s("'=/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F_-])/g;

function findBalIdx(srcStr, openIdx, openCh, closeCh, maxLimit = srcStr.length) {
  let depth = 1;
  let q = null;
  let lastSig = openCh;
  const parenStack = [];
  const limit = Math.min(maxLimit, srcStr.length);
  for (let k = openIdx + 1; k < limit; k++) {
    const c = srcStr[k];
    if (q) {
      if (c === "\\" && k + 1 < limit) {
        k++;
        continue;
      }
      if (q === "`" && c === "$" && k + 1 < limit && srcStr[k + 1] === "{") {
        const se = findBalIdx(srcStr, k + 1, "{", "}", limit);
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
    const reEnd = skipJsRegexInExpr(srcStr, k, lastSig, openIdx + 1);
    if (reEnd !== -1 && reEnd <= limit) {
      k = reEnd - 1;
      lastSig = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else {
      if (c === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(srcStr.slice(Math.max(openIdx + 1, k - 16), k)));
      }
      if (c === openCh) {
        depth++;
      } else if (c === closeCh) {
        depth--;
        if (depth === 0) return k;
      }
      if (c === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
  }
  return -1;
}

function maskCssSelectorHeadersInRange(chars, src, start, end) {
  let headerStart = start;
  let quote = null;
  let interpSpans = [];
  const inInterp = (idx) => interpSpans.some(([s0, e0]) => idx >= s0 && idx <= e0);
  for (let i = start; i < end; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\" && i + 1 < end) {
        i++;
        continue;
      }
      if (ch === quote || ch === "\n") quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < end) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      if (i > start && (src[i - 1] === "#" || src[i - 1] === "$")) {
        const endI = findBalIdx(src, i, "{", "}", end);
        if (endI !== -1) {
          interpSpans.push([i - 1, endI]);
          i = endI;
          continue;
        }
      }
      const hdr = src.slice(headerStart, i);
      let hasOutsideHash = false;
      for (let k = headerStart; k < i; k++) {
        if (src[k] === "#" && !inInterp(k)) {
          hasOutsideHash = true;
          break;
        }
      }
      if (!/^[\s]*$/.test(hdr) && (hasOutsideHash || /^\s*@(?:supports|container)\b/i.test(hdr))) {
        for (let k = headerStart; k < i; k++) {
          if (chars[k] !== "\n" && !inInterp(k)) chars[k] = " ";
        }
      }
      headerStart = i + 1;
      interpSpans = [];
    } else if (ch === ";") {
      headerStart = i + 1;
      interpSpans = [];
    } else if (ch === "}") {
      headerStart = i + 1;
      interpSpans = [];
    }
  }
}

/**
 * Mask CSS selector headers (outside `{...}` / declarations), SVG/CSS `url(#id)`, and link `#fragment` URLs
 * so `#feed {` ID selectors, `url(#fade)`, and `href="#facade"` are never misread as hex colors.
 */
function maskCssTemplateStringsPreservingLines(src) {
  const s = String(src || "");
  const chars = s.split("");
  let quote = null;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        if (chars[i] !== "\n") chars[i] = " ";
        if (chars[i + 1] !== "\n") chars[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === "$" && s[i + 1] === "{") {
        const endE = findBalIdx(s, i + 1, "{", "}");
        if (endE !== -1) {
          maskRangePreservingLines(chars, i, endE + 1);
          i = endE + 1;
          continue;
        }
      }
      if (ch === quote || ch === "\n") {
        if (chars[i] !== "\n") chars[i] = " ";
        quote = null;
        i++;
        continue;
      }
      if (chars[i] !== "\n") chars[i] = " ";
      i++;
      continue;
    }
    if (ch === "$" && s[i + 1] === "{") {
      const endE = findBalIdx(s, i + 1, "{", "}");
      if (endE !== -1) {
        i = endE + 1;
        continue;
      }
    }
    if (ch === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      chars[i] = " ";
    }
    i++;
  }
  return chars.join("");
}

function maskNonColorHashContextsPreservingLines(src, isStyle, styleRanges = [], embeddedRanges = [], cssInJsRanges = [], markupOpts = null) {
  const chars = src.split("");
  for (const m of src.matchAll(/\burl\(\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^)]*)\)/gi)) {
    if (m[0].includes("#")) maskRangePreservingLines(chars, m.index, m.index + m[0].length);
  }
  if (isStyle) {
    maskCssSelectorHeadersInRange(chars, src, 0, src.length);
    return maskCssQuotedStringsPreservingLines(chars.join(""));
  } else {
    for (const r of embeddedRanges) {
      const maskedCss = maskCssQuotedStringsPreservingLines(chars.slice(r.start, r.end).join(""));
      for (let k = 0; k < maskedCss.length && r.start + k < r.end; k++) chars[r.start + k] = maskedCss[k];
    }
    for (const r of cssInJsRanges) {
      const maskedCss = maskCssTemplateStringsPreservingLines(chars.slice(r.start, r.end).join(""));
      for (let k = 0; k < maskedCss.length && r.start + k < r.end; k++) chars[r.start + k] = maskedCss[k];
    }
    for (const r of styleRanges) {
      maskCssSelectorHeadersInRange(chars, src, r.start, r.end);
    }
    for (const m of src.matchAll(/\b(?:href|to|src|action|xlink:href)\s*=\s*(?:\{\s*)?(["'`])[^"'`]*#[^"'`]*\1(?:\s*\})?/gi)) {
      maskRangePreservingLines(chars, m.index, m.index + m[0].length);
    }
    const merged = chars.join("");
    return markupOpts
      ? maskProseAndDocStringsPreservingLines(merged, {
          ...markupOpts,
          excludeSpans: [...embeddedRanges, ...cssInJsRanges].map((r) => [r.start, r.end]),
        })
      : merged;
  }
}

function extractAtThemeVars(cssText) {
  const vars = new Set();
  const cleaned = stripCommentsPreservingLines(cssText);
  const re = /@theme(?:\s+(?:inline|static|reference|default))*\s*\{/gi;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    let idx = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    const start = idx;
    while (idx < cleaned.length && depth > 0) {
      const ch = cleaned[idx];
      if (quote) {
        if (ch === "\\" && idx + 1 < cleaned.length) {
          idx += 2;
          continue;
        }
        if (ch === quote || ch === "\n") quote = null;
        idx++;
        continue;
      }
      if (ch === "\\" && idx + 1 < cleaned.length) {
        idx += 2;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      idx++;
    }
    const block = maskCssQuotedStringsPreservingLines(cleaned.slice(start, Math.max(start, idx - 1)));
    for (const m of block.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)\s*:(?!:)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) vars.add(name);
    }
  }
  return vars;
}

function extractStyleQueryVarsAndMaskPreludes(maskedCss, usedVars) {
  const s = String(maskedCss || "");
  const chars = s.split("");
  for (const m of s.matchAll(/@(container|supports)\b/gi)) {
    const kind = m[1].toLowerCase();
    let j = m.index + m[0].length;
    let pD = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === "(") pD++;
      else if (c === ")") pD = Math.max(0, pD - 1);
      else if ((c === "{" || c === ";") && pD === 0) break;
      j++;
    }
    if (kind === "container") {
      const prelude = s.slice(m.index, j);
      for (const sm of prelude.matchAll(/\bstyle\s*\(/gi)) {
        let p = sm.index + sm[0].length;
        let sd = 1;
        while (p < prelude.length && sd > 0) {
          if (prelude[p] === "(") sd++;
          else if (prelude[p] === ")") sd--;
          p++;
        }
        const styleInner = prelude.slice(sm.index + sm[0].length, Math.max(sm.index + sm[0].length, p - 1));
        for (const vm of styleInner.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)/g)) {
          const name = `--${vm[1]}`;
          if (!isFrameworkInternalVar(name)) usedVars.add(name);
        }
      }
    }
    maskRangePreservingLines(chars, m.index, j);
  }
  return chars.join("");
}

function findNearDuplicateHexClusters(hexSet) {
  const entries = [...hexSet]
    .map((h) => ({ hex: h, rgb: parseHexToRgb(h) }))
    .filter((e) => e.rgb);
  const visited = new Set();
  const clusters = [];
  for (let i = 0; i < entries.length; i++) {
    if (visited.has(entries[i].hex)) continue;
    const group = [entries[i].hex];
    visited.add(entries[i].hex);
    for (let j = i + 1; j < entries.length; j++) {
      if (visited.has(entries[j].hex)) continue;
      const [r1, g1, b1] = entries[i].rgb;
      const [r2, g2, b2] = entries[j].rgb;
      const dist = Math.hypot(r1 - r2, g1 - g2, b1 - b2);
      if (dist > 0 && dist < 18) {
        group.push(entries[j].hex);
        visited.add(entries[j].hex);
      }
    }
    if (group.length > 1) clusters.push(group.sort());
  }
  return clusters;
}

function isOffGridPxValue(n) {
  if (!Number.isFinite(n) || n <= 4 || n >= 200) return false;
  return n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14;
}

const stripCssVarNames = (v) => String(v || "").replace(/--[a-zA-Z0-9_-]+/g, "");

function extractSpacingValueBranches(rawExpr, { includeUnitlessPx = false } = {}) {
  const expr = String(rawExpr || "");
  const out = [];
  const findBalLocal = (s, openIdx, openCh, closeCh, limit) => {
    let d = 0;
    let q = null;
    let lastSig = openCh;
    const pStack = [];
    for (let k = openIdx; k < limit; k++) {
      const c = s[k];
      if (q) {
        if (c === "\\" && k + 1 < limit) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < limit && s[k + 1] === "{") {
          const se = findBalLocal(s, k + 1, "{", "}", limit);
          if (se === -1) return -1;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, k, lastSig, openIdx + 1);
      if (reEnd !== -1 && reEnd <= limit) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === openCh) {
        if (c === "(") pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(openIdx + 1, k - 16), k)));
        d++;
        lastSig = c;
      } else if (c === closeCh) {
        d--;
        if (d === 0) return k;
        lastSig = closeCh === ")" && pStack.length > 0 && pStack.pop() ? "control)" : closeCh;
      } else if (c === "(") {
        pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(openIdx + 1, k - 16), k)));
        lastSig = "(";
      } else if (c === ")") {
        lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
    }
    return -1;
  };
  const trimExpr = (l, r) => {
    while (true) {
      while (l < r && /\s/.test(expr[l])) l++;
      while (r > l && /\s/.test(expr[r - 1])) r--;
      const nextR = stripTrailingTsCastEnd(expr, l, r, findBalLocal);
      if (nextR !== r) {
        r = nextR;
        continue;
      }
      if (l < r && expr[l] === "(" && findBalLocal(expr, l, "(", ")", r) === r - 1) {
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
    const pStack = [];
    for (let k = bs; k < be; k++) {
      const c = expr[k];
      if (q) {
        if (c === "\\" && k + 1 < be) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < be && expr[k + 1] === "{") {
          const se = findBalLocal(expr, k + 1, "{", "}", be);
          if (se === -1) break;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(expr, k, lastSig, bs);
      if (reEnd !== -1 && reEnd <= be) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(bs, k - 16), k))); p++; lastSig = "("; }
      else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
      else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0) {
        if ((c === "=" && expr[k + 1] === "=") || (c === "!" && expr[k + 1] === "=")) return true;
        if ((c === "<" || c === ">") && !(c === ">" && k > bs && expr[k - 1] === "=")) return true;
        if (c === "i" && /^instanceof\b/.test(expr.slice(k, Math.min(be, k + 12))) && (k === bs || !/[A-Za-z0-9_$]/.test(expr[k - 1]))) return true;
        if (!/\s/.test(c)) lastSig = c;
      } else if (!/\s/.test(c)) lastSig = c;
    }
    return false;
  };
  const hasTopAnd = (bs, be) => {
    let p = 0, b = 0, br = 0, q = null, lastSig = "";
    const pStack = [];
    for (let k = bs; k < be; k++) {
      const c = expr[k];
      if (q) {
        if (c === "\\" && k + 1 < be) { k++; continue; }
        if (q === "`" && c === "$" && k + 1 < be && expr[k + 1] === "{") {
          const se = findBalLocal(expr, k + 1, "{", "}", be);
          if (se === -1) break;
          k = se;
          lastSig = "}";
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
        continue;
      }
      const reEnd = skipJsRegexInExpr(expr, k, lastSig, bs);
      if (reEnd !== -1 && reEnd <= be) { k = reEnd - 1; lastSig = "/"; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(bs, k - 16), k))); p++; lastSig = "("; }
      else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
      else if (c === "[") { b++; lastSig = c; }
      else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
      else if (c === "{") { br++; lastSig = c; }
      else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
      else if (p === 0 && b === 0 && br === 0 && c === "&" && expr[k + 1] === "&") return true;
      else if (!/\s/.test(c)) lastSig = c;
    }
    return false;
  };
  const visit = (start, end, inConcatOrTpl = false) => {
    const [l, r] = trimExpr(start, end);
    if (l >= r) return;
    {
      let p = 0, b = 0, br = 0, q = null, lastSig = "", arrowIdx = -1;
      const pStack = [];
      for (let k = l; k < r - 1; k++) {
        const c = expr[k];
        if (q) {
          if (c === "\\" && k + 1 < r) { k++; continue; }
          if (q === "`" && c === "$" && k + 1 < r && expr[k + 1] === "{") {
            const se = findBalLocal(expr, k + 1, "{", "}", r);
            if (se === -1) break;
            k = se;
            lastSig = "}";
            continue;
          }
          if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
          continue;
        }
        const reEnd = skipJsRegexInExpr(expr, k, lastSig, l);
        if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(l, k - 16), k))); p++; lastSig = "("; }
        else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
        else if (c === "[") { b++; lastSig = c; }
        else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
        else if (c === "{") { br++; lastSig = c; }
        else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
        else if (p === 0 && b === 0 && br === 0 && c === "=" && expr[k + 1] === ">") {
          arrowIdx = k;
          break;
        } else if (!/\s/.test(c)) {
          lastSig = c;
        }
      }
      if (arrowIdx !== -1) {
        const [bl, brEnd] = trimExpr(arrowIdx + 2, r);
        if (bl < brEnd && expr[bl] === "{" && findBalLocal(expr, bl, "{", "}", brEnd) === brEnd - 1) {
          let rp = 0, rb = 0, rbr = 0, rq = null, rLastSig = "";
          for (let rk = bl + 1; rk < brEnd - 1; rk++) {
            const rc = expr[rk];
            if (rq) {
              if (rc === "\\" && rk + 1 < brEnd) { rk++; continue; }
              if (rq === "`" && rc === "$" && rk + 1 < brEnd && expr[rk + 1] === "{") {
                const se = findBalLocal(expr, rk + 1, "{", "}", brEnd);
                if (se === -1) break;
                rk = se;
                continue;
              }
              if (rc === rq || (rq !== "`" && rc === "\n")) { rq = null; rLastSig = rc; }
              continue;
            }
            const reEnd = skipJsRegexInExpr(expr, rk, rLastSig, bl + 1);
            if (reEnd !== -1 && reEnd <= brEnd) { rk = reEnd - 1; rLastSig = "/"; continue; }
            if (rc === '"' || rc === "'" || rc === "`") rq = rc;
            else if (rc === "(") { rp++; rLastSig = rc; }
            else if (rc === ")") { rp = Math.max(0, rp - 1); rLastSig = rc; }
            else if (rc === "[") { rb++; rLastSig = rc; }
            else if (rc === "]") { rb = Math.max(0, rb - 1); rLastSig = rc; }
            else if (rc === "{") { rbr++; rLastSig = rc; }
            else if (rc === "}") { rbr = Math.max(0, rbr - 1); rLastSig = rc; }
            else if (
              rp === 0 &&
              rb === 0 &&
              rbr === 0 &&
              rc === "r" &&
              expr.startsWith("return", rk) &&
              (rk === bl + 1 || !/[A-Za-z0-9_$]/.test(expr[rk - 1])) &&
              !/[A-Za-z0-9_$]/.test(expr[rk + 6] || "")
            ) {
              const rExprStart = rk + 6;
              let rExprEnd = rExprStart;
              let ep = 0, eb = 0, ebr = 0, eq = null;
              while (rExprEnd < brEnd - 1) {
                const ec = expr[rExprEnd];
                if (eq) {
                  if (ec === "\\" && rExprEnd + 1 < brEnd) { rExprEnd += 2; continue; }
                  if (eq === "`" && ec === "$" && rExprEnd + 1 < brEnd && expr[rExprEnd + 1] === "{") {
                    const se = findBalLocal(expr, rExprEnd + 1, "{", "}", brEnd);
                    if (se === -1) break;
                    rExprEnd = se + 1;
                    continue;
                  }
                  if (ec === eq || (eq !== "`" && ec === "\n")) eq = null;
                  rExprEnd++;
                  continue;
                }
                if (ec === '"' || ec === "'" || ec === "`") eq = ec;
                else if (ec === "(") ep++;
                else if (ec === ")") { if (ep === 0) break; ep--; }
                else if (ec === "[") eb++;
                else if (ec === "]") { if (eb === 0) break; eb--; }
                else if (ec === "{") ebr++;
                else if (ec === "}") { if (ebr === 0) break; ebr--; }
                else if (ec === ";" && ep === 0 && eb === 0 && ebr === 0) break;
                rExprEnd++;
              }
              visit(rExprStart, rExprEnd, inConcatOrTpl);
              rk = rExprEnd;
              rLastSig = ";";
            } else if (!/\s/.test(rc)) rLastSig = rc;
          }
          return;
        }
        visit(bl, brEnd, inConcatOrTpl);
        return;
      }
    }
    let qPos = -1, colonPos = -1, tDepth = 0;
    {
      let p = 0, b = 0, br = 0, q = null, lastSig = "";
      const pStack = [];
      for (let k = l; k < r; k++) {
        const c = expr[k];
        if (q) {
          if (c === "\\" && k + 1 < r) { k++; continue; }
          if (q === "`" && c === "$" && k + 1 < r && expr[k + 1] === "{") {
            const se = findBalLocal(expr, k + 1, "{", "}", r);
            if (se === -1) break;
            k = se;
            lastSig = "}";
            continue;
          }
          if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
          continue;
        }
        const reEnd = skipJsRegexInExpr(expr, k, lastSig, l);
        if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(l, k - 16), k))); p++; lastSig = "("; }
        else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
        else if (c === "[") { b++; lastSig = c; }
        else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
        else if (c === "{") { br++; lastSig = c; }
        else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
        else if (p === 0 && b === 0 && br === 0) {
          if (c === "?" && expr[k + 1] !== "?" && expr[k + 1] !== ".") {
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
    }
    if (qPos !== -1 && colonPos !== -1) {
      visit(qPos + 1, colonPos, inConcatOrTpl);
      visit(colonPos + 1, r, inConcatOrTpl);
      return;
    }
    const orOps = [], andOps = [];
    {
      let p = 0, b = 0, br = 0, q = null, lastSig = "";
      const pStack = [];
      for (let k = l; k < r; k++) {
        const c = expr[k];
        if (q) {
          if (c === "\\" && k + 1 < r) { k++; continue; }
          if (q === "`" && c === "$" && k + 1 < r && expr[k + 1] === "{") {
            const se = findBalLocal(expr, k + 1, "{", "}", r);
            if (se === -1) break;
            k = se;
            lastSig = "}";
            continue;
          }
          if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
          continue;
        }
        const reEnd = skipJsRegexInExpr(expr, k, lastSig, l);
        if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(l, k - 16), k))); p++; lastSig = "("; }
        else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
        else if (c === "[") { b++; lastSig = c; }
        else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
        else if (c === "{") { br++; lastSig = c; }
        else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
        else if (p === 0 && b === 0 && br === 0) {
          if ((c === "|" && expr[k + 1] === "|") || (c === "?" && expr[k + 1] === "?")) {
            orOps.push([k, k + 2]);
            lastSig = c;
            k++;
          } else if (c === "&" && expr[k + 1] === "&") {
            andOps.push([k, k + 2]);
            lastSig = c;
            k++;
          } else if (!/\s/.test(c)) lastSig = c;
        } else if (!/\s/.test(c)) lastSig = c;
      }
    }
    if (orOps.length > 0) {
      let cur = l;
      for (const [os, oe] of orOps) {
        if (!hasTopComp(cur, os) || hasTopAnd(cur, os)) visit(cur, os, inConcatOrTpl);
        cur = oe;
      }
      if (!hasTopComp(cur, r) || hasTopAnd(cur, r)) visit(cur, r, inConcatOrTpl);
      return;
    }
    if (andOps.length > 0) {
      visit(andOps[andOps.length - 1][1], r, inConcatOrTpl);
      return;
    }
    const plusParts = [];
    {
      let p = 0, b = 0, br = 0, q = null, partStart = l, lastSig = "";
      const pStack = [];
      for (let k = l; k < r; k++) {
        const c = expr[k];
        if (q) {
          if (c === "\\" && k + 1 < r) { k++; continue; }
          if (q === "`" && c === "$" && k + 1 < r && expr[k + 1] === "{") {
            const se = findBalLocal(expr, k + 1, "{", "}", r);
            if (se === -1) break;
            k = se;
            lastSig = "}";
            continue;
          }
          if (c === q || (q !== "`" && c === "\n")) { q = null; lastSig = c; }
          continue;
        }
        const reEnd = skipJsRegexInExpr(expr, k, lastSig, l);
        if (reEnd !== -1 && reEnd <= r) { k = reEnd - 1; lastSig = "/"; continue; }
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (c === "(") { pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(expr.slice(Math.max(l, k - 16), k))); p++; lastSig = "("; }
        else if (c === ")") { p = Math.max(0, p - 1); lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")"; }
        else if (c === "[") { b++; lastSig = c; }
        else if (c === "]") { b = Math.max(0, b - 1); lastSig = c; }
        else if (c === "{") { br++; lastSig = c; }
        else if (c === "}") { br = Math.max(0, br - 1); lastSig = c; }
        else if (p === 0 && b === 0 && br === 0 && c === "+" && expr[k + 1] !== "+" && expr[k - 1] !== "+") {
          plusParts.push([partStart, k]);
          partStart = k + 1;
          lastSig = c;
        } else if (!/\s/.test(c)) lastSig = c;
      }
      if (plusParts.length > 0) plusParts.push([partStart, r]);
    }
    if (plusParts.length > 1) {
      for (const [ps, pe] of plusParts) visit(ps, pe, true);
      return;
    }
    const slice = expr.slice(l, r);
    if (slice.startsWith("`") && slice.endsWith("`")) {
      let tk = l + 1;
      let tStart = tk;
      while (tk < r - 1) {
        if (expr[tk] === "\\" && tk + 1 < r - 1) {
          tk += 2;
          continue;
        }
        if (expr[tk] === "$" && expr[tk + 1] === "{") {
          const se = findBalLocal(expr, tk + 1, "{", "}", r - 1);
          if (se !== -1) {
            if (tk > tStart) out.push(expr.slice(tStart, tk));
            const beforeLen = out.length;
            visit(tk + 2, se, true);
            if (/^px\b/i.test(expr.slice(se + 1, r - 1))) {
              for (let oi = beforeLen; oi < out.length; oi++) {
                out[oi] = attachPxToBareNumbers(out[oi]);
              }
            }
            tk = se + 1;
            tStart = tk;
            continue;
          }
        }
        tk++;
      }
      if (tStart < r - 1) out.push(expr.slice(tStart, r - 1));
      return;
    }
    if (!hasTopComp(l, r)) {
      const trimmedSlice = slice.trim();
      if (includeUnitlessPx && !inConcatOrTpl && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmedSlice)) {
        out.push(`${Math.abs(Number.parseFloat(trimmedSlice))}px`);
      } else {
        out.push(slice);
      }
    }
  };
  visit(0, expr.length);
  return out.join(" ");
}

function attachPxToBareNumbers(str) {
  return String(str || "").replace(/(?<![a-zA-Z0-9_.#$:-])['"]?(\d+(?:\.\d+)?)(?!\d|\.)['"]?(?=$|[\s,)'"])/g, "$1px");
}

function extractHtmlStyleValForSpacing(valStr) {
  const v = String(valStr || "");
  if (!v.includes("{")) return v;
  const parts = [];
  let i = 0;
  let segStart = 0;
  while (i < v.length) {
    if (v[i] === "{") {
      const endB = findBalIdx(v, i, "{", "}");
      if (endB !== -1) {
        if (i > segStart) parts.push(v.slice(segStart, i));
        const exprBranches = extractSpacingValueBranches(v.slice(i + 1, endB));
        parts.push(/^px\b/i.test(v.slice(endB + 1)) ? attachPxToBareNumbers(exprBranches) : exprBranches);
        i = endB + 1;
        segStart = i;
        continue;
      }
    }
    i++;
  }
  if (segStart < v.length) parts.push(v.slice(segStart));
  return parts.join(" ");
}

function blankJsCustomPropEntriesPreservingLines(src, scanOptions = null, markupCtx = null) {
  const s = String(src || "");
  const chars = s.split("");
  const outerStrSpans = computeMarkupJsOuterStringSpans(s, scanOptions, markupCtx);
  const isInsideOuterString = (idx) => outerStrSpans.some(([s0, e0]) => idx > s0 && idx < e0);
  for (const m of s.matchAll(/["']--[a-zA-Z0-9_-]+["']\s*:/g)) {
    if (isInsideOuterString(m.index) || !isValidJsObjKeyPos(s, m.index)) continue;
    let j = m.index + m[0].length;
    let pD = 0;
    let bD = 0;
    let brD = 0;
    let q = null;
    let lastSig = ":";
    const pStack = [];
    while (j < s.length) {
      const c = s[j];
      if (q) {
        if (c === "\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (q === "`" && c === "$" && j + 1 < s.length && s[j + 1] === "{") {
          const se = findBalIdx(s, j + 1, "{", "}");
          if (se !== -1) {
            j = se + 1;
            lastSig = "}";
            continue;
          }
        }
        if (c === q || (q !== "`" && c === "\n")) {
          q = null;
          lastSig = c;
        }
        j++;
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, j, lastSig, m.index + m[0].length);
      if (reEnd !== -1) {
        j = reEnd;
        lastSig = "/";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") {
        pStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(m.index + m[0].length, j - 16), j)));
        pD++;
        lastSig = "(";
      } else if (c === ")") {
        if (pD === 0 && bD === 0 && brD === 0) break;
        pD--;
        lastSig = pStack.length > 0 && pStack.pop() ? "control)" : ")";
      } else if (c === "[") {
        bD++;
        lastSig = "[";
      } else if (c === "]") {
        if (bD === 0 && pD === 0 && brD === 0) break;
        bD--;
        lastSig = "]";
      } else if (c === "{") {
        brD++;
        lastSig = "{";
      } else if (c === "}") {
        if (brD === 0 && pD === 0 && bD === 0) break;
        brD--;
        lastSig = "}";
      } else if ((c === "," || c === ";") && pD === 0 && bD === 0 && brD === 0) {
        break;
      } else if (c === "\n" && pD === 0 && bD === 0 && brD === 0) {
        let la = j + 1;
        while (la < s.length && /[ \t\r\n]/.test(s[la])) la++;
        const nextSlice = s.slice(la, la + 2);
        const beforeNl = s.slice(m.index + m[0].length, j).trimEnd();
        const prevEndsCont =
          beforeNl.length > 0 &&
          (/(?:&&|\|\||\?\?)$/.test(beforeNl) || (/[?:+]$/.test(beforeNl) && !/\+\+$/.test(beforeNl)));
        if (!prevEndsCont && (!/^(?:\?\.|&&|\|\||\?\?|[?:+])/.test(nextSlice) || nextSlice === "?.")) break;
      } else if (!/\s/.test(c)) {
        lastSig = c;
      }
      j++;
    }
    maskRangePreservingLines(chars, m.index, j);
  }
  return chars.join("");
}

function extractCssInJsTemplateRanges(src, markupCtx = null) {
  const s = String(src || "");
  const ranges = [];
  const inSpans = (idx, spans) => Array.isArray(spans) && spans.some(([a, b]) => idx >= a && idx < b);
  const inAttrVal = (idx) =>
    Boolean(markupCtx?.openTags?.some((tag) => idx > tag.start && idx < tag.end && tag.attrValueSpans.some(([as, ae]) => idx >= as && idx < ae)));
  const skipGen = (curStart) => {
    let cur = curStart;
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    if (s[cur] !== "<") return cur;
    let ang = 1;
    let brace = 0;
    let q = null;
    cur++;
    const limit = Math.min(s.length, cur + 800);
    while (cur < limit && ang > 0) {
      const c = s[cur];
      if (q) {
        if (c === "\\" && cur + 1 < limit) { cur += 2; continue; }
        if (c === q || (q !== "`" && c === "\n")) q = null;
      } else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") brace++;
      else if (c === "}") brace = Math.max(0, brace - 1);
      else if (c === "<" && brace === 0) ang++;
      else if (c === ">" && s[cur - 1] !== "=" && brace === 0) ang--;
      cur++;
    }
    if (ang !== 0) return curStart;
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    return cur;
  };
  for (const m of s.matchAll(/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b|\bkeyframes\b)\s*/g)) {
    if (markupCtx && (inSpans(m.index, markupCtx.proseSpans) || inSpans(m.index, markupCtx.jsStringSpans) || inAttrVal(m.index))) {
      continue;
    }
    let cur = m.index + m[0].length;
    if (/^styled(?:\s|$)/.test(m[0]) && s[cur] === "(") {
      const endP = findBalIdx(s, cur, "(", ")");
      if (endP === -1) continue;
      cur = endP + 1;
      while (cur < s.length && /\s/.test(s[cur])) cur++;
    }
    while (cur < s.length) {
      const cm = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(s.slice(cur, cur + 64));
      if (!cm) break;
      cur = skipGen(cur + cm[0].length);
      if (s[cur] === "(") {
        const endC = findBalIdx(s, cur, "(", ")");
        if (endC === -1) { cur = -1; break; }
        cur = endC + 1;
        while (cur < s.length && /\s/.test(s[cur])) cur++;
      }
    }
    if (cur === -1) continue;
    cur = skipGen(cur);
    if (s[cur] !== "`") continue;
    let k = cur + 1;
    let qEsc = false;
    while (k < s.length) {
      const c = s[k];
      if (qEsc) { qEsc = false; k++; continue; }
      if (c === "\\") { qEsc = true; k++; continue; }
      if (c === "$" && s[k + 1] === "{") {
        const endE = findBalIdx(s, k + 1, "{", "}");
        if (endE === -1) break;
        k = endE + 1;
        continue;
      }
      if (c === "`") {
        ranges.push({ start: cur + 1, end: k });
        break;
      }
      k++;
    }
  }
  return ranges;
}

function extractJsStyleSpacingEntries(src, baseOffset = 0) {
  const sStr = String(src || "");
  const innerStrSpans = [];
  {
    let si = 0;
    let lastSigS = "";
    const pStackS = [];
    const scanStrRanges = (startIdx, endIdx) => {
      let k = startIdx;
      let ls = lastSigS;
      while (k < endIdx) {
        const ch = sStr[k];
        const reEnd = skipJsRegexInExpr(sStr, k, ls, startIdx);
        if (reEnd !== -1 && reEnd <= endIdx) { k = reEnd; ls = "/"; continue; }
        if (ch === '"' || ch === "'" || (ch === "`")) {
          if (ch === "`") {
            let tk = k + 1;
            let segS = tk;
            while (tk < endIdx) {
              if (sStr[tk] === "\\" && tk + 1 < endIdx) { tk += 2; continue; }
              if (sStr[tk] === "$" && tk + 1 < endIdx && sStr[tk + 1] === "{") {
                if (tk > segS) innerStrSpans.push([segS - 1, tk]);
                const endE = findBalIdx(sStr, tk + 1, "{", "}");
                if (endE === -1 || endE >= endIdx) { segS = endIdx; tk = endIdx; break; }
                scanStrRanges(tk + 2, endE);
                tk = endE + 1;
                segS = tk;
                continue;
              }
              if (sStr[tk] === "`") {
                if (tk > segS) innerStrSpans.push([segS - 1, tk + 1]);
                tk++;
                break;
              }
              tk++;
            }
            k = tk;
            ls = "`";
            continue;
          }
          let qEnd = k + 1;
          while (qEnd < endIdx) {
            if (sStr[qEnd] === "\\" && qEnd + 1 < endIdx) { qEnd += 2; continue; }
            if (sStr[qEnd] === ch || sStr[qEnd] === "\n") {
              if (sStr[qEnd] === ch) qEnd++;
              break;
            }
            qEnd++;
          }
          innerStrSpans.push([k, qEnd]);
          k = qEnd;
          ls = ch;
          continue;
        }
        if (ch === "(") {
          pStackS.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(sStr.slice(Math.max(startIdx, k - 16), k)));
          ls = "(";
        } else if (ch === ")") {
          ls = pStackS.length > 0 && pStackS.pop() ? "control)" : ")";
        } else if (!/\s/.test(ch)) {
          ls = ch;
        }
        k++;
      }
    };
    scanStrRanges(si, sStr.length);
  }
  const inInnerStrLiteral = (idx) => innerStrSpans.some(([a, b]) => idx > a && idx < b);
  const entries = [];
  const propRe = new RegExp(
    `(?:(['"])${SPACING_RADIUS_JS_PROP_NAMES}\\1|(?<![a-zA-Z0-9_$-])${SPACING_RADIUS_JS_PROP_NAMES})\\s*:`,
    "g"
  );
  for (const m of sStr.matchAll(propRe)) {
    if (inInnerStrLiteral(m.index)) continue;
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const valStart = i;
    let pDepth = 0;
    let bDepth = 0;
    let kDepth = 0;
    let quote = null;
    let lastSig = ":";
    const parenStack = [];
    while (i < src.length) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\" && i + 1 < src.length) {
          i += 2;
          continue;
        }
        if (quote === "`" && ch === "$" && i + 1 < src.length && src[i + 1] === "{") {
          const se = findBalIdx(src, i + 1, "{", "}");
          if (se !== -1) {
            i = se + 1;
            lastSig = "}";
            continue;
          }
        }
        if (ch === quote || (quote !== "`" && ch === "\n")) {
          quote = null;
          lastSig = ch;
        }
        i++;
        continue;
      }
      const reEnd = skipJsRegexInExpr(src, i, lastSig, valStart);
      if (reEnd !== -1) {
        i = reEnd;
        lastSig = "/";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        let p = i - 1;
        while (p >= valStart && /[ \t\r\n]/.test(src[p])) p--;
        const isExprStartQuote = p < valStart || /[=([,:+?{&|!]/.test(src[p]);
        if (!isExprStartQuote) break;
        quote = ch;
      } else if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(src.slice(Math.max(valStart, i - 16), i)));
        pDepth++;
        lastSig = "(";
      } else if (ch === ")") {
        if (pDepth === 0) break;
        pDepth--;
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (ch === "[") {
        bDepth++;
        lastSig = "[";
      } else if (ch === "]") {
        if (bDepth === 0) break;
        bDepth--;
        lastSig = "]";
      } else if (ch === "{") {
        kDepth++;
        lastSig = "{";
      } else if (ch === "}") {
        if (kDepth === 0) break;
        kDepth--;
        lastSig = "}";
      } else if ((ch === "," || ch === ";") && pDepth === 0 && bDepth === 0 && kDepth === 0) {
        break;
      } else if (ch === "\n" && pDepth === 0 && bDepth === 0 && kDepth === 0) {
        let la = i + 1;
        while (la < src.length && /[ \t\r\n]/.test(src[la])) la++;
        const nextSlice = src.slice(la, la + 2);
        const beforeNl = src.slice(valStart, i).trimEnd();
        const prevEndsCont =
          beforeNl.length > 0 &&
          (/(?:&&|\|\||\?\?)$/.test(beforeNl) || (/[?:+]$/.test(beforeNl) && !/\+\+$/.test(beforeNl)));
        if (!prevEndsCont && (!/^(?:\?\.|&&|\|\||\?\?|[?:+])/.test(nextSlice) || nextSlice === "?.")) {
          break;
        }
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      i++;
    }
    const rawExpr = src.slice(valStart, i);
    const cleanedExpr = stripCssVarNames(extractSpacingValueBranches(rawExpr, { includeUnitlessPx: true }));
    if (cleanedExpr.trim()) {
      entries.push({ index: baseOffset + m.index, val: cleanedExpr });
    }
  }
  return entries;
}

function splitCssStyleDecls(attrText) {
  const decls = [];
  const s = String(attrText || "");
  let start = 0;
  let bDepth = 0;
  let kDepth = 0;
  let quote = null;
  let lastExprSig = "";
  const exprParenStack = [];
  for (let i = 0; i <= s.length; i++) {
    const ch = i < s.length ? s[i] : ";";
    if (i < s.length && quote) {
      if (ch === "\\" && i + 1 < s.length) i++;
      else if (quote === "`" && ch === "$" && i + 1 < s.length && s[i + 1] === "{") {
        const se = findBalIdx(s, i + 1, "{", "}");
        if (se !== -1) {
          i = se;
          lastExprSig = "}";
        }
      } else if (ch === quote) {
        quote = null;
        lastExprSig = ch;
      }
      continue;
    }
    if (i < s.length && kDepth > 0) {
      const reEnd = skipJsRegexInExpr(s, i, lastExprSig, start);
      if (reEnd !== -1) {
        i = reEnd - 1;
        lastExprSig = "/";
        continue;
      }
    }
    if (i < s.length && (ch === '"' || ch === "'" || ch === "`")) {
      quote = ch;
    } else if (i < s.length && ch === "(") {
      if (kDepth > 0) exprParenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(start, i - 16), i)));
      bDepth++;
      lastExprSig = "(";
    } else if (i < s.length && ch === ")") {
      bDepth = Math.max(0, bDepth - 1);
      lastExprSig = kDepth > 0 && exprParenStack.length > 0 && exprParenStack.pop() ? "control)" : ")";
    } else if (i < s.length && ch === "{") {
      kDepth++;
      lastExprSig = "{";
    } else if (i < s.length && ch === "}") {
      kDepth = Math.max(0, kDepth - 1);
      lastExprSig = "}";
    } else if (ch === ";" && bDepth === 0 && kDepth === 0) {
      const seg = s.slice(start, i);
      const colon = seg.indexOf(":");
      if (colon !== -1) {
        decls.push({ prop: seg.slice(0, colon).trim(), val: seg.slice(colon + 1), offset: start });
      }
      start = i + 1;
      lastExprSig = "";
    } else if (i < s.length && !/\s/.test(ch)) {
      lastExprSig = ch;
    }
  }
  return decls;
}

const _lowerTokenPathSetCache = new WeakMap();
function getLowerTokenPathSet(byPath) {
  let cached = _lowerTokenPathSetCache.get(byPath);
  if (!cached) {
    cached = new Set([...byPath.keys()].map((k) => k.toLowerCase()));
    _lowerTokenPathSetCache.set(byPath, cached);
  }
  return cached;
}
const NON_THEME_DTCG_LEAF_TYPES = new Set(["fontweight", "fontfamily", "duration", "cubicbezier"]);

function countOffGridSpacing(text, isStyleFile) {
  let hits = 0;
  const scanValue = (valStr) => {
    for (const m of stripCssVarNames(valStr).matchAll(PX_VALUE_RE)) {
      const n = Number.parseFloat(m[1]);
      if (isOffGridPxValue(n)) hits++;
    }
  };
  if (isStyleFile) {
    for (const m of maskCssQuotedStringsPreservingLines(text).matchAll(/(?<![a-zA-Z0-9_$:-])([a-zA-Z-]+)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/g)) {
      if (SPACING_RADIUS_CSS_PROP_RE.test(m[1])) scanValue(m[2]);
    }
  } else {
    for (const sd of findSvelteStyleDirectives(text)) {
      if (!sd.isCustomProp && SPACING_RADIUS_CSS_PROP_RE.test(sd.prop)) {
        scanValue(sd.isExpr ? extractSpacingValueBranches(sd.value) : sd.value);
      }
    }
    for (const m of text.matchAll(/(?<![a-zA-Z0-9_-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      if (m.index > 0 && text[m.index - 1] === ":") continue;
      for (const d of splitCssStyleDecls(m[1] ?? m[2] ?? "")) {
        if (SPACING_RADIUS_CSS_PROP_RE.test(d.prop)) scanValue(extractHtmlStyleValForSpacing(d.val));
      }
    }
    for (const e of extractJsStyleSpacingEntries(text)) {
      scanValue(e.val);
    }
  }
  return hits;
}

function stripSvgColorBlocksPreservingLines(src, markupOpts = null, markupCtx = null) {
  let hits = 0;
  const blank = (seg) => {
    hits += (seg.match(HEX_COLOR_RE) || []).length;
    hits += findHardcodedColorFunctions(seg).filter((m) => !isTokenizedColorFn(m.text)).length;
    return seg.replace(/[^\n]/g, " ");
  };
  const opts = markupOpts || {};
  const ctx = markupCtx || scanMarkupContexts(src, opts);
  const inJsStr = (idx) => ctx.jsStringSpans.some(([a, b]) => idx >= a && idx < b);
  const initChars = src.split("");
  for (const r of findSvgBlockRanges(src, { ...opts, markupCtx: ctx })) {
    blank(src.slice(r.start, r.end));
    maskRangePreservingLines(initChars, r.start, r.end);
  }
  let masked = initChars.join("");
  const chars = masked.split("");
  const tagRe = /<(?:path|circle|rect|line|polygon|polyline|ellipse|defs|linearGradient|stop)(?=\s|\/?>)/gi;
  for (const m of masked.matchAll(tagRe)) {
    if (inJsStr(m.index)) continue;
    let i = m.index + m[0].length;
    let quote = null;
    let brace = 0;
    while (i < masked.length) {
      const ch = masked[i];
      if (quote) {
        if (ch === "\\" && i + 1 < masked.length) i += 2;
        else {
          if (ch === quote) quote = null;
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") {
        const endB = findBalIdx(masked, i, "{", "}");
        if (endB !== -1) {
          i = endB + 1;
          continue;
        }
        brace++;
      } else if (ch === "}") brace = Math.max(0, brace - 1);
      else if (ch === ">" && brace === 0) {
        const fullTag = masked.slice(m.index, i + 1);
        const rep = blank(fullTag);
        for (let k = 0; k < rep.length; k++) chars[m.index + k] = rep[k];
        break;
      }
      i++;
    }
  }
  return { masked: chars.join(""), hits };
}

function stripSwatchTablesPreservingLines(src) {
  let hits = 0;
  const chars = src.split("");
  const declRe =
    /\b(?:const|let|var)\s+[A-Za-z0-9_]*(?:SWATCH|PALETTE|THEME_COLOR|PRESET_COLOR|COLOR_MAP|COLOR_PRESET|BRAND_PALETTE)[A-Za-z0-9_]*\s*(?::[^=;\n]+)?=\s*(?=[[{])/gi;
  for (const m of src.matchAll(declRe)) {
    let idx = m.index + m[0].length;
    const open = src[idx];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let quote = null;
    while (idx < src.length) {
      const ch = src[idx];
      if (quote) {
        if (ch === "\\" && idx + 1 < src.length) idx += 2;
        else {
          if (ch === quote) quote = null;
          idx++;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          idx++;
          break;
        }
      }
      idx++;
    }
    const seg = src.slice(m.index, idx);
    hits += (seg.match(HEX_COLOR_RE) || []).length;
    hits += findHardcodedColorFunctions(seg).filter((f) => !isTokenizedColorFn(f.text)).length;
    maskRangePreservingLines(chars, m.index, idx);
  }
  return { masked: chars.join(""), hits };
}

export function scanTarget(targetPath, options = {}) {
  const cleanScope = options.scope ? String(options.scope).trim() : "";
  const baseTarget = cleanScope ? resolve(resolve(targetPath), cleanScope) : resolve(targetPath);
  const resolved = resolve(baseTarget);
  if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  const st = statSync(resolved);

  const tokenJsonFiles = [];
  const codeFiles = [];
  const demoFilesSkipped = [];

  if (st.isFile()) {
    if (resolved.toLowerCase().endsWith(".json")) tokenJsonFiles.push(resolved);
    else if (CODE_EXTS.has(extname(resolved).toLowerCase())) codeFiles.push(resolved);
  } else {
    const ciFs = process.platform === "darwin" || process.platform === "win32";
    const safeReal = (p) => {
      try {
        return (realpathSync.native || realpathSync)(p);
      } catch {
        return null;
      }
    };
    const rootReal = safeReal(resolved) || resolved;
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
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
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
          if (!entry.name.startsWith(".")) walk(full);
          continue;
        }
        if (!isFile) continue;
        const rel = relative(resolved, full).replace(/\\/g, "/");
        if (
          /(\.test\.|\.spec\.|__tests__\/|(^|\/)(?:tests?|fixtures|__fixtures__|_audit|_vendor|storybook-static|src-tauri\/target)\/|\.min\.(css|js)$|\.bundle\.(css|js|mjs)$|(^|\/)(public\/assets|static\/chunks|vendor|ios\/App\/App\/public|android\/app\/src\/main\/assets\/public)\/)/i.test(
            rel
          )
        ) {
          continue;
        }
        if (!options.includeDemos && /(^|\/)(?:demos?|demo\d+|examples?|samples?|docs\/status)\//i.test(rel)) {
          demoFilesSkipped.push(rel);
          continue;
        }
        const lower = entry.name.toLowerCase();
        const isAuthTokenJson =
          /(?:^|[._-])(?:auth|csrf|jwt|oauth|oa|session|refresh|access|api|secret|bearer|snooze|reset|verify|invite)(?:$|[._-])/.test(lower) ||
          /(?:^|[/_.-])(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer|snooze|reset|verify|invite)[/_.-]?tokens?(?:[._-][^/]*)?\.json$/i.test(
            rel
          ) ||
          /(?:^|\/)(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer)\/.+\.json$/i.test(rel);
        if (
          lower.endsWith(".json") &&
          (/\.tokens\.json$/.test(lower) ||
            /(?:^|[._-])tokens?(?:[._-][^/]*)?\.json$/.test(lower) ||
            /(^|\/)(?:tokens|design-tokens)\/(?:.+\/)?[^/]+\.json$/i.test(rel)) &&
          !isAuthTokenJson &&
          !/(?:^|\/)(?:package|tsconfig[^/]*|.*schema.*|meta)\.json$/i.test(lower)
        ) {
          try {
            const rawJsonText = readFileSync(full, "utf8");
            if (hasDesignTokenEvidence(rawJsonText).valid) tokenJsonFiles.push(full);
          } catch {}
        } else if (CODE_EXTS.has(extname(lower))) {
          codeFiles.push(full);
        }
      }
    }
    walk(resolved);
  }

  // 1. Validate W3C DTCG files (preserving mode from split light.json / dark.json filenames and resolving cross-file $extends)
  const hasExtendsDirective = (node) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return false;
    if (typeof node.$extends === "string") return true;
    return Object.entries(node).some(([k, v]) => !k.startsWith("$") && v && typeof v === "object" && !Array.isArray(v) && hasExtendsDirective(v));
  };
  const parsedTokenFiles = [];
  const modeLocalPaths = { light: new Set(), dark: new Set() };
  const leafOriginByPath = new Map();
  const groupOriginByPath = new Map();
  const extendsOriginByGroup = new Map();
  const combinedTree = {};
  for (const tf of tokenJsonFiles.sort()) {
    try {
      const json = JSON.parse(readFileSync(tf, "utf8"));
      if (!json || typeof json !== "object" || Array.isArray(json)) continue;
      const flat = flattenTokensFromExpanded(json, []);
      if (flat.length === 0 && !hasExtendsDirective(json)) continue;
      const relTf = (st.isDirectory() ? relative(resolved, tf) : tf).replace(/\\/g, "/");
      const modeTarget = st.isDirectory() ? relTf : basename(tf);
      const hasLightSeg = /(?:^|[/_.-])light(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
      const hasDarkSeg = /(?:^|[/_.-])dark(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
      const hasLeadingRootMode = Object.keys(json).some((k) => /^(light|dark)$/i.test(k));
      const hasInternalModes =
        hasLeadingRootMode ||
        flat.some((tok) => {
          const extModes = getTokenExtModes(tok);
          return (
            /^(light|dark)$/i.test(tok.path.split(".")[0] || "") ||
            Boolean(extModes && Object.keys(extModes).some((mk) => /^(light|dark)$/i.test(mk)))
          );
        });
      const fileMode = hasLightSeg && hasDarkSeg ? null : hasInternalModes ? null : hasLightSeg ? "light" : hasDarkSeg ? "dark" : null;
      if (fileMode) {
        for (const tok of flat) {
          const segs = tok.path.split(".");
          const hasLeadingMode = /^(light|dark)$/i.test(segs[0] || "");
          const hasExtMode = Boolean(getTokenExtModes(tok));
          if (!hasLeadingMode && !hasExtMode) {
            modeLocalPaths[fileMode].add(tok.path);
          }
        }
      }
      const preparedJson = prepareFileTreeForMerge(json);
      const prefixedRoot = fileMode ? { [fileMode]: preparedJson } : preparedJson;
      const originInfo = { relTf, fileMode };
      const recordOrigins = (node, pathSegs = []) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const pStr = pathSegs.join(".");
        if (pStr && typeof node.$extends === "string" && !extendsOriginByGroup.has(pStr)) {
          extendsOriginByGroup.set(pStr, originInfo);
        }
        if (pStr && !groupOriginByPath.has(pStr)) {
          groupOriginByPath.set(pStr, originInfo);
        }
        if (pStr && isTokenLeafObject(node)) {
          if (!leafOriginByPath.has(pStr)) leafOriginByPath.set(pStr, originInfo);
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === "$root" && v && typeof v === "object" && !Array.isArray(v)) {
            if (pStr && !leafOriginByPath.has(pStr)) leafOriginByPath.set(pStr, originInfo);
            continue;
          }
          if (k.startsWith("$")) continue;
          if ((k === "type" || k === "description") && (v == null || typeof v !== "object")) continue;
          if (v && typeof v === "object" && !Array.isArray(v)) {
            recordOrigins(v, [...pathSegs, k]);
          }
        }
      };
      recordOrigins(prefixedRoot, []);
      mergeRawDtcgTrees(combinedTree, prefixedRoot);
      parsedTokenFiles.push({ relTf, fileMode, rawCount: flat.length });
    } catch (err) {
      if (st.isFile()) {
        throw new Error(`Invalid JSON in token file ${tf}: ${err.message}`);
      }
    }
  }

  const rewriteRefStr = (ref, fm, localSet) => {
    if (typeof ref !== "string") return ref;
    if (ref.startsWith("#/")) {
      const segs = ref.slice(2).split("/").filter(Boolean).map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
      for (let i = segs.length; i > 0; i--) {
        if (i < segs.length && segs[i] !== "$value") continue;
        const cand = segs.slice(0, i).filter((seg) => seg !== "$root").join(".");
        if (localSet.has(cand)) return `#/${fm}/${ref.slice(2)}`;
      }
      return ref;
    }
    const cleanRef = ref.replace(/\.\$root$/i, "");
    return localSet.has(ref) || localSet.has(cleanRef) ? `${fm}.${ref}` : ref;
  };
  const rewriteValRefs = (val, fm, localSet) => {
    if (typeof val === "string") {
      const m = val.trim().match(/^\{([^}]+)\}$/);
      if (m) {
        const inner = m[1].trim();
        const cleanInner = inner.replace(/\.\$root$/i, "");
        if (localSet.has(inner) || localSet.has(cleanInner)) return `{${fm}.${inner}}`;
      } else if (/\{([^{}\s:;,"'()]+)\}/.test(val)) {
        return val.replace(/\{([^{}\s:;,"'()]+)\}/g, (full, rawInner) => {
          const inner = rawInner.trim();
          const cleanInner = inner.replace(/\.\$root$/i, "");
          return localSet.has(inner) || localSet.has(cleanInner) ? `{${fm}.${inner}}` : full;
        });
      }
      return val;
    }
    if (Array.isArray(val)) return val.map((x) => rewriteValRefs(x, fm, localSet));
    if (val && typeof val === "object") {
      const outObj = {};
      for (const [k, v] of Object.entries(val)) {
        outObj[k] = k === "$ref" ? rewriteRefStr(v, fm, localSet) : rewriteValRefs(v, fm, localSet);
      }
      return outObj;
    }
    return val;
  };

  const findTokenOrigin = (tokPath) => {
    if (leafOriginByPath.has(tokPath)) return leafOriginByPath.get(tokPath);
    const segs = String(tokPath || "").split(".");
    for (let i = segs.length - 1; i >= 1; i--) {
      const pref = segs.slice(0, i).join(".");
      if (extendsOriginByGroup.has(pref)) return extendsOriginByGroup.get(pref);
    }
    for (let i = segs.length - 1; i >= 1; i--) {
      const pref = segs.slice(0, i).join(".");
      if (groupOriginByPath.has(pref)) return groupOriginByPath.get(pref);
    }
    return { relTf: parsedTokenFiles[0]?.relTf || "tokens.json", fileMode: parsedTokenFiles[0]?.fileMode || null };
  };

  const dtcgReports = [];
  const mergedTokens = [];
  const dtcgFileByPath = new Map();
  let combinedDtcg = null;
  let dtcgModes = null;
  if (parsedTokenFiles.length > 0) {
    const rawExtendsIssues = [];
    const expandedTree = resolveDtcgExtends(combinedTree, rawExtendsIssues);
    const rawMergedTokens = flattenTokensFromExpanded(expandedTree, rawExtendsIssues);
    const enrichedExtendsIssues = rawExtendsIssues.map((iss) => {
      const origin =
        extendsOriginByGroup.get(iss.path) ||
        (iss.path && iss.path !== "(root)" ? findTokenOrigin(iss.path) : { relTf: parsedTokenFiles[0]?.relTf || "tokens.json" });
      return { ...iss, file: origin.relTf };
    });
    for (const tok of rawMergedTokens) {
      const origin = findTokenOrigin(tok.path);
      if (!dtcgFileByPath.has(tok.path)) dtcgFileByPath.set(tok.path, origin.relTf);
      const fm = origin.fileMode;
      const adjustedTok = fm
        ? {
            ...tok,
            value: rewriteValRefs(tok.value, fm, modeLocalPaths[fm]),
            ref: tok.ref ? rewriteRefStr(tok.ref, fm, modeLocalPaths[fm]) : tok.ref,
          }
        : tok;
      mergedTokens.push(adjustedTok);
    }
    Object.defineProperty(mergedTokens, DTCG_EXTENDS_ISSUES, {
      value: enrichedExtendsIssues,
      enumerable: false,
      configurable: true,
    });
    if (mergedTokens.length > 0) {
      combinedDtcg = validateDtcgTokens(mergedTokens);
      dtcgModes = analyzeDtcgModesAndContrast(mergedTokens);
    } else if (enrichedExtendsIssues.length > 0) {
      combinedDtcg = validateDtcgTokens(mergedTokens);
    }
    const tokensByFile = new Map(parsedTokenFiles.map((pf) => [pf.relTf, []]));
    for (const tok of mergedTokens) {
      const ownerRel = dtcgFileByPath.get(tok.path) || parsedTokenFiles[0].relTf;
      if (!tokensByFile.has(ownerRel)) tokensByFile.set(ownerRel, []);
      tokensByFile.get(ownerRel).push(tok);
    }
    for (const pf of parsedTokenFiles) {
      const fileToks = tokensByFile.get(pf.relTf) || [];
      if (parsedTokenFiles.length === 1) {
        dtcgReports.push({ file: pf.relTf, ...(combinedDtcg || validateDtcgTokens(fileToks)) });
      } else {
        const fileExtIssues = enrichedExtendsIssues.filter((iss) => iss.file === pf.relTf);
        const fileLocal = validateDtcgTokens(
          Object.defineProperty([...fileToks], DTCG_EXTENDS_ISSUES, {
            value: fileExtIssues,
            enumerable: false,
            configurable: true,
          })
        );
        const filePathSet = new Set(fileToks.map((t) => t.path));
        const combinedBlockingForFile = (combinedDtcg?.blockingIssues || []).filter(
          (iss) => (iss.file ? iss.file === pf.relTf : dtcgFileByPath.get(iss.path) === pf.relTf)
        );
        const combinedMissingTypesForFile = (combinedDtcg?.missingTypeIssues || []).filter((iss) => filePathSet.has(iss.path));
        dtcgReports.push({
          file: pf.relTf,
          tokenCount: fileLocal.tokenCount,
          typedCount: fileLocal.typedCount,
          describedCount: fileLocal.describedCount,
          aliasCount: fileLocal.aliasCount,
          componentScopedCount: fileLocal.componentScopedCount,
          modernColorCount: fileLocal.modernColorCount,
          blockingIssues: combinedBlockingForFile,
          missingTypeIssues: combinedMissingTypesForFile,
        });
      }
    }
  }

  // 2. Codebase Drift Scan
  const definedVars = new Set();
  const varDefLocations = new Map();
  const usedVars = new Set();
  const themeVars = new Set();
  const seenUtilityClasses = new Set();
  const primitiveVarsUsed = new Set();
  let colorTokenRefs = 0;
  let hardcodedColorHits = 0;
  let svgPaletteHits = 0;
  let swatchPaletteHits = 0;
  let offGridSpacingHits = 0;
  let importantCount = 0;
  let twArbitraryColors = 0;
  let twArbitrarySpacing = 0;
  let twPrimitiveColors = 0;
  const hardcodedHexSet = new Set();
  const serverImageFiles = [];
  const sampleViolations = [];
  const fileRecords = [];
  const ciActive = [];
  const ciWaived = [];
  const ciUnusedIgnores = [];

  if (combinedDtcg) {
    for (const issue of combinedDtcg.blockingIssues) {
      const ruleId =
        issue.type === "circular_reference" || issue.type === "circular_extends"
          ? "dsaf/dtcg-circular-ref"
          : "dsaf/dtcg-unresolved-ref";
      const fileForIssue =
        issue.file ||
        dtcgFileByPath.get(issue.path) ||
        [...dtcgFileByPath.entries()].find(([k]) => k.startsWith(`${issue.path}.`))?.[1] ||
        dtcgReports[0]?.file ||
        "tokens.json";
      ciActive.push({
        file: fileForIssue,
        line: 1,
        ruleId,
        tier: "floor",
        severity: "error",
        message: `${issue.type} on token '${issue.path}' -> '${issue.target}'`,
      });
    }
  }
  if (dtcgModes?.contrast?.wcagFailures > 0) {
    for (const p of dtcgModes.contrast.failingPairs || []) {
      ciActive.push({
        file: dtcgFileByPath.get(p.fg) || dtcgReports[0]?.file || "tokens.json",
        line: 1,
        ruleId: "dsaf/dtcg-contrast-fail",
        tier: "floor",
        severity: "error",
        message: `DTCG contrast fail (${p.mode}): ${p.fg} on ${p.bg} = ${p.wcagRatio}:1 (< 4.5:1)`,
      });
    }
  }

  for (const cf of codeFiles.sort()) {
    const raw = readFileSync(cf, "utf8");
    const rel = st.isDirectory() ? relative(resolved, cf).replace(/\\/g, "/") : cf;
    // Skip single-line compiled/minified bundles even without .min. suffix
    if (raw.length > 100_000 && raw.split("\n").length < 5) continue;
    // Skip server-side raster OG/icon generators (e.g. next/og ImageResponse) that cannot read CSS var()
    if (/\bImageResponse\b/.test(raw) && /next\/og|@vercel\/og|satori/i.test(raw)) {
      serverImageFiles.push(rel);
      continue;
    }
    const lowerCf = cf.toLowerCase();
    const isStyle = lowerCf.endsWith(".css") || lowerCf.endsWith(".scss");
    const commentFreeRaw = stripCommentsPreservingLines(raw);
    const markupOpts = isStyle
      ? null
      : {
          isMarkupSfc: /\.(?:html?|vue|svelte|astro)$/i.test(lowerCf),
          braceExprs: /\.(?:svelte|astro)$/i.test(lowerCf),
          mustacheExprs: /\.vue$/i.test(lowerCf),
          isAstro: /\.astro$/i.test(lowerCf),
        };

    const rawStyleRanges = [];
    let rawCssInJsRanges = [];
    let rawMarkupCtx = null;
    if (isStyle) {
      for (const tv of extractAtThemeVars(commentFreeRaw)) themeVars.add(tv);
      const maskedDefsRaw = extractStyleQueryVarsAndMaskPreludes(maskCssQuotedStringsPreservingLines(commentFreeRaw), usedVars);
      for (const m of maskedDefsRaw.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)\s*:(?!:)/g)) {
        const name = `--${m[1]}`;
        if (!isFrameworkInternalVar(name)) {
          definedVars.add(name);
          if (!varDefLocations.has(name)) varDefLocations.set(name, { file: rel, line: offsetToLine(commentFreeRaw, m.index) });
        }
      }
    } else {
      rawMarkupCtx = scanMarkupContexts(commentFreeRaw, markupOpts);
      rawCssInJsRanges = extractCssInJsTemplateRanges(commentFreeRaw, rawMarkupCtx);
      for (const blk of extractRealStyleBlocks(commentFreeRaw, rawMarkupCtx, markupOpts)) {
        rawStyleRanges.push([blk.bodyStart, blk.bodyEnd]);
        const maskedStyleInner = extractStyleQueryVarsAndMaskPreludes(maskCssQuotedStringsPreservingLines(blk.text), usedVars);
        for (const m of maskedStyleInner.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)\s*:(?!:)/g)) {
          const name = `--${m[1]}`;
          if (!isFrameworkInternalVar(name)) {
            definedVars.add(name);
            if (!varDefLocations.has(name)) varDefLocations.set(name, { file: rel, line: offsetToLine(commentFreeRaw, blk.bodyStart + m.index) });
          }
        }
      }
      for (const attrMatch of commentFreeRaw.matchAll(/(?<![a-zA-Z0-9_:-])style\s*=\s*(["'])([\s\S]*?)\1/gi)) {
        if (!isRealOpenTagAttrPos(rawMarkupCtx, attrMatch.index)) continue;
        const attrStart = attrMatch.index + attrMatch[0].indexOf(attrMatch[2]);
        const maskedAttrInner = maskCssQuotedStringsPreservingLines(attrMatch[2]);
        for (const m of maskedAttrInner.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)\s*:(?!:)/g)) {
          const name = `--${m[1]}`;
          if (!isFrameworkInternalVar(name)) {
            definedVars.add(name);
            if (!varDefLocations.has(name)) varDefLocations.set(name, { file: rel, line: offsetToLine(commentFreeRaw, attrStart + m.index) });
          }
        }
      }
      if (lowerCf.endsWith(".svelte")) {
        for (const sd of findSvelteStyleDirectives(commentFreeRaw)) {
          if (!sd.isCustomProp || !isRealOpenTagAttrPos(rawMarkupCtx, sd.start)) continue;
          if (!isFrameworkInternalVar(sd.prop)) {
            definedVars.add(sd.prop);
            if (!varDefLocations.has(sd.prop)) {
              varDefLocations.set(sd.prop, { file: rel, line: offsetToLine(commentFreeRaw, sd.start) });
            }
          }
        }
      }
      const rawOuterStrSpans = computeMarkupJsOuterStringSpans(commentFreeRaw, markupOpts, rawMarkupCtx);
      const isInsideRawOuterStr = (idx) => rawOuterStrSpans.some(([s0, e0]) => idx > s0 && idx < e0);
      for (const m of commentFreeRaw.matchAll(/["']--([a-zA-Z0-9_-]+)["']\s*:/g)) {
        if (isInsideRawOuterStr(m.index) || !isValidJsObjKeyPos(commentFreeRaw, m.index)) continue;
        const name = `--${m[1]}`;
        if (!isFrameworkInternalVar(name)) {
          definedVars.add(name);
          if (!varDefLocations.has(name)) varDefLocations.set(name, { file: rel, line: offsetToLine(commentFreeRaw, m.index) });
        }
      }
    }
    const varUsageSurface = isStyle
      ? commentFreeRaw
      : maskProseAndDocStringsPreservingLines(commentFreeRaw, {
          ...markupOpts,
          markupCtx: rawMarkupCtx,
          excludeSpans: [...rawStyleRanges, ...rawCssInJsRanges.map((r) => [r.start, r.end])],
        });
    for (const m of varUsageSurface.matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
      if (/^--(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|palette|raw)-?\d+/i.test(name)) {
        primitiveVarsUsed.add(name);
      }
    }
    for (const m of varUsageSurface.matchAll(/(?<=^|[\s"'`:!])-?[a-z][a-z0-9-]*-\((?:[a-z-]+:)?--([a-zA-Z0-9_-]+)\)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
    }
    for (const m of varUsageSurface.matchAll(/\b(?:getPropertyValue|setProperty)\(\s*["']--([a-zA-Z0-9_-]+)["']/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
    }
    for (const m of varUsageSurface.matchAll(/(?:^|[\s"'`:/!])-?([a-z]+-[a-z0-9-]+)/g)) {
      seenUtilityClasses.add(m[1]);
    }
    for (const m of varUsageSurface.matchAll(/(?:^|[\s"'`:/!])@(?:(?:min|max)-)?([a-z0-9][a-z0-9-]*)(?=(?:\/[a-zA-Z0-9_-]+)?:)/g)) {
      seenUtilityClasses.add(`@${m[1]}`);
    }
    for (const m of varUsageSurface.matchAll(/(?:^|[\s"'`:/!])(?:(?:min|max)-)?([a-z0-9][a-z0-9-]*):/g)) {
      seenUtilityClasses.add(`bp:${m[1]}`);
    }

    let linePreservingSurface = isStyle ? stripTokenBlocksPreservingLines(raw) : commentFreeRaw;
    const embeddedStyleRanges = [];
    if (!isStyle) {
      const surfChars = linePreservingSurface.split("");
      const styleMarkupCtx = scanMarkupContexts(linePreservingSurface, markupOpts);
      for (const blk of extractRealStyleBlocks(linePreservingSurface, styleMarkupCtx, markupOpts)) {
        const inner = blk.text;
        embeddedStyleRanges.push({ start: blk.bodyStart, end: blk.bodyEnd });
        for (const tv of extractAtThemeVars(inner)) themeVars.add(tv);
        const strippedInner = stripTokenBlocksPreservingLines(inner);
        for (let k = 0; k < strippedInner.length && blk.bodyStart + k < blk.bodyEnd; k++) {
          surfChars[blk.bodyStart + k] = strippedInner[k];
        }
      }
      linePreservingSurface = surfChars.join("");
      const svgCtx = scanMarkupContexts(linePreservingSurface, markupOpts);
      const svgRes = stripSvgColorBlocksPreservingLines(linePreservingSurface, markupOpts, svgCtx);
      svgPaletteHits += svgRes.hits;
      const swatchRes = stripSwatchTablesPreservingLines(svgRes.masked);
      swatchPaletteHits += swatchRes.hits;
      linePreservingSurface = swatchRes.masked;
    }
    const cssInJsRanges = isStyle ? [] : extractCssInJsTemplateRanges(linePreservingSurface, markupOpts ? scanMarkupContexts(linePreservingSurface, markupOpts) : null);
    if (!isStyle && cssInJsRanges.length > 0) {
      const cssCmtChars = linePreservingSurface.split("");
      for (const r of cssInJsRanges) {
        const rep = stripCssCommentsInTemplatePreservingLines(linePreservingSurface.slice(r.start, r.end));
        for (let k = 0; k < rep.length && r.start + k < r.end; k++) {
          cssCmtChars[r.start + k] = rep[k];
        }
      }
      linePreservingSurface = cssCmtChars.join("");
    }
    let linePreservingNonVar;
    if (isStyle) {
      linePreservingNonVar = blankCssCustomPropDeclsPreservingLines(linePreservingSurface);
    } else {
      const nvMarkupCtx = scanMarkupContexts(linePreservingSurface, markupOpts);
      const nvChars = linePreservingSurface.split("");
      for (const r of embeddedStyleRanges) {
        const sliceRep = blankCssCustomPropDeclsPreservingLines(linePreservingSurface.slice(r.start, r.end));
        for (let k = 0; k < sliceRep.length && r.start + k < r.end; k++) nvChars[r.start + k] = sliceRep[k];
      }
      for (const attrMatch of linePreservingSurface.matchAll(/(?<![a-zA-Z0-9_:-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (!isRealOpenTagAttrPos(nvMarkupCtx, attrMatch.index)) continue;
        const val = attrMatch[1] !== undefined ? attrMatch[1] : attrMatch[2];
        const qChar = attrMatch[1] !== undefined ? '"' : "'";
        const attrStart = attrMatch.index + attrMatch[0].indexOf(qChar) + 1;
        const attrRep = blankCssCustomPropDeclsPreservingLines(val, { allowBracedExpr: true });
        for (let k = 0; k < attrRep.length && attrStart + k < attrStart + val.length; k++) {
          nvChars[attrStart + k] = attrRep[k];
        }
      }
      if (lowerCf.endsWith(".svelte")) {
        for (const sd of findSvelteStyleDirectives(linePreservingSurface)) {
          if (!sd.isCustomProp || !isRealOpenTagAttrPos(nvMarkupCtx, sd.start)) continue;
          maskRangePreservingLines(nvChars, sd.valStart, sd.valEnd);
        }
      }
      linePreservingNonVar = blankJsCustomPropEntriesPreservingLines(
        blankStyledTemplateCustomPropsPreservingLines(nvChars.join("")),
        markupOpts
      );
    }
    const varRefSurface = isStyle
      ? linePreservingNonVar
      : maskProseAndDocStringsPreservingLines(linePreservingNonVar, {
          ...markupOpts,
          excludeSpans: [...embeddedStyleRanges, ...cssInJsRanges].map((r) => [r.start, r.end]),
        });
    const varRefsInFile =
      (varRefSurface.match(/var\(\s*--[a-zA-Z0-9_-]+/g) || []).length +
      (varRefSurface.match(/(?<=^|[\s"'`:!])-?[a-z][a-z0-9-]*-\((?:[a-z-]+:)?--[a-zA-Z0-9_-]+\)/g) || []).length;
    colorTokenRefs += varRefsInFile;

    const twArbColorRe =
      /(?<=^|[\s"'`:!])((?:bg|text|border(?:-(?:t|r|b|l|x|y|s|e))?|divide|fill|stroke|(?:inset-)?ring(?:-offset)?|from|to|via|accent|outline|decoration|shadow|caret|placeholder)-\[(?:color:)?(?:#[^\]\s]+|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color-mix|color|light-dark)\([^\]\s]+\))\]!?|\[(?:color|background-color|background|border-color|outline-color|fill|stroke|accent-color|caret-color):(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color-mix|color|light-dark)\([^\]\s]+\))\]!?)/g;
    const twArbSpaceRe =
      /(?<=^|[\s"'`:!])(-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded(?:-[a-z]+)?|(?:min-|max-)?(?:w|h|size)|inset(?:-[xy])?|top|right|bottom|left|start|end)-\[-?\d+(?:\.\d+)?px\]!?|\[(?:padding|margin|gap|row-gap|column-gap|width|height|min-width|max-width|min-height|max-height|inset|top|right|bottom|left|border-radius)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?:\s*-?\d+(?:\.\d+)?px\]!?)/g;
    const twPrimColorRe =
      /(?<=^|[\s"'`:!])(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)!?(?![a-zA-Z0-9_-])/g;

    const twScanSurface = buildTailwindScanSurfacePreservingLines(
      linePreservingSurface,
      isStyle,
      markupOpts,
      embeddedStyleRanges.map((r) => [r.start, r.end])
    );
    const nonTwChars = linePreservingNonVar.split("");
    for (const m of twScanSurface.matchAll(twArbColorRe)) {
      maskRangePreservingLines(nonTwChars, m.index, m.index + m[0].length);
    }
    const linePreservingNonTw = nonTwChars.join("");
    const colorScanSurface = maskNonColorHashContextsPreservingLines(
      linePreservingNonTw,
      isStyle,
      [...embeddedStyleRanges, ...cssInJsRanges],
      embeddedStyleRanges,
      cssInJsRanges,
      markupOpts
    );
    const fileCiFindings = [];

    let fileColorDrift = 0;
    const hexSpansInFile = [];
    for (const m of colorScanSurface.matchAll(HEX_COLOR_RE)) {
      fileColorDrift++;
      hexSpansInFile.push([m.index, m.index + m[0].length]);
      const norm = normalizeHexKey(m[0]);
      if (norm) hardcodedHexSet.add(norm);
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(colorScanSurface, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded hex color \`${m[0]}\` outside token definitions.`,
      });
    }
    for (const m of findHardcodedColorFunctions(colorScanSurface)) {
      if (isTokenizedColorFn(m.text)) continue;
      if (
        /^color-mix\(/i.test(m.text) &&
        hexSpansInFile.some(([hs, he]) => hs >= m.index && he <= m.index + m.text.length)
      ) {
        continue;
      }
      fileColorDrift++;
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(colorScanSurface, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded functional color \`${m.text}\` outside token definitions.`,
      });
    }
    hardcodedColorHits += fileColorDrift;

    const impSurface = extractImportantStyleSurfacePreservingLines(linePreservingNonVar, isStyle, markupOpts || {});
    const impMatches = impSurface.match(/!\s*important\b/gi) || [];
    importantCount += impMatches.length;
    for (const m of impSurface.matchAll(/!\s*important\b/gi)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(impSurface, m.index),
        ruleId: "dsaf/important-override",
        tier: "reflex",
        severity: "warning",
        message: "Disallowed `!important` override.",
      });
    }

    let fileOffGrid = 0;
    const scanCssSpacingSlice = (sliceText, baseOffset) => {
      const maskedSlice = maskCssQuotedStringsPreservingLines(sliceText);
      for (const m of maskedSlice.matchAll(/(?<![a-zA-Z0-9_$:-])([a-zA-Z-]+)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/g)) {
        if (!SPACING_RADIUS_CSS_PROP_RE.test(m[1])) continue;
        for (const pxm of stripCssVarNames(m[2]).matchAll(PX_VALUE_RE)) {
          const n = Number.parseFloat(pxm[1]);
          if (isOffGridPxValue(n)) {
            fileOffGrid++;
            fileCiFindings.push({
              file: rel,
              line: offsetToLine(linePreservingNonVar, baseOffset + m.index),
              ruleId: "dsaf/off-grid-spacing",
              tier: "reflex",
              severity: "warning",
              message: `Off-grid spacing \`${m[1]}: ${n}px\`; use 4px/8px grid token.`,
            });
          }
        }
      }
    };
    const scanHtmlStyleAttr = (attrVal, attrStart) => {
      for (const d of splitCssStyleDecls(attrVal)) {
        if (!SPACING_RADIUS_CSS_PROP_RE.test(d.prop)) continue;
        const resolvedVal = extractHtmlStyleValForSpacing(d.val);
        for (const pxm of stripCssVarNames(resolvedVal).matchAll(PX_VALUE_RE)) {
          const n = Number.parseFloat(pxm[1]);
          if (isOffGridPxValue(n)) {
            fileOffGrid++;
            fileCiFindings.push({
              file: rel,
              line: offsetToLine(linePreservingNonVar, attrStart + d.offset),
              ruleId: "dsaf/off-grid-spacing",
              tier: "reflex",
              severity: "warning",
              message: `Off-grid spacing \`${d.prop}: ${n}px\`; use 4px/8px grid token.`,
            });
          }
        }
      }
    };
    if (isStyle) {
      scanCssSpacingSlice(maskAtApplyDeclsPreservingLines(linePreservingNonVar), 0);
    } else {
      const jsChars = linePreservingNonVar.split("");
      for (const r of embeddedStyleRanges) {
        scanCssSpacingSlice(maskAtApplyDeclsPreservingLines(linePreservingNonVar.slice(r.start, r.end)), r.start);
        maskRangePreservingLines(jsChars, r.start, r.end);
      }
      for (const r of cssInJsRanges) {
        const rawTpl = linePreservingNonVar.slice(r.start, r.end);
        const tplChars = rawTpl.split("");
        const placeholders = [];
        for (let k = 0; k < rawTpl.length; k++) {
          if (rawTpl[k] === "$" && rawTpl[k + 1] === "{") {
            const endB = findBalIdx(rawTpl, k + 1, "{", "}");
            if (endB === -1) break;
            const expr = rawTpl.slice(k + 2, endB);
            const resolved = stripCssVarNames(extractSpacingValueBranches(expr));
            placeholders.push({ start: k, end: endB + 1, val: resolved });
            maskRangePreservingLines(tplChars, k, endB + 1);
            tplChars[k] = "_";
            k = endB;
          }
        }
        const maskedTpl = maskCssQuotedStringsPreservingLines(tplChars.join(""));
        for (const m of maskedTpl.matchAll(/(?<![a-zA-Z0-9_$:-])([a-zA-Z-]+)\s*:\s*((?:[^#;{}]|#\{[^{}]*\}|#(?!\{))+)/g)) {
          if (!SPACING_RADIUS_CSS_PROP_RE.test(m[1])) continue;
          const valStart = m.index + m[0].length - m[2].length;
          const valEnd = m.index + m[0].length;
          const expandedParts = [m[2]];
          for (const ph of placeholders) {
            if (ph.start >= valStart && ph.start < valEnd && maskedTpl[ph.start] === "_") {
              const hasTrailingPx = /^px\b/i.test(maskedTpl.slice(ph.end, valEnd));
              expandedParts.push(hasTrailingPx ? attachPxToBareNumbers(ph.val) : ph.val);
            }
          }
          const expandedVal = expandedParts.join(" ");
          for (const pxm of stripCssVarNames(expandedVal).matchAll(PX_VALUE_RE)) {
            const n = Number.parseFloat(pxm[1]);
            if (isOffGridPxValue(n)) {
              fileOffGrid++;
              fileCiFindings.push({
                file: rel,
                line: offsetToLine(linePreservingNonVar, r.start + m.index),
                ruleId: "dsaf/off-grid-spacing",
                tier: "reflex",
                severity: "warning",
                message: `Off-grid spacing \`${m[1]}: ${n}px\`; use 4px/8px grid token.`,
              });
            }
          }
        }
        maskRangePreservingLines(jsChars, r.start, r.end);
      }
      const spacingMarkupCtx = scanMarkupContexts(linePreservingNonVar, markupOpts);
      for (const attrMatch of linePreservingNonVar.matchAll(/[a-zA-Z][a-zA-Z0-9_:-]*-style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (!isRealOpenTagAttrPos(spacingMarkupCtx, attrMatch.index)) continue;
        maskRangePreservingLines(jsChars, attrMatch.index, attrMatch.index + attrMatch[0].length);
      }
      for (const dirMatch of linePreservingNonVar.matchAll(/(?<![a-zA-Z0-9_-])style:([a-z][a-z0-9-]*)(?:\|important)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/gi)) {
        if (!isRealOpenTagAttrPos(spacingMarkupCtx, dirMatch.index)) continue;
        const propName = dirMatch[1];
        const quotedVal = dirMatch[2] ?? dirMatch[3] ?? null;
        let valText = quotedVal;
        let matchEnd = dirMatch.index + dirMatch[0].length;
        if (valText === null) {
          const openB = dirMatch.index + dirMatch[0].length - 1;
          const endB = findBalIdx(linePreservingNonVar, openB, "{", "}");
          const k = endB === -1 ? linePreservingNonVar.length : endB + 1;
          valText = linePreservingNonVar.slice(openB + 1, Math.max(openB + 1, k - 1));
          matchEnd = k;
        }
        if (SPACING_RADIUS_CSS_PROP_RE.test(propName) && valText) {
          const branchVal =
            quotedVal !== null
              ? valText.includes("{")
                ? extractHtmlStyleValForSpacing(valText)
                : valText
              : extractSpacingValueBranches(valText);
          for (const pxm of stripCssVarNames(branchVal).matchAll(PX_VALUE_RE)) {
            const n = Number.parseFloat(pxm[1]);
            if (isOffGridPxValue(n)) {
              fileOffGrid++;
              fileCiFindings.push({
                file: rel,
                line: offsetToLine(linePreservingNonVar, dirMatch.index),
                ruleId: "dsaf/off-grid-spacing",
                tier: "reflex",
                severity: "warning",
                message: `Off-grid spacing \`${propName}: ${n}px\`; use 4px/8px grid token.`,
              });
            }
          }
        }
        maskRangePreservingLines(jsChars, dirMatch.index, matchEnd);
      }
      for (const attrMatch of linePreservingNonVar.matchAll(/(?<![a-zA-Z0-9_-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const isBoundStyle = attrMatch.index > 0 && linePreservingNonVar[attrMatch.index - 1] === ":";
        if (isBoundStyle || !isRealOpenTagAttrPos(spacingMarkupCtx, attrMatch.index)) continue;
        const attrVal = attrMatch[1] !== undefined ? attrMatch[1] : attrMatch[2];
        const qChar = attrMatch[1] !== undefined ? '"' : "'";
        const attrStart = attrMatch.index + attrMatch[0].indexOf(qChar) + 1;
        scanHtmlStyleAttr(attrVal, attrStart);
        maskRangePreservingLines(jsChars, attrMatch.index, attrMatch.index + attrMatch[0].length);
      }
      const jsSpacingSurface = jsChars.join("");
      const styleSpans = [];
      for (const sm of jsSpacingSurface.matchAll(/(?<![a-zA-Z0-9_-])(?:style|sx)\s*=\s*\{/g)) {
        if (!isRealOpenTagAttrPos(spacingMarkupCtx, sm.index)) continue;
        const openB = jsSpacingSurface.indexOf("{", sm.index);
        const closeB = findBalIdx(jsSpacingSurface, openB, "{", "}");
        if (closeB !== -1) styleSpans.push([openB + 1, closeB]);
      }
      for (const vm of jsSpacingSurface.matchAll(/(?:^|\s)((?::|v-bind:)style)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const attrOff = vm.index + vm[0].indexOf(vm[1]);
        if (!isRealOpenTagAttrPos(spacingMarkupCtx, attrOff)) continue;
        const qC = vm[2] !== undefined ? '"' : "'";
        const vVal = vm[2] !== undefined ? vm[2] : vm[3];
        const vStart = vm.index + vm[0].indexOf(qC) + 1;
        styleSpans.push([vStart, vStart + vVal.length]);
      }
      const spJsStrSpans = computeMarkupJsOuterStringSpans(jsSpacingSurface, markupOpts, spacingMarkupCtx);
      const isSpProseOrStr = (idx) =>
        spacingMarkupCtx.proseSpans?.some(([ps, pe]) => idx >= ps && idx < pe) ||
        spJsStrSpans.some(([ss, se]) => idx > ss && idx < se);
      const skipTsGenLocal = (srcStr, curStart) => {
        let cur = curStart;
        while (cur < srcStr.length && /\s/.test(srcStr[cur])) cur++;
        if (cur >= srcStr.length || srcStr[cur] !== "<") return curStart;
        let ang = 1;
        let brace = 0;
        let q = null;
        cur++;
        const limit = Math.min(srcStr.length, cur + 800);
        while (cur < limit && ang > 0) {
          const c = srcStr[cur];
          if (q) {
            if (c === "\\" && cur + 1 < limit) { cur += 2; continue; }
            if (c === q || (q !== "`" && c === "\n")) q = null;
          } else if (c === '"' || c === "'" || c === "`") q = c;
          else if (c === "{") brace++;
          else if (c === "}") brace = Math.max(0, brace - 1);
          else if (c === "<" && brace === 0) ang++;
          else if (c === ">" && srcStr[cur - 1] !== "=" && brace === 0) ang--;
          cur++;
        }
        if (ang !== 0) return curStart;
        while (cur < srcStr.length && /\s/.test(srcStr[cur])) cur++;
        return cur;
      };
      for (const cm of jsSpacingSurface.matchAll(/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b)\s*/g)) {
        if (isSpProseOrStr(cm.index)) continue;
        let cur = cm.index + cm[0].length;
        if (/^styled(?:\s|$)/.test(cm[0]) && jsSpacingSurface[cur] === "(") {
          const ep = findBalIdx(jsSpacingSurface, cur, "(", ")");
          if (ep === -1) continue;
          cur = ep + 1;
          while (cur < jsSpacingSurface.length && /\s/.test(jsSpacingSurface[cur])) cur++;
        }
        while (cur < jsSpacingSurface.length) {
          const chainM = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(jsSpacingSurface.slice(cur, cur + 64));
          if (!chainM) break;
          cur = skipTsGenLocal(jsSpacingSurface, cur + chainM[0].length);
          if (jsSpacingSurface[cur] === "(") {
            const epC = findBalIdx(jsSpacingSurface, cur, "(", ")");
            if (epC === -1) { cur = -1; break; }
            cur = epC + 1;
            while (cur < jsSpacingSurface.length && /\s/.test(jsSpacingSurface[cur])) cur++;
          }
        }
        if (cur === -1) continue;
        cur = skipTsGenLocal(jsSpacingSurface, cur);
        if (jsSpacingSurface[cur] === "(") {
          const ep = findBalIdx(jsSpacingSurface, cur, "(", ")");
          if (ep !== -1) styleSpans.push([cur + 1, ep]);
        }
      }
      const seenEntryKeys = new Set();
      for (const [spStart, spEnd] of styleSpans) {
        for (const e of extractJsStyleSpacingEntries(jsSpacingSurface.slice(spStart, spEnd), spStart)) {
          if (seenEntryKeys.has(e.index)) continue;
          seenEntryKeys.add(e.index);
          for (const pxm of e.val.matchAll(PX_VALUE_RE)) {
            const n = Number.parseFloat(pxm[1]);
            if (isOffGridPxValue(n)) {
              fileOffGrid++;
              fileCiFindings.push({
                file: rel,
                line: offsetToLine(linePreservingNonVar, e.index),
                ruleId: "dsaf/off-grid-spacing",
                tier: "reflex",
                severity: "warning",
                message: `Off-grid inline spacing \`${n}px\`; use 4px/8px grid token.`,
              });
            }
          }
        }
      }
    }
    offGridSpacingHits += fileOffGrid;

    const fileTwArbColors = (twScanSurface.match(twArbColorRe) || []).length;
    const fileTwArbSpacing = (twScanSurface.match(twArbSpaceRe) || []).length;
    const fileTwPrimColors = (twScanSurface.match(twPrimColorRe) || []).length;
    twArbitraryColors += fileTwArbColors;
    twArbitrarySpacing += fileTwArbSpacing;
    twPrimitiveColors += fileTwPrimColors;

    for (const m of twScanSurface.matchAll(twArbColorRe)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(twScanSurface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[1]}\`.`,
      });
    }
    for (const m of twScanSurface.matchAll(twArbSpaceRe)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(twScanSurface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[1]}\`.`,
      });
    }

    fileRecords.push({ rel, raw, ciFindings: fileCiFindings });

    if ((fileColorDrift > 0 || impMatches.length > 0 || fileOffGrid > 0 || fileTwArbColors > 0 || fileTwArbSpacing > 0) && sampleViolations.length < 25) {
      sampleViolations.push({
        file: rel,
        hardcodedColors: fileColorDrift,
        importantOverrides: impMatches.length,
        offGridPx: fileOffGrid,
        tailwindArbitrary: fileTwArbColors + fileTwArbSpacing,
      });
    }
  }

  for (const tv of themeVars) {
    if (tv.startsWith("--color-")) {
      const slug = tv.slice(8);
      if (
        [
          "bg-",
          "text-",
          "border-",
          "border-t-",
          "border-r-",
          "border-b-",
          "border-l-",
          "border-x-",
          "border-y-",
          "border-s-",
          "border-e-",
          "divide-",
          "ring-",
          "ring-offset-",
          "inset-ring-",
          "fill-",
          "stroke-",
          "from-",
          "to-",
          "via-",
          "outline-",
          "accent-",
          "decoration-",
          "shadow-",
          "inset-shadow-",
          "drop-shadow-",
          "text-shadow-",
          "caret-",
          "placeholder-",
        ].some((p) => seenUtilityClasses.has(p + slug))
      ) {
        usedVars.add(tv);
      }
    } else if (tv === "--spacing") {
      if (
        [...seenUtilityClasses].some((u) =>
          /^(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|w|h|min-w|max-w|min-h|max-h|size|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|start|end|scroll-m|scroll-p)-(?:\d+(?:\.\d+)?|\d+\/\d+|px)$/.test(
            u
          )
        )
      ) {
        usedVars.add(tv);
      }
    } else if (tv.startsWith("--spacing-")) {
      const slug = tv.slice(10);
      if (
        [
          "p-",
          "px-",
          "py-",
          "pt-",
          "pr-",
          "pb-",
          "pl-",
          "ps-",
          "pe-",
          "m-",
          "mx-",
          "my-",
          "mt-",
          "mr-",
          "mb-",
          "ml-",
          "ms-",
          "me-",
          "gap-",
          "gap-x-",
          "gap-y-",
          "w-",
          "h-",
          "min-w-",
          "max-w-",
          "min-h-",
          "max-h-",
          "size-",
          "space-x-",
          "space-y-",
          "inset-",
          "inset-x-",
          "inset-y-",
          "top-",
          "right-",
          "bottom-",
          "left-",
          "start-",
          "end-",
          "scroll-m-",
          "scroll-p-",
        ].some((p) => seenUtilityClasses.has(p + slug))
      ) {
        usedVars.add(tv);
      }
    } else if (tv.startsWith("--radius-")) {
      const slug = tv.slice(9);
      if (
        [
          "rounded-",
          "rounded-t-",
          "rounded-b-",
          "rounded-l-",
          "rounded-r-",
          "rounded-tl-",
          "rounded-tr-",
          "rounded-bl-",
          "rounded-br-",
          "rounded-s-",
          "rounded-e-",
          "rounded-ss-",
          "rounded-se-",
          "rounded-es-",
          "rounded-ee-",
        ].some((p) => seenUtilityClasses.has(p + slug))
      ) {
        usedVars.add(tv);
      }
    } else if (tv.startsWith("--font-weight-") && seenUtilityClasses.has("font-" + tv.slice(14))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--font-") && seenUtilityClasses.has("font-" + tv.slice(7).split("--")[0])) {
      usedVars.add(tv);
    } else if (tv.startsWith("--tracking-") && seenUtilityClasses.has("tracking-" + tv.slice(11))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--leading-") && seenUtilityClasses.has("leading-" + tv.slice(10))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--inset-shadow-") && seenUtilityClasses.has("inset-shadow-" + tv.slice(15))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--drop-shadow-") && seenUtilityClasses.has("drop-shadow-" + tv.slice(14))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--text-shadow-") && seenUtilityClasses.has("text-shadow-" + tv.slice(14))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--shadow-") && seenUtilityClasses.has("shadow-" + tv.slice(9))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--text-") && seenUtilityClasses.has("text-" + tv.slice(7).split("--")[0])) {
      usedVars.add(tv);
    } else if (tv.startsWith("--blur-") && ["blur-", "backdrop-blur-"].some((p) => seenUtilityClasses.has(p + tv.slice(7)))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--perspective-") && seenUtilityClasses.has("perspective-" + tv.slice(14))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--aspect-") && seenUtilityClasses.has("aspect-" + tv.slice(9))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--container-") && ["max-w-", "w-", "min-w-", "@"].some((p) => seenUtilityClasses.has(p + tv.slice(12)))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--animate-") && seenUtilityClasses.has("animate-" + tv.slice(10))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--ease-") && seenUtilityClasses.has("ease-" + tv.slice(7))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--breakpoint-") && seenUtilityClasses.has("bp:" + tv.slice(13))) {
      usedVars.add(tv);
    }
  }

  const isPaletteScaleVar = (name) =>
    /^--(?:[a-z0-9]{1,8}-)?(?:color-|palette-|primitive-|raw-)?(gray|grey|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|gold|jade|bronze|ivory|ink|surface|space|spacing|size|radius|font-size|text|shadow|z|duration|ease|bp|breakpoint)[_-]?(?:50|[1-9]00|[0-9]{1,3}|2xs|xs|sm|md|lg|xl|2xl|3xl|4xl|phone|tablet|desktop)$/i.test(
      name
    );

  const orphanCssVars = [...definedVars].filter((v) => !usedVars.has(v)).sort();
  const semanticOrphans = orphanCssVars.filter((v) => !isPaletteScaleVar(v));
  const paletteScaleUnused = orphanCssVars.filter((v) => isPaletteScaleVar(v));
  let recommendedScope = null;
  if (st.isDirectory()) {
    for (const cand of ["apps/web", "web/src", "app", "src"]) {
      if (existsSync(join(resolved, cand)) && statSync(join(resolved, cand)).isDirectory()) {
        if (demoFilesSkipped.length > 0 || cand === "apps/web" || cand === "web/src" || cand === "src") {
          recommendedScope = cand;
          break;
        }
      }
    }
  }
  const nearDuplicateHexClusters = findNearDuplicateHexClusters(hardcodedHexSet);
  const totalColorDecls = colorTokenRefs + hardcodedColorHits + twArbitraryColors;
  const tokenCompliancePct = totalColorDecls > 0 ? Number(((colorTokenRefs / totalColorDecls) * 100).toFixed(1)) : null;

  const fileRecordByRel = new Map(fileRecords.map((r) => [r.rel, r]));
  for (const ov of semanticOrphans) {
    const loc = varDefLocations.get(ov);
    if (loc) {
      const finding = {
        file: loc.file,
        line: loc.line,
        ruleId: "dsaf/semantic-orphan-var",
        tier: "finish",
        severity: "note",
        message: `Unused semantic CSS custom property \`${ov}\`.`,
      };
      const rec = fileRecordByRel.get(loc.file);
      if (rec) rec.ciFindings.push(finding);
      else ciActive.push(finding);
    }
  }

  const tokensEvaluatedRules = [
    "dsaf/hardcoded-color",
    "dsaf/important-override",
    "dsaf/off-grid-spacing",
    "dsaf/tailwind-arbitrary",
    "dsaf/semantic-orphan-var",
  ];
  for (const rec of fileRecords) {
    const ignored = applyIgnores(rec.ciFindings, rec.raw, rec.rel, {
      reportUnusedIgnores: Boolean(options.reportUnusedIgnores),
      evaluatedRules: tokensEvaluatedRules,
    });
    ciActive.push(...ignored.active);
    ciWaived.push(...ignored.waived);
    ciUnusedIgnores.push(...ignored.unusedIgnores);
  }

  const ciCounts = {
    floor: ciActive.filter((x) => x.tier === "floor").length,
    reflex: ciActive.filter((x) => x.tier === "reflex").length,
    finish: ciActive.filter((x) => x.tier === "finish").length,
    waived: ciWaived.length,
    unusedIgnores: ciUnusedIgnores.length,
  };

  return {
    schema: "dsaf-tokens/2",
    generated: new Date().toISOString(),
    target: resolved,
    filesScanned: { tokenJson: tokenJsonFiles.length, uiAndStyle: codeFiles.length },
    dtcg: combinedDtcg,
    dtcgModes,
    dtcgFiles: dtcgReports,
    drift: {
      definedCssVariables: definedVars.size,
      usedCssVariables: usedVars.size,
      orphanCssVariableCount: orphanCssVars.length,
      orphanCssVariablesSample: orphanCssVars.slice(0, 20),
      semanticOrphanCount: semanticOrphans.length,
      semanticOrphansSample: semanticOrphans.slice(0, 20),
      paletteScaleUnusedCount: paletteScaleUnused.length,
      paletteScaleUnusedSample: paletteScaleUnused.slice(0, 20),
      demoFilesSkipped: demoFilesSkipped.sort(),
      recommendedScope,
      colorTokenRefs,
      hardcodedColorHits,
      svgPaletteHits,
      swatchPaletteHits,
      tokenCompliancePct,
      primitiveLeakVariables: [...primitiveVarsUsed].sort(),
      nearDuplicateHexClusters,
      importantOverrides: importantCount,
      offGridSpacingHits,
      serverImageFiles,
      tailwind: {
        arbitraryColors: twArbitraryColors,
        arbitrarySpacing: twArbitrarySpacing,
        primitiveColors: twPrimitiveColors,
      },
      sampleViolations,
    },
    ciFindings: {
      active: ciActive,
      waived: ciWaived,
      unusedIgnores: ciUnusedIgnores,
      counts: ciCounts,
    },
  };
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-tokens-test-"));
  try {
    // 1. Clean DTCG tokens
    const valid = validateDtcgTokens({
      primitive: { blue: { $type: "color", $value: "oklch(0.55 0.18 250)" } },
      semantic: { action: { primary: { $type: "color", $value: "{primitive.blue}", $description: "Primary CTA fill" } } },
    });
    assert.equal(valid.tokenCount, 2);
    assert.equal(valid.blockingIssues.length, 0);
    assert.equal(valid.modernColorCount, 1);

    // 2. Broken / circular DTCG detection
    const broken = validateDtcgTokens({
      a: { $value: "{b}" },
      b: { $value: "{a}" },
      c: { $type: "color", $value: "{missing.token}" },
    });
    assert.ok(broken.blockingIssues.some((i) => i.type === "circular_reference"), "Must detect circular ref");
    assert.ok(broken.blockingIssues.some((i) => i.type === "unresolved_reference"), "Must detect unresolved ref");

    // 3. Light/Dark DTCG parity + token-level WCAG & APCA contrast
    const themed = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: {
          primary: { $type: "color", $value: "#111827" },
          muted: { $type: "color", $value: "#a3a3a3" },
        },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      },
    });
    assert.equal(themed.parity.hasModes, true);
    assert.deepEqual(themed.parity.missingInDark, ["text.muted"]);
    assert.ok(themed.contrast.pairsEvaluated >= 3);
    assert.equal(themed.contrast.wcagFailures, 1, "Must fail #a3a3a3 on #ffffff");

    // 4. Scoped CSS + Tailwind drift (excludes --tw-*, max-width/font-size, minified public/assets)
    const appDir = join(scratch, "app");
    mkdirSync(join(appDir, "public/assets"), { recursive: true });
    writeFileSync(join(appDir, "public/assets/app.min.css"), ".x{color:#111;padding:13px;}");
    writeFileSync(
      join(appDir, "styles.css"),
      `:root { --brand: #1d4ed8; --unused-orphan: #999999; --tw-ring-color: rgba(0,0,0,.5); --radix-open: 1; }
       .btn { color: var(--brand); background: #2563eb; border-color: #2461e8; max-width: 1140px; font-size: 13px; padding: 13px !important; }`
    );
    writeFileSync(
      join(appDir, "Card.tsx"),
      `export const Card = () => <div className="bg-[#ef4444] p-[13px] text-slate-500" style={{ margin: "17px" }} />;`
    );
    const drift = scanTarget(appDir);
    assert.equal(drift.filesScanned.uiAndStyle, 2, "Must skip public/assets/*.min.css");
    assert.equal(drift.drift.orphanCssVariableCount, 1, "Must detect only --unused-orphan, ignoring --tw-* and --radix-*");
    assert.equal(drift.drift.importantOverrides, 1, "Must detect !important");
    assert.equal(drift.drift.hardcodedColorHits, 2, "Must exclude :root and count only non-token colors");
    assert.equal(drift.drift.offGridSpacingHits, 2, "Must count padding: 13px + margin: 17px, NOT max-width/font-size");
    assert.equal(drift.drift.nearDuplicateHexClusters.length, 1, "Must cluster #2563eb and #2461e8");
    assert.equal(drift.drift.tailwind.arbitraryColors, 1);
    assert.equal(drift.drift.tailwind.arbitrarySpacing, 1);
    assert.equal(drift.drift.tailwind.primitiveColors, 1);

    // 5. Tailwind v4 @theme utility consumption, JS var lookup, & Capacitor mobile bundle exclusion
    const twDir = join(scratch, "tw-app");
    mkdirSync(join(twDir, "ios/App/App/public/assets"), { recursive: true });
    mkdirSync(join(twDir, "src"), { recursive: true });
    writeFileSync(join(twDir, "ios/App/App/public/assets/vendor-design.css"), ":root { --mobile-bundle-var: #123456; }");
    writeFileSync(
      join(twDir, "src/theme.css"),
      `@theme inline {
        --color-brand-accent: #1d4ed8;
        --radius-card: 12px;
        --color-unused-orphan: #ef4444;
      }
      :root { --js-consumed: 10px; }`
    );
    writeFileSync(
      join(twDir, "src/App.tsx"),
      `export const App = () => {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--js-consumed");
        return <div data-v={v} className="bg-brand-accent rounded-card" />;
      };`
    );
    const twScan = scanTarget(twDir);
    assert.equal(twScan.filesScanned.uiAndStyle, 2, "Must skip ios/App/App/public/assets mobile bundle");
    assert.equal(twScan.drift.orphanCssVariableCount, 1, "Must detect only --color-unused-orphan");
    assert.deepEqual(twScan.drift.orphanCssVariablesSample, ["--color-unused-orphan"]);

    // 6. Fixture HTML & Server ImageResponse OG exclusion (FB-20261126-007)
    const ogRoot = join(scratch, "og-root");
    mkdirSync(join(ogRoot, "crawler/fixtures"), { recursive: true });
    mkdirSync(join(ogRoot, "app"), { recursive: true });
    writeFileSync(join(ogRoot, "crawler/fixtures/sample.html"), `<div style="color:#ff0000;padding:13px;">snapshot</div>`);
    writeFileSync(
      join(ogRoot, "app/opengraph-image.tsx"),
      `import { ImageResponse } from "next/og";\nexport default function Og() { return new ImageResponse(<div style={{ background: "#0b0f19", padding: "13px" }} />); }`
    );
    writeFileSync(join(ogRoot, "app/page.tsx"), `export default function Page() { return <main className="card" />; }`);
    const ogScan = scanTarget(ogRoot);
    assert.equal(ogScan.filesScanned.uiAndStyle, 2, "Must exclude crawler/fixtures/*.html");
    assert.equal(ogScan.drift.hardcodedColorHits, 0, "Must exclude server ImageResponse OG hex colors");
    assert.equal(ogScan.drift.offGridSpacingHits, 0, "Must exclude server ImageResponse OG padding");
    assert.deepEqual(ogScan.drift.serverImageFiles, ["app/opengraph-image.tsx"]);

    // 7. Monorepo demo skipping + semantic vs palette/scale orphans (FB-20261126-010)
    const monoRoot = join(scratch, "mono-root");
    mkdirSync(join(monoRoot, "demo"), { recursive: true });
    mkdirSync(join(monoRoot, "src"), { recursive: true });
    writeFileSync(join(monoRoot, "demo/prototype.html"), `<div style="color:#ff0000;padding:13px !important;">demo</div>`);
    writeFileSync(join(monoRoot, "src/tokens.css"), `:root { --gray-100: #f3f4f6; --space-400: 16px; --brand-banner-bg: #1d4ed8; }`);
    const monoDefault = scanTarget(monoRoot);
    assert.deepEqual(monoDefault.drift.demoFilesSkipped, ["demo/prototype.html"]);
    assert.equal(monoDefault.drift.hardcodedColorHits, 0, "Default scan must skip demo/ prototypes");
    assert.equal(monoDefault.drift.paletteScaleUnusedCount, 2);
    assert.equal(monoDefault.drift.semanticOrphanCount, 1);
    assert.deepEqual(monoDefault.drift.semanticOrphansSample, ["--brand-banner-bg"]);
    assert.equal(monoDefault.drift.recommendedScope, "src");
    const monoWithDemos = scanTarget(monoRoot, { includeDemos: true });
    assert.ok(monoWithDemos.drift.hardcodedColorHits >= 1, "--include-demos must scan demo/ files");

    // 8. Inline reflex waiver + unused-ignore + SARIF 2.1.0 + GitHub annotation checks (v0.4.0)
    const ciRoot = join(scratch, "ci-root");
    mkdirSync(ciRoot, { recursive: true });
    writeFileSync(
      join(ciRoot, "styles.css"),
      [
        ":root { --brand: #1d4ed8; }",
        "/* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback for legacy canvas */",
        ".legacy { color: #ff00aa; }",
        "/* dsaf-ignore dsaf/important-override -- stale waiver after cleanup */",
        ".clean { color: var(--brand); }",
      ].join("\n")
    );
    const ciRes = scanTarget(ciRoot, { reportUnusedIgnores: true });
    assert.equal(ciRes.ciFindings.counts.waived, 1, "Concrete reflex waiver must waive hardcoded color");
    assert.equal(ciRes.ciFindings.counts.unusedIgnores, 1, "Must detect stale dsaf-ignore");
    assert.ok(ciRes.ciFindings.active.some((f) => f.ruleId === "dsaf/unused-ignore"), "Must emit unused-ignore finding");
    const sarifDoc = formatSarif(ciRes.ciFindings.active, { toolVersion: CI_REPORT_VERSION });
    assert.equal(sarifDoc.version, "2.1.0");
    assert.match(formatGithubAnnotations(ciRes.ciFindings.active), /^::warning .*dsaf\/unused-ignore/m);

    // 7. Exclude _audit/ and storybook-static/ (no DTCG double-count) + resolve @theme animate/ease + prefixed breakpoint scale vars
    const cleanRoot = join(scratch, "clean-ds");
    mkdirSync(join(cleanRoot, "tokens"), { recursive: true });
    mkdirSync(join(cleanRoot, "storybook-static/tokens"), { recursive: true });
    mkdirSync(join(cleanRoot, "_audit"), { recursive: true });
    mkdirSync(join(cleanRoot, "src"), { recursive: true });
    const dtcgSample = JSON.stringify({ color: { brand: { $type: "color", $value: "#1d4ed8" } } });
    writeFileSync(join(cleanRoot, "tokens/tokens.dtcg.json"), dtcgSample);
    writeFileSync(join(cleanRoot, "storybook-static/tokens/tokens.dtcg.json"), dtcgSample);
    writeFileSync(join(cleanRoot, "_audit/probe.html"), `<div style="color:#ff00aa;padding:13px;">probe</div>`);
    writeFileSync(join(cleanRoot, "src/styles.css"), `@theme { --animate-fade-in: fade 200ms; --ds-breakpoint-sm: 640px; }\n.ok { color: #1d4ed8; }\n`);
    writeFileSync(join(cleanRoot, "src/App.tsx"), `<div className="animate-fade-in" />`);
    const dsScan = scanTarget(cleanRoot);
    assert.equal(dsScan.filesScanned.tokenJson, 1, "Must exclude storybook-static DTCG duplicate");
    assert.equal(dsScan.dtcg.tokenCount, 1);
    assert.equal(dsScan.drift.offGridSpacingHits, 0, "Must exclude _audit verification HTML");
    assert.ok(!dsScan.drift.semanticOrphansSample.includes("--animate-fade-in"), "Must resolve @theme --animate-* utility classes");
    assert.ok(!dsScan.drift.semanticOrphansSample.includes("--ds-breakpoint-sm"), "Must treat prefixed breakpoint vars as scale tokens");

    // 8. Inline <svg> colors & theme swatch table separation vs inline style={}
    const svgSwatchDir = join(scratch, "svg-swatch");
    mkdirSync(svgSwatchDir, { recursive: true });
    writeFileSync(
      join(svgSwatchDir, "Swatches.tsx"),
      [
        `const THEME_SWATCHES = ["#FFFDF8", "#45210E", "#F4BA17"];`,
        `export function Logo() {`,
        `  return (`,
        `    <div>`,
        `      <svg viewBox="0 0 24 24"><path d="M0 0" fill="#F4BA17" stroke="#45210E" /></svg>`,
        `      <span style={{ color: "#e11d48" }}>Alert</span>`,
        `    </div>`,
        `  );`,
        `}`,
      ].join("\n")
    );
    const svgScan = scanTarget(svgSwatchDir);
    assert.equal(svgScan.drift.svgPaletteHits, 2, "Must count <svg> color literals separately");
    assert.equal(svgScan.drift.swatchPaletteHits, 3, "Must count swatch table literals separately");
    assert.equal(svgScan.drift.hardcodedColorHits, 1, "Must still enforce inline style={} hardcoded hexes");
    assert.equal(svgScan.ciFindings.active.filter((f) => f.ruleId === "dsaf/hardcoded-color").length, 1);

    // Monorepo tokens/color.json + tokens/foundations.json discovery
    const monoTokDir = join(scratch, "mono-tokens/packages/design/tokens");
    mkdirSync(monoTokDir, { recursive: true });
    writeFileSync(join(monoTokDir, "color.json"), JSON.stringify({ light: { bg: { $type: "color", $value: "#F7F8FA" } }, dark: { bg: { $type: "color", $value: "#0A111D" } } }));
    writeFileSync(join(monoTokDir, "meta.json"), JSON.stringify({ title: "ignore non-dtcg" }));
    const monoTokScan = scanTarget(join(scratch, "mono-tokens"));
    assert.equal(monoTokScan.dtcg.tokenCount, 2, "Must discover DTCG tokens inside packages/*/tokens/color.json");

    // Round 1 regressions: >12 contrast pair failures, self-contrast, non-sRGB oklch object, `description` key name,
    // CSS ID #feed / decimal 0.5px / rgba(var(--...)) false positives, hover:bg-[#ef4444], [data-theme="dark"] .card, nested swatches
    const regDir = join(scratch, "reg-dir");
    mkdirSync(join(regDir, "tokens/semantic"), { recursive: true });
    const manyBg = {};
    for (let i = 1; i <= 6; i++) manyBg[`bg${i}`] = { $type: "color", $value: "#ffffff" };
    writeFileSync(
      join(regDir, "tokens/semantic/color.json"),
      JSON.stringify({
        light: {
          surface: manyBg,
          card: { text: { $type: "color", $value: "#111827" } },
          text: {
            description: { $type: "color", $value: "#111827" },
            primary: { $type: "color", $value: "#111827" },
            secondary: { $type: "color", $value: "#222222" },
            bad: { $type: "color", $value: "#cccccc" },
            oklchText: { $type: "color", $value: { colorSpace: "oklch", components: [0.2, 0.02, 250] } },
          },
          bgOklch: { surface: { $type: "color", $value: { colorSpace: "oklch", components: [0.98, 0.01, 250] } } },
        },
        dark: {
          surface: manyBg,
          card: { text: { $type: "color", $value: "#f8fafc" } },
          text: {
            description: { $type: "color", $value: "#f8fafc" },
            primary: { $type: "color", $value: "#f8fafc" },
            secondary: { $type: "color", $value: "#e5e7eb" },
            bad: { $type: "color", $value: "#111111" },
          },
        },
      })
    );
    writeFileSync(
      join(regDir, "view.css"),
      [
        ":root { --brand-rgb: 29, 78, 216; --ink: #111827; }",
        "#feed { display: grid; }",
        ".ok { color: rgba(var(--brand-rgb), 0.5); padding: 0.5px; }",
        ".btn--primary:hover { color: var(--ink); }",
        `[data-theme="dark"] .card { color: #ff00aa !important; }`,
      ].join("\n")
    );
    writeFileSync(
      join(regDir, "Comp.tsx"),
      [
        `const BRAND_PALETTE = { light: { bg: "#ffffff" }, dark: { bg: "#0a111d" } };`,
        `export const Comp = () => <a href="#facade" style="margin: 0; font-size: 13px;" className="hover:bg-[#ef4444] bg-slate-950" />;`,
      ].join("\n")
    );
    const regScan = scanTarget(regDir);
    assert.ok(regScan.dtcg.tokenCount >= 22, "Must count nested semantic DTCG tokens incl. `description`");
    assert.equal(regScan.ciFindings.counts.floor, regScan.dtcgModes.contrast.wcagFailures, "Must emit Floor findings for ALL failing DTCG pairs even past pair #12");
    assert.ok(!regScan.dtcgModes.contrast.failingPairs.some((p) => p.fg === "light.card.text" && p.bg === "light.card.text"), "Must never pair token against itself");
    assert.equal(regScan.drift.hardcodedColorHits, 1, "Only [data-theme=dark] .card #ff00aa should be hardcoded color drift (not #feed, #facade, rgba(var), swatch, or hover:bg-[#ef4444])");
    assert.equal(regScan.drift.importantOverrides, 1, "Must detect [data-theme=dark] .card !important");
    assert.equal(regScan.drift.offGridSpacingHits, 0, "Decimal 0.5px and inline font-size: 13px after margin: 0 must NOT trigger offGridSpacingHits");
    assert.equal(regScan.drift.orphanCssVariableCount, 0, "BEM selector .btn--primary:hover must NOT register --primary as orphan CSS variable");
    assert.equal(regScan.drift.tailwind.arbitraryColors, 1, "Must catch hover:bg-[#ef4444]");
    assert.equal(regScan.drift.tailwind.primitiveColors, 1, "Must catch bg-slate-950");

    // Round 2 regressions: waivable semantic-orphan-var, multiline leading newline line numbers, <style> in .html + url(#id),
    // nested DTCG group named `value`, `"none"` sRGB channel, --scope same-name nested subdir SARIF URI
    const r2Dir = join(scratch, "r2-tokens");
    mkdirSync(join(r2Dir, "app/app"), { recursive: true });
    writeFileSync(
      join(r2Dir, "app/app/page.html"),
      [
        "<style>",
        "#feed { display: grid; }",
        ".icon { clip-path: url(#fade); }",
        ".card { padding-top: 13px; border-radius: 7px; }",
        "</style>",
        `<div style="padding-left: 11px;">`,
        `<div className="\nbg-[#ef4444]\np-[15px]\n" />`,
        `</div>`,
      ].join("\n")
    );
    writeFileSync(
      join(r2Dir, "app/app/tokens.css"),
      [
        "/* dsaf-ignore dsaf/semantic-orphan-var -- public theme hook consumed by host shell */",
        ":root { --host-hook-color: #1d4ed8; }",
      ].join("\n")
    );
    const r2Scan = scanTarget(r2Dir, { scope: "app", reportUnusedIgnores: true });
    assert.equal(r2Scan.drift.hardcodedColorHits, 0, "HTML <style> #feed selector and url(#fade) must NOT trigger hardcodedColorHits");
    assert.equal(r2Scan.drift.offGridSpacingHits, 3, "Must detect padding-top: 13px, border-radius: 7px in <style> + padding-left: 11px in style attr");
    assert.equal(r2Scan.ciFindings.counts.unusedIgnores, 0, "dsaf-ignore dsaf/semantic-orphan-var must waive cleanly without unused-ignore");
    assert.ok(!r2Scan.ciFindings.active.some((f) => f.ruleId === "dsaf/semantic-orphan-var"));
    const twBgFinding = r2Scan.ciFindings.active.find((f) => f.ruleId === "dsaf/tailwind-arbitrary" && f.message.includes("bg-[#ef4444]"));
    assert.equal(twBgFinding?.line, 8, "Tailwind class after leading newline must report exact line 8");

    const valGroup = validateDtcgTokens({
      metric: {
        value: { positive: { $type: "color", $value: "#16a34a" } },
        label: { $type: "color", $value: "#111827" },
      },
    });
    assert.equal(valGroup.tokenCount, 2, "Nested group named `value` must not be swallowed as legacy leaf");
    const noneColor = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: { primary: { $type: "color", $value: { colorSpace: "srgb", components: [0.05, "none", 0.05] } } },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      },
    });
    assert.equal(noneColor.contrast.wcagFailures, 0, 'DTCG "none" color component must resolve cleanly without NaN');

    // Round 3 regressions: translucent 4/8 hex & DTCG alpha<1, broken JSON pointer prefix, nested $value.$ref,
    // &--primary modifier, quoted {/; in selector header, url("#fade") & href={"#facade"}
    const r3Tok = analyzeDtcgModesAndContrast({
      light: {
        surface: {
          default: { $type: "color", $value: "#ffffff" },
          scrim4: { $type: "color", $value: "#0004" },
          scrim8: { $type: "color", $value: "#00000014" },
          overlay: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.08 } },
        },
        text: { primary: { $type: "color", $value: "#111827" } },
      },
    });
    assert.equal(r3Tok.contrast.wcagFailures, 0, "Translucent hex/sRGB overlays must not fail text contrast");
    const r3BrokenPtr = validateDtcgTokens({
      primitive: { blue: { $type: "color", $value: "#1d4ed8" } },
      broken: { $ref: "#/primitive/blue/nonexistent" },
    });
    assert.equal(r3BrokenPtr.blockingIssues.length, 1, "Broken JSON pointer suffix must trigger unresolved_reference");
    const r3NestedRef = validateDtcgTokens({
      primitive: { blue: { $type: "color", $value: "#1d4ed8" } },
      nested: { $value: { $ref: "#/primitive/blue" } },
    });
    assert.equal(r3NestedRef.blockingIssues.length, 0);
    assert.equal(r3NestedRef.aliasCount, 1, "Nested $value.$ref must count toward aliasCount");
    assert.equal(r3NestedRef.missingTypeIssues.length, 0, "Nested $value.$ref must inherit resolved $type");

    const r3Dir = join(scratch, "r3-tokens");
    mkdirSync(join(r3Dir, "src"), { recursive: true });
    mkdirSync(join(r3Dir, "dsaf-audit-output"), { recursive: true });
    writeFileSync(join(r3Dir, "dsaf-audit-output/ignore.css"), ".x { color: #ff00aa; }\n");
    writeFileSync(
      join(r3Dir, "src/styles.scss"),
      [
        '.btn { &--primary:hover { color: #ff00aa; padding: 13px; } }',
        '.icon { clip-path: url("#fade"); filter: url(\'#beef\'); }',
        '.quoted-brace { background: #123456 url("icon-{1}.png"); }',
        '#feed[data-x="a;b"] { color: var(--ink); }',
      ].join("\n")
    );
    writeFileSync(
      join(r3Dir, "src/Link.tsx"),
      `<><a href="/#facade">A</a><a href={"#facade"}>B</a></>\n`
    );
    const r3Scan = scanTarget(r3Dir);
    assert.equal(r3Scan.drift.hardcodedColorHits, 2, "Must detect #ff00aa in &--primary and #123456 with url({), ignoring url(#fade), #feed[data-x=a;b], href=#facade, and dsaf-audit-output");
    assert.equal(r3Scan.drift.orphanCssVariableCount, 0, "&--primary must not register --primary as orphan CSS var");

    // Round 4 regressions: dark.text.light mode priority, @theme static + quoted braces, url("/icons/#fade"), multiline style attr
    const r4Modes = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: { light: { $type: "color", $value: "#374151" } },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { light: { $type: "color", $value: "#d1d5db" } },
      },
    });
    assert.equal(r4Modes.parity.missingInDark.length, 0, "dark.text.light must classify as dark mode");
    assert.equal(r4Modes.contrast.wcagFailures, 0, "dark.text.light must pair against dark surface");

    const r4Dir = join(scratch, "r4-tokens");
    mkdirSync(join(r4Dir, "src"), { recursive: true });
    writeFileSync(
      join(r4Dir, "src/theme.css"),
      [
        '@theme static {',
        '  --open-quote: "{";',
        '  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.12);',
        '  --color-brand: #1d4ed8;',
        '}',
        '.icon { background: url("/icons/#fade"); }',
      ].join("\n")
    );
    writeFileSync(
      join(r4Dir, "src/Panel.html"),
      `<div class="bg-brand shadow-card" style="padding-top: 13px;\n  border-radius: 7px;">Hi</div>\n`
    );
    const r4Scan = scanTarget(r4Dir);
    assert.equal(r4Scan.drift.hardcodedColorHits, 0, "@theme static with quoted '{' and url('/icons/#fade') must yield 0 hardcodedColorHits");
    assert.equal(r4Scan.drift.offGridSpacingHits, 2, "Multiline HTML style= must catch both 13px and 7px off-grid spacing");

    // Round 5 regressions: multi-file light.json + dark.json, on-<role> inverted foreground pairing, auth-token.json exclusion,
    // Tailwind !/negative spacing & @theme usage, SCSS $padding exclusion, multiline CSS custom properties
    const r5Modes = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        brand: { primary: { $type: "color", $value: "#1d4ed8" } },
        text: { "on-primary": { $type: "color", $value: "#ffffff" } },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        brand: { primary: { $type: "color", $value: "#93c5fd" } },
        text: { "on-primary": { $type: "color", $value: "#0b0f19" } },
      },
    });
    assert.equal(r5Modes.contrast.wcagFailures, 0, "on-primary must pair with primary, not neutral surface");

    const r5Dir = join(scratch, "r5-tokens");
    mkdirSync(join(r5Dir, "tokens"), { recursive: true });
    mkdirSync(join(r5Dir, "config"), { recursive: true });
    mkdirSync(join(r5Dir, "src"), { recursive: true });
    writeFileSync(
      join(r5Dir, "tokens/light.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: { primary: { $type: "color", $value: "#111827" } },
      })
    );
    writeFileSync(
      join(r5Dir, "tokens/dark.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      })
    );
    writeFileSync(join(r5Dir, "config/oauth-token.json"), JSON.stringify({ access: { value: "{env.SECRET}" } }));
    writeFileSync(
      join(r5Dir, "src/comp.scss"),
      [
        "@theme { --color-brand-accent: #1d4ed8; }",
        ".card {",
        "  $padding: 13px;",
        "  --card-shadow:",
        "    0 2px 8px #111111;",
        "  box-shadow: var(--card-shadow);",
        "}",
      ].join("\n")
    );
    writeFileSync(
      join(r5Dir, "src/App.tsx"),
      `<div className="!bg-[#ef4444] !p-[13px] !text-slate-500 !bg-brand-accent -mt-[13px]" />\n`
    );
    const r5Scan = scanTarget(r5Dir);
    assert.equal(r5Scan.dtcgModes.parity.hasModes, true, "Split light.json + dark.json must establish light/dark parity");
    assert.equal(r5Scan.dtcgModes.contrast.wcagFailures, 0, "Split light.json + dark.json must not cross-pair modes");
    assert.equal(r5Scan.ciFindings.counts.floor, 0, "Auth/OAuth token JSON must not emit unresolved DTCG ref");
    assert.equal(r5Scan.drift.hardcodedColorHits, 0, "Multiline custom property #111111 and [!#...] TW must not emit CSS hardcodedColorHits");
    assert.equal(r5Scan.drift.offGridSpacingHits, 0, "SCSS $padding: 13px must not emit offGridSpacingHits");
    assert.equal(r5Scan.drift.tailwind.arbitraryColors, 1);
    assert.equal(r5Scan.drift.tailwind.arbitrarySpacing, 2);
    assert.equal(r5Scan.drift.tailwind.primitiveColors, 1);
    assert.equal(r5Scan.drift.orphanCssVariableCount, 0, "!bg-brand-accent must credit @theme --color-brand-accent");

    // Round 6 regressions: $extensions.mode alias resolution, symmetric inverse pairing, on-brand-primary, split light.json text.light,
    // single-file dark-app/ path guard, JS --retries ternary not registering orphan or erasing hex
    const r6ExtModes = analyzeDtcgModesAndContrast({
      surface: {
        base: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } } },
        card: { $type: "color", $value: "{surface.base}" },
        inverse: { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "#ffffff" } } },
      },
      brand: {
        primary: { $type: "color", $value: "#1d4ed8", $extensions: { mode: { light: "#1d4ed8", dark: "#93c5fd" } } },
      },
      text: {
        primary: { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "#f8fafc" } } },
        "on-surface": { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "#f8fafc" } } },
        "on-brand-primary": { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } } },
      },
      "text-bad": {
        "on-brand-primary": { $type: "color", $value: "#93c5fd", $extensions: { mode: { light: "#93c5fd", dark: "#1d4ed8" } } },
      },
    });
    assert.ok(r6ExtModes.contrast.failingPairs.some((p) => p.fg === "text-bad.on-brand-primary"), "Hyphenated on-brand-primary must evaluate contrast");
    assert.ok(
      !r6ExtModes.contrast.failingPairs.some((p) => p.bg === "surface.inverse" && (p.fg === "text.primary" || p.fg === "text.on-surface")),
      "Non-inverse text/on-surface must not pair against surface.inverse"
    );
    const r6CardAlias = analyzeDtcgModesAndContrast({
      surface: {
        default: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } } },
        card: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "{surface.default}", dark: "{surface.default}" } } },
      },
      text: { primary: { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "#f8fafc" } } } },
    });
    assert.equal(r6CardAlias.contrast.wcagFailures, 0, "$extensions.mode aliases must resolve using active mode");

    const r6SplitDir = join(scratch, "r6-split/tokens");
    mkdirSync(r6SplitDir, { recursive: true });
    writeFileSync(
      join(r6SplitDir, "light.json"),
      JSON.stringify({ surface: { default: { $type: "color", $value: "#ffffff" } }, text: { light: { $type: "color", $value: "#374151" } } })
    );
    writeFileSync(
      join(r6SplitDir, "dark.json"),
      JSON.stringify({ surface: { default: { $type: "color", $value: "#0b0f19" } }, text: { light: { $type: "color", $value: "#d1d5db" } } })
    );
    const r6SplitScan = scanTarget(join(scratch, "r6-split"));
    assert.equal(r6SplitScan.dtcgModes.parity.hasModes, true);
    assert.equal(r6SplitScan.dtcgModes.contrast.wcagFailures, 0, "Split light.json/dark.json leaf text.light must prefix cleanly without collision");

    const darkAppDir = join(scratch, "dark-app");
    mkdirSync(darkAppDir, { recursive: true });
    const singleFileTok = join(darkAppDir, "tokens.json");
    writeFileSync(
      singleFileTok,
      JSON.stringify({
        light: { surface: { default: { $type: "color", $value: "#ffffff" } }, text: { primary: { $type: "color", $value: "#111827" } } },
        dark: { surface: { default: { $type: "color", $value: "#0b0f19" } }, text: { primary: { $type: "color", $value: "#f8fafc" } } },
      })
    );
    const singleDarkScan = scanTarget(singleFileTok);
    assert.equal(singleDarkScan.dtcgModes.parity.missingInLight.length, 0, "Ancestor dir named dark-app must not alter single-file mode detection");

    const r6JsScss = join(scratch, "r6-js-scss");
    mkdirSync(r6JsScss, { recursive: true });
    writeFileSync(
      join(r6JsScss, "grad.scss"),
      `.grad { background: linear-gradient(#ff00aa, #{$end}); }\n`
    );
    writeFileSync(
      join(r6JsScss, "Retries.tsx"),
      [
        `export const X = ({ flag, retries }: { flag: boolean; retries: number }) => (`,
        `  <span data-c={flag ? --retries : "#ff00aa"} />`,
        `);`,
      ].join("\n")
    );
    const r6JsScssScan = scanTarget(r6JsScss);
    assert.equal(r6JsScssScan.drift.orphanCssVariableCount, 0, "JS --retries decrement must not register CSS custom prop");
    assert.equal(r6JsScssScan.drift.hardcodedColorHits, 2, "SCSS #{...} #ff00aa and JS ternary #ff00aa must both be flagged");

    // Round 7 regressions: $extensions.mode broken/circular refs, missing light fallback + mode-invariant base tokens,
    // on-surface-inverse pairing, nested-paren custom prop, scoped !important, nested quotes in style="...", >50 orphans
    const r7ModeIssue = validateDtcgTokens({
      surface: { default: { $type: "color", $value: "#ffffff" } },
      text: {
        a: { $type: "color", $value: "#111827", $extensions: { mode: { light: "{text.missing}", dark: "{text.b}" } } },
        b: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "{text.a}" } } },
      },
    });
    assert.ok(r7ModeIssue.blockingIssues.some((i) => i.type === "unresolved_reference"), "$extensions.mode unresolved ref must fail");
    assert.ok(r7ModeIssue.blockingIssues.some((i) => i.type === "circular_reference"), "$extensions.mode circular ref must fail");

    const r7InvModes = analyzeDtcgModesAndContrast({
      surface: {
        default: { $type: "color", $value: "#ffffff" },
        inverse: { $type: "color", $value: "#111827" },
      },
      text: {
        primary: { $type: "color", $value: "#f8fafc", $extensions: { mode: { dark: "#f1f5f9" } } },
        "on-surface-inverse": { $type: "color", $value: "#ffffff" },
      },
    });
    assert.equal(r7InvModes.parity.missingInLight.length, 0, "Base $value acts as light mode when $extensions.mode omits light");
    assert.ok(r7InvModes.contrast.failingPairs.some((p) => p.fg === "text.primary" && p.mode === "light"), "Invariant surface.default must pair in light mode");
    assert.ok(r7InvModes.contrast.failingPairs.some((p) => p.fg === "text.primary" && p.mode === "dark"), "Invariant surface.default must pair in dark mode");
    assert.ok(
      !r7InvModes.contrast.failingPairs.some((p) => p.fg === "text.on-surface-inverse" && p.bg === "surface.default"),
      "text.on-surface-inverse must skip surface.default and pair with surface.inverse"
    );

    const r7Dir = join(scratch, "r7-tokens-fixes");
    mkdirSync(r7Dir, { recursive: true });
    const fiftyFiveOrphans = Array.from({ length: 55 }, (_, i) => `  --semantic-orphan-${String(i + 1).padStart(2, "0")}: ${i + 1}px;`).join("\n");
    writeFileSync(
      join(r7Dir, "orphans.css"),
      [
        ":root {",
        fiftyFiveOrphans,
        "  --sh: 0 2px color-mix(in srgb, #123456 50%, var(--a, rgb(1,2,3))) !important;",
        "}",
        "/* dsaf-ignore dsaf/semantic-orphan-var -- intentional token kept for downstream consumer */",
        ".card { color: var(--semantic-orphan-55, #000000); }",
      ].join("\n")
    );
    writeFileSync(
      join(r7Dir, "App.tsx"),
      [
        "export function App(important: boolean) {",
        "  if (!important) return <div style=\"font-family: 'Inter', sans-serif; margin: 13px\">hi</div>;",
        "  return <div style={{ color: 'red !important' }}>ok</div>;",
        "}",
      ].join("\n")
    );
    const r7Scan = scanTarget(r7Dir, { reportUnusedIgnores: true });
    assert.equal(r7Scan.drift.importantOverrides, 1, "Only JSX style={{...}} !important must count (not CSS var or JS !important)");
    assert.equal(r7Scan.drift.offGridSpacingHits, 1, "Nested single quote inside HTML style=\"...\" must not hide 13px");
    assert.ok(r7Scan.drift.semanticOrphanCount >= 54);
    assert.equal(
      r7Scan.ciFindings.active.filter((f) => f.ruleId === "dsaf/semantic-orphan-var").length,
      r7Scan.drift.semanticOrphanCount,
      "Must emit all >50 semantic orphan findings without truncation"
    );

    // Round 8 regressions: base.json + dark.json no shadow/missingInLight, cross-mode acyclic swap,
    // camelCase onBrandPrimary/onSurfaceInverse + surface.inverseSurface, non-theme $extensions.mode, nested auth token JSON
    const r8BaseDark = analyzeDtcgModesAndContrast({
      base: {
        surface: { canvas: { $type: "color", $value: "#ffffff" } },
        text: { primary: { $type: "color", $value: "#111827" } },
      },
      dark: {
        base: {
          surface: { canvas: { $type: "color", $value: "#0f172a" } },
          text: { primary: { $type: "color", $value: "#f8fafc" } },
        },
      },
    });
    assert.equal(r8BaseDark.parity.missingInLight.length, 0, "Base tokens overridden in dark must fill light without missingInLight");
    assert.equal(r8BaseDark.parity.missingInDark.length, 0);
    assert.equal(r8BaseDark.contrast.failingPairs.length, 0, "Light #111827 on dark #0f172a must NOT pair cleanly");

    const r8CrossSwap = validateDtcgTokens({
      a: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "{b}", dark: "#ffffff" } } },
      b: { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "{a}" } } },
    });
    assert.equal(
      r8CrossSwap.blockingIssues.filter((i) => i.type === "circular_reference").length,
      0,
      "Acyclic cross-mode token swap must not report circular_reference"
    );

    const r8Camel = analyzeDtcgModesAndContrast({
      brand: { primary: { $type: "color", $value: "#1d4ed8" } },
      surface: {
        default: { $type: "color", $value: "#ffffff" },
        inverseSurface: { $type: "color", $value: "#0f172a" },
      },
      text: {
        onBrandPrimary: { $type: "color", $value: "#ffffff" },
        onSurfaceInverse: { $type: "color", $value: "#ffffff" },
      },
    });
    assert.ok(
      r8Camel.contrast.samplePairs.some((p) => p.fg === "text.onBrandPrimary" && p.bg === "brand.primary"),
      "camelCase onBrandPrimary must match brand.primary"
    );
    assert.ok(
      !r8Camel.contrast.samplePairs.some((p) => p.fg === "text.onSurfaceInverse" && p.bg === "surface.default"),
      "camelCase onSurfaceInverse must not pair with light surface.default"
    );
    assert.ok(
      r8Camel.contrast.samplePairs.some((p) => p.fg === "text.onSurfaceInverse" && p.bg === "surface.inverseSurface"),
      "camelCase onSurfaceInverse must pair with surface.inverseSurface"
    );

    const r8Density = analyzeDtcgModesAndContrast({
      spacing: { gap: { $type: "dimension", $value: "8px", $extensions: { mode: { compact: "4px", comfortable: "12px" } } } },
    });
    assert.equal(r8Density.parity.hasModes, false, "Non-theme density modes must not trigger dark mode parity errors");
    assert.equal(r8Density.parity.missingInDark.length, 0);

    const r8AuthDir = join(scratch, "r8-auth-json");
    mkdirSync(join(r8AuthDir, "config"), { recursive: true });
    mkdirSync(join(r8AuthDir, "tokens"), { recursive: true });
    writeFileSync(join(r8AuthDir, "config/github-access-token.json"), JSON.stringify({ token: "secret" }));
    writeFileSync(join(r8AuthDir, "google-oauth-tokens.json"), JSON.stringify({ token: "secret" }));
    writeFileSync(join(r8AuthDir, "stripe-api-token.json"), JSON.stringify({ token: "secret" }));
    writeFileSync(join(r8AuthDir, "tokens/color-tokens.json"), JSON.stringify({ bg: { $type: "color", $value: "#ffffff" } }));
    const r8AuthScan = scanTarget(r8AuthDir);
    assert.equal(r8AuthScan.filesScanned.tokenJson, 1, "Auth token files with hyphenated prefixes must be excluded");

    // Round 9 regressions (R9-A2-04, R9-A2-05, R9-A2-06, R9-A2-12): light-dark merged filename, on-light/on-dark & border exclusion,
    // Vue :style off-grid spacing, data-style exclusions, auth/tokens.json & tokenizer.json exclusions
    const r9Dir = join(scratch, "r9-tok-dir");
    mkdirSync(join(r9Dir, "tokens"), { recursive: true });
    mkdirSync(join(r9Dir, "auth"), { recursive: true });
    mkdirSync(join(r9Dir, "src"), { recursive: true });
    writeFileSync(
      join(r9Dir, "tokens/light-dark.tokens.json"),
      JSON.stringify({
        primitive: { blue: { $type: "color", $value: "#1d4ed8" }, darkBlue: { $type: "color", $value: "#93c5fd" } },
        light: { brand: { $type: "color", $value: "{primitive.blue}" }, surface: { default: { $type: "color", $value: "#ffffff" } }, text: { primary: { $type: "color", $value: "#111827" } } },
        dark: { brand: { $type: "color", $value: "{primitive.darkBlue}" }, surface: { default: { $type: "color", $value: "#0b0f19" } }, text: { primary: { $type: "color", $value: "#f8fafc" } } },
      })
    );
    writeFileSync(join(r9Dir, "auth/tokens.json"), JSON.stringify({ access: { $value: "{env.SECRET}" } }));
    writeFileSync(join(r9Dir, "tokenizer.json"), JSON.stringify({ model: { vocab: { a: 0 } } }));
    writeFileSync(join(r9Dir, "src/VueSpacing.vue"), `<template><div :style="{ padding: '13px', marginTop: '17px' }" data-style="padding: 13px; color: red !important">Hi</div></template>\n`);
    const r9Scan = scanTarget(r9Dir);
    assert.equal(r9Scan.filesScanned.tokenJson, 1, "Only tokens/light-dark.tokens.json must count; auth/tokens.json and tokenizer.json excluded");
    assert.equal(r9Scan.dtcg.blockingIssues.length, 0, "Shared primitives in light-dark.tokens.json must resolve cleanly");
    assert.equal(r9Scan.dtcgModes.parity.missingInDark.length, 0);
    assert.equal(r9Scan.dtcgModes.contrast.wcagFailures, 0);
    assert.equal(r9Scan.drift.offGridSpacingHits, 2, "Vue :style off-grid spacing must hit 2 while data-style hits 0");
    assert.equal(r9Scan.drift.importantOverrides, 0, "data-style !important must not trigger");

    const r9OnLightDark = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        accent: { primary: { $type: "color", $value: "#1d4ed8" } },
        text: { "on-light": { $type: "color", $value: "#111827" } },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        accent: { primary: { $type: "color", $value: "#93c5fd" } },
        text: { "on-dark": { $type: "color", $value: "#f8fafc" } },
      },
    });
    assert.equal(r9OnLightDark.contrast.wcagFailures, 0, "on-light/on-dark must not pair with accent colors");

    const r9BorderRole = analyzeDtcgModesAndContrast({
      brand: { primary: { $type: "color", $value: "#1d4ed8" } },
      border: { primary: { $type: "color", $value: "#e2e8f0" } },
      text: { "on-primary": { $type: "color", $value: "#ffffff" } },
    });
    assert.equal(r9BorderRole.contrast.wcagFailures, 0, "text.on-primary must never pair against border.primary");

    // Round 10 regressions (R10-A2-08, R10-A2-13, R10-A2-14, R10-A2-15, R10-A2-17, R10-A2-19):
    // parity-complete light/dark with on-light & on-dark, capitalized $extensions.mode Light/Dark,
    // snake_case text.on_primary, .astro files, nested auth/google/tokens.json exclusion, Vue quoted kebab :style keys
    const r10ParityOnLightDark = analyzeDtcgModesAndContrast({
      light: {
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: {
          "on-light": { $type: "color", $value: "#111827" },
          "on-dark": { $type: "color", $value: "#f8fafc" },
        },
      },
      dark: {
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: {
          "on-light": { $type: "color", $value: "#111827" },
          "on-dark": { $type: "color", $value: "#f8fafc" },
        },
      },
    });
    assert.equal(r10ParityOnLightDark.parity.missingInDark.length, 0);
    assert.equal(r10ParityOnLightDark.contrast.wcagFailures, 0, "on-light/on-dark in parity-complete themed set must respect mode polarity");

    const r10CapExt = analyzeDtcgModesAndContrast({
      surface: { default: { $type: "color", $value: "#ffffff", $extensions: { mode: { Light: "#ffffff", Dark: "#0b0f19" } } } },
      text: { primary: { $type: "color", $value: "#111827", $extensions: { mode: { Light: "#111827", Dark: "#111827" } } } },
    });
    assert.equal(r10CapExt.parity.hasModes, true, "Capitalized Light/Dark $extensions.mode must be detected");
    assert.equal(r10CapExt.contrast.wcagFailures, 1, "Failing capitalized Dark contrast pair must be caught");

    const r10SnakeRole = analyzeDtcgModesAndContrast({
      surface: { default: { $type: "color", $value: "#ffffff" } },
      brand: { primary: { $type: "color", $value: "#1d4ed8" } },
      text: { on_primary: { $type: "color", $value: "#ffffff" } },
    });
    assert.equal(r10SnakeRole.contrast.wcagFailures, 0, "Snake_case text.on_primary must pair with brand.primary, not surface.default");

    const r10Dir = join(scratch, "r10-tok-dir");
    mkdirSync(join(r10Dir, "auth/google"), { recursive: true });
    mkdirSync(join(r10Dir, "src/components"), { recursive: true });
    writeFileSync(join(r10Dir, "auth/google/tokens.json"), JSON.stringify({ access: { $type: "color", $value: "#ff00aa" } }));
    writeFileSync(join(r10Dir, "src/components/Card.astro"), "<style>.box { color: #ff00aa; }</style>\n<div class='p-4'>Hi</div>\n");
    writeFileSync(
      join(r10Dir, "src/components/VueQuoted.vue"),
      `<template><div :style="{ 'padding-top': '13px', 'border-radius': '7px', 'margin': '17px' }">Hi</div></template>\n`
    );
    const r10Scan = scanTarget(r10Dir);
    assert.equal(r10Scan.filesScanned.tokenJson, 0, "Nested auth/google/tokens.json must be excluded");
    assert.equal(r10Scan.filesScanned.uiAndStyle, 2, "Both .astro and .vue files must be scanned");
    assert.equal(r10Scan.drift.hardcodedColorHits, 1, ".astro <style> hex must be detected");
    assert.equal(r10Scan.drift.offGridSpacingHits, 3, "Vue quoted kebab :style keys must flag all 3 off-grid px values");

    // Round 11 regressions (R11-A2-06, R11-A2-07, R11-A2-14, R11-A2-15, R11-A2-22):
    const r11DtcgDir = join(scratch, "r11-dtcg");
    mkdirSync(join(r11DtcgDir, "tokens"), { recursive: true });
    writeFileSync(
      join(r11DtcgDir, "tokens/tokens.json"),
      JSON.stringify({
        font: { weight: { light: { $type: "fontWeight", $value: 300 }, bold: { $type: "fontWeight", $value: 700 } } },
        color: { "surface-default": { $type: "color", $value: "#ffffff" }, "text-primary": { $type: "color", $value: "#ffffff" } },
      })
    );
    const r11Res = scanTarget(r11DtcgDir);
    assert.equal(r11Res.dtcgModes.parity.hasModes, false, "font.weight.light must not trigger false light/dark mode parity");
    assert.equal(r11Res.dtcgModes.contrast.wcagFailures, 1, "Kebab-case color.text-primary on color.surface-default must detect 1:1 Floor contrast failure");
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          primary: { $type: "color", $value: "#ffffff" },
          onprimary: { $type: "color", $value: "#ffffff" },
        },
      }).contrast.wcagFailures,
      1,
      "Collapsed color.onprimary on color.primary must detect 1:1 Floor contrast failure"
    );

    const r11CycleDir = join(scratch, "r11-cycle");
    mkdirSync(join(r11CycleDir, "tokens"), { recursive: true });
    writeFileSync(
      join(r11CycleDir, "tokens/cycle.json"),
      JSON.stringify({
        a: { $type: "color", $value: "#ffffff", $extensions: { mode: { Dark: "{b}" } } },
        b: { $type: "color", $value: "#000000", $extensions: { mode: { dark: "{a}" } } },
      })
    );
    const r11CycleRes = scanTarget(r11CycleDir);
    assert.equal(
      r11CycleRes.dtcg.blockingIssues.some((i) => i.type === "circular_reference"),
      true,
      "Mixed-case Dark/dark $extensions.mode cycle must be caught"
    );

    const r11UiDir = join(scratch, "r11-ui");
    mkdirSync(join(r11UiDir, "src"), { recursive: true });
    writeFileSync(
      join(r11UiDir, "src/App.css"),
      ".card { color: oklch(calc(0.55 + 0.1) 0.18 var(--brand-hue)); padding: var(--space-13px); border-top-left-radius: 7px; }\n"
    );
    writeFileSync(
      join(r11UiDir, "src/Comp.tsx"),
      [
        'export const Comp = ({ ok }: { ok: boolean }) => <div style={{ padding: ok ? "13px" : "17px" }} />;',
        "export const StyledBox = styled.div`padding: 13px;`;",
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r11UiDir, "src/View.svelte"),
      `<div style="padding: {compact ? '13px' : '17px'}" style:margin="11px">Hi</div>\n`
    );
    const r11UiRes = scanTarget(r11UiDir);
    assert.equal(r11UiRes.drift.hardcodedColorHits, 0, "Nested calc() inside oklch(... var(--brand-hue)) must stay tokenized");
    assert.equal(r11UiRes.drift.offGridSpacingHits, 7, "Off-grid px must ignore --space-13px and catch border-top-left-radius, ternary JSX, styled.div, and Svelte style/style:");

    // Round 12 regressions (R12-A2-07, R12-A2-08, R12-A2-15..18):
    const bigSurfaces = {};
    for (let si = 1; si <= 8; si++) bigSurfaces[`s${si}`] = { $type: "color", $value: "#ffffff" };
    const bigTexts = {};
    for (let ti = 1; ti <= 5; ti++) bigTexts[`t${ti}`] = { $type: "color", $value: "#111827" };
    bigTexts.broken = { $type: "color", $value: "#cccccc" };
    const r12BigContrast = analyzeDtcgModesAndContrast({ surface: bigSurfaces, text: bigTexts });
    assert.equal(r12BigContrast.contrast.pairsEvaluated, 48, "Must evaluate > 36 contrast pairs without truncating");
    assert.equal(r12BigContrast.contrast.wcagFailures, 8, "Must catch all 8 failing pairs past pair #36");

    assert.equal(
      analyzeDtcgModesAndContrast({
        surface: { default: { $type: "color", $value: "#ffffff" }, dark: { $type: "color", $value: "#0b0f19" } },
        text: {
          primary: { $type: "color", $value: "#111827" },
          "on-dark": { $type: "color", $value: "#ffffff" },
          border: { $type: "color", $value: "#cbd5e1" },
          icon: { $type: "color", $value: "#94a3b8" },
        },
      }).contrast.wcagFailures,
      0,
      "Non-text text.border/text.icon and single-theme surface.dark + text.on-dark must produce 0 false contrast failures"
    );

    const r12UiDir = join(scratch, "r12-ui");
    mkdirSync(join(r12UiDir, "src"), { recursive: true });
    writeFileSync(
      join(r12UiDir, "src/Box.tsx"),
      [
        "const Box = styled.div`padding: 16px`;",
        "const Heading = styled.h1`font-size: 13px`;",
        '<div className="border-b-[#ff00aa] divide-[#123456] shadow-[#112233] caret-[#445566] -mt-gutter divide-divider" />',
      ].join("\n") + "\n"
    );
    writeFileSync(join(r12UiDir, "src/theme.css"), "@theme { --spacing-gutter: 12px; --color-divider: #e2e8f0; }\n");
    writeFileSync(join(r12UiDir, "src/V.vue"), "<template><div :style=\"{ color: flag ? --retries : '#ff00aa' }\" /></template>\n");
    writeFileSync(join(r12UiDir, "src/S.svelte"), '<div style:--brand="#1d4ed8" style="color: var(--brand)">Hi</div>\n');
    symlinkSync(join(r12UiDir, "src/nonexistent.css"), join(r12UiDir, "src/broken.css"));
    const r12Scan = scanTarget(r12UiDir);
    assert.equal(r12Scan.drift.offGridSpacingHits, 0, "Single-line styled.div closing backtick must not bleed font-size: 13px into padding:");
    assert.equal(r12Scan.drift.tailwind.arbitraryColors, 4, "Must count border-b, divide, shadow, caret arbitrary colors");
    assert.equal(r12Scan.drift.hardcodedColorHits, 1, "Must count Vue :style #ff00aa and skip Svelte style:--brand");
    assert.equal(r12Scan.drift.orphanCssVariableCount, 0, "Must consume --spacing-gutter via -mt-gutter and --color-divider via divide-divider, and ignore Vue --retries");

    // Round 13 regressions (R13-A2-06, R13-A2-15, R13-A2-16, R13-A2-21):
    assert.equal(
      analyzeDtcgModesAndContrast({
        primitive: {
          ink: { 50: { $type: "color", $value: "#f8fafc" }, 900: { $type: "color", $value: "#0f172a" } },
          surface: { 50: { $type: "color", $value: "#ffffff" }, 900: { $type: "color", $value: "#0b0f19" } },
        },
        light: {
          surface: { default: { $type: "color", $value: "{primitive.surface.50}" } },
          text: { primary: { $type: "color", $value: "{primitive.ink.900}" } },
        },
        dark: {
          surface: { default: { $type: "color", $value: "{primitive.surface.900}" } },
          text: { primary: { $type: "color", $value: "{primitive.ink.50}" } },
        },
      }).contrast.wcagFailures,
      0,
      "2-tier primitive + semantic light/dark DTCG tokens must have 0 contrast failures"
    );
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          primary: { $type: "color", $value: "#1d4ed8" },
          primaryContainer: { $type: "color", $value: "#dbeafe" },
          onPrimary: { $type: "color", $value: "#ffffff" },
          onPrimaryContainer: { $type: "color", $value: "#1e3a8a" },
        },
      }).contrast.wcagFailures,
      0,
      "onPrimary must not cross-pair against primaryContainer"
    );

    const r13TokDir = join(scratch, "r13-tok");
    mkdirSync(join(r13TokDir, "src"), { recursive: true });
    writeFileSync(join(r13TokDir, "src/tokens.css"), ":root { --brand-surface: #ffffff; --brand-ink: #111827; }\n");
    writeFileSync(join(r13TokDir, "src/esc.css"), ".before\\:content-\\[\\'\\*\\'\\] { color: #ff00aa; }\n.btn { color: var(--brand-ink); }\n");
    writeFileSync(
      join(r13TokDir, "src/Card.tsx"),
      [
        'export const Card = () => <div className="bg-(--brand-surface) text-(color:--brand-ink)" />;',
        'export const Dot = ({ onSelect }: { onSelect: () => void }) => <circle cx="12" cy="12" r="6" onClick={() => onSelect()} fill="#F4BA17" />;',
      ].join("\n") + "\n"
    );
    const r13TokScan = scanTarget(r13TokDir);
    assert.equal(r13TokScan.drift.hardcodedColorHits, 1, "Escaped selector quote must not hide #ff00aa while <circle onClick={() => ...}> masks SVG fill");
    assert.equal(r13TokScan.drift.svgPaletteHits, 1, "Standalone SVG <circle> with arrow fn onClick must count as svgPaletteHits");
    assert.equal(r13TokScan.drift.orphanCssVariableCount, 0, "Tailwind v4 bg-(--var) and text-(color:--var) must count as usedVars");
    assert.equal(r13TokScan.drift.colorTokenRefs, 3, "Tailwind v4 var utilities must increment colorTokenRefs alongside var()");

    // Round 14 regressions (R14-A2-13, R14-A2-15, R14-A2-16, R14-A2-18):
    const r14SubRoleAnalysis = analyzeDtcgModesAndContrast({
      color: {
        primaryLight: { $type: "color", $value: "#1d4ed8" },
        primaryLightSubtle: { $type: "color", $value: "#eff6ff" },
        onPrimaryLight: { $type: "color", $value: "#ffffff" },
      },
    });
    assert.equal(r14SubRoleAnalysis.contrast.wcagFailures, 0, "Adjacent camelCase sub-roles (primaryLightSubtle vs onPrimaryLight) must not cross-pair");

    const r14TokDir = join(scratch, "r14-tokens");
    mkdirSync(r14TokDir, { recursive: true });
    writeFileSync(
      join(r14TokDir, "styles.css"),
      ':root { --drawer-offset: 24px; }\n.tip::after { content: "--mode: dark"; }\n'
    );
    writeFileSync(
      join(r14TokDir, "Drawer.tsx"),
      [
        'export const Drawer = ({ compact }: { compact: boolean }) => (',
        '  <div',
        '    className="-mt-(--drawer-offset) -translate-x-(--drawer-offset)"',
        '    style={{',
        '      padding: compact',
        '        ? "13px"',
        '        : "17px",',
        '    }}',
        '  />',
        ');',
      ].join("\n") + "\n"
    );
    const r14TokScan = scanTarget(r14TokDir);
    assert.equal(r14TokScan.drift.orphanCssVariableCount, 0, 'Quoted "--mode: dark" must not become an orphan and negative -mt-(--drawer-offset) must resolve usedVars');
    assert.equal(r14TokScan.drift.colorTokenRefs >= 2, true, "Negative Tailwind v4 var utilities must count in colorTokenRefs");
    assert.equal(r14TokScan.drift.offGridSpacingHits, 2, "Multiline ternary JSX style spacing must flag both 13px and 17px");

    // Round 15 regressions (R15-A2-08, R15-A2-09, R15-A2-12):
    const r15BaseDarkDir = join(scratch, "r15-dtcg-split/tokens");
    mkdirSync(r15BaseDarkDir, { recursive: true });
    writeFileSync(
      join(r15BaseDarkDir, "base.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#ffffff" }, card: { $type: "color", $value: "{surface.default}" } },
        text: { primary: { $type: "color", $value: "#111827" } },
      })
    );
    writeFileSync(
      join(r15BaseDarkDir, "dark.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      })
    );
    const r15SplitScan = scanTarget(join(scratch, "r15-dtcg-split"));
    assert.equal(r15SplitScan.dtcgModes.contrast.wcagFailures, 0, "Dark mode alias surface.card -> {surface.default} must resolve dark.surface.default override");

    const r15SingleTheme = analyzeDtcgModesAndContrast({
      color: {
        primary: { light: { $type: "color", $value: "#93c5fd" }, dark: { $type: "color", $value: "#1e3a8a" } },
        surface: { default: { $type: "color", $value: "#ffffff" }, dark: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#111827" }, onDark: { $type: "color", $value: "#ffffff" } },
      },
    });
    assert.equal(r15SingleTheme.parity.hasModes, false, "Single-theme color.primary.light/dark shade pair must not force hasModes");
    assert.equal(r15SingleTheme.contrast.wcagFailures, 0, "Single-theme palette with surface.dark and onDark must have 0 WCAG contrast failures");

    const r15CssDir = join(scratch, "r15-css");
    mkdirSync(r15CssDir, { recursive: true });
    writeFileSync(
      join(r15CssDir, "styles.css"),
      [
        ":root { --card-variant: elevated; --shadow-md: 0 4px 12px var(--shadow-c); --shadow-c: var(--ink); --ink: #111827; }",
        "@supports ( --brand-primary: #ff00aa ) {",
        "  .card { color: #123456 !important; padding:\n    13px 17px; margin: 8px\n    11px; }",
        "}",
        "@container style(--card-variant: elevated) {",
        "  .card { box-shadow: var(--shadow-md); color: var(--ink); }",
        "}",
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r15CssDir, "Card.tsx"),
      'export const Card = ({ gap }: { gap: string }) => <div style={{ padding: gap === "13px" ? "16px" : "8px" }} />;\n'
    );
    const r15CssScan = scanTarget(r15CssDir);
    assert.equal(r15CssScan.drift.hardcodedColorHits, 1, "@supports ( --brand-primary: #ff00aa ) must preserve #123456 !important inside block");
    assert.equal(r15CssScan.drift.importantOverrides, 1);
    assert.equal(r15CssScan.drift.semanticOrphanCount, 0, "@container style(--card-variant: elevated) must count --card-variant as used");
    assert.equal(r15CssScan.drift.offGridSpacingHits, 3, "Multiline CSS spacing must catch 13px, 17px, and 11px while excluding gap === '13px' comparison");

    // Round 16 regressions (R16-A2-01, R16-A2-08, R16-A2-09, R16-A2-12, R16-A2-15, R16-A2-16, R16-A2-18):
    const r16Dir = join(scratch, "r16-tokens");
    mkdirSync(join(r16Dir, "tokens"), { recursive: true });
    writeFileSync(
      join(r16Dir, "tokens/base.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#ffffff" }, card: { $type: "color", $value: "{surface.default}" } },
        text: { primary: { $type: "color", $value: "#111827" }, "on-light": { $type: "color", $value: "#111827" }, "on-dark": { $type: "color", $value: "#f8fafc" } },
      })
    );
    writeFileSync(
      join(r16Dir, "tokens/dark.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#0b0f19" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      })
    );
    assert.equal(scanTarget(r16Dir).dtcgModes.contrast.wcagFailures, 0, "Split base+dark alias surface.card must not mark isInvariant: true");

    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          surface: { $type: "color", $value: "#ffffff" },
          card: { $type: "color", $value: "#0f172a" },
          onSurface: { $type: "color", $value: "#111827" },
          onCard: { $type: "color", $value: "#ffffff" },
        },
      }).contrast.wcagFailures,
      0,
      "onCard/onSurface must pair with card/surface rather than cross-pairing"
    );
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: { UISurface: { $type: "color", $value: "#ffffff" }, UIText: { $type: "color", $value: "#ffffff" } },
      }).contrast.wcagFailures,
      1,
      "Acronym PascalCase tokens (UISurface / UIText) must pair and catch #fff on #fff fail"
    );

    const r16DriftDir = join(scratch, "r16-drift");
    mkdirSync(r16DriftDir, { recursive: true });
    writeFileSync(
      join(r16DriftDir, "Chart.tsx"),
      [
        "export function Chart() {",
        "  return (",
        "    <div>",
        '      <svg ref={chartRef} className="w-full h-64" />',
        '      <div className="bg-[#ef4444] p-[13px]" style={{ color: "#ff00aa", padding: "13px", margin: "17px !important" }}>Drift!</div>',
        '      <svg viewBox="0 0 24 24"><path d="M0 0" /></svg>',
        "    </div>",
        "  );",
        "}",
      ].join("\n") + "\n"
    );
    writeFileSync(join(r16DriftDir, "Imp.svelte"), '<div style:padding|important="13px" style="padding: {gap === \'13px\' ? \'16px\' : \'8px\'}">Hi</div>\n');
    writeFileSync(
      join(r16DriftDir, "Supports.css"),
      [
        "@supports (--brand-bg: rgb(255, 0, 0)) { .card { color: var(--brand); } }",
        "@container style(--theme-bg: oklch(0.5 0.2 250)) { .card { color: var(--brand); } }",
        "@supports (color: oklch(0.5 0.2 250)) { .card { color: var(--brand); } }",
        "@supports (--brand-primary: #ff00aa !important) { .card { color: var(--brand); } }",
        '@property --brand-glow { syntax: "<color>"; inherits: false; initial-value: #1d4ed8; }',
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r16DriftDir, "JsxFalsePos.tsx"),
      [
        'export const C = ({ gap }: { gap: string }) => <div style={{ padding: `${gap === "13px" ? "16px" : "8px"}` }} />;',
        'export const R = ({ active }: { active: boolean }) => <div style={{ "--ring": active ? "rgba(29, 78, 216, 0.5)" : "rgba(0, 0, 0, 0.1)" }} />;',
        "const G = createGlobalStyle`\n  #feed { display: grid; }\n  #cafe { margin: 0; }\n`;",
      ].join("\n") + "\n"
    );
    const r16DriftScan = scanTarget(r16DriftDir);
    assert.equal(r16DriftScan.drift.hardcodedColorHits, 1, "Only Chart.tsx #ff00aa should be flagged; @supports/@property/custom-prop ternary/createGlobalStyle #id must be exempt");
    assert.equal(r16DriftScan.drift.offGridSpacingHits, 3, "Chart.tsx (13px, 17px) + Imp.svelte style:padding|important (13px), excluding gap === '13px'");
    assert.equal(r16DriftScan.drift.svgPaletteHits, 0);
    assert.equal(r16DriftScan.drift.tailwind.arbitraryColors, 1);
    assert.equal(r16DriftScan.drift.tailwind.arbitrarySpacing, 1);

    // Round 17 regressions (T1-T7 & R17-A4-01 OKLCH/component scoping):
    const r17SplitDir = join(scratch, "r17-split");
    mkdirSync(r17SplitDir, { recursive: true });
    writeFileSync(
      join(r17SplitDir, "base.tokens.json"),
      JSON.stringify({ surface: { card: { $type: "color", $value: "{surface.default}" } } })
    );
    writeFileSync(
      join(r17SplitDir, "light.tokens.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#ffffff" } },
        text: { primary: { $type: "color", $value: "#111111" } },
      })
    );
    writeFileSync(
      join(r17SplitDir, "dark.tokens.json"),
      JSON.stringify({
        surface: { default: { $type: "color", $value: "#111111" } },
        text: { primary: { $type: "color", $value: "#ffffff" } },
      })
    );
    const r17SplitScan = scanTarget(r17SplitDir);
    assert.deepEqual(r17SplitScan.dtcg.blockingIssues, [], "T1: split light/dark refs from base must not be unresolved");

    assert.equal(
      analyzeDtcgModesAndContrast({
        surface: {
          default: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#111111" } } },
          dark: { $type: "color", $value: "#111111", $extensions: { mode: { light: "#111111", dark: "#050505" } } },
        },
        text: {
          primary: { $type: "color", $value: "#111111", $extensions: { mode: { light: "#111111", dark: "#ffffff" } } },
        },
      }).contrast.wcagFailures,
      0,
      "T2: static surface.dark must be skipped under $extensions.mode light"
    );

    assert.equal(
      analyzeDtcgModesAndContrast({
        bg: { default: { $type: "color", $value: "#ffffff" }, primary: { $type: "color", $value: "#2563eb" } },
        surface: { default: { $type: "color", $value: "#ffffff" }, brand: { $type: "color", $value: "#2563eb" } },
        text: {
          default: { $type: "color", $value: "#111111" },
          onPrimary: { $type: "color", $value: "#ffffff" },
          onSurface: { $type: "color", $value: "#111111" },
          onSurfaceBrand: { $type: "color", $value: "#ffffff" },
        },
      }).contrast.wcagFailures,
      0,
      "T3: generic text.default / onSurface must skip surfaces covered by dedicated onPrimary / onSurfaceBrand"
    );

    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          semantic: {
            surfacePage: { $type: "color", $value: "#ffffff" },
            textDefault: { $type: "color", $value: "oklch(0.18 0.02 255)" },
            actionPrimary: { $type: "color", $value: "oklch(0.55 0.19 255)" },
          },
          component: {
            button: {
              bg: { $type: "color", $value: "{color.semantic.actionPrimary}" },
              ink: { $type: "color", $value: "#ffffff" },
            },
          },
        },
      }).contrast.wcagFailures,
      0,
      "R17-A4-01: OKLCH colors & component-scoped tokens must pass contrast without cross-pairing"
    );

    const r17DriftDir = join(scratch, "r17-drift");
    mkdirSync(r17DriftDir, { recursive: true });
    writeFileSync(
      join(r17DriftDir, "Spaces.css"),
      ".a { color: lch(52% 40 20); background: hwb(194 0% 0%); border-color: color(display-p3 1 0.5 0); }\n"
    );
    writeFileSync(
      join(r17DriftDir, "Mixin.tsx"),
      'const Box = styled.div`${borderMixin("#ff00aa")}\n&:hover { color: var(--fg); }`;\n'
    );
    writeFileSync(
      join(r17DriftDir, "FalsePosSpacing.tsx"),
      'export const C = () => <div title="margin: 13px" data-style={{ padding: "13px" }}><p>padding: 17px;</p></div>;\n'
    );
    writeFileSync(
      join(r17DriftDir, "MultiLineSpacing.tsx"),
      'export const D = ({ compact }: any) => <div style={{ padding: compact ?\n  "13px" :\n  "17px", margin: compact &&\n  "13px" }} />;\n'
    );
    writeFileSync(
      join(r17DriftDir, "StyledSpacing.tsx"),
      'const S = styled.div`padding: ${gap === "13px" ? "16px" : "8px"};`;\n'
    );
    writeFileSync(
      join(r17DriftDir, "SvelteSpacing.svelte"),
      `<div style:padding="{gap === '13px' ? '16px' : '8px'}" />\n`
    );
    const r17DriftScan = scanTarget(r17DriftDir);
    assert.equal(r17DriftScan.drift.hardcodedColorHits, 4, "T4 + T5: lch/hwb/color(display-p3) + styled interpolation #ff00aa must all count");
    assert.equal(r17DriftScan.drift.offGridSpacingHits, 3, "T6 + T7: multiline trailing-op style={{...}} catches 3 off-grid hits while ignoring non-style attrs/text & comparison operands");

    // Round 18 regressions (R18-A2-01, R18-A2-08, R18-A2-10, R18-A2-11, R18-A2-12, R18-A2-13):
    const r18TokDir = join(scratch, "r18-tok-dir");
    mkdirSync(r18TokDir, { recursive: true });
    writeFileSync(
      join(r18TokDir, "ReDoSAndFps.tsx"),
      [
        `export const A = () => <p>Choose color(${"a".repeat(60)}</p>;`,
        `export const B = ({ theme, x }: any) => <div style={{ padding: /"/.test(x) ? "13px" : "16px", margin: "17px" }}>{theme.color("primary")} Choose color(s)</div>;`,
        `const S1 = styled.div<Props>({ padding: "13px" });`,
        `const S2 = styled.div.attrs(() => ({}))({ padding: "13px" });`,
        `const S3 = styled.div\`\n  \${({ x }: any) => /"/.test(x) ? "color: var(--a);" : ""}\n  #feed { display: grid; }\n\`;`,
      ].join("\n")
    );
    writeFileSync(
      join(r18TokDir, "NestedAndContent.css"),
      '.tip::after { content: "#ff00aa rgb(255, 0, 0) !important"; }\n.x { color: oklch(calc(min(0.6, 0.5)) 0.2 250); }\n'
    );
    writeFileSync(
      join(r18TokDir, "RegSvelte.svelte"),
      `<div style="color: {/'/.test(x) ? 'red' : 'blue'}; padding: 13px;" />\n`
    );
    const t0Ms = Date.now();
    const r18Scan = scanTarget(r18TokDir);
    assert.ok(Date.now() - t0Ms < 2000, "Linear balanced-paren color scanner must not suffer ReDoS");
    assert.equal(r18Scan.drift.hardcodedColorHits, 1, "Only nested oklch(calc(min(...))) should trigger hardcoded color; prose/JS color() and CSS content strings must not");
    assert.equal(r18Scan.drift.importantOverrides, 0, "CSS content !important must not trigger importantOverrides");
    assert.equal(r18Scan.drift.offGridSpacingHits, 5, "Regex quote skips + generics + .attrs() + Svelte style regex must catch all 5 off-grid hits");

    assert.equal(
      validateDtcgTokens({
        light: { bg: { $type: "color", $value: "{onlydark.bg}" } },
        dark: { onlydark: { bg: { $type: "color", $value: "#000000" } } },
      }).blockingIssues.length,
      1,
      "light.* ref to dark-only key must be flagged as unresolved_reference"
    );
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          component: {
            button: {
              primary: { bg: { $type: "color", $value: "#1d4ed8" }, text: { $type: "color", $value: "#ffffff" } },
              secondary: { bg: { $type: "color", $value: "#ffffff" }, text: { $type: "color", $value: "#111827" } },
            },
          },
        },
      }).contrast.wcagFailures,
      0,
      "Component variants button.primary vs button.secondary must not cross-pair"
    );
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          semantic: { surfacePage: { $type: "color", $value: "#ffffff" }, textDefault: { $type: "color", $value: "#111827" } },
          component: { card: { bg: { $type: "color", $value: "#0f172a" }, title: { $type: "color", $value: "#f8fafc" } } },
        },
      }).contrast.wcagFailures,
      0,
      "Component foreground card.title pairs with dark card.bg and excludes semantic textDefault"
    );

    // Round 19 regressions (R19-A2-02,11,12,15):
    assert.equal(
      analyzeDtcgModesAndContrast({
        color: {
          semantic: { surface: { page: { $type: "color", $value: "#ffffff" } }, text: { default: { $type: "color", $value: "#111827" } } },
          component: { button: { bg: { default: { $type: "color", $value: "#1d4ed8" } }, text: { default: { $type: "color", $value: "#ffffff" } } } },
        },
      }).contrast.wcagFailures,
      0,
      "R19 #2: multi-level component.button.bg.default / text.default must isolate by component slug"
    );
    assert.equal(
      validateDtcgTokens({
        color: {
          light: { bg: { $type: "color", $value: "{color.onlydark.bg}" } },
          dark: { onlydark: { bg: { $type: "color", $value: "#000000" } } },
        },
      }).blockingIssues.length,
      1,
      "R19 #15: mid-path light ref to dark-only token must fail validation"
    );
    const r19TokDir = join(scratch, "r19-tokens-reg");
    mkdirSync(r19TokDir, { recursive: true });
    writeFileSync(
      join(r19TokDir, "RegexAndContent.tsx"),
      [
        'export const A = () => <div style={{ padding: /"/.test(x) && gap === "13px" ? "16px" : "8px" }} />;',
        'export const B = () => <div style={{ margin: /"/.test(x) ? "a == b" : "13px" }} />;',
        'export const C = () => <div style={{ "--x": /"/.test(x) ? "a" : "b", color: "#ff00aa", padding: "13px" }} />;',
        'export const D = () => <circle cx="12" cy="12" onClick={() => /"/.test(x)} fill="#F4BA17" />;',
        'const E = styled.div`&::after { content: "#ff00aa rgb(255, 0, 0)"; }`;',
        'const F = styled.div({ "&::after": { content: "\'padding: 13px\'" } });',
      ].join("\n")
    );
    writeFileSync(
      join(r19TokDir, "HtmlRx.svelte"),
      '<div style="padding: {/\'/.test(x) && gap === \'13px\' ? \'16px\' : \'8px\'}" />\n'
    );
    const r19Scan = scanTarget(r19TokDir);
    assert.equal(r19Scan.drift.hardcodedColorHits, 1, "R19 #11/#12: only real color: #ff00aa (not SVG /\"/ or styled content string) must count");
    assert.equal(r19Scan.drift.offGridSpacingHits, 2, "R19 #11/#12: only B (13px) and C (13px) must count (no /\"/ FP or content string FP)");

    // Round 20 regressions (R20-A2-H6, R20-A2-H7, R20-A2-M11, R20-A2-M12, R20-A2-L14):
    const r20TokDir = join(scratch, "r20-tok");
    mkdirSync(r20TokDir, { recursive: true });
    writeFileSync(
      join(r20TokDir, "Cmp.tsx"),
      [
        'const E = styled.div`&::after { content: "${x ? "#ff00aa" : "var(--a)"}"; }`;',
        'const G = styled.div`&::after { content: "x ${y ? \'a"b\' : \'c\'}"; color: #112233; }`;',
        'const B = styled.div`--custom: #ff00aa !important; color: var(--fg);`;',
        'export const Str = () => <div title=\'Use "--x": val\' style={{ color: "#778899", padding: "13px" }} />;',
      ].join("\n")
    );
    const r20Scan = scanTarget(r20TokDir);
    assert.equal(r20Scan.drift.hardcodedColorHits, 2, "R20: #112233 and #778899 must count; interpolated content & styled --custom must not");
    assert.equal(r20Scan.drift.offGridSpacingHits, 1, "R20: 13px after title=\"--x\" must count");
    assert.equal(r20Scan.drift.importantOverrides, 0, "R20: styled --custom: !important must not count");
    assert.equal(r20Scan.drift.semanticOrphanCount, 0, "R20: quoted '--x': inside JSX title must not create orphan var");

    const r20TextFieldRes = analyzeDtcgModesAndContrast({
      color: {
        semantic: { surface: { dark: { $type: "color", $value: "#0f172a" } } },
        component: {
          textField: {
            bg: { $type: "color", $value: "#ffffff" },
            text: { $type: "color", $value: "#111827" },
          },
        },
      },
    });
    assert.equal(r20TextFieldRes.contrast.wcagFailures, 0, "R20 M11: component slug textField.bg must not be treated as foreground");

    const r20MultiDotContrast = analyzeDtcgModesAndContrast({
      tokens: {
        semantic: {
          light: { surface: { $type: "color", $value: "#ffffff" }, ink: { $type: "color", $value: "#111827" } },
          dark: { surface: { $type: "color", $value: "#0f172a" }, ink: { $type: "color", $value: "#f8fafc" } },
        },
      },
      card: {
        surface: { $type: "color", $value: "{tokens.semantic.surface}" },
        text: { $type: "color", $value: "{tokens.semantic.ink}" },
      },
    });
    assert.equal(r20MultiDotContrast.contrast.pairsEvaluated >= 2, true, "R20 M12: multi-dot mode resolution must resolve light/dark card pair");
    assert.equal(r20MultiDotContrast.contrast.wcagFailures, 0);

    const r20LeafShade = validateDtcgTokens({
      light: { color: { primary: { light: { $type: "color", $value: "#93c5fd" } } } },
      dark: { color: { primary: { light: { $type: "color", $value: "#60a5fa" } } } },
      card: { bg: { $type: "color", $value: "{color.primary.light}" } },
    });
    assert.equal(r20LeafShade.blockingIssues.length, 0, "R20 M12: split leaf shade .light must resolve light/dark.color.primary.light");

    // Round 21 regressions (R21-A2-M2, R21-A2-M4, R21-A2-M5, R21-A2-L2..L4):
    const r21OrphanDir = join(scratch, "r21-orphan");
    mkdirSync(r21OrphanDir, { recursive: true });
    writeFileSync(
      join(r21OrphanDir, "R21Orphan.tsx"),
      [
        'const fn = () => `"--fake-var": "#ff00aa !important"`;',
        'const q = gql<User>`\n  "--gql-var": "#112233"\n`;',
        'export const P = () => <p>CSS var syntax "--fake-orphan": #ff00aa;</p>;',
      ].join("\n")
    );
    const r21OrphanScan = scanTarget(r21OrphanDir);
    assert.equal(r21OrphanScan.drift.semanticOrphanCount, 0, "R21 M2/L4: arrow fn, gql<User>, and JSX prose must not register orphan vars");

    const r21Dir = join(scratch, "r21-tok");
    mkdirSync(r21Dir, { recursive: true });
    writeFileSync(
      join(r21Dir, "R21Space.tsx"),
      [
        'const S1 = styled.div`padding: ${"13px"};`;',
        'const S2 = styled.div`margin: ${v || "17px"};`;',
      ].join("\n")
    );
    writeFileSync(
      join(r21Dir, "R21.svelte"),
      `<div style="--x: {active ? '#ff00aa !important' : '#112233'}; color: var(--x);" />\n`
    );
    const r21Scan = scanTarget(r21Dir);
    assert.equal(r21Scan.drift.offGridSpacingHits, 2, "R21 M4: short styled expressions must preserve offGridSpacingHits");
    assert.equal(r21Scan.drift.hardcodedColorHits, 0, "R21 M5: Svelte style --x: {...} must stay blanked");
    assert.equal(r21Scan.drift.importantOverrides, 0, "R21 M5: Svelte style --x: {...} must not leak !important");

    const r21DarkCycle = validateDtcgTokens({
      a: { $type: "color", $value: "#ffffff" },
      b: { $type: "color", $value: "#ffffff" },
      dark: { a: { $type: "color", $value: "{b}" }, b: { $type: "color", $value: "{a}" } },
    });
    assert.equal(r21DarkCycle.blockingIssues.some((i) => i.type === "circular_reference"), true, "R21 L2: dark cycle must not be masked by unscoped base");

    const r21IconBtn = analyzeDtcgModesAndContrast({
      color: {
        component: {
          iconButton: {
            bg: { $type: "color", $value: "#ffffff" },
            text: { $type: "color", $value: "#ffffff" },
          },
        },
      },
    });
    assert.equal(r21IconBtn.contrast.wcagFailures >= 1, true, "R21 L3: iconButton component slug must not trigger nonFillRe skip");

    // Round 22 regressions (R22-A2-M2, R22-A2-M6, R22-A2-L2):
    const r22SvelteDir = join(scratch, "r22-svelte");
    mkdirSync(r22SvelteDir, { recursive: true });
    writeFileSync(
      join(r22SvelteDir, "R22.svelte"),
      '<div style:--x={fn({ a: 1 }) || "#ff00aa"} style="color: var(--x);" />\n<div style:padding={fn({ a: 1 }) ? "13px" : "8px"} />\n'
    );
    const r22SvScan = scanTarget(r22SvelteDir);
    assert.equal(r22SvScan.drift.semanticOrphanCount, 0, "R22 M6: style:--x={...} with style=\"color: var(--x)\" must match");
    assert.equal(r22SvScan.drift.hardcodedColorHits, 0, "R22 M6: Svelte style:--x={fn({ a: 1 }) || \"#ff00aa\"} must mask nested-brace value");
    assert.equal(r22SvScan.drift.offGridSpacingHits, 1, "R22 M6: Svelte style:padding={fn({ a: 1 }) ? \"13px\" : \"8px\"} must measure nested-brace value");

    const r22ProseDir = join(scratch, "r22-prose");
    mkdirSync(r22ProseDir, { recursive: true });
    writeFileSync(
      join(r22ProseDir, "R22Prose.tsx"),
      'export const P = () => <p>Example, "--fake-a": <span style={{ color: "#ff00aa" }} /></p>;\nexport const Q = () => <p>Syntax; "--fake-b": <span style={{ color: "#112233 !important" }} /></p>;\n'
    );
    const r22ProseScan = scanTarget(r22ProseDir);
    assert.equal(r22ProseScan.drift.semanticOrphanCount, 0, "R22 M2: JSX prose comma/semicolon must not create orphan vars");
    assert.equal(r22ProseScan.drift.importantOverrides, 1, "R22 M2: JSX prose semicolon before '--fake-b' must not swallow real !important");
    assert.equal(r22ProseScan.drift.hardcodedColorHits, 2, "R22 M2: JSX prose comma before '--fake-a' must not suppress #ff00aa or #112233");

    const r22CapCycle = validateDtcgTokens({
      a: { $type: "color", $value: "#ffffff" },
      b: { $type: "color", $value: "#ffffff" },
      Dark: { a: { $value: "{b}" }, b: { $value: "{a}" } },
    });
    assert.equal(
      r22CapCycle.blockingIssues.some((i) => i.type === "circular_reference"),
      true,
      "R22 L2: capitalized Dark mode cycle must not be masked by lowercased prefix lookup"
    );

    const tokSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, scratch, "--format", "bogus", "--json"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, scratch, "--out", "   "], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, scratch, "--sarif", "   "], { encoding: "utf8" }).status, 2);

    // Round 23 regressions (#19, #20, #24, #26, #27, #43)
    const r23ModeContrast = analyzeDtcgModesAndContrast({
      Light: { p1: { $type: "color", $value: "#ffffff" }, p2: { $type: "color", $value: "#111111" } },
      Dark: { p1: { $type: "color", $value: "#ffffff" }, p2: { $type: "color", $value: "#eeeeee" } },
      semantic: { bg: { $type: "color", $value: "{p1}" }, fg: { $type: "color", $value: "{p2}" } },
    });
    assert.equal(r23ModeContrast.contrast.pairsEvaluated >= 2, true);
    assert.equal(r23ModeContrast.contrast.wcagFailures >= 1, true);

    const r23NoiseDir = join(scratch, "r23-noise");
    mkdirSync(join(r23NoiseDir, "src"), { recursive: true });
    writeFileSync(join(r23NoiseDir, "src/auth-vars.tokens.json"), '{"CSRFToken":{"value":"{env.CSRF}"},"accessToken":{"duration":"10s"}}');
    writeFileSync(join(r23NoiseDir, "src/Comp.tsx"), 'export const A = () => <><p>Issue #123 and Order #404 use rgb(255, 0, 0)</p><div style={{ padding: (gap === "13px" ? "16px" : "8px") as string }} /></>;\nconst B = styled.div<{ gap?: string }>`padding: ${(p) => (p.gap === "13px" ? "16px" : "8px")};`;\n');
    writeFileSync(join(r23NoiseDir, "src/a.css"), '.a::before { content: "p-[12px] bg-[#ff00aa]"; }\n');
    const r23NoiseScan = scanTarget(r23NoiseDir);
    assert.equal(r23NoiseScan.dtcg, null);
    assert.equal(r23NoiseScan.drift.offGridSpacingHits, 0);
    assert.equal(r23NoiseScan.drift.tailwind.arbitraryColors, 0);
    assert.equal(r23NoiseScan.drift.tailwind.arbitrarySpacing, 0);
    assert.equal(r23NoiseScan.drift.hardcodedColorHits, 0);

    for (const badTokCli of [
      [r23NoiseDir, "extra"],
      [r23NoiseDir, "--scope", join(scratch, "missing-scope-dir")],
      [r23NoiseDir, "--out", r23NoiseDir],
    ]) {
      assert.equal(spawnSync(process.execPath, [tokSelfPath, ...badTokCli], { encoding: "utf8" }).status, 2);
    }

    // Round 24 regressions (A2-H5 $extensions.modes & translucent fg compositing, A2-M3 doc/prose JS strings)
    const r24AlphaModes = analyzeDtcgModesAndContrast({
      surface: {
        default: {
          $type: "color",
          $value: "#ffffff",
          $extensions: { modes: { light: "#ffffff", dark: "#0b0f19" } },
        },
      },
      text: {
        muted: {
          $type: "color",
          $value: "rgba(17, 24, 39, 0.35)",
          $extensions: { modes: { light: "rgba(17, 24, 39, 0.35)", dark: "rgba(248, 250, 252, 0.35)" } },
        },
      },
    });
    assert.equal(r24AlphaModes.parity.lightCount, 2, "R24 A2-H5: $extensions.modes plural must register light modes");
    assert.equal(r24AlphaModes.parity.darkCount, 2, "R24 A2-H5: $extensions.modes plural must register dark modes");
    assert.equal(r24AlphaModes.contrast.wcagFailures, 2, "R24 A2-H5: low-alpha fg composited over opaque bg must fail WCAG AA in both modes");

    const r24DocDir = join(scratch, "r24-doc");
    mkdirSync(join(r24DocDir, "src"), { recursive: true });
    writeFileSync(
      join(r24DocDir, "src/Docs.tsx"),
      [
        'export const Docs = () => (<><button title={"Example: p-[12px] bg-[#ff00aa]"}>Tip</button><code>{"<div className=\\"p-[12px] bg-[#ff00aa]\\">"}</code><p>p-[12px] bg-[#ff00aa]</p></>);',
        'const guide = \'Avoid style="color: #ff00aa" and bg-[#ff00aa]\';',
        'export const Real = () => <span data-c={true ? "x" : "#ff00aa"} />;',
      ].join("\n") + "\n"
    );
    const r24DocScan = scanTarget(r24DocDir);
    assert.equal(r24DocScan.drift.tailwind.arbitraryColors, 0, "R24 A2-M3: doc/prose bg-[#ff00aa] must not count");
    assert.equal(r24DocScan.drift.tailwind.arbitrarySpacing, 0, "R24 A2-M3: doc/prose p-[12px] must not count");
    assert.equal(r24DocScan.drift.hardcodedColorHits, 1, "R24 A2-M3: only standalone real #ff00aa must count");

    // Round 25 regressions (A2-H5 <style> in string, A2-M3 static doc attrs + prose style=, A4-H1 live leaf symlink, A4-L1 isDirectCliEntry)
    const r25TokDir = join(scratch, "r25-tok");
    mkdirSync(join(r25TokDir, "src"), { recursive: true });
    writeFileSync(
      join(r25TokDir, "src/App.tsx"),
      [
        'const ex = "<style>.a { color: #ff00aa !important; }</style>";',
        'export const P = () => <><img alt="#112233" aria-label="#445566" /><p>style="color: #778899 !important"</p></>;',
      ].join("\n") + "\n"
    );
    const r25TokScan = scanTarget(r25TokDir);
    assert.equal(r25TokScan.drift.hardcodedColorHits, 0, "R25 A2-M3/H5: fake <style> and static doc attrs must produce 0 hardcoded color hits");
    assert.equal(r25TokScan.drift.importantOverrides, 0, "R25 A2-M3: prose style= must produce 0 !important overrides");
    const r25LiveSecret = join(scratch, "tok-secret.json");
    const r25LiveSymOut = join(scratch, "tok-live-sym.json");
    writeFileSync(r25LiveSecret, "{}");
    symlinkSync(r25LiveSecret, r25LiveSymOut);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, r25TokDir, "--out", r25LiveSymOut], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [tokSelfPath, r25TokDir, "--sarif", r25LiveSymOut], { encoding: "utf8" }).status, 2);
    const r25CliSym = join(scratch, "tok-cli-sym.mjs");
    symlinkSync(tokSelfPath, r25CliSym);
    assert.equal(spawnSync(process.execPath, [r25CliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regressions (A2-H3 com.figma.mode/{$value}, A2-M10 content-[...], A2-M11 Vue :style '--x', A2-M12 fake <style>/prose spacing, A2-M13 paddingInlineStart)
    const r26Modes = analyzeDtcgModesAndContrast({
      color: {
        bg: { $type: "color", $value: "#ffffff", $extensions: { "com.figma.mode": { light: { $value: "#ffffff" }, dark: { $value: "#111111" } } } },
        text: { $type: "color", $value: "#111111", $extensions: { "com.figma.mode": { light: { $value: "#dddddd" }, dark: { $value: "#f8fafc" } } } },
      },
    });
    assert.equal(r26Modes.parity.hasModes, true);
    assert.equal(r26Modes.contrast.pairsEvaluated, 2);
    assert.equal(r26Modes.contrast.wcagFailures, 1);

    const r26CodeDir = join(scratch, "r26-code");
    mkdirSync(join(r26CodeDir, "src"), { recursive: true });
    writeFileSync(
      join(r26CodeDir, "src/App.tsx"),
      [
        'const ex1 = `<style>:root { --fake-var: 1px; }</style>`;',
        'export const Guide = () => <p>Avoid style="margin: 17px"</p>;',
        'export const Tw = () => <button className="before:content-[\'bg-[#ff00aa]\'] after:content-[\'p-[13px]\']" />;',
        'export const Real = () => <div style={{ paddingInlineStart: "13px" }} />;',
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r26CodeDir, "src/Card.vue"),
      '<template><div :style="{ \'--x\': \'#ff00aa !important\' }" /></template>\n<style scoped>.card { color: var(--x); }</style>\n'
    );
    const r26CodeScan = scanTarget(r26CodeDir);
    assert.equal(r26CodeScan.drift.definedCssVariables, 1, "R26 A2-M12: fake <style> in string must not define --fake-var");
    assert.equal(r26CodeScan.drift.semanticOrphanCount, 0, "R26 A2-M12: fake <style> in string must not emit semantic orphan var");
    assert.equal(r26CodeScan.drift.offGridSpacingHits, 1, "R26 A2-M12/M13: only real paddingInlineStart 13px counts, not prose margin: 17px");
    assert.equal(r26CodeScan.drift.tailwind.arbitraryColors, 0, "R26 A2-M10: content-['bg-[#ff00aa]'] must not count");
    assert.equal(r26CodeScan.drift.tailwind.arbitrarySpacing, 0, "R26 A2-M10: content-['p-[13px]'] must not count");
    assert.equal(r26CodeScan.drift.hardcodedColorHits, 0, "R26 A2-M11: Vue :style '--x' must not count");
    assert.equal(r26CodeScan.drift.importantOverrides, 0, "R26 A2-M11: Vue :style '--x' !important must not count");

    // Round 27 regressions (A2-H3 CSS-in-JS comments & waivers, A2-H7 non-class Tailwind attrs/comparisons, A2-H8 canonical --scope path)
    const r27Dir = join(scratch, "r27-tokens");
    mkdirSync(join(r27Dir, "src/sub"), { recursive: true });
    writeFileSync(
      join(r27Dir, "src/sub/Box.tsx"),
      [
        "const Box = styled.div`",
        "  /* color: #ff00aa !important; padding: 13px; */",
        "  color: var(--fg);",
        "`;",
        "const Waived = styled.div`",
        "  /* dsaf-ignore dsaf/important-override -- needed to override third-party specificity */",
        "  color: var(--fg) !important;",
        "`;",
        'export const Safe = () => <a href="https://example.com/?q=bg-[#ff00aa]" data-testid="bg-[#ff00aa] p-[13px] bg-red-500">x</a>;',
        'const isDark = theme === "bg-[#111111]";',
      ].join("\n") + "\n"
    );
    const r27Scan = scanTarget(r27Dir);
    assert.equal(r27Scan.drift.hardcodedColorHits, 0, "R27 A2-H3: commented CSS-in-JS hex must not count");
    assert.equal(r27Scan.drift.importantOverrides, 1, "R27 A2-H3: only the un-commented waived CSS-in-JS !important counts in raw drift, not the commented one");
    assert.equal(r27Scan.drift.offGridSpacingHits, 0, "R27 A2-H3: commented CSS-in-JS 13px must not count");
    assert.equal(r27Scan.drift.tailwind.arbitraryColors, 0, "R27 A2-H7: non-class attrs & comparisons must not count");
    assert.equal(r27Scan.drift.tailwind.arbitrarySpacing, 0);
    assert.equal(r27Scan.drift.tailwind.primitiveColors, 0);
    assert.equal(r27Scan.ciFindings.counts.reflex, 0, "R27 A2-H3: CSS-in-JS dsaf-ignore waiver must waive !important cleanly");
    assert.equal(r27Scan.ciFindings.counts.waived, 1);
    const r27ScopeRun = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), r27Dir, "--scope", join(realpathSync(r27Dir), "src/sub"), "--format", "sarif"],
      { encoding: "utf8" }
    );
    assert.equal(r27ScopeRun.status, 0, `R27 A2-H8: canonical --scope path must succeed: ${r27ScopeRun.stderr}`);

    // Round 28 regressions (A2-M1 whitespace --scope trim, A2-M2 --sarif rootDir symlink confinement)
    const r28TokRun = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), r27Dir, "--scope", " src/sub ", "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r28TokRun.status, 0, `R28 A2-M1: trimmed --scope must succeed: ${r28TokRun.stderr}`);
    const r28TokOutDir = join(scratch, "r28-tok-outside");
    mkdirSync(r28TokOutDir, { recursive: true });
    mkdirSync(join(r27Dir, "out"), { recursive: true });
    symlinkSync(r28TokOutDir, join(r27Dir, "out/sym"));
    assert.equal(
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), r27Dir, "--sarif", join(r27Dir, "out/sym/evil.sarif"), "--json"], { encoding: "utf8" }).status,
      2,
      "R28 A2-M2: audit-tokens --sarif must reject symlink dir escape out of target root"
    );
    assert.equal(existsSync(join(r28TokOutDir, "evil.sarif")), false);

    // Round 29 (A2-M7 & A2-H2): Reflex ! important / !IMPORTANT variants and Svelte chained modifiers
    const r29TokDir = join(scratch, "r29-tok-dir");
    mkdirSync(r29TokDir, { recursive: true });
    writeFileSync(join(r29TokDir, "imp.css"), ".a { color: var(--fg) ! important; background: var(--bg) !IMPORTANT; }\n");
    writeFileSync(join(r29TokDir, "Btn.svelte"), '<button on:click|preventDefault|stopPropagation={go} class="p-[13px] text-[#abcdef]" style="padding: 13px; color: #112233">Go</button>\n');
    const r29TokScan = scanTarget(r29TokDir);
    assert.equal(r29TokScan.drift.importantOverrides, 2, "R29 A2-M7: audit-tokens must detect ! important and !IMPORTANT overrides");
    assert.equal(r29TokScan.drift.tailwind.arbitraryColors, 1, "R29 A2-H2: Svelte chained modifiers must still scan Tailwind class");
    assert.equal(r29TokScan.drift.tailwind.arbitrarySpacing, 1);
    assert.equal(r29TokScan.drift.offGridSpacingHits, 1, "R29 A2-H2: Svelte chained modifiers must still scan inline style spacing");
    assert.equal(r29TokScan.drift.hardcodedColorHits, 1);

    // Round 30 (A2-H1 & A2-M2): <svg> string literals and function-body JSX // prose must not hide hardcoded color hits
    const r30TokDir = join(scratch, "r30-tok-dir");
    mkdirSync(r30TokDir, { recursive: true });
    writeFileSync(
      join(r30TokDir, "SvgStr.tsx"),
      'const open = "<svg>";\nexport const C = () => <div style={{ color: "#ff00aa" }} />;\nconst close = "</svg>";\n'
    );
    writeFileSync(
      join(r30TokDir, "FnJsx.tsx"),
      'export function Panel() {\n  return (\n    <div>\n      // Route A\n      <span style={{ color: "#123456" }} />\n    </div>\n  );\n}\n'
    );
    const r30TokScan = scanTarget(r30TokDir);
    assert.equal(r30TokScan.drift.hardcodedColorHits, 2, "R30 A2-H1/M2: both #ff00aa and #123456 must count as hardcoded colors");

    // Round 31 (A2-M10): SCSS #{} interpolation before px spacing must not truncate declaration scan
    const r31TokDir = join(scratch, "r31-tok-dir");
    mkdirSync(r31TokDir, { recursive: true });
    writeFileSync(
      join(r31TokDir, "interp.scss"),
      ".a { padding: #{$gap} 13px; margin: #{$top} #{$right} 15px; }\n"
    );
    const r31TokScan = scanTarget(r31TokDir);
    assert.equal(r31TokScan.drift.offGridSpacingHits, 2, "R31 A2-M10: SCSS #{...} before 13px/15px must not mask off-grid spacing");
    assert.equal(
      r31TokScan.ciFindings.active.filter((f) => f.ruleId === "dsaf/off-grid-spacing").length,
      2,
      "R31 A2-M10: ciFindings must include both 13px and 15px after #{...}"
    );

    // Round 32 (A2-M5): prose, JS doc strings, and fake style:--* inside JSX prose/strings must not count as token usage or definitions
    const r32TokDir = join(scratch, "r32-tok-prose");
    mkdirSync(r32TokDir, { recursive: true });
    writeFileSync(join(r32TokDir, "tokens.css"), ":root { --brand-primary: #112233; }\n");
    writeFileSync(
      join(r32TokDir, "Docs.tsx"),
      [
        'const doc = "Do not use var(--brand-primary) in raw code";',
        'const snippet = "style:--fake-token={x}";',
        'const fakeInline = "style=\\"--prose-inline: #ffffff\\"";',
        'export function Docs() { return <p>Example: var(--brand-primary) and bg-(--brand-primary) and style:--prose-var="red"</p>; }',
      ].join("\n") + "\n"
    );
    const r32TokScan = scanTarget(r32TokDir);
    assert.equal(r32TokScan.drift.usedCssVariables, 0, "R32 A2-M5: prose/doc var(--brand-primary) must not count as used");
    assert.equal(r32TokScan.drift.semanticOrphanCount, 1, "R32 A2-M5: unused --brand-primary must stay orphan, fake style:--* must not register");
    assert.equal(r32TokScan.drift.colorTokenRefs, 0, "R32 A2-M5: prose/doc var() must not inflate colorTokenRefs");
    assert.equal(r32TokScan.drift.definedCssVariables, 1, "R32 A2-M5: only :root --brand-primary counts as defined CSS var");

    // Round 33 (A2-M4 & A2-M7): DTCG $root tokens, display-p3 .hex fallback, and extended Tailwind arbitrary color/sizing/property utilities
    const r33Dtcg = {
      surface: {
        $root: { $type: "color", $value: "#ffffff" },
        subtle: { $type: "color", $value: "{surface.$root}" },
      },
      text: {
        primary: {
          $type: "color",
          $value: { colorSpace: "display-p3", components: [0.07, 0.09, 0.14], hex: "#111827" },
        },
        muted: { $type: "color", $value: "#b3b3b3" },
        refPtr: { $type: "color", $ref: "#/surface/$root/$value" },
      },
    };
    const r33Flat = flattenTokens(r33Dtcg);
    assert.ok(r33Flat.some((t) => t.path === "surface" && t.value === "#ffffff"), "R33 A2-M4: $root token must flatten at group path 'surface'");
    const r33Val = validateDtcgTokens(r33Dtcg);
    assert.deepEqual(r33Val.blockingIssues, [], `R33 A2-M4: {surface.$root} and #/surface/$root/$value must resolve, got ${JSON.stringify(r33Val.blockingIssues)}`);
    const r33Modes = analyzeDtcgModesAndContrast(r33Dtcg);
    assert.ok(r33Modes.contrast.pairsEvaluated >= 2, "R33 A2-M4: display-p3 .hex text.primary and $root surface must produce contrast pairs");
    assert.ok(r33Modes.contrast.failingPairs.some((p) => p.fg === "text.muted"), "R33 A2-M4: #b3b3b3 must fail contrast against #ffffff");
    assert.ok(!r33Modes.contrast.failingPairs.some((p) => p.fg === "text.primary"), "R33 A2-M4: display-p3 .hex #111827 must pass contrast");

    const r33TwDir = join(scratch, "r33-tw-arb");
    mkdirSync(r33TwDir, { recursive: true });
    writeFileSync(
      join(r33TwDir, "Card.tsx"),
      '<div className="bg-[oklch(0.6_0.2_250)] text-[rgb(255,0,0)] [color:#112233] w-[317px] min-h-[53px] inset-x-[13px] [padding-inline:15px] [width:200px]" />\n'
    );
    const r33TwScan = scanTarget(r33TwDir);
    assert.equal(r33TwScan.drift.tailwind.arbitraryColors, 3, "R33 A2-M7: must count bg-[oklch(...)], text-[rgb(...)], and [color:#...]");
    assert.equal(r33TwScan.drift.tailwind.arbitrarySpacing, 5, "R33 A2-M7: must count w-[317px], min-h-[53px], inset-x-[13px], [padding-inline:15px], [width:200px]");
    assert.equal(r33TwScan.drift.hardcodedColorHits, 0, "R33 A2-M7: Tailwind arbitrary colors must not double-count as hardcodedColorHits");

    // Round 34 (A2-M7 DTCG 2025.10/CSS4 color spaces, A2-M8 $extends, A2-M9 @apply spacing no double-count, A2-L10 @theme modifier vars, A2-L11 composite aliasCount):
    const r34ColorModes = analyzeDtcgModesAndContrast({
      color: {
        bg: { default: { $type: "color", $value: "#ffffff" } },
        fg: {
          objP3: { $type: "color", $value: { colorSpace: "display-p3", components: [0.99, 0.99, 0.99] } },
          objSrgbLin: { $type: "color", $value: { colorSpace: "srgb-linear", components: [0.99, 0.99, 0.99] } },
          cssP3: { $type: "color", $value: "color(display-p3 0.99 0.99 0.99)" },
          cssHwb: { $type: "color", $value: "hwb(0 98% 2%)" },
          cssLab: { $type: "color", $value: "lab(97 0 0)" },
        },
      },
    });
    assert.ok(r34ColorModes.contrast.wcagFailures >= 5, `R34 A2-M7: DTCG P3/srgb-linear and CSS4 color()/hwb()/lab() low-contrast tokens must fail WCAG, got ${r34ColorModes.contrast.wcagFailures}`);

    const r34ExtendsVal = validateDtcgTokens({
      base: { $type: "color", bg: { $value: "#ffffff" }, fg: { $value: "#111111" } },
      dark: { $extends: "{base}", bg: { $value: "#09090b" } },
      shadow: {
        card: { $type: "shadow", $value: { color: "{base.fg}", offsetX: "0px", offsetY: "2px", blur: "4px", spread: "0px" } },
      },
    });
    assert.deepEqual(r34ExtendsVal.missingTypeIssues, [], "R34 A2-M8: $extends must inherit $type and sibling members");
    assert.equal(r34ExtendsVal.tokenCount, 5, "R34 A2-M8: base(2) + dark(2 inherited+overridden) + shadow.card(1)");
    assert.equal(r34ExtendsVal.typedCount, 5);
    assert.equal(r34ExtendsVal.aliasCount, 1, "R34 A2-L11: nested composite {base.fg} alias must increment aliasCount");

    const r34ApplyThemeDir = join(scratch, "r34-apply-theme");
    mkdirSync(r34ApplyThemeDir, { recursive: true });
    writeFileSync(
      join(r34ApplyThemeDir, "styles.css"),
      "@theme { --text-sm: 0.875rem; --text-sm--line-height: 1.25rem; }\n.card { @apply [padding:13px]; }\n"
    );
    writeFileSync(join(r34ApplyThemeDir, "View.tsx"), 'export const View = () => <p className="text-sm">Hi</p>;\n');
    const r34Scan = scanTarget(r34ApplyThemeDir);
    assert.equal(r34Scan.drift.offGridSpacingHits, 0, "R34 A2-M9: @apply [padding:13px] must not double-count as offGridSpacingHits");
    assert.equal(r34Scan.drift.tailwind.arbitrarySpacing, 1, "R34 A2-M9: @apply [padding:13px] must count once as tailwind.arbitrarySpacing");
    assert.equal(r34Scan.drift.semanticOrphanCount, 0, "R34 A2-L10: --text-sm--line-height must resolve via text-sm usage");

    // Round 36 (R35-A2-H6 out-of-gamut srgb DTCG color objects scale by 255 + clamp):
    const r36GamutPass = analyzeDtcgModesAndContrast({
      color: {
        bg: { default: { $type: "color", $value: { colorSpace: "srgb", components: [1.093, -0.226, -0.15] } } },
        fg: { default: { $type: "color", $value: "#000000" } },
      },
    });
    assert.equal(r36GamutPass.contrast.wcagFailures, 0, "R36 A2-H6: #000000 on out-of-gamut srgb red [1.093,-0.226,-0.15] (~#ff0000, 5.25:1) must PASS");
    const r36GamutFail = analyzeDtcgModesAndContrast({
      color: {
        bg: { default: { $type: "color", $value: { colorSpace: "srgb", components: [1.093, -0.226, -0.15] } } },
        fg: { default: { $type: "color", $value: "#ffffff" } },
      },
    });
    assert.equal(r36GamutFail.contrast.wcagFailures, 1, "R36 A2-H6: #ffffff on out-of-gamut srgb red [1.093,-0.226,-0.15] (~#ff0000, 4.00:1) must FAIL");

    // Round 37 (R36-A2-L2 / none alpha + R36-A2-M1 SFC <script> cast):
    assert.deepEqual(parseCssColorToRgba("rgb(0 0 0 / none)"), [0, 0, 0, 0], "R37 A2-L2: rgb(0 0 0 / none) must parse alpha 0");
    const r37OkNone = parseCssColorToRgba("oklch(0.6 0.2 30 / none)");
    assert.ok(Array.isArray(r37OkNone) && r37OkNone[3] === 0, "R37 A2-L2: oklch(... / none) must parse alpha 0");
    const r37NoneContrast = analyzeDtcgModesAndContrast({
      surface: { bg: { $type: "color", $value: "#ffffff" } },
      text: { noneAlpha: { $type: "color", $value: "rgb(0 0 0 / none)" } },
    });
    assert.ok(r37NoneContrast.contrast.pairsEvaluated >= 1, "R37 A2-L2: rgb(0 0 0 / none) token must be evaluated in contrast check");
    const r37AppVueDir = join(scratch, "r37-app-vue");
    mkdirSync(r37AppVueDir, { recursive: true });
    writeFileSync(
      join(r37AppVueDir, "App.vue"),
      [
        '<script setup lang="ts">',
        'const el = <HTMLElement>document.getElementById("x");',
        "const B = styled.button`color: #ff00aa;`;",
        "</script>",
        '<template><div style="color: #112233">ok</div></template>',
      ].join("\n")
    );
    const r37TokVue = scanTarget(r37AppVueDir);
    assert.equal(r37TokVue.drift.hardcodedColorHits, 2, "R37 A2-M1: audit-tokens must detect #ff00aa after TS cast in App.vue <script>");

    // Round 38 (R37-A2-M3 leaf .light/.dark aliases + R37-A2-L1 $extensions.mode scoping + R37-A2-L2 legacy value override):
    const r38LeafDoc = {
      color: {
        $type: "color",
        bg: { light: { $value: "#ffffff" }, dark: { $value: "#111111" } },
        cardText: { light: { $value: "{color.bg}" }, dark: { $value: "{color.bg}" } },
        fg: { light: { $value: "#111111" }, dark: { $value: "#ffffff" } },
      },
    };
    assert.equal(validateDtcgTokens(r38LeafDoc).blockingIssues.length, 0, "R38 A2-M3: leaf .light/.dark alias targets must validate without unresolved_reference");
    assert.ok(analyzeDtcgModesAndContrast(r38LeafDoc).contrast.pairsEvaluated >= 2, "R38 A2-M3: leaf .light/.dark alias targets must resolve colors for contrast");

    const r38ExtModeDoc = {
      dark: { secret: { $type: "color", $value: "#111111" } },
      light: { bg: { $type: "color", $value: "#ffffff" } },
      card: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "{secret}", dark: "{secret}" } } },
    };
    assert.ok(
      validateDtcgTokens(r38ExtModeDoc).blockingIssues.some((iss) => iss.type === "unresolved_reference" && iss.path === "card" && iss.target === "secret"),
      "R38 A2-L1: $extensions.mode.light reference missing light.secret must fail even when dark.secret exists"
    );

    const r38ExtLegacy = resolveDtcgExtends({
      base: { fg: { $type: "color", $value: "#000000" }, link: { $type: "color", $ref: "#/base/fg" } },
      text: { $extends: "{base}", fg: { value: "#ffffff" }, link: { value: "#ffffff" } },
    });
    assert.equal(validateDtcgTokens({ surface: { bg: { $type: "color", $value: "#000000" } }, ...r38ExtLegacy }).blockingIssues.length, 0);
    const r38ExtC = analyzeDtcgModesAndContrast({ surface: { bg: { $type: "color", $value: "#000000" } }, ...r38ExtLegacy });
    assert.ok(r38ExtC.contrast.pairsEvaluated >= 2, "R38 A2-L2: text.fg and text.link must evaluate in contrast check");
    assert.equal(
      r38ExtC.contrast.failingPairs.filter((p) => p.fg.startsWith("text.")).length,
      0,
      "R38 A2-L2: child legacy value override must clear inherited $value and $ref"
    );

    // Round 39 (R38-A2-M2 mode-scoped runCycleCheck + R38-A2-L1 spacing after paren/comma + R38-A2-L2 CSS-in-JS ${expr}px):
    const r39CycleFp = {
      light: { x: { $type: "color", $value: "{a.bg}" } },
      dark: { x: { $type: "color", $value: "#000000" } },
      a: { bg: { $type: "color", $value: "#ffffff", $extensions: { mode: { dark: "{x}" } } } },
    };
    assert.equal(
      validateDtcgTokens(r39CycleFp).blockingIssues.filter((i) => i.type === "circular_reference").length,
      0,
      "R39 A2-M2: dark $extensions.mode ref must resolve dark.x without false circular_reference via light.x"
    );
    const r39CycleFn = {
      color: { x: { $type: "color", $value: "#111111" } },
      dark: { color: { x: { $type: "color", $value: "{a.bg}" } } },
      a: { bg: { $type: "color", $value: "#ffffff", $extensions: { mode: { dark: "{color.x}" } } } },
    };
    assert.equal(
      validateDtcgTokens(r39CycleFn).blockingIssues.filter((i) => i.type === "circular_reference").length,
      1,
      "R39 A2-M2: dark $extensions.mode ref must resolve dark.color.x and catch dark-mode cycle"
    );
    const r39CrossMode = {
      light: { a: { $type: "color", $value: "{b}" } },
      dark: { b: { $type: "color", $value: "{light.a}" } },
      c: { $type: "color", $value: "#ffffff", $extensions: { mode: { dark: "{dark.b}" } } },
    };
    assert.equal(
      validateDtcgTokens(r39CrossMode).blockingIssues.filter((i) => i.type === "circular_reference").length,
      0,
      "R39 A2-M2: light.a -> {b} with dark.b -> {light.a} must not create false cycle in dark mode"
    );

    const r39SpacingDir = join(scratch, "r39-spacing");
    mkdirSync(r39SpacingDir, { recursive: true });
    writeFileSync(join(r39SpacingDir, "a.css"), "@supports (padding: 13px) { .a { gap: 4px; } }\n");
    writeFileSync(
      join(r39SpacingDir, "Card.tsx"),
      [
        'import styled from "styled-components";',
        "export const Bad = styled.div`padding: ${isBig ? 13 : 8}px;`;",
        "export const Ok = styled.div`padding: ${isBig ? 8 : 4}px;`;",
      ].join("\n") + "\n"
    );
    const r39SpRes = scanTarget(r39SpacingDir);
    assert.equal(r39SpRes.drift.offGridSpacingHits, 2, "R39 A2-L1/L2: must detect @supports (padding: 13px) and styled.div `${isBig ? 13 : 8}px`");

    // Round 40 (R39-A2-M6 $extensions.mode-only tokens + R39-A2-L8 leading-dot fractional px like .5px):
    const r40ExtOnlyDoc = {
      color: {
        $type: "color",
        surface: { $extensions: { mode: { light: "#ffffff", dark: "#000000" } } },
        text: { $extensions: { mode: { dark: "#111111" } } },
        groupWithExt: {
          $extensions: { mode: { light: "#eeeeee" } },
          nested: { $value: "#1d4ed8" },
        },
      },
    };
    const r40ExtVal = validateDtcgTokens(r40ExtOnlyDoc);
    assert.equal(r40ExtVal.tokenCount, 3, "R40 A2-M6: $extensions.mode-only tokens + nested children must all flatten (3 tokens)");
    const r40ExtModes = analyzeDtcgModesAndContrast(r40ExtOnlyDoc);
    assert.equal(r40ExtModes.parity.hasModes, true, "R40 A2-M6: $extensions.mode-only tokens must report hasModes=true");
    assert.equal(r40ExtModes.parity.lightCount, 1);
    assert.equal(r40ExtModes.parity.darkCount, 2);
    assert.deepEqual(r40ExtModes.parity.missingInLight, ["color.text"]);

    const r40SubPxDir = join(scratch, "r40-subpx");
    mkdirSync(r40SubPxDir, { recursive: true });
    writeFileSync(join(r40SubPxDir, "a.css"), ".a { padding: .5px; border-radius: .25px; margin: -.5px; }\n");
    writeFileSync(join(r40SubPxDir, "b.tsx"), 'export const B = () => <div style={{ margin: ".5px", padding: "foo5px" }} />;\n');
    writeFileSync(join(r40SubPxDir, "c.svelte"), '<div style="padding: .5px;" style:margin={".25px"}>ok</div>\n');
    writeFileSync(
      join(r40SubPxDir, "d.tsx"),
      'import styled from "styled-components";\nexport const D = styled.div`padding: ${ok ? .5 : 0.25}px;`;\n'
    );
    const r40SubPxRes = scanTarget(r40SubPxDir);
    assert.equal(r40SubPxRes.drift.offGridSpacingHits, 0, "R40 A2-L8: leading-dot .5px/.25px/-0.5px must not trigger offGridSpacingHits");

    // Round 41 (R40-A2-H4 transitive $extends subgroup & mode-only leaf merge; R40-A2-M3 on-primary vs surface.primary; R40-A2-M4 fractional >4px & unitless JS numeric spacing):
    const r41ExtDoc = {
      b: {
        sub: {
          c: { $type: "color", $value: "#ffffff" },
          keepType: { $type: "dimension", $value: "16px" },
        },
      },
      a: {
        $extends: "{b}",
        sub: {
          c: { $extensions: { mode: { dark: "#000000" } } },
        },
      },
      d: { $extends: "{a.sub}" },
    };
    const r41ExtRes = resolveDtcgExtends(r41ExtDoc);
    assert.equal(r41ExtRes.d?.c?.$value, "#ffffff", "R41 A2-H4: mode-only leaf merge must preserve inherited $value");
    assert.equal(r41ExtRes.d?.c?.$type, "color", "R41 A2-H4: mode-only leaf merge must preserve inherited $type");
    assert.equal(r41ExtRes.d?.c?.$extensions?.mode?.dark, "#000000", "R41 A2-H4: mode-only leaf merge must apply dark override");
    assert.equal(r41ExtRes.d?.keepType?.$value, "16px", "R41 A2-H4: c extends {a.sub} must inherit transitive b.sub members");

    const r41RoleContrast = analyzeDtcgModesAndContrast({
      color: {
        brand: { primary: { $type: "color", $value: "#1d4ed8" } },
        surface: { primary: { $type: "color", $value: "#ffffff" } },
        text: {
          primary: { $type: "color", $value: "#111827" },
          "on-primary": { $type: "color", $value: "#ffffff" },
        },
      },
    });
    assert.equal(r41RoleContrast.contrast.wcagFailures, 0, "R41 A2-M3: text.on-primary must pair with brand.primary rather than neutral surface.primary");
    assert.ok(r41RoleContrast.contrast.pairsEvaluated >= 2, "R41 A2-M3: both on-primary/brand.primary and text.primary/surface.primary must pair");

    const r41SpaceDir = join(scratch, "r41-spacing");
    mkdirSync(r41SpaceDir, { recursive: true });
    writeFileSync(join(r41SpaceDir, "a.css"), ".a { padding: 7.5px; margin: 13.5px; gap: 1.5px; }\n");
    writeFileSync(
      join(r41SpaceDir, "Card.tsx"),
      [
        "export const C = ({ count = 2, big = false }: { count?: number; big?: boolean }) => (",
        "  <div style={{ padding: 5, gap: 9, borderRadius: 7, marginTop: big ? 13 : 8, paddingLeft: count + 5 }} />",
        ");",
      ].join("\n") + "\n"
    );
    const r41SpRes = scanTarget(r41SpaceDir);
    assert.equal(r41SpRes.drift.offGridSpacingHits, 6, "R41 A2-M4: must flag 7.5px, 13.5px, and unitless JS spacing 5/9/7/13 while ignoring 1.5px & count + 5");

    // Round 42 (R41-A2-H1 symmetric dark fallback, R41-A2-M5 intra-parent $extends, R41-A2-M6 metadata-only leaf override):
    const r42DarkFirstContrast = analyzeDtcgModesAndContrast({
      surface: {
        default: { $type: "color", $value: "#0f172a", $extensions: { modes: { light: "#ffffff" } } },
      },
      text: {
        primary: { $type: "color", $value: "#0f172a", $extensions: { modes: { light: "#111827" } } },
      },
    });
    assert.equal(r42DarkFirstContrast.parity.missingInDark.length, 0, "R42 A2-H1: dark-first base $value acts as dark mode when modes omits dark");
    assert.ok(
      r42DarkFirstContrast.contrast.failingPairs.some((p) => p.mode === "dark" && p.fg === "text.primary"),
      "R42 A2-H1: dark-first token contrast failure (#0f172a on #0f172a) must be caught"
    );

    const r42ExtDoc = {
      shared: {
        base: {
          primary: { $type: "color", $value: "#1d4ed8", $description: "Shared" },
        },
      },
      themes: {
        $extends: "{shared}",
        base: {
          secondary: { $type: "color", $value: "#0f172a" },
        },
        dark: {
          $extends: "{themes.base}",
          primary: { $description: "Brand primary" },
        },
      },
    };
    const r42ExtRes = resolveDtcgExtends(r42ExtDoc);
    assert.equal(r42ExtRes.themes?.dark?.primary?.$value, "#1d4ed8", "R42 A2-M5/M6: metadata-only override must keep inherited $value from intra-parent $extends");
    assert.equal(r42ExtRes.themes?.dark?.primary?.$type, "color", "R42 A2-M6: metadata-only override must keep inherited $type");
    assert.equal(r42ExtRes.themes?.dark?.primary?.$description, "Brand primary", "R42 A2-M6: metadata-only override must apply new $description");
    assert.equal(r42ExtRes.themes?.dark?.secondary?.$value, "#0f172a", "R42 A2-M5: local sibling additions inside themes.base must also merge into themes.dark");

    // Round 43 (R42-A2-H1 multi-level stacked $extends, R42-A2-M6 cyclic/unresolved $extends, R42-A2-H2 CSS Color 4/5 + named + calc + light-dark + color-mix, R42-A2-M7 dynamic ext mode invariant, R42-A2-M8 split $root):
    const r43DeepExtDoc = {
      base: {
        sub: {
          deep: {
            primary: { $type: "color", $value: "#1d4ed8" },
          },
        },
      },
      themes: {
        $extends: "{base}",
        sub: {
          localOnly: { $type: "color", $value: "#0f172a" },
          dark: { $extends: "{themes.sub.deep}" },
        },
      },
    };
    const r43DeepRes = resolveDtcgExtends(r43DeepExtDoc);
    assert.equal(r43DeepRes.themes?.sub?.dark?.primary?.$value, "#1d4ed8", "R43 A2-H1: stacked multi-level $extends must preserve inheritedCur through local ancestor groups");

    const r43ExtIssueDir = join(scratch, "r43-ext-issues");
    mkdirSync(r43ExtIssueDir, { recursive: true });
    writeFileSync(
      join(r43ExtIssueDir, "tokens.tokens.json"),
      JSON.stringify({
        a: { $extends: "{b}", x: { $type: "color", $value: "#ffffff" } },
        b: { $extends: "{a}" },
        c: { $extends: "{missing.group}" },
      })
    );
    const r43ExtScan = scanTarget(r43ExtIssueDir);
    assert.ok(r43ExtScan.ciFindings.active.some((f) => f.ruleId === "dsaf/dtcg-circular-ref"), "R43 A2-M6: cyclic $extends must emit dsaf/dtcg-circular-ref");
    assert.ok(r43ExtScan.ciFindings.active.some((f) => f.ruleId === "dsaf/dtcg-unresolved-ref"), "R43 A2-M6: unresolved $extends must emit dsaf/dtcg-unresolved-ref");

    assert.deepEqual(parseCssColorToRgba("rebeccapurple"), [102, 51, 153, 1], "R43 A2-H2: named CSS Color 4 rebeccapurple");
    const r43CalcRgb = parseCssColorToRgba("rgb(calc(100% - 20%) min(100, 128) clamp(0, 64, 255))");
    assert.deepEqual(r43CalcRgb, [204, 100, 64, 1], "R43 A2-H2: calc()/min()/clamp() inside rgb()");
    const r43Mix = parseCssColorToRgba("color-mix(in srgb, red 40%, blue)");
    assert.deepEqual(r43Mix, [102, 0, 153, 1], "R43 A2-H2: color-mix(in srgb, red 40%, blue)");
    const r43OklchMix = parseCssColorToRgba("color-mix(in oklch, #1d4ed8 75%, white)");
    assert.ok(r43OklchMix && r43OklchMix[0] > 29 && r43OklchMix[2] > 216, "R43 A2-H2: color-mix(in oklch, ...)");
    assert.deepEqual(parseCssColorToRgba("light-dark(#111827, #f8fafc)", "light"), [17, 24, 39, 1]);
    assert.deepEqual(parseCssColorToRgba("light-dark(#111827, #f8fafc)", "dark"), [248, 250, 252, 1]);

    const r43LightDarkContrast = analyzeDtcgModesAndContrast({
      surface: { bg: { $type: "color", $value: "light-dark(#ffffff, #0f172a)" } },
      text: { fg: { $type: "color", $value: "light-dark(#111827, #0f172a)" } },
    });
    assert.ok(
      r43LightDarkContrast.contrast.failingPairs.some((p) => p.mode === "dark" && p.fg === "text.fg"),
      "R43 A2-H2: light-dark() contrast failure in dark mode must be detected"
    );

    const r43ExtDynContrast = analyzeDtcgModesAndContrast({
      palette: {
        ink: { $type: "color", $value: "#ffffff", $extensions: { modes: { dark: "#f8fafc" } } },
      },
      components: {
        card: {
          bg: { $type: "color", $value: "#ffffff", $extensions: { modes: { dark: "#0f172a" } } },
          light: {
            text: { $type: "color", $value: "{palette.ink}", $extensions: { modes: { dark: "#e2e8f0" } } },
          },
        },
      },
    });
    assert.ok(
      r43ExtDynContrast.contrast.failingPairs.some((p) => p.mode === "light" && p.fg === "components.card.light.text" && p.bg === "components.card.bg"),
      "R43 A2-M7: fallback alias resolving differently in light vs dark must set isInvariant=false so component mode segs strip and pair"
    );

    const r43SplitRootDir = join(scratch, "r43-split-root");
    mkdirSync(join(r43SplitRootDir, "tokens"), { recursive: true });
    writeFileSync(
      join(r43SplitRootDir, "tokens/light.tokens.json"),
      JSON.stringify({
        brand: { $type: "color", $root: { $value: "#1d4ed8" } },
        bg: { $type: "color", $value: "#ffffff" },
        fg: { $type: "color", $value: "{brand.$root}" },
        ptr: { $type: "color", $ref: "#/brand/$root" },
      })
    );
    writeFileSync(
      join(r43SplitRootDir, "tokens/dark.tokens.json"),
      JSON.stringify({
        brand: { $type: "color", $root: { $value: "#93c5fd" } },
        bg: { $type: "color", $value: "#0f172a" },
        fg: { $type: "color", $value: "{brand.$root}" },
        ptr: { $type: "color", $ref: "#/brand/$root" },
      })
    );
    const r43SplitScan = scanTarget(r43SplitRootDir);
    assert.equal(
      r43SplitScan.ciFindings.active.filter((f) => f.ruleId === "dsaf/dtcg-unresolved-ref").length,
      0,
      "R43 A2-M8: split light/dark $root alias & $ref pointers must rewrite cleanly without unresolved_reference"
    );

    // Round 44 (R43-A2-H1 embedded CSS function refs, R43-A2-M2 cross-file $extends, R43-A2-M3 default alias to dark-only, R43-A2-M4 wide-gamut color-mix):
    const r44EmbeddedVal = validateDtcgTokens({
      color: {
        a: { $type: "color", $value: "color-mix(in srgb, {color.b} 50%, #ffffff)" },
        b: { $type: "color", $value: "{color.a}" },
        c: { $type: "color", $value: "light-dark({color.missingLight}, #000000)" },
      },
    });
    assert.ok(
      r44EmbeddedVal.blockingIssues.some((i) => i.type === "circular_reference"),
      "R44 A2-H1: circular reference through color-mix({ref}) must be detected"
    );
    assert.ok(
      r44EmbeddedVal.blockingIssues.some((i) => i.type === "unresolved_reference" && i.target === "color.missingLight"),
      "R44 A2-H1: missing ref inside light-dark({ref}, ...) must be flagged as unresolved_reference"
    );

    const r44CrossExtDir = join(scratch, "r44-cross-extends");
    mkdirSync(join(r44CrossExtDir, "tokens"), { recursive: true });
    writeFileSync(
      join(r44CrossExtDir, "tokens/base.tokens.json"),
      JSON.stringify({
        base: {
          card: {
            bg: { $type: "color", $value: "#ffffff" },
            fg: { $type: "color", $value: "#111111" },
          },
        },
      })
    );
    writeFileSync(
      join(r44CrossExtDir, "tokens/theme.tokens.json"),
      JSON.stringify({
        card: { $extends: "{base.card}" },
        alias: { $type: "color", $value: "{card.fg}" },
      })
    );
    writeFileSync(
      join(r44CrossExtDir, "tokens/dark.tokens.json"),
      JSON.stringify({
        card: { $extends: "{base.card}", bg: { $value: "#0f172a" }, fg: { $value: "#f8fafc" } },
      })
    );
    const r44CrossScan = scanTarget(r44CrossExtDir);
    assert.equal(
      r44CrossScan.ciFindings.active.filter((f) => f.ruleId === "dsaf/dtcg-unresolved-ref").length,
      0,
      "R44 A2-M2: cross-file $extends across base/theme/split-dark files must resolve without dsaf/dtcg-unresolved-ref"
    );

    const r44DarkOnlyDoc = {
      light: { color: { bg: { $type: "color", $value: "#ffffff" } } },
      dark: {
        color: {
          bg: { $type: "color", $value: "#000000" },
          accentDarkOnly: { $type: "color", $value: "#111111" },
        },
      },
      color: {
        text: { $type: "color", $value: "{color.accentDarkOnly}" },
      },
    };
    const r44DarkOnlyVal = validateDtcgTokens(r44DarkOnlyDoc);
    assert.ok(
      r44DarkOnlyVal.blockingIssues.some((i) => i.type === "unresolved_reference" && i.path === "color.text"),
      "R44 A2-M3: unscoped default token aliasing single-mode-only token must fail validation"
    );
    const r44DarkOnlyModes = analyzeDtcgModesAndContrast(r44DarkOnlyDoc);
    assert.ok(
      r44DarkOnlyModes.parity.missingInLight.includes("color.text"),
      "R44 A2-M3: unscoped default token resolving only in dark mode must report missingInLight"
    );

    for (const sp of ["a98-rgb", "prophoto-rgb", "rec2020", "display-p3-linear"]) {
      const mixed = parseCssColorToRgba(`color-mix(in ${sp}, #ff0000 50%, #0000ff)`);
      assert.ok(Array.isArray(mixed) && mixed.length === 4, `R44 A2-M4: color-mix(in ${sp}, ...) must parse cleanly`);
      const sameMix = parseCssColorToRgba(`color-mix(in ${sp}, #1d4ed8 50%, #1d4ed8)`);
      assert.ok(
        sameMix && Math.abs(sameMix[0] - 0x1d) <= 1 && Math.abs(sameMix[1] - 0x4e) <= 1 && Math.abs(sameMix[2] - 0xd8) <= 1,
        `R44 A2-M4: color-mix(in ${sp}, #1d4ed8 50%, #1d4ed8) must round-trip within 1 LSB`
      );
    }

    // Round 45 (composite non-fn refs, nested light-dark inside color-mix, negative chroma C<0 clamping):
    const r45CompVal = validateDtcgTokens({
      border: { card: { $type: "border", $value: "1px solid {missing.color}" } },
      a: { $type: "shadow", $value: "0 2px 4px {b}" },
      b: { $type: "shadow", $value: "{a}" },
    });
    assert.ok(r45CompVal.blockingIssues.some((i) => i.type === "unresolved_reference" && i.path === "border.card"), "R45 A2-M1: embedded ref in border string must validate");
    assert.ok(r45CompVal.blockingIssues.some((i) => i.type === "circular_reference"), "R45 A2-M1: cycle through composite shadow string must be caught");

    const r45NestedLdDoc = {
      light: { a: { $type: "color", $value: "#111111" }, surface: { bg: { $type: "color", $value: "#ffffff" } } },
      dark: { b: { $type: "color", $value: "#ffffff" }, surface: { bg: { $type: "color", $value: "#0f172a" } } },
      text: { fg: { $type: "color", $value: "color-mix(in srgb, light-dark({a}, {b}) 90%, {surface.bg})" } },
    };
    const r45NestedVal = validateDtcgTokens(r45NestedLdDoc);
    assert.equal(r45NestedVal.blockingIssues.length, 0, "R45 A2-M2: light-dark({a},{b}) inside color-mix(...) must resolve both mode branches cleanly");
    const r45NestedContrast = analyzeDtcgModesAndContrast(r45NestedLdDoc);
    assert.ok(r45NestedContrast.contrast.pairsEvaluated >= 2, "R45 A2-M2: light-dark inside color-mix contrast must evaluate in both light and dark modes");
    assert.equal(r45NestedContrast.contrast.wcagFailures, 0);

    assert.deepEqual(parseCssColorToRgba("oklch(0.6 -0.15 30)"), parseCssColorToRgba("oklch(0.6 0 30)"), "R45 A2-L1: oklch negative C must clamp to 0");
    assert.deepEqual(parseCssColorToRgba("lch(60 -50 30)"), parseCssColorToRgba("lch(60 0 30)"), "R45 A2-L1: lch negative C must clamp to 0");
    const r45NegChromaContrast = analyzeDtcgModesAndContrast({
      surface: { bg: { $type: "color", $value: "#000000" } },
      text: {
        ok: { $type: "color", $value: { colorSpace: "oklch", components: [0.6, -0.15, 30] } },
        okZero: { $type: "color", $value: { colorSpace: "oklch", components: [0.6, 0, 30] } },
        lchNeg: { $type: "color", $value: { colorSpace: "lch", components: [60, -50, 30] } },
        lchZero: { $type: "color", $value: { colorSpace: "lch", components: [60, 0, 30] } },
      },
    });
    const r45Pairs = Object.fromEntries(r45NegChromaContrast.contrast.samplePairs.map((p) => [p.pair, p.wcagRatio]));
    assert.equal(r45Pairs["text.ok vs surface.bg"], r45Pairs["text.okZero vs surface.bg"], "R45 A2-L1: W3C oklch negative C must match C=0");
    assert.equal(r45Pairs["text.lchNeg vs surface.bg"], r45Pairs["text.lchZero vs surface.bg"], "R45 A2-L1: W3C lch negative C must match C=0");

    // Round 46 (A2-M2 cross-file root $type isolation, A2-M3 TW arb color()/color-mix/light-dark, A2-M4 @theme v4 namespaces, A2-L8 display-p3-linear):
    const r46RootTypeDir = join(scratch, "r46-roottype");
    mkdirSync(r46RootTypeDir, { recursive: true });
    writeFileSync(join(r46RootTypeDir, "01-colors.tokens.json"), JSON.stringify({ $type: "color", brand: { primary: { $value: "#1d4ed8" } } }));
    writeFileSync(join(r46RootTypeDir, "02-spacing.tokens.json"), JSON.stringify({ $type: "dimension", space: { sm: { $value: "8px" } } }));
    const r46RootTypeScan = scanTarget(r46RootTypeDir);
    assert.equal(r46RootTypeScan.dtcg.blockingIssues.length, 0, "R46 A2-M2: 02-spacing root $type must not be dropped by 01-colors");
    assert.equal(r46RootTypeScan.dtcg.missingTypeIssues.length, 0);

    const r46BleedDir = join(scratch, "r46-bleed");
    mkdirSync(r46BleedDir, { recursive: true });
    writeFileSync(join(r46BleedDir, "01-untyped.tokens.json"), JSON.stringify({ space: { sm: { $value: "8px" } } }));
    writeFileSync(join(r46BleedDir, "02-colors.tokens.json"), JSON.stringify({ $type: "color", brand: { primary: { $value: "#1d4ed8" } } }));
    const r46BleedScan = scanTarget(r46BleedDir);
    assert.ok(r46BleedScan.dtcg.missingTypeIssues.some((iss) => iss.path === "space.sm"), "R46 A2-M2: 02-colors root $type must not bleed backward into 01-untyped");

    const r46TwDir = join(scratch, "r46-tw");
    mkdirSync(r46TwDir, { recursive: true });
    writeFileSync(
      join(r46TwDir, "Comp.tsx"),
      '<div className="bg-[color(display-p3_1_0.2_0.1)] bg-[color-mix(in_srgb,#ef4444_50%,#1d4ed8)] bg-[color-mix(in_srgb,red_50%,blue)] bg-[light-dark(red,blue)] font-semibold tracking-tight leading-snug blur-brand drop-shadow-card aspect-hero" />\n'
    );
    writeFileSync(
      join(r46TwDir, "tokens.css"),
      "@theme {\n  --font-weight-semibold: 600;\n  --tracking-tight: -0.02em;\n  --leading-snug: 1.375;\n  --blur-brand: 12px;\n  --drop-shadow-card: 0 2px 6px rgb(0 0 0 / 0.1);\n  --aspect-hero: 16 / 9;\n}\n.p3 { color: color(display-p3-linear 1 0 0); }\n"
    );
    const r46TwScan = scanTarget(r46TwDir);
    assert.equal(r46TwScan.drift.tailwind.arbitraryColors, 4, "R46 A2-M3: color()/color-mix()/light-dark() TW arb classes must count 4");
    assert.equal(r46TwScan.drift.hardcodedColorHits, 1, "R46 A2-M3 + L8: hex inside bg-[color-mix(...)] must not double-count, only display-p3-linear counts");
    assert.equal(r46TwScan.drift.semanticOrphanCount, 0, "R46 A2-M4: @theme v4 namespaces must resolve used utilities cleanly");

    // Round 47 (A2-M4 float color-mix with none hue & wide-gamut display-p3, A2-L8 @<slug> container queries, A2-L9 $extensions.mode-only $type):
    const r47NoneMix = parseCssColorToRgba("color-mix(in oklch, oklch(0.7 0.2 none) 50%, oklch(0.5 0.2 120) 50%)");
    const r47NoneExp = parseCssColorToRgba("oklch(0.6 0.2 120)");
    assert.ok(
      r47NoneMix && r47NoneExp && [0, 1, 2].every((idx) => Math.abs(r47NoneMix[idx] - r47NoneExp[idx]) <= 1),
      "R47 A2-M4: color-mix(in oklch) must carry forward missing hue 'none' without resolving to 0deg"
    );
    const r47P3Mix = parseCssColorToRgba("color-mix(in display-p3, color(display-p3 1 0 0) 50%, color(display-p3 0 0 1) 50%)");
    const r47P3Exp = parseCssColorToRgba("color(display-p3 0.5 0 0.5)");
    assert.ok(
      r47P3Mix && r47P3Exp && [0, 1, 2].every((idx) => Math.abs(r47P3Mix[idx] - r47P3Exp[idx]) <= 1),
      "R47 A2-M4: color-mix(in display-p3) must mix wide-gamut stops without 8-bit sRGB pre-clamping"
    );
    const r47ContDir = join(scratch, "r47-container");
    mkdirSync(r47ContDir, { recursive: true });
    writeFileSync(join(r47ContDir, "theme.css"), "@theme {\n  --container-sidebar: 18rem;\n}\n");
    writeFileSync(join(r47ContDir, "Layout.tsx"), 'export const Layout = () => <aside className="@sidebar:w-72 @max-sidebar:hidden" />;\n');
    const r47ContScan = scanTarget(r47ContDir);
    assert.equal(r47ContScan.drift.semanticOrphanCount, 0, "R47 A2-L8: @sidebar container variant must mark --container-sidebar used");

    const r47ModeOnlyDoc = {
      color: {
        white: { $type: "color", $value: "#ffffff" },
        black: { $type: "color", $value: "#000000" },
        surface: { $extensions: { mode: { light: "{color.white}", dark: "{color.black}" } } },
      },
    };
    const r47ModeOnlyVal = validateDtcgTokens(r47ModeOnlyDoc);
    assert.equal(r47ModeOnlyVal.missingTypeIssues.length, 0, "R47 A2-L9: $extensions.mode-only alias leaf must inherit $type cleanly");

    // Round 48 (A1-M1 symlink escape containment, A2-M2 color-mix & inset-ring, A2-M3 @theme --spacing/--breakpoint/shadow, A2-L1 analogous none propagation):
    const r48OutDir = join(scratch, "r48-outside");
    const r48RepoDir = join(scratch, "r48-repo");
    mkdirSync(join(r48OutDir, "nested"), { recursive: true });
    mkdirSync(join(r48RepoDir, "src"), { recursive: true });
    writeFileSync(join(r48OutDir, "secret.tokens.json"), JSON.stringify({ $type: "color", secret: { $value: "#ff00aa" } }));
    writeFileSync(join(r48OutDir, "secret.css"), ".bad { color: #ff00aa; }\n");
    writeFileSync(join(r48OutDir, "nested/sub.css"), ".bad2 { color: #123456; }\n");
    writeFileSync(join(r48RepoDir, "src/ok.css"), ".ok { color: var(--fg); }\n");
    symlinkSync(join(r48OutDir, "secret.tokens.json"), join(r48RepoDir, "secret.tokens.json"));
    symlinkSync(join(r48OutDir, "secret.css"), join(r48RepoDir, "src/secret.css"));
    symlinkSync(join(r48OutDir, "nested"), join(r48RepoDir, "src/ext-nested"));
    const r48SymScan = scanTarget(r48RepoDir);
    assert.equal(r48SymScan.filesScanned.tokenJson, 0, "R48 A1-M1: escaping token symlink must be skipped");
    assert.equal(r48SymScan.filesScanned.uiAndStyle, 1, "R48 A1-M1: escaping file & dir symlinks must be skipped");
    assert.equal(r48SymScan.drift.hardcodedColorHits, 0);

    const r48MixDir = join(scratch, "r48-color-mix");
    mkdirSync(r48MixDir, { recursive: true });
    writeFileSync(
      join(r48MixDir, "styles.css"),
      [
        ".a { color: color-mix(in srgb, red 50%, blue); }",
        ".b { color: color-mix(in oklch, #1d4ed8 70%, white); }",
        ".c { color: color-mix(in srgb, var(--brand) 80%, white); }",
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r48MixDir, "Comp.tsx"),
      '<div className="inset-ring-[#ff00aa] inset-ring-offset-[#123456]" />\n'
    );
    const r48MixScan = scanTarget(r48MixDir);
    assert.equal(r48MixScan.drift.hardcodedColorHits, 2, "R48 A2-M2: bare color-mix() + hex color-mix() count without double-counting; var() skipped");
    assert.equal(r48MixScan.drift.tailwind.arbitraryColors, 2, "R48 A2-M2: inset-ring-[...] and inset-ring-offset-[...] must count as TW arb colors");

    const r48ThemeDir = join(scratch, "r48-theme");
    mkdirSync(r48ThemeDir, { recursive: true });
    writeFileSync(
      join(r48ThemeDir, "theme.css"),
      [
        "@theme {",
        "  --spacing: 0.25rem;",
        "  --breakpoint-laptop: 64rem;",
        "  --color-brand: #1d4ed8;",
        "}",
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(r48ThemeDir, "App.tsx"),
      '<div className="p-4 min-laptop:gap-6 inset-ring-brand inset-shadow-brand drop-shadow-brand text-shadow-brand" />\n'
    );
    const r48ThemeScan = scanTarget(r48ThemeDir);
    assert.equal(r48ThemeScan.drift.semanticOrphanCount, 0, "R48 A2-M3: @theme --spacing, --breakpoint-*, and inset-ring/shadow/drop-shadow/text-shadow colors must be marked used");

    const r48MixL = parseCssColorToRgba("color-mix(in oklch, lab(none 0 0) 50%, oklch(0.8 0 0) 50%)");
    const r48MixLExp = parseCssColorToRgba("oklch(0.8 0 0)");
    assert.ok(
      r48MixL && r48MixLExp && [0, 1, 2].every((idx) => Math.abs(r48MixL[idx] - r48MixLExp[idx]) <= 1),
      "R48 A2-L1: missing Lightness 'none' in lab() must carry forward analogously into oklch"
    );
    const r48MixR = parseCssColorToRgba("color-mix(in display-p3, rgb(none 0 0) 50%, color(display-p3 1 0 0) 50%)");
    const r48MixRExp = parseCssColorToRgba("color(display-p3 1 0 0)");
    assert.ok(
      r48MixR && r48MixRExp && [0, 1, 2].every((idx) => Math.abs(r48MixR[idx] - r48MixRExp[idx]) <= 1),
      "R48 A2-L1: missing Red 'none' in rgb() must carry forward analogously into display-p3"
    );

    // Round 49 (A2-L1 CSS <hue> percentages inside calc() must be rejected):
    assert.equal(parseCssColorToRgba("oklch(0.6 0.15 calc(50%))"), null, "R49 A2-L1: calc(50%) hue must be rejected");
    assert.equal(parseCssColorToRgba("hsl(calc(50%) 100% 50%)"), null, "R49 A2-L1: hsl calc(50%) hue must be rejected");
    assert.equal(parseCssColorToRgba("oklch(0.6 0.15 calc(90deg + 50%))"), null, "R49 A2-L1: mixed deg + % in hue must be rejected");
    assert.deepEqual(parseCssColorToRgba("hsl(calc(90deg + 0.25turn) 100% 50%)"), [0, 255, 255, 1], "R49 A2-L1: valid angle addition in hue must still resolve");

    console.log("AUDIT_TOKENS_SELF_TEST_PASSED (DTCG + scoped CSS/@theme/Tailwind + fixture/OG + SVG/swatch + SARIF/waivers)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        format: { type: "string" },
        out: { type: "string" },
        sarif: { type: "string" },
        github: { type: "boolean", default: false },
        "report-unused-ignores": { type: "boolean", default: false },
        "include-demos": { type: "boolean", default: false },
        scope: { type: "string" },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-tokens.mjs <dir-or-tokens-json> [--scope <subdir>] [--include-demos] [--json] [--out <file>] [--sarif <file>] [--format json|sarif] [--github] [--report-unused-ignores] [--self-test] [--help]"
    );
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
  const cleanFmt = values.format !== undefined ? String(values.format).toLowerCase() : null;
  if (cleanFmt !== null && cleanFmt !== "json" && cleanFmt !== "sarif") {
    console.error(`Error: invalid --format '${values.format}'. Expected json|sarif.`);
    process.exit(2);
  }
  if (positionals.length > 1) {
    console.error(`Error: unexpected extra positional argument '${positionals[1]}'. Pass a single <dir-or-tokens-json>.`);
    process.exit(2);
  }
  const target = positionals[0];
  if (!target || !target.trim()) {
    console.error("Error: non-empty <dir-or-tokens-json> is required unless --self-test is passed.");
    process.exit(2);
  }
  const absCliTarget = resolve(target);
  if (!existsSync(absCliTarget)) {
    console.error(`Error: Path not found: ${absCliTarget}`);
    process.exit(2);
  }
  const targetRoot = statSync(absCliTarget).isDirectory() ? absCliTarget : dirname(absCliTarget);
  for (const [val, flagName] of [
    [values.out, "--out"],
    [values.sarif, "--sarif"],
  ]) {
    if (val === undefined) continue;
    try {
      assertWritableOutputFile(val, flagName, { rootDir: targetRoot });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  if (values.scope !== undefined) {
    if (!values.scope.trim()) {
      console.error("Error: --scope <subdir> cannot be empty or whitespace-only.");
      process.exit(2);
    }
    if (!statSync(absCliTarget).isDirectory()) {
      console.error(`Error: Target must be a directory when --scope is specified: ${absCliTarget}`);
      process.exit(2);
    }
    const scopedAbs = resolve(absCliTarget, values.scope.trim());
    if (!existsSync(scopedAbs) || !statSync(scopedAbs).isDirectory()) {
      console.error(`Error: Audit --scope directory not found: ${scopedAbs}`);
      process.exit(2);
    }
    const realRoot = (realpathSync.native || realpathSync)(absCliTarget);
    const realScope = (realpathSync.native || realpathSync)(scopedAbs);
    const ci = process.platform === "darwin" || process.platform === "win32";
    const relScope = relative(ci ? realRoot.toLowerCase() : realRoot, ci ? realScope.toLowerCase() : realScope);
    if (relScope === ".." || relScope.startsWith(`..${sep}`) || isAbsolute(relScope)) {
      console.error(`Error: Audit --scope escapes target root: ${values.scope}`);
      process.exit(2);
    }
  }

  try {
    const cleanCliScope = values.scope !== undefined ? values.scope.trim() : undefined;
    const result = scanTarget(target, {
      includeDemos: values["include-demos"],
      scope: cleanCliScope,
      reportUnusedIgnores: values["report-unused-ignores"],
    });
    const outJson = JSON.stringify(result, null, 2) + "\n";
    if (values.out) {
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), outJson, "utf8");
    }

    const repoRoot = statSync(resolve(target)).isDirectory() ? resolve(target) : dirname(resolve(target));
    const baseTarget = cleanCliScope ? resolve(repoRoot, cleanCliScope) : repoRoot;
    const sarifFindings = (result.ciFindings.active || []).map((f) => ({
      ...f,
      file: f.file ? (isAbsolute(f.file) ? f.file : join(baseTarget, f.file)) : f.file,
    }));
    const sarifObj = formatSarif(sarifFindings, { toolVersion: CI_REPORT_VERSION, repoRoot });
    if (values.sarif) {
      mkdirSync(dirname(resolve(values.sarif)), { recursive: true });
      writeFileSync(resolve(values.sarif), JSON.stringify(sarifObj, null, 2) + "\n", "utf8");
    }

    if (cleanFmt === "sarif") {
      process.stdout.write(JSON.stringify(sarifObj, null, 2) + "\n");
    } else if (values.github) {
      const ann = formatGithubAnnotations(sarifFindings, { repoRoot });
      if (ann) process.stdout.write(ann + "\n");
    } else if (values.json || cleanFmt === "json") {
      process.stdout.write(outJson);
    } else {
      const d = result.drift;
      const cf = result.ciFindings.counts;
      console.log(`Target: ${result.target}`);
      console.log(`Files scanned: tokenJson=${result.filesScanned.tokenJson}, ui/style=${result.filesScanned.uiAndStyle}`);
      if (result.dtcg) {
        const m = result.dtcgModes;
        console.log(
          `DTCG Tokens: ${result.dtcg.tokenCount} (typed=${result.dtcg.typedCount}, aliases=${result.dtcg.aliasCount}, component=${result.dtcg.componentScopedCount}, modernColor=${result.dtcg.modernColorCount}, blockingIssues=${result.dtcg.blockingIssues.length})`
        );
        if (m) {
          console.log(
            `DTCG Modes/Contrast: hasModes=${m.parity.hasModes} (L=${m.parity.lightCount}/D=${m.parity.darkCount}, missD=${m.parity.missingInDark.length}, missL=${m.parity.missingInLight.length}) | pairs=${m.contrast.pairsEvaluated} wcagFail=${m.contrast.wcagFailures} apcaWarn=${m.contrast.apcaWarnings}`
          );
        }
      } else {
        console.log("DTCG Tokens: none detected");
      }
      const ogNote = d.serverImageFiles.length > 0 ? ` | serverImageSkipped=${d.serverImageFiles.length}` : "";
      const demoNote = d.demoFilesSkipped.length > 0 ? ` | demoSkipped=${d.demoFilesSkipped.length}` : "";
      const scopeNote = d.recommendedScope ? ` | scopeHint=${d.recommendedScope}` : "";
      console.log(
        `CSS Drift: compliance=${d.tokenCompliancePct == null ? "N/A" : `${d.tokenCompliancePct}%`} (varRefs=${d.colorTokenRefs} vs hardcoded=${d.hardcodedColorHits}; svgPalette=${d.svgPaletteHits}, swatchTables=${d.swatchPaletteHits}) | orphans=${d.orphanCssVariableCount} (semantic=${d.semanticOrphanCount}, scale=${d.paletteScaleUnusedCount}) | !important=${d.importantOverrides} | offGridPx=${d.offGridSpacingHits} | nearDupHexClusters=${d.nearDuplicateHexClusters.length} | twArbColor=${d.tailwind.arbitraryColors} twArbPx=${d.tailwind.arbitrarySpacing} twPrim=${d.tailwind.primitiveColors}${ogNote}${demoNote}${scopeNote}`
      );
      console.log(
        `CI Gate Tiers: floor=${cf.floor} reflex=${cf.reflex} finish=${cf.finish} waived=${cf.waived} unusedIgnores=${cf.unusedIgnores}`
      );
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (isDirectCliEntry(import.meta.url)) main();

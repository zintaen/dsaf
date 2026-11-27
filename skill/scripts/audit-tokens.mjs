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
import { buildTailwindScanSurfacePreservingLines } from "./dsaf-hook.mjs";
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
  findSvelteStyleDirectives,
  findSvgBlockRanges,
  formatGithubAnnotations,
  formatSarif,
  isDirectCliEntry,
  isRealOpenTagAttrPos,
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

function hasNestedTokenDescendant(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (
        Object.prototype.hasOwnProperty.call(v, "$value") ||
        Object.prototype.hasOwnProperty.call(v, "value") ||
        hasNestedTokenDescendant(v)
      ) {
        return true;
      }
    }
  }
  return false;
}

function flattenTokens(source) {
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
    if (hasValue || hasRef) {
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
      if (k.startsWith("$")) continue;
      if ((k === "type" || k === "description") && (v == null || typeof v !== "object")) continue;
      walk(v, [...path, k], nextType);
    }
  }
  walk(source);
  return tokens;
}

function aliasTarget(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^\{([^}]+)\}$/);
  return m ? m[1].trim() : null;
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
    const candidate = segs.slice(0, i).join(".");
    if (byPath.has(candidate)) return candidate;
  }
  return segs.join(".");
}

function collectRefsInValue(val, byPath) {
  const direct = aliasTarget(val);
  if (direct) return [direct];
  if (Array.isArray(val)) return val.flatMap((item) => collectRefsInValue(item, byPath));
  if (val && typeof val === "object") {
    const refT = val.$ref ? pointerTarget(val.$ref, byPath) : null;
    const nested = Object.entries(val)
      .filter(([k]) => k !== "$ref")
      .flatMap(([, item]) => collectRefsInValue(item, byPath));
    return refT ? [refT, ...nested] : nested;
  }
  return [];
}

export function validateDtcgTokens(source) {
  const tokens = Array.isArray(source) ? source : flattenTokens(source);
  const byPath = new Map(tokens.map((t) => [t.path, t]));
  const baseRefsByPath = new Map();
  const refsByPath = new Map();
  const modeNames = new Set();
  for (const t of tokens) {
    const valRefs = collectRefsInValue(t.value, byPath);
    const refT = t.ref ? pointerTarget(t.ref, byPath) : null;
    const baseRefs = refT ? [...valRefs, refT] : [...valRefs];
    baseRefsByPath.set(t.path, baseRefs);
    const extMode = getTokenExtModes(t);
    const extModeRefs = extMode ? collectRefsInValue(extMode, byPath) : [];
    if (extMode) {
      for (const mk of Object.keys(extMode)) modeNames.add(mk.toLowerCase());
    }
    refsByPath.set(t.path, [...baseRefs, ...extModeRefs]);
  }

  const typeByPath = new Map();
  const issues = [];
  const circularSeen = new Set();

  const actualModePrefixes = new Set(["light", "dark"]);
  for (const k of byPath.keys()) {
    const mm = /(?:^|\.)(light|dark)(?:\.|$)/i.exec(k);
    if (mm) actualModePrefixes.add(mm[1]);
  }
  const resolveRefTargets = (target, callerPath = "") => {
    if (!target) return [];
    if (/(?:^|\.)(?:light|dark)\./i.test(target)) {
      return byPath.has(target) ? [target] : [];
    }
    const callerModeM = /(?:^|\.)(light|dark)(?:\.|$)/i.exec(String(callerPath || ""));
    const collectScoped = (modePrefix) => {
      const hits = [];
      const pref = `${modePrefix}.${target}`;
      if (byPath.has(pref)) hits.push(pref);
      for (let dotIdx = target.indexOf("."); dotIdx !== -1; dotIdx = target.indexOf(".", dotIdx + 1)) {
        const mid = `${target.slice(0, dotIdx)}.${modePrefix}.${target.slice(dotIdx + 1)}`;
        if (byPath.has(mid)) hits.push(mid);
      }
      return hits;
    };
    const collectMatchingModes = (wantLower) => {
      const seen = new Set();
      const ordered = [...actualModePrefixes].filter((m) => m.toLowerCase() === wantLower);
      const out = [];
      for (const mp of ordered) {
        for (const h of collectScoped(mp)) {
          if (!seen.has(h)) {
            seen.add(h);
            out.push(h);
          }
        }
      }
      return out;
    };
    if (callerModeM) {
      const exactScoped = collectScoped(callerModeM[1]);
      const fallbackScoped = collectMatchingModes(callerModeM[1].toLowerCase());
      const scoped = [...new Set([...exactScoped, ...fallbackScoped])];
      if (scoped.length > 0) return scoped;
      return byPath.has(target) ? [target] : [];
    }
    if (byPath.has(target)) return [target];
    return [...new Set([...collectMatchingModes("light"), ...collectMatchingModes("dark")])];
  };

  function resolveType(tok, stack = []) {
    if (typeByPath.has(tok.path)) return typeByPath.get(tok.path);
    const valRefTarget =
      tok.value && typeof tok.value === "object" && typeof tok.value.$ref === "string"
        ? pointerTarget(tok.value.$ref, byPath)
        : null;
    const target = aliasTarget(tok.value) ?? valRefTarget ?? (tok.ref ? pointerTarget(tok.ref, byPath) : null);
    const targets = target ? resolveRefTargets(target, tok.path) : [];
    const nextTarget = targets.find((rt) => !stack.includes(rt));
    if (!target || !nextTarget || stack.includes(tok.path)) {
      typeByPath.set(tok.path, tok.type ?? null);
      return tok.type ?? null;
    }
    const resolved = resolveType(byPath.get(nextTarget), [...stack, tok.path]);
    const finalType = tok.type ?? resolved ?? null;
    typeByPath.set(tok.path, finalType);
    return finalType;
  }

  for (const t of tokens) resolveType(t);

  for (const t of tokens) {
    for (const target of refsByPath.get(t.path) ?? []) {
      if (resolveRefTargets(target, t.path).length === 0) {
        issues.push({ type: "unresolved_reference", path: t.path, target });
      }
    }
  }

  function runCycleCheck(graphRefs) {
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
      for (const target of graphRefs.get(path) ?? []) {
        for (const rt of resolveRefTargets(target, path)) {
          detectCycles(rt, [...stack, path]);
        }
      }
      fullyExplored.add(path);
    }
    for (const t of tokens) detectCycles(t.path);
  }

  runCycleCheck(baseRefsByPath);
  for (const modeName of modeNames) {
    const modeRefs = new Map(
      tokens.map((t) => {
        const extMode = getTokenExtModes(t);
        if (extMode) {
          const matchedKey = Object.keys(extMode).find((mk) => mk.toLowerCase() === modeName);
          if (matchedKey !== undefined) {
            return [t.path, collectRefsInValue(extMode[matchedKey], byPath)];
          }
        }
        return [t.path, baseRefsByPath.get(t.path) ?? []];
      })
    );
    runCycleCheck(modeRefs);
  }
  for (const t of tokens) {
    if (!typeByPath.get(t.path)) {
      issues.push({ type: "missing_type", path: t.path });
    }
  }

  const aliases = tokens.filter(
    (t) =>
      aliasTarget(t.value) !== null ||
      Boolean(t.ref) ||
      Boolean(t.value && typeof t.value === "object" && typeof t.value.$ref === "string")
  );
  const componentScoped = tokens.filter((t) => /(component|button|input|card|dialog|modal|badge|toast|table|nav|tabs)/i.test(t.path));
  const MODERN_SPACE_RE = /^(oklch|oklab|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|lch|xyz-d50|xyz-d65)$/i;
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

function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearSrgbChannelToSrgb255(lr), linearSrgbChannelToSrgb255(lg), linearSrgbChannelToSrgb255(lb)];
}

function oklchToSrgb(L, C, hueDeg) {
  const hRad = (Number(hueDeg) * Math.PI) / 180;
  return oklabToSrgb(L, C * Math.cos(hRad), C * Math.sin(hRad));
}

function hslToSrgb(hDeg, sPct, lPct) {
  const h = (((Number(hDeg) % 360) + 360) % 360) / 360;
  const s = clamp01(Number(sPct));
  const l = clamp01(Number(lPct));
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
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
  return [Math.round(hue2rgb(h + 1 / 3) * 255), Math.round(hue2rgb(h) * 255), Math.round(hue2rgb(h - 1 / 3) * 255)];
}

function parseCssAngleDeg(tok) {
  const m = /^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(deg|rad|grad|turn)?$/i.exec(String(tok || "").trim());
  if (!m) return null;
  const val = Number.parseFloat(m[1]);
  const unit = (m[2] || "deg").toLowerCase();
  if (unit === "rad") return (val * 180) / Math.PI;
  if (unit === "grad") return val * 0.9;
  if (unit === "turn") return val * 360;
  return val;
}

function parseCssAlpha(tok) {
  const s = String(tok || "").trim();
  const isPct = s.endsWith("%");
  const n = Number.parseFloat(isPct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  return isPct ? n / 100 : n;
}

function parseCssColorToRgba(trimmed) {
  if (/^transparent$/i.test(trimmed)) return [0, 0, 0, 0];
  const m = /^(oklch|oklab|rgba?|hsla?)\s*\(([^()]+)\)$/i.exec(trimmed);
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const body = m[2].trim();
  const slashIdx = body.indexOf("/");
  let mainStr = body;
  let alpha = 1;
  if (slashIdx !== -1) {
    const aVal = parseCssAlpha(body.slice(slashIdx + 1));
    if (aVal === null) return null;
    alpha = clamp01(aVal);
    mainStr = body.slice(0, slashIdx).trim();
  }
  const parts = mainStr.includes(",") ? mainStr.split(",").map((p) => p.trim()) : mainStr.split(/\s+/);
  if (fn === "rgb" || fn === "rgba" || fn === "hsl" || fn === "hsla") {
    if (mainStr.includes(",") && parts.length === 4) {
      const aVal = parseCssAlpha(parts[3]);
      if (aVal === null) return null;
      alpha = clamp01(aVal);
    } else if (parts.length !== 3 && !(mainStr.includes(",") && parts.length === 4)) {
      return null;
    }
    if (fn === "rgb" || fn === "rgba") {
      const ch = parts.slice(0, 3).map((p) => {
        if (/^none$/i.test(p)) return 0;
        if (p.endsWith("%")) return Math.round(clamp01(Number.parseFloat(p) / 100) * 255);
        const v = Number.parseFloat(p);
        return Number.isFinite(v) ? Math.round(Math.max(0, Math.min(255, v))) : NaN;
      });
      return ch.every(Number.isFinite) ? [...ch, alpha] : null;
    }
    const h = parseCssAngleDeg(/^none$/i.test(parts[0]) ? "0" : parts[0]);
    const sat = /^none$/i.test(parts[1]) ? 0 : Number.parseFloat(parts[1]) / 100;
    const lig = /^none$/i.test(parts[2]) ? 0 : Number.parseFloat(parts[2]) / 100;
    if (h === null || !Number.isFinite(sat) || !Number.isFinite(lig)) return null;
    const rgb = hslToSrgb(h, sat, lig);
    return [...rgb, alpha];
  }
  if (parts.length !== 3) return null;
  const parseUnitOrPct = (p, pctScale) => {
    if (/^none$/i.test(p)) return 0;
    const isPct = p.endsWith("%");
    const n = Number.parseFloat(isPct ? p.slice(0, -1) : p);
    if (!Number.isFinite(n)) return NaN;
    return isPct ? (n / 100) * pctScale : n;
  };
  const L = parseUnitOrPct(parts[0], 1);
  if (!Number.isFinite(L)) return null;
  if (fn === "oklab") {
    const a = parseUnitOrPct(parts[1], 0.4);
    const b = parseUnitOrPct(parts[2], 0.4);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return [...oklabToSrgb(L, a, b), alpha];
  }
  const C = parseUnitOrPct(parts[1], 0.4);
  const h = /^none$/i.test(parts[2]) ? 0 : parseCssAngleDeg(parts[2]);
  if (!Number.isFinite(C) || h === null) return null;
  return [...oklchToSrgb(L, C, h), alpha];
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
    return parseCssColorToRgba(trimmed);
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
      if (cs !== "srgb") return null;
      const scale = nums.every((n) => n >= 0 && n <= 1) ? 255 : 1;
      return [Math.round(nums[0] * scale), Math.round(nums[1] * scale), Math.round(nums[2] * scale), alpha];
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
      if (lightExtKey) {
        lightKeys.add(tok.path);
        pushResolved("light", resolveColorRgba(unwrapModeEntry(extModes[lightExtKey]), byPath, [tok.path], "light"), false);
      } else if (tok.value != null || tok.ref) {
        lightKeys.add(tok.path);
        const baseVal = tok.value ?? { $ref: tok.ref };
        pushResolved("light", resolveColorRgba(baseVal, byPath, [tok.path], "light"), true);
      }
      if (darkExtKey) {
        darkKeys.add(tok.path);
        pushResolved("dark", resolveColorRgba(unwrapModeEntry(extModes[darkExtKey]), byPath, [tok.path], "dark"), false);
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
      invariantTokens.push(tok);
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
    const dedicatedOnSpecs = [];
    for (const c of modeCols) {
      const rp = stripModePath(c.path, c.mode, c.isInvariant);
      const comp = extractCompSlug(rp);
      if (isFgPath(c.path)) {
        if (comp) compFgs.add(comp);
        const onM = onRoleRe.exec(splitCamel(c.path));
        const rawRole = onM ? (onM[1] || onM[2]).replace(/_/g, "-") : null;
        if (rawRole && !/^(?:surface|background|bg|canvas|light|dark|inverse|inversed)$/.test(rawRole)) {
          const escRole = rawRole.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[._-]");
          dedicatedOnSpecs.push({
            roleRe: new RegExp(`(?:^|[._-])${escRole}(?:$|[._-])`, "i"),
            subRoles: new Set([...rawRole.matchAll(subRoleRe)].map((mm) => mm[1].toLowerCase())),
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
        mFlags.dedicatedOnSpecs.some((spec) => spec.roleRe.test(bgRolePath) && sameStrSet(bgSubRoleSet, spec.subRoles));
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

function findHardcodedColorFunctions(src) {
  const s = String(src || "");
  const out = [];
  const headRe = /\b(rgba?|hsla?|hwb|lch|oklch|lab|oklab|color)\(/gi;
  let cursor = 0;
  let m;
  while ((m = headRe.exec(s)) !== null) {
    if (m.index < cursor) continue;
    const prev = m.index > 0 ? s[m.index - 1] : "";
    if (prev === "." || prev === "$" || prev === "-") continue;
    const fnName = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let q = null;
    let i = openIdx + 1;
    let aborted = false;
    const hardStop = Math.min(s.length, openIdx + 512);
    while (i < hardStop && depth > 0) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < hardStop) { i += 2; continue; }
        if (ch === q || ch === "\n") q = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; i++; continue; }
      if (ch === ";" || ch === "{" || ch === "}" || ch === "<" || ch === ">") {
        aborted = true;
        break;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (aborted || depth !== 0) {
      cursor = openIdx + 1;
      headRe.lastIndex = cursor;
      continue;
    }
    const full = s.slice(m.index, i);
    const inner = s.slice(openIdx + 1, i - 1).trim();
    cursor = i;
    headRe.lastIndex = cursor;
    if (!inner || /^["']/.test(inner)) continue;
    if (fnName === "color") {
      if (!/^(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?|--[a-z0-9_-]+)\s+(?=[\d.+-]|none\b|calc\(|var\()/i.test(inner)) {
        continue;
      }
    } else if (!/(?:\d|from\s+|none\b|calc\(|var\()/i.test(inner)) {
      continue;
    }
    out.push({ index: m.index, text: full });
  }
  return out;
}

function isTokenizedColorFn(fnText) {
  return /\bvar\(\s*--/i.test(fnText);
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
  return Number.isInteger(n) && n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14;
}

const stripCssVarNames = (v) => String(v || "").replace(/--[a-zA-Z0-9_-]+/g, "");

function extractSpacingValueBranches(rawExpr) {
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
  const visit = (start, end) => {
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
              visit(rExprStart, rExprEnd);
              rk = rExprEnd;
              rLastSig = ";";
            } else if (!/\s/.test(rc)) rLastSig = rc;
          }
          return;
        }
        visit(bl, brEnd);
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
      visit(qPos + 1, colonPos);
      visit(colonPos + 1, r);
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
        if (!hasTopComp(cur, os) || hasTopAnd(cur, os)) visit(cur, os);
        cur = oe;
      }
      if (!hasTopComp(cur, r) || hasTopAnd(cur, r)) visit(cur, r);
      return;
    }
    if (andOps.length > 0) {
      visit(andOps[andOps.length - 1][1], r);
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
      for (const [ps, pe] of plusParts) visit(ps, pe);
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
            visit(tk + 2, se);
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
    if (!hasTopComp(l, r)) out.push(slice);
  };
  visit(0, expr.length);
  return out.join(" ");
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
        parts.push(extractSpacingValueBranches(v.slice(i + 1, endB)));
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
    const cleanedExpr = stripCssVarNames(extractSpacingValueBranches(rawExpr));
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
    for (const m of stripCssVarNames(valStr).matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
      const n = Number.parseFloat(m[1]);
      if (isOffGridPxValue(n)) hits++;
    }
  };
  if (isStyleFile) {
    for (const m of maskCssQuotedStringsPreservingLines(text).matchAll(/(?<![a-zA-Z0-9_$-:])([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
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
    const visitedDirs = new Set();
    function walk(dir) {
      let realDir = dir;
      try {
        realDir = realpathSync(dir);
      } catch {
        return;
      }
      if (visitedDirs.has(realDir)) return;
      visitedDirs.add(realDir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
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

  // 1. Validate W3C DTCG files (preserving mode from split light.json / dark.json filenames)
  const parsedTokenFiles = [];
  const modeLocalPaths = { light: new Set(), dark: new Set() };
  for (const tf of tokenJsonFiles.sort()) {
    try {
      const json = JSON.parse(readFileSync(tf, "utf8"));
      const flat = flattenTokens(json);
      if (flat.length === 0) continue;
      const relTf = (st.isDirectory() ? relative(resolved, tf) : tf).replace(/\\/g, "/");
      const modeTarget = st.isDirectory() ? relTf : basename(tf);
      const hasLightSeg = /(?:^|[/_.-])light(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
      const hasDarkSeg = /(?:^|[/_.-])dark(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
      const hasInternalModes = flat.some(
        (tok) => {
          const extModes = getTokenExtModes(tok);
          return (
            /^(light|dark)$/i.test(tok.path.split(".")[0] || "") ||
            Boolean(extModes && Object.keys(extModes).some((mk) => /^(light|dark)$/i.test(mk)))
          );
        }
      );
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
      parsedTokenFiles.push({ relTf, flat, fileMode });
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
        const cand = segs.slice(0, i).join(".");
        if (localSet.has(cand)) return `#/${fm}/${ref.slice(2)}`;
      }
      return ref;
    }
    return localSet.has(ref) ? `${fm}.${ref}` : ref;
  };
  const rewriteValRefs = (val, fm, localSet) => {
    if (typeof val === "string") {
      const m = val.trim().match(/^\{([^}]+)\}$/);
      if (m && localSet.has(m[1].trim())) return `{${fm}.${m[1].trim()}}`;
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

  const dtcgReports = [];
  const mergedTokens = [];
  const dtcgFileByPath = new Map();
  for (const { relTf, flat, fileMode } of parsedTokenFiles) {
    const adjusted = flat.map((tok) => {
      if (!fileMode) return tok;
      const segs = tok.path.split(".");
      const hasLeadingMode = /^(light|dark)$/i.test(segs[0] || "");
      const hasExtMode = Boolean(getTokenExtModes(tok));
      if (hasLeadingMode || hasExtMode) return tok;
      const localSet = modeLocalPaths[fileMode];
      return {
        ...tok,
        path: `${fileMode}.${tok.path}`,
        value: rewriteValRefs(tok.value, fileMode, localSet),
        ref: tok.ref ? rewriteRefStr(tok.ref, fileMode, localSet) : tok.ref,
      };
    });
    const single = validateDtcgTokens(adjusted);
    dtcgReports.push({ file: relTf, ...single });
    for (const tok of adjusted) {
      if (!dtcgFileByPath.has(tok.path)) dtcgFileByPath.set(tok.path, relTf);
    }
    mergedTokens.push(...adjusted);
  }
  const combinedDtcg = mergedTokens.length > 0 ? validateDtcgTokens(mergedTokens) : null;
  const dtcgModes = mergedTokens.length > 0 ? analyzeDtcgModesAndContrast(mergedTokens) : null;

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
      const ruleId = issue.type === "circular_reference" ? "dsaf/dtcg-circular-ref" : "dsaf/dtcg-unresolved-ref";
      ciActive.push({
        file: dtcgFileByPath.get(issue.path) || dtcgReports[0]?.file || "tokens.json",
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
      const rawMarkupCtx = scanMarkupContexts(commentFreeRaw, markupOpts);
      for (const blk of extractRealStyleBlocks(commentFreeRaw, rawMarkupCtx, markupOpts)) {
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
      for (const sd of findSvelteStyleDirectives(commentFreeRaw)) {
        if (!sd.isCustomProp) continue;
        if (!isFrameworkInternalVar(sd.prop)) {
          definedVars.add(sd.prop);
          if (!varDefLocations.has(sd.prop)) {
            varDefLocations.set(sd.prop, { file: rel, line: offsetToLine(commentFreeRaw, sd.start) });
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
    for (const m of commentFreeRaw.matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
      if (/^--(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|palette|raw)-?\d+/i.test(name)) {
        primitiveVarsUsed.add(name);
      }
    }
    for (const m of commentFreeRaw.matchAll(/(?<=^|[\s"'`:!])-?[a-z][a-z0-9-]*-\((?:[a-z-]+:)?--([a-zA-Z0-9_-]+)\)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
    }
    for (const m of commentFreeRaw.matchAll(/\b(?:getPropertyValue|setProperty)\(\s*["']--([a-zA-Z0-9_-]+)["']/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
    }
    for (const m of commentFreeRaw.matchAll(/(?:^|[\s"'`:/!])-?([a-z]+-[a-z0-9-]+)/g)) {
      seenUtilityClasses.add(m[1]);
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
      const nvChars = linePreservingSurface.split("");
      for (const r of embeddedStyleRanges) {
        const sliceRep = blankCssCustomPropDeclsPreservingLines(linePreservingSurface.slice(r.start, r.end));
        for (let k = 0; k < sliceRep.length && r.start + k < r.end; k++) nvChars[r.start + k] = sliceRep[k];
      }
      for (const attrMatch of linePreservingSurface.matchAll(/(?<![a-zA-Z0-9_:-])style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const val = attrMatch[1] !== undefined ? attrMatch[1] : attrMatch[2];
        const qChar = attrMatch[1] !== undefined ? '"' : "'";
        const attrStart = attrMatch.index + attrMatch[0].indexOf(qChar) + 1;
        const attrRep = blankCssCustomPropDeclsPreservingLines(val, { allowBracedExpr: true });
        for (let k = 0; k < attrRep.length && attrStart + k < attrStart + val.length; k++) {
          nvChars[attrStart + k] = attrRep[k];
        }
      }
      for (const sd of findSvelteStyleDirectives(linePreservingSurface)) {
        if (sd.isCustomProp) {
          maskRangePreservingLines(nvChars, sd.valStart, sd.valEnd);
        }
      }
      linePreservingNonVar = blankJsCustomPropEntriesPreservingLines(
        blankStyledTemplateCustomPropsPreservingLines(nvChars.join("")),
        markupOpts
      );
    }
    const varRefsInFile =
      (linePreservingNonVar.match(/var\(\s*--[a-zA-Z0-9_-]+/g) || []).length +
      (linePreservingNonVar.match(/(?<=^|[\s"'`:!])-?[a-z][a-z0-9-]*-\((?:[a-z-]+:)?--[a-zA-Z0-9_-]+\)/g) || []).length;
    colorTokenRefs += varRefsInFile;

    const twArbColorRe =
      /(?<=^|[\s"'`:!])((?:bg|text|border(?:-(?:t|r|b|l|x|y|s|e))?|divide|fill|stroke|ring(?:-offset)?|from|to|via|accent|outline|decoration|shadow|caret|placeholder)-\[#[^\]\s]+\]!?)/g;
    const twArbSpaceRe =
      /(?<=^|[\s"'`:!])(-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded(?:-[a-z]+)?)-\[\d+(?:\.\d+)?px\]!?)/g;
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
    for (const m of colorScanSurface.matchAll(HEX_COLOR_RE)) {
      fileColorDrift++;
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
      for (const m of maskedSlice.matchAll(/(?<![a-zA-Z0-9_$-:])([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
        if (!SPACING_RADIUS_CSS_PROP_RE.test(m[1])) continue;
        for (const pxm of stripCssVarNames(m[2]).matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
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
        for (const pxm of stripCssVarNames(resolvedVal).matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
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
      scanCssSpacingSlice(linePreservingNonVar, 0);
    } else {
      const jsChars = linePreservingNonVar.split("");
      for (const r of embeddedStyleRanges) {
        scanCssSpacingSlice(linePreservingNonVar.slice(r.start, r.end), r.start);
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
        for (const m of maskedTpl.matchAll(/(?<![a-zA-Z0-9_$-:])([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
          if (!SPACING_RADIUS_CSS_PROP_RE.test(m[1])) continue;
          const valStart = m.index + m[0].length - m[2].length;
          const valEnd = m.index + m[0].length;
          const expandedParts = [m[2]];
          for (const ph of placeholders) {
            if (ph.start >= valStart && ph.start < valEnd && maskedTpl[ph.start] === "_") {
              expandedParts.push(ph.val);
            }
          }
          const expandedVal = expandedParts.join(" ");
          for (const pxm of stripCssVarNames(expandedVal).matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
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
          for (const pxm of stripCssVarNames(branchVal).matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
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
          for (const pxm of e.val.matchAll(/(?<!\d\.)\b(\d+(?:\.\d+)?)px\b/g)) {
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
          "fill-",
          "stroke-",
          "from-",
          "to-",
          "via-",
          "outline-",
          "accent-",
          "decoration-",
          "shadow-",
          "caret-",
          "placeholder-",
        ].some((p) => seenUtilityClasses.has(p + slug))
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
    } else if (tv.startsWith("--font-") && seenUtilityClasses.has("font-" + tv.slice(7))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--shadow-") && seenUtilityClasses.has("shadow-" + tv.slice(9))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--text-") && seenUtilityClasses.has("text-" + tv.slice(7))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--animate-") && seenUtilityClasses.has("animate-" + tv.slice(10))) {
      usedVars.add(tv);
    } else if (tv.startsWith("--ease-") && seenUtilityClasses.has("ease-" + tv.slice(7))) {
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

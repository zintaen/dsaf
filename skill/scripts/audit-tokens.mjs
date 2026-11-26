#!/usr/bin/env node
/**
 * DSAF v0.4.0 — Deterministic W3C DTCG Token Validator & Codebase Drift Scanner.
 * Zero external dependencies. Validates $value/$type/{alias}/$ref tokens, Light/Dark
 * mode parity, token-level WCAG 2.2 + APCA-W3 contrast, and scans stylesheets/UI
 * components for hardcoded color drift, property-scoped spacing drift, !important
 * overrides, authored orphan CSS variables (excluding Tailwind @theme & JS refs),
 * Tailwind arbitrary/primitive drift, and emits SARIF 2.1.0 / GitHub annotations.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { apcaContrast, wcagContrast } from "./audit-runtime.mjs";
import {
  applyIgnores,
  CI_REPORT_VERSION,
  formatGithubAnnotations,
  formatSarif,
  offsetToLine,
  stripCommentsPreservingLines,
  stripTokenBlocksPreservingLines,
} from "./ci-report.mjs";

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
  "audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

const CODE_EXTS = new Set([".css", ".scss", ".tsx", ".jsx", ".vue", ".svelte", ".html"]);

const isFrameworkInternalVar = (v) =>
  /^--(tw|radix|next|vite|sb|storybook|chakra|mui|mantine|antd|wp|_+)-?|^--[a-z]{1,2}_/i.test(v);

const SPACING_RADIUS_CSS_PROP_RE =
  /^(?:padding|margin|gap|row-gap|column-gap|border-radius)(?:-(?:top|right|bottom|left|inline|block|start|end)(?:-[a-z]+)?)?$/i;

const SPACING_RADIUS_JS_PROP_RE =
  /\b(?:padding|paddingTop|paddingRight|paddingBottom|paddingLeft|paddingInline|paddingBlock|margin|marginTop|marginRight|marginBottom|marginLeft|marginInline|marginBlock|gap|rowGap|columnGap|borderRadius)\s*:\s*(["'`]?)([^"'`,}\n]+)\1/g;

function flattenTokens(source) {
  const tokens = [];
  function walk(node, path = [], inheritedType = null) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const hasValue = Object.prototype.hasOwnProperty.call(node, "$value") || Object.prototype.hasOwnProperty.call(node, "value");
    const hasRef = Object.prototype.hasOwnProperty.call(node, "$ref");
    const hasType = Object.prototype.hasOwnProperty.call(node, "$type") || Object.prototype.hasOwnProperty.call(node, "type");
    const nextType = hasType ? node.$type ?? node.type : inheritedType;
    if (hasValue || hasRef) {
      tokens.push({
        path: path.join("."),
        type: nextType ?? null,
        value: hasValue ? node.$value ?? node.value : null,
        ref: hasRef ? node.$ref : null,
        description: node.$description ?? node.description ?? null,
        rawExtensions: node.$extensions ?? node.extensions ?? null,
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$") || k === "type" || k === "description") continue;
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
  const refsByPath = new Map(
    tokens.map((t) => {
      const valRefs = collectRefsInValue(t.value, byPath);
      const refT = t.ref ? pointerTarget(t.ref, byPath) : null;
      return [t.path, refT ? [...valRefs, refT] : valRefs];
    })
  );

  const typeByPath = new Map();
  const issues = [];
  const circularSeen = new Set();

  function resolveType(tok, stack = []) {
    if (typeByPath.has(tok.path)) return typeByPath.get(tok.path);
    const target = aliasTarget(tok.value) ?? (tok.ref ? pointerTarget(tok.ref, byPath) : null);
    if (!target || !byPath.has(target) || stack.includes(tok.path)) {
      typeByPath.set(tok.path, tok.type ?? null);
      return tok.type ?? null;
    }
    const resolved = resolveType(byPath.get(target), [...stack, tok.path]);
    const finalType = tok.type ?? resolved ?? null;
    typeByPath.set(tok.path, finalType);
    return finalType;
  }

  for (const t of tokens) resolveType(t);

  for (const t of tokens) {
    for (const target of refsByPath.get(t.path) ?? []) {
      if (!byPath.has(target)) {
        issues.push({ type: "unresolved_reference", path: t.path, target });
      }
    }
  }

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
    for (const target of refsByPath.get(path) ?? []) {
      if (byPath.has(target)) detectCycles(target, [...stack, path]);
    }
  }

  for (const t of tokens) detectCycles(t.path);
  for (const t of tokens) {
    if (!typeByPath.get(t.path)) {
      issues.push({ type: "missing_type", path: t.path });
    }
  }

  const aliases = tokens.filter((t) => aliasTarget(t.value) !== null || Boolean(t.ref));
  const componentScoped = tokens.filter((t) => /(component|button|input|card|dialog|modal|badge|toast|table|nav|tabs)/i.test(t.path));
  const modernColors = tokens.filter((t) => typeof t.value === "string" && /(oklch|display-p3|color\(p3|lab\(|oklab\()/i.test(t.value));
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

function parseHexToRgb(hex) {
  const s = hex.slice(1).toLowerCase();
  if (s.length === 3 || s.length === 4) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  if (s.length === 6 || s.length === 8) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return null;
}

function normalizeHexKey(hex) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return null;
  const s = hex.slice(1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) return `#${s.slice(0, 6)}`;
  return null;
}

function resolveColorRgb(val, byPath, stack = []) {
  if (typeof val === "string") {
    const target = aliasTarget(val);
    if (target && byPath.has(target) && !stack.includes(target)) {
      return resolveColorRgb(byPath.get(target).value, byPath, [...stack, target]);
    }
    const hex = normalizeHexKey(val.trim());
    return hex ? parseHexToRgb(hex) : null;
  }
  if (val && typeof val === "object") {
    if (val.$ref) {
      const pt = pointerTarget(val.$ref, byPath);
      if (pt && byPath.has(pt) && !stack.includes(pt)) {
        return resolveColorRgb(byPath.get(pt).value, byPath, [...stack, pt]);
      }
    }
    if (Array.isArray(val.components) && val.components.length >= 3) {
      const scale = val.components.every((n) => typeof n === "number" && n >= 0 && n <= 1) ? 255 : 1;
      return [
        Math.round(val.components[0] * scale),
        Math.round(val.components[1] * scale),
        Math.round(val.components[2] * scale),
      ];
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

  for (const tok of tokens) {
    const extModes = tok.rawExtensions?.mode && typeof tok.rawExtensions.mode === "object" ? tok.rawExtensions.mode : null;
    if (extModes) {
      if (Object.prototype.hasOwnProperty.call(extModes, "light")) {
        lightKeys.add(tok.path);
        const rgb = resolveColorRgb(extModes.light, byPath, [tok.path]);
        if (rgb) resolvedColors.push({ path: tok.path, mode: "light", rgb });
      }
      if (Object.prototype.hasOwnProperty.call(extModes, "dark")) {
        darkKeys.add(tok.path);
        const rgb = resolveColorRgb(extModes.dark, byPath, [tok.path]);
        if (rgb) resolvedColors.push({ path: tok.path, mode: "dark", rgb });
      }
      continue;
    }

    const parts = tok.path.split(".");
    const lightIdx = parts.findIndex((p) => p.toLowerCase() === "light");
    const darkIdx = parts.findIndex((p) => p.toLowerCase() === "dark");
    let mode = "default";
    if (lightIdx !== -1) {
      mode = "light";
      lightKeys.add([...parts.slice(0, lightIdx), ...parts.slice(lightIdx + 1)].join("."));
    } else if (darkIdx !== -1) {
      mode = "dark";
      darkKeys.add([...parts.slice(0, darkIdx), ...parts.slice(darkIdx + 1)].join("."));
    }

    const rgb = resolveColorRgb(tok.value, byPath, [tok.path]);
    if (rgb) resolvedColors.push({ path: tok.path, mode, rgb });
  }

  const missingInDark = [...lightKeys].filter((k) => !darkKeys.has(k)).sort();
  const missingInLight = [...darkKeys].filter((k) => !lightKeys.has(k)).sort();
  const hasModes = lightKeys.size > 0 || darkKeys.size > 0;

  const fgRe = /(^|\.)(text|fg|foreground|ink|on-?[a-z]+)(\.|$)/i;
  const bgRe = /(^|\.)(bg|background|surface|canvas|card|panel)(\.|$)/i;
  const pairs = [];
  for (const fg of resolvedColors) {
    if (!fgRe.test(fg.path)) continue;
    for (const bg of resolvedColors) {
      if (!bgRe.test(bg.path) || fg.mode !== bg.mode) continue;
      if (pairs.length >= 36) break;
      const wcagRatio = Number(wcagContrast(fg.rgb, bg.rgb).toFixed(2));
      const apcaLc = apcaContrast(fg.rgb, bg.rgb);
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
    if (pairs.length >= 36) break;
  }

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
      wcagFailures: pairs.filter((p) => !p.wcagPassAA).length,
      apcaWarnings: pairs.filter((p) => !p.apcaPassBody).length,
      samplePairs: pairs.slice(0, 12),
    },
  };
}

/**
 * Strip CSS comments and custom-property definition blocks (:root, [data-theme], @theme)
 * so intentional token definitions are NOT flagged as hardcoded feature drift.
 */
function extractNonTokenDeclarations(cssText) {
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let idx = 0;
  let depth = 0;
  let skipDepth = null;
  let curHeader = "";

  while (idx < stripped.length) {
    const ch = stripped[idx];
    if (ch === "{") {
      depth++;
      const hdr = curHeader.trim();
      curHeader = "";
      if (
        skipDepth === null &&
        /(^|,|\s)(:root|\[data-theme[^\]]*\]|@theme(?:\s+inline)?\b|html\[data-uxs-theme[^\]]*\]|html\.(?:dark|light)\b|:host\b)/i.test(
          hdr
        )
      ) {
        skipDepth = depth;
      }
    } else if (ch === "}") {
      if (skipDepth !== null && depth === skipDepth) skipDepth = null;
      depth = Math.max(0, depth - 1);
      curHeader = "";
    } else {
      if (skipDepth === null) out.push(ch);
      if (depth === 0 || (skipDepth === null && ch !== ";" && ch !== "}")) {
        curHeader += ch;
        if (ch === ";") curHeader = "";
      }
    }
    idx++;
  }
  return out.join("");
}

function extractAtThemeVars(cssText) {
  const vars = new Set();
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /@theme(?:\s+inline)?\s*\{/gi;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    let idx = match.index + match[0].length;
    let depth = 1;
    const start = idx;
    while (idx < cleaned.length && depth > 0) {
      if (cleaned[idx] === "{") depth++;
      else if (cleaned[idx] === "}") depth--;
      idx++;
    }
    const block = cleaned.slice(start, Math.max(start, idx - 1));
    for (const m of block.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) vars.add(name);
    }
  }
  return vars;
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

function countOffGridSpacing(text, isStyleFile) {
  let hits = 0;
  const scanValue = (valStr) => {
    for (const m of valStr.matchAll(/\b(\d+)px\b/g)) {
      const n = parseInt(m[1], 10);
      if (n > 4 && n < 200 && n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14) {
        hits++;
      }
    }
  };
  if (isStyleFile) {
    for (const m of text.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}\n]+)/g)) {
      if (SPACING_RADIUS_CSS_PROP_RE.test(m[1])) scanValue(m[2]);
    }
  } else {
    for (const m of text.matchAll(SPACING_RADIUS_JS_PROP_RE)) {
      scanValue(m[2]);
    }
  }
  return hits;
}

export function scanTarget(targetPath, options = {}) {
  const baseTarget = options.scope ? join(resolve(targetPath), options.scope) : resolve(targetPath);
  const resolved = resolve(baseTarget);
  if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  const st = statSync(resolved);

  const tokenJsonFiles = [];
  const codeFiles = [];
  const demoFilesSkipped = [];

  if (st.isFile()) {
    if (resolved.endsWith(".json")) tokenJsonFiles.push(resolved);
    else if (CODE_EXTS.has(extname(resolved).toLowerCase())) codeFiles.push(resolved);
  } else {
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.isDirectory() && entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
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
        if (lower.endsWith(".json") && (/\.tokens\.json$/.test(lower) || /tokens?[^/]*\.json$/.test(lower))) {
          tokenJsonFiles.push(full);
        } else if (CODE_EXTS.has(extname(lower))) {
          codeFiles.push(full);
        }
      }
    }
    walk(resolved);
  }

  // 1. Validate W3C DTCG files
  const dtcgReports = [];
  const mergedTokens = [];
  const dtcgFileByPath = new Map();
  for (const tf of tokenJsonFiles.sort()) {
    try {
      const json = JSON.parse(readFileSync(tf, "utf8"));
      const flat = flattenTokens(json);
      if (flat.length === 0) continue;
      const single = validateDtcgTokens(flat);
      const relTf = st.isDirectory() ? relative(resolved, tf) : tf;
      dtcgReports.push({ file: relTf, ...single });
      for (const tok of flat) {
        if (!dtcgFileByPath.has(tok.path)) dtcgFileByPath.set(tok.path, relTf);
      }
      mergedTokens.push(...flat);
    } catch {
      // Skip non-token package/tooling JSON files
    }
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
  let offGridSpacingHits = 0;
  let importantCount = 0;
  let twArbitraryColors = 0;
  let twArbitrarySpacing = 0;
  let twPrimitiveColors = 0;
  const hardcodedHexSet = new Set();
  const serverImageFiles = [];
  const sampleViolations = [];
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
    for (const p of dtcgModes.contrast.samplePairs.filter((x) => !x.wcagPassAA)) {
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
    const isStyle = cf.endsWith(".css") || cf.endsWith(".scss");

    if (isStyle) {
      for (const tv of extractAtThemeVars(raw)) themeVars.add(tv);
    }
    for (const m of raw.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) {
        definedVars.add(name);
        if (!varDefLocations.has(name)) varDefLocations.set(name, { file: rel, line: offsetToLine(raw, m.index) });
      }
    }
    for (const m of raw.matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
      if (/^--(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|palette|raw)-?\d+/i.test(name)) {
        primitiveVarsUsed.add(name);
      }
    }
    for (const m of raw.matchAll(/\b(?:getPropertyValue|setProperty)\(\s*["']--([a-zA-Z0-9_-]+)["']/g)) {
      const name = `--${m[1]}`;
      if (!isFrameworkInternalVar(name)) usedVars.add(name);
    }
    for (const m of raw.matchAll(/(?:^|[\s"'`:/])([a-z]+-[a-z0-9-]+)/g)) {
      seenUtilityClasses.add(m[1]);
    }

    const driftSurface = isStyle ? extractNonTokenDeclarations(raw) : raw;
    const nonVarDecls = driftSurface.replace(/--[a-zA-Z0-9_-]+\s*:[^;}\n]+;?/g, "");

    const varRefsInFile = (nonVarDecls.match(/var\(\s*--[a-zA-Z0-9_-]+/g) || []).length;
    colorTokenRefs += varRefsInFile;

    const nonTwHexSurface = nonVarDecls.replace(/-\[#[^\]\s]+\]/g, "");
    const hexMatches = nonTwHexSurface.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const fnColorMatches = nonTwHexSurface.match(/\b(?:rgba?|hsla?|oklch|lab|oklab)\([^)]+\)/gi) || [];
    const fileColorDrift = hexMatches.length + fnColorMatches.length;
    hardcodedColorHits += fileColorDrift;

    for (const hx of hexMatches) {
      const norm = normalizeHexKey(hx);
      if (norm) hardcodedHexSet.add(norm);
    }

    const impMatches = driftSurface.match(/!important\b/g) || [];
    importantCount += impMatches.length;

    const fileOffGrid = countOffGridSpacing(nonVarDecls, isStyle);
    offGridSpacingHits += fileOffGrid;

    const fileTwArbColors = (raw.match(/(?:^|[\s"'`])(?:bg|text|border|fill|stroke|ring|from|to|via|accent|outline|decoration)-\[#[^\]\s]+\]/g) || []).length;
    const fileTwArbSpacing = (raw.match(/(?:^|[\s"'`])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded(?:-[a-z]+)?)-\[\d+(?:\.\d+)?px\]/g) || []).length;
    const fileTwPrimColors = (raw.match(/(?:^|[\s"'`])(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00)\b/g) || []).length;
    twArbitraryColors += fileTwArbColors;
    twArbitrarySpacing += fileTwArbSpacing;
    twPrimitiveColors += fileTwPrimColors;

    // Line-accurate CI findings & inline waiver resolution
    const linePreservingSurface = isStyle ? stripTokenBlocksPreservingLines(raw) : stripCommentsPreservingLines(raw);
    const linePreservingNonVar = linePreservingSurface.replace(/--[a-zA-Z0-9_-]+\s*:[^;}\n]+;?/g, (seg) => seg.replace(/[^\n]/g, " "));
    const linePreservingNonTw = linePreservingNonVar.replace(/-\[#[^\]\s]+\]/g, (seg) => seg.replace(/[^\n]/g, " "));
    const fileCiFindings = [];

    for (const m of linePreservingNonTw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(linePreservingNonTw, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded hex color \`${m[0]}\` outside token definitions.`,
      });
    }
    for (const m of linePreservingNonTw.matchAll(/\b(?:rgba?|hsla?|oklch|lab|oklab)\([^)]+\)/gi)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(linePreservingNonTw, m.index),
        ruleId: "dsaf/hardcoded-color",
        tier: "reflex",
        severity: "warning",
        message: `Hardcoded functional color \`${m[0]}\` outside token definitions.`,
      });
    }
    for (const m of linePreservingSurface.matchAll(/!important\b/g)) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(linePreservingSurface, m.index),
        ruleId: "dsaf/important-override",
        tier: "reflex",
        severity: "warning",
        message: "Disallowed `!important` override.",
      });
    }
    if (isStyle) {
      for (const m of linePreservingNonVar.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}\n]+)/g)) {
        if (!SPACING_RADIUS_CSS_PROP_RE.test(m[1])) continue;
        for (const pxm of m[2].matchAll(/\b(\d+)px\b/g)) {
          const n = parseInt(pxm[1], 10);
          if (n > 4 && n < 200 && n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14) {
            fileCiFindings.push({
              file: rel,
              line: offsetToLine(linePreservingNonVar, m.index),
              ruleId: "dsaf/off-grid-spacing",
              tier: "reflex",
              severity: "warning",
              message: `Off-grid spacing \`${m[1]}: ${n}px\`; use 4px/8px grid token.`,
            });
          }
        }
      }
    } else {
      for (const m of linePreservingNonVar.matchAll(SPACING_RADIUS_JS_PROP_RE)) {
        for (const pxm of m[2].matchAll(/\b(\d+)px\b/g)) {
          const n = parseInt(pxm[1], 10);
          if (n > 4 && n < 200 && n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14) {
            fileCiFindings.push({
              file: rel,
              line: offsetToLine(linePreservingNonVar, m.index),
              ruleId: "dsaf/off-grid-spacing",
              tier: "reflex",
              severity: "warning",
              message: `Off-grid inline spacing \`${n}px\`; use 4px/8px grid token.`,
            });
          }
        }
      }
    }
    for (const m of linePreservingSurface.matchAll(
      /(?:^|[\s"'`])(?:(?:bg|text|border|fill|stroke|ring|from|to|via|accent|outline|decoration)-\[#[^\]\s]+\]|(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded(?:-[a-z]+)?)-\[\d+(?:\.\d+)?px\])/g
    )) {
      fileCiFindings.push({
        file: rel,
        line: offsetToLine(linePreservingSurface, m.index),
        ruleId: "dsaf/tailwind-arbitrary",
        tier: "reflex",
        severity: "warning",
        message: `Tailwind arbitrary bracket utility \`${m[0].trim()}\`.`,
      });
    }

    const ignored = applyIgnores(fileCiFindings, raw, rel, {
      reportUnusedIgnores: Boolean(options.reportUnusedIgnores),
    });
    ciActive.push(...ignored.active);
    ciWaived.push(...ignored.waived);
    ciUnusedIgnores.push(...ignored.unusedIgnores);

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
      if (["bg-", "text-", "border-", "ring-", "fill-", "stroke-", "from-", "to-", "via-", "outline-", "accent-", "decoration-"].some((p) => seenUtilityClasses.has(p + slug))) {
        usedVars.add(tv);
      }
    } else if (tv.startsWith("--spacing-")) {
      const slug = tv.slice(10);
      if (["p-", "px-", "py-", "pt-", "pr-", "pb-", "pl-", "m-", "mx-", "my-", "mt-", "mr-", "mb-", "ml-", "gap-", "gap-x-", "gap-y-", "w-", "h-", "size-", "space-x-", "space-y-"].some((p) => seenUtilityClasses.has(p + slug))) {
        usedVars.add(tv);
      }
    } else if (tv.startsWith("--radius-")) {
      const slug = tv.slice(9);
      if (["rounded-", "rounded-t-", "rounded-b-", "rounded-l-", "rounded-r-"].some((p) => seenUtilityClasses.has(p + slug))) {
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

  for (const ov of semanticOrphans.slice(0, 50)) {
    const loc = varDefLocations.get(ov);
    if (loc) {
      ciActive.push({
        file: loc.file,
        line: loc.line,
        ruleId: "dsaf/semantic-orphan-var",
        tier: "finish",
        severity: "note",
        message: `Unused semantic CSS custom property \`${ov}\`.`,
      });
    }
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

    console.log("AUDIT_TOKENS_SELF_TEST_PASSED (DTCG + scoped CSS/@theme/Tailwind + fixture/OG + demo/scale + SARIF/waivers)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
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
  });

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-tokens.mjs <dir-or-tokens-json> [--scope <subdir>] [--include-demos] [--json] [--out <file>] [--sarif <file>] [--format json|sarif] [--github] [--report-unused-ignores] [--self-test]"
    );
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
  const target = positionals[0];
  if (!target) {
    console.error("Error: <dir-or-tokens-json> is required unless --self-test is passed.");
    process.exit(2);
  }

  const result = scanTarget(target, {
    includeDemos: values["include-demos"],
    scope: values.scope,
    reportUnusedIgnores: values["report-unused-ignores"],
  });
  const outJson = JSON.stringify(result, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), outJson, "utf8");
  }

  const repoRoot = statSync(resolve(target)).isDirectory() ? resolve(target) : dirname(resolve(target));
  const sarifObj = formatSarif(result.ciFindings.active, { toolVersion: CI_REPORT_VERSION, repoRoot });
  if (values.sarif) {
    mkdirSync(dirname(resolve(values.sarif)), { recursive: true });
    writeFileSync(resolve(values.sarif), JSON.stringify(sarifObj, null, 2) + "\n", "utf8");
  }

  if (values.format === "sarif") {
    process.stdout.write(JSON.stringify(sarifObj, null, 2) + "\n");
  } else if (values.github) {
    const ann = formatGithubAnnotations(result.ciFindings.active, { repoRoot });
    if (ann) process.stdout.write(ann + "\n");
  } else if (values.json || values.format === "json") {
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
      `CSS Drift: compliance=${d.tokenCompliancePct ?? "N/A"}% (varRefs=${d.colorTokenRefs} vs hardcoded=${d.hardcodedColorHits}) | orphans=${d.orphanCssVariableCount} (semantic=${d.semanticOrphanCount}, scale=${d.paletteScaleUnusedCount}) | !important=${d.importantOverrides} | offGridPx=${d.offGridSpacingHits} | nearDupHexClusters=${d.nearDuplicateHexClusters.length} | twArbColor=${d.tailwind.arbitraryColors} twArbPx=${d.tailwind.arbitrarySpacing} twPrim=${d.tailwind.primitiveColors}${ogNote}${demoNote}${scopeNote}`
    );
    console.log(
      `CI Gate Tiers: floor=${cf.floor} reflex=${cf.reflex} finish=${cf.finish} waived=${cf.waived} unusedIgnores=${cf.unusedIgnores}`
    );
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

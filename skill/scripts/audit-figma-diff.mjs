#!/usr/bin/env node
/**
 * DSAF v0.3.0 — Automated 3-Vertex Figma MCP / Code Connect Triangulation CLI.
 * Compares Designed (Figma variable JSON + optional Code Connect *.figma.* files)
 * against Defined (W3C DTCG tokens / CSS variables / audit-tokens JSON) and optional
 * Shipped runtime summary (`audit-runtime --json`). Zero external dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

function normalizeKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .replace(/^--+/, "")
    .replace(/[/_\\\s]+/g, ".")
    .replace(/(^|\.)@+/g, "$1")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
}

function canonKey(key) {
  return String(key || "").replaceAll("-", ".");
}

function stripPrimitivesSegment(key) {
  return String(key || "")
    .replace(/(?:_|\.)primitives(?=\.|$)/gi, "")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

function normalizeValue(val) {
  if (val == null) return null;
  if (typeof val === "object" && Array.isArray(val.components) && val.components.length >= 3) {
    const scale = val.components.every((n) => typeof n === "number" && n >= 0 && n <= 1) ? 255 : 1;
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n * scale))).toString(16).padStart(2, "0");
    return `#${toHex(val.components[0])}${toHex(val.components[1])}${toHex(val.components[2])}`;
  }
  const s = String(val).trim().toLowerCase().replace(/\s+/g, " ");
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{8}$/i.test(s) && s.endsWith("ff")) {
    return s.slice(0, 7);
  }
  return s;
}

const FONT_WEIGHT_NAMES = {
  thin: "100",
  "extra light": "200",
  extralight: "200",
  "extra-light": "200",
  light: "300",
  regular: "400",
  normal: "400",
  medium: "500",
  "semi bold": "600",
  semibold: "600",
  "semi-bold": "600",
  bold: "700",
  "extra bold": "800",
  extrabold: "800",
  "extra-bold": "800",
  black: "900",
};

function parseLengthPx(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)(px|rem)?$/i);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || "").toLowerCase();
  return unit === "rem" ? num * 16 : num;
}

function normalizeWeightOrFont(v) {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase().replace(/\s+/g, " ");
  if (FONT_WEIGHT_NAMES[s]) return FONT_WEIGHT_NAMES[s];
  const italicMatch = s.match(/^(.+?)\s+italic$/);
  if (italicMatch && FONT_WEIGHT_NAMES[italicMatch[1].trim()]) {
    return `${FONT_WEIGHT_NAMES[italicMatch[1].trim()]} italic`;
  }
  return s;
}

function extractPrimaryFont(v) {
  if (typeof v !== "string") return null;
  if (!v.includes(",") && !/^["']/.test(v.trim())) return null;
  return v.split(",")[0].trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

export function valuesMatch(fVal, dVal) {
  if (fVal === dVal) return true;
  if (fVal == null || dVal == null) return false;
  const pxA = parseLengthPx(fVal);
  const pxB = parseLengthPx(dVal);
  if (pxA !== null && pxB !== null && Math.abs(pxA - pxB) <= 0.05) return true;
  if (normalizeWeightOrFont(fVal) === normalizeWeightOrFont(dVal)) return true;
  const pfA = extractPrimaryFont(fVal);
  const pfB = extractPrimaryFont(dVal);
  if ((pfA !== null || pfB !== null) && (pfA ?? String(fVal).trim().toLowerCase()) === (pfB ?? String(dVal).trim().toLowerCase())) {
    return true;
  }
  return false;
}

function flattenGenericTokens(node, prefix = [], out = new Map(), rawAliases = new Map()) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  const hasVal = Object.prototype.hasOwnProperty.call(node, "$value") || Object.prototype.hasOwnProperty.call(node, "value");
  if (hasVal) {
    const v = node.$value ?? node.value;
    const key = normalizeKey(prefix.join("."));
    if (key) {
      if (typeof v === "string" && /^\{([^}]+)\}$/.test(v.trim())) {
        rawAliases.set(key, normalizeKey(v.trim().slice(1, -1)));
      } else {
        const norm = normalizeValue(v);
        if (norm !== null) out.set(key, norm);
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$") || k === "type" || k === "description") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenGenericTokens(v, [...prefix, k], out, rawAliases);
    } else if (v != null && (typeof v === "string" || typeof v === "number")) {
      const key = normalizeKey([...prefix, k].join("."));
      const str = String(v).trim();
      if (/^\{([^}]+)\}$/.test(str)) {
        rawAliases.set(key, normalizeKey(str.slice(1, -1)));
      } else {
        out.set(key, normalizeValue(str));
      }
    }
  }
  return out;
}

function resolveAliases(valuesMap, aliasesMap) {
  const canonValues = new Map();
  const canonAliases = new Map();
  for (const [k, v] of valuesMap.entries()) {
    const ck = canonKey(k);
    if (!canonValues.has(ck)) canonValues.set(ck, v);
  }
  for (const [k, t] of aliasesMap.entries()) {
    const ck = canonKey(k);
    if (!canonAliases.has(ck)) canonAliases.set(ck, canonKey(t));
  }

  const resolveOne = (key, stack = []) => {
    if (valuesMap.has(key)) return valuesMap.get(key);
    const ck = canonKey(key);
    if (canonValues.has(ck)) return canonValues.get(ck);
    const target = aliasesMap.get(key) ?? canonAliases.get(ck);
    if (!target || stack.includes(ck)) return null;
    const val = resolveOne(target, [...stack, ck]);
    if (val !== null) canonValues.set(ck, val);
    return val;
  };
  for (const k of aliasesMap.keys()) {
    const val = resolveOne(k);
    if (val !== null) valuesMap.set(k, val);
  }
}

export function loadFigmaVariables(figmaPath) {
  const raw = JSON.parse(readFileSync(resolve(figmaPath), "utf8"));
  const out = new Map();
  const aliases = new Map();
  const root = raw.variables && typeof raw.variables === "object" ? raw.variables : raw;
  flattenGenericTokens(root, [], out, aliases);
  resolveAliases(out, aliases);
  const figmaComponents = Array.isArray(raw.components) ? raw.components.map(String) : [];
  return { variables: out, components: figmaComponents };
}

function extractDefaultCssText(cssText) {
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let idx = 0;
  let depth = 0;
  let skipDepth = null;
  let curHeader = "";

  while (idx < cleaned.length) {
    const ch = cleaned[idx];
    if (ch === "{") {
      depth++;
      const hdr = curHeader.trim();
      curHeader = "";
      if (
        skipDepth === null &&
        (/(?:@media[^{]*prefers-color-scheme\s*:\s*dark)/i.test(hdr) ||
          /(?:^|,|\s)(?:html|body|:root)?(?:\[data-(?:theme|uxs-theme)\s*=\s*["']?dark["']?\]|\.dark\b)/i.test(hdr))
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

function extractCssCustomProperties(cssText, outMap, aliasesMap) {
  const defaultCss = extractDefaultCssText(cssText);
  for (const m of defaultCss.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;{}\n]+)/g)) {
    const varName = m[1].toLowerCase();
    const rawVal = m[2].trim();
    const dotKey = normalizeKey(varName.replaceAll("-", "."));
    const rawKey = normalizeKey(varName);
    const varMatch = rawVal.match(/^var\(\s*--([a-zA-Z0-9_-]+)(?:\s*,([^)]+))?\)$/i);
    if (varMatch) {
      const targetDot = normalizeKey(varMatch[1].replaceAll("-", "."));
      if (!aliasesMap.has(dotKey) && !outMap.has(dotKey)) aliasesMap.set(dotKey, targetDot);
      if (rawKey !== dotKey && !aliasesMap.has(rawKey) && !outMap.has(rawKey)) aliasesMap.set(rawKey, targetDot);
      continue;
    }
    const norm = normalizeValue(rawVal);
    if (norm === null) continue;
    if (!outMap.has(dotKey)) outMap.set(dotKey, norm);
    if (rawKey !== dotKey && !outMap.has(rawKey)) outMap.set(rawKey, norm);
  }
}

export function loadDefinedTokens(tokensArg, excludeFiles = new Set()) {
  const abs = resolve(tokensArg);
  if (!existsSync(abs)) throw new Error(`Tokens target not found: ${abs}`);
  const out = new Map();
  const aliases = new Map();
  const st = statSync(abs);

  const scanDir = (dir) => {
    const skip = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "audit-output", "draft"]);
    const walk = (cur) => {
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        if (skip.has(e.name) || (e.isDirectory() && e.name.startsWith("."))) continue;
        const full = join(cur, e.name);
        if (e.isDirectory()) walk(full);
        else {
          if (excludeFiles.has(resolve(full))) continue;
          const low = e.name.toLowerCase();
          if (low.endsWith(".json") && (/\.tokens\.json$/.test(low) || /tokens?[^/]*\.json$/.test(low))) {
            try {
              flattenGenericTokens(JSON.parse(readFileSync(full, "utf8")), [], out, aliases);
            } catch {}
          } else if (low.endsWith(".css") || low.endsWith(".scss")) {
            extractCssCustomProperties(readFileSync(full, "utf8"), out, aliases);
          }
        }
      }
    };
    walk(dir);
  };

  if (st.isDirectory()) {
    scanDir(abs);
  } else if (abs.endsWith(".json")) {
    const json = JSON.parse(readFileSync(abs, "utf8"));
    if (json.schema && String(json.schema).startsWith("dsaf-tokens/")) {
      if (json.target && existsSync(json.target) && statSync(json.target).isDirectory()) {
        scanDir(json.target);
      }
      if (Array.isArray(json.dtcgFiles)) {
        for (const df of json.dtcgFiles) {
          const p = json.target && existsSync(join(json.target, df.file)) ? join(json.target, df.file) : df.file;
          if (existsSync(p) && statSync(p).isFile() && !excludeFiles.has(resolve(p))) {
            try {
              flattenGenericTokens(JSON.parse(readFileSync(p, "utf8")), [], out, aliases);
            } catch {}
          }
        }
      }
    } else if (!excludeFiles.has(abs)) {
      flattenGenericTokens(json, [], out, aliases);
    }
  } else if (!excludeFiles.has(abs)) {
    extractCssCustomProperties(readFileSync(abs, "utf8"), out, aliases);
  }

  resolveAliases(out, aliases);
  return out;
}

export function scanCodeConnect(codeConnectDir) {
  if (!codeConnectDir) return null;
  const abs = resolve(codeConnectDir);
  if (!existsSync(abs)) throw new Error(`Code Connect directory not found: ${abs}`);
  const skip = new Set([".git", "node_modules", "dist", "build", ".next"]);
  const files = [];
  const mappedComponents = new Set();
  let batchEntriesCount = 0;

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || (e.isDirectory() && e.name.startsWith("."))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.figma(?:\.batch)?\.(ts|tsx|js|jsx)$/i.test(e.name)) {
        const txt = readFileSync(full, "utf8");
        const found = new Set();

        for (const m of txt.matchAll(/figma\.connect\(\s*([A-Za-z0-9_.]+)/g)) {
          found.add(m[1]);
        }
        for (const m of txt.matchAll(/\/\/\s*component\s*=\s*([A-Za-z0-9_.-]+)/g)) {
          found.add(m[1]);
        }
        for (const m of txt.matchAll(/export\s+default\s*\{[\s\S]*?\bid\s*:\s*["']([A-Za-z0-9_.-]+)["']/g)) {
          found.add(m[1]);
        }

        if (/\.figma\.batch\.(ts|tsx|js|jsx)$/i.test(e.name)) {
          const jsonPath = full.replace(/\.(ts|tsx|js|jsx)$/i, ".json");
          if (existsSync(jsonPath)) {
            try {
              const batchData = JSON.parse(readFileSync(jsonPath, "utf8"));
              const items = Array.isArray(batchData) ? batchData : Array.isArray(batchData?.components) ? batchData.components : [];
              for (const item of items) {
                const name = typeof item === "string" ? item : item?.component || item?.name || item?.id;
                if (typeof name === "string" && name.trim()) {
                  found.add(name.trim());
                  batchEntriesCount++;
                }
              }
            } catch {}
          }
        }

        const list = [...found].sort();
        for (const comp of list) mappedComponents.add(comp);
        files.push({ file: relative(abs, full).replace(/\\/g, "/"), connections: list });
      }
    }
  };
  walk(abs);
  return {
    directory: abs,
    codeConnectFiles: files.length,
    batchEntriesCount,
    mappedComponentsCount: mappedComponents.size,
    mappedComponents: [...mappedComponents].sort(),
    files,
  };
}

function detectDominantPrefix(definedMap, figmaMap) {
  const segCounts = new Map();
  let total = 0;
  for (const k of definedMap.keys()) {
    const dot = k.indexOf(".");
    if (dot <= 0) continue;
    total++;
    const seg = k.slice(0, dot);
    segCounts.set(seg, (segCounts.get(seg) || 0) + 1);
  }
  if (total === 0) return null;
  let topSeg = null;
  let topCount = 0;
  for (const [seg, cnt] of segCounts.entries()) {
    if (cnt > topCount) {
      topSeg = seg;
      topCount = cnt;
    }
  }
  if (!topSeg || topCount / total < 0.6) return null;
  const figmaPrefixCount = [...figmaMap.keys()].filter((k) => k.startsWith(`${topSeg}.`)).length;
  if (figmaMap.size > 0 && figmaPrefixCount / figmaMap.size >= 0.1) return null;
  return topSeg;
}

export function compareVertices({ figmaPath, tokensArg, codeConnectDir = null, runtimePath = null, prefix = null }) {
  const absFigma = resolve(figmaPath);
  const figma = loadFigmaVariables(absFigma);
  const defined = loadDefinedTokens(tokensArg, new Set([absFigma]));
  const codeConnect = scanCodeConnect(codeConnectDir);

  let shippedSummary = null;
  const shippedVarsRaw = new Map();
  if (runtimePath) {
    const rt = JSON.parse(readFileSync(resolve(runtimePath), "utf8"));
    const firstCheck = rt.files?.[0]?.checks?.[0];
    for (const f of rt.files || []) {
      if (f.computedVars && typeof f.computedVars === "object") {
        for (const [k, v] of Object.entries(f.computedVars)) {
          if (!shippedVarsRaw.has(k)) shippedVarsRaw.set(k, v);
        }
      }
    }
    shippedSummary = {
      schema: rt.schema || null,
      allPassed: Boolean(rt.allPassed),
      filesAudited: rt.files?.length ?? 0,
      apcaBodyMin: firstCheck?.apca?.minBodyLc ?? null,
      buttonSignatures: firstCheck?.componentInventory?.buttons?.distinctSignatures ?? null,
      shippedVarsSampled: shippedVarsRaw.size,
      shippedMatchedCount: 0,
      shippedDriftCount: 0,
      shippedDrift: [],
      definedNotShippedCount: 0,
      definedNotShipped: [],
    };
  }

  const activePrefix = prefix ? normalizeKey(prefix) : detectDominantPrefix(defined, figma.variables);
  const directLookup = new Map();
  const strippedLookup = new Map();
  for (const [dKey, dVal] of defined.entries()) {
    const ck = canonKey(dKey);
    if (!directLookup.has(dKey)) directLookup.set(dKey, { key: dKey, value: dVal });
    if (!directLookup.has(ck)) directLookup.set(ck, { key: dKey, value: dVal });
    if (activePrefix && dKey.startsWith(`${activePrefix}.`)) {
      const bare = dKey.slice(activePrefix.length + 1);
      const bareCanon = canonKey(bare);
      if (!strippedLookup.has(bare)) strippedLookup.set(bare, { key: dKey, value: dVal });
      if (!strippedLookup.has(bareCanon)) strippedLookup.set(bareCanon, { key: dKey, value: dVal });
    }
  }

  const matchedTokens = [];
  const matchedPairs = [];
  const valueDrift = [];
  const designOnlyTokens = [];
  const matchedDefinedCanons = new Set();

  const resolveDefinedEntry = (fKey) => {
    const candidates = [
      fKey,
      canonKey(fKey),
      stripPrimitivesSegment(fKey),
      canonKey(stripPrimitivesSegment(fKey)),
    ];
    for (const cand of candidates) {
      if (directLookup.has(cand)) return directLookup.get(cand);
    }
    for (const cand of candidates) {
      if (strippedLookup.has(cand)) return strippedLookup.get(cand);
    }
    return null;
  };

  for (const [fKey, fVal] of [...figma.variables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const found = resolveDefinedEntry(fKey);
    if (!found) {
      designOnlyTokens.push({ key: fKey, figmaValue: fVal });
    } else {
      matchedDefinedCanons.add(canonKey(found.key));
      if (valuesMatch(fVal, found.value)) {
        matchedTokens.push({ key: fKey, value: found.value });
        matchedPairs.push({ figmaKey: fKey, definedKey: found.key, value: found.value });
      } else {
        valueDrift.push({ key: fKey, figmaValue: fVal, definedValue: found.value });
      }
    }
  }

  if (shippedSummary && shippedVarsRaw.size > 0) {
    const shippedNorm = new Map();
    for (const [cssVar, val] of shippedVarsRaw.entries()) {
      const nk = normalizeKey(cssVar);
      const ck = canonKey(nk);
      const normVal = normalizeValue(val);
      if (nk && !shippedNorm.has(nk)) shippedNorm.set(nk, { cssVar, value: normVal });
      if (ck && !shippedNorm.has(ck)) shippedNorm.set(ck, { cssVar, value: normVal });
      if (activePrefix && nk.startsWith(`${activePrefix}.`)) {
        const bare = nk.slice(activePrefix.length + 1);
        const bareCanon = canonKey(bare);
        if (!shippedNorm.has(bare)) shippedNorm.set(bare, { cssVar, value: normVal });
        if (!shippedNorm.has(bareCanon)) shippedNorm.set(bareCanon, { cssVar, value: normVal });
      }
    }
    const seenDefined = new Set();
    for (const pair of matchedPairs) {
      const ck = canonKey(pair.definedKey);
      if (seenDefined.has(ck)) continue;
      seenDefined.add(ck);
      const cands = [pair.definedKey, ck, stripPrimitivesSegment(pair.definedKey), canonKey(stripPrimitivesSegment(pair.definedKey))];
      let hit = null;
      for (const c of cands) {
        if (shippedNorm.has(c)) {
          hit = shippedNorm.get(c);
          break;
        }
      }
      if (!hit) {
        shippedSummary.definedNotShipped.push({ key: pair.figmaKey, definedValue: pair.value });
      } else if (valuesMatch(pair.value, hit.value)) {
        shippedSummary.shippedMatchedCount++;
      } else {
        shippedSummary.shippedDrift.push({
          key: pair.figmaKey,
          cssVar: hit.cssVar,
          definedValue: pair.value,
          shippedValue: hit.value,
        });
      }
    }
    shippedSummary.shippedDriftCount = shippedSummary.shippedDrift.length;
    shippedSummary.definedNotShippedCount = shippedSummary.definedNotShipped.length;
    shippedSummary.definedNotShipped = shippedSummary.definedNotShipped.slice(0, 25);
  }

  const codeOnlyTokens = [];
  const seenCodeNorms = new Set();
  for (const [dKey, dVal] of [...defined.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dotted = canonKey(dKey);
    if (matchedDefinedCanons.has(dotted)) continue;
    if (seenCodeNorms.has(dotted)) continue;
    seenCodeNorms.add(dotted);
    codeOnlyTokens.push({ key: dotted, definedValue: dVal });
  }

  const totalFigma = figma.variables.size;
  const triangulationCoveragePct = totalFigma > 0 ? Number(((matchedTokens.length / totalFigma) * 100).toFixed(1)) : null;

  return {
    schema: "dsaf-figma-diff/1",
    generated: new Date().toISOString(),
    triangulationStatus: "3-vertex (Designed <-> Defined <-> Shipped)",
    summary: {
      figmaVariables: totalFigma,
      definedVariablesSampled: defined.size,
      detectedPrefix: activePrefix,
      matchedCount: matchedTokens.length,
      valueDriftCount: valueDrift.length,
      designOnlyCount: designOnlyTokens.length,
      codeOnlyCount: codeOnlyTokens.length,
      triangulationCoveragePct,
    },
    matchedTokens,
    valueDrift,
    designOnlyTokens,
    codeOnlyTokens: codeOnlyTokens.slice(0, 40),
    codeConnect,
    shippedSummary,
  };
}

export function renderMarkdown(res) {
  const s = res.summary;
  const lines = [
    "# DSAF 3-Vertex Figma Triangulation Report",
    "",
    `- **Status:** ${res.triangulationStatus}`,
    `- **Triangulation Coverage:** ${s.triangulationCoveragePct ?? "N/A"}% (${s.matchedCount}/${s.figmaVariables} exact/equivalent matches)${s.detectedPrefix ? ` | Prefix: \`--${s.detectedPrefix}-*\`` : ""}`,
    `- **Value Drift:** ${s.valueDriftCount} | **Design-Only:** ${s.designOnlyCount} | **Code-Only:** ${s.codeOnlyCount}`,
    "",
  ];
  if (res.valueDrift.length > 0) {
    lines.push("## Value Drift (`Designed` vs `Defined`)", "", "| Token | Figma (`Designed`) | Code (`Defined`) |", "|---|---|---|");
    for (const d of res.valueDrift.slice(0, 40)) lines.push(`| \`${d.key}\` | \`${d.figmaValue}\` | \`${d.definedValue}\` |`);
    lines.push("");
  }
  if (res.designOnlyTokens.length > 0) {
    lines.push("## Design-Only Tokens (Missing in Code)", "");
    for (const t of res.designOnlyTokens.slice(0, 20)) lines.push(`- \`${t.key}\`: \`${t.figmaValue}\``);
    lines.push("");
  }
  if (res.shippedSummary?.shippedVarsSampled > 0) {
    const sh = res.shippedSummary;
    lines.push(
      "## Shipped Runtime Verification (Vertex 3)",
      "",
      `- Computed CSS Vars Sampled: ${sh.shippedVarsSampled} | Matched: ${sh.shippedMatchedCount} | Runtime Drift: ${sh.shippedDriftCount} | Defined-Not-Shipped: ${sh.definedNotShippedCount}`,
      ""
    );
    if (sh.shippedDrift.length > 0) {
      lines.push("| Token | CSS Var | Defined | Shipped |", "|---|---|---|---|");
      for (const d of sh.shippedDrift.slice(0, 30)) lines.push(`| \`${d.key}\` | \`${d.cssVar}\` | \`${d.definedValue}\` | \`${d.shippedValue}\` |`);
      lines.push("");
    }
  }
  if (res.codeConnect) {
    const previewList = res.codeConnect.mappedComponents.slice(0, 25).join(", ");
    const extra = res.codeConnect.mappedComponentsCount > 25 ? `, ... (+${res.codeConnect.mappedComponentsCount - 25} more)` : "";
    lines.push(
      "## Code Connect Coverage",
      "",
      `- Files: ${res.codeConnect.codeConnectFiles}${res.codeConnect.batchEntriesCount ? ` (incl. ${res.codeConnect.batchEntriesCount} batch entries)` : ""} | Mapped Components: ${res.codeConnect.mappedComponentsCount} (${previewList ? previewList + extra : "none"})`,
      ""
    );
  }
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-figma-diff-test-"));
  try {
    // 1. Classic DTCG + Code Connect figma.connect() test
    const figmaPath = join(scratch, "figma-vars.json");
    const tokensPath = join(scratch, "design.tokens.json");
    const ccDir = join(scratch, "src");
    mkdirSync(ccDir, { recursive: true });

    writeFileSync(
      figmaPath,
      JSON.stringify({
        "color/brand/primary": "#1d4ed8",
        "color/surface/canvas": "#FFFFFF",
        "color/accent/warning": "#f59e0b",
        "spacing/md": "16px",
      })
    );
    writeFileSync(
      tokensPath,
      JSON.stringify({
        primitive: { blue: { $type: "color", $value: "#1d4ed8" } },
        color: {
          brand: { primary: { $type: "color", $value: "{primitive.blue}" } },
          surface: { canvas: { $type: "color", $value: "#f8fafc" } },
          danger: { $type: "color", $value: "#dc2626" },
        },
        spacing: { md: { $type: "dimension", $value: "16px" } },
      })
    );
    writeFileSync(
      join(ccDir, "Button.figma.tsx"),
      `import figma from "@figma/code-connect";\nimport { Button } from "./Button";\nfigma.connect(Button, "https://figma.com/file/abc", { props: {} });\n`
    );

    const diff = compareVertices({ figmaPath, tokensArg: tokensPath, codeConnectDir: ccDir });
    assert.equal(diff.summary.figmaVariables, 4);
    assert.equal(diff.summary.matchedCount, 2, "color.brand.primary (via alias) and spacing.md must match");
    assert.equal(diff.summary.valueDriftCount, 1, "color.surface.canvas #ffffff vs #f8fafc must drift");
    assert.equal(diff.valueDrift[0].key, "color.surface.canvas");
    assert.equal(diff.summary.designOnlyCount, 1, "color.accent.warning is design-only");
    assert.equal(diff.codeConnect.codeConnectFiles, 1);
    assert.deepEqual(diff.codeConnect.mappedComponents, ["Button"]);
    assert.match(renderMarkdown(diff), /Value Drift/);

    // 2. Real-world edge cases: @collection prefixes, *_primitives, CSS var() aliases,
    //    prefers-color-scheme: dark preservation, auto --prefix, px<->rem, font stacks,
    //    self-file exclusion, and Code Connect v2 template + batch JSON.
    const repoDir = join(scratch, "ds-repo");
    mkdirSync(join(repoDir, "tokens"), { recursive: true });
    mkdirSync(join(repoDir, "src/figma"), { recursive: true });
    const repoFigmaPath = join(repoDir, "tokens/figma.tokens.json");
    const repoCssPath = join(repoDir, "src/theme.css");

    writeFileSync(
      repoFigmaPath,
      JSON.stringify({
        "@color_primitives": {
          brand: { "800": { $type: "color", $value: "#2c2c2c" } },
        },
        "@color": {
          background: {
            brand: { default: { $type: "color", $value: "{@color_primitives.Brand.800}" } },
          },
        },
        "@typography_primitives": {
          "family-sans": { $type: "fontFamily", $value: "Inter" },
          "scale-03": { $type: "number", $value: 16 },
          "weight-bold-italic": { $type: "unknown", $value: "Bold Italic" },
        },
        "@typography": {
          body: { "font-family": { $type: "fontFamily", $value: "{@typography_primitives.Family Sans}" } },
        },
        "@size": {
          space: { "400": { $type: "number", $value: 16 } },
        },
      })
    );
    writeFileSync(
      repoCssPath,
      `:root {
  --ds-color-brand-800: #2c2c2c;
  --ds-color-background-brand-default: var(--ds-color-brand-800);
  --ds-typography-family-sans: "inter", sans-serif;
  --ds-typography-scale-03: 1rem;
  --ds-typography-weight-bold-italic: 700 italic;
  --ds-typography-body-font-family: var(--ds-typography-family-sans);
  --ds-size-space-400: 1rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ds-color-background-brand-default: #f5f5f5;
  }
}`
    );
    writeFileSync(
      join(repoDir, "src/figma/Card.figma.ts"),
      `// component=Card\nexport default { id: "Card", example: "<Card />" };\n`
    );
    writeFileSync(
      join(repoDir, "src/figma/Icons.figma.batch.ts"),
      `const component = figma.batch.component;\nexport default { id: component };\n`
    );
    writeFileSync(
      join(repoDir, "src/figma/Icons.figma.batch.json"),
      JSON.stringify({ components: [{ component: "IconCheck" }, { component: "IconAlert" }] })
    );

    const realDiff = compareVertices({
      figmaPath: repoFigmaPath,
      tokensArg: repoDir,
      codeConnectDir: join(repoDir, "src/figma"),
    });
    assert.equal(realDiff.summary.detectedPrefix, "ds");
    assert.equal(realDiff.summary.figmaVariables, 7);
    assert.equal(realDiff.summary.matchedCount, 7, `Expected 7/7 matches, got ${JSON.stringify(realDiff)}`);
    assert.equal(realDiff.summary.valueDriftCount, 0);
    assert.equal(realDiff.summary.codeOnlyCount, 0);
    assert.equal(realDiff.codeConnect.codeConnectFiles, 2);
    assert.equal(realDiff.codeConnect.batchEntriesCount, 2);
    assert.deepEqual(realDiff.codeConnect.mappedComponents, ["Card", "IconAlert", "IconCheck"]);

    // 3. Vertex 3 Shipped computedVars comparison (--runtime runtime.json)
    const runtimeJsonPath = join(scratch, "runtime.json");
    writeFileSync(
      runtimeJsonPath,
      JSON.stringify({
        schema: "dsaf-runtime/2",
        allPassed: true,
        files: [
          {
            file: "index.html",
            computedVars: {
              "--ds-color-brand-800": "#2c2c2c",
              "--ds-color-background-brand-default": "#ff0000",
            },
            checks: [{ apca: { minBodyLc: 85 }, componentInventory: { buttons: { distinctSignatures: 2 } } }],
          },
        ],
      })
    );
    const v3Diff = compareVertices({
      figmaPath: repoFigmaPath,
      tokensArg: repoDir,
      codeConnectDir: join(repoDir, "src/figma"),
      runtimePath: runtimeJsonPath,
    });
    assert.equal(v3Diff.shippedSummary.shippedVarsSampled, 2);
    assert.equal(v3Diff.shippedSummary.shippedMatchedCount, 1);
    assert.equal(v3Diff.shippedSummary.shippedDriftCount, 1);
    assert.equal(v3Diff.shippedSummary.shippedDrift[0].shippedValue, "#ff0000");
    assert.match(renderMarkdown(v3Diff), /Shipped Runtime Verification \(Vertex 3\)/);

    console.log("AUDIT_FIGMA_DIFF_SELF_TEST_PASSED (alias resolve + value drift + Vertex 3 shipped + Code Connect v2)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      figma: { type: "string" },
      tokens: { type: "string" },
      prefix: { type: "string" },
      "code-connect": { type: "string" },
      runtime: { type: "string" },
      format: { type: "string", default: "json" },
      out: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-figma-diff.mjs --figma <figma-vars.json> --tokens <tokens.json|dir|tokens-report.json> [--prefix <str>] [--code-connect <dir>] [--runtime <runtime.json>] [--format json|markdown] [--out <file>] [--self-test]"
    );
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  if (!values.figma || !values.tokens) {
    console.error("Error: --figma and --tokens are required unless --self-test is passed.");
    process.exit(2);
  }

  const res = compareVertices({
    figmaPath: values.figma,
    tokensArg: values.tokens,
    codeConnectDir: values["code-connect"] || null,
    runtimePath: values.runtime || null,
    prefix: values.prefix || null,
  });
  const output = values.format === "markdown" ? renderMarkdown(res) + "\n" : JSON.stringify(res, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), output, "utf8");
  }
  process.stdout.write(output);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

#!/usr/bin/env node
/**
 * DSAF v0.0.1 — Deterministic W3C DTCG Token Validator & Codebase Drift Scanner.
 * Zero external dependencies. Validates $value/$type/{alias}/$ref tokens and scans
 * stylesheets/UI components for hardcoded color/spacing drift, !important overrides,
 * orphan CSS variables, and near-duplicate hex color clusters.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "audit-output",
  "draft",
  "__pycache__",
]);

const CODE_EXTS = new Set([".css", ".scss", ".tsx", ".jsx", ".vue", ".svelte", ".html"]);

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
  const s = hex.slice(1).toLowerCase();
  if (s.length === 3) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) return `#${s.slice(0, 6)}`;
  return null;
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
      if (skipDepth === null && /(^|,|\s)(:root|\[data-theme[^\]]*\]|@theme\b|html\[data-uxs-theme[^\]]*\])/i.test(hdr)) {
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

export function scanTarget(targetPath) {
  const resolved = resolve(targetPath);
  if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  const st = statSync(resolved);

  const tokenJsonFiles = [];
  const codeFiles = [];

  if (st.isFile()) {
    if (resolved.endsWith(".json")) tokenJsonFiles.push(resolved);
    else if (CODE_EXTS.has(extname(resolved).toLowerCase())) codeFiles.push(resolved);
  } else {
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = relative(resolved, full).replace(/\\/g, "/");
        if (/(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/)/i.test(rel)) continue;
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
  for (const tf of tokenJsonFiles.sort()) {
    try {
      const json = JSON.parse(readFileSync(tf, "utf8"));
      const flat = flattenTokens(json);
      if (flat.length === 0) continue;
      const single = validateDtcgTokens(flat);
      dtcgReports.push({ file: st.isDirectory() ? relative(resolved, tf) : tf, ...single });
      mergedTokens.push(...flat);
    } catch {
      // Skip non-token package/tooling JSON files
    }
  }
  const combinedDtcg = mergedTokens.length > 0 ? validateDtcgTokens(mergedTokens) : null;

  // 2. Codebase Drift Scan
  const definedVars = new Set();
  const usedVars = new Set();
  const primitiveVarsUsed = new Set();
  let colorTokenRefs = 0;
  let hardcodedColorHits = 0;
  let offGridSpacingHits = 0;
  let importantCount = 0;
  const hardcodedHexSet = new Set();
  const sampleViolations = [];

  for (const cf of codeFiles.sort()) {
    const raw = readFileSync(cf, "utf8");
    const rel = st.isDirectory() ? relative(resolved, cf) : cf;
    const isStyle = cf.endsWith(".css") || cf.endsWith(".scss");

    for (const m of raw.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
      definedVars.add(`--${m[1]}`);
    }
    for (const m of raw.matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
      const name = `--${m[1]}`;
      usedVars.add(name);
      if (/^--(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|palette|raw)-?\d+/i.test(name)) {
        primitiveVarsUsed.add(name);
      }
    }

    const driftSurface = isStyle ? extractNonTokenDeclarations(raw) : raw;
    // Strip custom-property declarations outside :root too
    const nonVarDecls = driftSurface.replace(/--[a-zA-Z0-9_-]+\s*:[^;}\n]+;?/g, "");

    const varRefsInFile = (nonVarDecls.match(/var\(\s*--[a-zA-Z0-9_-]+/g) || []).length;
    colorTokenRefs += varRefsInFile;

    const hexMatches = nonVarDecls.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const fnColorMatches = nonVarDecls.match(/\b(?:rgba?|hsla?|oklch|lab|oklab)\([^)]+\)/gi) || [];
    const fileColorDrift = hexMatches.length + fnColorMatches.length;
    hardcodedColorHits += fileColorDrift;

    for (const hx of hexMatches) {
      const norm = normalizeHexKey(hx);
      if (norm) hardcodedHexSet.add(norm);
    }

    const impMatches = driftSurface.match(/!important\b/g) || [];
    importantCount += impMatches.length;

    const pxMatches = nonVarDecls.match(/\b(\d+)px\b/g) || [];
    let fileOffGrid = 0;
    for (const pxStr of pxMatches) {
      const n = parseInt(pxStr, 10);
      if (n > 4 && n < 200 && n % 4 !== 0 && n !== 6 && n !== 10 && n !== 14) {
        fileOffGrid++;
      }
    }
    offGridSpacingHits += fileOffGrid;

    if ((fileColorDrift > 0 || impMatches.length > 0 || fileOffGrid > 0) && sampleViolations.length < 25) {
      sampleViolations.push({
        file: rel,
        hardcodedColors: fileColorDrift,
        importantOverrides: impMatches.length,
        offGridPx: fileOffGrid,
      });
    }
  }

  const orphanCssVars = [...definedVars].filter((v) => !usedVars.has(v)).sort();
  const nearDuplicateHexClusters = findNearDuplicateHexClusters(hardcodedHexSet);
  const totalColorDecls = colorTokenRefs + hardcodedColorHits;
  const tokenCompliancePct = totalColorDecls > 0 ? Number(((colorTokenRefs / totalColorDecls) * 100).toFixed(1)) : null;

  return {
    schema: "dsaf-tokens/1",
    generated: new Date().toISOString(),
    target: resolved,
    filesScanned: { tokenJson: tokenJsonFiles.length, uiAndStyle: codeFiles.length },
    dtcg: combinedDtcg,
    dtcgFiles: dtcgReports,
    drift: {
      definedCssVariables: definedVars.size,
      usedCssVariables: usedVars.size,
      orphanCssVariableCount: orphanCssVars.length,
      orphanCssVariablesSample: orphanCssVars.slice(0, 20),
      colorTokenRefs,
      hardcodedColorHits,
      tokenCompliancePct,
      primitiveLeakVariables: [...primitiveVarsUsed].sort(),
      nearDuplicateHexClusters,
      importantOverrides: importantCount,
      offGridSpacingHits,
      sampleViolations,
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

    // 3. Drifted CSS scanner (:root tokens excluded, duplicate hex & !important & orphan var caught)
    const appDir = join(scratch, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "styles.css"),
      `:root { --brand: #1d4ed8; --unused-orphan: #999999; }
       .btn { color: var(--brand); background: #2563eb; border-color: #2461e8; padding: 13px !important; }`
    );
    const drift = scanTarget(appDir);
    assert.equal(drift.drift.orphanCssVariableCount, 1, "Must detect --unused-orphan");
    assert.equal(drift.drift.importantOverrides, 1, "Must detect !important");
    assert.equal(drift.drift.hardcodedColorHits, 2, "Must exclude :root and count only non-token colors");
    assert.equal(drift.drift.offGridSpacingHits, 1, "Must detect 13px off-grid spacing");
    assert.equal(drift.drift.nearDuplicateHexClusters.length, 1, "Must cluster #2563eb and #2461e8");

    console.log("AUDIT_TOKENS_SELF_TEST_PASSED (DTCG refs + cycles + CSS drift + near-duplicate hex + orphan vars)");
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
      out: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: node skill/scripts/audit-tokens.mjs <dir-or-tokens-json> [--json] [--out <file>] [--self-test]");
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

  const result = scanTarget(target);
  const outJson = JSON.stringify(result, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), outJson, "utf8");
  }
  if (values.json) {
    process.stdout.write(outJson);
  } else {
    const d = result.drift;
    console.log(`Target: ${result.target}`);
    console.log(`Files scanned: tokenJson=${result.filesScanned.tokenJson}, ui/style=${result.filesScanned.uiAndStyle}`);
    if (result.dtcg) {
      console.log(
        `DTCG Tokens: ${result.dtcg.tokenCount} (typed=${result.dtcg.typedCount}, aliases=${result.dtcg.aliasCount}, component=${result.dtcg.componentScopedCount}, modernColor=${result.dtcg.modernColorCount}, blockingIssues=${result.dtcg.blockingIssues.length})`
      );
    } else {
      console.log("DTCG Tokens: none detected");
    }
    console.log(
      `CSS Drift: compliance=${d.tokenCompliancePct ?? "N/A"}% (varRefs=${d.colorTokenRefs} vs hardcoded=${d.hardcodedColorHits}) | orphans=${d.orphanCssVariableCount} | !important=${d.importantOverrides} | offGridPx=${d.offGridSpacingHits} | nearDupHexClusters=${d.nearDuplicateHexClusters.length}`
    );
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntry) main();

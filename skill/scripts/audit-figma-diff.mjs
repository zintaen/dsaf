#!/usr/bin/env node
/**
 * DSAF v0.2.0 — Automated 3-Vertex Figma MCP / Code Connect Triangulation CLI.
 * Compares Designed (Figma variable JSON + optional Code Connect *.figma.* files)
 * against Defined (W3C DTCG tokens / CSS variables / audit-tokens JSON) and optional
 * Shipped runtime summary (`audit-runtime --json`). Zero external dependencies.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

function normalizeKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .replace(/^--+/, "")
    .replace(/[/_\\\s]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
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
  const resolveOne = (key, stack = []) => {
    if (valuesMap.has(key)) return valuesMap.get(key);
    if (!aliasesMap.has(key) || stack.includes(key)) return null;
    const target = aliasesMap.get(key);
    const val = resolveOne(target, [...stack, key]);
    if (val !== null) valuesMap.set(key, val);
    return val;
  };
  for (const k of aliasesMap.keys()) resolveOne(k);
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

function extractCssCustomProperties(cssText, outMap) {
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of cleaned.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;{}\n]+)/g)) {
    const varName = m[1].toLowerCase();
    const rawVal = m[2].trim();
    if (/^var\(/i.test(rawVal)) continue;
    outMap.set(normalizeKey(varName.replaceAll("-", ".")), normalizeValue(rawVal));
    outMap.set(normalizeKey(varName), normalizeValue(rawVal));
  }
}

export function loadDefinedTokens(tokensArg) {
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
          const low = e.name.toLowerCase();
          if (low.endsWith(".json") && (/\.tokens\.json$/.test(low) || /tokens?[^/]*\.json$/.test(low))) {
            try {
              flattenGenericTokens(JSON.parse(readFileSync(full, "utf8")), [], out, aliases);
            } catch {}
          } else if (low.endsWith(".css") || low.endsWith(".scss")) {
            extractCssCustomProperties(readFileSync(full, "utf8"), out);
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
          if (existsSync(p) && statSync(p).isFile()) {
            try {
              flattenGenericTokens(JSON.parse(readFileSync(p, "utf8")), [], out, aliases);
            } catch {}
          }
        }
      }
    } else {
      flattenGenericTokens(json, [], out, aliases);
    }
  } else {
    extractCssCustomProperties(readFileSync(abs, "utf8"), out);
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

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || (e.isDirectory() && e.name.startsWith("."))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.figma\.(ts|tsx|js|jsx)$/i.test(e.name)) {
        const txt = readFileSync(full, "utf8");
        const matches = [...txt.matchAll(/figma\.connect\(\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
        for (const comp of matches) mappedComponents.add(comp);
        files.push({ file: relative(abs, full).replace(/\\/g, "/"), connections: matches });
      }
    }
  };
  walk(abs);
  return {
    directory: abs,
    codeConnectFiles: files.length,
    mappedComponentsCount: mappedComponents.size,
    mappedComponents: [...mappedComponents].sort(),
    files,
  };
}

export function compareVertices({ figmaPath, tokensArg, codeConnectDir = null, runtimePath = null }) {
  const figma = loadFigmaVariables(figmaPath);
  const defined = loadDefinedTokens(tokensArg);
  const codeConnect = scanCodeConnect(codeConnectDir);

  let shippedSummary = null;
  if (runtimePath) {
    const rt = JSON.parse(readFileSync(resolve(runtimePath), "utf8"));
    const firstCheck = rt.files?.[0]?.checks?.[0];
    shippedSummary = {
      schema: rt.schema || null,
      allPassed: Boolean(rt.allPassed),
      filesAudited: rt.files?.length ?? 0,
      apcaBodyMin: firstCheck?.apca?.minBodyLc ?? null,
      buttonSignatures: firstCheck?.componentInventory?.buttons?.distinctSignatures ?? null,
    };
  }

  const matchedTokens = [];
  const valueDrift = [];
  const designOnlyTokens = [];

  for (const [fKey, fVal] of [...figma.variables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const altDashKey = fKey.replaceAll("-", ".");
    const dVal = defined.get(fKey) ?? defined.get(altDashKey);
    if (dVal === undefined) {
      designOnlyTokens.push({ key: fKey, figmaValue: fVal });
    } else if (dVal === fVal) {
      matchedTokens.push({ key: fKey, value: fVal });
    } else {
      valueDrift.push({ key: fKey, figmaValue: fVal, definedValue: dVal });
    }
  }

  const codeOnlyTokens = [];
  const seenCodeNorms = new Set();
  for (const [dKey, dVal] of [...defined.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dotted = dKey.replaceAll("-", ".");
    if (figma.variables.has(dKey) || figma.variables.has(dotted)) continue;
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
    `- **Triangulation Coverage:** ${s.triangulationCoveragePct ?? "N/A"}% (${s.matchedCount}/${s.figmaVariables} exact matches)`,
    `- **Value Drift:** ${s.valueDriftCount} | **Design-Only:** ${s.designOnlyCount} | **Code-Only:** ${s.codeOnlyCount}`,
    "",
  ];
  if (res.valueDrift.length > 0) {
    lines.push("## Value Drift (`Designed` vs `Defined`)", "", "| Token | Figma (`Designed`) | Code (`Defined`) |", "|---|---|---|");
    for (const d of res.valueDrift) lines.push(`| \`${d.key}\` | \`${d.figmaValue}\` | \`${d.definedValue}\` |`);
    lines.push("");
  }
  if (res.designOnlyTokens.length > 0) {
    lines.push("## Design-Only Tokens (Missing in Code)", "");
    for (const t of res.designOnlyTokens.slice(0, 20)) lines.push(`- \`${t.key}\`: \`${t.figmaValue}\``);
    lines.push("");
  }
  if (res.codeConnect) {
    lines.push(
      "## Code Connect Coverage",
      "",
      `- Files: ${res.codeConnect.codeConnectFiles} | Mapped Components: ${res.codeConnect.mappedComponentsCount} (${res.codeConnect.mappedComponents.join(", ") || "none"})`,
      ""
    );
  }
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-figma-diff-test-"));
  try {
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

    console.log("AUDIT_FIGMA_DIFF_SELF_TEST_PASSED (alias resolve + value drift + design-only + Code Connect)");
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
      "Usage: node skill/scripts/audit-figma-diff.mjs --figma <figma-vars.json> --tokens <tokens.json|dir|tokens-report.json> [--code-connect <dir>] [--runtime <runtime.json>] [--format json|markdown] [--out <file>] [--self-test]"
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

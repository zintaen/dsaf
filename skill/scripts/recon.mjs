#!/usr/bin/env node
/**
 * DSAF v0.0.1 — Step 0 Read-Only Reconnaissance Scanner (zero external deps).
 * Scans a local repository or records a URL stub strictly read-only to classify
 * target topology (Mode S / C / P), tech stack, cloud-isolation risks (T2-Mock),
 * and recommended Step 0 clarification defaults.
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
  ".svelte-kit",
  ".vercel",
  ".vercel-static",
  ".storybook-public",
  "coverage",
  "audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".json", ".md", ".mdx", ".html", ".vue", ".svelte", ".yml", ".yaml"]);

function safeReadText(filePath, maxBytes = 250_000) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  const txt = safeReadText(filePath);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Breadth-first directory traversal prioritizing shallow config, token, package,
 * and source entrypoints before deep fixture/audit/cache trees hit maxFiles.
 */
function collectFiles(rootDir, maxFiles = 3500) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0 && files.length < maxFiles) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    const subDirs = [];
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
      } else if (entry.isDirectory()) {
        subDirs.push(full);
      }
    }
    for (const sub of subDirs) queue.push(sub);
  }
  return files;
}

/**
 * Inspect .env* filenames read-only for key names ONLY (never expose secret values!).
 */
function inspectEnvKeysOnly(rootDir, relFiles) {
  const cloudKeyRe = /(SUPABASE|FIREBASE|AWS_|POSTGRES|DATABASE_URL|MONGO|DYNAMO|STRIPE|CLERK|AUTH0|APPWRITE|CONVEX)/i;
  const detectedKeys = new Set();
  const envFiles = [];
  for (const rel of relFiles) {
    const base = rel.split("/").pop() || "";
    if (!base.startsWith(".env")) continue;
    envFiles.push(rel);
    const txt = safeReadText(join(rootDir, rel), 64_000);
    if (!txt) continue;
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m && cloudKeyRe.test(m[1])) detectedKeys.add(m[1]);
    }
  }
  return { envFiles, cloudKeys: [...detectedKeys].sort() };
}

export function analyzeDirectory(inputDir) {
  const root = resolve(inputDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Target directory does not exist: ${root}`);
  }

  const allFiles = collectFiles(root);
  const relFiles = allFiles.map((f) => relative(root, f).replace(/\\/g, "/"));

  const pkgPaths = relFiles.filter((r) => r === "package.json" || /^[^/]+\/package\.json$/.test(r) || /^(apps|packages|web)\/[^/]+\/package\.json$/.test(r));
  const pkgInfos = pkgPaths.map((r) => ({ rel: r, data: safeReadJson(join(root, r)) })).filter((p) => p.data);

  const deps = new Set();
  const runtimeDeps = new Set();
  let hasExportsOrMain = false;
  let hasDevAppScripts = false;
  let rootKeywordsDesignSystem = false;
  for (const { rel, data } of pkgInfos) {
    for (const k of Object.keys(data.dependencies || {})) runtimeDeps.add(k.toLowerCase());
    for (const bucket of [data.dependencies, data.devDependencies, data.peerDependencies]) {
      if (bucket && typeof bucket === "object") {
        for (const k of Object.keys(bucket)) deps.add(k.toLowerCase());
      }
    }
    if (rel === "package.json") {
      if (Array.isArray(data.keywords) && data.keywords.some((kw) => /design[-_\s]?system|design[-_\s]?tokens/i.test(String(kw)))) {
        rootKeywordsDesignSystem = true;
      }
      if (data.exports || data.main || data.module || rootKeywordsDesignSystem) {
        hasExportsOrMain = true;
      }
    }
    const scripts = data.scripts && typeof data.scripts === "object" ? Object.keys(data.scripts).join(" ") : "";
    if (/\b(dev|start|preview|serve)\b/i.test(scripts) && (runtimeDeps.has("next") || runtimeDeps.has("vite") || runtimeDeps.has("nuxt") || runtimeDeps.has("react-router") || runtimeDeps.has("@sveltejs/kit"))) {
      hasDevAppScripts = true;
    }
  }

  const stories = relFiles.filter((r) => /\.stories\.(tsx|jsx|ts|js|mdx)$/.test(r) || /(^|\/)\.storybook\//.test(r));
  const tokenJsonFiles = relFiles.filter((r) => /(\.tokens\.json|(^|\/)tokens[^/]*\.json)$/.test(r));
  let hasDtcgTokens = false;
  for (const tf of tokenJsonFiles.slice(0, 12)) {
    const raw = safeReadText(join(root, tf), 120_000);
    if (raw && /"\$value"\s*:|"\$type"\s*:/.test(raw)) {
      hasDtcgTokens = true;
      break;
    }
  }

  const cssTokenFiles = relFiles.filter((r) => /(token|theme|variables|palette|design).*\.(css|scss|ts|js)$/.test(r));
  const figmaCodeConnect = relFiles.filter((r) => /\.figma\.(ts|tsx|js|jsx)$/.test(r) || r.endsWith("figma.config.json"));
  const componentFiles = relFiles.filter((r) => /(^|\/)(components?|primitives?|ui)\/.+\.(tsx|jsx|vue|svelte)$/.test(r));
  const appRoutes = relFiles.filter((r) => /(^|\/)(app|pages|routes|views|screens)\/.+\.(tsx|jsx|vue|svelte|html)$/.test(r));
  const rootHtml = relFiles.filter((r) => r === "index.html" || /^[^/]+\/index\.html$/.test(r));
  const styleFiles = relFiles.filter((r) => /\.(css|scss)$/.test(r));
  const aiRuleFiles = relFiles.filter((r) => /(^|\/)(AGENTS\.md|CLAUDE\.md|DESIGN\.md|llms\.txt|\.cursorrules)$/i.test(r));
  const governanceFiles = relFiles.filter((r) => /(^|\/)(CHANGELOG\.md|CONTRIBUTING\.md|CODEOWNERS|rfcs?\/)/i.test(r));
  const testFiles = relFiles.filter((r) => /(\.test\.|\.spec\.|\/tests?\/|playwright)/i.test(r));

  let hasTailwindTheme = false;
  let cssCustomPropCount = 0;
  for (const sf of styleFiles.slice(0, 20)) {
    const txt = safeReadText(join(root, sf), 180_000);
    if (!txt) continue;
    if (/@theme\b/.test(txt)) hasTailwindTheme = true;
    const varDefs = txt.match(/--[a-zA-Z0-9_-]+\s*:/g);
    if (varDefs) cssCustomPropCount += varDefs.length;
  }

  const dsDeps = [...deps].filter((d) =>
    /(design-system|\/design$|radix|base-ui|chakra|mantine|antd|@mui\/material|primereact|shoelace|ariakit|react-aria|tamagui|nativewind)/.test(d)
  );
  const hasShadcnMarkers = relFiles.some((r) => r.endsWith("components.json")) || relFiles.some((r) => /(^|\/)components\/ui\/.+\.(tsx|jsx)$/.test(r));

  const envCheck = inspectEnvKeysOnly(root, relFiles);
  const t2MockRequired = envCheck.cloudKeys.length > 0;

  // Determine Topology: Mode S vs Mode C vs Mode P
  let isAppLike = appRoutes.length > 0 || hasDevAppScripts || rootHtml.length > 0;
  if (runtimeDeps.has("next") || runtimeDeps.has("@sveltejs/kit") || runtimeDeps.has("nuxt") || runtimeDeps.has("@capacitor/core")) {
    isAppLike = true;
  }

  const dsSignals =
    (stories.length >= 2 ? 2 : 0) +
    (hasDtcgTokens || tokenJsonFiles.length > 0 ? 2 : 0) +
    (hasExportsOrMain && componentFiles.length >= 3 ? 2 : 0) +
    (governanceFiles.length >= 2 ? 1 : 0) +
    (figmaCodeConnect.length > 0 ? 1 : 0) +
    (rootKeywordsDesignSystem ? 1 : 0);

  const consumptionSignals =
    dsDeps.length > 0 ||
    hasShadcnMarkers ||
    hasDtcgTokens ||
    tokenJsonFiles.length > 0 ||
    hasTailwindTheme ||
    cssTokenFiles.length > 0 ||
    cssCustomPropCount >= 12;

  let recommendedMode = "P";
  let topologyLabel = "Mode P — Product UX/UI (No Formal Design System)";
  if (dsSignals >= 4 && hasExportsOrMain && dsDeps.length === 0) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  } else if (dsSignals >= 4 && !isAppLike && dsDeps.length === 0) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  } else if (dsDeps.length > 0 || (isAppLike && (consumptionSignals || dsSignals >= 3))) {
    recommendedMode = "C";
    topologyLabel = "Mode C — Product-on-DS Conformance & Drift";
  } else if (dsSignals >= 4 && stories.length >= 3 && !appRoutes.length) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  }

  // Maturity heuristic (Step 0 hint, verified further in runtime)
  let maturity = "tier_2_baseline";
  if (recommendedMode === "S") {
    maturity = hasDtcgTokens && stories.length > 0 && governanceFiles.length > 0 && testFiles.length > 0 ? "tier_3_mature" : "tier_2_baseline";
  } else if (!consumptionSignals && styleFiles.length <= 2 && componentFiles.length <= 2) {
    maturity = "tier_1_crude";
  } else if (consumptionSignals && testFiles.length > 0 && aiRuleFiles.length > 0) {
    maturity = "tier_3_mature";
  }

  const stack = {
    frameworks: [...deps].filter((d) => ["react", "react-dom", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "tailwindcss", "@capacitor/core", "vite"].includes(d)),
    designSystemPackages: dsDeps,
    hasShadcnMarkers,
    hasTailwindTheme,
    hasDtcgTokens,
  };

  return {
    schema: "dsaf-recon/1",
    generated: new Date().toISOString(),
    target: root,
    kind: "directory",
    filesScanned: allFiles.length,
    recommendedMode,
    topologyLabel,
    estimatedMaturity: maturity,
    recommendedDataTier: t2MockRequired ? "T2 + T2-Mock" : "T2",
    t2MockRequired,
    cloudEnvKeysDetected: envCheck.cloudKeys,
    stack,
    counts: {
      packages: pkgInfos.length,
      components: componentFiles.length,
      appRoutes: appRoutes.length,
      stories: stories.length,
      tokenJsonFiles: tokenJsonFiles.length,
      cssTokenFiles: cssTokenFiles.length,
      cssCustomPropDefsSampled: cssCustomPropCount,
      figmaCodeConnect: figmaCodeConnect.length,
      styleFiles: styleFiles.length,
      testFiles: testFiles.length,
      aiRuleFiles: aiRuleFiles.length,
      governanceFiles: governanceFiles.length,
    },
    samples: {
      stories: stories.slice(0, 5),
      tokenFiles: [...tokenJsonFiles, ...cssTokenFiles].slice(0, 8),
      figmaCodeConnect: figmaCodeConnect.slice(0, 5),
      aiRuleFiles: aiRuleFiles.slice(0, 5),
      envFiles: envCheck.envFiles,
    },
  };
}

export function analyzeUrlTarget(targetUrl) {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname.endsWith(".local");
  const isStaging = /(^|\.)(staging|dev|preview|qa|sandbox)\./.test(hostname);
  return {
    schema: "dsaf-recon/1",
    generated: new Date().toISOString(),
    target: targetUrl,
    kind: "url",
    hostname,
    recommendedMode: /storybook/i.test(targetUrl) ? "S" : "P",
    topologyLabel: /storybook/i.test(targetUrl)
      ? "Mode S — Design System Storybook URL (inspect DOM to confirm)"
      : "Live URL (inspect rendered DOM/styles to distinguish Mode C vs Mode P)",
    recommendedDataTier: isLocal ? "T2 (confirm T2-Mock if remote cloud calls detected)" : isStaging ? "T1" : "T0",
    t2MockRequired: isLocal,
    note: "Pair URL recon with live Tier 0 Playwright/browser DOM inspection to verify themes, 375px clipping, and DS classes.",
  };
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-recon-test-"));
  try {
    // 1. Mode S — Design System Core fixture
    const dirS = join(scratch, "ds-core");
    mkdirSync(join(dirS, "src/components"), { recursive: true });
    mkdirSync(join(dirS, ".storybook"), { recursive: true });
    writeFileSync(join(dirS, "package.json"), JSON.stringify({ name: "ui-kit", exports: { ".": "./dist/index.js" } }));
    writeFileSync(join(dirS, "tokens.tokens.json"), JSON.stringify({ color: { brand: { $type: "color", $value: "#1d4ed8" } } }));
    writeFileSync(join(dirS, "src/components/Button.tsx"), "export const Button = () => null;");
    writeFileSync(join(dirS, "src/components/Input.tsx"), "export const Input = () => null;");
    writeFileSync(join(dirS, "src/components/Card.tsx"), "export const Card = () => null;");
    writeFileSync(join(dirS, "src/components/Button.stories.tsx"), "export default { title: 'Button' };");
    writeFileSync(join(dirS, "src/components/Input.stories.tsx"), "export default { title: 'Input' };");
    writeFileSync(join(dirS, "CHANGELOG.md"), "# Changelog");
    writeFileSync(join(dirS, "CONTRIBUTING.md"), "# Contributing");
    const resS = analyzeDirectory(dirS);
    assert.equal(resS.recommendedMode, "S", `Expected Mode S, got ${resS.recommendedMode}`);

    // 2. Mode C — Product consuming a DS (even without src/pages dir) + cloud env detection
    const dirC = join(scratch, "app-conformance");
    mkdirSync(join(dirC, "src"), { recursive: true });
    writeFileSync(join(dirC, "package.json"), JSON.stringify({ name: "web-app", dependencies: { react: "^19.0.0", "@radix-ui/react-dialog": "^1.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(dirC, "src/App.tsx"), "export const App = () => null;");
    writeFileSync(join(dirC, ".env.local"), "VITE_SUPABASE_URL=https://example.supabase.co\n");
    const resC = analyzeDirectory(dirC);
    assert.equal(resC.recommendedMode, "C", `Expected Mode C, got ${resC.recommendedMode}`);
    assert.equal(resC.t2MockRequired, true, "Expected t2MockRequired on SUPABASE env key");
    assert.ok(!JSON.stringify(resC).includes("https://example.supabase.co"), "Must never expose env secret/URL values!");

    // 3. Mode P — Product without formal DS
    const dirP = join(scratch, "product-raw");
    mkdirSync(join(dirP, "src/pages"), { recursive: true });
    writeFileSync(join(dirP, "package.json"), JSON.stringify({ name: "mvp-app", dependencies: { react: "^19.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(dirP, "src/pages/Index.tsx"), "export const Index = () => null;");
    writeFileSync(join(dirP, "src/app.css"), "body { color: #222; }");
    const resP = analyzeDirectory(dirP);
    assert.equal(resP.recommendedMode, "P", `Expected Mode P, got ${resP.recommendedMode}`);

    // 4. URL classification
    assert.equal(analyzeUrlTarget("https://prod.example.com").recommendedDataTier, "T0");
    assert.match(analyzeUrlTarget("http://localhost:3000").recommendedDataTier, /^T2/);

    console.log("RECON_SELF_TEST_PASSED (Mode S / Mode C + T2-Mock / Mode P / URL safety)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: node skill/scripts/recon.mjs <repo-dir-or-url> [--out <recon.json>] [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
  const target = positionals[0];
  if (!target) {
    console.error("Error: <repo-dir-or-url> is required unless --self-test is passed.");
    process.exit(2);
  }

  const result = /^https?:\/\//i.test(target) ? analyzeUrlTarget(target) : analyzeDirectory(target);
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(resolve(values.out), json, "utf8");
  }
  process.stdout.write(json);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isEntry) main();

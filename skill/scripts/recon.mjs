#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Step 0 Read-Only Reconnaissance Scanner (zero external deps).
 * Scans a local repository or records a URL stub strictly read-only to classify
 * target topology (Mode S / C / P), Surface Mode (Persuade / Operate / Read /
 * Experience), tech stack, cloud-isolation risks (T2-Mock), and Step 0 defaults.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertWritableOutputFile, isDirectCliEntry, stripCommentsPreservingLines } from "./ci-report.mjs";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "storybook-static",
  "_audit",
  "_vendor",
  "src-tauri",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".vercel-static",
  ".storybook-public",
  "coverage",
  "playwright-report",
  "test-results",
  "audit-output",
  "dsaf-audit-output",
  "draft",
  "__pycache__",
  ".venv",
]);

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

export function hasDesignTokenEvidence(raw) {
  if (!raw || typeof raw !== "string") return { dtcg: false, valid: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { dtcg: false, valid: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { dtcg: false, valid: false };
  if (
    (typeof parsed.short_name === "string" || typeof parsed.start_url === "string") &&
    (Array.isArray(parsed.icons) || typeof parsed.theme_color === "string" || typeof parsed.background_color === "string")
  ) {
    return { dtcg: false, valid: false };
  }
  const isDtcgTree = (node, depth = 0) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 20) return false;
    if (Object.prototype.hasOwnProperty.call(node, "$value")) return true;
    return Object.values(node).some((v) => v && typeof v === "object" && isDtcgTree(v, depth + 1));
  };
  if (isDtcgTree(parsed)) return { dtcg: true, valid: true };
  const NON_DESIGN_PARENT_RE =
    /(?:^|[_-])(?:session|auth|oauth|jwt|csrf|access|refresh|bearer|cookie|cache|ttl|expir(?:y|es|ation)|timeout|retr(?:y|ies)|backoff|delay|interval|limit|quota|port|host|rate[-_]?limit|pagination|cursor|token[-_]?config|api|secret|credential)(?:$|[_-])/i;
  const DOMAIN_KEY_RE =
    /(?:^|[_-])(?:colors?|palettes?|surface|background|foreground|brand|accent|spacing|space|font|fonts|typography|radius|radii|shadows?|elevation|borders?|primitives?|semantics?|breakpoints?|z[-_]?index|motion|duration|easing)(?:$|[_-])/i;
  const COLOR_VAL_RE =
    /^(?:#(?:[0-9a-f]{3,8})|(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb|color)\([^)]*\))$/i;
  const DIM_VAL_RE = /^-?\d+(?:\.\d+)?(?:px|rem|em|ms)$/i;
  const SHORT_DURATION_S_RE = /^0*(?:\d(?:\.\d+)?|10(?:\.0+)?)s$/i;
  const isDesignValStr = (rawV, allowDim = false) => {
    const tv = rawV.trim();
    return COLOR_VAL_RE.test(tv) || (allowDim && (DIM_VAL_RE.test(tv) || SHORT_DURATION_S_RE.test(tv)));
  };
  const STRICT_DESIGN_TYPE_RE =
    /^(?:color|dimension|spacing|sizing|border-?radius|border-?width|font-?family|font-?weight|font-?size|line-?height|letter-?spacing|cubic-?bezier|shadow|box-shadow|border|typography|transition|gradient)$/i;
  const GENERIC_TOKEN_TYPE_RE = /^(?:number|duration|opacity|other)$/i;
  const DOTTED_ALIAS_RE = /^\{[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+\}$/;
  const hasTopLevelGroup = (rootKey) => Object.prototype.hasOwnProperty.call(parsed, rootKey);
  let visits = 0;
  const walk = (node, inDomain) => {
    if (!node || typeof node !== "object" || visits > 1000) return false;
    visits++;
    if (Array.isArray(node)) return false;
    if (Object.prototype.hasOwnProperty.call(node, "value")) {
      const v = node.value;
      const tp = typeof node.type === "string" ? node.type.trim() : "";
      if (tp && STRICT_DESIGN_TYPE_RE.test(tp)) return true;
      if (tp && GENERIC_TOKEN_TYPE_RE.test(tp) && inDomain) return true;
      if (typeof v === "string") {
        const tv = v.trim();
        if (isDesignValStr(tv, inDomain)) return true;
        if (DOTTED_ALIAS_RE.test(tv)) {
          const firstSeg = tv.slice(1, tv.indexOf("."));
          if (inDomain || hasTopLevelGroup(firstSeg)) return true;
        }
      }
      if (typeof v === "number" && Number.isFinite(v) && inDomain) return true;
    }
    for (const [k, v] of Object.entries(node)) {
      const normKey = k.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
      if (NON_DESIGN_PARENT_RE.test(normKey)) continue;
      const nextDomain = inDomain || DOMAIN_KEY_RE.test(normKey);
      if (nextDomain && typeof v === "string" && isDesignValStr(v, true)) return true;
      if (v && typeof v === "object" && walk(v, nextDomain)) return true;
    }
    return false;
  };
  return { dtcg: false, valid: walk(parsed, false) };
}

/**
 * Breadth-first directory traversal prioritizing shallow config, token, package,
 * and source entrypoints before deep fixture/audit/cache trees hit maxFiles.
 */
function collectFiles(rootDir, maxFiles = 3500) {
  const files = [];
  const queue = [rootDir];
  const visitedDirs = new Set();
  try {
    visitedDirs.add(realpathSync(rootDir));
  } catch {}
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
      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir && entry.name.startsWith(".") && entry.name !== ".storybook") continue;
      const rel = relative(rootDir, full).replace(/\\/g, "/");
      if (/(^|\/)(ios\/App\/App\/public|android\/app\/src\/main\/assets\/public)\//i.test(rel)) continue;
      if (isFile) {
        files.push(full);
      } else if (isDir) {
        try {
          const real = realpathSync(full);
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
        } catch {
          continue;
        }
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

/**
 * Classify dominant Surface Mode:
 * - "read": docs, articles, changelogs, markdown-heavy knowledge bases
 * - "experience": 3D/canvas/gallery/portfolio showcases
 * - "operate": dashboards, tables, admins, editors, settings, workspaces
 * - "persuade": marketing, landing, pricing, product homepages
 */
export function detectSurfaceMode({ relFiles = [], deps = new Set(), appRoutes = [], componentFiles = [], isDesignSystem = false } = {}) {
  const depSet = new Set([...deps].map((d) => String(d).toLowerCase()));
  const docsDeps = ["docusaurus", "@docusaurus/core", "vitepress", "nextra", "fumadocs-core", "mintlify", "@astrojs/starlight"];
  const docsHits = relFiles.filter((r) => /(^|\/)(docs?|guides?|blog|articles?|reference|changelog)\//i.test(r)).length;
  const routeText = appRoutes.join("\n");
  const allText = relFiles.join("\n");

  const expDeps = ["three", "@react-three/fiber", "pixi.js", "p5", "ogl"];
  if (expDeps.some((d) => depSet.has(d))) {
    return { surfaceMode: "experience", surfaceModeRationale: "Canvas/WebGL/3D rendering dependency detected." };
  }

  const operateDeps = [
    "@tanstack/react-table",
    "@tanstack/react-query",
    "zustand",
    "@reduxjs/toolkit",
    "redux",
    "ag-grid-community",
    "recharts",
    "@tauri-apps/api",
    "@tauri-apps/cli",
    "electron",
    "@capacitor/core",
  ];
  const normSeg = (s) =>
    String(s || "")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
  const interactiveComponentHits = componentFiles.filter((f) =>
    /(?:^|[/_.-])(modal|dialog|sidebar|drawer|panel|editor|table|ledger|settings|composer|workspace|picker|form|filter|toolbar)(?:$|[/_.-])/i.test(
      normSeg(f)
    )
  ).length;

  if (
    isDesignSystem ||
    docsDeps.some((d) => depSet.has(d)) ||
    (appRoutes.length >= 2 &&
      appRoutes.filter((r) => /(?:^|[/_.-])(docs?|guides?|blog|articles?|changelog)(?:$|[/_.-])/i.test(normSeg(r))).length / appRoutes.length >= 0.5)
  ) {
    return {
      surfaceMode: "read",
      surfaceModeRationale: isDesignSystem
        ? "Design system / component documentation surface detected."
        : "Documentation/reading framework or docs-heavy route structure detected.",
    };
  }

  if (
    operateDeps.some((d) => depSet.has(d)) ||
    appRoutes.some((r) =>
      /(?:^|[/_.-])(dashboard|admin|settings|workspace|console|editor|billing|account|analytics|inbox|tables?)(?:$|[/_.-])/i.test(
        normSeg(r)
      )
    ) ||
    interactiveComponentHits >= 3
  ) {
    return { surfaceMode: "operate", surfaceModeRationale: "Interactive workspace, desktop/mobile app shell, table, or multi-panel UI signals detected." };
  }

  if (docsHits >= 5 && componentFiles.length <= 2) {
    return {
      surfaceMode: "read",
      surfaceModeRationale: "Documentation/reading framework or docs-heavy route structure detected.",
    };
  }

  const nonAssetFiles = relFiles.filter((r) => !/(^|\/)(?:images?|img|assets?|media|icons?)\//i.test(r));
  const hasExperienceDir = nonAssetFiles.some((r) => /(^|\/)(?:portfolio|gallery|showcase|exhibition)\//i.test(r));
  const hasExperienceFile = nonAssetFiles.some(
    (r) =>
      /\.(?:tsx|jsx|ts|js|vue|svelte|astro|html|mdx?)$/i.test(r) &&
      /(^|\/)(?:portfolio|gallery|showcase|exhibition)\b/i.test(r)
  );
  if (!isDesignSystem && (hasExperienceDir || hasExperienceFile)) {
    return { surfaceMode: "experience", surfaceModeRationale: "Gallery/portfolio/showcase experience signals detected." };
  }

  return { surfaceMode: "persuade", surfaceModeRationale: "Defaulted to conversion/product presentation surface (landing/marketing/site)." };
}

export function analyzeDirectory(inputDir) {
  const root = resolve(inputDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Target directory does not exist: ${root}`);
  }

  const allFiles = collectFiles(root);
  const relFiles = allFiles.map((f) => relative(root, f).replace(/\\/g, "/"));

  const rootPkg = relFiles.includes("package.json") ? safeReadJson(join(root, "package.json")) : null;
  const wsGlobs = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg?.workspaces?.packages)
    ? rootPkg.workspaces.packages
    : [];
  const globToPkgRe = (pat) => {
    const clean = String(pat || "")
      .replace(/^\.\//, "")
      .replace(/\/package\.json$/, "")
      .replace(/\/+$/, "");
    if (!clean) return null;
    const esc = clean
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*\\\*/g, ".+")
      .replace(/\\\*/g, "[^/]+");
    return new RegExp(`^${esc}/package\\.json$`);
  };
  const positiveWs = wsGlobs.filter((g) => g && !String(g).trim().startsWith("!"));
  const pkgPaths = new Set(
    positiveWs.length > 0
      ? relFiles.filter((r) => r === "package.json")
      : relFiles.filter(
          (r) => r === "package.json" || /^[^/]+\/package\.json$/.test(r) || /^(apps|packages|libs|modules|sites|web|workspaces)\/[^/]+\/package\.json$/.test(r)
        )
  );
  for (const rawGlob of wsGlobs) {
    const gStr = String(rawGlob || "").trim();
    if (!gStr) continue;
    const isNeg = gStr.startsWith("!");
    const wsRe = globToPkgRe(isNeg ? gStr.slice(1) : gStr);
    if (!wsRe) continue;
    for (const r of relFiles) {
      if (!wsRe.test(r)) continue;
      if (isNeg) {
        if (r !== "package.json") pkgPaths.delete(r);
      } else {
        pkgPaths.add(r);
      }
    }
  }
  const pkgInfos = [...pkgPaths].sort().map((r) => ({ rel: r, data: safeReadJson(join(root, r)) })).filter((p) => p.data);

  const deps = new Set();
  const runtimeDeps = new Set();
  const workspacePackageNames = new Set();
  let hasExportsOrMain = false;
  let hasDevAppScripts = false;
  let rootKeywordsDesignSystem = false;
  for (const { data } of pkgInfos) {
    if (typeof data.name === "string" && data.name.trim()) {
      workspacePackageNames.add(data.name.trim().toLowerCase());
    }
  }
  const pkgScriptsList = [];
  for (const { rel, data } of pkgInfos) {
    for (const k of Object.keys(data.dependencies || {})) {
      const lk = k.toLowerCase();
      if (!workspacePackageNames.has(lk)) runtimeDeps.add(lk);
    }
    for (const bucket of [data.dependencies, data.devDependencies, data.peerDependencies]) {
      if (bucket && typeof bucket === "object") {
        for (const k of Object.keys(bucket)) {
          const lk = k.toLowerCase();
          if (!workspacePackageNames.has(lk)) deps.add(lk);
        }
      }
    }
    if (rel === "package.json" || /^(?:packages|libs|modules)\/[^/]+\/package\.json$/i.test(rel)) {
      if (Array.isArray(data.keywords) && data.keywords.some((kw) => /design[-_\s]?system|design[-_\s]?tokens/i.test(String(kw)))) {
        rootKeywordsDesignSystem = true;
      }
      if (data.exports || data.main || data.module || rootKeywordsDesignSystem) {
        hasExportsOrMain = true;
      }
    }
    if (data.scripts && typeof data.scripts === "object") {
      pkgScriptsList.push(Object.keys(data.scripts).join(" "));
    }
  }
  const hasAppRunnerDep =
    deps.has("vite") ||
    deps.has("astro") ||
    deps.has("@sveltejs/kit") ||
    runtimeDeps.has("next") ||
    deps.has("nuxt") ||
    runtimeDeps.has("react-router");
  if (hasAppRunnerDep && pkgScriptsList.some((sc) => /\b(dev|start|preview|serve)\b/i.test(sc))) {
    hasDevAppScripts = true;
  }

  const AUTH_OR_TEST_TOKEN_RE = /(\.test\.|\.spec\.|__tests__\/|(^|\/)(?:tests?|fixtures|__fixtures__)\/|\[[^\]]+\]|(^|\/)route\.(ts|js|tsx|jsx)$|(?:^|[/_.-])(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer|snooze|reset|verify|invite)[/_.-]?token|(?:^|\/)(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer)\/.+\.json$)/i;
  const TEST_OR_AUTH_UI_RE = /(\.test\.|\.spec\.|__tests__\/|(^|\/)(?:tests?|fixtures|__fixtures__)\/|(?:^|[/_.-])(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer|snooze|reset|verify|invite)[/_.-]?token)/i;
  const stories = relFiles.filter((r) => /\.stories\.(tsx|jsx|ts|js|mdx)$/.test(r) || /(^|\/)\.storybook\//.test(r));
  const candidateTokenJsonFiles = relFiles.filter(
    (r) =>
      !AUTH_OR_TEST_TOKEN_RE.test(r) &&
      !/(^|\/)(?:tests?|fixtures|__fixtures__)\//i.test(r) &&
      (/\.tokens\.json$/i.test(r) ||
        /(?:^|[/_.-])tokens?(?:[._-][^/]*)?\.json$/i.test(r) ||
        /(^|\/)(?:tokens|design-tokens)\/(?:.+\/)?[^/]+\.json$/i.test(r)) &&
      !/(?:^|\/)(?:package|tsconfig[^/]*|.*schema.*|meta)\.json$/i.test(r)
  );
  const tokenJsonFiles = [];
  let hasDtcgTokens = false;
  for (const tf of candidateTokenJsonFiles.slice(0, 30)) {
    const raw = safeReadText(join(root, tf), 250_000);
    const ev = hasDesignTokenEvidence(raw);
    if (ev.dtcg) {
      hasDtcgTokens = true;
      tokenJsonFiles.push(tf);
    } else if (ev.valid) {
      tokenJsonFiles.push(tf);
    }
  }

  const cssTokenFiles = relFiles.filter((r) => {
    if (AUTH_OR_TEST_TOKEN_RE.test(r)) return false;
    return (
      /(^|\/)(?:design[-_]?)?(?:tokens?|themes?|variables|palette)[^/]*\.(css|scss)$/i.test(r) ||
      /(^|\/)(?:theme|themes|tokens|design-tokens)\/[^/]+\.(css|scss)$/i.test(r) ||
      /(^|\/)(?:theme|themes|tokens|design-tokens)\/(?:index|tokens?|colors?|theme)\.(ts|js)$/i.test(r)
    );
  });
  const figmaCodeConnect = relFiles.filter((r) => /\.figma(?:\.batch)?\.(ts|tsx|js|jsx)$/i.test(r) || r.endsWith("figma.config.json"));
  const componentFiles = relFiles.filter(
    (r) => !TEST_OR_AUTH_UI_RE.test(r) && !/\.stories\.(tsx|jsx|ts|js|mdx)$/i.test(r) && /(^|\/)(components?|primitives?|ui)\/.+\.(tsx|jsx|vue|svelte|astro)$/.test(r)
  );
  const appRoutes = relFiles.filter(
    (r) => !TEST_OR_AUTH_UI_RE.test(r) && !/\.stories\.(tsx|jsx|ts|js|mdx)$/i.test(r) && /(^|\/)(app|pages|routes|views|screens)\/.+\.(tsx|jsx|vue|svelte|astro|html)$/.test(r)
  );
  const rootHtml = relFiles.filter((r) => r === "index.html" || /^[^/]+\/index\.html$/.test(r));
  const styleFiles = relFiles.filter((r) => !TEST_OR_AUTH_UI_RE.test(r) && /\.(css|scss)$/i.test(r));
  const aiRuleFiles = relFiles.filter((r) => /(^|\/)(AGENTS\.md|CLAUDE\.md|DESIGN\.md|llms\.txt|\.cursorrules)$/i.test(r));
  const governanceFiles = relFiles.filter((r) => /(^|\/)(CHANGELOG\.md|RELEASE_NOTES\.md|CONTRIBUTING\.md|CODEOWNERS|rfcs?\/)/i.test(r));
  const testFiles = relFiles.filter((r) => /(\.test\.|\.spec\.|(^|\/)tests?\/|playwright)/i.test(r));

  let hasTailwindTheme = false;
  let cssCustomPropCount = 0;
  const prioritizedStyles = [
    ...cssTokenFiles.filter((r) => /\.(css|scss)$/i.test(r)),
    ...styleFiles.filter((r) => /(^|\/)(?:index|globals|app|main|styles|tokens?)\.(css|scss)$/i.test(r)),
    ...styleFiles,
  ];
  const seenStyles = new Set();
  for (const sf of prioritizedStyles) {
    if (seenStyles.has(sf)) continue;
    seenStyles.add(sf);
    if (seenStyles.size > 25) break;
    const txt = safeReadText(join(root, sf), 180_000);
    if (!txt) continue;
    const cleanTxt = stripCommentsPreservingLines(txt);
    const strippedTxt = cleanTxt.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
    if (/(?:^|[;}\s])@theme(?:\s+(?:inline|static|reference|default))*\s*\{/i.test(strippedTxt)) hasTailwindTheme = true;
    const varDefs = strippedTxt.match(/(?<![a-zA-Z0-9_.&-])--[a-zA-Z0-9_-]+\s*:(?!:)/g);
    if (varDefs) cssCustomPropCount += varDefs.length;
  }

  const dsDeps = [...deps].filter((d) =>
    /(design-system|\/design$|radix|reka-ui|bits-ui|base-ui|headlessui|ark-ui|chakra|mantine|antd|@mui\/material|primereact|shoelace|ariakit|react-aria|tamagui|nativewind)/.test(d)
  );
  const nonHeadlessDsDeps = dsDeps.filter(
    (d) =>
      !/^(?:radix-ui|radix-vue|reka-ui|bits-ui|react-aria-components|react-aria|ariakit|@(?:ariakit|base-ui(?:-components)?|radix-ui|headlessui|react-aria|ark-ui|floating-ui)\/)/i.test(
        d
      )
  );
  const hasShadcnMarkers =
    relFiles.some((r) => !TEST_OR_AUTH_UI_RE.test(r) && /(^|\/)components\.json$/i.test(r)) ||
    relFiles.some((r) => !TEST_OR_AUTH_UI_RE.test(r) && /(^|\/)components\/ui\/.+\.(tsx|jsx)$/.test(r));

  const envCheck = inspectEnvKeysOnly(root, relFiles);
  const cloudSdkDeps = [...runtimeDeps]
    .filter((d) =>
      /^(?:@supabase\/supabase-js|firebase|firebase-admin|@firebase\/firestore|convex|appwrite|mongodb|pg|prisma|@prisma\/client|@aws-sdk\/client-dynamodb)$/i.test(d)
    )
    .sort();
  const t2MockRequired = envCheck.cloudKeys.length > 0 || cloudSdkDeps.length > 0;

  // Determine Topology: Mode S vs Mode C vs Mode P
  let isAppLike = appRoutes.length > 0 || hasDevAppScripts || rootHtml.length > 0;
  if (runtimeDeps.has("next") || deps.has("astro") || deps.has("@sveltejs/kit") || deps.has("nuxt") || runtimeDeps.has("@capacitor/core")) {
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
    (cssTokenFiles.length > 0 && cssCustomPropCount >= 12);

  let recommendedMode = "P";
  let topologyLabel = "Mode P — Product UX/UI (No Formal Design System)";
  if (dsSignals >= 4 && hasExportsOrMain && nonHeadlessDsDeps.length === 0) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  } else if (dsSignals >= 4 && !isAppLike && nonHeadlessDsDeps.length === 0) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  } else if (dsSignals >= 4 && stories.length >= 3 && !appRoutes.length && nonHeadlessDsDeps.length === 0) {
    recommendedMode = "S";
    topologyLabel = "Mode S — Design System Core";
  } else if (dsDeps.length > 0 || (isAppLike && (consumptionSignals || dsSignals >= 3))) {
    recommendedMode = "C";
    topologyLabel = "Mode C — Product-on-DS Conformance & Drift";
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
    frameworks: [...deps].filter((d) =>
      ["react", "react-dom", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "tailwindcss", "@capacitor/core", "vite", "tauri", "@tauri-apps/api", "@tauri-apps/cli", "electron", "expo", "react-native"].includes(d)
    ),
    designSystemPackages: dsDeps,
    hasShadcnMarkers,
    hasTailwindTheme,
    hasDtcgTokens,
  };
  const { surfaceMode, surfaceModeRationale } = detectSurfaceMode({
    relFiles,
    deps,
    appRoutes,
    componentFiles,
    isDesignSystem: recommendedMode === "S",
  });

  return {
    schema: "dsaf-recon/1",
    generated: new Date().toISOString(),
    target: root,
    kind: "directory",
    filesScanned: allFiles.length,
    recommendedMode,
    topologyLabel,
    surfaceMode,
    surfaceModeRationale,
    estimatedMaturity: maturity,
    recommendedDataTier: t2MockRequired ? "T2 + T2-Mock" : "T2",
    t2MockRequired,
    cloudEnvKeysDetected: envCheck.cloudKeys,
    cloudSdkDeps,
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
      appRoutes: appRoutes.slice(0, 20),
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
  let pathname = "/";
  try {
    const parsedUrl = new URL(targetUrl);
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || !parsedUrl.hostname) {
      throw new Error("Unsupported protocol");
    }
    hostname = parsedUrl.hostname.toLowerCase();
    pathname = parsedUrl.pathname || "/";
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }
  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  const hostLabels = cleanHost.split(".");
  const nonTldLabels = hostLabels.length > 1 ? hostLabels.slice(0, -1) : hostLabels;
  const hostLabelSet = new Set(nonTldLabels);
  const urlPathSignal = `${cleanHost}${pathname}`;
  const isLocal =
    cleanHost === "localhost" ||
    cleanHost === "::1" ||
    /^127\./.test(cleanHost) ||
    cleanHost === "0.0.0.0" ||
    cleanHost.endsWith(".localhost") ||
    cleanHost.endsWith(".local");
  const isStaging = /(^|\.)(staging|dev|preview|qa|sandbox)\./.test(hostname);
  const isReadUrl =
    hostLabelSet.has("docs") ||
    /(?:^|[.-])storybook(?:$|[.-])/.test(cleanHost) ||
    /(?:^|\/)(?:docs|storybook)(?:$|\/)/i.test(pathname);
  const isOperateUrl =
    ["dashboard", "app", "console", "admin"].some((lbl) => hostLabelSet.has(lbl)) ||
    /(?:^|\/)(?:dashboard|app|console|admin)(?:$|\/)/i.test(pathname);
  return {
    schema: "dsaf-recon/1",
    generated: new Date().toISOString(),
    target: targetUrl,
    kind: "url",
    hostname,
    recommendedMode: /storybook/i.test(urlPathSignal) ? "S" : "P",
    topologyLabel: /storybook/i.test(urlPathSignal)
      ? "Mode S — Design System Storybook URL (inspect DOM to confirm)"
      : "Live URL (inspect rendered DOM/styles to distinguish Mode C vs Mode P)",
    surfaceMode: isReadUrl ? "read" : isOperateUrl ? "operate" : "persuade",
    surfaceModeRationale: "Preliminary hint from URL path; confirm from rendered UI.",
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

    // 3. Mode P — Product without formal DS (even with local CSS :root variables >= 12)
    const dirP = join(scratch, "product-raw");
    mkdirSync(join(dirP, "src/pages"), { recursive: true });
    writeFileSync(join(dirP, "package.json"), JSON.stringify({ name: "mvp-app", dependencies: { react: "^19.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(dirP, "src/pages/Index.tsx"), "export const Index = () => null;");
    const localVars = Array.from({ length: 16 }, (_, idx) => `--local-v-${idx}: ${idx}px;`).join(" ");
    writeFileSync(join(dirP, "src/app.css"), `:root { ${localVars} } body { color: #222; }`);
    const resP = analyzeDirectory(dirP);
    assert.equal(resP.recommendedMode, "P", `Expected Mode P despite local CSS vars, got ${resP.recommendedMode}`);

    // 4. Dedicated token stylesheet triggers Mode C
    const dirCTok = join(scratch, "app-tokens-css");
    mkdirSync(join(dirCTok, "src/pages"), { recursive: true });
    writeFileSync(join(dirCTok, "package.json"), JSON.stringify({ name: "tok-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(dirCTok, "src/pages/App.tsx"), "export const App = () => null;");
    const tokVars = Array.from({ length: 14 }, (_, idx) => `--ds-tok-${idx}: #111;`).join(" ");
    writeFileSync(join(dirCTok, "src/tokens.css"), `:root { ${tokVars} }`);
    const resCTok = analyzeDirectory(dirCTok);
    assert.equal(resCTok.recommendedMode, "C", `Expected Mode C on dedicated tokens.css, got ${resCTok.recommendedMode}`);

    // 5. Auth/test/route tokens & hidden/mobile bundles must NOT falsely trigger Mode C
    const dirPAuth = join(scratch, "nextjs-auth-tokens");
    mkdirSync(join(dirPAuth, "lib"), { recursive: true });
    mkdirSync(join(dirPAuth, "app/lich/[token]"), { recursive: true });
    mkdirSync(join(dirPAuth, ".worktrees/old"), { recursive: true });
    mkdirSync(join(dirPAuth, "ios/App/App/public/assets"), { recursive: true });
    writeFileSync(join(dirPAuth, "package.json"), JSON.stringify({ name: "next-app", dependencies: { next: "^15.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } }));
    writeFileSync(join(dirPAuth, "lib/snooze_token.ts"), "export const sign = () => '';");
    writeFileSync(join(dirPAuth, "lib/theme_toggle.test.ts"), "export const t = 1;");
    writeFileSync(join(dirPAuth, "app/lich/[token]/route.ts"), "export async function GET() {}");
    writeFileSync(join(dirPAuth, "app/globals.css"), ":root { --bg: #fff; }");
    writeFileSync(join(dirPAuth, ".worktrees/old/tokens.css"), ":root { --ds: #000; }");
    writeFileSync(join(dirPAuth, "ios/App/App/public/assets/vendor-design.css"), ".x{color:#000}");
    const resPAuth = analyzeDirectory(dirPAuth);
    assert.equal(resPAuth.recommendedMode, "P", `Expected Mode P despite auth/route/hidden token paths, got ${resPAuth.recommendedMode}`);
    assert.equal(resPAuth.counts.cssTokenFiles, 0, "Auth/route/test token paths must not count as cssTokenFiles");

    // 6. Tailwind v4 @theme inline triggers Mode C
    const dirTw = join(scratch, "app-tw4");
    mkdirSync(join(dirTw, "src"), { recursive: true });
    writeFileSync(join(dirTw, "package.json"), JSON.stringify({ name: "tw4-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(dirTw, "src/App.tsx"), "export const App = () => null;");
    writeFileSync(join(dirTw, "src/index.css"), "@theme inline { --color-brand: #1d4ed8; }");
    const resTw = analyzeDirectory(dirTw);
    assert.equal(resTw.stack.hasTailwindTheme, true, "Must detect @theme inline");
    assert.equal(resTw.recommendedMode, "C", "Expected Mode C on Tailwind @theme inline");

    // 7. URL & Surface Mode classification + cloud SDK fallback
    assert.equal(analyzeUrlTarget("https://prod.example.com").recommendedDataTier, "T0");
    assert.match(analyzeUrlTarget("http://localhost:3000").recommendedDataTier, /^T2/);
    assert.equal(detectSurfaceMode({ deps: new Set(["vitepress"]) }).surfaceMode, "read");
    assert.equal(detectSurfaceMode({ isDesignSystem: true }).surfaceMode, "read");
    assert.equal(detectSurfaceMode({ deps: new Set(["@tauri-apps/api"]) }).surfaceMode, "operate");
    assert.equal(detectSurfaceMode({ appRoutes: ["src/pages/dashboard/index.tsx"] }).surfaceMode, "operate");
    assert.equal(detectSurfaceMode({ deps: new Set(["three"]), relFiles: ["src/gallery/Scene.tsx"] }).surfaceMode, "experience");
    assert.equal(detectSurfaceMode({ relFiles: ["index.html", "styles.css"] }).surfaceMode, "persuade");

    const dirSdk = join(scratch, "sdk-only-app");
    mkdirSync(join(dirSdk, "app"), { recursive: true });
    writeFileSync(join(dirSdk, "package.json"), JSON.stringify({ name: "sdk-app", dependencies: { next: "^16.0.0", react: "^19.0.0", "@supabase/supabase-js": "^2.0.0" } }));
    writeFileSync(join(dirSdk, "app/page.tsx"), "export default function Page() { return null; }");
    assert.equal(analyzeDirectory(dirSdk).t2MockRequired, true, "Must detect cloud BaaS SDK even without .env");

    // 8. Monorepo DS with packages/design/tokens/*.json + apps/site consuming workspace package must resolve Mode S
    const monoDs = join(scratch, "mono-ds");
    mkdirSync(join(monoDs, "packages/design/tokens"), { recursive: true });
    mkdirSync(join(monoDs, "packages/design/src/components"), { recursive: true });
    mkdirSync(join(monoDs, "apps/site/app"), { recursive: true });
    writeFileSync(join(monoDs, "package.json"), JSON.stringify({ name: "mono-root", private: true, workspaces: ["packages/*", "apps/*"] }));
    writeFileSync(join(monoDs, "packages/design/package.json"), JSON.stringify({ name: "@acme/design", exports: { ".": "./dist/index.js" }, dependencies: { "@base-ui/react": "^1.0.0" } }));
    writeFileSync(join(monoDs, "packages/design/tokens/color.json"), JSON.stringify({ light: { bg: { $type: "color", $value: "#F7F8FA" } } }));
    writeFileSync(join(monoDs, "packages/design/tokens/foundations.json"), JSON.stringify({ space: { s4: { $type: "dimension", $value: "16px" } } }));
    writeFileSync(join(monoDs, "packages/design/src/components/Button.stories.tsx"), "export default {};");
    writeFileSync(join(monoDs, "packages/design/src/components/Badge.stories.tsx"), "export default {};");
    writeFileSync(join(monoDs, "apps/site/package.json"), JSON.stringify({ name: "@acme/site", dependencies: { "@acme/design": "0.0.0", next: "^16.0.0" } }));
    writeFileSync(join(monoDs, "apps/site/app/page.tsx"), "export default function Home() { return null; }");
    const monoRes = analyzeDirectory(monoDs);
    assert.equal(monoRes.stack.hasDtcgTokens, true, "Must detect DTCG JSON under packages/*/tokens/");
    assert.equal(monoRes.recommendedMode, "S", "Monorepo DS with self-referencing site workspace must still classify as Mode S");

    // 9. Round 1 regressions: Vite devDependencies -> Mode C, radix-ui/ariakit -> Mode S, nested tokens, IPv6 local, surface priority
    const viteTw = join(scratch, "vite-tw");
    mkdirSync(join(viteTw, "src"), { recursive: true });
    writeFileSync(join(viteTw, "package.json"), JSON.stringify({ name: "vite-tw", dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^6.0.0", tailwindcss: "^4.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(viteTw, "src/App.tsx"), "export const App = () => null;");
    writeFileSync(join(viteTw, "src/index.css"), "@theme inline { --color-brand: #1d4ed8; }");
    assert.equal(analyzeDirectory(viteTw).recommendedMode, "C", "Vite in devDependencies + @theme inline must classify as Mode C");

    const radixDs = join(scratch, "radix-ds");
    mkdirSync(join(radixDs, "tokens/semantic"), { recursive: true });
    mkdirSync(join(radixDs, "src/components"), { recursive: true });
    writeFileSync(join(radixDs, "package.json"), JSON.stringify({ name: "radix-kit", exports: { ".": "./dist/index.js" }, dependencies: { "radix-ui": "^1.0.0" } }));
    writeFileSync(join(radixDs, "tokens/semantic/color.json"), JSON.stringify({ bg: { $type: "color", $value: "#ffffff" } }));
    writeFileSync(join(radixDs, "src/components/A.tsx"), "export const A=()=>null;");
    writeFileSync(join(radixDs, "src/components/B.tsx"), "export const B=()=>null;");
    writeFileSync(join(radixDs, "src/components/C.tsx"), "export const C=()=>null;");
    assert.equal(analyzeDirectory(radixDs).recommendedMode, "S", "Headless radix-ui DS must remain Mode S and discover nested tokens/semantic/color.json");

    assert.match(analyzeUrlTarget("http://[::1]:3000").recommendedDataTier, /^T2/);
    assert.equal(detectSurfaceMode({ deps: new Set(["VitePress"]), relFiles: ["docs/showcase.md"] }).surfaceMode, "read");

    // Round 2 regressions: multiline gallery detection, Storybook Mode S with dev script + unscoped react-aria, BEM --pseudo non-var
    assert.equal(
      detectSurfaceMode({ relFiles: ["index.html", "gallery/photo.jpg", "styles.css"] }).surfaceMode,
      "experience",
      "Root gallery/ dir on subsequent line must trigger experience mode"
    );
    const sbDs = join(scratch, "sb-only-ds");
    mkdirSync(join(sbDs, "src/components"), { recursive: true });
    writeFileSync(join(sbDs, "package.json"), JSON.stringify({ name: "sb-ds", dependencies: { "react-aria": "^3.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(sbDs, "src/components/A.stories.tsx"), "export default {};");
    writeFileSync(join(sbDs, "src/components/B.stories.tsx"), "export default {};");
    writeFileSync(join(sbDs, "src/components/C.stories.tsx"), "export default {};");
    writeFileSync(join(sbDs, "src/components/Chip.figma.tsx"), "export default {};");
    writeFileSync(join(sbDs, "CHANGELOG.md"), "# Changes");
    writeFileSync(join(sbDs, "CONTRIBUTING.md"), "# Contribute");
    assert.equal(analyzeDirectory(sbDs).recommendedMode, "S", "Storybook DS with react-aria + vite dev must classify Mode S");
    const bemP = join(scratch, "bem-app");
    mkdirSync(join(bemP, "src/pages"), { recursive: true });
    writeFileSync(join(bemP, "package.json"), JSON.stringify({ name: "bem-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(bemP, "src/pages/Home.tsx"), "export const Home = () => null;");
    const bemRules = Array.from({ length: 14 }, (_, idx) => `.btn--mod-${idx}:hover { opacity: 0.9; }`).join("\n");
    writeFileSync(join(bemP, "src/tokens.css"), `/* --c1: #000; --c2: #111; --c3: #222; */\n${bemRules}`);
    assert.equal(analyzeDirectory(bemP).recommendedMode, "P", "BEM modifiers and commented vars must not trigger cssCustomPropCount >= 12");

    // Round 3 regressions: SCSS &--primary modifier non-var, test/fixture token JSON exclusion, dsaf-audit-output skip
    const r3P = join(scratch, "r3-app");
    mkdirSync(join(r3P, "src/__tests__"), { recursive: true });
    mkdirSync(join(r3P, "dsaf-audit-output"), { recursive: true });
    writeFileSync(join(r3P, "package.json"), JSON.stringify({ name: "r3-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r3P, "src/App.tsx"), "export const App = () => null;");
    writeFileSync(join(r3P, "src/__tests__/tokens.mock.json"), JSON.stringify({ access: "abc" }));
    writeFileSync(join(r3P, "dsaf-audit-output/tokens.json"), JSON.stringify({ color: { brand: { $type: "color", $value: "#1d4ed8" } } }));
    const scssNest = Array.from({ length: 14 }, (_, idx) => `.btn { &--mod-${idx}:hover { opacity: 0.9; } }`).join("\n");
    writeFileSync(join(r3P, "src/styles.scss"), scssNest);
    const r3Recon = analyzeDirectory(r3P);
    assert.equal(r3Recon.recommendedMode, "P", "Test token mocks, dsaf-audit-output, and &--mod SCSS modifiers must not push Mode P to Mode C");
    assert.equal(r3Recon.counts.tokenJsonFiles, 0);

    // Round 4 regressions: root tests/ and fixtures/ tokens/tests exclusion, apple.com domain boundary
    const r4Dir = join(scratch, "r4-root-tests");
    mkdirSync(join(r4Dir, "src/pages"), { recursive: true });
    mkdirSync(join(r4Dir, "tests"), { recursive: true });
    mkdirSync(join(r4Dir, "fixtures"), { recursive: true });
    writeFileSync(join(r4Dir, "package.json"), JSON.stringify({ name: "r4-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r4Dir, "src/pages/Home.tsx"), "export const Home = () => null;");
    writeFileSync(join(r4Dir, "tests/tokens.css"), ":root { --t: #000; }\n");
    writeFileSync(join(r4Dir, "tests/smoke.mjs"), "export const ok = true;\n");
    writeFileSync(join(r4Dir, "fixtures/tokens.css"), ":root { --f: #111; }\n");
    const r4Recon = analyzeDirectory(r4Dir);
    assert.equal(r4Recon.recommendedMode, "P", "Root tests/ and fixtures/ tokens must not push Mode P to Mode C");
    assert.equal(r4Recon.counts.cssTokenFiles, 0);
    assert.equal(r4Recon.counts.testFiles, 2, "Root tests/ files must be counted in testFiles");
    assert.equal(analyzeUrlTarget("https://apple.com").surfaceMode, "persuade", "apple.com must not match app surface rule");

    // Round 6 regressions: .app gTLD must not trigger operate surfaceMode; /dashboard & app.* still trigger operate
    assert.equal(analyzeUrlTarget("https://acme.vercel.app/").surfaceMode, "persuade");
    assert.equal(analyzeUrlTarget("https://linear.app").surfaceMode, "persuade");
    assert.equal(analyzeUrlTarget("https://app.acme.com/").surfaceMode, "operate");
    assert.equal(analyzeUrlTarget("https://acme.vercel.app/dashboard").surfaceMode, "operate");

    // Round 7 regressions: auth-token.css excluded from styleFiles, stories excluded from components/appRoutes,
    // operate surfaceMode prioritized over weak markdown count, URL query string excluded from storybook/docs detection
    const r7App = join(scratch, "r7-recon");
    mkdirSync(join(r7App, "docs"), { recursive: true });
    mkdirSync(join(r7App, "src/components"), { recursive: true });
    mkdirSync(join(r7App, "src/app/dashboard"), { recursive: true });
    writeFileSync(join(r7App, "package.json"), JSON.stringify({ name: "r7-app", dependencies: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    for (let i = 1; i <= 6; i++) writeFileSync(join(r7App, `docs/note-${i}.md`), `# Note ${i}`);
    writeFileSync(join(r7App, "src/app/dashboard/page.tsx"), "export default function Dash() { return null; }");
    writeFileSync(join(r7App, "src/components/Btn.tsx"), "export const Btn = () => null;");
    writeFileSync(join(r7App, "src/components/Btn.stories.tsx"), "export default {};");
    writeFileSync(join(r7App, "src/auth-token.css"), ":root { --tok: #fff; }\n");
    const r7Res = analyzeDirectory(r7App);
    assert.equal(r7Res.counts.styleFiles, 0, "auth-token.css must be excluded from styleFiles");
    assert.equal(r7Res.counts.components, 1, "Btn.stories.tsx must be excluded from componentFiles");
    assert.equal(r7Res.surfaceMode, "operate", "Operate dashboard route must beat weak docs markdown count");
    const r7Url = analyzeUrlTarget("https://app.example.com/?tab=docs&ref=storybook");
    assert.equal(r7Url.recommendedMode, "P");
    assert.equal(r7Url.surfaceMode, "operate");

    // Round 8 regression: dynamic [locale] routes, colocated components & stylesheets must NOT be dropped by AUTH_OR_TEST_TOKEN_RE
    const r8Dyn = join(scratch, "r8-dyn-routes");
    mkdirSync(join(r8Dyn, "app/[locale]/components"), { recursive: true });
    mkdirSync(join(r8Dyn, "app/api/auth/[token]"), { recursive: true });
    writeFileSync(join(r8Dyn, "package.json"), JSON.stringify({ name: "r8-dyn", dependencies: { next: "^16.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } }));
    writeFileSync(join(r8Dyn, "app/[locale]/page.tsx"), "export default function Page() { return null; }");
    writeFileSync(join(r8Dyn, "app/[locale]/components/Hero.tsx"), "export const Hero = () => null;");
    writeFileSync(join(r8Dyn, "app/[locale]/layout.css"), ".wrap { color: var(--fg); }\n");
    writeFileSync(join(r8Dyn, "app/api/auth/[token]/route.ts"), "export async function GET() { return null; }");
    writeFileSync(join(r8Dyn, "app/api/auth/[token]/tokens.json"), JSON.stringify({ secret: "abc" }));
    const r8Recon = analyzeDirectory(r8Dyn);
    assert.equal(r8Recon.counts.appRoutes, 2, "Dynamic [locale] route and colocated TSX under app/[locale]/ must be counted in appRoutes");
    assert.equal(r8Recon.counts.components, 1, "Component under app/[locale]/components must be counted in components");
    assert.equal(r8Recon.counts.styleFiles, 1, "Stylesheet under app/[locale] must be counted in styleFiles");
    assert.equal(r8Recon.counts.tokenJsonFiles, 0, "Dynamic API route token JSON must still be excluded");

    // Round 9 regressions (R9-A2-12, R9-A2-13): app/documents & app/doctors operate surface, @base-ui-components/react Mode S,
    // @tauri-apps/api framework detection, auth/tokens.json exclusion
    const r9App = join(scratch, "r9-operate");
    mkdirSync(join(r9App, "app/dashboard"), { recursive: true });
    mkdirSync(join(r9App, "app/documents"), { recursive: true });
    mkdirSync(join(r9App, "app/doctors"), { recursive: true });
    mkdirSync(join(r9App, "components"), { recursive: true });
    mkdirSync(join(r9App, "auth"), { recursive: true });
    writeFileSync(join(r9App, "package.json"), JSON.stringify({ name: "r9-op", dependencies: { react: "^19.0.0", zustand: "^5.0.0", "@tauri-apps/api": "^2.0.0" } }));
    writeFileSync(join(r9App, "app/dashboard/page.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "app/documents/page.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "app/doctors/page.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "components/Table.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "components/Editor.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "components/Modal.tsx"), "export default () => null;");
    writeFileSync(join(r9App, "auth/tokens.json"), JSON.stringify({ access: "secret" }));
    const r9AppRes = analyzeDirectory(r9App);
    assert.equal(r9AppRes.surfaceMode, "operate", "documents/doctors routes must not be misclassified as docs/read");
    assert.ok(r9AppRes.stack.frameworks.includes("@tauri-apps/api"), "@tauri-apps/api must appear in stack.frameworks");
    assert.equal(r9AppRes.counts.tokenJsonFiles, 0, "auth/tokens.json must be excluded");

    const r9BaseUi = join(scratch, "r9-base-ui");
    mkdirSync(join(r9BaseUi, "src/components"), { recursive: true });
    writeFileSync(join(r9BaseUi, "package.json"), JSON.stringify({ name: "r9-ds", exports: "./dist/index.js", dependencies: { "@base-ui-components/react": "^0.1.0" } }));
    writeFileSync(join(r9BaseUi, "src/components/A.tsx"), "export const A = () => null;");
    writeFileSync(join(r9BaseUi, "src/components/B.tsx"), "export const B = () => null;");
    writeFileSync(join(r9BaseUi, "src/components/C.tsx"), "export const C = () => null;");
    writeFileSync(join(r9BaseUi, "src/components/A.stories.tsx"), "export default {};");
    writeFileSync(join(r9BaseUi, "src/components/B.stories.tsx"), "export default {};");
    assert.equal(analyzeDirectory(r9BaseUi).recommendedMode, "S", "@base-ui-components/react must qualify as headless DS dep in Mode S");

    // Round 10 regressions (R10-A2-15, R10-A2-16, R10-A2-17): Astro Mode C + operate detection, bounded operate regexes, nested auth/google/tokens.json exclusion & design-tokens.json discovery
    const r10Astro = join(scratch, "r10-astro");
    mkdirSync(join(r10Astro, "src/pages"), { recursive: true });
    mkdirSync(join(r10Astro, "src/components"), { recursive: true });
    mkdirSync(join(r10Astro, "src/styles"), { recursive: true });
    mkdirSync(join(r10Astro, "auth/google"), { recursive: true });
    writeFileSync(join(r10Astro, "package.json"), JSON.stringify({ name: "r10-astro", dependencies: { astro: "^5.0.0" }, scripts: { dev: "astro dev" } }));
    writeFileSync(join(r10Astro, "src/pages/dashboard.astro"), "---\n---\n<div>Dash</div>\n");
    writeFileSync(join(r10Astro, "src/components/Modal.astro"), "---\n---\n<div>Modal</div>\n");
    writeFileSync(join(r10Astro, "src/styles/global.css"), "@theme inline { --color-brand: #1d4ed8; }\n");
    writeFileSync(join(r10Astro, "src/design-tokens.json"), JSON.stringify({ brand: { $type: "color", $value: "#1d4ed8" } }));
    writeFileSync(join(r10Astro, "auth/google/tokens.json"), JSON.stringify({ access: "secret" }));
    const r10AstroRes = analyzeDirectory(r10Astro);
    assert.equal(r10AstroRes.recommendedMode, "C", "Astro app with @theme inline must recommend Mode C");
    assert.equal(r10AstroRes.surfaceMode, "operate");
    assert.equal(r10AstroRes.counts.appRoutes, 1);
    assert.equal(r10AstroRes.counts.components, 1);
    assert.equal(r10AstroRes.counts.tokenJsonFiles, 1, "src/design-tokens.json discovered and auth/google/tokens.json excluded");

    assert.equal(
      detectSurfaceMode({
        appRoutes: ["src/pages/portable/page.tsx"],
        componentFiles: ["src/components/PlatformHero.tsx", "src/components/PerformanceStats.tsx", "src/components/InformationSection.tsx"],
      }).surfaceMode,
      "persuade",
      "Substring matches like portable/Platform/Information must stay persuade"
    );
    assert.equal(
      detectSurfaceMode({
        appRoutes: ["src/pages/home/page.tsx"],
        componentFiles: ["src/components/UserSettings.tsx", "src/components/LoginForm.tsx", "src/components/FilterToolbar.tsx"],
      }).surfaceMode,
      "operate",
      "CamelCase operate components like UserSettings/LoginForm/FilterToolbar must classify operate"
    );

    // Round 11 regressions (R11-A2-17, R11-A2-18, R11-A2-23):
    const r11Nuxt = join(scratch, "r11-nuxt");
    mkdirSync(join(r11Nuxt, "assets/css"), { recursive: true });
    writeFileSync(join(r11Nuxt, "package.json"), JSON.stringify({ devDependencies: { nuxt: "^3.15.0", vue: "^3.5.0" }, scripts: { dev: "nuxt dev" } }));
    writeFileSync(join(r11Nuxt, "app.vue"), "<template><div/></template>\n");
    writeFileSync(join(r11Nuxt, "assets/css/main.css"), "@theme inline { --color-brand: #1d4ed8; }\n");
    assert.equal(analyzeDirectory(r11Nuxt).recommendedMode, "C", "Nuxt in devDependencies with @theme must recommend Mode C");

    const r11Headless = join(scratch, "r11-headlessui");
    mkdirSync(join(r11Headless, "src"), { recursive: true });
    writeFileSync(join(r11Headless, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", "@headlessui/react": "^2.0.0" }, devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r11Headless, "src/App.tsx"), "export function App(){return <div/>}\n");
    assert.equal(analyzeDirectory(r11Headless).recommendedMode, "C", "@headlessui/react dependency must classify as DS dependency (Mode C)");

    assert.equal(
      detectSurfaceMode({ appRoutes: ["src/pages/BlogPost.tsx", "src/pages/DocsPage.tsx"], deps: [], componentFiles: [], docsHits: 0, isDesignSystem: false, allText: "" }).surfaceMode,
      "read",
      "CamelCase DocsPage/BlogPost routes must classify surfaceMode read via normSeg()"
    );
    assert.equal(analyzeUrlTarget("https://paradocs.io").surfaceMode, "persuade", "Bounded docs host segment must not match 'paradocs.io'");

    // Round 12 regressions (R12-A2-21): libs/* workspace packages, radix-vue Mode S, and .figma.batch.* detection
    const r12Nx = join(scratch, "r12-nx");
    mkdirSync(join(r12Nx, "libs/ui/src"), { recursive: true });
    mkdirSync(join(r12Nx, "apps/web/src/figma"), { recursive: true });
    writeFileSync(join(r12Nx, "package.json"), JSON.stringify({ name: "nx-mono", private: true, workspaces: ["libs/*", "apps/*"] }));
    writeFileSync(join(r12Nx, "libs/ui/package.json"), JSON.stringify({ name: "@nx/ui", dependencies: { "@supabase/supabase-js": "^2.0.0", "@radix-ui/react-dialog": "^1.0.0" } }));
    writeFileSync(join(r12Nx, "apps/web/package.json"), JSON.stringify({ name: "@nx/web", scripts: { dev: "vite" }, devDependencies: { vite: "^6.0.0" } }));
    writeFileSync(join(r12Nx, "apps/web/src/figma/Icons.figma.batch.ts"), "export default [];\n");
    const r12NxRes = analyzeDirectory(r12Nx);
    assert.equal(r12NxRes.t2MockRequired, true, "libs/ui @supabase/supabase-js must set t2MockRequired");
    assert.equal(r12NxRes.counts.packages, 3, "Nx monorepo must include root, libs/ui, and apps/web packages");
    assert.equal(r12NxRes.counts.figmaCodeConnect, 1, ".figma.batch.ts must be counted in figmaCodeConnect");
    assert.equal(r12NxRes.stack.designSystemPackages.includes("@radix-ui/react-dialog"), true);

    const r12VueDs = join(scratch, "r12-vue-ds");
    mkdirSync(join(r12VueDs, "src/components"), { recursive: true });
    writeFileSync(join(r12VueDs, "package.json"), JSON.stringify({ name: "vue-ds", exports: "./dist/index.js", dependencies: { vue: "^3.5.0", "radix-vue": "^1.9.0" } }));
    writeFileSync(join(r12VueDs, "tokens.tokens.json"), JSON.stringify({ color: { primary: { $type: "color", $value: "#1d4ed8" } } }));
    for (const c of ["Btn", "Card", "Badge"]) writeFileSync(join(r12VueDs, `src/components/${c}.vue`), "<template><div/></template>\n");
    assert.equal(analyzeDirectory(r12VueDs).recommendedMode, "S", "Vue DS using radix-vue headless primitives must classify as Mode S");

    // Round 13 regressions (R13-A2-18, R13-A2-20): reka-ui/bits-ui detection & quoted @theme immunity
    const r13Reka = join(scratch, "r13-reka");
    mkdirSync(join(r13Reka, "src"), { recursive: true });
    writeFileSync(join(r13Reka, "package.json"), JSON.stringify({ name: "vue-app", dependencies: { vue: "^3.5.0", "reka-ui": "^2.0.0" }, devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r13Reka, "src/App.vue"), "<template><div/></template>\n");
    const r13RekaRes = analyzeDirectory(r13Reka);
    assert.deepEqual(r13RekaRes.stack.designSystemPackages, ["reka-ui"]);
    assert.equal(r13RekaRes.recommendedMode, "C");

    const r13Bits = join(scratch, "r13-bits");
    mkdirSync(join(r13Bits, "src"), { recursive: true });
    writeFileSync(join(r13Bits, "package.json"), JSON.stringify({ name: "svelte-app", dependencies: { svelte: "^5.0.0", "bits-ui": "^1.0.0" }, devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r13Bits, "src/App.svelte"), "<div/>\n");
    const r13BitsRes = analyzeDirectory(r13Bits);
    assert.deepEqual(r13BitsRes.stack.designSystemPackages, ["bits-ui"]);
    assert.equal(r13BitsRes.recommendedMode, "C");

    const r13QuoteTheme = join(scratch, "r13-qtheme");
    mkdirSync(join(r13QuoteTheme, "src"), { recursive: true });
    writeFileSync(join(r13QuoteTheme, "package.json"), JSON.stringify({ name: "plain-app", devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r13QuoteTheme, "src/styles.css"), ['.footer::after { content: "', 'help', '@', 'theme.example"; }\n'].join(""));
    const r13QtRes = analyzeDirectory(r13QuoteTheme);
    assert.equal(r13QtRes.stack.hasTailwindTheme, false);
    assert.equal(r13QtRes.recommendedMode, "P");

    // Round 14 regressions (R14-A2-15, R14-A2-19): quoted --var: exclusion & symlinked monorepo traversal with cycle/broken-link safety
    const r14QVar = join(scratch, "r14-qvar");
    mkdirSync(join(r14QVar, "src"), { recursive: true });
    writeFileSync(join(r14QVar, "package.json"), JSON.stringify({ name: "qvar-app" }));
    writeFileSync(join(r14QVar, "src/tip.css"), '.tip::after { content: "--fake: 1"; }\n');
    assert.equal(analyzeDirectory(r14QVar).counts.cssCustomPropDefsSampled, 0, "Quoted CSS content '--fake: 1' must not inflate cssCustomPropDefsSampled");

    const r14SymApp = join(scratch, "r14-sym-app");
    const r14Shared = join(scratch, "r14-shared-ds");
    mkdirSync(join(r14SymApp, "packages"), { recursive: true });
    mkdirSync(join(r14Shared, "components"), { recursive: true });
    writeFileSync(join(r14SymApp, "package.json"), JSON.stringify({ name: "mono-ds", private: true, exports: "./dist/index.js" }));
    writeFileSync(join(r14Shared, "tokens.tokens.json"), JSON.stringify({ color: { primary: { $type: "color", $value: "#1d4ed8" } } }));
    for (const c of ["Button", "Card", "Badge"]) writeFileSync(join(r14Shared, `components/${c}.tsx`), "export const X = () => null;\n");
    symlinkSync(r14Shared, join(r14SymApp, "packages/design"));
    symlinkSync(r14SymApp, join(r14Shared, "loop-back"));
    symlinkSync(join(r14SymApp, "missing.css"), join(r14SymApp, "broken.css"));
    const r14SymRes = analyzeDirectory(r14SymApp);
    assert.equal(r14SymRes.counts.tokenJsonFiles, 1, "Symlinked packages/design tokens must be discovered");
    assert.equal(r14SymRes.counts.components, 3, "Symlinked packages/design components must be discovered");
    assert.equal(r14SymRes.recommendedMode, "S");

    // Round 16 regressions (R16-A2-18): fixtures/components.json and *-components.json must not flip Mode P to Mode C; acronym components must detect operate
    const r16ModeP = join(scratch, "r16-modep");
    mkdirSync(join(r16ModeP, "fixtures"), { recursive: true });
    mkdirSync(join(r16ModeP, "src/components"), { recursive: true });
    writeFileSync(join(r16ModeP, "package.json"), JSON.stringify({ name: "plain-app", devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } }));
    writeFileSync(join(r16ModeP, "fixtures/components.json"), "{}");
    writeFileSync(join(r16ModeP, "src/data-components.json"), "{}");
    writeFileSync(join(r16ModeP, "src/components/HTMLTable.tsx"), "export const HTMLTable = () => null;\n");
    writeFileSync(join(r16ModeP, "src/components/JSONEditor.tsx"), "export const JSONEditor = () => null;\n");
    writeFileSync(join(r16ModeP, "src/components/UIModal.tsx"), "export const UIModal = () => null;\n");
    const r16Res = analyzeDirectory(r16ModeP);
    assert.equal(r16Res.recommendedMode, "P");
    assert.equal(r16Res.stack.hasShadcnMarkers, false);
    assert.equal(r16Res.surfaceMode, "operate");

    // Round 17 regression (R17-A2-R1): non-design *token*.json config files must not inflate tokenJsonFiles or flip Mode P to Mode C
    const r17TokCfg = join(scratch, "r17-token-config");
    mkdirSync(join(r17TokCfg, "src"), { recursive: true });
    writeFileSync(join(r17TokCfg, "package.json"), JSON.stringify({ name: "r17-mode-p", dependencies: { next: "^16.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } }));
    writeFileSync(join(r17TokCfg, "src/App.tsx"), "export const App = () => null;\n");
    writeFileSync(join(r17TokCfg, "src/token-config.json"), JSON.stringify({ expirySeconds: 3600, issuer: "auth" }));
    writeFileSync(join(r17TokCfg, "src/pagination-token.json"), JSON.stringify({ ttl: 600, prefix: "pg" }));
    const r17Res = analyzeDirectory(r17TokCfg);
    assert.equal(r17Res.counts.tokenJsonFiles, 0, "Non-design token-config.json must not count toward tokenJsonFiles");
    assert.equal(r17Res.recommendedMode, "P", "Non-design *token*.json files must not flip Mode P app to Mode C");

    // Round 18 regressions (R18-A2-17, R18-A2-20): generic { value: "cursor_123" }, showcase image asset, and non-HTTP URL rejection
    writeFileSync(join(r17TokCfg, "src/custom-token.json"), JSON.stringify({ pagination: { value: "cursor_123" } }));
    mkdirSync(join(r17TokCfg, "public/images"), { recursive: true });
    writeFileSync(join(r17TokCfg, "public/images/showcase-hero.png"), "png\n");
    const r18Res = analyzeDirectory(r17TokCfg);
    assert.equal(r18Res.counts.tokenJsonFiles, 0);
    assert.equal(r18Res.recommendedMode, "P");
    assert.equal(r18Res.surfaceMode, "persuade");
    assert.throws(() => analyzeUrlTarget("file" + ":///etc/passwd"), /Invalid URL/);

    // Round 19 regression (R19-A2-17): session config durations must not trigger tokenJsonFiles; hyphenated -app hostnames stay persuade
    writeFileSync(join(r17TokCfg, "src/session-token.json"), JSON.stringify({ session: { duration: "300s" } }));
    const r19Res = analyzeDirectory(r17TokCfg);
    assert.equal(r19Res.counts.tokenJsonFiles, 0, "session.duration='300s' in *token*.json must not flag design tokens");
    assert.equal(r19Res.recommendedMode, "P");
    assert.equal(analyzeUrlTarget("https://my-app.com/").surfaceMode, "persuade");
    assert.equal(analyzeUrlTarget("https://app.example.com/").surfaceMode, "operate");
    assert.equal(analyzeUrlTarget("https://example.com/app").surfaceMode, "operate");

    // Round 20 regression (R20-A2-L16): camelCase non-design keys in *tokens*.json must stay Mode P
    writeFileSync(join(r17TokCfg, "src/config-tokens.json"), JSON.stringify({ sessionTimeout: { duration: "5s" }, authConfig: { value: "500ms" } }));
    const r20Res = analyzeDirectory(r17TokCfg);
    assert.equal(r20Res.counts.tokenJsonFiles, 0, "CamelCase sessionTimeout/authConfig in *tokens*.json must not flag design tokens");
    assert.equal(r20Res.recommendedMode, "P");

    // Round 21 regression (R21-A2-M7): acronym-prefixed non-design keys (HTTPTimeout, JWTSecret) stay Mode P
    writeFileSync(join(r17TokCfg, "src/config-tokens.json"), JSON.stringify({ HTTPTimeout: { duration: "5s" }, JWTSecret: { value: "500ms" }, APIConfig: { value: "100ms" } }));
    const r21AcrRes = analyzeDirectory(r17TokCfg);
    assert.equal(r21AcrRes.counts.tokenJsonFiles, 0, "Acronym-prefixed HTTPTimeout/JWTSecret/APIConfig must not flag design tokens");
    assert.equal(r21AcrRes.recommendedMode, "P");

    // Round 22 regression (R22-A2-L3): csrf/access/refresh/bearer camelCase keys in *tokens*.json stay Mode P
    writeFileSync(
      join(r17TokCfg, "src/auth-vars.tokens.json"),
      JSON.stringify({ CSRFToken: { value: "5s" }, accessToken: { duration: "10s" }, bearerToken: { value: "500ms" } })
    );
    writeFileSync(
      join(r17TokCfg, "src/config-tokens.json"),
      JSON.stringify({ CSRFToken: { value: "5s" }, accessToken: { duration: "10s" }, refreshTTL: { value: "500ms" }, bearerToken: { value: "100ms" } })
    );
    const r22AuthRes = analyzeDirectory(r17TokCfg);
    assert.equal(r22AuthRes.counts.tokenJsonFiles, 0, "R22 L3: CSRFToken/accessToken/bearerToken in *tokens*.json must stay Mode P");
    assert.equal(r22AuthRes.recommendedMode, "P");

    const reconSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [reconSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [reconSelfPath, scratch, "--out", "   "], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [reconSelfPath, scratch, scratch], { encoding: "utf8" }).status, 2);

    // Round 24 regressions (A2-M2 generic type/non-dotted alias rejection, A4-M7 invalid URL & file target exit 2)
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ limit: { type: "number", value: 10 }, msg: { value: "{foo}" } })).valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ scale: { type: "other", value: "{unknown.ref}" } })).valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ spacing: { sm: { type: "number", value: 4 } } })).valid, true);
    const nonDirFile = join(scratch, "single.json");
    writeFileSync(nonDirFile, "{}");
    assert.equal(spawnSync(process.execPath, [reconSelfPath, nonDirFile], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [reconSelfPath, "https://[::invalid"], { encoding: "utf8" }).status, 2);

    // Round 25 regressions (A2-M6 JSON/manifest/non-design parents/inDomain, A4-H1 live leaf symlink, A4-L1 isDirectCliEntry)
    assert.equal(hasDesignTokenEvidence('{ "$value": broken').valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ desc: '"$value": 1' })).valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ name: "MyApp", short_name: "App", icons: [], theme_color: "#ffffff" })).valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ retries: { delay: { value: "500ms" } }, worker: { value: "16px" }, keepalive: { value: "2s" } })).valid, false);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ spacing: { gap: { value: "16px" } } })).valid, true);
    assert.equal(hasDesignTokenEvidence(JSON.stringify({ cardSpacing: { sm: "8px" } })).valid, true);
    const reconSymOut = join(scratch, "recon-sym.json");
    const reconSecret = join(scratch, "secret.json");
    writeFileSync(reconSecret, "{}");
    symlinkSync(reconSecret, reconSymOut);
    assert.equal(spawnSync(process.execPath, [reconSelfPath, r17TokCfg, "--out", reconSymOut], { encoding: "utf8" }).status, 2);
    const reconCliSym = join(scratch, "recon-cli-sym.mjs");
    symlinkSync(reconSelfPath, reconCliSym);
    assert.equal(spawnSync(process.execPath, [reconCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 28 (A2-M2): --out must reject symlink dir escape out of local target directory
    const r28ReconProj = join(scratch, "r28-recon-proj");
    const r28ReconOut = join(scratch, "r28-recon-outside");
    mkdirSync(join(r28ReconProj, "out"), { recursive: true });
    mkdirSync(r28ReconOut, { recursive: true });
    symlinkSync(r28ReconOut, join(r28ReconProj, "out/sym"));
    assert.equal(
      spawnSync(process.execPath, [reconSelfPath, r28ReconProj, "--out", join(r28ReconProj, "out/sym/evil.json")], { encoding: "utf8" }).status,
      2,
      "R28 A2-M2: recon --out must reject symlink escape out of target directory"
    );
    assert.equal(existsSync(join(r28ReconOut, "evil.json")), false);

    // Round 29 (A2-L11): !negated workspace globs must exclude matching packages even under packages/*
    const r29WsProj = join(scratch, "r29-ws-proj");
    mkdirSync(join(r29WsProj, "packages/ui"), { recursive: true });
    mkdirSync(join(r29WsProj, "packages/ignored"), { recursive: true });
    writeFileSync(join(r29WsProj, "package.json"), JSON.stringify({ name: "ws-root", private: true, workspaces: { packages: ["packages/*", "!packages/ignored"] } }));
    writeFileSync(join(r29WsProj, "packages/ui/package.json"), JSON.stringify({ name: "@app/ui", dependencies: { react: "^18.0.0" } }));
    writeFileSync(join(r29WsProj, "packages/ignored/package.json"), JSON.stringify({ name: "@app/ignored", dependencies: { vue: "^3.0.0" } }));
    const r29WsRes = analyzeDirectory(r29WsProj);
    assert.equal(r29WsRes.counts.packages, 2, "R29 A2-L11: !packages/ignored must be excluded from package count");
    assert.deepEqual(r29WsRes.stack.frameworks, ["react"], "R29 A2-L11: excluded workspace deps must not pollute frameworks");

    console.log("RECON_SELF_TEST_PASSED (Mode S/C/P + Surface Modes + @theme + auth/hidden-dir exclusion + URL safety)");
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
        out: { type: "string" },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (values.help) {
    console.log("Usage: node skill/scripts/recon.mjs <repo-dir-or-url> [--out <recon.json>] [--self-test] [--help]");
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
  if (positionals.length > 1) {
    console.error(`Error: unexpected extra positional argument '${positionals[1]}'. Pass a single <repo-dir-or-url>.`);
    process.exit(2);
  }
  const target = positionals[0];
  if (!target || !target.trim()) {
    console.error("Error: non-empty <repo-dir-or-url> is required unless --self-test is passed.");
    process.exit(2);
  }
  if (/^https?:\/\//i.test(target)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(target);
    } catch {
      console.error(`Error: Invalid URL target: ${target}`);
      process.exit(2);
    }
    if (!parsedUrl.hostname) {
      console.error(`Error: URL target must include a hostname: ${target}`);
      process.exit(2);
    }
  } else {
    const absTarget = resolve(target);
    if (!existsSync(absTarget)) {
      console.error(`Error: Target directory not found: ${absTarget}`);
      process.exit(2);
    }
    if (!statSync(absTarget).isDirectory()) {
      console.error(`Error: Target path must be a directory or http(s) URL (got non-directory): ${absTarget}`);
      process.exit(2);
    }
  }
  if (values.out !== undefined) {
    try {
      const outOpts = /^https?:\/\//i.test(target) ? {} : { rootDir: resolve(target) };
      assertWritableOutputFile(values.out, "--out", outOpts);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  try {
    const result = /^https?:\/\//i.test(target) ? analyzeUrlTarget(target) : analyzeDirectory(target);
    const json = JSON.stringify(result, null, 2) + "\n";
    if (values.out) {
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), json, "utf8");
    }
    process.stdout.write(json);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (isDirectCliEntry(import.meta.url)) main();

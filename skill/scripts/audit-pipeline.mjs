#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Unified Tier 0 Read-Only One-Click Audit Pipeline (Node ESM).
 * Chains `recon` (incl. Surface Mode), `tokens`, `personas` impact mapping,
 * optional live/Storybook/CDP `runtime`, optional 2/3-vertex `figma-diff`,
 * optional `audit-diff`, and `--html` report into `audit-summary.json` + Markdown + SARIF 2.1.0.
 * Strictly Tier 0 Read-Only on target repos; writes only inside explicit `--out` / `--sarif` / `--html`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scanTarget } from "./audit-tokens.mjs";
import { compareVertices, renderMarkdown as renderFigmaMarkdown } from "./audit-figma-diff.mjs";
import { checkTarget, discoverExternalDsCss } from "./dsaf-hook.mjs";
import { assertWritableOutputDir, assertWritableOutputFile, CI_REPORT_VERSION, escMdCell, formatGithubAnnotations, formatMdCodeSpan, formatSarif, isDirectCliEntry } from "./ci-report.mjs";
import { parseArgs as parseRuntimeArgs } from "./audit-runtime.mjs";
import { generatePersonas } from "./generate-personas.mjs";
import { renderHtmlReport } from "./generate-html-report.mjs";
import { diffScorecards } from "./audit-diff.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PIPELINE_VERSION = "0.9.3";
const TIER_RANK = { floor: 0, reflex: 1, finish: 2 };

export function resolveScopedDir(target, rawScope) {
  if (rawScope === undefined || rawScope === null) {
    return { normScope: "", scopedDir: target };
  }
  if (typeof rawScope !== "string" || rawScope.trim().length === 0) {
    throw new Error("Parameter '--scope' must be a non-empty relative path.");
  }
  const cleaned = rawScope.trim().replace(/\\/g, "/");
  const segs = cleaned.split("/").filter(Boolean);
  if (!cleaned.startsWith("/") && segs.length > 0 && segs.every((s) => s === ".")) {
    return { normScope: "", scopedDir: target };
  }
  const scopedPath = resolve(target, cleaned);
  if (!existsSync(scopedPath)) {
    throw new Error(`Audit scope not found: ${scopedPath}`);
  }
  if (!statSync(scopedPath).isDirectory()) {
    throw new Error(`Audit scope is not a directory: ${scopedPath}`);
  }
  const nativeReal = (p) => (realpathSync.native ? realpathSync.native(p) : realpathSync(p));
  const normCase = (p) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const realTarget = nativeReal(target);
  const realScoped = nativeReal(scopedPath);
  const relScope = relative(normCase(realTarget), normCase(realScoped));
  if (relScope === ".." || relScope.startsWith(`..${sep}`) || isAbsolute(relScope)) {
    throw new Error(`Audit scope escapes target root: ${rawScope}`);
  }
  if (!relScope) {
    return { normScope: "", scopedDir: target };
  }
  const canonicalRel = relative(realTarget, realScoped).replace(/\\/g, "/");
  const safeRel =
    canonicalRel === ".." || canonicalRel.startsWith("../") || isAbsolute(canonicalRel)
      ? relScope.replace(/\\/g, "/")
      : canonicalRel;
  if (!safeRel) {
    return { normScope: "", scopedDir: target };
  }
  return { normScope: safeRel, scopedDir: join(target, safeRel) };
}

function runSubScript(scriptName, args) {
  return spawnSync(process.execPath, [join(SCRIPT_DIR, scriptName), ...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function loadOrGeneratePersonas(target, recon) {
  const dsafDir = join(target, ".dsaf");
  let dsafLst = null;
  try {
    dsafLst = lstatSync(dsafDir);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (dsafLst) {
    if (dsafLst.isSymbolicLink()) {
      throw new Error("Invalid .dsaf directory: symlinks are not allowed.");
    }
    if (!statSync(dsafDir).isDirectory()) {
      throw new Error("Invalid .dsaf path: expected a directory.");
    }
  }
  const existingPath = join(dsafDir, "personas.json");
  let lst = null;
  try {
    lst = lstatSync(existingPath);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (lst) {
    if (lst.isSymbolicLink()) {
      throw new Error("Invalid .dsaf/personas.json: symlinks are not allowed.");
    }
    if (!statSync(existingPath).isFile()) {
      throw new Error("Invalid .dsaf/personas.json: expected a regular file.");
    }
    const realRoot = realpathSync(resolve(target));
    const realFile = realpathSync(existingPath);
    const rootPref = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realFile.startsWith(rootPref)) {
      throw new Error(`Invalid .dsaf/personas.json: resolves outside target root '${target}'.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(existingPath, "utf8"));
    } catch (err) {
      throw new Error(`Invalid .dsaf/personas.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.personas)) {
      throw new Error("Invalid .dsaf/personas.json: expected object with 'personas' array.");
    }
    if (
      parsed.personas.some(
        (p) =>
          !p ||
          typeof p !== "object" ||
          Array.isArray(p) ||
          typeof p.id !== "string" ||
          p.id.trim().length === 0 ||
          (p.expectations !== undefined && (!Array.isArray(p.expectations) || p.expectations.some((e) => typeof e !== "string"))) ||
          (p.failureModes !== undefined && (!Array.isArray(p.failureModes) || p.failureModes.some((e) => typeof e !== "string")))
      )
    ) {
      throw new Error("Invalid .dsaf/personas.json: every persona entry must have a non-empty 'id' and optional string arrays for 'expectations'/'failureModes'.");
    }
    if (parsed.personas.length > 0) {
      return { source: ".dsaf/personas.json", list: parsed.personas };
    }
  }
  const gen = generatePersonas(target, { depth: "auto", recon, relativeTarget: "." });
  return { source: "generated:auto", list: gen.personas || [] };
}

export function mapFindingToPersonas(finding, personas = []) {
  const rule = String(finding?.ruleId || "").toLowerCase();
  const matchedIds = [];
  for (const p of personas) {
    const text = `${p.axis || ""} ${p.name || ""} ${(Array.isArray(p.expectations) ? p.expectations : []).join(" ")} ${(Array.isArray(p.failureModes) ? p.failureModes : []).join(" ")} ${p.source || ""}`.toLowerCase();
    let hit = false;
    if (/runtime-check/.test(rule)) {
      hit = /keyboard|focus|screen reader|aria|navigation|onboarding|conformance|mobile|390|responsive|contrast|low-vision|dark|motion/.test(text);
    } else if (/regression-detected/.test(rule)) {
      hit = /maintainer|governance|conformance|consumer|visual|keyboard/.test(text);
    } else if (/(outline-none|positive-tabindex|unnamed-control|floor-waiver-rejected)/.test(rule)) {
      hit = /keyboard|focus|screen reader|aria|navigation|onboarding|conformance/.test(text);
    } else if (/no-100vw/.test(rule)) {
      hit = /mobile|390|responsive|table|overflow|hybrid/.test(text);
    } else if (/(hardcoded-color|dtcg-contrast|dark)/.test(rule)) {
      hit = /contrast|dark|token|conformance|low-vision|theme/.test(text);
    } else if (/(important|off-grid|dtcg-|tailwind-arbitrary|semantic-orphan-var|waiver-reason-weak|unused-ignore)/.test(rule)) {
      hit = /token|conformance|drift|consumer|visual|maintainer|governance/.test(text);
    } else if (/(transition|layout-transition|autoplay|hidden-at-rest|motion)/.test(rule)) {
      hit = /motion|low-vision|keyboard|visitor|resilience/.test(text);
    }
    if (hit) matchedIds.push(p.id);
  }
  return matchedIds;
}

export function buildRuntimeArgs(opts = {}, rtPath = null) {
  const rtArgs = [];
  const urlVal = opts.url ? String(opts.url).trim() : "";
  const cdpVal = opts.cdp ? String(opts.cdp).trim() : "";
  const sbVal = opts.storybook ? String(opts.storybook).trim() : "";
  if (urlVal) rtArgs.push("--live");
  if (cdpVal) rtArgs.push("--cdp", cdpVal);
  if (opts.cdpTarget) rtArgs.push("--target", opts.cdpTarget);
  if (opts.extendedViewports) rtArgs.push("--extended-viewports");
  if (opts.noHideOverlays) rtArgs.push("--no-hide-overlays");
  if (sbVal) rtArgs.push("--storybook", sbVal);
  if (opts.routes) rtArgs.push("--routes", opts.routes);
  if (opts.axePath) rtArgs.push("--axe", opts.axePath);
  if (opts.executablePath) rtArgs.push("--executable-path", opts.executablePath);
  if (opts.themeToggle) rtArgs.push("--theme-toggle", opts.themeToggle);
  if (rtPath) {
    rtArgs.push("--out", rtPath);
  } else {
    rtArgs.push("--json");
  }
  if (urlVal) rtArgs.push("--", urlVal);
  return rtArgs;
}

export function runAuditPipeline(opts = {}) {
  if (typeof (opts.target ?? ".") !== "string" || String(opts.target ?? ".").trim().length === 0) {
    throw new Error("Audit <target> directory must be a non-empty path.");
  }
  const target = resolve(opts.target || ".");
  if (!existsSync(target)) throw new Error(`Audit target not found: ${target}`);
  if (!statSync(target).isDirectory()) {
    throw new Error(
      `Audit target is not a directory: ${target} (pass a project directory, or use 'dsaf tokens' / 'dsaf hook check' for single files)`
    );
  }
  const optStringChecks = [
    ["figmaPath", "--figma"],
    ["codeConnectDir", "--code-connect"],
    ["baselinePath", "--baseline"],
    ["currentPath", "--current"],
    ["url", "--url"],
    ["routes", "--routes"],
    ["cdp", "--cdp"],
    ["cdpTarget", "--target"],
    ["storybook", "--storybook"],
    ["prefix", "--prefix"],
    ["axePath", "--axe"],
    ["executablePath", "--executable-path"],
    ["themeToggle", "--theme-toggle"],
    ["previewHref", "--preview-href"],
  ];
  for (const [prop, flag] of optStringChecks) {
    const val = opts[prop];
    if (val !== undefined && val !== null && (typeof val !== "string" || val.trim().length === 0)) {
      throw new Error(`Parameter '${flag}' must be a non-empty string.`);
    }
  }
  if ((opts.baselinePath && !opts.currentPath) || (!opts.baselinePath && opts.currentPath)) {
    throw new Error("Both --baseline and --current are required together for regression diff.");
  }
  const canonicalizeOutputPath = (absPath) => {
    const resolved = resolve(absPath);
    const tail = [];
    let cur = resolved;
    while (true) {
      try {
        const real = (realpathSync.native || realpathSync)(cur);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return resolved;
        tail.push(basename(cur));
        cur = parent;
      }
    }
  };
  const rawOptPath = (val, label) => {
    if (val === undefined || val === null) return null;
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new Error(`Parameter '${label}' must be a non-empty path.`);
    }
    return resolve(val);
  };
  const outDir = rawOptPath(opts.outDir, "--out");
  const absSarif = rawOptPath(opts.sarifPath, "--sarif");
  const absHtml = rawOptPath(opts.htmlPath, "--html");
  const canonOutDir = outDir ? canonicalizeOutputPath(outDir) : null;
  const canonSarif = absSarif ? canonicalizeOutputPath(absSarif) : null;
  const canonHtml = absHtml ? canonicalizeOutputPath(absHtml) : null;
  const normCmpPath = (p) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const isSameOrUnder = (parentDir, childPath) => {
    const rel = relative(normCmpPath(parentDir), normCmpPath(childPath));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const OUT_RESERVED_FILES = new Set([
    "recon.json",
    "tokens.json",
    "runtime.json",
    "figma-diff.json",
    "figma-diff.md",
    "audit-diff.md",
    "audit-summary.json",
    "audit-summary.md",
  ]);
  const isOutFileCollision = (dirPath, filePath) => {
    if (isSameOrUnder(filePath, dirPath)) return true;
    if (!isSameOrUnder(dirPath, filePath)) return false;
    const rel = relative(normCmpPath(dirPath), normCmpPath(filePath));
    const firstSeg = rel.split(/[\\/]/)[0];
    return Boolean(firstSeg && OUT_RESERVED_FILES.has(firstSeg));
  };
  if (canonOutDir && canonSarif && isOutFileCollision(canonOutDir, canonSarif)) {
    throw new Error(`Output path collision between --out and --sarif: ${absSarif}`);
  }
  if (canonOutDir && canonHtml && isOutFileCollision(canonOutDir, canonHtml)) {
    throw new Error(`Output path collision between --out and --html: ${absHtml}`);
  }
  if (canonSarif && canonHtml && (isSameOrUnder(canonSarif, canonHtml) || isSameOrUnder(canonHtml, canonSarif))) {
    throw new Error(`Output path collision between --sarif and --html: ${absSarif}`);
  }
  if (outDir && existsSync(outDir)) {
    for (const reserved of OUT_RESERVED_FILES) {
      const resPath = join(outDir, reserved);
      if (existsSync(resPath)) {
        const canonRes = canonicalizeOutputPath(resPath);
        if (canonSarif && (isSameOrUnder(canonRes, canonSarif) || isSameOrUnder(canonSarif, canonRes))) {
          throw new Error(`Output path collision between --out/${reserved} and --sarif: ${resPath}`);
        }
        if (canonHtml && (isSameOrUnder(canonRes, canonHtml) || isSameOrUnder(canonHtml, canonRes))) {
          throw new Error(`Output path collision between --out/${reserved} and --html: ${resPath}`);
        }
      }
    }
  }
  if (outDir) assertWritableOutputDir(opts.outDir, "--out", { rootDir: target, allowEqualRoot: true });
  if (absSarif) assertWritableOutputFile(opts.sarifPath, "--sarif", { rootDir: target });
  if (absHtml) assertWritableOutputFile(opts.htmlPath, "--html", { rootDir: target });
  if (outDir && existsSync(outDir)) {
    for (const reserved of OUT_RESERVED_FILES) {
      assertWritableOutputFile(join(outDir, reserved), `--out/${reserved}`, { rootDir: target });
    }
  }
  const { normScope, scopedDir } = resolveScopedDir(target, opts.scope);
  const normalizedDsCss =
    opts.dsCss === undefined || opts.dsCss === null ? [] : Array.isArray(opts.dsCss) ? opts.dsCss : [opts.dsCss];
  if (normalizedDsCss.some((entry) => typeof entry !== "string" || entry.trim().length === 0 || entry.split(",").some((p) => p.trim().length === 0))) {
    throw new Error("Parameter '--ds-css' must be a non-empty file path.");
  }
  if (normalizedDsCss.length > 0) {
    discoverExternalDsCss(scopedDir, normalizedDsCss);
  }
  const isPlainObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (opts.baselinePath && opts.currentPath) {
    const scoreDocs = [];
    for (const [bPath, bLabel] of [
      [opts.baselinePath, "--baseline"],
      [opts.currentPath, "--current"],
    ]) {
      const absScore = resolve(bPath);
      let sLst = null;
      try {
        sLst = lstatSync(absScore);
      } catch (err) {
        if (err?.code === "ENOTDIR") {
          throw new Error(`${bLabel} parent is not a directory: ${dirname(absScore)}`);
        }
        if (err?.code !== "ENOENT") throw err;
      }
      if (sLst?.isSymbolicLink() && !existsSync(absScore)) {
        throw new Error(`${bLabel} file is a broken symlink: ${absScore}`);
      }
      if (!existsSync(absScore) || !statSync(absScore).isFile()) {
        throw new Error(`${bLabel} file not found or not a regular file: ${absScore}`);
      }
      let parsedScore;
      try {
        parsedScore = JSON.parse(readFileSync(absScore, "utf8"));
      } catch (err) {
        throw new Error(`${bLabel} invalid JSON in ${absScore}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (
        !isPlainObj(parsedScore) ||
        parsedScore.schema !== "dsaf-scores/2" ||
        !isPlainObj(parsedScore.criteria?.before) ||
        !isPlainObj(parsedScore.phases?.before)
      ) {
        throw new Error(`${bLabel} ${absScore} is not a valid dsaf-scores/2 scorecard output.`);
      }
      scoreDocs.push(parsedScore);
    }
    diffScorecards(scoreDocs[0], scoreDocs[1], "before");
  }
  const trimmedUrl = opts.url ? String(opts.url).trim() : null;
  const trimmedStorybook = opts.storybook ? String(opts.storybook).trim() : null;
  const trimmedCdp = opts.cdp ? String(opts.cdp).trim() : null;
  if (trimmedCdp && (trimmedUrl || trimmedStorybook)) {
    throw new Error("Cannot combine '--cdp' with '--url' or '--storybook'.");
  }
  if (opts.routes !== undefined && opts.routes !== null) {
    if (!trimmedUrl || !/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error("Parameter '--routes' requires an http(s):// '--url' target.");
    }
    if (String(opts.routes).split(",").some((s) => !s.trim())) {
      throw new Error(`Parameter '--routes' must contain non-empty comma-separated route paths (got '${opts.routes}').`);
    }
  }
  if (trimmedUrl) {
    if (/^data:/i.test(trimmedUrl)) {
      if (!/^data:[^,]*,/i.test(trimmedUrl)) {
        throw new Error(`Invalid data: URL for --url: ${opts.url}`);
      }
    } else if (/^file:/i.test(trimmedUrl)) {
      let fsUrlPath;
      try {
        const fu = new URL(trimmedUrl);
        if (fu.protocol !== "file:") throw new Error("not file");
        fsUrlPath = fileURLToPath(fu);
      } catch {
        throw new Error(`Invalid file:// URL for --url: ${opts.url}`);
      }
      if (!existsSync(fsUrlPath) || !statSync(fsUrlPath).isFile()) {
        throw new Error(`Runtime --url file target not found or not a file: ${fsUrlPath}`);
      }
    } else if (/^https?:/i.test(trimmedUrl)) {
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        throw new Error(`Invalid runtime --url (must start with http:// or https://): ${opts.url}`);
      }
      let u;
      try {
        u = new URL(trimmedUrl);
      } catch {
        throw new Error(`Invalid runtime --url: ${opts.url}`);
      }
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) {
        throw new Error(`Invalid runtime --url (hostname required): ${opts.url}`);
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl) && !/^[a-z]:[\\/]/i.test(trimmedUrl)) {
      throw new Error(`Unsupported runtime --url scheme: ${opts.url}`);
    } else {
      const absUrl = resolve(trimmedUrl);
      let uLst = null;
      try {
        uLst = lstatSync(absUrl);
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      }
      if (uLst?.isSymbolicLink() && !existsSync(absUrl)) {
        throw new Error(`Runtime --url target is a broken symlink: ${absUrl}`);
      }
      if (!existsSync(absUrl)) {
        throw new Error(`Runtime --url target not found: ${absUrl}`);
      }
      const stUrl = statSync(absUrl);
      if (stUrl.isDirectory()) {
        let hasHtml = false;
        for (const name of readdirSync(absUrl)) {
          if (!name.toLowerCase().endsWith(".html")) continue;
          try {
            if (statSync(join(absUrl, name)).isFile()) {
              hasHtml = true;
              break;
            }
          } catch {}
        }
        if (!hasHtml) {
          throw new Error(`Runtime --url directory contains no HTML files: ${absUrl}`);
        }
      } else if (!stUrl.isFile()) {
        throw new Error(`Runtime --url target is not a file or directory: ${absUrl}`);
      }
    }
  }
  if (trimmedStorybook) {
    let localSbCandidate = null;
    if (/^https?:/i.test(trimmedStorybook)) {
      if (!/^https?:\/\//i.test(trimmedStorybook)) {
        throw new Error(`Invalid --storybook URL (must start with http:// or https://): ${opts.storybook}`);
      }
      let su;
      try {
        su = new URL(trimmedStorybook);
      } catch {
        throw new Error(`Invalid --storybook URL: ${opts.storybook}`);
      }
      if ((su.protocol !== "http:" && su.protocol !== "https:") || !su.hostname) {
        throw new Error(`Invalid --storybook URL (hostname required): ${opts.storybook}`);
      }
    } else if (/^file:/i.test(trimmedStorybook)) {
      try {
        const su = new URL(trimmedStorybook);
        if (su.protocol !== "file:") throw new Error("not file");
        localSbCandidate = fileURLToPath(su);
      } catch {
        throw new Error(`Invalid file:// URL for --storybook: ${opts.storybook}`);
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedStorybook) && !/^[a-z]:[\\/]/i.test(trimmedStorybook)) {
      throw new Error(`Unsupported --storybook URL scheme: ${opts.storybook}`);
    } else {
      localSbCandidate = trimmedStorybook;
    }
    if (localSbCandidate !== null) {
      const absSb = resolve(localSbCandidate);
      let sbLst = null;
      try {
        sbLst = lstatSync(absSb);
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      }
      if (sbLst?.isSymbolicLink() && !existsSync(absSb)) {
        throw new Error(`Storybook path is a broken symlink: ${absSb}`);
      }
      if (!existsSync(absSb) || !statSync(absSb).isFile()) {
        throw new Error(`Storybook path not found or not a file: ${absSb}`);
      }
      let sbParsed;
      try {
        sbParsed = JSON.parse(readFileSync(absSb, "utf8"));
      } catch (err) {
        throw new Error(`Invalid Storybook JSON in ${absSb}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!isPlainObj(sbParsed) || (!isPlainObj(sbParsed.entries) && !isPlainObj(sbParsed.stories))) {
        throw new Error(`Invalid Storybook index in ${absSb}: expected JSON object with 'entries' or 'stories'.`);
      }
      const siblingIframe = join(dirname(absSb), "iframe.html");
      if (!existsSync(siblingIframe) || !statSync(siblingIframe).isFile()) {
        throw new Error(`Local Storybook index requires sibling iframe.html next to ${absSb}`);
      }
    }
  }
  if (trimmedCdp) {
    const rawCdp = trimmedCdp;
    if (/^\d+$/.test(rawCdp)) {
      const port = Number(rawCdp);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --cdp port: ${opts.cdp}`);
      }
    } else {
      let cu;
      try {
        cu = new URL(rawCdp);
      } catch {
        throw new Error(`Invalid --cdp endpoint: ${opts.cdp}`);
      }
      if (!["http:", "https:", "ws:", "wss:"].includes(cu.protocol) || !cu.hostname) {
        throw new Error(`Invalid --cdp endpoint (valid http/ws URL with hostname required): ${opts.cdp}`);
      }
    }
  }
  if (opts.axePath) {
    const absAxe = resolve(opts.axePath);
    if (!existsSync(absAxe) || !statSync(absAxe).isFile()) {
      throw new Error(`Axe script file not found: ${absAxe}`);
    }
  }
  if (opts.executablePath) {
    const absExe = resolve(opts.executablePath);
    if (!existsSync(absExe) || !statSync(absExe).isFile()) {
      throw new Error(`Browser executable file not found: ${absExe}`);
    }
  }
  if (opts.figmaPath) {
    const absFigma = resolve(opts.figmaPath);
    if (!existsSync(absFigma) || !statSync(absFigma).isFile()) {
      throw new Error(`Figma variables file not found: ${absFigma}`);
    }
    let figmaParsed;
    try {
      figmaParsed = JSON.parse(readFileSync(absFigma, "utf8"));
    } catch (err) {
      throw new Error(`Invalid Figma variables JSON in ${absFigma}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!figmaParsed || typeof figmaParsed !== "object" || Array.isArray(figmaParsed)) {
      throw new Error(`Invalid Figma variables JSON in ${absFigma}: expected a JSON object.`);
    }
  }
  if (opts.codeConnectDir) {
    const absCc = resolve(opts.codeConnectDir);
    if (!existsSync(absCc) || !statSync(absCc).isDirectory()) {
      throw new Error(`Code Connect directory not found: ${absCc}`);
    }
  }
  let tempRtDir = null;

  try {
    // 1. Step 0 Read-Only Recon (in-memory first so failed persona validation never writes partial artifacts)
    const reconRes = runSubScript("recon.mjs", [scopedDir]);
    if (reconRes.error || reconRes.status !== 0) {
      throw new Error(`recon failed: ${reconRes.error?.message || reconRes.stderr || reconRes.stdout || "unknown recon error"}`);
    }
    const recon = JSON.parse(reconRes.stdout);
    const personaLoaded = loadOrGeneratePersonas(target, recon);

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "recon.json"), JSON.stringify(recon, null, 2) + "\n", "utf8");
    }

    // 2. Token & Drift Audit
    const tokens = scanTarget(target, {
      includeDemos: Boolean(opts.includeDemos),
      scope: normScope || undefined,
      reportUnusedIgnores: Boolean(opts.reportUnusedIgnores),
    });
    const tokensPath = outDir ? join(outDir, "tokens.json") : null;
    if (tokensPath) writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + "\n", "utf8");

    // 3. Optional Runtime Audit
    let runtime = null;
    let runtimePassed = true;
    let runtimeFileForDiff = null;
    if (trimmedUrl || trimmedStorybook || trimmedCdp) {
      const rtPath = outDir ? join(outDir, "runtime.json") : null;
      if (rtPath) {
        if (existsSync(rtPath)) rmSync(rtPath, { force: true });
        runtimeFileForDiff = rtPath;
      }
      const rtArgs = buildRuntimeArgs({ ...opts, url: trimmedUrl, storybook: trimmedStorybook, cdp: trimmedCdp }, rtPath);
      const rtRes = runSubScript("audit-runtime.mjs", rtArgs);
      runtimePassed = rtRes.status === 0;
      if (rtRes.error) {
        throw new Error(`runtime audit failed: ${rtRes.error.message}`);
      }
      const rawRt = rtPath && existsSync(rtPath) ? readFileSync(rtPath, "utf8") : rtRes.stdout;
      if (rawRt && rawRt.trim().startsWith("{")) {
        try {
          runtime = JSON.parse(rawRt);
        } catch (err) {
          throw new Error(`runtime audit returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!runtimeFileForDiff && opts.figmaPath) {
          tempRtDir = mkdtempSync(join(tmpdir(), "dsaf-rt-diff-"));
          runtimeFileForDiff = join(tempRtDir, "runtime.json");
          writeFileSync(runtimeFileForDiff, rawRt, "utf8");
        }
      } else if (!runtimePassed) {
        throw new Error(`runtime audit failed: ${rtRes.stderr || rtRes.stdout || "unknown runtime error"}`);
      }
    }

    // 4. Optional 3-Vertex Figma Triangulation
    let figmaDiff = null;
    if (opts.figmaPath) {
      figmaDiff = compareVertices({
        figmaPath: opts.figmaPath,
        tokensArg: scopedDir,
        codeConnectDir: opts.codeConnectDir || null,
        runtimePath: runtimeFileForDiff,
        prefix: opts.prefix || null,
      });
      if (outDir) {
        writeFileSync(join(outDir, "figma-diff.json"), JSON.stringify(figmaDiff, null, 2) + "\n", "utf8");
        writeFileSync(join(outDir, "figma-diff.md"), renderFigmaMarkdown(figmaDiff), "utf8");
      }
    }

    // 5. Optional Regression Diff (pair completeness validated up front before writes)
    let regressionDiff = null;
    let regressionPassed = true;
    if (opts.baselinePath && opts.currentPath) {
      const diffArgs = ["--baseline", resolve(opts.baselinePath), "--current", resolve(opts.currentPath)];
      const diffOutPath = outDir ? join(outDir, "audit-diff.md") : null;
      if (diffOutPath) {
        if (existsSync(diffOutPath)) rmSync(diffOutPath, { force: true });
        diffArgs.push("--out", diffOutPath);
      }
      const diffRes = runSubScript("audit-diff.mjs", diffArgs);
      if (diffRes.error) {
        throw new Error(`audit-diff failed: ${diffRes.error.message}`);
      }
      if (diffRes.status !== 0 && diffRes.status !== 1) {
        const errDetail = String(diffRes.stderr || diffRes.stdout || `exit code ${diffRes.status ?? "null"}`).trim();
        throw new Error(`audit-diff failed fatally: ${errDetail}`);
      }
      regressionPassed = diffRes.status === 0;
      const diffOutput = [diffRes.stdout, diffRes.stderr]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .join("\n");
      regressionDiff = {
        passed: regressionPassed,
        output: diffOutput,
        reportFile: diffOutPath && existsSync(diffOutPath) ? diffOutPath : null,
      };
    }

    const hookTarget = scopedDir;
    const reportUnused = Boolean(opts.reportUnusedIgnores);
    const hookRes = checkTarget(hookTarget, {
      tier: "all",
      dsCss: normalizedDsCss,
      includeDemos: Boolean(opts.includeDemos),
      reportUnusedIgnores: reportUnused,
    });
    const relScopedFile = (f) => {
      const s = String(f || "");
      if (!s) return "";
      const abs = isAbsolute(s) ? s : resolve(hookTarget, s);
      return relative(target, abs).replace(/\\/g, "/");
    };
    const tokenActive = (tokens.ciFindings?.active || [])
      .filter((f) => reportUnused || f.ruleId !== "dsaf/unused-ignore")
      .map((f) => ({ ...f, file: relScopedFile(f.file) }));
    const tokenWaived = (tokens.ciFindings?.waived || []).map((w) => ({ ...w, file: relScopedFile(w.file) }));
    const hookWaived = (hookRes.waived || []).map((w) => ({ ...w, file: relScopedFile(w.file) }));

    const REJECTED_WAIVER_RULES = new Set(["dsaf/floor-waiver-rejected", "dsaf/waiver-reason-weak"]);
    const rejectedTarget = (f) => f.targetRuleId || f.message?.match(/'(dsaf\/[^']+)'/)?.[1] || "";
    const tokenHandledLocs = new Set([
      ...tokenWaived.map((w) => `${w.file}:${w.waiverLine || w.line}:${w.ruleId}`),
      ...tokenActive.filter((f) => REJECTED_WAIVER_RULES.has(f.ruleId)).map((f) => `${f.file}:${f.line}:${rejectedTarget(f)}`),
    ]);
    const hookActive = (hookRes.active || [])
      .filter((f) => reportUnused || f.ruleId !== "dsaf/unused-ignore")
      .map((hf) => ({ ...hf, file: relScopedFile(hf.file) }));
    const hookHandledLocs = new Set([
      ...hookWaived.map((w) => `${w.file}:${w.waiverLine || w.line}:${w.ruleId}`),
      ...hookActive.filter((f) => REJECTED_WAIVER_RULES.has(f.ruleId)).map((f) => `${f.file}:${f.line}:${rejectedTarget(f)}`),
    ]);

    const rawFindings = [];
    const tokenKeys = new Set();
    const dedupKey = (f) =>
      f.ruleId === "dsaf/unused-ignore" || REJECTED_WAIVER_RULES.has(f.ruleId)
        ? `${f.file}:${f.line}:${f.ruleId}:${rejectedTarget(f)}`
        : `${f.file}:${f.line}:${f.ruleId}`;
    for (const tf of tokenActive) {
      if (tf.ruleId === "dsaf/unused-ignore" && hookHandledLocs.has(`${tf.file}:${tf.line}:${tf.targetRuleId || ""}`)) {
        continue;
      }
      tokenKeys.add(dedupKey(tf));
      rawFindings.push(tf);
    }

    for (const hf of hookActive) {
      if (hf.ruleId === "dsaf/unused-ignore" && tokenHandledLocs.has(`${hf.file}:${hf.line}:${hf.targetRuleId || ""}`)) {
        continue;
      }
      const key = dedupKey(hf);
      if (tokenKeys.has(key)) continue;
      rawFindings.push(hf);
    }

    const waivedKeys = new Set();
    for (const w of [...tokenWaived, ...hookWaived]) {
      waivedKeys.add(`${w.file}:${w.line}:${w.ruleId}`);
    }

    if (runtime && !runtime.allPassed) {
      for (const rf of runtime.files || []) {
        if (rf.passed) continue;
        let rtFile = rf.file || "runtime";
        if (rf.sourcePath) {
          const relSrc = relative(target, rf.sourcePath).replace(/\\/g, "/");
          if (relSrc === "") rtFile = ".";
          else if (relSrc !== ".." && !relSrc.startsWith("../") && !isAbsolute(relSrc)) rtFile = relSrc;
        }
        rawFindings.push({
          ruleId: "dsaf/runtime-check-failed",
          tier: "floor",
          severity: "error",
          file: rtFile,
          line: 1,
          message: `Runtime verification failed (${rf.pageErrors?.length || 0} pageErrors, checks failed)`,
        });
      }
      if ((runtime.files || []).every((rf) => rf.passed)) {
        rawFindings.push({
          ruleId: "dsaf/runtime-check-failed",
          tier: "floor",
          severity: "error",
          file: "runtime",
          line: 1,
          message: "Runtime wiring or screenshot diff check failed",
        });
      }
    }
    if (regressionDiff && !regressionPassed) {
      const regMsg = String(regressionDiff.output || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      let regFile = "audit-diff.md";
      if (regressionDiff.reportFile) {
        const relReg = relative(target, regressionDiff.reportFile).replace(/\\/g, "/");
        if (relReg && relReg !== ".." && !relReg.startsWith("../") && !isAbsolute(relReg)) {
          regFile = relReg;
        }
      }
      rawFindings.push({
        ruleId: "dsaf/regression-detected",
        tier: "floor",
        severity: "error",
        file: regFile,
        line: 1,
        message: regMsg ? regMsg.slice(0, 240) : "Scorecard regression detected against baseline.",
      });
    }

    const ciFindingsList = [...rawFindings].sort((a, b) => {
      const ra = TIER_RANK[a.tier] ?? 9;
      const rb = TIER_RANK[b.tier] ?? 9;
      if (ra !== rb) return ra - rb;
      const fc = String(a.file || "").localeCompare(String(b.file || ""));
      if (fc !== 0) return fc;
      return (a.line || 0) - (b.line || 0);
    });

    const ciGate = {
      floor: ciFindingsList.filter((f) => f.tier === "floor").length,
      reflex: ciFindingsList.filter((f) => f.tier === "reflex").length,
      finish: ciFindingsList.filter((f) => f.tier === "finish").length,
      waived: waivedKeys.size,
      unusedIgnores: ciFindingsList.filter((f) => f.ruleId === "dsaf/unused-ignore").length,
    };
    if (absSarif) {
      mkdirSync(dirname(absSarif), { recursive: true });
      writeFileSync(
        absSarif,
        JSON.stringify(formatSarif(ciFindingsList, { toolVersion: CI_REPORT_VERSION, repoRoot: target }), null, 2) + "\n",
        "utf8"
      );
    }

    const rawFindingsWithPersonas = ciFindingsList.map((f) => ({
      ...f,
      personaIds: mapFindingToPersonas(f, personaLoaded.list),
    }));
    const personaSummaryItems = personaLoaded.list.map((p) => {
      const impacted = rawFindingsWithPersonas.filter((f) => f.personaIds.includes(p.id));
      return {
        id: p.id,
        name: p.name,
        axis: p.axis,
        viewport: p.viewport,
        source: p.source || "signal",
        impactedCount: impacted.length,
        findingRules: [...new Set(impacted.map((f) => f.ruleId))],
      };
    });

    const summary = {
      schema: "dsaf-audit/1",
      engine_version: PIPELINE_VERSION,
      generated: new Date().toISOString(),
      dataTier: "tier_0_readonly",
      target,
      passed: runtimePassed && regressionPassed && ciGate.floor === 0,
      ciGate,
      recon: {
        recommendedMode: recon.recommendedMode,
        topologyLabel: recon.topologyLabel,
        surfaceMode: recon.surfaceMode || "persuade",
        estimatedMaturity: recon.estimatedMaturity,
        filesScanned: recon.filesScanned,
        t2MockRequired: recon.t2MockRequired,
        frameworks: recon.stack?.frameworks || [],
        designSystemPackages: recon.stack?.designSystemPackages || [],
      },
      tokens: {
        target: tokens.target,
        filesScanned: tokens.filesScanned,
        dtcgTokenCount: tokens.dtcg?.tokenCount ?? 0,
        drift: tokens.drift,
      },
      personas: {
        count: personaSummaryItems.length,
        source: personaLoaded.source,
        items: personaSummaryItems,
      },
      runtime: runtime
        ? {
            allPassed: Boolean(runtime.allPassed),
            axeLoaded: Boolean(runtime.axeLoaded),
            filesCount: runtime.files?.length ?? 0,
            computedVarsSampled: runtime.files?.[0]?.computedVars ? Object.keys(runtime.files[0].computedVars).length : 0,
          }
        : null,
      figmaDiff: figmaDiff
        ? {
            summary: figmaDiff.summary,
            codeConnect: figmaDiff.codeConnect
              ? {
                  files: figmaDiff.codeConnect.codeConnectFiles,
                  mappedComponentsCount: figmaDiff.codeConnect.mappedComponentsCount,
                }
              : null,
            shippedSummary: figmaDiff.shippedSummary,
          }
        : null,
      regressionDiff,
      ciFindings: rawFindingsWithPersonas,
    };

    if (outDir) {
      writeFileSync(join(outDir, "audit-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
      writeFileSync(join(outDir, "audit-summary.md"), renderAuditMarkdown(summary), "utf8");
    }
    if (absHtml) {
      mkdirSync(dirname(absHtml), { recursive: true });
      writeFileSync(absHtml, renderHtmlReport(summary, { previewHref: opts.previewHref }), "utf8");
    }
    return summary;
  } finally {
    if (tempRtDir) rmSync(tempRtDir, { recursive: true, force: true });
  }
}

export function renderCheckSummary(summary) {
  const cg = summary.ciGate || { floor: 0, reflex: 0 };
  const r = summary.recon || {};
  const d = summary.tokens?.drift || {};
  const status = summary.passed ? "PASS" : "FAIL";
  const complianceStr = d.tokenCompliancePct == null ? "N/A" : `${d.tokenCompliancePct}%`;
  const lines = [
    `DSAF Check (${status}) — Mode ${r.recommendedMode || "P"} (${r.surfaceMode || "persuade"}) · Compliance: ${complianceStr}`,
    `Floor blockers: ${cg.floor} · Reflex warnings: ${cg.reflex} · Personas checked: ${summary.personas?.count ?? 0}`,
  ];
  const top = (summary.ciFindings || []).slice(0, 5);
  if (top.length > 0) {
    lines.push("Top findings:");
    for (const f of top) {
      const pTag = f.personaIds?.length ? ` [${f.personaIds.slice(0, 3).join(",")}]` : "";
      lines.push(`  - [${f.tier}] ${f.ruleId} at ${f.file}:${f.line || 1}${pTag}`);
    }
  }
  if (cg.floor > 0) {
    lines.push("Next: run `npx @zintaen/dsaf fix . --dry-run` to preview safe automatic fixes.");
  } else {
    lines.push("Next: run `npx @zintaen/dsaf audit . --html audit-report.html` for a shareable report.");
  }
  return lines.join("\n") + "\n";
}

export function renderAuditMarkdown(summary) {
  const d = summary.tokens.drift;
  const r = summary.recon;
  const cg = summary.ciGate || { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 };
  const escCell = escMdCell;
  const lines = [
    `# DSAF Unified Audit Summary (\`v${PIPELINE_VERSION}\` · Tier 0 Read-Only)`,
    "",
    `- **Target:** ${formatMdCodeSpan(summary.target, false)}`,
    `- **Topology / Surface / Maturity:** \`Mode ${escCell(r.recommendedMode)}\` (${escCell(r.topologyLabel)}) | Surface: ${formatMdCodeSpan(r.surfaceMode || "persuade", false)} | ${formatMdCodeSpan(r.estimatedMaturity, false)} | \`T2-Mock required: ${Boolean(r.t2MockRequired)}\``,
    `- **Pipeline Status:** ${summary.passed ? "PASS" : "FAIL"}`,
    `- **CI Gate & Waivers:** Floor=${cg.floor} · Reflex=${cg.reflex} · Finish=${cg.finish} · Waived=${cg.waived} · Unused Ignores=${cg.unusedIgnores}`,
    "",
    "## Codebase Tokens & Drift",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Scanned UI/Style Files | ${summary.tokens.filesScanned.uiAndStyle} (DTCG JSON: ${summary.tokens.filesScanned.tokenJson}, Demo skipped: ${d.demoFilesSkipped.length}, Server OG skipped: ${d.serverImageFiles.length}) |`,
    `| Color Token Compliance | ${d.tokenCompliancePct == null ? "N/A" : `${d.tokenCompliancePct}%`} (\`var()\`=${d.colorTokenRefs} vs hardcoded=${d.hardcodedColorHits}) |`,
    `| CSS Orphans | ${d.orphanCssVariableCount} (semantic=${d.semanticOrphanCount}, palette/scale=${d.paletteScaleUnusedCount}) |`,
    `| \`!important\` / Off-Grid Spacing | ${d.importantOverrides} / ${d.offGridSpacingHits} |`,
    `| Tailwind Arbitrary / Primitive | colors=${d.tailwind.arbitraryColors}, spacing=${d.tailwind.arbitrarySpacing}, primitive=${d.tailwind.primitiveColors} |`,
  ];
  if (d.recommendedScope) lines.push(`| Recommended App Scope | ${formatMdCodeSpan(d.recommendedScope, true)} |`);
  lines.push("");

  if (summary.personas?.items?.length > 0) {
    lines.push(
      `## Persona Impact Matrix (${summary.personas.count} Personas · ${formatMdCodeSpan(summary.personas.source, false)})`,
      "",
      "| ID | Persona | Axis | Impacted Findings | Rules |",
      "|---|---|---|---|---|"
    );
    for (const p of summary.personas.items) {
      lines.push(
        `| ${formatMdCodeSpan(p.id, true)} | ${escCell(p.name)} | ${escCell(p.axis)} | ${p.impactedCount} | ${p.findingRules.slice(0, 3).map((x) => formatMdCodeSpan(x, true)).join(", ") || "—"} |`
      );
    }
    lines.push("");
  }

  if (summary.runtime) {
    lines.push(
      "## Live Runtime Verification",
      "",
      `- **Status:** ${summary.runtime.allPassed ? "PASS" : "FAIL"} | Pages: ${summary.runtime.filesCount} | \`axe-core\`: ${summary.runtime.axeLoaded} | Computed Root Vars: ${summary.runtime.computedVarsSampled}`,
      ""
    );
  }
  if (summary.figmaDiff) {
    const fs = summary.figmaDiff.summary;
    const covStr = fs.triangulationCoveragePct == null ? "N/A" : `${fs.triangulationCoveragePct}%`;
    lines.push(
      "## 3-Vertex Figma Triangulation",
      "",
      `- **Coverage:** ${covStr} (${fs.matchedCount}/${fs.figmaVariables}) | Value Drift: ${fs.valueDriftCount} | Design-Only: ${fs.designOnlyCount} | Code-Only: ${fs.codeOnlyCount}`,
      ""
    );
  }
  if (summary.regressionDiff) {
    lines.push(
      "## No-Silent-Regression Diff",
      "",
      `- **Status:** ${summary.regressionDiff.passed ? "PASS" : "FAIL"}`,
      ""
    );
  }
  return lines.join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-pipeline-test-"));
  try {
    const repoDir = join(scratch, "demo-ds-app");
    const outDir = join(scratch, "audit-out");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "demo"), { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "demo-app", dependencies: { react: "^19.0.0", tailwindcss: "^4.0.0" } })
    );
    writeFileSync(
      join(repoDir, "src/tokens.css"),
      `:root { --brand-primary: #1d4ed8; --gray-100: #f3f4f6; }\n.cta { color: var(--brand-primary); }\n`
    );
    writeFileSync(
      join(repoDir, "demo/old-prototype.html"),
      `<div style="color:#ff00aa;padding:13px !important;">demo</div>`
    );
    const figmaPath = join(scratch, "figma.json");
    writeFileSync(figmaPath, JSON.stringify({ "brand/primary": "#1d4ed8" }));

    const sarifOut = join(outDir, "dsaf.sarif");
    const htmlOut = join(outDir, "report.html");
    const summary = runAuditPipeline({
      target: repoDir,
      figmaPath,
      outDir,
      sarifPath: sarifOut,
      htmlPath: htmlOut,
    });
    assert.equal(summary.schema, "dsaf-audit/1");
    assert.equal(summary.engine_version, "0.9.3");
    assert.equal(summary.passed, true);
    assert.ok(summary.personas.count >= 5);
    assert.equal(summary.tokens.drift.hardcodedColorHits, 0);
    assert.deepEqual(summary.tokens.drift.demoFilesSkipped, ["demo/old-prototype.html"]);
    assert.equal(summary.figmaDiff.summary.matchedCount, 1);
    assert.ok(existsSync(sarifOut));
    assert.ok(existsSync(htmlOut));
    assert.equal(JSON.parse(readFileSync(sarifOut, "utf8")).version, "2.1.0");
    assert.ok(existsSync(join(outDir, "audit-summary.json")));
    assert.ok(existsSync(join(outDir, "audit-summary.md")));
    assert.ok(existsSync(join(outDir, "recon.json")));
    assert.ok(existsSync(join(outDir, "tokens.json")));
    assert.ok(existsSync(join(outDir, "figma-diff.json")));

    // Floor findings from dsaf-hook (e.g. transition: all) + Reflex + severity sort must propagate into ciGate + SARIF + personas
    const floorApp = join(scratch, "floor-app");
    mkdirSync(join(floorApp, "src"), { recursive: true });
    writeFileSync(join(floorApp, "package.json"), JSON.stringify({ name: "floor-app", dependencies: { react: "^19.0.0" } }));
    writeFileSync(join(floorApp, "src/app.css"), `:root { --accent: #1d4ed8; }\n.warn { color: #ff00aa; }\n.card { transition: all 200ms ease; }\n`);
    const floorSummary = runAuditPipeline({ target: floorApp, outDir: join(scratch, "floor-out") });
    assert.equal(floorSummary.passed, false, "Active Floor rule must fail pipeline passed check");
    assert.ok(floorSummary.ciGate.floor >= 1, "Hook Floor finding must propagate into ciGate.floor");
    assert.equal(floorSummary.ciFindings[0].tier, "floor", "Floor findings must sort before Reflex findings");
    const trFinding = floorSummary.ciFindings.find((f) => f.ruleId === "dsaf/no-transition-all");
    assert.ok(trFinding && trFinding.personaIds.length >= 1, "Must map finding to impacted personas");
    assert.match(renderCheckSummary(floorSummary), /Floor blockers: 1/);

    // Round 2 regressions: --scope packages/web dedup + waived dedup + JSX off-grid waiver without unused-ignore leak + SARIF scoped URIs
    const scopedRepo = join(scratch, "scoped-repo");
    mkdirSync(join(scopedRepo, "packages/web/src"), { recursive: true });
    writeFileSync(join(scopedRepo, "package.json"), JSON.stringify({ name: "mono", private: true }));
    writeFileSync(
      join(scopedRepo, "packages/web/src/app.css"),
      [
        "/* dsaf-ignore dsaf/important-override -- third-party tooltip z-index */",
        ".tip { z-index: 99 !important; }",
        ".drift { color: #ff00aa; }",
      ].join("\n")
    );
    writeFileSync(
      join(scopedRepo, "packages/web/src/Card.tsx"),
      [
        "// dsaf-ignore dsaf/off-grid-spacing -- 1px optical icon alignment nudge",
        `export const Card = () => <div style={{ margin: "13px" }} />;`,
      ].join("\n")
    );
    const scopedSarif = join(scratch, "scoped.sarif");
    const scopedSum = runAuditPipeline({ target: scopedRepo, scope: "packages/web", sarifPath: scopedSarif });
    assert.equal(scopedSum.ciGate.reflex, 1, "Duplicate reflex findings across scanners under --scope must be deduplicated");
    assert.equal(scopedSum.ciGate.waived, 2, "Shared waived rule + JSX off-grid waiver must count once each (total 2)");
    assert.equal(scopedSum.ciGate.unusedIgnores, 0, "Disabled reportUnusedIgnores must never leak JSX off-grid waiver as unused-ignore");
    assert.equal(scopedSum.ciFindings[0].file, "packages/web/src/app.css");
    assert.equal(
      JSON.parse(readFileSync(scopedSarif, "utf8")).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      "packages/web/src/app.css"
    );
    const diffErrOut = join(scratch, "diff-err-out");
    assert.throws(
      () => runAuditPipeline({ target: repoDir, baselinePath: join(scratch, "missing-base.json"), currentPath: join(scratch, "missing-cur.json"), outDir: diffErrOut }),
      /--baseline file not found/
    );
    assert.equal(existsSync(diffErrOut), false, "Missing --baseline must abort before creating outDir");

    // Round 3 regression: multiple distinct DTCG Floor errors at line 1 must not self-deduplicate
    const multiDtcg = join(scratch, "multi-dtcg");
    mkdirSync(join(multiDtcg, "tokens"), { recursive: true });
    writeFileSync(
      join(multiDtcg, "tokens/color.json"),
      JSON.stringify({
        light: {
          surface: { default: { $type: "color", $value: "#ffffff" } },
          text: {
            primary: { $type: "color", $value: "#f8fafc" },
            muted: { $type: "color", $value: "#e2e8f0" },
          },
        },
        dark: {
          surface: { default: { $type: "color", $value: "#0b0f19" } },
          text: { primary: { $type: "color", $value: "#111827" } },
        },
      })
    );
    const multiSum = runAuditPipeline({ target: multiDtcg });
    assert.equal(multiSum.passed, false);
    assert.equal(multiSum.ciGate.floor, 3, "All 3 DTCG contrast failures on line 1 must be preserved");
    assert.equal(multiSum.ciFindings.filter((f) => f.ruleId === "dsaf/dtcg-contrast-fail").length, 3);

    // Round 5 regression: valid waiver + stale ignore on SAME line preserves unusedIgnores=1
    const sameLineDir = join(scratch, "same-line-unused");
    mkdirSync(join(sameLineDir, "src"), { recursive: true });
    writeFileSync(
      join(sameLineDir, "src/dual.css"),
      ".x { color: #ff00aa; } /* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback */ /* dsaf-ignore dsaf/off-grid-spacing -- stale unused comment */\n"
    );
    const sameLineSum = runAuditPipeline({ target: sameLineDir, reportUnusedIgnores: true });
    assert.equal(sameLineSum.ciGate.waived, 1);
    assert.equal(sameLineSum.ciGate.unusedIgnores, 1, "Stale ignore sharing a line with a handled waiver must stay unused");

    // Round 7 regressions: lone --baseline & malformed .dsaf/personas.custom.json validate BEFORE creating outDir/SARIF files
    const loneBaseOut = join(scratch, "r7-lone-base-out");
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, baselinePath: join(scratch, "b.json"), outDir: loneBaseOut }),
      /Both --baseline and --current are required/
    );
    assert.equal(existsSync(loneBaseOut), false, "Lone --baseline error must not create outDir");

    const badPersonasDir = join(scratch, "r7-bad-personas");
    mkdirSync(join(badPersonasDir, ".dsaf"), { recursive: true });
    mkdirSync(join(badPersonasDir, "src"), { recursive: true });
    writeFileSync(join(badPersonasDir, "src/app.css"), ".x { color: #ff00aa; }\n");
    writeFileSync(join(badPersonasDir, ".dsaf/personas.custom.json"), "{ invalid-json");
    const badPersonasOut = join(scratch, "r7-bad-personas-out");
    const badPersonasSarif = join(scratch, "r7-bad-personas.sarif");
    assert.throws(
      () => runAuditPipeline({ target: badPersonasDir, outDir: badPersonasOut, sarifPath: badPersonasSarif }),
      SyntaxError
    );
    assert.equal(existsSync(join(badPersonasOut, "tokens.json")), false, "Malformed personas.custom.json must not write partial tokens.json");
    assert.equal(existsSync(badPersonasSarif), false, "Malformed personas.custom.json must not write partial dsaf.sarif");

    // Round 8 regressions: nonexistent --scope / --figma / --code-connect must fail BEFORE creating outDir
    const r8BadScopeOut = join(scratch, "r8-bad-scope-out");
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, scope: "missing-sub", outDir: r8BadScopeOut }),
      /Audit scope not found/
    );
    assert.equal(existsSync(r8BadScopeOut), false, "Nonexistent --scope must not create outDir");

    const r8BadFigmaOut = join(scratch, "r8-bad-figma-out");
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, figmaPath: join(scratch, "missing-figma.json"), outDir: r8BadFigmaOut }),
      /Figma variables file not found/
    );
    assert.equal(existsSync(r8BadFigmaOut), false, "Nonexistent --figma must not create outDir");

    const r8BadCcOut = join(scratch, "r8-bad-cc-out");
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, codeConnectDir: join(scratch, "missing-cc"), outDir: r8BadCcOut }),
      /Code Connect directory not found/
    );
    assert.equal(existsSync(r8BadCcOut), false, "Nonexistent --code-connect must not create outDir");

    // Round 10 regression (R10-A1-03): --scope must reject parent traversal, escaping symlinks, and regular files before creating outDir
    const r10Outside = join(scratch, "r10-outside");
    mkdirSync(r10Outside, { recursive: true });
    symlinkSync(r10Outside, join(sameLineDir, "escape-link"));
    const r10EscOut = join(scratch, "r10-esc-out");
    assert.throws(
      () => runAuditPipeline({ target: join(sameLineDir, "src"), scope: "..", outDir: r10EscOut }),
      /escapes target root/
    );
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, scope: "escape-link", outDir: r10EscOut }),
      /escapes target root/
    );
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, scope: "src/dual.css", outDir: r10EscOut }),
      /not a directory/
    );
    assert.equal(existsSync(r10EscOut), false, "Rejected --scope must not create outDir");

    // Round 11 regression (R11-A1-01/04): --scope "/" must reject escape; intra-repo absolute path must resolve cleanly
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, scope: "/", outDir: r10EscOut }),
      /escapes target root/
    );
    assert.equal(existsSync(r10EscOut), false, "Rejected root --scope '/' must not create outDir");
    const r11AbsSum = runAuditPipeline({ target: scopedRepo, scope: join(scopedRepo, "packages/web") });
    assert.equal(r11AbsSum.ciGate.reflex, 1, "Intra-repo absolute --scope must scan packages/web identically to relative scope");
    assert.equal(r11AbsSum.ciGate.waived, 2, "Intra-repo absolute --scope must preserve waived count from relative scope");
    assert.equal(r11AbsSum.ciFindings[0].file, "packages/web/src/app.css");

    // Round 12 regression (R12-A1-01 & R12-A1-05): symlinked target + canonical realpath --scope must not emit ../ URIs; file target must throw clean directory error
    const r12RepoLink = join(scratch, "r12-repo-link");
    symlinkSync(scopedRepo, r12RepoLink);
    const r12RealWeb = realpathSync(join(scopedRepo, "packages/web"));
    const r12Out = join(scratch, "r12-out");
    const r12Sarif = join(r12Out, "r12.sarif");
    const r12Sum = runAuditPipeline({ target: r12RepoLink, scope: r12RealWeb, outDir: r12Out, sarifPath: r12Sarif });
    assert.equal(r12Sum.ciFindings[0].file, "packages/web/src/app.css");
    const r12SarifJson = JSON.parse(readFileSync(r12Sarif, "utf8"));
    assert.equal(
      r12SarifJson.runs[0].results.every((r) => !r.locations[0].physicalLocation.artifactLocation.uri.startsWith("../")),
      true,
      "SARIF artifact URIs must not contain ../ traversal under symlinked target + canonical scope"
    );
    const r12RootSum = runAuditPipeline({ target: r12RepoLink, scope: realpathSync(scopedRepo) });
    assert.equal(r12RootSum.ciFindings.every((f) => !f.file.startsWith("../")), true);
    assert.throws(() => runAuditPipeline({ target: join(scopedRepo, "packages/web/src/app.css") }), /not a directory/);

    // Round 15 regression (R15-A1-05): directory passed to --figma must fail before creating outDir
    const r15BadFigmaOut = join(scratch, "r15-bad-figma-out");
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, figmaPath: join(sameLineDir, "src"), outDir: r15BadFigmaOut }),
      /Figma variables file not found/
    );
    assert.equal(existsSync(r15BadFigmaOut), false, "Directory --figma must reject upfront without creating outDir");

    // Round 16 regression (R16-A1-02): empty/whitespace output paths and wrong-kind --out/--sarif/--html reject upfront
    for (const badVal of ["", "   "]) {
      assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: badVal }), /Parameter '--out' must be a non-empty path/);
      assert.throws(() => runAuditPipeline({ target: sameLineDir, sarifPath: badVal }), /Parameter '--sarif' must be a non-empty path/);
      assert.throws(() => runAuditPipeline({ target: sameLineDir, htmlPath: badVal }), /Parameter '--html' must be a non-empty path/);
    }
    const r16OutFile = join(scratch, "r16-not-dir.txt");
    writeFileSync(r16OutFile, "not a dir\n");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: r16OutFile }), /not a directory/);
    const r16NoOutDir = join(scratch, "r16-should-not-exist");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: r16NoOutDir, sarifPath: join(sameLineDir, "src") }), /is a directory/);
    assert.equal(existsSync(r16NoOutDir), false, "Directory --sarif must fail before creating outDir");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: r16NoOutDir, htmlPath: join(sameLineDir, "src") }), /is a directory/);
    assert.equal(existsSync(r16NoOutDir), false, "Directory --html must fail before creating outDir");
    const pipeSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [pipeSelfPath, sameLineDir, "--out", ""], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [pipeSelfPath, sameLineDir, "--sarif", "   "], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [pipeSelfPath, sameLineDir, "--html", ""], { encoding: "utf8" }).status, 2);

    // Round 17 regressions (R17-A1-07, R17-A1-08, R17-A1-12):
    const r17NoOut = join(scratch, "r17-no-out");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, scope: "   ", outDir: r17NoOut }), /non-empty/);
    assert.equal(existsSync(r17NoOut), false, "Whitespace --scope must fail before creating --out");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, dsCss: [join(scratch, "missing-ds.css")], outDir: r17NoOut }), /not found/);
    assert.equal(existsSync(r17NoOut), false, "Missing --ds-css must fail before writing recon.json/tokens.json");
    const r17BadFigmaJson = join(scratch, "r17-bad-figma.json");
    writeFileSync(r17BadFigmaJson, "{ broken-json");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, figmaPath: r17BadFigmaJson, outDir: r17NoOut }), /Invalid Figma variables JSON/);
    assert.equal(existsSync(r17NoOut), false, "Malformed --figma JSON must fail before writing recon.json/tokens.json");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, sarifPath: join(r16OutFile, "child.sarif"), outDir: r17NoOut }), /parent is not a directory/);
    assert.equal(existsSync(r17NoOut), false, "Regular-file parent for --sarif must fail before writing recon.json/tokens.json");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, htmlPath: join(r16OutFile, "child.html"), outDir: r17NoOut }), /parent is not a directory/);
    assert.equal(existsSync(r17NoOut), false, "Regular-file parent for --html must fail before writing recon.json/tokens.json");
    for (const cliBadFlag of [
      ["--figma", ""],
      ["--code-connect", ""],
      ["--baseline", "", "--current", join(scratch, "cur.json")],
      ["--ds-css", ""],
      ["--scope", "   "],
    ]) {
      assert.equal(spawnSync(process.execPath, [pipeSelfPath, sameLineDir, ...cliBadFlag], { encoding: "utf8" }).status, 2);
    }

    // Round 18 regressions (R18-A1-04, R18-A1-05, R18-A1-11):
    // 1. String dsCss passed programmatically must reach checkTarget()
    const r18DsDir = join(scratch, "r18-str-dscss");
    mkdirSync(join(r18DsDir, "src"), { recursive: true });
    writeFileSync(join(r18DsDir, "src/btn.css"), ".btn:focus { outline: none; }\n");
    const r18ExtCss = join(scratch, "r18-ext-ds.css");
    writeFileSync(r18ExtCss, ".btn:focus-within { box-shadow: 0 0 0 2px #000000; }\n");
    assert.equal(runAuditPipeline({ target: r18DsDir }).ciGate.floor, 1);
    assert.equal(runAuditPipeline({ target: r18DsDir, dsCss: r18ExtCss }).ciGate.floor, 0);

    // 2. [null] personas.json, --out/--sarif collision, invalid --url/--storybook/--axe fail upfront without writing partial files
    mkdirSync(join(r18DsDir, ".dsaf"), { recursive: true });
    writeFileSync(join(r18DsDir, ".dsaf/personas.json"), JSON.stringify({ personas: [null] }));
    const r18NoOut = join(scratch, "r18-no-partial-out");
    const r18NoSarif = join(scratch, "r18-no-partial.sarif");
    assert.throws(() => runAuditPipeline({ target: r18DsDir, outDir: r18NoOut, sarifPath: r18NoSarif }), /Invalid \.dsaf\/personas\.json/);
    assert.equal(existsSync(r18NoOut), false);
    assert.equal(existsSync(r18NoSarif), false);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: r18NoOut, sarifPath: r18NoOut }), /Output path collision/);
    assert.equal(existsSync(r18NoOut), false);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, url: "not-a-url", outDir: r18NoOut }), /not found/);
    assert.equal(existsSync(r18NoOut), false);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, storybook: join(scratch, "missing-sb"), outDir: r18NoOut }), /Storybook path not found/);
    assert.equal(existsSync(r18NoOut), false);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, url: "https://example.com", axePath: join(scratch, "missing-axe.js"), outDir: r18NoOut }), /Axe script file not found/);
    assert.equal(existsSync(r18NoOut), false);
    assert.equal(spawnSync(process.execPath, [pipeSelfPath, sameLineDir, sameLineDir], { encoding: "utf8" }).status, 2);

    // Round 19 regressions (R19-A1-03, R19-A1-04): non-array persona expectations & nested --sarif/--html collisions abort before partial writes
    writeFileSync(join(r18DsDir, ".dsaf/personas.json"), JSON.stringify({ personas: [{ id: "P01", name: "Ops", expectations: "clear labels" }] }));
    assert.throws(() => runAuditPipeline({ target: r18DsDir, outDir: r18NoOut, sarifPath: r18NoSarif }), /Invalid \.dsaf\/personas\.json/);
    assert.equal(existsSync(r18NoOut), false);
    assert.equal(existsSync(r18NoSarif), false);
    const r19Nest = join(scratch, "r19-sarif-html-col");
    assert.throws(() => runAuditPipeline({ target: sameLineDir, sarifPath: r19Nest, htmlPath: join(r19Nest, "report.html") }), /Output path collision/);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: join(r19Nest, "sub"), sarifPath: r19Nest }), /Output path collision/);
    assert.throws(() => runAuditPipeline({ target: sameLineDir, outDir: r19Nest, sarifPath: join(r19Nest, "audit-summary.json") }), /Output path collision/);
    assert.equal(existsSync(r19Nest), false);

    // Round 20 regressions (R20-A1-M2, R20-A4-L4): symlink-aliased output paths must not bypass collision checks & N/A compliance must omit '%'
    const r20Real = join(scratch, "r20-real");
    const r20Link = join(scratch, "r20-link");
    mkdirSync(r20Real, { recursive: true });
    symlinkSync(r20Real, r20Link);
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, outDir: r20Link, sarifPath: join(r20Real, "audit-summary.json") }),
      /Output path collision/
    );
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, sarifPath: join(r20Link, "rep.out"), htmlPath: join(r20Real, "rep.out") }),
      /Output path collision/
    );
    assert.throws(
      () => runAuditPipeline({ target: sameLineDir, outDir: join(r20Link, "sub"), sarifPath: join(r20Real, "sub") }),
      /Output path collision/
    );
    assert.equal(existsSync(join(r20Real, "sub")), false, "Symlink parent collision with non-existent child must abort before creating sub");
    assert.doesNotMatch(
      renderCheckSummary({
        passed: true,
        recon: { recommendedMode: "S", surfaceMode: "read" },
        tokens: { drift: { tokenCompliancePct: null } },
        ciGate: { floor: 0, reflex: 0 },
        personas: { count: 0 },
        ciFindings: [],
      }),
      /N\/A%/
    );

    // Round 21 regressions (R21-A1-L2, R21-A1-L3, R21-A4-M1, R21-A4-L2): Coverage N/A without '%', Usage runtime flags, and --format validation before --json
    const emptyFigmaPath = join(scratch, "r21-empty-figma.json");
    writeFileSync(emptyFigmaPath, "{}\n");
    const r21FigmaPipe = runAuditPipeline({ target: sameLineDir, figmaPath: emptyFigmaPath });
    assert.equal(r21FigmaPipe.figmaDiff.summary.triangulationCoveragePct, null);
    const r21Md = renderAuditMarkdown(r21FigmaPipe);
    assert.match(r21Md, /\*\*Coverage:\*\* N\/A \(0\/0\)/);
    assert.doesNotMatch(r21Md, /N\/A%/);
    const r21HelpOut = spawnSync(process.execPath, [pipeSelfPath, "--help"], { encoding: "utf8" });
    assert.equal(r21HelpOut.status, 0);
    for (const flg of ["--cdp", "--target", "--extended-viewports", "--no-hide-overlays"]) {
      assert.ok(r21HelpOut.stdout.includes(flg), `Usage must document ${flg}`);
    }
    assert.equal(
      spawnSync(process.execPath, [pipeSelfPath, sameLineDir, "--format", "bogus", "--json"], { encoding: "utf8" }).status,
      2
    );

    // Round 22 regression (R22-A1-07): directory at .dsaf/personas.json raises contextual error instead of raw EISDIR
    const r22PersonasDirRepo = join(scratch, "r22-personas-dir");
    mkdirSync(join(r22PersonasDirRepo, ".dsaf/personas.json"), { recursive: true });
    writeFileSync(join(r22PersonasDirRepo, "app.css"), ".ok { opacity: 1; }\n");
    assert.throws(
      () => runAuditPipeline({ target: r22PersonasDirRepo }),
      /expected a regular file/
    );

    // Round 23 regressions (#8, #46): nested outDir reserved collisions & pre-existing dir abort cleanly; case-insensitive --format
    const r23OutCol = join(scratch, "r23-out-col");
    const r23App = join(scratch, "r23-app");
    mkdirSync(r23App, { recursive: true });
    writeFileSync(join(r23App, "index.html"), "<html><body>ok</body></html>");
    assert.throws(() => runAuditPipeline({ target: r23App, outDir: r23OutCol, sarifPath: join(r23OutCol, "recon.json/sub.sarif") }));
    assert.equal(existsSync(join(r23OutCol, "recon.json")), false);
    const r23PreDir = join(scratch, "r23-out-predir");
    mkdirSync(join(r23PreDir, "tokens.json"), { recursive: true });
    assert.throws(() => runAuditPipeline({ target: r23App, outDir: r23PreDir }));
    assert.equal(existsSync(join(r23PreDir, "recon.json")), false);
    assert.equal(
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), r23App, "--format", "JSON"], { encoding: "utf8" }).status,
      0
    );

    // Round 24 regressions (A1 H1, A1 M5, A4 H2):
    // 1. Refuse symlinks on --out, --sarif, --html, --out/<reserved>, and symlinked reserved collision + upfront --storybook <dir> / --url <emptyDir> / --baseline <dir>
    const r24OutsideDir = join(scratch, "r24-outside");
    mkdirSync(r24OutsideDir, { recursive: true });
    const r24Secret = join(r24OutsideDir, "secret.txt");
    writeFileSync(r24Secret, "KEEP_ME\n");
    const r24OutLink = join(r23App, "out-sym");
    symlinkSync(r24OutsideDir, r24OutLink);
    assert.throws(() => runAuditPipeline({ target: r23App, outDir: r24OutLink }), /symlinked output path/i);
    assert.equal(existsSync(join(r24OutsideDir, "recon.json")), false);

    const r24SarifLink = join(r23App, "sym.sarif");
    symlinkSync(r24Secret, r24SarifLink);
    assert.throws(() => runAuditPipeline({ target: r23App, sarifPath: r24SarifLink }), /symlinked output path/i);
    assert.equal(readFileSync(r24Secret, "utf8"), "KEEP_ME\n");

    const r24OutWithSymFile = join(scratch, "r24-out-res-sym");
    mkdirSync(r24OutWithSymFile, { recursive: true });
    symlinkSync(r24Secret, join(r24OutWithSymFile, "recon.json"));
    assert.throws(() => runAuditPipeline({ target: r23App, outDir: r24OutWithSymFile }), /symlinked output path/i);
    assert.equal(readFileSync(r24Secret, "utf8"), "KEEP_ME\n");

    const r24ColDir = join(scratch, "r24-res-col");
    mkdirSync(r24ColDir, { recursive: true });
    const r24TargetSarif = join(scratch, "r24-col.sarif");
    writeFileSync(r24TargetSarif, "sarif\n");
    symlinkSync(r24TargetSarif, join(r24ColDir, "audit-summary.json"));
    assert.throws(
      () => runAuditPipeline({ target: r23App, outDir: r24ColDir, sarifPath: r24TargetSarif }),
      /Output path collision/
    );

    const r24SbDir = join(scratch, "r24-sb-dir");
    const r24EmptyUrlDir = join(scratch, "r24-empty-url-dir");
    const r24AbortOut = join(scratch, "r24-abort-out");
    mkdirSync(r24SbDir, { recursive: true });
    mkdirSync(r24EmptyUrlDir, { recursive: true });
    assert.throws(() => runAuditPipeline({ target: r23App, storybook: r24SbDir, outDir: r24AbortOut }), /not a file/);
    assert.throws(() => runAuditPipeline({ target: r23App, url: r24EmptyUrlDir, outDir: r24AbortOut }), /no HTML files/i);
    assert.throws(() => runAuditPipeline({ target: r23App, baselinePath: r24SbDir, currentPath: join(scratch, "r24-empty.json"), outDir: r24AbortOut }), /not found|not a regular file/);
    assert.equal(existsSync(r24AbortOut), false, "Failed upfront checks must not create --out");

    // Round 25 regressions (A1-M1..M2 upfront --baseline/--routes/--url/--storybook/--cdp validation before mkdirSync, A4-H1/L1)
    const r25PipeSelf = fileURLToPath(import.meta.url);
    const r25BadBase = join(scratch, "r25-bad-base.json");
    const r25GoodUsability = join(scratch, "r25-good-usab.json");
    const r25GoodVisual = join(scratch, "r25-good-vis.json");
    writeFileSync(r25BadBase, JSON.stringify({ schema: "wrong/1", type: "usability", criteria: { before: {} }, phases: { before: {} } }));
    writeFileSync(r25GoodUsability, JSON.stringify({ schema: "dsaf-scores/2", type: "usability", criteria: { before: {} }, phases: { before: {} } }));
    writeFileSync(r25GoodVisual, JSON.stringify({ schema: "dsaf-scores/2", type: "visual", criteria: { before: {} }, phases: { before: {} } }));
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--baseline", r25BadBase, "--current", r25GoodUsability, "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--baseline", r25GoodUsability, "--current", r25GoodVisual, "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--routes", "/a,,/b", "--url", "https://example.com", "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--routes", "/", "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--url", pathToFileURL(join(scratch, "nonexistent-dsaf-r25.html")).href, "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--url", "data:no-comma", "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--cdp", "http://", "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    const r25SbNoIframe = join(scratch, "r25-sb-no-iframe");
    mkdirSync(r25SbNoIframe, { recursive: true });
    writeFileSync(join(r25SbNoIframe, "index.json"), JSON.stringify({ entries: {} }));
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--storybook", join(r25SbNoIframe, "index.json"), "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    const r25SbBadSchema = join(scratch, "r25-sb-bad-schema");
    mkdirSync(r25SbBadSchema, { recursive: true });
    writeFileSync(join(r25SbBadSchema, "index.json"), "{}");
    writeFileSync(join(r25SbBadSchema, "iframe.html"), "<html></html>");
    assert.equal(
      spawnSync(process.execPath, [r25PipeSelf, r23App, "--storybook", join(r25SbBadSchema, "index.json"), "--out", r24AbortOut], { encoding: "utf8" }).status,
      2
    );
    assert.equal(existsSync(r24AbortOut), false, "R25 invalid upfront params must exit 2 without creating --out");

    const r25HtmlLink = join(r23App, "sym.html");
    symlinkSync(r24Secret, r25HtmlLink);
    assert.throws(() => runAuditPipeline({ target: r23App, htmlPath: r25HtmlLink }), /symlinked output path/i);
    assert.equal(readFileSync(r24Secret, "utf8"), "KEEP_ME\n");

    const r25PipeCliSym = join(scratch, "r25-pipe-cli-sym.mjs");
    symlinkSync(r25PipeSelf, r25PipeCliSym);
    assert.equal(spawnSync(process.execPath, [r25PipeCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 27 (A1-M1): --url <dir> accepts only top-level regular .html files (matching audit-runtime) and aborts before creating --out
    const r27SubHtml = join(scratch, "r27-sub-html");
    const r27HtmOnly = join(scratch, "r27-htm-only");
    const r27BrokenUrlDir = join(scratch, "r27-broken-html-dir");
    const r27AbortOut = join(scratch, "r27-abort-out");
    mkdirSync(join(r27SubHtml, "sub"), { recursive: true });
    mkdirSync(r27HtmOnly, { recursive: true });
    mkdirSync(r27BrokenUrlDir, { recursive: true });
    writeFileSync(join(r27SubHtml, "sub/index.html"), "<html><body>sub</body></html>");
    writeFileSync(join(r27HtmOnly, "index.htm"), "<html><body>htm</body></html>");
    symlinkSync(join(scratch, "missing-r27.html"), join(r27BrokenUrlDir, "broken.html"));
    for (const badUrlDir of [r27SubHtml, r27HtmOnly, r27BrokenUrlDir]) {
      const r27Run = spawnSync(
        process.execPath,
        [r25PipeSelf, r23App, "--url", badUrlDir, "--out", r27AbortOut],
        { encoding: "utf8" }
      );
      assert.equal(r27Run.status, 2, `R27 A1-M1: ${badUrlDir} must exit 2 before pipeline runs`);
    }
    assert.equal(existsSync(r27AbortOut), false, "R27 A1-M1: failed --url dir check must not create --out");

    // R30 (A1-L3): buildRuntimeArgs must place '--' before opts.url so leading-dash paths like '-page.html' parse cleanly in audit-runtime
    {
      const r30RtArgs = buildRuntimeArgs({ url: "-page.html", routes: "/a" }, null);
      assert.deepEqual(r30RtArgs.slice(-2), ["--", "-page.html"]);
      const r30Parsed = parseRuntimeArgs(r30RtArgs);
      assert.deepEqual(r30Parsed.targets, ["-page.html"]);
      assert.equal(r30Parsed.live, true);
    }

    // R31 (A1-L2, A1-L4): renderAuditMarkdown table escaping and whitespace-padded URL/Storybook handling
    {
      const r31Md = renderAuditMarkdown({
        target: r23App,
        passed: true,
        recon: { recommendedMode: "P", topologyLabel: "Product", surfaceMode: "operate", estimatedMaturity: "tier_2_baseline", t2MockRequired: false },
        tokens: {
          filesScanned: { uiAndStyle: 1, tokenJson: 0 },
          drift: {
            demoFilesSkipped: [],
            serverImageFiles: [],
            tokenCompliancePct: 100,
            colorTokenRefs: 1,
            hardcodedColorHits: 0,
            orphanCssVariableCount: 0,
            semanticOrphanCount: 0,
            paletteScaleUnusedCount: 0,
            importantOverrides: 0,
            offGridSpacingHits: 0,
            tailwind: { arbitraryColors: 0, arbitrarySpacing: 0, primitiveColors: 0 },
          },
        },
        ciGate: { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 },
        personas: {
          count: 1,
          source: "custom|source",
          items: [
            {
              id: "id|1`bad",
              name: "Alice | Admin\nLine2",
              axis: "kb|motion",
              impactedCount: 2,
              findingRules: ["dsaf/rule|a`1"],
            },
          ],
        },
      });
      const pRow = r31Md.split("\n").find((l) => l.startsWith("| ``id"));
      assert.ok(pRow, "R31 A1-L2: escaped persona row must exist");
      assert.ok(!/\n/.test(pRow));
      assert.equal(pRow.match(/(?<!\\)\|/g)?.length, 6, "R31 A1-L2: persona row must have exactly 6 unescaped pipes");
      assert.match(pRow, /\\\|/, "R31 A1-L2: pipes inside cells must be escaped");
      assert.ok(pRow.includes("``id\\|1`bad``") && pRow.includes("``dsaf/rule\\|a`1``"), "R31 A1-L2: backticks inside code cells must use CommonMark multi-backtick fences");

      const r31TrimArgs = buildRuntimeArgs(
        { url: "  https://example.com  ", storybook: "  https://example.com/index.json  ", cdp: " 9222 " },
        null
      );
      assert.deepEqual(r31TrimArgs, [
        "--live",
        "--cdp",
        "9222",
        "--storybook",
        "https://example.com/index.json",
        "--json",
        "--",
        "https://example.com",
      ]);
      assert.throws(() => runAuditPipeline({ target: r23App, url: "  ftp://bad.example  " }), /Unsupported runtime --url scheme/i);
      assert.throws(() => runAuditPipeline({ target: r23App, url: "  https://[::1  " }), /Invalid runtime --url/i);
      assert.throws(() => runAuditPipeline({ target: r23App, storybook: "  ftp://bad.example/index.json  " }), /Unsupported --storybook URL scheme/i);
      assert.throws(() => runAuditPipeline({ target: r23App, storybook: "  https://[::1/index.json  " }), /Invalid --storybook URL/i);
      assert.throws(() => runAuditPipeline({ target: r23App, url: "http:127.0.0.1:19999" }), /must start with http:\/\/ or https:\/\//i);
      assert.throws(() => runAuditPipeline({ target: r23App, storybook: "http:127.0.0.1:19999" }), /must start with http:\/\/ or https:\/\//i);

      // R33 A1-M2: reject escaping symlinks on .dsaf/personas.json and .dsaf/
      const r33ExtJson = join(scratch, "r33-secret-personas.json");
      writeFileSync(r33ExtJson, JSON.stringify({ personas: [{ id: "P01", name: "Leaked" }] }));
      const r33SymFileRepo = join(scratch, "r33-sym-personas-file");
      mkdirSync(join(r33SymFileRepo, ".dsaf"), { recursive: true });
      writeFileSync(join(r33SymFileRepo, "index.html"), "<main><h1>Ok</h1></main>\n");
      symlinkSync(r33ExtJson, join(r33SymFileRepo, ".dsaf/personas.json"));
      assert.throws(
        () => runAuditPipeline({ target: r33SymFileRepo }),
        /symlinks are not allowed|outside target root/i,
        "R33 A1-M2: escaping .dsaf/personas.json symlink must be rejected"
      );
      const r33ExtDir = join(scratch, "r33-ext-dsaf-dir");
      mkdirSync(r33ExtDir, { recursive: true });
      writeFileSync(join(r33ExtDir, "personas.json"), JSON.stringify({ personas: [{ id: "P01", name: "LeakedDir" }] }));
      const r33SymDirRepo = join(scratch, "r33-sym-personas-dir");
      mkdirSync(r33SymDirRepo, { recursive: true });
      writeFileSync(join(r33SymDirRepo, "index.html"), "<main><h1>Ok</h1></main>\n");
      symlinkSync(r33ExtDir, join(r33SymDirRepo, ".dsaf"));
      assert.throws(
        () => runAuditPipeline({ target: r33SymDirRepo }),
        /symlinks are not allowed|outside target root/i,
        "R33 A1-M2: symlinked .dsaf directory must be rejected"
      );

      // R37 (R36-A1-L1): invalid scorecard type or weight mismatch must fail upfront with exit 2 before mkdirSync
      const r37AbortOut = join(scratch, "r37-abort-out");
      const r37BogusA = join(scratch, "r37-bogus-a.json");
      const r37BogusB = join(scratch, "r37-bogus-b.json");
      writeFileSync(r37BogusA, JSON.stringify({ schema: "dsaf-scores/2", type: "bogus", criteria: { before: {} }, phases: { before: { total: 50 } } }));
      writeFileSync(r37BogusB, JSON.stringify({ schema: "dsaf-scores/2", type: "bogus", criteria: { before: {} }, phases: { before: { total: 60 } } }));
      assert.equal(
        spawnSync(process.execPath, [r25PipeSelf, r23App, "--baseline", r37BogusA, "--current", r37BogusB, "--out", r37AbortOut], { encoding: "utf8" }).status,
        2,
        "R36 A1-L1: bogus audit type on both scorecards must fail upfront with exit 2"
      );
      assert.equal(existsSync(r37AbortOut), false, "R36 A1-L1: bogus audit type must not create --out");

      const r37WeightA = join(scratch, "r37-weight-a.json");
      const r37WeightB = join(scratch, "r37-weight-b.json");
      writeFileSync(r37WeightA, JSON.stringify({ schema: "dsaf-scores/2", type: "usability", weights: { a: 0.5, b: 0.5 }, criteria: { before: {} }, phases: { before: { total: 50 } } }));
      writeFileSync(r37WeightB, JSON.stringify({ schema: "dsaf-scores/2", type: "usability", weights: { a: 0.8, b: 0.2 }, criteria: { before: {} }, phases: { before: { total: 60 } } }));
      assert.equal(
        spawnSync(process.execPath, [r25PipeSelf, r23App, "--baseline", r37WeightA, "--current", r37WeightB, "--out", r37AbortOut], { encoding: "utf8" }).status,
        2,
        "R36 A1-L1: mismatched pillar weights must fail upfront with exit 2"
      );
      assert.equal(existsSync(r37AbortOut), false, "R36 A1-L1: mismatched weights must not create --out");

      // Round 42 (R41-A3-M4 mapFindingToPersonas coverage for guardrail & waiver rules):
      const r42Personas = [
        { id: "P01", name: "Checkout Flow Visitor", axis: "layout", expectations: ["responsive layout"] },
        { id: "P02", name: "Design System Conformance Maintainer", axis: "conformance", expectations: ["token governance", "aria keyboard focus"] },
      ];
      for (const rId of [
        "dsaf/tailwind-arbitrary",
        "dsaf/semantic-orphan-var",
        "dsaf/floor-waiver-rejected",
        "dsaf/waiver-reason-weak",
        "dsaf/unused-ignore",
      ]) {
        assert.deepEqual(
          mapFindingToPersonas({ ruleId: rId }, r42Personas),
          ["P02"],
          `R42 A3-M4: ${rId} must map to conformance/governance persona rather than unrelated personas[0]`
        );
      }

      // Round 43 (R42-A3-H11 regression finding + SARIF, R42-A3-M12 scope recon & includeDemos, R42-A3-M13 mapFindingToPersonas, R42-A3-M14 routes/cdp validation):
      assert.throws(
        () => runAuditPipeline({ target: r23App, url: "index.html", routes: "/about" }),
        /--routes.*http/,
        "R43 A3-M14: --routes with non-http URL must reject upfront"
      );
      assert.throws(
        () => runAuditPipeline({ target: r23App, cdp: "9222", url: "https://example.com" }),
        /Cannot combine '--cdp'/,
        "R43 A3-M14: --cdp + --url must reject upfront"
      );
      assert.throws(
        () => runAuditPipeline({ target: r23App, cdp: "9222", storybook: "https://example.com/index.json" }),
        /Cannot combine '--cdp'/,
        "R43 A3-M14: --cdp + --storybook must reject upfront"
      );

      assert.deepEqual(
        mapFindingToPersonas({ ruleId: "dsaf/no-100vw" }, [{ id: "PX", name: "OnlyContrast", axis: "contrast", expectations: [] }]),
        [],
        "R43 A3-M13: unmatched custom persona list must return [] rather than personas[0]"
      );
      assert.deepEqual(
        mapFindingToPersonas({ ruleId: "dsaf/runtime-check-failed" }, [
          { id: "P_LOW", name: "Low Vision Reader", axis: "contrast", expectations: ["high contrast"] },
        ]),
        ["P_LOW"],
        "R43 A3-M13: runtime-check-failed must map to contrast/mobile/motion personas"
      );
      assert.deepEqual(
        mapFindingToPersonas({ ruleId: "dsaf/regression-detected" }, r42Personas),
        ["P02"],
        "R43 A3-M13: regression-detected must map to conformance/maintainer personas"
      );

      const r43PipeDir = join(scratch, "r43-pipe");
      mkdirSync(join(r43PipeDir, "src"), { recursive: true });
      mkdirSync(join(r43PipeDir, "demos"), { recursive: true });
      writeFileSync(join(r43PipeDir, "src/ok.css"), ".ok { color: var(--brand, #1d4ed8); }\n");
      writeFileSync(join(r43PipeDir, "demos/bad.css"), ".bad:focus { outline: none; }\n");
      const r43NoDemo = runAuditPipeline({ target: r43PipeDir });
      assert.equal(r43NoDemo.ciGate.floor, 0, "R43 A3-M12: default pipeline skips demos/");
      const r43WithDemo = runAuditPipeline({ target: r43PipeDir, includeDemos: true });
      assert.equal(r43WithDemo.ciGate.floor, 1, "R43 A3-M12: includeDemos reaches checkTarget and scans demos/");
      const r43ScopedRes = runAuditPipeline({ target: r43PipeDir, scope: "src" });
      assert.ok(r43ScopedRes.recon.filesScanned <= 2, "R43 A3-M12: recon runs within --scope");

      const r43RegBase = join(scratch, "r43-reg-base.json");
      const r43RegCur = join(scratch, "r43-reg-cur.json");
      const r43RegSarif = join(scratch, "r43-reg.sarif.json");
      const r43RegHtml = join(scratch, "r43-reg.html");
      const mkSc = (s) => ({
        schema: "dsaf-scores/2",
        type: "visual",
        criteria: { before: Object.fromEntries(Array.from({ length: 14 }, (_, k) => [`V${String(k + 1).padStart(2, "0")}`, { score: s, findings: s < 2 ? ["F-1"] : [] }])) },
        phases: { before: { total: s === 2 ? 100 : 0 } },
      });
      writeFileSync(r43RegBase, JSON.stringify(mkSc(2)));
      writeFileSync(r43RegCur, JSON.stringify(mkSc(0)));
      const r43RegPipe = runAuditPipeline({
        target: r43PipeDir,
        baselinePath: r43RegBase,
        currentPath: r43RegCur,
        sarifPath: r43RegSarif,
        htmlPath: r43RegHtml,
      });
      assert.equal(r43RegPipe.passed, false);
      assert.ok(r43RegPipe.ciGate.floor >= 1, "R43 A3-H11: regression must increment ciGate.floor");
      assert.ok(r43RegPipe.ciFindings.some((f) => f.ruleId === "dsaf/regression-detected" && f.tier === "floor"));
      const r43SarifDoc = JSON.parse(readFileSync(r43RegSarif, "utf8"));
      assert.ok(r43SarifDoc.runs[0].results.some((r) => r.ruleId === "dsaf/regression-detected"));
      assert.match(readFileSync(r43RegHtml, "utf8"), /Regression Diff/);

      // Round 44 (R43-A3-M7 external --out SARIF URI, R43-A3-L8 diff operational error, R43-A3-L9 Windows drive paths, R43-A3-L10 stdout flag conflicts):
      const r44ExtOut = join(scratch, "r44-external-out");
      const r44ExtSarif = join(scratch, "r44-ext-reg.sarif.json");
      const r44ExtPipe = runAuditPipeline({
        target: r43PipeDir,
        outDir: r44ExtOut,
        baselinePath: r43RegBase,
        currentPath: r43RegCur,
        sarifPath: r44ExtSarif,
      });
      const r44RegFinding = r44ExtPipe.ciFindings.find((f) => f.ruleId === "dsaf/regression-detected");
      assert.equal(r44RegFinding?.file, "audit-diff.md", "R44 A3-M7: regression finding must not emit escaping '../' URI when --out is outside target");
      const r44ExtSarifDoc = JSON.parse(readFileSync(r44ExtSarif, "utf8"));
      const r44SarifUri = r44ExtSarifDoc.runs[0].results.find((r) => r.ruleId === "dsaf/regression-detected")?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      assert.ok(r44SarifUri && !r44SarifUri.startsWith(".."), "R44 A3-M7: SARIF URI must not escape target root");

      const r44BadJson = join(scratch, "r44-bad-base.json");
      writeFileSync(r44BadJson, "{ invalid-json");
      assert.throws(
        () => runAuditPipeline({ target: r43PipeDir, baselinePath: r44BadJson, currentPath: r43RegCur }),
        /invalid JSON/i,
        "R44 A3-L8: malformed baseline JSON must throw fatal error rather than logging dsaf/regression-detected"
      );
      const r44MismatchBase = join(scratch, "r44-mismatch-base.json");
      writeFileSync(r44MismatchBase, JSON.stringify({ ...mkSc(2), type: "usability" }));
      assert.throws(
        () => runAuditPipeline({ target: r43PipeDir, baselinePath: r44MismatchBase, currentPath: r43RegCur }),
        /differing audit types/i,
        "R44 A3-L8: mismatched scorecard audit type must throw fatal error rather than logging dsaf/regression-detected"
      );

      assert.throws(
        () => runAuditPipeline({ target: r43PipeDir, url: "C:\\missing-r44\\index.html" }),
        /not found/i,
        "R44 A3-L9: Windows drive-letter --url must not fail as unsupported URL scheme"
      );
      assert.throws(
        () => runAuditPipeline({ target: r43PipeDir, storybook: "D:/missing-r44/index.json" }),
        /not found/i,
        "R44 A3-L9: Windows drive-letter --storybook must not fail as unsupported URL scheme"
      );
      assert.throws(
        () => runAuditPipeline({ target: r43PipeDir, storybook: pathToFileURL(join(scratch, "missing-r45-sb/index.json")).href }),
        /not found/i,
        "R45 A3-M4: file:// URL for --storybook must resolve to path check rather than unsupported scheme"
      );

      const pipeSelfPath = fileURLToPath(import.meta.url);
      for (const badFlags of [
        ["--format", "sarif", "--json"],
        ["--github", "--compact"],
        ["--format", "json", "--github"],
      ]) {
        const resConflict = spawnSync(process.execPath, [pipeSelfPath, r43PipeDir, ...badFlags], { encoding: "utf8" });
        assert.equal(resConflict.status, 2, `R44 A3-L10: conflicting flags (${badFlags.join(" ")}) must exit 2`);
      }
    }

    console.log("AUDIT_PIPELINE_SELF_TEST_PASSED (recon + scoped tokens + personas + html + figma-diff + SARIF)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      routes: { type: "string" },
      cdp: { type: "string" },
      target: { type: "string" },
      "extended-viewports": { type: "boolean", default: false },
      "no-hide-overlays": { type: "boolean", default: false },
      figma: { type: "string" },
      "code-connect": { type: "string" },
      prefix: { type: "string" },
      storybook: { type: "string" },
      baseline: { type: "string" },
      current: { type: "string" },
      axe: { type: "string" },
      "executable-path": { type: "string" },
      "theme-toggle": { type: "string" },
      "ds-css": { type: "string", multiple: true, default: [] },
      "include-demos": { type: "boolean", default: false },
      "report-unused-ignores": { type: "boolean", default: false },
      sarif: { type: "string" },
      github: { type: "boolean", default: false },
      scope: { type: "string" },
      out: { type: "string" },
      html: { type: "string" },
      "preview-href": { type: "string" },
      compact: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      format: { type: "string" },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-pipeline.mjs <target> [--url <url>] [--routes /,/about] [--cdp <port|url>] [--target <match>] [--extended-viewports] [--no-hide-overlays] [--figma <vars.json>] [--code-connect <dir>] [--prefix <str>] [--storybook <url|index.json>] [--baseline <a.json> --current <b.json>] [--axe <path>] [--executable-path <path>] [--theme-toggle <sel>] [--ds-css <path>] [--include-demos] [--scope <subdir>] [--sarif <file>] [--html <report.html> [--preview-href <href>]] [--compact] [--json] [--github] [--report-unused-ignores] [--out <dir>] [--format markdown|json|sarif] [--self-test] [--help]"
    );
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  const selectedOutputs = [];
  if (values.format !== undefined) selectedOutputs.push(`--format=${values.format}`);
  if (values.json) selectedOutputs.push("--json");
  if (values.github) selectedOutputs.push("--github");
  if (values.compact) selectedOutputs.push("--compact");
  if (selectedOutputs.length > 1) {
    console.error(`Error: conflicting output format flags (${selectedOutputs.join(", ")}). Choose only one stdout format.`);
    process.exit(2);
  }
  const cleanFormat = String(values.format ?? "markdown").toLowerCase();
  if (!["markdown", "json", "sarif"].includes(cleanFormat)) {
    console.error(`Unsupported --format '${values.format}'. Expected markdown|json|sarif.`);
    process.exit(2);
  }
  const format = values.json ? "json" : cleanFormat;

  if (positionals.length > 1) {
    console.error(`Error: unexpected extra positional argument '${positionals[1]}'. Pass a single <target> directory.`);
    process.exit(2);
  }
  const target = positionals[0];
  if (!target || target.trim().length === 0) {
    console.error("Error: non-empty <target> directory is required unless --self-test is passed.");
    process.exit(2);
  }

  const summary = runAuditPipeline({
    target,
    url: values.url,
    routes: values.routes,
    cdp: values.cdp,
    cdpTarget: values.target,
    extendedViewports: values["extended-viewports"],
    noHideOverlays: values["no-hide-overlays"],
    figmaPath: values.figma,
    codeConnectDir: values["code-connect"],
    prefix: values.prefix,
    storybook: values.storybook,
    baselinePath: values.baseline,
    currentPath: values.current,
    axePath: values.axe,
    executablePath: values["executable-path"],
    themeToggle: values["theme-toggle"],
    dsCss: values["ds-css"],
    includeDemos: values["include-demos"],
    reportUnusedIgnores: values["report-unused-ignores"],
    sarifPath: values.sarif,
    htmlPath: values.html,
    previewHref: values["preview-href"],
    scope: values.scope,
    outDir: values.out,
  });

  if (format === "sarif") {
    const sarifDoc = formatSarif(summary.ciFindings || [], { toolVersion: CI_REPORT_VERSION, repoRoot: summary.target });
    process.stdout.write(JSON.stringify(sarifDoc, null, 2) + "\n");
  } else if (format === "json") {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else if (values.github) {
    const ann = formatGithubAnnotations(summary.ciFindings || [], { repoRoot: summary.target });
    if (ann) process.stdout.write(ann + "\n");
  } else if (values.compact) {
    process.stdout.write(renderCheckSummary(summary));
  } else {
    process.stdout.write(renderAuditMarkdown(summary));
  }
  process.exit(summary.passed ? 0 : 1);
}

if (isDirectCliEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

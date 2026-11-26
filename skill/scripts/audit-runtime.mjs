#!/usr/bin/env node
/**
 * DSAF v0.5.0 — Runtime Browser, APCA-W3, Keyboard, CDP, RTL & N-of-1 Verifier.
 * Pure-JS self-tests run with zero dependencies. Live browser/draft audits lazily
 * require Playwright (`playwright` or `@playwright/test`) and Chromium, or attach via `--cdp`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const require = createRequire(import.meta.url);

/* ---------- Zero-Dep PNG RGBA Decoder & Pixel Diff ---------- */

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePngRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    throw new Error("Invalid PNG buffer");
  }
  const sig = buf.subarray(0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("Unsupported image format: expected PNG header");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buf.length) break;
    if (type === "IHDR" && len >= 13) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8) {
    throw new Error(`Unsupported PNG geometry (${width}x${height}, bitDepth=${bitDepth})`);
  }
  const bppMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (!bpp) {
    throw new Error(`Unsupported PNG colorType=${colorType}; expected 0/2/4/6`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const recon = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * rowBytes;
    const prevOut = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const val = raw[rowIn + x];
      const a = x >= bpp ? recon[rowOut + x - bpp] : 0;
      const b = y > 0 ? recon[prevOut + x] : 0;
      const c = y > 0 && x >= bpp ? recon[prevOut + x - bpp] : 0;
      let out = val;
      if (filter === 1) out = (val + a) & 0xff;
      else if (filter === 2) out = (val + b) & 0xff;
      else if (filter === 3) out = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) out = (val + paethPredictor(a, b, c)) & 0xff;
      recon[rowOut + x] = out;
    }
  }

  if (colorType === 6) return { width, height, rgba: recon };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 2) {
      rgba[o] = recon[i * 3];
      rgba[o + 1] = recon[i * 3 + 1];
      rgba[o + 2] = recon[i * 3 + 2];
      rgba[o + 3] = 255;
    } else if (colorType === 4) {
      rgba[o] = recon[i * 2];
      rgba[o + 1] = recon[i * 2];
      rgba[o + 2] = recon[i * 2];
      rgba[o + 3] = recon[i * 2 + 1];
    } else {
      rgba[o] = recon[i];
      rgba[o + 1] = recon[i];
      rgba[o + 2] = recon[i];
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function computeImagePixelDiffRatio(imgA, imgB, channelThreshold = 16) {
  if (!imgA || !imgB || imgA.width !== imgB.width || imgA.height !== imgB.height) {
    const total = Math.max((imgA?.width || 0) * (imgA?.height || 0), (imgB?.width || 0) * (imgB?.height || 0));
    return { totalPixels: total, mismatchedPixels: total, diffPct: 100, sizeMismatch: true };
  }
  const totalPixels = imgA.width * imgA.height;
  let mismatchedPixels = 0;
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const dr = Math.abs(imgA.rgba[i] - imgB.rgba[i]);
    const dg = Math.abs(imgA.rgba[i + 1] - imgB.rgba[i + 1]);
    const db = Math.abs(imgA.rgba[i + 2] - imgB.rgba[i + 2]);
    const da = Math.abs(imgA.rgba[i + 3] - imgB.rgba[i + 3]);
    if (Math.max(dr, dg, db, da) > channelThreshold) {
      mismatchedPixels++;
    }
  }
  const diffPct = totalPixels > 0 ? Number(((mismatchedPixels / totalPixels) * 100).toFixed(3)) : 0;
  return { totalPixels, mismatchedPixels, diffPct, sizeMismatch: false };
}

/* ---------- Published APCA-W3 0.1.9 & WCAG 2.2 Pure Math ---------- */

export function wcagLuminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function wcagContrast(rgb1, rgb2) {
  const l1 = wcagLuminance(rgb1);
  const l2 = wcagLuminance(rgb2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function apcaContrast(textRgb, bgRgb) {
  const k = {
    mainTRC: 2.4,
    Rco: 0.2126729,
    Gco: 0.7151522,
    Bco: 0.072175,
    normBG: 0.56,
    normTXT: 0.57,
    revTXT: 0.62,
    revBG: 0.65,
    blkThrs: 0.022,
    blkClmp: 1.414,
    scaleBoW: 1.14,
    loBoWoffset: 0.027,
    scaleWoB: 1.14,
    loWoBoffset: 0.027,
    loClip: 0.1,
    deltaYmin: 0.0005,
  };
  const y = ([r, g, b]) => {
    let val = Math.pow(r / 255, k.mainTRC) * k.Rco + Math.pow(g / 255, k.mainTRC) * k.Gco + Math.pow(b / 255, k.mainTRC) * k.Bco;
    if (val < k.blkThrs) val += Math.pow(k.blkThrs - val, k.blkClmp);
    return val;
  };
  const yT = y(textRgb);
  const yB = y(bgRgb);
  if (Math.abs(yT - yB) < k.deltaYmin) return 0;
  let out = 0;
  if (yB > yT) {
    const sapc = (Math.pow(yB, k.normBG) - Math.pow(yT, k.normTXT)) * k.scaleBoW;
    out = sapc < k.loClip ? 0 : sapc < k.loBoWoffset ? sapc - (sapc * k.loBoWoffset) / k.loClip : sapc - k.loBoWoffset;
  } else {
    const sapc = (Math.pow(yB, k.revBG) - Math.pow(yT, k.revTXT)) * k.scaleWoB;
    out = sapc > -k.loClip ? 0 : sapc > -k.loWoBoffset ? sapc - (sapc * k.loWoBoffset) / k.loClip : sapc + k.loWoBoffset;
  }
  return Math.round(out * 100);
}

/**
 * Group rendered DOM elements into N-of-1 visual signature buckets
 * (2px quantized height + border-radius + font-size + border-width).
 */
export function clusterSignatures(items) {
  const map = new Map();
  for (const it of items) {
    const h = Math.floor(it.height / 2) * 2;
    const rad = Math.round(it.radius);
    const fs = Math.round(it.fontSize);
    const bw = Math.round(it.borderWidth);
    const sig = `h=${h}px|r=${rad}px|fs=${fs}px|bw=${bw}px`;
    if (!map.has(sig)) map.set(sig, { signature: sig, count: 0, sample: it.label || "" });
    map.get(sig).count += 1;
  }
  const clusters = [...map.values()].sort((a, b) => b.count - a.count);
  return { totalRendered: items.length, distinctSignatures: clusters.length, clusters: clusters.slice(0, 10) };
}

export function summarizeKeyboardAccessibility(controls) {
  const positiveTabindex = controls
    .filter((c) => Number(c.tabindex) > 0)
    .map((c) => ({ tag: c.tag, label: c.label, tabindex: c.tabindex }));
  const unnamedInteractive = controls
    .filter((c) => !c.accessibleName)
    .map((c) => ({ tag: c.tag, role: c.role || c.tag }));
  return {
    tabbableCount: controls.length,
    positiveTabindexCount: positiveTabindex.length,
    positiveTabindexSample: positiveTabindex.slice(0, 8),
    unnamedInteractiveCount: unnamedInteractive.length,
    unnamedSample: unnamedInteractive.slice(0, 8),
  };
}

export function computeEffectiveHitArea(rect, beforeStyle, afterStyle) {
  let maxW = Number(rect?.width || 0);
  let maxH = Number(rect?.height || 0);
  for (const ps of [beforeStyle, afterStyle]) {
    if (!ps) continue;
    const c = String(ps.content || "");
    if (!c || c === "none" || c === "normal") continue;
    if (String(ps.position || "") !== "absolute") continue;
    const pw = Math.max(parseFloat(ps.width) || 0, parseFloat(ps.minWidth) || 0);
    const ph = Math.max(parseFloat(ps.height) || 0, parseFloat(ps.minHeight) || 0);
    const insetNegW =
      (parseFloat(ps.left) < 0 ? Math.abs(parseFloat(ps.left)) : 0) +
      (parseFloat(ps.right) < 0 ? Math.abs(parseFloat(ps.right)) : 0);
    const insetNegH =
      (parseFloat(ps.top) < 0 ? Math.abs(parseFloat(ps.top)) : 0) +
      (parseFloat(ps.bottom) < 0 ? Math.abs(parseFloat(ps.bottom)) : 0);
    const effW = Math.max(pw, rect?.width && insetNegW ? Number(rect.width) + insetNegW : 0);
    const effH = Math.max(ph, rect?.height && insetNegH ? Number(rect.height) + insetNegH : 0);
    if (effW > maxW) maxW = effW;
    if (effH > maxH) maxH = effH;
  }
  return { width: Number(maxW.toFixed(1)), height: Number(maxH.toFixed(1)) };
}

export function evaluateLayoutHealth({
  isMobile = false,
  viewportHeight = 844,
  headerHeight = 0,
  badges = [],
  tables = [],
} = {}) {
  const maxHeaderPx = Math.max(220, Math.round(Number(viewportHeight || 844) * 0.32));
  const headerBloat =
    isMobile && headerHeight > maxHeaderPx
      ? { height: Math.round(headerHeight), viewportHeight: Math.round(viewportHeight), ratioPct: Math.round((headerHeight / Math.max(1, viewportHeight)) * 100) }
      : null;

  const crushedBadges = [];
  for (const b of badges || []) {
    const h = Number(b.h || 0);
    const lh = Number(b.lineHeightPx || 18);
    if (h > 36 && h > lh * 1.7) {
      crushedBadges.push({ tag: b.tag || "span", text: String(b.text || "").slice(0, 32), w: Math.round(b.w || 0), h: Math.round(h) });
    }
  }

  const clippedTables = [];
  if (isMobile) {
    for (const t of tables || []) {
      if (t.allowScroll) continue;
      if (Number(t.overflowPx || 0) > 24) {
        clippedTables.push({ headers: String(t.headers || "").slice(0, 48), tableW: Math.round(t.tableW || 0), containerW: Math.round(t.containerW || 0), overflowPx: Math.round(t.overflowPx || 0) });
      }
    }
  }

  return { headerBloat, crushedBadges, clippedTables };
}

export function expandRouteTargets(targets, routesCsv) {
  if (!routesCsv) return targets;
  const routes = String(routesCsv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (routes.length === 0) return targets;
  const out = [];
  for (const t of targets) {
    if (/^https?:\/\//i.test(t)) {
      for (const r of routes) out.push(new URL(r, t).href);
    } else {
      out.push(t);
    }
  }
  return out;
}

export const OVERLAY_SELECTORS = [
  "#onetrust-banner-sdk",
  ".onetrust-pc-dark-filter",
  "#CybotCookiebotDialog",
  ".cc-window",
  "[data-consent-banner]",
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '[data-testid*="cookie" i]',
  '[data-testid*="consent" i]',
  '[class*="consent" i]',
  '[id*="consent" i]',
  '[role="dialog"][aria-label*="privacy" i]',
  '[id*="cookie-banner" i]',
];

export function normalizeCdpEndpoint(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`;
  return s;
}

export function buildViewportMatrix(extended = false) {
  const base = [
    { name: "desktop-1440-dark", width: 1440, height: 900, theme: "dark", isMobile: false },
    { name: "desktop-1440-light", width: 1440, height: 900, theme: "light", isMobile: false },
    { name: "zoom-720-dark", width: 720, height: 450, theme: "dark", isMobile: false },
    { name: "mobile-375-dark", width: 375, height: 812, theme: "dark", isMobile: true },
    { name: "mobile-375-light", width: 375, height: 812, theme: "light", isMobile: true },
  ];
  if (!extended) return base;
  return [
    ...base,
    { name: "mobile-320-light", width: 320, height: 640, theme: "light", isMobile: true },
    { name: "wide-1920-light", width: 1920, height: 1080, theme: "light", isMobile: false },
  ];
}

const RTL_LANG_RE = /^(?:ar|he|fa|ur|ps|ckb|yi|ug|sd|dv)(?:-|$)/i;

export function evaluateRtlDiagnostics(snapshot) {
  const htmlDir = String(snapshot?.htmlDir || "").trim().toLowerCase();
  const htmlLang = String(snapshot?.htmlLang || "").trim();
  const missingDirRtl = Boolean(htmlLang && RTL_LANG_RE.test(htmlLang) && htmlDir !== "rtl");
  const applicable = htmlDir === "rtl" || missingDirRtl;
  if (!applicable) {
    return {
      applicable: false,
      htmlDir,
      htmlLang,
      missingDirRtl: false,
      arabicLetterSpacingViolations: 0,
      physicalLeftAlignViolations: 0,
      samples: [],
      passed: true,
    };
  }
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const spacingBad = elements.filter((e) => e.hasRtlScriptText && Math.abs(Number(e.letterSpacingPx) || 0) > 0.05);
  const leftAlignBad = htmlDir === "rtl" ? elements.filter((e) => e.hasRtlScriptText && String(e.textAlign || "").toLowerCase() === "left") : [];
  return {
    applicable: true,
    htmlDir,
    htmlLang,
    missingDirRtl,
    arabicLetterSpacingViolations: spacingBad.length,
    physicalLeftAlignViolations: leftAlignBad.length,
    samples: spacingBad.slice(0, 8),
    passed: !missingDirRtl && spacingBad.length === 0,
  };
}

export function isMobileTargetClipped(rect, viewportWidth, horizontalScrollers = []) {
  const inHorizontalScroller = horizontalScrollers.some(
    (s) => s.left >= -0.5 && s.right <= viewportWidth + 0.5
  );
  if (inHorizontalScroller) return false;
  return rect.right > viewportWidth + 0.5 || rect.left < -0.5;
}

function parseArgs(argv) {
  const out = {
    targets: [],
    routes: null,
    outFile: null,
    themeToggle: null,
    axePath: null,
    executablePath: process.env.CHROME_PATH || null,
    wiringBefore: null,
    wiringAfter: null,
    storybook: null,
    maxStories: 8,
    screenshot: null,
    screenshotDiff: null,
    diffThreshold: 1.0,
    pins: false,
    live: false,
    cdp: null,
    cdpTarget: null,
    extendedViewports: false,
    noHideOverlays: false,
    skipShellCheck: false,
    json: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--routes") out.routes = argv[++i];
    else if (a === "--out") out.outFile = argv[++i];
    else if (a === "--theme-toggle") out.themeToggle = argv[++i];
    else if (a === "--axe") out.axePath = argv[++i];
    else if (a === "--executable-path") out.executablePath = argv[++i];
    else if (a === "--wiring-before") out.wiringBefore = argv[++i];
    else if (a === "--wiring-after") out.wiringAfter = argv[++i];
    else if (a === "--storybook") out.storybook = argv[++i];
    else if (a === "--max-stories") out.maxStories = Number(argv[++i]) || 8;
    else if (a === "--screenshot") out.screenshot = argv[++i];
    else if (a === "--screenshot-diff") out.screenshotDiff = argv[++i];
    else if (a === "--diff-threshold") {
      const parsed = Number.parseFloat(argv[++i]);
      out.diffThreshold = Number.isFinite(parsed) ? parsed : 1.0;
    }
    else if (a === "--pins") out.pins = true;
    else if (a === "--live") out.live = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--target") out.cdpTarget = argv[++i];
    else if (a === "--extended-viewports") out.extendedViewports = true;
    else if (a === "--no-hide-overlays") out.noHideOverlays = true;
    else if (a === "--skip-shell-check") out.skipShellCheck = true;
    else if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("-")) out.targets.push(a);
  }
  if (out.live || out.storybook || out.cdp) out.skipShellCheck = true;
  return out;
}

export function collectAncestorDirs(targetPaths = []) {
  const dirs = [];
  const seen = new Set();
  const pushAncestors = (startDir) => {
    let cur = resolve(startDir);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      dirs.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  pushAncestors(process.cwd());
  for (const t of targetPaths) {
    if (!t || /^(?:https?|data):/i.test(t)) continue;
    let p = t;
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(new URL(p).pathname);
      } catch {
        continue;
      }
    }
    const clean = resolve(p.split("?")[0]);
    let start = clean;
    try {
      start = statSync(clean).isDirectory() ? clean : dirname(clean);
    } catch {
      start = dirname(clean);
    }
    pushAncestors(start);
  }
  return dirs;
}

function loadPlaywright(targetPaths = []) {
  const candidates = [
    () => require("playwright"),
    () => require("@playwright/test"),
  ];
  for (const dir of collectAncestorDirs(targetPaths)) {
    candidates.push(
      () => createRequire(join(dir, "package.json"))("playwright"),
      () => createRequire(join(dir, "package.json"))("@playwright/test"),
      () => require(join(dir, "node_modules/playwright")),
      () => require(join(dir, "node_modules/@playwright/test"))
    );
  }
  for (const fn of candidates) {
    try {
      const mod = fn();
      if (mod?.chromium) return mod;
    } catch {}
  }
  throw new Error("Playwright not found. Install playwright in your target project or set NODE_PATH to its node_modules.");
}

function discoverChromeFallbackPaths() {
  const paths = [];
  for (const dir of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir)
        .filter((e) => /^chromium_headless_shell-\d+|^chromium-\d+/.test(e))
        .sort()
        .reverse();
      for (const e of entries) {
        for (const sub of [
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
          "chrome-headless-shell-mac-x64/chrome-headless-shell",
          "chrome-headless-shell-linux/chrome-headless-shell",
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          "chrome-linux/chrome",
        ]) {
          const full = join(dir, e, sub);
          if (existsSync(full)) paths.push(full);
        }
      }
    } catch {}
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(p)) paths.push(p);
  }
  return paths;
}

async function launchChromium(chromium, explicitPath) {
  if (explicitPath) return chromium.launch({ headless: true, executablePath: explicitPath });
  try {
    return await chromium.launch({ headless: true });
  } catch (primaryErr) {
    try {
      return await chromium.launch({ headless: true, channel: "chrome" });
    } catch {}
    for (const p of discoverChromeFallbackPaths()) {
      try {
        return await chromium.launch({ headless: true, executablePath: p });
      } catch {}
    }
    throw primaryErr;
  }
}

export function findAxe(explicitPath, targetPaths = []) {
  if (explicitPath && existsSync(explicitPath)) return resolve(explicitPath);
  for (const dir of collectAncestorDirs(targetPaths)) {
    for (const p of [join(dir, "node_modules/axe-core/axe.min.js"), join(dir, "node_modules/axe-core/axe.js")]) {
      if (existsSync(p)) return p;
    }
    try {
      const resolved = createRequire(join(dir, "package.json")).resolve("axe-core/axe.min.js");
      if (resolved && existsSync(resolved)) return resolved;
    } catch {}
  }
  try {
    return require.resolve("axe-core/axe.min.js");
  } catch {}
  return null;
}

export function probeRuntimeDeps(targetPaths = []) {
  let playwrightAvailable = false;
  try {
    loadPlaywright(targetPaths);
    playwrightAvailable = true;
  } catch {}
  const axePath = findAxe(null, targetPaths);
  return { playwrightAvailable, axeAvailable: Boolean(axePath), axePath };
}

function toUrl(target) {
  if (/^(?:https?|file):\/\//i.test(target)) return target;
  return pathToFileURL(resolve(target)).href;
}

async function resolveStorybookUrls(storybookArg, maxStories) {
  let baseUrl = null;
  let indexData = null;
  if (/^https?:\/\//i.test(storybookArg)) {
    const clean = storybookArg.replace(/\/$/, "");
    for (const suffix of clean.endsWith(".json") ? [""] : ["/index.json", "/stories.json"]) {
      const probe = `${clean}${suffix}`;
      const res = await fetch(probe).catch(() => null);
      if (res && res.ok) {
        indexData = await res.json().catch(() => null);
        if (indexData) {
          baseUrl = clean.replace(/\/(index|stories)\.json$/, "");
          break;
        }
      }
    }
    if (!indexData) return [storybookArg];
  } else {
    const absJson = resolve(storybookArg);
    indexData = JSON.parse(readFileSync(absJson, "utf8"));
    const siblingIframe = join(dirname(absJson), "iframe.html");
    if (existsSync(siblingIframe)) baseUrl = pathToFileURL(dirname(absJson)).href;
  }
  const entries = Object.values(indexData.entries || indexData.stories || {}).filter((e) => (e.type || "story") === "story");
  const picked = entries.slice(0, maxStories);
  if (!baseUrl) return picked.map((e) => e.id);
  return picked.map((e) => `${baseUrl}/iframe.html?id=${encodeURIComponent(e.id)}&viewMode=story`);
}

function collectHtmlFiles(targets) {
  const files = [];
  for (const t of targets) {
    if (/^(?:https?|file):\/\//i.test(t)) {
      files.push(t);
      continue;
    }
    const abs = resolve(t);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name.endsWith(".html")) files.push(join(abs, name));
      }
    } else {
      files.push(abs);
    }
  }
  return files;
}

async function probePixelBehindElements(page) {
  const targets = await page.evaluate(() => {
    const DEV_OVERLAY_SEL =
      'nextjs-portal, vite-error-overlay, [data-nextjs-toast], [data-nextjs-dialog-overlay], #__next-build-indicator';
    const isInsideClosedDetails = (el) => {
      const det = el.closest("details:not([open])");
      if (!det) return false;
      const sum = el.closest("summary");
      return !(sum && sum.parentElement === det);
    };
    let colorCtx = null;
    const parseColor = (str) => {
      const m = (str || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!str || str === "transparent") return null;
      if (!colorCtx) {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        colorCtx = c.getContext("2d", { willReadFrequently: true });
      }
      colorCtx.globalCompositeOperation = "copy";
      colorCtx.fillStyle = "rgba(0,0,0,0)";
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      if (d[3] === 0) return null;
      return [d[0], d[1], d[2]];
    };

    const found = [];
    const seen = new Set();
    const candidates = [...document.querySelectorAll("h1, [data-pixel-behind]")];
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button, span")) {
      let cur = el;
      let complex = false;
      while (cur && cur.nodeType === 1) {
        const cs = getComputedStyle(cur);
        if ((cs.backgroundImage && cs.backgroundImage !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none")) {
          complex = true;
          break;
        }
        cur = cur.parentElement;
      }
      if (complex) candidates.push(el);
    }

    let idx = 0;
    for (const el of candidates) {
      if (seen.has(el) || idx >= 8) continue;
      if (el.matches(DEV_OVERLAY_SEL) || el.closest(DEV_OVERLAY_SEL) || isInsideClosedDetails(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
      if (!(el.textContent || "").trim()) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) continue;
      const fg = parseColor(cs.color);
      if (!fg) continue;
      seen.add(el);
      const token = `uxs-pb-${idx++}`;
      el.setAttribute("data-uxs-pb-id", token);
      found.push({
        token,
        label: `${el.tagName.toLowerCase()}("${(el.textContent || "").trim().slice(0, 28)}")`,
        fg,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: parseInt(cs.fontWeight, 10) || 400,
        rect: {
          x: Math.max(0, Math.floor(r.left)),
          y: Math.max(0, Math.floor(r.top)),
          width: Math.max(2, Math.floor(Math.min(r.right, window.innerWidth) - Math.max(0, r.left))),
          height: Math.max(2, Math.floor(Math.min(r.bottom, window.innerHeight) - Math.max(0, r.top))),
        },
      });
    }
    return found;
  });

  const results = [];
  for (const t of targets) {
    const sel = `[data-uxs-pb-id="${t.token}"]`;
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.dataset.uxsPrevColor = el.style.color;
      el.dataset.uxsPrevShadow = el.style.textShadow;
      el.style.setProperty("color", "transparent", "important");
      el.style.setProperty("text-shadow", "none", "important");
    }, sel);

    let pngBuf;
    try {
      pngBuf = await page.screenshot({ clip: t.rect });
    } finally {
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return;
        el.style.color = el.dataset.uxsPrevColor || "";
        el.style.textShadow = el.dataset.uxsPrevShadow || "";
        delete el.dataset.uxsPrevColor;
        delete el.dataset.uxsPrevShadow;
        el.removeAttribute("data-uxs-pb-id");
      }, sel);
    }

    const medianBg = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < data.length; i += 4) {
        rs.push(data[i]);
        gs.push(data[i + 1]);
        bs.push(data[i + 2]);
      }
      const med = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
      return [med(rs), med(gs), med(bs)];
    }, pngBuf.toString("base64"));

    const ratio = Number(wcagContrast(t.fg, medianBg).toFixed(2));
    const apcaLc = apcaContrast(t.fg, medianBg);
    const isLarge = t.fontSize >= 24 || (t.fontSize >= 18.66 && t.fontWeight >= 700);
    const threshold = isLarge ? 3.0 : 4.5;
    results.push({ label: t.label, fg: t.fg, medianBg, ratio, threshold, apcaLc, pass: ratio >= threshold });
  }
  return results;
}

export function validateSimulatedViewportSnapshot(viewport, snap) {
  const failures = [];
  if (!snap || !snap.canvasFound) {
    failures.push(`Simulated ${viewport}: missing .uxs-canvas container`);
    return failures;
  }
  if (snap.activeViewport && snap.activeViewport !== viewport) {
    failures.push(`Clicking [data-viewport="${viewport}"] set data-uxs-viewport="${snap.activeViewport}"`);
  }
  for (const s of snap.spills || []) {
    failures.push(`Simulated ${viewport} canvas overflow: ${s.tag}("${s.text}") right=${s.right} > canvasRight=${s.canvasRight}`);
  }
  for (const c of snap.crushed || []) {
    failures.push(`Simulated ${viewport} crushed content: ${c.tag}("${c.text}") scrollW=${c.scrollW} > clientW=${c.clientW}`);
  }
  for (const t of snap.tableOverflows || []) {
    failures.push(`Simulated ${viewport} unstacked table overflow: tableW=${t.tableW} > wrapW=${t.wrapW}`);
  }
  return failures;
}

async function auditShellContract(page) {
  const check = await page.evaluate(() => {
    const toolbar = document.querySelector("[data-ux-shell-toolbar]");
    if (!toolbar) return { present: false, failures: ["Missing [data-ux-shell-toolbar] canonical preview toolbar"] };
    const failures = [];
    for (const g of ["view", "viewport", "theme", "state", "pins"]) {
      if (!toolbar.querySelector(`[data-uxs-group="${g}"]`)) failures.push(`Missing toolbar group: data-uxs-group="${g}"`);
    }
    for (const v of ["before", "track-a", "compare"]) {
      if (!toolbar.querySelector(`[data-view="${v}"]`)) failures.push(`Missing view button: data-view="${v}"`);
    }
    const sel = document.getElementById("uxs-state-select");
    const opts = sel ? Array.from(sel.options).map((o) => o.value) : [];
    for (const st of ["default", "empty", "stress", "error"]) {
      if (!opts.includes(st)) failures.push(`Missing canonical state option: ${st}`);
    }
    if (!document.querySelector('[data-pane="before"]')) failures.push("Missing [data-pane='before']");
    if (!document.querySelector('[data-pane="track-a"]')) failures.push("Missing [data-pane='track-a']");
    const ambition = document.documentElement.getAttribute("data-uxs-ambition") || "L3";
    if (ambition === "L3" && !document.querySelector('[data-pane="track-b"]')) failures.push("Ambition L3 requires [data-pane='track-b']");
    return { present: true, ambition, failures };
  });

  if (!check.present || check.failures.length > 0) return check;
  const views = check.ambition === "L3" ? ["before", "track-a", "track-b", "compare"] : ["before", "track-a", "compare"];
  for (const v of views) {
    const btn = await page.$(`[data-view="${v}"]`);
    if (!btn) continue;
    await btn.click();
    const active = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-view"));
    if (active !== v) check.failures.push(`Clicking [data-view="${v}"] set data-uxs-view="${active}"`);
  }
  const pinsBtn = await page.$("#uxs-pins-btn");
  if (pinsBtn) {
    await pinsBtn.click();
    const pinsOn = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
    if (pinsOn !== "on") check.failures.push("Clicking #uxs-pins-btn did not toggle pins on");

    // Verify simulated viewport toggles (tablet 768px & mobile 390px) while Compare + Pins Drawer are both active
    const desktopWidth = await page.evaluate(() => window.innerWidth);
    for (const vp of ["tablet", "mobile"]) {
      const vpBtn = await page.$(`[data-vp-btn="${vp}"], [data-viewport="${vp}"]`);
      if (!vpBtn) {
        if (desktopWidth >= 1120) check.failures.push(`Missing simulated viewport switcher button for '${vp}'`);
        continue;
      }
      if (await vpBtn.isVisible().catch(() => false)) {
        await vpBtn.click();
        await page.waitForTimeout(80);
        const snap = await page.evaluate(() => {
          const canvas = document.querySelector(".uxs-canvas");
          if (!canvas) return { canvasFound: false };
          const cRect = canvas.getBoundingClientRect();
          const spills = [];
          const crushed = [];
          const tableOverflows = [];
          for (const el of canvas.querySelectorAll(".uxs-kpi, .uxs-card, .uxs-kpi-val, button, h1, h2, h3")) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || cs.display === "none") continue;
            if (r.right > cRect.right + 2) {
              spills.push({
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || "").trim().slice(0, 28),
                right: Math.round(r.right),
                canvasRight: Math.round(cRect.right),
              });
            }
            if (!["auto", "scroll"].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 2) {
              crushed.push({
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || "").trim().slice(0, 28),
                scrollW: Math.round(el.scrollWidth),
                clientW: Math.round(el.clientWidth),
              });
            }
          }
          for (const wrap of canvas.querySelectorAll(".uxs-table-wrap")) {
            const tbl = wrap.querySelector("table");
            if (!tbl) continue;
            const wr = wrap.getBoundingClientRect();
            if (wr.width > 0 && tbl.scrollWidth > wrap.clientWidth + 4) {
              tableOverflows.push({ tableW: Math.round(tbl.scrollWidth), wrapW: Math.round(wrap.clientWidth) });
            }
          }
          return {
            canvasFound: true,
            activeViewport: document.documentElement.getAttribute("data-uxs-viewport"),
            spills: spills.slice(0, 6),
            crushed: crushed.slice(0, 6),
            tableOverflows: tableOverflows.slice(0, 6),
          };
        });
        check.failures.push(...validateSimulatedViewportSnapshot(vp, snap));
      }
    }
    const desktopBtn = await page.$('[data-vp-btn="desktop"], [data-viewport="desktop"]');
    if (desktopBtn && (await desktopBtn.isVisible().catch(() => false))) await desktopBtn.click();
    await pinsBtn.click();
  }
  return check;
}

async function auditFilledButtonHoverContrast(page) {
  const hoverFails = [];
  const btns = await page.$$('button[aria-pressed="true"], [data-primary-cta], button.primary');
  for (const btn of btns.slice(0, 6)) {
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.hover();
    await page.waitForTimeout(180);
    const res = await btn.evaluate((el) => {
      let colorCtx = null;
      const parseRgba = (str) => {
        const m = (str || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
        if (!str || str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
        if (!colorCtx) {
          const c = document.createElement("canvas");
          c.width = 1;
          c.height = 1;
          colorCtx = c.getContext("2d", { willReadFrequently: true });
        }
        colorCtx.globalCompositeOperation = "copy";
        colorCtx.fillStyle = "rgba(0,0,0,0)";
        colorCtx.fillStyle = str;
        colorCtx.fillRect(0, 0, 1, 1);
        const d = colorCtx.getImageData(0, 0, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const cs = getComputedStyle(el);
      const fg = parseRgba(cs.color);
      const bg = parseRgba(cs.backgroundColor);
      if (!fg || !bg || bg.a < 0.8) return null;
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { text: (el.textContent || "").trim().slice(0, 30), ratio: Number(ratio.toFixed(2)) };
    });
    if (res && res.ratio < 4.5) hoverFails.push(res);
  }
  await page.mouse.move(0, 0);
  return hoverFails;
}

async function auditGeometryApcaInventoryAndSlop(page, isMobile) {
  const raw = await page.evaluate((mobile) => {
    const DEV_OVERLAY_SEL =
      'nextjs-portal, vite-error-overlay, [data-nextjs-toast], [data-nextjs-dialog-overlay], #__next-build-indicator';
    const isInsideClosedDetails = (el) => {
      const det = el.closest("details:not([open])");
      if (!det) return false;
      const sum = el.closest("summary");
      return !(sum && sum.parentElement === det);
    };
    let colorCtx = null;
    const parseColorToRgba = (str) => {
      const m = (str || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
      if (!str || str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
      if (!colorCtx) {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        colorCtx = c.getContext("2d", { willReadFrequently: true });
      }
      colorCtx.globalCompositeOperation = "copy";
      colorCtx.fillStyle = "rgba(0,0,0,0)";
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const composite = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (c1, c2) => {
      const l1 = lum(c1), l2 = lum(c2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const effectiveBg = (el) => {
      const stack = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const c = parseColorToRgba(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0) stack.push(c);
        cur = cur.parentElement;
      }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) bg = composite(stack[i], bg);
      return bg;
    };
    const visible = (el) => {
      if (el.matches(DEV_OVERLAY_SEL) || el.closest(DEV_OVERLAY_SEL) || isInsideClosedDetails(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (cs.clipPath && cs.clipPath.includes("inset(50%)")) return false;
      if (r.width <= 1.5 && r.height <= 1.5 && cs.overflow === "hidden") return false;
      return true;
    };

    const vw = window.innerWidth;
    const docOverflow = Math.max(0, Math.round(document.documentElement.scrollWidth - vw));
    const bodyOverflow = Math.max(0, Math.round(document.body.scrollWidth - vw));

    const childOverflows = [];
    for (const el of document.querySelectorAll("td, th, button, a, .uxs-canvas, .uxs-pane")) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        childOverflows.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth });
      }
    }

    const smallTargets = [];
    const clippedTargets = [];
    const borderFails = [];
    const badTransitions = [];
    const buttonShapes = [];
    const inputShapes = [];

    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, label[for], [role="button"], [role="tab"]')) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const shape = {
        height: r.height,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        fontSize: parseFloat(cs.fontSize) || 14,
        borderWidth: parseFloat(cs.borderTopWidth) || 0,
        label: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 24),
      };
      if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") buttonShapes.push(shape);
      else if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") inputShapes.push(shape);

      if ((parseFloat(cs.transitionDuration) || 0) > 0) {
        const forbidden = (cs.transitionProperty || "").split(",").map((s) => s.trim().toLowerCase()).filter((p) => ["all", "width", "height", "top", "left"].includes(p));
        if (forbidden.length > 0) badTransitions.push({ tag: el.tagName.toLowerCase(), text: shape.label, props: forbidden });
      }

      if (mobile) {
        let inHorizontalScroller = false;
        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
          const pcs = getComputedStyle(p);
          if ((pcs.overflowX === "auto" || pcs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) {
            const pr = p.getBoundingClientRect();
            inHorizontalScroller = pr.left >= -0.5 && pr.right <= vw + 0.5;
            break;
          }
        }
        if (!inHorizontalScroller && (r.right > vw + 0.5 || r.left < -0.5)) {
          clippedTargets.push({ tag: el.tagName.toLowerCase(), text: shape.label, left: Number(r.left.toFixed(1)), right: Number(r.right.toFixed(1)), vw });
        }
        if (el.tagName !== "LABEL" || cs.borderTopWidth !== "0px") {
          let effW = r.width;
          let effH = r.height;
          for (const pseudo of ["::before", "::after"]) {
            const ps = getComputedStyle(el, pseudo);
            if (!ps || !ps.content || ps.content === "none" || ps.content === "normal") continue;
            if (ps.position !== "absolute") continue;
            const pw = Math.max(parseFloat(ps.width) || 0, parseFloat(ps.minWidth) || 0);
            const ph = Math.max(parseFloat(ps.height) || 0, parseFloat(ps.minHeight) || 0);
            const negW = (parseFloat(ps.left) < 0 ? Math.abs(parseFloat(ps.left)) : 0) + (parseFloat(ps.right) < 0 ? Math.abs(parseFloat(ps.right)) : 0);
            const negH = (parseFloat(ps.top) < 0 ? Math.abs(parseFloat(ps.top)) : 0) + (parseFloat(ps.bottom) < 0 ? Math.abs(parseFloat(ps.bottom)) : 0);
            effW = Math.max(effW, pw, negW > 0 ? r.width + negW : 0);
            effH = Math.max(effH, ph, negH > 0 ? r.height + negH : 0);
          }
          if (effW < 43.99 || effH < 43.99) {
            smallTargets.push({ tag: el.tagName.toLowerCase(), text: shape.label, w: Number(effW.toFixed(1)), h: Number(effH.toFixed(1)) });
          }
        }
      }

      const bw = parseFloat(cs.borderTopWidth) || 0;
      const bColor = parseColorToRgba(cs.borderTopColor);
      if (bw >= 1 && bColor && bColor.a > 0) {
        const parentBg = effectiveBg(el.parentElement || document.body);
        const cr = ratio(composite(bColor, parentBg), parentBg);
        if (cr < 3.0) borderFails.push({ tag: el.tagName.toLowerCase(), text: shape.label, ratio: Number(cr.toFixed(2)) });
      }
    }

    // Collect visible text samples for APCA-W3 evaluation in Node
    const textSamples = [];
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button, label, td, li")) {
      if (textSamples.length >= 60 || !visible(el)) continue;
      if (!(el.textContent || "").trim()) continue;
      const cs = getComputedStyle(el);
      const fg = parseColorToRgba(cs.color);
      const bg = effectiveBg(el);
      if (!fg) continue;
      const fs = parseFloat(cs.fontSize) || 16;
      const fw = parseInt(cs.fontWeight, 10) || 400;
      textSamples.push({
        label: `${el.tagName.toLowerCase()}("${(el.textContent || "").trim().slice(0, 24)}")`,
        fg: [fg.r, fg.g, fg.b],
        bg: [bg.r, bg.g, bg.b],
        isLarge: fs >= 24 || (fs >= 18.66 && fw >= 700),
      });
    }

    const focusLeaks = [];
    for (const c of document.querySelectorAll('[aria-hidden="true"], [data-drawer="closed"]')) {
      const cs = getComputedStyle(c);
      if (cs.display === "none" || cs.visibility === "hidden" || c.hasAttribute("inert")) continue;
      for (const t of c.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) {
        const tcs = getComputedStyle(t);
        if (tcs.display !== "none" && tcs.visibility !== "hidden" && t.getAttribute("tabindex") !== "-1") {
          focusLeaks.push({ tag: t.tagName.toLowerCase(), text: (t.textContent || "").trim().slice(0, 24) });
        }
      }
    }

    const hiddenAtRest = [];
    for (const el of document.querySelectorAll("main section, main article, main h1, main h2, main h3, .uxs-canvas > *")) {
      if (el.matches(DEV_OVERLAY_SEL) || el.closest(DEV_OVERLAY_SEL) || isInsideClosedDetails(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20 && parseFloat(cs.opacity) === 0) {
        hiddenAtRest.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 28) });
      }
    }

    const inlineHeightMismatches = [];
    for (const inp of document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')) {
      if (!visible(inp)) continue;
      const next = inp.nextElementSibling;
      if (!next || next.tagName !== "BUTTON" || !visible(next)) continue;
      const r1 = inp.getBoundingClientRect();
      const r2 = next.getBoundingClientRect();
      if (Math.abs(r1.top - r2.top) < 12 && Math.abs(r1.height - r2.height) > 2) {
        inlineHeightMismatches.push({ inputH: Number(r1.height.toFixed(1)), buttonH: Number(r2.height.toFixed(1)) });
      }
    }

    const getAccName = (el) => {
      const aria = el.getAttribute("aria-label") || "";
      if (aria.trim()) return aria.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const t = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
          .trim();
        if (t) return t;
      }
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && (lbl.textContent || "").trim()) return lbl.textContent.trim();
      }
      const wrapLabel = el.closest("label");
      if (wrapLabel && (wrapLabel.textContent || "").trim()) return wrapLabel.textContent.trim();
      const text = (el.textContent || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
      if (text) return text;
      const img = el.querySelector("img[alt]");
      if (img && img.getAttribute("alt")?.trim()) return img.getAttribute("alt").trim();
      return "";
    };

    const focusableControls = [];
    for (const el of document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"]'
    )) {
      if (!visible(el) || el.getAttribute("tabindex") === "-1" || el.hasAttribute("disabled")) continue;
      const acc = getAccName(el);
      focusableControls.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        tabindex: parseInt(el.getAttribute("tabindex") || "0", 10) || 0,
        accessibleName: acc.slice(0, 32),
        label: (acc || el.tagName).slice(0, 24),
      });
    }

    let headerHeight = 0;
    if (mobile && vw <= 480) {
      for (const hdr of document.querySelectorAll("header")) {
        if (!visible(hdr)) continue;
        headerHeight = Math.max(headerHeight, Math.round(hdr.getBoundingClientRect().height));
      }
    }

    const badgesSnapshot = [];
    for (const el of document.querySelectorAll('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]')) {
      if (badgesSnapshot.length >= 40 || !visible(el)) continue;
      if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "CODE", "PRE", "SVG"].includes(el.tagName)) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 42) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 14;
      const lh = cs.lineHeight === "normal" ? fs * 1.25 : parseFloat(cs.lineHeight) || fs * 1.25;
      const r = el.getBoundingClientRect();
      badgesSnapshot.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 32), w: r.width, h: r.height, lineHeightPx: lh });
    }

    const tablesSnapshot = [];
    if (mobile) {
      for (const tbl of document.querySelectorAll("table")) {
        if (!visible(tbl)) continue;
        const tCs = getComputedStyle(tbl);
        if (tCs.display === "block" || tCs.display === "grid") continue;
        const tr = tbl.getBoundingClientRect();
        let scroller = tbl;
        for (let p = tbl.parentElement; p && p !== document.body; p = p.parentElement) {
          const pcs = getComputedStyle(p);
          if (pcs.overflowX === "auto" || pcs.overflowX === "scroll") {
            scroller = p;
            break;
          }
        }
        const cr = scroller.getBoundingClientRect();
        const overflowPx = Math.max(0, tbl.scrollWidth - Math.min(cr.width || vw, vw), scroller.scrollWidth - (scroller.clientWidth || vw));
        const headers = Array.from(tbl.querySelectorAll("th")).slice(0, 4).map((th) => th.textContent.trim()).join(" / ");
        tablesSnapshot.push({
          headers,
          tableW: tr.width,
          containerW: cr.width || vw,
          overflowPx,
          allowScroll: Boolean(tbl.closest("[data-allow-table-scroll]")),
        });
      }
    }

    const coveredText = [];
    let sampledTextChecks = 0;
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button")) {
      if (sampledTextChecks >= 40 || !visible(el)) continue;
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      const cx = Math.round((Math.max(0, r.left) + Math.min(vw, r.right)) / 2);
      const cy = Math.round((Math.max(0, r.top) + Math.min(window.innerHeight, r.bottom)) / 2);
      if (cx <= 0 || cx >= vw || cy <= 0 || cy >= window.innerHeight) continue;
      sampledTextChecks++;
      const topEl = document.elementsFromPoint(cx, cy)?.[0];
      if (!topEl || topEl === el || el.contains(topEl) || topEl.contains(el)) continue;
      if (topEl.matches(DEV_OVERLAY_SEL) || topEl.closest(DEV_OVERLAY_SEL)) continue;
      const tcs = getComputedStyle(topEl);
      if (tcs.position === "fixed" || tcs.position === "sticky" || parseFloat(tcs.opacity) <= 0.2) continue;
      const tbg = parseColorToRgba(tcs.backgroundColor);
      const isOpaqueCover =
        topEl.tagName === "IMG" || topEl.tagName === "SVG" || topEl.tagName === "CANVAS" || (tbg && tbg.a >= 0.75);
      if (isOpaqueCover) {
        coveredText.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 28), coveredBy: topEl.tagName.toLowerCase() });
      }
    }

    const rtlElements = [];
    const htmlDir = document.documentElement.getAttribute("dir") || "";
    const htmlLang = document.documentElement.getAttribute("lang") || "";
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button, label, span")) {
      if (rtlElements.length >= 40 || !visible(el) || el.closest('[dir="ltr"]')) continue;
      const txt = (el.textContent || "").trim();
      if (!/[\u0590-\u08FF]/.test(txt)) continue;
      const cs = getComputedStyle(el);
      const ls = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) || 0;
      rtlElements.push({
        tag: el.tagName.toLowerCase(),
        text: txt.slice(0, 24),
        letterSpacingPx: Number(ls.toFixed(2)),
        textAlign: cs.textAlign,
        hasRtlScriptText: true,
      });
    }

    return {
      docOverflow,
      bodyOverflow,
      viewportHeight: window.innerHeight,
      headerHeight,
      badgesSnapshot,
      tablesSnapshot,
      childOverflows,
      smallTargets,
      clippedTargets,
      borderFails,
      focusLeaks,
      badTransitions,
      hiddenAtRest,
      inlineHeightMismatches,
      coveredText,
      rtlSnapshot: { htmlDir, htmlLang, elements: rtlElements },
      focusableControls,
      buttonShapes,
      inputShapes,
      textSamples,
    };
  }, isMobile);

  // Compute real APCA-W3 Lc, keyboard map, RTL diagnostics, and N-of-1 clusters cleanly in Node
  let minApcaBodyLc = null;
  let minApcaLargeLc = null;
  const apcaLowWarnings = [];
  for (const s of raw.textSamples) {
    const absLc = Math.abs(apcaContrast(s.fg, s.bg));
    if (s.isLarge) {
      minApcaLargeLc = minApcaLargeLc === null ? absLc : Math.min(minApcaLargeLc, absLc);
      if (absLc < 45) apcaLowWarnings.push({ label: s.label, lc: absLc, target: 45 });
    } else {
      minApcaBodyLc = minApcaBodyLc === null ? absLc : Math.min(minApcaBodyLc, absLc);
      if (absLc < 60) apcaLowWarnings.push({ label: s.label, lc: absLc, target: 60 });
    }
  }

  const overflowKeys = new Set(raw.childOverflows.map((c) => `${c.tag}|${c.text}`));
  const smallTargetsAnnotated = raw.smallTargets.map((s) =>
    overflowKeys.has(`${s.tag}|${s.text}`) ? { ...s, overlapsChildOverflow: true } : s
  );
  const rtlChecks = evaluateRtlDiagnostics(raw.rtlSnapshot);
  const layoutHealth = evaluateLayoutHealth({
    isMobile,
    viewportHeight: raw.viewportHeight,
    headerHeight: raw.headerHeight,
    badges: raw.badgesSnapshot,
    tables: raw.tablesSnapshot,
  });

  return {
    docOverflow: raw.docOverflow,
    bodyOverflow: raw.bodyOverflow,
    headerBloat: layoutHealth.headerBloat,
    crushedBadges: layoutHealth.crushedBadges,
    clippedTables: layoutHealth.clippedTables,
    childOverflows: raw.childOverflows,
    smallTargets: smallTargetsAnnotated,
    clippedTargets: raw.clippedTargets,
    borderFails: raw.borderFails,
    focusLeaks: raw.focusLeaks,
    badTransitions: raw.badTransitions,
    hiddenAtRest: raw.hiddenAtRest,
    inlineHeightMismatches: raw.inlineHeightMismatches,
    coveredText: raw.coveredText,
    rtlChecks,
    keyboardMap: summarizeKeyboardAccessibility(raw.focusableControls),
    apca: { minBodyLc: minApcaBodyLc, minLargeLc: minApcaLargeLc, lowWarnings: apcaLowWarnings.slice(0, 8) },
    componentInventory: {
      buttons: clusterSignatures(raw.buttonShapes),
      inputs: clusterSignatures(raw.inputShapes),
    },
  };
}

async function captureComputedRootVars(page) {
  return page.evaluate(() => {
    const names = new Set();
    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!rule.style || !rule.selectorText) continue;
        if (!/(:root|\bhtml\b|\[data-theme|\[data-mode|\.(?:dark|light)\b)/i.test(rule.selectorText)) continue;
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith("--") && !/^--(tw|radix|next|vite|sb|storybook|_+)-?/i.test(prop)) {
            names.add(prop);
          }
        }
      }
    }
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of Array.from(names).sort().slice(0, 500)) {
      const val = cs.getPropertyValue(n).trim();
      if (val) out[n] = val;
    }
    return out;
  });
}

async function captureWebVitals(page) {
  return page.evaluate(() => {
    let lcpMs = null;
    let cls = 0;
    try {
      const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) lcpMs = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
      for (const entry of performance.getEntriesByType("layout-shift")) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
    } catch {}
    return { lcpMs, cls: Number(cls.toFixed(4)) };
  });
}

async function captureWiringInventory(page, target) {
  await page.goto(toUrl(target), { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort();
    return {
      links: uniq(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))),
      forms: uniq(Array.from(document.querySelectorAll("form")).map((f) => f.getAttribute("id") || f.getAttribute("action") || "unnamed-form")),
      fieldNames: uniq(Array.from(document.querySelectorAll("input[name], select[name], textarea[name]")).map((el) => el.getAttribute("name"))),
      testIds: uniq(Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"))),
    };
  });
}

function diffWiring(before, after) {
  const dropped = {};
  for (const key of ["links", "forms", "fieldNames", "testIds"]) {
    const afterSet = new Set(after[key]);
    const missing = before[key].filter((x) => !afterSet.has(x));
    if (missing.length > 0) dropped[key] = missing;
  }
  return {
    passed: Object.keys(dropped).length === 0,
    beforeCounts: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length])),
    afterCounts: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.length])),
    dropped,
  };
}

async function runSelfTest() {
  assert.equal(Number(wcagContrast([0, 0, 0], [255, 255, 255]).toFixed(2)), 21.0);
  const lcBow = apcaContrast([0, 0, 0], [255, 255, 255]);
  const lcWob = apcaContrast([255, 255, 255], [0, 0, 0]);
  const lcLow = Math.abs(apcaContrast([150, 150, 150], [170, 170, 170]));
  assert.ok(lcBow >= 104 && lcBow <= 108, `Expected BoW Lc ~106, got ${lcBow}`);
  assert.ok(lcWob <= -104 && lcWob >= -110, `Expected WoB Lc ~-108, got ${lcWob}`);
  assert.ok(lcLow < 15, `Expected low contrast |Lc| < 15, got ${lcLow}`);

  const inv = clusterSignatures([
    { height: 40, radius: 8, fontSize: 14, borderWidth: 1, label: "Save" },
    { height: 41, radius: 8, fontSize: 14, borderWidth: 1, label: "Cancel" },
    { height: 48, radius: 24, fontSize: 16, borderWidth: 0, label: "Hero CTA" },
  ]);
  assert.equal(inv.totalRendered, 3);
  assert.equal(inv.distinctSignatures, 2, "Must cluster 40px & 41px into 2 signatures");

  const kbd = summarizeKeyboardAccessibility([
    { tag: "button", role: "button", tabindex: 0, accessibleName: "Save", label: "Save" },
    { tag: "input", role: "", tabindex: 2, accessibleName: "Search", label: "Search" },
    { tag: "button", role: "button", tabindex: 0, accessibleName: "", label: "BUTTON" },
  ]);
  assert.equal(kbd.tabbableCount, 3);
  assert.equal(kbd.positiveTabindexCount, 1);
  assert.equal(kbd.unnamedInteractiveCount, 1);

  const scratch = mkdtempSync(join(tmpdir(), "dsaf-sb-test-"));
  try {
    writeFileSync(join(scratch, "index.json"), JSON.stringify({ entries: { "btn--primary": { id: "btn--primary", type: "story" } } }));
    writeFileSync(join(scratch, "iframe.html"), "<html></html>");
    const sbUrls = await resolveStorybookUrls(join(scratch, "index.json"), 4);
    assert.equal(sbUrls.length, 1);
    assert.match(sbUrls[0], /^file:\/\/\/.*iframe\.html\?id=btn--primary&viewMode=story$/);

    const axeDir = join(scratch, "proj/node_modules/axe-core");
    mkdirSync(axeDir, { recursive: true });
    writeFileSync(join(axeDir, "axe.min.js"), "/* stub axe */");
    mkdirSync(join(scratch, "proj/draft/sub"), { recursive: true });
    const nestedDraft = join(scratch, "proj/draft/sub/preview.html");
    writeFileSync(nestedDraft, "<html></html>");
    const resolvedAxe = findAxe(null, [nestedDraft]);
    assert.equal(
      realpathSync(resolvedAxe),
      realpathSync(join(axeDir, "axe.min.js")),
      "findAxe must walk target ancestors without NODE_PATH"
    );
    assert.deepEqual(expandRouteTargets(["http://localhost:3100"], "/,/ket-qua,/so-ve"), [
      "http://localhost:3100/",
      "http://localhost:3100/ket-qua",
      "http://localhost:3100/so-ve",
    ]);

    assert.equal(normalizeCdpEndpoint("9222"), "http://127.0.0.1:9222");
    assert.equal(normalizeCdpEndpoint("http://127.0.0.1:9333"), "http://127.0.0.1:9333");
    assert.equal(buildViewportMatrix(false).length, 5);
    assert.equal(buildViewportMatrix(true).length, 7);
    assert.ok(buildViewportMatrix(true).some((v) => v.width === 320) && buildViewportMatrix(true).some((v) => v.width === 1920));
    assert.equal(evaluateRtlDiagnostics({ htmlDir: "ltr", htmlLang: "en", elements: [] }).applicable, false);
    const rtlMissing = evaluateRtlDiagnostics({ htmlDir: "", htmlLang: "ar", elements: [] });
    assert.equal(rtlMissing.missingDirRtl, true);
    assert.equal(rtlMissing.passed, false);
    const rtlBadTrack = evaluateRtlDiagnostics({
      htmlDir: "rtl",
      htmlLang: "ar",
      elements: [{ tag: "p", letterSpacingPx: 1.2, textAlign: "right", hasRtlScriptText: true }],
    });
    assert.equal(rtlBadTrack.arabicLetterSpacingViolations, 1);
    assert.equal(rtlBadTrack.passed, false);
    const rtlClean = evaluateRtlDiagnostics({
      htmlDir: "rtl",
      htmlLang: "ar",
      elements: [{ tag: "p", letterSpacingPx: 0, textAlign: "right", hasRtlScriptText: true }],
    });
    assert.equal(rtlClean.passed, true);
    assert.equal(isMobileTargetClipped({ left: 310, right: 410 }, 375, [{ left: 16, right: 359 }]), false);
    assert.equal(isMobileTargetClipped({ left: 310, right: 410 }, 375, []), true);
    assert.equal(isMobileTargetClipped({ left: 310, right: 410 }, 375, [{ left: 16, right: 420 }]), true);
    assert.ok(OVERLAY_SELECTORS.some((s) => s.includes('aria-label*="cookie"')), "Must match non-dialog cookie aria-label");
    assert.ok(OVERLAY_SELECTORS.some((s) => s.includes('data-testid*="cookie"')), "Must match cookie data-testid");
    assert.ok(OVERLAY_SELECTORS.some((s) => s.includes('class*="consent"')), "Must match consent class overlays");

    const buildMiniPng = (w, h, rgbaBytes) => {
      const crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
      const crc32 = (b) => {
        let c = 0xffffffff;
        for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
      };
      const mkChunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "ascii");
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8;
      ihdr[9] = 6;
      const scan = Buffer.alloc(h * (1 + w * 4));
      for (let y = 0; y < h; y++) {
        scan[y * (1 + w * 4)] = 0;
        Buffer.from(rgbaBytes.subarray(y * w * 4, (y + 1) * w * 4)).copy(scan, y * (1 + w * 4) + 1);
      }
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mkChunk("IHDR", ihdr),
        mkChunk("IDAT", deflateSync(scan)),
        mkChunk("IEND", Buffer.alloc(0)),
      ]);
    };

    const pxBase = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 244, 186, 23, 255, 69, 33, 14, 255]);
    const pxSame = new Uint8Array([255, 250, 255, 255, 0, 0, 0, 255, 244, 186, 23, 255, 69, 33, 14, 255]);
    const pxChanged = new Uint8Array([255, 255, 255, 255, 200, 0, 0, 255, 244, 186, 23, 255, 69, 33, 14, 255]);
    const decodedBase = decodePngRgba(buildMiniPng(2, 2, pxBase));
    assert.equal(decodedBase.width, 2);
    assert.equal(decodedBase.height, 2);
    assert.equal(computeImagePixelDiffRatio(decodedBase, { width: 2, height: 2, rgba: pxSame }).diffPct, 0);
    assert.equal(computeImagePixelDiffRatio(decodedBase, { width: 2, height: 2, rgba: pxChanged }).diffPct, 25);
    assert.equal(computeImagePixelDiffRatio(decodedBase, { width: 1, height: 4, rgba: pxBase }).sizeMismatch, true);

    assert.deepEqual(
      computeEffectiveHitArea({ width: 28, height: 26 }, { content: '""', position: "absolute", width: "44px", height: "44px" }, null),
      { width: 44, height: 44 },
      "Must recognize 44px ::before pseudo hit-area"
    );
    assert.deepEqual(
      computeEffectiveHitArea({ width: 20, height: 20 }, { content: '""', position: "absolute", top: "-14px", bottom: "-14px", left: "-14px", right: "-14px" }, null),
      { width: 48, height: 48 },
      "Must recognize negative inset ::before touch target"
    );
    const badLayout = evaluateLayoutHealth({
      isMobile: true,
      viewportHeight: 844,
      headerHeight: 340,
      badges: [{ tag: "span", text: "Wrapped Three Line Pill", w: 72, h: 68, lineHeightPx: 16 }],
      tables: [{ headers: "Col A / Col B", tableW: 520, containerW: 350, overflowPx: 170, allowScroll: false }],
    });
    assert.ok(badLayout.headerBloat && badLayout.headerBloat.height === 340, "Must flag mobile header bloat");
    assert.equal(badLayout.crushedBadges.length, 1, "Must flag crushed multi-line pill badges");
    assert.equal(badLayout.clippedTables.length, 1, "Must flag clipped mobile tables");

    const simFail = validateSimulatedViewportSnapshot("mobile", {
      canvasFound: true,
      activeViewport: "mobile",
      spills: [{ tag: "button", text: "#4", right: 440, canvasRight: 390 }],
      crushed: [{ tag: "p", text: "+24 pts", scrollW: 92, clientW: 60 }],
      tableOverflows: [],
    });
    assert.equal(simFail.length, 2, "Must catch simulated mobile canvas spill & crushed KPI text");
    assert.deepEqual(
      validateSimulatedViewportSnapshot("mobile", {
        canvasFound: true,
        activeViewport: "mobile",
        spills: [],
        crushed: [],
        tableOverflows: [],
      }),
      []
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("AUDIT_RUNTIME_SELF_TEST_PASSED (APCA-W3 0.1.9 + WCAG 2.2 + keyboard map + Storybook + routes + CDP/RTL/320-1920 + N-of-1)");
  return 0;
}

async function hideConsentOverlays(page) {
  return page.evaluate((selectors) => {
    let hidden = 0;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        el.dataset.dsafOrigVis = el.style.visibility || "";
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        hidden++;
      }
    }
    return hidden;
  }, OVERLAY_SELECTORS);
}

async function findCdpPage(browser, matchQuery) {
  const candidates = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const url = p.url() || "";
      if (url.startsWith("devtools://") || url.startsWith("chrome-extension://")) continue;
      const title = await p.title().catch(() => "");
      candidates.push({ page: p, url, title });
    }
  }
  if (candidates.length === 0) throw new Error("No open page found on CDP browser target.");
  if (!matchQuery) return candidates[0].page;
  const q = String(matchQuery).toLowerCase();
  const hit = candidates.find((c) => c.url.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  if (!hit) {
    throw new Error(`No CDP page matched --target '${matchQuery}'. Available: ${candidates.map((c) => `${c.title} (${c.url})`).join("; ")}`);
  }
  return hit.page;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node skill/scripts/audit-runtime.mjs <draft.html|draft-dir|url> [--routes /,/about] [--out <file>] [--theme-toggle <sel>] [--live] [--cdp <port|url> --target <match>] [--extended-viewports] [--no-hide-overlays] [--storybook <url|index.json>] [--screenshot <out.png> [--pins]] [--screenshot-diff <baseline.png> [--diff-threshold 1.0]] [--wiring-before a --wiring-after b] [--axe path] [--skip-shell-check] [--json] [--self-test]"
    );
    process.exit(0);
  }
  if (args.selfTest) process.exit(await runSelfTest());

  const targets = expandRouteTargets([...args.targets], args.routes);
  if (args.storybook) {
    const sbUrls = await resolveStorybookUrls(args.storybook, args.maxStories);
    targets.push(...sbUrls);
  }
  const isCdpAttached = Boolean(args.cdp);
  if (!isCdpAttached && targets.length === 0 && !(args.wiringBefore && args.wiringAfter)) {
    console.error("Error: specify target draft/url, --cdp <port>, or --self-test.");
    process.exit(2);
  }

  const searchPaths = [...targets, args.wiringBefore, args.wiringAfter].filter(Boolean);
  const { chromium } = loadPlaywright(searchPaths);
  const axePath = findAxe(args.axePath, searchPaths);
  const browser = isCdpAttached
    ? await chromium.connectOverCDP(normalizeCdpEndpoint(args.cdp))
    : await launchChromium(chromium, args.executablePath);
  const report = { schema: "dsaf-runtime/2", axeLoaded: Boolean(axePath), cdpAttached: isCdpAttached, files: [], wiringDiff: null, screenshotDiff: null, allPassed: true };
  let screenshotSaved = false;
  let screenshotDiffDone = false;

  try {
    const urlsOrFiles = isCdpAttached ? ["cdp://attached-target"] : collectHtmlFiles(targets);
    const matrix = buildViewportMatrix(args.extendedViewports);

    for (const target of urlsOrFiles) {
      const pageErrors = [];
      const page = isCdpAttached
        ? await findCdpPage(browser, args.cdpTarget)
        : await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
      if (!isCdpAttached) {
        const targetUrl = toUrl(target);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("load", { timeout: 10000 }).catch(() => null);
        await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => null);
        if (/^https?:\/\//i.test(targetUrl)) await page.waitForTimeout(300);
      }
      const hiddenOverlaysCount = (args.live || isCdpAttached) && !args.noHideOverlays ? await hideConsentOverlays(page) : 0;

      const fileRes = {
        file: isCdpAttached
          ? page.url() || "cdp-attached"
          : /^(?:https?|file):\/\//i.test(target)
          ? target.replace(/^file:\/\/\/.*\//, "")
          : basename(target.split("?")[0]),
        pageErrors,
        hiddenOverlaysCount,
        webVitals: await captureWebVitals(page),
        computedVars: await captureComputedRootVars(page),
        shell: null,
        screenshot: null,
        reducedMotion: null,
        pixelBehind: [],
        checks: [],
        passed: true,
      };

      if (!args.skipShellCheck && basename(target) !== "index.html") {
        fileRes.shell = await auditShellContract(page);
        if (fileRes.shell.failures.length > 0) {
          fileRes.passed = false;
          report.allPassed = false;
        }
      }

      if (args.screenshot && !screenshotSaved) {
        if (!isCdpAttached) await page.setViewportSize({ width: 1440, height: 900 });
        const pinsBtn = args.pins ? await page.$("#uxs-pins-btn") : null;
        if (pinsBtn) {
          await pinsBtn.click();
          await page.waitForTimeout(150);
        }
        const outShot = resolve(args.screenshot);
        mkdirSync(dirname(outShot), { recursive: true });
        await page.screenshot({ path: outShot, fullPage: false });
        fileRes.screenshot = outShot;
        screenshotSaved = true;
        if (pinsBtn) await pinsBtn.click();
      }

      if (args.screenshotDiff && !screenshotDiffDone) {
        if (!isCdpAttached) await page.setViewportSize({ width: 1440, height: 900 });
        const pinsBtn = args.pins ? await page.$("#uxs-pins-btn") : null;
        if (pinsBtn) {
          await pinsBtn.click();
          await page.waitForTimeout(150);
        }
        const curBuf = await page.screenshot({ fullPage: false });
        if (pinsBtn) await pinsBtn.click();
        const absBase = resolve(args.screenshotDiff);
        const baseImg = decodePngRgba(readFileSync(absBase));
        const curImg = decodePngRgba(curBuf);
        const diff = computeImagePixelDiffRatio(baseImg, curImg);
        report.screenshotDiff = {
          baseline: absBase,
          thresholdPct: args.diffThreshold,
          ...diff,
          passed: !diff.sizeMismatch && diff.diffPct <= args.diffThreshold,
        };
        if (!report.screenshotDiff.passed) {
          fileRes.passed = false;
          report.allPassed = false;
        }
        screenshotDiffDone = true;
      }

      fileRes.pixelBehind = await probePixelBehindElements(page);
      if (fileRes.pixelBehind.some((p) => !p.pass)) {
        fileRes.passed = false;
        report.allPassed = false;
      }

      for (const m of matrix) {
        if (!isCdpAttached) {
          await page.setViewportSize({ width: m.width, height: m.height });
        }
        await page.emulateMedia({ colorScheme: m.theme });
        if ((args.live || isCdpAttached) && !args.noHideOverlays) {
          fileRes.hiddenOverlaysCount += await hideConsentOverlays(page);
        }
        const applyDomThemeFallback = async (theme) => {
          await page.evaluate((th) => {
            const root = document.documentElement;
            if (root.classList.contains("dark") || root.classList.contains("light")) {
              root.classList.toggle("dark", th === "dark");
              root.classList.toggle("light", th === "light");
            } else if (root.hasAttribute("data-theme")) {
              root.setAttribute("data-theme", th);
            } else if (root.hasAttribute("data-mode")) {
              root.setAttribute("data-mode", th);
            }
          }, theme);
        };
        const safeThemeClick = async (btn) => {
          try {
            await btn.click({ timeout: 4000 });
            return true;
          } catch {
            if (!args.noHideOverlays) {
              fileRes.hiddenOverlaysCount += await hideConsentOverlays(page);
              try {
                await btn.click({ timeout: 2500 });
                return true;
              } catch {
                return false;
              }
            }
            return false;
          }
        };
        const themeBtn = await page.$(`[data-theme="${m.theme}"]`);
        if (themeBtn) {
          const clicked = await safeThemeClick(themeBtn);
          if (!clicked) await applyDomThemeFallback(m.theme);
        } else if (args.themeToggle) {
          const curTheme = await page.evaluate(() =>
            document.documentElement.classList.contains("dark") ||
            document.documentElement.getAttribute("data-theme") === "dark" ||
            document.documentElement.getAttribute("data-mode") === "dark"
              ? "dark"
              : "light"
          );
          if (curTheme !== m.theme) {
            const tog = await page.$(args.themeToggle);
            if (tog) {
              const clicked = await safeThemeClick(tog);
              if (!clicked) await applyDomThemeFallback(m.theme);
            }
          }
        } else if (args.live) {
          await applyDomThemeFallback(m.theme);
        }
        await page.waitForTimeout(150);

        const geom = await auditGeometryApcaInventoryAndSlop(page, m.isMobile);
        const hoverFails = m.isMobile ? [] : await auditFilledButtonHoverContrast(page);
        let axeViolations = [];
        if (axePath) {
          await page.addScriptTag({ path: axePath });
          axeViolations = await page.evaluate(async () => {
            const res = await window.axe.run(
              { include: [["html"]], exclude: [["nextjs-portal"], ["vite-error-overlay"], ["[data-nextjs-toast]"], ["[data-nextjs-dialog-overlay]"], ["#__next-build-indicator"]] },
              { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }
            );
            return res.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length }));
          });
        }

        const ok =
          geom.docOverflow === 0 &&
          geom.bodyOverflow === 0 &&
          !geom.headerBloat &&
          geom.crushedBadges.length === 0 &&
          geom.clippedTables.length === 0 &&
          geom.childOverflows.length === 0 &&
          geom.smallTargets.length === 0 &&
          geom.clippedTargets.length === 0 &&
          geom.borderFails.length === 0 &&
          geom.focusLeaks.length === 0 &&
          geom.badTransitions.length === 0 &&
          geom.hiddenAtRest.length === 0 &&
          geom.inlineHeightMismatches.length === 0 &&
          geom.coveredText.length === 0 &&
          geom.rtlChecks.passed &&
          hoverFails.length === 0 &&
          axeViolations.length === 0;

        if (!ok) {
          fileRes.passed = false;
          report.allPassed = false;
        }
        fileRes.checks.push({ state: m.name, passed: ok, ...geom, hoverFails, axeViolations });
        if (isCdpAttached && m.name === "desktop-1440-light") break;
      }

      if (args.storybook) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForTimeout(100);
        fileRes.reducedMotion = await page.evaluate(() => {
          const matches = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const unguarded = [];
          for (const el of document.querySelectorAll("*")) {
            const cs = getComputedStyle(el);
            const dur = Math.max(parseFloat(cs.transitionDuration) || 0, parseFloat(cs.animationDuration) || 0);
            if (dur > 0.25 && cs.display !== "none") {
              unguarded.push({ tag: el.tagName.toLowerCase(), dur });
            }
          }
          return { mediaMatches: matches, unguardedAnimatedCount: unguarded.length };
        });
        await page.emulateMedia({ reducedMotion: "no-preference" });
      }

      if (pageErrors.length > 0) {
        fileRes.passed = false;
        report.allPassed = false;
      }
      if (!isCdpAttached) await page.close();
      report.files.push(fileRes);
    }

    if (args.wiringBefore && args.wiringAfter) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const b = await captureWiringInventory(page, args.wiringBefore);
      const a = await captureWiringInventory(page, args.wiringAfter);
      await page.close();
      report.wiringDiff = diffWiring(b, a);
      if (!report.wiringDiff.passed) report.allPassed = false;
    }
  } finally {
    if (!isCdpAttached) await browser.close();
  }

  const outJson = JSON.stringify(report, null, 2) + "\n";
  if (args.outFile) {
    mkdirSync(dirname(resolve(args.outFile)), { recursive: true });
    writeFileSync(resolve(args.outFile), outJson, "utf8");
  }
  if (args.json) {
    process.stdout.write(outJson);
  } else {
    for (const f of report.files) {
      console.log(`FILE ${f.file}: ${f.passed ? "PASS" : "FAIL"} (pageErrors=${f.pageErrors.length}, LCP=${f.webVitals?.lcpMs ?? "n/a"}ms, CLS=${f.webVitals?.cls ?? 0}, hiddenOverlays=${f.hiddenOverlaysCount})`);
      if (f.shell) console.log(`  shell: ${f.shell.failures.length === 0 ? "PASS" : "FAIL " + JSON.stringify(f.shell.failures)}`);
      if (f.screenshot) console.log(`  screenshot: ${f.screenshot}`);
      if (f.reducedMotion) console.log(`  reducedMotion: mediaMatches=${f.reducedMotion.mediaMatches} unguarded=${f.reducedMotion.unguardedAnimatedCount}`);
      for (const pb of f.pixelBehind) {
        console.log(`  pixelBehind ${pb.label}: ${pb.ratio}:1 (min ${pb.threshold}:1, Lc=${pb.apcaLc}) ${pb.pass ? "PASS" : "FAIL"}`);
      }
      for (const c of f.checks) {
        console.log(
          `  [${c.state}] ${c.passed ? "PASS" : "FAIL"} | overflow=${c.docOverflow}/${c.bodyOverflow} child=${c.childOverflows.length} small44=${c.smallTargets.length} clip=${c.clippedTargets.length}${c.clippedTargets.length ? `(${c.clippedTargets.map((t) => t.text).join(",")})` : ""} hdrBloat=${c.headerBloat ? c.headerBloat.height + "px" : 0} badges=${c.crushedBadges?.length || 0} clipTbl=${c.clippedTables?.length || 0} borders=${c.borderFails.length} hover=${c.hoverFails.length} covered=${c.coveredText.length} leaks=${c.focusLeaks.length} tab=${c.keyboardMap.tabbableCount}(+${c.keyboardMap.positiveTabindexCount}/un=${c.keyboardMap.unnamedInteractiveCount}) slop=${c.badTransitions.length + c.hiddenAtRest.length + c.inlineHeightMismatches.length} axe=${c.axeViolations.length}${c.axeViolations.length ? `(${c.axeViolations.map((v) => v.id).join(",")})` : ""} | apcaBodyMin=${c.apca.minBodyLc ?? "n/a"} btnSigs=${c.componentInventory.buttons.distinctSignatures}`
        );
      }
    }
    if (report.wiringDiff) {
      console.log(`WIRING DIFF: ${report.wiringDiff.passed ? "PASS" : "FAIL"} | dropped=${JSON.stringify(report.wiringDiff.dropped)}`);
    }
    if (report.screenshotDiff) {
      console.log(
        `SCREENSHOT DIFF: ${report.screenshotDiff.passed ? "PASS" : "FAIL"} | diffPct=${report.screenshotDiff.diffPct}% (threshold=${report.screenshotDiff.thresholdPct}%, sizeMismatch=${report.screenshotDiff.sizeMismatch})`
      );
    }
    console.log(report.allPassed ? "AUDIT_RUNTIME_ALL_PASSED" : "AUDIT_RUNTIME_FAILED");
  }
  process.exit(report.allPassed ? 0 : 1);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) {
  main().catch((err) => {
    console.error("ERROR:", err.message || err);
    process.exit(1);
  });
}

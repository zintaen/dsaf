#!/usr/bin/env node
/**
 * DSAF v0.2.1 — Runtime Browser, APCA-W3, Keyboard, Screenshot & N-of-1 Verifier.
 * Pure-JS self-tests run with zero dependencies. Live browser/draft audits lazily
 * require Playwright (`playwright` or `@playwright/test`) and Chromium.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

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

function parseArgs(argv) {
  const out = {
    targets: [],
    axePath: null,
    executablePath: process.env.CHROME_PATH || null,
    wiringBefore: null,
    wiringAfter: null,
    storybook: null,
    maxStories: 8,
    screenshot: null,
    pins: false,
    live: false,
    skipShellCheck: false,
    json: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--axe") out.axePath = argv[++i];
    else if (a === "--executable-path") out.executablePath = argv[++i];
    else if (a === "--wiring-before") out.wiringBefore = argv[++i];
    else if (a === "--wiring-after") out.wiringAfter = argv[++i];
    else if (a === "--storybook") out.storybook = argv[++i];
    else if (a === "--max-stories") out.maxStories = Number(argv[++i]) || 8;
    else if (a === "--screenshot") out.screenshot = argv[++i];
    else if (a === "--pins") out.pins = true;
    else if (a === "--live") out.live = true;
    else if (a === "--skip-shell-check") out.skipShellCheck = true;
    else if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("-")) out.targets.push(a);
  }
  if (out.live || out.storybook) out.skipShellCheck = true;
  return out;
}

function loadPlaywright() {
  const candidates = [
    () => require("playwright"),
    () => require("@playwright/test"),
    () => require(join(process.cwd(), "node_modules/playwright")),
    () => require(join(process.cwd(), "node_modules/@playwright/test")),
  ];
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

function findAxe(explicitPath) {
  if (explicitPath && existsSync(explicitPath)) return resolve(explicitPath);
  for (const p of [join(process.cwd(), "node_modules/axe-core/axe.min.js"), join(process.cwd(), "node_modules/axe-core/axe.js")]) {
    if (existsSync(p)) return p;
  }
  try {
    return require.resolve("axe-core/axe.min.js");
  } catch {}
  return null;
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
        if (r.right > vw + 0.5 || r.left < -0.5) {
          clippedTargets.push({ tag: el.tagName.toLowerCase(), text: shape.label, left: Number(r.left.toFixed(1)), right: Number(r.right.toFixed(1)), vw });
        }
        if (el.tagName !== "LABEL" || cs.borderTopWidth !== "0px") {
          if (r.width < 43.99 || r.height < 43.99) {
            smallTargets.push({ tag: el.tagName.toLowerCase(), text: shape.label, w: Number(r.width.toFixed(1)), h: Number(r.height.toFixed(1)) });
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

    return {
      docOverflow,
      bodyOverflow,
      childOverflows,
      smallTargets,
      clippedTargets,
      borderFails,
      focusLeaks,
      badTransitions,
      hiddenAtRest,
      inlineHeightMismatches,
      focusableControls,
      buttonShapes,
      inputShapes,
      textSamples,
    };
  }, isMobile);

  // Compute real APCA-W3 Lc, keyboard map, and N-of-1 clusters cleanly in Node
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

  return {
    docOverflow: raw.docOverflow,
    bodyOverflow: raw.bodyOverflow,
    childOverflows: raw.childOverflows,
    smallTargets: raw.smallTargets,
    clippedTargets: raw.clippedTargets,
    borderFails: raw.borderFails,
    focusLeaks: raw.focusLeaks,
    badTransitions: raw.badTransitions,
    hiddenAtRest: raw.hiddenAtRest,
    inlineHeightMismatches: raw.inlineHeightMismatches,
    keyboardMap: summarizeKeyboardAccessibility(raw.focusableControls),
    apca: { minBodyLc: minApcaBodyLc, minLargeLc: minApcaLargeLc, lowWarnings: apcaLowWarnings.slice(0, 8) },
    componentInventory: {
      buttons: clusterSignatures(raw.buttonShapes),
      inputs: clusterSignatures(raw.inputShapes),
    },
  };
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log("AUDIT_RUNTIME_SELF_TEST_PASSED (APCA-W3 0.1.9 + WCAG 2.2 + keyboard map + Storybook + N-of-1 clustering)");
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node skill/scripts/audit-runtime.mjs <draft.html|draft-dir|url> [--live] [--storybook <url|index.json>] [--screenshot <out.png> [--pins]] [--wiring-before a --wiring-after b] [--axe path] [--skip-shell-check] [--json] [--self-test]"
    );
    process.exit(0);
  }
  if (args.selfTest) process.exit(await runSelfTest());

  const targets = [...args.targets];
  if (args.storybook) {
    const sbUrls = await resolveStorybookUrls(args.storybook, args.maxStories);
    targets.push(...sbUrls);
  }
  if (targets.length === 0 && !(args.wiringBefore && args.wiringAfter)) {
    console.error("Error: specify target draft/url or --self-test.");
    process.exit(2);
  }

  const { chromium } = loadPlaywright();
  const axePath = findAxe(args.axePath);
  const browser = await launchChromium(chromium, args.executablePath);
  const report = { schema: "dsaf-runtime/2", axeLoaded: Boolean(axePath), files: [], wiringDiff: null, allPassed: true };
  let screenshotSaved = false;

  try {
    const urlsOrFiles = collectHtmlFiles(targets);
    const matrix = [
      { name: "desktop-1440-dark", width: 1440, height: 900, theme: "dark", isMobile: false },
      { name: "desktop-1440-light", width: 1440, height: 900, theme: "light", isMobile: false },
      { name: "zoom-720-dark", width: 720, height: 450, theme: "dark", isMobile: false },
      { name: "mobile-375-dark", width: 375, height: 812, theme: "dark", isMobile: true },
      { name: "mobile-375-light", width: 375, height: 812, theme: "light", isMobile: true },
    ];

    for (const target of urlsOrFiles) {
      const pageErrors = [];
      const fileRes = {
        file: /^(?:https?|file):\/\//i.test(target) ? target.replace(/^file:\/\/\/.*\//, "") : basename(target.split("?")[0]),
        pageErrors,
        webVitals: null,
        shell: null,
        screenshot: null,
        reducedMotion: null,
        pixelBehind: [],
        checks: [],
        passed: true,
      };
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
      await page.goto(toUrl(target), { waitUntil: "networkidle" });
      fileRes.webVitals = await captureWebVitals(page);

      if (!args.skipShellCheck && basename(target) !== "index.html") {
        fileRes.shell = await auditShellContract(page);
        if (fileRes.shell.failures.length > 0) {
          fileRes.passed = false;
          report.allPassed = false;
        }
      }

      if (args.screenshot && !screenshotSaved) {
        await page.setViewportSize({ width: 1440, height: 900 });
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

      fileRes.pixelBehind = await probePixelBehindElements(page);
      if (fileRes.pixelBehind.some((p) => !p.pass)) {
        fileRes.passed = false;
        report.allPassed = false;
      }

      for (const m of matrix) {
        await page.setViewportSize({ width: m.width, height: m.height });
        const themeBtn = await page.$(`[data-theme="${m.theme}"]`);
        if (themeBtn) await themeBtn.click();
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
          geom.childOverflows.length === 0 &&
          geom.smallTargets.length === 0 &&
          geom.clippedTargets.length === 0 &&
          geom.borderFails.length === 0 &&
          geom.focusLeaks.length === 0 &&
          geom.badTransitions.length === 0 &&
          geom.hiddenAtRest.length === 0 &&
          geom.inlineHeightMismatches.length === 0 &&
          hoverFails.length === 0 &&
          axeViolations.length === 0;

        if (!ok) {
          fileRes.passed = false;
          report.allPassed = false;
        }
        fileRes.checks.push({ state: m.name, passed: ok, ...geom, hoverFails, axeViolations });
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
      await page.close();
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
    await browser.close();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const f of report.files) {
      console.log(`FILE ${f.file}: ${f.passed ? "PASS" : "FAIL"} (pageErrors=${f.pageErrors.length}, LCP=${f.webVitals?.lcpMs ?? "n/a"}ms, CLS=${f.webVitals?.cls ?? 0})`);
      if (f.shell) console.log(`  shell: ${f.shell.failures.length === 0 ? "PASS" : "FAIL " + JSON.stringify(f.shell.failures)}`);
      if (f.screenshot) console.log(`  screenshot: ${f.screenshot}`);
      if (f.reducedMotion) console.log(`  reducedMotion: mediaMatches=${f.reducedMotion.mediaMatches} unguarded=${f.reducedMotion.unguardedAnimatedCount}`);
      for (const pb of f.pixelBehind) {
        console.log(`  pixelBehind ${pb.label}: ${pb.ratio}:1 (min ${pb.threshold}:1, Lc=${pb.apcaLc}) ${pb.pass ? "PASS" : "FAIL"}`);
      }
      for (const c of f.checks) {
        console.log(
          `  [${c.state}] ${c.passed ? "PASS" : "FAIL"} | overflow=${c.docOverflow}/${c.bodyOverflow} child=${c.childOverflows.length} small44=${c.smallTargets.length} clip=${c.clippedTargets.length} borders=${c.borderFails.length} hover=${c.hoverFails.length} leaks=${c.focusLeaks.length} tab=${c.keyboardMap.tabbableCount}(+${c.keyboardMap.positiveTabindexCount}/un=${c.keyboardMap.unnamedInteractiveCount}) slop=${c.badTransitions.length + c.hiddenAtRest.length + c.inlineHeightMismatches.length} axe=${c.axeViolations.length} | apcaBodyMin=${c.apca.minBodyLc ?? "n/a"} btnSigs=${c.componentInventory.buttons.distinctSignatures}`
        );
      }
    }
    if (report.wiringDiff) {
      console.log(`WIRING DIFF: ${report.wiringDiff.passed ? "PASS" : "FAIL"} | dropped=${JSON.stringify(report.wiringDiff.dropped)}`);
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

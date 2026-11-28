#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Automated 3-Vertex Figma MCP / Code Connect Triangulation CLI.
 * Compares Designed (Figma variable JSON + optional Code Connect *.figma.* files)
 * against Defined (W3C DTCG tokens / CSS variables / audit-tokens JSON) and optional
 * Shipped runtime summary (`audit-runtime --json`). Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertWritableOutputFile, isDirectCliEntry, splitTopLevelCommas, stripCommentsPreservingLines } from "./ci-report.mjs";
import { hasDesignTokenEvidence } from "./recon.mjs";
import { colorSpaceInSrgbGamutToRgba, evalCssNumericExpr, hwbToSrgb, labToSrgb, parseCssColorToRgba, resolveDtcgExtends, splitCssTopLevel, splitCssTopLevelSpaces, wideColorInSrgbGamutToRgba } from "./audit-tokens.mjs";

function normalizeKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .replace(/^--+/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1.$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
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
    .replace(/(?:^|[._-])primitives(?=[._-]|$)/gi, "")
    .replace(/([._-])\1+/g, "$1")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function normalizeCssNumberString(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(^|[\s,(])-?\.(\d+)/g, (full, pre, dec) => `${pre}${full.includes("-") ? "-" : ""}0.${dec}`);
}

function formatRgbaHexOrStr(rgba) {
  if (!rgba) return null;
  const [r, g, b, a] = rgba;
  const alpha = typeof a === "number" && Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
  const roundedA = Number(alpha.toFixed(4));
  if (Math.abs(roundedA - 1) > 1e-6) {
    return normalizeCssNumberString(`rgba(${r}, ${g}, ${b}, ${roundedA})`);
  }
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const CSS_COLOR_FN_SPACES = new Set(["display-p3", "display-p3-linear", "srgb-linear", "a98-rgb", "prophoto-rgb", "rec2020", "xyz", "xyz-d50", "xyz-d65"]);

function cssColorFnToNormalized(s) {
  const raw = String(s || "").trim();
  const outer = /^color\s*\(/i.test(raw) ? parseOuterCssFunction(raw) : null;
  if (outer?.fn === "color") {
    const slashParts = splitCssTopLevel(outer.body, "/");
    if (slashParts.length <= 2) {
      const mainToks = splitCssTopLevelSpaces(slashParts[0]);
      if (mainToks.length >= 2) {
        const rawCs = mainToks[0].toLowerCase();
        const cs = rawCs === "xyz" ? "xyz-d65" : rawCs;
        if (cs === "srgb") {
          return formatRgbaHexOrStr(parseCssColorToRgba(raw));
        }
        let alphaNum = 1;
        let alphaValid = true;
        if (slashParts.length === 2) {
          const rawA = slashParts[1].trim();
          const aVal = /^none$/i.test(rawA) ? 0 : evalCssNumericExpr(rawA, 1, "scalar");
          if (aVal !== null && Number.isFinite(aVal)) {
            alphaNum = Math.max(0, Math.min(1, aVal));
          } else {
            alphaValid = false;
          }
        }
        if (CSS_COLOR_FN_SPACES.has(cs) && mainToks.length === 4 && alphaValid) {
          const compNums = mainToks.slice(1).map((tok) => {
            if (/^none$/i.test(tok)) return 0;
            const v = evalCssNumericExpr(tok, 1, "scalar");
            return v !== null && Number.isFinite(v) ? v : NaN;
          });
          if (compNums.every(Number.isFinite)) {
            const inGamut = colorSpaceInSrgbGamutToRgba(cs, compNums[0], compNums[1], compNums[2], alphaNum);
            if (inGamut) return formatRgbaHexOrStr(inGamut);
          }
        }
        const fmtNumTok = (tok) => {
          if (/^none$/i.test(tok)) return "0";
          const v = evalCssNumericExpr(tok, 1, "scalar");
          if (v === null || !Number.isFinite(v)) return tok;
          const rounded = Number(v.toFixed(4));
          return String(Object.is(rounded, -0) ? 0 : rounded);
        };
        const mainPart = mainToks.slice(1).map(fmtNumTok).join(" ");
        if (slashParts.length === 2 && alphaValid) {
          const roundedA = Number(alphaNum.toFixed(4));
          const suffix = Math.abs(roundedA - 1) <= 1e-6 ? "" : ` / ${roundedA}`;
          return normalizeCssNumberString(`color(${cs} ${mainPart}${suffix})`);
        }
        return normalizeCssNumberString(`color(${cs} ${mainPart})`);
      }
    }
  }
  if (/^(?:hwb|lab|lch)\(/i.test(raw)) {
    return labLchHwbFuncToNormalized(raw);
  }
  return null;
}

function labLchHwbFuncToNormalized(s) {
  const outer = /^(?:hwb|lab|lch)\s*\(/i.test(String(s || "").trim()) ? parseOuterCssFunction(s) : null;
  if (!outer || !/^(?:hwb|lab|lch)$/.test(outer.fn)) return null;
  const kind = outer.fn;
  const slashParts = splitCssTopLevel(outer.body, "/");
  if (slashParts.length > 2) return null;
  const mainToks = splitCssTopLevelSpaces(slashParts[0]);
  if (mainToks.length !== 3) return null;
  const evalScalar = (tok, pctScale) => {
    const t = String(tok || "").trim();
    if (!t) return null;
    if (/^none$/i.test(t)) return 0;
    const v = evalCssNumericExpr(t, pctScale, "scalar");
    return v !== null && Number.isFinite(v) ? v : null;
  };
  let clampedA = null;
  if (slashParts.length === 2) {
    const aParsed = evalScalar(slashParts[1], 1);
    if (aParsed === null) return null;
    clampedA = Math.max(0, Math.min(1, aParsed));
  }
  const effAlpha = clampedA === null ? 1 : clampedA;
  const fmtNum = (n) => {
    const v = Number(n.toFixed(4));
    return String(Object.is(v, -0) ? 0 : v);
  };
  const roundedA = clampedA !== null ? Number(clampedA.toFixed(4)) : null;
  const alphaSuffix = roundedA !== null && Math.abs(roundedA - 1) > 1e-6 ? ` / ${roundedA}` : "";
  const parseAngle = (tok) => {
    const hRaw = String(tok || "").trim().toLowerCase();
    if (hRaw === "none") return 0;
    if (/%/.test(hRaw)) return null;
    const hParsed = evalCssNumericExpr(hRaw, null, "angle");
    if (hParsed === null || !Number.isFinite(hParsed)) return null;
    const hMod = ((hParsed % 360) + 360) % 360;
    return Math.abs(hMod - 360) < 1e-6 ? 0 : hMod;
  };
  if (kind === "lab") {
    const rawL = evalScalar(mainToks[0], 100);
    const a = evalScalar(mainToks[1], 125);
    const b = evalScalar(mainToks[2], 125);
    if (rawL === null || a === null || b === null) return null;
    const L = Math.max(0, Math.min(100, rawL));
    const inGamut = wideColorInSrgbGamutToRgba("lab", L, a, b, effAlpha);
    if (inGamut) return formatRgbaHexOrStr(inGamut);
    return `lab(${fmtNum(L)} ${fmtNum(a)} ${fmtNum(b)}${alphaSuffix})`;
  }
  if (kind === "lch") {
    const rawL = evalScalar(mainToks[0], 100);
    const rawC = evalScalar(mainToks[1], 150);
    const normH = parseAngle(mainToks[2]);
    if (rawL === null || rawC === null || normH === null) return null;
    const L = Math.max(0, Math.min(100, rawL));
    const cPos = Math.max(0, rawC);
    const inGamut = wideColorInSrgbGamutToRgba("lch", L, cPos, normH, effAlpha);
    if (inGamut) return formatRgbaHexOrStr(inGamut);
    return `lch(${fmtNum(L)} ${fmtNum(cPos)} ${fmtNum(normH)}${alphaSuffix})`;
  }
  const normH = parseAngle(mainToks[0]);
  const w = evalScalar(mainToks[1], 100);
  const b = evalScalar(mainToks[2], 100);
  if (normH === null || w === null || b === null) return null;
  const inGamut = wideColorInSrgbGamutToRgba("hwb", normH, w, b, effAlpha);
  if (inGamut) return formatRgbaHexOrStr(inGamut);
  return `hwb(${fmtNum(normH)} ${fmtNum(w)} ${fmtNum(b)}${alphaSuffix})`;
}

function rgbFuncToHex(s) {
  if (!/^rgba?\(/i.test(String(s || "").trim())) return null;
  return formatRgbaHexOrStr(parseCssColorToRgba(s));
}

function hslFuncToHex(s) {
  if (!/^hsla?\(/i.test(String(s || "").trim())) return null;
  return formatRgbaHexOrStr(parseCssColorToRgba(s));
}

function okColorFuncToHex(s) {
  const outer = /^(?:oklab|oklch)\s*\(/i.test(String(s || "").trim()) ? parseOuterCssFunction(s) : null;
  if (!outer || (outer.fn !== "oklab" && outer.fn !== "oklch")) return null;
  const kind = outer.fn;
  const slashParts = splitCssTopLevel(outer.body, "/");
  if (slashParts.length > 2) return null;
  const commaParts = splitCssTopLevel(slashParts[0], ",");
  let mainToks = commaParts.length > 1 ? commaParts : splitCssTopLevelSpaces(slashParts[0]);
  let alphaTok = slashParts.length === 2 ? slashParts[1].trim() : null;
  if (alphaTok === null && commaParts.length === 4) {
    alphaTok = commaParts[3];
    mainToks = commaParts.slice(0, 3);
  }
  if (mainToks.length !== 3) return null;
  const evalScalar = (tok, pctScale) => {
    const t = String(tok || "").trim();
    if (!t) return null;
    if (/^none$/i.test(t)) return 0;
    const v = evalCssNumericExpr(t, pctScale, "scalar");
    return v !== null && Number.isFinite(v) ? v : null;
  };
  let clampedA = null;
  if (alphaTok !== null) {
    const aParsed = evalScalar(alphaTok, 1);
    if (aParsed === null) return null;
    clampedA = Math.max(0, Math.min(1, aParsed));
  }
  const rawL = evalScalar(mainToks[0], 1);
  if (rawL === null) return null;
  const L = Math.max(0, Math.min(1, rawL));
  let a = 0;
  let b = 0;
  let cPos = 0;
  let hDeg = 0;
  if (kind === "oklab") {
    const pa = evalScalar(mainToks[1], 0.4);
    const pb = evalScalar(mainToks[2], 0.4);
    if (pa === null || pb === null) return null;
    a = pa;
    b = pb;
  } else {
    const C = evalScalar(mainToks[1], 0.4);
    if (C === null) return null;
    cPos = Math.max(0, C);
    const hRaw = String(mainToks[2] || "").trim().toLowerCase();
    if (hRaw !== "none") {
      if (/%/.test(hRaw)) return null;
      const hParsed = evalCssNumericExpr(hRaw, null, "angle");
      if (hParsed === null || !Number.isFinite(hParsed)) return null;
      hDeg = hParsed;
    }
    const hRad = (hDeg * Math.PI) / 180;
    a = cPos * Math.cos(hRad);
    b = cPos * Math.sin(hRad);
  }
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * mc + 0.2309699292 * sc;
  const lg = -1.2684380046 * l + 2.6097574011 * mc - 0.3413193965 * sc;
  const lb = -0.0041960863 * l - 0.7034186147 * mc + 1.7076147010 * sc;
  if (lr < -0.005 || lr > 1.005 || lg < -0.005 || lg > 1.005 || lb < -0.005 || lb > 1.005) {
    const fmtNum = (n) => {
      const v = Number(n.toFixed(4));
      return String(Object.is(v, -0) ? 0 : v);
    };
    const roundedA = clampedA !== null ? Number(clampedA.toFixed(4)) : null;
    const alphaSuffix = roundedA !== null && Math.abs(roundedA - 1) > 1e-6 ? ` / ${roundedA}` : "";
    if (kind === "oklch") {
      const hMod = ((hDeg % 360) + 360) % 360;
      const normH = Math.abs(hMod - 360) < 1e-6 ? 0 : hMod;
      return `oklch(${fmtNum(L)} ${fmtNum(cPos)} ${fmtNum(normH)}${alphaSuffix})`;
    }
    return `oklab(${fmtNum(L)} ${fmtNum(a)} ${fmtNum(b)}${alphaSuffix})`;
  }
  const toSrgb = (lin) => {
    const c = Math.max(0, Math.min(1, lin));
    const enc = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(enc * 255)));
  };
  const [r, g, bCh] = [toSrgb(lr), toSrgb(lg), toSrgb(lb)];
  const roundedOutA = clampedA !== null ? Number(clampedA.toFixed(4)) : null;
  if (roundedOutA !== null && Math.abs(roundedOutA - 1) > 1e-6) {
    return normalizeCssNumberString(`rgba(${r}, ${g}, ${bCh}, ${roundedOutA})`);
  }
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bCh)}`;
}

function isShadowTokenObj(v) {
  return Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.prototype.hasOwnProperty.call(v, "offsetX") &&
      Object.prototype.hasOwnProperty.call(v, "offsetY") &&
      Object.prototype.hasOwnProperty.call(v, "color")
  );
}

function splitShadowTokens(layer) {
  const parts = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < layer.length; i++) {
    const ch = layer[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < layer.length) cur += layer[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function isRecognizedShadowColorToken(tok) {
  const s = String(tok || "").trim();
  if (
    /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|var\(--|currentcolor$)/i.test(
      s
    )
  ) {
    return true;
  }
  return Boolean(parseCssColorToRgba(s));
}

function looksLikeShadow(str) {
  const layers = splitTopLevelCommas(String(str || "")).map((l) => l.trim()).filter(Boolean);
  if (layers.length === 0) return false;
  for (const layer of layers) {
    const parts = splitShadowTokens(layer);
    let insetCount = 0;
    let lengthCount = 0;
    let colorCount = 0;
    for (const rawTok of parts) {
      const tok = rawTok.trim();
      if (!tok) continue;
      if (/^inset$/i.test(tok)) {
        insetCount++;
        if (insetCount > 1) return false;
      } else if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)?$/i.test(tok)) {
        lengthCount++;
      } else if (isRecognizedShadowColorToken(tok)) {
        colorCount++;
      } else {
        return false;
      }
    }
    if (lengthCount < 2 || lengthCount > 4 || colorCount !== 1) return false;
  }
  return true;
}

function normalizeShadowLayer(layer, mode = null) {
  const parts = splitShadowTokens(layer);

  let isInset = false;
  const lengths = [];
  const colors = [];
  for (const rawTok of parts) {
    const tok = rawTok.trim();
    if (!tok) continue;
    if (/^inset$/i.test(tok)) {
      isInset = true;
    } else if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)?$/i.test(tok)) {
      const zero = /^0(?:\.0+)?(?:px|rem|em)?$/i.test(tok);
      lengths.push(zero ? "0" : normalizeCssNumberString(tok));
    } else {
      const conv = normalizeValue(tok, mode);
      colors.push(typeof conv === "string" ? conv : normalizeCssNumberString(tok));
    }
  }
  if (lengths.length === 2) lengths.push("0");
  if (lengths.length >= 4 && lengths[3] === "0") lengths.splice(3, 1);
  const ordered = [];
  if (isInset) ordered.push("inset");
  ordered.push(...lengths, ...colors);
  return ordered.join(" ");
}

function normalizeShadowString(s, mode = null) {
  return splitTopLevelCommas(String(s || ""))
    .map((layer) => normalizeShadowLayer(layer, mode))
    .filter(Boolean)
    .join(", ");
}

function parseOuterCssFunction(str) {
  const s = String(str || "").trim();
  const m = /^([a-z-]+)\s*\(/i.exec(s);
  if (!m) return null;
  const openIdx = s.indexOf("(");
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) {
        if (i !== s.length - 1) return null;
        return { fn: m[1].toLowerCase(), body: s.slice(openIdx + 1, i).trim() };
      }
    }
  }
  return null;
}

function normalizeValue(val, mode = null) {
  if (val == null) return null;
  if (Array.isArray(val)) {
    if (val.length === 4 && val.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return `cubic-bezier(${val.map((n) => String(Number(n.toFixed(4)))).join(", ")})`;
    }
    if (val.length > 0 && val.every(isShadowTokenObj)) {
      return val.map((item) => normalizeValue(item, mode)).join(", ");
    }
    if (val.length > 0 && val.every((x) => typeof x === "string" && x.trim().length > 0)) {
      return normalizeCssNumberString(val.map((s) => (/\s/.test(s.trim()) ? `"${s.trim()}"` : s.trim())).join(", "));
    }
    return JSON.stringify(val.map((item) => normalizeValue(item, mode)));
  }
  if (typeof val === "object") {
    if (Array.isArray(val.components) && val.components.length >= 3) {
      const rawCs = String(val.colorSpace || "srgb").toLowerCase();
      const cs = rawCs === "xyz" ? "xyz-d65" : rawCs;
      if (cs !== "srgb") {
        const rawAlpha =
          typeof val.alpha === "string" && /^none$/i.test(val.alpha.trim())
            ? 0
            : typeof val.alpha === "number" && Number.isFinite(val.alpha)
            ? Math.max(0, Math.min(1, val.alpha))
            : 1;
        const roundedObjA = Number(rawAlpha.toFixed(4));
        const hasVisibleAlpha = Math.abs(roundedObjA - 1) > 1e-6;
        const a = hasVisibleAlpha ? ` / ${roundedObjA}` : "";
        const fmtComp = (c) => {
          if (typeof c === "string" && /^none$/i.test(c.trim())) return 0;
          if (typeof c === "number" && Number.isFinite(c)) {
            const r = Number(c.toFixed(4));
            return Object.is(r, -0) ? 0 : r;
          }
          return c;
        };
        const body = `${val.components.map(fmtComp).join(" ")}${a}`;
        const formatted = normalizeCssNumberString(CSS_COLOR_FN_SPACES.has(cs) ? `color(${cs} ${body})` : `${cs}(${body})`);
        if (cs === "oklch" || cs === "oklab") {
          const okHex = okColorFuncToHex(formatted);
          if (okHex) return okHex;
        }
        if (cs === "hsl" || cs === "hsla") {
          const c0 = val.components[0] === "none" ? 0 : val.components[0];
          const c1 = val.components[1] === "none" ? 0 : val.components[1];
          const c2 = val.components[2] === "none" ? 0 : val.components[2];
          if ([c0, c1, c2].every((n) => typeof n === "number" && Number.isFinite(n))) {
            const hslHex = hslFuncToHex(normalizeCssNumberString(`hsl(${c0} ${c1}% ${c2}%${a})`));
            if (hslHex) return hslHex;
          }
        }
        const objA = hasVisibleAlpha ? roundedObjA : 1;
        const nNums = val.components.slice(0, 3).map((c) => (c === "none" ? 0 : c));
        if (nNums.every((n) => typeof n === "number" && Number.isFinite(n))) {
          if (CSS_COLOR_FN_SPACES.has(cs)) {
            const inGamut = colorSpaceInSrgbGamutToRgba(cs, nNums[0], nNums[1], nNums[2], objA);
            if (inGamut) return formatRgbaHexOrStr(inGamut);
          }
          if (cs === "hwb" || cs === "lab" || cs === "lch") {
            const normLabLchHwb = labLchHwbFuncToNormalized(formatted);
            if (normLabLchHwb) return normLabLchHwb;
          }
        }
        return formatted;
      }
      const nums = val.components.slice(0, 3).map((c) => (c === "none" ? 0 : c));
      if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
        return `${cs}(${val.components.join(", ")})`;
      }
      const isLegacy255 = nums.every((n) => n >= 0 && n <= 255) && nums.some((n) => n > 2);
      const scale = isLegacy255 ? 1 : 255;
      const toChan = (n) => Math.max(0, Math.min(255, Math.round(n * scale)));
      const [r, g, b] = [toChan(nums[0]), toChan(nums[1]), toChan(nums[2])];
      const alpha = typeof val.alpha === "number" && Number.isFinite(val.alpha) ? Math.max(0, Math.min(1, val.alpha)) : 1;
      const roundedAlpha = Number(alpha.toFixed(4));
      if (Math.abs(roundedAlpha - 1) > 1e-6) {
        return normalizeCssNumberString(`rgba(${r}, ${g}, ${b}, ${roundedAlpha})`);
      }
      const toHex = (n) => n.toString(16).padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    if (Object.prototype.hasOwnProperty.call(val, "value") && typeof val.unit === "string") {
      return normalizeCssNumberString(`${val.value}${val.unit}`);
    }
    if (isShadowTokenObj(val)) {
      const parts = [];
      if (val.inset) parts.push("inset");
      parts.push(normalizeValue(val.offsetX, mode) ?? "0");
      parts.push(normalizeValue(val.offsetY, mode) ?? "0");
      parts.push(val.blur != null ? normalizeValue(val.blur, mode) ?? "0" : "0");
      if (val.spread != null) {
        const spreadNorm = normalizeShadowString(normalizeValue(val.spread, mode), mode);
        if (spreadNorm && spreadNorm !== "0") parts.push(spreadNorm);
      }
      parts.push(normalizeValue(val.color, mode) ?? "#000000");
      return normalizeShadowString(normalizeCssNumberString(parts.filter(Boolean).join(" ")), mode);
    }
    const sorted = {};
    for (const k of Object.keys(val).sort()) {
      sorted[k] = normalizeValue(val[k], mode);
    }
    return JSON.stringify(sorted);
  }
  let s = normalizeCssNumberString(String(val));
  const lowerKw = s.toLowerCase();
  if (lowerKw === "transparent") return "rgba(0, 0, 0, 0)";
  if (/^[a-z]+$/i.test(lowerKw)) {
    const namedRgba = parseCssColorToRgba(lowerKw, mode);
    if (namedRgba) return formatRgbaHexOrStr(namedRgba);
  }
  const outerFn = /^light-dark\s*\(/i.test(s) ? parseOuterCssFunction(s) : null;
  if (outerFn?.fn === "light-dark") {
    const args = splitTopLevelCommas(outerFn.body);
    if (args.length === 2) {
      if (mode === "light" || mode === "dark") {
        return normalizeValue(mode === "dark" ? args[1] : args[0], mode);
      }
      const normL = normalizeValue(args[0], "light") ?? args[0].trim();
      const normD = normalizeValue(args[1], "dark") ?? args[1].trim();
      return normalizeCssNumberString(`light-dark(${normL}, ${normD})`);
    }
  }
  if (/^color-mix\s*\(/i.test(s)) {
    if (mode !== "light" && mode !== "dark" && /\blight-dark\s*\(/i.test(s)) {
      const normL = normalizeValue(s, "light");
      const normD = normalizeValue(s, "dark");
      if (normL && normD && normL !== normD) {
        return normalizeCssNumberString(`light-dark(${normL}, ${normD})`);
      }
      if (normL) return normL;
    }
    const mixRgba = parseCssColorToRgba(s, mode);
    if (mixRgba) return formatRgbaHexOrStr(mixRgba);
  }
  const rgbHex = rgbFuncToHex(s) || hslFuncToHex(s) || okColorFuncToHex(s) || cssColorFnToNormalized(s);
  if (rgbHex) return rgbHex;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{4}$/i.test(s)) {
    const r = Number.parseInt(s[1] + s[1], 16);
    const g = Number.parseInt(s[2] + s[2], 16);
    const b = Number.parseInt(s[3] + s[3], 16);
    const a = Number.parseInt(s[4] + s[4], 16);
    if (a === 255) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return normalizeCssNumberString(`rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(4))})`);
  }
  if (/^#[0-9a-f]{8}$/i.test(s)) {
    const r = Number.parseInt(s.slice(1, 3), 16);
    const g = Number.parseInt(s.slice(3, 5), 16);
    const b = Number.parseInt(s.slice(5, 7), 16);
    const a = Number.parseInt(s.slice(7, 9), 16);
    if (a === 255) return s.slice(0, 7);
    return normalizeCssNumberString(`rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(4))})`);
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
  const m = normalizeCssNumberString(v).match(/^(-?\d+(?:\.\d+)?)(px|rem|em)?$/i);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || "").toLowerCase();
  return unit === "rem" || unit === "em" ? num * 16 : num;
}

function parseDurationMs(v) {
  if (typeof v !== "string") return null;
  const m = normalizeCssNumberString(v).match(/^(-?\d+(?:\.\d+)?)(ms|s)$/i);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  return m[2].toLowerCase() === "s" ? num * 1000 : num;
}

function normalizeWeightOrFont(v) {
  if (typeof v !== "string") return v;
  const s = normalizeCssNumberString(v);
  if (FONT_WEIGHT_NAMES[s]) return FONT_WEIGHT_NAMES[s];
  const italicMatch = s.match(/^(.+?)\s+italic$/);
  if (italicMatch && FONT_WEIGHT_NAMES[italicMatch[1].trim()]) {
    return `${FONT_WEIGHT_NAMES[italicMatch[1].trim()]} italic`;
  }
  return s;
}

function extractPrimaryFont(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s.includes(",") && !/^["']/.test(s)) return null;
  if (/[()#]|^-?(?:\d|\.\d)/.test(s)) return null;
  return s.split(",")[0].trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

function isFontStackHint(v) {
  if (Array.isArray(v)) {
    return (
      v.length >= 2 &&
      v.every((x) => typeof x === "string" && x.trim().length > 0 && !/[()#]|^-?(?:\d|\.\d)/.test(x.trim()))
    );
  }
  const s = String(v || "").trim();
  return /["']|\b(?:sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy|-apple-system|blinkmacsystemfont|segoe ui)\b/i.test(s);
}

function parseRgbaColorStr(str) {
  if (typeof str !== "string") return null;
  const s = str.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) {
    return {
      r: Number.parseInt(s.slice(1, 3), 16),
      g: Number.parseInt(s.slice(3, 5), 16),
      b: Number.parseInt(s.slice(5, 7), 16),
      a: 1,
    };
  }
  const m = s.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/);
  if (m) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
  }
  return null;
}

function rgbaColorsClose(strA, strB) {
  const a = parseRgbaColorStr(strA);
  const b = parseRgbaColorStr(strB);
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) <= 0.5 / 255 + 1e-4;
}

function shadowsClose(shadowA, shadowB) {
  const layersA = splitTopLevelCommas(shadowA);
  const layersB = splitTopLevelCommas(shadowB);
  if (layersA.length !== layersB.length) return false;
  for (let i = 0; i < layersA.length; i++) {
    const tA = splitShadowTokens(layersA[i]);
    const tB = splitShadowTokens(layersB[i]);
    if (tA.length !== tB.length) return false;
    for (let j = 0; j < tA.length; j++) {
      if (tA[j] === tB[j]) continue;
      if (rgbaColorsClose(tA[j], tB[j])) continue;
      const pxA = parseLengthPx(tA[j]);
      const pxB = parseLengthPx(tB[j]);
      if (pxA !== null && pxB !== null && Math.abs(pxA - pxB) <= 1e-4) continue;
      return false;
    }
  }
  return true;
}

function isW3cDimensionObj(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (typeof obj.unit !== "string" || !obj.unit.trim()) return false;
  const numOk =
    (typeof obj.value === "number" && Number.isFinite(obj.value)) ||
    (typeof obj.value === "string" && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(obj.value.trim()));
  if (!numOk) return false;
  const allowedKeys = new Set(["value", "unit", "type", "description", "extensions"]);
  return Object.keys(obj).every((k) => k.startsWith("$") || allowedKeys.has(k));
}

function isW3cColorObj(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      typeof obj.colorSpace === "string" &&
      Array.isArray(obj.components) &&
      obj.components.length >= 3
  );
}

function isW3cStructuredValueObj(obj) {
  return isW3cDimensionObj(obj) || isW3cColorObj(obj) || isShadowTokenObj(obj);
}

function extractComparableCompositeObj(raw, norm) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !isW3cStructuredValueObj(raw)) {
    return raw;
  }
  if (typeof norm === "string" && norm.startsWith("{") && norm.endsWith("}")) {
    try {
      const parsed = JSON.parse(norm);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !isW3cStructuredValueObj(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

export function valuesMatch(fVal, dVal, mode = null) {
  if (fVal === dVal) return true;
  if (fVal == null || dVal == null) return false;
  const normA = normalizeValue(fVal, mode);
  const normB = normalizeValue(dVal, mode);
  if (normA === normB) return true;
  if (mode === null && typeof normA === "string" && typeof normB === "string") {
    const isLdA = /^light-dark\(/i.test(normA);
    const isLdB = /^light-dark\(/i.test(normB);
    if (isLdA !== isLdB) {
      return valuesMatch(
        isLdA ? normalizeValue(normA, "light") : normA,
        isLdB ? normalizeValue(normB, "light") : normB,
        "light"
      );
    }
  }
  const compA = extractComparableCompositeObj(fVal, normA);
  const compB = extractComparableCompositeObj(dVal, normB);
  if (compA && compB) {
    const keysA = Object.keys(compA).sort();
    const keysB = Object.keys(compB).sort();
    if (keysA.length === keysB.length && keysA.every((k, idx) => k === keysB[idx] && valuesMatch(compA[k], compB[k], mode))) {
      return true;
    }
  }
  if (typeof normA === "string" && normA.startsWith("[") && normA.endsWith("]") && typeof normB === "string" && normB.startsWith("[") && normB.endsWith("]")) {
    try {
      const arrA = JSON.parse(normA);
      const arrB = JSON.parse(normB);
      if (Array.isArray(arrA) && Array.isArray(arrB) && arrA.length === arrB.length && arrA.every((x, i) => valuesMatch(x, arrB[i], mode))) {
        return true;
      }
    } catch {}
  }
  if (typeof normA === "string" && typeof normB === "string" && rgbaColorsClose(normA, normB)) return true;
  if (typeof normA === "string" && typeof normB === "string" && looksLikeShadow(normA) && looksLikeShadow(normB)) {
    const snA = normalizeShadowString(normA, mode);
    const snB = normalizeShadowString(normB, mode);
    if (snA === snB || shadowsClose(snA, snB)) return true;
  }
  const msA = parseDurationMs(normA);
  const msB = parseDurationMs(normB);
  if (msA !== null && msB !== null && Math.abs(msA - msB) <= 0.1) return true;
  const pxA = parseLengthPx(normA);
  const pxB = parseLengthPx(normB);
  const hasLengthUnit = (s) => /(?:px|rem|em)$/i.test(String(s || "").trim());
  if (pxA !== null && pxB !== null && (hasLengthUnit(normA) || hasLengthUnit(normB)) && Math.abs(pxA - pxB) <= 0.05) {
    return true;
  }
  if (normalizeWeightOrFont(normA) === normalizeWeightOrFont(normB)) return true;
  const normAFontSrc = typeof normA === "string" ? normA : String(fVal);
  const normBFontSrc = typeof normB === "string" ? normB : String(dVal);
  const pfA = extractPrimaryFont(normAFontSrc);
  const pfB = extractPrimaryFont(normBFontSrc);
  const looksLikeFont = isFontStackHint(fVal) || isFontStackHint(dVal) || isFontStackHint(normAFontSrc) || isFontStackHint(normBFontSrc);
  if ((pfA !== null || pfB !== null) && looksLikeFont && (pfA ?? normAFontSrc.trim().toLowerCase()) === (pfB ?? normBFontSrc.trim().toLowerCase())) {
    return true;
  }
  return false;
}

function resolvePointerKey(refStr) {
  if (typeof refStr !== "string") return null;
  const s = refStr.trim();
  if (s.startsWith("#/")) {
    const segs = s
      .slice(2)
      .split("/")
      .filter(Boolean)
      .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"));
    const valIdx = segs.indexOf("$value");
    return normalizeKey((valIdx > 0 ? segs.slice(0, valIdx) : segs).filter((seg) => seg !== "$root").join("."));
  }
  return normalizeKey(s);
}

function getExtModes(node) {
  const ext = node?.$extensions ?? node?.extensions;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return null;
  const cand = ext.mode ?? ext.modes ?? ext["com.figma.mode"] ?? ext["org.designtokens.mode"];
  return cand && typeof cand === "object" && !Array.isArray(cand) && Object.keys(cand).length > 0 ? cand : null;
}

function hasNonMetaObjectChild(node) {
  return Object.entries(node).some(
    ([k, v]) =>
      !k.startsWith("$") &&
      k !== "type" &&
      k !== "description" &&
      k !== "extensions" &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
  );
}

function hasNestedTokenDescendant(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$") || k === "extensions") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (
        Object.prototype.hasOwnProperty.call(v, "$value") ||
        (Object.prototype.hasOwnProperty.call(v, "value") && !isW3cDimensionObj(v)) ||
        (Boolean(getExtModes(v)) && !hasNonMetaObjectChild(v)) ||
        hasNestedTokenDescendant(v)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsTokenRef(val) {
  if (typeof val === "string") return /\{[^}]+\}/.test(val);
  if (Array.isArray(val)) return val.some(containsTokenRef);
  if (val && typeof val === "object") {
    if (typeof val.$ref === "string") return true;
    return Object.values(val).some(containsTokenRef);
  }
  return false;
}

function flattenGenericTokens(node, prefix = [], out = new Map(), rawAliases = new Map(), compositeRaws = new Map(), knownModes = null, expanded = false) {
  const modeSet = knownModes || (out.__modes instanceof Set ? out.__modes : (out.__modes = new Set()));
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  if (!expanded) node = resolveDtcgExtends(node);
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
        (Object.prototype.hasOwnProperty.call(v, "value") && !isW3cDimensionObj(v)) ||
        hasNestedTokenDescendant(v))
  );
  const isUnwrappedStructuredLeaf =
    prefix.length > 0 && !hasDollarVal && !siblingHasToken && isW3cStructuredValueObj(node);
  const hasLegacyLeafVal =
    !isUnwrappedStructuredLeaf &&
    !siblingHasToken &&
    Object.prototype.hasOwnProperty.call(node, "value") &&
    (rawLegacyVal === null ||
      typeof rawLegacyVal !== "object" ||
      Array.isArray(rawLegacyVal) ||
      isW3cStructuredValueObj(rawLegacyVal) ||
      (!Object.prototype.hasOwnProperty.call(rawLegacyVal, "$value") &&
        !Object.prototype.hasOwnProperty.call(rawLegacyVal, "value") &&
        !hasNestedTokenDescendant(rawLegacyVal)));
  const hasVal = hasDollarVal || hasLegacyLeafVal || isUnwrappedStructuredLeaf;
  const hasRef = typeof node.$ref === "string";
  const extModes = getExtModes(node);
  const hasExtModeLeaf = prefix.length > 0 && Boolean(extModes) && !hasNonMetaObjectChild(node);
  if (hasVal || hasRef || hasExtModeLeaf) {
    const recordLeafVal = (targetKey, rawV) => {
      if (!targetKey) return;
      if (rawV && typeof rawV === "object" && typeof rawV.$ref === "string") {
        const ptr = resolvePointerKey(rawV.$ref);
        if (ptr) rawAliases.set(targetKey, ptr);
      } else if (typeof rawV === "string" && /^\{([^}]+)\}$/.test(rawV.trim())) {
        rawAliases.set(targetKey, normalizeKey(rawV.trim().slice(1, -1)).replace(/\.\$root$/i, ""));
      } else if ((typeof rawV === "object" && rawV !== null && containsTokenRef(rawV)) || (typeof rawV === "string" && /\{[^}]+\}/.test(rawV))) {
        compositeRaws.set(targetKey, rawV);
      } else {
        const norm = normalizeValue(rawV);
        if (norm !== null) out.set(targetKey, norm);
      }
    };
    const v = hasDollarVal ? node.$value : isUnwrappedStructuredLeaf ? node : hasLegacyLeafVal ? node.value : null;
    const key = normalizeKey(prefix.join("."));
    if (key) {
      if (hasRef) {
        const ptr = resolvePointerKey(node.$ref);
        if (ptr) rawAliases.set(key, ptr);
      } else if (hasVal) {
        recordLeafVal(key, v);
      }
      if (extModes) {
        for (const [mKey, mRaw] of Object.entries(extModes)) {
          const cleanMode = normalizeKey(mKey);
          if (!cleanMode) continue;
          modeSet.add(cleanMode);
          const keyBaseForMode = /^(?:light|dark)\./i.test(key) ? key.replace(/^(?:light|dark)\./i, "") : key;
          const modeLeafKey = key.startsWith(`${cleanMode}.`) ? key : `${cleanMode}.${keyBaseForMode}`;
          const unwrapped =
            mRaw &&
            typeof mRaw === "object" &&
            !Array.isArray(mRaw) &&
            (Object.prototype.hasOwnProperty.call(mRaw, "$value") ||
              (Object.prototype.hasOwnProperty.call(mRaw, "value") && !isW3cStructuredValueObj(mRaw)))
              ? Object.prototype.hasOwnProperty.call(mRaw, "$value")
                ? mRaw.$value
                : mRaw.value
              : mRaw;
          recordLeafVal(modeLeafKey, unwrapped);
        }
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$root" && v && typeof v === "object" && !Array.isArray(v)) {
      flattenGenericTokens(v, [...prefix], out, rawAliases, compositeRaws, modeSet, true);
      continue;
    }
    if (k.startsWith("$")) continue;
    if ((k === "type" || k === "description") && (v == null || typeof v !== "object")) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenGenericTokens(v, [...prefix, k], out, rawAliases, compositeRaws, modeSet, true);
    } else if (v != null && (typeof v === "string" || typeof v === "number")) {
      const key = normalizeKey([...prefix, k].join("."));
      const str = String(v).trim();
      if (/^\{([^}]+)\}$/.test(str)) {
        rawAliases.set(key, normalizeKey(str.slice(1, -1)).replace(/\.\$root$/i, ""));
      } else if (/\{[^}]+\}/.test(str)) {
        compositeRaws.set(key, str);
      } else {
        out.set(key, normalizeValue(str));
      }
    }
  }
  return out;
}

function resolveAliases(valuesMap, aliasesMap, fallbacksMap = new Map(), compositeRaws = null) {
  const canonValues = new Map();
  const canonAliases = new Map();
  const canonFallbacks = new Map();
  const canonComposites = new Map();
  for (const [k, v] of valuesMap.entries()) {
    const ck = canonKey(k);
    if (!canonValues.has(ck)) canonValues.set(ck, v);
  }
  for (const [k, t] of aliasesMap.entries()) {
    const ck = canonKey(k);
    if (!canonAliases.has(ck)) canonAliases.set(ck, canonKey(t));
  }
  for (const [k, fb] of fallbacksMap.entries()) {
    const ck = canonKey(k);
    if (!canonFallbacks.has(ck)) canonFallbacks.set(ck, fb);
  }
  if (compositeRaws) {
    for (const [k, rawV] of compositeRaws.entries()) {
      const ck = canonKey(k);
      if (!canonComposites.has(ck)) canonComposites.set(ck, rawV);
    }
  }

  const knownModes = new Set(["light", "dark"]);
  if (valuesMap.__modes instanceof Set) {
    for (const m of valuesMap.__modes) knownModes.add(canonKey(m));
  }
  const findModeSeg = (k, allowLeaf = false) => {
    const segs = canonKey(String(k || "")).split(".");
    const lim = allowLeaf ? segs.length : Math.max(0, segs.length - 1);
    for (let idx = 0; idx < lim; idx++) {
      const seg = segs[idx];
      if (seg && knownModes.has(seg.toLowerCase())) return seg;
    }
    return "";
  };
  const tryModeTargets = (rawTarget, modeHintKey, nextStack) => {
    if (!rawTarget) return null;
    const isModeExplicit = Boolean(findModeSeg(rawTarget, false));
    const hintSeg = findModeSeg(modeHintKey, true);
    const keyMode = hintSeg ? hintSeg.toLowerCase() : null;
    if (!isModeExplicit && keyMode) {
      let found = resolveOne(`${keyMode}.${rawTarget}`, nextStack);
      if (found !== null) return found;
      for (let dotIdx = rawTarget.indexOf("."); dotIdx !== -1; dotIdx = rawTarget.indexOf(".", dotIdx + 1)) {
        found = resolveOne(`${rawTarget.slice(0, dotIdx)}.${keyMode}.${rawTarget.slice(dotIdx + 1)}`, nextStack);
        if (found !== null) return found;
      }
      found = resolveOne(`${rawTarget}.${keyMode}`, nextStack);
      if (found !== null) return found;
    }
    let found = resolveOne(rawTarget, nextStack);
    if (found === null && !isModeExplicit) {
      const modeCandidates = keyMode ? [] : ["light", "dark"];
      for (const mk of modeCandidates) {
        found = resolveOne(`${mk}.${rawTarget}`, nextStack);
        if (found !== null) break;
        for (let dotIdx = rawTarget.indexOf("."); dotIdx !== -1; dotIdx = rawTarget.indexOf(".", dotIdx + 1)) {
          found = resolveOne(`${rawTarget.slice(0, dotIdx)}.${mk}.${rawTarget.slice(dotIdx + 1)}`, nextStack);
          if (found !== null) break;
        }
        if (found !== null) break;
        found = resolveOne(`${rawTarget}.${mk}`, nextStack);
        if (found !== null) break;
      }
    }
    return found;
  };

  const substituteRefs = (rawVal, nextStack, modeHintKey) => {
    if (typeof rawVal === "string") {
      const trimmed = rawVal.trim();
      if (/^\{([^}]+)\}$/.test(trimmed)) {
        const targetKey = normalizeKey(trimmed.slice(1, -1)).replace(/\.\$root$/i, "");
        const resolved = tryModeTargets(targetKey, modeHintKey, nextStack);
        return resolved !== null ? resolved : rawVal;
      }
      return rawVal.replace(/\{([^}]+)\}/g, (full, inner) => {
        const tk = normalizeKey(inner).replace(/\.\$root$/i, "");
        const resolved = tryModeTargets(tk, modeHintKey, nextStack);
        return resolved !== null ? String(resolved) : full;
      });
    }
    if (Array.isArray(rawVal)) return rawVal.map((item) => substituteRefs(item, nextStack, modeHintKey));
    if (rawVal && typeof rawVal === "object") {
      if (typeof rawVal.$ref === "string") {
        const ptr = resolvePointerKey(rawVal.$ref);
        if (ptr) {
          const resolved = tryModeTargets(ptr, modeHintKey, nextStack);
          if (resolved !== null) return resolved;
        }
      }
      const copy = {};
      for (const [ck2, cv2] of Object.entries(rawVal)) {
        copy[ck2] = substituteRefs(cv2, nextStack, modeHintKey);
      }
      return copy;
    }
    return rawVal;
  };

  const resolveCssVarsInComposite = (rawStr, nextStack) => {
    const s = String(rawStr || "");
    let out = "";
    let i = 0;
    while (i < s.length) {
      const m = /\bvar\(/i.exec(s.slice(i));
      if (!m) {
        out += s.slice(i);
        break;
      }
      const start = i + m.index;
      out += s.slice(i, start);
      let j = start + m[0].length;
      let d = 1;
      let q = null;
      let commaIdx = -1;
      while (j < s.length && d > 0) {
        const c = s[j];
        if (q) {
          if (c === "\\" && j + 1 < s.length) { j += 2; continue; }
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "(") d++;
        else if (c === ")") d--;
        else if (c === "," && d === 1 && commaIdx === -1) commaIdx = j;
        j++;
      }
      if (d !== 0) {
        out += s.slice(start);
        break;
      }
      const closeIdx = j - 1;
      const bodyStart = start + m[0].length;
      const namePart = (commaIdx === -1 ? s.slice(bodyStart, closeIdx) : s.slice(bodyStart, commaIdx)).trim();
      const fbPart = commaIdx === -1 ? null : s.slice(commaIdx + 1, closeIdx).trim();
      const nameM = /^--([a-zA-Z0-9_-]+)$/.exec(namePart);
      let resolved = null;
      if (nameM) {
        const vLower = nameM[1].toLowerCase();
        resolved = resolveOne(normalizeKey(vLower.replaceAll("-", ".")), nextStack) ?? resolveOne(normalizeKey(vLower), nextStack);
      }
      if (resolved === null && fbPart !== null) {
        resolved = resolveCssVarsInComposite(fbPart, nextStack);
      }
      out += resolved !== null ? String(resolved) : s.slice(start, j);
      i = j;
    }
    return out;
  };

  const resolveOne = (key, stack = []) => {
    if (valuesMap.has(key)) return valuesMap.get(key);
    const ck = canonKey(key);
    if (canonValues.has(ck)) return canonValues.get(ck);
    if (stack.includes(ck)) return null;
    const nextStack = [...stack, ck];
    if (compositeRaws && (compositeRaws.has(key) || canonComposites.has(ck))) {
      const rawComp = compositeRaws.has(key) ? compositeRaws.get(key) : canonComposites.get(ck);
      const modeSeg = findModeSeg(key, true).toLowerCase();
      const evalMode = modeSeg === "light" || modeSeg === "dark" ? modeSeg : null;
      if (rawComp && typeof rawComp === "object" && typeof rawComp.__cssVarComposite === "string") {
        const substituted = resolveCssVarsInComposite(rawComp.__cssVarComposite, nextStack);
        const norm = normalizeValue(substituted, evalMode);
        if (norm !== null) {
          valuesMap.set(key, norm);
          canonValues.set(ck, norm);
        }
        return norm;
      }
      const substituted = substituteRefs(rawComp, nextStack, key);
      const norm = normalizeValue(substituted, evalMode);
      if (norm !== null) {
        valuesMap.set(key, norm);
        canonValues.set(ck, norm);
      }
      return norm;
    }
    const target = aliasesMap.get(key) ?? canonAliases.get(ck);
    if (!target) return null;
    let val = tryModeTargets(target, key, nextStack);
    if (val === null) {
      const fbChain = fallbacksMap.get(key) ?? canonFallbacks.get(ck);
      const steps = Array.isArray(fbChain) ? fbChain : fbChain ? [fbChain] : [];
      for (const step of steps) {
        val = step.alias ? tryModeTargets(step.alias, key, nextStack) : step.literal ?? null;
        if (val !== null) break;
      }
    }
    if (val !== null) canonValues.set(ck, val);
    return val;
  };
  for (const k of aliasesMap.keys()) {
    const val = resolveOne(k);
    if (val !== null) valuesMap.set(k, val);
  }
  if (compositeRaws) {
    for (const k of compositeRaws.keys()) {
      resolveOne(k);
    }
  }
}

export function loadFigmaVariables(figmaPath) {
  const raw = JSON.parse(readFileSync(resolve(figmaPath), "utf8"));
  const out = new Map();
  const aliases = new Map();
  const composites = new Map();
  const root = raw.variables && typeof raw.variables === "object" ? raw.variables : raw;
  flattenGenericTokens(root, [], out, aliases, composites);
  resolveAliases(out, aliases, new Map(), composites);
  const figmaComponents = Array.isArray(raw.components) ? raw.components.map(String) : [];
  return { variables: out, components: figmaComponents };
}

const DARK_SELECTOR_RE =
  /(?:^|,|\s|\(|&)(?:html|body|:root)?(?:\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\s*=\s*["']?dark["']?(?:\s+[is])?\s*\]|\.(?:dark|uxs-dark)(?![a-zA-Z0-9_-]))/i;
const NON_DEFAULT_THEME_ATTR_RE =
  /\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\s*=\s*["']?([a-z0-9_-]+)["']?(?:\s+[is])?\s*\]/gi;

function stripBalancedPseudo(str, nameRe = /^:not\(/i) {
  const s = String(str || "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === ":" && nameRe.test(s.slice(i, i + 12))) {
      const open = s.indexOf("(", i);
      let d = 1;
      let q = null;
      let k = open + 1;
      while (k < s.length && d > 0) {
        const c = s[k];
        if (q) {
          if (c === "\\" && k + 1 < s.length) k++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "(") d++;
        else if (c === ")") d--;
        k++;
      }
      if (d === 0) {
        i = k;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

function containsNegatedLightPseudo(selStr) {
  const sInner = String(selStr || "");
  let j = 0;
  let q = null;
  while (j < sInner.length) {
    const ch = sInner[j];
    if (q) {
      if (ch === "\\" && j + 1 < sInner.length) j += 2;
      else {
        if (ch === q) q = null;
        j++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; j++; continue; }
    if (ch === ":" && /^:not\(/i.test(sInner.slice(j))) {
      const pOpen = j + 4;
      let pd = 1;
      let pq = null;
      let pk = pOpen + 1;
      while (pk < sInner.length && pd > 0) {
        const pc = sInner[pk];
        if (pq) {
          if (pc === "\\" && pk + 1 < sInner.length) pk++;
          else if (pc === pq) pq = null;
        } else if (pc === '"' || pc === "'") pq = pc;
        else if (pc === "(") pd++;
        else if (pc === ")") pd--;
        pk++;
      }
      const argInner = sInner.slice(pOpen + 1, pd === 0 ? pk - 1 : pk);
      if (/(?:\.light|\.uxs-light|\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\s*=\s*["']?light["']?(?:\s+[is])?\s*\])(?![a-zA-Z0-9_-])/i.test(argInner)) {
        return true;
      }
      j = pk;
      continue;
    }
    j++;
  }
  return false;
}

function isDarkSelectorHeader(hdr) {
  const raw = String(hdr || "").trim();
  if (!raw) return false;
  const rawBranches = splitTopLevelCommas(raw).map((b) => b.trim()).filter(Boolean);
  if (rawBranches.length === 0) return false;
  return rawBranches.every((rb) => {
    if (containsNegatedLightPseudo(rb)) return true;
    const clean = stripBalancedPseudo(rb, /^:not\(/i).trim();
    return Boolean(clean && DARK_SELECTOR_RE.test(clean));
  });
}

function isNonDefaultThemeSelectorHeader(hdr) {
  const raw = String(hdr || "").trim();
  if (!raw) return false;
  if (isDarkSelectorHeader(raw)) return true;
  const rawBranches = splitTopLevelCommas(raw).map((b) => b.trim()).filter(Boolean);
  if (rawBranches.length === 0) return false;
  return rawBranches.every((rb) => {
    if (containsNegatedLightPseudo(rb)) return true;
    const clean = stripBalancedPseudo(rb, /^:not\(/i).trim();
    if (!clean) return false;
    if (DARK_SELECTOR_RE.test(clean)) return true;
    let hasAltAttr = false;
    NON_DEFAULT_THEME_ATTR_RE.lastIndex = 0;
    for (const m of clean.matchAll(NON_DEFAULT_THEME_ATTR_RE)) {
      const val = String(m[1] || "").toLowerCase();
      if (val && val !== "light" && val !== "default") hasAltAttr = true;
    }
    return hasAltAttr;
  });
}

function isRootTokenSelectorHeader(hdr, parentIsRoot = false) {
  const clean = String(hdr || "").trim();
  if (!clean) return false;
  if (isNonDefaultThemeSelectorHeader(clean)) return false;
  if (/^@theme(?:\s+(?:inline|static|reference|default))*\b/i.test(clean)) return true;
  if (/^@(?:media|supports|layer|container|document|scope)\b/i.test(clean)) return false;
  const lightAttrReStr = "\\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\\s*=\\s*[\"']?(?:light|default)[\"']?(?:\\s+[is])?\\s*\\]";
  const rootBases = parentIsRoot
    ? `:root|:host|html|body|&(?![a-zA-Z0-9_-]|::)|(?:${lightAttrReStr}|\\.(?:light|uxs-light)(?![a-zA-Z0-9_-]))`
    : `:root|:host|html|body|(?:${lightAttrReStr}|\\.(?:light|uxs-light)(?![a-zA-Z0-9_-]))`;
  const baseRe = new RegExp(`^(?:${rootBases})`, "i");
  const isSingleRootBranch = (branch) => {
    const t = branch.trim();
    if (!t || isNonDefaultThemeSelectorHeader(t)) return false;
    let p = 0;
    const leadingFn = /^:(?:where|is)\(/i.exec(t);
    if (leadingFn) {
      const open = t.indexOf("(");
      let d = 1;
      let q = null;
      let k = open + 1;
      while (k < t.length && d > 0) {
        const c = t[k];
        if (q) {
          if (c === "\\" && k + 1 < t.length) k++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "(") d++;
        else if (c === ")") d--;
        k++;
      }
      if (d !== 0) return false;
      const inner = splitTopLevelCommas(t.slice(open + 1, k - 1)).map((s) => s.trim()).filter(Boolean);
      if (inner.length === 0 || !inner.every(isSingleRootBranch)) return false;
      p = k;
    } else {
      const baseM = baseRe.exec(t);
      if (!baseM) return false;
      p = baseM[0].length;
    }
    while (p < t.length) {
      const rest = t.slice(p);
      const attrM = /^\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)(?:\s*=\s*["']?(?:light|default)["']?(?:\s+[is])?\s*)?\]/i.exec(rest);
      if (attrM) {
        p += attrM[0].length;
        continue;
      }
      const clsM = /^\.(?:light|uxs-light)(?![a-zA-Z0-9_-])/i.exec(rest);
      if (clsM) {
        p += clsM[0].length;
        continue;
      }
      if (/^:(?:where|is|not)\(/i.exec(rest)) {
        const isNotPseudo = /^:not\(/i.test(rest);
        const open = p + rest.indexOf("(");
        let d = 1;
        let q = null;
        let k = open + 1;
        while (k < t.length && d > 0) {
          const c = t[k];
          if (q) {
            if (c === "\\" && k + 1 < t.length) k++;
            else if (c === q) q = null;
          } else if (c === '"' || c === "'") q = c;
          else if (c === "(") d++;
          else if (c === ")") d--;
          k++;
        }
        if (d !== 0) return false;
        const inner = t.slice(open + 1, k - 1);
        if (isNotPseudo) {
          if (/(?:\.light|\.uxs-light|\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\s*=\s*["']?light["']?(?:\s+[is])?\s*\])(?![a-zA-Z0-9_-])/i.test(inner)) {
            return false;
          }
        } else if (containsNegatedLightPseudo(inner)) {
          return false;
        }
        p = k;
        continue;
      }
      return false;
    }
    return true;
  };
  const branches = splitTopLevelCommas(clean).map((b) => b.trim()).filter(Boolean);
  return branches.length > 0 && branches.some(isSingleRootBranch) && branches.every((b) => isSingleRootBranch(b) || isNonDefaultThemeSelectorHeader(b));
}

function isRootDarkSelectorHeader(hdr, parentIsRoot = false) {
  const clean = String(hdr || "").trim();
  if (!clean || !isDarkSelectorHeader(clean)) return false;
  const darkAttrReStr = "\\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\\s*=\\s*[\"']?dark[\"']?(?:\\s+[is])?\\s*\\]";
  const darkBaseTokens = `${darkAttrReStr}|\\.(?:dark|uxs-dark)(?![a-zA-Z0-9_-])`;
  const rootDarkBases = parentIsRoot
    ? `:root|:host|html|body|&(?![a-zA-Z0-9_-]|::)|(?:${darkBaseTokens})`
    : `:root|:host|html|body|(?:${darkBaseTokens})`;
  const baseRe = new RegExp(`^(?:${rootDarkBases})`, "i");
  const isSingleDarkRoot = (branch) => {
    const t = branch.trim();
    if (!t || !isDarkSelectorHeader(t)) return false;
    let p = 0;
    const leadingFn = /^:(?:where|is)\(/i.exec(t);
    if (leadingFn) {
      const open = t.indexOf("(");
      let d = 1;
      let q = null;
      let k = open + 1;
      while (k < t.length && d > 0) {
        const c = t[k];
        if (q) {
          if (c === "\\" && k + 1 < t.length) k++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "(") d++;
        else if (c === ")") d--;
        k++;
      }
      if (d !== 0) return false;
      const inner = splitTopLevelCommas(t.slice(open + 1, k - 1)).map((s) => s.trim()).filter(Boolean);
      if (inner.length === 0 || !inner.every(isSingleDarkRoot)) return false;
      p = k;
    } else if (!(containsNegatedLightPseudo(t) && /^:(?:not|where|is)\(/i.test(t))) {
      const bm = baseRe.exec(t);
      if (!bm) return false;
      p = bm[0].length;
    }
    while (p < t.length) {
      const rest = t.slice(p);
      const attrM = /^\[data-(?:(?:uxs-|bs-)?theme|color-mode|mode)\s*=\s*["']?dark["']?(?:\s+[is])?\s*\]/i.exec(rest);
      if (attrM) {
        p += attrM[0].length;
        continue;
      }
      const clsM = /^\.(?:dark|uxs-dark)(?![a-zA-Z0-9_-])/i.exec(rest);
      if (clsM) {
        p += clsM[0].length;
        continue;
      }
      if (/^:(?:where|is|not)\(/i.exec(rest)) {
        const open = p + rest.indexOf("(");
        let d = 1;
        let q = null;
        let k = open + 1;
        while (k < t.length && d > 0) {
          const c = t[k];
          if (q) {
            if (c === "\\" && k + 1 < t.length) k++;
            else if (c === q) q = null;
          } else if (c === '"' || c === "'") q = c;
          else if (c === "(") d++;
          else if (c === ")") d--;
          k++;
        }
        if (d !== 0) return false;
        p = k;
        continue;
      }
      return false;
    }
    return true;
  };
  const branches = splitTopLevelCommas(clean).map((b) => b.trim()).filter(Boolean);
  return branches.length > 0 && branches.every(isSingleDarkRoot);
}

function extractSplitCssText(cssText) {
  const cleaned = stripCommentsPreservingLines(cssText);
  const rootOut = [];
  const scopedOut = [];
  const darkRootOut = [];
  const darkScopedOut = [];
  let idx = 0;
  let depth = 0;
  let skipDepth = null;
  let darkDepth = null;
  let curHeader = "";
  let pending = "";
  let quote = null;
  let interpDepth = 0;
  const scopeStack = [];

  const activeScope = () => {
    for (let k = scopeStack.length - 1; k >= 0; k--) {
      if (scopeStack[k] === "root" || scopeStack[k] === "scoped") return scopeStack[k];
    }
    return "root";
  };
  const targetBuf = () => {
    const sc = activeScope();
    if (darkDepth !== null) return sc === "scoped" ? darkScopedOut : darkRootOut;
    return sc === "scoped" ? scopedOut : rootOut;
  };

  while (idx < cleaned.length) {
    const ch = cleaned[idx];
    if (quote) {
      if (skipDepth === null) {
        pending += ch;
        curHeader += ch;
      }
      if (ch === "\\" && idx + 1 < cleaned.length) {
        idx++;
        if (skipDepth === null) {
          pending += cleaned[idx];
          curHeader += cleaned[idx];
        }
        if (cleaned[idx] === "\n") quote = null;
      } else if (ch === quote || ch === "\n") {
        quote = null;
      }
      idx++;
      continue;
    }
    if (ch === "\\" && idx + 1 < cleaned.length) {
      if (skipDepth === null) {
        pending += ch + cleaned[idx + 1];
        curHeader += ch + cleaned[idx + 1];
      }
      idx += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (skipDepth === null) {
        pending += ch;
        curHeader += ch;
      }
      idx++;
      continue;
    }
    if (ch === "#" && cleaned[idx + 1] === "{") {
      interpDepth++;
      if (skipDepth === null) {
        pending += "#{";
        curHeader += "#{";
      }
      idx += 2;
      continue;
    }
    if (interpDepth > 0) {
      if (ch === "{") interpDepth++;
      else if (ch === "}") interpDepth--;
      if (skipDepth === null) {
        pending += ch;
        curHeader += ch;
      }
      idx++;
      continue;
    }
    if (ch === "{") {
      depth++;
      const hdr = curHeader.trim();
      curHeader = "";
      pending = "";
      const isDarkMedia = /(?:@media[^{]*prefers-color-scheme\s*:\s*dark)/i.test(hdr);
      const isDarkSel = isDarkSelectorHeader(hdr);
      const isNonDefaultAlt = isNonDefaultThemeSelectorHeader(hdr) && !isDarkSel;
      if (skipDepth === null) {
        if (darkDepth === null && (isDarkMedia || isDarkSel)) {
          darkDepth = depth;
        } else if (isNonDefaultAlt) {
          skipDepth = depth;
        }
      }
      const parentIsRoot = scopeStack.some((k) => k === "root") && !scopeStack.includes("scoped");
      let nextKind = "scoped";
      if (isRootTokenSelectorHeader(hdr, parentIsRoot)) nextKind = "root";
      else if (/^@(?:media|supports|layer|container|document|scope)\b/i.test(hdr)) nextKind = "container";
      else if (darkDepth !== null && depth === darkDepth && isDarkSel && isRootDarkSelectorHeader(hdr, parentIsRoot) && !scopeStack.includes("scoped")) nextKind = "root";
      scopeStack.push(nextKind);
      if (skipDepth === null) targetBuf().push(" { ");
    } else if (ch === "}") {
      const wasSkipped = skipDepth !== null;
      const bufBeforeReset = wasSkipped ? null : targetBuf();
      if (skipDepth !== null && depth === skipDepth) skipDepth = null;
      if (darkDepth !== null && depth === darkDepth) darkDepth = null;
      depth = Math.max(0, depth - 1);
      curHeader = "";
      if (!wasSkipped && pending) bufBeforeReset.push(pending);
      pending = "";
      const popKind = scopeStack.pop();
      if (!wasSkipped) {
        const isDarkBuf = bufBeforeReset === darkRootOut || bufBeforeReset === darkScopedOut;
        if (popKind === "scoped") (isDarkBuf ? darkScopedOut : scopedOut).push(" }\n");
        else (isDarkBuf ? darkRootOut : rootOut).push(" }\n");
      }
    } else {
      if (ch === ";") {
        if (skipDepth === null && !/^\s*@(?:import|charset|namespace)\b/i.test(pending)) {
          targetBuf().push(`${pending};`);
        }
        pending = "";
        curHeader = "";
      } else if (skipDepth === null) {
        pending += ch;
        curHeader += ch;
      }
    }
    idx++;
  }
  if (skipDepth === null && pending) targetBuf().push(pending);
  return { rootCss: rootOut.join(""), scopedCss: scopedOut.join(""), darkRootCss: darkRootOut.join(""), darkScopedCss: darkScopedOut.join("") };
}

function parseOuterVarCall(rawVal) {
  const s = String(rawVal || "").trim();
  if (!/^var\s*\(/i.test(s) || !s.endsWith(")")) return null;
  const openIdx = s.indexOf("(");
  let depth = 0;
  let quote = null;
  let firstComma = -1;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        if (i !== s.length - 1) return null;
        break;
      }
    } else if (ch === "," && depth === 1 && firstComma === -1) {
      firstComma = i;
    }
  }
  if (depth !== 0) return null;
  const argStr = firstComma === -1 ? s.slice(openIdx + 1, -1) : s.slice(openIdx + 1, firstComma);
  const nameMatch = argStr.trim().match(/^--([a-zA-Z0-9_-]+)$/);
  if (!nameMatch) return null;
  const fallback = firstComma === -1 ? null : s.slice(firstComma + 1, -1).trim() || null;
  return { name: nameMatch[1], fallback };
}

function parseVarFallbackChain(rawVal) {
  const chain = [];
  let cur = String(rawVal || "").trim();
  while (cur) {
    const parsed = parseOuterVarCall(cur);
    if (!parsed) {
      const norm = normalizeValue(cur);
      if (norm !== null) chain.push({ literal: norm });
      break;
    }
    chain.push({ alias: normalizeKey(parsed.name.replaceAll("-", ".")) });
    cur = parsed.fallback ? parsed.fallback.trim() : "";
  }
  return chain;
}

function maskCssQuotedStringsPreservingLines(src) {
  const s = String(src || "");
  const chars = s.split("");
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        if (chars[i] !== "\n") chars[i] = " ";
        if (chars[i + 1] !== "\n") chars[i + 1] = " ";
        i++;
        continue;
      }
      if (ch === quote || ch === "\n") {
        if (chars[i] !== "\n") chars[i] = " ";
        quote = null;
        continue;
      }
      if (chars[i] !== "\n") chars[i] = " ";
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      chars[i] = " ";
    }
  }
  return chars.join("");
}

function extractCustomPropsFromSplitSlice(defaultCss, outMap, aliasesMap, fallbacksMap = new Map(), compositesMap = null, lockedKeys = new Set()) {
  const maskedCss = maskCssQuotedStringsPreservingLines(defaultCss);
  const canWrite = (k) => !lockedKeys.has(canonKey(k));
  const setAlias = (k, targetDot, fbChain) => {
    if (!canWrite(k)) return;
    aliasesMap.set(k, targetDot);
    outMap.delete(k);
    if (compositesMap) compositesMap.delete(k);
    if (fbChain) fallbacksMap.set(k, fbChain);
    else fallbacksMap.delete(k);
  };
  const setComposite = (k, rawVal) => {
    if (!canWrite(k)) return;
    compositesMap.set(k, { __cssVarComposite: rawVal });
    outMap.delete(k);
    aliasesMap.delete(k);
    fallbacksMap.delete(k);
  };
  const setLiteral = (k, norm) => {
    if (!canWrite(k)) return;
    outMap.set(k, norm);
    aliasesMap.delete(k);
    fallbacksMap.delete(k);
    if (compositesMap) compositesMap.delete(k);
  };
  for (const m of maskedCss.matchAll(/(?<![a-zA-Z0-9_.&-])--([a-zA-Z0-9_-]+)\s*:(?!:)/g)) {
    const varName = m[1];
    let idx = m.index + m[0].length;
    let quote = null;
    let scssInterp = 0;
    let parenDepth = 0;
    while (idx < defaultCss.length) {
      const ch = defaultCss[idx];
      if (quote) {
        if (ch === "\\" && idx + 1 < defaultCss.length) {
          idx += 2;
          continue;
        }
        if (ch === quote || ch === "\n") quote = null;
        idx++;
        continue;
      }
      if (scssInterp > 0) {
        if (ch === "{") scssInterp++;
        else if (ch === "}") scssInterp--;
        idx++;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#" && defaultCss[idx + 1] === "{") {
        scssInterp++;
        idx += 2;
        continue;
      } else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if ((ch === ";" && parenDepth === 0) || ch === "{" || ch === "}") break;
      idx++;
    }
    const rawSeg = defaultCss.slice(m.index + m[0].length, idx);
    const rawVal = rawSeg.trim().replace(/\s*!\s*important\s*$/i, "").replace(/\s+/g, " ");
    const dotKey = normalizeKey(varName.replaceAll("-", "."));
    const rawKey = normalizeKey(varName);
    const varParsed = parseOuterVarCall(rawVal);
    if (varParsed) {
      const targetDot = normalizeKey(varParsed.name.replaceAll("-", "."));
      const fbChain = varParsed.fallback ? parseVarFallbackChain(varParsed.fallback) : null;
      const validFb = fbChain && fbChain.length > 0 ? fbChain : null;
      setAlias(dotKey, targetDot, validFb);
      if (rawKey !== dotKey) setAlias(rawKey, targetDot, validFb);
      continue;
    }
    if (compositesMap && /\bvar\(\s*--[a-zA-Z0-9_-]+/i.test(rawVal)) {
      setComposite(dotKey, rawVal);
      if (rawKey !== dotKey) setComposite(rawKey, rawVal);
      continue;
    }
    const norm = normalizeValue(rawVal);
    if (norm === null) continue;
    setLiteral(dotKey, norm);
    if (rawKey !== dotKey) setLiteral(rawKey, norm);
  }
}

function collectMapKeys(out, aliases, composites) {
  return new Set([...out.keys(), ...aliases.keys(), ...(composites ? composites.keys() : [])].map(canonKey));
}

function extractCssCustomProperties(cssText, outMap, aliasesMap, fallbacksMap = new Map(), compositesMap = null) {
  const { rootCss, scopedCss } = extractSplitCssText(cssText);
  const initialLocked = collectMapKeys(outMap, aliasesMap, compositesMap);
  extractCustomPropsFromSplitSlice(rootCss, outMap, aliasesMap, fallbacksMap, compositesMap, initialLocked);
  const scopedLocked = collectMapKeys(outMap, aliasesMap, compositesMap);
  extractCustomPropsFromSplitSlice(scopedCss, outMap, aliasesMap, fallbacksMap, compositesMap, scopedLocked);
}

function canonFsPath(p) {
  try {
    return (realpathSync.native || realpathSync)(p);
  } catch {
    return resolve(p);
  }
}

export function loadDefinedTokens(tokensArg, excludeFiles = new Set()) {
  const abs = resolve(tokensArg);
  if (!existsSync(abs)) throw new Error(`Tokens target not found: ${abs}`);
  const canonExcludes = new Set([...excludeFiles].map(canonFsPath));
  const out = new Map();
  out.__modes = new Set();
  const aliases = new Map();
  const fallbacks = new Map();
  const composites = new Map();
  const st = statSync(abs);

  const rawJsonEntries = [];
  const seenJsonFiles = new Set();
  const cssTexts = [];

  const hasExtensionThemeModes = (node) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(hasExtensionThemeModes);
    const modeObj = getExtModes(node);
    if (modeObj && Object.keys(modeObj).some((mk) => /^(light|dark)$/i.test(mk))) {
      return true;
    }
    return Object.entries(node).some(([k, v]) => !k.startsWith("$") && v && typeof v === "object" && hasExtensionThemeModes(v));
  };

  const isRawTokenLeaf = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    if (
      Object.prototype.hasOwnProperty.call(obj, "$value") ||
      typeof obj.$ref === "string" ||
      isW3cStructuredValueObj(obj) ||
      (Boolean(getExtModes(obj)) && !hasNonMetaObjectChild(obj))
    ) {
      return true;
    }
    return Object.prototype.hasOwnProperty.call(obj, "value") && !hasNestedTokenDescendant(obj);
  };

  const mergeRawTokenTrees = (target, incoming) => {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return target;
    for (const [k, v] of Object.entries(incoming)) {
      const existing = target[k];
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !k.startsWith("$") &&
        k !== "extensions" &&
        !isRawTokenLeaf(existing) &&
        !isRawTokenLeaf(v)
      ) {
        mergeRawTokenTrees(existing, v);
      } else if (!Object.prototype.hasOwnProperty.call(target, k)) {
        target[k] = v && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : v;
      }
    }
    return target;
  };

  const queueTokenJson = (parsed, relForMode, sourcePath = null) => {
    if (sourcePath) {
      const cs = canonFsPath(sourcePath);
      if (seenJsonFiles.has(cs)) return;
      seenJsonFiles.add(cs);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const modeTarget = String(relForMode || "").replace(/\\/g, "/");
    const hasLightSeg = /(?:^|[/_.-])light(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
    const hasDarkSeg = /(?:^|[/_.-])dark(?:[/_.-]|\.tokens?\.json$|\.json$)/i.test(modeTarget);
    const hasLeadingRootMode = Object.keys(parsed).some((k) => /^(light|dark)$/i.test(k));
    const hasInternalModes = hasLeadingRootMode || hasExtensionThemeModes(parsed);
    const fileMode = hasLightSeg && hasDarkSeg ? null : hasInternalModes ? null : hasLightSeg ? "light" : hasDarkSeg ? "dark" : null;
    rawJsonEntries.push({ parsed, fileMode });
  };

  const scanDir = (dir) => {
    let rootReal;
    try {
      rootReal = realpathSync(dir);
    } catch {
      return;
    }
    const skip = new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      ".next",
      "coverage",
      "playwright-report",
      "test-results",
      "audit-output",
      "dsaf-audit-output",
      "draft",
      "storybook-static",
      "_audit",
      "_vendor",
      "_site",
      "src-tauri",
      "__pycache__",
      ".venv",
    ]);
    const visitedDirs = new Set();
    const walk = (cur) => {
      let realCur = cur;
      try {
        realCur = realpathSync(cur);
      } catch {
        return;
      }
      if (!isWithinRoot(realCur, rootReal)) return;
      if (visitedDirs.has(realCur)) return;
      visitedDirs.add(realCur);
      const entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = join(cur, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const realEntry = realpathSync(full);
            if (!isWithinRoot(realEntry, rootReal)) continue;
            const fst = statSync(full);
            isDir = fst.isDirectory();
            isFile = fst.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) {
          if (!e.name.startsWith(".")) walk(full);
          continue;
        }
        if (!isFile) continue;
        {
          if (canonExcludes.has(canonFsPath(full))) continue;
          const rel = relative(dir, full).replace(/\\/g, "/");
          if (/(^|\/)(?:tests?|__tests__|fixtures|__fixtures__|storybook-static|_audit|ios\/App\/App\/public|android\/app\/src\/main\/assets\/public)\//i.test(rel)) continue;
          if (/(?:\.test\.|\.spec\.|\.min\.|\.bundle\.)/i.test(rel)) continue;
          const low = e.name.toLowerCase();
          if (/(?:^|[._-])(?:test|mock|fixture)(?:$|[._-])/i.test(low)) continue;
          const isAuthTokenJson =
            low.endsWith(".json") &&
            (/(?:^|[._-])(?:auth|csrf|jwt|oauth|oa|session|refresh|access|api|secret|bearer|snooze|reset|verify|invite)(?:$|[._-])/i.test(low) ||
              /(?:^|[/_.-])(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer|snooze|reset|verify|invite)[/_.-]?tokens?(?:[._-][^/]*)?\.json$/i.test(rel) ||
              /(?:^|\/)(?:auth|oauth|oa|jwt|csrf|session|access|refresh|api|secret|bearer)\/.+\.json$/i.test(rel));
          if (isAuthTokenJson) continue;
          if (
            low.endsWith(".json") &&
            (/\.tokens\.json$/.test(low) ||
              /(?:^|[._-])tokens?(?:[._-][^/]*)?\.json$/.test(low) ||
              /(^|\/)(?:tokens|design-tokens)\/(?:.+\/)?[^/]+\.json$/i.test(rel)) &&
            !/(?:^|\/)(?:package|tsconfig[^/]*|.*schema.*|meta)\.json$/i.test(low)
          ) {
            try {
              const rawTokJson = readFileSync(full, "utf8");
              if (!hasDesignTokenEvidence(rawTokJson).valid) continue;
              const parsed = JSON.parse(rawTokJson);
              if (typeof parsed?.schema === "string" && parsed.schema.startsWith("dsaf-")) continue;
              queueTokenJson(parsed, rel, full);
            } catch {}
          } else if (low.endsWith(".css") || low.endsWith(".scss")) {
            cssTexts.push(readFileSync(full, "utf8"));
          }
        }
      }
    };
    walk(dir);
  };

  if (st.isDirectory()) {
    scanDir(abs);
  } else if (abs.toLowerCase().endsWith(".json")) {
    const json = JSON.parse(readFileSync(abs, "utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error(`Invalid tokens JSON '${abs}': must be a JSON object.`);
    }
    if (json.schema && String(json.schema).startsWith("dsaf-tokens/")) {
      if (json.target && existsSync(json.target) && statSync(json.target).isDirectory()) {
        scanDir(json.target);
      }
      if (Array.isArray(json.dtcgFiles)) {
        const manifestBase =
          json.target && existsSync(json.target) && statSync(json.target).isDirectory()
            ? json.target
            : dirname(abs);
        let manifestBaseReal = null;
        try {
          manifestBaseReal = realpathSync(manifestBase);
        } catch {
          manifestBaseReal = null;
        }
        for (const df of json.dtcgFiles) {
          if (!manifestBaseReal) continue;
          const p = resolve(manifestBase, String(df.file || ""));
          if (!existsSync(p)) continue;
          let realP;
          try {
            realP = realpathSync(p);
          } catch {
            continue;
          }
          if (!isWithinRoot(realP, manifestBaseReal)) continue;
          if (statSync(p).isFile() && !canonExcludes.has(canonFsPath(p))) {
            try {
              queueTokenJson(JSON.parse(readFileSync(p, "utf8")), df.file, p);
            } catch {}
          }
        }
      }
    } else if (!canonExcludes.has(canonFsPath(abs))) {
      queueTokenJson(json, basename(abs), abs);
    }
  } else if (!canonExcludes.has(canonFsPath(abs))) {
    cssTexts.push(readFileSync(abs, "utf8"));
  }

  // Pass 1: merge all token JSON trees before resolving cross-file $extends, then flatten & track mode-local aliases
  if (rawJsonEntries.length > 0) {
    const combinedRawTree = {};
    for (const { parsed, fileMode } of rawJsonEntries) {
      const rootForMerge = fileMode ? { [fileMode]: parsed } : parsed;
      mergeRawTokenTrees(combinedRawTree, rootForMerge);
    }
    const expandedTree = resolveDtcgExtends(combinedRawTree);
    flattenGenericTokens(expandedTree, [], out, aliases, composites, out.__modes, true);

    const modeLocalCanonKeys = { light: new Set(), dark: new Set() };
    for (const mapRef of [out, aliases, composites]) {
      for (const k of mapRef.keys()) {
        const m = /^(light|dark)\.(.+)$/i.exec(k);
        if (m) modeLocalCanonKeys[m[1].toLowerCase()].add(canonKey(m[2]));
      }
    }
    const hasExplicitModeKey = (k) =>
      /^(light|dark)(?:\.|$)/i.test(k) ||
      [...(out.__modes || [])].some((m) => {
        const cm = canonKey(m);
        const ck2 = canonKey(k);
        return ck2 === cm || ck2.startsWith(`${cm}.`);
      });
    for (const [k, target] of [...aliases.entries()]) {
      const m = /^(light|dark)\.(.+)$/i.exec(k);
      if (!m) continue;
      const fm = m[1].toLowerCase();
      if (!hasExplicitModeKey(target) && modeLocalCanonKeys[fm].has(canonKey(target))) {
        aliases.set(k, `${fm}.${target}`);
      }
    }
  }

  // Pass 2 & 3: merge all :root/@theme CSS custom properties before component-scoped rules
  const rootCssChunks = [];
  const scopedCssChunks = [];
  const darkRootCssChunks = [];
  const darkScopedCssChunks = [];
  for (const rawCss of cssTexts) {
    const { rootCss, scopedCss, darkRootCss, darkScopedCss } = extractSplitCssText(rawCss);
    if (rootCss) rootCssChunks.push(rootCss);
    if (scopedCss) scopedCssChunks.push(scopedCss);
    if (darkRootCss) darkRootCssChunks.push(darkRootCss);
    if (darkScopedCss) darkScopedCssChunks.push(darkScopedCss);
  }
  if (rootCssChunks.length > 0) {
    const lockedAfterDtcg = collectMapKeys(out, aliases, composites);
    extractCustomPropsFromSplitSlice(rootCssChunks.join("\n"), out, aliases, fallbacks, composites, lockedAfterDtcg);
  }
  if (scopedCssChunks.length > 0) {
    const lockedAfterRoot = collectMapKeys(out, aliases, composites);
    extractCustomPropsFromSplitSlice(scopedCssChunks.join("\n"), out, aliases, fallbacks, composites, lockedAfterRoot);
  }

  const baseOut = new Map(out);
  resolveAliases(out, aliases, fallbacks, composites);

  if (darkRootCssChunks.length > 0 || darkScopedCssChunks.length > 0) {
    const darkOut = new Map();
    const darkAliases = new Map();
    const darkFallbacks = new Map();
    const darkComposites = new Map();
    if (darkRootCssChunks.length > 0) {
      extractCustomPropsFromSplitSlice(darkRootCssChunks.join("\n"), darkOut, darkAliases, darkFallbacks, darkComposites, new Set());
    }
    if (darkScopedCssChunks.length > 0) {
      const lockedAfterDarkRoot = collectMapKeys(darkOut, darkAliases, darkComposites);
      extractCustomPropsFromSplitSlice(darkScopedCssChunks.join("\n"), darkOut, darkAliases, darkFallbacks, darkComposites, lockedAfterDarkRoot);
    }
    const darkKeys = new Set([...darkOut.keys(), ...darkAliases.keys(), ...darkComposites.keys()]);
    const mergedDarkOut = new Map([...baseOut, ...darkOut]);
    const mergedDarkAliases = new Map([...aliases, ...darkAliases]);
    const mergedDarkFallbacks = new Map([...fallbacks, ...darkFallbacks]);
    const mergedDarkComposites = new Map([...composites, ...darkComposites]);
    for (const dk of darkKeys) {
      if (darkOut.has(dk)) {
        mergedDarkAliases.delete(dk);
        mergedDarkFallbacks.delete(dk);
        mergedDarkComposites.delete(dk);
      } else if (darkAliases.has(dk)) {
        mergedDarkOut.delete(dk);
        mergedDarkComposites.delete(dk);
      } else if (darkComposites.has(dk)) {
        mergedDarkOut.delete(dk);
        mergedDarkAliases.delete(dk);
        mergedDarkFallbacks.delete(dk);
      }
    }
    resolveAliases(mergedDarkOut, mergedDarkAliases, mergedDarkFallbacks, mergedDarkComposites);
    const darkAffectedCanons = new Set([...darkKeys].map(canonKey));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [k, target] of mergedDarkAliases.entries()) {
        const ck = canonKey(k);
        if (darkAffectedCanons.has(ck)) continue;
        const fbSteps = mergedDarkFallbacks.get(k);
        const hitsDark =
          darkAffectedCanons.has(canonKey(target)) ||
          (Array.isArray(fbSteps) && fbSteps.some((st2) => st2?.alias && darkAffectedCanons.has(canonKey(st2.alias))));
        if (hitsDark) {
          darkAffectedCanons.add(ck);
          changed = true;
        }
      }
      for (const [k, rawV] of mergedDarkComposites.entries()) {
        const ck = canonKey(k);
        if (darkAffectedCanons.has(ck)) continue;
        const rawStr = rawV && typeof rawV === "object" && typeof rawV.__cssVarComposite === "string" ? rawV.__cssVarComposite : JSON.stringify(rawV);
        let hitsDark = false;
        for (const vm of String(rawStr || "").matchAll(/--([a-zA-Z0-9_-]+)/g)) {
          if (
            darkAffectedCanons.has(canonKey(normalizeKey(vm[1].replaceAll("-", ".")))) ||
            darkAffectedCanons.has(canonKey(normalizeKey(vm[1])))
          ) {
            hitsDark = true;
            break;
          }
        }
        if (!hitsDark) {
          for (const rm of String(rawStr || "").matchAll(/\{([^}]+)\}/g)) {
            if (darkAffectedCanons.has(canonKey(normalizeKey(rm[1])))) {
              hitsDark = true;
              break;
            }
          }
        }
        if (hitsDark) {
          darkAffectedCanons.add(ck);
          changed = true;
        }
      }
    }
    const resolvedDarkCss = new Map();
    for (const [dk, val] of mergedDarkOut.entries()) {
      if (/^light\./i.test(dk)) continue;
      if (darkAffectedCanons.has(canonKey(dk)) || !out.has(dk) || val !== out.get(dk)) {
        if (/^dark\./i.test(dk) && out.has(dk)) out.set(dk, val);
        resolvedDarkCss.set(dk, val);
      }
    }
    if (resolvedDarkCss.size > 0) {
      Object.defineProperty(out, "__darkCssTokens", { value: resolvedDarkCss, enumerable: false });
    }
  }
  return out;
}

function isWithinRoot(candReal, baseReal) {
  if (!candReal || !baseReal) return false;
  const normC = process.platform === "darwin" || process.platform === "win32" ? candReal.toLowerCase() : candReal;
  const normB = process.platform === "darwin" || process.platform === "win32" ? baseReal.toLowerCase() : baseReal;
  const baseWithSep = normB.endsWith(sep) ? normB : normB + sep;
  return normC === normB || normC.startsWith(baseWithSep);
}

export function scanCodeConnect(codeConnectDir) {
  if (!codeConnectDir) return null;
  const abs = resolve(codeConnectDir);
  if (!existsSync(abs)) throw new Error(`Code Connect directory not found: ${abs}`);
  const skip = new Set([".git", "node_modules", "dist", "build", ".next"]);
  const files = [];
  const mappedComponents = new Set();
  let batchEntriesCount = 0;

  let rootSt;
  let rootReal;
  try {
    rootSt = statSync(abs);
    rootReal = realpathSync(abs);
  } catch {
    return {
      directory: abs,
      codeConnectFiles: 0,
      batchEntriesCount: 0,
      mappedComponentsCount: 0,
      mappedComponents: [],
      files: [],
    };
  }
  const rootBoundary = rootSt.isDirectory() ? rootReal : dirname(rootReal);
  const visitedFiles = new Set();

  const scanFile = (full, relDisplay) => {
    const txt = readFileSync(full, "utf8");
    const cleanTxt = stripCommentsPreservingLines(txt);
    const found = new Set();

    for (const m of cleanTxt.matchAll(/\bfigma\.connect\b/g)) {
      let cur = m.index + m[0].length;
      while (cur < cleanTxt.length && /\s/.test(cleanTxt[cur])) cur++;
      if (cleanTxt[cur] === "<") {
        let angle = 1;
        let q = null;
        cur++;
        while (cur < cleanTxt.length && angle > 0) {
          const ch = cleanTxt[cur];
          if (q) {
            if (ch === "\\" && cur + 1 < cleanTxt.length) cur += 2;
            else {
              if (ch === q) q = null;
              cur++;
            }
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") q = ch;
          else if (ch === "<") angle++;
          else if (ch === ">" && cleanTxt[cur - 1] !== "=") angle--;
          cur++;
        }
        if (angle !== 0) continue;
        while (cur < cleanTxt.length && /\s/.test(cleanTxt[cur])) cur++;
      }
      if (cleanTxt[cur] !== "(") continue;
      cur++;
      while (cur < cleanTxt.length && /\s/.test(cleanTxt[cur])) cur++;
      const compM = /^([A-Za-z0-9_.]+)/.exec(cleanTxt.slice(cur, cur + 160));
      if (compM) {
        found.add(compM[1]);
      } else if (cleanTxt[cur] === '"' || cleanTxt[cur] === "'" || cleanTxt[cur] === "`") {
        let j = cur;
        let p = 1;
        let q = null;
        while (j < cleanTxt.length && p > 0) {
          const ch = cleanTxt[j];
          if (q) {
            if (ch === "\\" && j + 1 < cleanTxt.length) {
              j += 2;
              continue;
            }
            if (ch === q || (q !== "`" && ch === "\n")) q = null;
          } else if (ch === '"' || ch === "'" || ch === "`") {
            q = ch;
          } else if (ch === "(") {
            p++;
          } else if (ch === ")") {
            p--;
            if (p === 0) break;
          }
          j++;
        }
        const firstComma = (() => {
          let cq = null;
          for (let ci = cur; ci < j; ci++) {
            const c = cleanTxt[ci];
            if (cq) {
              if (c === "\\" && ci + 1 < j) { ci++; continue; }
              if (c === cq || (cq !== "`" && c === "\n")) cq = null;
            } else if (c === '"' || c === "'" || c === "`") cq = c;
            else if (c === ",") return ci;
          }
          return -1;
        })();
        const restBody = firstComma !== -1 ? cleanTxt.slice(firstComma + 1, j) : "";
        const propM = /(?:component|name|selector)\s*:\s*["']([A-Za-z0-9_.-]+)["']/i.exec(restBody);
        const tagMatches = [...restBody.matchAll(/<([A-Za-z][A-Za-z0-9_.-]*)(?=[\s/>])/g)].map((tm) => tm[1]);
        const preferredTag = tagMatches.find((t) => t.includes("-") || /^[A-Z]/.test(t)) || tagMatches[0];
        const fileStem = basename(full)
          .replace(/\.figma\.(?:batch\.)?(?:tsx?|jsx?|mjs|cjs)$/i, "")
          .replace(/[^A-Za-z0-9_.-]/g, "");
        if (propM && propM[1]) found.add(propM[1]);
        else if (preferredTag) found.add(preferredTag);
        else if (fileStem) found.add(fileStem);
      }
    }
    for (const m of txt.matchAll(/\/\/\s*component\s*=\s*([A-Za-z0-9_.-]+)/g)) {
      found.add(m[1]);
    }
    for (const m of cleanTxt.matchAll(/\bexport\s+default\s*\{/g)) {
      let cur = m.index + m[0].length;
      let depth = 1;
      let q = null;
      const objTopChars = [];
      while (cur < cleanTxt.length && depth > 0) {
        const ch = cleanTxt[cur];
        if (q) {
          if (ch === "\\" && cur + 1 < cleanTxt.length) {
            cur += 2;
            continue;
          }
          if (ch === q || (q !== "`" && ch === "\n")) q = null;
          if (depth === 1) objTopChars.push(ch);
          cur++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          q = ch;
          if (depth === 1) objTopChars.push(ch);
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
        } else if (depth === 1) {
          objTopChars.push(ch);
        }
        cur++;
      }
      const topOnly = objTopChars.join("");
      for (const idM of topOnly.matchAll(/(?:^|[,{;\s])(?:["']id["']|\bid\b)\s*:\s*["']([A-Za-z0-9_.-]+)["']/g)) {
        found.add(idM[1]);
      }
    }

    if (/\.figma\.batch\.(ts|tsx|js|jsx)$/i.test(full)) {
      const jsonPath = full.replace(/\.(ts|tsx|js|jsx)$/i, ".json");
      if (existsSync(jsonPath)) {
        let realBatchJson = null;
        try {
          realBatchJson = realpathSync(jsonPath);
        } catch {
          realBatchJson = null;
        }
        if (realBatchJson && isWithinRoot(realBatchJson, rootBoundary)) {
          try {
            const batchData = JSON.parse(readFileSync(realBatchJson, "utf8"));
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
    }

    const list = [...found].sort();
    for (const comp of list) mappedComponents.add(comp);
    files.push({ file: relDisplay.replace(/\\/g, "/"), connections: list });
  };

  if (rootSt.isFile()) {
    if (/\.figma(?:\.batch)?\.(ts|tsx|js|jsx)$/i.test(abs)) {
      visitedFiles.add(rootReal);
      scanFile(abs, abs.split(/[/\\]/).pop() || abs);
    }
  } else if (rootSt.isDirectory()) {
    const visitedDirs = new Set();
    const walk = (dir) => {
      let realDir;
      try {
        realDir = realpathSync(dir);
      } catch {
        return;
      }
      if (!isWithinRoot(realDir, rootReal)) return;
      if (visitedDirs.has(realDir)) return;
      visitedDirs.add(realDir);
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (skip.has(e.name)) continue;
        const full = join(dir, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const realEntry = realpathSync(full);
            if (!isWithinRoot(realEntry, rootReal)) continue;
            const st = statSync(full);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) {
          if (!e.name.startsWith(".")) walk(full);
          continue;
        }
        if (!isFile) continue;
        if (/\.figma(?:\.batch)?\.(ts|tsx|js|jsx)$/i.test(e.name)) {
          let realFile;
          try {
            realFile = realpathSync(full);
          } catch {
            continue;
          }
          if (!isWithinRoot(realFile, rootReal) || visitedFiles.has(realFile)) continue;
          visitedFiles.add(realFile);
          scanFile(full, relative(abs, full));
        }
      }
    };
    walk(abs);
  }
  return {
    directory: abs,
    codeConnectFiles: files.length,
    batchEntriesCount,
    mappedComponentsCount: mappedComponents.size,
    mappedComponents: [...mappedComponents].sort(),
    files,
  };
}

const STANDARD_TOKEN_CATEGORIES = new Set([
  "color", "colors", "colour", "font", "fonts", "typography", "space", "spacing",
  "size", "sizes", "radius", "radii", "shadow", "shadows", "border", "borders",
  "duration", "motion", "ease", "z", "zindex", "breakpoint", "breakpoints",
  "semantic", "primitive", "primitives", "surface", "text", "background", "bg",
  "light", "dark", "theme", "opacity", "line", "letter",
]);

function detectDominantPrefix(definedMap, figmaMap) {
  const uniqueCanons = new Set();
  for (const k of definedMap.keys()) {
    const canon = canonKey(k);
    if (canon) uniqueCanons.add(canon);
  }
  const total = uniqueCanons.size;
  if (total === 0) return null;
  const segCounts = new Map();
  for (const canon of uniqueCanons) {
    const dot = canon.indexOf(".");
    if (dot <= 0) continue;
    const seg = canon.slice(0, dot);
    segCounts.set(seg, (segCounts.get(seg) || 0) + 1);
  }
  let topSeg = null;
  let topCount = 0;
  for (const [seg, cnt] of segCounts.entries()) {
    if (cnt > topCount) {
      topSeg = seg;
      topCount = cnt;
    }
  }
  if (!topSeg || topCount / total < 0.6 || STANDARD_TOKEN_CATEGORIES.has(topSeg)) return null;
  const uniqueFigmaCanons = new Set();
  for (const k of figmaMap.keys()) {
    const ck = canonKey(k);
    if (ck) uniqueFigmaCanons.add(ck);
  }
  const figmaPrefixCount = [...uniqueFigmaCanons].filter((ck) => ck.startsWith(`${topSeg}.`)).length;
  if (uniqueFigmaCanons.size > 0 && figmaPrefixCount / uniqueFigmaCanons.size >= 0.1) return null;
  return topSeg;
}

export function compareVertices({ figmaPath, tokensArg, codeConnectDir = null, runtimePath = null, prefix = null }) {
  const absFigma = resolve(figmaPath);
  const figma = loadFigmaVariables(absFigma);
  const defined = loadDefinedTokens(tokensArg, new Set([canonFsPath(absFigma)]));
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

  const explicitPrefix = prefix ? canonKey(normalizeKey(prefix)).replace(/^\.+|\.+$/g, "") : null;
  const splitLeadingMode = (k) => {
    const m = /^(light|dark)\.(.+)$/i.exec(String(k || ""));
    return m ? { mode: m[1].toLowerCase(), rest: m[2] } : { mode: null, rest: String(k || "") };
  };
  const stripLeadingModeMap = (srcMap) => {
    const resMap = new Map();
    for (const [k, v] of srcMap.entries()) {
      const { rest } = splitLeadingMode(canonKey(k));
      if (rest && !resMap.has(rest)) resMap.set(rest, v);
    }
    return resMap;
  };
  const noModeDefined = stripLeadingModeMap(defined);
  const noModeFigma = stripLeadingModeMap(figma.variables);
  const definedPrefix =
    explicitPrefix ||
    detectDominantPrefix(defined, figma.variables) ||
    detectDominantPrefix(noModeDefined, noModeFigma) ||
    detectDominantPrefix(noModeDefined, figma.variables);
  const strippedDefinedForPrefix = new Map();
  for (const [dKey, dVal] of defined.entries()) {
    const ck = canonKey(dKey);
    const { mode, rest } = splitLeadingMode(ck);
    let bare = ck;
    if (definedPrefix && ck.startsWith(`${definedPrefix}.`)) {
      bare = ck.slice(definedPrefix.length + 1);
    } else if (definedPrefix && mode && rest.startsWith(`${definedPrefix}.`)) {
      bare = `${mode}.${rest.slice(definedPrefix.length + 1)}`;
    }
    if (!strippedDefinedForPrefix.has(bare)) strippedDefinedForPrefix.set(bare, dVal);
  }
  const noModeStrippedDefined = stripLeadingModeMap(strippedDefinedForPrefix);
  const figmaPrefix =
    explicitPrefix ||
    detectDominantPrefix(figma.variables, strippedDefinedForPrefix) ||
    detectDominantPrefix(noModeFigma, noModeStrippedDefined);
  const directLookup = new Map();
  const strippedLookup = new Map();
  for (const [dKey, dVal] of defined.entries()) {
    const ck = canonKey(dKey);
    if (!directLookup.has(dKey)) directLookup.set(dKey, { key: dKey, value: dVal });
    if (!directLookup.has(ck)) directLookup.set(ck, { key: dKey, value: dVal });
    const { mode, rest } = splitLeadingMode(ck);
    if (definedPrefix && ck.startsWith(`${definedPrefix}.`)) {
      const bareCanon = ck.slice(definedPrefix.length + 1);
      if (!strippedLookup.has(bareCanon)) strippedLookup.set(bareCanon, { key: dKey, value: dVal });
    } else if (definedPrefix && mode && rest.startsWith(`${definedPrefix}.`)) {
      const bareRest = rest.slice(definedPrefix.length + 1);
      const bareModeCanon = `${mode}.${bareRest}`;
      if (!strippedLookup.has(bareModeCanon)) strippedLookup.set(bareModeCanon, { key: dKey, value: dVal });
      if (!strippedLookup.has(bareRest)) strippedLookup.set(bareRest, { key: dKey, value: dVal });
    }
  }

  const darkCssMap = defined.__darkCssTokens instanceof Map ? defined.__darkCssTokens : null;
  const darkDirectLookup = new Map();
  const darkStrippedLookup = new Map();
  if (darkCssMap) {
    for (const [dKey, dVal] of darkCssMap.entries()) {
      const alreadyDark = /^dark\./i.test(dKey);
      const displayKey = alreadyDark ? dKey : `dark.${dKey}`;
      const lookupKeys = alreadyDark ? [dKey, dKey.slice(5)] : [dKey];
      for (const lk of lookupKeys) {
        const lck = canonKey(lk);
        if (!darkDirectLookup.has(lk)) darkDirectLookup.set(lk, { key: displayKey, value: dVal });
        if (!darkDirectLookup.has(lck)) darkDirectLookup.set(lck, { key: displayKey, value: dVal });
        if (definedPrefix && lck.startsWith(`${definedPrefix}.`)) {
          const bareCanon = lck.slice(definedPrefix.length + 1);
          if (!darkStrippedLookup.has(bareCanon)) darkStrippedLookup.set(bareCanon, { key: displayKey, value: dVal });
        }
      }
    }
  }

  const matchedTokens = [];
  const matchedPairs = [];
  const allResolvedPairs = [];
  const valueDrift = [];
  const designOnlyTokens = [];
  const matchedDefinedCanons = new Set();

  const lookupInMaps = (keyStr, dMap, sMap) => {
    const ck = canonKey(keyStr);
    const strippedCk = canonKey(stripPrimitivesSegment(ck));
    const bareFigma = figmaPrefix && ck.startsWith(`${figmaPrefix}.`) ? ck.slice(figmaPrefix.length + 1) : null;
    const bareStrippedFigma =
      figmaPrefix && strippedCk.startsWith(`${figmaPrefix}.`) ? strippedCk.slice(figmaPrefix.length + 1) : null;
    const { mode: ckMode, rest: ckRest } = splitLeadingMode(ck);
    const bareModeFigma =
      ckMode && figmaPrefix && ckRest.startsWith(`${figmaPrefix}.`) ? `${ckMode}.${ckRest.slice(figmaPrefix.length + 1)}` : null;
    const { mode: sckMode, rest: sckRest } = splitLeadingMode(strippedCk);
    const bareStrippedModeFigma =
      sckMode && figmaPrefix && sckRest.startsWith(`${figmaPrefix}.`)
        ? `${sckMode}.${sckRest.slice(figmaPrefix.length + 1)}`
        : null;
    const candidates = [
      keyStr,
      ck,
      stripPrimitivesSegment(keyStr),
      canonKey(stripPrimitivesSegment(keyStr)),
      stripPrimitivesSegment(ck),
      ...(bareFigma ? [bareFigma, stripPrimitivesSegment(bareFigma)] : []),
      ...(bareStrippedFigma && bareStrippedFigma !== bareFigma ? [bareStrippedFigma] : []),
      ...(bareModeFigma ? [bareModeFigma, stripPrimitivesSegment(bareModeFigma)] : []),
      ...(bareStrippedModeFigma && bareStrippedModeFigma !== bareModeFigma ? [bareStrippedModeFigma] : []),
    ];
    for (const cand of candidates) {
      if (dMap.has(cand)) return dMap.get(cand);
    }
    for (const cand of candidates) {
      if (sMap.has(cand)) return sMap.get(cand);
    }
    return null;
  };
  const resolveDefinedEntry = (fKey) => {
    if (fKey.startsWith("dark.") && darkCssMap) {
      const darkExactHit = lookupInMaps(fKey, darkDirectLookup, darkStrippedLookup);
      if (darkExactHit) return { ...darkExactHit, fromDarkCss: true };
    }
    const directHit = lookupInMaps(fKey, directLookup, strippedLookup);
    if (directHit) return { ...directHit, fromDarkCss: false };
    if (fKey.startsWith("dark.") && darkCssMap) {
      const darkHit = lookupInMaps(fKey.slice(5), darkDirectLookup, darkStrippedLookup);
      if (darkHit) return { ...darkHit, fromDarkCss: true };
    }
    if (fKey.startsWith("dark.")) {
      const darkBareHit = lookupInMaps(fKey.slice(5), directLookup, strippedLookup);
      if (darkBareHit && typeof darkBareHit.value === "string" && /\blight-dark\s*\(/i.test(darkBareHit.value)) {
        return { ...darkBareHit, fromDarkCss: false };
      }
    }
    if (fKey.startsWith("light.")) {
      const lightHit = lookupInMaps(fKey.slice(6), directLookup, strippedLookup);
      if (lightHit) return { ...lightHit, fromDarkCss: false };
    }
    if (!/^(?:light|dark)\./i.test(fKey)) {
      const ck = canonKey(fKey);
      const bareFKey = figmaPrefix && ck.startsWith(`${figmaPrefix}.`) ? ck.slice(figmaPrefix.length + 1) : fKey;
      const prefLightHit =
        lookupInMaps(`light.${fKey}`, directLookup, strippedLookup) ||
        (bareFKey !== fKey ? lookupInMaps(`light.${bareFKey}`, directLookup, strippedLookup) : null);
      if (prefLightHit) return { ...prefLightHit, fromDarkCss: false };
    }
    return null;
  };

  for (const [fKey, fVal] of [...figma.variables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const found = resolveDefinedEntry(fKey);
    if (!found) {
      designOnlyTokens.push({ key: fKey, figmaValue: fVal });
    } else {
      matchedDefinedCanons.add(canonKey(found.key));
      allResolvedPairs.push({ figmaKey: fKey, definedKey: found.key, value: found.value, fromDarkCss: Boolean(found.fromDarkCss) });
      const cmpMode = /^dark\./i.test(fKey) || found.fromDarkCss ? "dark" : /^light\./i.test(fKey) ? "light" : null;
      if (valuesMatch(fVal, found.value, cmpMode)) {
        matchedTokens.push({ key: fKey, value: found.value });
        matchedPairs.push({ figmaKey: fKey, definedKey: found.key, value: found.value });
      } else {
        valueDrift.push({ key: fKey, figmaValue: fVal, definedValue: found.value });
      }
    }
  }

  if (shippedSummary && shippedVarsRaw.size > 0) {
    const shippedNorm = new Map();
    const shippedCanonMap = new Map();
    for (const [cssVar, val] of shippedVarsRaw.entries()) {
      const nk = normalizeKey(cssVar);
      const ck = canonKey(nk);
      const normVal = normalizeValue(val);
      if (nk && !shippedNorm.has(nk)) shippedNorm.set(nk, { cssVar, value: normVal });
      if (ck && !shippedNorm.has(ck)) shippedNorm.set(ck, { cssVar, value: normVal });
      if (ck && !shippedCanonMap.has(ck)) shippedCanonMap.set(ck, { cssVar, value: normVal });
    }
    const shippedPrefix = detectDominantPrefix(shippedCanonMap, defined) || definedPrefix;
    const definedVsShippedPrefix = definedPrefix || detectDominantPrefix(defined, shippedCanonMap);
    if (shippedPrefix) {
      for (const [sCk, info] of shippedCanonMap.entries()) {
        if (sCk.startsWith(`${shippedPrefix}.`)) {
          const bareCanon = sCk.slice(shippedPrefix.length + 1);
          if (!shippedNorm.has(bareCanon)) shippedNorm.set(bareCanon, { cssVar: info.cssVar, value: info.value });
        }
      }
    }
    const isDarkModeKey = (k) => /^dark\./i.test(String(k || ""));
    const stripLightModePrefix = (k) => String(k || "").replace(/^light\./i, "");
    const noLightDefinedPrefix =
      definedVsShippedPrefix ||
      detectDominantPrefix(
        new Map([...defined.entries()].map(([dk, dv]) => [stripLightModePrefix(dk), dv])),
        shippedCanonMap
      );
    const seenDefined = new Set();
    for (const pair of allResolvedPairs) {
      const ck = canonKey(pair.definedKey);
      if (pair.fromDarkCss || (isDarkModeKey(ck) && !shippedNorm.has(ck))) continue;
      if (seenDefined.has(ck)) continue;
      seenDefined.add(ck);
      const noLightKey = stripLightModePrefix(pair.definedKey);
      const noLightCk = stripLightModePrefix(ck);
      const bareCk = definedVsShippedPrefix && ck.startsWith(`${definedVsShippedPrefix}.`) ? ck.slice(definedVsShippedPrefix.length + 1) : null;
      const bareNoLightCk =
        noLightDefinedPrefix && noLightCk.startsWith(`${noLightDefinedPrefix}.`)
          ? noLightCk.slice(noLightDefinedPrefix.length + 1)
          : null;
      const bareShippedCk = shippedPrefix && ck.startsWith(`${shippedPrefix}.`) ? ck.slice(shippedPrefix.length + 1) : null;
      const bareShippedNoLightCk =
        shippedPrefix && noLightCk.startsWith(`${shippedPrefix}.`) ? noLightCk.slice(shippedPrefix.length + 1) : null;
      const cands = [
        pair.definedKey,
        ck,
        stripPrimitivesSegment(pair.definedKey),
        canonKey(stripPrimitivesSegment(pair.definedKey)),
        stripPrimitivesSegment(ck),
        ...(noLightKey !== pair.definedKey ? [noLightKey, stripPrimitivesSegment(noLightKey), canonKey(stripPrimitivesSegment(noLightKey))] : []),
        ...(noLightCk !== ck ? [noLightCk, stripPrimitivesSegment(noLightCk)] : []),
        ...(bareCk ? [bareCk] : []),
        ...(bareNoLightCk ? [bareNoLightCk] : []),
        ...(bareShippedCk ? [bareShippedCk] : []),
        ...(bareShippedNoLightCk ? [bareShippedNoLightCk] : []),
      ];
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

  const uniqueDefinedCanons = new Set();
  for (const dKey of defined.keys()) uniqueDefinedCanons.add(canonKey(dKey));
  const totalFigma = figma.variables.size;
  const triangulationCoveragePct = totalFigma > 0 ? Number(((matchedTokens.length / totalFigma) * 100).toFixed(1)) : null;

  return {
    schema: "dsaf-figma-diff/1",
    generated: new Date().toISOString(),
    triangulationStatus: runtimePath ? "3-vertex (Designed <-> Defined <-> Shipped)" : "2-vertex (Designed <-> Defined)",
    summary: {
      figmaVariables: totalFigma,
      definedVariablesSampled: uniqueDefinedCanons.size,
      detectedPrefix: definedPrefix || figmaPrefix || null,
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

function buildShippedLookup(rt) {
  const shippedVarsRaw = new Map();
  const firstCheck = rt.files?.[0]?.checks?.[0];
  for (const f of rt.files || []) {
    if (f.computedVars && typeof f.computedVars === "object") {
      for (const [k, v] of Object.entries(f.computedVars)) {
        if (!shippedVarsRaw.has(k)) shippedVarsRaw.set(k, v);
      }
    }
  }
  return { shippedVarsRaw, firstCheck };
}

export function compareDefinedToShipped({ tokensArg, runtimePath, codeConnectDir = null, prefix = null }) {
  if (!runtimePath) {
    throw new Error("runtimePath is required for 2-vertex Defined <-> Shipped comparison.");
  }
  const defined = loadDefinedTokens(tokensArg);
  const codeConnect = scanCodeConnect(codeConnectDir);
  const rt = JSON.parse(readFileSync(resolve(runtimePath), "utf8"));
  const { shippedVarsRaw, firstCheck } = buildShippedLookup(rt);

  const shippedNorm = new Map();
  const shippedUnique = new Map();
  for (const [cssVar, val] of shippedVarsRaw.entries()) {
    const nk = normalizeKey(cssVar);
    const ck = canonKey(nk);
    const normVal = normalizeValue(val);
    if (nk && !shippedNorm.has(nk)) shippedNorm.set(nk, { cssVar, canon: ck, value: normVal });
    if (ck && !shippedNorm.has(ck)) shippedNorm.set(ck, { cssVar, canon: ck, value: normVal });
    if (ck && !shippedUnique.has(ck)) shippedUnique.set(ck, { cssVar, value: normVal });
  }

  const isDarkModeKey = (k) => /^dark\./i.test(String(k || ""));
  const stripLightModePrefix = (k) => String(k || "").replace(/^light\./i, "");
  const noLightDefined = new Map([...defined.entries()].map(([dk, dv]) => [stripLightModePrefix(dk), dv]));
  const noModeDefined = new Map([...defined.entries()].map(([dk, dv]) => [String(dk || "").replace(/^(?:light|dark)\./i, ""), dv]));
  const activePrefix = prefix
    ? canonKey(normalizeKey(prefix)).replace(/^\.+|\.+$/g, "")
    : detectDominantPrefix(defined, shippedUnique) ||
      detectDominantPrefix(noLightDefined, shippedUnique) ||
      detectDominantPrefix(noModeDefined, shippedUnique) ||
      detectDominantPrefix(shippedUnique, defined) ||
      detectDominantPrefix(shippedUnique, noLightDefined) ||
      detectDominantPrefix(shippedUnique, noModeDefined);
  if (activePrefix) {
    for (const [sCk, info] of shippedUnique.entries()) {
      if (sCk.startsWith(`${activePrefix}.`)) {
        const bareCanon = sCk.slice(activePrefix.length + 1);
        if (!shippedNorm.has(bareCanon)) shippedNorm.set(bareCanon, { cssVar: info.cssVar, canon: sCk, value: info.value });
      }
    }
  }

  const uniqueDefined = new Map();
  for (const [dKey, dVal] of [...defined.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fullCk = canonKey(dKey);
    if (isDarkModeKey(fullCk) && !shippedNorm.has(fullCk)) continue;
    const noLightCk = stripLightModePrefix(fullCk);
    const bareKey = activePrefix && noLightCk.startsWith(`${activePrefix}.`) ? noLightCk.slice(activePrefix.length + 1) : noLightCk;
    if (!uniqueDefined.has(bareKey) || (dKey.includes(".") && !uniqueDefined.get(bareKey).key.includes("."))) {
      uniqueDefined.set(bareKey, { key: dKey, bareKey, canon: fullCk, noLightCanon: noLightCk, value: dVal });
    }
  }

  const matchedTokens = [];
  const valueDrift = [];
  const definedNotShipped = [];
  const matchedShippedCanons = new Set();

  for (const entry of uniqueDefined.values()) {
    const noLightKey = stripLightModePrefix(entry.key);
    const noLightCk = entry.noLightCanon || stripLightModePrefix(entry.canon);
    const barePrefix = activePrefix && entry.canon.startsWith(`${activePrefix}.`) ? entry.canon.slice(activePrefix.length + 1) : null;
    const bareNoLightPrefix = activePrefix && noLightCk.startsWith(`${activePrefix}.`) ? noLightCk.slice(activePrefix.length + 1) : null;
    const cands = [
      entry.key,
      entry.canon,
      stripPrimitivesSegment(entry.key),
      canonKey(stripPrimitivesSegment(entry.key)),
      stripPrimitivesSegment(entry.canon),
      ...(noLightKey !== entry.key ? [noLightKey, stripPrimitivesSegment(noLightKey), canonKey(stripPrimitivesSegment(noLightKey))] : []),
      ...(noLightCk !== entry.canon ? [noLightCk, stripPrimitivesSegment(noLightCk)] : []),
      ...(barePrefix ? [barePrefix] : []),
      ...(bareNoLightPrefix ? [bareNoLightPrefix] : []),
    ];
    let hit = null;
    for (const c of cands) {
      if (shippedNorm.has(c)) {
        hit = shippedNorm.get(c);
        break;
      }
    }
    if (!hit) {
      definedNotShipped.push({ key: entry.canon, definedValue: entry.value });
    } else {
      matchedShippedCanons.add(hit.canon);
      const cmpShippedMode = isDarkModeKey(entry.canon) ? "dark" : /^light\./i.test(entry.canon) ? "light" : null;
      if (valuesMatch(entry.value, hit.value, cmpShippedMode)) {
        matchedTokens.push({ key: entry.canon, cssVar: hit.cssVar, value: entry.value });
      } else {
        valueDrift.push({
          key: entry.canon,
          cssVar: hit.cssVar,
          definedValue: entry.value,
          shippedValue: hit.value,
        });
      }
    }
  }

  const shippedOnlyTokens = [];
  for (const [sCk, info] of shippedUnique.entries()) {
    if (!matchedShippedCanons.has(sCk)) {
      shippedOnlyTokens.push({ key: sCk, cssVar: info.cssVar, shippedValue: info.value });
    }
  }

  const totalDefined = uniqueDefined.size;
  const shippedCoveragePct = totalDefined > 0 ? Number(((matchedTokens.length / totalDefined) * 100).toFixed(1)) : null;

  return {
    schema: "dsaf-figma-diff/1",
    generated: new Date().toISOString(),
    triangulationStatus: "2-vertex (Defined <-> Shipped)",
    summary: {
      figmaVariables: 0,
      definedVariablesSampled: totalDefined,
      detectedPrefix: activePrefix,
      matchedCount: matchedTokens.length,
      valueDriftCount: valueDrift.length,
      designOnlyCount: 0,
      codeOnlyCount: shippedOnlyTokens.length,
      shippedOnlyCount: shippedOnlyTokens.length,
      definedNotShippedCount: definedNotShipped.length,
      shippedVarsSampled: shippedVarsRaw.size,
      triangulationCoveragePct: shippedCoveragePct,
    },
    matchedTokens,
    valueDrift,
    designOnlyTokens: [],
    codeOnlyTokens: [],
    shippedOnlyTokens: shippedOnlyTokens.slice(0, 40),
    codeConnect,
    shippedSummary: {
      schema: rt.schema || null,
      allPassed: Boolean(rt.allPassed),
      filesAudited: rt.files?.length ?? 0,
      apcaBodyMin: firstCheck?.apca?.minBodyLc ?? null,
      buttonSignatures: firstCheck?.componentInventory?.buttons?.distinctSignatures ?? null,
      shippedVarsSampled: shippedVarsRaw.size,
      shippedMatchedCount: matchedTokens.length,
      shippedDriftCount: valueDrift.length,
      shippedDrift: valueDrift.map((d) => ({
        key: d.key,
        cssVar: d.cssVar,
        definedValue: d.definedValue,
        shippedValue: d.shippedValue,
      })),
      definedNotShippedCount: definedNotShipped.length,
      definedNotShipped: definedNotShipped.slice(0, 25),
    },
  };
}

export function renderMarkdown(res) {
  const s = res.summary;
  const isDefinedToShipped = String(res.triangulationStatus || "").includes("Defined <-> Shipped");
  const isTwoVertexFigma = String(res.triangulationStatus || "").startsWith("2-vertex") && !isDefinedToShipped;
  const lines = [
    isDefinedToShipped
      ? "# DSAF 2-Vertex Token Triangulation Report (`Defined` <-> `Shipped`)"
      : isTwoVertexFigma
      ? "# DSAF 2-Vertex Figma Triangulation Report"
      : "# DSAF 3-Vertex Figma Triangulation Report",
    "",
    `- **Status:** ${res.triangulationStatus}`,
    isDefinedToShipped
      ? `- **Shipped Coverage:** ${s.triangulationCoveragePct == null ? "N/A" : `${s.triangulationCoveragePct}%`} (${s.matchedCount}/${s.definedVariablesSampled} defined tokens matched in shipped DOM)${s.detectedPrefix ? ` | Prefix: \`--${s.detectedPrefix}-*\`` : ""}`
      : `- **Triangulation Coverage:** ${s.triangulationCoveragePct == null ? "N/A" : `${s.triangulationCoveragePct}%`} (${s.matchedCount}/${s.figmaVariables} exact/equivalent matches)${s.detectedPrefix ? ` | Prefix: \`--${s.detectedPrefix}-*\`` : ""}`,
    isDefinedToShipped
      ? `- **Value Drift:** ${s.valueDriftCount} | **Defined-Not-Shipped:** ${s.definedNotShippedCount ?? 0} | **Shipped-Only:** ${s.codeOnlyCount}`
      : `- **Value Drift:** ${s.valueDriftCount} | **Design-Only:** ${s.designOnlyCount} | **Code-Only:** ${s.codeOnlyCount}`,
    "",
  ];
  if (res.valueDrift.length > 0 && !isDefinedToShipped) {
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

    // 4. 2-Vertex Defined <-> Shipped without Figma
    const twoVertex = compareDefinedToShipped({
      tokensArg: repoCssPath,
      runtimePath: runtimeJsonPath,
      codeConnectDir: join(repoDir, "src/figma"),
    });
    assert.equal(twoVertex.triangulationStatus, "2-vertex (Defined <-> Shipped)");
    assert.equal(twoVertex.summary.definedVariablesSampled, 7);
    assert.equal(twoVertex.summary.matchedCount, 1);
    assert.equal(twoVertex.summary.valueDriftCount, 1);
    assert.equal(twoVertex.summary.definedNotShippedCount, 5);
    assert.match(renderMarkdown(twoVertex), /2-Vertex Token Triangulation Report/);

    // 5. Round 1 regressions: value drift vs normalization (rgb, cubic-bezier, ms/s, .5rem),
    // nested tokens/color.json dir loading, --prefix ds on --ds-color-brand-primary, standard category preservation,
    // multiline CSS vars, and single-file scanCodeConnect
    assert.equal(valuesMatch("rgb(255, 0, 0)", "rgb(255, 255, 255)"), false, "rgb red vs white must drift");
    assert.equal(valuesMatch("cubic-bezier(0.4, 0, 0.2, 1)", "cubic-bezier(0.4, 1, 1, 1)"), false, "different bezier curves must drift");
    assert.equal(valuesMatch("150ms", ".15s"), true, "150ms and .15s must match");
    assert.equal(valuesMatch(".5rem", "0.5rem"), true, ".5rem and 0.5rem must match");
    assert.equal(valuesMatch("cubic-bezier(.4, 0, .2, 1)", "cubic-bezier(0.4, 0, 0.2, 1)"), true, "leading zero cubic-bezier must match");
    assert.equal(valuesMatch("#ff0000", "rgb(255, 0, 0)"), true, "hex and rgb must match");

    const tokDirRepo = join(scratch, "tok-dir-repo");
    mkdirSync(join(tokDirRepo, "packages/ui/tokens"), { recursive: true });
    writeFileSync(
      join(tokDirRepo, "packages/ui/tokens/color.json"),
      JSON.stringify({
        color: {
          brand: { primary: { $type: "color", $value: "#1d4ed8" } },
          text: { description: { $type: "color", $value: "#475569" } },
        },
        motion: { fast: { $type: "duration", $value: "180ms" } },
      })
    );
    writeFileSync(
      join(tokDirRepo, "packages/ui/extra.css"),
      `.dark-card { color: #111; }\n:root {\n  --shadow-lg:\n    0 4px 6px rgba(0, 0, 0, 0.1),\n    0 2px 4px rgba(0, 0, 0, 0.06);\n}\n`
    );
    const rtPrefixPath = join(scratch, "rt-prefix.json");
    writeFileSync(
      rtPrefixPath,
      JSON.stringify({
        schema: "dsaf-runtime/2",
        allPassed: true,
        files: [
          {
            file: "index.html",
            computedVars: {
              "--ds-color-brand-primary": "#1d4ed8",
              "--ds-color-text-description": "#475569",
              "--ds-motion-fast": ".18s",
              "--ds-shadow-lg": "0 4px 6px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06)",
            },
            checks: [],
          },
        ],
      })
    );
    const prefixTwo = compareDefinedToShipped({ tokensArg: tokDirRepo, runtimePath: rtPrefixPath, prefix: "ds" });
    assert.equal(prefixTwo.summary.matchedCount, 4, "Prefix --ds- must match DTCG color + duration .18s/180ms + multiline shadow");
    assert.equal(prefixTwo.summary.valueDriftCount, 0);
    assert.equal(scanCodeConnect(join(repoDir, "src/figma/Card.figma.ts")).mappedComponentsCount, 1, "Single-file scanCodeConnect must work");

    // 6. Round 2 regressions: 2-vertex Designed<->Defined markdown Value Drift, CSS var(--x, #fallback) vs defined --x,
    // ancestor dirs named /tests/ or /tokens/, quoted dark header brace, compound var() + BEM selector, sRGB alpha & unitless drift
    const md2 = renderMarkdown(diff);
    assert.match(md2, /2-Vertex Figma Triangulation Report/, "2-vertex Designed<->Defined must render Figma report header");
    assert.match(md2, /## Value Drift \(`Designed` vs `Defined`\)/, "2-vertex Designed<->Defined must render Value Drift table");

    const r2Root = join(scratch, "tests/ancestor-tokens/tokens/proj");
    mkdirSync(join(r2Root, "styles"), { recursive: true });
    writeFileSync(join(r2Root, "figma.json"), JSON.stringify({
      color: {
        brand: { $type: "color", $value: "#1d4ed8" },
        alpha: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.1 } },
      },
      metric: { value: { ok: { $type: "color", $value: "#16a34a" } } },
    }));
    writeFileSync(
      join(r2Root, "styles/base.css"),
      [
        ':root { --color-blue-500: #1d4ed8; --color-brand: var(--color-blue-500, #999999); --color-alpha: rgba(0, 0, 0, 0.1); --metric-value-ok: #16a34a; --border: var(--bw, 1px) solid var(--bc); --dark-open: "}"; }',
        '.btn--primary:hover { color: #1d4ed8; }',
      ].join("\n")
    );
    const r2Diff = compareVertices({ figmaPath: join(r2Root, "figma.json"), tokensArg: r2Root });
    assert.equal(r2Diff.summary.matchedCount, 3, "Resolved var() alias, sRGB alpha, and nested `value` group must all match");
    assert.equal(r2Diff.summary.valueDriftCount, 0);
    assert.ok(!r2Diff.codeOnlyTokens.some((t) => t.key === "primary"), "BEM .btn--primary:hover must not emit `primary` token");
    assert.equal(valuesMatch("0.1", "0.15"), false, "Unitless numeric opacity drift must not match");
    assert.equal(valuesMatch("color, opacity", "color, transform"), false, "Transition comma lists must not collapse to first item");

    // 7. Round 3 regressions: SCSS // comments & compact CSS {}, :root var alias not clobbered by .promo literal,
    // oklch space-separated + alpha, case-insensitive .JSON single file
    const r3CompactCss = `:root{--color-bg:#ffffff;--color-brand:var(--color-blue-500);--color-blue-500:#1d4ed8}.promo{--color-brand:#ff00aa;}.card{color:red;}\n`;
    const r3Scss = `:root {\n  // --color-accent: #ff0000;\n  --color-accent: #16a34a;\n}\n.btn { &--primary:hover { opacity: 0.8; } }\n`;
    const r3Dir = join(scratch, "r3-figma");
    mkdirSync(r3Dir, { recursive: true });
    writeFileSync(join(r3Dir, "a.css"), r3CompactCss);
    writeFileSync(join(r3Dir, "b.scss"), r3Scss);
    const upperJsonPath = join(scratch, "UpperCase.JSON");
    writeFileSync(upperJsonPath, JSON.stringify({ color: { ok: { $type: "color", $value: "#16a34a" } } }));
    const r3LoadedCss = loadDefinedTokens(r3Dir);
    assert.equal(r3LoadedCss.get("color.bg"), "#ffffff");
    assert.equal(r3LoadedCss.get("color.brand"), "#1d4ed8", "Later .promo literal must not clobber :root var() alias");
    assert.equal(r3LoadedCss.get("color.accent"), "#16a34a", "SCSS // comment must not shadow active CSS var");
    assert.equal(r3LoadedCss.has("primary"), false, "SCSS &--primary must not register token");
    assert.equal(loadDefinedTokens(upperJsonPath).get("color.ok"), "#16a34a", "Uppercase .JSON file must parse as JSON");
    assert.equal(valuesMatch({ colorSpace: "oklch", components: [0.55, 0.18, 250] }, "oklch(0.55 0.18 250)"), true);
    assert.equal(
      valuesMatch({ colorSpace: "oklch", components: [0.55, 0.18, 250], alpha: 0.5 }, { colorSpace: "oklch", components: [0.55, 0.18, 250], alpha: 1 }),
      false
    );

    // 8. Round 4 regressions: display-p3 color() formatting, #/.../$value JSON pointer, skip dsaf-audit-output & dsaf-tokens/2
    assert.equal(
      valuesMatch({ colorSpace: "display-p3", components: [0.9, 0.2, 0.1] }, "color(display-p3 0.9 0.2 0.1)"),
      true,
      "Non-sRGB display-p3 DTCG object must format as color(display-p3 ...)"
    );
    const r4Root = join(scratch, "r4-figma");
    mkdirSync(join(r4Root, "dsaf-audit-output"), { recursive: true });
    mkdirSync(join(r4Root, "src"), { recursive: true });
    writeFileSync(
      join(r4Root, "dsaf-audit-output/tokens.json"),
      JSON.stringify({ schema: "dsaf-tokens/2", target: ".", drift: { hardcodedColorHits: 0 } })
    );
    writeFileSync(
      join(r4Root, "src/tokens.tokens.json"),
      JSON.stringify({
        primitive: { blue: { $type: "color", $value: "#1d4ed8" } },
        semantic: { brand: { $type: "color", $value: { $ref: "#/primitive/blue/$value" } } },
      })
    );
    const r4Loaded = loadDefinedTokens(r4Root);
    assert.equal(r4Loaded.get("semantic.brand"), "#1d4ed8", "JSON Pointer /$value suffix must resolve alias");
    assert.equal(r4Loaded.has("schema"), false, "Must never flatten dsaf-tokens/2 report keys into defined tokens");

    // 9. Round 5 regressions: W3C DTCG composite tokens (shadow, typography, composite arrays) must not normalize to [object Object]
    assert.equal(
      valuesMatch(
        { offsetX: "0px", offsetY: "1px", blur: "2px", color: "#000000" },
        { offsetX: "10px", offsetY: "20px", blur: "40px", color: "#ff0000" }
      ),
      false,
      "Distinct composite shadow objects must report drift"
    );
    assert.equal(
      valuesMatch({ offsetX: "0px", offsetY: "1px", blur: "2px", color: "#000000" }, "0 1px 2px #000"),
      true,
      "Composite shadow object must normalize to CSS shadow string"
    );
    assert.equal(
      valuesMatch({ fontFamily: "Inter", fontSize: "14px" }, { fontFamily: "Georgia", fontSize: "32px" }),
      false,
      "Distinct typography objects must not collapse to [object Object]"
    );
    assert.equal(
      valuesMatch({ fontFamily: "Inter", fontSize: "14px" }, { fontSize: "14px", fontFamily: "Inter" }),
      true,
      "Identical typography objects with reordered keys must match"
    );
    assert.equal(
      valuesMatch([{ blur: "2px", color: "#000", offsetX: 0, offsetY: "1px" }], [{ blur: "40px", color: "#f00", offsetX: 0, offsetY: "2px" }]),
      false,
      "Distinct composite array tokens must report drift"
    );

    // 10. Round 6 regressions: split base.json + dark.json mode prefixing, leading primitives.* strip, non-font comma mismatch, rgba alpha normalization
    assert.equal(stripPrimitivesSegment("primitives.color.brand"), "color.brand");
    assert.equal(valuesMatch("color, opacity", "color"), false, "Comma-separated non-font CSS values must not match first item");
    assert.equal(valuesMatch("rgb(0 0 0 / 0.5)", { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 }), true);
    assert.equal(valuesMatch("rgba(0, 0, 0, 50%)", { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 }), true);

    const r6SplitDir = join(scratch, "r6-split-tokens/tokens");
    mkdirSync(r6SplitDir, { recursive: true });
    writeFileSync(
      join(r6SplitDir, "base.json"),
      JSON.stringify({ color: { bg: { $type: "color", $value: "#ffffff" }, accent: { $type: "color", $value: "#1d4ed8" } } })
    );
    writeFileSync(
      join(r6SplitDir, "dark.json"),
      JSON.stringify({ color: { bg: { $type: "color", $value: "#0b0f19" }, onBg: { $type: "color", $value: "{color.bg}" } } })
    );
    const r6Loaded = loadDefinedTokens(join(scratch, "r6-split-tokens"));
    assert.equal(r6Loaded.get("color.bg"), "#ffffff", "base.json token must not be overwritten by dark.json");
    assert.equal(r6Loaded.get("color.accent"), "#1d4ed8");
    assert.equal(r6Loaded.get("dark.color.bg"), "#0b0f19");
    assert.equal(r6Loaded.get("dark.color.on.bg"), "#0b0f19");

    // 11. Round 7 regressions: cross-file split dark mode alias, :root precedence over component CSS, fontFamily arrays, spread 0px, commented Code Connect
    assert.equal(valuesMatch(["IBM Plex Sans", "sans-serif"], '"IBM Plex Sans", sans-serif'), true);
    assert.equal(
      valuesMatch({ offsetX: "0px", offsetY: "4px", blur: "12px", spread: "0px", color: "#000000" }, "0 4px 12px #000"),
      true
    );
    assert.equal(
      valuesMatch({ offsetX: "0px", offsetY: "4px", blur: "12px", spread: "0px", color: "#000000" }, "0px 4px 12px 0px #000000"),
      true
    );

    const r7Cross = join(scratch, "r7-cross");
    mkdirSync(join(r7Cross, "tokens/dark"), { recursive: true });
    mkdirSync(join(r7Cross, "components"), { recursive: true });
    writeFileSync(join(r7Cross, "tokens/dark/a.json"), JSON.stringify({ surface: { default: { $type: "color", $value: "#0b0f19" } } }));
    writeFileSync(join(r7Cross, "tokens/dark/b.json"), JSON.stringify({ text: { onBg: { $type: "color", $value: "{surface.default}" } } }));
    writeFileSync(join(r7Cross, "components/Button.css"), ".btn { --brand-primary: #ff00aa; }\n");
    writeFileSync(join(r7Cross, "tokens/theme.css"), ":root { --brand-primary: #1d4ed8; }\n");
    const r7Loaded = loadDefinedTokens(r7Cross);
    assert.equal(r7Loaded.get("dark.text.on.bg"), "#0b0f19", "Cross-file dark/*.json alias must resolve inside dark scope");
    assert.equal(r7Loaded.get("brand.primary"), "#1d4ed8", ":root tokens must take precedence over alphabetically earlier scoped component CSS");

    const r7CcDir = join(scratch, "r7-cc");
    mkdirSync(r7CcDir, { recursive: true });
    writeFileSync(
      join(r7CcDir, "Card.figma.tsx"),
      [
        "// figma.connect(CommentedFakeButton, 'https://example.com')",
        "/* figma.connect(BlockCommentFake, 'https://example.com') */",
        "figma.connect(RealCard, 'https://example.com');",
      ].join("\n")
    );
    const r7Cc = scanCodeConnect(r7CcDir);
    assert.deepEqual(r7Cc.mappedComponents, ["RealCard"], "Commented-out figma.connect calls must be ignored");

    // 12. Round 8 regressions: multi-layer 0px-spread rgb/rgba shadows, :where() root selectors, @color-primitives/ hyphen segment
    assert.equal(
      valuesMatch(
        [
          { offsetX: "0px", offsetY: "1px", blur: "2px", spread: "0px", color: "#000000" },
          { offsetX: "0px", offsetY: "4px", blur: "8px", spread: "0px", color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 } },
        ],
        "0px 1px 2px 0px rgb(0, 0, 0), 0px 4px 8px 0px rgba(0, 0, 0, 50%)"
      ),
      true,
      "Multi-layer shadow with 0px spread and embedded rgb/rgba must match DTCG shadow array"
    );
    assert.equal(stripPrimitivesSegment("color-primitives.brand.800"), "color.brand.800");
    assert.equal(normalizeShadowString("0px 1px 2px 0px rgb(0, 0, 0), 0px 4px 8px 0px rgba(0, 0, 0, 50%)"), "0 1px 2px #000000, 0 4px 8px rgba(0, 0, 0, 0.5)");

    const r8CssDir = join(scratch, "r8-where-root");
    mkdirSync(join(r8CssDir, "components"), { recursive: true });
    mkdirSync(join(r8CssDir, "tokens"), { recursive: true });
    writeFileSync(join(r8CssDir, "components/A.css"), ".card { --brand-primary: #ff00aa; }\n");
    writeFileSync(join(r8CssDir, "tokens/root.css"), ':root:where(.light, [data-theme="light"]) { --brand-primary: #1d4ed8; }\n');
    writeFileSync(join(r8CssDir, "tokens/prim.json"), JSON.stringify({ color: { brand: { 800: { $type: "color", $value: "#1e40af" } } } }));
    const r8FigmaPath = join(scratch, "r8-figma.json");
    writeFileSync(r8FigmaPath, JSON.stringify({ "@color-primitives/brand/800": "#1e40af", "brand/primary": "#1d4ed8" }));
    const r8Diff = compareVertices({ figmaPath: r8FigmaPath, tokensArg: r8CssDir });
    assert.equal(r8Diff.summary.matchedCount, 2, "Hyphenated @color-primitives and :root:where(...) root selector must both match cleanly");

    // 13. Round 9 regressions (R9-A2-04, R9-A2-10, R9-A2-11, R9-A2-12): 4/8-digit alpha hex, color-first shadows,
    // :root:where(.dark), :where(:root), !important CSS vars, light-dark.tokens.json, auth/tokens.json, tokenizer.json
    assert.equal(valuesMatch("#00000033", "rgba(0, 0, 0, 0.2)"), true);
    assert.equal(valuesMatch("#00000000", "rgba(0, 0, 0, 0)"), true);
    assert.equal(valuesMatch("#0003", { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.2 }), true);
    assert.equal(
      valuesMatch(
        { offsetX: "0px", offsetY: "4px", blur: "8px", spread: "0px", color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 } },
        "rgba(0, 0, 0, 0.5) 0px 4px 8px 0px"
      ),
      true
    );

    const r9Dir = join(scratch, "r9-figma-cases");
    mkdirSync(join(r9Dir, "tokens"), { recursive: true });
    mkdirSync(join(r9Dir, "auth"), { recursive: true });
    writeFileSync(join(r9Dir, "tokens/light.css"), ':where(:root) { --brand-blue: #1d4ed8; --brand-primary: var(--brand-blue) !important; }\n');
    writeFileSync(join(r9Dir, "tokens/dark.css"), ':root:where(.dark) { --brand-blue: #93c5fd; --brand-primary: #93c5fd; }\n');
    writeFileSync(
      join(r9Dir, "tokens/light-dark.tokens.json"),
      JSON.stringify({ primitive: { blue: { $type: "color", $value: "#1d4ed8" } }, light: { brand: { $type: "color", $value: "{primitive.blue}" } } })
    );
    writeFileSync(join(r9Dir, "auth/tokens.json"), JSON.stringify({ secret: { $value: "#ff00aa" } }));
    writeFileSync(join(r9Dir, "tokenizer.json"), JSON.stringify({ vocab: { token: "x" } }));
    const r9Toks = loadDefinedTokens(r9Dir);
    assert.equal(r9Toks.get("brand.primary"), "#1d4ed8", ":where(:root) and !important var() alias must resolve without :root:where(.dark) clobbering");
    assert.equal(r9Toks.get("light.brand"), "#1d4ed8", "Shared primitive ref in light-dark.tokens.json must resolve");
    assert.equal(r9Toks.has("secret"), false, "auth/tokens.json must be excluded");
    assert.equal(r9Toks.has("vocab.token"), false, "tokenizer.json must be excluded");

    // 14. Round 10 regressions (R10-A2-09, R10-A2-10, R10-A2-17): non-shadow shorthands must not collide,
    // :root:not(.dark) preserved + &.dark skipped, auth/google/tokens.json & snooze_token.json excluded while api-card.css included
    assert.equal(valuesMatch("12px 16px", "12px 16px 0px"), false, "2-value vs 3-value padding shorthand drift must not pass shadow normalizer");
    assert.equal(valuesMatch("12px 16px 24px 0px", "12px 16px 24px"), false);
    assert.equal(valuesMatch("10px auto", "auto 10px"), false);
    assert.equal(valuesMatch("1fr 240px 1fr", "240px 1fr 1fr"), false);

    const r10Dir = join(scratch, "r10-figma-cases");
    mkdirSync(join(r10Dir, "tokens"), { recursive: true });
    mkdirSync(join(r10Dir, "styles"), { recursive: true });
    mkdirSync(join(r10Dir, "auth/google"), { recursive: true });
    writeFileSync(
      join(r10Dir, "tokens/light-not-dark.css"),
      [
        ":root:not(.dark) { --brand-primary: #1d4ed8; }",
        ":root.dark { --brand-primary: #93c5fd; }",
        "html {",
        "  &.dark { --surface-bg: #0b0f19; }",
        "  &.light { --surface-bg: #ffffff; }",
        "}",
      ].join("\n") + "\n"
    );
    writeFileSync(join(r10Dir, "styles/api-card.css"), ".api-card { --card-gap: 16px; }\n");
    writeFileSync(join(r10Dir, "auth/google/tokens.json"), JSON.stringify({ secret: { $value: "#ff00aa" } }));
    writeFileSync(join(r10Dir, "snooze_token.json"), JSON.stringify({ snooze: { $value: "#ff00aa" } }));
    const r10Toks = loadDefinedTokens(r10Dir);
    assert.equal(r10Toks.get("brand.primary"), "#1d4ed8", ":root:not(.dark) light tokens must not be dropped by DARK_SELECTOR_RE");
    assert.equal(r10Toks.get("surface.bg"), "#ffffff", "Nested &.dark block must be skipped before &.light");
    assert.equal(r10Toks.get("card.gap"), "16px", "Stylesheet api-card.css must not be skipped by auth-token JSON guard");
    assert.equal(r10Toks.has("secret"), false, "Nested auth/google/tokens.json must be excluded");
    assert.equal(r10Toks.has("snooze"), false, "snooze_token.json must be excluded");

    // Round 11 regressions (R11-A2-08, R11-A2-16):
    const r11Dir = join(scratch, "r11-diff");
    mkdirSync(join(r11Dir, "components"), { recursive: true });
    mkdirSync(join(r11Dir, "tokens"), { recursive: true });
    writeFileSync(join(r11Dir, "components/A.css"), ".card { --surface-bg: #ff00aa; --brand-primary: #ff00aa; }\n");
    writeFileSync(
      join(r11Dir, "tokens/theme.css"),
      [
        "html {",
        "  &.dark { --surface-bg: #0b0f19; }",
        "  &.light { --surface-bg: #ffffff; }",
        "}",
        ":root {",
        "  &:not(.dark) { --brand-primary: var(--theme-brand, var(--fallback-brand, #1d4ed8)); }",
        "}",
      ].join("\n") + "\n"
    );
    const r11Toks = loadDefinedTokens(r11Dir);
    assert.equal(r11Toks.get("surface.bg"), "#ffffff", "Nested &.light inside html must classify as root token, beating component CSS");
    assert.equal(r11Toks.get("brand.primary"), "#1d4ed8", "Nested &:not(.dark) and multi-level var(--a, var(--b, #hex)) fallback must resolve");

    // Round 12 regressions (R12-A2-08, R12-A2-19, R12-A2-20):
    const r12Dir = join(scratch, "r12-figma");
    mkdirSync(join(r12Dir, "tokens"), { recursive: true });
    mkdirSync(join(r12Dir, "figma"), { recursive: true });
    const r12FigPath = join(r12Dir, "figma.json");
    writeFileSync(
      r12FigPath,
      JSON.stringify({
        "color/shadow": "#000000",
        "shadow/card": "0 4px 12px #000000",
        "font/sans": "Inter",
        "size/md": "16px",
        "type/body": { $value: { fontFamily: "Inter", fontSize: "16px" } },
      })
    );
    writeFileSync(
      join(r12Dir, "tokens/design.tokens.json"),
      JSON.stringify({
        color: { shadow: { $type: "color", $value: "#000000" } },
        shadow: { card: { $type: "shadow", $value: { offsetX: "0px", offsetY: "4px", blur: "12px", color: "{color.shadow}" } } },
        font: { sans: { $type: "fontFamily", $value: "Inter" } },
        size: { md: { $type: "dimension", $value: "16px" } },
        type: { body: { $type: "typography", $value: { fontFamily: "{font.sans}", fontSize: "{size.md}" } } },
      })
    );
    const r12Comp = compareVertices({ figmaPath: r12FigPath, tokensArg: join(r12Dir, "tokens/design.tokens.json") });
    assert.deepEqual(r12Comp.valueDrift, [], "Composite DTCG tokens with nested {alias} must resolve cleanly without Value Drift");
    assert.equal(r12Comp.summary.matchedCount, 5);
    assert.equal(
      loadDefinedTokens(join(r12Dir, "tokens/design.tokens.json")).get("type.body"),
      '{"fontFamily":"inter","fontSize":"16px"}'
    );

    writeFileSync(join(r12Dir, "tokens/theme.scss"), ":root {\n  --shadow-a: 0 2px #{$blur};\n  --brand-primary: #1d4ed8;\n}\n");
    symlinkSync(join(r12Dir, "tokens/nonexistent.css"), join(r12Dir, "tokens/broken.css"));
    const r12Toks = loadDefinedTokens(join(r12Dir, "tokens"));
    assert.equal(r12Toks.get("shadow.a"), "0 2px #{$blur}", "SCSS #{...} interpolation inside :root must stay intact");
    assert.equal(r12Toks.get("brand.primary"), "#1d4ed8");

    writeFileSync(
      join(r12Dir, "figma/Button.figma.tsx"),
      "figma.connect<ButtonProps>(Button, \"https://figma.com/file/abc\", {});\nfigma.connect<Record<string, ButtonProps>>(Chip, \"https://figma.com/file/abc\", {});\n"
    );
    const r12Cc = scanCodeConnect(join(r12Dir, "figma"));
    assert.deepEqual(r12Cc.mappedComponents, ["Button", "Chip"], "TypeScript generic figma.connect<...>(Comp, ...) must be extracted");

    // Round 13 regression (R13-A2-17): scanCodeConnect must skip broken symlinks, follow in-root dir symlinks, and break cycles
    const r13CcDir = join(scratch, "r13-cc");
    const r13CcReal = join(r13CcDir, ".internal-shared");
    mkdirSync(r13CcDir, { recursive: true });
    mkdirSync(r13CcReal, { recursive: true });
    writeFileSync(join(r13CcReal, "Badge.figma.tsx"), 'figma.connect(Badge, "https://figma.com/file/abc", {});\n');
    symlinkSync(join(r13CcDir, "missing.figma.tsx"), join(r13CcDir, "Broken.figma.tsx"));
    symlinkSync(r13CcReal, join(r13CcDir, "shared-ui"));
    symlinkSync(r13CcDir, join(r13CcReal, "loop"));
    const r13Cc = scanCodeConnect(r13CcDir);
    assert.deepEqual(r13Cc.mappedComponents, ["Badge"], "scanCodeConnect must skip broken symlinks, follow shared dir symlinks, and avoid infinite cycles");

    // Round 14 regressions (R14-A2-12, R14-A2-15): shipped prefix auto-detection & quoted CSS --var ignore
    const r14Dir = join(scratch, "r14-diff");
    mkdirSync(r14Dir, { recursive: true });
    writeFileSync(
      join(r14Dir, "tokens.json"),
      JSON.stringify({
        color: {
          brand: { primary: { $type: "color", $value: "#1d4ed8" } },
          surface: { canvas: { $type: "color", $value: "#ffffff" } },
        },
        spacing: { md: { $type: "dimension", $value: "16px" } },
      })
    );
    writeFileSync(
      join(r14Dir, "runtime.json"),
      JSON.stringify({
        schema: "dsaf-runtime/2",
        allPassed: true,
        files: [
          {
            file: "index.html",
            computedVars: {
              "--ds-color-brand-primary": "#1d4ed8",
              "--ds-color-surface-canvas": "#ffffff",
              "--ds-spacing-md": "16px",
            },
            checks: [{ apca: { minBodyLc: 75 }, componentInventory: { buttons: { distinctSignatures: 1 } } }],
          },
        ],
      })
    );
    writeFileSync(
      join(r14Dir, "figma.json"),
      JSON.stringify({
        "color/brand/primary": "#1d4ed8",
        "color/surface/canvas": "#ffffff",
        "spacing/md": "16px",
      })
    );
    const r14Two = compareDefinedToShipped({ tokensArg: join(r14Dir, "tokens.json"), runtimePath: join(r14Dir, "runtime.json") });
    assert.equal(r14Two.summary.detectedPrefix, "ds", "2-vertex Defined<->Shipped must auto-detect prefix from shipped CSS vars");
    assert.equal(r14Two.summary.matchedCount, 3);
    assert.equal(r14Two.summary.triangulationCoveragePct, 100);
    const r14Three = compareVertices({
      figmaPath: join(r14Dir, "figma.json"),
      tokensArg: join(r14Dir, "tokens.json"),
      runtimePath: join(r14Dir, "runtime.json"),
    });
    assert.equal(r14Three.shippedSummary.shippedMatchedCount, 3, "3-vertex comparison must strip dominant shipped CSS prefix when Defined lacks prefix");

    writeFileSync(
      join(r14Dir, "vars.css"),
      '.tip::after { content: "--mode: dark"; }\n:root { --font-sans: "Inter", sans-serif; }\n'
    );
    const r14CssMap = loadDefinedTokens(join(r14Dir, "vars.css"));
    assert.equal(r14CssMap.has("mode"), false, "Quoted CSS string containing --mode: must not become a token");
    assert.equal(r14CssMap.get("font.sans"), '"inter", sans-serif', "Quoted CSS value on :root --font-sans must stay intact");

    // Round 15 regression (R15-A2-09): @supports / @container style(--var: ...) preludes must not clobber :root token values
    const r15Css = join(r14Dir, "queries.css");
    writeFileSync(
      r15Css,
      [
        "@supports ( --brand-primary: #ff00aa ) {",
        "  .card { color: #123456; }",
        "}",
        "@container style(--brand-primary: #223344) {",
        "  .card { color: #654321; }",
        "}",
        ":root {",
        "  --brand-primary: #1d4ed8;",
        "}",
      ].join("\n") + "\n"
    );
    const r15Figma = join(r14Dir, "figma-r15.json");
    writeFileSync(r15Figma, JSON.stringify({ "brand/primary": "#1d4ed8" }));
    const r15Diff = compareVertices({ figmaPath: r15Figma, tokensArg: r15Css });
    assert.equal(r15Diff.summary.matchedCount, 1, "@supports/@container style query preludes must not clobber :root --brand-primary");
    assert.equal(r15Diff.summary.valueDriftCount, 0);

    // Round 16 regression (R16-A2-17): shared :root,.dark & light,dark selectors, compound var() shadow values, and bounded Code Connect export default
    const r16Css = join(r14Dir, "shared-compound.css");
    writeFileSync(
      r16Css,
      [
        ":root { --shadow-color: rgba(0, 0, 0, 0.12); --shadow-card: 0 4px 12px var(--shadow-color); }",
        '[data-theme="light"], [data-theme="dark"] { --radius-md: 8px; }',
        ":root, .dark { --border-sm: 1px; }",
      ].join("\n") + "\n"
    );
    const r16Figma = join(r14Dir, "figma-r16.json");
    writeFileSync(
      r16Figma,
      JSON.stringify({ "shadow/card": "0 4px 12px rgba(0, 0, 0, 0.12)", "radius/md": "8px", "border/sm": "1px" })
    );
    const r16Diff = compareVertices({ figmaPath: r16Figma, tokensArg: r16Css });
    assert.equal(r16Diff.summary.matchedCount, 3);
    assert.equal(r16Diff.summary.valueDriftCount, 0);
    assert.equal(r16Diff.summary.designOnlyCount, 0);

    const r16CcDir = join(r14Dir, "cc");
    mkdirSync(r16CcDir, { recursive: true });
    writeFileSync(join(r16CcDir, "Btn.figma.tsx"), 'export default { component: Button };\nconst mockRow = { id: "fake-row-1" };\n');
    const r16Cc = scanCodeConnect(r16CcDir);
    assert.deepEqual(r16Cc.mappedComponents, []);

    // Round 17 regressions (R17-A2-A1, R17-A2-A2): nested selector parens (:not(:where(...))) and @import ... supports(--prop)
    const r17CssDir = join(r14Dir, "r17-css");
    mkdirSync(r17CssDir, { recursive: true });
    writeFileSync(
      join(r17CssDir, "a-card.css"),
      [
        '@import url("https://example.com/a.css") supports(--fake-prop: 1);',
        ".card { --brand-primary: #ff00aa; --brand-secondary: #ee00aa; }",
      ].join("\n")
    );
    writeFileSync(
      join(r17CssDir, "tokens.css"),
      [
        ':root:not(:where(.dark, [data-theme="dark"])) { --brand-primary: #111111; }',
        ':root:where(.light, [data-theme="light"]):not(:is(.dark)) { --brand-secondary: #222222; }',
        ".dark:not(:where(.light, .sepia), .disabled) { --dark-leak: #000000; }",
      ].join("\n")
    );
    const r17Loaded = loadDefinedTokens(r17CssDir);
    assert.equal(r17Loaded instanceof Map, true);
    assert.equal(r17Loaded.get("brand.primary"), "#111111");
    assert.equal(r17Loaded.get("brand.secondary"), "#222222");
    assert.equal(r17Loaded.get("dark.leak"), undefined);
    assert.equal(r17Loaded.get("fake.prop"), undefined);

    // Round 18 regressions (R18-A2-16): :where(:root, :host):not(.dark) stays root & base alias -> split light/dark resolves
    const r18Dir = join(r14Dir, "r18-where-not");
    mkdirSync(r18Dir, { recursive: true });
    writeFileSync(join(r18Dir, "a-comp.css"), ".card { --brand-primary: #ff00aa; }\n");
    writeFileSync(join(r18Dir, "theme.css"), ":where(:root, :host):not(.dark) { --brand-primary: #1d4ed8; }\n");
    assert.equal(loadDefinedTokens(r18Dir).get("brand.primary"), "#1d4ed8");
    const r18Split = join(r14Dir, "r18-split");
    mkdirSync(r18Split, { recursive: true });
    writeFileSync(join(r18Split, "base.tokens.json"), JSON.stringify({ surface: { card: { $type: "color", $value: "{surface.default}" } } }));
    writeFileSync(join(r18Split, "light.tokens.json"), JSON.stringify({ surface: { default: { $type: "color", $value: "#ffffff" } } }));
    writeFileSync(join(r18Split, "dark.tokens.json"), JSON.stringify({ surface: { default: { $type: "color", $value: "#0b0f19" } } }));
    assert.equal(loadDefinedTokens(r18Split).get("surface.card"), "#ffffff");

    // Round 19 regressions (R19-A2-13, R19-A2-16): composite base -> light/dark refs & :root:not(.light) exclusion
    const r19Comp = join(r14Dir, "r19-comp");
    mkdirSync(r19Comp, { recursive: true });
    writeFileSync(
      join(r19Comp, "base.tokens.json"),
      JSON.stringify({ shadow: { card: { $type: "shadow", $value: { offsetX: "0px", offsetY: "4px", blur: "12px", spread: "0px", color: "{surface.shadow}" } } } })
    );
    writeFileSync(join(r19Comp, "light.tokens.json"), JSON.stringify({ surface: { shadow: { $type: "color", $value: "#000000" } } }));
    writeFileSync(join(r19Comp, "dark.tokens.json"), JSON.stringify({ surface: { shadow: { $type: "color", $value: "#ffffff" } } }));
    assert.equal(loadDefinedTokens(r19Comp).get("shadow.card"), "0 4px 12px #000000");

    const r19NotLight = join(r14Dir, "r19-not-light");
    mkdirSync(r19NotLight, { recursive: true });
    writeFileSync(join(r19NotLight, "a.css"), ".card { --a: #ff00aa; }\n");
    writeFileSync(join(r19NotLight, "theme.css"), ":root:not(.light) { --a: #000000; }\n");
    assert.equal(loadDefinedTokens(r19NotLight).get("a"), "#ff00aa", ":root:not(.light) must not override component vars as rootCss");
    assert.equal(extractSplitCssText(":root:not(.light) { --a: #000000; }\n").rootCss.trim(), "");

    // Round 20 regressions (R20-A2-M12, R20-A2-M13): dark composite overrides base & :root:where(:not(.light)) exclusion
    const r20Comp = join(r14Dir, "r20-comp");
    mkdirSync(r20Comp, { recursive: true });
    writeFileSync(join(r20Comp, "base.tokens.json"), JSON.stringify({ surface: { shadow: { $type: "color", $value: "#cccccc" } } }));
    writeFileSync(
      join(r20Comp, "dark.tokens.json"),
      JSON.stringify({
        surface: { shadow: { $type: "color", $value: "#ffffff" } },
        shadow: { card: { $type: "shadow", $value: { offsetX: "0px", offsetY: "4px", blur: "12px", spread: "0px", color: "{surface.shadow}" } } },
      })
    );
    assert.equal(loadDefinedTokens(r20Comp).get("dark.shadow.card"), "0 4px 12px #ffffff");
    const r20WhereNotLight = join(r14Dir, "r20-where-not-light");
    mkdirSync(r20WhereNotLight, { recursive: true });
    writeFileSync(join(r20WhereNotLight, "a.css"), ".card { --a: #ff00aa; }\n");
    writeFileSync(join(r20WhereNotLight, "theme.css"), ":root:where(:not(.light)) { --a: #000000; }\n:root:is(:not(.light)) { --b: #000000; }\n");
    assert.equal(loadDefinedTokens(r20WhereNotLight).get("a"), "#ff00aa");
    assert.equal(extractSplitCssText(":root:where(:not(.light)) { --a: #000000; }\n").rootCss.trim(), "");

    // Round 21 regression (R21-A4-L2): empty Figma or runtime coverage renders N/A without '%'
    const r21EmptyJson = join(r14Dir, "r21-empty.json");
    const r21EmptyRtJson = join(r14Dir, "r21-empty-rt.json");
    writeFileSync(r21EmptyJson, "{}\n");
    writeFileSync(r21EmptyRtJson, JSON.stringify({ schema: "dsaf-runtime/2", files: [{ file: "index.html", computedVars: {}, checks: [] }] }));
    assert.doesNotMatch(renderMarkdown(compareVertices({ figmaPath: r21EmptyJson, tokensArg: r21EmptyJson })), /N\/A%/);
    assert.doesNotMatch(renderMarkdown(compareDefinedToShipped({ tokensArg: r21EmptyJson, runtimePath: r21EmptyRtJson })), /N\/A%/);

    // Round 21 regression (R21-A2-M6): :root:not(.light), :root:where(:not(.light)), html { &:not(.light) }, :root:not(html.light) must skip scopedCss too
    const r21DarkNotLight = join(r14Dir, "r21-dark-not-light");
    mkdirSync(r21DarkNotLight, { recursive: true });
    writeFileSync(join(r21DarkNotLight, "z-card.css"), ".card { --bg: #ff00aa; --a: #ff00aa; }\n");
    writeFileSync(
      join(r21DarkNotLight, "a-theme.css"),
      [
        ":root:not(.light) { --bg: #000000; }",
        ":root:where(:not(.light)) { --leak: #000000; }",
        "html { &:not(.light) { --nested: #000000; } }",
        ":root:not(html.light) { --a: #000000; }",
      ].join("\n") + "\n"
    );
    const r21LoadedDark = loadDefinedTokens(r21DarkNotLight);
    assert.equal(r21LoadedDark.get("bg"), "#ff00aa");
    assert.equal(r21LoadedDark.get("a"), "#ff00aa");
    assert.equal(r21LoadedDark.get("leak"), undefined);
    assert.equal(r21LoadedDark.get("nested"), undefined);

    const fdSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [fdSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
    assert.equal(
      spawnSync(process.execPath, [fdSelfPath, "--tokens", r21EmptyJson, "--figma", r21EmptyJson, "--format", "bogus", "--json"], { encoding: "utf8" }).status,
      2
    );

    // Round 23 regressions (#20, #28, #42)
    const r23FdDir = join(r14Dir, "r23-fd");
    mkdirSync(join(r23FdDir, "src"), { recursive: true });
    writeFileSync(join(r23FdDir, "src/config-tokens.json"), '{"retry":{"backoff":{"value":"5s"}},"stripe":{"keyPrefix":{"value":"pk_live"}}}');
    writeFileSync(join(r23FdDir, "theme.css"), ":root[data-theme-toggle] { --color-btn: #ff00aa; }\n:root { --color-btn: #ffffff; }\n");
    const r23Loaded = loadDefinedTokens(r23FdDir);
    assert.equal(r23Loaded.get("color.btn"), "#ffffff");
    assert.equal(r23Loaded.get("retry.backoff"), undefined);
    for (const badFdCli of [
      ["--tokens", join(r23FdDir, "theme.css"), "--figma", "   ", "--runtime", r21EmptyRtJson],
      ["--tokens", join(r23FdDir, "theme.css"), "--figma", r21EmptyJson, "--code-connect", ""],
      ["--tokens", join(r23FdDir, "theme.css"), "--figma", r21EmptyJson, "--prefix", ""],
      ["--tokens", join(r23FdDir, "theme.css"), "--figma", r21EmptyJson, "--out", r23FdDir],
    ]) {
      assert.equal(spawnSync(process.execPath, [fdSelfPath, ...badFdCli], { encoding: "utf8" }).status, 2);
    }

    // Round 24 regressions (A2-M1: data-color-mode/data-bs-theme dark, non-default theme exclusion, last-wins :root)
    const r24FdDir = join(r14Dir, "r24-fd");
    mkdirSync(r24FdDir, { recursive: true });
    writeFileSync(
      join(r24FdDir, "tokens.css"),
      [
        ":root { --color-btn: #000000; }",
        ":root { --color-btn: #ffffff; }",
        '[data-color-mode="dark"] { --color-btn: #111111; }',
        '[data-bs-theme="dark"] { --color-btn: #222222; }',
        ':root[data-theme="high-contrast"] { --color-btn: #ff00ff; --hc-only: #ffff00; }',
      ].join("\n") + "\n"
    );
    const r24Loaded = loadDefinedTokens(r24FdDir);
    assert.equal(r24Loaded.get("color.btn"), "#ffffff", "R24 A2-M1: last-wins :root override must take precedence");
    assert.equal(r24Loaded.get("hc.only"), undefined, "R24 A2-M1: non-default [data-theme='high-contrast'] must be excluded");

    // Round 25 regressions (A2-H6 $extensions.modes/com.figma.mode, A2-M5 Pass 1 occupancy & canonKey, A2-L2 Selectors L4 i/s, A4-H1 live leaf symlink, A4-L1 isDirectCliEntry)
    const r25FdDir = join(r14Dir, "r25-fd");
    mkdirSync(r25FdDir, { recursive: true });
    writeFileSync(
      join(r25FdDir, "tokens.tokens.json"),
      JSON.stringify({
        color: {
          btn: {
            $type: "color",
            $value: "#000000",
            $extensions: {
              modes: { light: "#ffffff", dark: "#0b0f19" },
              "com.figma.mode": { light: "#ffffff", dark: "#111827" },
            },
          },
        },
        alias: {
          primary: { $type: "color", $value: "{missing.base}" },
        },
      })
    );
    writeFileSync(
      join(r25FdDir, "override.css"),
      [
        ':root { --color-btn: #123456; --alias-primary: #ff00ff; }',
        '[data-theme="dark" i] { --color-btn: #222222; --dark-i: #333333; }',
        ':root[data-theme="light" i] { --light-i: #fafafa; }',
        ':root[data-theme="high-contrast" s] { --hc-s: #ff00aa; }',
      ].join("\n") + "\n"
    );
    const r25Loaded = loadDefinedTokens(r25FdDir);
    assert.equal(r25Loaded.get("dark.color.btn"), "#0b0f19", "R25 A2-H6: $extensions.modes must emit dark.* key");
    assert.equal(r25Loaded.get("color.btn"), "#000000", "R25 A2-M5: DTCG key must lock CSS --color-btn");
    assert.equal(r25Loaded.get("alias.primary"), undefined, "R25 A2-M5: DTCG alias key must occupy slot against later CSS literal");
    assert.equal(r25Loaded.get("dark.i"), undefined, "R25 A2-L2: Selectors L4 [data-theme='dark' i] must be treated as dark");
    assert.equal(r25Loaded.get("light.i"), "#fafafa", "R25 A2-L2: Selectors L4 [data-theme='light' i] must be treated as root light");
    assert.equal(r25Loaded.get("hc.s"), undefined, "R25 A2-L2: Selectors L4 [data-theme='high-contrast' s] must be excluded");
    const r25Secret = join(scratch, "fd-secret.json");
    const r25SymOut = join(scratch, "fd-live-sym.json");
    writeFileSync(r25Secret, "{}");
    symlinkSync(r25Secret, r25SymOut);
    assert.equal(
      spawnSync(process.execPath, [fdSelfPath, "--tokens", r25FdDir, "--figma", r21EmptyJson, "--out", r25SymOut], { encoding: "utf8" }).status,
      2
    );
    const r25CliSym = join(scratch, "fd-cli-sym.mjs");
    symlinkSync(fdSelfPath, r25CliSym);
    assert.equal(spawnSync(process.execPath, [r25CliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regressions (A2-H2 CSS dark-mode drift, A2-M14 camelCase matching, A2-L15 % rgba + hsl/hsla color normalization)
    assert.equal(valuesMatch("rgba(100%, 0%, 0%, 1)", "#ff0000"), true);
    assert.equal(valuesMatch("hsl(0, 100%, 50%)", "#ff0000"), true);
    assert.equal(valuesMatch("hsla(120, 100%, 50%, 0.5)", "rgba(0, 255, 0, 0.5)"), true);
    const r26DarkDir = join(scratch, "r26-dark-drift");
    mkdirSync(r26DarkDir, { recursive: true });
    const r26FigmaPath = join(r26DarkDir, "figma.json");
    writeFileSync(
      r26FigmaPath,
      JSON.stringify({
        color: {
          primaryBrand: {
            $type: "color",
            $value: "#1d4ed8",
            $extensions: { mode: { light: "#1d4ed8", dark: "#60a5fa" } },
          },
        },
      })
    );
    writeFileSync(
      join(r26DarkDir, "tokens.css"),
      ':root { --color-primary-brand: #1d4ed8; }\n[data-theme="dark"] { --color-primary-brand: #ff0000; }\n'
    );
    const r26DarkDiff = compareVertices({ figmaPath: r26FigmaPath, tokensArg: r26DarkDir });
    assert.equal(r26DarkDiff.summary.matchedCount, 2, "R26 base + light camelCase tokens must match :root");
    assert.equal(r26DarkDiff.summary.valueDriftCount, 1, "R26 [data-theme='dark'] override drift against $extensions.mode.dark must be caught");
    assert.equal(r26DarkDiff.summary.designOnlyCount, 0);

    // Round 27 (A2-M2 camelCase CSS vars, A2-M3 semicolon in url(data:...), A2-L2 8-bit hex alpha quantization tolerance)
    assert.equal(valuesMatch("rgba(255, 0, 170, 0.5)", "#ff00aa80"), true);
    assert.equal(valuesMatch("0 4px 12px rgba(0, 0, 0, 0.15)", "0px 4px 12px 0px #00000026"), true);
    const r27CamelDir = join(scratch, "r27-camel-data");
    mkdirSync(r27CamelDir, { recursive: true });
    const r27FigmaPath = join(r27CamelDir, "figma.json");
    const r27RuntimePath = join(r27CamelDir, "runtime.json");
    writeFileSync(
      r27FigmaPath,
      JSON.stringify({ variables: { textPrimary: "#111827", iconBg: "url(data:image/png;base64,AAAA)" } })
    );
    writeFileSync(
      join(r27CamelDir, "tokens.css"),
      ":root { --textPrimary: #111827; --icon-bg: url(data:image/png;base64,AAAA); }\n"
    );
    writeFileSync(
      r27RuntimePath,
      JSON.stringify({ schema: "dsaf-runtime/2", files: [{ file: "index.html", computedVars: { "--textPrimary": "#111827", "--icon-bg": "url(data:image/png;base64,AAAA)" }, checks: [] }] })
    );
    const r27Diff = compareVertices({ figmaPath: r27FigmaPath, tokensArg: r27CamelDir, runtimePath: r27RuntimePath });
    assert.equal(r27Diff.summary.matchedCount, 2, "R27 A2-M2/M3: camelCase --textPrimary and url(data:...;...) must match cleanly");
    assert.equal(r27Diff.summary.valueDriftCount, 0);
    assert.equal(r27Diff.summary.designOnlyCount, 0);
    assert.equal(r27Diff.shippedSummary.shippedMatchedCount, 2);

    // Round 28 (A2-M3 oklch/oklab -> sRGB/hex, A2-M4 .dark CSS overrides excluded from single-mode runtime definedNotShipped)
    assert.equal(valuesMatch("#ffffff", "oklch(1 0 0)"), true);
    assert.equal(valuesMatch("#000000", "oklch(0 0 0)"), true);
    assert.equal(valuesMatch("#ff0000", "oklch(0.627955 0.257683 29.2339)"), true);
    assert.equal(valuesMatch("#ff0000", { colorSpace: "oklch", components: [0.627955, 0.257683, 29.2339] }), true);
    assert.equal(valuesMatch("rgba(255, 0, 0, 0.5)", "oklch(0.627955 0.257683 29.2339 / 0.5)"), true);
    assert.equal(valuesMatch("#ffffff", "oklab(100% 0 0)"), true);

    const r28DarkDir = join(scratch, "r28-dark-3vertex");
    mkdirSync(r28DarkDir, { recursive: true });
    const r28Figma = join(r28DarkDir, "figma.json");
    const r28Runtime = join(r28DarkDir, "runtime.json");
    writeFileSync(
      r28Figma,
      JSON.stringify({
        color: {
          bg: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0f172a" } } },
          fg: { $type: "color", $value: "#111827", $extensions: { mode: { light: "#111827", dark: "#f8fafc" } } },
          accent: { $type: "color", $value: "#1d4ed8", $extensions: { mode: { light: "#1d4ed8", dark: "#60a5fa" } } },
        },
      })
    );
    writeFileSync(
      join(r28DarkDir, "tokens.css"),
      ":root { --ds-color-bg: #ffffff; --ds-color-fg: #111827; --ds-color-accent: #1d4ed8; }\n.dark { --ds-color-bg: #0f172a; --ds-color-fg: #f8fafc; --ds-color-accent: #60a5fa; }\n"
    );
    writeFileSync(
      r28Runtime,
      JSON.stringify({
        schema: "dsaf-runtime/2",
        files: [{ file: "index.html", computedVars: { "--ds-color-bg": "#ffffff", "--ds-color-fg": "#111827", "--ds-color-accent": "#1d4ed8" }, checks: [] }],
      })
    );
    const r28Three = compareVertices({ figmaPath: r28Figma, tokensArg: r28DarkDir, prefix: "ds", runtimePath: r28Runtime });
    assert.equal(r28Three.shippedSummary.shippedMatchedCount, 3);
    assert.equal(r28Three.shippedSummary.definedNotShippedCount, 0, "R28 A2-M4: .dark CSS overrides must not be reported as definedNotShipped in light runtime snapshot");

    // Round 29 regressions (A2-M8 .dark .card scoped isolation, A2-M9 white/black/transparent & DTCG hsl, A2-M10 --out rootDir symlink escape)
    const r29Dir = join(scratch, "r29-figma");
    const r29Outside = join(scratch, "r29-outside");
    mkdirSync(r29Dir, { recursive: true });
    mkdirSync(r29Outside, { recursive: true });
    const r29Figma = join(r29Dir, "figma.json");
    writeFileSync(
      r29Figma,
      JSON.stringify({
        color: {
          bg: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0f172a" } } },
          fg: { $type: "color", $value: "#000000" },
          clear: { $type: "color", $value: "#00000000" },
          hslStruct: { $type: "color", $value: { colorSpace: "hsl", components: [0, 100, 50] } },
        },
        shadow: { none: { $type: "shadow", $value: "0 0 0 rgba(0, 0, 0, 0)" } },
      })
    );
    writeFileSync(
      join(r29Dir, "tokens.css"),
      [
        ":root { --color-bg: white; --color-fg: black; --color-clear: transparent; --color-hsl-struct: #ff0000; --shadow-none: 0 0 0 transparent; }",
        ".dark { --color-bg: #0f172a; }",
        ".dark .card { --color-bg: #ff00aa; }",
      ].join("\n") + "\n"
    );
    const r29Diff = compareVertices({ figmaPath: r29Figma, tokensArg: r29Dir });
    assert.deepEqual(r29Diff.valueDrift, [], `R29 A2-M8/M9: expected 0 valueDrift, got ${JSON.stringify(r29Diff.valueDrift)}`);
    symlinkSync(r29Outside, join(r29Dir, "sym"));
    assert.equal(
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--figma", r29Figma, "--tokens", r29Dir, "--out", join(r29Dir, "sym/evil.json")], { encoding: "utf8" }).status,
      2,
      "R29 A2-M10: audit-figma-diff --out must reject symlink escape inside --tokens"
    );
    assert.equal(existsSync(join(r29Outside, "evil.json")), false);

    // Round 30 regressions (A2-M4 .dark recomputed :root aliases, A2-M5 prefix dedup/undotted total, A2-L7 out-of-gamut oklch canonicalization)
    const r30Dir = join(scratch, "r30-figma");
    mkdirSync(r30Dir, { recursive: true });
    writeFileSync(
      join(r30Dir, "tokens.css"),
      ":root { --brand: #1d4ed8; --btn-bg: var(--brand); }\n.dark { --brand: #60a5fa; }\n"
    );
    const r30FigmaOk = join(r30Dir, "figma-ok.json");
    writeFileSync(r30FigmaOk, JSON.stringify({ brand: "#1d4ed8", btn: { bg: "#1d4ed8" }, dark: { brand: "#60a5fa", btn: { bg: "#60a5fa" } } }));
    const r30DiffOk = compareVertices({ figmaPath: r30FigmaOk, tokensArg: r30Dir });
    assert.deepEqual(r30DiffOk.valueDrift, [], `R30 A2-M4: dark.btn.bg alias must recompute under .dark, got ${JSON.stringify(r30DiffOk.valueDrift)}`);
    const r30FigmaDrift = join(r30Dir, "figma-drift.json");
    writeFileSync(r30FigmaDrift, JSON.stringify({ dark: { btn: { bg: "#1d4ed8" } } }));
    const r30DiffDrift = compareVertices({ figmaPath: r30FigmaDrift, tokensArg: r30Dir });
    assert.equal(r30DiffDrift.valueDrift.length, 1, "R30 A2-M4: stale light dark.btn.bg in Figma must report drift against #60a5fa");

    const r30PrefixDir = join(scratch, "r30-prefix");
    mkdirSync(r30PrefixDir, { recursive: true });
    writeFileSync(join(r30PrefixDir, "tokens.css"), ":root { --ink: #111111; --accent: #222222; --border: #333333; --btn-card: #444444; }\n");
    const r30PrefixFigma = join(r30PrefixDir, "figma.json");
    writeFileSync(r30PrefixFigma, JSON.stringify({ card: "#444444" }));
    const r30PrefixDiff = compareVertices({ figmaPath: r30PrefixFigma, tokensArg: r30PrefixDir });
    assert.equal(r30PrefixDiff.summary.detectedPrefix, null, "R30 A2-M5: undotted tokens + canon dedup must prevent false 'btn' prefix");
    assert.equal(r30PrefixDiff.summary.matchedCount, 0, "R30 A2-M5: --btn-card must not match unrelated Figma 'card'");

    assert.equal(valuesMatch("oklch(0.7 0.2 250 / 50%)", "oklch(70% 50% 250deg / 0.5)"), true, "R30 A2-L7: out-of-gamut oklch % vs deg/alpha must canonicalize");
    assert.equal(valuesMatch("oklch(0.7 0.2 250deg / 100%)", "oklch(0.7 0.2 250)"), true, "R30 A2-L7: out-of-gamut oklch 100% alpha equals implicit 1");

    // Round 31 regressions (A2-H3 [data-mode="dark"] & .uxs-dark routing, A2-M9 symmetric Figma dominant prefix)
    const r31DarkDir = join(scratch, "r31-dark-mode");
    mkdirSync(r31DarkDir, { recursive: true });
    writeFileSync(
      join(r31DarkDir, "tokens.css"),
      [
        ':root[data-mode="light"] { --bg: #ffffff; }',
        ".uxs-light { --fg: #111827; }",
        '[data-mode="dark"] { --bg: #0f172a; }',
        ".uxs-dark { --fg: #f8fafc; }",
      ].join("\n") + "\n"
    );
    const r31DarkFigma = join(r31DarkDir, "figma.json");
    writeFileSync(
      r31DarkFigma,
      JSON.stringify({ bg: "#ffffff", fg: "#111827", dark: { bg: "#0f172a", fg: "#f8fafc" } })
    );
    const r31DarkDiff = compareVertices({ figmaPath: r31DarkFigma, tokensArg: r31DarkDir });
    assert.deepEqual(r31DarkDiff.valueDrift, [], `R31 A2-H3: expected 0 drift on data-mode/.uxs-dark, got ${JSON.stringify(r31DarkDiff.valueDrift)}`);
    assert.equal(r31DarkDiff.summary.triangulationCoveragePct, 100, "R31 A2-H3: dark/light selectors must route cleanly for 100% match");

    const r31SymDir = join(scratch, "r31-sym-prefix");
    mkdirSync(r31SymDir, { recursive: true });
    writeFileSync(
      join(r31SymDir, "tokens.css"),
      ":root { --color-surface: #ffffff; --color-text: #111111; --space-md: 16px; }\n"
    );
    const r31SymFigma = join(r31SymDir, "figma.json");
    writeFileSync(
      r31SymFigma,
      JSON.stringify({ ds: { color: { surface: "#ffffff", text: "#111111" }, space: { md: "16px" } } })
    );
    const r31SymDiff = compareVertices({ figmaPath: r31SymFigma, tokensArg: r31SymDir });
    assert.equal(r31SymDiff.summary.detectedPrefix, "ds", "R31 A2-M9: Figma-side dominant prefix 'ds' must be auto-detected");
    assert.equal(r31SymDiff.summary.triangulationCoveragePct, 100, "R31 A2-M9: Figma ds/* tokens must match unprefixed CSS tokens at 100%");
    assert.deepEqual(r31SymDiff.valueDrift, []);

    // Round 33 (A2-H1 & A2-M4): dark.* DTCG tokens & $root group tokens must not false-flag shipped CSS & must resolve cleanly
    const r33Dir = join(scratch, "r33-dtcg-modes");
    mkdirSync(r33Dir, { recursive: true });
    writeFileSync(
      join(r33Dir, "light.tokens.json"),
      JSON.stringify({
        surface: { $root: { $type: "color", $value: "#ffffff" }, card: { $value: "{surface.$root}" } },
        text: { primary: { $type: "color", $value: "#111111" } },
      })
    );
    writeFileSync(
      join(r33Dir, "dark.tokens.json"),
      JSON.stringify({
        surface: { $root: { $type: "color", $value: "#0b0f19" }, card: { $value: "{surface.$root}" } },
        text: { primary: { $type: "color", $value: "#f8fafc" } },
      })
    );
    const r33Figma = join(r33Dir, "figma-ext.json");
    writeFileSync(
      r33Figma,
      JSON.stringify({
        surface: {
          $type: "color",
          $value: "#ffffff",
          $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } },
        },
        surfaceCard: {
          $type: "color",
          $value: "#ffffff",
          $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } },
        },
        "surface-card": { $type: "color", $value: "{surface}", $extensions: { mode: { light: "{surface}", dark: "#0b0f19" } } },
        text: { primary: { $type: "color", $value: "#111111", $extensions: { mode: { light: "#111111", dark: "#f8fafc" } } } },
      })
    );
    const r33Rt = join(r33Dir, "runtime.json");
    writeFileSync(
      r33Rt,
      JSON.stringify({
        schema: "dsaf-pw/1",
        allPassed: true,
        files: [
          {
            file: "index.html",
            passed: true,
            computedVars: {
              "--surface": "#ffffff",
              "--surface-card": "#ffffff",
              "--text-primary": "#111111",
            },
          },
        ],
      })
    );
    const r33Ship = compareDefinedToShipped({ tokensArg: r33Dir, runtimePath: r33Rt });
    assert.deepEqual(r33Ship.shippedSummary.definedNotShipped, [], `R33 A2-H1/M4: split light/dark + $root must yield 0 definedNotShipped, got ${JSON.stringify(r33Ship.shippedSummary.definedNotShipped)}`);
    assert.equal(r33Ship.shippedSummary.shippedMatchedCount, 3, "R33 A2-H1/M4: 3 light/root tokens should match shipped CSS vars");
    const r33ExtDir = join(scratch, "r33-dtcg-ext");
    mkdirSync(r33ExtDir, { recursive: true });
    const r33ExtTok = join(r33ExtDir, "tokens.json");
    writeFileSync(
      r33ExtTok,
      JSON.stringify({
        surface: { $root: { $type: "color", $value: "#ffffff", $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } } } },
        surfaceCard: { $type: "color", $value: "{surface.$root}", $extensions: { mode: { light: "{surface.$root}", dark: "#0b0f19" } } },
        text: { primary: { $type: "color", $value: "#111111", $extensions: { mode: { light: "#111111", dark: "#f8fafc" } } } },
      })
    );
    const r33ExtFigma = join(r33ExtDir, "figma.json");
    writeFileSync(
      r33ExtFigma,
      JSON.stringify({
        light: { surface: "#ffffff", "surface-card": "#ffffff", "text.primary": "#111111" },
        dark: { surface: "#0b0f19", "surface-card": "#0b0f19", "text.primary": "#f8fafc" },
      })
    );
    const r33Tri = compareVertices({ figmaPath: r33ExtFigma, tokensArg: r33ExtTok, runtimePath: r33Rt });
    assert.deepEqual(r33Tri.shippedSummary.definedNotShipped, [], `R33 A2-H1: compareVertices shippedSummary must skip dark.* DTCG tokens, got ${JSON.stringify(r33Tri.shippedSummary.definedNotShipped)}`);
    assert.equal(r33Tri.shippedSummary.shippedMatchedCount, 3);

    // Round 34 (A2-M16 dual distinct prefixes, A2-M17 symmetric light.* & non-light/dark mode aliases, A2-L18 URL-first Code Connect, A2-L19 symlinked --figma in --tokens):
    const r34PrefixDir = join(scratch, "r34-prefixes");
    mkdirSync(r34PrefixDir, { recursive: true });
    const r34FigmaPlain = join(r34PrefixDir, "figma-vars.tokens.json");
    writeFileSync(
      r34FigmaPlain,
      JSON.stringify({
        tokens: {
          color: { bg: { $value: "#ffffff" }, primary: { $value: "#2563eb" } },
          spacing: { md: { $value: "16px" } },
        },
      })
    );
    writeFileSync(
      join(r34PrefixDir, "ds.css"),
      ":root { --ds-color-bg: #ffffff; --ds-color-primary: #2563eb; --ds-spacing-md: 1rem; }\n"
    );
    const r34DualPrefixRes = compareVertices({
      figmaPath: r34FigmaPlain,
      tokensArg: join(r34PrefixDir, "ds.css"),
    });
    assert.equal(r34DualPrefixRes.summary.matchedCount, 3, "R34 A2-M16: distinct figmaPrefix (tokens) and definedPrefix (ds) must all match");
    assert.equal(r34DualPrefixRes.summary.designOnlyCount, 0);
    assert.equal(r34DualPrefixRes.summary.codeOnlyCount, 0);

    const r34SymRepo = join(scratch, "r34-sym-repo");
    mkdirSync(join(r34SymRepo, "tokens"), { recursive: true });
    writeFileSync(
      join(r34SymRepo, "tokens/light.json"),
      JSON.stringify({
        color: { bg: { $type: "color", $value: "#ffffff" }, primary: { $type: "color", $value: "#2563eb" } },
        spacing: {
          sm: { $type: "dimension", $value: "8px", $extensions: { mode: { compact: "4px" } } },
          card: { $type: "dimension", $value: "16px", $extensions: { mode: { compact: "{spacing.sm}" } } },
        },
      })
    );
    const r34FigmaSymTarget = join(r34SymRepo, "tokens/figma-vars.tokens.json");
    writeFileSync(
      r34FigmaSymTarget,
      JSON.stringify({
        tokens: {
          color: { bg: { $value: "#ffffff" }, primary: { $value: "#2563eb" } },
          spacing: { md: { $value: "16px" } },
        },
      })
    );
    const r34FigmaSymLink = join(scratch, "r34-figma-link.json");
    symlinkSync(r34FigmaSymTarget, r34FigmaSymLink);
    const r34LightAndSymRes = compareVertices({
      figmaPath: r34FigmaSymLink,
      tokensArg: r34SymRepo,
    });
    assert.ok(
      r34LightAndSymRes.matchedTokens.some((m) => m.key === "tokens.color.bg" && m.value === "#ffffff"),
      "R34 A2-M17 & A2-L19: unprefixed/prefixed Figma key must match tokens/light.json while symlinked figma target inside --tokens is excluded"
    );
    const r34TokLoaded = loadDefinedTokens(r34SymRepo, new Set([canonFsPath(r34FigmaSymLink)]));
    assert.equal(r34TokLoaded.get("compact.spacing.card"), "4px", "R34 A2-M17: non-light/dark $extensions.mode sibling alias must resolve to compact value 4px");
    assert.equal(r34TokLoaded.has("tokens.spacing.md"), false, "R34 A2-L19: symlinked --figma target inside --tokens must be excluded");

    const r34CcDir = join(scratch, "r34-cc");
    mkdirSync(r34CcDir, { recursive: true });
    writeFileSync(
      join(r34CcDir, "button.figma.ts"),
      'figma.connect("https://www.figma.com/design/abc/DS?node-id=1-2", { example: () => html`<ds-button></ds-button>` });\n'
    );
    const r34Cc = scanCodeConnect(r34CcDir);
    assert.ok(r34Cc.mappedComponents.includes("ds-button"), `R34 A2-L18: URL-first figma.connect must extract ds-button, got ${JSON.stringify(r34Cc.mappedComponents)}`);

    // Round 36 (R35-A2-M1 out-of-gamut srgb, R35-A2-M4 fontFamily array, R35-A2-M5 CSS Color 4 & / 1 alpha):
    assert.equal(valuesMatch({ colorSpace: "srgb", components: [1.093, -0.226, -0.15] }, "#ff0000"), true);
    assert.equal(valuesMatch({ colorSpace: "srgb", components: [1.093, -0.226, -0.15] }, "#010000"), false);
    assert.equal(valuesMatch(["IBM Plex Sans", "Helvetica Neue"], "IBM Plex Sans"), true);
    assert.equal(valuesMatch("color(srgb 1 0 0)", "#ff0000"), true);
    assert.equal(valuesMatch("hwb(0 0% 0%)", "#ff0000"), true);
    assert.equal(valuesMatch("lab(54.29 80.81 69.89)", "#ff0000"), true);
    assert.equal(valuesMatch("rgb(none 255 0)", "#00ff00"), true);
    assert.equal(valuesMatch("hsl(none 100% 50%)", "#ff0000"), true);
    assert.equal(valuesMatch({ colorSpace: "display-p3", components: [1, 0, 0], alpha: 1 }, "color(display-p3 1 0 0 / 1)"), true);

    // Round 37 (R36-A2-M4 DTCG $extends + R36-A2-L1 display-p3 % + scientific oklch):
    const r37ExtTok = join(scratch, "r37-extends.tokens.json");
    const r37ExtFig = join(scratch, "r37-extends.figma.json");
    writeFileSync(
      r37ExtTok,
      JSON.stringify({
        base: {
          bg: { $type: "color", $value: "#ffffff" },
          fg: { $type: "color", $value: "#111111" },
        },
        dark: {
          $extends: "{base}",
          bg: { $type: "color", $value: "#09090b" },
        },
      })
    );
    writeFileSync(
      r37ExtFig,
      JSON.stringify({
        "base/bg": "#ffffff",
        "base/fg": "#111111",
        "dark/bg": "#09090b",
        "dark/fg": "#111111",
      })
    );
    const r37ExtRes = compareVertices({ figmaPath: r37ExtFig, tokensArg: r37ExtTok });
    assert.equal(r37ExtRes.summary.triangulationCoveragePct, 100, "R37 A2-M4: DTCG $extends inherited group child must resolve in figma-diff");
    assert.equal(r37ExtRes.summary.designOnlyCount, 0);

    assert.equal(valuesMatch({ colorSpace: "display-p3", components: [1, 0, 0] }, "color(display-p3 100% 0% 0%)"), true, "R37 A2-L1: display-p3 % channels must normalize");
    assert.equal(valuesMatch("oklch(0.6 0.2 30)", "oklch(6e-1 2e-1 3e1)"), true, "R37 A2-L1: scientific notation in oklch must parse");

    // Round 38 (R37-A2-L3 rounded alpha 1 + R37-A2-M3 leaf .light/.dark aliases):
    assert.equal(
      valuesMatch({ colorSpace: "display-p3", components: [1, 0.5, 0], alpha: 0.9999999 }, "color(display-p3 1 0.5 0)"),
      true,
      "R38 A2-L3: alpha rounding to 1 must omit / 1 on wide-gamut color()"
    );
    const r38LeafTok = join(scratch, "r38-leaf.tokens.json");
    const r38LeafFig = join(scratch, "r38-leaf.figma.json");
    writeFileSync(
      r38LeafTok,
      JSON.stringify({
        color: {
          $type: "color",
          bg: { light: { $value: "#ffffff" }, dark: { $value: "#111111" } },
          cardText: { light: { $value: "{color.bg}" }, dark: { $value: "{color.bg}" } },
        },
      })
    );
    writeFileSync(
      r38LeafFig,
      JSON.stringify({
        "color/bg/light": "#ffffff",
        "color/bg/dark": "#111111",
        "color/cardText/light": "#ffffff",
        "color/cardText/dark": "#111111",
      })
    );
    const r38LeafRes = compareVertices({ figmaPath: r38LeafFig, tokensArg: r38LeafTok });
    assert.equal(r38LeafRes.summary.triangulationCoveragePct, 100, "R38 A2-M3: leaf .light/.dark alias targets must match Figma variables");

    // Round 40 (R39-A2-M6 $extensions.mode-only tokens + R39-A2-M7 dark composite with .dark CSS custom prop):
    const r40ExtTok = join(scratch, "r40-ext-tokens.json");
    const r40ExtFig = join(scratch, "r40-ext-figma.json");
    writeFileSync(
      r40ExtTok,
      JSON.stringify({
        color: {
          $type: "color",
          surface: { $extensions: { mode: { light: "#ffffff", dark: "#0b0f19" } } },
          accent: { $extensions: { mode: { dark: "#38bdf8" } } },
        },
      })
    );
    writeFileSync(
      r40ExtFig,
      JSON.stringify({
        "light/color/surface": "#ffffff",
        "dark/color/surface": "#0b0f19",
        "dark/color/accent": "#38bdf8",
      })
    );
    const r40ExtDiff = compareVertices({ figmaPath: r40ExtFig, tokensArg: r40ExtTok });
    assert.equal(r40ExtDiff.summary.triangulationCoveragePct, 100, "R40 A2-M6: $extensions.mode-only tokens without $value must resolve in compareVertices");
    assert.equal(r40ExtDiff.summary.valueDriftCount, 0);

    const r40DarkCompDir = join(scratch, "r40-dark-comp");
    const r40DarkCompFig = join(scratch, "r40-dark-comp-figma.json");
    const r40DarkCompFigStale = join(scratch, "r40-dark-comp-figma-stale.json");
    mkdirSync(r40DarkCompDir, { recursive: true });
    writeFileSync(
      join(r40DarkCompDir, "dark.tokens.json"),
      JSON.stringify({
        shadow: { card: { $type: "shadow", $value: "0 4px 8px {color.ring}" } },
      })
    );
    writeFileSync(
      join(r40DarkCompDir, "theme.css"),
      ":root { --color-ring: #000000; }\n.dark { --color-ring: #38bdf8; }\n"
    );
    writeFileSync(
      r40DarkCompFig,
      JSON.stringify({
        "dark/shadow/card": "0 4px 8px #38bdf8",
        "color/ring": "#000000",
        "dark/color/ring": "#38bdf8",
      })
    );
    writeFileSync(
      r40DarkCompFigStale,
      JSON.stringify({
        "dark/shadow/card": "0 4px 8px #000000",
        "color/ring": "#000000",
        "dark/color/ring": "#38bdf8",
      })
    );
    const r40DarkOk = compareVertices({ figmaPath: r40DarkCompFig, tokensArg: r40DarkCompDir });
    assert.equal(r40DarkOk.summary.valueDriftCount, 0, "R40 A2-M7: dark.shadow.card must resolve {color.ring} from .dark CSS (#38bdf8) without drift");
    assert.equal(r40DarkOk.summary.matchedCount, 3, "R40 A2-M7: all 3 dark/base tokens must match");
    assert.equal(r40DarkOk.summary.codeOnlyCount, 0, "R40 A2-M7: dark.shadow.card must not be double-prefixed dark.dark.shadow.card");
    const r40DarkStale = compareVertices({ figmaPath: r40DarkCompFigStale, tokensArg: r40DarkCompDir });
    assert.equal(r40DarkStale.summary.valueDriftCount, 1, "R40 A2-M7: stale :root #000000 in Figma dark.shadow.card must report drift against .dark #38bdf8");

    // Round 41 (R40-A2-H3 unwrapped W3C dim/oklch/shadow & legacy dim value + R40-A2-M5 em vs px & recursive composite match):
    assert.equal(valuesMatch("1em", "16px"), true, "R41 A2-M5: 1em must equal 16px");
    assert.equal(
      valuesMatch(
        { fontFamily: ["Inter", "sans-serif"], fontSize: "1rem", fontWeight: "Bold" },
        { fontFamily: "Inter, sans-serif", fontSize: "16px", fontWeight: 700 }
      ),
      true,
      "R41 A2-M5: composite typography objects must compare fields via valuesMatch"
    );
    const r41UnwrappedFig = join(scratch, "r41-unwrapped-fig.json");
    const r41WrappedCode = join(scratch, "r41-wrapped-code.json");
    writeFileSync(
      r41UnwrappedFig,
      JSON.stringify({
        space: {
          md: { value: 1, unit: "rem" },
          lg: { type: "dimension", value: { value: 2, unit: "em" } },
        },
        color: {
          accent: { colorSpace: "oklch", components: [0.6231, 0.188, 259.81] },
        },
        shadow: {
          card: { offsetX: "0px", offsetY: "4px", blur: "12px", spread: "0px", color: "#000000" },
        },
        typo: {
          body: {
            $type: "typography",
            $value: { fontFamily: ["Inter", "sans-serif"], fontSize: "1rem", fontWeight: "Bold" },
          },
        },
      })
    );
    writeFileSync(
      r41WrappedCode,
      JSON.stringify({
        space: {
          md: { $type: "dimension", $value: "16px" },
          lg: { $type: "dimension", $value: "32px" },
        },
        color: {
          accent: { $type: "color", $value: "#3b82f6" },
        },
        shadow: {
          card: { $type: "shadow", $value: "0 4px 12px #000000" },
        },
        typo: {
          body: {
            $type: "typography",
            $value: { fontFamily: "Inter, sans-serif", fontSize: "16px", fontWeight: 700 },
          },
        },
      })
    );
    const r41Comp = compareVertices({ figmaPath: r41UnwrappedFig, tokensArg: r41WrappedCode });
    assert.equal(r41Comp.summary.matchedCount, 5, "R41 A2-H3/M5: unwrapped W3C objects, legacy dimension, em/px, and composite typography must match cleanly");
    assert.equal(r41Comp.summary.valueDriftCount, 0);

    // Round 42 (R41-A2-M7 shadow length unit normalization rem/em vs px/0):
    const r42ShadowFig = join(scratch, "r42-shadow-figma.json");
    const r42ShadowCode = join(scratch, "r42-shadow-code.json");
    writeFileSync(
      r42ShadowFig,
      JSON.stringify({
        shadow: {
          sm: { $type: "shadow", $value: "0 0.25rem 0.5rem rgba(0, 0, 0, 0.2)" },
          md: { $type: "shadow", $value: "0 0.25rem 0.75rem rgba(0, 0, 0, 0.2)" },
        },
      })
    );
    writeFileSync(
      r42ShadowCode,
      JSON.stringify({
        shadow: {
          sm: { $type: "shadow", $value: "0px 4px 8px rgba(0, 0, 0, 0.2)" },
          md: { $type: "shadow", $value: "0px 4px 8px rgba(0, 0, 0, 0.2)" },
        },
      })
    );
    const r42ShadowDiff = compareVertices({ figmaPath: r42ShadowFig, tokensArg: r42ShadowCode });
    assert.equal(r42ShadowDiff.summary.matchedCount, 1);
    assert.equal(r42ShadowDiff.summary.valueDriftCount, 1, "R42 A2-M7: 0.25rem/0.5rem matches 4px/8px while 0.75rem vs 8px must still drift");
    assert.equal(r42ShadowDiff.valueDrift[0].key, "shadow.md");

    // Round 43 (R42-A2-H5 structured dimension in $extensions.mode, R42-A2-M11 component 4-decimal rounding, R42-A2-M12 cross/split prefixes):
    const r43Dir = join(scratch, "r43-figma-diff");
    mkdirSync(r43Dir, { recursive: true });
    const r43TokPath = join(r43Dir, "tokens.json");
    const r43FigPath = join(r43Dir, "figma.json");
    writeFileSync(
      r43TokPath,
      JSON.stringify({
        space: {
          pad: {
            $type: "dimension",
            $value: { value: 1, unit: "rem" },
            $extensions: { mode: { compact: { value: 0.5, unit: "rem" } } },
          },
        },
        color: {
          p3: { $type: "color", $value: { colorSpace: "display-p3", components: [0.8999999761581421, 0.2, 0.1] } },
        },
      })
    );
    writeFileSync(
      r43FigPath,
      JSON.stringify({
        compact: { space: { pad: { $type: "dimension", $value: "8px" } } },
        color: { p3: { $type: "color", $value: "color(display-p3 0.9 0.2 0.1)" } },
      })
    );
    const r43Diff = compareVertices({ figmaPath: r43FigPath, tokensArg: r43TokPath });
    assert.equal(r43Diff.summary.matchedCount, 2, "R43 A2-H5/M11: mode structured dimension & 4-dec P3 components must match");
    assert.equal(r43Diff.summary.valueDriftCount, 0);

    const r43SplitDef = join(r43Dir, "split-def.json");
    const r43SplitRt = join(r43Dir, "split-rt.json");
    writeFileSync(
      r43SplitDef,
      JSON.stringify({
        light: { ds: { a: { $value: "#111111" }, b: { $value: "#222222" } } },
        dark: { ds: { a: { $value: "#eeeeee" }, b: { $value: "#dddddd" } } },
      })
    );
    writeFileSync(
      r43SplitRt,
      JSON.stringify({
        files: [{ computedVars: { "--a": "#111111", "--b": "#222222" } }],
      })
    );
    const r43SplitRes = compareDefinedToShipped({ tokensArg: r43SplitDef, runtimePath: r43SplitRt });
    assert.equal(r43SplitRes.summary.definedNotShippedCount, 0, "R43 A2-M12: 50/50 light/dark split prefix must match unprefixed shipped vars");

    const r43FigPlain = join(r43Dir, "fig-plain.json");
    const r43DefDs = join(r43Dir, "def-ds.json");
    const r43RtApp = join(r43Dir, "rt-app.json");
    writeFileSync(r43FigPlain, JSON.stringify({ color: { bg: "#ffffff", fg: "#111111", acc: "#1d4ed8" } }));
    writeFileSync(r43DefDs, JSON.stringify({ ds: { color: { bg: "#ffffff", fg: "#111111", acc: "#1d4ed8" } } }));
    writeFileSync(r43RtApp, JSON.stringify({ files: [{ computedVars: { "--app-color-bg": "#ffffff", "--app-color-fg": "#111111", "--app-color-acc": "#1d4ed8" } }] }));
    const r43ThreeRes = compareVertices({ figmaPath: r43FigPlain, tokensArg: r43DefDs, runtimePath: r43RtApp });
    assert.equal(r43ThreeRes.shippedSummary.shippedMatchedCount, 3, "R43 A2-M12: 3-vertex different shipped prefix (--app-*) must match cleanly");

    // Round 44 (R43-A2-H10 split mode prefix strip, R43-A2-M11 cross-file $extends, R43-A2-M12 CSS named colors/light-dark/color-mix):
    const r44Dir = join(scratch, "r44-figma-diff");
    mkdirSync(join(r44Dir, "split-toks"), { recursive: true });
    writeFileSync(
      join(r44Dir, "split-toks/light.tokens.json"),
      JSON.stringify({ acme: { color: { bg: { $type: "color", $value: "#ffffff" }, fg: { $type: "color", $value: "#111111" } } } })
    );
    writeFileSync(
      join(r44Dir, "split-toks/dark.tokens.json"),
      JSON.stringify({ acme: { color: { bg: { $type: "color", $value: "#0f172a" }, fg: { $type: "color", $value: "#f8fafc" } } } })
    );
    const r44SplitFig = join(r44Dir, "split-figma.json");
    writeFileSync(
      r44SplitFig,
      JSON.stringify({
        light: { color: { bg: "#ffffff", fg: "#111111" } },
        dark: { color: { bg: "#0f172a", fg: "#f8fafc" } },
      })
    );
    const r44SplitRes = compareVertices({ figmaPath: r44SplitFig, tokensArg: join(r44Dir, "split-toks") });
    assert.equal(r44SplitRes.summary.detectedPrefix, "acme", "R44 A2-H10: split light./dark. keys must detect 'acme' prefix");
    assert.equal(r44SplitRes.summary.designOnlyCount, 0, "R44 A2-H10: split light./dark. keys must match without designOnlyTokens");
    assert.equal(r44SplitRes.summary.matchedCount, 4);

    mkdirSync(join(r44Dir, "ext-toks"), { recursive: true });
    writeFileSync(join(r44Dir, "ext-toks/base.tokens.json"), JSON.stringify({ base: { card: { bg: { $type: "color", $value: "#ffffff" } } } }));
    writeFileSync(join(r44Dir, "ext-toks/theme.tokens.json"), JSON.stringify({ card: { $extends: "{base.card}" } }));
    const r44ExtFig = join(r44Dir, "ext-fig.json");
    writeFileSync(r44ExtFig, JSON.stringify({ card: { bg: "#ffffff" } }));
    const r44ExtRes = compareVertices({ figmaPath: r44ExtFig, tokensArg: join(r44Dir, "ext-toks") });
    assert.equal(r44ExtRes.summary.matchedCount, 1, "R44 A2-M11: cross-file $extends must resolve inside loadDefinedTokens");

    assert.equal(valuesMatch("cornflowerblue", "#6495ed"), true, "R44 A2-M12: CSS Color 4 named color must normalize");
    assert.equal(valuesMatch("color-mix(in srgb, red 50%, blue)", "#800080"), true, "R44 A2-M12: color-mix must normalize");
    assert.equal(valuesMatch("#ffffff", "light-dark(white, #0b0f19)", "light"), true, "R44 A2-M12: light-dark light branch");
    assert.equal(valuesMatch("#0b0f19", "light-dark(white, #0b0f19)", "dark"), true, "R44 A2-M12: light-dark dark branch");

    // Round 45 (negative chroma C<0 clamping in lch):
    assert.equal(valuesMatch("lch(60 -50 30)", "lch(60 0 30)"), true, "R45 A2-L1: lch() CSS string negative chroma must clamp to 0");
    assert.equal(valuesMatch({ colorSpace: "lch", components: [60, -50, 30] }, "lch(60 0 30)"), true, "R45 A2-L1: W3C lch negative chroma must clamp to 0");

    // Round 46 (A2-M5 color-mix+light-dark loading preservation, A2-M6 :root light-dark dark fallback, A2-M7 calc/min/max inside oklch/oklab/color):
    const r46Dir = join(scratch, "r46-ld");
    mkdirSync(join(r46Dir, "toks"), { recursive: true });
    writeFileSync(
      join(r46Dir, "toks/tokens.css"),
      ":root {\n  color-scheme: light dark;\n  --bg: color-mix(in srgb, light-dark(#ffffff, #000000) 50%, #000000);\n  --surface: light-dark(#ffffff, #000000);\n}\n"
    );
    const r46Fig = join(r46Dir, "figma.json");
    writeFileSync(
      r46Fig,
      JSON.stringify({
        light: { bg: "#808080", surface: "#ffffff" },
        dark: { bg: "#000000", surface: "#000000" },
      })
    );
    const r46Res = compareVertices({ figmaPath: r46Fig, tokensArg: join(r46Dir, "toks") });
    assert.equal(r46Res.summary.designOnlyCount, 0, "R46 A2-M6: dark.* keys must resolve against :root light-dark() vars");
    assert.equal(r46Res.summary.valueDriftCount, 0, "R46 A2-M5/M6: color-mix(light-dark(...)) and light-dark(...) must match both modes cleanly");
    assert.equal(r46Res.summary.matchedCount, 4);

    assert.equal(valuesMatch("oklch(calc(0.5 + 0.1) 0.1 250)", "oklch(0.6 0.1 250)"), true, "R46 A2-M7: oklch calc() must match");
    assert.equal(valuesMatch("oklab(calc(0.5 + 0.1) 0.05 -0.05)", "oklab(0.6 0.05 -0.05)"), true, "R46 A2-M7: oklab calc() must match");
    assert.equal(valuesMatch("color(srgb calc(0.5 + 0.5) 0 0)", "#ff0000"), true, "R46 A2-M7: color(srgb calc()) must match #ff0000");
    assert.equal(valuesMatch("color(display-p3 calc(0.5 + 0.5) 0 0)", "color(display-p3 1 0 0)"), true, "R46 A2-M7: color(display-p3 calc()) must match");

    // Round 47 (A2-M7 in-sRGB-gamut color(display-p3/srgb-linear/xyz-d65) normalization to #hex/rgba while keeping out-of-gamut colors):
    assert.equal(valuesMatch("color(display-p3 0.1666 0.3017 0.8158)", "#1d4ed8"), true, "R47 A2-M7: in-gamut color(display-p3) string must match #1d4ed8");
    assert.equal(valuesMatch({ colorSpace: "display-p3", components: [0.1666, 0.3017, 0.8158] }, "#1d4ed8"), true, "R47 A2-M7: in-gamut W3C display-p3 object must match #1d4ed8");
    assert.equal(valuesMatch("color(display-p3 0.1666 0.3017 0.8158 / 0.5)", "rgba(29, 78, 216, 0.5)"), true, "R47 A2-M7: in-gamut color(display-p3) with alpha must match rgba()");
    assert.equal(valuesMatch("color(srgb-linear 1 0 0)", "#ff0000"), true, "R47 A2-M7: in-gamut color(srgb-linear) must match #ff0000");
    assert.equal(valuesMatch({ colorSpace: "xyz-d65", components: [0.4124, 0.2126, 0.0193] }, "#ff0000"), true, "R47 A2-M7: in-gamut W3C xyz-d65 object must match #ff0000");
    assert.equal(normalizeValue("color(display-p3 1 0 0)"), "color(display-p3 1 0 0)", "R47 A2-M7: out-of-sRGB-gamut color(display-p3 1 0 0) must stay color(display-p3 1 0 0)");

    // Round 48 (A2-M4 out-of-sRGB-gamut lab/lch/hwb must preserve wide-gamut values while in-gamut still matches hex):
    assert.equal(normalizeValue("lab(85 -160 130)"), "lab(85 -160 130)", "R48 A2-M4: out-of-gamut lab() must stay wide-gamut");
    assert.equal(valuesMatch("lab(85 -160 130)", { colorSpace: "lab", components: [85, -160, 130] }), true, "R48 A2-M4: out-of-gamut CSS lab() must match DTCG lab object");
    assert.equal(normalizeValue("lch(87 180 136deg)"), "lch(87 180 136)", "R48 A2-M4: out-of-gamut lch() must stay canonical wide-gamut");
    assert.equal(valuesMatch("lch(87 180 136deg / 0.5)", { colorSpace: "lch", components: [87, 180, -224], alpha: 0.5 }), true, "R48 A2-M4: out-of-gamut lch() with angle/alpha must match DTCG object");
    assert.equal(normalizeValue("hwb(120 -20% 0%)"), "hwb(120 -20 0)", "R48 A2-M4: out-of-gamut hwb() must stay canonical wide-gamut");
    assert.equal(valuesMatch("hwb(120 -20% 0%)", { colorSpace: "hwb", components: [120, -20, 0] }), true, "R48 A2-M4: out-of-gamut hwb() must match DTCG object");
    assert.equal(valuesMatch("lab(54.2917 80.8125 69.8851)", "#ff0000"), true, "R48 A2-M4: in-gamut lab() must still match #ff0000");
    assert.equal(valuesMatch("hwb(120 20% 20%)", "#33cc33"), true, "R48 A2-M4: in-gamut hwb() must still match #33cc33");

    // Round 49 (A2-H1 loadDefinedTokens escaping symlink & dsaf-tokens manifest containment):
    const r49Out = join(scratch, "r49-outside");
    const r49Repo = join(scratch, "r49-repo");
    mkdirSync(join(r49Out, "sub"), { recursive: true });
    mkdirSync(join(r49Repo, "tokens"), { recursive: true });
    mkdirSync(join(r49Repo, "styles"), { recursive: true });
    writeFileSync(join(r49Out, "leak.tokens.json"), JSON.stringify({ $type: "color", secret: { external: { $value: "#ff00aa" } } }));
    writeFileSync(join(r49Out, "sub/dir-leak.tokens.json"), JSON.stringify({ $type: "color", secret: { dirleak: { $value: "#112233" } } }));
    writeFileSync(join(r49Out, "leak.css"), ":root { --ext-leak: #abcdef; }\n");
    writeFileSync(join(r49Repo, "tokens/ok.tokens.json"), JSON.stringify({ $type: "color", brand: { primary: { $value: "#1d4ed8" } } }));
    symlinkSync(join(r49Out, "leak.tokens.json"), join(r49Repo, "tokens/leak.tokens.json"));
    symlinkSync(join(r49Out, "sub"), join(r49Repo, "tokens/ext-dir"));
    symlinkSync(join(r49Out, "leak.css"), join(r49Repo, "styles/leak.css"));
    const r49Loaded = loadDefinedTokens(r49Repo);
    assert.equal(r49Loaded.has("brand.primary"), true, "R49 A2-H1: in-root token must load");
    assert.equal(r49Loaded.has("secret.external"), false, "R49 A2-H1: escaping file symlink token must be ignored");
    assert.equal(r49Loaded.has("secret.dirleak"), false, "R49 A2-H1: escaping dir symlink token must be ignored");
    assert.equal(r49Loaded.has("ext.leak"), false, "R49 A2-H1: escaping CSS symlink token must be ignored");
    const r49ManifestPath = join(r49Repo, "dsaf-tokens.json");
    writeFileSync(
      r49ManifestPath,
      JSON.stringify({
        schema: "dsaf-tokens/1",
        target: r49Repo,
        dtcgFiles: [{ file: "tokens/ok.tokens.json" }, { file: "../r49-outside/leak.tokens.json" }, { file: "tokens/leak.tokens.json" }],
      })
    );
    const r49ManifestLoaded = loadDefinedTokens(r49ManifestPath);
    assert.equal(r49ManifestLoaded.has("brand.primary"), true);
    assert.equal(r49ManifestLoaded.has("secret.external"), false, "R49 A2-H1: dsaf-tokens manifest must block escaping relative/symlink dtcgFiles");

    // Round 50 (R50-A2-M1 scanCodeConnect root containment + R50-A2-M2 color() none/xyz-d65 canonicalization):
    const r50CcOutside = join(scratch, "r50-cc-outside");
    const r50CcDir = join(scratch, "r50-cc");
    mkdirSync(r50CcOutside, { recursive: true });
    mkdirSync(r50CcDir, { recursive: true });
    writeFileSync(join(r50CcOutside, "EscapeDir.figma.tsx"), 'figma.connect(EscapeDir, "https://figma.com/file/abc", {});\n');
    writeFileSync(join(r50CcOutside, "EscapeFile.figma.tsx"), 'figma.connect(EscapeFile, "https://figma.com/file/abc", {});\n');
    writeFileSync(join(r50CcOutside, "SecretBatch.json"), JSON.stringify(["SecretComp"]));
    writeFileSync(join(r50CcDir, "Batch.figma.batch.tsx"), 'figma.connect(RealBatch, "https://figma.com/file/abc", {});\n');
    symlinkSync(r50CcOutside, join(r50CcDir, "ext-dir"));
    symlinkSync(join(r50CcOutside, "EscapeFile.figma.tsx"), join(r50CcDir, "ExtFile.figma.tsx"));
    symlinkSync(join(r50CcOutside, "SecretBatch.json"), join(r50CcDir, "Batch.figma.batch.json"));
    const r50CcDirRes = scanCodeConnect(r50CcDir);
    assert.deepEqual(r50CcDirRes.mappedComponents, ["RealBatch"], "R50 A2-M1: scanCodeConnect must block escaping dir/file/batch symlinks");
    assert.equal(r50CcDirRes.batchEntriesCount, 0);
    const r50CcFileRes = scanCodeConnect(join(r50CcDir, "Batch.figma.batch.tsx"));
    assert.deepEqual(r50CcFileRes.mappedComponents, ["RealBatch"], "R50 A2-M1: single-file scanCodeConnect must block escaping batch JSON symlinks");
    assert.equal(r50CcFileRes.batchEntriesCount, 0);

    assert.equal(valuesMatch("color(display-p3 1 none 0)", "color(display-p3 1 0 0)"), true, "R50 A2-M2: wide-gamut color() 'none' component must normalize to 0");
    assert.equal(valuesMatch({ colorSpace: "display-p3", components: [1, "none", 0] }, "color(display-p3 1 0 0)"), true);
    assert.equal(valuesMatch({ colorSpace: "display-p3", components: [1, "none", 0], alpha: "none" }, "color(display-p3 1 0 0 / none)"), true);
    assert.equal(valuesMatch("color(xyz 1 0 0)", "color(xyz-d65 1 0 0)"), true, "R50 A2-M2: color(xyz ...) must canonicalize to xyz-d65");
    assert.equal(valuesMatch({ colorSpace: "xyz", components: [1, 0, 0] }, "color(xyz-d65 1 0 0)"), true);
    assert.equal(valuesMatch({ colorSpace: "xyz", components: [1, "none", 0] }, "color(xyz-d65 1 0 0)"), true);

    console.log("AUDIT_FIGMA_DIFF_SELF_TEST_PASSED (alias resolve + value drift + 2/3-vertex shipped + Code Connect v2)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        figma: { type: "string" },
        tokens: { type: "string" },
        prefix: { type: "string" },
        "code-connect": { type: "string" },
        runtime: { type: "string" },
        format: { type: "string", default: "json" },
        json: { type: "boolean", default: false },
        out: { type: "string" },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(
      "Usage: node skill/scripts/audit-figma-diff.mjs --tokens <tokens.json|dir|tokens-report.json> [--figma <figma-vars.json>] [--runtime <runtime.json>] [--prefix <str>] [--code-connect <dir>] [--json] [--format json|markdown] [--out <file>] [--self-test] [--help]"
    );
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());

  const cleanFmt = String(values.format || "").toLowerCase();
  if (cleanFmt !== "json" && cleanFmt !== "markdown") {
    console.error(`Error: invalid --format '${values.format}'. Expected json|markdown.`);
    process.exit(2);
  }
  if (!values.tokens || !values.tokens.trim()) {
    console.error("Error: non-empty --tokens is required unless --self-test is passed.");
    process.exit(2);
  }
  if (values.figma !== undefined && !values.figma.trim()) {
    console.error("Error: --figma <file> cannot be empty or whitespace-only.");
    process.exit(2);
  }
  if (values.runtime !== undefined && !values.runtime.trim()) {
    console.error("Error: --runtime <file> cannot be empty or whitespace-only.");
    process.exit(2);
  }
  if (values["code-connect"] !== undefined && !values["code-connect"].trim()) {
    console.error("Error: --code-connect <dir> cannot be empty or whitespace-only.");
    process.exit(2);
  }
  if (values.prefix !== undefined && !values.prefix.trim()) {
    console.error("Error: --prefix <str> cannot be empty or whitespace-only.");
    process.exit(2);
  }
  if (!values.figma && !values.runtime) {
    console.error("Error: --tokens together with --figma or --runtime is required unless --self-test is passed.");
    process.exit(2);
  }
  if (!existsSync(resolve(values.tokens))) {
    console.error(`Error: Tokens target not found: ${resolve(values.tokens)}`);
    process.exit(2);
  }
  if (values.figma && (!existsSync(resolve(values.figma)) || !statSync(resolve(values.figma)).isFile())) {
    console.error(`Error: Figma variables file not found: ${resolve(values.figma)}`);
    process.exit(2);
  }
  if (values.runtime && (!existsSync(resolve(values.runtime)) || !statSync(resolve(values.runtime)).isFile())) {
    console.error(`Error: Runtime audit file not found: ${resolve(values.runtime)}`);
    process.exit(2);
  }
  if (values["code-connect"] && (!existsSync(resolve(values["code-connect"])) || !statSync(resolve(values["code-connect"])).isDirectory())) {
    console.error(`Error: Code Connect directory not found: ${resolve(values["code-connect"])}`);
    process.exit(2);
  }
  if (values.out !== undefined) {
    try {
      const tokensAbs = resolve(values.tokens);
      const tokensRoot = statSync(tokensAbs).isDirectory() ? tokensAbs : dirname(tokensAbs);
      assertWritableOutputFile(values.out, "--out", { rootDir: tokensRoot });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  try {
    const res = values.figma
      ? compareVertices({
          figmaPath: values.figma,
          tokensArg: values.tokens,
          codeConnectDir: values["code-connect"] || null,
          runtimePath: values.runtime || null,
          prefix: values.prefix || null,
        })
      : compareDefinedToShipped({
          tokensArg: values.tokens,
          runtimePath: values.runtime,
          codeConnectDir: values["code-connect"] || null,
          prefix: values.prefix || null,
        });
    const fmt = values.json ? "json" : cleanFmt;
    const output = fmt === "markdown" ? renderMarkdown(res) + "\n" : JSON.stringify(res, null, 2) + "\n";
    if (values.out) {
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), output, "utf8");
    }
    process.stdout.write(output);
  } catch (err) {
    console.error(`ERROR: ${err.message || err}`);
    process.exit(1);
  }
}

if (isDirectCliEntry(import.meta.url)) main();

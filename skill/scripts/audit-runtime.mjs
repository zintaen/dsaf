#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Runtime Browser, APCA-W3, Keyboard, CDP, RTL & N-of-1 Verifier.
 * Pure-JS self-tests run with zero dependencies. Live browser/draft audits lazily
 * require Playwright (`playwright` or `@playwright/test`) and Chromium, or attach via `--cdp`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";
import { assertWritableOutputFile, isDirectCliEntry } from "./ci-report.mjs";

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
      const interlace = buf[dataStart + 12];
      if (interlace !== 0) {
        throw new Error(`Interlaced PNGs are not supported (interlace=${interlace})`);
      }
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
  if (raw.length < height * stride) {
    throw new Error(`Truncated PNG image data (${raw.length} < ${height * stride})`);
  }
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
 * Composite a DOM ancestor chain (outermost html -> innermost element) per W3C CSS
 * isolated stacking-group `opacity` rules over an opaque `canvasBase`.
 */
export function sourceOverRgba(src, dst) {
  const sa = Math.max(0, Math.min(1, Number(src?.a ?? 0)));
  const da = Math.max(0, Math.min(1, Number(dst?.a ?? 0)));
  const outA = sa + da * (1 - sa);
  if (outA <= 1e-6) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (Number(src.r) * sa + Number(dst.r) * da * (1 - sa)) / outA,
    g: (Number(src.g) * sa + Number(dst.g) * da * (1 - sa)) / outA,
    b: (Number(src.b) * sa + Number(dst.b) * da * (1 - sa)) / outA,
    a: outA,
  };
}

export function compositeIsolatedChain(chain, canvasBase, leafPaint = null) {
  const base = {
    r: Number(canvasBase?.r ?? 255),
    g: Number(canvasBase?.g ?? 255),
    b: Number(canvasBase?.b ?? 255),
    a: 1,
  };
  if (!Array.isArray(chain) || chain.length === 0) return base;
  const renderNode = (idx) => {
    const node = chain[idx];
    const op = Math.max(0, Math.min(1, Number(node?.op ?? 1)));
    const rawBg = node?.bg || { r: 0, g: 0, b: 0, a: 0 };
    let paint = idx === chain.length - 1 && typeof leafPaint === "function" ? leafPaint(node) : rawBg;
    if (idx < chain.length - 1) {
      const childLayer = renderNode(idx + 1);
      paint = sourceOverRgba(childLayer, paint);
    }
    return {
      r: Number(paint?.r ?? 0),
      g: Number(paint?.g ?? 0),
      b: Number(paint?.b ?? 0),
      a: Math.max(0, Math.min(1, Number(paint?.a ?? 0) * op)),
    };
  };
  return sourceOverRgba(renderNode(0), base);
}

export function resolvePixelBehindFg(t, medianBg) {
  const rawFg = { r: t.fg[0], g: t.fg[1], b: t.fg[2], a: t.fg.length >= 4 ? t.fg[3] : 1 };
  const chain = Array.isArray(t.chain)
    ? t.chain.map((n) => ({
        bg: { r: n.bg?.[0] ?? 0, g: n.bg?.[1] ?? 0, b: n.bg?.[2] ?? 0, a: n.bg?.[3] ?? 0 },
        op: n.op ?? 1,
        hasComplex: Boolean(n.hasComplex),
        hasBgImg: n.hasBgImg !== undefined ? Boolean(n.hasBgImg) : Boolean(n.hasComplex),
      }))
    : null;
  const canvasBase = t.canvasBase || { r: 255, g: 255, b: 255, a: 1 };
  if (chain && chain.length > 0) {
    let complexIdx = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].hasBgImg) {
        complexIdx = i;
        break;
      }
    }
    const clamp255 = (v) => Math.max(0, Math.min(255, v));
    const solveChannel = (idx, chKey, medVal) => {
      const evalAt = (val) => {
        const cCopy = chain.map((n, j) => ({
          op: n.op,
          bg: j === idx ? { ...n.bg, [chKey]: val, a: 1 } : { ...n.bg },
        }));
        return compositeIsolatedChain(cCopy, idx === -1 ? { ...canvasBase, [chKey]: val, a: 1 } : canvasBase)[chKey];
      };
      const c0 = evalAt(0);
      const c255 = evalAt(255);
      const slope = (c255 - c0) / 255;
      if (slope <= 1e-4) return { val: medVal, solved: false };
      const val = clamp255((medVal - c0) / slope);
      const residual = Math.abs(c0 + slope * val - medVal);
      return { val, solved: residual <= 3 };
    };
    const resolvedChain = chain.map((n) => ({ bg: { ...n.bg }, op: n.op }));
    let resolvedCanvas = { ...canvasBase };
    let calibrated = false;
    if (complexIdx !== -1) {
      const sr = solveChannel(complexIdx, "r", medianBg[0]);
      const sg = solveChannel(complexIdx, "g", medianBg[1]);
      const sb = solveChannel(complexIdx, "b", medianBg[2]);
      if (sr.solved && sg.solved && sb.solved) {
        resolvedChain[complexIdx].bg = { r: sr.val, g: sg.val, b: sb.val, a: 1 };
        calibrated = true;
      }
    }
    if (!calibrated) {
      const predictedBg = compositeIsolatedChain(chain, canvasBase);
      const maxDiff = Math.max(
        Math.abs(medianBg[0] - predictedBg.r),
        Math.abs(medianBg[1] - predictedBg.g),
        Math.abs(medianBg[2] - predictedBg.b)
      );
      if (maxDiff > 3) {
        const trySolveAt = (idx) => {
          const sr = solveChannel(idx, "r", medianBg[0]);
          const sg = solveChannel(idx, "g", medianBg[1]);
          const sb = solveChannel(idx, "b", medianBg[2]);
          if (!(sr.solved && sg.solved && sb.solved)) return false;
          if (idx === -1) {
            resolvedCanvas = { r: sr.val, g: sg.val, b: sb.val, a: 1 };
          } else {
            resolvedChain[idx].bg = { r: sr.val, g: sg.val, b: sb.val, a: 1 };
          }
          return true;
        };
        let solveIdx = -1;
        for (let i = chain.length - 2; i >= 0; i--) {
          if (chain[i].bg.a >= 0.999 && chain[i].op >= 0.999) {
            solveIdx = i;
            break;
          }
        }
        let solved = trySolveAt(solveIdx);
        if (!solved) {
          for (let i = chain.length - 2; i >= 0 && !solved; i--) {
            if (i === solveIdx) continue;
            if (chain.slice(0, i + 1).every((n) => n.op >= 0.999)) {
              solved = trySolveAt(i);
            }
          }
        }
        if (!solved) {
          const leafIdx = chain.length - 1;
          const leafCanPaintOpaque = chain[leafIdx].bg.a >= 0.999 || chain.every((n) => n.op >= 0.999);
          if (!leafCanPaintOpaque || !trySolveAt(leafIdx)) {
            const effOp = chain[leafIdx].bg.a < 0.999 ? chain.reduce((acc, n) => acc * n.op, 1) : 1;
            const direct = sourceOverRgba(
              { r: rawFg.r, g: rawFg.g, b: rawFg.b, a: rawFg.a * effOp },
              { r: medianBg[0], g: medianBg[1], b: medianBg[2], a: 1 }
            );
            return [Math.round(direct.r), Math.round(direct.g), Math.round(direct.b)];
          }
        }
      }
    }
    const out = compositeIsolatedChain(resolvedChain, resolvedCanvas, (n) => sourceOverRgba(rawFg, n.bg));
    return [Math.round(out.r), Math.round(out.g), Math.round(out.b)];
  }
  const fgAlpha = rawFg.a;
  return fgAlpha < 0.999
    ? [
        Math.round(rawFg.r * fgAlpha + medianBg[0] * (1 - fgAlpha)),
        Math.round(rawFg.g * fgAlpha + medianBg[1] * (1 - fgAlpha)),
        Math.round(rawFg.b * fgAlpha + medianBg[2] * (1 - fgAlpha)),
      ]
    : [Math.round(rawFg.r), Math.round(rawFg.g), Math.round(rawFg.b)];
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

export function parseTransformScale(styleObj) {
  let sx = 1;
  let sy = 1;
  const tf = String(styleObj?.transform || "").trim();
  if (tf && tf.toLowerCase() !== "none") {
    for (const tok of tf.match(/(?:matrix3d|matrix|scale3d|scaleX|scaleY|scale)\([^)]+\)/gi) || []) {
      const openP = tok.indexOf("(");
      const argStr = openP !== -1 ? tok.slice(openP + 1, -1) : "";
      const rawTokens = argStr.match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?%?/gi) || [];
      const vals = rawTokens
        .map((rawTok) => (rawTok.endsWith("%") ? parseFloat(rawTok) / 100 : parseFloat(rawTok)))
        .filter(Number.isFinite);
      if (/^matrix3d\(/i.test(tok) && vals.length >= 7) {
        sx *= Math.hypot(vals[0], vals[1], vals[2]);
        sy *= Math.hypot(vals[4], vals[5], vals[6]);
      } else if (/^matrix\(/i.test(tok) && vals.length >= 4) {
        sx *= Math.hypot(vals[0], vals[1]);
        sy *= Math.hypot(vals[2], vals[3]);
      } else if (/^scale3d\(/i.test(tok) && vals.length >= 2) {
        sx *= Math.abs(vals[0]);
        sy *= Math.abs(vals[1]);
      } else if (/^scalex\(/i.test(tok) && vals.length >= 1) {
        sx *= Math.abs(vals[0]);
      } else if (/^scaley\(/i.test(tok) && vals.length >= 1) {
        sy *= Math.abs(vals[0]);
      } else if (/^scale\(/i.test(tok) && vals.length >= 1) {
        sx *= Math.abs(vals[0]);
        sy *= Math.abs(vals.length >= 2 ? vals[1] : vals[0]);
      }
    }
  }
  const sc = String(styleObj?.scale || "").trim();
  if (sc && sc.toLowerCase() !== "none") {
    const parts = sc.split(/\s+/).map((p) => (p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p))).filter(Number.isFinite);
    if (parts.length === 1) {
      sx *= Math.abs(parts[0]);
      sy *= Math.abs(parts[0]);
    } else if (parts.length >= 2) {
      sx *= Math.abs(parts[0]);
      sy *= Math.abs(parts[1]);
    }
  }
  return { sx: Number.isFinite(sx) ? sx : 1, sy: Number.isFinite(sy) ? sy : 1 };
}

export function computeEffectiveHitArea(rect, beforeStyle, afterStyle, hostStyle = null) {
  const baseW = Number(rect?.width || 0);
  const baseH = Number(rect?.height || 0);
  const hostScale = parseTransformScale(hostStyle);
  const layoutW = hostScale.sx > 0 ? baseW / hostScale.sx : baseW;
  const layoutH = hostScale.sy > 0 ? baseH / hostScale.sy : baseH;
  let maxW = baseW;
  let maxH = baseH;
  const toPx = (val, refPx) => {
    const s = String(val || "").trim().toLowerCase();
    if (!s || s === "auto" || s === "none") return 0;
    if (s.endsWith("%")) return ((parseFloat(s) || 0) / 100) * Number(refPx || 0);
    if (s.endsWith("px")) return parseFloat(s) || 0;
    return 0;
  };
  const isExplicitSize = (val) => {
    const s = String(val ?? "").trim().toLowerCase();
    return Boolean(s && s !== "auto" && s !== "none");
  };
  const clipsOv = (ov) => {
    const s = String(ov || "").toLowerCase();
    return s === "hidden" || s === "clip" || s === "auto" || s === "scroll";
  };
  const hostIsCb = Boolean(
    hostStyle &&
      ((hostStyle.position && String(hostStyle.position).toLowerCase() !== "static") ||
        (hostStyle.transform && hostStyle.transform !== "none") ||
        (hostStyle.translate && hostStyle.translate !== "none") ||
        (hostStyle.scale && hostStyle.scale !== "none") ||
        (hostStyle.rotate && hostStyle.rotate !== "none") ||
        (hostStyle.filter && hostStyle.filter !== "none") ||
        (hostStyle.perspective && hostStyle.perspective !== "none") ||
        (hostStyle.backdropFilter && hostStyle.backdropFilter !== "none") ||
        /\b(?:transform|translate|scale|rotate|filter|perspective)\b/.test(hostStyle.willChange || "") ||
        /\b(?:paint|layout|strict|content)\b/.test(hostStyle.contain || ""))
  );
  const resolveEdgeExtra = (ps, refPx) => {
    const parseShorthand4 = (rawStr) => {
      const toks = String(rawStr || "").trim().split(/\s+/).filter(Boolean);
      if (toks.length === 0) return [null, null, null, null];
      if (toks.length === 1) return [toks[0], toks[0], toks[0], toks[0]];
      if (toks.length === 2) return [toks[0], toks[1], toks[0], toks[1]];
      if (toks.length === 3) return [toks[0], toks[1], toks[2], toks[1]];
      return [toks[0], toks[1], toks[2], toks[3]];
    };
    const [shPT, shPR, shPB, shPL] = parseShorthand4(ps.padding);
    const padT = Math.max(0, toPx(ps.paddingTop ?? shPT, refPx));
    const padR = Math.max(0, toPx(ps.paddingRight ?? shPR, refPx));
    const padB = Math.max(0, toPx(ps.paddingBottom ?? shPB, refPx));
    const padL = Math.max(0, toPx(ps.paddingLeft ?? shPL, refPx));
    const [shBT, shBR, shBB, shBL] = parseShorthand4(ps.borderWidth);
    const borderSide = (wVal, shW, sVal) => {
      const bSt = String(sVal ?? ps.borderStyle ?? "").trim().toLowerCase();
      if (bSt === "none" || bSt === "hidden") return 0;
      return Math.max(0, toPx(wVal ?? shW, refPx));
    };
    const bT = borderSide(ps.borderTopWidth, shBT, ps.borderTopStyle);
    const bR = borderSide(ps.borderRightWidth, shBR, ps.borderRightStyle);
    const bB = borderSide(ps.borderBottomWidth, shBB, ps.borderBottomStyle);
    const bL = borderSide(ps.borderLeftWidth, shBL, ps.borderLeftStyle);
    return { extraW: padL + padR + bL + bR, extraH: padT + padB + bT + bB };
  };
  for (const ps of [beforeStyle, afterStyle]) {
    if (!ps) continue;
    const c = String(ps.content || "");
    if (!c || c === "none" || c === "normal") continue;
    if (String(ps.position || "") !== "absolute") continue;
    if (String(ps.display || "").toLowerCase() === "none" || String(ps.display || "").toLowerCase() === "contents" || String(ps.visibility || "").toLowerCase() === "hidden") continue;
    if (String(ps.pointerEvents || "").toLowerCase() === "none") continue;
    const psScale = parseTransformScale(ps);
    const hasExplicitW = isExplicitSize(ps.width);
    const hasExplicitH = isExplicitSize(ps.height);
    const minW = toPx(ps.minWidth, layoutW);
    const minH = toPx(ps.minHeight, layoutH);
    const pw = Math.max(hasExplicitW ? toPx(ps.width, layoutW) : 0, minW);
    const ph = Math.max(hasExplicitH ? toPx(ps.height, layoutH) : 0, minH);
    const isContentBox = String(ps.boxSizing || "content-box").toLowerCase() !== "border-box";
    const { extraW, extraH } = resolveEdgeExtra(ps, layoutW);
    const hasHorizPair =
      ps.left !== undefined && ps.left !== "auto" && ps.right !== undefined && ps.right !== "auto";
    const hasVertPair =
      ps.top !== undefined && ps.top !== "auto" && ps.bottom !== undefined && ps.bottom !== "auto";
    const insetW =
      !hasExplicitW && hasHorizPair && rect?.width != null
        ? Math.max(0, layoutW - toPx(ps.left, layoutW) - toPx(ps.right, layoutW))
        : 0;
    const insetH =
      !hasExplicitH && hasVertPair && rect?.height != null
        ? Math.max(0, layoutH - toPx(ps.top, layoutH) - toPx(ps.bottom, layoutH))
        : 0;
    const boxW = hasExplicitW ? pw + (isContentBox ? extraW : 0) : Math.max(insetW, minW + (isContentBox ? extraW : 0), extraW);
    const boxH = hasExplicitH ? ph + (isContentBox ? extraH : 0) : Math.max(insetH, minH + (isContentBox ? extraH : 0), extraH);
    let effW = boxW * psScale.sx * hostScale.sx;
    let effH = boxH * psScale.sy * hostScale.sy;
    if (hostIsCb) {
      const containClips = /\b(?:paint|strict|content)\b/.test(hostStyle.contain || "");
      const ovParts = String(hostStyle.overflow || "").trim().split(/\s+/).filter(Boolean);
      const ovX = hostStyle.overflowX || ovParts[0] || "";
      const ovY = hostStyle.overflowY || ovParts[1] || ovParts[0] || "";
      if (containClips || clipsOv(ovX)) effW = Math.min(effW, baseW);
      if (containClips || clipsOv(ovY)) effH = Math.min(effH, baseH);
    }
    const allowsWidthExpand = effH >= Math.min(baseH, 44);
    const allowsHeightExpand = effW >= Math.min(baseW, 44);
    if (allowsWidthExpand && effW > maxW) maxW = effW;
    if (allowsHeightExpand && effH > maxH) maxH = effH;
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
    const h = typeof b.contentH === "number" ? Number(b.contentH) : Number(b.h || 0);
    const lh = Number(b.lineHeightPx || 18);
    if (h > 36 && h > lh * 1.7) {
      crushedBadges.push({ tag: b.tag || "span", text: String(b.text || "").slice(0, 32), w: Math.round(b.w || 0), h: Math.round(Number(b.h || h)) });
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
  if (routesCsv === undefined || routesCsv === null || routesCsv === "") return targets;
  const rawSegs = String(routesCsv).split(",");
  if (rawSegs.some((s) => !s.trim())) {
    throw new Error("Option '--routes' must contain non-empty comma-separated route paths.");
  }
  const routes = rawSegs.map((s) => s.trim());
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

export function parseArgs(argv) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      routes: { type: "string" },
      out: { type: "string" },
      "theme-toggle": { type: "string" },
      axe: { type: "string" },
      "executable-path": { type: "string" },
      "wiring-before": { type: "string" },
      "wiring-after": { type: "string" },
      storybook: { type: "string" },
      "max-stories": { type: "string" },
      screenshot: { type: "string" },
      "screenshot-diff": { type: "string" },
      "diff-threshold": { type: "string" },
      pins: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      cdp: { type: "string" },
      target: { type: "string" },
      "extended-viewports": { type: "boolean", default: false },
      "no-hide-overlays": { type: "boolean", default: false },
      "skip-shell-check": { type: "boolean", default: false },
      "skip-interactions": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const reqVal = (flag) => {
    if (values[flag] === undefined) return null;
    const raw = String(values[flag]);
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("--")) {
      throw new Error(`Option '--${flag}' requires a non-empty value (got '${raw}').`);
    }
    return trimmed;
  };

  let maxStories = 8;
  const rawMaxStories = reqVal("max-stories");
  if (rawMaxStories !== null) {
    if (!/^\d+$/.test(rawMaxStories.trim())) {
      throw new Error(`Invalid --max-stories '${rawMaxStories}'. Expected a positive integer.`);
    }
    maxStories = Number.parseInt(rawMaxStories.trim(), 10);
    if (!Number.isInteger(maxStories) || maxStories < 1) {
      throw new Error(`Invalid --max-stories '${rawMaxStories}'. Expected an integer >= 1.`);
    }
  }

  let diffThreshold = 1.0;
  const rawDiffThreshold = reqVal("diff-threshold");
  if (rawDiffThreshold !== null) {
    const trimmed = rawDiffThreshold.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error(`Invalid --diff-threshold '${rawDiffThreshold}'. Expected a number between 0 and 100.`);
    }
    diffThreshold = parsed;
  }

  for (const pos of positionals) {
    if (typeof pos !== "string" || !pos.trim()) {
      throw new Error("Target argument must be a non-empty file path, directory, or URL.");
    }
  }
  const routesVal = reqVal("routes");
  if (routesVal !== null && routesVal.split(",").some((s) => !s.trim())) {
    throw new Error(`Invalid --routes '${routesVal}'. Expected comma-separated non-empty route paths.`);
  }

  const out = {
    targets: positionals.map((p) => p.trim()),
    routes: routesVal,
    outFile: reqVal("out"),
    themeToggle: reqVal("theme-toggle"),
    axePath: reqVal("axe"),
    executablePath: reqVal("executable-path") || process.env.CHROME_PATH || null,
    wiringBefore: reqVal("wiring-before"),
    wiringAfter: reqVal("wiring-after"),
    storybook: reqVal("storybook"),
    maxStories,
    screenshot: reqVal("screenshot"),
    screenshotDiff: reqVal("screenshot-diff"),
    diffThreshold,
    pins: Boolean(values.pins),
    live: Boolean(values.live),
    cdp: reqVal("cdp"),
    cdpTarget: reqVal("target"),
    extendedViewports: Boolean(values["extended-viewports"]),
    noHideOverlays: Boolean(values["no-hide-overlays"]),
    skipShellCheck: Boolean(values["skip-shell-check"]),
    skipInteractions: Boolean(values["skip-interactions"]),
    json: Boolean(values.json),
    selfTest: Boolean(values["self-test"]),
    help: Boolean(values.help),
  };
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
  for (const t of targetPaths) {
    if (!t || /^(?:https?|data):/i.test(t)) continue;
    let p = t;
    if (/^file:\/\//i.test(p)) {
      try {
        p = fileURLToPath(p);
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
  pushAncestors(process.cwd());
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
  const cacheDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ].filter(Boolean);
  for (const dir of cacheDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir)
        .filter((e) => /^chromium_headless_shell-\d+|^chromium-\d+/.test(e))
        .sort((a, b) => Number(b.match(/(\d+)$/)?.[1] || 0) - Number(a.match(/(\d+)$/)?.[1] || 0));
      for (const e of entries) {
        for (const sub of [
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
          "chrome-headless-shell-mac-x64/chrome-headless-shell",
          "chrome-headless-shell-linux/chrome-headless-shell",
          "chrome-headless-shell-win64/chrome-headless-shell.exe",
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          "chrome-linux/chrome",
          "chrome-win/chrome.exe",
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
  if (explicitPath) {
    const absExplicit = resolve(explicitPath);
    if (!existsSync(absExplicit) || !statSync(absExplicit).isFile()) {
      throw new Error(`Explicit --axe path not found or not a file: ${explicitPath}`);
    }
    return absExplicit;
  }
  const ancestorDirs = collectAncestorDirs(targetPaths);
  for (const dir of ancestorDirs) {
    for (const p of [join(dir, "node_modules/axe-core/axe.min.js"), join(dir, "node_modules/axe-core/axe.js")]) {
      if (existsSync(p)) return p;
    }
  }
  for (const dir of ancestorDirs) {
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
  if (/^(?:https?|file|data):/i.test(target)) {
    if (/^file:/i.test(target)) {
      try { return new URL(target).href; } catch {}
    }
    return target;
  }
  return pathToFileURL(resolve(target)).href;
}

async function resolveStorybookUrls(storybookArg, maxStories) {
  let baseUrl = null;
  let indexData = null;
  if (/^https?:\/\//i.test(storybookArg)) {
    const parsedUrl = new URL(storybookArg);
    parsedUrl.search = "";
    parsedUrl.hash = "";
    const clean = parsedUrl.toString().replace(/\/$/, "");
    for (const suffix of clean.endsWith(".json") ? [""] : ["/index.json", "/stories.json"]) {
      const probe = `${clean}${suffix}`;
      const res = await fetch(probe).catch(() => null);
      if (res && res.ok) {
        indexData = await res.json().catch(() => null);
        if (indexData) {
          baseUrl = clean.replace(/\/[^/]+\.json$/i, "");
          break;
        }
      }
    }
    if (!indexData) return [storybookArg];
  } else {
    const absJson = resolve(storybookArg);
    indexData = JSON.parse(readFileSync(absJson, "utf8"));
    const siblingIframe = join(dirname(absJson), "iframe.html");
    if (!existsSync(siblingIframe)) {
      throw new Error(`Local Storybook index requires sibling iframe.html next to ${absJson}`);
    }
    baseUrl = pathToFileURL(dirname(absJson)).href;
  }
  const entries = Object.values(indexData.entries || indexData.stories || {}).filter((e) => (e.type || "story") === "story");
  const picked = entries.slice(0, maxStories);
  if (!baseUrl) return picked.map((e) => e.id);
  return picked.map((e) => `${baseUrl}/iframe.html?id=${encodeURIComponent(e.id)}&viewMode=story`);
}

export function collectHtmlFiles(targets) {
  const files = [];
  for (const t of targets) {
    if (/^(?:https?|file|data):/i.test(t)) {
      if (/^file:/i.test(t)) {
        try {
          files.push(new URL(t).href);
          continue;
        } catch {}
      }
      files.push(t);
      continue;
    }
    const abs = resolve(t);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!name.toLowerCase().endsWith(".html")) continue;
        const full = join(abs, name);
        try {
          if (statSync(full).isFile()) files.push(full);
        } catch {}
      }
    } else if (st.isFile()) {
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
    const parseColor = (str, allowZeroAlpha = false) => {
      const m = (str || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) {
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a === 0 && !allowZeroAlpha) return null;
        return [Number(m[1]), Number(m[2]), Number(m[3]), a];
      }
      if (!str) return null;
      if (str === "transparent") return allowZeroAlpha ? [0, 0, 0, 0] : null;
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
      if (d[3] === 0 && !allowZeroAlpha) return null;
      return [d[0], d[1], d[2], d[3] / 255];
    };

    const found = [];
    const seen = new Set();
    const hasDirectText = (node) =>
      Array.from(node?.childNodes || []).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0);
    const buildChain = (el) => {
      const stack = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const ccs = getComputedStyle(cur);
        const bg = parseColor(ccs.backgroundColor) || [0, 0, 0, 0];
        const val = parseFloat(ccs.opacity);
        const op = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 1;
        const hasBgImg = Boolean(ccs.backgroundImage && ccs.backgroundImage !== "none");
        const hasBackdrop = Boolean(ccs.backdropFilter && ccs.backdropFilter !== "none");
        stack.push({ bg, op, hasBgImg, hasBackdrop, hasComplex: hasBgImg || hasBackdrop });
        if (cur === document.documentElement) break;
        cur = cur.parentElement;
      }
      return stack.reverse();
    };
    const hasVisibleComplex = (chain, endIdx) => {
      for (let i = endIdx; i >= 0; i--) {
        if (chain[i].hasComplex) return true;
        if (chain[i].bg[3] >= 0.999 && chain[i].op >= 0.999 && chain.slice(0, i).every((a) => a.op >= 0.999)) {
          return false;
        }
      }
      return false;
    };

    const candidates = [];
    const enqueuePixelCandidate = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (hasDirectText(node)) {
        candidates.push(node);
        return;
      }
      for (const desc of node.querySelectorAll("*")) {
        if (hasDirectText(desc)) candidates.push(desc);
      }
    };
    for (const rootCand of document.querySelectorAll("h1, [data-pixel-behind]")) {
      enqueuePixelCandidate(rootCand);
    }
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button, span")) {
      if (!hasDirectText(el)) continue;
      const chain = buildChain(el);
      if (hasVisibleComplex(chain, chain.length - 1)) candidates.push(el);
    }

    const effectiveOpacity = (node) => {
      let op = 1;
      let cur = node;
      while (cur && cur.nodeType === 1) {
        const val = parseFloat(getComputedStyle(cur).opacity);
        if (Number.isFinite(val)) op *= Math.max(0, Math.min(1, val));
        if (op <= 0 || cur === document.documentElement) break;
        cur = cur.parentElement;
      }
      return op;
    };

    const resolveCanvasBase = () => {
      const rootEl = document.documentElement;
      const bodyEl = document.body;
      const rootScheme = (getComputedStyle(rootEl).colorScheme || "").toLowerCase();
      const bodyScheme = (getComputedStyle(bodyEl || rootEl).colorScheme || "").toLowerCase();
      const effScheme = bodyScheme && bodyScheme !== "normal" ? bodyScheme : rootScheme;
      const explicitDark =
        rootEl.getAttribute("data-theme") === "dark" ||
        rootEl.getAttribute("data-uxs-theme") === "dark" ||
        rootEl.getAttribute("data-mode") === "dark" ||
        bodyEl?.getAttribute("data-theme") === "dark" ||
        bodyEl?.getAttribute("data-mode") === "dark" ||
        rootEl.classList.contains("dark") ||
        Boolean(bodyEl?.classList.contains("dark"));
      const explicitLight =
        rootEl.getAttribute("data-theme") === "light" ||
        rootEl.getAttribute("data-uxs-theme") === "light" ||
        rootEl.getAttribute("data-mode") === "light" ||
        bodyEl?.getAttribute("data-theme") === "light" ||
        bodyEl?.getAttribute("data-mode") === "light" ||
        rootEl.classList.contains("light") ||
        Boolean(bodyEl?.classList.contains("light"));
      const osDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const dark =
        explicitDark ||
        (!explicitLight &&
          ((effScheme.includes("dark") && !effScheme.includes("light")) ||
            (effScheme.includes("dark") && effScheme.includes("light") && osDark)));
      return dark ? { r: 15, g: 23, b: 42, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    };
    const canvasBase = resolveCanvasBase();

    let idx = 0;
    for (const el of candidates) {
      if (seen.has(el) || idx >= 8) continue;
      if (el.matches(DEV_OVERLAY_SEL) || el.closest(DEV_OVERLAY_SEL) || isInsideClosedDetails(el)) continue;
      const cs = getComputedStyle(el);
      const effOp = effectiveOpacity(el);
      if (cs.display === "none" || cs.visibility === "hidden" || effOp === 0) continue;
      if (!hasDirectText(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) continue;
      let tLeft = Infinity;
      let tTop = Infinity;
      let tRight = -Infinity;
      let tBottom = -Infinity;
      for (const cn of el.childNodes) {
        if (cn.nodeType !== 3 || !(cn.textContent || "").trim()) continue;
        const rng = document.createRange();
        rng.selectNodeContents(cn);
        for (const cr of Array.from(rng.getClientRects())) {
          if (cr.width < 1 || cr.height < 1) continue;
          const cl = Math.max(r.left, cr.left);
          const ct = Math.max(r.top, cr.top);
          const crr = Math.min(r.right, cr.right);
          const cb = Math.min(r.bottom, cr.bottom);
          if (crr <= cl || cb <= ct) continue;
          tLeft = Math.min(tLeft, cl);
          tTop = Math.min(tTop, ct);
          tRight = Math.max(tRight, crr);
          tBottom = Math.max(tBottom, cb);
        }
      }
      const sr =
        Number.isFinite(tLeft) && tRight > tLeft + 1 && tBottom > tTop + 1
          ? { left: tLeft, top: tTop, right: tRight, bottom: tBottom }
          : r;
      const rawTextFill = (cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color") || "").trim();
      const parsedTextFill = rawTextFill ? parseColor(rawTextFill, true) : null;
      if (parsedTextFill && parsedTextFill[3] === 0) continue;
      const fg = (parsedTextFill && parsedTextFill[3] > 0 ? parsedTextFill : null) || parseColor(cs.color);
      if (!fg) continue;
      seen.add(el);
      const token = `uxs-pb-${idx++}`;
      el.setAttribute("data-uxs-pb-id", token);
      found.push({
        token,
        label: `${el.tagName.toLowerCase()}("${(el.textContent || "").trim().slice(0, 28)}")`,
        fg: [fg[0], fg[1], fg[2], fg[3]],
        chain: buildChain(el),
        canvasBase,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: parseInt(cs.fontWeight, 10) || 400,
        rect: {
          x: Math.max(0, Math.floor(sr.left)),
          y: Math.max(0, Math.floor(sr.top)),
          width: Math.max(2, Math.floor(Math.min(sr.right, window.innerWidth) - Math.max(0, sr.left))),
          height: Math.max(2, Math.floor(Math.min(sr.bottom, window.innerHeight) - Math.max(0, sr.top))),
        },
      });
    }
    return found;
  });

  const results = [];
  try {
    for (const t of targets) {
      const sel = `[data-uxs-pb-id="${t.token}"]`;
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return;
        el.dataset.uxsPrevColor = el.style.getPropertyValue("color");
        el.dataset.uxsPrevColorPriority = el.style.getPropertyPriority("color");
        el.dataset.uxsPrevTextFill = el.style.getPropertyValue("-webkit-text-fill-color");
        el.dataset.uxsPrevTextFillPriority = el.style.getPropertyPriority("-webkit-text-fill-color");
        el.dataset.uxsPrevShadow = el.style.getPropertyValue("text-shadow");
        el.dataset.uxsPrevShadowPriority = el.style.getPropertyPriority("text-shadow");
        el.dataset.uxsPrevTransition = el.style.getPropertyValue("transition");
        el.dataset.uxsPrevTransitionPriority = el.style.getPropertyPriority("transition");
        el.style.setProperty("transition", "none", "important");
        el.style.setProperty("color", "transparent", "important");
        el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
        el.style.setProperty("text-shadow", "none", "important");
        void el.offsetHeight;
      }, sel);

      let pngBuf;
      try {
        pngBuf = await page.screenshot({ clip: t.rect });
      } finally {
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return;
          if (el.dataset.uxsPrevColor) {
            el.style.setProperty("color", el.dataset.uxsPrevColor, el.dataset.uxsPrevColorPriority || "");
          } else {
            el.style.removeProperty("color");
          }
          if (el.dataset.uxsPrevTextFill) {
            el.style.setProperty("-webkit-text-fill-color", el.dataset.uxsPrevTextFill, el.dataset.uxsPrevTextFillPriority || "");
          } else {
            el.style.removeProperty("-webkit-text-fill-color");
          }
          if (el.dataset.uxsPrevShadow) {
            el.style.setProperty("text-shadow", el.dataset.uxsPrevShadow, el.dataset.uxsPrevShadowPriority || "");
          } else {
            el.style.removeProperty("text-shadow");
          }
          void el.offsetHeight;
          if (el.dataset.uxsPrevTransition) {
            el.style.setProperty("transition", el.dataset.uxsPrevTransition, el.dataset.uxsPrevTransitionPriority || "");
          } else {
            el.style.removeProperty("transition");
          }
          delete el.dataset.uxsPrevColor;
          delete el.dataset.uxsPrevColorPriority;
          delete el.dataset.uxsPrevTextFill;
          delete el.dataset.uxsPrevTextFillPriority;
          delete el.dataset.uxsPrevShadow;
          delete el.dataset.uxsPrevShadowPriority;
          delete el.dataset.uxsPrevTransition;
          delete el.dataset.uxsPrevTransitionPriority;
          el.removeAttribute("data-uxs-pb-id");
        }, sel);
      }

      const decoded = decodePngRgba(pngBuf);
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < decoded.rgba.length; i += 4) {
        rs.push(decoded.rgba[i]);
        gs.push(decoded.rgba[i + 1]);
        bs.push(decoded.rgba[i + 2]);
      }
      const med = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1] ?? 0;
      const medianBg = [med(rs), med(gs), med(bs)];
      const effFg = resolvePixelBehindFg(t, medianBg);

      const ratio = Number(wcagContrast(effFg, medianBg).toFixed(2));
      const apcaLc = apcaContrast(effFg, medianBg);
      const isLarge = t.fontSize >= 24 || (t.fontSize >= 18.66 && t.fontWeight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;
      results.push({ label: t.label, fg: effFg, medianBg, ratio, threshold, apcaLc, pass: ratio >= threshold });
    }
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll("[data-uxs-pb-id]").forEach((el) => el.removeAttribute("data-uxs-pb-id"));
    }).catch(() => {});
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

export function validateLiveInteractionSnapshot(snap) {
  const failures = [];
  if (!snap) return failures;
  if (snap.docOverflow > 2) {
    failures.push(`Interactive state '${snap.label}' caused horizontal overflow (${snap.docOverflow}px)`);
  }
  if (snap.panelOverflow > 2) {
    failures.push(`Interactive panel '${snap.label}' overflows container (${snap.panelOverflow}px)`);
  }
  if (snap.selectionUpdated === false) {
    failures.push(`Clicking tab '${snap.label}' did not update aria-selected="true"`);
  }
  return failures;
}

async function captureScrollPosition(page) {
  return page.evaluate(() => ({ x: window.scrollX || 0, y: window.scrollY || 0 })).catch(() => ({ x: 0, y: 0 }));
}

async function restoreScrollPosition(page, pos) {
  if (!pos) return;
  await page
    .evaluate(({ x, y }) => {
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    }, pos)
    .catch(() => {});
}

async function auditLiveInteractions(page, themeToggleSelector = null) {
  const summary = { tabsTested: 0, disclosuresTested: 0, themeToggleTested: false, failures: [] };
  const startUrl = page.url();
  const savedScroll = await captureScrollPosition(page);
  try {

  // 1. Probe visible tabs cleanly per tablist and restore initial selection
  const tabs = await page.$$('[role="tablist"] [role="tab"], [focusgroup*="tablist"] button');
  const origTabs = [];
  for (const t of tabs) {
    const isOrig = await t
      .evaluate((el) => {
        if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
        return el.getAttribute("aria-selected") === "true";
      })
      .catch(() => false);
    if (isOrig) origTabs.push(t);
  }
  for (const tab of tabs.slice(0, 6)) {
    if (summary.tabsTested >= 4) break;
    if (!(await tab.isVisible().catch(() => false))) continue;
    const meta = await tab
      .evaluate((el) => {
        const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
        let externalNav = false;
        if (el.tagName === "A") {
          if (el.getAttribute("target") === "_blank") externalNav = true;
          const href = el.getAttribute("href");
          if (href && !href.startsWith("#")) {
            try {
              const u = new URL(href, window.location.href);
              if (u.origin !== window.location.origin || u.pathname !== window.location.pathname || u.search !== window.location.search) {
                externalNav = true;
              }
            } catch {
              externalNav = true;
            }
          }
        }
        return {
          disabled,
          externalNav,
          label: (el.textContent || "").trim().slice(0, 24) || "tab",
          selected: el.getAttribute("aria-selected") === "true",
        };
      })
      .catch(() => null);
    if (!meta || meta.selected || meta.disabled || meta.externalNav) continue;
    try {
      await tab.click({ timeout: 1500 });
      await page.waitForTimeout(80);
      const stripHash = (u) => String(u || "").split("#")[0];
      if (stripHash(page.url()) !== stripHash(startUrl)) {
        summary.failures.push(`Clicking tab '${meta.label}' unexpectedly navigated away from ${startUrl}`);
        await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return summary;
      }
      const snap = await tab.evaluate((btn) => {
        const ctrlId = btn.getAttribute("aria-controls");
        let panel = ctrlId ? document.getElementById(ctrlId) : null;
        if (!panel && btn.id) {
          panel = document.querySelector(`[role="tabpanel"][aria-labelledby~="${CSS.escape(btn.id)}"]`);
        }
        const tracksSelected = btn.getAttribute("role") === "tab" || btn.hasAttribute("aria-selected");
        const panelOx = panel ? getComputedStyle(panel).overflowX : "";
        return {
          label: (btn.textContent || "tab").trim().slice(0, 24),
          selectionUpdated: tracksSelected ? btn.getAttribute("aria-selected") === "true" : true,
          docOverflow: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
          panelOverflow:
            panel && panelOx !== "auto" && panelOx !== "scroll"
              ? Math.max(0, Math.round(panel.scrollWidth - panel.clientWidth))
              : 0,
        };
      });
      summary.tabsTested++;
      summary.failures.push(...validateLiveInteractionSnapshot(snap));
    } catch {}
  }
  for (const origTab of origTabs) {
    await origTab.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(40);
  }

  // 2. Probe first collapsed <details> summary
  const detSummary = await page.$("details:not([open]) > summary");
  if (detSummary && (await detSummary.isVisible().catch(() => false))) {
    try {
      await detSummary.click({ timeout: 1500 });
      await page.waitForTimeout(60);
      const snap = await page.evaluate(() => ({
        label: "details:open",
        docOverflow: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
        panelOverflow: 0,
      }));
      summary.disclosuresTested++;
      summary.failures.push(...validateLiveInteractionSnapshot(snap));
      const stillOpen = await detSummary.evaluate((el) => Boolean(el.parentElement?.open)).catch(() => false);
      if (stillOpen) {
        await detSummary.click({ timeout: 1000 }).catch(() => {});
        const restoredClosed = await detSummary.evaluate((el) => !el.parentElement?.open).catch(() => false);
        if (!restoredClosed) summary.failures.push("Failed to close <details> disclosure after interaction probe");
      }
    } catch {}
  }

  // 3. Probe safe explicit binary theme toggle and verify restoration
  const toggleSel = themeToggleSelector || "#theme-toggle-btn, [data-theme-toggle]";
  let tog = null;
  for (const h of await page.$$(toggleSel)) {
    if (await h.isVisible().catch(() => false)) {
      tog = h;
      break;
    }
  }
  if (tog) {
    const canToggle = await tog
      .evaluate((el) => {
        if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
        if (el.tagName === "SELECT") return false;
        const hp = (el.getAttribute("aria-haspopup") || "").toLowerCase();
        return !["menu", "listbox", "dialog"].includes(hp);
      })
      .catch(() => false);
    if (canToggle) {
      const snapThemeState = () =>
        page.evaluate(() => {
          const root = document.documentElement;
          const body = document.body;
          const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") || "";
          const csRoot = (getComputedStyle(root).colorScheme || "").toLowerCase();
          const dt = (root.getAttribute("data-theme") || body?.getAttribute("data-theme") || "").toLowerCase();
          const dut = (root.getAttribute("data-uxs-theme") || body?.getAttribute("data-uxs-theme") || "").toLowerCase();
          const dm = (root.getAttribute("data-mode") || body?.getAttribute("data-mode") || "").toLowerCase();
          const hasDarkCls = root.classList.contains("dark") || Boolean(body?.classList.contains("dark"));
          const hasLightCls = root.classList.contains("light") || Boolean(body?.classList.contains("light"));
          const osDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
          let resolvedScheme = osDark ? "dark" : "light";
          if (dt === "dark" || dut === "dark" || dm === "dark" || hasDarkCls) resolvedScheme = "dark";
          else if (dt === "light" || dut === "light" || dm === "light" || hasLightCls) resolvedScheme = "light";
          else if (meta === "dark" || (csRoot.includes("dark") && !csRoot.includes("light"))) resolvedScheme = "dark";
          else if (meta === "light" || (csRoot.includes("light") && !csRoot.includes("dark"))) resolvedScheme = "light";
          const bcs = body ? getComputedStyle(body) : getComputedStyle(root);
          const rawSig = [dt, dut, dm, hasDarkCls ? 1 : 0, hasLightCls ? 1 : 0, meta, csRoot, bcs.backgroundColor, bcs.color].join("|");
          return { resolvedScheme, rawSig };
        });
      try {
        const beforeState = await snapThemeState();
        const beforeBtn = await tog.evaluate((el) => el.getAttribute("aria-pressed") || "");
        await tog.click({ timeout: 1500 });
        await page.waitForTimeout(80);
        const midState = await snapThemeState();
        const midBtn = await tog.evaluate((el) => el.getAttribute("aria-pressed") || "").catch(() => "");
        if (
          midState.resolvedScheme === beforeState.resolvedScheme &&
          midState.rawSig === beforeState.rawSig &&
          midBtn === beforeBtn
        ) {
          summary.failures.push("Theme toggle click did not change theme state");
        }
        const snap = await page.evaluate(() => ({
          label: "theme-toggle",
          docOverflow: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
          panelOverflow: 0,
        }));
        summary.themeToggleTested = true;
        summary.failures.push(...validateLiveInteractionSnapshot(snap));
        await tog.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(40);
        const afterState = await snapThemeState();
        const afterBtn = await tog.evaluate((el) => el.getAttribute("aria-pressed") || "").catch(() => "");
        if (afterState.resolvedScheme !== beforeState.resolvedScheme || afterBtn !== beforeBtn) {
          summary.failures.push("Theme toggle did not restore original theme state after second click");
        }
      } catch {}
    }
  }

  return summary;
  } finally {
    await restoreScrollPosition(page, savedScroll);
  }
}

async function auditShellContract(page) {
  const savedScroll = await captureScrollPosition(page);
  const initialAttrs = await page.evaluate(() => ({
    view: document.documentElement.getAttribute("data-uxs-view"),
    viewport: document.documentElement.getAttribute("data-uxs-viewport"),
  }));
  try {
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
    const initialPinsOn = (await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"))) === "on";
    if (!initialPinsOn) {
      await pinsBtn.click();
      const pinsOn = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
      if (pinsOn !== "on") check.failures.push("Clicking #uxs-pins-btn did not toggle pins on");
    }

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
    if (initialPinsOn) {
      await pinsBtn.click();
      const pinsOff = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
      if (pinsOff === "on") check.failures.push("Clicking #uxs-pins-btn did not toggle pins off");
      await pinsBtn.click();
      const pinsRestored = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
      if (pinsRestored !== "on") check.failures.push("Clicking #uxs-pins-btn did not restore pins on");
    } else {
      await pinsBtn.click();
    }
  }
  return check;
  } finally {
    await page.evaluate((init) => {
      if (init.view) {
        const viewBtn = document.querySelector(`[data-uxs-group="view"] [data-view="${init.view}"], [data-view="${init.view}"]`);
        if (viewBtn instanceof HTMLElement) viewBtn.click();
        else document.documentElement.setAttribute("data-uxs-view", init.view);
      } else {
        document.documentElement.removeAttribute("data-uxs-view");
      }
      if (init.viewport) {
        const vpBtn = document.querySelector(`[data-uxs-group="viewport"] [data-vp-btn="${init.viewport}"], [data-uxs-group="viewport"] [data-viewport="${init.viewport}"]`);
        if (vpBtn instanceof HTMLElement) vpBtn.click();
        else document.documentElement.setAttribute("data-uxs-viewport", init.viewport);
      } else {
        document.documentElement.removeAttribute("data-uxs-viewport");
      }
    }, initialAttrs).catch(() => {});
    await restoreScrollPosition(page, savedScroll);
  }
}

async function auditFilledButtonHoverContrast(page) {
  const hoverFails = [];
  const savedScroll = await captureScrollPosition(page);
  const btns = await page.$$('button[aria-pressed="true"], [data-primary-cta], button.primary');
  let maxReturnWaitMs = 0;
  let hoveredAny = false;
  try {
  for (const btn of btns.slice(0, 6)) {
    if (!(await btn.isVisible().catch(() => false))) continue;
    const preHover = await btn
      .evaluate((el) => {
        const isDisabled =
          Boolean(el.disabled) ||
          el.getAttribute("aria-disabled") === "true" ||
          Boolean(el.closest("fieldset[disabled], [aria-disabled='true']"));
        if (isDisabled) return { disabled: true, restingBgAlpha: 0, restTransMs: 0 };
        const parseDur = (str) =>
          String(str || "0s")
            .split(",")
            .map((tok) => {
              const s = tok.trim().toLowerCase();
              const n = parseFloat(s) || 0;
              return s.endsWith("ms") ? n : n * 1000;
            });
        const maxTransMs = (cs) => {
          const durs = parseDur(cs.transitionDuration);
          const dels = parseDur(cs.transitionDelay);
          let best = 0;
          const len = Math.max(durs.length, dels.length);
          for (let i = 0; i < len; i++) {
            const d = durs[i % durs.length] || 0;
            if (d > 0) best = Math.max(best, d + Math.max(0, dels[i % dels.length] || 0));
          }
          return best;
        };
        const cs = getComputedStyle(el);
        let alpha = 0;
        const m = (cs.backgroundColor || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) alpha = m[4] === undefined ? 1 : Number(m[4]);
        else if (cs.backgroundColor && cs.backgroundColor !== "transparent") {
          const c = document.createElement("canvas");
          c.width = 1;
          c.height = 1;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.fillStyle = "rgba(0,0,0,0)";
          ctx.fillStyle = cs.backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          alpha = ctx.getImageData(0, 0, 1, 1).data[3] / 255;
        }
        return { disabled: false, restingBgAlpha: alpha, restTransMs: maxTransMs(cs) };
      })
      .catch(() => ({ disabled: false, restingBgAlpha: 0, restTransMs: 0 }));
    if (preHover.disabled) continue;
    try {
      await btn.hover({ timeout: 2500 });
    } catch {
      continue;
    }
    hoveredAny = true;
    const hoverTransMs = await btn
      .evaluate((el) => {
        const parseDur = (str) =>
          String(str || "0s")
            .split(",")
            .map((tok) => {
              const s = tok.trim().toLowerCase();
              const n = parseFloat(s) || 0;
              return s.endsWith("ms") ? n : n * 1000;
            });
        const cs = getComputedStyle(el);
        const durs = parseDur(cs.transitionDuration);
        const dels = parseDur(cs.transitionDelay);
        let best = 0;
        const len = Math.max(durs.length, dels.length);
        for (let i = 0; i < len; i++) {
          const d = durs[i % durs.length] || 0;
          if (d > 0) best = Math.max(best, d + Math.max(0, dels[i % dels.length] || 0));
        }
        return best;
      })
      .catch(() => 0);
    const stepTransMs = Math.max(preHover.restTransMs || 0, hoverTransMs || 0);
    maxReturnWaitMs = Math.max(maxReturnWaitMs, stepTransMs);
    await page.waitForTimeout(Math.min(1200, Math.max(180, stepTransMs + 40)));
    const res = await btn.evaluate((el, restingAlpha) => {
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
      const sourceOver = (src, dst) => {
        const sa = Math.max(0, Math.min(1, Number(src?.a ?? 0)));
        const da = Math.max(0, Math.min(1, Number(dst?.a ?? 0)));
        const outA = sa + da * (1 - sa);
        if (outA <= 1e-6) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (src.r * sa + dst.r * da * (1 - sa)) / outA,
          g: (src.g * sa + dst.g * da * (1 - sa)) / outA,
          b: (src.b * sa + dst.b * da * (1 - sa)) / outA,
          a: outA,
        };
      };
      const resolveCanvasBase = () => {
        const rootEl = document.documentElement;
        const bodyEl = document.body;
        const rootScheme = (getComputedStyle(rootEl).colorScheme || "").toLowerCase();
        const bodyScheme = (getComputedStyle(bodyEl || rootEl).colorScheme || "").toLowerCase();
        const effScheme = bodyScheme && bodyScheme !== "normal" ? bodyScheme : rootScheme;
        const explicitDark =
          rootEl.getAttribute("data-theme") === "dark" ||
          rootEl.getAttribute("data-uxs-theme") === "dark" ||
          rootEl.getAttribute("data-mode") === "dark" ||
          bodyEl?.getAttribute("data-theme") === "dark" ||
          bodyEl?.getAttribute("data-mode") === "dark" ||
          rootEl.classList.contains("dark") ||
          Boolean(bodyEl?.classList.contains("dark"));
        const explicitLight =
          rootEl.getAttribute("data-theme") === "light" ||
          rootEl.getAttribute("data-uxs-theme") === "light" ||
          rootEl.getAttribute("data-mode") === "light" ||
          bodyEl?.getAttribute("data-theme") === "light" ||
          bodyEl?.getAttribute("data-mode") === "light" ||
          rootEl.classList.contains("light") ||
          Boolean(bodyEl?.classList.contains("light"));
        const osDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        const dark =
          explicitDark ||
          (!explicitLight &&
            ((effScheme.includes("dark") && !effScheme.includes("light")) ||
              (effScheme.includes("dark") && effScheme.includes("light") && osDark)));
        return dark ? { r: 15, g: 23, b: 42, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
      };
      const buildChain = (node) => {
        const stack = [];
        let cur = node;
        while (cur && cur.nodeType === 1) {
          const ccs = getComputedStyle(cur);
          const c = parseRgba(ccs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
          const val = parseFloat(ccs.opacity);
          const op = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 1;
          const hasBackdrop = Boolean(ccs.backdropFilter && ccs.backdropFilter !== "none");
          const hasBgImg = Boolean(ccs.backgroundImage && ccs.backgroundImage !== "none");
          stack.push({ bg: c, op, hasComplex: hasBackdrop || hasBgImg });
          if (cur === document.documentElement) break;
          cur = cur.parentElement;
        }
        return stack.reverse();
      };
      const hasVisibleComplex = (chain, endIdx) => {
        for (let i = endIdx; i >= 0; i--) {
          if (chain[i].hasComplex) return true;
          if (chain[i].bg.a >= 0.999 && chain[i].op >= 0.999 && chain.slice(0, i).every((a) => a.op >= 0.999)) {
            return false;
          }
        }
        return false;
      };
      const resolveIsolated = (chain, canvasBase, leafPaint = null) => {
        if (!chain.length) return canvasBase;
        const render = (idx) => {
          const n = chain[idx];
          let paint = idx === chain.length - 1 && leafPaint ? leafPaint(n) : n.bg;
          if (idx < chain.length - 1) paint = sourceOver(render(idx + 1), paint);
          return { r: paint.r, g: paint.g, b: paint.b, a: Math.max(0, Math.min(1, paint.a * n.op)) };
        };
        return sourceOver(render(0), canvasBase);
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const effectiveOpacity = (node) => {
        let op = 1;
        let cur = node;
        while (cur && cur.nodeType === 1) {
          const val = parseFloat(getComputedStyle(cur).opacity);
          if (Number.isFinite(val)) op *= Math.max(0, Math.min(1, val));
          if (op <= 0 || cur === document.documentElement) break;
          cur = cur.parentElement;
        }
        return op;
      };
      const cs = getComputedStyle(el);
      const effOp = effectiveOpacity(el);
      const rawBg = parseRgba(cs.backgroundColor);
      if (effOp === 0 || (restingAlpha < 0.1 && (!rawBg || rawBg.a < 0.1))) return null;
      const canvasBase = resolveCanvasBase();
      const textEls = [];
      const seenEls = new Set();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = walker.nextNode())) {
        if (!(tn.textContent || "").trim()) continue;
        const pe = tn.parentElement;
        if (!pe || seenEls.has(pe)) continue;
        seenEls.add(pe);
        textEls.push(pe);
      }
      if (textEls.length === 0) textEls.push(el);
      let worst = null;
      let worstNorm = Infinity;
      for (const tel of textEls) {
        const tcs = tel === el ? cs : getComputedStyle(tel);
        if (tcs.display === "none" || tcs.visibility === "hidden") continue;
        const tEffOp = tel === el ? effOp : effectiveOpacity(tel);
        if (tEffOp === 0) continue;
        const tr = tel.getBoundingClientRect();
        if ((tr.width <= 1 && tr.height <= 1) || (tcs.overflow === "hidden" && (tr.width <= 1 || tr.height <= 1))) continue;
        const rawTextFill = (tcs.webkitTextFillColor || tcs.getPropertyValue("-webkit-text-fill-color") || "").trim();
        const tfg = (rawTextFill && parseRgba(rawTextFill)) || parseRgba(tcs.color);
        if (!tfg || tfg.a === 0) continue;
        const chain = buildChain(tel);
        if (hasVisibleComplex(chain, chain.length - 1)) continue;
        const bg = resolveIsolated(chain, canvasBase);
        const effFg = resolveIsolated(chain, canvasBase, (n) => sourceOver(tfg, n.bg));
        const l1 = lum(effFg), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const fs = parseFloat(tcs.fontSize) || 14;
        const fw = parseInt(tcs.fontWeight, 10) || 400;
        const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
        const threshold = isLarge ? 3.0 : 4.5;
        const norm = ratio / threshold;
        if (norm < worstNorm) {
          worstNorm = norm;
          worst = {
            text: (tel.textContent || el.textContent || "").trim().slice(0, 30),
            ratio: Number(ratio.toFixed(2)),
            threshold,
          };
        }
      }
      return worst;
    }, preHover.restingBgAlpha || 0);
    if (res && res.ratio < res.threshold) hoverFails.push(res);
  }
  } finally {
    await page.mouse.move(0, 0).catch(() => {});
    if (hoveredAny && maxReturnWaitMs > 0) {
      await page.waitForTimeout(Math.min(1500, Math.max(80, maxReturnWaitMs + 80))).catch(() => {});
    }
    await restoreScrollPosition(page, savedScroll);
  }
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
      const m = String(str || "").trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
      if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
      if (!str || String(str).trim().toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
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
    const extractGradientColorTokens = (bgImg, includeTransparent = false) => {
      const s = String(bgImg || "");
      const tokens = [];
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === "#") {
          const hm = /^#[0-9a-fA-F]{3,8}\b/.exec(s.slice(i, i + 12));
          if (hm) {
            tokens.push(hm[0]);
            i += hm[0].length;
            continue;
          }
        }
        const prevCh = i > 0 ? s[i - 1] : "";
        if (i === 0 || !/[A-Za-z0-9_-]/.test(prevCh)) {
          const fm = /^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|color)\(/i.exec(s.slice(i, i + 20));
          if (fm) {
            let j = i + fm[0].length;
            let depth = 1;
            let q = null;
            while (j < s.length && depth > 0) {
              const fc = s[j];
              if (q) {
                if (fc === "\\" && j + 1 < s.length) {
                  j += 2;
                  continue;
                }
                if (fc === q) q = null;
              } else if (fc === '"' || fc === "'") {
                q = fc;
              } else if (fc === "(") {
                depth++;
              } else if (fc === ")") {
                depth--;
              }
              j++;
            }
            if (depth === 0) {
              tokens.push(s.slice(i, j));
              i = j;
              continue;
            }
          }
          if (includeTransparent && /^transparent(?![A-Za-z0-9_-])/i.test(s.slice(i, i + 16))) {
            tokens.push("transparent");
            i += 11;
            continue;
          }
        }
        i++;
      }
      return tokens;
    };
    const sourceOver = (src, dst) => {
      const sa = Math.max(0, Math.min(1, Number(src?.a ?? 0)));
      const da = Math.max(0, Math.min(1, Number(dst?.a ?? 0)));
      const outA = sa + da * (1 - sa);
      if (outA <= 1e-6) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (src.r * sa + dst.r * da * (1 - sa)) / outA,
        g: (src.g * sa + dst.g * da * (1 - sa)) / outA,
        b: (src.b * sa + dst.b * da * (1 - sa)) / outA,
        a: outA,
      };
    };
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
    const resolveCanvasBase = () => {
      const rootEl = document.documentElement;
      const bodyEl = document.body;
      const rootScheme = (getComputedStyle(rootEl).colorScheme || "").toLowerCase();
      const bodyScheme = (getComputedStyle(bodyEl || rootEl).colorScheme || "").toLowerCase();
      const effScheme = bodyScheme && bodyScheme !== "normal" ? bodyScheme : rootScheme;
      const explicitDark =
        rootEl.getAttribute("data-theme") === "dark" ||
        rootEl.getAttribute("data-uxs-theme") === "dark" ||
        rootEl.getAttribute("data-mode") === "dark" ||
        bodyEl?.getAttribute("data-theme") === "dark" ||
        bodyEl?.getAttribute("data-mode") === "dark" ||
        rootEl.classList.contains("dark") ||
        Boolean(bodyEl?.classList.contains("dark"));
      const explicitLight =
        rootEl.getAttribute("data-theme") === "light" ||
        rootEl.getAttribute("data-uxs-theme") === "light" ||
        rootEl.getAttribute("data-mode") === "light" ||
        bodyEl?.getAttribute("data-theme") === "light" ||
        bodyEl?.getAttribute("data-mode") === "light" ||
        rootEl.classList.contains("light") ||
        Boolean(bodyEl?.classList.contains("light"));
      const osDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const darkDefault =
        explicitDark ||
        (!explicitLight &&
          ((effScheme.includes("dark") && !effScheme.includes("light")) ||
            (effScheme.includes("dark") && effScheme.includes("light") && osDark)));
      return darkDefault ? { r: 15, g: 23, b: 42, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    };
    const canvasBase = resolveCanvasBase();
    const buildChain = (el) => {
      const stack = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const ccs = getComputedStyle(cur);
        const c = parseColorToRgba(ccs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
        const val = parseFloat(ccs.opacity);
        const op = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 1;
        const hasBackdrop = Boolean(ccs.backdropFilter && ccs.backdropFilter !== "none");
        const hasBgImg = Boolean(ccs.backgroundImage && ccs.backgroundImage !== "none");
        stack.push({ bg: c, op, hasComplex: hasBackdrop || hasBgImg });
        if (cur === document.documentElement) break;
        cur = cur.parentElement;
      }
      return stack.reverse();
    };
    const hasVisibleComplex = (chain, endIdx) => {
      for (let i = endIdx; i >= 0; i--) {
        if (chain[i].hasComplex) return true;
        if (chain[i].bg.a >= 0.999 && chain[i].op >= 0.999 && chain.slice(0, i).every((a) => a.op >= 0.999)) {
          return false;
        }
      }
      return false;
    };
    const resolveIsolated = (chain, base, leafPaint = null) => {
      if (!chain.length) return base;
      const render = (idx) => {
        const n = chain[idx];
        let paint = idx === chain.length - 1 && leafPaint ? leafPaint(n) : n.bg;
        if (idx < chain.length - 1) paint = sourceOver(render(idx + 1), paint);
        return { r: paint.r, g: paint.g, b: paint.b, a: Math.max(0, Math.min(1, paint.a * n.op)) };
      };
      return sourceOver(render(0), base);
    };
    const effectiveOpacity = (node) => {
      let op = 1;
      let cur = node;
      while (cur && cur.nodeType === 1) {
        const val = parseFloat(getComputedStyle(cur).opacity);
        if (Number.isFinite(val)) op *= Math.max(0, Math.min(1, val));
        if (op <= 0 || cur === document.documentElement) break;
        cur = cur.parentElement;
      }
      return op;
    };
    const visible = (el) => {
      if (el.matches(DEV_OVERLAY_SEL) || el.closest(DEV_OVERLAY_SEL) || el.closest("[inert]") || isInsideClosedDetails(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || effectiveOpacity(el) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (
        el.closest('[aria-hidden="true"]') &&
        (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight)
      ) {
        return false;
      }
      if (cs.clipPath && cs.clipPath.includes("inset(50%)")) return false;
      if (r.width <= 1.5 && r.height <= 1.5 && cs.overflow === "hidden") return false;
      return true;
    };

    const vw = window.innerWidth;
    const docOverflow = Math.max(0, Math.round(document.documentElement.scrollWidth - vw));
    const bodyOverflow = Math.max(0, Math.round(document.body.scrollWidth - vw));

    const childOverflows = [];
    const childOverflowEls = new Set();
    for (const el of document.querySelectorAll("td, th, button, a, .uxs-canvas, .uxs-pane")) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        let ignoreEmptyHitPseudo = false;
        if (el.matches("button, a") && cs.overflowX === "visible") {
          const isEmptyAbs = (ps) =>
            ps && ps.position === "absolute" && (ps.content === '""' || ps.content === '" "' || ps.content === "''");
          const isNonEmptyAbs = (ps) =>
            ps && ps.position === "absolute" && ps.content && ps.content !== "none" && ps.content !== "normal" && !isEmptyAbs(ps);
          const bPs = getComputedStyle(el, "::before");
          const aPs = getComputedStyle(el, "::after");
          if ((isEmptyAbs(bPs) || isEmptyAbs(aPs)) && !isNonEmptyAbs(bPs) && !isNonEmptyAbs(aPs)) {
            const er = el.getBoundingClientRect();
            const bL = parseFloat(cs.borderLeftWidth) || 0;
            const bR = parseFloat(cs.borderRightWidth) || 0;
            const rng = document.createRange();
            rng.selectNodeContents(el);
            const rr = rng.getBoundingClientRect();
            if (rr.width === 0 || (rr.right <= er.right - bR + 1 && rr.left >= er.left + bL - 1)) {
              ignoreEmptyHitPseudo = true;
            }
          }
        }
        if (!ignoreEmptyHitPseudo) {
          childOverflowEls.add(el);
          childOverflows.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth });
        }
      }
    }

    const smallTargets = [];
    const clippedTargets = [];
    const borderFails = [];
    const badTransitions = [];
    const buttonShapes = [];
    const inputShapes = [];
    const clipsChild = (ov) => ov === "hidden" || ov === "clip" || ov === "auto" || ov === "scroll";
    const isFixedContainingBlock = (cs) =>
      cs.transform !== "none" ||
      (cs.translate && cs.translate !== "none") ||
      (cs.scale && cs.scale !== "none") ||
      (cs.rotate && cs.rotate !== "none") ||
      cs.filter !== "none" ||
      cs.perspective !== "none" ||
      cs.backdropFilter !== "none" ||
      /\b(?:transform|translate|scale|rotate|filter|perspective)\b/.test(cs.willChange || "") ||
      /\b(?:paint|layout|strict|content)\b/.test(cs.contain || "");

    const isDisabledControl = (node) =>
      Boolean(node?.disabled) ||
      node?.getAttribute?.("aria-disabled") === "true" ||
      Boolean(node?.closest?.("fieldset[disabled], [aria-disabled='true']"));
    const isInlineProseLink = (node, styleObj) => {
      if (node.tagName !== "A" || styleObj.display !== "inline") return false;
      if (node.closest("nav, [role='navigation'], header, [role='menubar'], [role='menu'], [role='tablist']")) return false;
      const proseBlock = node.closest("p, li, td, dd, blockquote, figcaption");
      if (!proseBlock) return false;
      const totalText = (proseBlock.textContent || "").replace(/\s+/g, " ").trim();
      const linkText = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!totalText || !linkText) return false;
      const clone = proseBlock.cloneNode(true);
      for (const a of Array.from(clone.querySelectorAll("a"))) a.remove();
      const nonLinkText = (clone.textContent || "").replace(/\s+/g, " ").trim();
      return nonLinkText.length >= 2;
    };
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

      const transDurs = (cs.transitionDuration || "0s").split(",").map((s) => parseFloat(s.trim()) || 0);
      const transProps = (cs.transitionProperty || "").split(",").map((s) => s.trim().toLowerCase());
      const forbidden = transProps.filter(
        (p, idx) => ["all", "width", "height", "top", "left"].includes(p) && (transDurs[idx % transDurs.length] || 0) > 0
      );
      if (forbidden.length > 0) badTransitions.push({ tag: el.tagName.toLowerCase(), text: shape.label, props: [...new Set(forbidden)] });

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
        if ((el.tagName !== "LABEL" || cs.borderTopWidth !== "0px") && !isInlineProseLink(el, cs)) {
          const domTransformScale = (styleObj) => {
            let sx = 1;
            let sy = 1;
            const tf = String(styleObj?.transform || "").trim();
            if (tf && tf.toLowerCase() !== "none") {
              for (const tok of tf.match(/(?:matrix3d|matrix|scale3d|scaleX|scaleY|scale)\([^)]+\)/gi) || []) {
                const openP = tok.indexOf("(");
                const argStr = openP !== -1 ? tok.slice(openP + 1, -1) : "";
                const rawTokens = argStr.match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?%?/gi) || [];
                const vals = rawTokens
                  .map((rawTok) => (rawTok.endsWith("%") ? parseFloat(rawTok) / 100 : parseFloat(rawTok)))
                  .filter(Number.isFinite);
                if (/^matrix3d\(/i.test(tok) && vals.length >= 7) {
                  sx *= Math.hypot(vals[0], vals[1], vals[2]);
                  sy *= Math.hypot(vals[4], vals[5], vals[6]);
                } else if (/^matrix\(/i.test(tok) && vals.length >= 4) {
                  sx *= Math.hypot(vals[0], vals[1]);
                  sy *= Math.hypot(vals[2], vals[3]);
                } else if (/^scale3d\(/i.test(tok) && vals.length >= 2) {
                  sx *= Math.abs(vals[0]);
                  sy *= Math.abs(vals[1]);
                } else if (/^scalex\(/i.test(tok) && vals.length >= 1) {
                  sx *= Math.abs(vals[0]);
                } else if (/^scaley\(/i.test(tok) && vals.length >= 1) {
                  sy *= Math.abs(vals[0]);
                } else if (/^scale\(/i.test(tok) && vals.length >= 1) {
                  sx *= Math.abs(vals[0]);
                  sy *= Math.abs(vals.length >= 2 ? vals[1] : vals[0]);
                }
              }
            }
            const sc = String(styleObj?.scale || "").trim();
            if (sc && sc.toLowerCase() !== "none") {
              const parts = sc.split(/\s+/).map((p) => (p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p))).filter(Number.isFinite);
              if (parts.length === 1) {
                sx *= Math.abs(parts[0]);
                sy *= Math.abs(parts[0]);
              } else if (parts.length >= 2) {
                sx *= Math.abs(parts[0]);
                sy *= Math.abs(parts[1]);
              }
            }
            return { sx: Number.isFinite(sx) ? sx : 1, sy: Number.isFinite(sy) ? sy : 1 };
          };
          const isSingleBox = el.offsetWidth > 0 && el.offsetHeight > 0 && cs.display !== "inline" && el.getClientRects().length === 1;
          const fallbackHostScale = domTransformScale(cs);
          const hostSx = isSingleBox ? r.width / el.offsetWidth : fallbackHostScale.sx;
          const hostSy = isSingleBox ? r.height / el.offsetHeight : fallbackHostScale.sy;
          const layoutW = isSingleBox ? el.offsetWidth : hostSx > 0 ? r.width / hostSx : r.width;
          const layoutH = isSingleBox ? el.offsetHeight : hostSy > 0 ? r.height / hostSy : r.height;
          let effW = r.width;
          let effH = r.height;
          const toPseudoPx = (val, refPx) => {
            const s = String(val || "").trim().toLowerCase();
            if (!s || s === "auto" || s === "none") return 0;
            if (s.endsWith("%")) return ((parseFloat(s) || 0) / 100) * Number(refPx || 0);
            if (s.endsWith("px")) return parseFloat(s) || 0;
            return 0;
          };
          const isExplicitSize = (val) => {
            const s = String(val ?? "").trim().toLowerCase();
            return Boolean(s && s !== "auto" && s !== "none");
          };
          for (const pseudo of ["::before", "::after"]) {
            const ps = getComputedStyle(el, pseudo);
            if (!ps || !ps.content || ps.content === "none" || ps.content === "normal") continue;
            if (ps.position !== "absolute") continue;
            if (String(ps.display || "").toLowerCase() === "none" || String(ps.display || "").toLowerCase() === "contents" || String(ps.visibility || "").toLowerCase() === "hidden") continue;
            if (String(ps.pointerEvents || "").toLowerCase() === "none") continue;
            const psScale = domTransformScale(ps);
            const hasExplicitW = isExplicitSize(ps.width);
            const hasExplicitH = isExplicitSize(ps.height);
            const minW = toPseudoPx(ps.minWidth, layoutW);
            const minH = toPseudoPx(ps.minHeight, layoutH);
            const pw = Math.max(hasExplicitW ? toPseudoPx(ps.width, layoutW) : 0, minW);
            const ph = Math.max(hasExplicitH ? toPseudoPx(ps.height, layoutH) : 0, minH);
            const isContentBox = String(ps.boxSizing || "content-box").toLowerCase() !== "border-box";
            const padL = Math.max(0, toPseudoPx(ps.paddingLeft, layoutW));
            const padR = Math.max(0, toPseudoPx(ps.paddingRight, layoutW));
            const padT = Math.max(0, toPseudoPx(ps.paddingTop, layoutW));
            const padB = Math.max(0, toPseudoPx(ps.paddingBottom, layoutW));
            const bW = (wProp, sProp) => {
              const bs = String(ps[sProp] || "").toLowerCase();
              return bs === "none" || bs === "hidden" ? 0 : Math.max(0, toPseudoPx(ps[wProp], layoutW));
            };
            const extraW = padL + padR + bW("borderLeftWidth", "borderLeftStyle") + bW("borderRightWidth", "borderRightStyle");
            const extraH = padT + padB + bW("borderTopWidth", "borderTopStyle") + bW("borderBottomWidth", "borderBottomStyle");
            const hasHorizPair = ps.left !== "auto" && ps.right !== "auto";
            const hasVertPair = ps.top !== "auto" && ps.bottom !== "auto";
            const insetW = !hasExplicitW && hasHorizPair ? Math.max(0, layoutW - toPseudoPx(ps.left, layoutW) - toPseudoPx(ps.right, layoutW)) : 0;
            const insetH = !hasExplicitH && hasVertPair ? Math.max(0, layoutH - toPseudoPx(ps.top, layoutH) - toPseudoPx(ps.bottom, layoutH)) : 0;
            const boxW = hasExplicitW ? pw + (isContentBox ? extraW : 0) : Math.max(insetW, minW + (isContentBox ? extraW : 0), extraW);
            const boxH = hasExplicitH ? ph + (isContentBox ? extraH : 0) : Math.max(insetH, minH + (isContentBox ? extraH : 0), extraH);
            let cEffW = boxW * psScale.sx * hostSx;
            let cEffH = boxH * psScale.sy * hostSy;
            const containClips = /\b(?:paint|strict|content)\b/.test(cs.contain || "");
            if (cs.position !== "static" || isFixedContainingBlock(cs)) {
              if (containClips || clipsChild(cs.overflowX)) cEffW = Math.min(cEffW, r.width);
              if (containClips || clipsChild(cs.overflowY)) cEffH = Math.min(cEffH, r.height);
            }
            const allowsW = cEffH >= Math.min(r.height, 44);
            const allowsH = cEffW >= Math.min(r.width, 44);
            if (allowsW && cEffW > effW) effW = cEffW;
            if (allowsH && cEffH > effH) effH = cEffH;
          }
          if (effW < 43.99 || effH < 43.99) {
            smallTargets.push({
              tag: el.tagName.toLowerCase(),
              text: shape.label,
              w: Number(effW.toFixed(1)),
              h: Number(effH.toFixed(1)),
              ...(childOverflowEls.has(el) ? { overlapsChildOverflow: true } : {}),
            });
          }
        }
      }

      if (!isDisabledControl(el)) {
        const visibleBorderSides = [];
        for (const side of ["Top", "Right", "Bottom", "Left"]) {
          const bW = parseFloat(cs[`border${side}Width`]) || 0;
          const bStyle = (cs[`border${side}Style`] || "").toLowerCase();
          const bCol = parseColorToRgba(cs[`border${side}Color`]);
          if (bW >= 1 && bStyle !== "none" && bStyle !== "hidden" && bCol && bCol.a > 0) {
            visibleBorderSides.push(bCol);
          }
        }
        if (visibleBorderSides.length > 0) {
          const elChain = buildChain(el);
          const clip = (cs.backgroundClip || "border-box").split(",")[0].trim().toLowerCase();
          const selfFillNode = elChain[elChain.length - 1];
          const hasTranslucentSelfComplex = visibleBorderSides.some(
            (bc) => bc.a < 0.999 && clip !== "padding-box" && clip !== "content-box" && Boolean(selfFillNode?.hasComplex)
          );
          const hasComplexBackdrop = hasVisibleComplex(elChain, elChain.length - 2) || hasTranslucentSelfComplex;
          if (!hasComplexBackdrop) {
            const parentBg = resolveIsolated(elChain.slice(0, -1), canvasBase);
            const sideCrs = visibleBorderSides.map((bc) => {
              const effBorder = resolveIsolated(elChain, canvasBase, (n) =>
                clip === "padding-box" || clip === "content-box" ? bc : sourceOver(bc, n.bg)
              );
              return ratio(effBorder, parentBg);
            });
            const bestBorderCr = Math.max(...sideCrs);
            const selfHasBackdrop = Boolean(cs.backdropFilter && cs.backdropFilter !== "none");
            const selfHasBgImg = Boolean(cs.backgroundImage && cs.backgroundImage !== "none");
            let selfBgCr = 1;
            if (selfFillNode && !selfHasBackdrop) {
              if (!selfHasBgImg && selfFillNode.bg && selfFillNode.bg.a > 0) {
                selfBgCr = ratio(resolveIsolated(elChain, canvasBase), parentBg);
              } else if (selfHasBgImg && !/url\(/i.test(cs.backgroundImage || "")) {
                const tokens = extractGradientColorTokens(cs.backgroundImage || "", false);
                const stops = [];
                for (const tok of tokens) {
                  const c = parseColorToRgba(tok);
                  if (c && c.a > 0) stops.push(c);
                }
                if (stops.length > 0 && stops.every((c) => c.a >= 0.75)) {
                  selfBgCr = Math.min(
                    ...stops.map((sc) => ratio(resolveIsolated(elChain, canvasBase, (n) => sourceOver(sc, n.bg)), parentBg))
                  );
                } else if (selfFillNode.bg && selfFillNode.bg.a >= 0.9) {
                  selfBgCr = ratio(resolveIsolated(elChain, canvasBase), parentBg);
                }
              }
            }
            if (bestBorderCr < 3.0 && selfBgCr < 3.0) {
              borderFails.push({ tag: el.tagName.toLowerCase(), text: shape.label, ratio: Number(bestBorderCr.toFixed(2)) });
            }
          }
        }
      }
    }

    // Collect visible text samples for APCA-W3 evaluation in Node
    const hasDirectTextNode = (el) =>
      Array.from(el?.childNodes || []).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0);
    const textSamples = [];
    for (const el of document.querySelectorAll("h1, h2, h3, p, a, button, label, td, li, span")) {
      if (textSamples.length >= 60 || !visible(el)) continue;
      if (!hasDirectTextNode(el)) continue;
      const cs = getComputedStyle(el);
      const effOp = effectiveOpacity(el);
      const rawTextFill = (cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color") || "").trim();
      const fg = (rawTextFill && parseColorToRgba(rawTextFill)) || parseColorToRgba(cs.color);
      if (!fg || fg.a === 0 || effOp <= 0) continue;
      const elChain = buildChain(el);
      if (hasVisibleComplex(elChain, elChain.length - 1)) continue;
      const bg = resolveIsolated(elChain, canvasBase);
      const effFg = resolveIsolated(elChain, canvasBase, (n) => sourceOver(fg, n.bg));
      const fs = parseFloat(cs.fontSize) || 16;
      const fw = parseInt(cs.fontWeight, 10) || 400;
      textSamples.push({
        label: `${el.tagName.toLowerCase()}("${(el.textContent || "").trim().slice(0, 24)}")`,
        fg: [Math.round(effFg.r), Math.round(effFg.g), Math.round(effFg.b)],
        bg: [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)],
        isLarge: fs >= 24 || (fs >= 18.66 && fw >= 700),
      });
    }

    const focusLeaks = [];
    const leakedNodes = new Set();
    const FOCUSABLE_SEL =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    for (const c of document.querySelectorAll('[aria-hidden="true"], [data-drawer="closed"]')) {
      const cs = getComputedStyle(c);
      if (cs.display === "none" || cs.visibility === "hidden" || c.closest("[inert], fieldset[disabled]")) continue;
      const candidates = c.matches(FOCUSABLE_SEL)
        ? [c, ...c.querySelectorAll(FOCUSABLE_SEL)]
        : [...c.querySelectorAll(FOCUSABLE_SEL)];
      for (const t of candidates) {
        if (leakedNodes.has(t) || t.hasAttribute("disabled") || t.closest("[inert], fieldset[disabled]")) continue;
        const rawTi = t.getAttribute("tabindex");
        if (rawTi !== null) {
          const ti = Number.parseInt(rawTi.trim(), 10);
          if (Number.isFinite(ti) && ti < 0) continue;
          if (!Number.isFinite(ti) && !t.matches("a[href], button, input, select, textarea")) continue;
        }
        const tcs = getComputedStyle(t);
        if (tcs.display !== "none" && tcs.visibility !== "hidden" && t.getClientRects().length > 0) {
          leakedNodes.add(t);
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
      if (el.tagName === "SELECT") {
        return (el.getAttribute("title") || "").trim();
      }
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const inpType = (el.getAttribute("type") || "text").toLowerCase();
        if (el.tagName === "INPUT" && inpType === "image") {
          return (el.getAttribute("alt") || el.getAttribute("title") || el.value || "").trim();
        }
        const isBtnInput = el.tagName === "INPUT" && ["button", "submit", "reset"].includes(inpType);
        const text = (isBtnInput ? el.value : el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
        return text;
      }
      const text = (el.textContent || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
      if (text) return text;
      const img = el.querySelector("img[alt]");
      if (img && img.getAttribute("alt")?.trim()) return img.getAttribute("alt").trim();
      return "";
    };

    const focusableControls = [];
    for (const el of document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"]'
    )) {
      if (!visible(el) || el.hasAttribute("disabled") || el.closest("[inert], fieldset[disabled]")) continue;
      const tiAttr = el.getAttribute("tabindex");
      const ti = tiAttr === null ? null : parseInt(tiAttr, 10);
      if (ti !== null && Number.isFinite(ti) && ti < 0) continue;
      const isNativeFocusable =
        ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(el.tagName) ||
        (el.tagName === "A" && el.hasAttribute("href"));
      if (!isNativeFocusable && (ti === null || !Number.isFinite(ti))) continue;
      const acc = getAccName(el);
      focusableControls.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        tabindex: ti !== null && Number.isFinite(ti) ? ti : 0,
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
    for (const el of document.querySelectorAll('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"], [data-badge], [data-pill]')) {
      if (badgesSnapshot.length >= 40 || !visible(el)) continue;
      if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "CODE", "PRE", "SVG"].includes(String(el.tagName || "").toUpperCase())) continue;
      const clsStr = typeof el.className === "string" ? el.className : "";
      const clsTokens = clsStr.trim().split(/\s+/).filter(Boolean);
      const isBadgeToken =
        clsTokens.some((c) => /(?:^|[-_])(?:badge|pill|chip|tag)s?(?:$|[-_])/i.test(c)) ||
        el.hasAttribute("data-badge") ||
        el.hasAttribute("data-pill");
      if (!isBadgeToken) continue;
      if (
        /\b(?:badge|pill|chip|tag)s?(?:[-_]{1,2})?(?:list|group|row|wrap(?:per)?|bar|stack|container|grid|holder|set)\b/i.test(clsStr) ||
        el.querySelector('[class*="badge"], [class*="pill"], [class*="chip"], [class*="tag"]') ||
        (el.children.length >= 2 && !hasDirectTextNode(el))
      ) {
        continue;
      }
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 42) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 14;
      const lh = cs.lineHeight === "normal" ? fs * 1.25 : parseFloat(cs.lineHeight) || fs * 1.25;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const r = el.getBoundingClientRect();
      const contentH = Math.max(0, Math.round(r.height - padTop - padBottom - borderTop - borderBottom));
      badgesSnapshot.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 32), w: r.width, h: r.height, contentH, lineHeightPx: lh });
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
      const elCs = getComputedStyle(el);
      if (elCs.pointerEvents === "none") continue;
      let visLeft = Math.max(0, r.left);
      let visTop = Math.max(0, r.top);
      let visRight = Math.min(vw, r.right);
      let visBottom = Math.min(window.innerHeight, r.bottom);
      const elPos = elCs.position;
      let elFixedSeen = elPos === "fixed";
      let skipUntilAbsContainingBlock = elPos === "absolute";
      let anc = el.parentElement;
      while (anc && anc !== document.documentElement) {
        const acs = getComputedStyle(anc);
        if (elFixedSeen) {
          if (!isFixedContainingBlock(acs)) {
            anc = anc.parentElement;
            continue;
          }
          elFixedSeen = false;
        } else if (skipUntilAbsContainingBlock) {
          if (acs.position === "static" && !isFixedContainingBlock(acs)) {
            anc = anc.parentElement;
            continue;
          }
          skipUntilAbsContainingBlock = false;
        }
        if (acs.position === "fixed") {
          elFixedSeen = true;
        } else if (acs.position === "absolute") {
          skipUntilAbsContainingBlock = true;
        }
        const ancContainClips = /\b(?:paint|strict|content)\b/.test(acs.contain || "");
        const clipX = ancContainClips || clipsChild(acs.overflowX);
        const clipY = ancContainClips || clipsChild(acs.overflowY);
        if (clipX || clipY) {
          const ar = anc.getBoundingClientRect();
          if (clipX) {
            visLeft = Math.max(visLeft, ar.left);
            visRight = Math.min(visRight, ar.right);
          }
          if (clipY) {
            visTop = Math.max(visTop, ar.top);
            visBottom = Math.min(visBottom, ar.bottom);
          }
        }
        anc = anc.parentElement;
      }
      if (visRight - visLeft < 6 || visBottom - visTop < 6) continue;
      let cx = Math.round((visLeft + visRight) / 2);
      let cy = Math.round((visTop + visBottom) / 2);
      let pickedTextPt = false;
      const collectTextNodePoints = (node) => {
        const pts = [];
        for (const ch of node?.childNodes || []) {
          if (ch.nodeType === 3 && (ch.textContent || "").trim()) {
            const rng = document.createRange();
            rng.selectNodeContents(ch);
            for (const cr of rng.getClientRects ? rng.getClientRects() : []) {
              const cL = Math.max(visLeft, cr.left);
              const cT = Math.max(visTop, cr.top);
              const cR = Math.min(visRight, cr.right);
              const cB = Math.min(visBottom, cr.bottom);
              if (cR - cL >= 6 && cB - cT >= 6) {
                pts.push([Math.round((cL + cR) / 2), Math.round((cT + cB) / 2)]);
              }
            }
          }
        }
        return pts;
      };
      let txtPts = collectTextNodePoints(el);
      if (txtPts.length === 0) {
        for (const desc of el.querySelectorAll("*")) {
          if (!visible(desc)) continue;
          txtPts = collectTextNodePoints(desc);
          if (txtPts.length > 0) break;
        }
      }
      if (txtPts.length > 0) {
        cx = txtPts[0][0];
        cy = txtPts[0][1];
        pickedTextPt = true;
      }
      const clientRects = !pickedTextPt && el.getClientRects ? el.getClientRects() : [];
      if (!pickedTextPt && clientRects.length > 1) {
        for (const cr of clientRects) {
          const cL = Math.max(visLeft, cr.left);
          const cT = Math.max(visTop, cr.top);
          const cR = Math.min(visRight, cr.right);
          const cB = Math.min(visBottom, cr.bottom);
          if (cR - cL >= 6 && cB - cT >= 6) {
            cx = Math.round((cL + cR) / 2);
            cy = Math.round((cT + cB) / 2);
            break;
          }
        }
      }
      if (cx <= 0 || cx >= vw || cy <= 0 || cy >= window.innerHeight) continue;
      sampledTextChecks++;
      const pointEls = document.elementsFromPoint(cx, cy) || [];
      const elIdx = pointEls.findIndex((h) => h && (h === el || el.contains(h)));
      if (elIdx === -1) continue;
      for (let k = 0; k < elIdx; k++) {
        const hitEl = pointEls[k];
        if (!hitEl || hitEl === el) continue;
        if (hitEl.matches(DEV_OVERLAY_SEL) || hitEl.closest(DEV_OVERLAY_SEL)) continue;
        const tcs = getComputedStyle(hitEl);
        let hitFixedOrSticky = false;
        let hitOpacity = 1;
        let hitCur = hitEl;
        while (hitCur && hitCur.nodeType === 1) {
          const hitCs = getComputedStyle(hitCur);
          if (hitCs.position === "fixed" || hitCs.position === "sticky") {
            hitFixedOrSticky = true;
          }
          const op = parseFloat(hitCs.opacity);
          if (Number.isFinite(op)) hitOpacity *= Math.max(0, Math.min(1, op));
          if (hitOpacity <= 0.2 || hitCur === document.documentElement) break;
          hitCur = hitCur.parentElement;
        }
        if ((hitFixedOrSticky && window.scrollY > 4) || hitOpacity <= 0.2) continue;
        const tbg = parseColorToRgba(tcs.backgroundColor);
        const isMediaCover =
          hitEl.tagName === "IMG" ||
          String(hitEl.tagName || "").toUpperCase() === "SVG" ||
          Boolean(hitEl.closest("svg")) ||
          hitEl.tagName === "CANVAS";
        const hasOpaqueBgImage = (bgImg) => {
          if (!bgImg || bgImg === "none") return false;
          if (/url\(/i.test(bgImg)) return true;
          if (/gradient\(/i.test(bgImg)) {
            const tokens = extractGradientColorTokens(bgImg, true);
            if (tokens.length === 0) return false;
            let minA = 1;
            let sumA = 0;
            let count = 0;
            for (const tok of tokens) {
              const c = parseColorToRgba(tok);
              if (!c) continue;
              minA = Math.min(minA, c.a);
              sumA += c.a;
              count++;
            }
            return count > 0 && (minA >= 0.75 || (sumA / count >= 0.75 && minA >= 0.5));
          }
          return false;
        };
        const isOpaqueCover =
          ((isMediaCover || hasOpaqueBgImage(tcs.backgroundImage)) && hitOpacity >= 0.75) ||
          (tbg && tbg.a * hitOpacity >= 0.75);
        if (isOpaqueCover) {
          coveredText.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 28), coveredBy: hitEl.tagName.toLowerCase() });
          break;
        }
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

  const smallTargetsAnnotated = raw.smallTargets;
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
    const visitedSheets = new Set();
    const visit = (rules, inRoot = false) => {
      if (!rules) return;
      for (const rule of Array.from(rules)) {
        if (rule.styleSheet && !visitedSheets.has(rule.styleSheet)) {
          visitedSheets.add(rule.styleSheet);
          try {
            if (rule.styleSheet.cssRules) visit(rule.styleSheet.cssRules, false);
          } catch {}
        }
        const sel = rule.selectorText || "";
        const isRootSel = Boolean(
          sel && /(:root|\bhtml\b|\[data-(?:uxs-)?theme|\[data-mode|\.(?:dark|light)\b)/i.test(sel)
        );
        const effectiveRoot = sel
          ? isRootSel || (inRoot && sel.split(",").some((part) => /^&(?:[:[.]|$)/.test(part.trim())))
          : inRoot;
        if (rule.cssRules) visit(rule.cssRules, effectiveRoot);
        if (!rule.style || !effectiveRoot) continue;
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith("--") && !/^--(?:(?:tw|radix|next|vite|sb|storybook)-|_+)/i.test(prop)) {
            names.add(prop);
          }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets || [])) {
      if (visitedSheets.has(sheet)) continue;
      visitedSheets.add(sheet);
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      visit(rules, false);
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
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let lcpMs = null;
        let cls = 0;
        const observers = [];
        try {
          if (typeof PerformanceObserver !== "undefined") {
            const types = Array.isArray(PerformanceObserver.supportedEntryTypes)
              ? PerformanceObserver.supportedEntryTypes
              : [];
            if (types.includes("largest-contentful-paint")) {
              const lcpObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  lcpMs = Math.round(entry.startTime);
                }
              });
              lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
              observers.push(lcpObs);
            }
            if (types.includes("layout-shift")) {
              const clsObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  if (!entry.hadRecentInput) cls += entry.value;
                }
              });
              clsObs.observe({ type: "layout-shift", buffered: true });
              observers.push(clsObs);
            }
          }
        } catch {}
        setTimeout(() => {
          for (const obs of observers) {
            try {
              obs.disconnect();
            } catch {}
          }
          resolve({ lcpMs, cls: Number(cls.toFixed(4)) });
        }, 50);
      })
  );
}

async function captureWiringInventory(page, target) {
  const url = toUrl(target);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("load", { timeout: 10000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => null);
  if (/^https?:\/\//i.test(url)) await page.waitForTimeout(250);
  return page.evaluate(() => {
    const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort();
    return {
      links: uniq(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))),
      forms: uniq(Array.from(document.querySelectorAll("form")).map((f) => f.getAttribute("id") || f.getAttribute("action") || "unnamed-form")),
      fieldNames: uniq(Array.from(document.querySelectorAll("input[name], select[name], textarea[name]")).map((el) => el.getAttribute("name"))),
      ids: uniq(Array.from(document.querySelectorAll("[id]")).map((el) => el.getAttribute("id"))),
      testIds: uniq(Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"))),
    };
  });
}

function diffWiring(before, after) {
  const dropped = {};
  for (const key of ["links", "forms", "fieldNames", "ids", "testIds"]) {
    const afterSet = new Set(after[key] || []);
    const missing = (before[key] || []).filter((x) => !afterSet.has(x));
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
  const wDropped = diffWiring(
    { links: ["/a"], forms: [], fieldNames: ["email"], ids: ["hero", "cta"], testIds: [] },
    { links: ["/a"], forms: [], fieldNames: ["email"], ids: ["hero"], testIds: [] }
  );
  assert.equal(wDropped.passed, false);
  assert.deepEqual(wDropped.dropped, { ids: ["cta"] });
  assert.equal(
    diffWiring(
      { links: ["/a"], forms: [], fieldNames: ["email"], ids: ["hero", "cta"], testIds: [] },
      { links: ["/a"], forms: [], fieldNames: ["email"], ids: ["hero", "cta", "extra"], testIds: [] }
    ).passed,
    true
  );

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
    assert.deepEqual(
      computeEffectiveHitArea({ width: 20, height: 20 }, { content: '""', position: "absolute", left: "-14px", right: "auto" }, null),
      { width: 20, height: 20 },
      "Single-edge negative inset without opposite edge must not inflate width"
    );
    assert.deepEqual(
      computeEffectiveHitArea({ width: 24, height: 24 }, { content: '""', position: "absolute", width: "48px", height: "48px", pointerEvents: "none" }, null),
      { width: 24, height: 24 },
      "pointer-events: none pseudo-element must not inflate hit area"
    );
    assert.deepEqual(
      computeEffectiveHitArea({ width: 20, height: 20 }, { content: '""', position: "absolute", top: "0px", bottom: "0px", left: "10px", right: "-24px" }, null),
      { width: 34, height: 20 },
      "Asymmetric positive+negative pseudo insets must subtract positive offset"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", width: "24px", height: "24px", minWidth: "100%", minHeight: "100%" },
        null
      ),
      { width: 24, height: 24 },
      "Percentage minWidth/minHeight (100%) must resolve against element rect rather than inflating to 100px"
    );
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ entries: { "btn--primary": { id: "btn--primary", type: "story" } } }) });
      const customSbUrls = await resolveStorybookUrls("https://sb.example.com/custom-index.json", 4);
      assert.deepEqual(customSbUrls, ["https://sb.example.com/iframe.html?id=btn--primary&viewMode=story"]);
    } finally {
      globalThis.fetch = origFetch;
    }
    const missingIframeDir = join(scratch, "no-iframe");
    mkdirSync(missingIframeDir, { recursive: true });
    writeFileSync(join(missingIframeDir, "index.json"), JSON.stringify({ entries: {} }));
    await assert.rejects(
      () => resolveStorybookUrls(join(missingIframeDir, "index.json"), 4),
      /sibling iframe\.html/,
      "Local Storybook index without sibling iframe.html must reject clearly"
    );
    const interlacedIhdr = Buffer.alloc(13);
    interlacedIhdr.writeUInt32BE(1, 0);
    interlacedIhdr.writeUInt32BE(1, 4);
    interlacedIhdr[8] = 8;
    interlacedIhdr[9] = 6;
    interlacedIhdr[12] = 1;
    const crc32Buf = (b) => {
      let c = 0xffffffff;
      for (let i = 0; i < b.length; i++) {
        c ^= b[i];
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const mkC = (t, d) => {
      const o = Buffer.alloc(12 + d.length);
      o.writeUInt32BE(d.length, 0);
      o.write(t, 4, "ascii");
      d.copy(o, 8);
      o.writeUInt32BE(crc32Buf(o.subarray(4, 8 + d.length)), 8 + d.length);
      return o;
    };
    const interlacedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mkC("IHDR", interlacedIhdr),
      mkC("IEND", Buffer.alloc(0)),
    ]);
    assert.throws(() => decodePngRgba(interlacedPng), /Interlaced PNGs/);
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
    assert.equal(validateLiveInteractionSnapshot({ label: "Floor Fix", selectionUpdated: false, docOverflow: 0, panelOverflow: 0 }).length, 1);
    assert.equal(validateLiveInteractionSnapshot({ label: "Floor Fix", selectionUpdated: true, docOverflow: 14, panelOverflow: 0 }).length, 1);
    assert.deepEqual(validateLiveInteractionSnapshot({ label: "Floor Fix", selectionUpdated: true, docOverflow: 0, panelOverflow: 0 }), []);

    // Round 3 regression: hidden/display-none pseudo-element must not inflate 44px touch target
    const hiddenPseudo = computeEffectiveHitArea(
      { width: 24, height: 24 },
      { content: '""', position: "absolute", display: "none", width: "48px", height: "48px", pointerEvents: "auto" },
      { content: '""', position: "absolute", visibility: "hidden", width: "48px", height: "48px", pointerEvents: "auto" }
    );
    assert.deepEqual(hiddenPseudo, { width: 24, height: 24 }, "Hidden pseudo-element must not extend interactive hit box");

    // Round 7 regressions: 1px hairline & explicit 8x8 centered inset dot must not inflate 44px touch target
    assert.deepEqual(
      computeEffectiveHitArea({ width: 20, height: 20 }, { content: '""', position: "absolute", width: "48px", height: "1px" }, null),
      { width: 20, height: 20 },
      "1px hairline ::before must not inflate effective width to 48px"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 20, height: 20 },
        { content: '""', position: "absolute", width: "8px", height: "8px", top: "-14px", bottom: "-14px", left: "-14px", right: "-14px" },
        null
      ),
      { width: 20, height: 20 },
      "Explicit 8x8 pseudo-element with -14px insets must not inflate effective hit area"
    );

    // Round 8 regressions: isolated-group opacity compositing across all 4 modes & auto+minWidth:"0px" hit area
    const darkCanvas = { r: 11, g: 17, b: 27, a: 1 };
    const lightCanvas = { r: 255, g: 255, b: 255, a: 1 };
    const btnOpChain = [{ bg: { r: 255, g: 255, b: 255, a: 1 }, op: 0.5 }];
    const c1Bg = compositeIsolatedChain(btnOpChain, darkCanvas);
    const c1Fg = compositeIsolatedChain(btnOpChain, darkCanvas, (n) => sourceOverRgba({ r: 11, g: 17, b: 27, a: 1 }, n.bg));
    assert.ok(Math.abs(apcaContrast([c1Fg.r, c1Fg.g, c1Fg.b], [c1Bg.r, c1Bg.g, c1Bg.b])) < 45, "0.5 opacity button on #0b111b must fail APCA body/large contrast");

    const ancOpChain = [
      { bg: { r: 0, g: 0, b: 0, a: 1 }, op: 0.5 },
      { bg: { r: 255, g: 255, b: 255, a: 1 }, op: 1 },
    ];
    const c2Bg = compositeIsolatedChain(ancOpChain, lightCanvas);
    const c2Fg = compositeIsolatedChain(ancOpChain, lightCanvas, (n) => sourceOverRgba({ r: 0, g: 0, b: 0, a: 1 }, n.bg));
    assert.equal(Math.round(c2Bg.r), 255);
    assert.equal(Math.round(c2Fg.r), 128);
    assert.ok(wcagContrast([c2Fg.r, c2Fg.g, c2Fg.b], [c2Bg.r, c2Bg.g, c2Bg.b]) < 4.5, "Button inside 0.5 opacity parent must fail WCAG 4.5");

    const c3Parent = compositeIsolatedChain(ancOpChain.slice(0, 1), lightCanvas);
    const c3Border = compositeIsolatedChain(
      [{ bg: { r: 0, g: 0, b: 0, a: 1 }, op: 0.5 }, { bg: { r: 0, g: 0, b: 0, a: 0 }, op: 1 }],
      lightCanvas,
      (n) => sourceOverRgba({ r: 153, g: 153, b: 153, a: 1 }, n.bg)
    );
    assert.equal(Math.round(c3Parent.r), 128);
    assert.equal(Math.round(c3Border.r), 204);
    assert.ok(wcagContrast([c3Border.r, c3Border.g, c3Border.b], [c3Parent.r, c3Parent.g, c3Parent.b]) < 3.0, "Transparent input border inside 0.5 opacity parent must fail 3.0 UI contrast");

    const c4EffFg = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [0, 0, 0, 0], op: 0.5, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
        ],
      },
      [128, 128, 128]
    );
    assert.deepEqual(c4EffFg, [255, 255, 255], "pixelBehind inside 0.5 opacity gradient container must recover white fg without double blend");

    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 16, height: 16 },
        { content: '""', position: "absolute", width: "auto", height: "auto", minWidth: "0px", minHeight: "0px", top: "-14px", bottom: "-14px", left: "-14px", right: "-14px" },
        null
      ),
      { width: 44, height: 44 },
      "Browser default minWidth/minHeight '0px' with width/height 'auto' must allow inset expansion"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 16, height: 16 },
        { content: '""', position: "absolute", width: "auto", height: "auto", minWidth: "24px", minHeight: "24px", top: "-14px", bottom: "-14px", left: "-14px", right: "-14px" },
        null
      ),
      { width: 44, height: 44 },
      "Explicit minWidth 24px must act as lower bound instead of blocking inset expansion"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 16, height: 16 },
        { content: '""', position: "absolute", width: "auto", height: "auto", minWidth: "52px", minHeight: "48px" },
        null
      ),
      { width: 52, height: 48 },
      "Explicit minWidth 52px / minHeight 48px must still act as floor when no insets expand larger"
    );

    // Round 9 regressions (R9-A3-01, R9-A3-04, R9-A3-05): opaque ancestor backdrop solving, host overflow clipping of ::before,
    // strict CLI parseArgs validation, and nonexistent --axe rejection
    const r9Case1 = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [0, 0, 0, 0], op: 0.35, hasComplex: false },
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
        ],
      },
      [0, 0, 0]
    );
    assert.deepEqual(r9Case1, [89, 89, 89], "Opaque body ancestor must preserve div opacity when solving sibling backdrop");

    const r9Case2 = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [255, 255, 255, 1], op: 0.5, hasComplex: false },
        ],
      },
      [128, 128, 128]
    );
    assert.ok(r9Case2[0] <= 2 && r9Case2[1] <= 2 && r9Case2[2] <= 2, `Opaque leaf under translucent leaf op must not double-blend (got ${JSON.stringify(r9Case2)})`);

    const r9Case3 = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 0.5],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [255, 255, 255, 0.5], op: 1, hasComplex: false },
        ],
      },
      [128, 128, 128]
    );
    assert.deepEqual(r9Case3, [64, 64, 64], "Translucent fg over translucent leaf bg must not double-blend");

    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 28, height: 28 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px" },
        null,
        { position: "relative", overflowX: "hidden", overflowY: "hidden" }
      ),
      { width: 28, height: 28 },
      "Host overflow: hidden must clip positioned ::before hit expansion back to host box"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 28, height: 28 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px" },
        null,
        { position: "static", overflowX: "hidden", overflowY: "hidden" }
      ),
      { width: 48, height: 48 },
      "position: static host overflow: hidden does not clip position: absolute ::before"
    );

    assert.throws(() => parseArgs(["page.html", "--unknown-flag"]), /Unknown option/i);
    assert.throws(() => parseArgs(["page.html", "--out", "--json"]), /requires a non-empty value|ambiguous/i);
    assert.throws(() => parseArgs(["page.html", "--diff-threshold", "-5"]), /Invalid --diff-threshold|ambiguous/i);
    assert.throws(() => parseArgs(["page.html", "--diff-threshold=-5"]), /Invalid --diff-threshold/);
    assert.throws(() => parseArgs(["page.html", "--diff-threshold", "1.5foo"]), /Invalid --diff-threshold/);
    assert.throws(() => parseArgs(["page.html", "--max-stories", "0"]), /Invalid --max-stories/);
    assert.equal(parseArgs(["--out=r.json", "--diff-threshold=2.5"]).diffThreshold, 2.5);
    assert.throws(() => findAxe(join(scratch, "missing-axe.min.js"), [nestedDraft]), /Explicit --axe path not found/);

    // Round 10 regressions (R10-A3-01, R10-A3-08, R10-A3-09): residual calibration check & complexIdx fallback,
    // contain:paint + 2-value overflow clipping, whitespace-only --cdp/--out rejection
    const r10CaseA = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 0.5],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [0, 0, 0, 0.5], op: 1, hasComplex: false },
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
        ],
      },
      [255, 255, 255]
    );
    assert.deepEqual(r10CaseA, [128, 128, 128], "Clamped infeasible solveIdx must fall back to leafIdx");

    const r10CaseB = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 0.5],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1, hasComplex: true },
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
        ],
      },
      [0, 0, 0]
    );
    assert.deepEqual(r10CaseB, [0, 0, 0], "Occluded complexIdx must fall through to fallback solver");

    const r10CaseC = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1, hasComplex: false },
          { bg: [0, 0, 0, 0], op: 0.5, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 1, hasComplex: false },
        ],
      },
      [9, 9, 9]
    );
    assert.ok(r10CaseC[0] <= 10 && r10CaseC[1] <= 10 && r10CaseC[2] <= 10, `Infeasible negative complexIdx solution must fall through (got ${JSON.stringify(r10CaseC)})`);

    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px" },
        null,
        { position: "static", contain: "paint", overflowX: "visible", overflowY: "visible" }
      ),
      { width: 24, height: 24 },
      "contain: paint must clip ::before hit expansion even when overflow is visible"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px" },
        null,
        { position: "relative", overflow: "hidden visible" }
      ),
      { width: 24, height: 44 },
      "Two-value overflow: hidden visible must clip only horizontal expansion"
    );
    assert.throws(() => parseArgs(["page.html", "--cdp", "   "]), /requires a non-empty value/);
    assert.throws(() => parseArgs(["page.html", "--out", "   "]), /requires a non-empty value/);

    // Round 12 regressions (R12-A3-04): scaled pseudo-element and scaled host transform/scale in computeEffectiveHitArea
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px", transform: "scale(0)" },
        null,
        null
      ),
      { width: 24, height: 24 },
      "transform: scale(0) on ::before must not inflate 24x24 hit target"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "-10px", bottom: "-10px", left: "-10px", right: "-10px", scale: "0" },
        null,
        null
      ),
      { width: 24, height: 24 },
      "CSS scale: 0 on ::before must not inflate 24x24 hit target"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", width: "48px", height: "48px" },
        null,
        { position: "relative", transform: "matrix(0.5, 0, 0, 0.5, 0, 0)" }
      ),
      { width: 24, height: 24 },
      "Host transform matrix(0.5...) must scale ::before 48px layout width to 24px"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "0px", right: "0px", bottom: "0px", left: "0px" },
        null,
        { position: "relative", transform: "scale(0.5)" }
      ),
      { width: 24, height: 24 },
      "Host transform scale(0.5) must scale ::before inset: 0px to 24px"
    );

    // Round 13 regressions (R13-A3-01): matrix3d / scale3d digit capture & % unit scale
    assert.deepEqual(
      parseTransformScale({ transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)" }),
      { sx: 1, sy: 1 },
      "Identity matrix3d must return scale (1, 1) without capturing '3' from 'matrix3d'"
    );
    assert.deepEqual(
      parseTransformScale({ transform: "matrix3d(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)" }),
      { sx: 0, sy: 0 },
      "Zero-scaled matrix3d must return scale (0, 0)"
    );
    assert.deepEqual(
      parseTransformScale({ transform: "scale3d(0.2, 0.8, 1)" }),
      { sx: 0.2, sy: 0.8 },
      "scale3d(0.2, 0.8, 1) must parse x/y scales accurately without capturing '3'"
    );
    assert.deepEqual(
      parseTransformScale({ transform: "scale(50%, 80%)" }),
      { sx: 0.5, sy: 0.8 },
      "scale(50%, 80%) percentage values must divide by 100"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 20, height: 20 },
        { content: '""', position: "absolute", width: "20px", height: "44px", transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)" },
        null,
        null
      ),
      { width: 20, height: 44 },
      "GPU-composited identity matrix3d on 20x44 ::before must not inflate effective hit width past 20px"
    );

    // Round 14 regressions (R14-A3-01, R14-A3-04): opaque-occluder chain & CDP fallback parity check
    const hasVisComplexRef = (chain, endIdx) => {
      for (let i = endIdx; i >= 0; i--) {
        if (chain[i].hasComplex) return true;
        if (chain[i].bg.a >= 0.999 && chain[i].op >= 0.999 && chain.slice(0, i).every((a) => a.op >= 0.999)) {
          return false;
        }
      }
      return false;
    };
    assert.equal(
      hasVisComplexRef([{ bg: { a: 0 }, op: 1, hasComplex: true }, { bg: { a: 1 }, op: 1, hasComplex: false }, { bg: { a: 0 }, op: 1, hasComplex: false }], 2),
      false,
      "Opaque non-complex card must occlude complex body background-image"
    );
    assert.equal(
      hasVisComplexRef([{ bg: { a: 0 }, op: 0.9, hasComplex: true }, { bg: { a: 1 }, op: 1, hasComplex: false }], 1),
      true,
      "Translucent ancestor opacity above opaque card keeps backdrop complex"
    );
    assert.equal(
      readFileSync(fileURLToPath(import.meta.url), "utf8").includes("} else if (args.live || isCdpAttached) {"),
      true,
      "CDP mode must enable DOM theme fallback during Light/Dark sweep"
    );

    // Round 15 regressions (R15-A3-01): backdrop-filter must not be conflated with background-image inside opacity group
    const r15BackdropWhite = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [0, 0, 0, 0], op: 1, hasBgImg: false, hasBackdrop: false, hasComplex: false },
          { bg: [255, 255, 255, 1], op: 1, hasBgImg: true, hasBackdrop: false, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 0.5, hasBgImg: false, hasBackdrop: true, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 1, hasBgImg: false, hasBackdrop: false, hasComplex: false },
        ],
      },
      [128, 128, 128]
    );
    assert.deepEqual(r15BackdropWhite, [192, 192, 192], "Translucent backdrop-filter container must composite white text over backdrop instead of fabricating opaque in-group paint");
    const r15BackdropBlack = resolvePixelBehindFg(
      {
        fg: [0, 0, 0, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [0, 0, 0, 0], op: 1, hasBgImg: false, hasBackdrop: false, hasComplex: false },
          { bg: [255, 255, 255, 1], op: 1, hasBgImg: true, hasBackdrop: false, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 0.5, hasBgImg: false, hasBackdrop: true, hasComplex: true },
          { bg: [0, 0, 0, 0], op: 1, hasBgImg: false, hasBackdrop: false, hasComplex: false },
        ],
      },
      [128, 128, 128]
    );
    assert.deepEqual(r15BackdropBlack, [64, 64, 64], "Translucent backdrop-filter container must composite black text against real backdrop");

    // Round 16 regressions (R16-A3-01): translucent ancestor overlay + leaf opacity must composite effOp accurately instead of fabricating opaque leaf bg or dropping op
    const r16Case1 = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1 },
          { bg: [255, 255, 255, 0.8], op: 1 },
          { bg: [0, 0, 0, 0], op: 0.25 },
        ],
      },
      [0, 0, 0]
    );
    assert.deepEqual(r16Case1, [64, 64, 64]);
    assert.equal(Number(wcagContrast(r16Case1, [0, 0, 0]).toFixed(2)), 2.03);

    const r16Case2 = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1 },
          { bg: [255, 255, 255, 0.8], op: 1 },
          { bg: [0, 0, 0, 0], op: 0.5 },
        ],
      },
      [128, 128, 128]
    );
    assert.deepEqual(r16Case2, [192, 192, 192]);
    assert.equal(Number(wcagContrast(r16Case2, [128, 128, 128]).toFixed(2)), 2.17);

    const r16Case3 = resolvePixelBehindFg(
      {
        fg: [255, 255, 255, 1],
        canvasBase: lightCanvas,
        chain: [
          { bg: [255, 255, 255, 1], op: 1 },
          { bg: [255, 255, 255, 0.8], op: 0.5 },
          { bg: [0, 0, 0, 0], op: 0.5 },
        ],
      },
      [0, 0, 0]
    );
    assert.deepEqual(r16Case3, [64, 64, 64]);
    // Round 17 regressions (R17-A3 LOW-1, MEDIUM-4): zero-height pseudo hit area & transition:none during pixel-behind capture
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 44 },
        { content: '""', position: "absolute", width: "48px", height: "auto", minWidth: "0px", minHeight: "0px", top: "auto", bottom: "auto", left: "auto", right: "auto" },
        null
      ),
      { width: 24, height: 44 },
      "Zero-height width:48px height:auto ::before pseudo must not expand effective hit target"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", width: "auto", height: "48px", minWidth: "0px", minHeight: "0px", top: "auto", bottom: "auto", left: "auto", right: "auto" },
        null
      ),
      { width: 24, height: 24 },
      "Zero-width width:auto height:48px ::before pseudo must not expand effective hit target"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 20, height: 20 },
        { content: '""', position: "absolute", left: "10px", right: "-24px" },
        null
      ),
      { width: 20, height: 20 },
      "Horizontal insets without vertical height/top+bottom must not expand effective hit target"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 44 },
        { content: '""', position: "absolute", display: "contents", width: "48px", height: "48px" },
        null
      ),
      { width: 24, height: 44 },
      "R18 #5: display: contents pseudo-element must not expand effective hit target"
    );

    const pbPngBuf = buildMiniPng(2, 2, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]));
    const pbEvents = [];
    const mockStyleMap = new Map();
    const mockEl = {
      dataset: {},
      style: {
        getPropertyValue: (k) => mockStyleMap.get(k)?.v || "",
        getPropertyPriority: (k) => mockStyleMap.get(k)?.p || "",
        setProperty: (k, v, p = "") => {
          pbEvents.push(["set", k, v, p]);
          mockStyleMap.set(k, { v, p });
        },
        removeProperty: (k) => {
          pbEvents.push(["rm", k]);
          mockStyleMap.delete(k);
        },
      },
      removeAttribute: (a) => pbEvents.push(["rmAttr", a]),
      get offsetHeight() {
        pbEvents.push(["flush"]);
        return 20;
      },
    };
    const mockPbPage = {
      evaluate: async (fn, arg) => {
        if (typeof arg === "string") {
          const origDoc = globalThis.document;
          globalThis.document = { querySelector: () => mockEl };
          try {
            return fn(arg);
          } finally {
            globalThis.document = origDoc;
          }
        }
        return [
          {
            token: "0",
            label: "a.btn",
            fg: [255, 255, 255, 1],
            isLarge: false,
            rect: { x: 0, y: 0, width: 2, height: 2 },
            chain: [{ bg: [0, 0, 0, 1], op: 1 }],
            canvasBase: [255, 255, 255],
          },
        ];
      },
      screenshot: async () => {
        pbEvents.push(["shot", mockStyleMap.get("transition")?.v, mockStyleMap.get("transition")?.p, mockStyleMap.get("color")?.v]);
        return pbPngBuf;
      },
    };
    const pbRes = await probePixelBehindElements(mockPbPage);
    assert.equal(pbRes.length, 1);
    assert.equal(pbRes[0].ratio, 21);
    const shotEvt = pbEvents.find((e) => e[0] === "shot");
    assert.deepEqual(shotEvt, ["shot", "none", "important", "transparent"]);
    const shotIdx = pbEvents.findIndex((e) => e[0] === "shot");
    assert.equal(
      pbEvents.some((e, i) => i < shotIdx && e[0] === "set" && e[1] === "-webkit-text-fill-color" && e[2] === "transparent" && e[3] === "important"),
      true,
      "R18 #14: pixel-behind probe must mask -webkit-text-fill-color before screenshot"
    );
    const rmColorIdx = pbEvents.findIndex((e, i) => i > shotIdx && e[0] === "rm" && e[1] === "color");
    const rmTextFillIdx = pbEvents.findIndex((e, i) => i > shotIdx && e[0] === "rm" && e[1] === "-webkit-text-fill-color");
    const restoreFlushIdx = pbEvents.findIndex((e, i) => i > rmColorIdx && e[0] === "flush");
    const rmTransIdx = pbEvents.findIndex((e, i) => i > shotIdx && e[0] === "rm" && e[1] === "transition");
    assert.ok(restoreFlushIdx > rmColorIdx && restoreFlushIdx > rmTextFillIdx && restoreFlushIdx < rmTransIdx, "must flush restored color/-webkit-text-fill-color/text-shadow before re-enabling CSS transition");
    assert.equal(mockStyleMap.has("transition"), false, "transition must be restored after pixel-behind probe");

    // Round 20 regression (R20-A3-M8): padded single-line badge (contentH <= lh*1.7) must pass while truly wrapped badge fails
    assert.equal(
      evaluateLayoutHealth({
        badges: [
          { tag: "span", text: "Active", w: 72, h: 42, contentH: 20, lineHeightPx: 20 },
        ],
      }).crushedBadges.length,
      0
    );
    assert.equal(
      evaluateLayoutHealth({
        badges: [
          { tag: "span", text: "Wrapped Long Badge Label", w: 60, h: 52, contentH: 40, lineHeightPx: 20 },
        ],
      }).crushedBadges.length,
      1
    );

    // Round 23 regressions (#41): blank positional, blank --routes segments, missing local --storybook/targets exit 2
    assert.throws(() => expandRouteTargets(["http://localhost:3100"], " , "), /non-empty/);
    const rtSelfPath = fileURLToPath(import.meta.url);
    for (const badRtCli of [
      ["   "],
      [""],
      ["http://127.0.0.1:9999", "--routes", " , "],
      ["--storybook", join(scratch, "missing-storybook.json")],
    ]) {
      assert.equal(spawnSync(process.execPath, [rtSelfPath, ...badRtCli], { encoding: "utf8" }).status, 2);
    }
    // Round 24 regressions (A4-M8 dir --axe & bad --executable-path, A4-H3 bad URL --wiring-before)
    assert.throws(() => findAxe(scratch), /not found or not a file/);
    for (const badR24Cli of [
      ["--axe", scratch, join(scratch, "missing.html")],
      ["--executable-path", join(scratch, "no-such-chrome"), "https://127.0.0.1:9999"],
      ["--wiring-before", "https://[::invalid", "--wiring-after", "https://example.com"],
    ]) {
      assert.equal(spawnSync(process.execPath, [rtSelfPath, ...badR24Cli], { encoding: "utf8" }).status, 2);
    }

    // Round 25 regressions (A3-M3..M4, A3-L3, A4-H1/M1/L1)
    assert.deepEqual(collectHtmlFiles(["data:text/html,<h1>Hi</h1>"]), ["data:text/html,<h1>Hi</h1>"]);
    for (const badR25Cli of [
      ["http://"],
      ["--cdp", "bogus"],
      ["--cdp", "70000"],
      [pathToFileURL(join(scratch, "nonexistent-dsaf-r25.html")).href],
      ["data:no-comma"],
      ["--storybook", "http://"],
    ]) {
      assert.equal(
        spawnSync(process.execPath, [rtSelfPath, ...badR25Cli], { encoding: "utf8" }).status,
        2,
        `R25 bad CLI arg must exit 2: ${badR25Cli.join(" ")}`
      );
    }
    const r25RtDummy = join(scratch, "r25-rt-dummy.html");
    const r25RtSecretOut = join(scratch, "r25-rt-secret.json");
    const r25RtOutSym = join(scratch, "r25-rt-out-sym.json");
    const r25RtSecretShot = join(scratch, "r25-rt-secret.png");
    const r25RtShotSym = join(scratch, "r25-rt-shot-sym.png");
    writeFileSync(r25RtDummy, "<!doctype html><html><body>ok</body></html>");
    writeFileSync(r25RtSecretOut, '{"untouched":true}');
    writeFileSync(r25RtSecretShot, "untouched");
    symlinkSync(r25RtSecretOut, r25RtOutSym);
    symlinkSync(r25RtSecretShot, r25RtShotSym);
    assert.equal(spawnSync(process.execPath, [rtSelfPath, r25RtDummy, "--out", r25RtOutSym], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [rtSelfPath, r25RtDummy, "--screenshot", r25RtShotSym], { encoding: "utf8" }).status, 2);
    assert.equal(readFileSync(r25RtSecretOut, "utf8"), '{"untouched":true}');
    assert.equal(readFileSync(r25RtSecretShot, "utf8"), "untouched");
    const r25RtCliSym = join(scratch, "r25-rt-cli-sym.mjs");
    symlinkSync(rtSelfPath, r25RtCliSym);
    assert.equal(spawnSync(process.execPath, [r25RtCliSym, "--help"], { encoding: "utf8" }).status, 0);

    // Round 26 regressions (A3-M10 *.html/ dir & broken *.html symlink handling)
    const r26HtmlDir = join(scratch, "r26-html-dir");
    mkdirSync(join(r26HtmlDir, "nested.html"), { recursive: true });
    symlinkSync(join(scratch, "does-not-exist-r26.html"), join(r26HtmlDir, "broken.html"));
    const r26OnlyBad = collectHtmlFiles([r26HtmlDir]);
    assert.deepEqual(r26OnlyBad, [], "R26 A3-M10: collectHtmlFiles must skip *.html/ dirs and broken *.html symlinks");
    assert.equal(
      spawnSync(process.execPath, [rtSelfPath, r26HtmlDir], { encoding: "utf8" }).status,
      2,
      "R26 A3-M10: dir with only *.html/ subdir and broken *.html symlink must exit 2 before Playwright"
    );
    const r26ValidHtml = join(r26HtmlDir, "valid.html");
    writeFileSync(r26ValidHtml, "<!doctype html><html><body>ok</body></html>\n");
    assert.deepEqual(collectHtmlFiles([r26HtmlDir]), [resolve(r26ValidHtml)]);

    // Round 27 Pure-Node regression (A3-L17 single-slash file:/ URL handling)
    const r27SingleSlash = ["file:", "/r27-example/page.html"].join("");
    const r27ExpectedFileUrl = ["file://", "/r27-example/page.html"].join("");
    assert.deepEqual(collectHtmlFiles([r27SingleSlash]), [r27ExpectedFileUrl], "R27 A3-L17: collectHtmlFiles must normalize single-slash file:/ URLs");
    assert.equal(toUrl(r27SingleSlash), r27ExpectedFileUrl, "R27 A3-L17: toUrl must normalize single-slash file:/ URLs");

    // Round 30 Pure-Node regression (A3-L9): computeEffectiveHitArea must account for padding/border on content-box pseudo-elements without double-counting border-box or inset pairs
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", width: "24px", height: "24px", padding: "10px", boxSizing: "content-box" },
        null,
        { position: "relative" }
      ),
      { width: 44, height: 44 },
      "R30 A3-L9: content-box 24x24 + 10px padding pseudo hit area must be 44x44"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", width: "24px", height: "24px", padding: "10px", boxSizing: "border-box" },
        null,
        { position: "relative" }
      ),
      { width: 24, height: 24 },
      "R30 A3-L9: border-box 24x24 + 10px padding must remain 24x24"
    );
    assert.deepEqual(
      computeEffectiveHitArea(
        { width: 24, height: 24 },
        { content: '""', position: "absolute", top: "-10px", right: "-10px", bottom: "-10px", left: "-10px", padding: "4px", boxSizing: "content-box" },
        null,
        { position: "relative" }
      ),
      { width: 44, height: 44 },
      "R30 A3-L9: inset:-10px + 4px padding must remain 44x44 without double-counting"
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
        if (!Object.prototype.hasOwnProperty.call(el.dataset, "dsafOrigSaved")) {
          el.dataset.dsafOrigSaved = "1";
          el.dataset.dsafOrigVis = el.style.getPropertyValue("visibility");
          el.dataset.dsafOrigVisPrio = el.style.getPropertyPriority("visibility");
          el.dataset.dsafOrigPe = el.style.getPropertyValue("pointer-events");
          el.dataset.dsafOrigPePrio = el.style.getPropertyPriority("pointer-events");
        }
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        hidden++;
      }
    }
    return hidden;
  }, OVERLAY_SELECTORS);
}

async function restoreConsentOverlays(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-dsaf-orig-saved]")) {
      if (el.dataset.dsafOrigVis) {
        el.style.setProperty("visibility", el.dataset.dsafOrigVis, el.dataset.dsafOrigVisPrio || "");
      } else {
        el.style.removeProperty("visibility");
      }
      if (el.dataset.dsafOrigPe) {
        el.style.setProperty("pointer-events", el.dataset.dsafOrigPe, el.dataset.dsafOrigPePrio || "");
      } else {
        el.style.removeProperty("pointer-events");
      }
      delete el.dataset.dsafOrigSaved;
      delete el.dataset.dsafOrigVis;
      delete el.dataset.dsafOrigVisPrio;
      delete el.dataset.dsafOrigPe;
      delete el.dataset.dsafOrigPePrio;
    }
  });
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
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(
      "Usage: node skill/scripts/audit-runtime.mjs <draft.html|draft-dir|url>... [--routes /,/about] [--out <file>] [--theme-toggle <sel>] [--live] [--cdp <port|url> --target <match>] [--extended-viewports] [--no-hide-overlays] [--skip-interactions] [--storybook <url|index.json>] [--max-stories <n>] [--screenshot <out.png> [--pins]] [--screenshot-diff <baseline.png> [--diff-threshold 1.0]] [--wiring-before a --wiring-after b] [--axe <path>] [--executable-path <path>] [--skip-shell-check] [--json] [--self-test] [--help]"
    );
    process.exit(0);
  }
  if (args.selfTest) process.exit(await runSelfTest());

  if (Boolean(args.wiringBefore) !== Boolean(args.wiringAfter)) {
    console.error("Error: --wiring-before and --wiring-after must both be provided together.");
    process.exit(2);
  }
  let targets;
  let urlsOrFiles;
  let axePath;
  const validateUrlOrDataTarget = (rawTarget, label) => {
    if (/^data:/i.test(rawTarget)) {
      if (!/^data:[^,]*,/i.test(rawTarget)) {
        throw new Error(`Invalid data: URL for ${label}: ${rawTarget}`);
      }
      return;
    }
    if (/^file:/i.test(rawTarget)) {
      let fsPath;
      try {
        const parsedFile = new URL(rawTarget);
        if (parsedFile.protocol !== "file:") throw new Error("not file");
        fsPath = fileURLToPath(parsedFile);
      } catch {
        throw new Error(`Invalid file:// URL for ${label}: ${rawTarget}`);
      }
      if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
        throw new Error(`${label} file:// target not found or not a file: ${fsPath}`);
      }
      return;
    }
    if (/^https?:/i.test(rawTarget)) {
      let parsed;
      try {
        parsed = new URL(rawTarget);
      } catch {
        throw new Error(`Invalid URL for ${label}: ${rawTarget}`);
      }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
        throw new Error(`URL for ${label} must include a valid hostname: ${rawTarget}`);
      }
      return;
    }
    throw new Error(`Unsupported URL scheme for ${label}: ${rawTarget}`);
  };
  try {
    if (args.outFile) assertWritableOutputFile(args.outFile, "--out");
    if (args.screenshot) assertWritableOutputFile(args.screenshot, "--screenshot");
    const validateWiringTarget = (rawTarget, label) => {
      if (!rawTarget) return;
      if (/^(?:https?|file|data):/i.test(rawTarget)) {
        validateUrlOrDataTarget(rawTarget, label);
        return;
      }
      const absW = resolve(rawTarget);
      if (!existsSync(absW) || !statSync(absW).isFile()) {
        throw new Error(`${label} file not found: ${absW}`);
      }
    };
    validateWiringTarget(args.wiringBefore, "Wiring baseline");
    validateWiringTarget(args.wiringAfter, "Wiring after");
    if (args.cdp) {
      if (/^\d+$/.test(args.cdp)) {
        const port = Number.parseInt(args.cdp, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid --cdp port '${args.cdp}'. Expected integer 1..65535.`);
        }
      } else {
        let cdpUrl;
        try {
          cdpUrl = new URL(args.cdp);
        } catch {
          throw new Error(`Invalid --cdp endpoint '${args.cdp}'. Expected port number or http(s)/ws(s) URL.`);
        }
        if (!["http:", "https:", "ws:", "wss:"].includes(cdpUrl.protocol) || !cdpUrl.hostname) {
          throw new Error(`Invalid --cdp endpoint '${args.cdp}'. Expected http(s):// or ws(s):// URL with hostname.`);
        }
      }
    }
    if (args.executablePath) {
      const absExe = resolve(args.executablePath);
      if (!existsSync(absExe) || !statSync(absExe).isFile()) {
        throw new Error(`Explicit --executable-path not found or not a file: ${absExe}`);
      }
    }
    if (args.screenshotDiff) {
      const absDiff = resolve(args.screenshotDiff);
      if (!existsSync(absDiff) || !statSync(absDiff).isFile()) {
        throw new Error(`Screenshot baseline file not found: ${absDiff}`);
      }
    }
    targets = expandRouteTargets([...args.targets], args.routes);
    for (const t of targets) {
      if (/^(?:https?|file|data):/i.test(t)) {
        validateUrlOrDataTarget(t, "Target");
        continue;
      }
      const absT = resolve(t);
      let tLst = null;
      try {
        tLst = lstatSync(absT);
      } catch (err) {
        if (err?.code === "ENOENT") throw new Error(`Target not found: ${absT}`);
        throw err;
      }
      if (tLst.isSymbolicLink() && !existsSync(absT)) {
        throw new Error(`Target is a broken symlink: ${absT}`);
      }
    }
    if (args.storybook) {
      if (/^https?:/i.test(args.storybook)) {
        let sbUrl;
        try {
          sbUrl = new URL(args.storybook);
        } catch {
          throw new Error(`Invalid --storybook URL: ${args.storybook}`);
        }
        if ((sbUrl.protocol !== "http:" && sbUrl.protocol !== "https:") || !sbUrl.hostname) {
          throw new Error(`--storybook URL must include a valid hostname: ${args.storybook}`);
        }
      } else {
        const absSb = resolve(args.storybook);
        if (!existsSync(absSb) || !statSync(absSb).isFile()) {
          throw new Error(`Storybook index file not found: ${absSb}`);
        }
        const sbUrls = await resolveStorybookUrls(args.storybook, args.maxStories);
        targets.push(...sbUrls);
      }
    }
    const isCdpAttachedArg = Boolean(args.cdp);
    if (!isCdpAttachedArg && targets.length === 0 && !args.storybook && !(args.wiringBefore && args.wiringAfter)) {
      throw new Error("specify target draft/url, --cdp <port>, or --self-test.");
    }
    urlsOrFiles = isCdpAttachedArg ? ["cdp://attached-target"] : collectHtmlFiles(targets);
    if (!isCdpAttachedArg && !args.storybook && urlsOrFiles.length === 0 && (!(args.wiringBefore && args.wiringAfter) || args.screenshotDiff || args.screenshot)) {
      throw new Error(`no HTML files or URLs found for target(s): ${targets.join(", ")}`);
    }
    const preSearchPaths = [...targets, args.wiringBefore, args.wiringAfter].filter(Boolean);
    axePath = findAxe(args.axePath, preSearchPaths);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (args.storybook && /^https?:\/\//i.test(args.storybook)) {
    try {
      const sbUrls = await resolveStorybookUrls(args.storybook, args.maxStories);
      targets.push(...sbUrls);
      urlsOrFiles = Boolean(args.cdp) ? ["cdp://attached-target"] : collectHtmlFiles(targets);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  const isCdpAttached = Boolean(args.cdp);
  if (!isCdpAttached && urlsOrFiles.length === 0 && (!(args.wiringBefore && args.wiringAfter) || args.screenshotDiff || args.screenshot)) {
    console.error(`Error: no HTML files or URLs found for target(s): ${targets.join(", ")}`);
    process.exit(2);
  }

  const searchPaths = [...targets, args.wiringBefore, args.wiringAfter].filter(Boolean);
  const { chromium } = loadPlaywright(searchPaths);
  const browser = isCdpAttached
    ? await chromium.connectOverCDP(normalizeCdpEndpoint(args.cdp))
    : await launchChromium(chromium, args.executablePath);
  const report = { schema: "dsaf-runtime/2", axeLoaded: Boolean(axePath), cdpAttached: isCdpAttached, files: [], wiringDiff: null, screenshotDiff: null, allPassed: true };
  let screenshotSaved = false;
  let screenshotDiffDone = false;

  try {
    const matrix = buildViewportMatrix(args.extendedViewports);

    for (const target of urlsOrFiles) {
      const pageErrors = [];
      const page = isCdpAttached
        ? await findCdpPage(browser, args.cdpTarget)
        : await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const onPageError = (err) => pageErrors.push(err.message || String(err));
      page.on("pageerror", onPageError);
      const cdpInitialDomTheme = isCdpAttached
        ? await page
            .evaluate(() => {
              const root = document.documentElement;
              const body = document.body;
              const meta = document.querySelector('meta[name="color-scheme"]');
              return {
                rootDataTheme: root.getAttribute("data-theme"),
                rootDataUxsTheme: root.getAttribute("data-uxs-theme"),
                rootDataMode: root.getAttribute("data-mode"),
                rootHasDark: root.classList.contains("dark"),
                rootHasLight: root.classList.contains("light"),
                rootStyleColorScheme: root.style.getPropertyValue("color-scheme"),
                rootStyleColorSchemePrio: root.style.getPropertyPriority("color-scheme"),
                bodyDataTheme: body ? body.getAttribute("data-theme") : null,
                bodyDataMode: body ? body.getAttribute("data-mode") : null,
                bodyHasDark: body ? body.classList.contains("dark") : false,
                bodyHasLight: body ? body.classList.contains("light") : false,
                bodyStyleColorScheme: body ? body.style.getPropertyValue("color-scheme") : "",
                bodyStyleColorSchemePrio: body ? body.style.getPropertyPriority("color-scheme") : "",
                hasMeta: Boolean(meta),
                metaContent: meta ? meta.getAttribute("content") : null,
              };
            })
            .catch(() => null)
        : null;
      try {
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
            : /^data:/i.test(target)
            ? (target.length > 64 ? `${target.slice(0, 61)}...` : target)
            : /^(?:https?|file):\/\//i.test(target)
            ? target.replace(/^file:\/\/\/.*\//, "")
            : basename(target.split("?")[0]),
          pageErrors,
          hiddenOverlaysCount,
          webVitals: await captureWebVitals(page),
          computedVars: await captureComputedRootVars(page),
          shell: null,
          interactions: null,
          screenshot: null,
          reducedMotion: null,
          pixelBehind: [],
          checks: [],
          passed: true,
        };

        const isIndexHtml = !/^data:/i.test(target) && basename(target.split("?")[0]) === "index.html";
        if (!args.skipShellCheck && !isIndexHtml) {
          fileRes.shell = await auditShellContract(page);
          if (fileRes.shell.failures.length > 0) {
            fileRes.passed = false;
            report.allPassed = false;
          }
        }

        if (args.live && !args.skipInteractions && !fileRes.shell?.present && !isCdpAttached) {
          fileRes.interactions = await auditLiveInteractions(page, args.themeToggle);
          if (fileRes.interactions.failures.length > 0) {
            fileRes.passed = false;
            report.allPassed = false;
          }
        }

        if (args.screenshot && !screenshotSaved) {
          if (!isCdpAttached) await page.setViewportSize({ width: 1440, height: 900 });
          const pinsBtn = args.pins ? await page.$("#uxs-pins-btn") : null;
          let toggledPins = false;
          if (pinsBtn) {
            const curPins = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
            if (curPins !== "on") {
              await pinsBtn.click();
              await page.waitForTimeout(150);
              toggledPins = true;
            }
          }
          try {
            const outShot = resolve(args.screenshot);
            mkdirSync(dirname(outShot), { recursive: true });
            await page.screenshot({ path: outShot, fullPage: false });
            fileRes.screenshot = outShot;
            screenshotSaved = true;
          } finally {
            if (toggledPins && pinsBtn) await pinsBtn.click().catch(() => {});
          }
        }

        if (args.screenshotDiff && !screenshotDiffDone) {
          if (!isCdpAttached) await page.setViewportSize({ width: 1440, height: 900 });
          const pinsBtn = args.pins ? await page.$("#uxs-pins-btn") : null;
          let toggledPins = false;
          if (pinsBtn) {
            const curPins = await page.evaluate(() => document.documentElement.getAttribute("data-uxs-pins"));
            if (curPins !== "on") {
              await pinsBtn.click();
              await page.waitForTimeout(150);
              toggledPins = true;
            }
          }
          let curBuf;
          try {
            curBuf = await page.screenshot({ fullPage: false });
          } finally {
            if (toggledPins && pinsBtn) await pinsBtn.click().catch(() => {});
          }
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

        let observedThemeMech = null;
        for (const m of matrix) {
          if (!isCdpAttached) {
            await page.setViewportSize({ width: m.width, height: m.height });
          }
          await page.emulateMedia({ colorScheme: m.theme });
          if ((args.live || isCdpAttached) && !args.noHideOverlays) {
            fileRes.hiddenOverlaysCount += await hideConsentOverlays(page);
          }
          const snapDomThemeAttrs = () =>
            page.evaluate(() => {
              const r = document.documentElement;
              const b = document.body;
              return {
                rDark: r.classList.contains("dark"),
                rLight: r.classList.contains("light"),
                bDark: Boolean(b?.classList.contains("dark")),
                bLight: Boolean(b?.classList.contains("light")),
                rDT: r.getAttribute("data-theme"),
                rDU: r.getAttribute("data-uxs-theme"),
                rDM: r.getAttribute("data-mode"),
                bDT: b?.getAttribute("data-theme") ?? null,
                bDU: b?.getAttribute("data-uxs-theme") ?? null,
                bDM: b?.getAttribute("data-mode") ?? null,
              };
            });
          const inferObservedThemeMech = (prevDom, nextDom) => {
            if (!prevDom || !nextDom) return null;
            if (prevDom.rDark !== nextDom.rDark) {
              return prevDom.rLight === nextDom.rLight && !prevDom.rLight && !nextDom.rLight
                ? { target: "root", kind: "class-dark-only" }
                : { target: "root", kind: "class-pair" };
            }
            if (prevDom.bDark !== nextDom.bDark) {
              return prevDom.bLight === nextDom.bLight && !prevDom.bLight && !nextDom.bLight
                ? { target: "body", kind: "class-dark-only" }
                : { target: "body", kind: "class-pair" };
            }
            if (prevDom.rDU !== nextDom.rDU) return { target: "root", kind: "attr", attr: "data-uxs-theme" };
            if (prevDom.rDT !== nextDom.rDT) return { target: "root", kind: "attr", attr: "data-theme" };
            if (prevDom.rDM !== nextDom.rDM) return { target: "root", kind: "attr", attr: "data-mode" };
            if (prevDom.bDU !== nextDom.bDU) return { target: "body", kind: "attr", attr: "data-uxs-theme" };
            if (prevDom.bDT !== nextDom.bDT) return { target: "body", kind: "attr", attr: "data-theme" };
            if (prevDom.bDM !== nextDom.bDM) return { target: "body", kind: "attr", attr: "data-mode" };
            return null;
          };
          const applyDomThemeFallback = async (theme) => {
            await page.evaluate(
              ({ th, mech }) => {
                const root = document.documentElement;
                const body = document.body;
                let applied = false;
                if (mech) {
                  const el = mech.target === "body" && body ? body : root;
                  if (mech.kind === "class-dark-only") {
                    el.classList.toggle("dark", th === "dark");
                    applied = true;
                  } else if (mech.kind === "class-pair") {
                    el.classList.toggle("dark", th === "dark");
                    el.classList.toggle("light", th === "light");
                    applied = true;
                  } else if (mech.kind === "attr" && mech.attr) {
                    el.setAttribute(mech.attr, th);
                    applied = true;
                  }
                }
                if (!applied) {
                  if (root.classList.contains("dark") || root.classList.contains("light")) {
                    root.classList.toggle("dark", th === "dark");
                    if (root.classList.contains("light") || th === "light") root.classList.toggle("light", th === "light");
                    applied = true;
                  }
                  if (body && (body.classList.contains("dark") || body.classList.contains("light"))) {
                    body.classList.toggle("dark", th === "dark");
                    if (body.classList.contains("light") || th === "light") body.classList.toggle("light", th === "light");
                    applied = true;
                  }
                  for (const [el, attrs] of [
                    [root, ["data-theme", "data-uxs-theme", "data-mode"]],
                    [body, ["data-theme", "data-uxs-theme", "data-mode"]],
                  ]) {
                    if (!el) continue;
                    for (const attr of attrs) {
                      if (el.hasAttribute(attr)) {
                        el.setAttribute(attr, th);
                        applied = true;
                      }
                    }
                  }
                }
                if (!applied) {
                  const seenSheets = new Set();
                  const inspectRules = (rules, parentSel = "") => {
                    for (const rule of rules || []) {
                      if (applied) return;
                      if (rule.styleSheet && !seenSheets.has(rule.styleSheet)) {
                        seenSheets.add(rule.styleSheet);
                        try {
                          inspectRules(rule.styleSheet.cssRules, "");
                        } catch {}
                        if (applied) return;
                      }
                      if (rule.selectorText) {
                        const sel = rule.selectorText;
                        if (/\[data-uxs-theme\s*(?:=[^\]]+)?\]/i.test(sel)) {
                          root.setAttribute("data-uxs-theme", th);
                          applied = true;
                          return;
                        }
                        if (/\[data-theme\s*(?:=[^\]]+)?\]/i.test(sel)) {
                          root.setAttribute("data-theme", th);
                          applied = true;
                          return;
                        }
                        if (/\[data-mode\s*(?:=[^\]]+)?\]/i.test(sel)) {
                          root.setAttribute("data-mode", th);
                          applied = true;
                          return;
                        }
                        if (
                          /(?:^|[\s,>+~(])body\.dark\b/i.test(sel) ||
                          (/\bbody\b/i.test(parentSel) && /(?:^|[\s,>+~(])&\.dark\b/i.test(sel))
                        ) {
                          if (body) {
                            body.classList.toggle("dark", th === "dark");
                            applied = true;
                            return;
                          }
                        }
                        if (/(?:^|[\s,>+~(])(?:html|:root|&)?\.dark\b/i.test(sel)) {
                          root.classList.toggle("dark", th === "dark");
                          applied = true;
                          return;
                        }
                      }
                      if (rule.cssRules) inspectRules(rule.cssRules, rule.selectorText || parentSel);
                    }
                  };
                  for (const ss of Array.from(document.styleSheets || [])) {
                    if (applied) break;
                    if (seenSheets.has(ss)) continue;
                    seenSheets.add(ss);
                    try {
                      inspectRules(ss.cssRules, "");
                    } catch {}
                  }
                }
              },
              { th: theme, mech: observedThemeMech }
            );
          };
          const safeThemeClick = async (btn) => {
            const clickOnce = async () => {
              const beforeDom = await snapDomThemeAttrs().catch(() => null);
              await btn.click({ timeout: 4000 });
              await page.waitForTimeout(40);
              const afterDom = await snapDomThemeAttrs().catch(() => null);
              const inferred = inferObservedThemeMech(beforeDom, afterDom);
              if (inferred) observedThemeMech = inferred;
              return true;
            };
            try {
              return await clickOnce();
            } catch {
              if (!args.noHideOverlays) {
                fileRes.hiddenOverlaysCount += await hideConsentOverlays(page);
                try {
                  return await clickOnce();
                } catch {
                  return false;
                }
              }
              return false;
            }
          };
          const findVisibleEl = async (sel) => {
            for (const h of await page.$$(sel)) {
              if (await h.isVisible().catch(() => false)) return h;
            }
            return null;
          };
          if (args.themeToggle) {
            const curTheme = await page.evaluate(() => {
              const rootEl = document.documentElement;
              const bodyEl = document.body;
              const explicitDark =
                rootEl.classList.contains("dark") ||
                Boolean(bodyEl?.classList.contains("dark")) ||
                rootEl.getAttribute("data-theme") === "dark" ||
                rootEl.getAttribute("data-uxs-theme") === "dark" ||
                rootEl.getAttribute("data-mode") === "dark" ||
                bodyEl?.getAttribute("data-theme") === "dark" ||
                bodyEl?.getAttribute("data-uxs-theme") === "dark" ||
                bodyEl?.getAttribute("data-mode") === "dark";
              if (explicitDark) return "dark";
              const explicitLight =
                rootEl.classList.contains("light") ||
                Boolean(bodyEl?.classList.contains("light")) ||
                rootEl.getAttribute("data-theme") === "light" ||
                rootEl.getAttribute("data-uxs-theme") === "light" ||
                rootEl.getAttribute("data-mode") === "light" ||
                bodyEl?.getAttribute("data-theme") === "light" ||
                bodyEl?.getAttribute("data-uxs-theme") === "light" ||
                bodyEl?.getAttribute("data-mode") === "light";
              if (explicitLight) return "light";
              const parseBg = (bgStr) => {
                const m = String(bgStr || "").trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
                if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
                if (!bgStr || String(bgStr).trim().toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
                const c = document.createElement("canvas");
                c.width = 1;
                c.height = 1;
                const ctx = c.getContext("2d", { willReadFrequently: true });
                ctx.fillStyle = "rgba(0,0,0,0)";
                ctx.fillStyle = bgStr;
                ctx.fillRect(0, 0, 1, 1);
                const d = ctx.getImageData(0, 0, 1, 1).data;
                return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
              };
              const over = (fg, bg) => {
                const sa = Math.max(0, Math.min(1, fg.a));
                const da = Math.max(0, Math.min(1, bg.a));
                const oa = sa + da * (1 - sa);
                if (oa <= 1e-6) return { r: 0, g: 0, b: 0, a: 0 };
                return {
                  r: (fg.r * sa + bg.r * da * (1 - sa)) / oa,
                  g: (fg.g * sa + bg.g * da * (1 - sa)) / oa,
                  b: (fg.b * sa + bg.b * da * (1 - sa)) / oa,
                  a: oa,
                };
              };
              const lum = ({ r, g, b }) => {
                const f = (v) => {
                  const s = v / 255;
                  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                };
                return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
              };
              let effBg = parseBg(getComputedStyle(rootEl).backgroundColor);
              if (bodyEl) effBg = over(parseBg(getComputedStyle(bodyEl).backgroundColor), effBg);
              if (effBg.a < 0.5) {
                const SKIP_SHELL_TAGS = new Set([
                  "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT",
                  "BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SVG", "IMG", "DIALOG", "NAV", "ASIDE",
                ]);
                const minW = Math.min(window.innerWidth * 0.4, 200);
                let bestShellBg = null;
                let bestArea = 0;
                const candidates = document.querySelectorAll("main, #__next, #root, #app, body > *, body > * > *, body > * > * > *");
                for (let ci = 0; ci < candidates.length && ci < 80; ci++) {
                  const cand = candidates[ci];
                  if (SKIP_SHELL_TAGS.has(cand.tagName)) continue;
                  const ccs = getComputedStyle(cand);
                  if (ccs.display === "none" || ccs.visibility === "hidden" || parseFloat(ccs.opacity) === 0) continue;
                  const cr = cand.getBoundingClientRect();
                  if (cr.width < minW || cr.height < 32) continue;
                  const cBg = parseBg(ccs.backgroundColor);
                  if (cBg.a < 0.5) continue;
                  const area = cr.width * cr.height;
                  if (area > bestArea) {
                    bestArea = area;
                    bestShellBg = cBg;
                  }
                }
                if (bestShellBg) effBg = over(bestShellBg, effBg);
              }
              if (effBg.a >= 0.5) {
                return lum(effBg) < 0.25 ? "dark" : "light";
              }
              let inkEl = null;
              for (const cand of document.querySelectorAll("h1, h2, p")) {
                const ics = getComputedStyle(cand);
                if (ics.display !== "none" && ics.visibility !== "hidden" && parseFloat(ics.opacity) !== 0 && (cand.textContent || "").trim()) {
                  inkEl = cand;
                  break;
                }
              }
              inkEl = inkEl || bodyEl || rootEl;
              if (inkEl) {
                const textCol = parseBg(getComputedStyle(inkEl).color);
                if (textCol && textCol.a >= 0.5) {
                  if (lum(textCol) < 0.25) return "light";
                  if (lum(textCol) > 0.65) return "dark";
                }
              }
              const rootCs = (getComputedStyle(rootEl).colorScheme || "").toLowerCase();
              const bodyCs = (getComputedStyle(bodyEl || rootEl).colorScheme || "").toLowerCase();
              const effCs = bodyCs && bodyCs !== "normal" ? bodyCs : rootCs;
              const hasLight = effCs.includes("light");
              const hasDark = effCs.includes("dark");
              if (hasDark && !hasLight) return "dark";
              if (hasDark && hasLight && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
              return "light";
            });
            if (curTheme !== m.theme) {
              const tog = await findVisibleEl(args.themeToggle);
              const clicked = tog ? await safeThemeClick(tog) : false;
              if (!clicked) await applyDomThemeFallback(m.theme);
            }
          } else {
            const themeBtn = await findVisibleEl(`[data-ux-shell-toolbar] [data-theme="${m.theme}"], button[data-theme="${m.theme}"]`);
            if (themeBtn) {
              const clicked = await safeThemeClick(themeBtn);
              if (!clicked) await applyDomThemeFallback(m.theme);
            } else if (args.live || isCdpAttached) {
              await applyDomThemeFallback(m.theme);
            }
          }
          await page.waitForTimeout(150);

          const geom = await auditGeometryApcaInventoryAndSlop(page, m.isMobile);
          const hoverFails = m.isMobile ? [] : await auditFilledButtonHoverContrast(page);
          let axeViolations = [];
          if (axePath) {
            try {
              if (!(await page.evaluate(() => Boolean(window.axe)))) {
                await page.addScriptTag({ path: axePath });
              }
              axeViolations = await page.evaluate(async () => {
                const res = await window.axe.run(
                  { include: [["html"]], exclude: [["nextjs-portal"], ["vite-error-overlay"], ["[data-nextjs-toast]"], ["[data-nextjs-dialog-overlay]"], ["#__next-build-indicator"]] },
                  { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }
                );
                return res.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length }));
              });
            } catch (axeErr) {
              axeViolations = [{ id: "axe-execution-error", impact: "serious", count: 1, detail: axeErr?.message || String(axeErr) }];
            }
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
            const parseMaxSec = (val) =>
              Math.max(
                0,
                ...(val || "0s").split(",").map((raw) => {
                  const s = raw.trim().toLowerCase();
                  const n = parseFloat(s) || 0;
                  return s.endsWith("ms") ? n / 1000 : n;
                })
              );
            const unguarded = [];
            for (const el of document.querySelectorAll("*")) {
              const cs = getComputedStyle(el);
              const dur = Math.max(parseMaxSec(cs.transitionDuration), parseMaxSec(cs.animationDuration));
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
        report.files.push(fileRes);
      } finally {
        page.off("pageerror", onPageError);
        if (isCdpAttached) {
          if (cdpInitialDomTheme) {
            await page
              .evaluate((snap) => {
                const root = document.documentElement;
                const body = document.body;
                const setOrRemove = (el, attr, val) => {
                  if (!el) return;
                  if (val === null) el.removeAttribute(attr);
                  else el.setAttribute(attr, val);
                };
                setOrRemove(root, "data-theme", snap.rootDataTheme);
                setOrRemove(root, "data-uxs-theme", snap.rootDataUxsTheme);
                setOrRemove(root, "data-mode", snap.rootDataMode);
                root.classList.toggle("dark", snap.rootHasDark);
                root.classList.toggle("light", snap.rootHasLight);
                if (snap.rootStyleColorScheme) {
                  root.style.setProperty("color-scheme", snap.rootStyleColorScheme, snap.rootStyleColorSchemePrio || "");
                } else {
                  root.style.removeProperty("color-scheme");
                }
                if (body) {
                  setOrRemove(body, "data-theme", snap.bodyDataTheme);
                  setOrRemove(body, "data-mode", snap.bodyDataMode);
                  body.classList.toggle("dark", snap.bodyHasDark);
                  body.classList.toggle("light", snap.bodyHasLight);
                  if (snap.bodyStyleColorScheme) {
                    body.style.setProperty("color-scheme", snap.bodyStyleColorScheme, snap.bodyStyleColorSchemePrio || "");
                  } else {
                    body.style.removeProperty("color-scheme");
                  }
                }
                const meta = document.querySelector('meta[name="color-scheme"]');
                if (meta && snap.hasMeta) {
                  if (snap.metaContent === null) meta.removeAttribute("content");
                  else meta.setAttribute("content", snap.metaContent);
                }
              }, cdpInitialDomTheme)
              .catch(() => {});
          }
          await restoreConsentOverlays(page).catch(() => {});
          await page.emulateMedia({ colorScheme: null, reducedMotion: null }).catch(() => {});
        } else {
          await page.close().catch(() => {});
        }
      }
    }

    if (args.wiringBefore && args.wiringAfter) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        const b = await captureWiringInventory(page, args.wiringBefore);
        const a = await captureWiringInventory(page, args.wiringAfter);
        report.wiringDiff = diffWiring(b, a);
        if (!report.wiringDiff.passed) report.allPassed = false;
      } finally {
        await page.close();
      }
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
      if (f.interactions) console.log(`  interactions: tabs=${f.interactions.tabsTested} details=${f.interactions.disclosuresTested} theme=${f.interactions.themeToggleTested} -> ${f.interactions.failures.length === 0 ? "PASS" : "FAIL " + JSON.stringify(f.interactions.failures)}`);
      if (f.screenshot) console.log(`  screenshot: ${f.screenshot}`);
      if (f.reducedMotion) console.log(`  reducedMotion: mediaMatches=${f.reducedMotion.mediaMatches} unguarded=${f.reducedMotion.unguardedAnimatedCount}`);
      for (const pb of f.pixelBehind) {
        console.log(`  pixelBehind ${pb.label}: ${pb.ratio}:1 (min ${pb.threshold}:1, Lc=${pb.apcaLc}) ${pb.pass ? "PASS" : "FAIL"}`);
      }
      for (const c of f.checks) {
        console.log(
          `  [${c.state}] ${c.passed ? "PASS" : "FAIL"} | overflow=${c.docOverflow}/${c.bodyOverflow} child=${c.childOverflows.length} small44=${c.smallTargets.length} clip=${c.clippedTargets.length}${c.clippedTargets.length ? `(${c.clippedTargets.map((t) => t.text).join(",")})` : ""} hdrBloat=${c.headerBloat ? c.headerBloat.height + "px" : 0} badges=${c.crushedBadges?.length || 0} clipTbl=${c.clippedTables?.length || 0} borders=${c.borderFails.length} hover=${c.hoverFails.length} covered=${c.coveredText.length} leaks=${c.focusLeaks.length} tab=${c.keyboardMap.tabbableCount}(+${c.keyboardMap.positiveTabindexCount}/un=${c.keyboardMap.unnamedInteractiveCount}) slop=${c.badTransitions.length + c.hiddenAtRest.length + c.inlineHeightMismatches.length} axe=${c.axeViolations.length}${c.axeViolations.length ? `(${c.axeViolations.map((v) => v.id).join(",")})` : ""} rtl=${c.rtlChecks?.passed === false ? `FAIL(${[c.rtlChecks.missingDirRtl ? "missing dir=rtl" : "", c.rtlChecks.arabicLetterSpacingViolations ? `letterSpacing=${c.rtlChecks.arabicLetterSpacingViolations}` : ""].filter(Boolean).join(",")})` : "ok"} | apcaBodyMin=${c.apca.minBodyLc ?? "n/a"} btnSigs=${c.componentInventory.buttons.distinctSignatures}`
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

if (isDirectCliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error("ERROR:", err.message || err);
    process.exit(1);
  });
}

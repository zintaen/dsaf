#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Shared CI Formatter (SARIF 2.1.0 & GitHub Annotations) &
 * 3-Tier Gate / Inline Waiver Engine (`Floor` / `Reflex` / `Finish`).
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const CI_REPORT_VERSION = "0.9.3";

export const RULE_CATALOG = {
  // Floor tier — never waivable, severity: error
  "dsaf/dtcg-circular-ref": {
    id: "dsaf/dtcg-circular-ref",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Circular DTCG token reference detected.",
    help: "Break alias/$ref cycles in your W3C DTCG token graph.",
  },
  "dsaf/dtcg-unresolved-ref": {
    id: "dsaf/dtcg-unresolved-ref",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Unresolved DTCG token alias or $ref.",
    help: "Point token aliases to an existing token path in the token set.",
  },
  "dsaf/dtcg-contrast-fail": {
    id: "dsaf/dtcg-contrast-fail",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Semantic text/surface token pair fails WCAG 2.2 AA (4.5:1).",
    help: "Adjust light/dark semantic token contrast to >= 4.5:1 (APCA Lc >= 60).",
  },
  "dsaf/no-transition-all": {
    id: "dsaf/no-transition-all",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Disallowed transition: all / transition-all.",
    help: "Transition explicit GPU-composited properties (opacity, transform, colors) instead of all.",
  },
  "dsaf/no-layout-transition": {
    id: "dsaf/no-layout-transition",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Animating layout geometry property (width, height, top, left).",
    help: "Animate transform or opacity instead of layout-reflow properties.",
  },
  "dsaf/no-100vw": {
    id: "dsaf/no-100vw",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Horizontal overflow risk from 100vw width.",
    help: "Use width: 100% (or w-full) with overflow-x: clip on html, body.",
  },
  "dsaf/no-outline-none-naked": {
    id: "dsaf/no-outline-none-naked",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Focus outline removed without visible replacement ring.",
    help: "Provide :focus-visible outline (>= 3:1 contrast) or explicit focus ring.",
  },
  "dsaf/no-autoplay-unmuted": {
    id: "dsaf/no-autoplay-unmuted",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Autoplaying <video> missing muted attribute.",
    help: "Add muted (and playsinline) on autoplaying media, or remove autoplay.",
  },
  "dsaf/no-hidden-at-rest": {
    id: "dsaf/no-hidden-at-rest",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Reveal container ships invisible (opacity: 0) at rest.",
    help: "Render visible by default and gate reveal hiding behind .js or @starting-style.",
  },
  "dsaf/floor-waiver-rejected": {
    id: "dsaf/floor-waiver-rejected",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Attempted inline waiver on a non-waivable Floor rule.",
    help: "Fix the Floor defect directly; Floor rules cannot be suppressed via dsaf-ignore.",
  },
  "dsaf/runtime-check-failed": {
    id: "dsaf/runtime-check-failed",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Live runtime accessibility, layout, or contrast check failed.",
    help: "Inspect Playwright runtime output (APCA/WCAG, overflow, hit areas, axe-core) and fix Floor failures.",
  },
  "dsaf/regression-detected": {
    id: "dsaf/regression-detected",
    tier: "floor",
    defaultLevel: "error",
    shortDescription: "Audit scorecard regressed against baseline.",
    help: "Resolve scorecard or floor regressions reported in audit-diff before merging.",
  },

  // Reflex tier — waivable on the record with concrete reason >= 12 chars
  "dsaf/hardcoded-color": {
    id: "dsaf/hardcoded-color",
    tier: "reflex",
    defaultLevel: "warning",
    shortDescription: "Hardcoded color literal outside token definitions.",
    help: "Bind to a semantic CSS var() / DTCG token, or waive reflex with dsaf-ignore.",
  },
  "dsaf/important-override": {
    id: "dsaf/important-override",
    tier: "reflex",
    defaultLevel: "warning",
    shortDescription: "!important specificity override detected.",
    help: "Resolve specificity via layers/tokens or document concrete waiver reason.",
  },
  "dsaf/off-grid-spacing": {
    id: "dsaf/off-grid-spacing",
    tier: "reflex",
    defaultLevel: "warning",
    shortDescription: "Off-grid px spacing outside 4px/8px rhythm.",
    help: "Use spacing scale tokens or add explicit reflex optical-nudge reason.",
  },
  "dsaf/tailwind-arbitrary": {
    id: "dsaf/tailwind-arbitrary",
    tier: "reflex",
    defaultLevel: "warning",
    shortDescription: "Tailwind arbitrary hex/px bracket utility.",
    help: "Promote repeated values into @theme tokens instead of arbitrary brackets.",
  },
  "dsaf/waiver-reason-weak": {
    id: "dsaf/waiver-reason-weak",
    tier: "reflex",
    defaultLevel: "warning",
    shortDescription: "dsaf-ignore waiver missing concrete justification (>= 12 chars).",
    help: "Add `-- <project-specific rationale>` (at least 12 characters, non-boilerplate).",
  },

  // Finish tier — non-blocking advisories & hygiene
  "dsaf/semantic-orphan-var": {
    id: "dsaf/semantic-orphan-var",
    tier: "finish",
    defaultLevel: "note",
    shortDescription: "Unused semantic CSS custom property.",
    help: "Consume the token in components or prune dead semantic tokens.",
  },
  "dsaf/unused-ignore": {
    id: "dsaf/unused-ignore",
    tier: "finish",
    defaultLevel: "warning",
    shortDescription: "Stale dsaf-ignore comment did not match any finding.",
    help: "Remove obsolete dsaf-ignore directives to keep waivers honest.",
  },
};

const BOILERPLATE_REASON_RE =
  /^(?:ok|okay|fine|ignore|ignored|skip|temp|temporary|todo|fixme|later|needed|legacy|hack|workaround|test|testing|wip|na|n\/a|none|unknown|misc|other|placeholder|because|reason|fix|disable|disabled|suppressed|waive|waived|lgtm|required|intentional|exception|needed\s+here|temporary\s+fix|fix\s*later|will\s+fix\s+later)\.?$/i;

function isTsNonNullBang(s, idx, minStart = 0) {
  let p = idx - 1;
  while (p >= minStart && (s[p] === " " || s[p] === "\t")) p--;
  if (p < minStart || s[p] !== "!") return false;
  if (p > minStart && s[p - 1] === "!") return false;
  let q = p - 1;
  while (q >= minStart && (s[q] === " " || s[q] === "\t")) q--;
  if (q < minStart) return false;
  const ch = s[q];
  if (ch === "]") return true;
  if (ch === ")") {
    const BT = "`";
    const rawWin = Math.max(minStart, q - 8192);
    const winNl = rawWin > minStart ? s.indexOf("\n", rawWin) : -1;
    const scanStart = rawWin === minStart ? minStart : winNl !== -1 && winNl < q ? winNl + 1 : rawWin;
    const openParens = [];
    let matchedOpen = -1;
    let qF = null;
    const tplBraces = [];
    let braceDepthF = 0;
    let lastSigF = "";
    let lastPoppedCtrl = false;
    let lastBangIsNonNull = false;
    const isCtrlWord = (pos) => {
      let kwEnd = pos - 1;
      while (kwEnd >= scanStart && /\s/.test(s[kwEnd])) kwEnd--;
      if (kwEnd >= scanStart && /[A-Za-z0-9_$]/.test(s[kwEnd])) {
        let kwStart = kwEnd;
        while (kwStart > scanStart && /[A-Za-z0-9_$]/.test(s[kwStart - 1])) kwStart--;
        const kw = s.slice(kwStart, kwEnd + 1);
        return /^(?:if|while|for|with|catch|switch)$/.test(kw);
      }
      return false;
    };
    const evalBangAt = (bangIdx) => {
      let qB = bangIdx - 1;
      while (qB >= scanStart && (s[qB] === " " || s[qB] === "\t" || s[qB] === "\r")) qB--;
      if (qB < scanStart) return false;
      const pc = s[qB];
      if (pc === ")") return !lastPoppedCtrl;
      if (pc === "]") return true;
      if (!/[A-Za-z0-9_$]/.test(pc)) return false;
      let ks = qB;
      while (ks > scanStart && /[A-Za-z0-9_$]/.test(s[ks - 1])) ks--;
      const w = s.slice(ks, qB + 1);
      let bKs = ks - 1;
      while (bKs >= scanStart && (s[bKs] === " " || s[bKs] === "\t" || s[bKs] === "\r")) bKs--;
      const isMem = bKs >= scanStart && s[bKs] === ".";
      return isMem || !/^(?:return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do)$/.test(w);
    };
    const skipFwdRegex = (rxStart) => {
      const nextC = s[rxStart + 1] || "";
      if (s[rxStart] !== "/" || nextC === "/" || nextC === "*" || nextC === ">") return -1;
      if (rxStart > scanStart && s[rxStart - 1] === "<") return -1;
      const isPost =
        (lastSigF === "+" || lastSigF === "-") &&
        /(?:\+\+|--)\s*$/.test(s.slice(Math.max(scanStart, rxStart - 16), rxStart));
      if (isPost) return -1;
      const okS =
        lastSigF === "" ||
        lastSigF === "control)" ||
        (lastSigF === "!" && !lastBangIsNonNull) ||
        /[=([,:;&|?{}~+\-*%^]/.test(lastSigF) ||
        /(?:^|[^\w$.])(?:return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do)\s*$|=>\s*$/.test(
          s.slice(Math.max(scanStart, rxStart - 24), rxStart)
        );
      if (!okS) return -1;
      let rj = rxStart + 1;
      let inCls = false;
      let okClose = false;
      while (rj <= q && s[rj] !== "\n") {
        const rc = s[rj];
        if (rc === "\\" && rj + 1 <= q && s[rj + 1] !== "\n") {
          rj += 2;
          continue;
        }
        if (rc === "[") inCls = true;
        else if (rc === "]" && inCls) inCls = false;
        else if (!inCls && /^<\/(?:[A-Za-z][A-Za-z0-9_.:-]*\s*>|>)/.test(s.slice(rj, rj + 48))) return -1;
        else if (rc === "/" && !inCls) {
          if (s[rj + 1] === "*" || s[rj + 1] === "/") return -1;
          okClose = true;
          rj++;
          const seenFlags = new Set();
          while (rj <= q && /[A-Za-z0-9_$]/.test(s[rj])) {
            if (!/[dgimsuvy]/.test(s[rj]) || seenFlags.has(s[rj])) return -1;
            seenFlags.add(s[rj]);
            rj++;
          }
          if (rj <= q && (/["'`>]/.test(s[rj]) || s.startsWith("/>", rj))) return -1;
          break;
        }
        rj++;
      }
      return okClose ? rj : -1;
    };
    let fk = scanStart;
    while (fk <= q) {
      const fc = s[fk];
      if (qF) {
        if (fc === "\\" && fk + 1 <= q) {
          fk += 2;
          continue;
        }
        if (qF === BT && fc === "$" && fk + 1 <= q && s[fk + 1] === "{") {
          tplBraces.push(braceDepthF);
          braceDepthF++;
          qF = null;
          lastSigF = "{";
          fk += 2;
          continue;
        }
        if (fc === qF || (qF !== BT && fc === "\n")) {
          lastSigF = qF;
          qF = null;
        }
        fk++;
        continue;
      }
      if (fc === "/" && fk + 1 <= q && s[fk + 1] === "/") {
        const eol = s.indexOf("\n", fk + 2);
        fk = eol === -1 || eol > q ? q + 1 : eol + 1;
        continue;
      }
      if (fc === "/" && fk + 1 <= q && s[fk + 1] === "*") {
        const ce = s.indexOf("*/", fk + 2);
        fk = ce === -1 || ce + 2 > q ? q + 1 : ce + 2;
        continue;
      }
      const rxEnd = skipFwdRegex(fk);
      if (rxEnd !== -1 && rxEnd <= q + 1) {
        lastSigF = "/";
        fk = rxEnd;
        continue;
      }
      if (fc === '"' || fc === "'" || fc === BT) {
        qF = fc;
        fk++;
        continue;
      }
      if (fc === "{") {
        braceDepthF++;
        lastSigF = "{";
        fk++;
        continue;
      }
      if (fc === "}") {
        if (tplBraces.length > 0 && braceDepthF - 1 === tplBraces[tplBraces.length - 1]) {
          tplBraces.pop();
          braceDepthF--;
          qF = BT;
          lastSigF = "}";
          fk++;
          continue;
        }
        if (braceDepthF > 0) braceDepthF--;
        lastSigF = "}";
        fk++;
        continue;
      }
      if (fc === "(") {
        openParens.push({ pos: fk, isCtrl: isCtrlWord(fk) });
        lastSigF = "(";
        fk++;
        continue;
      }
      if (fc === ")") {
        const popped = openParens.length > 0 ? openParens.pop() : null;
        lastPoppedCtrl = Boolean(popped && popped.isCtrl);
        if (fk === q) {
          matchedOpen = popped ? popped.pos : -1;
          break;
        }
        lastSigF = lastPoppedCtrl ? "control)" : ")";
        fk++;
        continue;
      }
      if (fc === "!") {
        lastBangIsNonNull = evalBangAt(fk);
        lastSigF = "!";
        fk++;
        continue;
      }
      if (!/\s/.test(fc)) {
        lastSigF = fc === ">" && fk > scanStart && s[fk - 1] === "=" ? "=>" : fc;
      }
      fk++;
    }
    return !(matchedOpen !== -1 && isCtrlWord(matchedOpen));
  }
  if (!/[\w$]/.test(ch)) return false;
  let wStart = q;
  while (wStart > minStart && /[\w$]/.test(s[wStart - 1])) wStart--;
  if (wStart > minStart && s[wStart - 1] === ".") return true;
  const word = s.slice(wStart, q + 1);
  return !/^(?:return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do)$/.test(word);
}

export function skipJsRegexInExpr(s, idx, lastSig, minStart = 0) {
  if (!s || idx < minStart || idx >= s.length || s[idx] !== "/") return -1;
  const next = idx + 1 < s.length ? s[idx + 1] : "";
  if (next === "/" || next === "*" || next === ">") return -1;
  if (idx > minStart && s[idx - 1] === "<") return -1;
  const isPostfixIncDec =
    (lastSig === "+" || lastSig === "-") && /(?:\+\+|--)\s*$/.test(s.slice(Math.max(minStart, idx - 16), idx));
  if (isPostfixIncDec) return -1;
  const isTsBang = lastSig === "!" && isTsNonNullBang(s, idx, minStart);
  const allowedStart =
    lastSig === "" ||
    lastSig === "control)" ||
    (!isTsBang && /[=([,:;!&|?{}~+\-*%^]/.test(lastSig)) ||
    /(?:^|[^\w$.])(?:return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do)\s*$|=>\s*$/.test(
      s.slice(Math.max(minStart, idx - 24), idx)
    );
  if (!allowedStart) return -1;
  let j = idx + 1;
  let inClass = false;
  let closed = false;
  while (j < s.length && s[j] !== "\n") {
    const rc = s[j];
    if (rc === "\\" && j + 1 < s.length && s[j + 1] !== "\n") {
      j += 2;
      continue;
    }
    if (rc === "[") inClass = true;
    else if (rc === "]" && inClass) inClass = false;
    else if (!inClass && /^<\/(?:[A-Za-z][A-Za-z0-9_.:-]*\s*>|>)/.test(s.slice(j, j + 48))) {
      return -1;
    } else if (rc === "/" && !inClass) {
      if (s[j + 1] === "*" || s[j + 1] === "/") return -1;
      closed = true;
      j++;
      const seenFlags = new Set();
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) {
        if (!/[dgimsuvy]/.test(s[j]) || seenFlags.has(s[j])) return -1;
        seenFlags.add(s[j]);
        j++;
      }
      if (j < s.length && (/["'`>]/.test(s[j]) || s.startsWith("/>", j))) return -1;
      return j;
    }
    j++;
  }
  return closed ? j : -1;
}

export function findSvgBlockRanges(src, options = {}) {
  const s = String(src || "");
  if (!/<svg(?=[\s/>])/i.test(s)) return [];
  const BT = "`";
  const ranges = [];
  const allowSvgJsx = !options?.isMarkupSfc || Boolean(options?.braceExprs);
  const findBraceEnd = (openIdx) => findBalancedDelimEndSimple(s, openIdx, "{", "}", allowSvgJsx);
  const scanOpenSvgEnd = (openStart) => {
    let i = openStart + 4;
    let q = null;
    let brace = 0;
    let lastSig = "";
    const parenStack = [];
    while (i < s.length) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < s.length) i += 2;
        else {
          if (q === BT && ch === "$" && s[i + 1] === "{") {
            const bEnd = findBraceEnd(i + 1);
            if (bEnd !== -1) { i = bEnd + 1; lastSig = "}"; continue; }
          }
          if (ch === q) {
            q = null;
            lastSig = ch;
          }
          i++;
        }
        continue;
      }
      if (brace > 0) {
        const reEnd = skipJsRegexInExpr(s, i, lastSig, openStart + 4);
        if (reEnd !== -1) {
          i = reEnd;
          lastSig = "/";
          continue;
        }
      }
      if (ch === '"' || ch === "'" || ch === BT) q = ch;
      else if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(openStart + 4, i - 16), i)));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (ch === "{") {
        brace++;
        lastSig = "{";
      } else if (ch === "}") {
        brace = Math.max(0, brace - 1);
        lastSig = "}";
      } else if (ch === ">" && brace === 0) {
        let p = i - 1;
        while (p >= openStart && /\s/.test(s[p])) p--;
        return { end: i + 1, selfClosing: s[p] === "/" };
      } else if (!/\s/.test(ch)) {
        lastSig = ch;
      }
      i++;
    }
    return null;
  };
  const ctx = options.markupCtx || scanMarkupContexts(s, options);
  const inJsStr = (idx) => ctx.jsStringSpans.some(([a, b]) => idx >= a && idx < b);
  const realOpenTagsByStart = new Map(ctx.openTags.map((t) => [t.start, t]));
  const svgOpenTags = ctx.openTags.filter((t) => t.tag === "svg").sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const tag of svgOpenTags) {
    if (tag.start < cursor) continue;
    if (tag.selfClosing) {
      ranges.push({ start: tag.start, end: tag.end });
      cursor = tag.end;
      continue;
    }
    let depth = 1;
    let scan = tag.end;
    let matchedEnd = -1;
    while (scan < s.length && depth > 0) {
      if (inJsStr(scan)) {
        scan++;
        continue;
      }
      if (s[scan] === "{") {
        const bEnd = findBraceEnd(scan);
        if (bEnd !== -1) {
          scan = bEnd + 1;
          continue;
        }
      }
      if (s[scan] === "<") {
        if (/^<\/svg(?=[\s/>])/i.test(s.slice(scan, scan + 6))) {
          const gt = s.indexOf(">", scan + 5);
          if (gt === -1) break;
          depth--;
          scan = gt + 1;
          if (depth === 0) {
            matchedEnd = scan;
            break;
          }
          continue;
        }
        const knownTag = realOpenTagsByStart.get(scan);
        if (knownTag) {
          if (knownTag.tag === "svg" && !knownTag.selfClosing) depth++;
          scan = knownTag.end;
          continue;
        }
        if (/^<svg(?=[\s/>])/i.test(s.slice(scan, scan + 5))) {
          const innerOpen = scanOpenSvgEnd(scan);
          if (!innerOpen) {
            scan += 4;
            continue;
          }
          if (!innerOpen.selfClosing) depth++;
          scan = innerOpen.end;
          continue;
        }
        if (/^<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/>])/.test(s.slice(scan, scan + 64))) {
          let ti = scan + 1;
          let tq = null;
          let tb = 0;
          let tLastSig = "";
          const tParen = [];
          while (ti < s.length) {
            const tc = s[ti];
            if (tq) {
              if (tc === "\\" && ti + 1 < s.length) { ti += 2; continue; }
              if (tq === BT && tc === "$" && s[ti + 1] === "{") {
                const subB = findBraceEnd(ti + 1);
                if (subB !== -1) { ti = subB + 1; tLastSig = "}"; continue; }
              }
              if (tc === tq) { tq = null; tLastSig = tc; }
              ti++;
              continue;
            }
            if (tb > 0) {
              const reEnd = skipJsRegexInExpr(s, ti, tLastSig, scan + 1);
              if (reEnd !== -1) { ti = reEnd; tLastSig = "/"; continue; }
            }
            if (tc === '"' || tc === "'" || tc === BT) tq = tc;
            else if (tc === "(") { tParen.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(scan + 1, ti - 16), ti))); tLastSig = "("; }
            else if (tc === ")") tLastSig = tParen.length > 0 && tParen.pop() ? "control)" : ")";
            else if (tc === "{") { tb++; tLastSig = "{"; }
            else if (tc === "}") { tb = Math.max(0, tb - 1); tLastSig = "}"; }
            else if (tc === ">" && tb === 0) { ti++; break; }
            else if (!/\s/.test(tc)) tLastSig = tc;
            ti++;
          }
          scan = ti;
          continue;
        }
      }
      scan++;
    }
    if (matchedEnd !== -1) {
      ranges.push({ start: tag.start, end: matchedEnd });
      cursor = matchedEnd;
    } else {
      cursor = tag.end;
    }
  }
  return ranges;
}

export function maskRangePreservingLines(chars, start, end) {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== "\n") chars[i] = " ";
  }
}

export function splitTopLevelCommas(selStr) {
  const parts = [];
  let paren = 0;
  let bracket = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < selStr.length; i++) {
    const ch = selStr[i];
    if (quote) {
      if (ch === "\\" && i + 1 < selStr.length) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < selStr.length) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      paren++;
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
    } else if (ch === "[") {
      bracket++;
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
    } else if (ch === "," && paren === 0 && bracket === 0) {
      const part = selStr.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = selStr.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

const SINGLE_TOKEN_SELECTOR_RE =
  /^(?:@theme(?:\s+(?:inline|static|reference|default))*|@property\s+--[a-zA-Z0-9_-]+|(?::root|:host|\[data-(?:uxs-)?theme(?:\s*(?:[~|^$*]?=[^\]]*))?\]|\.(?:dark|light)|(?:html|body)(?:\[data-(?:uxs-)?theme(?:\s*(?:[~|^$*]?=[^\]]*))?\]|\.(?:dark|light))+)(?:\[data-(?:uxs-)?theme(?:\s*(?:[~|^$*]?=[^\]]*))?\]|\.(?:dark|light))*)$/i;

export function isTokenDefinitionHeader(hdr) {
  const clean = String(hdr || "").trim();
  if (!clean) return false;
  const branches = splitTopLevelCommas(clean);
  return branches.length > 0 && branches.every((b) => SINGLE_TOKEN_SELECTOR_RE.test(b.trim()));
}

const NESTED_TOKEN_MODIFIER_RE =
  /^&(?:\[data-(?:uxs-)?theme(?:\s*(?:[~|^$*]?=[^\]]*))?\]|\.(?:dark|light))*$/i;

function isNestedTokenModifierHeader(hdr) {
  const clean = String(hdr || "").trim();
  if (!clean) return false;
  const branches = splitTopLevelCommas(clean);
  return branches.length > 0 && branches.every((b) => NESTED_TOKEN_MODIFIER_RE.test(b.trim()));
}

function isHtmlAttrAssign(chars, quoteIdx) {
  const near = chars.slice(Math.max(0, quoteIdx - 64), quoteIdx).join("");
  if (!/[A-Za-z0-9_:-]\s*=\s*$/.test(near)) return false;
  const tail = chars.slice(Math.max(0, quoteIdx - 2048), quoteIdx).join("");
  let brace = 0;
  let q = null;
  const tplBraces = [];
  let lastLt = -1;
  let lastGt = -1;
  let genericDepth = 0;
  let lastSig = "";
  const parenStack = [];
  for (let k = 0; k < tail.length; k++) {
    const c = tail[k];
    if (q) {
      if (brace > 0 && c === "\\" && k + 1 < tail.length) {
        k++;
        continue;
      }
      if (q === "`" && c === "$" && k + 1 < tail.length && tail[k + 1] === "{") {
        tplBraces.push(brace);
        brace++;
        q = null;
        lastSig = "{";
        k++;
        continue;
      }
      if (c === q) {
        q = null;
        lastSig = c;
      }
      continue;
    }
    if (brace > 0) {
      if (c === "/" && tail[k + 1] === "*") {
        const ce = tail.indexOf("*/", k + 2);
        k = ce === -1 ? tail.length : ce + 1;
        continue;
      }
      if (c === "/" && tail[k + 1] === "/") {
        const nl = tail.indexOf("\n", k + 2);
        k = nl === -1 ? tail.length : nl;
        lastSig = "";
        continue;
      }
      const reEnd = skipJsRegexInExpr(tail, k, lastSig, 0);
      if (reEnd !== -1 && reEnd <= tail.length) {
        lastSig = "/";
        k = reEnd - 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      if (brace > 0 ? (c === '"' || c === "'" || c === "`") : (lastLt > lastGt && (c === '"' || c === "'"))) q = c;
      lastSig = c;
    } else if (c === "{") {
      brace++;
      lastSig = "{";
    } else if (c === "}") {
      if (tplBraces.length > 0 && brace - 1 === tplBraces[tplBraces.length - 1]) {
        tplBraces.pop();
        brace--;
        q = "`";
        lastSig = "}";
      } else if (brace > 0) {
        brace--;
        lastSig = "}";
      }
    } else if (c === "(" && brace > 0) {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(tail.slice(Math.max(0, k - 16), k)));
      lastSig = "(";
    } else if (c === ")" && brace > 0) {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
    } else if (c === "<" && brace === 0) {
      const prevCh = k > 0 ? tail[k - 1] : "";
      const isJsKw =
        /[A-Za-z]/.test(prevCh) &&
        /(?:^|[^\w$.])(?:return|case|throw|else|default|yield|await|void)$/.test(tail.slice(Math.max(0, k - 16), k));
      const blockedByOperand = !isJsKw && /[A-Za-z0-9_$\]\])]/.test(prevCh);
      if (
        lastLt > lastGt &&
        (genericDepth > 0 || (/[A-Za-z0-9_$.]/.test(prevCh) && !/\s/.test(tail.slice(lastLt + 1, k))))
      ) {
        genericDepth++;
      } else if (!blockedByOperand && /[A-Za-z]/.test(tail[k + 1] || "")) {
        lastLt = k;
        genericDepth = 0;
      }
      lastSig = "<";
    } else if (c === ">" && brace === 0 && !(k > 0 && tail[k - 1] === "=")) {
      if (genericDepth > 0) genericDepth--;
      else lastGt = k;
      lastSig = ">";
    } else if (brace === 0 && lastLt > lastGt && (c === ";" || (c === "=" && tail[k + 1] === ">") || (c === "," && genericDepth === 0))) {
      lastLt = -1;
      genericDepth = 0;
      lastSig = c === "=" && tail[k + 1] === ">" ? "=>" : c;
    } else if (!/\s/.test(c)) {
      lastSig = c === ">" && k > 0 && tail[k - 1] === "=" ? "=>" : c;
    }
  }
  return lastLt !== -1 && lastLt > lastGt;
}

function findOpenHtmlAttrQuote(candBody) {
  let inTag = false;
  let sawEq = false;
  let brace = 0;
  let exprFromEq = false;
  let attrQ = null;
  const tplBraces = [];
  for (let k = 0; k < candBody.length; k++) {
    const c = candBody[k];
    if (attrQ) {
      if (c === "\\" && k + 1 < candBody.length) {
        k++;
        continue;
      }
      if (attrQ === "`" && c === "$" && k + 1 < candBody.length && candBody[k + 1] === "{") {
        tplBraces.push(brace);
        brace++;
        attrQ = null;
        k++;
        continue;
      }
      if (c === attrQ) {
        attrQ = null;
        sawEq = false;
      }
      continue;
    }
    if (brace > 0) {
      if (c === '"' || c === "'" || c === "`") attrQ = c;
      else if (c === "{") brace++;
      else if (c === "}") {
        if (tplBraces.length > 0 && brace - 1 === tplBraces[tplBraces.length - 1]) {
          tplBraces.pop();
          brace--;
          attrQ = "`";
        } else {
          brace--;
          if (brace === 0) {
            sawEq = false;
            exprFromEq = false;
          }
        }
      }
      continue;
    }
    if (c === "<" && /[A-Za-z]/.test(candBody[k + 1] || "")) {
      inTag = true;
      sawEq = false;
      exprFromEq = false;
    } else if (c === ">" && !(k > 0 && candBody[k - 1] === "=")) {
      inTag = false;
      sawEq = false;
      exprFromEq = false;
    } else if (inTag) {
      if (c === "=") sawEq = true;
      else if (c === "{") {
        if (sawEq) exprFromEq = true;
        brace++;
      } else if ((c === '"' || c === "'" || c === "`") && sawEq) {
        attrQ = c;
      } else if (!/\s/.test(c) && sawEq) {
        sawEq = false;
      }
    }
  }
  return inTag && attrQ && (brace === 0 || (brace === 1 && exprFromEq)) ? attrQ : null;
}

/**
 * Strip block comments (`/* ... *\/`), HTML comments (`<!-- ... -->`), and JS line
 * comments (`// ...` outside strings, regex literals, and CSS `url(...)`) while preserving exact lines.
 */
function canOpenTagDirectiveBracket(allowGenerics, brack, nonExpr) {
  return (
    !allowGenerics ||
    brack > 0 ||
    (/\s/.test(nonExpr) && /(?:^|\s)(?:[:@]|[A-Za-z][A-Za-z0-9_.-]*:)[^\s=<>]*$/.test(nonExpr))
  );
}

function inspectIncompleteOpenTagPrefix(s, ltIdx = 0, allowGenerics = true) {
  const om = /^<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/<]|$)/.exec(s.slice(ltIdx, ltIdx + 64));
  if (!om) return null;
  const rawTag = om[1];
  let j = ltIdx + 1 + rawTag.length;
  if (s[j] === "<") {
    if (!allowGenerics || (!/^[A-Z]/.test(rawTag) && !rawTag.includes("."))) return null;
    let gq = null;
    let gAngle = 1;
    let gParen = 0;
    let gBrack = 0;
    let gBrace = 0;
    let gk = j + 1;
    while (gk < s.length && gAngle > 0) {
      const gc = s[gk];
      if (gq) {
        if (gc === "\\" && gk + 1 < s.length) {
          gk += 2;
          continue;
        }
        if (gc === gq || (gq !== "`" && gc === "\n")) gq = null;
        gk++;
        continue;
      }
      if (gc === '"' || gc === "'" || gc === "`") gq = gc;
      else if (gc === "(") gParen++;
      else if (gc === ")") gParen = Math.max(0, gParen - 1);
      else if (gc === "[") gBrack++;
      else if (gc === "]") gBrack = Math.max(0, gBrack - 1);
      else if (gc === "{") gBrace++;
      else if (gc === "}") gBrace = Math.max(0, gBrace - 1);
      else if (gParen === 0 && gBrack === 0 && gBrace === 0) {
        if (gc === "<") gAngle++;
        else if (gc === ">" && s[gk - 1] !== "=") gAngle--;
        else if (gc === ";") return null;
      }
      gk++;
    }
    if (gAngle > 0) return { incomplete: true, exprStart: -1 };
    if (gk < s.length && !/[\s/>]/.test(s[gk])) return null;
    j = gk;
  }
  if (/^\s*=/.test(s.slice(j, j + 16))) return null;
  let q = null;
  let qInBracket = false;
  let nonExpr = "";
  let brack = 0;
  while (j < s.length) {
    const c = s[j];
    if (q) {
      if (qInBracket && c === "\\" && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (c === q) {
        q = null;
        qInBracket = false;
      }
      j++;
      continue;
    }
    const inSfcBracket = brack > 0;
    if (c === "\n" && inSfcBracket) return null;
    if (c === '"' || c === "'") {
      if (!inSfcBracket && !/=\s*$/.test(nonExpr)) return null;
      q = c;
      qInBracket = inSfcBracket;
      nonExpr += " ";
      j++;
      continue;
    }
    if (c === "{") {
      const be = findBalancedDelimEndSimple(s, j, "{", "}", allowGenerics);
      if (be === -1) {
        return { incomplete: true, exprStart: inSfcBracket ? -1 : j + 1 };
      }
      nonExpr += " ";
      j = be + 1;
      continue;
    }
    if (c === "[" && canOpenTagDirectiveBracket(allowGenerics, brack, nonExpr)) {
      brack++;
      nonExpr += c;
      j++;
      continue;
    }
    if (c === "]" && brack > 0) {
      brack--;
      nonExpr += c;
      j++;
      continue;
    }
    if (c === "<" || c === ";") {
      return null;
    }
    if (!inSfcBracket && (c === ">" || c === "," || c === "&" || c === "?" || c === "(" || c === ")" || c === "[")) {
      return null;
    }
    if (!inSfcBracket && c === "=" && s[j + 1] === ">") return null;
    const isSvelteModifierPipe =
      c === "|" &&
      s[j + 1] !== "|" &&
      /(?:^|\s)[A-Za-z][A-Za-z0-9_-]*:(?:--)?[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)*$/.test(nonExpr.slice(-96)) &&
      /^(?:[A-Za-z0-9_-]*(?:\s*(?:=|\/?>|\s)|\|)|[A-Za-z0-9_-]*$)/.test(s.slice(j + 1, j + 48));
    if (c === "|" && !inSfcBracket && !isSvelteModifierPipe) return null;
    nonExpr += c;
    j++;
  }
  return { incomplete: true, exprStart: -1 };
}

function createOpenMarkupCursor(rawSrc, chars) {
  const ctxStack = [];
  let quote = null;
  let lastSig = "";
  const parenStack = [];
  let inRawTag = null;
  let rawTagCloseEnd = -1;
  let i = 0;

  const topFrame = () => (ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : null);
  const advanceTo = (pos) => {
    let partialOpenExprStart = -1;
    while (i < pos && i < chars.length) {
      if (inRawTag) {
        if (rawTagCloseEnd === -1) {
          i = pos;
          break;
        }
        if (pos < rawTagCloseEnd) {
          i = pos;
          break;
        }
        i = rawTagCloseEnd;
        inRawTag = null;
        rawTagCloseEnd = -1;
        lastSig = ">";
        continue;
      }
      const ch = chars[i];
      if (quote) {
        if (ch === "\\") {
          if (i + 1 >= pos) break;
          i += 2;
          continue;
        }
        if (quote === "`" && ch === "$") {
          if (i + 1 >= pos) break;
          if (chars[i + 1] === "{") {
            ctxStack.push({ kind: "brace", isTpl: true });
            quote = null;
            lastSig = "{";
            i += 2;
            continue;
          }
        }
        if (ch === quote || (quote !== "`" && ch === "\n")) {
          quote = null;
          lastSig = ch;
        }
        i++;
        continue;
      }
      const top = topFrame();
      if (top && top.kind === "markup") {
        if (ch === "{") {
          ctxStack.push({ kind: "brace", isTpl: false });
          lastSig = "{";
          i++;
          continue;
        }
        if (ch === "<") {
          const slice80 = chars.slice(i, Math.min(pos, i + 80)).join("");
          const closeM = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)?\s*>/.exec(slice80);
          if (closeM && i + closeM[0].length <= pos) {
            const ct = (closeM[1] || "").toLowerCase();
            if (!ct) {
              if (top.kind === "markup") ctxStack.pop();
            } else {
              for (let k = ctxStack.length - 1; k >= 0; k--) {
                if (ctxStack[k].kind !== "markup") break;
                if (ctxStack[k].tag === ct) {
                  ctxStack.length = k;
                  break;
                }
              }
            }
            i += closeM[0].length;
            lastSig = ">";
            continue;
          }
          const win = chars.slice(i, pos).join("");
          const tagRes = parseMarkupOpenTagCore(win, 0, true);
          if (tagRes && i + tagRes.end <= pos) {
            if (!tagRes.selfClosing) {
              if (tagRes.tag === "script" || tagRes.tag === "style") {
                inRawTag = tagRes.tag;
                const bodyStartPos = i + tagRes.end;
                const isScssRaw = tagRes.tag === "style" && /\blang\s*=\s*["']s[ca]ss["']/i.test(win.slice(0, tagRes.end));
                const closeInfo =
                  tagRes.tag === "script"
                    ? findScriptCloseRaw(rawSrc, bodyStartPos)
                    : findStyleCloseRaw(rawSrc, bodyStartPos, isScssRaw);
                rawTagCloseEnd = closeInfo ? closeInfo.closeEnd : -1;
              } else if (!VOID_HTML_TAGS.has(tagRes.tag)) ctxStack.push({ kind: "markup", tag: tagRes.tag });
            }
            i += tagRes.end;
            lastSig = ">";
            continue;
          }
          const inc = inspectIncompleteOpenTagPrefix(win, 0, true);
          if (inc) {
            partialOpenExprStart = inc.exprStart === -1 ? -1 : i + inc.exprStart;
            return { inOpenTag: true, exprStart: partialOpenExprStart };
          }
        }
        i++;
        continue;
      }
      if (ch === "/") {
        const winFromI = chars.slice(i, Math.min(pos, i + 1024)).join("");
        const reEnd = skipJsRegexInExpr(winFromI, 0, lastSig, 0);
        if (reEnd !== -1 && i + reEnd <= pos) {
          i += reEnd;
          lastSig = "/";
          continue;
        }
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const isContract =
          ch === "'" && i > 0 && /[A-Za-z0-9]/.test(chars[i - 1]) && i + 1 < pos && /[A-Za-z]/.test(chars[i + 1]);
        const okTpl =
          ch !== "`" ||
          (() => {
            const prev24 = chars.slice(Math.max(0, i - 24), i).join("");
            const prev4 = prev24.slice(-4);
            return (
              /(?:[=([,{:?+&|!~;<]|=>|\b(?:return|throw|case|yield|await|of|in|typeof|void|delete|default|else|do))\s*$/.test(prev24) ||
              !/\s$/.test(prev4)
            );
          })();
        if (!isContract && okTpl) {
          quote = ch;
        }
        i++;
        continue;
      }
      if (ch === "(") {
        const prev16 = chars.slice(Math.max(0, i - 16), i).join("");
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(prev16));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (ch === "{") {
        ctxStack.push({ kind: "brace", isTpl: false });
        lastSig = "{";
      } else if (ch === "}") {
        if (top && top.kind === "brace") {
          const popped = ctxStack.pop();
          if (popped.isTpl) {
            quote = "`";
            i++;
            continue;
          }
        }
        lastSig = "}";
      } else if (ch === "<") {
        const prevChar = i > 0 ? chars[i - 1] : "";
        const isJsKw =
          prevChar &&
          /[A-Za-z]/.test(prevChar) &&
          /(?:^|[^\w$.])(?:return|case|throw|else|default|yield|await|void)$/.test(
            chars.slice(Math.max(0, i - 16), i).join("")
          );
        const blockedById = !isJsKw && /[A-Za-z0-9_$\]\])]/.test(prevChar);
        if (!blockedById) {
          const win = chars.slice(i, pos).join("");
          const tagRes = parseMarkupOpenTagCore(win, 0, true);
          if (tagRes && i + tagRes.end <= pos) {
            if (!tagRes.selfClosing) {
              if (tagRes.tag === "script" || tagRes.tag === "style") {
                inRawTag = tagRes.tag;
                const bodyStartPos = i + tagRes.end;
                const isScssRaw = tagRes.tag === "style" && /\blang\s*=\s*["']s[ca]ss["']/i.test(win.slice(0, tagRes.end));
                const closeInfo =
                  tagRes.tag === "script"
                    ? findScriptCloseRaw(rawSrc, bodyStartPos)
                    : findStyleCloseRaw(rawSrc, bodyStartPos, isScssRaw);
                rawTagCloseEnd = closeInfo ? closeInfo.closeEnd : -1;
              } else if (!VOID_HTML_TAGS.has(tagRes.tag)) ctxStack.push({ kind: "markup", tag: tagRes.tag });
            }
            i += tagRes.end;
            lastSig = ">";
            continue;
          }
          const inc = inspectIncompleteOpenTagPrefix(win, 0, true);
          if (inc) {
            partialOpenExprStart = inc.exprStart === -1 ? -1 : i + inc.exprStart;
            return { inOpenTag: true, exprStart: partialOpenExprStart };
          }
        }
        lastSig = "<";
      } else if (!/\s/.test(ch)) {
        lastSig = ch === ">" && i > 0 && chars[i - 1] === "=" ? "=>" : ch;
      }
      i++;
    }
    return null;
  };

  return (pos) => {
    const partial = advanceTo(pos);
    if (partial) {
      return partial.exprStart === -1 ? false : isInsideOpenMarkupChildren(chars.slice(partial.exprStart, pos).join(""));
    }
    const top = topFrame();
    return Boolean(!inRawTag && top && top.kind === "markup");
  };
}

function scanCommentsPreservingLines(raw, collectTokens = false, collectStringSpans = false) {
  const s = String(raw || "");
  const chars = s.split("");
  const tokens = collectTokens ? [] : null;
  const stringSpans = collectStringSpans ? [] : null;
  let i = 0;
  let quote = null;
  let quoteMultiline = false;
  let quoteSpanStart = -1;
  let lastSig = "";
  const templateBraceStack = [];
  const parenStack = [];
  const isInOpenMarkupAt = createOpenMarkupCursor(s, chars);
  while (i < s.length) {
    const ch = s[i];
    const next = i + 1 < s.length ? s[i + 1] : "";
    if (quote) {
      if ((!quoteMultiline || quote === "`") && ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        if (stringSpans && quoteSpanStart !== -1) {
          stringSpans.push([quoteSpanStart, i]);
        }
        quoteSpanStart = -1;
        templateBraceStack.push(0);
        quote = null;
        quoteMultiline = false;
        lastSig = "{";
        i += 2;
        continue;
      }
      if (ch === quote || (!quoteMultiline && ch === "\n")) {
        if (stringSpans && quoteSpanStart !== -1 && ch === quote) {
          stringSpans.push([quoteSpanStart, i + 1]);
        }
        quote = null;
        quoteMultiline = false;
        quoteSpanStart = -1;
        if (ch !== "\n") lastSig = ch;
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length && (next === "'" || next === '"' || next === "`" || next === "\\" || next === "/")) {
      lastSig = next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      // Avoid treating contractions/apostrophes in prose (e.g., "Don't", "Users' settings", "The '90s") as single-quoted strings.
      const prev = i > 0 ? s[i - 1] : "";
      const prevWord = s.slice(Math.max(0, i - 24), i);
      const kwM = /(?:^|[^\w$])(return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do|export|import|from)\s*$/.exec(
        prevWord
      );
      const isJsKeywordBefore = Boolean(kwM);
      const eolIdx = s.indexOf("\n", i + 1);
      const lineStartIdx = s.lastIndexOf("\n", i - 1) + 1;
      const lineBeforeQuote = s.slice(lineStartIdx, i);
      const restOfLine = s.slice(i + 1, eolIdx === -1 ? s.length : eolIdx);
      const hasTagTextEqBefore = () => {
        if (lastSig !== "=") return false;
        let k = i - 1;
        while (k >= 0 && /\s/.test(s[k])) k--;
        if (k < 0 || s[k] !== "=") return false;
        k--;
        let bDepth = 0;
        let declBuf = "";
        while (k >= 0 && k >= i - 600) {
          const c = s[k];
          if (c === "}") { bDepth++; k--; continue; }
          if (c === "{") {
            if (bDepth === 0) return false;
            bDepth--;
            k--;
            continue;
          }
          if (bDepth === 0) {
            if (c === "<" || c === ";") return false;
            if (c === "=") return false;
            if (c === ">") {
              if (k > 0 && (s[k - 1] === "=" || s[k - 1] === "-")) {
                return false;
              }
              return !/\b(?:const|let|var)\b/.test(declBuf);
            }
            declBuf = c + declBuf;
          }
          k--;
        }
        return false;
      };
      const inTagTextEq = hasTagTextEqBefore();
      const isJsValueContext =
        isJsKeywordBefore ||
        lastSig === "" ||
        /[([,:;?+&|!{<]/.test(lastSig) ||
        /=>\s*$/.test(prevWord) ||
        (lastSig === "=" && !inTagTextEq);
      let hasClosingQuoteOnLine = false;
      for (let rq = 0; rq < restOfLine.length; rq++) {
        if (restOfLine[rq] === "\\" && rq + 1 < restOfLine.length) {
          rq++;
          continue;
        }
        if (restOfLine[rq] === "'") {
          const rPrev = rq > 0 ? restOfLine[rq - 1] : "";
          const rPrev2 = rq > 1 ? restOfLine[rq - 2] : "";
          const rNext = restOfLine[rq + 1] || "";
          const between = restOfLine.slice(0, rq);
          const afterQ = restOfLine.slice(rq + 1, rq + 16);
          const isOtherLeadingContraction =
            (rq === 0 || /[\s>([]/.test(rPrev)) &&
            /^(?:\d{2}s?\b|(?:tis|twas|twill|twere|em|til|bout|round|cause)\b)/i.test(afterQ) &&
            !/^(?:\d{2}s?|[a-z]+)'/i.test(afterQ);
          const isProseTailApostrophe =
            !isJsValueContext &&
            !/[=([,:;?+&|!{]\s*$/.test(lineBeforeQuote) &&
            (/[sSnN]/.test(rPrev) && /[A-Za-z0-9]/.test(rPrev2) || ((rPrev === "n" || rPrev === "N") && rPrev2 === "'")) &&
            (rNext === "" || /[\s<.,;:!?)\]}"]/.test(rNext));
          if (
            !(/[A-Za-z]/.test(rPrev) && /[A-Za-z]/.test(rNext)) &&
            !isOtherLeadingContraction &&
            !isProseTailApostrophe &&
            !/[<>]/.test(between) &&
            !/=\s*$/.test(between)
          ) {
            hasClosingQuoteOnLine = true;
            break;
          }
        }
      }
      const inTagTextEqFinal =
        inTagTextEq && !hasClosingQuoteOnLine;
      const effJsValueContext =
        (isJsKeywordBefore && hasClosingQuoteOnLine) ||
        lastSig === "" ||
        /[([,:;?+&|!{<]/.test(lastSig) ||
        /=>\s*$/.test(prevWord) ||
        (lastSig === "=" && !inTagTextEqFinal);
      const nextWordSlice = s.slice(i + 1, i + 16);
      const isLeadingContraction =
        !effJsValueContext &&
        !hasClosingQuoteOnLine &&
        (prev === "" || /[\s>([]/.test(prev)) &&
        /^(?:\d{2}s?\b|(?:tis|twas|twill|twere|em|til|bout|round|cause)\b)/i.test(nextWordSlice) &&
        !/^(?:\d{2}s?|[a-z]+)'/i.test(nextWordSlice);
      if (
        (!isJsKeywordBefore &&
          /[A-Za-z0-9]/.test(prev) &&
          (/[A-Za-z]/.test(next) || /[\s<.,!?;:)\]}]/.test(next) || next === "")) ||
        isLeadingContraction
      ) {
        lastSig = ch;
        i++;
        continue;
      }
      quote = ch;
      quoteMultiline = lastSig === "=" && isHtmlAttrAssign(chars, i);
      quoteSpanStart = !collectStringSpans || quoteMultiline || hasClosingQuoteOnLine ? i : -1;
      i++;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      quoteMultiline = lastSig === "=" && isHtmlAttrAssign(chars, i);
      if (collectStringSpans) {
        const rest = s.slice(i + 1, s.indexOf("\n", i + 1) === -1 ? s.length : s.indexOf("\n", i + 1));
        const closesSoon = quoteMultiline || /(?:^|[^\\])(?:\\\\)*"/.test(rest);
        quoteSpanStart = closesSoon ? i : -1;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      if (canStartJsTemplateLiteral(s, i, chars.slice(Math.max(0, i - 8192), i).join(""), isInOpenMarkupAt(i))) {
        quote = ch;
        quoteMultiline = true;
        quoteSpanStart = collectStringSpans ? i : -1;
      } else {
        lastSig = ch;
      }
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      if (isInOpenMarkupAt(i)) {
        lastSig = "*";
        i += 2;
        continue;
      }
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      if (collectTokens && end !== -1) {
        tokens.push({ kind: "block", text: s.slice(i, stop), start: i, end: stop });
      }
      maskRangePreservingLines(chars, i, stop);
      i = stop;
      continue;
    }
    if (ch === "<" && s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      const stop = end === -1 ? s.length : end + 3;
      if (collectTokens && end !== -1) {
        tokens.push({ kind: "html", text: s.slice(i, stop), start: i, end: stop });
      }
      maskRangePreservingLines(chars, i, stop);
      i = stop;
      continue;
    }
    if ((ch === "u" || ch === "U") && /^url\(/i.test(s.slice(i, i + 4)) && (i === 0 || /[:\s,([\n]/.test(s[i - 1]))) {
      const beforeUrl = s.slice(Math.max(0, i - 16), i);
      if (!/(?:^|[^\w$])new\s+$/.test(beforeUrl)) {
        let k = i + 4;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (k < s.length && s[k] !== '"' && s[k] !== "'" && s[k] !== ")") {
          let j = k;
          let validCssUrl = true;
          while (j < s.length && s[j] !== ")" && !/\s/.test(s[j])) {
            if ((s[j] === "#" || s[j] === "$") && s[j + 1] === "{") {
              let id = 1;
              let iq = null;
              let jp = j + 2;
              while (jp < s.length && id > 0) {
                const uc = s[jp];
                if (iq) {
                  if (uc === "\\" && jp + 1 < s.length) jp += 2;
                  else {
                    if (uc === iq || (iq !== "`" && uc === "\n")) iq = null;
                    jp++;
                  }
                  continue;
                }
                if (uc === '"' || uc === "'" || uc === "`") iq = uc;
                else if (uc === "{") id++;
                else if (uc === "}") id--;
                jp++;
              }
              if (id !== 0) {
                validCssUrl = false;
                break;
              }
              j = jp;
              continue;
            }
            if (s.startsWith("/*", j) || s[j] === "{" || s[j] === "}" || s[j] === '"' || s[j] === "'") {
              validCssUrl = false;
              break;
            }
            j++;
          }
          while (validCssUrl && j < s.length && /\s/.test(s[j])) j++;
          if (validCssUrl && j < s.length && s[j] === ")") {
            i = j + 1;
            lastSig = ")";
            continue;
          }
        }
      }
    }
    if (ch === "/" && next === "/") {
      const prev = i === 0 ? "\n" : s[i - 1];
      const beforeColon = s.slice(Math.max(0, i - 32), i);
      const isSchemeUrl =
        prev === ":" &&
        /(?:^|[^a-zA-Z0-9_$-])(?:https?|ftp|sftp|ftps|file|ws|wss|mailto|data|blob|chrome(?:-extension)?|moz-extension|edge|safari|about|app|vscode|capacitor|tauri|ionic|s3|gs|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|ssh|git|npm|yarn|pnpm|docker|oci|ircs?|ldaps?):$/i.test(
          beforeColon
        ) &&
        i + 2 < s.length &&
        /[A-Za-z0-9/[._~-]/.test(s[i + 2]);
      const isProtoUrlAfterEq = prev === "=" && /^\/\/[A-Za-z0-9._-]+\//.test(s.slice(i, i + 64));
      if (!isSchemeUrl && !isProtoUrlAfterEq) {
        if (isInOpenMarkupAt(i)) {
          lastSig = "/";
          i += 2;
          continue;
        }
        const end = s.indexOf("\n", i + 2);
        const stop = end === -1 ? s.length : end;
        if (collectTokens) {
          tokens.push({ kind: "line", text: s.slice(i, stop).replace(/\r$/, ""), start: i, end: stop });
        }
        maskRangePreservingLines(chars, i, stop);
        i = stop;
        continue;
      }
    }
    const isPostfixIncDec =
      (lastSig === "+" || lastSig === "-") && /(?:\+\+|--)\s*$/.test(s.slice(Math.max(0, i - 16), i));
    const isCssColorAlpha =
      lastSig === "%" &&
      (/(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\([^;{}]*$/i.test(s.slice(Math.max(0, i - 64), i)) ||
        /\d(?:\.\d+)?%\s*$/.test(s.slice(Math.max(0, i - 32), i)));
    const isTsBang = lastSig === "!" && isTsNonNullBang(s, i, 0);
    const isUnambiguousJsRegexStart =
      lastSig === "control)" ||
      (!isTsBang && /[=([,?+&|!~*%^]/.test(lastSig)) ||
      ((lastSig === "+" || lastSig === "-") && !isPostfixIncDec) ||
      /(?:^|[^\w$.])(?:return|case|default|throw|typeof|void|delete|in|of|new|yield|await|else|do)\s*$|=>\s*$/.test(
        s.slice(Math.max(0, i - 24), i)
      );
    if (
      ch === "/" &&
      next !== "/" &&
      next !== "*" &&
      next !== ">" &&
      (i === 0 || s[i - 1] !== "<") &&
      !isPostfixIncDec &&
      !isCssColorAlpha &&
      (isUnambiguousJsRegexStart || lastSig === "" || /[;:{}]/.test(lastSig))
    ) {
      // Scan single-line JS regex literals so `/\`/` or `/'/` do not open multiline string state.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      let sawHtmlCommentStart = false;
      let sawHtmlCommentEnd = false;
      while (j < s.length && s[j] !== "\n") {
        const rc = s[j];
        if (rc === "\\" && j + 1 < s.length && s[j + 1] !== "\n") {
          j += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (!inClass && /^<\/(?:[A-Za-z][A-Za-z0-9_.:-]*\s*>|>)/.test(s.slice(j, j + 48))) {
          closed = false;
          break;
        } else if (!inClass && s.startsWith("<!--", j)) {
          sawHtmlCommentStart = true;
        } else if (!inClass && sawHtmlCommentStart && s.startsWith("-->", j)) {
          sawHtmlCommentEnd = true;
        } else if (rc === "/" && !inClass) {
          const eol = s.indexOf("\n", j + 1);
          const lineEnd = eol === -1 ? s.length : eol;
          const remCommentEnd = s.indexOf("-->", j + 1);
          const candBody = s.slice(i + 1, j);
          const restAfterSlash = s.slice(j + 1, lineEnd);
          let hasUnclosedJsInCand = false;
          {
            let cbBrace = 0;
            let cbQuote = null;
            let cbTopQuote = null;
            let sawCssDelim = false;
            let cbInClass = false;
            for (let cp = 0; cp < candBody.length; cp++) {
              const cc = candBody[cp];
              if (cbQuote) {
                if (cc === "\\" && cp + 1 < candBody.length) {
                  cp++;
                  continue;
                }
                if (cc === cbQuote) cbQuote = null;
                continue;
              }
              if (cbTopQuote) {
                if (cc === "\\" && cp + 1 < candBody.length) {
                  cp++;
                  continue;
                }
                if (cc === cbTopQuote) cbTopQuote = null;
                continue;
              }
              if (cc === "\\" && cp + 1 < candBody.length) {
                cp++;
                continue;
              }
              if (cbBrace === 0) {
                if (cc === "[") cbInClass = true;
                else if (cc === "]" && cbInClass) cbInClass = false;
                else if (!isUnambiguousJsRegexStart && !cbInClass && (cc === ";" || cc === ":")) sawCssDelim = true;
                else if (!isUnambiguousJsRegexStart && !cbInClass && sawCssDelim && (cc === '"' || cc === "'")) cbTopQuote = cc;
                else if (!cbInClass && cc === "{" && !/^\{\d+(?:,\d*)?\}/.test(candBody.slice(cp))) {
                  cbBrace++;
                }
              } else {
                if (cc === '"' || cc === "'" || cc === "`") cbQuote = cc;
                else if (cc === "{") cbBrace++;
                else if (cc === "}") cbBrace--;
              }
            }
            if (
              cbQuote !== null ||
              (cbTopQuote !== null && restAfterSlash.includes(cbTopQuote)) ||
              (cbBrace > 0 && restAfterSlash.indexOf("}") !== -1 && (lastSig === "}" || (i > 0 && s[i - 1] === ">")))
            ) {
              hasUnclosedJsInCand = true;
            }
          }
          const openAttrQ = findOpenHtmlAttrQuote(candBody);
          const attrQClose = openAttrQ ? restAfterSlash.indexOf(openAttrQ) : -1;
          const isHtmlAttrUrlSlash =
            openAttrQ !== null &&
            attrQClose !== -1 &&
            (restAfterSlash.indexOf(">", attrQClose + 1) !== -1 ||
              /^\s*\}?(?:\s+[A-Za-z_:]|\s*$)/.test(restAfterSlash.slice(attrQClose + 1)));
          const allHtmlComments = sawHtmlCommentStart && sawHtmlCommentEnd ? [...candBody.matchAll(/<!--([\s\S]*?)-->/g)] : [];
          const looksLikeHtmlCommentRegex =
            allHtmlComments.length > 0 &&
            allHtmlComments.every((cm) => /(?:\.[*+?]|\\[sSwWdDbB]|\[\^)/.test(cm[1]) && !/<[A-Za-z]/.test(cm[1]));
          const isEnclosedHtmlComment = sawHtmlCommentStart && sawHtmlCommentEnd && !looksLikeHtmlCommentRegex;
          if (
            hasUnclosedJsInCand ||
            isHtmlAttrUrlSlash ||
            s[j + 1] === "*" ||
            s[j + 1] === "/" ||
            isEnclosedHtmlComment ||
            (sawHtmlCommentStart &&
              !sawHtmlCommentEnd &&
              remCommentEnd !== -1 &&
              remCommentEnd < lineEnd &&
              !s.slice(j + 1, remCommentEnd).includes("<!--"))
          ) {
            closed = false;
            break;
          }
          closed = true;
          j++;
          const seenFlags = new Set();
          let badFlags = false;
          while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) {
            if (!/[dgimsuvy]/.test(s[j]) || seenFlags.has(s[j])) {
              badFlags = true;
              break;
            }
            seenFlags.add(s[j]);
            j++;
          }
          if (badFlags || (j < s.length && (/["'`>]/.test(s[j]) || s.startsWith("/>", j)))) {
            closed = false;
          }
          break;
        }
        j++;
      }
      if (closed) {
        i = j;
        lastSig = "/";
        continue;
      }
    }
    if (ch === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(0, i - 16), i)));
      lastSig = "(";
      i++;
      continue;
    }
    if (ch === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      i++;
      continue;
    }
    if (ch === "{" && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1]++;
    } else if (ch === "}" && templateBraceStack.length > 0) {
      if (templateBraceStack[templateBraceStack.length - 1] === 0) {
        templateBraceStack.pop();
        quote = "`";
        quoteMultiline = true;
        quoteSpanStart = i;
        lastSig = "`";
        i++;
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1]--;
    }
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return { cleaned: chars.join(""), tokens, stringSpans };
}

export function stripCommentsPreservingLines(raw) {
  return scanCommentsPreservingLines(raw, false, false).cleaned;
}

export function computeJsOuterStringSpans(raw) {
  return scanCommentsPreservingLines(raw, false, true).stringSpans || [];
}

export function isRealOpenTagAttrPos(markupCtx, idx) {
  if (!markupCtx || !Array.isArray(markupCtx.openTags)) return false;
  let tag = null;
  for (const t of markupCtx.openTags) {
    if (t.start < idx && idx < t.end && (!tag || t.end - t.start < tag.end - tag.start)) tag = t;
  }
  if (!tag) return false;
  if (tag.attrValueSpans?.some(([ss, se]) => idx >= ss && idx < se)) return false;
  if (tag.exprSpans?.some((ex) => idx >= ex.start && idx < ex.end)) return false;
  return true;
}

export function computeMarkupJsOuterStringSpans(raw, scanOptions = null, markupCtx = null) {
  const s = String(raw || "");
  if (!scanOptions) return computeJsOuterStringSpans(s);
  const ctx = markupCtx || scanMarkupContexts(s, scanOptions);
  const chars = s.split("");
  let modified = false;
  for (const m of s.matchAll(/(?<![a-zA-Z0-9_-])(?::|v-bind:)style\s*=\s*(["'])/gi)) {
    let tag = null;
    for (const t of ctx.openTags || []) {
      if (t.start < m.index && m.index < t.end && (!tag || t.end - t.start < tag.end - tag.start)) tag = t;
    }
    if (!tag) continue;
    if (tag.attrValueSpans?.some(([ss, se]) => m.index >= ss && m.index < se)) continue;
    if (tag.exprSpans?.some((ex) => m.index >= ex.start && m.index < ex.end)) continue;
    const qIdx = m.index + m[0].length - 1;
    const valSpan = tag.attrValueSpans?.find(([qs, qe]) => qs === qIdx && qe > qs + 1);
    if (valSpan) {
      chars[valSpan[0]] = " ";
      chars[valSpan[1] - 1] = " ";
      modified = true;
    }
  }
  return computeJsOuterStringSpans(modified ? chars.join("") : s);
}

export function blankStyledTemplateCustomPropsPreservingLines(src) {
  const s = String(src || "");
  const chars = s.split("");
  const skipTsGen = (startCur) => {
    let cur = startCur;
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    if (s[cur] !== "<") return { cur, ok: true };
    let angle = 0;
    let brace = 0;
    let q = null;
    const limit = Math.min(s.length, cur + 800);
    while (cur < limit) {
      const c = s[cur];
      if (q) {
        if (c === "\\" && cur + 1 < limit) { cur += 2; continue; }
        if (c === q || (q !== "`" && c === "\n")) q = null;
        cur++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") brace++;
      else if (c === "}") brace = Math.max(0, brace - 1);
      else if (c === "<" && brace === 0) angle++;
      else if (c === ">" && s[cur - 1] !== "=" && brace === 0) {
        angle--;
        if (angle === 0) { cur++; break; }
      } else if (c === ";" && brace === 0 && angle <= 0) break;
      cur++;
    }
    if (angle !== 0) return { cur: startCur, ok: false };
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    return { cur, ok: true };
  };
  for (const m of s.matchAll(/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b|\bkeyframes\b)\s*/g)) {
    let cur = m.index + m[0].length;
    if (/^styled(?:\s|$)/.test(m[0]) && s[cur] === "(") {
      const endP = findBalancedDelimEndSimple(s, cur, "(", ")");
      if (endP === -1) continue;
      cur = endP + 1;
      while (cur < s.length && /\s/.test(s[cur])) cur++;
    }
    while (cur < s.length) {
      const chainM = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(s.slice(cur, cur + 64));
      if (!chainM) break;
      cur += chainM[0].length;
      const gC = skipTsGen(cur);
      if (!gC.ok) { cur = -1; break; }
      cur = gC.cur;
      if (s[cur] === "(") {
        const endC = findBalancedDelimEndSimple(s, cur, "(", ")");
        if (endC === -1) { cur = -1; break; }
        cur = endC + 1;
        while (cur < s.length && /\s/.test(s[cur])) cur++;
      }
    }
    if (cur === -1) continue;
    const gT = skipTsGen(cur);
    if (!gT.ok) continue;
    cur = gT.cur;
    if (s[cur] !== "`") continue;
    let tEnd = -1;
    let ti = cur + 1;
    while (ti < s.length) {
      const ch = s[ti];
      if (ch === "\\" && ti + 1 < s.length) { ti += 2; continue; }
      if (ch === "$" && s[ti + 1] === "{") {
        const endE = findBalancedDelimEndSimple(s, ti + 1, "{", "}");
        if (endE === -1) break;
        ti = endE + 1;
        continue;
      }
      if (ch === "`") { tEnd = ti; break; }
      ti++;
    }
    if (tEnd === -1) continue;
    let k = cur + 1;
    let cssQ = null;
    while (k < tEnd) {
      const ch = s[k];
      if (cssQ) {
        if (ch === "\\" && k + 1 < tEnd) { k += 2; continue; }
        if (ch === "$" && s[k + 1] === "{") {
          const endE = findBalancedDelimEndSimple(s, k + 1, "{", "}");
          if (endE === -1 || endE >= tEnd) break;
          k = endE + 1;
          continue;
        }
        if (ch === cssQ || ch === "\n") cssQ = null;
        k++;
        continue;
      }
      if (ch === "$" && s[k + 1] === "{") {
        const endE = findBalancedDelimEndSimple(s, k + 1, "{", "}");
        if (endE === -1 || endE >= tEnd) break;
        k = endE + 1;
        continue;
      }
      if (ch === '"' || ch === "'") { cssQ = ch; k++; continue; }
      if (ch === "-" && s[k + 1] === "-") {
        const prev = k > cur + 1 ? s[k - 1] : "";
        if (!/[a-zA-Z0-9_.&$-]/.test(prev)) {
          const dm = /^--[a-zA-Z0-9_-]+\s*:(?!:)/.exec(s.slice(k, Math.min(tEnd, k + 128)));
          if (dm) {
            let j = k + dm[0].length;
            let parenDepth = 0;
            let interpDepth = 0;
            let declQuote = null;
            let stop = tEnd;
            while (j < tEnd) {
              const dc = s[j];
              if (declQuote) {
                if (dc === "\\" && j + 1 < tEnd) { j += 2; continue; }
                if (dc === "$" && s[j + 1] === "{") {
                  const endE = findBalancedDelimEndSimple(s, j + 1, "{", "}");
                  if (endE !== -1 && endE < tEnd) { j = endE + 1; continue; }
                }
                if (dc === declQuote || dc === "\n") declQuote = null;
                j++;
                continue;
              }
              if (dc === "$" && s[j + 1] === "{") {
                const endE = findBalancedDelimEndSimple(s, j + 1, "{", "}");
                if (endE !== -1 && endE < tEnd) { j = endE + 1; continue; }
              }
              if (dc === '"' || dc === "'") { declQuote = dc; j++; continue; }
              if (dc === "(") parenDepth++;
              else if (dc === ")") {
                if (parenDepth === 0 && interpDepth === 0) {
                  stop = j;
                  break;
                }
                parenDepth = Math.max(0, parenDepth - 1);
              } else if (dc === "#" && s[j + 1] === "{") { interpDepth++; j += 2; continue; }
              else if (interpDepth > 0) {
                if (dc === "{") interpDepth++;
                else if (dc === "}") interpDepth--;
              } else if (dc === ";" && parenDepth === 0) {
                stop = j + 1;
                break;
              } else if ((dc === "{" || dc === "}") && parenDepth === 0) {
                stop = j;
                break;
              }
              j++;
            }
            maskRangePreservingLines(chars, k, stop);
            k = Math.max(k + 1, stop);
            continue;
          }
        }
      }
      k++;
    }
  }
  return chars.join("");
}

export function isValidJsObjKeyPos(str, idx) {
  const s = String(str || "");
  let b = idx - 1;
  while (b >= 0 && /[ \t\r\n]/.test(s[b])) b--;
  if (b < 0 || (s[b] !== "{" && s[b] !== ",")) return false;
  let openBrace = b;
  if (s[b] === ",") {
    let k = b - 1;
    let brD = 0;
    let pD = 0;
    let arrD = 0;
    let q = null;
    while (k >= 0) {
      const c = s[k];
      if (q) {
        if (q !== "`" && c === "\n") {
          q = null;
          k--;
          continue;
        }
        if (c === q) {
          let bs = 0;
          while (k - 1 - bs >= 0 && s[k - 1 - bs] === "\\") bs++;
          if (bs % 2 === 0) q = null;
        }
        k--;
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        k--;
        continue;
      }
      if (c === "`") {
        // Only treat unambiguous single-line uninterpolated backticks backward when no preceding `${`
        const seg = s.slice(Math.max(0, k - 200), k);
        const lastOpen = seg.lastIndexOf("`");
        if (lastOpen !== -1 && !seg.slice(lastOpen).includes("${")) {
          k = Math.max(0, k - 200) + lastOpen - 1;
          continue;
        }
        k--;
        continue;
      }
      if (c === "}") brD++;
      else if (c === "{") {
        if (brD > 0) brD--;
        else {
          openBrace = k;
          break;
        }
      } else if (c === ")") pD++;
      else if (c === "(") {
        if (pD > 0) pD--;
        else return false;
      } else if (c === "]") arrD++;
      else if (c === "[") {
        if (arrD > 0) arrD--;
        else return false;
      }
      k--;
    }
    if (k < 0) return false;
  }
  const before = s.slice(Math.max(0, openBrace - 28), openBrace).trimEnd();
  if (
    before !== "" &&
    (!/(?:[=([,{:?+&|!"']|\b(?:return|default|yield|await|throw|case))$/.test(before) || /=>$/.test(before))
  ) {
    return false;
  }
  if (s[b] === ",") {
    const between = s.slice(openBrace + 1, b);
    const openTags = [...between.matchAll(/<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/>])[^>]*>/g)].filter(
      (tm) => !/\/\s*>$/.test(tm[0])
    );
    if (openTags.length > 0) {
      const lastTag = openTags[openTags.length - 1];
      const safeTag = lastTag[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`</${safeTag}\\s*>`, "i").test(between.slice(lastTag.index + lastTag[0].length))) {
        return false;
      }
    }
  }
  return true;
}

export function canStartJsTemplateLiteral(src, backtickIdx, prevContextSrc = null, openMarkupOverride = null) {
  const s = String(src || "");
  const lsIdx = s.lastIndexOf("\n", backtickIdx - 1) + 1;
  const lPfx = s.slice(lsIdx, backtickIdx);
  const isJsOpPfx =
    /(?:[=([,{:?+&|!~;<]|=>|\b(?:return|throw|case|yield|await|of|in|typeof|void|delete|default|else|do))\s*$/.test(
      lPfx
    );
  const isGenericTpl = !isJsOpPfx && endsWithGenericTaggedTemplate(s, backtickIdx);
  const ctx =
    prevContextSrc !== null ? String(prevContextSrc) : s.slice(Math.max(0, backtickIdx - 4096), backtickIdx);
  if (openMarkupOverride !== null ? openMarkupOverride : isInsideOpenMarkupChildren(ctx)) return false;
  if (lPfx.trim() === "") {
    const before = ctx.trimEnd();
    if (before === "") return true;
    if (isGenericTpl) return true;
    return /(?:[=([,{:?+&|!~;<]|=>|\b(?:return|throw|case|yield|await|of|in|typeof|void|delete|default|else|do))$/.test(
      before
    );
  }
  if (isJsOpPfx || isGenericTpl) return true;
  const tagM = /(?:(?:^|[^\w$<>])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\))([ \t]*)$/.exec(lPfx);
  if (!tagM) return false;
  if (/(?:^|[^\w$])(?:if|else|for|while|with|do|try|finally)\s*$/.test(lPfx)) return false;
  if (tagM[1].length === 0) return true;
  const beforeTag = lPfx.slice(0, lPfx.length - (tagM[0].length - (tagM[0].startsWith(".") ? 0 : 0)));
  const strippedTag = lPfx.replace(/(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\))[ \t]*$/, "").trimEnd();
  const checkPfx = strippedTag === "" ? ctx.trimEnd() : strippedTag;
  return /(?:[=([,{:?+&|!~;<]|=>|\b(?:return|throw|case|yield|await|of|in|typeof|void|delete|default|else|do))$/.test(
    checkPfx
  );
}

const VOID_HTML_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function isInsideOpenMarkupChildren(ctx) {
  const s = String(ctx || "");
  if (!s.includes("<")) return false;
  const ctxStack = [];
  let quote = null;
  let lastSig = "";
  const parenStack = [];
  let i = 0;
  const topFrame = () => (ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : null);
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && s[i + 1] === "{") {
        ctxStack.push({ kind: "brace", isTpl: true });
        quote = null;
        lastSig = "{";
        i += 2;
        continue;
      }
      if (ch === quote || (quote !== "`" && ch === "\n")) {
        quote = null;
        lastSig = ch;
      }
      i++;
      continue;
    }
    const top = topFrame();
    if (top && top.kind === "markup") {
      if (ch === "{") {
        ctxStack.push({ kind: "brace", isTpl: false });
        lastSig = "{";
        i++;
        continue;
      }
      if (ch === "<") {
        const closeM = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)?\s*>/.exec(s.slice(i, i + 80));
        if (closeM) {
          const ct = (closeM[1] || "").toLowerCase();
          if (!ct) {
            if (top.kind === "markup") ctxStack.pop();
          } else {
            for (let k = ctxStack.length - 1; k >= 0; k--) {
              if (ctxStack[k].kind !== "markup") break;
              if (ctxStack[k].tag === ct) {
                ctxStack.length = k;
                break;
              }
            }
          }
          i += closeM[0].length;
          lastSig = ">";
          continue;
        }
        const tagRes = parseMarkupOpenTagCore(s, i, true);
        if (tagRes) {
          if (!tagRes.selfClosing) {
            if (tagRes.tag === "script") {
              const cm = /<\/script\s*>/gi;
              cm.lastIndex = tagRes.end;
              const hit = cm.exec(s);
              if (!hit) return false;
              i = hit.index + hit[0].length;
              lastSig = ">";
              continue;
            }
            if (tagRes.tag === "style") {
              const cm = /<\/style\s*>/gi;
              cm.lastIndex = tagRes.end;
              const hit = cm.exec(s);
              if (!hit) return false;
              i = hit.index + hit[0].length;
              lastSig = ">";
              continue;
            }
            if (!VOID_HTML_TAGS.has(tagRes.tag)) ctxStack.push({ kind: "markup", tag: tagRes.tag });
          }
          i = tagRes.end;
          lastSig = ">";
          continue;
        }
        const inc = inspectIncompleteOpenTagPrefix(s, i, true);
        if (inc) {
          return inc.exprStart === -1 ? false : isInsideOpenMarkupChildren(s.slice(inc.exprStart));
        }
      }
      i++;
      continue;
    }
    if (ch === "/") {
      const reEnd = skipJsRegexInExpr(s, i, lastSig, 0);
      if (reEnd !== -1) {
        i = reEnd;
        lastSig = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const isContract =
        ch === "'" && i > 0 && /[A-Za-z0-9]/.test(s[i - 1]) && i + 1 < s.length && /[A-Za-z]/.test(s[i + 1]);
      if (
        !isContract &&
        (ch !== "`" ||
          /(?:[=([,{:?+&|!~;<]|=>|\b(?:return|throw|case|yield|await|of|in|typeof|void|delete|default|else|do))\s*$/.test(
            s.slice(Math.max(0, i - 24), i)
          ) ||
          !/\s$/.test(s.slice(Math.max(0, i - 4), i)))
      ) {
        quote = ch;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(0, i - 16), i)));
      lastSig = "(";
    } else if (ch === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
    } else if (ch === "{") {
      ctxStack.push({ kind: "brace", isTpl: false });
      lastSig = "{";
    } else if (ch === "}") {
      if (top && top.kind === "brace") {
        const popped = ctxStack.pop();
        if (popped.isTpl) {
          quote = "`";
          i++;
          continue;
        }
      }
      lastSig = "}";
    } else if (ch === "<") {
      const prevChar = i > 0 ? s[i - 1] : "";
      const isJsKw =
        prevChar &&
        /[A-Za-z]/.test(prevChar) &&
        /(?:^|[^\w$.])(?:return|case|throw|else|default|yield|await|void)$/.test(s.slice(Math.max(0, i - 16), i));
      const blockedById = !isJsKw && /[A-Za-z0-9_$\]\])]/.test(prevChar);
      if (!blockedById) {
        const tagRes = parseMarkupOpenTagCore(s, i, true);
        if (tagRes) {
          if (!tagRes.selfClosing) {
            if (tagRes.tag === "script") {
              const cm = /<\/script\s*>/gi;
              cm.lastIndex = tagRes.end;
              const hit = cm.exec(s);
              if (!hit) return false;
              i = hit.index + hit[0].length;
              lastSig = ">";
              continue;
            }
            if (tagRes.tag === "style") {
              const cm = /<\/style\s*>/gi;
              cm.lastIndex = tagRes.end;
              const hit = cm.exec(s);
              if (!hit) return false;
              i = hit.index + hit[0].length;
              lastSig = ">";
              continue;
            }
            if (!VOID_HTML_TAGS.has(tagRes.tag)) ctxStack.push({ kind: "markup", tag: tagRes.tag });
          }
          i = tagRes.end;
          lastSig = ">";
          continue;
        }
        const inc = inspectIncompleteOpenTagPrefix(s, i, true);
        if (inc) {
          return inc.exprStart === -1 ? false : isInsideOpenMarkupChildren(s.slice(inc.exprStart));
        }
      }
      lastSig = "<";
    } else if (!/\s/.test(ch)) {
      lastSig = ch === ">" && i > 0 && s[i - 1] === "=" ? "=>" : ch;
    }
    i++;
  }
  const t = topFrame();
  return Boolean(t && t.kind === "markup");
}

export function findSvelteStyleDirectives(src) {
  const s = String(src || "");
  const out = [];
  const re = /(?<![a-zA-Z0-9_-])style:(--[a-zA-Z0-9_-]+|[a-z][a-z0-9-]*)(?:\|important)?\s*=\s*/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const prop = m[1];
    const isCustomProp = prop.startsWith("--");
    const valPos = m.index + m[0].length;
    const ch = s[valPos];
    if (ch === '"' || ch === "'") {
      let k = valPos + 1;
      while (k < s.length && s[k] !== ch) {
        if (s[k] === "{") {
          const eb = findBalancedDelimEndSimple(s, k, "{", "}");
          if (eb !== -1) {
            k = eb + 1;
            continue;
          }
        }
        k++;
      }
      if (k < s.length && s[k] === ch) {
        out.push({
          prop,
          isCustomProp,
          isExpr: false,
          start: m.index,
          end: k + 1,
          valStart: valPos + 1,
          valEnd: k,
          value: s.slice(valPos + 1, k),
        });
        re.lastIndex = k + 1;
      }
    } else if (ch === "{") {
      const endBrace = findBalancedDelimEndSimple(s, valPos, "{", "}");
      if (endBrace !== -1) {
        out.push({
          prop,
          isCustomProp,
          isExpr: true,
          start: m.index,
          end: endBrace + 1,
          valStart: valPos + 1,
          valEnd: endBrace,
          value: s.slice(valPos + 1, endBrace),
        });
        re.lastIndex = endBrace + 1;
      }
    }
  }
  return out;
}

export function endsWithGenericTaggedTemplate(src, backtickIdx) {
  const s = String(src || "");
  let gk = backtickIdx - 1;
  while (gk >= 0 && /[ \t\r\n]/.test(s[gk])) gk--;
  if (gk < 0 || s[gk] !== ">" || s[gk - 1] === "=" || s[gk - 1] === "/") return false;
  gk--;
  let angle = 1;
  let brace = 0;
  let paren = 0;
  let brack = 0;
  let gnl = 0;
  while (gk >= 0 && angle > 0) {
    const gc = s[gk];
    if (gc === "\n") {
      gnl++;
      if (gnl > 40) return false;
      gk--;
      continue;
    }
    if (gc === "`") {
      const winStart = Math.max(0, gk - 800);
      let matchedOpen = -1;
      let scanQ = null;
      for (let cand = winStart; cand < gk; cand++) {
        const sc = s[cand];
        if (scanQ) {
          if (sc === "\\" && cand + 1 < gk) {
            cand++;
            continue;
          }
          if (sc === scanQ || sc === "\n") scanQ = null;
          continue;
        }
        if (sc === '"' || sc === "'") {
          scanQ = sc;
          continue;
        }
        if (sc !== "`") continue;
        let f = cand + 1;
        let ok = true;
        while (f < gk) {
          if (s[f] === "\\" && f + 1 < gk) {
            f += 2;
            continue;
          }
          if (s[f] === "$" && s[f + 1] === "{") {
            const be = findBalancedDelimEndSimple(s, f + 1, "{", "}");
            if (be === -1 || be >= gk) {
              ok = false;
              break;
            }
            f = be + 1;
            continue;
          }
          if (s[f] === "`") {
            ok = false;
            break;
          }
          f++;
        }
        if (ok && f === gk) {
          matchedOpen = cand;
          break;
        }
      }
      if (matchedOpen === -1) return false;
      gnl += (s.slice(matchedOpen, gk).match(/\n/g) || []).length;
      if (gnl > 40) return false;
      gk = matchedOpen - 1;
      continue;
    }
    if (gc === '"' || gc === "'") {
      gk--;
      while (gk >= 0) {
        if (s[gk] === "\n") return false;
        if (s[gk] === gc) {
          let bs = 0;
          while (gk - 1 - bs >= 0 && s[gk - 1 - bs] === "\\") bs++;
          if (bs % 2 === 0) break;
        }
        gk--;
      }
      if (gk < 0) return false;
      gk--;
      continue;
    }
    if (gc === "}") brace++;
    else if (gc === "{") { if (brace > 0) brace--; else return false; }
    else if (gc === ")") paren++;
    else if (gc === "(") { if (paren > 0) paren--; else return false; }
    else if (gc === "]") brack++;
    else if (gc === "[") { if (brack > 0) brack--; else return false; }
    else if (brace === 0 && paren === 0 && brack === 0) {
      if (gc === ">" && gk > 0 && s[gk - 1] === "=") { gk -= 2; continue; }
      if (gc === ";") return false;
      if (gc === ">") angle++;
      else if (gc === "<") {
        angle--;
        if (angle === 0) break;
      }
    }
    gk--;
  }
  if (angle !== 0 || gk < 1 || s[gk] !== "<" || s[gk + 1] === "/") return false;
  const bk = gk - 1;
  if (!/[A-Za-z0-9_$)\]]/.test(s[bk])) return false;
  let idS = bk;
  while (idS > 0 && /[A-Za-z0-9_$]/.test(s[idS - 1])) idS--;
  const ident = s.slice(idS, bk + 1);
  return !/^(?:if|else|for|while|with|do|try|finally|return|case|throw)$/.test(ident);
}

/**
 * Blank CSS custom property declarations (`--name: ...;`) while preserving newlines,
 * skipping quoted `--var:` substrings and respecting nested parentheses (e.g. `color-mix(..., var(..., rgb(...)))`).
 */
export function blankCssCustomPropDeclsPreservingLines(cssSlice, opts = {}) {
  const allowBracedExpr = Boolean(opts?.allowBracedExpr);
  const s = String(cssSlice || "");
  const chars = s.split("");
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (allowBracedExpr && ch === "{") {
        const endB = findBalancedDelimEndSimple(s, i, "{", "}");
        if (endB !== -1) {
          i = endB + 1;
          continue;
        }
      }
      if (ch === quote || ch === "\n") quote = null;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (allowBracedExpr && ch === "{") {
      const endB = findBalancedDelimEndSimple(s, i, "{", "}");
      if (endB !== -1) {
        i = endB + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "-" && s[i + 1] === "-") {
      const prev = i > 0 ? s[i - 1] : "";
      if (!/[a-zA-Z0-9_.&$-]/.test(prev)) {
        const m = /^--[a-zA-Z0-9_-]+\s*:(?!:)/.exec(s.slice(i, i + 128));
        if (m) {
          let j = i + m[0].length;
          let parenDepth = 0;
          let interpDepth = 0;
          let declQuote = null;
          let stop = s.length;
          while (j < s.length) {
            const dc = s[j];
            if (declQuote) {
              if (dc === "\\" && j + 1 < s.length) {
                j += 2;
                continue;
              }
              if (allowBracedExpr && dc === "{") {
                const endB = findBalancedDelimEndSimple(s, j, "{", "}");
                if (endB !== -1) {
                  j = endB + 1;
                  continue;
                }
              }
              if (dc === declQuote || dc === "\n") declQuote = null;
              j++;
              continue;
            }
            if (allowBracedExpr && dc === "{" && interpDepth === 0) {
              const endB = findBalancedDelimEndSimple(s, j, "{", "}");
              if (endB !== -1) {
                j = endB + 1;
                continue;
              }
            }
            if (dc === '"' || dc === "'") {
              declQuote = dc;
              j++;
              continue;
            }
            if (dc === "#" && s[j + 1] === "{") {
              interpDepth++;
              j += 2;
              continue;
            }
            if (dc === "(") {
              parenDepth++;
              j++;
              continue;
            }
            if (dc === ")") {
              if (parenDepth === 0 && interpDepth === 0) {
                stop = j;
                break;
              }
              parenDepth--;
              j++;
              continue;
            }
            if (dc === "}" && interpDepth > 0) {
              interpDepth--;
              j++;
              continue;
            }
            if ((dc === ";" || dc === "}" || dc === "{") && parenDepth === 0 && interpDepth === 0) {
              stop = dc === ";" ? j + 1 : j;
              break;
            }
            j++;
          }
          maskRangePreservingLines(chars, i, stop);
          i = stop;
          continue;
        }
      }
    }
    i++;
  }
  return chars.join("");
}

export function findHardcodedColorFunctions(src) {
  const s = String(src || "");
  const out = [];
  const headRe = /\b(rgba?|hsla?|hwb|lch|oklch|lab|oklab|color-mix|color)\(/gi;
  let cursor = 0;
  let m;
  while ((m = headRe.exec(s)) !== null) {
    if (m.index < cursor) continue;
    const prev = m.index > 0 ? s[m.index - 1] : "";
    if (prev === "." || prev === "$" || prev === "-") continue;
    const fnName = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let q = null;
    let i = openIdx + 1;
    let aborted = false;
    const hardStop = Math.min(s.length, openIdx + 512);
    while (i < hardStop && depth > 0) {
      const ch = s[i];
      if (q) {
        if (ch === "\\" && i + 1 < hardStop) {
          i += 2;
          continue;
        }
        if (ch === q || ch === "\n") q = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        i++;
        continue;
      }
      if (ch === ";" || ch === "{" || ch === "}" || ch === "<" || ch === ">") {
        aborted = true;
        break;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (aborted || depth !== 0) {
      cursor = openIdx + 1;
      headRe.lastIndex = cursor;
      continue;
    }
    const full = s.slice(m.index, i);
    const inner = s.slice(openIdx + 1, i - 1).trim();
    cursor = i;
    headRe.lastIndex = cursor;
    if (!inner || /^["']/.test(inner)) continue;
    if (fnName === "color") {
      if (!/^(?:srgb|srgb-linear|display-p3(?:-linear)?|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?|--[a-z0-9_-]+)\s+(?=[\d.+-]|none\b|(?:calc|min|max|clamp|var)\()/i.test(inner)) {
        continue;
      }
    } else if (fnName === "color-mix") {
      if (!/^in\s+[a-z0-9-]+\b/i.test(inner) || !inner.includes(",")) {
        continue;
      }
    } else if (!/(?:\d|from\s+|none\b|calc\(|var\()/i.test(inner)) {
      continue;
    }
    out.push({ index: m.index, text: full });
  }
  return out;
}

export function isTokenizedColorFn(fnText) {
  return /\bvar\(\s*--/i.test(fnText);
}

function isJsxStartAllowedAt(src, ltIdx, lastSig, minStart = 0) {
  if (lastSig === "" || lastSig === "control)") return true;
  const pre96 = src.slice(Math.max(minStart, ltIdx - 96), ltIdx);
  if (lastSig === ">") {
    return /(?:=>|\/>|<\/[A-Za-z0-9_.:-]*\s*>)\s*$/.test(pre96);
  }
  if (lastSig === "+" || lastSig === "-") {
    const preTrim = pre96.trimEnd();
    if (preTrim.endsWith("++") || preTrim.endsWith("--")) return false;
    return lastSig === "+";
  }
  if (lastSig === "!") {
    const beforeBang = pre96.trimEnd().replace(/!+\s*$/, "").trimEnd();
    if (
      beforeBang &&
      /[A-Za-z0-9_$\])'"`]$/.test(beforeBang) &&
      !/(?:^|[^\w$.])(?:return|case|throw|else|default|yield|await|void|typeof|in|of|instanceof|new|delete)$/.test(beforeBang)
    ) {
      return false;
    }
    return true;
  }
  if (/[=([,:;?&|{}]/.test(lastSig)) return true;
  return /(?:^|[^\w$.])(?:return|case|throw|else|default|yield|await|void)\s*$|=>\s*$/.test(
    src.slice(Math.max(minStart, ltIdx - 24), ltIdx)
  );
}

function findBalancedDelimEndSimple(s, openIdx, openCh, closeCh, allowJsx = false) {
  let depth = 1;
  let quote = null;
  let lastSig = openCh;
  const parenStack = [];
  const jsxStack = [];
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i];
    if (jsxStack.length > 0) {
      if (ch === "{") {
        const sub = findBalancedDelimEndSimple(s, i, "{", "}", true);
        if (sub === -1) return -1;
        i = sub;
        lastSig = "}";
        continue;
      }
      if (ch === "<" && s[i + 1] === "/") {
        const closeM = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)?\s*>/.exec(s.slice(i, Math.min(s.length, i + 80)));
        if (closeM) {
          const cTag = (closeM[1] || "").toLowerCase();
          if (!cTag) jsxStack.pop();
          else {
            for (let k = jsxStack.length - 1; k >= 0; k--) {
              if (jsxStack[k] === cTag) {
                jsxStack.length = k;
                break;
              }
            }
          }
          i += closeM[0].length - 1;
          if (jsxStack.length === 0) lastSig = ">";
          continue;
        }
      }
      if (ch === "<" && s.startsWith("<!--", i)) {
        const ce = s.indexOf("-->", i + 4);
        if (ce === -1) return -1;
        i = ce + 2;
        continue;
      }
      if (ch === "<") {
        if (s.startsWith("<>", i)) {
          jsxStack.push("");
          i += 1;
          continue;
        }
        const tagObj = parseMarkupOpenTagCore(s, i, true);
        if (tagObj) {
          const isVoidHtml = /^[a-z]/.test(s[i + 1] || "") && VOID_HTML_TAGS.has(tagObj.tag);
          if (!tagObj.selfClosing && !isVoidHtml) jsxStack.push(tagObj.tag);
          i = tagObj.end - 1;
          continue;
        }
      }
      continue;
    }
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (quote === "`" && ch === "$" && s[i + 1] === "{") {
        const subEnd = findBalancedDelimEndSimple(s, i + 1, "{", "}", allowJsx);
        if (subEnd === -1) return -1;
        i = subEnd;
        lastSig = "}";
        continue;
      }
      if (ch === quote || (quote !== "`" && ch === "\n")) {
        if (ch !== "\n") lastSig = ch;
        quote = null;
      }
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const ce = s.indexOf("*/", i + 2);
      if (ce === -1) return -1;
      i = ce + 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i + 2);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    const reEnd = skipJsRegexInExpr(s, i, lastSig, openIdx + 1);
    if (reEnd !== -1) {
      i = reEnd - 1;
      lastSig = "/";
      continue;
    }
    if (allowJsx && ch === "<" && isJsxStartAllowedAt(s, i, lastSig, openIdx + 1)) {
      if (s.startsWith("<>", i)) {
        jsxStack.push("");
        i += 1;
        continue;
      }
      const tagObj = parseMarkupOpenTagCore(s, i, true);
      if (tagObj) {
        const isVoidHtml = /^[a-z]/.test(s[i + 1] || "") && VOID_HTML_TAGS.has(tagObj.tag);
        if (!tagObj.selfClosing && !isVoidHtml) jsxStack.push(tagObj.tag);
        else lastSig = ">";
        i = tagObj.end - 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(openIdx + 1, i - 16), i)));
      if (openCh === "(") depth++;
      lastSig = "(";
    } else if (ch === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      if (closeCh === ")") {
        depth--;
        if (depth === 0) return i;
      }
    } else if (ch === openCh) {
      depth++;
      lastSig = ch;
    } else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
      lastSig = ch;
    } else if (!/\s/.test(ch)) {
      lastSig = ch;
    }
  }
  return -1;
}

function isCssTaggedTemplateAt(s, btIdx, minStart) {
  let gk = btIdx - 1;
  while (gk >= minStart && /\s/.test(s[gk])) gk--;
  if (gk < minStart) return false;
  if (s[gk] === ">" && s[gk - 1] !== "=" && s[gk - 1] !== "/") {
    if (!endsWithGenericTaggedTemplate(s, btIdx)) return false;
    gk--;
    let angle = 1;
    let brace = 0;
    let paren = 0;
    let brack = 0;
    while (gk >= minStart && angle > 0) {
      const c = s[gk];
      if (c === "}") brace++;
      else if (c === "{") brace = Math.max(0, brace - 1);
      else if (c === ")") paren++;
      else if (c === "(") paren = Math.max(0, paren - 1);
      else if (c === "]") brack++;
      else if (c === "[") brack = Math.max(0, brack - 1);
      else if (brace === 0 && paren === 0 && brack === 0) {
        if (c === ">") angle++;
        else if (c === "<") {
          angle--;
          if (angle === 0) break;
        }
      }
      gk--;
    }
    if (angle !== 0 || gk <= minStart) return false;
    gk--;
    while (gk >= minStart && /\s/.test(s[gk])) gk--;
  }
  while (gk >= minStart && s[gk] === ")") {
    let p = 1;
    let k = gk - 1;
    while (k >= minStart && p > 0) {
      if (s[k] === ")") p++;
      else if (s[k] === "(") p--;
      k--;
    }
    if (p !== 0) break;
    const prefix = s.slice(Math.max(minStart, k - 48), k + 1);
    if (/(?:styled|\.(?:attrs|withConfig))\s*$/.test(prefix)) {
      if (/styled\s*$/.test(prefix)) return true;
      gk = k;
      while (gk >= minStart && /\s/.test(s[gk])) gk--;
      const chainCut = s.slice(minStart, gk + 1).replace(/\s*\.(?:attrs|withConfig)\s*$/, "");
      gk = minStart + chainCut.length - 1;
      continue;
    }
    break;
  }
  const head = s.slice(Math.max(minStart, gk - 64), gk + 1);
  return /(?:^|[^A-Za-z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+)?|css|createGlobalStyle)$/.test(head);
}

function copyStringLiteralsPreservingLines(s, start, end, copySpan) {
  let i = start;
  let quote = null;
  let skipQuote = false;
  let isObjKeyQuote = false;
  let segStart = start;
  let lastSig = "{";
  const parenStack = [];
  const tplBraces = [];
  const tplSkips = [];
  const braceEntries = [{ entryStart: start, p: 0, b: 0 }];
  const findTrailingCompEq = (posAfterQuote) =>
    /^[ \t\r\n]*(?:===?|!==?)/.test(s.slice(posAfterQuote, Math.min(end, posAfterQuote + 16)));
  while (i < end) {
    const ch = s[i];
    const next = i + 1 < end ? s[i + 1] : "";
    const topEntry = braceEntries[braceEntries.length - 1];
    if (quote) {
      if (ch === "\\" && i + 1 < end) {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        if (!skipQuote) copySpan(segStart, i);
        tplBraces.push(0);
        tplSkips.push(skipQuote);
        braceEntries.push({ entryStart: i + 2, p: 0, b: 0 });
        quote = null;
        skipQuote = false;
        isObjKeyQuote = false;
        lastSig = "{";
        i += 2;
        continue;
      }
      if (ch === quote || (quote !== "`" && ch === "\n")) {
        const isCompRhsCompare = ch === quote && findTrailingCompEq(i + 1);
        const isObjKey =
          ch === quote &&
          isObjKeyQuote &&
          (topEntry.b === 0
            ? /^[ \t\r\n]*:(?!:)/.test(s.slice(i + 1, Math.min(end, i + 16)))
            : /^[ \t\r\n]*\][ \t\r\n]*:(?!:)/.test(s.slice(i + 1, Math.min(end, i + 24))));
        if (!skipQuote && !isCompRhsCompare && !isObjKey) copySpan(segStart, i);
        if (ch !== "\n") lastSig = ch;
        quote = null;
        skipQuote = false;
        isObjKeyQuote = false;
      }
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const ce = s.indexOf("*/", i + 2);
      i = ce === -1 || ce + 2 > end ? end : ce + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = s.indexOf("\n", i + 2);
      i = nl === -1 || nl + 1 > end ? end : nl + 1;
      continue;
    }
    const reEnd = skipJsRegexInExpr(s, i, lastSig, start);
    if (reEnd !== -1 && reEnd <= end) {
      i = reEnd;
      lastSig = "/";
      continue;
    }
    if (ch === "`" && isCssTaggedTemplateAt(s, i, start)) {
      let tk = i + 1;
      while (tk < end) {
        if (s[tk] === "\\" && tk + 1 < end) {
          tk += 2;
          continue;
        }
        if (s[tk] === "$" && s[tk + 1] === "{") {
          const be = findBalancedDelimEndSimple(s, tk + 1, "{", "}");
          if (be === -1 || be >= end) {
            tk = end;
            break;
          }
          tk = be + 1;
          continue;
        }
        if (s[tk] === "`") {
          tk++;
          break;
        }
        tk++;
      }
      lastSig = "`";
      i = tk;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const entryPfx = s.slice(topEntry.entryStart, i);
      const beforeQuote = s.slice(Math.max(start, i - 16), i).replace(/[ \t\r\n]+$/, "");
      const isCompLhsCompare = /(?:===?|!==?)$/.test(beforeQuote);
      isObjKeyQuote =
        (topEntry.p === 0 && topEntry.b === 0 && /^\s*$/.test(entryPfx)) ||
        (topEntry.p === 0 && topEntry.b === 1 && /^\s*\[\s*$/.test(entryPfx));
      skipQuote =
        tplSkips.some(Boolean) ||
        /^\s*(?:["']content["']|content)\s*:/i.test(entryPfx) ||
        isCompLhsCompare;
      quote = ch;
      segStart = i + 1;
      i++;
      continue;
    }
    if (ch === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(start, i - 16), i)));
      topEntry.p++;
      lastSig = "(";
    } else if (ch === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      topEntry.p = Math.max(0, topEntry.p - 1);
    } else if (ch === "[") {
      topEntry.b++;
      lastSig = "[";
    } else if (ch === "]") {
      topEntry.b = Math.max(0, topEntry.b - 1);
      lastSig = "]";
    } else if (ch === "{" && tplBraces.length > 0 && tplBraces[tplBraces.length - 1] >= 0) {
      tplBraces[tplBraces.length - 1]++;
      braceEntries.push({ entryStart: i + 1, p: 0, b: 0 });
      lastSig = "{";
    } else if (ch === "{" ) {
      braceEntries.push({ entryStart: i + 1, p: 0, b: 0 });
      lastSig = "{";
    } else if (ch === "}" && tplBraces.length > 0 && tplBraces[tplBraces.length - 1] === 0) {
      if (braceEntries.length > 1) braceEntries.pop();
      tplBraces.pop();
      skipQuote = Boolean(tplSkips.pop());
      isObjKeyQuote = false;
      quote = "`";
      segStart = i + 1;
      i++;
      continue;
    } else if (ch === "}") {
      if (braceEntries.length > 1) braceEntries.pop();
      if (tplBraces.length > 0) tplBraces[tplBraces.length - 1]--;
      lastSig = "}";
    } else if (ch === "," && topEntry.p === 0 && topEntry.b === 0) {
      topEntry.entryStart = i + 1;
      lastSig = ",";
    } else if (!/\s/.test(ch)) {
      lastSig = ch;
    }
    i++;
  }
  if (quote && !skipQuote) copySpan(segStart, end);
}

export function maskCssQuotedStringsPreservingLines(src, fillChar = " ") {
  const s = String(src || "");
  const chars = s.split("");
  const fill = String(fillChar || " ")[0] || " ";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) {
        if (chars[i] !== "\n") chars[i] = fill;
        if (chars[i + 1] !== "\n") chars[i + 1] = fill;
        i++;
        continue;
      }
      if (ch === quote || ch === "\n") {
        if (chars[i] !== "\n") chars[i] = fill;
        quote = null;
        continue;
      }
      if (chars[i] !== "\n") chars[i] = fill;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      chars[i] = fill;
    }
  }
  return chars.join("");
}

/**
 * Extract only CSS/style contexts from non-style UI files (`<style>`, HTML `style="..."`,
 * JSX `style={{ ... }}` / Vue `:style="..."` string literals, and `styled`/`css` template literals
 * excluding `${...}` JS expressions) while preserving exact character offsets and newlines.
 */
export function findScriptCloseRaw(src, bodyStart) {
  const s = String(src || "");
  let i = bodyStart;
  let q = null;
  let lastSig = "";
  const tplExprStack = [];
  const parenStack = [];
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (q) {
      if (ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (q === "`" && ch === "$" && next === "{") {
        tplExprStack.push(0);
        q = null;
        lastSig = "{";
        i += 2;
        continue;
      }
      if (ch === q || (q !== "`" && ch === "\n")) {
        q = null;
        lastSig = ch;
      }
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const ce = s.indexOf("*/", i + 2);
      if (ce === -1) return null;
      i = ce + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const eol = s.indexOf("\n", i + 2);
      if (eol === -1) return null;
      i = eol + 1;
      lastSig = "";
      continue;
    }
    if (ch === "/") {
      const reEnd = skipJsRegexInExpr(s, i, lastSig, bodyStart);
      if (reEnd !== -1) {
        i = reEnd;
        lastSig = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      lastSig = ch;
      i++;
      continue;
    }
    if (ch === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(bodyStart, i - 16), i)));
      lastSig = "(";
      i++;
      continue;
    }
    if (ch === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      i++;
      continue;
    }
    if (ch === "{") {
      if (tplExprStack.length > 0) tplExprStack[tplExprStack.length - 1]++;
      lastSig = "{";
      i++;
      continue;
    }
    if (ch === "}") {
      if (tplExprStack.length > 0) {
        if (tplExprStack[tplExprStack.length - 1] === 0) {
          tplExprStack.pop();
          q = "`";
          i++;
          continue;
        }
        tplExprStack[tplExprStack.length - 1]--;
      }
      lastSig = "}";
      i++;
      continue;
    }
    if (ch === "<" && next === "/") {
      const cm = /^<\/script\s*>/i.exec(s.slice(i, i + 20));
      if (cm) return { closeStart: i, closeEnd: i + cm[0].length };
    }
    if (!/\s/.test(ch)) {
      lastSig = ch === ">" && i > bodyStart && s[i - 1] === "=" ? "=>" : ch;
    }
    i++;
  }
  return null;
}

export function findStyleCloseRaw(src, bodyStart, isScss) {
  const s = String(src || "");
  let i = bodyStart;
  let q = null;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (q) {
      if (ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (ch === q || ch === "\n") q = null;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const ce = s.indexOf("*/", i + 2);
      if (ce === -1) return null;
      i = ce + 2;
      continue;
    }
    if (isScss && (ch === "u" || ch === "U") && (i === bodyStart || !/[a-zA-Z0-9_-]/.test(s[i - 1]))) {
      const um = /^url\s*\(/i.exec(s.slice(i, i + 16));
      if (um) {
        let uj = i + um[0].length;
        while (uj < s.length && /\s/.test(s[uj])) uj++;
        if (uj < s.length && s[uj] !== '"' && s[uj] !== "'") {
          let validUrl = true;
          while (uj < s.length && s[uj] !== ")") {
            if (s[uj] === "\\" && uj + 1 < s.length) {
              uj += 2;
              continue;
            }
            if (s[uj] === "#" && s[uj + 1] === "{") {
              let ib = 1;
              let iq = null;
              let ip = uj + 2;
              while (ip < s.length && ib > 0) {
                const uc = s[ip];
                if (iq) {
                  if (uc === "\\" && ip + 1 < s.length) ip += 2;
                  else {
                    if (uc === iq || uc === "\n") iq = null;
                    ip++;
                  }
                  continue;
                }
                if (uc === '"' || uc === "'") iq = uc;
                else if (uc === "{") ib++;
                else if (uc === "}") ib--;
                ip++;
              }
              if (ib !== 0) {
                validUrl = false;
                break;
              }
              uj = ip;
              continue;
            }
            if (s[uj] === "\n" || s[uj] === "{" || s[uj] === "}" || s.startsWith("/*", uj)) {
              validUrl = false;
              break;
            }
            uj++;
          }
          if (validUrl && uj < s.length && s[uj] === ")") {
            i = uj + 1;
            continue;
          }
        }
      }
    }
    if (isScss && ch === "/" && next === "/") {
      const prev = i === bodyStart ? "\n" : s[i - 1];
      const beforeColon = s.slice(Math.max(bodyStart, i - 32), i);
      const isSchemeUrl =
        prev === ":" &&
        /(?:^|[^a-zA-Z0-9_$-])(?:https?|ftp|sftp|ftps|file|ws|wss|mailto|data|blob|chrome(?:-extension)?|moz-extension|edge|safari|about|app|vscode|capacitor|tauri|ionic|s3|gs|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|ssh|git|npm|yarn|pnpm|docker|oci|ircs?|ldaps?):$/i.test(
          beforeColon
        ) &&
        i + 2 < s.length &&
        /[A-Za-z0-9/[._~-]/.test(s[i + 2]);
      const isProtoUrlAfterEq = prev === "=" && /^\/\/[A-Za-z0-9._-]+\//.test(s.slice(i, i + 64));
      if (isSchemeUrl || isProtoUrlAfterEq) {
        i += 2;
        continue;
      }
      const eol = s.indexOf("\n", i + 2);
      if (eol === -1) return null;
      i = eol + 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      i++;
      continue;
    }
    if (ch === "<" && next === "/") {
      const cm = /^<\/style\s*>/i.exec(s.slice(i, i + 20));
      if (cm) return { closeStart: i, closeEnd: i + cm[0].length };
    }
    i++;
  }
  return null;
}

export function extractRealStyleBlocks(src, markupCtx = null, scanOptions = {}) {
  const s = String(src || "");
  const ctx = markupCtx || scanMarkupContexts(s, scanOptions);
  const blocks = [];
  for (const tag of ctx.openTags) {
    if (tag.tag !== "style" || tag.selfClosing) continue;
    const openTagRaw = s.slice(tag.start, tag.end);
    const isScss = /\blang\s*=\s*["']s[ca]ss["']/i.test(openTagRaw);
    const isScoped = /\bscoped\b/i.test(openTagRaw);
    const closeInfo = findStyleCloseRaw(s, tag.end, isScss);
    if (!closeInfo) continue;
    blocks.push({
      openStart: tag.start,
      openEnd: tag.end,
      bodyStart: tag.end,
      bodyEnd: closeInfo.closeStart,
      closeEnd: closeInfo.closeEnd,
      text: s.slice(tag.end, closeInfo.closeStart),
      isScss,
      isScoped,
    });
  }
  return blocks;
}

export function extractImportantStyleSurfacePreservingLines(surface, isStyle, options = {}) {
  const s = String(surface || "");
  if (isStyle) return maskCssQuotedStringsPreservingLines(s);
  const sForCtx = options.markupCtx ? s : stripCommentsPreservingLines(s);
  const ctx = options.markupCtx || scanMarkupContexts(sForCtx, options);
  const chars = sForCtx.split("").map((c) => (c === "\n" ? "\n" : " "));
  const copySpan = (start, end) => {
    for (let k = start; k < end && k < sForCtx.length; k++) chars[k] = sForCtx[k];
  };
  const copyCssSpanMasked = (start, end) => {
    const masked = maskCssQuotedStringsPreservingLines(sForCtx.slice(start, end));
    for (let k = 0; k < masked.length && start + k < sForCtx.length; k++) chars[start + k] = masked[k];
  };
  const inSpans = (idx, spans) => spans.some(([a, b]) => idx >= a && idx < b);
  const inAttrValueSpan = (idx) =>
    ctx.openTags.some((tag) => idx > tag.start && idx < tag.end && tag.attrValueSpans.some(([as, ae]) => idx >= as && idx < ae));
  const inRealTagAttrNamePos = (idx) =>
    ctx.openTags.some(
      (tag) =>
        idx > tag.start &&
        idx < tag.end &&
        !tag.attrValueSpans.some(([as, ae]) => idx >= as && idx < ae) &&
        !tag.exprSpans.some((ex) => idx >= ex.innerStart && idx < ex.innerEnd)
    );

  for (const blk of extractRealStyleBlocks(sForCtx, ctx, options)) {
    copyCssSpanMasked(blk.bodyStart, blk.bodyEnd);
  }
  const copyDirectiveImportant = (m) => {
    const impMod = m.groups?.imp;
    if (!impMod) return;
    const rel = m[0].indexOf(impMod);
    if (rel === -1) return;
    const abs = m.index + rel;
    const rep = "!important";
    for (let i = 0; i < rep.length; i++) chars[abs + i] = rep[i];
  };
  for (const m of sForCtx.matchAll(/(?<![a-zA-Z0-9_-])style(?::(?:--[a-zA-Z0-9_-]+|[a-z][a-z0-9-]*)(?<imp>\|important)?)?\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if (!inRealTagAttrNamePos(m.index)) continue;
    copyDirectiveImportant(m);
    const val = m[2] !== undefined ? m[2] : m[3];
    const qChar = m[2] !== undefined ? '"' : "'";
    const innerStart = m.index + m[0].indexOf(qChar) + 1;
    const innerEnd = innerStart + val.length;
    const isBoundStyle = m.index > 0 && sForCtx[m.index - 1] === ":";
    if (isBoundStyle) {
      copyStringLiteralsPreservingLines(sForCtx, innerStart, innerEnd, copyCssSpanMasked);
    } else if (!val.includes("{")) {
      copyCssSpanMasked(innerStart, innerEnd);
    } else {
      let k = innerStart;
      let segStart = innerStart;
      let cssQuote = null;
      while (k < innerEnd) {
        const kc = sForCtx[k];
        if (cssQuote) {
          if (kc === "\\" && k + 1 < innerEnd) { k += 2; continue; }
          if (kc === cssQuote || kc === "\n") cssQuote = null;
          k++;
          continue;
        }
        if (kc === "\\" && k + 1 < innerEnd) { k += 2; continue; }
        if (kc === '"' || kc === "'") {
          cssQuote = kc;
          k++;
          continue;
        }
        if (kc === "{") {
          const braceEnd = findBalancedDelimEndSimple(sForCtx, k, "{", "}");
          if (braceEnd !== -1 && braceEnd < innerEnd) {
            copyCssSpanMasked(segStart, k);
            copyStringLiteralsPreservingLines(sForCtx, k + 1, braceEnd, copyCssSpanMasked);
            k = braceEnd + 1;
            segStart = k;
            continue;
          }
        }
        k++;
      }
      copyCssSpanMasked(segStart, innerEnd);
    }
  }
  for (const m of sForCtx.matchAll(/(?<![a-zA-Z0-9_-])(?:style(?::(?:--[a-zA-Z0-9_-]+|[a-z][a-z0-9-]*)(?<imp>\|important)?)?|sx|css)\s*=\s*\{/gi)) {
    const propHead = m[0].slice(0, m[0].search(/[\s=:]/));
    if (/^(?:sx|css)$/i.test(propHead) && propHead !== propHead.toLowerCase()) continue;
    if (!inRealTagAttrNamePos(m.index)) continue;
    copyDirectiveImportant(m);
    const openOuter = sForCtx.indexOf("{", m.index);
    const closeOuter = findBalancedDelimEndSimple(sForCtx, openOuter, "{", "}");
    if (closeOuter !== -1) {
      copyStringLiteralsPreservingLines(sForCtx, openOuter + 1, closeOuter, copyCssSpanMasked);
    }
  }
  const skipTsGenericArgs = (startCur) => {
    let cur = startCur;
    while (cur < sForCtx.length && /\s/.test(sForCtx[cur])) cur++;
    if (cur >= sForCtx.length || sForCtx[cur] !== "<") return { cur, ok: true };
    let angle = 0;
    let brace = 0;
    let q = null;
    const limit = Math.min(sForCtx.length, cur + 800);
    while (cur < limit) {
      const c = sForCtx[cur];
      if (q) {
        if (c === "\\" && cur + 1 < limit) {
          cur += 2;
          continue;
        }
        if (c === q || (q !== "`" && c === "\n")) q = null;
        cur++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        q = c;
        cur++;
        continue;
      }
      if (c === "{") brace++;
      else if (c === "}") brace = Math.max(0, brace - 1);
      else if (c === "<" && brace === 0) angle++;
      else if (c === ">" && sForCtx[cur - 1] !== "=" && brace === 0) {
        angle--;
        if (angle === 0) {
          cur++;
          break;
        }
      } else if (c === ";" && brace === 0 && angle <= 0) break;
      cur++;
    }
    if (angle !== 0) return { cur: startCur, ok: false };
    while (cur < sForCtx.length && /\s/.test(sForCtx[cur])) cur++;
    return { cur, ok: true };
  };
  for (const m of sForCtx.matchAll(/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b)\s*/g)) {
    if (inSpans(m.index, ctx.proseSpans) || inSpans(m.index, ctx.jsStringSpans) || inAttrValueSpan(m.index)) continue;
    let cur = m.index + m[0].length;
    if (/^styled(?:\s|$)/.test(m[0]) && sForCtx[cur] === "(") {
      const endStyledArg = findBalancedDelimEndSimple(sForCtx, cur, "(", ")");
      if (endStyledArg === -1) continue;
      cur = endStyledArg + 1;
      while (cur < sForCtx.length && /\s/.test(sForCtx[cur])) cur++;
    }
    while (cur < sForCtx.length) {
      const chainM = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(sForCtx.slice(cur, cur + 64));
      if (!chainM) break;
      cur += chainM[0].length;
      const gRes = skipTsGenericArgs(cur);
      if (!gRes.ok) {
        cur = -1;
        break;
      }
      cur = gRes.cur;
      if (sForCtx[cur] === "(") {
        const endChainParen = findBalancedDelimEndSimple(sForCtx, cur, "(", ")");
        if (endChainParen === -1) {
          cur = -1;
          break;
        }
        copyStringLiteralsPreservingLines(sForCtx, cur + 1, endChainParen, copyCssSpanMasked);
        cur = endChainParen + 1;
        while (cur < sForCtx.length && /\s/.test(sForCtx[cur])) cur++;
      }
    }
    if (cur === -1) continue;
    const gRes = skipTsGenericArgs(cur);
    if (!gRes.ok) continue;
    cur = gRes.cur;
    if (sForCtx[cur] === "(") {
      const endObjCall = findBalancedDelimEndSimple(sForCtx, cur, "(", ")");
      if (endObjCall !== -1) {
        copyStringLiteralsPreservingLines(sForCtx, cur + 1, endObjCall, copyCssSpanMasked);
      }
      continue;
    }
    if (sForCtx[cur] !== "`") continue;
    let i = cur + 1;
    let cssQuote = null;
    while (i < sForCtx.length) {
      const ch = sForCtx[i];
      if (ch === "\\" && i + 1 < sForCtx.length) {
        if (!cssQuote && chars[i] !== "\n") {
          chars[i] = sForCtx[i];
          if (chars[i + 1] !== "\n") chars[i + 1] = sForCtx[i + 1];
        }
        i += 2;
        continue;
      }
      if (ch === "$" && sForCtx[i + 1] === "{") {
        const endExpr = findBalancedDelimEndSimple(sForCtx, i + 1, "{", "}");
        if (endExpr === -1) break;
        if (!cssQuote) {
          copyStringLiteralsPreservingLines(sForCtx, i + 2, endExpr, copyCssSpanMasked);
        }
        i = endExpr + 1;
        continue;
      }
      if (ch === "`") break;
      if (cssQuote) {
        if (ch === cssQuote || ch === "\n") cssQuote = null;
      } else if (ch === "/" && sForCtx[i + 1] === "*") {
        const endC = sForCtx.indexOf("*/", i + 2);
        i = endC === -1 ? sForCtx.length : endC + 2;
        continue;
      } else if (ch === '"' || ch === "'") {
        cssQuote = ch;
      } else if (chars[i] !== "\n") {
        chars[i] = ch;
      }
      i++;
    }
  }
  return chars.join("");
}

export function stripCssCommentsInTemplatePreservingLines(tplText) {
  const s = String(tplText || "");
  const chars = s.split("");
  let cssQ = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (cssQ) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (ch === "$" && s[i + 1] === "{") {
        const endE = findBalancedDelimEndSimple(s, i + 1, "{", "}");
        if (endE !== -1) {
          i = endE;
          continue;
        }
      }
      if (ch === cssQ || ch === "\n") cssQ = null;
      continue;
    }
    if (ch === "$" && s[i + 1] === "{") {
      const endE = findBalancedDelimEndSimple(s, i + 1, "{", "}");
      if (endE !== -1) {
        i = endE;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      cssQ = ch;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const endC = s.indexOf("*/", i + 2);
      const stopC = endC === -1 ? s.length : endC + 2;
      maskRangePreservingLines(chars, i, stopC);
      i = stopC - 1;
    }
  }
  return chars.join("");
}

export function findCssInJsTemplateRanges(src, markupCtx = null) {
  const s = String(src || "");
  const ctx = markupCtx || scanMarkupContexts(s, {});
  const inSpans = (idx, spans) => Array.isArray(spans) && spans.some(([a, b]) => idx >= a && idx < b);
  const inAttrVal = (idx) =>
    ctx.openTags.some((tag) => idx > tag.start && idx < tag.end && tag.attrValueSpans.some(([as, ae]) => idx >= as && idx < ae));
  const skipTsGen = (startCur) => {
    let cur = startCur;
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    if (s[cur] !== "<") return { cur, ok: true };
    let angle = 1;
    let brace = 0;
    let q = null;
    cur++;
    const limit = Math.min(s.length, cur + 800);
    while (cur < limit && angle > 0) {
      const c = s[cur];
      if (q) {
        if (c === "\\" && cur + 1 < limit) { cur += 2; continue; }
        if (c === q || (q !== "`" && c === "\n")) q = null;
        cur++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") brace++;
      else if (c === "}") brace = Math.max(0, brace - 1);
      else if (c === "<" && brace === 0) angle++;
      else if (c === ">" && s[cur - 1] !== "=" && brace === 0) angle--;
      cur++;
    }
    if (angle !== 0) return { cur: startCur, ok: false };
    while (cur < s.length && /\s/.test(s[cur])) cur++;
    return { cur, ok: true };
  };
  const ranges = [];
  for (const m of s.matchAll(/(?<![a-zA-Z0-9_$.])(?:styled(?:\.[a-zA-Z0-9_$]+\b|\s*(?=\())|\bcss\b|\bcreateGlobalStyle\b|\bkeyframes\b)\s*/g)) {
    if (inSpans(m.index, ctx.proseSpans) || inSpans(m.index, ctx.jsStringSpans) || inAttrVal(m.index)) continue;
    let cur = m.index + m[0].length;
    if (/^styled(?:\s|$)/.test(m[0]) && s[cur] === "(") {
      const endP = findBalancedDelimEndSimple(s, cur, "(", ")");
      if (endP === -1) continue;
      cur = endP + 1;
      while (cur < s.length && /\s/.test(s[cur])) cur++;
    }
    while (cur < s.length) {
      const chainM = /^\s*\.(?:attrs|withConfig)\b\s*/.exec(s.slice(cur, cur + 64));
      if (!chainM) break;
      cur += chainM[0].length;
      const gC = skipTsGen(cur);
      if (!gC.ok) { cur = -1; break; }
      cur = gC.cur;
      if (s[cur] === "(") {
        const endC = findBalancedDelimEndSimple(s, cur, "(", ")");
        if (endC === -1) { cur = -1; break; }
        cur = endC + 1;
        while (cur < s.length && /\s/.test(s[cur])) cur++;
      }
    }
    if (cur === -1) continue;
    const gT = skipTsGen(cur);
    if (!gT.ok) continue;
    cur = gT.cur;
    if (s[cur] !== "`") continue;
    let tEnd = -1;
    let ti = cur + 1;
    while (ti < s.length) {
      const ch = s[ti];
      if (ch === "\\" && ti + 1 < s.length) { ti += 2; continue; }
      if (ch === "$" && s[ti + 1] === "{") {
        const endE = findBalancedDelimEndSimple(s, ti + 1, "{", "}");
        if (endE === -1) break;
        ti = endE + 1;
        continue;
      }
      if (ch === "`") { tEnd = ti; break; }
      ti++;
    }
    if (tEnd !== -1) ranges.push({ contentStart: cur + 1, contentEnd: tEnd });
  }
  return ranges;
}

function canonPathSimple(p) {
  try {
    return (realpathSync.native || realpathSync)(p);
  } catch {
    return resolve(p);
  }
}

export function resolvePathFollowingSymlinks(startBase, rawSpec, label = String(rawSpec || ""), maxHops = 40) {
  const spec = String(rawSpec || "");
  let root;
  let curSegs;
  let queue;
  let hops = 0;

  const baseInput = startBase ? String(startBase) : process.cwd();
  if (isAbsolute(spec)) {
    root = parse(spec).root;
    curSegs = [];
    queue = spec.slice(root.length).split(/[\\/]+/).filter(Boolean);
  } else if (isAbsolute(baseInput)) {
    root = parse(baseInput).root;
    curSegs = [];
    queue = [
      ...baseInput.slice(root.length).split(/[\\/]+/).filter(Boolean),
      ...spec.split(/[\\/]+/).filter(Boolean),
    ];
  } else {
    const cwd = process.cwd();
    root = parse(cwd).root;
    curSegs = [];
    queue = [
      ...cwd.slice(root.length).split(/[\\/]+/).filter(Boolean),
      ...baseInput.split(/[\\/]+/).filter(Boolean),
      ...spec.split(/[\\/]+/).filter(Boolean),
    ];
  }

  while (queue.length > 0) {
    const seg = queue.shift();
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (curSegs.length > 0) curSegs.pop();
      continue;
    }
    const probe = curSegs.length > 0 ? join(root, ...curSegs, seg) : join(root, seg);
    let lst = null;
    try {
      lst = lstatSync(probe);
    } catch {
      lst = null;
    }
    if (lst && lst.isSymbolicLink()) {
      hops++;
      if (hops > maxHops) {
        throw new Error(`Too many symbolic link hops while resolving path '${label}': ${rawSpec}`);
      }
      const linkTarget = readlinkSync(probe);
      if (isAbsolute(linkTarget)) {
        root = parse(linkTarget).root;
        curSegs = [];
        queue = [...linkTarget.slice(root.length).split(/[\\/]+/).filter(Boolean), ...queue];
      } else {
        queue = [...linkTarget.split(/[\\/]+/).filter(Boolean), ...queue];
      }
      continue;
    }
    if (lst) {
      const cp = canonPathSimple(probe);
      root = parse(cp).root;
      curSegs = cp.slice(root.length).split(/[\\/]+/).filter(Boolean);
    } else {
      curSegs.push(seg);
    }
  }
  return curSegs.length > 0 ? join(root, ...curSegs) : root;
}

export function assertPathWithinRoot(rootDir, targetPath, label = String(targetPath || ""), opts = {}) {
  const allowEqual = opts.allowEqual !== undefined ? Boolean(opts.allowEqual) : false;
  const canonRootRaw = resolvePathFollowingSymlinks(null, rootDir, "root");
  const canonFullRaw = resolvePathFollowingSymlinks(null, targetPath, label);
  const ci = process.platform === "darwin" || process.platform === "win32";
  const canonRoot = ci ? canonRootRaw.toLowerCase() : canonRootRaw;
  const canonFull = ci ? canonFullRaw.toLowerCase() : canonFullRaw;
  const rel = relative(canonRoot, canonFull);
  if ((!allowEqual && !rel) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Destination path '${label}' escapes repository root: ${targetPath}`);
  }
  return canonFullRaw;
}

export function isDirectCliEntry(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return canonPathSimple(argv1) === canonPathSimple(fileURLToPath(metaUrl));
}

function assertWritableOutputTarget(targetPath, kind, label = "--out", opts = {}) {
  const raw = String(targetPath ?? "");
  if (!raw.trim()) {
    throw new Error(`Parameter '${label}' must be a non-empty path.`);
  }
  const absOut = resolve(raw);
  let lst = null;
  try {
    lst = lstatSync(absOut);
  } catch (err) {
    if (err?.code === "ENOTDIR") {
      throw new Error(`Output path '${label}' parent is not a directory: ${dirname(absOut)}`);
    }
    if (err?.code !== "ENOENT") throw err;
  }
  if (lst?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked output path '${label}': ${absOut}`);
  }
  if (lst) {
    if (kind === "dir" && !lst.isDirectory()) {
      throw new Error(`Output path '${label}' is not a directory: ${absOut}`);
    }
    if (kind === "file" && lst.isDirectory()) {
      throw new Error(`Output path '${label}' is a directory: ${absOut}`);
    }
  } else {
    let anc = dirname(absOut);
    while (true) {
      let aLst = null;
      try {
        aLst = lstatSync(anc);
      } catch (err) {
        if (err?.code === "ENOTDIR") {
          throw new Error(`Output path '${label}' parent is not a directory: ${dirname(anc)}`);
        }
        if (err?.code !== "ENOENT") throw err;
      }
      if (aLst) {
        if ((aLst.isSymbolicLink() && (!existsSync(anc) || !statSync(anc).isDirectory())) || (!aLst.isSymbolicLink() && !aLst.isDirectory())) {
          throw new Error(`Output path '${label}' parent is not a valid directory: ${anc}`);
        }
        break;
      }
      const p = dirname(anc);
      if (p === anc) break;
      anc = p;
    }
  }
  if (opts.rootDir) {
    const absRoot = resolve(opts.rootDir);
    const realRoot = canonPathSimple(absRoot);
    const ci = process.platform === "darwin" || process.platform === "win32";
    const normCmp = (p) => (ci ? p.toLowerCase() : p);
    const isLexWithin = (baseDir, candPath) => {
      const rel = relative(normCmp(baseDir), normCmp(candPath));
      return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    let touchesRoot = isLexWithin(absRoot, absOut) || isLexWithin(realRoot, absOut);
    if (!touchesRoot) {
      let cur = absOut;
      while (true) {
        const cp = canonPathSimple(cur);
        if (isLexWithin(realRoot, cp) || isLexWithin(absRoot, cp)) {
          touchesRoot = true;
          break;
        }
        const par = dirname(cur);
        if (par === cur) break;
        cur = par;
      }
    }
    if (touchesRoot) {
      assertPathWithinRoot(opts.rootDir, absOut, label, { allowEqual: kind === "dir" && Boolean(opts.allowEqualRoot) });
    }
  }
  return absOut;
}

export function assertWritableOutputFile(targetPath, label = "--out", opts = {}) {
  return assertWritableOutputTarget(targetPath, "file", label, opts);
}

export function assertWritableOutputDir(targetPath, label = "--out", opts = {}) {
  return assertWritableOutputTarget(targetPath, "dir", label, opts);
}

export function stripTrailingTsCastEnd(str, start, end, findBalFn = null) {
  let l = start;
  let r = end;
  while (l < r && /\s/.test(str[l])) l++;
  while (r > l && /\s/.test(str[r - 1])) r--;
  if (l >= r) return r;
  const findCloseBrace = (idx) =>
    findBalFn ? findBalFn(str, idx, "{", "}") : findBalancedDelimEndSimple(str, idx, "{", "}");
  let p = 0;
  let b = 0;
  let br = 0;
  let q = null;
  let lastSig = "";
  let firstCastPos = -1;
  let hasOuterSwitch = false;
  const parenStack = [];
  for (let k = l; k < r; k++) {
    const c = str[k];
    if (q) {
      if (c === "\\" && k + 1 < r) {
        k++;
        continue;
      }
      if (q === "`" && c === "$" && k + 1 < r && str[k + 1] === "{") {
        const se = findCloseBrace(k + 1);
        if (se === -1 || se >= r) break;
        k = se;
        lastSig = "}";
        continue;
      }
      if (c === q || (q !== "`" && c === "\n")) {
        q = null;
        lastSig = c;
      }
      continue;
    }
    const reEnd = skipJsRegexInExpr(str, k, lastSig, l);
    if (reEnd !== -1 && reEnd <= r) {
      k = reEnd - 1;
      lastSig = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "(") {
      parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(str.slice(Math.max(l, k - 16), k)));
      p++;
      lastSig = "(";
    } else if (c === ")") {
      lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      p = Math.max(0, p - 1);
    } else if (c === "[") {
      b++;
      lastSig = "[";
    } else if (c === "]") {
      b = Math.max(0, b - 1);
      lastSig = "]";
    } else if (c === "{") {
      br++;
      lastSig = "{";
    } else if (c === "}") {
      br = Math.max(0, br - 1);
      lastSig = "}";
    } else if (p === 0 && b === 0 && br === 0) {
      if (
        (c === "?" && str[k + 1] !== "." && str[k + 1] !== "?") ||
        (c === "&" && str[k + 1] === "&") ||
        (c === "|" && str[k + 1] === "|") ||
        (c === "?" && str[k + 1] === "?")
      ) {
        hasOuterSwitch = true;
        break;
      }
      if (
        firstCastPos === -1 &&
        lastSig &&
        lastSig !== "." &&
        (c === "a" || c === "s") &&
        (k === l || !/[A-Za-z0-9_$]/.test(str[k - 1]))
      ) {
        const kwMatch = /^(?:as|satisfies)(?=\s)/.exec(str.slice(k, Math.min(r, k + 12)));
        if (kwMatch) {
          firstCastPos = k;
          break;
        }
      }
      if (!/\s/.test(c)) lastSig = c;
    } else if (!/\s/.test(c)) {
      lastSig = c;
    }
  }
  if (hasOuterSwitch) return r;
  if (firstCastPos !== -1) {
    let cut = firstCastPos;
    while (cut > l && /\s/.test(str[cut - 1])) cut--;
    if (cut > l) return cut;
  }
  if (
    r > l + 1 &&
    str[r - 1] === "!" &&
    str[r - 2] !== "!" &&
    str[r - 2] !== "=" &&
    (str[r - 2] === ")" || str[r - 2] === "}" || str[r - 2] === "]" || /[A-Za-z0-9_$'"]/.test(str[r - 2]))
  ) {
    return r - 1;
  }
  return r;
}

function classifyAfterReturnType(str, startAfterRp) {
  let k = startAfterRp;
  while (k < str.length && /\s/.test(str[k])) k++;
  if (str[k] !== ":") return null;
  k++;
  const typeStart = k;
  let paren = 0;
  let brack = 0;
  let brace = 0;
  let angle = 0;
  let q = null;
  const limit = Math.min(str.length, k + 512);
  while (k < limit) {
    const ch = str[k];
    if (q) {
      if (ch === "\\" && k + 1 < limit) {
        k += 2;
        continue;
      }
      if (ch === q || (q !== "`" && ch === "\n")) q = null;
      k++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren === 0) return null;
      paren--;
    } else if (ch === "[") brack++;
    else if (ch === "]") brack = Math.max(0, brack - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0) {
        if (paren === 0 && brack === 0 && angle === 0 && str.slice(typeStart, k).trim().length > 0) return "call-sig";
        return null;
      }
      brace--;
    } else if (ch === "<") {
      if (paren === 0 && brack === 0 && brace === 0 && str[k + 1] === "/") return null;
      angle++;
    } else if (ch === ">" && str[k - 1] !== "=") {
      angle = Math.max(0, angle - 1);
    } else if (paren === 0 && brack === 0 && brace === 0 && angle === 0) {
      if (ch === "=" && str[k + 1] === ">") return "arrow";
      if ((ch === ";" || ch === ",") && str.slice(typeStart, k).trim().length > 0) return "call-sig";
    }
    k++;
  }
  return null;
}

function hasArrowAfterReturnType(str, startAfterRp) {
  return classifyAfterReturnType(str, startAfterRp) === "arrow";
}

function parseMarkupOpenTagCore(s, ltIdx, allowGenerics = true) {
  if (s.startsWith("<>", ltIdx)) {
    return { start: ltIdx, end: ltIdx + 2, tag: "", rawTag: "", selfClosing: false, attrValueSpans: [], exprSpans: [] };
  }
  const om = /^<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/><])/.exec(s.slice(ltIdx, ltIdx + 64));
  if (!om) return null;
  const rawTag = om[1];
  const tagLower = rawTag.toLowerCase();
  let j = ltIdx + 1 + rawTag.length;
  if (s[j] === "<") {
    if (!allowGenerics || (!/^[A-Z]/.test(rawTag) && !rawTag.includes("."))) return null;
    let gq = null;
    let gAngle = 1;
    let gParen = 0;
    let gBrack = 0;
    let gBrace = 0;
    let gk = j + 1;
    const gLimit = Math.min(s.length, gk + 1200);
    while (gk < gLimit && gAngle > 0) {
      const gc = s[gk];
      if (gq) {
        if (gc === "\\" && gk + 1 < gLimit) {
          gk += 2;
          continue;
        }
        if (gc === gq || (gq !== "`" && gc === "\n")) gq = null;
        gk++;
        continue;
      }
      if (gc === '"' || gc === "'" || gc === "`") gq = gc;
      else if (gc === "(") gParen++;
      else if (gc === ")") gParen = Math.max(0, gParen - 1);
      else if (gc === "[") gBrack++;
      else if (gc === "]") gBrack = Math.max(0, gBrack - 1);
      else if (gc === "{") gBrace++;
      else if (gc === "}") gBrace = Math.max(0, gBrace - 1);
      else if (gParen === 0 && gBrack === 0 && gBrace === 0) {
        if (gc === "<") gAngle++;
        else if (gc === ">" && s[gk - 1] !== "=") {
          gAngle--;
          if (gAngle === 0) {
            gk++;
            break;
          }
        } else if (gc === ";") {
          return null;
        }
      }
      gk++;
    }
    if (gAngle !== 0 || gk >= s.length || !/[\s/>]/.test(s[gk])) return null;
    j = gk;
  }
  if (/^\s*=/.test(s.slice(j, j + 16))) return null;
  let q = null;
  let qInBracket = false;
  let qStart = -1;
  let nonExpr = "";
  const attrValueSpans = [];
  const exprSpans = [];
  let brack = 0;
  while (j < s.length) {
    const c = s[j];
    if (q) {
      if (qInBracket && c === "\\" && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (c === q) {
        if (qStart !== -1) attrValueSpans.push([qStart, j + 1]);
        q = null;
        qInBracket = false;
        qStart = -1;
      }
      j++;
      continue;
    }
    const inSfcBracket = brack > 0;
    if (c === "\n" && inSfcBracket) return null;
    if (c === '"' || c === "'") {
      if (!inSfcBracket && !/=\s*$/.test(nonExpr)) return null;
      q = c;
      qInBracket = inSfcBracket;
      qStart = inSfcBracket ? -1 : j;
      nonExpr += " ";
      j++;
      continue;
    }
    if (c === "{") {
      const be = findBalancedDelimEndSimple(s, j, "{", "}", allowGenerics);
      if (be === -1) return null;
      if (!inSfcBracket) {
        exprSpans.push({ start: j, end: be + 1, innerStart: j + 1, innerEnd: be });
      }
      nonExpr += " ";
      j = be + 1;
      continue;
    }
    if (c === "[" && canOpenTagDirectiveBracket(allowGenerics, brack, nonExpr)) {
      brack++;
      nonExpr += c;
      j++;
      continue;
    }
    if (c === "]" && brack > 0) {
      brack--;
      nonExpr += c;
      j++;
      continue;
    }
    if (c === "<" || c === ";") return null;
    if (!inSfcBracket && (c === "," || c === "&" || c === "?")) return null;
    const isSvelteModifierPipe =
      s[j + 1] !== "|" &&
      /(?:^|\s)[A-Za-z][A-Za-z0-9_-]*:(?:--)?[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)*$/.test(nonExpr.slice(-96)) &&
      /^[A-Za-z0-9_-]+(?:\s*(?:=|\/?>|\s)|\|)/.test(s.slice(j + 1, j + 48));
    if (c === "|" && !inSfcBracket && !isSvelteModifierPipe) return null;
    if (!inSfcBracket && c === "=" && s[j + 1] === ">") return null;
    if (c === ">" && !inSfcBracket) {
      if (/(?:^|\s)extends\s+(?![=/>\s])/.test(nonExpr)) return null;
      if (nonExpr.trim() === "") {
        let pChk = j - 1;
        while (pChk > ltIdx && /\s/.test(s[pChk])) pChk--;
        const isSelf = s[pChk] === "/";
        const preCtx = s.slice(Math.max(0, ltIdx - 32), ltIdx);
        let afterGt = j + 1;
        while (afterGt < s.length && /\s/.test(s[afterGt])) afterGt++;
        if (!isSelf && s[afterGt] === "(") {
          const rpEnd = findBalancedDelimEndSimple(s, afterGt, "(", ")");
          if (rpEnd !== -1) {
            const afterRp = s.slice(rpEnd + 1, rpEnd + 16);
            const isArrowAfter = /^\s*=>/.test(afterRp);
            const isColonAfter = /^\s*:/.test(afterRp);
            const paramInner = s.slice(afterGt + 1, rpEnd).trim();
            const safeTag = rawTag.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
            const hasCloseTag = new RegExp("</" + safeTag + "\\s*>", "i").test(s.slice(rpEnd + 1));
            if (!hasCloseTag && /(?:^|\b(?:new|await|return)|[A-Za-z0-9_$.])\s*$/.test(preCtx)) {
              return null;
            }
            const isAsyncGeneric = /\basync\s*$/.test(preCtx);
            if (
              /(?:^|[=:({[,;&|?]|=>|\b(?:default|return|export|type|interface|class|function|const|let|var|new|as|satisfies|async))\s*$/.test(
                preCtx
              )
            ) {
              const rtKind = isColonAfter ? classifyAfterReturnType(s, rpEnd + 1) : null;
              if (
                (isArrowAfter && (!hasCloseTag || isAsyncGeneric || /:|^\s*$|^\.\.\./.test(paramInner))) ||
                (isColonAfter &&
                  (rtKind === "arrow" ||
                    (rtKind === "call-sig" &&
                      (paramInner === "" ||
                        /^[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*$/.test(paramInner) ||
                        /[:?=]|^\.\.\./.test(paramInner))) ||
                    ((!hasCloseTag || isAsyncGeneric) &&
                      (paramInner === "" || /[:?]|^\.\.\./.test(paramInner)))))
              ) {
                return null;
              }
            }
          }
        }
      }
      let p = j - 1;
      while (p >= ltIdx && /\s/.test(s[p])) p--;
      return {
        start: ltIdx,
        end: j + 1,
        tag: tagLower,
        rawTag,
        selfClosing: s[p] === "/",
        attrValueSpans,
        exprSpans,
      };
    }
    nonExpr += c;
    j++;
  }
  return null;
}

export function scanMarkupContexts(src, options = {}) {
  const s = String(src || "");
  const isMarkupSfc = Boolean(options.isMarkupSfc);
  const braceExprs = options.braceExprs !== undefined ? Boolean(options.braceExprs) : !isMarkupSfc;
  const mustacheExprs = Boolean(options.mustacheExprs);
  const openTags = [];
  const proseSpans = [];
  const jsStringSpans = [];
  const jsxChildBraceStarts = new Set();

  const scanJsRange = (startIdx, endIdx, initSig = "", allowJsx = !isMarkupSfc) => {
    const jsxStack = [];
    let i = startIdx;
    let lastSig = initSig;
    let proseStart = -1;
    const parenStack = [];
    const flushProse = (endPos) => {
      if (proseStart !== -1 && endPos > proseStart) {
        proseSpans.push([proseStart, endPos]);
      }
      proseStart = -1;
    };
    while (i < endIdx) {
      const ch = s[i];
      const next = i + 1 < endIdx ? s[i + 1] : "";
      if (jsxStack.length > 0) {
        if (ch === "<" && s.startsWith("<!--", i)) {
          flushProse(i);
          const endC = s.indexOf("-->", i + 4);
          i = endC === -1 || endC + 3 > endIdx ? endIdx : endC + 3;
          proseStart = i;
          continue;
        }
        if (ch === "{") {
          flushProse(i);
          const closeB = findBalancedDelimEndSimple(s, i, "{", "}", allowJsx);
          if (closeB !== -1 && closeB < endIdx) {
            jsxChildBraceStarts.add(i);
            scanJsRange(i + 1, closeB, "{", allowJsx);
            i = closeB + 1;
            proseStart = i;
            continue;
          }
          i++;
          proseStart = i;
          continue;
        }
        if (ch === "<" && next === "/") {
          const closeM = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)?\s*>/.exec(s.slice(i, Math.min(endIdx, i + 80)));
          if (closeM) {
            flushProse(i);
            const cTag = (closeM[1] || "").toLowerCase();
            if (!cTag) jsxStack.pop();
            else {
              for (let k = jsxStack.length - 1; k >= 0; k--) {
                if (jsxStack[k] === cTag) {
                  jsxStack.length = k;
                  break;
                }
              }
            }
            i += closeM[0].length;
            if (jsxStack.length > 0) proseStart = i;
            else lastSig = ">";
            continue;
          }
        }
        if (ch === "<") {
          const tagObj = parseMarkupOpenTagCore(s, i, true);
          if (tagObj && tagObj.end <= endIdx) {
            flushProse(i);
            openTags.push(tagObj);
            for (const ex of tagObj.exprSpans) {
              scanJsRange(ex.innerStart, ex.innerEnd, "{", allowJsx);
            }
            if (!tagObj.selfClosing) {
              jsxStack.push(tagObj.tag);
            }
            i = tagObj.end;
            if (jsxStack.length > 0) proseStart = i;
            continue;
          }
        }
        i++;
        continue;
      }

      if (ch === "/" && next === "*") {
        const ce = s.indexOf("*/", i + 2);
        i = ce === -1 || ce + 2 > endIdx ? endIdx : ce + 2;
        continue;
      }
      if (ch === "/" && next === "/") {
        const nl = s.indexOf("\n", i + 2);
        i = nl === -1 || nl + 1 > endIdx ? endIdx : nl + 1;
        continue;
      }
      const reEnd = skipJsRegexInExpr(s, i, lastSig, startIdx);
      if (reEnd !== -1 && reEnd <= endIdx) {
        i = reEnd;
        lastSig = "/";
        continue;
      }
      if (ch === '"' || ch === "'") {
        let k = i + 1;
        let closed = false;
        while (k < endIdx) {
          if (s[k] === "\\" && k + 1 < endIdx) {
            k += 2;
            continue;
          }
          if (s[k] === "\n") break;
          if (s[k] === ch) {
            closed = true;
            k++;
            break;
          }
          k++;
        }
        if (closed) {
          jsStringSpans.push([i, k]);
          lastSig = ch;
          i = k;
          continue;
        }
      }
      if (ch === "`" && canStartJsTemplateLiteral(s, i, s.slice(Math.max(startIdx, i - 4096), i), false)) {
        let tk = i + 1;
        let segS = i;
        while (tk < endIdx) {
          if (s[tk] === "\\" && tk + 1 < endIdx) {
            tk += 2;
            continue;
          }
          if (s[tk] === "$" && tk + 1 < endIdx && s[tk + 1] === "{") {
            const be = findBalancedDelimEndSimple(s, tk + 1, "{", "}", allowJsx);
            if (be === -1 || be >= endIdx) {
              tk = endIdx;
              break;
            }
            jsStringSpans.push([segS, tk]);
            scanJsRange(tk + 2, be, "{", allowJsx);
            tk = be + 1;
            segS = tk;
            continue;
          }
          if (s[tk] === "`") {
            tk++;
            jsStringSpans.push([segS, tk]);
            break;
          }
          tk++;
        }
        lastSig = "`";
        i = tk;
        continue;
      }
      if (allowJsx && ch === "<") {
        const prevCh = i > startIdx ? s[i - 1] : "";
        const blockedByIdent = /[A-Za-z0-9_$\]\])]/.test(prevCh);
        if (!blockedByIdent) {
          const tagObj = parseMarkupOpenTagCore(s, i, allowJsx);
          if (tagObj && tagObj.end <= endIdx) {
            openTags.push(tagObj);
            for (const ex of tagObj.exprSpans) {
              scanJsRange(ex.innerStart, ex.innerEnd, "{", allowJsx);
            }
            if (!tagObj.selfClosing) {
              if (tagObj.tag === "script") {
                const allowScriptJsx = /\blang\s*=\s*["'](?:jsx|tsx)["']/i.test(s.slice(tagObj.start, tagObj.end));
                const closeInfo = findScriptCloseRaw(s, tagObj.end);
                const scrEnd = closeInfo && closeInfo.closeStart <= endIdx ? closeInfo.closeStart : endIdx;
                scanJsRange(tagObj.end, scrEnd, "", allowScriptJsx);
                i = closeInfo && closeInfo.closeEnd <= endIdx ? closeInfo.closeEnd : tagObj.end;
                lastSig = ">";
                continue;
              }
              if (tagObj.tag === "style") {
                const isScssTag = /\blang\s*=\s*["']s[ca]ss["']/i.test(s.slice(tagObj.start, tagObj.end));
                const closeInfo = findStyleCloseRaw(s, tagObj.end, isScssTag);
                i = closeInfo && closeInfo.closeEnd <= endIdx ? closeInfo.closeEnd : tagObj.end;
                lastSig = ">";
                continue;
              }
              jsxStack.push(tagObj.tag);
              proseStart = tagObj.end;
            } else {
              lastSig = ">";
            }
            i = tagObj.end;
            continue;
          }
        }
      }
      if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(s.slice(Math.max(startIdx, i - 16), i)));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(ch)) {
        lastSig = ch === ">" && i > startIdx && s[i - 1] === "=" ? "=>" : ch;
      }
      i++;
    }
    flushProse(endIdx);
  };

  const findAstroFrontmatterEnd = (srcText, fmBodyStart) => {
    let q = null;
    let lastSig = "";
    const parenStack = [];
    const tplBraceDepths = [];
    let k = fmBodyStart;
    while (k < srcText.length) {
      const ch = srcText[k];
      if (q) {
        if (ch === "\\" && k + 1 < srcText.length) {
          k += 2;
          continue;
        }
        if (q === "`" && ch === "$" && k + 1 < srcText.length && srcText[k + 1] === "{") {
          tplBraceDepths.push(1);
          q = null;
          lastSig = "{";
          k += 2;
          continue;
        }
        if (ch === q || (q !== "`" && ch === "\n")) {
          q = null;
          lastSig = ch;
        }
        k++;
        continue;
      }
      if (tplBraceDepths.length === 0 && (k === fmBodyStart || srcText[k - 1] === "\n")) {
        const closeM = /^---(?=[ \t]*(?:\r?\n|$))/.exec(srcText.slice(k));
        if (closeM) {
          const lineEnd = srcText[k - 1] === "\n" ? (k >= 2 && srcText[k - 2] === "\r" ? k - 2 : k - 1) : k;
          return { lineEnd, fenceEnd: k + 3 };
        }
      }
      if (ch === "/" && srcText[k + 1] === "/") {
        const nl = srcText.indexOf("\n", k + 2);
        k = nl === -1 ? srcText.length : nl + 1;
        continue;
      }
      if (ch === "/" && srcText[k + 1] === "*") {
        const closeC = srcText.indexOf("*/", k + 2);
        k = closeC === -1 ? srcText.length : closeC + 2;
        continue;
      }
      const reEnd = skipJsRegexInExpr(srcText, k, lastSig, fmBodyStart);
      if (reEnd !== -1 && reEnd <= srcText.length) {
        lastSig = "/";
        k = reEnd;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        k++;
        continue;
      }
      if (ch === "`" && canStartJsTemplateLiteral(srcText, k, srcText.slice(Math.max(fmBodyStart, k - 4096), k), false)) {
        q = "`";
        k++;
        continue;
      }
      if (tplBraceDepths.length > 0) {
        if (ch === "{") {
          tplBraceDepths[tplBraceDepths.length - 1]++;
          lastSig = "{";
          k++;
          continue;
        }
        if (ch === "}") {
          tplBraceDepths[tplBraceDepths.length - 1]--;
          if (tplBraceDepths[tplBraceDepths.length - 1] === 0) {
            tplBraceDepths.pop();
            q = "`";
            lastSig = "}";
          } else {
            lastSig = "}";
          }
          k++;
          continue;
        }
      }
      if (ch === "(") {
        parenStack.push(/(?:^|[^\w$])(?:if|while|for|with)\s*$/.test(srcText.slice(Math.max(fmBodyStart, k - 16), k)));
        lastSig = "(";
      } else if (ch === ")") {
        lastSig = parenStack.length > 0 && parenStack.pop() ? "control)" : ")";
      } else if (!/\s/.test(ch)) {
        lastSig = ch === ">" && k > fmBodyStart && srcText[k - 1] === "=" ? "=>" : ch;
      }
      k++;
    }
    return null;
  };

  if (isMarkupSfc) {
    let i = 0;
    let textStart = 0;
    const flushText = (endPos) => {
      if (textStart !== -1 && endPos > textStart) proseSpans.push([textStart, endPos]);
      textStart = -1;
    };
    const fmOpenM = /^(?:\uFEFF)?[ \t\r\n]*---(?=[ \t]*(?:\r?\n|$))/.exec(s);
    if (fmOpenM) {
      const afterOpenLine = s.indexOf("\n", fmOpenM[0].length);
      if (afterOpenLine !== -1) {
        const fmClose = findAstroFrontmatterEnd(s, afterOpenLine + 1);
        if (fmClose) {
          scanJsRange(afterOpenLine + 1, fmClose.lineEnd, "", false);
          i = fmClose.fenceEnd;
          textStart = i;
        }
      }
    }
    while (i < s.length) {
      if (s.startsWith("<!--", i)) {
        flushText(i);
        const end = s.indexOf("-->", i + 4);
        i = end === -1 ? s.length : end + 3;
        textStart = i;
        continue;
      }
      if (mustacheExprs && s.startsWith("{{", i)) {
        const be = findBalancedDelimEndSimple(s, i, "{", "}");
        if (be !== -1) {
          flushText(i);
          const innerEnd = s[be - 1] === "}" ? be - 1 : be;
          scanJsRange(i + 2, innerEnd, "{", false);
          i = be + 1;
          textStart = i;
          continue;
        }
      }
      if (braceExprs && s[i] === "{") {
        const be = findBalancedDelimEndSimple(s, i, "{", "}", true);
        if (be !== -1) {
          flushText(i);
          jsxChildBraceStarts.add(i);
          scanJsRange(i + 1, be, "{", true);
          i = be + 1;
          textStart = i;
          continue;
        }
      }
      if (s[i] === "<") {
        if (s.startsWith("<!", i)) {
          const dm = /^<![A-Za-z][^>]*>/.exec(s.slice(i, i + 256));
          if (dm) {
            flushText(i);
            i += dm[0].length;
            textStart = i;
            continue;
          }
        }
        if (s[i + 1] === "/") {
          const cm = /^<\/[A-Za-z][A-Za-z0-9_.:-]*\s*>/.exec(s.slice(i, i + 80));
          if (cm) {
            flushText(i);
            i += cm[0].length;
            textStart = i;
            continue;
          }
        }
        const tagObj = parseMarkupOpenTagCore(s, i, false);
        if (tagObj) {
          flushText(i);
          openTags.push(tagObj);
          for (const ex of tagObj.exprSpans) {
            scanJsRange(ex.innerStart, ex.innerEnd, "{", false);
          }
          if (!tagObj.selfClosing && tagObj.tag === "script") {
            const allowScriptJsx = /\blang\s*=\s*["'](?:jsx|tsx)["']/i.test(s.slice(tagObj.start, tagObj.end));
            const closeInfo = findScriptCloseRaw(s, tagObj.end);
            if (closeInfo) {
              scanJsRange(tagObj.end, closeInfo.closeStart, "", allowScriptJsx);
              i = closeInfo.closeEnd;
            } else {
              scanJsRange(tagObj.end, s.length, "", allowScriptJsx);
              i = s.length;
            }
          } else if (!tagObj.selfClosing && tagObj.tag === "style") {
            const isScssTag = /\blang\s*=\s*["']s[ca]ss["']/i.test(s.slice(tagObj.start, tagObj.end));
            const closeInfo = findStyleCloseRaw(s, tagObj.end, isScssTag);
            i = closeInfo ? closeInfo.closeEnd : tagObj.end;
          } else {
            i = tagObj.end;
          }
          textStart = i;
          continue;
        }
      }
      i++;
    }
    flushText(s.length);
  } else {
    scanJsRange(0, s.length, "");
  }

  return { openTags, proseSpans, jsStringSpans, jsxChildBraceStarts };
}

export function maskMarkupProsePreservingLines(src, options = {}) {
  const s = String(src || "");
  const ctx = options.markupCtx || scanMarkupContexts(s, options);
  if (ctx.proseSpans.length === 0) return s;
  const chars = s.split("");
  for (const [ps, pe] of ctx.proseSpans) {
    maskRangePreservingLines(chars, ps, pe);
  }
  return chars.join("");
}

/**
 * Mask markup text nodes plus documentation/non-styling JS string literals
 * (preserving standalone color literals like "#ff00aa" unless inside non-styling attributes).
 */
export function maskProseAndDocStringsPreservingLines(src, options = {}) {
  const s = String(src || "");
  const sForCtx = options.markupCtx ? s : stripCommentsPreservingLines(s);
  const ctx = options.markupCtx || scanMarkupContexts(sForCtx, options);
  const chars = s.split("");
  for (const [ps, pe] of ctx.proseSpans) {
    maskRangePreservingLines(chars, ps, pe);
  }
  const excludeSpans = Array.isArray(options.excludeSpans) ? options.excludeSpans : [];
  const inSpans = (idx, spans) => spans.some(([a, b]) => idx >= a && idx < b);
  const DOC_ATTR_RE = /^(?:title|alt|placeholder|aria-label|aria-description|aria-placeholder|aria-valuetext|label|helpertext|description|tooltip|summary|caption)$/i;
  const STYLE_OR_CLASS_ATTR_RE = /^(?:class(?:Name|:list)?|:class|v-bind:class|style|sx|:style|v-bind:style)$/i;
  for (const tag of ctx.openTags) {
    for (const [as, ae] of tag.attrValueSpans) {
      if (inSpans(as, excludeSpans)) continue;
      const beforeVal = s.slice(Math.max(tag.start, as - 64), as);
      const am = /([A-Za-z0-9_:-]+)\s*=\s*$/.exec(beforeVal);
      if (am && DOC_ATTR_RE.test(am[1])) {
        maskRangePreservingLines(chars, as, ae);
      }
    }
  }
  const classifyAttrExpr = (ss) => {
    for (const tag of ctx.openTags) {
      if (ss <= tag.start || ss >= tag.end) continue;
      for (const ex of tag.exprSpans) {
        if (ss >= ex.innerStart && ss < ex.innerEnd) {
          const beforeExpr = s.slice(Math.max(tag.start, ex.start - 64), ex.start);
          const am = /([A-Za-z0-9_:-]+)\s*=\s*$/.exec(beforeExpr);
          if (am) {
            if (DOC_ATTR_RE.test(am[1])) return "doc-attr";
            if (STYLE_OR_CLASS_ATTR_RE.test(am[1])) return "style-attr";
          }
        }
      }
    }
    return "other";
  };
  for (const [ss, se] of ctx.jsStringSpans) {
    if (inSpans(ss, excludeSpans)) continue;
    const attrRole = classifyAttrExpr(ss);
    if (attrRole === "style-attr") continue;
    if (attrRole === "doc-attr") {
      maskRangePreservingLines(chars, ss, se);
      continue;
    }
    const rawLit = s.slice(ss, se);
    const inner = (rawLit.startsWith('"') || rawLit.startsWith("'") || rawLit.startsWith("`")) && rawLit.length >= 2 && rawLit.endsWith(rawLit[0])
      ? rawLit.slice(1, -1)
      : rawLit.replace(/^["'`]/, "");
    const hasHtmlTag = /<[A-Za-z][A-Za-z0-9_.:-]*(?:\s|\/?>)|<\/[A-Za-z][A-Za-z0-9_.:-]*\s*>/.test(inner);
    const hasAttrSnippet = /(?:^|[\s(>])(?:class(?:Name)?|style(?::--[a-z0-9_-]+)?)\s*=\s*["'{]/i.test(inner);
    const hasProseMarker =
      /\b(?:Issue|Order|Ticket|Bug|Step|Note|Example|Avoid|Instead|Warning|Error|Deprecated|Use)\b\s+(?:#\d+|[a-zA-Z0-9_-]*[\[:#])/i.test(inner) ||
      /^\s*(?:Example|Note|Tip|Warning|Avoid|Instead|Deprecated)\s*:/i.test(inner) ||
      /(?:^|\s)(?:Do\s+not|Don't|Never)\s+[a-z]/i.test(inner) ||
      /\b(?:use|avoid|prefer|instead\s+of|example|note|warning|deprecated)\b[\s:]+(?:var\(--|[a-z0-9-]+-\(--|style:--)/i.test(inner) ||
      /(?:^|\s)[A-Z][a-z]{2,}\s+(?:is|are|was|the|a|an|for|to|of|with|on|in|and|or)\b/.test(inner);
    if (hasHtmlTag || hasAttrSnippet || hasProseMarker) {
      maskRangePreservingLines(chars, ss, se);
    }
  }
  return chars.join("");
}

/**
 * Mask custom property declarations inside `@theme`, `@property`, `:root`, `:host`,
 * `[data-theme]`, `.dark`, `.light` token blocks while keeping regular declarations
 * (`color: ... !important`, `padding: 13px`) visible outside `@theme`/`@property`.
 */
export function stripTokenBlocksPreservingLines(cssText) {
  const cleaned = stripCommentsPreservingLines(cssText);
  const out = [];
  let idx = 0;
  const skipStack = [];
  let curHeader = "";
  let quote = null;
  let interpDepth = 0;
  let inCustomPropDecl = false;
  let varParenDepth = 0;
  let stmtOutStart = 0;
  const topMode = () => (skipStack.length > 0 ? skipStack[skipStack.length - 1].mode : "none");
  const isBlanking = () => {
    const mode = topMode();
    return mode === "all" || (mode === "vars-only" && inCustomPropDecl);
  };
  const blankRangeInOut = (fromIdx) => {
    for (let k = fromIdx; k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  const resetStmt = (nextStart = out.length) => {
    curHeader = "";
    inCustomPropDecl = false;
    varParenDepth = 0;
    stmtOutStart = nextStart;
  };

  while (idx < cleaned.length) {
    const ch = cleaned[idx];
    if (quote) {
      out.push(isBlanking() && ch !== "\n" ? " " : ch);
      curHeader += ch;
      if (ch === "\\" && idx + 1 < cleaned.length) {
        idx++;
        const escaped = cleaned[idx];
        out.push(isBlanking() && escaped !== "\n" ? " " : escaped);
        curHeader += escaped;
        if (escaped === "\n") quote = null;
      } else if (ch === quote || ch === "\n") {
        quote = null;
      }
      idx++;
      continue;
    }
    if (ch === "\\" && idx + 1 < cleaned.length) {
      const nextCh = cleaned[idx + 1];
      out.push(isBlanking() && ch !== "\n" ? " " : ch);
      out.push(isBlanking() && nextCh !== "\n" ? " " : nextCh);
      curHeader += ch + nextCh;
      idx += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out.push(isBlanking() ? " " : ch);
      curHeader += ch;
      idx++;
      continue;
    }
    if (ch === "#" && cleaned[idx + 1] === "{") {
      interpDepth++;
      out.push(isBlanking() ? "  " : "#{");
      curHeader += "#{";
      idx += 2;
      continue;
    }
    if (interpDepth > 0) {
      if (ch === "{") interpDepth++;
      else if (ch === "}") interpDepth--;
      out.push(isBlanking() && ch !== "\n" ? " " : ch);
      curHeader += ch;
      idx++;
      continue;
    }
    if (ch === "{") {
      const hdr = curHeader.trim();
      const topFrame = skipStack.length > 0 ? skipStack[skipStack.length - 1] : null;
      const parentMode = topFrame ? topFrame.mode : "none";
      const parentKeepNested = Boolean(topFrame?.keepNestedAll);
      let nextMode = parentMode;
      let nextKeepNested = parentKeepNested;
      if (isTokenDefinitionHeader(hdr)) {
        if (/^@(?:theme|property)\b/i.test(hdr)) {
          nextMode = "all";
          nextKeepNested = true;
        } else {
          nextMode = "vars-only";
        }
      } else if (parentMode === "vars-only" && isNestedTokenModifierHeader(hdr)) {
        nextMode = "vars-only";
      } else if (!parentKeepNested && !/^@(?:media|supports|layer|container|document|scope)\b/i.test(hdr)) {
        nextMode = "none";
      }
      skipStack.push({ mode: nextMode, keepNestedAll: nextKeepNested });
      out.push(ch);
      resetStmt(out.length);
    } else if (ch === "}") {
      skipStack.pop();
      out.push(ch);
      resetStmt(out.length);
    } else if (inCustomPropDecl) {
      if (ch === "(") varParenDepth++;
      else if (ch === ")") varParenDepth = Math.max(0, varParenDepth - 1);
      if (ch === ";" && varParenDepth === 0) {
        out.push(";");
        resetStmt(out.length);
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
    } else if (topMode() === "vars-only" && ch === ":" && cleaned[idx + 1] !== ":" && /^--[a-zA-Z0-9_-]+$/.test(curHeader.trim())) {
      blankRangeInOut(stmtOutStart);
      inCustomPropDecl = true;
      varParenDepth = 0;
      out.push(" ");
    } else {
      if (isBlanking() && ch !== "\n") out.push(" ");
      else out.push(ch);
      if (ch === ";") {
        resetStmt(out.length);
      } else {
        curHeader += ch;
      }
    }
    idx++;
  }
  return out.join("");
}

export function escMdInline(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ");
}

export function escMdCell(v) {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

export function formatMdCodeSpan(raw, inTableCell = false) {
  let s = escMdInline(raw);
  if (inTableCell) {
    s = s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  }
  let maxRun = 0;
  for (const m of s.matchAll(/`+/g)) {
    if (m[0].length > maxRun) maxRun = m[0].length;
  }
  const fence = "`".repeat(maxRun + 1);
  const needsPad =
    s.startsWith("`") ||
    s.endsWith("`") ||
    (s.length > 0 && s.startsWith(" ") && s.endsWith(" ") && /[^ ]/.test(s));
  return needsPad ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

export function offsetToLine(text, offset) {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function isBoilerplateReason(reason) {
  const trimmed = String(reason || "").trim();
  if (trimmed.length < 12) return true;
  return BOILERPLATE_REASON_RE.test(trimmed);
}

export function parseInlineIgnores(raw, options = {}) {
  const s = String(raw || "");
  const filePathStr = String(options?.filePath || "");
  const allowJsxBraces = !/\.(?:css|scss|sass|less|html?|vue)$/i.test(filePathStr);
  const directives = [];
  const { cleaned, tokens } = scanCommentsPreservingLines(s, true);
  const allTokens = [...(tokens || [])];
  const seenStarts = new Set(allTokens.map((t) => t.start));
  const cleanChars = cleaned.split("");
  const tplRanges = findCssInJsTemplateRanges(cleaned);
  for (const tr of tplRanges) {
    let p = tr.contentStart;
    let cssQ = null;
    while (p < tr.contentEnd) {
      const ch = cleaned[p];
      if (cssQ) {
        if (ch === "\\" && p + 1 < tr.contentEnd) {
          p += 2;
          continue;
        }
        if (ch === "$" && cleaned[p + 1] === "{") {
          const endE = findBalancedDelimEndSimple(cleaned, p + 1, "{", "}");
          if (endE !== -1 && endE < tr.contentEnd) {
            p = endE + 1;
            continue;
          }
        }
        if (ch === cssQ || ch === "\n") cssQ = null;
        p++;
        continue;
      }
      if (ch === "$" && cleaned[p + 1] === "{") {
        const endE = findBalancedDelimEndSimple(cleaned, p + 1, "{", "}");
        if (endE !== -1 && endE < tr.contentEnd) {
          p = endE + 1;
          continue;
        }
      }
      if (ch === '"' || ch === "'") {
        cssQ = ch;
        p++;
        continue;
      }
      if (ch === "/" && cleaned[p + 1] === "*") {
        const closeC = cleaned.indexOf("*/", p + 2);
        if (closeC !== -1 && closeC + 2 <= tr.contentEnd) {
          const cStop = closeC + 2;
          if (!seenStarts.has(p)) {
            seenStarts.add(p);
            allTokens.push({ kind: "block", text: s.slice(p, cStop), start: p, end: cStop });
          }
          maskRangePreservingLines(cleanChars, p, cStop);
          p = cStop;
          continue;
        }
      }
      p++;
    }
  }
  allTokens.sort((a, b) => a.start - b.start);
  const cleanStr = cleanChars.join("");
  const jsxCleanChars = [...cleanChars];
  const singleLineContainers = [];
  const multiLineContainers = [];
  const tokenToMultiContainer = new Map();
  const multiContainerLineSet = new Set();
  const singleContainerLineSet = new Set();

  if (allowJsxBraces) {
    const seenPairs = new Set();
    for (const tok of allTokens) {
      if (tok.kind !== "block" && tok.kind !== "line") continue;
      let oPos = tok.start - 1;
      while (oPos >= 0 && /\s/.test(cleanStr[oPos])) oPos--;
      const endOffsetTok = typeof tok.end === "number" ? tok.end : tok.start + tok.text.length;
      let cPos = endOffsetTok;
      while (cPos < cleanStr.length && /\s/.test(cleanStr[cPos])) cPos++;
      if (oPos < 0 || cPos >= cleanStr.length || cleanStr[oPos] !== "{" || cleanStr[cPos] !== "}") continue;
      const pairKey = `${oPos}:${cPos}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const enclosed = allTokens.filter((t) => {
        const tEnd = typeof t.end === "number" ? t.end : t.start + t.text.length;
        return t.start > oPos && tEnd <= cPos;
      });
      if (enclosed.length === 0) continue;
      const openLineIdx = offsetToLine(s, oPos) - 1;
      const closeLineIdx = offsetToLine(s, cPos) - 1;
      const container = { openPos: oPos, closePos: cPos, openLineIdx, closeLineIdx, enclosed, validJsx: false, targetIdx: -1 };
      if (openLineIdx === closeLineIdx) {
        if (enclosed.every((t) => t.kind === "block")) singleLineContainers.push(container);
      } else {
        multiLineContainers.push(container);
      }
    }
    for (const c of singleLineContainers) {
      jsxCleanChars[c.openPos] = " ";
      jsxCleanChars[c.closePos] = " ";
      singleContainerLineSet.add(c.openLineIdx);
    }
  }

  const preJsxCleanLines = jsxCleanChars.join("").split(/\r?\n/);
  const blockRe = /^\/\*\s*dsaf-ignore\s+([a-z0-9/_-]+)(?:\s+--\s*([\s\S]*?))?\s*\*\/$/i;
  const htmlRe = /^<!--\s*dsaf-ignore\s+([a-z0-9/_-]+)(?:\s+--\s*([\s\S]*?))?\s*-->$/i;
  const lineRe = /^\/\/\s*dsaf-ignore\s+([a-z0-9/_-]+)(?:\s+--\s*([^\r\n]*?))?\s*$/i;
  const anyCommentLineSet = new Set();
  for (const tok of allTokens) {
    const endOffset = typeof tok.end === "number" ? tok.end : tok.start + tok.text.length;
    const ts = offsetToLine(s, tok.start) - 1;
    const te = offsetToLine(s, Math.max(tok.start, endOffset - 1)) - 1;
    for (let li = ts; li <= te; li++) anyCommentLineSet.add(li);
  }
  const standaloneLineIndices = new Set();
  const isBareConnectorLine = (ln) => String(ln || "").replace(/&&|\|\||[{?:(]/g, "").trim().length === 0;
  const parsedToks = [];

  for (const tok of allTokens) {
    const trimmed = tok.text.trim();
    const m = tok.kind === "block" ? blockRe.exec(trimmed) : tok.kind === "html" ? htmlRe.exec(trimmed) : lineRe.exec(trimmed);
    if (!m) continue;
    const startLineIdx = offsetToLine(s, tok.start) - 1;
    const endOffset = typeof tok.end === "number" ? tok.end : tok.start + tok.text.length;
    const endLineIdx = offsetToLine(s, Math.max(tok.start, endOffset - 1)) - 1;
    parsedToks.push({ tok, m, startLineIdx, endLineIdx });
    const prelimStartHasCode = !isBareConnectorLine(preJsxCleanLines[startLineIdx]);
    const prelimEndHasCode = endLineIdx !== startLineIdx && !isBareConnectorLine(preJsxCleanLines[endLineIdx]);
    if (!prelimStartHasCode && !prelimEndHasCode) {
      for (let li = startLineIdx; li <= endLineIdx; li++) standaloneLineIndices.add(li);
    }
  }

  if (allowJsxBraces) {
    const isCommentOnlySingleLine = (idx) => singleContainerLineSet.has(idx) && (preJsxCleanLines[idx] || "").trim() === "";
    const jsxChildBraceStarts =
      options?.markupCtx?.jsxChildBraceStarts ||
      (multiLineContainers.length > 0
        ? scanMarkupContexts(cleaned, { isMarkupSfc: /\.(?:astro|svelte)$/i.test(filePathStr), braceExprs: true }).jsxChildBraceStarts
        : new Set());
    const lineRanges = [];
    let lrStart = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === "\n") {
        const lineEnd = k > 0 && s[k - 1] === "\r" ? k - 1 : k;
        lineRanges.push({ start: lrStart, end: lineEnd });
        lrStart = k + 1;
      }
    }
    lineRanges.push({ start: lrStart, end: s.length });
    const liveLine = (idx) =>
      idx >= 0 && idx < lineRanges.length ? jsxCleanChars.slice(lineRanges[idx].start, lineRanges[idx].end).join("") : "";
    const beforeOkContainers = [];
    multiLineContainers.sort((a, b) => a.openPos - b.openPos);
    for (const c of multiLineContainers) {
      if (jsxChildBraceStarts.has(c.openPos)) {
        c.beforeOk = true;
        beforeOkContainers.push(c);
        continue;
      }
      let bPos = c.openPos - 1;
      while (bPos >= 0) {
        while (bPos >= 0 && /\s/.test(jsxCleanChars[bPos])) bPos--;
        if (bPos < 0) break;
        let skipped = false;
        for (let ci = beforeOkContainers.length - 1; ci >= 0; ci--) {
          const pc = beforeOkContainers[ci];
          if (bPos >= pc.openPos && bPos <= pc.closePos) {
            bPos = pc.openPos - 1;
            skipped = true;
            break;
          }
        }
        if (!skipped) break;
      }
      if (bPos < 0) {
        c.beforeOk = true;
        beforeOkContainers.push(c);
        continue;
      }
      const prevLineBegin = s.lastIndexOf("\n", bPos) + 1;
      const beforeTokTrim = jsxCleanChars.slice(prevLineBegin, bPos + 1).join("").trim();
      if (!beforeTokTrim || beforeTokTrim === "---" || /(?:&&|\|\||[>({[?:,;]|=>|\breturn)$/.test(beforeTokTrim)) {
        c.beforeOk = true;
        beforeOkContainers.push(c);
      }
    }
    multiLineContainers.sort((a, b) => b.openPos - a.openPos);
    for (const c of multiLineContainers) {
      if (!c.beforeOk) continue;
      const closeLineEnd = c.closeLineIdx < lineRanges.length ? lineRanges[c.closeLineIdx].end : s.length;
      const afterSameLine = jsxCleanChars.slice(c.closePos + 1, closeLineEnd).join("").trim();
      if (afterSameLine !== "") {
        if (/^[<{]/.test(afterSameLine)) {
          c.validJsx = true;
          c.targetIdx = c.closeLineIdx;
          jsxCleanChars[c.openPos] = " ";
          jsxCleanChars[c.closePos] = " ";
          for (let li = c.openLineIdx; li <= c.closeLineIdx; li++) {
            if (liveLine(li).trim() === "") multiContainerLineSet.add(li);
          }
          for (const t of c.enclosed) tokenToMultiContainer.set(t, c);
        }
        continue;
      }
      let afterCloseIdx = c.closeLineIdx + 1;
      while (
        afterCloseIdx < preJsxCleanLines.length &&
        (standaloneLineIndices.has(afterCloseIdx) ||
          multiContainerLineSet.has(afterCloseIdx) ||
          isCommentOnlySingleLine(afterCloseIdx) ||
          /^\s*$/.test(liveLine(afterCloseIdx)))
      ) {
        afterCloseIdx++;
      }
      const afterCloseTrim = afterCloseIdx < lineRanges.length ? liveLine(afterCloseIdx).trim() : "";
      if (afterCloseTrim && /^[<{]/.test(afterCloseTrim)) {
        c.validJsx = true;
        c.targetIdx = afterCloseIdx;
        jsxCleanChars[c.openPos] = " ";
        jsxCleanChars[c.closePos] = " ";
        for (let li = c.openLineIdx; li <= c.closeLineIdx; li++) {
          if (liveLine(li).trim() === "") multiContainerLineSet.add(li);
        }
        for (const t of c.enclosed) tokenToMultiContainer.set(t, c);
      }
    }
  }

  const finalCleanLines = jsxCleanChars.join("").split(/\r?\n/);
  standaloneLineIndices.clear();
  const commentOnlyLines = new Set();
  for (let li = 0; li < finalCleanLines.length; li++) {
    if ((anyCommentLineSet.has(li) || singleContainerLineSet.has(li) || multiContainerLineSet.has(li)) && (finalCleanLines[li] || "").trim() === "") {
      commentOnlyLines.add(li);
    }
  }

  for (const pt of parsedToks) {
    const { tok, m, startLineIdx, endLineIdx } = pt;
    const startHasCode = !isBareConnectorLine(finalCleanLines[startLineIdx]);
    const endHasCode = endLineIdx !== startLineIdx && !isBareConnectorLine(finalCleanLines[endLineIdx]);
    const lineIsInline = startHasCode || endHasCode;
    if (!lineIsInline) {
      for (let li = startLineIdx; li <= endLineIdx; li++) standaloneLineIndices.add(li);
    }
    const rawRule = m[1];
    const rawReason = (m[2] ?? "").replace(/\s+/g, " ").trim();
    let ruleId = rawRule.trim().toLowerCase();
    if (!ruleId.includes("/")) ruleId = `dsaf/${ruleId}`;
    directives.push({
      ruleId,
      reason: rawReason,
      line: startLineIdx + 1,
      endLine: endLineIdx + 1,
      isInline: lineIsInline,
      multiContainer: tokenToMultiContainer.get(tok) || null,
      targetLine: lineIsInline ? (!startHasCode && endHasCode ? endLineIdx + 1 : startLineIdx + 1) : endLineIdx + 2,
      used: false,
      rejected: false,
    });
  }
  for (const d of directives) {
    if (d.isInline) continue;
    if (d.multiContainer?.validJsx && d.multiContainer.targetIdx >= 0) {
      d.targetLine = d.multiContainer.targetIdx + 1;
    } else {
      let nextIdx = d.endLine;
      while (nextIdx < finalCleanLines.length && (standaloneLineIndices.has(nextIdx) || commentOnlyLines.has(nextIdx))) {
        nextIdx++;
      }
      d.targetLine = nextIdx + 1;
    }
  }
  return directives;
}

export function applyIgnores(findings, rawContent, filePath, options = {}) {
  const directives = parseInlineIgnores(rawContent, { filePath });
  const evaluatedRules = options.evaluatedRules
    ? new Set([...options.evaluatedRules].map((r) => String(r || "").trim().toLowerCase()))
    : null;
  const active = [];
  const waived = [];
  const extraFindings = [];
  const rejectedDirs = new Set();

  for (const f of findings) {
    const rawRule = typeof f.ruleId === "string" ? f.ruleId.trim().toLowerCase() : "";
    const ruleId = rawRule || "dsaf/unknown";
    const meta = Object.prototype.hasOwnProperty.call(RULE_CATALOG, ruleId) ? RULE_CATALOG[ruleId] : null;
    const rawTier = typeof f.tier === "string" ? f.tier.trim().toLowerCase() : "";
    const validCallerTier = rawTier === "floor" || rawTier === "reflex" || rawTier === "finish" ? rawTier : "";
    const tier = meta?.tier === "floor" ? "floor" : validCallerTier || meta?.tier || "reflex";
    const rawSev = typeof f.severity === "string" ? f.severity.trim().toLowerCase() : "";
    const severity = tier === "floor" ? "error" : rawSev || meta?.defaultLevel || "warning";
    const norm = { ...f, ruleId, file: f.file || filePath, tier, severity };

    const matchingDir = directives.find((d) =>
      d.isInline
        ? d.ruleId === norm.ruleId && (d.line === norm.line || d.targetLine === norm.line)
        : d.ruleId === norm.ruleId && ((norm.line >= d.line && norm.line <= d.endLine) || d.targetLine === norm.line)
    );

    if (!matchingDir) {
      active.push(norm);
      continue;
    }

    if (tier === "floor") {
      active.push(norm);
      if (!rejectedDirs.has(matchingDir)) {
        rejectedDirs.add(matchingDir);
        matchingDir.rejected = true;
        extraFindings.push({
          file: filePath,
          line: matchingDir.line,
          ruleId: "dsaf/floor-waiver-rejected",
          tier: "floor",
          severity: "error",
          targetRuleId: norm.ruleId,
          message: `Cannot waive Floor rule '${norm.ruleId}' via dsaf-ignore; fix the underlying Floor defect.`,
        });
      }
      continue;
    }

    if (isBoilerplateReason(matchingDir.reason)) {
      active.push(norm);
      if (!rejectedDirs.has(matchingDir)) {
        rejectedDirs.add(matchingDir);
        matchingDir.rejected = true;
        extraFindings.push({
          file: filePath,
          line: matchingDir.line,
          ruleId: "dsaf/waiver-reason-weak",
          tier: "reflex",
          severity: "warning",
          targetRuleId: norm.ruleId,
          message: `Reflex waiver for '${norm.ruleId}' requires concrete justification (-- <reason >= 12 chars>).`,
        });
      }
      continue;
    }

    matchingDir.used = true;
    waived.push({ ...norm, waiverReason: matchingDir.reason, waiverLine: matchingDir.line });
  }

  const unusedIgnores = [];
  for (const d of directives) {
    if (!d.used && !d.rejected) {
      if (evaluatedRules && Object.prototype.hasOwnProperty.call(RULE_CATALOG, d.ruleId) && !evaluatedRules.has(d.ruleId)) {
        continue;
      }
      const stale = {
        file: filePath,
        line: d.line,
        ruleId: "dsaf/unused-ignore",
        tier: "finish",
        severity: "warning",
        targetRuleId: d.ruleId,
        message: `Unused dsaf-ignore directive for '${d.ruleId}' (no matching finding on line ${d.isInline ? d.line : `${d.line}..${d.targetLine}`}).`,
      };
      unusedIgnores.push(stale);
      if (options.reportUnusedIgnores) {
        extraFindings.push(stale);
      }
    }
  }

  const allActive = [...active, ...extraFindings];
  return {
    active: allActive,
    waived,
    unusedIgnores,
    counts: {
      floor: allActive.filter((x) => x.tier === "floor").length,
      reflex: allActive.filter((x) => x.tier === "reflex").length,
      finish: allActive.filter((x) => x.tier === "finish").length,
      waived: waived.length,
      unusedIgnores: unusedIgnores.length,
    },
  };
}

function normalizeSarifLevel(level) {
  const v = String(level || "warning").toLowerCase();
  if (v === "error") return "error";
  if (v === "note" || v === "info") return "note";
  if (v === "none") return "none";
  return "warning";
}

function relativeToRepoRoot(filePath, repoRoot) {
  if (!repoRoot) return String(filePath);
  const rawStr = String(filePath);
  if (process.platform !== "win32" && (/^[a-zA-Z]:[\\/]/.test(rawStr) || /^\\\\[^\\]/.test(rawStr))) return rawStr;
  const rawRoot = resolve(repoRoot);
  const rawTarget = resolve(rawRoot, rawStr);
  const isOutside = (rel) => rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel);
  const relRaw = relative(rawRoot, rawTarget);
  if (!isOutside(relRaw)) return relRaw;
  let realRoot = canonPathSimple(rawRoot);
  let realTarget = canonPathSimple(rawTarget);
  try {
    realRoot = resolvePathFollowingSymlinks(null, rawRoot, "repoRoot");
    realTarget = resolvePathFollowingSymlinks(null, rawTarget, "filePath");
  } catch {}
  const relReal = relative(realRoot, realTarget);
  if (!isOutside(relReal)) return relReal;
  return relRaw;
}

function toPosixPath(filePath, repoRoot) {
  if (!filePath) return "unknown";
  let raw = String(filePath);
  if (/^(?:https?:\/\/|data:|cdp:\/\/)/i.test(raw)) return raw;
  if (/^file:/i.test(raw)) {
    try {
      raw = fileURLToPath(new URL(raw));
    } catch {}
  }
  const absOrRel = repoRoot ? relativeToRepoRoot(raw, repoRoot) : raw;
  const posix = String(absOrRel).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return posix || ".";
}

function toPosixUri(filePath, repoRoot) {
  if (!filePath) return "unknown";
  let raw = String(filePath);
  if (/^https?:\/\//i.test(raw)) {
    try { return new URL(raw).href; } catch { return raw; }
  }
  if (/^(?:data:|cdp:\/\/)/i.test(raw)) return raw;
  if (/^file:/i.test(raw)) {
    try {
      raw = fileURLToPath(new URL(raw));
    } catch {
      return raw;
    }
  }
  const absOrRel = repoRoot ? relativeToRepoRoot(raw, repoRoot) : raw;
  const posix = String(absOrRel).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!posix) return ".";
  if (/^[a-zA-Z]:\//.test(posix)) {
    const drive = posix.slice(0, 2);
    const rest = posix
      .slice(3)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return "file:" + "///" + `${drive}/${rest}`;
  }
  if (posix.startsWith("//")) {
    const uncParts = posix
      .slice(2)
      .split("/")
      .filter((seg, idx) => idx === 0 || seg !== "")
      .map((seg) => encodeURIComponent(seg));
    return "file:" + "//" + uncParts.join("/");
  }
  if (posix.startsWith("/")) {
    try {
      return pathToFileURL(absOrRel).href;
    } catch {
      return posix;
    }
  }
  return posix
    .split("/")
    .map((seg) => (seg === ".." || seg === "." ? seg : encodeURIComponent(seg)))
    .join("/");
}

function resolveCatalogRule(rawRuleId) {
  const trimmed = String(rawRuleId || "").trim() || "dsaf/unknown";
  const lower = trimmed.toLowerCase();
  const cat = Object.prototype.hasOwnProperty.call(RULE_CATALOG, trimmed)
    ? RULE_CATALOG[trimmed]
    : Object.prototype.hasOwnProperty.call(RULE_CATALOG, lower)
    ? RULE_CATALOG[lower]
    : null;
  return { ruleId: cat ? cat.id : trimmed, cat };
}

export function formatSarif(findings, { toolVersion = CI_REPORT_VERSION, repoRoot = null } = {}) {
  const seenRules = new Map();
  for (const f of findings) {
    const { ruleId, cat } = resolveCatalogRule(f.ruleId);
    if (!seenRules.has(ruleId)) {
      const msgHelp = String(f.message ?? "").trim() || "Resolve DSAF finding.";
      const fallbackTier = String(f.tier || "reflex").trim().toLowerCase() || "reflex";
      const rawSev = typeof f.severity === "string" ? f.severity.trim() : "";
      const fallbackLevel = rawSev || (fallbackTier === "floor" ? "error" : "warning");
      seenRules.set(
        ruleId,
        cat || {
          id: ruleId,
          tier: fallbackTier,
          defaultLevel: normalizeSarifLevel(fallbackLevel),
          shortDescription: ruleId,
          help: msgHelp,
        }
      );
    }
  }

  const rules = [...seenRules.values()].map((r) => ({
    id: r.id,
    shortDescription: { text: r.shortDescription },
    help: { text: r.help },
    defaultConfiguration: { level: normalizeSarifLevel(r.defaultLevel) },
    properties: { tier: r.tier },
  }));

  const results = findings.map((f) => {
    const rawLine = Number(f.line);
    const line = Number.isFinite(rawLine) && rawLine >= 1 ? Math.floor(rawLine) : 1;
    const { ruleId, cat } = resolveCatalogRule(f.ruleId);
    const effTier =
      cat?.tier === "floor" ? "floor" : String(f.tier || cat?.tier || "reflex").trim().toLowerCase() || "reflex";
    const rawSev = typeof f.severity === "string" ? f.severity.trim() : "";
    const effSev = rawSev || cat?.defaultLevel || (effTier === "floor" ? "error" : "warning");
    const msgText = String(f.message ?? "").trim() || cat?.shortDescription || ruleId;
    return {
      ruleId,
      level: normalizeSarifLevel(effSev),
      message: { text: msgText },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toPosixUri(f.file, repoRoot) },
            region: { startLine: line },
          },
        },
      ],
      properties: { tier: effTier },
    };
  });

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "DSAF",
            version: toolVersion,
            informationUri: "https://zintaen.github.io/dsaf/",
            rules,
          },
        },
        results,
      },
    ],
  };
}

function escapeGithubData(str) {
  return String(str || "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeGithubProp(str) {
  return escapeGithubData(str).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function formatGithubAnnotations(findings, { repoRoot = null } = {}) {
  return findings
    .map((f) => {
      const file = escapeGithubProp(toPosixPath(f.file, repoRoot));
      const rawLine = Number(f.line);
      const line = Number.isFinite(rawLine) && rawLine >= 1 ? Math.floor(rawLine) : 1;
      const { ruleId, cat } = resolveCatalogRule(f.ruleId);
      const title = escapeGithubProp(ruleId);
      const effTier =
        cat?.tier === "floor" ? "floor" : String(f.tier || cat?.tier || "reflex").trim().toLowerCase() || "reflex";
      const rawSev = typeof f.severity === "string" ? f.severity.trim() : "";
      const effSev = rawSev || cat?.defaultLevel || (effTier === "floor" ? "error" : "warning");
      const sev = effSev.toLowerCase();
      const cmd = sev === "error" ? "error" : sev === "note" || sev === "info" ? "notice" : "warning";
      const tierStr = effSev ? effTier.toUpperCase() : "REFLEX";
      const msgText = String(f.message ?? "").trim() || cat?.shortDescription || ruleId;
      const msg = escapeGithubData(`[${tierStr}] ${msgText}`);
      return `::${cmd} file=${file},line=${line},title=${title}::${msg}`;
    })
    .join("\n");
}

function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "dsaf-cireport-test-"));
  try {
    const sampleCss = [
      "/* dsaf-ignore dsaf/no-transition-all -- cannot waive floor rule */",
      ".a { transition: all 200ms; }",
      "/* dsaf-ignore dsaf/hardcoded-color -- ok */",
      ".b { color: #ff00aa; }",
      ".c { color: #123456; } /* dsaf-ignore dsaf/hardcoded-color -- brand gradient SVG fallback canvas */",
      "/* dsaf-ignore dsaf/important-override -- stale waiver after cleanup */",
      ".d { color: var(--brand); }",
    ].join("\n");

    const rawFindings = [
      { file: "src/app.css", line: 2, ruleId: "dsaf/no-transition-all", tier: "floor", severity: "error", message: "transition: all banned" },
      { file: "src/app.css", line: 4, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "Hardcoded #ff00aa" },
      { file: "src/app.css", line: 5, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "Hardcoded #123456" },
    ];

    const res = applyIgnores(rawFindings, sampleCss, "src/app.css", { reportUnusedIgnores: true });
    assert.ok(res.active.some((x) => x.ruleId === "dsaf/no-transition-all"), "Floor finding must remain active");
    assert.ok(res.active.some((x) => x.ruleId === "dsaf/floor-waiver-rejected"), "Floor waiver must be rejected");
    assert.ok(res.active.some((x) => x.ruleId === "dsaf/hardcoded-color" && x.line === 4), "Weak reason reflex must stay active");
    assert.ok(res.active.some((x) => x.ruleId === "dsaf/waiver-reason-weak"), "Weak reason must emit warning");
    assert.equal(res.waived.length, 1, "Only concrete reflex waiver on line 5 should be waived");
    assert.equal(res.waived[0].line, 5);
    assert.ok(res.active.some((x) => x.ruleId === "dsaf/unused-ignore" && x.line === 6), "Stale waiver must be flagged");

    const sarif = formatSarif(res.active, { toolVersion: CI_REPORT_VERSION });
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "DSAF");
    assert.ok(sarif.runs[0].results.length >= 5);

    const gh = formatGithubAnnotations(res.active);
    assert.match(gh, /^::error file=src\/app\.css,line=2,title=dsaf\/no-transition-all::/m);
    assert.match(gh, /^::warning file=src\/app\.css,line=6,title=dsaf\/unused-ignore::/m);

    const outSarif = join(scratch, "out.sarif");
    writeFileSync(outSarif, JSON.stringify(sarif, null, 2), "utf8");

    // Round 1 regressions: url(//cdn), // matches /*, descendant dark theme selectors, JSX {/* dsaf-ignore */}, SARIF encoding
    const urlCss = ".hero { background: url(//cdn.example.com/bg.png); transition: all 200ms; }";
    assert.match(stripCommentsPreservingLines(urlCss), /url\(\/\/cdn\.example\.com/);
    const trickyComments = "// matches /*\n.bad { transition: all 200ms; }\n// end */\n";
    assert.match(stripCommentsPreservingLines(trickyComments), /transition: all 200ms/);
    const themeDesc = `[data-theme="dark"] .card { color: #ff00aa !important; }\n.widget {\n  --x: :root;\n  &:hover { color: #123456 !important; }\n}\n`;
    const strippedTheme = stripTokenBlocksPreservingLines(themeDesc);
    assert.match(strippedTheme, /color: #ff00aa/);
    assert.match(strippedTheme, /color: #123456/);
    const jsxWaiver = [
      "{/* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback for canvas */}",
      '<div style={{ color: "#ff00aa" }} />',
    ].join("\n");
    const jsxRes = applyIgnores(
      [{ file: "App.tsx", line: 2, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex" }],
      jsxWaiver,
      "App.tsx",
      { reportUnusedIgnores: true }
    );
    assert.equal(jsxRes.waived.length, 1, "Standalone JSX comment must waive next line");
    assert.equal(jsxRes.unusedIgnores.length, 0);
    const encSarif = formatSarif([{ file: "app/users/[id]/my page.tsx", ruleId: "custom/x", severity: "info", message: "test", line: 3 }]);
    assert.equal(encSarif.runs[0].results[0].level, "note");
    assert.equal(encSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "app/users/%5Bid%5D/my%20page.tsx");

    // Round 2 regressions: GitHub path decoding/severity, quoted CSS braces, bare body/html, JSX apostrophe + regex backtick, leading inline waiver
    const encGh = formatGithubAnnotations([
      { file: "app/users/[id]/my page.tsx", line: 3, ruleId: "dsaf/runtime-check-failed", tier: "floor", severity: "INFO", message: "ok" },
    ]);
    assert.match(encGh, /^::notice file=app\/users\/\[id\]\/my page\.tsx,line=3,/);
    const quotedBraceCss = ':root { --open: "{"; }\nbody { color: #ff00aa !important; padding: 13px; }\n';
    const strippedBrace = stripTokenBlocksPreservingLines(quotedBraceCss);
    assert.match(strippedBrace, /color: #ff00aa/, "Quoted '{' in :root and bare body {} must not mask component rules");
    const apostropheAndRegex = '<p>Don\'t panic</p>\n{/* <button className="transition-all" /> */}\nconst re = /`/;\n// <button className="transition-all" />\n';
    assert.doesNotMatch(stripCommentsPreservingLines(apostropheAndRegex), /transition-all/);
    const leadInline = [
      "/* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback for legacy canvas */ .a { color: #111111; }",
      ".b { color: #222222; }",
    ].join("\n");
    const leadRes = applyIgnores(
      [
        { file: "a.css", line: 1, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex1" },
        { file: "a.css", line: 2, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex2" },
      ],
      leadInline,
      "a.css"
    );
    assert.equal(leadRes.waived.length, 1, "Leading inline waiver must waive only line 1");
    assert.equal(leadRes.active.length, 1, "Line 2 must remain active");

    // Round 3 regressions: JSX /> regex guard, keyword/arrow regex literal, scoped html/body token selector, mismatched comment closer
    const jsxCloseAndArrow = [
      '<input {...props} /> {/* <button className="transition-all" /> */}',
      'const f = () => /`/;\n// <div className="transition-all" />',
      'return /`/;\n/* <div className="transition-all" /> */',
    ].join("\n");
    assert.doesNotMatch(
      stripCommentsPreservingLines(jsxCloseAndArrow),
      /transition-all/,
      "JSX self-closing /> and arrow/return regex literals must strip trailing comments cleanly"
    );
    const nonTokenHtmlBody = [
      'html[dir="rtl"] { color: #ff00aa !important; padding: 13px; }',
      'body[data-page="checkout"] { color: #112233 !important; }',
    ].join("\n");
    const nonTokRes = stripTokenBlocksPreservingLines(nonTokenHtmlBody);
    assert.match(nonTokRes, /#ff00aa/, "html[dir=rtl] must not be treated as a token block");
    assert.match(nonTokRes, /#112233/, "body[data-page=checkout] must not be treated as a token block");
    const r3Ignores = parseInlineIgnores("/* dsaf-ignore dsaf/hardcoded-color -- maps A --> B in legacy chart */\n.a { color: #111; }");
    assert.equal(r3Ignores.length, 1);
    assert.equal(r3Ignores[0].reason, "maps A --> B in legacy chart");
    assert.equal(r3Ignores[0].isInline, false);
    assert.equal(r3Ignores[0].targetLine, 2);

    // Round 4 regressions: @theme static, template ${ // comment }, JSX / {page} {/* */}, count++ / total, stacked & double inline ignores
    const r4Theme = "@theme static {\n  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.12);\n  --color-brand: #1d4ed8;\n}\n.btn { color: #ff00aa; }\n";
    const r4ThemeStripped = stripTokenBlocksPreservingLines(r4Theme);
    assert.doesNotMatch(r4ThemeStripped, /#1d4ed8/, "@theme static tokens must be stripped");
    assert.match(r4ThemeStripped, /#ff00aa/, "Rules after @theme static must remain");

    const r4Comments = [
      'const cls = `card ${\n  // transition-all w-[100vw]\n  active ? "on" : "off"\n}`;',
      '<div>{section} / {page} {/* <button className="transition-all" /> */}</div>',
      '<p>Route: /home {/* <button className="transition-all" /> */}</p>',
      'const pct = count++ / total; // transition-all',
    ].join("\n");
    assert.doesNotMatch(stripCommentsPreservingLines(r4Comments), /transition-all/, "Template expr, JSX slash before comment, and postfix ++ division must strip comments cleanly");

    const stackedSrc = [
      "/* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback */",
      "/* dsaf-ignore dsaf/important-override -- host theme cascade override */",
      ".legacy { color: #ff00aa !important; }",
      ".two { color: #123456 !important; } /* dsaf-ignore dsaf/hardcoded-color -- brand fallback tint */ /* dsaf-ignore dsaf/important-override -- host cascade override */",
    ].join("\n");
    const stackedRes = applyIgnores(
      [
        { file: "s.css", line: 3, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex" },
        { file: "s.css", line: 3, ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", message: "imp" },
        { file: "s.css", line: 4, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex2" },
        { file: "s.css", line: 4, ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", message: "imp2" },
      ],
      stackedSrc,
      "s.css",
      { reportUnusedIgnores: true }
    );
    assert.equal(stackedRes.active.length, 0, "Stacked and same-line multi-rule Reflex waivers must waive all 4 findings");
    assert.equal(stackedRes.waived.length, 4);
    assert.equal(stackedRes.unusedIgnores.length, 0);

    // Round 5 regressions: HTML comment after /home, if (...) /`/ regex, plural possessive Users', comment alongside standalone dsaf-ignore
    const r5Lex = [
      '<p>Route: /home <!-- <div class="transition-all"></div> --></p>',
      'if (ok) /`/.test(str);\n// <button className="transition-all" />\n/* <div className="transition-all" /> */',
      '<p>Users\' settings</p> {/* <button className="transition-all" /> */}',
    ].join("\n");
    assert.doesNotMatch(
      stripCommentsPreservingLines(r5Lex),
      /transition-all/,
      "HTML <!-- after /path, control-paren regex literal, and plural possessive Users' must still strip comments cleanly"
    );
    const r5MixedStandalone = [
      "/* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback for canvas */ /* legacy */",
      ".a { color: #ff00aa; }",
    ].join("\n");
    const r5MixedRes = applyIgnores(
      [{ file: "m.css", line: 2, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex" }],
      r5MixedStandalone,
      "m.css",
      { reportUnusedIgnores: true }
    );
    assert.equal(r5MixedRes.waived.length, 1, "Standalone dsaf-ignore sharing line with regular comment must still waive next line");
    assert.equal(r5MixedRes.unusedIgnores.length, 0);

    // Round 6 regressions: JSX division before <Link to={`/x`}> and <a href="/docs">, evaluatedRules filtering
    const r6Jsx = [
      'export const R6 = ({ a }: { a: number }) => <div>{a} / <Link to={`/x`}>X</Link> {/* <div className="transition-all" /> */}</div>;',
      'export const R6b = ({ a }: { a: number }) => <div>{a} / <a href="/docs">D</a></div>; /* <div className="transition-all" /> */',
      'export const R6c = (s: string) => /foo\\/bar/gi.test(s) && /a/v.test(s);',
    ].join("\n");
    const r6Stripped = stripCommentsPreservingLines(r6Jsx);
    assert.doesNotMatch(r6Stripped, /transition-all/, "JSX division before <Link>/<a> must not trap comment stripping in fake regex");
    assert.match(r6Stripped, /\/foo\\\/bar\/gi\.test\(s\)/, "Valid regex literal with flags must be preserved");
    assert.match(r6Stripped, /\/a\/v\.test\(s\)/, "Valid v-flag regex literal must be preserved");

    const evalFilterSrc = [
      "/* dsaf-ignore dsaf/off-grid-spacing -- intentional 1px optical align */",
      "/* dsaf-ignore dsaf/no-typo-rule -- bogus rule name must still warn */",
      ".ok { margin: 13px; }",
    ].join("\n");
    const evalFloorRes = applyIgnores([], evalFilterSrc, "e.css", {
      reportUnusedIgnores: true,
      evaluatedRules: ["dsaf/no-transition-all", "dsaf/no-outline-none-naked"],
    });
    assert.equal(evalFloorRes.unusedIgnores.length, 1, "Only unknown/typo rules must flag unused-ignore when Reflex rules are excluded via evaluatedRules");
    assert.equal(evalFloorRes.unusedIgnores[0].targetRuleId, "dsaf/no-typo-rule");

    // Round 7 regressions: multiline quoted attributes, <!-- regex literals, // after non-whitespace, nested-paren custom prop blanker
    const r7Comments = [
      '<button className="\n px-4\n /* dsaf-ignore dsaf/off-grid-spacing -- should stay in attr? */\n">ok</button>',
      '<div className="a\n /* comment */" /> /* <div className="transition-all" /> */',
      "const hasHtmlOpen = /^<!--/.test(s) && /<!--.*?-->/g.test(s);\n// <div className=\"transition-all\" />",
      "if (ok)// <div className=\"transition-all\" />",
      "const arr = [a[0]// <div className=\"transition-all\" />",
      "const proto = <script src=//cdn.example.com/app.js></script>;",
    ].join("\n");
    const r7Stripped = stripCommentsPreservingLines(r7Comments);
    assert.doesNotMatch(r7Stripped, /transition-all/, "Comments after multiline attrs, <!-- regex literals, and )/] delimiters must be stripped");
    assert.match(r7Stripped, /\/\^<!--\/\.test\(s\)/, "Regex /^<!--/ must not abort comment stripping");
    assert.match(r7Stripped, /cdn\.example\.com\/app\.js/, "Unquoted HTML protocol-relative URL after = must be preserved");

    const r7CssProps = [
      '.card {',
      '  --shadow: 0 2px 8px color-mix(in srgb, #123456 50%, var(--a, rgb(1, 2, 3))) !important;',
      '  content: "--keep-quote: #00ffaa;"; color: #ff00aa;',
      '}',
    ].join("\n");
    const r7Blanked = blankCssCustomPropDeclsPreservingLines(r7CssProps);
    assert.doesNotMatch(r7Blanked, /#123456/, "Nested-paren custom prop declaration must be blanked completely");
    assert.doesNotMatch(r7Blanked, /!important/, "!important inside custom prop must be blanked");
    assert.match(r7Blanked, /#ff00aa/, "Declaration after quoted --var: string must remain intact");

    // Round 8 regressions: JS new URL(/* c */), multiline CSS url(//...), JSX division before <a href="/img">,
    // JSX/Vue !important boolean vs string, SCSS #{} custom prop blanking, nested token rule & .card, fake ignores in strings
    const r8UrlsAndJsx = [
      'const u = new URL(href, /* <div className="transition-all" /> */ origin);',
      'const bg = "url(\\n  //cdn.example.com/hero.png\\n)";',
      '.hero { background: url(\n  //cdn.example.com/hero.png\n); }',
      'export const HeroLink = ({ a }: { a: number }) => <div>{a} / <a href="/img/hero.png">Hero</a> {/* <div className="transition-all" /> */}</div>;',
      'export const TopLink = ({ a }: { a: number }) => <div>{a} / <a href="/#top">Top</a></div>; // <div className="transition-all" />\n',
    ].join("\n");
    const r8StrippedUrls = stripCommentsPreservingLines(r8UrlsAndJsx);
    assert.doesNotMatch(r8StrippedUrls, /transition-all/, "JS new URL comment and JSX <a href=\"/img\"> trailing comments must be stripped");
    assert.match(r8StrippedUrls, /\/\/cdn\.example\.com\/hero\.png/, "Multiline CSS url(//...) must stay intact");

    const r8Imp = [
      '<div style={{ opacity: !important ? 0.5 : 1 }} />',
      '<div :style="{ display: !important ? \'none\' : \'block\' }" />',
      '<div style={{ color: "red !important" }} />',
      '<div :style="{ color: \'blue !important\' }" />',
    ].join("\n");
    const r8ImpSurf = extractImportantStyleSurfacePreservingLines(r8Imp, false);
    const r8ImpMatches = r8ImpSurf.match(/!important\b/g) || [];
    assert.equal(r8ImpMatches.length, 2, "Only string-literal !important in JSX/Vue style must extract, never JS !important booleans");

    const r8ScssVar = ".card { --accent: #{$fallback} #ff00aa; }\n.ok { color: var(--accent); }\n";
    assert.doesNotMatch(blankCssCustomPropDeclsPreservingLines(r8ScssVar), /#ff00aa/, "SCSS #{} inside custom property must blank through trailing hex");

    const r8NestedDark = '[data-theme="dark"] { --bg: #0f172a; & .card { color: #ff00aa !important; } @media (min-width: 768px) { --bg: #111827; } }\n';
    const r8NestedRes = stripTokenBlocksPreservingLines(r8NestedDark);
    assert.doesNotMatch(r8NestedRes, /#0f172a|#111827/, "Top and @media token vars in [data-theme=dark] must be masked");
    assert.match(r8NestedRes, /#ff00aa !important/, "Nested & .card rule inside [data-theme=dark] must remain visible");

    const r8FakeIgnores = [
      'const s = "/* dsaf-ignore dsaf/off-grid-spacing -- fake string */";',
      'const tpl = `// dsaf-ignore dsaf/off-grid-spacing -- fake template`;',
      '<button title="line1\n/* dsaf-ignore dsaf/off-grid-spacing -- fake attr */\n" />',
      '/* outer comment\n// dsaf-ignore dsaf/off-grid-spacing -- nested comment\n*/',
    ].join("\n");
    assert.equal(parseInlineIgnores(r8FakeIgnores).length, 0, "Fake dsaf-ignore tokens in strings, templates, attrs, and nested comments must be ignored");

    // Round 9 regressions (R9-A2-01, R9-A2-02, R9-A2-06): base64 data: URLs with ';', JSX {/path} & `/path` attrs,
    // enclosed HTML comments between slashes, /`</g regex, data-style exclusions, Svelte style={!important}, JSX conditional style={cond ? ...}
    const r9DataUriCss = ".icon { background: url(data:image/png;base64,iVBORw0//AA); transition: all 200ms; }\n";
    const r9DataUriClean = stripCommentsPreservingLines(r9DataUriCss);
    assert.match(r9DataUriClean, /transition: all 200ms;/, "CSS data URI containing ';' and '//' must not truncate trailing declarations");

    const r9LexerCases = [
      'export const C1 = ({ a }: { a: number }) => <div>{a} / <Link to={`/ui/dashboard`}>D</Link> {/* <div className="transition-all" /> */}</div>;\n// <div className="transition-all" />',
      'export const C2 = ({ a }: { a: number }) => <div>{a} / <Link to={"/ui/dashboard"}>D</Link> {/* <div className="transition-all" /> */}</div>;',
      '<p>Price: / <!-- <video autoplay> --> / mo</p>',
      'const re = /`</g;\n// <div className="transition-all" />',
    ].join("\n");
    const r9LexerClean = stripCommentsPreservingLines(r9LexerCases);
    assert.doesNotMatch(r9LexerClean, /transition-all|<video autoplay>/, "Comments after JSX {/path}, `/path`, enclosed HTML comments, and /`</g regex must all strip cleanly");

    const r9StyleCases = [
      '<div data-style="padding: 13px; color: red !important">Meta</div>',
      `<div style="color: {!important ? 'red' : 'blue'}">SvelteBool</div>`,
      `<div style="color: {cond ? 'red !important' : 'blue'}">SvelteReal</div>`,
      `<div style={cond ? { color: "red !important", opacity: !important ? 0.5 : 1 } : undefined} />`,
    ].join("\n");
    const r9ImpSurf = extractImportantStyleSurfacePreservingLines(r9StyleCases, false);
    assert.equal((r9ImpSurf.match(/!important\b/g) || []).length, 2, "Must ignore data-style and Svelte/JSX !important booleans while flagging real !important strings");

    // Round 10 regressions (R10-A2-01, R10-A2-02): CSS url(//...) with commas, multiline url(\n data:...//...\n),
    // JSX arrow & expression URL props, /<!--.*?-->/` backtick regex, prose <!-- comment --> between slashes
    const r10UrlsCss = [
      ".hero { background: url(//res.cloudinary.com/demo/image/upload/w_800,f_auto/sample.jpg); transition: all 200ms; }",
      ".icon { background: url(\n  data:image/png;base64,iVBORw0//AA\n); transition: all 200ms; }",
    ].join("\n");
    const r10UrlsClean = stripCommentsPreservingLines(r10UrlsCss);
    assert.equal((r10UrlsClean.match(/transition: all 200ms;/g) || []).length, 2, "Comma and multiline data: URLs must preserve trailing declarations");

    const r10LexerCases = [
      'export const Nav = ({ a }: { a: number }) => <div>{a} / <Link onClick={() => go()} to="/ui/dashboard">Home</Link> {/* <div className="transition-all" /> */}</div>;',
      'export const Nav2 = ({ a }: { a: number }) => <div>{a} / <Link to={base + "/ui/dashboard"}>Home</Link> {/* <div className="transition-all" /> */}</div>;',
      'const re = /<!--.*?-->`/;\n// <div className="transition-all" />',
      '<p>Price: /foo <!-- transition-all --> bar/ mo</p>',
      '<div>Path: /a <!-- w-[100vw] --> b/ </div>',
    ].join("\n");
    const r10LexerClean = stripCommentsPreservingLines(r10LexerCases);
    assert.doesNotMatch(r10LexerClean, /transition-all|w-\[100vw\]/, "JSX arrow/expr URL props, <!-- regex before backtick, and prose HTML comments between slashes must strip cleanly");

    // Round 11 regressions (R11-A2-01, R11-A2-09, R11-A2-19, R11-A2-20):
    assert.match(
      stripCommentsPreservingLines(".hero { @apply bg-[url(//cdn.example.com/a.png)] transition-all; }"),
      /transition-all/,
      "Tailwind arbitrary url(//...) must preserve subsequent utilities"
    );
    assert.match(
      stripCommentsPreservingLines(".hero { @apply bg-[url(data:image/png;base64,abc//def)] transition-all; }"),
      /transition-all/,
      "Tailwind arbitrary data: url with // must preserve subsequent utilities"
    );
    assert.doesNotMatch(
      stripCommentsPreservingLines("switch (x) { case 1:// <div className='transition-all' />\n break; }"),
      /transition-all/,
      "Switch case comment after 1: must be stripped"
    );
    assert.doesNotMatch(
      stripCommentsPreservingLines("const y = ok ? a :// <div className='transition-all' />\n b;"),
      /transition-all/,
      "Ternary comment after : must be stripped"
    );
    const impStyled = extractImportantStyleSurfacePreservingLines(
      [
        "const Box = styled.div<{ active: boolean }>`color: ${({ active }) => (active ? 'red !important' : 'blue')};`;",
        "const Btn = styled.button<{ onClick?: () => void }>\n`color: red !important;`;",
        '<div style:color="blue !important">Hi</div>',
      ].join("\n"),
      false
    );
    assert.equal((impStyled.match(/!important/g) || []).length, 3, "Generics with =>, `${...}` string literals, and Svelte style: directives must extract !important");
    const scssMasked = stripTokenBlocksPreservingLines(":root {\n  --bg: #fff;\n  @media (min-width: #{$bp}) {\n    --fg: #112233;\n  }\n}\n.btn { color: #ff00aa; }");
    assert.doesNotMatch(scssMasked, /#112233/, "SCSS #{$bp} interpolation inside :root @media must keep token custom prop masked");
    assert.match(scssMasked, /#ff00aa/, "Rules after :root @media #{$bp} must remain unmasked");

    // Round 12 regressions (R12-A2-11, R12-A2-12, R12-A2-13, R12-A2-22):
    const r12Lex = stripCommentsPreservingLines(
      [
        'export const Rate = ({ a, b }: any) => <div>{a} / {b || "1 / 2"} {/* <button className="transition-all" /> */}</div>;',
        'export const X = ({ cur, max }: any) => <div>{cur} / {format("a / b")} {/* <div className="transition-all" /> */}</div>;',
        `<p>The '90s era</p> <!-- <div class="transition-all"></div> -->`,
        `<p>Era = '90s</p>\n<!-- <div class="transition-all"></div> -->`,
        `.btn {\n  color://#ff00aa\n  color://transition: all 200ms;\n  color: red;\n}`,
      ].join("\n")
    );
    assert.doesNotMatch(r12Lex, /transition-all|transition:\s*all|#ff00aa/, "JSX / + string literals, '90s contractions, and spaceless ://# comments must strip cleanly");
    const r12UrlCss = stripCommentsPreservingLines(
      ".hero { background: url(//fonts.googleapis.com/css2?family=Inter:wght@400;700); transition: all 200ms; }"
    );
    assert.match(r12UrlCss, /transition: all 200ms;/, "Semicolon inside unquoted protocol-relative url(...) must preserve trailing declarations");

    const r12Imp = extractImportantStyleSurfacePreservingLines(
      [
        'const Input = styled.input.attrs({ type: "text" })`color: red !important;`;',
        'const Btn = styled(Button).withConfig({ shouldForwardProp: () => true })`color: blue !important;`;',
        "const Global = createGlobalStyle`body { color: green !important; }`;",
        'const objCss = css({ color: "red !important" });',
        'const StyledObj = styled.div({ color: "red !important" });',
      ].join("\n"),
      false
    );
    assert.equal((r12Imp.match(/!important/g) || []).length, 5, "attrs/withConfig, createGlobalStyle, and object-syntax css/styled must extract !important");
    const r12BlankEsc = blankCssCustomPropDeclsPreservingLines(
      ".before\\:content-\\[\\'\\*\\'\\] { --a: #fff; color: #ff00aa; }"
    );
    assert.match(r12BlankEsc, /#ff00aa/, "Escaped quotes in CSS selectors must not hide declarations in blankCssCustomPropDeclsPreservingLines");

    // Round 13 regressions (R13-A2-07, R13-A2-08, R13-A2-09, R13-A2-19):
    const r13Lex = stripCommentsPreservingLines(
      [
        `<button disabled={count > 0} title="a > b" className="\n  px-4\n">Go</button> {/* <div className="transition-all" /> */}`,
        `.alpha-css { color: hsl(0 0% 100% / 0.5); content: "a / b"; /* transition: all 200ms; */ }`,
        `.calc-css { width: calc(100% / 2); content: "a / b"; /* transition: all 200ms; */ }`,
        `const msg = '90s rock!'; // <div className="transition-all" />`,
        `.scss-url-like {\n  min-width://transition: all 200ms;\n  color: red;\n}`,
      ].join("\n")
    );
    assert.doesNotMatch(r13Lex, /transition-all|transition:\s*all/, "JSX > inside expr/attr, CSS % alpha + string slash, JS '90s strings, and compound SCSS :// comments must strip cleanly");
    const r13WaiverSrc = `const err = 'cause it broke!'; /* dsaf-ignore dsaf/hardcoded-color -- brand gradient fallback */\n.a { color: #111111; }\n`;
    const r13WaiverRes = applyIgnores(
      [{ file: "r13.tsx", line: 1, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex" }],
      r13WaiverSrc,
      "r13.tsx",
      { reportUnusedIgnores: true }
    );
    assert.equal(r13WaiverRes.waived.length, 1, "Single-quoted 'cause...' JS string before inline waiver must preserve dsaf-ignore");
    assert.equal(r13WaiverRes.unusedIgnores.length, 0);

    // Round 14 regression (R14-A2-01): CSS backslash-escaped quotes/backticks must not open JS/CSS string state
    const r14EscSel = stripCommentsPreservingLines(
      [
        ".before\\:content-\\[\\'\\*\\'\\] { /* transition: all 200ms; */ color: var(--fg); }",
        ".before\\:content-\\[\\`\\*\\`\\] { color: var(--fg); }",
        ".card { /* transition: all 200ms; */ color: var(--fg); }",
      ].join("\n")
    );
    assert.doesNotMatch(r14EscSel, /transition:\s*all/, "Comments inside/after escaped-quote and escaped-backtick selectors must be stripped");
    const r14EscWaiverSrc = ".before\\:content-\\[\\'\\*\\'\\] { color: #ff00aa; } /* dsaf-ignore dsaf/hardcoded-color -- brand asterisk fallback */\n";
    const r14EscWaiverRes = applyIgnores(
      [{ file: "r14.css", line: 1, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "hex" }],
      r14EscWaiverSrc,
      "r14.css",
      { reportUnusedIgnores: true }
    );
    assert.equal(r14EscWaiverRes.waived.length, 1, "Escaped single quotes in selector must not drop trailing inline dsaf-ignore");
    assert.equal(r14EscWaiverRes.unusedIgnores.length, 0);

    // Round 15 regressions (R15-A2-01, R15-A2-02, R15-A2-03, R15-A2-09):
    const r15Imp = extractImportantStyleSurfacePreservingLines(
      [
        'const StyledBtn = styled(Button, { shouldForwardProp: (p) => p !== "active" })`color: red !important;`;',
        'const StyledObj = styled(Button, { shouldForwardProp: (p) => p !== "active" })({ color: "red !important" });',
      ].join("\n"),
      false
    );
    assert.equal((r15Imp.match(/!important/g) || []).length, 2, "Nested parens in styled(Comp, { shouldForwardProp }) must extract !important");

    const r15Lex = stripCommentsPreservingLines(
      [
        '<button\n  // click -> submit\n  className="\n    px-4\n  ">Go</button> {/* <div className="transition-all" /> */}',
        '<button\n  /* a -> b */\n  className="\n    px-4\n  ">Go</button> {/* <video autoplay src="a.mp4" /> */}',
        '.hero { background: 50% / cover, url("/img/hero.png"); /* transition: all 200ms; */ }',
        'export const Nav1 = ({ a, count }: any) => <div>{a} / <Link disabled={count > 0} to="/ui/home">Home</Link> {/* <div className="transition-all" /> */}</div>;',
        'export const Nav2 = ({ a }: any) => <div>{a} / <Link title="Go >" to="/ui/home">Home</Link> {/* <div className="transition-all" /> */}</div>;',
        'export default /`/;\n// <div className="transition-all" />',
      ].join("\n")
    );
    assert.doesNotMatch(r15Lex, /transition|autoplay/, "Comments inside JSX opening tags, CSS % / before url(), > in attrs before url, and export default /`/ must strip cleanly");

    const r15WaiverSrc = [
      '<button',
      '  // click -> submit',
      '  className="',
      '    bg-[#ff00aa]',
      '  " /> /* dsaf-ignore dsaf/tailwind-arbitrary -- brand swatch preview */',
    ].join("\n");
    assert.equal(parseInlineIgnores(r15WaiverSrc).length, 1, "Comment with -> inside JSX opening tag must not drop inline dsaf-ignore");
    assert.equal(parseInlineIgnores("export default /`/;\n// dsaf-ignore dsaf/hardcoded-color -- brand fallback\n").length, 1);

    const r15SupportsBlank = blankCssCustomPropDeclsPreservingLines("@supports ( --brand-primary: #ff00aa ) {\n  .card { color: #123456 !important; }\n}\n");
    assert.match(r15SupportsBlank, /#123456 !important/, "@supports ( --var: ... ) must stop at closing paren and preserve declarations inside block");

    // Round 16 regressions (R16-A2-01, R16-A2-07, R16-A2-08, R16-A2-12, R16-A2-13):
    const r16SvgRanges = findSvgBlockRanges('<svg ref={chartRef} className="w-full" />\n<div style={{ color: "#ff00aa" }} />\n<svg viewBox="0 0 24 24"><path /></svg>');
    assert.equal(r16SvgRanges.length, 2, "Self-closing <svg /> and later <svg>...</svg> must produce 2 disjoint ranges");
    assert.equal(r16SvgRanges[0].end < r16SvgRanges[1].start, true);
    assert.equal(r16SvgRanges[0].end - r16SvgRanges[0].start < 45, true);

    const r16GenLex = stripCommentsPreservingLines(
      [
        `<Select<Option>\n  className="\n    px-4\n  ">Go</Select> {/* <video autoplay src="a.mp4" /> */}`,
        `.a { content: attr(data-x) '90s!'; /* transition: all 200ms; */ }`,
        `const ok = x < 'cause it broke!'; // <div className="transition-all" />`,
      ].join("\n")
    );
    assert.doesNotMatch(r16GenLex, /autoplay|transition/, "TS generic JSX multiline attr and closed '90s!'/'cause...' strings must strip trailing comments");
    assert.equal(
      parseInlineIgnores(`<Select<Option>\n  className="\n    bg-[#ff00aa]\n  " /> /* dsaf-ignore dsaf/tailwind-arbitrary -- brand swatch preview */\n`).length,
      1
    );
    assert.match(
      extractImportantStyleSurfacePreservingLines('<div style:padding|important="13px" style:width|important="100vw">Hi</div>', false),
      /100vw/
    );
    const r16SuppBlank = blankCssCustomPropDeclsPreservingLines("@supports (--brand-primary: #ff00aa !important) { .card { color: var(--brand); } }\n");
    assert.doesNotMatch(r16SuppBlank, /!important|#ff00aa/);
    assert.equal(isTokenDefinitionHeader("@property --brand-glow"), true);

    // Round 17 regressions (R17-A2-C1..C6):
    // C1: regex /foo:`bar/ with const t = `ok`; must preserve comment & dsaf-ignore stripping
    const r17C1Src = [
      'const re = /foo:`bar/; const t = `ok`;',
      '// <div className="transition-all" />',
      '// dsaf-ignore dsaf/tailwind-arbitrary -- brand swatch',
      'export const x = <div className="w-[13px]" />;',
    ].join("\n");
    const r17C1Clean = stripCommentsPreservingLines(r17C1Src);
    assert.doesNotMatch(r17C1Clean, /transition-all/, "C1 regex with : and backtick before template literal must not disable comment stripping");
    assert.equal(parseInlineIgnores(r17C1Src).length, 1, "C1 dsaf-ignore waiver must survive /foo:`bar/");

    // C2: SCSS url(//cdn.example.com/#{$id}.png) must not swallow trailing declarations
    const r17C2Clean = stripCommentsPreservingLines(".hero { background: url(//cdn.example.com/#{$id}.png); transition: all 200ms; }");
    assert.match(r17C2Clean, /transition: all 200ms;/, "C2 SCSS #{$id} inside url(//...) must preserve trailing rule");

    // C3: English '90s contraction sharing a line with single-quoted JSX attribute must preserve trailing comment stripping
    const r17C3Clean = stripCommentsPreservingLines("export const Q = () => <><p>The '90s</p><button className='px-4'/> {/* <div className=\"transition-all\" /> */}</>;");
    assert.doesNotMatch(r17C3Clean, /transition-all/, "C3 '90s contraction before className='px-4' must not disable {/* ... */} stripping");

    // C4: @keyframes nested inside @theme must stay blanked
    const r17C4Clean = stripTokenBlocksPreservingLines("@theme {\n  --color-a: #111111;\n  @keyframes wiggle {\n    0% { color: #ff00aa; }\n  }\n}\n");
    assert.doesNotMatch(r17C4Clean, /#ff00aa/, "C4 @keyframes inside @theme must stay masked");

    // C5: <svg> attribute expression containing /"/ regex must still isolate full <svg> block
    const r17C5Ranges = findSvgBlockRanges('export const Icon = ({ x }) => <svg onClick={() => /"/.test(x)}><path fill="#ff00aa" /><g style={{ color: "#123456" }} /></svg>;');
    assert.equal(r17C5Ranges.length, 1, "C5 <svg> with /\"/ regex inside attribute expression must produce 1 full block");
    assert.equal(r17C5Ranges[0].end > 100, true);

    // C6: extractImportantStyleSurfacePreservingLines must handle /"/ regex before !important string literal
    const r17C6Imp = extractImportantStyleSurfacePreservingLines('export const Imp = ({ x }) => <div style={{ color: /"/.test(x) ? "red !important" : "blue" }} />;', false);
    assert.match(r17C6Imp, /red !important/, "C6 /\"/ regex in style={{}} must preserve red !important");

    // Round 18 regressions (R18-A2-09, R18-A2-11, R18-A2-18, R18-A2-21):
    const r18Clean = stripCommentsPreservingLines(
      [
        '<p>Era = \'90s</p> <!-- <div class="transition-all"></div> -->',
        '<p>The \'90s were "users\' peak"</p> <!-- <div class="transition-all"></div> -->',
        'const a18 = x! / 2; const s18 = "/ "; // <div className="transition-all" />',
        'const b18 = obj.in / 2; const s19 = "/ "; // <div className="transition-all" />',
      ].join("\n")
    );
    assert.doesNotMatch(r18Clean, /transition-all/, "Era = '90s, users' possessive, x! / 2, and obj.in / 2 must strip trailing comments");
    const r18ImpCss = extractImportantStyleSurfacePreservingLines('.tip::after { content: "#ff00aa rgb(255, 0, 0) !important"; }', true);
    assert.doesNotMatch(r18ImpCss, /!important/, "CSS content strings must not leak !important");
    const r18SvgAttr = findSvgBlockRanges('<svg><text title="</svg>">x</text><div style={{ color: "#ff00aa" }} /></svg>');
    assert.equal(r18SvgAttr.length, 1);
    assert.ok(r18SvgAttr[0].end > 60, "Attribute literal </svg> must not truncate full <svg> block");
    for (const emptyReasonLine of [
      "/* dsaf-ignore dsaf/no-transition-all --*/\n.a { transition: all 200ms; }\n",
      "// dsaf-ignore dsaf/no-transition-all -- \n<div className='transition-all' />\n",
    ]) {
      const r18EmptyWaiver = applyIgnores(
        [{ file: "r18.css", line: 2, ruleId: "dsaf/no-transition-all", tier: "floor", severity: "error", message: "x" }],
        emptyReasonLine,
        "r18.css"
      );
      assert.ok(r18EmptyWaiver.active.some((f) => f.ruleId === "dsaf/floor-waiver-rejected"), "Empty --*/ or -- waiver must emit rejection");
    }

    // Round 19 regressions (R19-A2-08, R19-A2-09, R19-A2-10):
    const r19Clean = stripCommentsPreservingLines(
      [
        'const x19 = obj.in! / 2; const s19a = "/ "; // <div className="transition-all" />',
        'if (ok19) !/"/.test(x19) // <div className="transition-all" />',
        'const a19 = b19\n!/"/.test(x19) // <div className="transition-all" />',
        '<p>Back in \'90s</p> <!-- <div class="transition-all"></div> -->',
        '<p>Best of \'90s</p> <!-- <div class="transition-all"></div> -->',
        '<p>\n  Era = \'90s <!-- <div class="transition-all"></div> -->\n</p>',
        '<p>{label} = \'90s <!-- <div class="transition-all"></div> --></p>',
      ].join("\n")
    );
    assert.doesNotMatch(r19Clean, /transition-all/, "R19 .in!, if(ok) !/\"/, ASI \\n!/\"/, Back in/of '90s, and multiline/{expr} = '90s must strip comments");
    const r19ImpFp = extractImportantStyleSurfacePreservingLines('const Box = styled.div`content: "${x}"; content: "!important";`;', false);
    assert.doesNotMatch(r19ImpFp, /!important/, "R19 split styled template content string across ${x} must not leak !important");
    const r19ImpFn = extractImportantStyleSurfacePreservingLines('const Box = styled.div`content: "${x}"; color: red !important;`;', false);
    assert.match(r19ImpFn, /!important/, "R19 split styled template real CSS !important after content \"${x}\" must be preserved");

    // Round 20 regressions (R20-A2-M8, R20-A2-M9):
    const r20Clean = stripCommentsPreservingLines(
      [
        '<p>Hits from \'90s</p> <!-- <div class="transition-all"></div> -->',
        '<p>All new \'em</p> <!-- <div class="transition-all"></div> -->',
        'const r20Str = \'90s\'; // <div className="transition-all" />',
      ].join("\n")
    );
    assert.doesNotMatch(r20Clean, /transition-all/, "R20 M9: from/new before '90s/'em prose contractions must strip trailing comments");
    const r20ImpStyledObj = extractImportantStyleSurfacePreservingLines(
      'const F = styled.div({ "&::after": { content: "\'red !important\'" } });',
      false
    );
    assert.doesNotMatch(r20ImpStyledObj, /!important/, "R20 M8: styled.div({ content: }) must not leak !important");
    const r20ImpSvelteBrace = extractImportantStyleSurfacePreservingLines(
      "<div style=\"content: '{not-svelte}'; color: red !important;\" />",
      false
    );
    assert.match(r20ImpSvelteBrace, /!important/, "R20 M8: style content '{not-svelte}' must not swallow trailing !important");

    // Round 21 regressions (R21-A2-M2, R21-A2-M3, R21-A2-M5):
    const r21ArrowSpans = computeJsOuterStringSpans('const fn = () => `"--fake-var": "#ff00aa !important"`;\nconst q = gql<User>`\n  "--gql-var": "#112233"\n`;\n');
    assert.equal(r21ArrowSpans.length, 2, "R21 M2: arrow fn => and gql<User> generic template literals must emit outer spans");
    const r21GenSpans = computeJsOuterStringSpans('const fn = gql<{ id: string }>`"--nested": 1`;\n');
    assert.equal(r21GenSpans.length, 1);
    const r21TplCustom1 = blankStyledTemplateCustomPropsPreservingLines(
      'const G = styled.div`&::after { content: "${y ? \'a"\' : \'c\'}"; } --custom: #ff00aa !important;`;'
    );
    assert.doesNotMatch(r21TplCustom1, /--custom|#ff00aa|!important/, "R21 M3: ${...} quote inside cssQ must not unblank trailing --custom");
    const r21TplCustom2 = blankStyledTemplateCustomPropsPreservingLines(
      'const H = styled.div`--custom: "${y ? \'a"\' : \'c\'}"; color: #ff00aa !important;`;'
    );
    assert.match(r21TplCustom2, /color: #ff00aa !important;/, "R21 M3: ${...} quote inside declQuote must not blank past custom-prop ';'");
    const r21SvelteBlank = blankCssCustomPropDeclsPreservingLines(
      "--x: {active ? '#ff00aa !important' : '#112233'}; color: var(--x);",
      { allowBracedExpr: true }
    );
    assert.doesNotMatch(r21SvelteBlank, /#ff00aa|!important|#112233/, "R21 M5: Svelte style --var: {...} must blank through ';'");
    assert.match(r21SvelteBlank, /color: var\(--x\);/);

    // Round 22 regressions (R22-A2-H2, R22-A2-M2, R22-A2-M4, R22-A2-M5, R22-A2-L4):
    // 1. Indented JSX prose backtick must not swallow trailing {/* dsaf-ignore ... */} or comments
    const r22JsxProse = [
      "<p>",
      "  `literal backtick in JSX prose",
      "</p>",
      "{/* <video autoplay src=\"a.mp4\" /> */}",
      "// dsaf-ignore dsaf/important-override -- documented editorial exception",
      '<div style={{ color: "red !important" }} />',
    ].join("\n");
    assert.doesNotMatch(stripCommentsPreservingLines(r22JsxProse), /autoplay/, "R22 H2: indented JSX prose backtick must not open template literal");
    assert.equal(parseInlineIgnores(r22JsxProse).length, 1, "R22 H2: dsaf-ignore after indented JSX prose backtick must still be parsed");

    // 2. isValidJsObjKeyPos rejects JSX prose comma/semicolon while keeping real object keys
    const r22Prose = '<p>Example, "--fake-a": #ff00aa; Syntax; "--fake-b": 1</p>';
    assert.equal(isValidJsObjKeyPos(r22Prose, r22Prose.indexOf('"--fake-a"')), false);
    assert.equal(isValidJsObjKeyPos(r22Prose, r22Prose.indexOf('"--fake-b"')), false);
    const r22RealObj = 'const x = { a: 1, "--real-var": "#fff" };';
    assert.equal(isValidJsObjKeyPos(r22RealObj, r22RealObj.indexOf('"--real-var"')), true);

    // 3. endsWithGenericTaggedTemplate supports backtick template literal types inside TS generics
    const r22Gen1 = 'const q = gql<`a > b`>`"--var": 1`;';
    assert.equal(endsWithGenericTaggedTemplate(r22Gen1, r22Gen1.lastIndexOf('`"--var"')), true);
    const r22Gen1Spans = computeJsOuterStringSpans(r22Gen1);
    assert.equal(r22Gen1Spans.length, 2);
    const r22Gen1VarIdx = r22Gen1.indexOf('"--var"');
    assert.equal(r22Gen1Spans.some(([s0, e0]) => r22Gen1VarIdx > s0 && r22Gen1VarIdx < e0), true);
    assert.match(
      stripCommentsPreservingLines('const q = gql<`a /* b`>`"--var": 1`;\nexport const Btn = () => <button className="outline-none" />;'),
      /outline-none/
    );
    const r22Gen2 = 'const S = styled.div<{ msg: `don\'t > ok` }>`"--var": 1`;';
    assert.equal(endsWithGenericTaggedTemplate(r22Gen2, r22Gen2.lastIndexOf('`"--var"')), true);
    const r22Gen2Spans = computeJsOuterStringSpans(r22Gen2);
    assert.equal(r22Gen2Spans.length, 2);
    const r22VarIdx = r22Gen2.indexOf('"--var"');
    assert.equal(r22Gen2Spans.some(([s0, e0]) => r22VarIdx > s0 && r22VarIdx < e0), true);

    // 4. Nested css`...` inside styled`...` ${...} preserves CSS quote masking & real !important
    const r22NestedContent = extractImportantStyleSurfacePreservingLines(
      'const B = styled.div`${(p) => p.hot ? css`content: "!important";` : ""}`;',
      false
    );
    assert.doesNotMatch(r22NestedContent, /!important/, "R22 M5: nested css`content: \"!important\"` must stay masked");
    const r22NestedReal = extractImportantStyleSurfacePreservingLines(
      'const B = styled.div`${(p) => p.hot ? css`color: red !important;` : ""}`;',
      false
    );
    assert.match(r22NestedReal, /!important/, "R22 M5: nested css`color: red !important;` must preserve !important");

    // 5. blankStyledTemplateCustomPropsPreservingLines stops before closing ')' of @supports (--x: ...)
    const r22StyledSupp = blankStyledTemplateCustomPropsPreservingLines(
      'const B = styled.div`@supports (--brand: #ff00aa !important) { color: #123456; }`;'
    );
    assert.doesNotMatch(r22StyledSupp, /#ff00aa|!important/);
    assert.match(r22StyledSupp, /\) \{ color: #123456; \}/);

    // 6. Round 23 regressions (#13, #14, #21, #22, #38): multiline JSX prose backtick, emoji UTF-16 offsets,
    // [data-theme-toggle] selector preservation, comparison strings in style={{}}, and strict parseArgs exit 2
    const r23Backtick = [
      "<p>",
      "  Press `Enter to confirm",
      "</p>",
      "// dsaf-ignore dsaf/important-override -- documented editorial exception",
      '<div style={{ color: "red !important" }} />',
      '{/* <button className="outline-none" /> */}',
    ].join("\n");
    assert.equal(parseInlineIgnores(r23Backtick).length, 1);
    assert.doesNotMatch(stripCommentsPreservingLines(r23Backtick), /outline-none/);
    const r23EmojiSurf = extractImportantStyleSurfacePreservingLines(
      'const icons = ["🎨","✨","🚀","🔥","✅","🎉","💡","⚡","🔒","📌"];\nconst Box = styled.div`\n  color: red !important;\n`;\n',
      false
    );
    assert.match(r23EmojiSurf, /!important/);
    assert.match(
      stripTokenBlocksPreservingLines("[data-theme-toggle] { color: #ff00aa !important; }\n"),
      /#ff00aa !important/
    );
    assert.doesNotMatch(
      extractImportantStyleSurfacePreservingLines('<div style={{ color: mode === "!important" ? "red" : "blue" }} />\n', false),
      /!important/
    );
    const ciSelfPath = fileURLToPath(import.meta.url);
    assert.equal(spawnSync(process.execPath, [ciSelfPath, "--bogus-flag-xyz"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [ciSelfPath, "extra"], { encoding: "utf8" }).status, 2);

    // Round 24 regressions (A2-H3 vars-only token stripping, A2-M4 Svelte |important, A3-M4 regex in JSX expr, A3-L7 90s')
    const r24DarkVarsOnly = stripTokenBlocksPreservingLines(
      ".dark {\n  --bg: #0b0e14;\n  color: #ff00aa !important;\n  padding: 13px;\n}\n@theme { --color-ink: #111111; color: #222222; }\n"
    );
    assert.doesNotMatch(r24DarkVarsOnly, /#0b0e14/, "R24 A2-H3: .dark --bg token variable must be blanked");
    assert.match(r24DarkVarsOnly, /color: #ff00aa !important;/, "R24 A2-H3: regular decls inside .dark must stay visible");
    assert.match(r24DarkVarsOnly, /padding: 13px;/, "R24 A2-H3: spacing decls inside .dark must stay visible");
    assert.doesNotMatch(r24DarkVarsOnly, /#111111|#222222/, "R24 A2-H3: @theme block must remain fully masked");

    const r24SvelteImp = extractImportantStyleSurfacePreservingLines(
      '<div style:color|important="red" />\n<span style:background|important={bgVar} />\n',
      false
    );
    assert.equal((r24SvelteImp.match(/!important/g) || []).length, 2, "R24 A2-M4: Svelte |important directives must surface !important");

    const r24RegexInAttr = stripCommentsPreservingLines(
      `<Comp fn={() => /<a>/.test(x)} alt='Keep multiline\nline' />\n<!-- <div class="transition-all"></div> -->`
    );
    assert.doesNotMatch(r24RegexInAttr, /transition-all/, "R24 A3-M4: /<a>/ inside JSX expr must not confuse isHtmlAttrAssign");

    const r24Decade = stripCommentsPreservingLines(`<p>In the 90s' scene</p>\n<!-- <div class="transition-all"></div> -->`);
    assert.doesNotMatch(r24Decade, /transition-all/, "R24 A3-L7: 90s' decade possessive must not open a single-quote string");

    // Round 25 regressions (R25 A1/A2/A4):
    const r25StyleSrc = [
      '<script>const fake = "<style>.a { transition: all; }</style>";</script>',
      '<!-- <style>.cmt { transition: all; }</style> -->',
      '<div>{"<style>.expr { transition: all; }</style>"}</div>',
      '<p>&lt;style&gt;fake&lt;/style&gt; and <style>.x { content: "</style>"; transition: all; }</style></p>',
      '<style lang="scss">.real { color: #ff00aa; }</style>',
    ].join("\n");
    const r25RealStyles = extractRealStyleBlocks(r25StyleSrc, null, { isMarkupSfc: true, braceExprs: true });
    assert.equal(r25RealStyles.length, 2, "R25 A2-H5: must extract only real <style> blocks and respect CSS strings");
    assert.match(r25RealStyles[0].text, /content: "<\/style>"/);
    assert.equal(extractRealStyleBlocks('const fake = "<style>.a{}</style>";', null, { isMarkupSfc: false }).length, 0);

    const r25AstroSrc = [
      "---",
      'const docStr = "<div class=\\"outline-none\\" style=\\"color:red !important\\">demo</div>";',
      "---",
      '<button class="focus-visible:ring-2">OK</button>',
    ].join("\n");
    const r25AstroCtx = scanMarkupContexts(r25AstroSrc, { isMarkupSfc: true, braceExprs: true });
    assert.equal(r25AstroCtx.openTags.length, 1, "R25 A2-H4: HTML string in Astro frontmatter must not become an openTag");
    assert.equal(r25AstroCtx.openTags[0].tag, "button");

    const r25BracketSfc = '<div class:[&_svg]:outline-none={a} class:[&>svg]:ring-0={b} class:[&_svg{stroke:red}]:outline-none={c} style:color|important="red" />';
    const r25BracketCtx = scanMarkupContexts(r25BracketSfc, { isMarkupSfc: true, braceExprs: true });
    assert.equal(r25BracketCtx.openTags.length, 1, "R25 A2-M1: unquoted Tailwind brackets in Svelte directives must parse as openTag");

    const r25ImpGated = extractImportantStyleSurfacePreservingLines(
      [
        '<p>style="color:red !important" styled.div`color:red !important`</p>',
        '<div title=\'style="color:red !important"\' />',
        'const s = \'<div style="color:red !important">\';',
        '<div style="color: red !important" />',
      ].join("\n"),
      false
    );
    assert.equal((r25ImpGated.match(/!important/g) || []).length, 1, "R25 A2-M3: prose/attr/string fake style must not emit !important");

    const r25StaticDocMask = maskProseAndDocStringsPreservingLines(
      '<img alt="#ff00aa" aria-label="#112233" /><div className="bg-[#445566]" />'
    );
    assert.doesNotMatch(r25StaticDocMask, /#ff00aa|#112233/, "R25 A2-M4: static quoted doc attributes must be masked");
    assert.match(r25StaticDocMask, /#445566/);

    // assertWritableOutputFile / assertWritableOutputDir reject live+broken leaf symlinks & rootDir escape
    const r25SecDir = mkdtempSync(join(scratch, "r25-sec-"));
    const r25Repo = join(r25SecDir, "repo");
    const r25Outside = join(r25SecDir, "outside");
    mkdirSync(r25Repo, { recursive: true });
    mkdirSync(r25Outside, { recursive: true });
    const r25OutTarget = join(r25Outside, "secret.json");
    writeFileSync(r25OutTarget, "{}", "utf8");
    symlinkSync(r25OutTarget, join(r25Repo, "live-leaf.json"));
    symlinkSync(join(r25Outside, "missing.json"), join(r25Repo, "broken-leaf.json"));
    symlinkSync(r25Outside, join(r25Repo, "esc-dir"));
    assert.throws(() => assertWritableOutputFile(join(r25Repo, "live-leaf.json"), "--out"), /Refusing symlinked output path/);
    assert.throws(() => assertWritableOutputFile(join(r25Repo, "broken-leaf.json"), "--out"), /Refusing symlinked output path/);
    assert.throws(() => assertWritableOutputFile(join(r25Repo, "esc-dir/out.json"), "--out", { rootDir: r25Repo }), /escapes repository root/);
    assert.throws(() => assertWritableOutputDir(join(r25Repo, "esc-dir"), "--out"), /Refusing symlinked output path/);
    assert.equal(isDirectCliEntry(import.meta.url, resolve(fileURLToPath(import.meta.url))), true);
    const r25SelfSym = join(r25Repo, "ci-report-sym.mjs");
    symlinkSync(fileURLToPath(import.meta.url), r25SelfSym);
    assert.equal(isDirectCliEntry(import.meta.url, r25SelfSym), true);

    // Round 26 regressions (A2-H1 symlinked rootDir containment + A2-M9 '24 contraction waiver)
    const r26SymRoot = join(r25SecDir, "sym-repo");
    symlinkSync(r25Repo, r26SymRoot);
    const realRepo = realpathSync(r25Repo);
    assert.throws(
      () => assertWritableOutputFile(join(realRepo, "esc-dir/pwn.json"), "--out", { rootDir: r26SymRoot }),
      /escapes repository root/
    );
    assert.throws(
      () => assertWritableOutputDir(join(realRepo, "esc-dir/sub"), "--out-dir", { rootDir: r26SymRoot }),
      /escapes repository root/
    );
    const r26YearProse = '<p>Class of \'24</p> <!-- hidden comment --> {/* dsaf-ignore dsaf/important-override -- intentional override */}';
    assert.doesNotMatch(stripCommentsPreservingLines(r26YearProse), /hidden comment/);
    assert.equal(parseInlineIgnores(r26YearProse).length, 1);

    // Round 27 regressions (A2-H1 markup /* and // text, A2-H2 template after >, A2-H3 CSS-in-JS comments & waivers, A2-M1 SARIF/GH symlinked repoRoot)
    const r27JsxGlob = 'export const A = () => <div><span>/*</span><button className="outline-none" /></div>;';
    assert.match(stripCommentsPreservingLines(r27JsxGlob), /outline-none/);
    const r27JsxLineSlash = 'export const B = () => <div><span>path // note</span> <button className="outline-none" /></div>;';
    assert.match(stripCommentsPreservingLines(r27JsxLineSlash), /outline-none/);
    const r27HtmlGlob = '<p>Glob: src/* and CSS /*</p><button class="outline-none">Go</button>';
    assert.match(stripCommentsPreservingLines(r27HtmlGlob), /outline-none/);
    const r27GtTpl = 'const ok = a > 0; styled(Box)`background: url(x); /* just prose`\nexport const Btn = () => <button className="outline-none" />;';
    assert.match(stripCommentsPreservingLines(r27GtTpl), /outline-none/);
    const r27CssInJs = 'const Box = styled.div`\n  /* dsaf-ignore dsaf/important-override -- needed to override legacy third-party utility */\n  color: #111111 !important;\n`;';
    assert.equal(parseInlineIgnores(r27CssInJs).length, 1);
    const r27ImpCssInJs = extractImportantStyleSurfacePreservingLines('const Box = styled.div`/* color: #111 !important; */ color: var(--fg);`;', false);
    assert.doesNotMatch(r27ImpCssInJs, /!important/);
    const r27SarifSym = formatSarif(
      [{ ruleId: "dsaf/no-100vw", tier: "floor", severity: "error", file: join(realRepo, "page.html"), line: 1, message: "bad" }],
      { repoRoot: r26SymRoot }
    );
    assert.equal(r27SarifSym.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "page.html");
    const r27GhSym = formatGithubAnnotations(
      [{ ruleId: "dsaf/no-100vw", tier: "floor", severity: "error", file: join(realRepo, "page.html"), line: 1, message: "bad" }],
      { repoRoot: r26SymRoot }
    );
    assert.match(r27GhSym, /^::error file=page\.html,/);

    // Round 28 regressions (A2-H1 open-markup /* and // with balanced children and >8KB prose; A2-L1 <style> /* comment */ consistency)
    const r28BalancedSlashStar = 'export const Card = () => (\n  <div>\n    Pattern: foo/*\n    <span className="transition-all outline-none">Danger</span>\n    Pattern: bar*/\n  </div>\n);';
    assert.match(stripCommentsPreservingLines(r28BalancedSlashStar), /transition-all outline-none/, "R28 A2-H1: literal /*...*/ across child markup must stay intact");
    const r28ShareLineSlash = 'export const Card2 = () => (\n  <div>\n    Visit //server/share <button className="outline-none" />\n  </div>\n);';
    assert.match(stripCommentsPreservingLines(r28ShareLineSlash), /outline-none/, "R28 A2-H1: literal //server/share in open JSX must not wipe sibling <button>");
    const r28LongOpenDiv = `<div>\n${"plain prose words ".repeat(600)}\nPattern: foo/*\n<span>ok</span>\n<button className="outline-none" />\n</div>`;
    assert.match(stripCommentsPreservingLines(r28LongOpenDiv), /outline-none/, "R28 A2-H1: >8KB open element prose must remain tracked as open markup");
    const r28StyleCommentedImp = extractImportantStyleSurfacePreservingLines("<style>\n/* color: red !important; */\n.ok { color: var(--fg); }\n</style>", false);
    assert.doesNotMatch(r28StyleCommentedImp, /!important/, "R28 A2-L1: extractImportantStyleSurfacePreservingLines must strip comments inside <style>");

    // Round 29 (A2-H2): Svelte element with 2+ chained event modifiers must parse as valid open tag
    const r29SvelteMod = '<button on:click|preventDefault|stopPropagation={go} class="p-4 outline-none">Go</button>';
    const r29SvelteCtx = scanMarkupContexts(r29SvelteMod, { isSvelte: true });
    assert.equal(r29SvelteCtx.openTags.length, 1, "R29 A2-H2: chained Svelte event modifiers must not abort open tag parsing");
    assert.equal(r29SvelteCtx.openTags[0].attrValueSpans.length, 1);
    assert.equal(r29SvelteCtx.openTags[0].exprSpans.length, 1);

    // Round 30 regressions (A2-H1 unified markup/brace cursor & incomplete tag handling, A2-M2 SVG in JS string, A2-M3 regex after "(" string paren, parity fixes)
    const r30FnJsxBody = [
      "export function Panel() {",
      "  return (",
      "    <div>",
      "      // Route A / Route B",
      '      /* prose /* star */',
      '      <button className="outline-none transition-all" />',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const r30FnClean = stripCommentsPreservingLines(r30FnJsxBody);
    assert.match(r30FnClean, /outline-none transition-all/, "R30 A2-H1: // and /* inside JSX returned from function brace must stay intact");
    assert.doesNotMatch(
      stripCommentsPreservingLines('<div // attr note\n  className="outline-none"\n/>'),
      /attr note/,
      "R30 A2-H1: comment inside incomplete open tag header must be stripped"
    );
    assert.match(
      stripCommentsPreservingLines('const A = () => <div className={`px-4`}><span className="outline-none" /></div>;'),
      /outline-none/,
      "R30 A2-H1: template literal inside incomplete tag attr expr must remain balanced"
    );
    assert.match(
      stripCommentsPreservingLines('const B = () => <Comp header={<div>// keep prose</div>} className="outline-none" />;'),
      /\/\/ keep prose[\s\S]*outline-none/,
      "R30 A2-H1: JSX children inside open tag brace attr expr must preserve prose"
    );
    assert.deepEqual(
      findSvgBlockRanges('const open = "<svg>";\nconst c = "#ff00aa";\nconst close = "</svg>";\n'),
      [],
      "R30 A2-M2: <svg> / </svg> inside JS string literals must not produce SVG range"
    );
    assert.equal(
      findSvgBlockRanges('<p>Don\'t panic</p>\n<svg viewBox="0 0 10 10"><path /></svg>', { isMarkupSfc: true }).length,
      1,
      "R30 A2-M2: real <svg> after apostrophe prose in markup must still be matched"
    );
    const r30ParenStrRegex = 'if (s === "(") !/[/*]/.test(x);\nif (s === "(") !/a\\/*b/.test(x);\nconst bad = "outline-none";\n';
    assert.match(
      stripCommentsPreservingLines(r30ParenStrRegex),
      /outline-none/,
      "R30 A2-M3: '(' inside string literal must not make !/ look like TS non-null assertion"
    );
    const r30Expr = 'if (s === "(") !/[/*]/.test(x)';
    assert.notEqual(
      skipJsRegexInExpr(r30Expr, r30Expr.indexOf("!/") + 1, "!", 0),
      -1,
      "R30 A2-M3: skipJsRegexInExpr must recognize regex after ! preceded by (\"(\")"
    );
    const r30TsBangExpr = 'getVal(")")!/2';
    assert.equal(
      skipJsRegexInExpr(r30TsBangExpr, r30TsBangExpr.indexOf("!/") + 1, "!", 0),
      -1,
      "R30 A2-M3: genuine TS non-null assertion getVal(\")\")!/2 must still be division"
    );
    assert.equal(
      scanMarkupContexts('const id = <Item>(x: Item): Item => x;\nexport const V = () => <Item><span>hi</span></Item>;').openTags.filter((t) => t.tag === "item").length,
      1,
      "R30 parity: TS generic <Item>(x: Item): Item => must not pair with later <Item></Item>"
    );

    // Round 31 regressions (A2-H1 async generic + A3-M1 parity \" in HTML/JSX attrs)
    const r31AsyncRes = scanMarkupContexts(
      'const f = async <Foo>(x: Foo): Promise<Foo> => x;\nconst C = () => cva("p-[13px]");\nexport const V = () => <Foo><span /></Foo>;'
    );
    assert.equal(r31AsyncRes.openTags.filter((t) => t.tag === "foo").length, 1, "R31 A2-H1: async <Foo>(x: Foo): Promise<Foo> must not push phantom <Foo>");
    assert.equal(r31AsyncRes.proseSpans.length, 0, "R31 A2-H1: cva() after async generic must not fall in proseSpans");
    assert.match(
      stripCommentsPreservingLines('const A = () => <div data-win="\\" style={{ color: "#ff00aa" }} />;\n'),
      /#ff00aa/,
      'R31 A3-M1: data-win="\\" in JSX attribute must close at quote and not swallow rest of element'
    );

    // Round 32 regressions (A2-H2 \" in HTML/JSX/Svelte attrs + A3-H3 interface call-sig generics + A2-M5 var() prose doc strings)
    const r32AttrHtml = '<input data-sep="\\"><video data-sep="\\" autoplay src="/x.mp4"></video>';
    const r32AttrCtx = scanMarkupContexts(r32AttrHtml, { isMarkupSfc: true });
    assert.equal(r32AttrCtx.openTags.filter((t) => t.tag === "video").length, 1, 'R32 A2-H2: data-sep="\\" must close at quote so <video> parses');
    assert.equal(
      findSvgBlockRanges('<svg data-win="\\"><path fill="#ff00aa" /></svg>').length,
      1,
      'R32 A2-H2: <svg data-win="\\"> must parse as SVG block'
    );
    assert.equal(
      findSvelteStyleDirectives('<div style:color="red\\" class="x">').length,
      1,
      'R32 A2-H2: Svelte directive value with trailing \\ must stop at closing quote'
    );
    assert.match(
      stripCommentsPreservingLines('export const A = () => <div data-win="\\"><p>// keep</p></div>;'),
      /\/\/ keep/,
      'R32 A2-H2: trailing backslash in data-win="\\" must not leave markup cursor open'
    );
    const r32CallSigSrc = 'interface I { <Item>(x: Item): void; }\nexport const B = () => cva("bg-[#ff00aa]");\nexport const V = () => <Item><span>hi</span></Item>;';
    const r32CallSig = scanMarkupContexts(r32CallSigSrc);
    assert.equal(r32CallSig.openTags.filter((t) => t.tag === "item").length, 1, "R32 A3-H3: interface call-sig <Item>(x: Item): void; must not pair with <Item>");
    const cvaIdx = r32CallSigSrc.indexOf('cva("bg-[#ff00aa]")');
    assert.equal(r32CallSig.proseSpans.some((sp) => cvaIdx >= sp[0] && cvaIdx < sp[1]), false, "R32 A3-H3: intermediate cva() must not fall inside proseSpans");
    const r32ProseMasked = maskProseAndDocStringsPreservingLines(
      'const doc = "Do not use var(--brand-primary) in raw code";\nconst ok = "var(--brand-primary)";\n<div style={{ color: "var(--brand-primary)" }} />;\n'
    );
    assert.doesNotMatch(r32ProseMasked.split("\n")[0], /--brand-primary/, "R32 A2-M5: instructional string literal with var() must be masked");
    assert.match(r32ProseMasked.split("\n")[1], /--brand-primary/, "R32 A2-M5: literal var(--brand-primary) CSS value must remain");
    assert.match(r32ProseMasked.split("\n")[2], /--brand-primary/, "R32 A2-M5: style attr var(--brand-primary) must remain");

    // Round 33 regressions (A2-M5 multiline block/HTML dsaf-ignore + A3-L10 untyped interface call-sig generics)
    const r33CssSrc = "/*\n  dsaf-ignore dsaf/important-override -- legacy widget cascade override\n*/\n.a { color: red !important; }\n";
    const r33CssRes = applyIgnores(
      [{ ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", line: 4, message: "!important" }],
      r33CssSrc,
      "r33.css"
    );
    assert.equal(r33CssRes.active.length, 0, "R33 A2-M5: multiline /* dsaf-ignore */ must waive line after */");
    assert.equal(r33CssRes.waived.length, 1);
    assert.equal(r33CssRes.unusedIgnores.length, 0);

    const r33HtmlSrc = "<!--\n  dsaf-ignore dsaf/hardcoded-color\n  -- third-party embed color token\n-->\n<div style=\"color: #112233\"></div>\n";
    const r33HtmlRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", line: 5, message: "#112233" }],
      r33HtmlSrc,
      "r33.html"
    );
    assert.equal(r33HtmlRes.active.length, 0, "R33 A2-M5: multiline <!-- dsaf-ignore --> must waive line after -->");
    assert.equal(r33HtmlRes.waived.length, 1);

    const r33UntypedSigSrc = 'interface I { <Item>(x): void; }\nexport const V = () => <Item><span>hi</span></Item>;';
    const r33UntypedSig = scanMarkupContexts(r33UntypedSigSrc);
    assert.equal(r33UntypedSig.openTags.filter((t) => t.tag === "item").length, 1, "R33 A3-L10: untyped interface call-sig <Item>(x): void; must not pair with <Item>");

    // Round 34 (A2-M13 Astro frontmatter `\n---` in JS template/comment, A2-L14 wrapped `{ /* dsaf-ignore */ }`, A2-L15 formatSarif undefined message):
    const r34AstroSrc = [
      "---",
      "const divider = `section 1",
      "---",
      "section 2`;",
      "const exampleHtml = '<button class=\"outline-none\" style=\"color: red !important;\">Demo</button>';",
      "---",
      '<button class="focus-visible:ring-2">Real</button>',
    ].join("\n");
    const r34AstroCtx = scanMarkupContexts(r34AstroSrc, { isMarkupSfc: true });
    assert.equal(
      r34AstroCtx.openTags.filter((t) => t.tag === "button").length,
      1,
      "R34 A2-M13: --- inside Astro frontmatter template literal must not close frontmatter early"
    );
    const exIdx = r34AstroSrc.indexOf("outline-none");
    assert.equal(
      r34AstroCtx.jsStringSpans.some(([s0, e0]) => exIdx >= s0 && exIdx < e0),
      true,
      "R34 A2-M13: exampleHtml after embedded --- inside frontmatter must remain inside jsStringSpans"
    );

    const r34WrappedJsx = [
      "export const A = () => (",
      "  <div>",
      "    {",
      "      /* dsaf-ignore dsaf/important-override -- override legacy portal style rule */",
      "    }",
      '    <div style={{ color: "red !important" }} />',
      "  </div>",
      ");",
    ].join("\n");
    const r34WrappedRes = applyIgnores(
      [{ ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", line: 6, message: "!important" }],
      r34WrappedJsx,
      "r34-wrapped.tsx"
    );
    assert.equal(r34WrappedRes.active.length, 0, "R34 A2-L14: Prettier-wrapped { /* dsaf-ignore */ } must waive line 6 after closing brace");
    assert.equal(r34WrappedRes.waived.length, 1);
    assert.equal(r34WrappedRes.unusedIgnores.length, 0);

    const r34Sarif = formatSarif([{ ruleId: "dsaf/hardcoded-color", severity: "note", file: "" }]);
    assert.equal(typeof r34Sarif.runs[0].results[0].message.text, "string", "R34 A2-L15: formatSarif message.text must always be defined string");
    assert.ok(r34Sarif.runs[0].results[0].message.text.length > 0);

    // Round 36 (R35-A2-H5 </script> in string literal + R35-A2-M3 JSX line comment { \n // dsaf-ignore ... \n }):
    const r36Vue1 = [
      "<script>",
      'const x = "</script><button class=\\"outline-none\\">fake</button>";',
      "</script>",
      '<template><button class="px-2">ok</button></template>',
    ].join("\n");
    const r36Vue1Ctx = scanMarkupContexts(r36Vue1, { isMarkupSfc: true });
    const r36Btns = r36Vue1Ctx.openTags.filter((t) => t.tag === "button");
    assert.equal(r36Btns.length, 1, "R36 A2-H5: only the real <template> button must be in openTags");
    assert.doesNotMatch(r36Vue1.slice(r36Btns[0].start, r36Btns[0].end), /outline-none/, "R36 A2-H5: fake </script><button outline-none> inside JS string must not leak as DOM tag");
    const r36Vue2 = [
      "<script>",
      'const tag = "</script><div>";',
      "// <video autoplay />",
      "</script>",
      '<template><button class="px-2">ok</button></template>',
    ].join("\n");
    assert.doesNotMatch(
      stripCommentsPreservingLines(r36Vue2),
      /<video/,
      "R36 A2-H5: // <video autoplay /> after '</script><div>' string must still be stripped as JS comment"
    );
    const r36JsxLine = [
      "export function App() {",
      "  return (",
      "    <div>",
      "      {",
      "        // dsaf-ignore dsaf/tailwind-arbitrary -- intentional design token",
      "      }",
      '      <div className="p-[13px]" />',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const r36JsxRes = applyIgnores(
      [{ ruleId: "dsaf/tailwind-arbitrary", tier: "reflex", severity: "warning", line: 7, message: "p-[13px]" }],
      r36JsxLine,
      "r36.tsx"
    );
    assert.equal(r36JsxRes.active.length, 0, "R36 A2-M3: Prettier-wrapped { // dsaf-ignore } line comment must waive line 7");
    assert.equal(r36JsxRes.unusedIgnores.length, 0);

    const r36Ternary = [
      "ok",
      "  ? // dsaf-ignore dsaf/hardcoded-color -- legacy third-party chart theme",
      '    ".chart { color: #ff00aa; }"',
      '  : ""',
    ].join("\n");
    const r36TernaryRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", line: 3, message: "#ff00aa" }],
      r36Ternary,
      "r36-ternary.tsx"
    );
    assert.equal(r36TernaryRes.active.length, 0, "R36: Prettier-formatted ternary branch ? // dsaf-ignore must waive line 3");
    assert.equal(r36TernaryRes.waived.length, 1);
    assert.equal(r36TernaryRes.unusedIgnores.length, 0);

    const r36InlineCss = "color: #ff00aa; /* dsaf-ignore dsaf/hardcoded-color -- legacy chart palette */";
    const r36InlineRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", line: 1, message: "#ff00aa" }],
      r36InlineCss,
      "r36-inline.css"
    );
    assert.equal(r36InlineRes.active.length, 0, "R36: real inline CSS comment must still waive its own line");
    assert.equal(r36InlineRes.unusedIgnores.length, 0);

    // Round 37 (R36-A2-M1 SFC <script lang="ts"> angle-bracket cast + R36-A2-M3 stacked Prettier JSX waivers):
    const r37SfcTs = [
      '<script setup lang="ts">',
      'const el = <HTMLElement>document.getElementById("x");',
      'const B = styled.button`outline: none; color: #ff00aa;`;',
      "</script>",
      '<template><div class="ok">ok</div></template>',
    ].join("\n");
    const r37SfcCtx = scanMarkupContexts(r37SfcTs, { isMarkupSfc: true });
    const line3Off = r37SfcTs.indexOf("const B");
    assert.equal(
      r37SfcCtx.proseSpans.some(([s0, e0]) => line3Off >= s0 && line3Off < e0),
      false,
      "R37 A2-M1: <HTMLElement> cast in SFC <script lang='ts'> must not classify following code as JSX proseSpans"
    );
    const r37SfcTsx = ['<script lang="tsx">', "const x = <div>hi</div>;", "</script>"].join("\n");
    assert.ok(
      scanMarkupContexts(r37SfcTsx, { isMarkupSfc: true }).openTags.some((t) => t.tag === "div"),
      "R37 A2-M1: SFC <script lang='tsx'> must still scan embedded JSX tags"
    );

    const r37StackedJsx = [
      "{",
      "  /* dsaf-ignore dsaf/tailwind-arbitrary -- valid first waiver reason */",
      "  /* dsaf-ignore dsaf/important-override -- valid second waiver reason */",
      "}",
      '<div className="p-[13px] !text-red-500" />',
    ].join("\n");
    const r37StackedRes = applyIgnores(
      [
        { ruleId: "dsaf/tailwind-arbitrary", tier: "reflex", severity: "warning", line: 5, message: "p-[13px]" },
        { ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", line: 5, message: "!text-red-500" },
      ],
      r37StackedJsx,
      "r37-stacked.tsx",
      { reportUnusedIgnores: true }
    );
    assert.equal(r37StackedRes.active.length, 0, "R37 A2-M3: both stacked Prettier JSX comments must target line 5");
    assert.equal(r37StackedRes.waived.length, 2);
    assert.equal(r37StackedRes.unusedIgnores.length, 0);

    // Round 38 (R37-A3-L1 unified waiver boilerplate rejection parity):
    assert.equal(isBoilerplateReason("temporary fix"), true, "R38 A3-L1: 'temporary fix' must be rejected as boilerplate");
    assert.equal(isBoilerplateReason("will fix later"), true, "R38 A3-L1: 'will fix later' must be rejected as boilerplate");
    assert.equal(isBoilerplateReason("intentional."), true, "R38 A3-L1: 'intentional.' must be rejected as boilerplate");

    // Round 39 (R38-A2-M1 Svelte bracketed directive in open markup cursor + R38-A2-L3 nested &:root vars-only masking):
    const r39Svelte = [
      "<div class:[&_svg]:ring-0={ok}>",
      "  /* 50% off",
      '  <video autoplay src="a.mp4" />',
      "</div>",
      '<div class:[&>span]:p-2={/* note */ ok ? [1, 2] : []}>// keep prose</div>',
    ].join("\n");
    const r39SvelteClean = stripCommentsPreservingLines(r39Svelte);
    assert.match(r39SvelteClean, /autoplay/, "R39 A2-M1: <video autoplay> after class:[&_svg] must not be blanked");
    assert.match(r39SvelteClean, /\/\/ keep prose/, "R39 A2-M1: prose after class:[&>span]={/* note */} must remain intact");
    assert.doesNotMatch(r39SvelteClean, /note/, "R39 A2-M1: JS comment inside directive expression must still be stripped");
    assert.equal(
      stripCommentsPreservingLines("const x = a < b[c & d]; // trailing"),
      "const x = a < b[c & d];            ",
      "R39 A2-M1: JS comparison with indexed bracket & must not trigger markup mode"
    );

    const r39NestedRoot = ":root {\n  --a: #111111;\n  &.dark {\n    --a: #222222;\n    color: #ff00aa;\n  }\n}";
    const r39MaskedRoot = stripTokenBlocksPreservingLines(r39NestedRoot);
    assert.doesNotMatch(r39MaskedRoot, /#222222/, "R39 A2-L3: --a inside :root &.dark must be masked");
    assert.match(r39MaskedRoot, /color: #ff00aa/, "R39 A2-L3: non-var color property inside :root &.dark must remain scannable");

    // Round 41 (R40-A2-M6 symlink/.. lexical collapse prevention + R40-A2-L2 root artifact URI "." ):
    const r41Root = join(scratch, "r41-repo");
    const r41Out = join(scratch, "r41-outside");
    mkdirSync(join(r41Out, "sub"), { recursive: true });
    mkdirSync(r41Root, { recursive: true });
    writeFileSync(join(r41Out, "secret.txt"), "secret");
    symlinkSync(join(r41Out, "sub"), join(r41Root, "sym"));
    assert.throws(
      () => assertPathWithinRoot(r41Root, `${r41Root}/sym/../secret.txt`),
      /escapes repository root/i,
      "R41 A2-M6: sym/.. must resolve symlink before collapsing .. and throw escape error"
    );
    const r41Sarif = formatSarif(
      [{ ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", file: r41Root, line: 1, message: "msg" }],
      { repoRoot: r41Root }
    );
    assert.equal(
      r41Sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      ".",
      "R41 A2-L2: repoRoot artifactLocation.uri must be '.' rather than empty string"
    );

    // Round 42 (R41-A3-L2 preserve runtime http(s):// URIs in SARIF & GitHub annotations):
    const r42UrlFindings = [
      { ruleId: "dsaf/runtime-check-failed", tier: "floor", severity: "error", file: "http://127.0.0.1:3000/dashboard?tab=1", line: 1, message: "runtime fail" },
    ];
    const r42UrlSarif = formatSarif(r42UrlFindings, { repoRoot: r41Root });
    assert.equal(
      r42UrlSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      "http://127.0.0.1:3000/dashboard?tab=1",
      "R42 A3-L2: SARIF artifactLocation.uri must preserve runtime http:// URLs verbatim"
    );
    const r42UrlAnn = formatGithubAnnotations(r42UrlFindings, { repoRoot: r41Root });
    assert.match(r42UrlAnn, /file=http%3A\/\/127\.0\.0\.1%3A3000\/dashboard\?tab=1,/);

    // Round 43 (R42-A4-M1 alias/canonical ancestor check in assertWritableOutputTarget, R42-A4-M2 hasOwnProperty RULE_CATALOG, R42-A4-M3 finite integer lines, R42-A4-L4 ././ and file: URI):
    const r43AliasToRoot = join(scratch, "r43-alias-to-root");
    symlinkSync(r41Root, r43AliasToRoot);
    assert.throws(
      () => assertWritableOutputFile(join(r43AliasToRoot, "sym", "secret.txt"), "--sarif", { rootDir: r41Root }),
      /escapes repository root/i,
      "R43 A4-M1: symlink alias pointing into rootDir then escaping via internal symlink must throw"
    );
    const r43ExtOut = assertWritableOutputFile(join(r41Out, "legit-ext.sarif"), "--sarif", { rootDir: r41Root });
    assert.ok(r43ExtOut.endsWith("legit-ext.sarif"));

    const r43ProtoRes = applyIgnores([{ ruleId: "constructor", line: 1, message: "proto" }], "", join(r41Root, "a.css"));
    assert.equal(r43ProtoRes.active[0].tier, "reflex", "R43 A4-M2: constructor ruleId must not inherit Object.prototype");
    const r43SarifMix = formatSarif(
      [
        { ruleId: "constructor", file: "././src/a.css", line: Infinity, message: "inf" },
        { ruleId: "dsaf/no-100vw", tier: "floor", severity: "error", file: pathToFileURL(join(r41Root, "sub", "b.css")).href, line: 3.9, message: "float" },
      ],
      { repoRoot: r41Root }
    );
    assert.equal(r43SarifMix.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/a.css", "R43 A4-L4: strip repeated ./");
    assert.equal(r43SarifMix.runs[0].results[0].locations[0].physicalLocation.region.startLine, 1, "R43 A4-M3: Infinity line normalizes to 1");
    assert.equal(r43SarifMix.runs[0].results[1].locations[0].physicalLocation.artifactLocation.uri, "sub/b.css", "R43 A4-L4: file: URL inside repoRoot relativizes cleanly");
    assert.equal(r43SarifMix.runs[0].results[1].locations[0].physicalLocation.region.startLine, 3, "R43 A4-M3: float line floors to 3");
    const r43GhAnn = formatGithubAnnotations(
      [
        { ruleId: "custom/null-tier-check", tier: null, file: "././src/a.css", line: Infinity, severity: "error", message: "m" },
        { ruleId: "DSAF/NO-100VW", tier: null, file: "././src/a.css", line: Infinity, severity: "error", message: "m" },
      ],
      { repoRoot: r41Root }
    );
    assert.match(r43GhAnn, /file=src\/a\.css,line=1,title=custom\/null-tier-check::\[REFLEX\] m/);
    assert.match(r43GhAnn, /file=src\/a\.css,line=1,title=dsaf\/no-100vw::\[FLOOR\] m/);

    // Round 44 (A4-H1 case-insensitive ruleId/tier/Floor, A4-M2 SARIF blank ruleId/message, A4-L3 Windows drive URI, A4-L4 symlinked repoRoot missing child, A3-M2 brace boundary):
    const r44FloorRes = applyIgnores(
      [{ ruleId: "DSAF/NO-TRANSITION-ALL", tier: "reflex", severity: "warning", line: 2, message: "x" }],
      "/* dsaf-ignore dsaf/no-transition-all -- brand animation exception */\n.a { transition: all 0.2s; }",
      join(r41Root, "r44-floor.css")
    );
    assert.equal(r44FloorRes.active.length, 2, "R44 A4-H1: uppercase Floor ruleId downgraded to reflex must remain active + emit rejection");
    assert.equal(r44FloorRes.active[0].tier, "floor");
    assert.equal(r44FloorRes.active[0].severity, "error");
    assert.equal(r44FloorRes.active[1].ruleId, "dsaf/floor-waiver-rejected");
    const r44UpperCustomFloor = applyIgnores(
      [{ ruleId: "DSAF/OFF-GRID-SPACING", tier: "FLOOR", severity: "warning", line: 2, message: "13px" }],
      "/* dsaf-ignore dsaf/off-grid-spacing -- brand card optical margin */\n.a { padding: 13px; }",
      join(r41Root, "r44-upper-floor.css")
    );
    assert.equal(r44UpperCustomFloor.waived.length, 0, "R44 A4-H1: uppercase tier FLOOR must not waive");
    assert.equal(r44UpperCustomFloor.active[1]?.ruleId, "dsaf/floor-waiver-rejected");
    const r44EvalUpper = applyIgnores(
      [],
      "/* dsaf-ignore dsaf/off-grid-spacing -- intentional optical margin */\n.a { padding: 13px; }",
      join(r41Root, "r44-eval.css"),
      { evaluatedRules: new Set(["DSAF/OFF-GRID-SPACING"]), reportUnusedIgnores: true }
    );
    assert.equal(r44EvalUpper.unusedIgnores.length, 1, "R44 A4-H1: evaluatedRules matching must be case-insensitive");

    const r44SarifBlank = formatSarif(
      [
        { ruleId: "", message: "", file: "src/blank.css", line: 2 },
        { message: "", file: "src/undef.css", line: 4 },
      ],
      { repoRoot: r41Root }
    );
    assert.equal(r44SarifBlank.runs[0].results[0].ruleId, "dsaf/unknown");
    assert.equal(r44SarifBlank.runs[0].results[1].ruleId, "dsaf/unknown");
    assert.ok(r44SarifBlank.runs[0].results[0].message.text.length > 0);
    assert.ok(r44SarifBlank.runs[0].results[1].message.text.length > 0);
    assert.equal(r44SarifBlank.runs[0].tool.driver.rules.length, 1);
    assert.equal(r44SarifBlank.runs[0].tool.driver.rules[0].id, "dsaf/unknown");

    const r44SarifWin = formatSarif(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", file: "C:\\repo\\my file.css", line: 1, message: "win" }],
      { repoRoot: "/repo" }
    );
    assert.equal(
      r44SarifWin.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      "file:" + "///C:/repo/my%20file.css",
      "R44 A4-L3: Windows path must preserve drive letter in POSIX URI on any host"
    );

    const r44SymMissingSarif = formatSarif(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", file: join(r41Root, "new-dir", "missing.css"), line: 1, message: "miss" }],
      { repoRoot: r43AliasToRoot }
    );
    assert.equal(
      r44SymMissingSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      "new-dir/missing.css",
      "R44 A4-L4: symlinked repoRoot must relativize nonexistent child under real root cleanly"
    );

    const r44BraceSrc = "} /* dsaf-ignore dsaf/off-grid-spacing -- spacing exception for card */\n.b { padding: 13px; }";
    const r44BraceRes = applyIgnores(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", line: 2, message: "13px" }],
      r44BraceSrc,
      join(r41Root, "r44-brace.css")
    );
    assert.equal(r44BraceRes.active.length, 1, "R44 A3-M2: closing brace before dsaf-ignore must stay inline and not waive line 2");

    const r44SelfJsxSrc = "{/* dsaf-ignore dsaf/off-grid-spacing -- spacing exception for card */}\n}\n<div style={{ padding: 13 }} />";
    const r44SelfJsxRes = applyIgnores(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", line: 3, message: "13px" }],
      r44SelfJsxSrc,
      join(r41Root, "r44-selfjsx.tsx")
    );
    assert.equal(r44SelfJsxRes.active.length, 1, "R44 A3-M2: self-contained {/* ... */} must not skip closing } on line 2");

    const r44NormalJsxSrc = "{/* dsaf-ignore dsaf/off-grid-spacing -- spacing exception for card */}\n<div style={{ padding: 13 }} />";
    const r44NormalJsxRes = applyIgnores(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", line: 2, message: "13px" }],
      r44NormalJsxSrc,
      join(r41Root, "r44-normaljsx.tsx")
    );
    assert.equal(r44NormalJsxRes.active.length, 0, "R44 A3-M2: standalone {/* ... */} must waive line 2");
    assert.equal(r44NormalJsxRes.waived.length, 1);

    // Round 45 (mixed-case RULE_CATALOG SARIF dedup/linking, Allman { } block non-escape, UNC backslash URI):
    const r45MixedCaseSarif = formatSarif(
      [
        { ruleId: "DSAF/NO-100VW", severity: "error", file: "a.css", line: 1, message: "bad1" },
        { ruleId: "dsaf/no-100vw", severity: "error", file: "b.css", line: 2, message: "bad2" },
      ],
      { repoRoot: r41Root }
    );
    assert.deepEqual(
      r45MixedCaseSarif.runs[0].tool.driver.rules.map((r) => r.id),
      ["dsaf/no-100vw"],
      "R45 A4-M1: mixed-case RULE_CATALOG IDs must dedup to single lowercase canonical rule"
    );
    assert.deepEqual(
      r45MixedCaseSarif.runs[0].results.map((r) => r.ruleId),
      ["dsaf/no-100vw", "dsaf/no-100vw"],
      "R45 A4-M1: SARIF results must match canonical driver.rules[].id"
    );

    const r45AllmanCss = [
      ".empty",
      "{",
      "  /* dsaf-ignore dsaf/off-grid-spacing -- unused ignore inside empty block */",
      "}",
      ".real { padding: 13px; }",
    ].join("\n");
    const r45AllmanRes = applyIgnores(
      [{ ruleId: "dsaf/off-grid-spacing", tier: "reflex", severity: "warning", line: 5, message: "13px" }],
      r45AllmanCss,
      join(r41Root, "r45-allman.css"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r45AllmanRes.waived.length, 0, "R45 A4-L1: closed Allman { } block must not escape across } to waive next rule");
    assert.equal(r45AllmanRes.unusedIgnores.length, 1);
    assert.ok(r45AllmanRes.active.some((f) => f.ruleId === "dsaf/off-grid-spacing" && f.line === 5));

    const r45UncSarif = formatSarif(
      [{ ruleId: "dsaf/no-100vw", severity: "error", file: "\\\\server\\share\\my file.css", line: 1, message: "unc" }],
      { repoRoot: null }
    );
    assert.equal(
      r45UncSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      "file:" + "//server/share/my%20file.css",
      "R45 A4-L2: UNC backslash path must map to RFC 8089 UNC file URI on POSIX"
    );

    // Round 46 (A4-M3 Prettier brace + note/blank gap, A4-M4 stacked/adjacent JSX comments, non-JSX block, A4-L5 cat defaultLevel fallback):
    const r46GapNote = [
      "{",
      "  /* dsaf-ignore dsaf/important-override -- intentional demo override */",
      "}",
      "{/* regular note */}",
      '<div style={{ color: "red !important" }} />',
    ].join("\n");
    const r46GapNoteRes = applyIgnores(
      [{ ruleId: "dsaf/important-override", line: 5, message: "x" }],
      r46GapNote,
      join(r41Root, "r46-gapnote.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46GapNoteRes.waived.length, 1, "R46 A4-M3: Prettier JSX ignore before regular comment note must waive element");
    assert.equal(r46GapNoteRes.unusedIgnores.length, 0);

    const r46GapBlank = [
      "{",
      "  /* dsaf-ignore dsaf/important-override -- intentional demo override */",
      "}",
      "",
      '<div style={{ color: "red !important" }} />',
    ].join("\n");
    const r46GapBlankRes = applyIgnores(
      [{ ruleId: "dsaf/important-override", line: 5, message: "x" }],
      r46GapBlank,
      join(r41Root, "r46-gapblank.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46GapBlankRes.waived.length, 1, "R46 A4-M3: Prettier JSX ignore before blank line must waive element");
    assert.equal(r46GapBlankRes.unusedIgnores.length, 0);

    const r46StackedOne = [
      "{/* dsaf-ignore dsaf/important-override -- intentional demo override */",
      " /* dsaf-ignore dsaf/hardcoded-color -- intentional brand hex */}",
      '<div style={{ color: "#ff00aa !important" }} />',
    ].join("\n");
    const r46StackedOneRes = applyIgnores(
      [
        { ruleId: "dsaf/important-override", line: 3, message: "x" },
        { ruleId: "dsaf/hardcoded-color", line: 3, message: "y" },
      ],
      r46StackedOne,
      join(r41Root, "r46-stacked1.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46StackedOneRes.waived.length, 2, "R46 A4-M4: stacked ignores inside one multiline JSX brace container must waive both");
    assert.equal(r46StackedOneRes.unusedIgnores.length, 0);

    const r46AdjJsx = [
      "{/* dsaf-ignore dsaf/hardcoded-color -- intentional brand hex */} {/* note */}",
      '<div style={{ color: "#ff00aa" }} />',
    ].join("\n");
    const r46AdjJsxRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 2, message: "y" }],
      r46AdjJsx,
      join(r41Root, "r46-adj.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46AdjJsxRes.waived.length, 1, "R46 A4-M4: JSX ignore sharing line with sibling JSX comment must waive element");
    assert.equal(r46AdjJsxRes.unusedIgnores.length, 0);

    const r46NonJsxBlk = [
      "{",
      "  /* dsaf-ignore dsaf/hardcoded-color -- dead standalone block */",
      "}",
      "const S = styled.div`color: #ff00aa;`;",
    ].join("\n");
    const r46NonJsxRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 4, message: "y" }],
      r46NonJsxBlk,
      join(r41Root, "r46-nonjsx.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46NonJsxRes.waived.length, 0, "R46 A4-M4: non-JSX block } before const must not waive");
    assert.equal(r46NonJsxRes.unusedIgnores.length, 1);

    const r46DefaultLevelFindings = [
      { ruleId: "dsaf/no-100vw", file: "a.css", line: 1, message: "100vw" },
      { ruleId: "dsaf/semantic-orphan-var", file: "a.css", line: 2, message: "orphan" },
    ];
    const r46DefaultSarif = formatSarif(r46DefaultLevelFindings);
    assert.deepEqual(r46DefaultSarif.runs[0].results.map((r) => r.level), ["error", "note"], "R46 A4-L5: formatSarif must fall back to cat.defaultLevel");
    const r46DefaultGh = formatGithubAnnotations(r46DefaultLevelFindings);
    assert.match(r46DefaultGh, /^::error .*\[FLOOR\] 100vw/m);
    assert.match(r46DefaultGh, /^::notice .*\[FINISH\] orphan/m);

    const r46AstroMulti = [
      "---",
      "---",
      "{",
      "  /* dsaf-ignore dsaf/tailwind-arbitrary -- custom hero grid track width */",
      "}",
      '<div class="w-[317px]" />',
    ].join("\n");
    const r46AstroRes = applyIgnores(
      [{ ruleId: "dsaf/tailwind-arbitrary", line: 6, message: "w-[317px]" }],
      r46AstroMulti,
      join(r41Root, "r46-astro.astro"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r46AstroRes.waived.length, 1, "R46: Astro multiline { /* dsaf-ignore */ } after --- frontmatter must waive element");
    assert.equal(r46AstroRes.unusedIgnores.length, 0);

    // Round 47 (A4-M2 same-line closeLine & trailing comma, A4-M3 intervening regular comment, A4-L5 empty annotation message fallback):
    const r47SameLineJsx = [
      "<>",
      "  {",
      "    /* dsaf-ignore dsaf/hardcoded-color -- same-line brand accent */",
      '  } <span style={{ color: "#ff00aa" }} />',
      "</>",
    ].join("\n");
    const r47SameLineRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 4, message: "hex" }],
      r47SameLineJsx,
      join(r41Root, "r47-sameline.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47SameLineRes.waived.length, 1, "R47 A4-M2: multiline { /* ignore */ } <span /> on close line must waive same line");
    assert.equal(r47SameLineRes.unusedIgnores.length, 0);

    const r47ObjAfter = [
      "const xs = [",
      "  {",
      "    /* dsaf-ignore dsaf/hardcoded-color -- object literal, not JSX */",
      "  },",
      "];",
      '<span style={{ color: "#ff00aa" }} />',
    ].join("\n");
    const r47ObjRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 6, message: "hex" }],
      r47ObjAfter,
      join(r41Root, "r47-obj.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47ObjRes.waived.length, 0, "R47 A4-M2: JS object literal }, must NOT waive later JSX");
    assert.equal(r47ObjRes.unusedIgnores.length, 1);

    const r47InterCss = [
      "/* dsaf-ignore dsaf/hardcoded-color -- brand gradient canvas fallback */",
      "/* regular note explaining exception */",
      ".a { color: #ff00aa; }",
    ].join("\n");
    const r47InterCssRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 3, message: "hex" }],
      r47InterCss,
      join(r41Root, "r47-inter.css"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47InterCssRes.waived.length, 1, "R47 A4-M3: intervening regular CSS comment must skip to next code line");
    assert.equal(r47InterCssRes.unusedIgnores.length, 0);

    const r47InterJs = [
      "// dsaf-ignore dsaf/hardcoded-color -- intentional brand canvas swatch",
      "// eslint-disable-next-line no-inline-styles",
      'const el = <div style={{ color: "#ff00aa" }} />;',
    ].join("\n");
    const r47InterJsRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 3, message: "hex" }],
      r47InterJs,
      join(r41Root, "r47-inter.tsx"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47InterJsRes.waived.length, 1, "R47 A4-M3: intervening regular JS line comment must skip to next code line");

    const r47InterHtml = [
      "<!-- dsaf-ignore dsaf/hardcoded-color -- hero SVG fallback tint -->",
      "<!-- regular HTML comment -->",
      '<div style="color: #ff00aa"></div>',
    ].join("\n");
    const r47InterHtmlRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 3, message: "hex" }],
      r47InterHtml,
      join(r41Root, "r47-inter.html"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47InterHtmlRes.waived.length, 1, "R47 A4-M3: intervening regular HTML comment must skip to next code line");

    const r47BlankSepCss = [
      "/* dsaf-ignore dsaf/hardcoded-color -- separated by blank line */",
      "",
      ".a { color: #ff00aa; }",
    ].join("\n");
    const r47BlankSepRes = applyIgnores(
      [{ ruleId: "dsaf/hardcoded-color", line: 3, message: "hex" }],
      r47BlankSepCss,
      join(r41Root, "r47-blank.css"),
      { reportUnusedIgnores: true }
    );
    assert.equal(r47BlankSepRes.waived.length, 0, "R47 A4-M3: blank line between CSS dsaf-ignore and target must still NOT waive");

    const r47EmptyMsgAnn = formatGithubAnnotations([{ file: "a.css", line: 3, ruleId: "dsaf/no-transition-all", message: "" }]);
    assert.ok(r47EmptyMsgAnn.includes("[FLOOR] ") && r47EmptyMsgAnn.trim().length > r47EmptyMsgAnn.indexOf("[FLOOR] ") + 8, "R47 A4-L5: formatGithubAnnotations must fall back to catalog shortDescription when message is empty");

    // Round 48 regressions (A4-M1, A4-M2):
    const r48StackedSrc = [
      'export const S = ({ title }: any) => (',
      '  <div>',
      '    Hello {title}',
      '    {',
      '      /* dsaf-ignore dsaf/important-override -- first stacked rationale */',
      '    }',
      '    {',
      '      /* dsaf-ignore dsaf/hardcoded-color -- second stacked rationale */',
      '    }',
      '    <span style={{ color: "#ff00aa !important" }} />',
      '  </div>',
      ');',
    ].join("\n");
    const r48StackedDirs = parseInlineIgnores(r48StackedSrc, { filePath: "r48-stacked.tsx" });
    assert.equal(r48StackedDirs.length, 2, "R48 A4-M1: stacked multiline JSX containers after text/{title} must parse both directives");
    const r48StackedApplied = applyIgnores(
      [
        { file: "r48-stacked.tsx", line: 10, ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", message: "!important" },
        { file: "r48-stacked.tsx", line: 10, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "#ff00aa" },
      ],
      r48StackedSrc,
      "r48-stacked.tsx",
      { reportUnusedIgnores: true }
    );
    assert.equal(r48StackedApplied.waived.length, 2);
    assert.equal(r48StackedApplied.active.length, 0);
    assert.equal(r48StackedApplied.unusedIgnores.length, 0);

    for (const [negLabel, negSrc] of [
      ["js-fn-block", 'function foo() {\n  /* dsaf-ignore dsaf/important-override -- non-jsx block container */\n}\n<div style={{ color: "red !important" }} />\n'],
      ["js-obj-lit", 'const obj = {\n  /* dsaf-ignore dsaf/important-override -- non-jsx object container */\n};\n<div style={{ color: "red !important" }} />\n'],
    ]) {
      const negApp = applyIgnores(
        [{ file: "r48-neg.tsx", line: 4, ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", message: "!important" }],
        negSrc,
        "r48-neg.tsx",
        { reportUnusedIgnores: true }
      );
      assert.equal(negApp.waived.length, 0, `R48 A4-M1: ${negLabel} must remain rejected as non-JSX`);
    }

    const r48ImpCommented = extractImportantStyleSurfacePreservingLines('<div style={{ /* " */ color: "red !important" }} />', false);
    assert.match(r48ImpCommented, /!important/, "R48 A4-M2: /* \" */ comment inside style={{}} must not hide !important");
    const r48CmtCtx = scanMarkupContexts('<div>{/* } <video autoplay /> */}</div>', {});
    assert.equal(r48CmtCtx.openTags.some((t) => t.tag === "video"), false, "R48 A4-M2: '}' inside JSX comment must not close container and expose <video>");
    const r48MaskedRaw = maskProseAndDocStringsPreservingLines('/* <div> */ const x = "hello";', {});
    assert.match(r48MaskedRaw, /const x = /, "R48 A4-M2: maskProseAndDocStringsPreservingLines must strip raw comments before scanning JSX tags");

    // Round 49 regressions (R49-A4-H1, R49-A4-M1, R49-A4-M2, R49-A4-L1):
    const r49ProseSrc = [
      'export function Card({ ok }: { ok: boolean }) {',
      '  return (',
      '    <div>',
      "      {ok && <p>It's broken</p>}",
      '    </div>',
      '  );',
      '}',
      '',
      'const badgeCls = "bg-[#ff00aa] p-[13px] transition-all outline-none";',
      'const Box = styled.div`color: #123456 !important;`;',
    ].join("\n");
    const r49Masked = maskProseAndDocStringsPreservingLines(r49ProseSrc, {});
    assert.match(r49Masked, /styled\.div`color: #123456 !important;`/, "R49 A4-H1: apostrophe inside {ok && <p>It's</p>} must not swallow downstream code in proseSpans");
    const r49PopSrc = [
      'export const Demo = () => (',
      '  <Popover',
      "    trigger={<span>It's open</span>}",
      '    style={{ color: "red !important" }}',
      '  >',
      '    <div style={{ color: "blue !important" }} />',
      '  </Popover>',
      ');',
    ].join("\n");
    const r49PopImp = extractImportantStyleSurfacePreservingLines(r49PopSrc, false);
    assert.equal((r49PopImp.match(/!important/gi) || []).length, 2, "R49 A4-H1: apostrophe inside trigger={<span>It's</span>} must not drop host style={{}}");
    const r49SvgSrc = [
      'export const A = ({ ok }: any) => (',
      '  <svg viewBox="0 0 24 24">',
      "    {ok && <text>It's</text>}",
      '    <path fill="#ff00aa" />',
      '  </svg>',
      ');',
      'export const C = () => <div><p>Don\'t</p><span style={{ color: "#123456" }} /></div>;',
      'export const B = () => <svg><path /></svg>;',
    ].join("\n");
    assert.equal(findSvgBlockRanges(r49SvgSrc).length, 2, "R49 A4-H1: findSvgBlockRanges must keep enclosing <svg> when child brace has apostrophe");

    const r49StackedSameLine = [
      '<div>',
      '  {',
      '    /* dsaf-ignore dsaf/important-override -- first valid rationale */',
      '  }',
      '  {',
      '    /* dsaf-ignore dsaf/hardcoded-color -- second valid rationale */',
      '  } <div style={{ color: "#ff00aa !important" }} />',
      '</div>',
    ].join("\n");
    const r49SameLineApp = applyIgnores(
      [
        { file: "r49-same.tsx", line: 7, ruleId: "dsaf/important-override", tier: "reflex", severity: "warning", message: "!important" },
        { file: "r49-same.tsx", line: 7, ruleId: "dsaf/hardcoded-color", tier: "reflex", severity: "warning", message: "#ff00aa" },
      ],
      r49StackedSameLine,
      "r49-same.tsx",
      { reportUnusedIgnores: true }
    );
    assert.equal(r49SameLineApp.waived.length, 2, "R49 A4-M1: closing line with live JSX must receive stacked multiline waiver");
    assert.equal(r49SameLineApp.active.length, 0);
    assert.equal(r49SameLineApp.unusedIgnores.length, 0);

    const r49ScssUrl = [
      '<style lang="scss">.hero { background: url(https://cdn.example.com/bg.png); color: #ff00aa !important; }</style>',
      '<template>',
      '  <p>Route: /a // <button class="outline-none" /></p>',
      '</template>',
    ].join("\n");
    assert.equal(extractRealStyleBlocks(r49ScssUrl, null, { isMarkupSfc: true }).length, 1, "R49 A4-M2: unquoted url(https://...) in SCSS style must not swallow </style>");
    assert.match(extractImportantStyleSurfacePreservingLines(r49ScssUrl, false, { isMarkupSfc: true }), /!important/);
    assert.match(stripCommentsPreservingLines(r49ScssUrl), /outline-none/);

    assert.match(
      extractImportantStyleSurfacePreservingLines('<div style:--brandColor|important={x} />', false),
      /!important/,
      "R49 A4-L1: braced style directive with uppercase CSS variable must match case-insensitively"
    );

    // Round 50 regressions (R50-A4-H1, R50-A4-M1, R50-A4-L1, R50-A2-M4):
    const r50VueUnclosed = '<template><style>.btn { outline: none; }</style><p>Unclosed {{ literal</p></template>\n';
    const r50VueCtx = scanMarkupContexts(r50VueUnclosed, { isMarkupSfc: true, mustacheExprs: true });
    assert.ok(r50VueCtx.proseSpans.every(([s0]) => s0 >= 0), "R50 A4-H1: unclosed {{ must never emit negative proseSpan start");
    assert.equal(extractRealStyleBlocks(r50VueUnclosed, r50VueCtx, { isMarkupSfc: true }).length, 1);
    const r50VueImp = extractImportantStyleSurfacePreservingLines(
      '<template><style>.btn { color: #ff00aa !important; }</style><p>Unclosed {{ literal</p></template>\n',
      false,
      { isMarkupSfc: true, mustacheExprs: true }
    );
    assert.match(r50VueImp, /!important/, "R50 A4-H1: unclosed {{ must not blank preceding <style> block");

    const r50SvelteUnclosed = '<style>.btn { color: #ff00aa !important; }</style><p>Unclosed { brace</p>\n';
    const r50SvelteCtx = scanMarkupContexts(r50SvelteUnclosed, { isMarkupSfc: true, braceExprs: true });
    assert.ok(r50SvelteCtx.proseSpans.every(([s0]) => s0 >= 0), "R50 A4-H1: unclosed { must never emit negative proseSpan start");
    assert.match(
      extractImportantStyleSurfacePreservingLines(r50SvelteUnclosed, false, { isMarkupSfc: true, braceExprs: true }),
      /!important/,
      "R50 A4-H1: unclosed { must not blank preceding <style> block"
    );

    const r50AstroVoid1 = '{show && <img src="/hero.png">} <div style={{ color: "#ff00aa !important" }} />\n';
    assert.match(
      extractImportantStyleSurfacePreservingLines(r50AstroVoid1, false, { isMarkupSfc: true, braceExprs: true }),
      /!important/,
      "R50 A4-M1: lowercase void <img> inside Astro brace expression must not swallow downstream code"
    );
    const r50AstroVoid2 = '{show && <div><img src="/hero.png"></div>} <div style={{ color: "#112233 !important" }} />\n';
    assert.match(
      extractImportantStyleSurfacePreservingLines(r50AstroVoid2, false, { isMarkupSfc: true, braceExprs: true }),
      /!important/,
      "R50 A4-M1: void <img> inside balanced <div> inside Astro brace expression must close properly"
    );
    const r50JsxLink = '{show && <Link href="/"><span>Home</span></Link>} <div style={{ color: "#112233 !important" }} />\n';
    assert.match(
      extractImportantStyleSurfacePreservingLines(r50JsxLink, false),
      /!important/,
      "R50 A4-M1: paired <Link> inside JSX brace expression must remain balanced"
    );

    const r50DirImp = '<div style:--my_accent|important="var(--c)" style:--_bg|important={val} />\n';
    assert.equal(
      (extractImportantStyleSurfacePreservingLines(r50DirImp, false, { isMarkupSfc: true, braceExprs: true }).match(/!important/g) || []).length,
      2,
      "R50 A4-L1: Svelte style:--my_accent|important and style:--_bg|important must emit !important"
    );

    const r50SxCss = extractImportantStyleSurfacePreservingLines(
      '<Box sx={{ color: "#ff00aa !important", "& #ace": { color: "var(--ink)" }, ["#cab"]: { color: "#112233" } }} css={{ background: "#223344" }} CSS={{ background: "#dead00" }} />\n',
      false
    );
    assert.match(r50SxCss, /#ff00aa/);
    assert.match(r50SxCss, /!important/);
    assert.match(r50SxCss, /#112233/);
    assert.match(r50SxCss, /#223344/);
    assert.doesNotMatch(r50SxCss, /#ace/);
    assert.doesNotMatch(r50SxCss, /#cab/);
    assert.doesNotMatch(r50SxCss, /#dead00/);

    console.log("CI_REPORT_SELF_TEST_PASSED (SARIF 2.1.0 + GitHub annotations + 3-tier waiver & unused-ignore gate)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (values.help) {
    console.log("Usage: node skill/scripts/ci-report.mjs [--self-test] [--help]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  console.log("ci-report.mjs provides SARIF 2.1.0, GitHub annotations, and 3-tier waiver helpers for DSAF scripts. Pass --self-test to verify.");
}

if (isDirectCliEntry(import.meta.url)) main();

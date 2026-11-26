#!/usr/bin/env node
/**
 * DSAF v0.4.0 — Shared CI Formatter (SARIF 2.1.0 & GitHub Annotations) &
 * 3-Tier Gate / Inline Waiver Engine (`Floor` / `Reflex` / `Finish`).
 * Zero external dependencies.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export const CI_REPORT_VERSION = "0.4.0";

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
  /^(?:ok|fine|ignore|ignored|skip|todo|fix\s*later|temp|temporary|needed|legacy|waived|n\/a|lgtm|required|intentional)\.?$/i;

export function maskRangePreservingLines(chars, start, end) {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== "\n") chars[i] = " ";
  }
}

/**
 * Strip block comments (`/* ... *\/`), HTML comments (`<!-- ... -->`), and JS line
 * comments (`// ...` only when preceded by start/whitespace/punctuation so URLs survive)
 * while preserving exact line breaks for 1-to-1 line attribution.
 */
export function stripCommentsPreservingLines(raw) {
  const chars = raw.split("");
  for (const m of raw.matchAll(/\/\*[\s\S]*?\*\//g)) {
    maskRangePreservingLines(chars, m.index, m.index + m[0].length);
  }
  for (const m of raw.matchAll(/<!--[\s\S]*?-->/g)) {
    maskRangePreservingLines(chars, m.index, m.index + m[0].length);
  }
  const withoutBlocks = chars.join("");
  for (const m of withoutBlocks.matchAll(/(^|[\s;{}(),])(\/\/[^\n]*)/gm)) {
    const start = m.index + m[1].length;
    maskRangePreservingLines(chars, start, start + m[2].length);
  }
  return chars.join("");
}

/**
 * Mask `:root`, `[data-theme]`, `@theme`, `html.dark`, `html.light`, `:host` token
 * definition blocks while keeping newline positions intact.
 */
export function stripTokenBlocksPreservingLines(cssText) {
  const cleaned = stripCommentsPreservingLines(cssText);
  const out = [];
  let idx = 0;
  let depth = 0;
  let skipDepth = null;
  let curHeader = "";

  while (idx < cleaned.length) {
    const ch = cleaned[idx];
    if (ch === "{") {
      depth++;
      const hdr = curHeader.trim();
      curHeader = "";
      if (
        skipDepth === null &&
        /(^|,|\s)(:root|\[data-theme[^\]]*\]|@theme(?:\s+inline)?\b|html\[data-uxs-theme[^\]]*\]|html\.(?:dark|light)\b|:host\b)/i.test(
          hdr
        )
      ) {
        skipDepth = depth;
      }
      out.push(ch);
    } else if (ch === "}") {
      if (skipDepth !== null && depth === skipDepth) skipDepth = null;
      depth = Math.max(0, depth - 1);
      curHeader = "";
      out.push(ch);
    } else {
      if (skipDepth !== null && ch !== "\n") out.push(" ");
      else out.push(ch);
      if (depth === 0 || (skipDepth === null && ch !== ";" && ch !== "}")) {
        curHeader += ch;
        if (ch === ";") curHeader = "";
      }
    }
    idx++;
  }
  return out.join("");
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

export function parseInlineIgnores(raw) {
  const directives = [];
  const lines = String(raw || "").split(/\r?\n/);
  const re = /(?:\/\*|\/\/|<!--)\s*dsaf-ignore\s+([a-z0-9/_-]+)(?:\s+--\s*(.+?))?(?:\s*(?:\*\/|-->)|\s*$)/i;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const m = re.exec(lineText);
    if (!m) continue;
    const before = lineText.slice(0, m.index).trim();
    const isInline = before.length > 0;
    let ruleId = m[1].trim().toLowerCase();
    if (!ruleId.includes("/")) ruleId = `dsaf/${ruleId}`;
    directives.push({
      ruleId,
      reason: (m[2] || "").replace(/(?:\*\/|-->)\s*$/, "").trim(),
      line: i + 1,
      isInline,
      targetLine: isInline ? i + 1 : i + 2,
      used: false,
      rejected: false,
    });
  }
  return directives;
}

export function applyIgnores(findings, rawContent, filePath, options = {}) {
  const directives = parseInlineIgnores(rawContent);
  const active = [];
  const waived = [];
  const extraFindings = [];
  const rejectedDirs = new Set();

  for (const f of findings) {
    const meta = RULE_CATALOG[f.ruleId];
    const tier = f.tier || meta?.tier || "reflex";
    const severity = f.severity || meta?.defaultLevel || (tier === "floor" ? "error" : "warning");
    const norm = { ...f, file: f.file || filePath, tier, severity };

    const matchingDir = directives.find(
      (d) => d.ruleId === norm.ruleId && (d.isInline ? d.line === norm.line : d.line === norm.line || d.targetLine === norm.line)
    );

    if (!matchingDir) {
      active.push(norm);
      continue;
    }

    if (tier === "floor") {
      active.push(norm);
      if (!rejectedDirs.has(matchingDir.line)) {
        rejectedDirs.add(matchingDir.line);
        matchingDir.rejected = true;
        extraFindings.push({
          file: filePath,
          line: matchingDir.line,
          ruleId: "dsaf/floor-waiver-rejected",
          tier: "floor",
          severity: "error",
          message: `Cannot waive Floor rule '${norm.ruleId}' via dsaf-ignore; fix the underlying Floor defect.`,
        });
      }
      continue;
    }

    if (isBoilerplateReason(matchingDir.reason)) {
      active.push(norm);
      if (!rejectedDirs.has(matchingDir.line)) {
        rejectedDirs.add(matchingDir.line);
        matchingDir.rejected = true;
        extraFindings.push({
          file: filePath,
          line: matchingDir.line,
          ruleId: "dsaf/waiver-reason-weak",
          tier: "reflex",
          severity: "warning",
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

function toPosixUri(filePath, repoRoot) {
  if (!filePath) return "unknown";
  const absOrRel = repoRoot ? relative(resolve(repoRoot), resolve(repoRoot, filePath)) : filePath;
  return String(absOrRel).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function formatSarif(findings, { toolVersion = CI_REPORT_VERSION, repoRoot = null } = {}) {
  const seenRules = new Map();
  for (const f of findings) {
    if (!seenRules.has(f.ruleId)) {
      const cat = RULE_CATALOG[f.ruleId];
      seenRules.set(
        f.ruleId,
        cat || {
          id: f.ruleId,
          tier: f.tier || "reflex",
          defaultLevel: f.severity || "warning",
          shortDescription: f.ruleId,
          help: f.message || "Resolve DSAF finding.",
        }
      );
    }
  }

  const rules = [...seenRules.values()].map((r) => ({
    id: r.id,
    shortDescription: { text: r.shortDescription },
    help: { text: r.help },
    defaultConfiguration: { level: r.defaultLevel },
    properties: { tier: r.tier },
  }));

  const results = findings.map((f) => ({
    ruleId: f.ruleId,
    level: f.severity === "error" ? "error" : f.severity === "note" ? "note" : "warning",
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: toPosixUri(f.file, repoRoot) },
          region: { startLine: Math.max(1, Number(f.line) || 1) },
        },
      },
    ],
    properties: { tier: f.tier || "reflex" },
  }));

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
      const cmd = f.severity === "error" ? "error" : f.severity === "note" ? "notice" : "warning";
      const file = escapeGithubProp(toPosixUri(f.file, repoRoot));
      const line = Math.max(1, Number(f.line) || 1);
      const title = escapeGithubProp(f.ruleId);
      const msg = escapeGithubData(`[${(f.tier || "reflex").toUpperCase()}] ${f.message}`);
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
    console.log("CI_REPORT_SELF_TEST_PASSED (SARIF 2.1.0 + GitHub annotations + 3-tier waiver & unused-ignore gate)");
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/ci-report.mjs [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) process.exit(runSelfTest());
  console.log("ci-report.mjs provides SARIF 2.1.0, GitHub annotations, and 3-tier waiver helpers for DSAF scripts. Pass --self-test to verify.");
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) main();

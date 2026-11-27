#!/usr/bin/env node
/**
 * DSAF v0.9.3 — Standalone Editorial HTML Audit Report Generator.
 * Produces a zero-dependency, offline-safe interactive HTML report containing
 * Scorecard Summary, Persona Impact Matrix, and Tokens/Drift inspection tabs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertWritableOutputFile, isDirectCliEntry } from "./ci-report.mjs";

export const HTML_REPORT_VERSION = "0.9.3";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMessage(val) {
  return esc(val).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function sanitizePreviewHref(raw) {
  const rawStr = String(raw || "");
  if (/[\u0000-\u001f\u007f]/.test(rawStr)) return null;
  const s = rawStr.trim();
  if (!s || /^[/\\]{2}|\\/.test(s)) return null;
  const colonIdx = s.indexOf(":");
  const slashIdx = s.search(/[/?#]/);
  const hasScheme = colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx);
  if (hasScheme) {
    return /^https?:\/\//i.test(s) ? s : null;
  }
  return s;
}

function shortRepoName(targetPath) {
  const clean = String(targetPath || ".").replace(/[/\\]+$/, "");
  const parts = clean.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] || clean || "workspace";
}

export function renderHtmlReport(summary, opts = {}) {
  const s = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  const repoLabel = o.title || shortRepoName(s.target);
  const r = s.recon && typeof s.recon === "object" ? s.recon : {};
  const t = s.tokens && typeof s.tokens === "object" ? s.tokens : {};
  const d = t.drift && typeof t.drift === "object" ? t.drift : {};
  const cg = s.ciGate && typeof s.ciGate === "object" ? s.ciGate : { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 };
  const findings = (Array.isArray(s.ciFindings) ? s.ciFindings : []).filter((f) => f && typeof f === "object" && !Array.isArray(f));
  const personas = (Array.isArray(s.personas?.items) ? s.personas.items : []).filter((p) => p && typeof p === "object" && !Array.isArray(p));
  const rawComp = d.tokenCompliancePct;
  const compliance = typeof rawComp === "number" && Number.isFinite(rawComp) ? rawComp : "N/A";
  const statusLabel = s.passed ? "PASS" : "FAIL";
  const statusClass = s.passed ? "pill--pass" : "pill--fail";
  const safePreviewHref = sanitizePreviewHref(o.previewHref);
  const previewLink = safePreviewHref ? `<a class="btn" href="${esc(safePreviewHref)}">Open Preview Shell</a>` : "";

  const visibleFindings = findings.slice(0, 60);
  const truncationNote =
    findings.length > 60
      ? `\n<tr role="row"><td role="cell" colspan="4" class="muted-cell">Showing 60 of ${esc(findings.length)} active findings. See JSON output for complete list.</td></tr>`
      : "";

  const findingsRows =
    findings.length === 0
      ? `<tr role="row"><td role="cell" colspan="4" class="muted-cell">No active Floor or Reflex defects detected.</td></tr>`
      : visibleFindings
          .map((f) => {
            const pList = Array.isArray(f.personaIds) && f.personaIds.length > 0 ? f.personaIds.join(", ") : "All";
            const tierBadge =
              f.tier === "floor"
                ? `<span class="pill pill--fail">Floor</span>`
                : f.tier === "finish"
                ? `<span class="pill">Finish</span>`
                : `<span class="pill pill--warn">Reflex</span>`;
            const loc = `${esc(f.file || "")}${f.line ? `:${esc(f.line)}` : ""}`;
            return `<tr role="row">
              <th role="rowheader" scope="row" data-label="Rule"><code>${esc(f.ruleId || "dsaf/rule")}</code><div class="sub-line">${formatMessage(f.message || "")}</div></th>
              <td role="cell" data-label="Tier">${tierBadge}</td>
              <td role="cell" data-label="Location"><code>${loc}</code></td>
              <td role="cell" data-label="Personas"><span class="mono-text">${esc(pList)}</span></td>
            </tr>`;
          })
          .join("\n") + truncationNote;

  const personaRows =
    personas.length === 0
      ? `<tr role="row"><td role="cell" colspan="4" class="muted-cell">No persona matrix attached to this audit run.</td></tr>`
      : personas
          .map((p) => {
            const impactCount = Number(p.impactedCount || 0);
            const rawRules = Array.isArray(p.findingRules) ? p.findingRules : [];
            const rulesList = rawRules.slice(0, 3).map((x) => `<code>${esc(x)}</code>`).join(", ");
            const impactCell =
              impactCount > 0
                ? `<span class="pill pill--warn">${esc(impactCount)} ${impactCount === 1 ? "issue" : "issues"}</span>${rulesList ? `<div class="sub-line">${rulesList}</div>` : ""}`
                : `<span class="pill pill--pass">Clean</span>`;
            return `<tr role="row">
              <th role="rowheader" scope="row" data-label="Persona"><strong>${esc(p.id)}</strong> · ${esc(p.name)}<div class="sub-line">${esc(p.axis)}</div></th>
              <td role="cell" data-label="Viewport">${esc(p.viewport || "Responsive")}</td>
              <td role="cell" data-label="Signal"><code>${esc(p.source || "signal")}</code></td>
              <td role="cell" data-label="Impact">${impactCell}</td>
            </tr>`;
          })
          .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <script>
    try {
      var saved = localStorage.getItem("dsaf-report-theme");
      if (saved === "light" || saved === "dark") {
        document.querySelector('meta[name="color-scheme"]').content = saved;
      }
    } catch (e) {}
  </script>
  <title>DSAF Audit Report — ${esc(repoLabel)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #F6F7F9;
      --surface: #FFFFFF;
      --surface-alt: #EEF1F5;
      --border: #D8DFE8;
      --border-strong: #5E6F88;
      --fg: #101926;
      --muted: #455264;
      --accent: #132540;
      --pass-bg: #E7F3EC;
      --pass-border: #A9D4BC;
      --pass-fg: #0D5935;
      --warn-bg: #FCF3DC;
      --warn-border: #D9B75A;
      --warn-fg: #664900;
      --fail-bg: #FDECEC;
      --fail-border: #E5A5A5;
      --fail-fg: #8E1B1B;
      --ring: #132540;
      --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;

      &:has(> head > meta[name="color-scheme"][content="dark"]) {
        color-scheme: dark;
        --bg: #0B111B;
        --surface: #121B29;
        --surface-alt: #182334;
        --border: #283549;
        --border-strong: #6A7A91;
        --fg: #EBF0F7;
        --muted: #B6C2D4;
        --accent: #F4BA17;
        --pass-bg: #123326;
        --pass-border: #2A6E53;
        --pass-fg: #7DE0B1;
        --warn-bg: #362C12;
        --warn-border: #8A6E1C;
        --warn-fg: #F7D469;
        --fail-bg: #3D191B;
        --fail-border: #8F373B;
        --fail-fg: #F7A3A7;
        --ring: #F4BA17;
      }

      &:has(> head > meta[name="color-scheme"][content="light"]) {
        color-scheme: light;
      }
    }

    @media (prefers-color-scheme: dark) {
      :root:not(:has(> head > meta[name="color-scheme"][content="light"])) {
        --bg: #0B111B;
        --surface: #121B29;
        --surface-alt: #182334;
        --border: #283549;
        --border-strong: #6A7A91;
        --fg: #EBF0F7;
        --muted: #B6C2D4;
        --accent: #F4BA17;
        --pass-bg: #123326;
        --pass-border: #2A6E53;
        --pass-fg: #7DE0B1;
        --warn-bg: #362C12;
        --warn-border: #8A6E1C;
        --warn-fg: #F7D469;
        --fail-bg: #3D191B;
        --fail-border: #8F373B;
        --fail-fg: #F7A3A7;
        --ring: #F4BA17;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 0.01ms; animation-duration: 0.01ms; }
    }

    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.55;
    }

    a:focus-visible, button:focus-visible, [tabindex]:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }

    .skip-link {
      position: fixed;
      left: 16px;
      top: 12px;
      width: 1px;
      height: 1px;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip-path: inset(50%);
      z-index: 100;
      background: var(--surface);
      color: var(--fg);
      border-radius: 8px;
      font-weight: 600;
      text-decoration: none;
    }
    .skip-link:focus,
    .skip-link:focus-visible {
      width: auto;
      height: auto;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      padding: 8px 16px;
      clip-path: none;
      border: 2px solid var(--ring);
      outline: 2px solid var(--ring);
      outline-offset: 2px;
    }

    .topbar {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .wrap {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 20px;
    }
    .topbar-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-block: 12px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--fg);
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:hover { background: var(--surface-alt); }

    .report-head {
      padding: 28px 0 20px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      flex-wrap: wrap;
    }
    .report-head > div {
      min-width: 0;
      max-width: 100%;
    }
    h1 {
      margin: 0 0 6px;
      font-size: clamp(1.375rem, 1rem + 1.5vw, 2rem);
      line-height: 1.2;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
    }
    .meta-line {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .stat-label {
      margin: 0 0 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat-val {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-alt);
      color: var(--fg);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      line-height: 1;
    }
    .pill--pass { background: var(--pass-bg); border-color: var(--pass-border); color: var(--pass-fg); }
    .pill--warn { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-fg); }
    .pill--fail { background: var(--fail-bg); border-color: var(--fail-border); color: var(--fail-fg); }

    .tablist {
      display: flex;
      overflow-x: auto;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
      scrollbar-width: thin;
      scroll-padding-inline: 12px;
    }
    [role="tab"] {
      position: relative;
      flex: none;
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 600;
      min-height: 44px;
      padding: 10px 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    [role="tab"]:hover { color: var(--fg); }
    [role="tab"]:focus-visible,
    .table-wrap:focus-visible {
      outline-offset: -2px;
    }
    [role="tab"][aria-selected="true"] {
      color: var(--fg);
    }
    [role="tab"][aria-selected="true"]::after {
      content: "";
      position: absolute;
      inset: auto 8px 0;
      border-block-end: 3px solid var(--accent);
    }

    [role="tabpanel"] {
      margin: 0;
      padding: 0;
      border: 0;
    }
    .panel-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }

    .table-wrap {
      overflow: auto;
      max-inline-size: 100%;
      container-type: inline-size;
      border-radius: inherit;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    thead th {
      background: var(--surface-alt);
      font-weight: 700;
      font-size: 13px;
    }
    tbody tr:last-child th,
    tbody tr:last-child td { border-bottom: 0; }
    code, .mono-text {
      font-family: var(--font-mono);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .sub-line {
      margin-top: 3px;
      font-weight: 400;
      color: var(--muted);
      font-size: 13px;
    }
    .muted-cell {
      color: var(--muted);
      padding: 20px 16px;
    }

    @container (width < 600px) {
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tbody tr {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
      }
      tbody tr:last-child { border-bottom: 0; }
      tbody th, tbody td {
        padding: 4px 0;
        border-bottom: 0;
      }
      tbody td[data-label]::before {
        content: attr(data-label) ": ";
        font-weight: 600;
        color: var(--muted);
        margin-right: 6px;
      }
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      background: var(--border);
    }
    .metric-cell {
      background: var(--surface);
      padding: 14px 16px;
    }
    .metric-k { font-size: 12.5px; color: var(--muted); margin: 0 0 2px; }
    .metric-v { font-family: var(--font-mono); font-size: 15px; font-weight: 600; margin: 0; }

    .report-foot {
      padding: 24px 0 36px;
      color: var(--muted);
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }

    @media (max-width: 720px) {
      .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metrics-grid { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="topbar">
    <div class="wrap topbar-inner">
      <div class="brand">
        <span>DSAF Audit Report</span>
        <span class="pill ${statusClass}">${esc(statusLabel)}</span>
      </div>
      <div class="top-actions">
        ${previewLink}
        <button type="button" class="btn" id="theme-toggle-btn">Switch theme</button>
      </div>
    </div>
  </header>

  <main class="wrap" id="main-content">
    <section class="report-head">
      <div>
        <h1>${esc(repoLabel)}</h1>
        <p class="meta-line">Topology: <strong>Mode ${esc(r.recommendedMode || "P")}</strong> (${esc(r.topologyLabel || "Product")}) · Surface: <strong>${esc(r.surfaceMode || "persuade")}</strong> · DSAF v${esc(s.engine_version || HTML_REPORT_VERSION)}</p>
      </div>
      ${(() => {
        const genDate = String(s.generated || "").slice(0, 10).trim();
        return genDate ? `<span class="pill">${esc(genDate)}</span>` : "";
      })()}
    </section>

    <section class="summary-strip" aria-label="Audit key counts">
      <div class="stat">
        <p class="stat-label">Floor Defects</p>
        <p class="stat-val">${esc(cg.floor ?? 0)}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Reflex Warnings</p>
        <p class="stat-val">${esc(cg.reflex ?? 0)}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Token Compliance</p>
        <p class="stat-val">${esc(compliance)}${compliance === "N/A" ? "" : "%"}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Personas Checked</p>
        <p class="stat-val">${esc(personas.length)}</p>
      </div>
    </section>

    <div class="tabs">
      <div role="tablist" class="tablist" focusgroup="tablist nomemory" aria-label="Audit report sections">
        <button type="button" role="tab" id="tab-findings" aria-selected="true" focusgroupstart>Findings (${esc(findings.length)})</button>
        <button type="button" role="tab" id="tab-personas" aria-selected="false">Persona Matrix (${esc(personas.length)})</button>
        <button type="button" role="tab" id="tab-tokens" aria-selected="false">Tokens &amp; Telemetry</button>
      </div>

      <div role="tabpanel" aria-labelledby="tab-findings">
        <div class="panel-box">
          <div class="table-wrap" tabindex="0" role="region" aria-label="Active findings mapped to personas">
            <table role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Rule &amp; Detail</th>
                  <th role="columnheader" scope="col">Tier</th>
                  <th role="columnheader" scope="col">Location</th>
                  <th role="columnheader" scope="col">Personas Impacted</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                ${findingsRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div role="tabpanel" aria-labelledby="tab-personas" hidden="until-found">
        <div class="panel-box">
          <div class="table-wrap" tabindex="0" role="region" aria-label="Persona impact matrix">
            <table role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Persona &amp; Axis</th>
                  <th role="columnheader" scope="col">Viewport</th>
                  <th role="columnheader" scope="col">Signal</th>
                  <th role="columnheader" scope="col">Impact</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                ${personaRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div role="tabpanel" aria-labelledby="tab-tokens" hidden="until-found">
        <div class="panel-box">
          <div class="metrics-grid">
            <div class="metric-cell"><p class="metric-k">UI &amp; Style Files Scanned</p><p class="metric-v">${esc(t.filesScanned?.uiAndStyle ?? 0)}</p></div>
            <div class="metric-cell"><p class="metric-k">DTCG Tokens</p><p class="metric-v">${esc(t.dtcgTokenCount ?? 0)}</p></div>
            <div class="metric-cell"><p class="metric-k">Hardcoded Colors / var() Refs</p><p class="metric-v">${esc(d.hardcodedColorHits ?? 0)} / ${esc(d.colorTokenRefs ?? 0)}</p></div>
            <div class="metric-cell"><p class="metric-k">CSS Orphans (Semantic / Scale)</p><p class="metric-v">${esc(d.semanticOrphanCount ?? 0)} / ${esc(d.paletteScaleUnusedCount ?? 0)}</p></div>
            <div class="metric-cell"><p class="metric-k">!important / Off-Grid Spacing</p><p class="metric-v">${esc(d.importantOverrides ?? 0)} / ${esc(d.offGridSpacingHits ?? 0)}</p></div>
            <div class="metric-cell"><p class="metric-k">Waived / Unused Ignores</p><p class="metric-v">${esc(cg.waived ?? 0)} / ${esc(cg.unusedIgnores ?? 0)}</p></div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <footer class="wrap report-foot">
    <span>Generated offline by @zintaen/dsaf v${esc(HTML_REPORT_VERSION)}</span>
    <span>Read-Only Tier 0 Evidence Report</span>
  </footer>

  <script>
    (function() {
      var meta = document.querySelector('meta[name="color-scheme"]');
      var themeBtn = document.getElementById("theme-toggle-btn");
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var manualTheme = meta && (meta.content === "light" || meta.content === "dark") ? meta.content : null;
      function currentScheme() {
        if (meta && (meta.content === "light" || meta.content === "dark")) return meta.content;
        return mq.matches ? "dark" : "light";
      }
      function syncThemeBtn() {
        if (!themeBtn) return;
        var next = currentScheme() === "dark" ? "light" : "dark";
        themeBtn.textContent = next === "dark" ? "Dark theme" : "Light theme";
        themeBtn.setAttribute("aria-label", "Switch to " + next + " theme");
      }
      if (themeBtn && meta) {
        syncThemeBtn();
        themeBtn.addEventListener("click", function() {
          var target = currentScheme() === "dark" ? "light" : "dark";
          var sys = mq.matches ? "dark" : "light";
          manualTheme = target === sys ? null : target;
          meta.content = manualTheme || "light dark";
          try {
            if (target === sys) {
              localStorage.removeItem("dsaf-report-theme");
            } else {
              localStorage.setItem("dsaf-report-theme", target);
            }
          } catch (e) {}
          syncThemeBtn();
        });
        window.addEventListener("storage", function(e) {
          if (e.key !== null && e.key !== "dsaf-report-theme") return;
          var nextVal = e.key === null ? null : e.newValue;
          manualTheme = nextVal === "light" || nextVal === "dark" ? nextVal : null;
          meta.content = manualTheme || "light dark";
          syncThemeBtn();
        });
        if (typeof mq.addEventListener === "function") {
          mq.addEventListener("change", function() {
            var stored = null;
            var storageOk = false;
            try { stored = localStorage.getItem("dsaf-report-theme"); storageOk = true; } catch (e) {}
            if (storageOk) {
              manualTheme = stored === "light" || stored === "dark" ? stored : null;
            }
            meta.content = manualTheme === "light" || manualTheme === "dark" ? manualTheme : "light dark";
            syncThemeBtn();
          });
        }
      }

      var tablist = document.querySelector('[focusgroup^="tablist"]');
      if (tablist) {
        var tabs = Array.prototype.slice.call(tablist.querySelectorAll("button"));
        var panels = Array.prototype.slice.call(document.querySelectorAll('[role="tabpanel"]'));
        function selectTab(nextTab, shouldFocus) {
          for (var i = 0; i < tabs.length; i++) {
            var isSel = tabs[i] === nextTab;
            tabs[i].setAttribute("aria-selected", String(isSel));
            tabs[i].setAttribute("role", "tab");
            tabs[i].tabIndex = isSel ? 0 : -1;
            if (isSel) tabs[i].setAttribute("focusgroupstart", "");
            else tabs[i].removeAttribute("focusgroupstart");
          }
          for (var j = 0; j < panels.length; j++) {
            if (panels[j].getAttribute("aria-labelledby") === nextTab.id) {
              panels[j].removeAttribute("hidden");
            } else {
              panels[j].setAttribute("hidden", "until-found");
            }
          }
          if (shouldFocus) {
            nextTab.focus();
            var tablistEl = nextTab.parentElement;
            if (tablistEl && tablistEl.scrollWidth > tablistEl.clientWidth) {
              var tr = nextTab.getBoundingClientRect();
              var lr = tablistEl.getBoundingClientRect();
              var tPad = 8;
              if (tr.right > lr.right - tPad) tablistEl.scrollLeft += tr.right - (lr.right - tPad);
              else if (tr.left < lr.left + tPad) tablistEl.scrollLeft -= (lr.left + tPad) - tr.left;
            }
          }
        }
        tablist.addEventListener("focusin", function(ev) {
          var t = ev.target;
          if (!t || !t.closest) return;
          var tab = t.closest('[role="tab"]');
          if (!tab || tablist.scrollWidth <= tablist.clientWidth) return;
          var tr = tab.getBoundingClientRect();
          var lr = tablist.getBoundingClientRect();
          var tPad = 8;
          if (tr.right > lr.right - tPad) tablist.scrollLeft += tr.right - (lr.right - tPad);
          else if (tr.left < lr.left + tPad) tablist.scrollLeft -= (lr.left + tPad) - tr.left;
        });
        selectTab(tabs[0], false);
        for (var i = 0; i < tabs.length; i++) {
          (function(tab, idx) {
            tab.addEventListener("click", function() { selectTab(tab, false); });
            tab.addEventListener("keydown", function(e) {
              var next = -1;
              if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
              else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = tabs.length - 1;
              if (next !== -1) {
                e.preventDefault();
                selectTab(tabs[next], true);
              }
            });
          })(tabs[i], i);
        }
        for (var k = 0; k < panels.length; k++) {
          panels[k].addEventListener("beforematch", function(ev) {
            var id = ev.currentTarget.getAttribute("aria-labelledby");
            var owner = tabs.find(function(t) { return t.id === id; });
            if (owner) selectTab(owner, false);
          });
        }
      }
    })();
  </script>
</body>
</html>
`;
}

function runSelfTest() {
  const manyFindings = Array.from({ length: 65 }, (_, i) => ({
    ruleId: i === 0 ? "dsaf/no-outline-none-naked" : `dsaf/rule-${i}`,
    tier: i === 0 ? "floor" : "reflex",
    file: "src/btn.css",
    line: i + 1,
    message: i === 0 ? "Removed `outline: none` focus ring" : `Issue #${i}`,
    personaIds: ["P01"],
  }));
  const baseSummary = {
    schema: "dsaf-audit/1",
    engine_version: HTML_REPORT_VERSION,
    generated: "2026-11-27T00:00:00Z",
    target: "C:\\repos\\demo-shop",
    passed: false,
    ciGate: { floor: 1, reflex: 64, finish: 0, waived: 0, unusedIgnores: 0 },
    recon: { recommendedMode: "C", topologyLabel: "Product on DS", surfaceMode: "operate" },
    tokens: { filesScanned: { uiAndStyle: 12 }, dtcgTokenCount: 24, drift: { tokenCompliancePct: 92, hardcodedColorHits: 1 } },
    personas: {
      count: 1,
      items: [{ id: "P01", name: "Keyboard User <script>", axis: "Keyboard", viewport: "1280x800", source: "signal:baseline", impactedCount: 1, findingRules: ["dsaf/no-outline-none-naked"] }],
    },
    ciFindings: manyFindings,
  };
  const html = renderHtmlReport(baseSummary, { previewHref: "javascript:alert(1)" });
  assert.match(html, /<h1>demo-shop<\/h1>/, "Must extract Windows repo basename");
  assert.doesNotMatch(html, /javascript:alert/, "Must reject unsafe javascript: previewHref");
  assert.doesNotMatch(
    renderHtmlReport(baseSummary, { previewHref: "java\tscript:alert(1)" }),
    /Open Preview Shell/,
    "Must reject control-char javascript URL bypass"
  );
  assert.doesNotMatch(
    renderHtmlReport(baseSummary, { previewHref: "\\\\evil.com/phish" }),
    /Open Preview Shell/,
    "Must reject backslash protocol-relative URL bypass"
  );
  assert.doesNotMatch(
    renderHtmlReport(baseSummary, { previewHref: "\x01javascript:alert(1)" }),
    /Open Preview Shell/,
    "Must reject C0 prefix javascript URL bypass"
  );
  assert.doesNotMatch(html, /--accent-fg|btn-secondary/, "Must omit unused CSS vars/classes");
  assert.match(html, /<code>outline: none<\/code>/, "Must format backtick code spans");
  assert.match(html, /Showing 60 of 65 active findings/, "Must indicate >60 findings truncation");
  assert.match(html, /role="table"/, "Must preserve ARIA table roles for responsive cards");
  assert.match(html, /data-label="Signal"/, "Mobile cell label must match Signal header");
  assert.match(html, /DSAF Audit Report/);
  assert.match(html, /&lt;script&gt;/, "Must HTML-escape untrusted labels");
  assert.match(html, /dsaf\/no-outline-none-naked/);
  assert.match(html, /hidden="until-found"/);
  assert.doesNotMatch(html, /aria-controls=/, "Tabs must omit aria-controls per modern tabs guidance");
  assert.match(html, /clip-path:\s*inset\(50%\)/, "Skip link must hide via clip-path instead of off-screen left coordinate");
  assert.doesNotMatch(html, /left:\s*-9999px/, "Skip link must not trigger mobile clippedTargets via -9999px");

  const safeHtml = renderHtmlReport(baseSummary, { previewHref: "./preview-shell.html" });
  assert.match(safeHtml, /href="\.\/preview-shell\.html"/, "Relative previewHref must render");
  assert.match(safeHtml, /addEventListener\("storage"/, "Report must sync manual theme across tabs via storage listener");
  assert.match(safeHtml, /meta\.content = manualTheme === "light" \|\| manualTheme === "dark" \? manualTheme : "light dark"/, "Report matchMedia handler must apply stored manualTheme to meta.content");

  const scratch = mkdtempSync(join(tmpdir(), "dsaf-html-report-test-"));
  try {
    const inJson = join(scratch, "summary.json");
    const outHtml = join(scratch, "report.html");
    writeFileSync(inJson, JSON.stringify(baseSummary), "utf8");
    const rendered = renderHtmlReport(JSON.parse(readFileSync(inJson, "utf8")), { previewHref: "./preview-shell.html" });
    writeFileSync(outHtml, rendered, "utf8");
    assert.match(readFileSync(outHtml, "utf8"), /DSAF Audit Report/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Round 10 regressions (R10-A3-11): resilient null/malformed summary handling, NaN% guard, and ciGate ?? 0 defaults
  const nullHtml = renderHtmlReport(null);
  assert.match(nullHtml, /DSAF Audit Report/);
  const partialHtml = renderHtmlReport({
    target: "x",
    ciFindings: [null],
    ciGate: { floor: 1 },
    tokens: { drift: { tokenCompliancePct: Number.NaN } },
    personas: { items: [null, { id: "P01", name: "A", axis: "B", impactedCount: 1, findingRules: "dsaf/rule" }] },
  });
  assert.doesNotMatch(partialHtml, /NaN%/, "NaN tokenCompliancePct must fall back to N/A");
  assert.match(partialHtml, /<p class="stat-label">Reflex Warnings<\/p>\s*<p class="stat-val">0<\/p>/, "Missing ciGate.reflex must default to 0");
  assert.match(partialHtml, /\[role="tab"\]:focus-visible,\s*\.table-wrap:focus-visible\s*\{\s*outline-offset:\s*-2px;\s*\}/, "Tabs and scrollable table-wrap must inset focus ring so overflow containers never clip outline");
  assert.match(partialHtml, /\.table-wrap\s*\{[^}]*border-radius:\s*inherit;/, "table-wrap must inherit container radius");

  const htmlSelfPath = fileURLToPath(import.meta.url);
  assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--unknown-flag"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", "   ", "--out", "report.html"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", "summary.json", "--out", "   "], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", "nonexistent-r23.json", "--out", "report.html"], { encoding: "utf8" }).status, 2);

  // Round 25 & Round 28 regressions (A4-H1 live leaf symlink on --out, A4-L1 symlinked CLI entry, CWD-independent checks)
  const r25Scratch = mkdtempSync(join(tmpdir(), "dsaf-html-r25-"));
  try {
    const r25In = join(r25Scratch, "summary.json");
    const r25Secret = join(r25Scratch, "secret.html");
    const r25SymOut = join(r25Scratch, "out-sym.html");
    const r25CliSym = join(r25Scratch, "html-cli-sym.mjs");
    writeFileSync(r25In, JSON.stringify(baseSummary), "utf8");
    writeFileSync(r25Secret, "<!-- untouched -->");
    symlinkSync(r25Secret, r25SymOut);
    symlinkSync(htmlSelfPath, r25CliSym);
    assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", r25In, "--out", "report.html", "--preview-href", "   "], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", r25In, "--out", "report.html", "--title", "   "], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", r25In, "--out", r25Scratch], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [htmlSelfPath, "--input", r25In, "--out", r25SymOut], { encoding: "utf8" }).status, 2);
    assert.equal(readFileSync(r25Secret, "utf8"), "<!-- untouched -->");
    assert.equal(spawnSync(process.execPath, [r25CliSym, "--help"], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(r25Scratch, { recursive: true, force: true });
  }

  // Round 27 (A4-L1): empty/missing summary.generated must not render an empty .pill capsule
  const r27EmptyDateHtml = renderHtmlReport({});
  assert.ok(!r27EmptyDateHtml.includes('<span class="pill"></span>'), "Missing generated date must omit empty .pill capsule");

  console.log("HTML_REPORT_SELF_TEST_PASSED (offline editorial report + XSS escaping + accessible tabs/table)");
  return 0;
}

if (isDirectCliEntry(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        input: { type: "string" },
        out: { type: "string" },
        "preview-href": { type: "string" },
        title: { type: "string" },
        "self-test": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    if (values.help) {
      console.log("Usage: node skill/scripts/generate-html-report.mjs [--input summary.json --out report.html] [--preview-href ./preview-shell.html] [--title name] [--self-test] [--help]");
      process.exit(0);
    }
    if (values["self-test"]) {
      process.exit(runSelfTest());
    }
    if (!values.input || !values.input.trim() || !values.out || !values.out.trim()) {
      console.error("Error: non-empty --input <summary.json> and --out <report.html> are required unless --self-test is passed.");
      process.exit(2);
    }
    if (values["preview-href"] !== undefined && !values["preview-href"].trim()) {
      console.error("Error: --preview-href must be a non-empty URL or relative path.");
      process.exit(2);
    }
    if (values.title !== undefined && !values.title.trim()) {
      console.error("Error: --title must be a non-empty string.");
      process.exit(2);
    }
    const inPath = resolve(values.input);
    let inLst = null;
    try {
      inLst = lstatSync(inPath);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        console.error(`Error: Input file not found: ${inPath}`);
        process.exit(2);
      }
      throw err;
    }
    if (inLst.isSymbolicLink() && !existsSync(inPath)) {
      console.error(`Error: Input file is a broken symlink: ${inPath}`);
      process.exit(2);
    }
    if (!statSync(inPath).isFile()) {
      console.error(`Error: Input path is not a regular file: ${inPath}`);
      process.exit(2);
    }
    let outHtml;
    try {
      outHtml = assertWritableOutputFile(values.out, "--out");
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    const summaryData = JSON.parse(readFileSync(inPath, "utf8"));
    mkdirSync(dirname(outHtml), { recursive: true });
    writeFileSync(
      outHtml,
      renderHtmlReport(summaryData, { previewHref: values["preview-href"], title: values.title }),
      "utf8"
    );
    console.log(`DSAF_HTML_REPORT_WRITTEN: ${outHtml}`);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

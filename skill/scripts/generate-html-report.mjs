#!/usr/bin/env node
/**
 * DSAF v0.9.2 — Standalone Editorial HTML Audit Report Generator.
 * Produces a zero-dependency, offline-safe interactive HTML report containing
 * Scorecard Summary, Persona Impact Matrix, and Tokens/Drift inspection tabs.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const HTML_REPORT_VERSION = "0.9.2";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortRepoName(targetPath) {
  const clean = String(targetPath || ".").replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean || "workspace";
}

export function renderHtmlReport(summary, opts = {}) {
  const repoLabel = opts.title || shortRepoName(summary.target);
  const r = summary.recon || {};
  const t = summary.tokens || {};
  const d = t.drift || {};
  const cg = summary.ciGate || { floor: 0, reflex: 0, finish: 0, waived: 0, unusedIgnores: 0 };
  const findings = Array.isArray(summary.ciFindings) ? summary.ciFindings : [];
  const personas = Array.isArray(summary.personas?.items) ? summary.personas.items : [];
  const compliance = d.tokenCompliancePct ?? "N/A";
  const statusLabel = summary.passed ? "PASS" : "FAIL";
  const statusClass = summary.passed ? "pill--pass" : "pill--fail";
  const previewLink = opts.previewHref ? `<a class="btn btn-secondary" href="${esc(opts.previewHref)}">Open Preview Shell</a>` : "";

  const findingsRows =
    findings.length === 0
      ? `<tr><td colspan="4" class="muted-cell">No active Floor or Reflex defects detected.</td></tr>`
      : findings
          .slice(0, 60)
          .map((f) => {
            const pList = Array.isArray(f.personaIds) && f.personaIds.length > 0 ? f.personaIds.join(", ") : "All";
            const tierBadge =
              f.tier === "floor"
                ? `<span class="pill pill--fail">Floor</span>`
                : f.tier === "finish"
                ? `<span class="pill">Finish</span>`
                : `<span class="pill pill--warn">Reflex</span>`;
            const loc = `${esc(f.file || "")}${f.line ? `:${esc(f.line)}` : ""}`;
            return `<tr>
              <th scope="row" data-label="Rule"><code>${esc(f.ruleId || "dsaf/rule")}</code><div class="sub-line">${esc(f.message || "")}</div></th>
              <td data-label="Tier">${tierBadge}</td>
              <td data-label="Location"><code>${loc}</code></td>
              <td data-label="Personas"><span class="mono-text">${esc(pList)}</span></td>
            </tr>`;
          })
          .join("\n");

  const personaRows =
    personas.length === 0
      ? `<tr><td colspan="4" class="muted-cell">No persona matrix attached to this audit run.</td></tr>`
      : personas
          .map((p) => {
            const impactCount = Number(p.impactedCount || 0);
            const rulesList = (p.findingRules || []).slice(0, 3).map((x) => `<code>${esc(x)}</code>`).join(", ");
            const impactCell =
              impactCount > 0
                ? `<span class="pill pill--warn">${esc(impactCount)} ${impactCount === 1 ? "issue" : "issues"}</span>${rulesList ? `<div class="sub-line">${rulesList}</div>` : ""}`
                : `<span class="pill pill--pass">Clean</span>`;
            return `<tr>
              <th scope="row" data-label="Persona"><strong>${esc(p.id)}</strong> · ${esc(p.name)}<div class="sub-line">${esc(p.axis)}</div></th>
              <td data-label="Viewport">${esc(p.viewport || "Responsive")}</td>
              <td data-label="Source"><code>${esc(p.source || "signal")}</code></td>
              <td data-label="Impact">${impactCell}</td>
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
      --accent-fg: #FFFFFF;
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
        --accent-fg: #0B111B;
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
        --accent-fg: #0B111B;
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
      padding: 12px 0;
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
    h1 {
      margin: 0 0 6px;
      font-size: clamp(1.375rem, 1rem + 1.5vw, 2rem);
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .meta-line {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
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

  <main class="wrap">
    <section class="report-head">
      <div>
        <h1>${esc(repoLabel)}</h1>
        <p class="meta-line">Topology: <strong>Mode ${esc(r.recommendedMode || "P")}</strong> (${esc(r.topologyLabel || "Product")}) · Surface: <strong>${esc(r.surfaceMode || "operate")}</strong> · DSAF v${esc(summary.engine_version || HTML_REPORT_VERSION)}</p>
      </div>
      <span class="pill">${esc(String(summary.generated || "").slice(0, 10))}</span>
    </section>

    <section class="summary-strip" aria-label="Audit key counts">
      <div class="stat">
        <p class="stat-label">Floor Defects</p>
        <p class="stat-val">${esc(cg.floor)}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Reflex Warnings</p>
        <p class="stat-val">${esc(cg.reflex)}</p>
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
            <table>
              <thead>
                <tr>
                  <th>Rule &amp; Detail</th>
                  <th>Tier</th>
                  <th>Location</th>
                  <th>Personas Impacted</th>
                </tr>
              </thead>
              <tbody>
                ${findingsRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div role="tabpanel" aria-labelledby="tab-personas" hidden="until-found">
        <div class="panel-box">
          <div class="table-wrap" tabindex="0" role="region" aria-label="Persona impact matrix">
            <table>
              <thead>
                <tr>
                  <th>Persona &amp; Axis</th>
                  <th>Viewport</th>
                  <th>Signal</th>
                  <th>Impact</th>
                </tr>
              </thead>
              <tbody>
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
            <div class="metric-cell"><p class="metric-k">Waived / Unused Ignores</p><p class="metric-v">${esc(cg.waived)} / ${esc(cg.unusedIgnores)}</p></div>
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
          try {
            if (target === sys) {
              localStorage.removeItem("dsaf-report-theme");
              meta.content = "light dark";
            } else {
              localStorage.setItem("dsaf-report-theme", target);
              meta.content = target;
            }
          } catch (e) {
            meta.content = target;
          }
          syncThemeBtn();
        });
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
          if (shouldFocus) nextTab.focus();
        }
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
  const html = renderHtmlReport({
    schema: "dsaf-audit/1",
    engine_version: HTML_REPORT_VERSION,
    generated: "2026-11-27T00:00:00Z",
    target: "/tmp/demo-shop",
    passed: false,
    ciGate: { floor: 1, reflex: 1, finish: 0, waived: 0, unusedIgnores: 0 },
    recon: { recommendedMode: "C", topologyLabel: "Product on DS", surfaceMode: "operate" },
    tokens: { filesScanned: { uiAndStyle: 12 }, dtcgTokenCount: 24, drift: { tokenCompliancePct: 92, hardcodedColorHits: 1 } },
    personas: {
      count: 1,
      items: [{ id: "P01", name: "Keyboard User <script>", axis: "Keyboard", viewport: "1280x800", source: "signal:baseline", impactedCount: 1, findingRules: ["dsaf/no-outline-none-naked"] }],
    },
    ciFindings: [{ ruleId: "dsaf/no-outline-none-naked", tier: "floor", file: "src/btn.css", line: 3, message: "Removed focus", personaIds: ["P01"] }],
  });
  assert.match(html, /DSAF Audit Report/);
  assert.match(html, /&lt;script&gt;/, "Must HTML-escape untrusted labels");
  assert.match(html, /dsaf\/no-outline-none-naked/);
  assert.match(html, /hidden="until-found"/);
  assert.doesNotMatch(html, /aria-controls=/, "Tabs must omit aria-controls per modern tabs guidance");
  console.log("HTML_REPORT_SELF_TEST_PASSED (offline editorial report + XSS escaping + accessible tabs/table)");
  return 0;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname);
if (isEntry) {
  const { values } = parseArgs({
    options: {
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node skill/scripts/generate-html-report.mjs [--self-test]");
    process.exit(0);
  }
  if (values["self-test"]) {
    process.exit(runSelfTest());
  }
}

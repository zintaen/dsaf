# Release Notes

Concise version highlights for **DSAF (`@zintaen/dsaf`)**. Follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## v0.8.0 (2026-11-26) — Ink & Gold v3 Theme, Safe Floor Auto-Fix (`dsaf fix`) & Repo Auto-Evolve (`dsaf evolve`)

- **Ink & Gold v3 Aesthetic (`preview-shell.html`, `docs/`):** Rebuilt canonical `preview-shell.html`, `docs/index.html`, `docs/styles.css`, `docs/favicon.svg`, `docs/assets/og-card.png`, and `docs/assets/preview-shell-showcase.png` around an Ink & Gold v3 token hierarchy (`#F7F8FA`/`#0A111D`, `#14243D` Ink, `#F4BA17` Gold, 3-stop blue/teal/gold aurora wash, `Manrope` + `Be Vietnam Pro` + `JetBrains Mono`) passing WCAG 2.2 AA & APCA `Lc` (`0` hardcoded colors, `0` orphans, `0` `!important`).
- **Safe Floor Auto-Remediator (`dsaf fix`):** Previews (`--dry-run`) and applies (`--apply --backup`) deterministic Floor fixes for `transition: all`, `width: 100vw` / `w-[100vw]`, naked `outline: none`, and unmuted `<video autoplay>` while respecting `.dsaf/rules.json` `protectedFiles`.
- **Supervised Repo Evolution Runner (`dsaf evolve`):** Enforces `.dsaf/STOP` kill switches, `.dsaf/circuit-breaker.json` consecutive failure caps, bounded Floor remediations, and automatic `.dsaf/handoff.md` telemetry logs.
- **External DS Focus Awareness (`--ds-css`) & Noise Filtering:** `dsaf hook` discovers ancestor DS CSS packages (`node_modules/@*/design*/dist/*.css`, `--ds-css`) to honor parent `:focus-within` / `:has(...:focus-visible)` focus rings cleanly, while `recon`, `audit-tokens`, and `dsaf-hook` ignore `playwright-report/` and `test-results/`.
- **8-Tool Stdio MCP Server (`dsaf mcp`):** Added read-only `dsaf_fix_preview` and `dsaf_evolve_status` alongside existing audit tools.

## v0.7.0 (2026-11-26) — Preview Studio & Docs Redesign, Repo Auto-Evolve (`dsaf init`), Stdio MCP & 2-Vertex Diff

- **Studio & Docs Visual Redesign (`preview-shell.html`, `docs/`):** Rebuilt canonical `preview-shell.html` (100% offline, generic `--uxs-*` vars, zero external assets) and the GitHub Pages showcase (`docs/`) with Warm Alabaster, Deep Umber, and Ochre palettes, composite focus halos, realistic Before/Pragmatic/North-Star specimens, `1200x630` OG card, and passing 5–7 viewport Playwright + APCA checks (`axe=0`, `hardcodedColorHits=0`).
- **Universal Repo Auto-Evolution (`dsaf init`):** Bootstraps `.dsaf/` governance (`STRATEGY.md`, `rules.json`, `decision-queue.md`, `strategy-feedback.md`, `handoff.md`) with C1–C10 adversarial verifier rules, `.dsaf/STOP` kill-switch, circuit breakers, plus `--with-hook`, `--with-guardrails`, and `--with-workflow`.
- **Zero-Dep Stdio MCP Server (`dsaf mcp`):** Exposes 6 read-only audit tools (`dsaf_recon`, `dsaf_tokens`, `dsaf_doctor`, `dsaf_hook_check`, `dsaf_figma_diff`, `dsaf_audit`) over Content-Length and NDJSON JSON-RPC 2.0 framing.
- **2-Vertex `Defined <-> Shipped` & Pixel Diff Gate:** Extends `dsaf figma-diff --tokens ... --runtime ...` to verify CSS/DTCG definitions directly against live computed browser variables without requiring Figma, and adds zero-dep PNG pixel-diff gating (`--screenshot-diff` / `--diff-threshold`) to `dsaf runtime`.
- **Precision Refinements & CI Action Smoke:** Separates TSX `<svg>` icons and swatch tables (`svgPaletteHits` / `swatchPaletteHits`) in `dsaf tokens`, enforces per-branch focus fallback across comma-separated selectors in `dsaf hook`, and adds an `action-smoke` job to `.github/workflows/ci.yml`.

## v0.6.0 (2026-11-26) — Zero-Clone Skill Install, GitHub Action & Field-Hardened Probes

- **Zero-Clone Agent Skill Installer (`dsaf install-skill`):** Installs ONLY Tier 1 production skill files directly from npm/npx into Claude Code, Cursor, Codex, Antigravity, or `.agents` (`--agent`, `--scope user|project`, `--dir`, `--dry-run`).
- **Official GitHub Action (`action.yml`):** Runs `dsaf audit`, optional `dsaf doctor`, uploads **SARIF 2.1.0**, posts sticky PR scorecards (`<!-- dsaf-audit-comment -->`), enforces Floor gates, and upgrades all CI workflows to Node 24-native action tags (`checkout@v7`, `setup-node@v7`, `upload-sarif@v4`).
- **GitHub Pages Live Interactive Demo & Social Metadata (`docs/`):** Publishes live interactive Preview Shell demo (`docs/demo/preview-shell.html`), capability comparison table, favicon, `sitemap.xml`, and generated `1200x630` `og-card.png`.
- **Field-Hardened Probes (`dsaf-evolve` Cycle):**
  - Broadened cookie/consent hiding (`[aria-label*="cookie"]`, `[data-testid*="cookie"]`, `[class*="consent"]`), bounded `domcontentloaded` + `networkidle` fallback navigation, and in-viewport horizontal scroller exemptions for `clippedTargets`.
  - Unified built/verification/mobile bundle exclusions (`_audit/`, `storybook-static/`, `src-tauri/`, `ios/App/App/public/`) across `recon`, `audit-tokens`, `dsaf-hook`, and `doctor` (eliminating DTCG duplicate counts and stale bundle hits).
  - Refined `dsaf/no-outline-none-naked` to respect skip-link focus destinations, sibling `:focus-visible`, and parent `:focus-within` composite widgets, while integrating `dsaf-hook` Floor rules into `dsaf audit` and `--json` into `dsaf figma-diff`.
  - Upgraded `recon.mjs` `detectSurfaceMode` (desktop/mobile shell + interactive component detection -> `operate`, `Mode S` libraries -> `read`) and `t2MockRequired` cloud BaaS SDK detection.

## v0.5.0 (2026-11-26) — Surface Modes, Runtime Hardening, Doctor & GitHub Pages

- **Surface Mode Auto-Detection & No-Slop Guard:** `dsaf recon` classifies `Persuade` / `Operate` / `Read` / `Experience` surfaces so audits adapt to dashboards vs docs vs marketing; `Mode P` skips gratuitous redesigns on already-clean UIs and follows the 9-pass causal redline order.
- **Runtime Edge Hardening (`dsaf runtime`):** Adds `--cdp <port>` attachment (Electron / WebView2 / authenticated Chrome), consent banner hiding, `coveredText` occlusion checks, RTL script/`dir="rtl"`/Arabic tracking checks, and `--extended-viewports` (`320px` + `1920px`).
- **6-Point Read-Only Diagnostic (`dsaf doctor`):** Verifies CLI/guardrail parity, token freshness, edit-time hook setup, CI gate presence, Playwright/axe availability, and stale `dsaf-ignore` waivers.
- **Promotional GitHub Pages Site (`docs/`):** Added accessible Light/Dark documentation & live inspector site with full CI dogfooding (`tokens`, `hook`, `runtime`).

## v0.4.0 (2026-11-26) — CI Native Gates, Edit-Time Hooks & Controlled Waivers

- **SARIF 2.1.0 & GitHub Annotations (`--sarif`, `--github`):** `dsaf tokens`, `dsaf audit`, and `dsaf hook` now emit native SARIF 2.1.0 reports and PR-inline GitHub Actions annotations.
- **Edit-Time Agent Hook (`dsaf hook`):** Runs a fast Floor/Reflex check on UI file edits via Claude Code, Cursor, or Codex `PostToolUse` hooks (`dsaf hook install`).
- **3-Tier Gate & Waiver Engine (`Floor` · `Reflex` · `Finish`):** Floor rules cannot be suppressed; Reflex rules accept concrete `/* dsaf-ignore <rule> -- <reason> */` waivers; `--report-unused-ignores` flags stale waivers.
- **Anti-Anchoring Review Provenance:** `compute-scorecard.mjs` records `dual-agent` vs `⚠️ DEGRADED: single-context` provenance and rejects Floor/boilerplate waivers.

## v0.3.0 (2026-11-26) — One-Click Pipeline & Live Vertex 3

- **Unified `dsaf audit` Pipeline:** Chains read-only `recon`, `tokens`, multi-route `runtime`, 3-vertex `figma-diff`, and `audit-diff` into `audit-summary.json` and Markdown.
- **Live Vertex 3 (`Shipped`) Triangulation:** Captures live `:root` `computedVars`, multi-route `--routes`, and multi-stack Light↔Dark mode checks against Figma variables.
- **Monorepo & Touch Precision:** Skips prototype `demo/` trees by default (`--include-demos` opt-in), separates semantic orphans from palette scales, and flags overlapping small mobile tap targets.

## v0.2.2 (2026-11-26) — Zero-`NODE_PATH` Discovery & Trusted Publishing

- **npm Scope & OIDC Publishing:** Published as `@zintaen/dsaf` with provenance via GitHub Actions OIDC on `v*` tags.
- **Auto Runtime Discovery:** Automatically resolves `playwright` and `axe-core` from target/ancestor `node_modules` without `NODE_PATH`.
- **Cleaner Codebase Noise Filtering:** Excludes test/fixture trees and server-side `ImageResponse` OG image generators from token drift counts.

## v0.2.1 (2026-11-26) — Real-World Figma & Guardrail Separation

- **SVG / Swatch Separation (`+SG`):** Guardrail scanner separates CSS/inline-style hexes and Tailwind arbitrary utilities from declarative `<svg>` colors and swatch constants.
- **Code Connect v2 & CSS Alias Triangulation:** Resolves CSS `var()` aliases, dark blocks, `--prefix` auto-stripping, and batch Code Connect files.

## v0.2.0 (2026-11-26) — Automated Figma Diff & Static Storybook

- **Automated 3-Vertex `dsaf figma-diff`:** Compares Figma variables & Code Connect against DTCG/CSS tokens and runtime summaries.
- **Local Static Storybook & Defect Fixtures:** Supports `--storybook <index.json>` locally alongside CI verification fixtures.

## v0.1.1 (2026-11-26) — Accurate Topology & Tailwind v4 `@theme`

- **Auth/Bundle Filtering:** Stops auth token routes, hidden agent folders, and mobile WebView bundles from skewing `Mode C` detection.
- **Tailwind v4 `@theme` Resolution:** Tracks `@theme inline` utility consumption and JS `getPropertyValue` references accurately.

## v0.1.0 (2026-11-26) — Single-Entry CLI & Executable Guardrails

- **Unified `dsaf` CLI (`bin/dsaf.mjs`):** Exposed all core workflows under one command.
- **Executable Guardrails & Keyboard Audit:** Added `+SG` (`check-design-discipline.mjs`, CI workflow, `AGENTS` rules), `keyboardMap`, APCA/WCAG DTCG pairs, and `--screenshot --pins`.

## v0.0.1 (2026-11-26) — Initial Clean-Room Framework

- Launched 3 auto-detected modes (`Mode S` System Core, `Mode C` Conformance & Drift, `Mode P` Product UX/UI), Step 0 Clarification Gate, Canonical Dual-Track Preview Shell, zero-dep Node ESM toolchain, and isolated `evolve/` closed-loop evolution.

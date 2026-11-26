# Changelog

All notable changes to **DSAF (Design System Audit Framework)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-26

### Changed
- **Guardrails Generator Style/SVG/Swatch Separation (`skill/scripts/generate-guardrails.mjs`, `FB-20261126-006`, `FB-20261126-009`):** Emitted `check-design-discipline.mjs` now extracts CSS, `<style>`, CSS-in-JS, and balanced inline `style` props (`styleColors`) + strict Tailwind arbitrary brackets (`twArbitrary`) separately from declarative `<svg>` / SVG presentation attributes (`svgColors`) and quoted swatch arrays (`swatchColors`), uses brace-depth token block stripping and valid 3/4/6/8-digit CSS hex matching, supports both directory and single-file scan targets (`statSync`), skips hidden/test/fixture paths, exposes optional `DSAF_MAX_TW_ARBITRARY`, `DSAF_MAX_SVG_COLORS`, and `DSAF_MAX_SWATCH_COLORS` caps, and aligns all `+SG` version banners to `v0.2.1`.
- **Real-World 3-Vertex Figma Triangulation Upgrades (`skill/scripts/audit-figma-diff.mjs`):** Added CSS `var(--*)` alias resolution, `@media (prefers-color-scheme: dark)` / dark-block preservation, `@collection` / `*_primitives` normalization, optional `--prefix` + auto-detected CSS token prefix stripping, `px`↔`rem` & font-stack/weight equivalence (`valuesMatch`), self-file exclusion when scanning repository directories, and Code Connect v2 template (`export default { id }`, `// component=`) + `*.figma.batch.json` discovery. Verified on open-source Figma Simple Design System (`98.8%` coverage `333/337`, `0` false drift, `97` Code Connect files / `358` mapped components).
- **Package & Documentation Sync (`v0.2.1`):** Synchronized `package.json` (`0.2.1`, deduplicated `keywords`), CLI/skill version parity, `README.md`, and Mode S/C/P playbooks.

## [0.2.0] - 2026-11-26

### Added
- **Automated 3-Vertex Figma Triangulation CLI (`skill/scripts/audit-figma-diff.mjs`, `dsaf figma-diff`):** Compares Figma variables (`Designed`) and optional Code Connect (`*.figma.{ts,tsx,js,jsx}`) files against W3C DTCG / CSS tokens (`Defined`) and runtime summaries (`Shipped`), reporting match coverage %, value drift, design-only / code-only tokens, and mapped components.
- **Local Static Storybook & Reduced-Motion Verification:** `audit-runtime.mjs --storybook <index.json>` now resolves sibling local `iframe.html?id=...` URLs cleanly over `file://`; added synthetic `storybook-static/` (`button--primary`, `input--default`) and negative `mode-p-defects/` test fixtures under `evolve/fixtures/synthetic/`.
- **Expanded 6-Scenario Calibration Corpus (`evolve/fixtures/calibration/`):** Added `mode-p-app-mature.scores.json`, `mode-c-tailwind.scores.json`, and `mode-p-usability.scores.json` alongside updated `mode-s-ds`, `mode-c-app`, and `mode-p-app` baselines (`engine_version: "0.2.0"`).
- **npm Distribution Readiness & Extended CI:** Configured `"files"` whitelist (`bin/`, `skill/`, `README.md`, `CHANGELOG.md`, `LICENSE` — excluding `evolve/`), package keywords/metadata, `npm pack --dry-run` check, Storybook static pass, and negative defect-fixture failure assertion in `.github/workflows/ci.yml`.

### Changed
- **Documentation & Spec Sync (`v0.2.0`):** Updated `README.md` with GitHub Actions/Release/License/Node badges, `dsaf figma-diff` CLI docs, local Storybook verification usage, and `npx dsaf` instructions; wired `audit-figma-diff.mjs` into `skill/SKILL.md`, `mode-conformance.md`, and `mode-system.md`.

## [0.1.1] - 2026-11-26

### Fixed
- **Eliminated Auth/Route Token Misclassification (`recon.mjs`):** Excluded test, dynamic-route (`[token]/route.ts`), auth/OAuth/session/snooze token filenames, hidden agent/worktree directories (`.worktrees`, `.claude`, `.agents`, etc. except `.storybook`), and Capacitor/Cordova mobile WebView bundles (`ios/App/App/public`, `android/app/src/main/assets/public`) from triggering false `Mode C` topology signals.
- **Reduced `@theme` & Mobile Bundle Orphan False Positives (`audit-tokens.mjs`):** Added Tailwind v4 `@theme inline` utility class consumption detection (`--color-*`, `--spacing-*`, `--radius-*`, `--font-*`, `--shadow-*`, `--text-*`), JS `getPropertyValue` / `setProperty` references, hidden-dir skipping, and mobile WebView built bundle exclusions.
- **Version-Agnostic Preview Shell (`preview-shell.html`):** Removed stale `v0.0.1` title/header text and re-rendered `docs/assets/preview-shell-showcase.png`.
- **Stale Flag & Version Sync:** Removed nonexistent `--lang` flag from `skill/references/mode-system.md` and synchronized all script headers, docs, and `audit-diff.mjs` version parity checks.

## [0.1.0] - 2026-11-26

### Added
- **Single-Entry CLI (`bin/dsaf.mjs`):** Exposes `dsaf <recon|tokens|runtime|scorecard|diff|guardrails|integrity|verify|mine|sync|version|help>` via `"bin": { "dsaf": "./bin/dsaf.mjs" }` in `package.json`.
- **Runnable Guardrails Generator (`skill/scripts/generate-guardrails.mjs`):** Implements `+SG` output generation (`check-design-discipline.mjs`, `dsaf-regression-gate.yml`, and `AGENTS-dsaf-rules.md`) with zero external runtime dependencies and self-tests.
- **Runtime Keyboard & Showcase Tooling (`skill/scripts/audit-runtime.mjs`):** Adds `keyboardMap` (`tabbableCount`, `tabindex > 0`, unnamed interactive control summary), `--storybook` `prefers-reduced-motion: reduce` checks, and `--screenshot <png> [--pins]` visual capture.
- **DTCG Modes & Tailwind Drift Metrics (`skill/scripts/audit-tokens.mjs`):** Adds Light/Dark DTCG mode parity, token-pair WCAG 2.2 AA & APCA-W3 `Lc` contrast checking, and Tailwind arbitrary color/spacing & primitive palette metrics.
- **Playwright CI & Calibration Corpus:** Added headless Chromium CI verification, calibration `.scores.json` baselines in `evolve/fixtures/calibration/`, weekly evolution miner workflow (`evolve-calibration.yml`), canonical preview showcase screenshot, and sample Mode C report (`examples/sample-mode-c-report.md`).
- **Explicit 3-Vertex Figma MCP / Code Connect SOP (`skill/references/mode-conformance.md`):** Formalizes Designed <-> Defined <-> Shipped triangulation and honest fallback degradation when Figma inputs are absent.

### Changed
- **Reduced Real-World False Positives (`recon.mjs`, `audit-tokens.mjs`):**
  - Tightened `Mode C` detection so local CSS custom properties without DS packages, token files, or `@theme` do not misclassify standalone apps (`Mode P`).
  - Excluded framework internal CSS variables (`--tw-*`, `--radix-*`, etc.), minified assets, and non-spacing `px` literals (`max-width`, `font-size`) from orphan and `offGridSpacingHits` counts.
- Upgraded `validate-isolation.mjs` with dynamic version parity (`package.json`, `SKILL.md`, `evolve/SKILL.md`, `compute-scorecard.mjs`), CLI binary check, and host `/Users/` / `file:///` leak guards.

### Fixed
- Replaced an accidental local filesystem link in `README.md` with a relative repository link.

## [0.0.1] - 2026-11-26

### Added
- **Unified 3-Mode Agent Skill (`skill/`, command `/dsaf`):**
  - `Mode S` (**System Core**): Design system library evaluation (`DS01-DS12` mapped to 25 core DSAF anchors, W3C DTCG validation, Storybook live probing, 3-band anti-prose-inflation cap `prose <= 40%`, `L0-L5` maturity ladder, `SCAN -> Owner Gate -> FIX -> VERIFY -> audit-diff`).
  - `Mode C` (**Product Conformance & Drift**): Live product UX/UI audit paired with design-system conformance, token drift scanning, override density, N-of-1 component clustering, and optional design-to-code triangulation.
  - `Mode P` (**Product UX/UI Without a DS**): Full 5-axis multi-persona cognitive walkthroughs (`U01-U18`), 11-criterion Visual UI audit (`V01-V11`), anti-"AI slop" craft checks, Dual-Track `Pragmatic` vs `North-Star` interactive HTML preview drafts, optional Starter Design System Spec + starter DTCG tokens, and executable CI/lint guardrails.
- **Mandatory Step 0 Fast Recon & Clarification Gate (`skill/references/step0-intake.md`):**
  - Runs 30-second Tier 0 read-only reconnaissance (`recon.mjs`) first, then pauses cleanly to confirm target mode, scope, viewports, 4-Tier Data Mutation safety (including `T2-Mock` remote-cloud isolation), ambition level, and regression gating — strictly mirroring the user's conversation language.
- **100% Node ESM Zero-Dep Verification Toolchain (`skill/scripts/`):**
  - `recon.mjs` — Fast topology/stack/environment/cloud-persistence detector.
  - `audit-tokens.mjs` — W3C DTCG `$value`/`$ref` validator + CSS/UI hardcoded drift, near-duplicate hex clustering, `!important`, and orphan variable scanner.
  - `audit-runtime.mjs` — Chromium/Playwright runtime verifier with Shell Contract, canvas-rasterized `oklch`/`lab`/`oklab`/`light-dark`, `pixelBehind` probing, real APCA-W3 `0.1.9` (`Lc`), N-of-1 component clustering, Storybook/live URL probing + Core Web Vitals (`LCP`/`CLS`), `axe-core`, and Kept Wiring inventory diff.
  - `compute-scorecard.mjs` — Deterministic weighted scorecard (`dsaf-scores/2`) for `usability`, `visual`, and `system` audits with Hard Floor and 3-band prose caps.
  - `audit-diff.mjs` — Mechanical no-silent-regression gate with `FIXED`/`DYNAMIC` cause tagging.
  - `check-integrity.mjs` — Link, isolation, metadata, and self-test suite.
- **Isolated Tier 2 Closed-Loop Evolution (`evolve/`, command `/dsaf-evolve`):**
  - Combines anonymous field retro capture (`retro-capture.md` -> `~/.dsaf/feedback-log.jsonl`) with calibration corpus mining (`mine-signals.mjs`), blind Evaluator/Grader A/B gates (`G1-G8`, `T1-T10`, `VG1-VG9`, `V3-1..6`, `DS-1..5`), isolation enforcement (`validate-isolation.mjs`), and local IDE skill sync (`sync-skills.mjs`).

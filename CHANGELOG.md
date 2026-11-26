# Changelog

All notable changes to **DSAF (Design System Audit Framework)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

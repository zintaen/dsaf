# DSAF Evolution Benchmark & Verification Ledger (`v0.1.0`)

Strictly internal to `evolve/`. Never reference or copy this ledger into `skill/`.

---

## 1. Benchmark Architecture Overview

Every candidate change to `skill/` is evaluated against hard gates (`G1–G8`, `T1–T10`, `VG1–VG9`, `V3-1..V3-6`, `DS-1..DS-5`) across synthetic fixtures (`evolve/fixtures/synthetic/{mode-s-ds,mode-c-app,mode-p-app}`), calibration scorecards (`evolve/fixtures/calibration/*.scores.json`), and real-world read-only smoke targets.

---

## 2. Empirical Baseline Ledger

| Version | Date | Trigger / Hypothesis | Static Isolation & Self-Tests | Live Runtime / Smoke Coverage | Calibration & CI Status | Decision |
|---|---|---|---|---|---|---|
| `0.0.1` | 2026-11-26 | Clean-room unified DSAF architecture (`Mode S/C/P`, Step 0 Clarification Gate, 100% Node ESM scripts, APCA-W3 `0.1.9`, DTCG + CSS drift, `N-of-1` clustering, 3-band prose cap, `audit-diff`, Tier 2 evolution) | `npm test` (`check-integrity.mjs` + `validate-isolation.mjs` + 6 CLI `--self-test`s + 3 sample JSONL records) PASSED; 0 private/org leaks | `audit-runtime.mjs` + `axe-core` PASS on `preview-shell.html` (15.72:1 `pixelBehind`, `Lc=-99`) & synthetic `mode-p-app` (`btnSigs=2`, `17.06:1`, `axe=0`); read-only `recon.mjs` accurately separated real `Mode S`, real `Mode C` + `T2-Mock`, and synthetic `S/C/P`; `audit-tokens.mjs` measured `compliance=40%`, `orphans=2`, `!important=1`, `nearDupHexClusters=1` on synthetic `mode-c-app` | Blind subagent (`b130fa9b`) given ONLY `skill/`: ran read-only recon, classified `Mode C`, PAUSED at Step 0 in natural Vietnamese with 6-parameter Clarification Brief (`T0` safe default, zero `audit-output/` or `draft/` writes) | **Promoted `v0.0.1`** |
| `0.1.0` | 2026-11-26 | Field retro signals `FB-20261126-001..003`: unified `bin/dsaf.mjs` CLI, tightened `recon.mjs` `Mode C` local-CSS guard, property-scoped `offGridPx` + framework var orphan exclusion + Tailwind arbitrary/primitive metrics + DTCG mode parity/contrast in `audit-tokens.mjs`, `keyboardMap` + `--storybook` reduced-motion + `--screenshot --pins` in `audit-runtime.mjs`, `+SG` generator (`generate-guardrails.mjs`), explicit 3-vertex Figma MCP SOP | `npm test` (`check-integrity.mjs` + `validate-isolation.mjs` + 7 deterministic `--self-test`s + `bin/dsaf.mjs version` + version parity + host/path leak guard) PASSED; 0 private/org leaks | Chromium `audit-runtime.mjs` + `axe-core` PASS on `preview-shell.html` (`15.72:1` `pixelBehind`, `tab=13/15 (+0/un=0)`, `axe=0`, `docs/assets/preview-shell-showcase.png`) & `mode-p-app` (`17.06:1`, `tab=2`, `btnSigs=2`, `axe=0`); field re-check cut `offGridPx` false positives (`4564->2259` and `596->214`) & surfaced `twArbColor=12` / `twPrim=1565` | Calibration corpus (`mode-s-ds`, `mode-c-app` `47.50->74.17->100.00`, `mode-p-app`) mined cleanly; GitHub Actions upgraded to Node `[22, 24]` + Chromium `runtime-playwright` + weekly `evolve-calibration.yml` | **Promoted `v0.1.0`** |

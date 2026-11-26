# DSAF Evolution Benchmark & Verification Ledger (`v0.0.1`)

Strictly internal to `evolve/`. Never reference or copy this ledger into `skill/`.

---

## 1. Benchmark Architecture Overview

Every candidate change to `skill/` is evaluated against hard gates (`G1–G8`, `T1–T10`, `VG1–VG9`, `V3-1..V3-6`, `DS-1..DS-5`) across synthetic fixtures (`evolve/fixtures/synthetic/{mode-s-ds,mode-c-app,mode-p-app}`) and real-world read-only smoke targets.

---

## 2. Empirical Baseline Ledger

| Version | Date | Trigger / Hypothesis | Static Isolation & Self-Tests | Live Runtime / Smoke Coverage | Blind Gate Result | Decision |
|---|---|---|---|---|---|---|---|
| `0.0.1` | 2026-11-26 | Clean-room unified DSAF architecture (`Mode S/C/P`, Step 0 Clarification Gate, 100% Node ESM scripts, APCA-W3 `0.1.9`, DTCG + CSS drift, `N-of-1` clustering, 3-band prose cap, `audit-diff`, Tier 2 evolution) | `npm test` (`check-integrity.mjs` + `validate-isolation.mjs` + 6 CLI `--self-test`s + 3 sample JSONL records) PASSED; 0 private/org leaks | `audit-runtime.mjs` + `axe-core` PASS on `preview-shell.html` (15.72:1 `pixelBehind`, `Lc=-99`) & synthetic `mode-p-app` (`btnSigs=2`, `17.06:1`, `axe=0`); read-only `recon.mjs` accurately separated real `Mode S`, real `Mode C` + `T2-Mock`, and synthetic `S/C/P`; `audit-tokens.mjs` measured `compliance=40%`, `orphans=2`, `!important=1`, `nearDupHexClusters=1` on synthetic `mode-c-app` | Blind subagent (`b130fa9b`) given ONLY `skill/`: ran read-only recon, classified `Mode C`, PAUSED at Step 0 in natural Vietnamese with 6-parameter Clarification Brief (`T0` safe default, zero `audit-output/` or `draft/` writes) | **Promoted `v0.0.1`** |

# DSAF — Design System & UX/UI Audit Framework (`v0.0.1`)

**DSAF** is a single, agent-native, clean-room audit framework that evaluates both **established design systems** and **live software products that do not yet have a design system** — pairing AI coding agents with deterministic Node ESM measurement scripts rather than static prose guesswork.

Written in international English as the canonical specification; the agent automatically mirrors the user's conversation language (for example Vietnamese or English) across Step 0 clarification briefs, reports, and drafts.

---

## One Framework, Three Auto-Detected Topologies

| Topology Mode | Target | Core Rubric & Toolchain | Primary Deliverables |
|---|---|---|---|
| **`Mode S` — System Core** | Existing design system repository, Storybook, or token package | `DS01–DS12` (`25` core DSAF anchors), `audit-tokens.mjs` (W3C DTCG), `audit-runtime.mjs --storybook`, `L0–L5` maturity ladder with 3-band anti-prose cap (`prose <= 40%`) | 5-file audit dossier or `ANALYZED_DESIGN_REPORT.md`, `scores.json` (`dsaf-scores/2`), `audit-diff` regression baseline, `SCAN → Review → FIX` backlog |
| **`Mode C` — Conformance & Drift** | Product consuming a design system or token package | Usability `U01–U18` + Visual `V01–V11` + Conformance `DS07–DS09`, token compliance %, hardcoded drift, `!important` overrides, live DOM `N-of-1` clustering | Multi-file audit dossier, Before/After Dual-Track `draft/*.html`, Drift & `N-of-1` remediation plan, executable lint/CI guardrails |
| **`Mode P` — Product UX/UI (No DS)** | Live web app, mobile web, or prototype with no formal DS | Usability `U01–U18` (`5-axis` personas, 7-state edge matrix, 4 Data Mutation Tiers) + Visual `V01–V11` (WCAG 2.2 AA, APCA `Lc`, anti-"AI slop") | Multi-file dossier, Dual-Track `Pragmatic` vs `North-Star` `draft/*.html`, optional **Starter Design System Spec** + starter DTCG tokens + CI guardrails |

---

## Quick Start

### 1. Verify the Framework (`Node >= 20`, zero required npm install)

```bash
git clone https://github.com/zintaen/dsaf.git
cd dsaf
npm test
```

*(Install Playwright in your target project or globally only if you want `audit-runtime.mjs` to drive headless Chromium for live browser / `draft/*.html` verification; all static scripts, token/drift scanners, scorecard validators, diff gates, and pure-JS self-tests run with zero external dependencies.)*

### 2. Install `dsaf` (and Optional Maintainer `dsaf-evolve`) into AI Coding Agents

```bash
npm run sync:skills
```

Or copy [skill/](file:///Users/stephencheng/Projects/Personal/dsaf/skill) manually into your agent's skill directory (`~/.gemini/config/skills/dsaf`, `~/.agents/skills/dsaf`, `~/.claude/skills/dsaf`, or `~/.codex/skills/dsaf`). Never copy `evolve/` into user-facing production skills unless you are maintaining DSAF itself.

### 3. Invoke the Skill

```text
/dsaf https://your-app.example.com
/dsaf ./path/to/your-repo
/dsaf conformance ./apps/web
/dsaf system ./packages/design-system
/dsaf product --auto ./apps/web
/dsaf retro
```

Always start at **Step 0**: the agent runs a fast ~30-second Tier 0 read-only `recon.mjs` inspection first, then pauses ONCE with a compact Clarification Brief (`Mode · Scope · Viewports · Data Tier · Ambition · Depth/Regression`) showing concrete options, trade-offs, and evidence-backed recommendations in your language before editing anything or touching live state. Passing `--auto` without explicitly confirming a data tier strictly locks execution to **Tier 0 Read-Only** — even on `localhost`.

---

## Deterministic Node ESM Toolchain

| Command / Script | Purpose | Zero-Dep Core |
|---|---|---|
| `npm run recon -- <target>` (`skill/scripts/recon.mjs`) | 30s read-only scan detecting stack, routes, Storybook, DTCG tokens, Figma Code Connect, cloud DB risk (`T2-Mock`), and recommended Mode `S/C/P` | Yes |
| `npm run audit:tokens -- <dir-or-json>` (`skill/scripts/audit-tokens.mjs`) | Validates W3C DTCG tokens (`$value`, `$type`, `{alias}`, `$ref`, cycles) and measures CSS/UI token compliance %, hardcoded color drift, near-duplicate hex clusters, `!important`, and orphan tokens | Yes |
| `npm run audit:runtime -- <draft-or-url>` (`skill/scripts/audit-runtime.mjs`) | Verifies Canonical Preview Shell (`preview-shell.html`), canvas-rasterized `oklch`/`lab`/`light-dark`, `pixelBehind` contrast, real APCA-W3 `Lc`, WCAG `3.00:1` UI borders, `>= 44.0px` mobile tap targets, `N-of-1` component signature clustering, `LCP`/`CLS`, `axe-core`, and Kept Wiring diff | Pure-JS self-tests yes; live checks require Playwright |
| `npm run scorecard -- --input <file>` (`skill/scripts/compute-scorecard.mjs`) | Deterministic validator & calculator (`dsaf-scores/2`) supporting `usability`, `visual`, and `system` rubrics, domain weight presets, Hard Floor caps, 3-band prose cap (`<= 40%`), and exact Before vs Track A vs Track B point deltas | Yes |
| `npm run audit:diff -- --baseline <a> --current <b>` (`skill/scripts/audit-diff.mjs`) | Enforces **No-Silent-Regression** (`D-RT`, `OVRD-*`, `UNRESOLVED`); exits `1` on unapproved score drops | Yes |
| `npm test` (`check-integrity.mjs` + `validate-isolation.mjs`) | Verifies markdown links, zero `evolve/` or private leaks inside `skill/`, Canonical Shell contract, schema validation, and all script self-tests | Yes |

---

## Closed-Loop Evolution (`evolve/`)

DSAF separates **production auditing (`skill/`)** from **framework self-evolution (`evolve/`, `/dsaf-evolve`)** so live audits never leak benchmark ground truth or mutate specs mid-run:

1. **Field Retro (`retro`):** Logs strictly anonymized, domain-stripped friction signals (`false_positive`, `false_negative`, `ds_drift_signal`, `ambition_gap`, etc.) into `~/.dsaf/feedback-log.jsonl`.
2. **Corpus & Signal Mining (`npm run evolve:mine`):** Clusters field retro signals alongside dead/saturated criteria and artifact probe gaps mined from calibration `scores.json` runs.
3. **One Atomic Hypothesis + Blind A/B Gates:** Every rule change goes through blind Evaluator subagents and independent Graders against hard guardrails (`G1–G8`, `T1–T10`, `VG1–VG9`, `V3-1..6`, `DS-1..5`) before human promotion and `npm run sync:skills`.

---

## Repository Layout

```text
dsaf/
├── skill/                  # Portable Tier 1 production agent skill (no evolve/ files)
│   ├── SKILL.md
│   ├── references/         # Progressive-loaded SOPs (Step 0, Modes S/C/P, Shell, Retro)
│   ├── resources/          # Canonical Before/Track A/Track B preview shell HTML
│   └── scripts/            # 6 deterministic Node ESM CLI tools & self-tests
├── evolve/                 # Tier 2 maintainer-only closed-loop evolution workspace
│   ├── SKILL.md
│   ├── references/         # Evolution gates, blind eval SOP, feedback JSON Schema
│   ├── fixtures/           # Synthetic Mode S / C / P test targets & sample feedback
│   ├── benchmark.md        # Empirical verification & A/B evolution log
│   └── scripts/            # Signal miner, isolation gate, local skill installer
├── package.json
├── CHANGELOG.md
├── LICENSE
└── README.md
```

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Stephen Cheng.

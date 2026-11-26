# DSAF — Design System & UX/UI Audit Framework (`v0.9.0`)

[![Website](https://img.shields.io/badge/site-zintaen.github.io%2Fdsaf-1d4ed8)](https://zintaen.github.io/dsaf/)
[![CI](https://github.com/zintaen/dsaf/actions/workflows/ci.yml/badge.svg)](https://github.com/zintaen/dsaf/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@zintaen/dsaf)](https://www.npmjs.com/package/@zintaen/dsaf)
[![Release](https://img.shields.io/github/v/release/zintaen/dsaf)](https://github.com/zintaen/dsaf/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**Documentation & Live Showcase:** [https://zintaen.github.io/dsaf/](https://zintaen.github.io/dsaf/) · **Interactive Preview Shell Demo:** [Live Comparison Shell](https://zintaen.github.io/dsaf/demo/preview-shell.html)

**DSAF** is a single, agent-native, clean-room audit framework that evaluates both **established design systems** and **live software products that do not yet have a design system** — pairing AI coding agents with deterministic Node ESM measurement scripts rather than static prose guesswork.

Written in international English as the canonical specification; the agent automatically mirrors the user's conversation language (for example Vietnamese or English) across Step 0 clarification briefs, reports, and drafts.

---

## Dual-Track Interactive Comparison Shell

![DSAF Canonical Preview Shell — Side-by-Side Comparison with Finding Pins](docs/assets/preview-shell-showcase.png)

Every UI refactor preview is built inside a self-contained single-file HTML comparison shell (`Before` · `Track A Pragmatic` · `Track B North-Star` · `Side-by-Side`, desktop/mobile viewports, Light/Dark switching, 4 UI states, and toggleable Finding Pins) and verified in headless Chromium. See [examples/sample-mode-c-report.md](examples/sample-mode-c-report.md) for a reproducible Mode C walkthrough.

---

## One Framework, Three Auto-Detected Topologies

| Topology Mode | Target | Core Rubric & Toolchain | Primary Deliverables |
|---|---|---|---|
| **`Mode S` — System Core** | Existing design system repository, Storybook, or token package | `DS01–DS12` (`25` core DSAF anchors), `audit-tokens.mjs` (W3C DTCG + Light/Dark contrast), `audit-runtime.mjs --storybook`, `L0–L5` maturity ladder with 3-band anti-prose cap (`prose <= 40%`) | 5-file audit dossier or `ANALYZED_DESIGN_REPORT.md`, `scores.json` (`dsaf-scores/2`), `audit-diff` regression baseline, `SCAN → Review → FIX` backlog |
| **`Mode C` — Conformance & Drift** | Product consuming a design system or token package | Usability `U01–U18` + Visual `V01–V11` + Conformance `DS07–DS09`, token compliance %, hardcoded & Tailwind arbitrary drift, `!important` overrides, live DOM `N-of-1` clustering, Figma MCP / Code Connect 3-vertex SOP | Multi-file audit dossier, Before/After Dual-Track `draft/*.html`, Drift & `N-of-1` remediation plan, executable lint/CI guardrails (`+SG`) |
| **`Mode P` — Product UX/UI (No DS)** | Live web app, mobile web, or prototype with no formal DS | Usability `U01–U18` (`5-axis` personas, 7-state edge matrix, 4 Data Mutation Tiers) + Visual `V01–V11` (WCAG 2.2 AA, APCA `Lc`, keyboard map, anti-"AI slop") | Multi-file dossier, Dual-Track `Pragmatic` vs `North-Star` `draft/*.html`, optional **Starter Design System Spec** + starter DTCG tokens + CI guardrails (`+SG`) |

---

## Quick Start

### 1. Verify the Framework (`Node >= 20`, zero required npm install)

```bash
git clone https://github.com/zintaen/dsaf.git
cd dsaf
npm test
```

*(Install Playwright in your target project or globally only if you want `audit-runtime.mjs` to drive headless Chromium for live browser / `draft/*.html` verification; all static scripts, token/drift scanners, guardrail generators, scorecard validators, diff gates, and pure-JS self-tests run with zero external dependencies.)*

### 2. Run the Single-Entry `dsaf` CLI (`bin/dsaf.mjs`)

```bash
node bin/dsaf.mjs help
node bin/dsaf.mjs audit ./your-app --out ./audit-output --sarif ./dsaf.sarif --report-unused-ignores
node bin/dsaf.mjs recon ./your-app
node bin/dsaf.mjs tokens ./your-app [--scope apps/web] [--include-demos] [--sarif ./tokens.sarif] [--github]
node bin/dsaf.mjs figma-diff --figma ./figma-vars.json --tokens ./your-app [--prefix --sds-] [--runtime ./runtime.json]
node bin/dsaf.mjs runtime --storybook ./storybook-static/index.json [--routes /,/about --extended-viewports --out ./runtime.json]
node bin/dsaf.mjs runtime --cdp 9222 --target Dashboard
node bin/dsaf.mjs hook install --agent claude --dir ./your-app
node bin/dsaf.mjs install-skill --agent claude --scope user
node bin/dsaf.mjs doctor ./your-app
node bin/dsaf.mjs guardrails --out ./your-app/.dsaf-guardrails --stack tailwind
```

> **Practical runtime & guardrail tips:**
> - **Automatic `playwright` & `axe-core` discovery (`dsaf runtime`):** Automatically searches `process.cwd()` and the target file/directory's ancestor `node_modules/` folders cleanly with no `NODE_PATH` needed (override with `NODE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if using an isolated browser dir).
> - **`+SG` gate targets & env caps (`check-design-discipline.mjs`):** Accepts either a directory (`app`, `src`) or a single file (`app/globals.css`). Configure budgets with `DSAF_MAX_HARDCODED_COLORS`, `DSAF_MAX_IMPORTANT`, `DSAF_MAX_TW_ARBITRARY`, plus optional `DSAF_MAX_SVG_COLORS` and `DSAF_MAX_SWATCH_COLORS`.

Or install/link via `npm link` / `npm install -g @zintaen/dsaf` (or `npx @zintaen/dsaf` — `package.json` configures a strict `"files"` whitelist excluding maintainer-only `evolve/`; releases publish automatically via GitHub Actions OIDC `.github/workflows/publish.yml` on `v*` tags) to invoke `dsaf <command>` anywhere (`audit`, `init`, `personas`, `fix`, `evolve`, `mcp`, `recon`, `tokens`, `figma-diff`, `runtime`, `scorecard`, `diff`, `guardrails`, `hook`, `install-skill`, `doctor`, `integrity`, `verify`, `mine`, `sync`, `version`). See [RELEASE_NOTES.md](RELEASE_NOTES.md) for concise highlights per release.

### 3. Install `dsaf` (Zero-Clone) into AI Coding Agents

```bash
# Install Tier 1 skill without cloning this repository
npx @zintaen/dsaf install-skill --agent claude --scope user
# Or install into all detected/supported agent roots (Claude, Cursor, Codex, Antigravity, .agents)
npx @zintaen/dsaf install-skill --agent all

# From a cloned DSAF repo (maintainer sync incl. dsaf-evolve):
npm run sync:skills
```

Or copy [skill/](skill/) manually into your agent's skill directory (`~/.gemini/config/skills/dsaf`, `~/.agents/skills/dsaf`, `~/.claude/skills/dsaf`, `~/.cursor/skills/dsaf`, or `~/.codex/skills/dsaf`). Never copy `evolve/` into user-facing production skills unless you are maintaining DSAF itself.

### 4. GitHub Action CI Integration (`action.yml`)

```yaml
- uses: actions/checkout@v7
- uses: zintaen/dsaf@v0.9.0
  with:
    target: apps/web
    sarif-file: dsaf.sarif
    comment-pr: "true"
    fail-on-floor: "true"
```

### 5. Invoke the Skill

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
| `dsaf audit <target>` (`skill/scripts/audit-pipeline.mjs`) | One-click Tier 0 Read-Only orchestrator chaining `recon` (incl. Surface Mode), scoped `tokens`, optional `--cdp`/multi-route `runtime`, optional 3-vertex `figma-diff --runtime`, `audit-diff`, and `--sarif` / `--github` CI outputs into `audit-summary.json` + Markdown | Yes (`runtime` needs Playwright) |
| `dsaf init [target]` (`skill/scripts/init-evolve.mjs`) | Universal repository auto-evolution bootstrap scaffolding `.dsaf/` C1–C10 governance (`STRATEGY.md`, `rules.json`, `decision-queue.md`, `strategy-feedback.md`, `handoff.md`), topology-seeded `.dsaf/personas.json`, optional `--with-hook`, `--with-guardrails`, `--with-workflow` | Yes |
| `dsaf personas [target]` (`skill/scripts/generate-personas.mjs`) | Deterministically seeds 5 (`quick`) or 8 (`deep`) orthogonal multi-axis personas bound to `dsaf recon` topology, Surface Mode, routes, and T2 edge scenarios | Yes |
| `dsaf fix <target>` (`skill/scripts/fix-floor.mjs`) | Dry-run planner (`--dry-run`) and safe bounded Floor auto-remediator (`--apply --backup`) for `transition: all`, `100vw`, naked `outline: none`, and unmuted `<video autoplay>` respecting `.dsaf/rules.json` `protectedFiles` | Yes |
| `dsaf evolve [target]` (`skill/scripts/evolve-runner.mjs`) | Supervised `.dsaf/` evolution runner enforcing `.dsaf/STOP` kill switches, `.dsaf/circuit-breaker.json` consecutive failure caps, bounded Floor fixes, and `.dsaf/handoff.md` round logs | Yes |
| `dsaf mcp` (`skill/scripts/mcp-server.mjs`) | Zero-dep JSON-RPC 2.0 stdio MCP server exposing 9 read-only tools (`dsaf_recon`, `dsaf_tokens`, `dsaf_doctor`, `dsaf_hook_check`, `dsaf_figma_diff`, `dsaf_audit`, `dsaf_fix_preview`, `dsaf_evolve_status`, `dsaf_personas`) | Yes (`Node >= 20`) |
| `dsaf recon <target>` (`skill/scripts/recon.mjs`) | 30s read-only scan detecting stack, routes, Storybook, DTCG tokens, Figma Code Connect, cloud DB risk (`T2-Mock`), Surface Mode (`Persuade/Operate/Read/Experience`), and recommended Mode `S/C/P` | Yes |
| `dsaf tokens <dir-or-json>` (`skill/scripts/audit-tokens.mjs`) | Validates W3C DTCG tokens (`$value`, `$type`, `{alias}`, `$ref`, cycles), Light/Dark parity & contrast, separates semantic orphans vs palette scale vars, skips `fixtures/`/`demo/`/`ImageResponse`/`playwright-report/`, tracks Tailwind `@theme`/arbitrary/primitive drift, and enforces `dsaf-ignore` waivers + `--sarif` / `--github` / `--report-unused-ignores` | Yes |
| `dsaf hook <check\|stdin\|install>` (`skill/scripts/dsaf-hook.mjs`) | Edit-time Floor/Reflex checker for Claude Code, Cursor & Codex `PostToolUse` hooks with external DS `:focus-within` / `:has(:focus-visible)` resolution (`--ds-css`) plus CI `--sarif` / `--github` file gate | Yes |
| `dsaf install-skill` (`skill/scripts/install-skill.mjs`) | Zero-clone Tier 1 skill installer for Claude, Cursor, Codex, Antigravity & `.agents` (`--agent`, `--scope user\|project`, `--dir`) | Yes |
| `dsaf doctor [dir]` (`skill/scripts/doctor.mjs`) | 6-point read-only check for stale guardrails, token mtimes, hook setup, CI gate presence, Playwright/axe availability & stale waivers | Yes |
| `dsaf figma-diff --figma <f> --tokens <t>` (`skill/scripts/audit-figma-diff.mjs`) | Automates full 3-vertex `Designed <-> Defined <-> Shipped` triangulation across Figma variables (`@collection` / `*_primitives`), CSS custom properties (`var()`, dark `@media`, `--prefix` auto-strip, `px`/`rem`), Code Connect (`*.figma.*` & batch JSON), and live `computedVars` (`--runtime`) | Yes |
| `dsaf runtime <draft-or-url>` (`skill/scripts/audit-runtime.mjs`) | Verifies Canonical Preview Shell (`preview-shell.html`), `--routes`, `--cdp` desktop/auth attachment, `--extended-viewports` (`320px`/`1920px`), consent overlay hiding, `coveredText`, RTL tracking, `pixelBehind`, APCA-W3 `Lc`, WCAG `3.00:1` UI borders, `>= 44.0px` targets + `overlapsChildOverflow`, `N-of-1` clusters, `LCP`/`CLS`, `axe-core`, and Kept Wiring diff | Pure-JS self-tests yes; live checks require Playwright |
| `dsaf scorecard --input <file>` (`skill/scripts/compute-scorecard.mjs`) | Deterministic validator & calculator (`dsaf-scores/2`) supporting `usability`, `visual`, and `system` rubrics, domain weight presets, Hard Floor & 3-tier waiver enforcement, `dual-agent` / `single-context` provenance, 3-band prose cap (`<= 40%`), and exact point deltas | Yes |
| `dsaf diff --baseline <a> --current <b>` (`skill/scripts/audit-diff.mjs`) | Enforces **No-Silent-Regression** (`D-RT`, `OVRD-*`, `UNRESOLVED`); exits `1` on unapproved score drops | Yes |
| `dsaf guardrails --out <dir>` (`skill/scripts/generate-guardrails.mjs`) | Emits runnable `check-design-discipline.mjs` (separating CSS/inline-style `#hex` & Tailwind arbitrary brackets from informational SVG/swatch colors), GitHub Actions `dsaf-regression-gate.yml`, and `AGENTS-dsaf-rules.md` (`+SG`) | Yes |
| `dsaf ci-report` (`skill/scripts/ci-report.mjs`) | Shared SARIF 2.1.0, GitHub Actions annotation, and 3-tier `Floor / Reflex / Finish` inline waiver validator | Yes |
| `npm test` (`check-integrity.mjs` + `validate-isolation.mjs`) | Verifies markdown links, zero `evolve/` or host `/Users/` / `file:///` leaks, version parity, CLI entry, Canonical Shell contract, schema validation, and all script self-tests | Yes |

---

## Closed-Loop Evolution (`evolve/`)

DSAF separates **production auditing (`skill/`)** from **framework self-evolution (`evolve/`, `/dsaf-evolve`)** so live audits never leak benchmark ground truth or mutate specs mid-run:

1. **Field Retro (`retro`):** Logs strictly anonymized, domain-stripped friction signals (`false_positive`, `false_negative`, `ds_drift_signal`, `ambition_gap`, etc.) into `~/.dsaf/feedback-log.jsonl`.
2. **Corpus & Signal Mining (`npm run evolve:mine`):** Clusters field retro signals alongside dead/saturated criteria and artifact probe gaps mined from `evolve/fixtures/calibration/*.scores.json`.
3. **One Atomic Hypothesis + Blind A/B Gates:** Every rule change goes through blind Evaluator subagents and independent Graders against hard guardrails (`G1–G8`, `T1–T10`, `VG1–VG9`, `V3-1..6`, `DS-1..5`) before human promotion and `npm run sync:skills`.

---

## Repository Layout

```text
dsaf/
├── action.yml              # Official GitHub Action (SARIF 2.1.0 + PR summary + Floor gate)
├── bin/
│   └── dsaf.mjs            # Single-entry `dsaf` CLI wrapper
├── docs/
│   ├── index.html          # Zero-slop GitHub Pages promo & showcase
│   ├── demo/               # Live interactive Canonical Preview Shell demo
│   └── assets/             # Showcase visuals & og-card rendered from Chromium
├── examples/
│   └── sample-mode-c-report.md
├── skill/                  # Portable Tier 1 production agent skill (no evolve/ files)
│   ├── SKILL.md
│   ├── references/         # Progressive-loaded SOPs (Step 0, Modes S/C/P, Shell, Retro)
│   ├── resources/          # Canonical Before/Track A/Track B preview shell HTML
│   └── scripts/            # Deterministic Node ESM CLI tools & self-tests
├── evolve/                 # Tier 2 maintainer-only closed-loop evolution workspace
│   ├── SKILL.md
│   ├── references/         # Evolution gates, blind eval SOP, feedback JSON Schema
│   ├── fixtures/           # Synthetic Mode S / C / P targets, calibration scores & retro log
│   ├── benchmark.md        # Empirical verification & A/B evolution log
│   └── scripts/            # Signal miner, isolation gate, local skill installer
├── package.json
├── RELEASE_NOTES.md
├── LICENSE
└── README.md
```

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Stephen Cheng.

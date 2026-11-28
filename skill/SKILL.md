---
name: dsaf
description: "DSAF v0.9.3 — Unified Design System & Product UX/UI Audit Framework. Auto-detects target topology (Mode S existing Design System core, Mode C product-on-DS conformance & drift, Mode P product UX/UI without a formal DS) and Surface Mode (Persuade / Operate / Read / Experience), enforces a mandatory Step 0 Read-Only Recon & Clarification Gate (never silently guessing user choices), runs deterministic Node ESM measurements (1-command dsaf check, dsaf setup skill+MCP+CI/auto-update installer, dsaf update universal upgrade & offline-safe freshness notifier, persona-linked CI findings & interactive --html audit reports, W3C DTCG tokens & Light/Dark contrast with tokens/*.json discovery, CSS Nesting & Base UI hook rules, SARIF 2.1.0 & GitHub CI annotations, edit-time Floor/Reflex hooks with external --ds-css focus detection, uncapped signal-driven dsaf personas + .dsaf/personas.custom.json, dsaf fix safe Floor remediation, dsaf doctor drift checks, 2/3-vertex Figma MCP & Defined-vs-Shipped diffing, N-of-1 component signatures, WCAG 2.2 AA, APCA-W3 Lc, keyboard tab/unnamed control mapping, pixel-behind contrast, >= 44px mobile & pseudo touch targets, container-query Preview Shell, live interactive tab/disclosure/theme probes, covered-text, RTL hygiene, CDP attachment, axe-core, screenshot pixel diff, LCP/CLS) & stdio MCP server (dsaf mcp, 8 tools), produces Dual-Track Pragmatic vs North-Star interactive HTML previews in isolated draft/ plus optional Starter Design System specs and executable CI/lint guardrails, and enforces 3-tier Floor/Reflex/Finish gates & No-Silent-Regression scorecard diffs. Use whenever asked to audit, review, score, benchmark, validate, or redesign any design system, token pipeline, component library, product UI/UX, accessibility, layout, or visual craft."
---

# DSAF — Design System & Product UX/UI Audit Framework (`v0.9.3`)

Repo-adaptive, evidence-first, unlimited-depth audit and redesign workflow for AI coding agents and engineers. Works seamlessly both when a product **has an established design system** and when a product **does not yet have one** — deriving density, visual identity, domain weights, and transformation ambition strictly from measured evidence.

**Response Language Mirroring Rule:** Although these specification files are written in concise international English, you **MUST** always interact with the user, present the Step 0 Clarification Brief, author reports (unless a specific output language is requested), and localize preview labels in the **user's conversation language** (for example natural Vietnamese when prompted in Vietnamese).

---

## 1. Command Routing & Progressive Reference Loading

Supports natural-language prompts or `/dsaf [audit | system | conformance | product | usability | visual | full | scan | fix] [--auto] <target>` (or CLI one-click `node ./scripts/audit-pipeline.mjs <target> --out <dir>`) plus optional prior `scores.json` or audit report inputs. Load **only** the reference files required for the active stage:

| Stage / Topology | Reference File(s) & Tooling | Purpose |
|---|---|---|
| **Step 0 — Fast Recon & Clarification Gate** *(mandatory first)* | [step0-intake.md](./references/step0-intake.md) + `node ./scripts/recon.mjs` + `node ./scripts/doctor.mjs` | 30s Tier 0 read-only recon (topology `Mode S/C/P`, **Surface Mode** `Persuade/Operate/Read/Experience`, UI stack, live display modes, `375px` clipping, `T2-Mock` isolation, Maturity Tier 1–3, `dsaf doctor` drift check) + 1-turn Clarification Brief |
| **Unified Scoring & CI Gates** *(all modes)* | [scoring-model.md](./references/scoring-model.md) + `node ./scripts/compute-scorecard.mjs` + `node ./scripts/audit-diff.mjs` + `node ./scripts/audit-pipeline.mjs` + `node ./scripts/ci-report.mjs` + `node ./scripts/dsaf-hook.mjs` | `U01–U18` Usability, `V01–V11` Visual UI, `DS01–DS12` System/Drift (`L0–L5`, `AUTO`/`MANUAL`/`AUTO+MANUAL`, 3-band prose cap `<= 40%`), **3-tier `Floor / Reflex / Finish` waivers**, `--sarif` / `--github` CI reporting, edit-time Floor hooks, & No-Silent-Regression gate |
| **`Mode S` — Design System Core** | [mode-system.md](./references/mode-system.md) + `node ./scripts/audit-tokens.mjs` + `node ./scripts/audit-figma-diff.mjs` + `node ./scripts/audit-runtime.mjs --storybook` | Audits an existing DS repo/Storybook/tokens package: W3C DTCG validation, Figma variable/Code Connect diff, component API & state matrix, APCA/WCAG checks, governance, `SCAN -> Owner Gate -> FIX -> VERIFY -> audit-diff` |
| **`Mode C` — Product Conformance & Drift** | [mode-conformance.md](./references/mode-conformance.md) + `node ./scripts/audit-tokens.mjs` + `node ./scripts/audit-figma-diff.mjs` + `node ./scripts/audit-runtime.mjs --live` | Measures product-to-DS drift: Token Compliance %, hardcoded hex/px overrides, Tailwind `@theme` & arbitrary drift, `!important` density, near-duplicate clusters, live DOM `N-of-1` proliferation, automated Figma MCP / Code Connect triangulation |
| **`Mode P` / `C` — Round 1 Usability** | [mode-product-ux.md](./references/mode-product-ux.md) | 5-axis personas (`8+`, uncapped), full cognitive walkthrough traces (zero tail compression), 7-state edge matrix + 5 synthetic edge datasets (`T2–T3`), AI-copy tells, Dual-Track HTML flow previews, Visual UI Handoff Constraints |
| **`Mode P` / `C` — Round 2 Visual UI** | [mode-product-ui.md](./references/mode-product-ui.md) + `node ./scripts/generate-guardrails.mjs` | 5-Line Brand Direction + Template Swap Test, Screen Anatomy, WCAG 2.2 AA + `pixelBehind` + APCA-W3 `Lc`, CSS/copy anti-slop, 3-tier token architecture, optional **Starter Design System Spec** & executable CI/AI guardrails |
| **Canonical Preview Shell & Runtime Verifier** | [preview-shell-contract.md](./references/preview-shell-contract.md) + [preview-shell.html](./resources/preview-shell.html) + `node ./scripts/audit-runtime.mjs` | Unified 1-file comparison shell (`View · Viewport · Theme · State · Finding Pins`) + live DOM verification across viewports, APCA `Lc`, `N-of-1`, `axe-core`, and Kept Wiring diff |
| **Onboarding, Auto-Update, Personas, Floor Auto-Fix & Stdio MCP (`setup` / `update` / `personas` / `fix` / `mcp`)** | `node ./scripts/setup.mjs` + `node ./scripts/update.mjs` + `node ./scripts/generate-personas.mjs` + `node ./scripts/fix-floor.mjs` + `node ./scripts/mcp-server.mjs` | Installs skill + MCP + optional edit-time hooks/CI/weekly auto-update workflows (`dsaf setup`), updates skills/guardrails/workflows/MCP/personas cleanly (`dsaf update`), generates uncapped `.dsaf/personas.json` (`dsaf personas`), previews/applies bounded Floor fixes (`dsaf fix --apply --backup`), and exposes 8 audit & dry-run tools (read-only unless `dsaf_audit` receives `outDir`) over JSON-RPC 2.0 stdio (`dsaf mcp`) |

---

## 2. Mandatory Step 0 — Pre-flight Clarification Gate (Ask Before Assuming)

Before executing ANY audit mode or creating `audit-output/` or `draft/`:

1. Run **Fast Read-Only Recon** (`node ./scripts/recon.mjs <target> --out <tmp/recon.json>` plus live tier-0 inspection when a URL is provided) strictly read-only to discover: product/repo type, detected topology (`Mode S` System Core, `Mode C` Conformance & Drift, or `Mode P` Product without DS), tech stack, live UI themes/modes (never blind regex over dead CSS), `375px` true overflow/clipping, host-OS / remote-cloud write risks requiring `T2-Mock`, and current UI Maturity Tier 1–3.
2. **Pause cleanly ONCE** whenever ANY core input parameter is missing or ambiguous (**Target Mode `S/C/P`**, **Scope `US/UI/DS/Full`**, **Platform/Viewports `1A–1D`**, **Data Mutation Tier `T0–T3`**, **Ambition/Deliverable `L1–L3 / +SG`**, or **Depth & Regression Baseline `Q/D + diff`**). Present a compact Step 0 Clarification Brief with **Concrete Options · Trade-offs · Evidence-Backed Recommendations** in the user's language, saving ONLY read-only recon output and the Brief until confirmed.
3. **Bypass Safety Lock:** Skip pausing ONLY when complete parameters were explicitly provided upfront OR the user explicitly passes `--auto` / instructs straight-through execution. If bypassed WITHOUT an explicitly confirmed data tier, **strictly lock execution to Tier 0 (Strict Read-Only) — even on `localhost`** — never infer permission to mutate state or seed data.

---

## 3. Unified Execution Lifecycle

1. **Multi-File Dossier Default (Anti-Compression):** When file writing is available, emit a structured 5-file dossier (`audit-output/<scope>/00-..04-*.md` + `draft/` + `scores.json`) rather than compressing findings into one truncated reply. Never truncate Blocker, Major, or Moderate root specs or tail walkthrough runs.
2. **Mode Routing & Chaining:**
   - **`Mode S`:** Run `audit-tokens.mjs` + `audit-runtime.mjs` (Storybook/docs URL if running) -> score `DS01–DS12` (`dsaf-scores/2`) with 3-band prose cap -> pause at Owner Review (`AWAITING_REVIEW`) before `FIX` -> verify post-fix scores with `audit-diff.mjs`.
   - **`Mode C`:** Run Round 1 (`usability`) + Round 2 (`visual-ui`) + Conformance checks (`audit-tokens.mjs` + `audit-runtime.mjs` N-of-1 cluster scan) -> enforce Usability Handoff Constraints before Visual UI -> present `draft/` previews + drift remediation backlog.
   - **`Mode P`:** Run Round 1 (`usability`) -> owner sign-off -> Round 2 (`visual-ui`) importing Usability Handoff Constraints -> optionally generate **`starter-design-system-spec.md` + starter W3C DTCG `tokens.starter.json`** alongside Dual-Track interactive `draft/*.html`.
3. **Post-Signoff Implementation Handoff & Executable Guardrails:** Touch committed repository source code ONLY after explicit owner sign-off and implementation approval. Emit exact target file edits, the **Kept Wiring Inventory** (`a[href]`, `form`, `[name]`, `[id]`, `[data-testid]`), the **Repo Lint & Test Contract Scan**, and actionable **Executable Guardrails** via `node ./scripts/generate-guardrails.mjs` (`check-design-discipline.mjs`, `dsaf-regression-gate.yml`, `AGENTS-dsaf-rules.md`).
4. **Re-Evaluation & Diff Gate:** Compare `baseline-scores.json` against `current-scores.json` via `node ./scripts/audit-diff.mjs` to surface every improvement and block silent regressions until explicitly resolved or overridden.

---

## 4. Non-Negotiable Guardrails

- **Rendered Evidence & Deterministic Script Proof First:** Never evaluate visual polish, contrast, spacing, or system compliance from static prose or filenames alone. Wait >= 1s after async loads, theme switches, text scaling, or toggles before measuring. Measure `pixelBehind` for text over images/gradients/blur, compute WCAG 2.2 AA (`>= 4.5:1` text + `:hover`, `>= 3.00:1` UI borders) alongside **APCA-W3 `Lc`** (`>= 60` body, `>= 45` large), measure effective mobile tap targets (`>= 44.0 px` within viewport bounds), filter closed `<details>`, cookie/consent overlays, and framework dev overlays, detect `coveredText` overlaps, check RTL (`dir="rtl"` & Arabic zero-tracking), support `--cdp` for authenticated/Electron sessions, and measure `N-of-1` component clusters directly in DOM.
- **3-Band Anti-Prose-Inflation Cap (`Mode S` & `Mode C`):** Documentation claims alone (`bands.prose <= 40`) can NEVER award passing (`Built` / `Measured`) scores without verified artifact and runtime/CI proof. Every score `< 2` must link a verified Finding ID; every System criterion tags `AUTO`, `MANUAL`, or `AUTO+MANUAL` cleanly.
- **4-Tier Data Safety & Draft Isolation:** Strictly honor confirmed Tier `0–3` (and enable `T2-Mock` route interception on `localhost` whenever remote cloud APIs are detected so `realCloudWrites === 0`). Across all tiers: zero real payments, zero external payment/donation/production clicks, zero real PII, and zero edits to product source before sign-off.
- **Zero Criterion Mega-Merging & Anti-"AI Slop":** Split unrelated root causes into independent Finding IDs; include 3 separate rationales (`Severity`, `Confidence`, `Effort`) for 100% of findings; maintain zero Section 5 <-> Appendix duplication. Enforce CSS anti-slop (`transition: all` and layout-property transitions banned, `overflow-x: clip`, zero `100vw`, `minmax(0, 1fr)`, `min-height: 1lh` error slots, equal inline input+button height, zero `opacity: 0` at rest) and copy anti-slop.
- **Canonical Preview Shell & Cross-File Reconciliation:** Clone [preview-shell.html](./resources/preview-shell.html) for every `draft/<slug>.html` file and verify 100% of `draft/` via `node ./scripts/audit-runtime.mjs <draft-dir>`. Confirm every cited screenshot/JSON artifact exists on disk and reconcile scorecard deltas programmatically via `compute-scorecard.mjs` before delivery.
- **Anti-Anchoring Dual-Agent & Fresh-Context Review:** Whenever the active harness exposes isolated subagents, separate unanchored visual/UX design review (**Assessment A**) from deterministic script/browser probes (**Assessment B**) until synthesis so linter output never anchors qualitative judgment, and review `draft/` previews in a fresh-context reviewer returning one hard disposition (`recapture | rebuild | fix | ship`). When running inline without subagents, declare `⚠️ DEGRADED: single-context (<reason>)` upfront via `compute-scorecard.mjs` `review_provenance`.
- **Three-Tier Gate & Controlled Waivers:** Treat `Floor` findings (DTCG integrity/contrast, `transition: all`, layout transitions, `100vw`, naked `outline: none`, unmuted `autoplay`, hidden `.reveal` at rest) as **unwaivable**. `Reflex` findings may carry `/* dsaf-ignore <rule-id> -- <reason >= 12 chars> */` waivers; audit stale waivers with `--report-unused-ignores`.

---

## 5. Static Integrity Self-Check

Verify links, isolation cleanliness, canonical shell contract, and all deterministic script unit tests with:

```bash
node ./scripts/check-integrity.mjs
```

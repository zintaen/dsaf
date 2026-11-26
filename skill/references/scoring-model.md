# Unified Deterministic Scoring Model & No-Silent-Regression Policy (`v0.2.2`)

Load this reference during criterion scoring and baseline comparison in every mode (`Mode S`, `Mode C`, `Mode P`). Pair with `../scripts/compute-scorecard.mjs` and `../scripts/audit-diff.mjs` to guarantee zero arithmetic drift, strict evidence linkage, and mechanical regression blocking.

---

## 1. Discrete Evidence Scale (`0 / 1 / 2 / N/A`)

Every criterion across all three rubrics uses the same verifiable discrete scale:

| Score | Label | Exact Observable Requirement |
|---|---|---|
| **2** | **Pass** | Verified across audited scope with zero Blocker/Major/Moderate findings linked to this criterion (and for System `DS*` rows, BOTH artifact and verification bands present — prose alone is blocked at score `<= 1`). |
| **1** | **Partial** | Works fundamentally or documented cleanly, with one or more verified **Moderate or Minor** findings (or capped due to missing runtime/CI verification). **MUST cite linked Finding IDs.** *(If citing a Blocker strictly as secondary impact rather than primary root cause, set `"secondary_impact": true` in JSON.)* |
| **0** | **Fail** | One or more verified **Blocker** or **systemic Major** findings (or complete absence of evidence across audited scope). **MUST cite linked Finding IDs.** |
| **N/A** | **Not Applicable / Untested** | Does not apply to product topology OR blocked by confirmed Data Tier (e.g. post-submit flows at `T0`). Excluded from that pillar's denominator; **MUST state reason**. |

### Exact Pillar & Delta Formula
For each pillar $p$ with assigned weight $W_p$ ($\sum W_p = 100$):
- $S_p = \sum$ numeric scores (`0`, `1`, `2`) of scored (non-`N/A`) criteria in pillar $p$.
- $M_p = 2 \times (\text{count of non-N/A criteria in } p)$.
- Pillar percentage $P_p = (S_p / M_p) \times 100\%$.
- Total normalized score (0–100): $\text{Total} = \frac{\sum (S_p / M_p) \times W_p}{\sum_{p \text{ scored}} W_p} \times 100$.
- **Per-Criterion Step Value (`+1` step = `0->1` or `1->2`):** $\Delta_{\text{step}}(p) = \frac{W_p}{M_p} \times \frac{100}{\sum_{q \text{ scored}} W_q}$. Roadmap point estimates MUST take exact values from `compute-scorecard.mjs` so track totals reconcile cleanly without double-counting shared criteria.

---

## 2. Grade Bands, Maturity Ladder & Hard Floors

### Grade Bands (Product & Conformance Readiness)
| Normalized Score (0–100) | Uncapped Grade | Meaning |
|---|---|---|
| **90.0 – 100.0** | **Grade A — Excellent / Production-Ready** | Class-leading usability, craft, or system conformance; minor polish only. |
| **75.0 – 89.9** | **Grade B — Good / Targeted Upgrades** | Solid foundation with clear, bounded improvement opportunities. |
| **60.0 – 74.9** | **Grade C — Fair / Noticeable Friction** | Usable, but clearly hurts efficiency, visual trust, or conformance. |
| **40.0 – 59.9** | **Grade D — Weak / Needs Restructuring** | Systemic structural, drift, or visual hierarchy failures. |
| **0.0 – 39.9** | **Grade F — Critical / Redesign Recommended** | Severe blockers or raw prototype quality. |

**Mandatory Hard Floor Cap (Product UX & Visual):**
- **Usability:** Any verified **Blocker** in `U18` (WCAG 2.2 AA) or causing **unrecoverable data loss / state corruption** caps readiness at `Hard Floor Capped — Remediation Required` regardless of numeric total.
- **Visual UI:** Any verified **Blocker** in `V05` (WCAG 2.2 AA `4.5:1` text / `3.00:1` UI borders), **horizontal overflow breaking usability**, or **mobile effective tap target `< 44.0 px`** caps readiness at `Hard Floor Capped — Remediation Required`.

### Design System Maturity Ladder (`Mode S` & Conformance Overview)
| Level | Score Range | Gate Requirements |
|---|---|---|
| **L0 — Ad-Hoc** | `0 – 19.9` | Inline styles / arbitrary values; no shared tokens or reusable primitives. |
| **L1 — Documented / Mentioned** | `20 – 39.9` | Style guides or docs exist (prose cap max `40%`), without automated tokens or CI enforcement. |
| **L2 — Defined Baseline** | `40 – 59.9` | Core token files and base components exist, with manual governance and partial parity. |
| **L3 — Built & Shipped** | `60 – 74.9` | Token pipeline, Top-20 components, live Storybook/preview, and WCAG AA floor verified in runtime. *(Maximum public self-audit level without third-party verification.)* |
| **L4 — Measured & Enforced** | `75 – 89.9` | Zero unresolved regressions, DTCG validation + drift lint + APCA/a11y CI gates running on PRs, measured adoption telemetry. |
| **L5 — Optimizing & Agent-Ready** | `90 – 100` | Multi-platform DTCG parity, automated design-to-code triangulation, live behavioral telemetry, external verification, and executable AI guardrails. |

### 3-Band Evidence Cap (Anti-Prose-Inflation Rule for `system` Audits)
Every `DS01–DS12` entry in `system` mode optionally records `bands: { prose, artifacts, verification }` (`0..40`, `0..40`, `0..20`):
- **Rule:** Documentation alone (`artifacts === 0 && verification === 0`) **CANNOT** score `2` (Pass) — `compute-scorecard.mjs` rejects `score: 2` when structural artifacts and verification proof are both missing (`prose <= 40%` hard cap).
- Every `DS*` criterion additionally carries `check_type`: `"AUTO"` (verifiable via code, tokens, DOM, Storybook, CI) or `"MANUAL"` (requiring human research, AT testing, counsel/design stewardship review), plus `volatility`: `"FIXED"` or `"DYNAMIC"`.

---

## 3. Rubric 1 — Usability (`U01–U18` across 6 Pillars)

| Pillar | ID | Criterion | Core Audit Anchors |
|---|---|---|---|
| **P1 Onboarding & Value Clarity** | **U01** | 5-Second Value Clarity | Purpose, audience, primary CTA unmistakable on first render. |
| | **U02** | First-Time Onboarding & Empty States | Actionable empty states, clear starting step, progressive disclosure. |
| | **U03** | Contextual Help & Self-Service | Inline hints, format examples, jargon explanation, rescue paths. |
| **P2 IA, Navigation & Mental Model** | **U04** | Information Architecture | Grouping, hierarchy depth, screen decomposition match user mental models. |
| | **U05** | Wayfinding & Information Scent | Labels predict destinations; active location and back/home paths clear. |
| | **U06** | Search, Filtering & Sorting | Accent/diacritic tolerance, clear zero-result states, quick filter reset. |
| **P3 Efficiency & UX Laws** | **U07** | Laws of UX (Fitts, Hick, Miller) | Reachable target sizing, controlled choices, chunked cognitive load. |
| | **U08** | Interaction Effort & Smart Defaults | Minimal step/field count, zero redundant re-entry, sensible defaults. |
| | **U09** | Power-User Ergonomics | Keyboard-first navigation, shortcuts, batch actions, quick copy, repeat accelerators. |
| **P4 Feedback, Errors & Recovery** | **U10** | Responsive Feedback (< 400 ms) | Perceived responsiveness, loading/progress indicators, clear confirmations. |
| | **U11** | Error Prevention & Validation | Constraints upfront, inline errors stating what/why/how to fix. |
| | **U12** | Data Preservation & Undo | Input retained across errors/navigation; clear confirmation & safe undo. |
| | **U13** | 7-State Edge Matrix Resilience | Empty, slow, 100+ dense, interrupted, server error, complete, offline/expired. |
| **P5 Consistency, Content & Trust** | **U14** | Language, Microcopy & Localization | User vocabulary, clean translations/dates/numbers, zero AI-copy slop. |
| | **U15** | Platform Conventions & Parity | Internal consistency, native platform norms, category parity. |
| | **U16** | Trust, Transparency & Control | Clear permissions/pricing/commitments, zero dark patterns, clean exits. |
| | **U17** | Cross-Session & Device Continuity | Draft persistence, resumable flows, link/device handoff. |
| **P6 Accessibility (Hard Floor)** | **U18** | WCAG 2.2 AA & Inclusive Context | Keyboard/focus, dialog/ARIA semantics, light/dark contrast, 200% reflow, >= 44px mobile targets, non-color cues. |

**Domain Weight Presets:** `dev_b2b` (10/20/25/20/10/15) · `consumer_mobile` (20/15/20/15/15/15) · `commerce_forms` (15/15/20/25/10/15) · `content_docs` (15/25/15/10/20/15) · `balanced` (15/18/20/18/14/15).

---

## 4. Rubric 2 — Visual UI (`V01–V11` across 6 Pillars)

| Pillar | ID | Criterion | Core Audit Anchors |
|---|---|---|---|
| **P1 Hierarchy & Focal Clarity** | **V01** | 3-Second Focal & Grayscale Test | Primary focal anchor matches top user goal; hierarchy holds in grayscale. |
| | **V02** | Functional Zoning & Scanning Flow | Clear visual regions without border clutter; natural priority flow. |
| **P2 Typography & Rhythm** | **V03** | Typography, Modular Scale & Rhythm | Font/weight discipline, scale ratios, line height, measure, diacritics, `tabular-nums`. |
| **P3 Color & Perceptual Contrast** | **V04** | Semantic Color Roles & Harmony | Clear canvas/surface/border/ink/accent/status roles without hue clashes. |
| | **V05** | WCAG 2.2 AA & APCA Contrast (Hard Floor) | >= 4.5:1 text (incl. `:hover` & `pixelBehind`), >= 3.00:1 UI borders (WCAG 1.4.11), APCA `Lc` targets, clean Light/Dark layering. |
| **P4 Grid, Spacing & Alignment** | **V06** | Grid Geometry & Gestalt Proximity | Consistent 4/8 px spacing, distinct macro/micro whitespace, zero box-in-box clutter. |
| | **V07** | Axis Alignment & Concentric Radii | Crisp axes/baselines, equal-height sibling controls, concentric nested radii, balanced visual weight. |
| **P5 Brand Craft & Motion** | **V08** | Authentic Craft & Anti-"AI Slop" | Passes 5-Line Brand Direction & Template Swap Test; zero purple-gradient/box-stack clichés or numeric/copy slop. |
| | **V09** | Elevation, States & Motion | Coherent depth, hover/active/focus-visible (constant `border-width` + `outline`), zero `transition: all`/layout animation, `min-height: 1lh` error slots, zero `opacity: 0` at rest, 0 CLS, reduced-motion. |
| **P6 Design System & Resilience** | **V10** | 3-Tier System & Component Consistency | Primitive -> Semantic -> Component tokens, 4-level button hierarchy, unified icon family & stroke weight. |
| | **V11** | Extreme Content & Viewport Resilience | Zero overflow/clipping under accented stress copy, 200% zoom, 375px mobile; `overflow-x: clip`, no `100vw`, `minmax(0, 1fr)`. |

**APCA Reference (`check-apca` / `audit-runtime.mjs`):** Body 14–16px (`|Lc| >= 75`, min `60`) · Secondary 12–14px (`>= 60`) · Large headings >= 24px or 18.66px bold (`>= 45`) · Non-text borders/icons (WCAG 1.4.11 `>= 3.0:1`, APCA `>= Lc 30`).

**Domain Weight Presets:** `dev_b2b` (20/20/18/20/10/12) · `consumer_brand` (20/15/18/17/20/10) · `content_docs` (18/27/18/15/10/12) · `balanced` (18/18/18/18/14/14).

---

## 5. Rubric 3 — Design System & Product Conformance (`DS01–DS12` across 4 Pillars)

| Pillar | ID | Criterion | Core Anchors (`DSAF-25` Refs) | Volatility / Check |
|---|---|---|---|---|
| **P1 Foundations & Tokens** | **DS01** | 3-Tier Token Architecture | Primitive -> Semantic -> Component hierarchy, spacing/type/elevation scales (`A1.1–A1.7`) | `FIXED` / `AUTO` |
| | **DS02** | W3C DTCG Conformance & Ref Integrity | `$value`/`$type` conformance, `{alias}` & `$ref` resolution, zero circular/unresolved refs (`A1.8`) | `DYNAMIC` / `AUTO` |
| | **DS03** | Modern Color & Multi-Mode Parity | OKLCH/P3 support + full Light/Dark/High-Contrast token parity (`A1.9, A6.1`) | `DYNAMIC` / `AUTO` |
| **P2 Component Architecture & A11y** | **DS04** | Core Component Coverage & APIs | Coverage of core primitives (Button, Input, Select, Dialog, Table, Tabs, Toast, Nav) & cohesive props (`A2.1`) | `FIXED` / `AUTO` |
| | **DS05** | Variant & Interactive State Matrix | Complete hover, focus-visible, active, disabled, loading, error states across light/dark (`A2.4`) | `FIXED` / `AUTO` |
| | **DS06** | Baked-In WCAG 2.2 AA + APCA | Runtime verified `0` axe errors, WCAG `>= 4.5:1` / `>= 3.00:1`, APCA `Lc` floors, `>= 44px` touch & keyboard traps (`A8.1, B5.2`) | `FIXED` / `AUTO` |
| **P3 Conformance & Drift** | **DS07** | Token Compliance & Hardcode Ratio | High token compliance %; minimal rogue hex/rgb/off-grid spacing or orphan tokens (`A7.1`) | `FIXED` / `AUTO` |
| | **DS08** | Override Hygiene & N-of-1 Consolidation | Low `!important` / local style patching; unified button/input/card DOM signatures (`A7.1`) | `FIXED` / `AUTO` |
| | **DS09** | Design-to-Code Triangulation | Parity across Defined (DTCG/docs) <-> Designed (Figma/Code Connect) <-> Shipped (DOM/Storybook) (`A5.4`) | `FIXED` / `MANUAL+AUTO` |
| **P4 Governance, DX & AI Readiness** | **DS10** | Docs, Storybook & Usage Guidance | Live Storybook/catalog, When-to-use / Do & Don't, content voice & tone (`A3.1, A5.4, B6.1`) | `FIXED` / `AUTO` |
| | **DS11** | Governance, Versioning & Budgets | Semver discipline, RFC process, changelog, CI/CD, bundle size budgets (`A4.2, A4.3, A5.5, A9.1`) | `FIXED` / `AUTO+MANUAL` |
| | **DS12** | AI Guardrails & Regression Gate | Agent rule files (`AGENTS.md`, `llms.txt`), executable design/copy lint, and mechanical `audit-diff` CI (`A10.3, B9.1`) | `DYNAMIC` / `AUTO` |

**Weight Presets (`P1..P4`):** `ds_core` (`30/30/20/20`) · `product_conformance` (`20/25/35/20`) · `balanced` (`25/25/25/25`).

**System Hard Floor:** Any verified Blocker in `DS06` (baked-in accessibility) or systemic circular/broken token compilation in `DS02` caps System Readiness at `Hard Floor Capped — Remediation Required`.

---

## 6. No-Silent-Regression Policy (`audit-diff.mjs`)

Regressions between two runs (`baseline-scores.json` -> `current-scores.json` of matching engine major version) are NEVER silently averaged away by gains elsewhere. Any criterion score drop is surfaced by `node ./scripts/audit-diff.mjs`:

| Cause Category | Tag | Eligible Criteria | Approver Required? |
|---|---|---|---|
| `rubric-tightened` | `D-RT` | `DYNAMIC` only | No (must cite updated external standard) |
| `fix-side-effect` | `OVRD-FSE` | `FIXED` or `DYNAMIC` | Yes (explicit human sign-off or rollback) |
| `external-dependency-change` | `OVRD-EDC` | `FIXED` or `DYNAMIC` | Yes |
| `deliberate-policy-tradeoff` | `OVRD-DPT` | `FIXED` or `DYNAMIC` | Yes (written rationale + follow-up) |
| `unresolved` | `UNRESOLVED` | Any | Blocks release (`exit 1`) |

Run `node ./scripts/audit-diff.mjs --baseline <old.json> --current <new.json>` (add `--allow-regressions` ONLY after recording signed override rows).

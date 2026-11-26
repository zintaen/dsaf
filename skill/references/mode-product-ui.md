<!-- Version 0.2.1 (2026-11-26). English canonical specification for DSAF Visual UI, Tokens & Design-System Upgrade Audits (Mode P & Mode C Round 2). Automatically mirror the user's conversation language across reports, UI copy, and previews unless explicitly overridden. -->

# Visual Design, Layout, 3-Tier Design System & Craft Audit with a Weighted Rubric

## Input Information

Fill in the fields below or provide them in your prompt. Missing fields are resolved read-only via `recon.mjs` and confirmed at Step 0.

- **Product and access:** [URL, build, read-only repo path, screenshots, or Figma/design specs; test account if applicable]
- **Target mode & deliverable option:** [Mode P Product without DS | Mode C Product with DS | optional `(+SG)` Starter Design System Spec + W3C DTCG tokens + Executable CI Guardrails] (default: confirm at Step 0)
- **Data mutation permission tier:** [Tier 0 Strict Read-Only | Tier 1 Shared Staging Safe-Create | Tier 2 Local Sandbox Full CRUD + `T2-Mock` + 5 Edge States | Tier 3 Isolated Worktree] (default: confirm at Step 0; lock to Tier 0 if bypassed without confirmation)
- **Target platform and viewports:** [desktop (`1440px`) | mobile (`375px`) | both desktop-first | both mobile-first] (default: confirm at Step 0)
- **Transformation ambition level:** [Level 1 Surgical Polish | Level 2 Structured DS Upgrade | Level 3 Breakthrough Visual Redesign Dual-Track (`Track A` Pragmatic vs `Track B` North-Star)] (default: confirm at Step 0)
- **Visual audit depth:** [Quick/Standard | Deep-Dive Maximum (screen-by-screen anatomy, `V01–V11` scorecard, full Moderate specs, 5-file dossier)] (default: Deep-Dive Maximum)
- **Usability Handoff Constraints / Prior visual audit:** [import approved labels, banned copy, step order, preserved behaviors, and prior `scores.json` if continuing/re-auditing]
- **Brand, scope, custom weights, previews & language:** [brand context or auto-derive; themes; custom `V01–V11` weights; `draft/` interactive previews on/off; mirror requester language]

## Task

Conduct a rigorous, rendered-first visual craft, layout geometry, contrast, typography, token architecture, and resilience audit across `V01–V11`, compute a deterministic weighted scorecard via `compute-scorecard.mjs`, architect a stack-native 3-tier token system (including an optional **Starter Design System Spec** when auditing a `Mode P` product lacking a DS), and verify interactive Dual-Track Before/After HTML/CSS prototypes cleanly inside `draft/`.

## Mandatory Principles

1. **Separate three categories cleanly:** *Observation* (screenshots + measured DOM styles/geometry/pixels), *Design judgment* (visual hierarchy, scanning flow, Gestalt proximity, optical alignment, color roles), and *Aesthetic choice* (multiple valid stylistic directions flagged clearly for owner preference rather than framed as bugs).
2. **Evidence grounding:** Every finding cites exact screen/URL, region, element, viewport, theme, text size, state, measured value/screenshot, and source. Unmeasured hunches stay in Open Hypotheses.
3. **Inspect rendered visuals & probe real pixels:** Never judge typography, contrast, hierarchy, or alignment from source code or class names alone. Measure element contrast directly on rendered DOM; for text over photos, gradients, or `backdrop-filter`, use rendered background pixel probing (`pixelBehind`). Wait >= 1 second after theme changes, text scaling, or collapsible toggles before capturing measurements. Label source-only items `"from source code, not seen at runtime"`.
4. **Zero fabricated values:** Report only directly measured `px/rem`, colors, WCAG ratios, **APCA-W3 `Lc`** values, token/variant counts, `N-of-1` signature clusters, and axis offsets. Score `V01–V11` strictly `0 / 1 / 2 / N/A` via `compute-scorecard.mjs`, linking every score `< 2` to verified Finding IDs.
5. **Strict scope locking:** Broad claims (`"zero contrast errors"`, `"consistent spacing"`) apply strictly to exact verified screens, viewports, Light/Dark modes, text sizes, and states. Mark untested modes `"not tested"`.
6. **Domain-authentic identity & Anti-"AI Slop" guardrails:** Derive aesthetic direction from real product character via a **5-Line Brand Direction** (`Product · Character · World · Moments · Signature`, banning empty buzzwords like `"clean, modern, sleek, minimal, premium"`), validated by the **Template Swap Test** (*"Would swapping the logo for a random competitor still fit?"*). Ban heavy card-box stacks, gratuitous purple-blue gradients, emoji replacing a unified icon family, monotonous equal-weight grids, and AI-copy/numeric-precision slop.
7. **Aesthetics never break usability or accessibility:** Every proposal and draft (`Track A` and `Track B`) enforces WCAG 2.2 AA (`>= 4.5:1` text incl. filled-button `:hover`, `>= 3.00:1` UI control borders per WCAG 1.4.11 across inputs, buttons, link buttons, and interactive bordered `<label>` rows), APCA `Lc` targets, `>= 44.0 px` mobile effective tap targets inside `375px` bounds, clear `outline` focus rings, zero horizontal overflow across mobile and `200%` zoom, and 100% of Usability Handoff Constraints when provided.
8. **Root-cause grouping & unbiased craft:** Merge ONLY when sharing BOTH exact CSS/component mechanism AND exact fix; never mega-merge distinct components under one Finding ID; preserve genuine existing visual strengths.
9. **Four-Tier Data Safety & Draft Isolation:** Identical `T0–T3` + `T2-Mock` + isolated `draft/` invariants per [step0-intake.md](./step0-intake.md).
10. **Mandatory Step 0 Gate:** Run `recon.mjs` + read-only visual scan, then pause ONCE for confirmation when parameters are ambiguous.

## Process

### Step 0. Fast Visual Recon & Pre-flight Clarification Gate
Follow [step0-intake.md](./step0-intake.md). Classify Visual Maturity Tier `1–3` and confirm Mode (`P` or `C`), viewports, Data Tier, Ambition (`L1–L3 / +SG`), and Depth.

### Step 1. Inventory Styling System, Select Domain Weights & Lock Brand Direction
- Inventory styling files (`audit-tokens.mjs`) + live rendered themes/modes/viewports + edge states (empty, `100+` dense, error, dialogs, drawers, expanded collapsibles).
- Compute **Token Entropy & N-of-1 Baseline** (`audit-tokens.mjs` + `audit-runtime.mjs`): unique font families, sizes, weights, colors (hardcoded vs `var()`), near-duplicate clusters, spacing steps, radii, elevation layers, and rendered `N-of-1` component signatures.
- Select Visual Domain Weight Preset from [scoring-model.md](./scoring-model.md) (`dev_b2b`, `consumer_brand`, `content_docs`, `balanced`; P1..P6 = 100).
- Lock **5-Line Brand Direction** + **Template Swap Test**, offering 2–3 visual directions with clear trade-offs and one recommendation when identity is absent or Tier 1 Crude.

### Step 2. Capture Screenshots, Measure WCAG/APCA/Geometry & Run Screen Anatomy
Capture identical screenshots per screen × viewport × theme × state and run `node ./scripts/audit-runtime.mjs <url> --live` to record repeatable baselines:
- Token entropy & compliance %, typography rhythm (smallest font, body size, line-height, heading/body ratio, measure, diacritics clipping, `tabular-nums`).
- **WCAG 2.2 AA & APCA-W3 `Lc`:** text contrast (`>= 4.5:1` / `:hover` / canvas-resolved `oklch`/`lab`/`light-dark` / `pixelBehind`), UI border contrast (`>= 3.00:1`), computed APCA `Lc` (`>= 60` body, `>= 45` large), closed `<details>` & framework dev-overlay filtering, and surface elevation contrast between canvas and cards in Light/Dark.
- **Geometry, N-of-1 & Overflow:** misaligned axes, mismatched adjacent inline input+button heights, Gestalt proximity inversions, non-concentric nested radii, rendered `N-of-1` button/input/card clusters, `>= 44.0 px` mobile tap targets, and `0px` horizontal overflow (`body` + child wrappers + viewport clipping).
- **3-Second Focal Test** + **Grayscale Test** directly on screenshots, followed by **Screen-by-Screen Visual Anatomy** across all functional regions.

### Step 3. Audit Across 11 Visual Criteria (`V01–V11`)
Audit all 11 criteria `V01–V11` across 6 pillars in [scoring-model.md](./scoring-model.md), checking objective CSS anti-slop (`transition: all` / `width`/`height`/`top`/`left` transitions banned, `overflow-x: clip`, no `100vw`, `minmax(0, 1fr)` grid tracks, `min-height: 1lh` inline error slots, constant `border-width` + `outline` focus rings, equal height inline input+button pairs, zero hidden-at-rest `opacity: 0` content, `prefers-reduced-motion`).

### Step 4. Synthesize Findings & Compute Weighted Visual Scorecard
Ensure 3 separate rationales (`Severity`, `Confidence`, `Effort`) on 100% of findings, zero Finding <-> Appendix duplication, and run `node ./scripts/compute-scorecard.mjs` (`type: "visual"`) enforcing the **Visual Hard Floor** (`V05` contrast, horizontal overflow, or mobile tap targets `< 44.0 px`). Document Visual Strengths to Preserve.

### Step 5. Architect a 3-Tier Design System (+ Optional `Starter DS Spec` for `Mode P`)
Express a cohesive 3-tier system in the target repo's native syntax (inside reports/`draft/` only before sign-off):
- **Tier 1 — Primitives:** tonal palette steps (`OKLCH`/sRGB), type families/modular scale, 4/8px grid spacing, concentric radius scale, elevation & motion tokens.
- **Tier 2 — Semantic Tokens (Light / Dark / High-Contrast):** canvas, surface-1/2, subtle/strong borders (`>= 3.00:1`), primary/secondary/muted ink (`>= 4.5:1` & APCA `Lc >= 60`), brand accents, semantic status roles.
- **Tier 3 — Component Tokens & CSS Hygiene Contracts:** 4-level buttons, uniform inputs, cards, numeric tables (`tabular-nums`), concentric outer/inner radius math (`R_outer = R_inner + padding`), Gestalt spacing rules, unified icon family & optical stroke weight, complete interaction states.
- **When `Mode P` (No Formal DS Yet) and `(+SG)` Confirmed:** Also emit **`starter-design-system-spec.md`** + a starter **`tokens.starter.json`** (`W3C DTCG $value/$type`) prioritized by real usage frequency (`Button`, `Input`, `Select`, `Card`, `Dialog`, `Toast`, `Table`), naming conventions, lightweight governance checklist, and incremental adoption roadmap.

### Step 6. Design Improvements by Ambition Level (`Track A` vs `Track B`)
Concrete `current -> proposed` CSS/token specs per finding across `Level 1` / `Level 2` / `Level 3 Dual-Track` (`Track A` Pragmatic Polish vs `Track B` North-Star Visual Redesign honoring Usability Handoff Constraints, compact mobile rest states, Template Swap Test, and measurable CSS/DOM acceptance criteria).

### Step 7. Prioritize by Visual Impact, Point Delta & Effort
Use exact `Pts/Step` values from `compute-scorecard.mjs` so Track A fixes reconcile cleanly to Track A deltas and Track B items reconcile to Track B deltas across the 4 buckets (**Do Now**, **Plan Next**, **Do When Convenient**, **Defer**).

### Step 8. Build Canonical Interactive `draft/` Previews, Self-Verify & Handoff
- Clone [preview-shell.html](../resources/preview-shell.html) per [preview-shell-contract.md](./preview-shell-contract.md) inside `draft/` (`Before · Track A · Track B · Side-by-Side` in ONE HTML file per screen, plus a System Specimen preview when `> 5` screens or Starter DS). Populate authentic real Before data without abridging long/accented labels or errors.
- Capture final screenshots under identical conditions, run the **Fresh-Context Visual Check** (Template Swap Test + Reverse Regression *"What did Before do better?"* + compact `375px` mobile rest state check), and run **`node ./scripts/audit-runtime.mjs <draft-dir>`** across 100% of `draft/*.html` files (`desktop-1440`, `zoom-720`, `mobile-375`, Light/Dark, `:hover`, `pixelBehind`, APCA `Lc`, borders `>= 3.00:1`, tap targets `>= 44.0 px`, `0px` overflow, `0` closed-drawer focus leaks, CSS anti-slop, `0` `axe-core` violations, working shell toggles). When invoking `dsaf runtime` from a global install against a project workspace, export `NODE_PATH=<repo>/node_modules` (and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if needed) so Playwright resolves reliably.
- Emit **3–6 Sign-Off Discussion Points**. After explicit owner sign-off, deliver:
  1. File-level CSS/token/component Implementation Handoff Spec.
  2. **Kept Wiring Inventory** (`a[href]`, `form`, `[name]`, `[id]`, `[data-testid]`).
  3. **Repo Lint & Test Contract Scan** (existing design linters, unit tests, E2E selectors).
  4. **Executable Guardrails (`+SG` or `Mode C`):** Run `node ./scripts/generate-guardrails.mjs --out .dsaf-guardrails --stack <css|tailwind|react> --mode <P|C>` to emit `check-design-discipline.mjs` (enforcing CSS/inline-style `#hex`, `!important`, and Tailwind arbitrary brackets separately from informational SVG presentation hexes and quoted swatch constants; supports directory or single-file targets via `DSAF_MAX_HARDCODED_COLORS`, `DSAF_MAX_IMPORTANT`, `DSAF_MAX_TW_ARBITRARY`, and optional `DSAF_MAX_SVG_COLORS`/`DSAF_MAX_SWATCH_COLORS`), `dsaf-regression-gate.yml`, and `AGENTS-dsaf-rules.md`.

### Step 9. Pre-Delivery Self-Check & Programmatic Reconciliation
Recompute the final contrast/APCA tables cleanly from final `draft/` computed output AFTER the last CSS edit, verify all cited `.png`/`.json`/`.html` paths exist on disk, ensure 100% Finding `<->` Scorecard `<->` Roadmap delta reconciliation, and verify 100% of `draft/*.html` passed `audit-runtime.mjs`.

## Output Structure

When file writing is available (default), write the 5-file dossier (`audit-output/visual-ui/` + `draft/` + `scores.json` + optional `starter-design-system-spec.md`):
- **File `00-executive-scorecard-signoff.md`:** Decision Summary, Scope/Token Entropy/Weights, `V01–V11` Scorecard (Before / Track A / Track B), Sign-Off Decisions.
- **File `01-brand-direction-and-anatomy.md`:** 5-Line Brand Direction, Template Swap Test, Anti-"AI Slop" Check, Aesthetic Options, Screen-by-Screen Visual Anatomy, and Visual Strengths to Preserve.
- **File `02-detailed-visual-findings.md`:** Master Summary Table, Full Deep-Dive Specs (100% Blocker/Major/Moderate + compact Minor), and Root-Cause Themes.
- **File `03-design-system-roadmap-handoff.md`:** 3-Tier Design System Tables (Primitives/Semantic/Component), Prioritized Upgrade Plan with exact deltas, Baseline Re-measurement Protocol, `draft/` Self-Verification Table, and Post-Signoff Implementation & Executable Guardrails Handoff.
- **File `04-appendix-and-evidence.md`:** Unmerged glitches, Open Aesthetic Hypotheses, Measurement Methods & `audit-runtime.mjs` / `audit-tokens.mjs` logs, and Asset Inventory.

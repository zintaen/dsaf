# Mode C — Product Conformance & Drift Audit (`v0.2.1`)

Load this playbook when Step 0 confirms **`Mode C` (Product-on-DS Conformance & Drift)** — auditing a live product or application codebase that already consumes a design system, token library, or structured styling architecture. Pair with [scoring-model.md](./scoring-model.md), [mode-product-ux.md](./mode-product-ux.md), and [mode-product-ui.md](./mode-product-ui.md).

---

## 1. Core Objective: Close the Three-State Gap

A design system only creates value if shipped UI stays faithful to it. `Mode C` measures both **Product UX/UI quality (`U01–U18`, `V01–V11`)** AND **System Conformance (`DS07–DS09` + `product_conformance` scorecard)** across three vertices:
1. **Defined** (DTCG tokens / CSS variables / component library specs)
2. **Designed** (Figma variables, components & Code Connect files, when available — cleanly degrade to 2-vertex *Defined <-> Shipped* when Figma data is absent)
3. **Shipped** (production CSS/JSX source + live Chromium rendered DOM geometry and pixels)

---

## 2. Conformance & Drift Procedure

### Step 1. Codebase Drift Scan (`audit-tokens.mjs`)
Run on the application styling/UI directories:
```bash
node ./scripts/audit-tokens.mjs <app-src-dir> --json --out <audit-output/conformance/tokens-drift.json>
```
Capture exact objective drift metrics (never estimate counts):
- **Token Compliance Ratio (%):** Percentage of color references using semantic `var(--*)` tokens vs raw hardcoded `#hex`, `rgb()`, `hsl()`, un-tokenized `oklch()` literals, or Tailwind arbitrary color classes (`bg-[#...]`) outside token definition blocks.
- **Primitive Token Leakage:** Direct usage of raw palette steps (e.g., `--gray-700`, Tailwind raw `bg-slate-600`) where semantic tokens (e.g., `--surface-elevated`, `--text-muted`) are defined and expected.
- **Orphan & Near-Duplicate Clusters:** Authored unused CSS/DTCG variables (framework internals like `--tw-*` / `--radix-*` and consumed Tailwind `@theme` utilities excluded) plus near-duplicate hardcoded colors (`deltaRGB < 18`) creeping into feature styles.
- **Scoped Off-Grid Spacing & `!important` Overrides:** Property-scoped `padding`/`margin`/`gap`/`border-radius` literals outside the 4px/8px scale, Tailwind arbitrary `p-[Npx]` utilities, and density of `!important` override hacks fighting system styles.
- **Light/Dark DTCG Mode Parity & Contrast:** Missing Light vs Dark semantic keys plus resolved token-pair WCAG/APCA compliance when DTCG files are present.

### Step 2. Live DOM "N-of-1" Component Proliferation & Triangulation (`audit-runtime.mjs`)
Run against the live running application (or built preview URL) across confirmed viewports (`1440px`, `720x450` zoom, `375px` mobile) and verified themes:
```bash
node ./scripts/audit-runtime.mjs <app-url> --live [--axe <path>] --json --out <audit-output/conformance/runtime.json>
```
Evaluate:
- **N-of-1 Component Signatures:** Inspect `componentInventory` reported by `audit-runtime.mjs` for `buttons` and `inputs` — surface every rogue local clone whose rendered `(height, borderRadius, fontSize, borderWidth)` diverges from canonical DS components (for example `"6 distinct button height×radius signatures across 19 rendered buttons"`).
- **Computed Fidelity & Keyboard Map:** Verify whether live buttons, inputs, dialogs, and typography resolve cleanly across Light/Dark themes without broken contrast (`< 4.5:1` / `< 3.00:1` UI borders / low APCA `Lc`), `< 44.0 px` mobile tap targets, `tabindex > 0` traps, or unnamed interactive controls (`keyboardMap`).
- **Figma MCP & Code Connect 3-Vertex Triangulation SOP (`audit-figma-diff.mjs`):**
  1. When Figma MCP context (`get_variable_defs`, `get_design_context`) or exported Figma variable JSON plus Code Connect mappings (`*.figma.ts` / `*.figma.tsx` / `*.figma.batch.*`) exist alongside codebase/runtime artifacts, run:
     ```bash
     node ./scripts/audit-figma-diff.mjs --figma <figma-vars.json> --tokens <audit-output/conformance/tokens-drift.json> [--prefix <css-prefix>] [--code-connect <app-src-dir>] [--runtime <audit-output/conformance/runtime.json>] --format markdown
     ```
     Supports CSS `var()` alias resolution, `@media (prefers-color-scheme: dark)` preservation, `@collection` / `*_primitives` normalization, auto-detected `--prefix` stripping, `px`↔`rem` & font-stack equivalence, and Code Connect v2 template + batch JSON parsing. Report exact `triangulationCoveragePct`, value drift (`Designed` vs `Defined`), design-only / code-only tokens, and Code Connect mapped components.
  2. When Figma specs or Code Connect files are absent, never fabricate a design vertex — state explicitly: `"3-vertex status: 2-vertex Defined <-> Shipped verified; Designed (Figma MCP / Code Connect): not tested (not supplied)"`.

### Step 3. Chain with Product UX (`U01–U18`) & Visual Craft (`V01–V11`)
- Execute Usability walkthroughs ([mode-product-ux.md](./mode-product-ux.md)) and Visual UI critique ([mode-product-ui.md](./mode-product-ui.md)) within confirmed `T0–T3` data permissions (enabling `T2-Mock` whenever `localhost` connects to a remote cloud DB).
- Never recommend throwing away a working DS component when fixing its product usage or missing variant solves the defect cleanly. Separate **Product Drift Fixes** (app team swaps hardcoded CSS -> existing DS token/component) from **DS Upstream Gaps** (DS team adds a genuinely missing component/token variant via RFC).

### Step 4. Conformance Scorecard, Dual-Track Previews & Executable CI Guardrails
- Compute the `product_conformance` Scorecard (`type: "system"`, `profile: "product_conformance"`) alongside Usability / Visual scorecards via `compute-scorecard.mjs` (`DS01–DS12` weighted toward `P3 Conformance & Drift = 35%`). Link every Finding ID (`DRIFT-*`, `F-*`, `VIS-*`) cleanly without mega-merging unrelated components.
- For UI fixes, clone [preview-shell.html](../resources/preview-shell.html) into `draft/` showing current drifted baseline (`Before`) vs consolidated DS-compliant UI (`Track A` / `Track B`), verified via `audit-runtime.mjs`.
- **Post-Signoff Deliverable — Executable Guardrails Pack (`generate-guardrails.mjs`):** After owner sign-off, run `node ./scripts/generate-guardrails.mjs --out <repo>/.dsaf-guardrails --stack <css|tailwind|react> --mode C` to emit:
  1. `check-design-discipline.mjs` — zero-dependency script enforcing CSS/inline-style `#hex` (`DSAF_MAX_HARDCODED_COLORS`), Tailwind arbitrary bracket classes (`DSAF_MAX_TW_ARBITRARY`), and `!important` overrides (`DSAF_MAX_IMPORTANT`) outside token blocks, while reporting declarative SVG `fill`/`stroke` marks (`DSAF_MAX_SVG_COLORS`) and quoted swatch constants (`DSAF_MAX_SWATCH_COLORS`) cleanly in `info:`.
  2. `dsaf-regression-gate.yml` — GitHub Actions CI gate running discipline checks + `audit-diff.mjs`.
  3. `AGENTS-dsaf-rules.md` — concrete token & component usage rules ready to embed in the repo's `AGENTS.md`.

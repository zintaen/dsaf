# Mode C — Product Conformance & Drift Audit (`v0.0.1`)

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
- **Token Compliance Ratio (%):** Percentage of color references using semantic `var(--*)` tokens vs raw hardcoded `#hex`, `rgb()`, `hsl()`, or un-tokenized `oklch()` literals outside token definition blocks.
- **Primitive Token Leakage:** Direct usage of raw palette steps (e.g., `--gray-700`, Tailwind raw `bg-slate-600`) where semantic tokens (e.g., `--surface-elevated`, `--text-muted`) are defined and expected.
- **Orphan & Near-Duplicate Clusters:** Unused CSS/DTCG variables plus near-duplicate hardcoded colors (`deltaRGB < 18`) creeping into feature styles.
- **Off-Grid Spacing & `!important` Overrides:** Arbitrary spacing/radius literals outside the 4px/8px scale and density of `!important` override hacks fighting system styles.

### Step 2. Live DOM "N-of-1" Component Proliferation & Triangulation (`audit-runtime.mjs`)
Run against the live running application (or built preview URL) across confirmed viewports (`1440px`, `720x450` zoom, `375px` mobile) and verified themes:
```bash
node ./scripts/audit-runtime.mjs <app-url> --live [--axe <path>] --json --out <audit-output/conformance/runtime.json>
```
Evaluate:
- **N-of-1 Component Signatures:** Inspect `componentInventory` reported by `audit-runtime.mjs` for `buttons`, `inputs`, and `cards` — surface every rogue local clone whose rendered `(height, borderRadius, fontSize, borderWidth)` diverges from canonical DS components (for example `"6 distinct button height×radius signatures across 19 rendered buttons"`).
- **Computed Fidelity Check:** Verify whether live buttons, inputs, dialogs, and typography actually resolve to DS tokens cleanly across Light/Dark themes without broken contrast (`< 4.5:1` / `< 3.00:1` UI borders / low APCA `Lc`) or mobile tap targets `< 44.0 px`.
- **Optional Figma / Code Connect Triangulation:** If Figma tools/Code Connect files are present, list unmapped components (`design-only` vs `code-only`), mismatched variant props/names, and detached custom UI patterns; otherwise mark `Figma vertex: not tested (no Figma source supplied)`.

### Step 3. Chain with Product UX (`U01–U18`) & Visual Craft (`V01–V11`)
- Execute Usability walkthroughs ([mode-product-ux.md](./mode-product-ux.md)) and Visual UI critique ([mode-product-ui.md](./mode-product-ui.md)) within confirmed `T0–T3` data permissions (enabling `T2-Mock` whenever `localhost` connects to a remote cloud DB).
- Never recommend throwing away a working DS component when fixing its product usage or missing variant solves the defect cleanly. Separate **Product Drift Fixes** (app team swaps hardcoded CSS -> existing DS token/component) from **DS Upstream Gaps** (DS team adds a genuinely missing component/token variant via RFC).

### Step 4. Conformance Scorecard, Dual-Track Previews & Executable CI Guardrails
- Compute the `product_conformance` Scorecard (`type: "system"`, `profile: "product_conformance"`) alongside Usability / Visual scorecards via `compute-scorecard.mjs` (`DS01–DS12` weighted toward `P3 Conformance & Drift = 35%`). Link every Finding ID (`DRIFT-*`, `F-*`, `VIS-*`) cleanly without mega-merging unrelated components.
- For UI fixes, clone [preview-shell.html](../resources/preview-shell.html) into `draft/` showing current drifted baseline (`Before`) vs consolidated DS-compliant UI (`Track A` / `Track B`), verified via `audit-runtime.mjs`.
- **Post-Signoff Deliverable — Executable Guardrails Pack:** After owner sign-off, include concrete CI-ready guardrails tailored to the app stack:
  1. Stylelint / ESLint / custom script rules blocking raw hex/rgb/off-scale px outside token files and flagging new `!important` overrides.
  2. Token compliance CI gate + `audit-diff.mjs` baseline check preventing future drift regressions.
  3. Concrete token & component usage rules appended to the repository's `AGENTS.md` / AI coding rules so future AI edits default to DS tokens and primitives.

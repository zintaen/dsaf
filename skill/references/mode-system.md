# Mode S — Design System Core Audit (`v0.9.3`)

Load this playbook when Step 0 confirms **`Mode S` (Design System Core)** — auditing an existing design system library, token package, or component system repository. Pair with [scoring-model.md](./scoring-model.md) and always follow the user's conversation language.

---

## 1. Operating Discipline (`SCAN -> AWAITING_REVIEW -> FIX -> VERIFY`)

1. **`SCAN` Mode (No Product Source Edits):** Collect deterministic token, build, Storybook, runtime a11y, optional Figma 3-vertex diff (`audit-figma-diff.mjs`, supporting `--prefix <str>` or auto-detected CSS token prefix, CSS `var()` aliases, `@media (prefers-color-scheme: dark)` preservation, `px`/`rem` equivalence, and Code Connect v2 templates/batches), and governance evidence; score `DS01–DS12` (`system` scorecard with 3-band evidence cap); enumerate findings tagged `@Agent[fix]`, `@Agent[research]`, `@Human[decide]`, or `@Human[manual]`. **PAUSE at `AWAITING_REVIEW`** for owner triage (`approve` / `reject` / `defer`).
2. **`FIX` Mode (Only After Owner Approval):** Apply approved token/doc/lint/component fixes within confirmed permissions, rebuild derived outputs (token builds, Storybook static build, manifests), re-run deterministic scripts, recompute `scores.json`, and run `audit-diff.mjs` to enforce **No-Silent-Regression**.

---

## 2. Step-by-Step Execution Procedure

### Step 1. Static Token & Architecture Audit (`audit-tokens.mjs`)
Run:
```bash
node ./scripts/audit-tokens.mjs <ds-root> --json --out <audit-output/system/tokens-audit.json>
```
Record verbatim `audit-tokens.mjs` metrics and pair them with manual DS domain checks:
- **Script-verified DTCG & drift metrics:** `tokenCount`, `typedCount`, `describedCount`, `aliasCount`, `componentScopedCount`, `modernColorCount`, `blockingIssues` (`{alias}` & `$ref` unresolved/circular counts), `dtcgModes` Light/Dark parity & contrast, `semanticOrphanCount` / `paletteScaleUnusedCount`, and `tokenCompliancePct`.
- **Manual DS architecture & parity checks:** 7-domain tier coverage (colors, typography, spacing, elevation/radius, motion, iconography, grid tokens) and High-Contrast / `forced-colors` mode parity.
- Record **Live CSS & Token Pairs** alongside DTCG token files (comparing CSS var consumers against `semanticOrphanCount` / orphan findings).

### Step 2. Live Component & Storybook Runtime Audit (`audit-runtime.mjs`)
Never rely solely on counting `*.stories.*` filenames! When Storybook, docs preview, or local test harness is available:
- Start or target the local Storybook / showcase server read-only (Tier 0/2 per Step 0 confirmation).
- Run `node ./scripts/audit-runtime.mjs <storybook-or-preview-url> --live [--storybook <url|index.json>] [--axe <path>] --json` across desktop (`1440px`), 200% zoom (`720x450`), mobile (`375px`), Light & Dark themes, and `prefers-reduced-motion`.
- Inspect core Top-20 component coverage (`button`, `input`, `select`, `checkbox/radio/switch`, `dialog/modal`, `drawer`, `tabs`, `table`, `toast/alert`, `tooltip/popover`, `badge`, `card`, `nav`) across `default`, `hover`, `focus-visible`, `active`, `disabled`, `error`, and `loading` states.
- Record minimum WCAG text & `3.00:1` UI border contrast, **APCA-W3 `Lc`** (`>= 60` body, `>= 45` large, `>= 30` UI borders), `axe-core` count, mobile tap targets `>= 44.0 px`, CSS anti-slop (`transition: all`, layout animations, focus outline leaks), and `N-of-1` signature proliferation across stories.

### Step 3. Governance, DX, Bundle & AI-Readiness Verification
Inspect directly (no guessed scores):
- Documentation quality: explicit *When to use / When NOT to use*, live code examples, content voice & tone.
- Governance & distribution: Semver (`package.json`, `CHANGELOG.md`), RFC/proposal workflow, `CODEOWNERS`, deprecation/breaking-change policy, `exports` / `sideEffects` tree-shaking, bundle size budget checks, CI workflows.
- AI readiness: `AGENTS.md` / `CLAUDE.md` / `llms.txt` / Figma Code Connect mappings telling AI tools to use semantic tokens and exported components rather than raw hex/px.

### Step 4. Synthesize Findings & Compute 3-Band `system` Scorecard
Run:
```bash
node ./scripts/compute-scorecard.mjs --input <audit-output/system/scorecard-input.json> --format markdown
```
Enforce these mandatory integrity rules:
- **3-Band Anti-Prose Cap (`prose <= 40`):** Every criterion `DS01–DS12` optionally specifies (and is recommended to include) `bands: { prose, artifacts, verification }` (`0..40`, `0..40`, `0..20`); whenever supplied, `compute-scorecard.mjs` strictly enforces the cap so prose alone without at least one of shipped artifacts or verification proof (`artifacts === 0 && verification === 0`) caps score at `<= 1` (`max 40%`).
- **`AUTO` vs `MANUAL` & Volatility Tagging:** Tag every row `AUTO`, `MANUAL`, or `AUTO+MANUAL` and `FIXED` or `DYNAMIC`. Human-only proof (e.g., assistive-tech screen-reader usability testing, adoption survey, design review rituals) stays `MANUAL` / `"not tested"` until attached.
- **Root-Cause Splitting:** Link multiple independent Finding IDs per criterion (`DS01–DS12`) rather than merging distinct component or token bugs into one Finding ID. Record `Severity (reason)`, `Confidence (reason)`, `Effort (concrete basis)`, revert safety/command for `@Agent[fix]`, and `DS01–DS12` criterion IDs.
- **Self-Audit Publication Cap Notice:** Note clearly that unverified self-audits cap public maturity claims at **`L3`** (`L4–L5` require independent verification plus measured production telemetry).

### Step 5. Pause at `AWAITING_REVIEW` -> Execute Approved `FIX` -> Gate with `audit-diff.mjs`
- Write the 5-file dossier (`audit-output/system/00-..04-*.md`) + `scores.json` (`--format json`). If creating visual component specimen previews, clone `../resources/preview-shell.html` into isolated `draft/` and verify via `audit-runtime.mjs`.
- **Stop and request owner triage** on `@Human[decide]`, `@Human[manual]`, and `@Agent[fix]` rows before modifying any DS source file.
- After approved fixes land, re-run `audit-tokens.mjs`, `audit-runtime.mjs`, and `compute-scorecard.mjs` (`after-scores.json`), then run:
```bash
node ./scripts/audit-diff.mjs --baseline <before-scores.json> --current <after-scores.json>
```
Resolve or sign every regression row (`D-RT`, `OVRD-FSE`, `OVRD-EDC`, `OVRD-DPT`) before marking the audit complete.

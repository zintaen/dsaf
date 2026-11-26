# DSAF Evolution Promotion & Non-Regression Gates (`v0.0.1`)

A candidate `skill/` change can be promoted ONLY when the targeted gate improves AND zero hard guardrails regress across tested languages and topologies (`Mode S`, `Mode C`, `Mode P`).

---

## 1. Product Usability Guardrails (`G1–G8`, `T1–T10`)

| Gate | Requirement | Pass Threshold |
|---|---|---|
| **G1** | Known-bug rubric recall | No regression vs baseline |
| **G2** | Anti-false-positive traps (`>= 1s` async wait, debounced search text/count check, `role="dialog"/"alertdialog"/<dialog>`, inner `overflow-y` containers, effective `::before/::after`/`<label>` tap targets) | `100%` clean |
| **G3** | Zero fabricated stats, counts, or unverified DOM claims | `0` fabrications |
| **G4** | Evidence accuracy against live app/DOM | `0` hallucinated findings |
| **G5** | Observation / Inference / `(simulated)` separation & conditional phrasing | `0` violations |
| **G6** | Untested scope marked `"not tested"` with reason | `0` violations |
| **G7** | Scope lock (no over-claiming across untested screens/viewports/modes/keys) | `0` major over-claims |
| **G8** | Tier 0 Unknown/Production strict safety (`0` submits/deletes/external clicks) | **STRICT `0`** |
| **T1–T2** | Evidence location + concrete `current -> proposed` fixes | `100%` |
| **T4** | Separate `Severity (reason)`, `Confidence (reason)`, `Effort (basis)` across 100% of findings | `100%` |
| **T7** | Root-cause split discipline & `0` Finding <-> Appendix duplication | `0` duplicates |
| **T10** | 1-to-1 reconciliation from failing baseline metrics to findings | `100%` |

---

## 2. Visual UI Guardrails (`VG1–VG9`)

| Gate | Requirement | Pass Threshold |
|---|---|---|
| **VG1** | Rendered-first inspection + measured styles/geometry | PASS |
| **VG2** | 3-second focal test + grayscale test + token entropy baseline | PASS |
| **VG3** | Coherent stack-native 3-tier token architecture | PASS |
| **VG4** | 100% `draft/*.html` live runtime check (`0` axe, `>= 4.5:1` / `:hover`, `pixelBehind`, `>= 3.00:1` borders, `>= 44.0 px` mobile targets inside `375px`, `0px` overflow) | `100% PASS` |
| **VG5** | Unshortened authentic Before data in drafts + Usability Handoff Constraint fidelity | PASS |
| **VG6** | 3 separate rationales (`Severity`, `Confidence`, `Effort`) + zero duplication | `100% PASS` |
| **VG7** | Scope lock & zero fabricated contrast/token values | PASS |
| **VG8** | Draft isolation outside product source code + Sign-Off points | PASS |
| **VG9** | Recomputed post-edit contrast/DOM logs synced verbatim into final report | PASS |

---

## 3. Clarification, Safety, Persona & Dual-Track Gates (`V3-1..V3-6`)

| Gate | Requirement | Threshold |
|---|---|---|
| **V3-1** | **Step 0 Pre-flight Gate:** Fast read-only recon first, PAUSE cleanly on missing params with Options · Trade-offs · Recommendations in user's language (`T0` forced if `--auto` omits tier). | PASS |
| **V3-2** | **4-Tier Safety & `T2-Mock`:** Zero remote cloud writes (`realCloudWrites === 0`) when localhost connects to remote DBs; seeds 5 synthetic edge datasets cleanly at `T2–T3`. | PASS |
| **V3-3** | **5-Axis Personas:** `8–12+` distinct personas in Deep-Dive spanning all 5 behavioral axes; core flows walked by `>= 3` personas. | PASS |
| **V3-4** | **Anti-Compression:** Multi-file dossier default; full Moderate specs; zero compressed tail walkthrough traces. | PASS |
| **V3-5** | **Deterministic Scorecard:** Verified via `compute-scorecard.mjs` (`weights=100`, Hard Floor + exact deltas). | PASS |
| **V3-6** | **Dual-Track Shell:** Canonical `preview-shell.html` (`Before · Track A · Track B · Side-by-Side` in 1 file) verified via `audit-runtime.mjs`. | PASS |

---

## 4. Design System & Conformance Gates (`DS-1..DS-5`)

| Gate | Requirement | Threshold |
|---|---|---|
| **DS-1** | **Topology Routing Accuracy:** Correctly distinguishes `Mode S` (DS Core), `Mode C` (Conformance & Drift), and `Mode P` (Product without DS) via `recon.mjs` + Step 0 without forcing corporate DS governance onto non-DS apps. | PASS |
| **DS-2** | **DTCG & Drift Determinism:** Token compliance %, hardcoded hex/off-grid counts, `!important`, near-duplicate clusters, and DTCG `$value`/`$ref` cycles come directly from `audit-tokens.mjs` (zero guessed counts). | PASS |
| **DS-3** | **Runtime APCA & N-of-1 Proof:** `audit-runtime.mjs` reports live APCA-W3 `Lc`, WCAG `3.00:1` UI borders, and rendered `N-of-1` component signature clusters across target viewports/themes. | PASS |
| **DS-4** | **3-Band Anti-Prose Cap (`Mode S`):** Prose/documentation alone never scores `2` (`Pass`) or exceeds `40%` ceiling without structural artifact + runtime/CI proof (`compute-scorecard.mjs` rejects prose inflation). | PASS |
| **DS-5** | **No-Silent-Regression Gate:** `audit-diff.mjs` catches criterion drops, rejects unapproved regressions (`exit 1`), and preserves explicit `FIXED` vs `DYNAMIC` override logging. | PASS |

# Blind A/B Evaluation & Isolation Protocol (`Tier 2`)

Execute this SOP before promoting any `skill/` rule or script change.

---

## 1. Strict Information Barrier

| Role | Allowed Inputs | Forbidden Inputs |
|---|---|---|
| **Blind Evaluator Subagent** | `skill/` ONLY + target app/repo/fixture + user prompt + scratch temp output dir | `evolve/`, `benchmark.md`, ground-truth defect lists, prior grader sheets, hidden expected scores |
| **Independent Grader Subagent** | Evaluator dossier + `draft/*.html` + `scores.json` + hidden fixture rubric in `benchmark.md` + `audit-runtime.mjs` / `audit-tokens.mjs` verification | Cannot edit Evaluator outputs or waive failed hard gates |

---

## 2. Minimum Cross-Topology Evolution Matrix

1. **Step 0 & Topology Test (`V3-1`, `DS-1`):** Provide an under-specified prompt pointing to a `Mode C` or `Mode S` repo -> verify fast read-only `recon.mjs`, correct mode detection, PAUSE at Step 0 in the user's language, and zero `audit-output/` or `draft/` writes pre-confirmation.
2. **Tier 0 Unknown-Env Safety Test (`G8`, `V3-2`):** Invoke with `--auto` without confirming a data tier on a localhost fixture configured with remote cloud env vars -> verify strict `T0` lock (`0` mutations/submits).
3. **`Mode P / C` Product Breakthrough Run (`G1–G7`, `VG1–VG9`, `V3-3..V3-6`, `DS-2..DS-3`):** Full confirmed audit on a product fixture with `audit-tokens.mjs` + `audit-runtime.mjs` on `100%` of `draft/*.html` + deterministic `compute-scorecard.mjs`.
4. **`Mode S` Design System Core Run (`DS-1..DS-5`):** Audit a tokenized DS fixture verifying `audit-tokens.mjs`, Storybook/runtime verification, 3-band anti-prose cap enforcement, and `audit-diff.mjs` regression detection.

---

## 3. Cleanliness Invariants

- Use isolated `/tmp/` worktrees whenever benchmarking historical git commits; remove worktrees and stop dev servers immediately after grading.
- Preserve host `~/.gitconfig` SHA-256 unchanged across every benchmark cycle.

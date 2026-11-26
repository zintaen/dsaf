---
name: dsaf-evolve
description: "Maintainer-only Tier 2 Closed-Loop Evolution Meta-Skill for DSAF v0.1.0. Mines domain-stripped real-world retro signals (~/.dsaf/feedback-log.jsonl) plus calibration scorecard corpora (dead/saturated criteria & probe gaps), formulates one atomic hypothesis per cycle, executes blind Evaluator/Grader A/B evaluations across Mode S/C/P fixtures against hard guardrails (G1-G8, T1-T10, VG1-VG9, V3-1..6, DS-1..5), enforces zero-contamination isolation, and syncs clean skill releases. NEVER use during normal product or design system audits; use ONLY when evolving DSAF itself."
---

# DSAF — Tier 2 Maintainer Closed-Loop Evolution (`v0.1.0`)

This meta-skill stays strictly isolated inside `evolve/` outside the production `skill/` directory so audit agents never see benchmark answers or mutate production rules mid-run.

## 1. Non-Negotiable Evolution Laws

1. **Zero Contamination:** Never copy `evolve/`, `benchmark.md`, or hidden fixture ground truth into `skill/`.
2. **One Atomic Hypothesis per Cycle:** Change a single root rule or probe heuristic per experiment. State hypothesis, target gate, expected direction, and rollback criteria BEFORE modifying `skill/`.
3. **General Principles Only:** Never teach to test fixtures or hardcode target names into `skill/`. Every rule must generalize across arbitrary repos and apps.
4. **Blind Evaluator + Independent Grader Isolation:** Evaluation subagents receive ONLY `skill/` + target fixture + user prompt — NEVER `evolve/`. Independent Grader subagents verify runtime drafts and score gates honestly without modifying Evaluator outputs.
5. **No-Silent-Regression & Maintainer Sign-Off:** Never auto-promote a release. Present the full diff + blind A/B scorecard comparison across Modes `S / C / P` to the maintainer; revert immediately if ANY hard gate regresses.

## 2. Six-Stage Evolution Workflow

### Stage 1 — Mine Field Signals & Corpus Metrics
Run the two-channel miner over field retro signals and calibration scorecards:

```bash
node ./evolve/scripts/mine-signals.mjs --input ~/.dsaf/feedback-log.jsonl [--scores-dir <calibration-dir>] --format markdown
```

Inspect high-priority clusters across `false_positive`, `false_negative`, `ds_drift_signal`, `ambition_gap`, `depth_or_persona_gap`, `process_or_safety_friction`, and `design_taste_signal`, plus `dead_criteria`, `saturated_criteria`, and `probe_gaps`. Reject one-off local project tastes.

### Stage 2 — Record One Atomic Hypothesis
Document in advance: hypothesis root cause, minimal diff in `skill/`, target gate to improve (`G*`, `VG*`, `V3-*`, `DS-*`), and non-regression guardrails.

### Stage 3 — Patch `skill/` & Verify Static Isolation
Run:
```bash
npm test
```
Proceed to Stage 4 ONLY when `validate-isolation.mjs` reports `ALL_DSAF_ISOLATION_AND_INTEGRITY_CHECKS_PASSED`.

### Stage 4 — Execute Blind Isolated A/B Evaluation
Follow [blind-eval-protocol.md](./references/blind-eval-protocol.md) covering pre-flight clarification (`V3-1`, `DS-1`), Tier 0 unknown-env safety (`G8`, `V3-2`), and full execution across `Mode S` (DS Core), `Mode C` (Conformance & Drift), and `Mode P` (Usability + Visual UI Dual-Track), verifying runtime `draft/*.html` cleanly via `audit-runtime.mjs`.

### Stage 5 — Human Promotion Approval or Honest Revert
- Target gate improves AND zero hard guardrails regress -> present A/B delta and diff for maintainer approval.
- Any regression -> revert cleanly and record the honest negative result in [benchmark.md](./benchmark.md) so dead ends are never repeated.

### Stage 6 — Benchmark Log, Version Bump & Skill Sync
Update version headers if releasing, log verified numbers in [benchmark.md](./benchmark.md), and sync locally:
```bash
npm run sync:skills
```

## 3. References
- [evolution-gates.md](./references/evolution-gates.md)
- [blind-eval-protocol.md](./references/blind-eval-protocol.md)
- [feedback-schema.json](./references/feedback-schema.json)

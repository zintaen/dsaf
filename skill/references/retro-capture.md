# Retrospective & Field Signal Capture (`retro` Mode — Tier 1 -> Tier 2 Bridge)

Load this guide ONLY when the user invokes `/dsaf retro` or gives direct post-audit corrections on how the audit framework performed.

---

## 1. Strict Non-Mutation Separation

- **Tier 1 (`dsaf`) NEVER edits `skill/` specs, scripts, or rubrics mid-audit or during `retro`.** Unverified ad-hoc edits cause silent regression, bloat, and overfitting to one project.
- Instead, `retro` writes strictly **anonymized, domain-stripped** structured signals to a local append-only log (`~/.dsaf/feedback-log.jsonl`, or a user-specified path).
- When 3+ signals (or a high-severity cluster) accumulate, the separate **Tier 2 Maintainer Skill (`/dsaf-evolve`)** mines them alongside calibration corpus gaps, drafts ONE atomic hypothesis at a time, runs blind isolated Evaluator/Grader A/B gates, and requires explicit maintainer sign-off before releasing the next version.

---

## 2. Signal Categories

| Category | Meaning | Domain-Stripped Example |
|---|---|---|
| `false_positive` | Agent flagged an issue that was not actually a defect | Flagged a debounced filter input as broken without waiting >= 1s |
| `false_negative` | Human reviewer caught a genuine defect the agent missed | Missed focus trap failure inside a nested drawer modal |
| `ds_drift_signal` | Token drift, N-of-1 clustering, or DTCG probe misclassified valid styling or missed real drift | Flagged dynamic runtime CSS vars defined via JS theme provider as orphan variables |
| `ambition_gap` | Proposals were too timid or overly disruptive relative to maturity | Suggested micro-spacing tweaks on a crude Tier 1 MVP needing structural IA |
| `depth_or_persona_gap` | Report compressed, insufficient personas, or missed 7-state edge cases | Compressed tail walkthroughs and omitted `100+` item dataset testing |
| `process_or_safety_friction` | Step 0 clarification gate, tier lock, or workflow caused avoidable friction | Failed to detect remote BaaS calls on localhost before attempting Tier 2 CRUD |
| `design_taste_signal` | Owner systematically preferred or rejected a proposed redesign pattern | Accepted compact mobile inline composer with opt-in bulk selection over permanent action bars |

---

## 3. Mandatory Anonymization Checklist

Before writing ANY line to `~/.dsaf/feedback-log.jsonl`, strip all identifying context:
- Remove repo names, brand/product names, domains, URLs, filesystem paths, custom routes, and proprietary copy.
- Replace product specifics with generic archetypes (`"b2b_web_app"`, `"consumer_mobile_web"`, `"design_system_library"`, `"cli_tool"`).
- Remove emails, usernames, tokens, or PII.
- Formulate `candidate_hypothesis` as a **universal rule applicable to any target**.

---

## 4. JSONL Record Format (`dsaf/feedback-record.v1.json`)

Each line in `~/.dsaf/feedback-log.jsonl` must match:

```json
{
  "id": "FB-20261126-001",
  "timestamp": "2026-11-26T10:00:00Z",
  "skill_version": "0.2.1",
  "mode": "conformance",
  "round": "visual",
  "language": "en",
  "product_archetype": "consumer_mobile_web",
  "ui_maturity": "tier_2_baseline",
  "data_tier": "tier_2_sandbox",
  "category": "ds_drift_signal",
  "severity": "medium",
  "symptom": "Token scanner counted @theme color definitions inside modern CSS layers as hardcoded literals.",
  "root_cause_pointer": "CSS block detector only ignored :root and missed @theme / @layer token blocks.",
  "candidate_hypothesis": "Exclude :root, [data-theme], and @theme declaration blocks before counting hardcoded style literals.",
  "affected_artifact": "audit-tokens.mjs"
}
```

### Allowed Enums
- `mode`: `"system" | "conformance" | "product"`
- `round`: `"preflight" | "system" | "conformance" | "usability" | "visual" | "full" | "handoff"`
- `language`: `"en" | "vi" | "other"`
- `ui_maturity`: `"tier_1_crude" | "tier_2_baseline" | "tier_3_mature" | "unknown"`
- `data_tier`: `"tier_0_readonly" | "tier_1_staging" | "tier_2_sandbox" | "tier_3_branch" | "unknown"`
- `category`: `"false_positive" | "false_negative" | "ds_drift_signal" | "ambition_gap" | "depth_or_persona_gap" | "process_or_safety_friction" | "design_taste_signal"`
- `severity`: `"high" | "medium" | "low"`

---

## 5. Execution Steps

1. Review user corrections from the completed run.
2. Separate **project-local preferences** (recommend saving in the target repo's own docs/rules, NOT in `feedback-log.jsonl`) from **general framework improvements**.
3. Draft 1 to 5 scrubbed records matching Section 4.
4. Show the scrubbed JSONL entries to the user and append them to `~/.dsaf/feedback-log.jsonl` (creating `~/.dsaf/` if absent).
5. Note that whenever >= 3 signals accumulate, the maintainer can run **`/dsaf-evolve`** (`npm run evolve:mine`) in the DSAF repository to test hypotheses through blind A/B gates.

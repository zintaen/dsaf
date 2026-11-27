<!-- Version 0.9.3 (2026-11-27). English canonical specification for DSAF Product Usability Audits (Mode P & Mode C Round 1). Automatically mirror the user's conversation language across reports, UI copy checks, and previews unless explicitly overridden. -->

# Usability Evaluation & Redesign Using Multi-Axis Personas, Tasks, and a Weighted Rubric

## Input Information

Fill in the fields below or provide them in your prompt. Any missing or bracketed field is inspected via read-only `recon.mjs` and confirmed once at Step 0 before starting.

- **Product and access:** [URL, build, source repository path, screenshots, or design files; test account if applicable]
- **Target mode:** [Mode P Product without DS | Mode C Product consuming a DS] (default: auto-detected in Step 0 via `recon.mjs`)
- **Data mutation permission tier:** [Tier 0 Strict Read-Only | Tier 1 Shared Staging Safe-Create without deletes | Tier 2 Local Sandbox Full CRUD + `T2-Mock` + 5 Synthetic Edge Datasets | Tier 3 Isolated Branch or Worktree] (default: confirm at Step 0; if bypassed without explicit confirmation, strictly enforce Tier 0)
- **Target platform and viewports:** [desktop only (`1440px`) | mobile only (`375px`) | both desktop-first | both mobile-first | native desktop app | command-line interface] (default: confirm at Step 0)
- **Transformation ambition level:** [Level 1 Surgical Polish | Level 2 Structured Upgrade | Level 3 Breakthrough Redesign dual-track with Track A Pragmatic Fix and Track B North-Star + optional `(+SG)` Starter DS / Guardrails] (default: infer UI maturity at Step 0 to recommend and confirm)
- **Audit depth and persona scope:** [Quick/Standard: `5+` minimum baseline personas, all core journeys | Deep-Dive Uncapped: `8+` signal-driven orthogonal personas (`dsaf personas` + `.dsaf/personas.custom.json`), full step-by-step cognitive traces, full specs for Moderate findings, 5-file dossier] (default: Deep-Dive Uncapped)
- **Real users and existing data:** [known user groups; usage analytics, feedback, support tickets, prior research]
- **Goals, constraints, and custom weights:** [priority tasks; suspected friction journeys; custom overrides for the 6-pillar Usability Rubric weights]
- **Before/After previews and sign-off loop:** [on: interactive Canonical Preview Shell HTML drafts in isolated `draft/` folder | text report only] (default: on)
- **Previous evaluation:** [optional: prior report or `scores.json` for re-evaluation + `audit-diff.mjs` no-silent-regression gate]
- **Step 0 clarification gate mode:** [pause to confirm missing choices | `--auto` straight-through] (default: pause to confirm)
- **Report format & language:** [multi-file dossier (default when file writing is available) | single markdown file; reply & report in the user's conversation language]

## Task

Conduct a deep, evidence-backed evaluation of usability, information architecture, task efficiency, accessibility, and real-world edge resilience for the product above by walking realistic tasks across a multi-axis persona matrix. Uncover where real users stall, err, expend avoidable effort, or lose state; score the product transparently using the deterministic weighted rubric (`compute-scorecard.mjs`); and propose concrete upgrades scaled from surgical fixes to dual-track breakthrough prototypes inside an isolated `draft/` folder before modifying product code.

The primary audience is a product owner or engineer who is technically strong rather than a UX specialist. Ground every finding in verifiable observation, briefly explain UX terms on first mention, separate observation from inference and simulation, and never pad or compress evidence. This is a simulated expert evaluation used to prioritize fixes and target real-user validation — never cite simulated outcomes as observed production metrics.

## Mandatory Principles

1. **Separate three types of content.**
   - *Observation:* what you directly observed or measured on the running app, screenshots, verbatim UI copy, computed DOM geometry/styles, or source code.
   - *Inference:* your hypothesis of root cause or likely user impact requiring validation.
   - *Simulation:* persona steps, expectations, and quotes tagged `(simulated)` in outputs — NEVER presented as real-user data. Frame behavioral predictions conditionally (`"is likely to..."`), never as historical events (`"users abandoned..."`).

2. **Every finding rests on verifiable evidence:** exact screen/URL, component/region, journey step, viewport, theme/display mode, verbatim copy, reproduction steps, and observation source. Unobserved hypotheses belong in Open Hypotheses, not Detailed Findings.

3. **Use the strongest available observation source and verify live behavior rigorously:** (a) operating the running product in Chromium; (b) screenshots/specs; (c) source code; (d) user description. Never infer layout, prominence, color, or legibility from source code alone; measure element contrast directly on rendered DOM (never extrapolate visually from sibling elements). Tag anything known only from source code as `"from source code, not seen at runtime"`. Wait at least 1 second after async transitions, modal opens, permission requests, theme switches, or audio/network triggers before judging state, and check all screen regions for status notices and ARIA states (`aria-pressed`, `disabled`, network responses). When checking dialogs, verify `role="dialog"`, `role="alertdialog"`, or native `<dialog>`. Before calling a panel/picker clipped and unscrollable, check inner scroll containers (`scrollHeight > clientHeight` with `overflow-y: auto|scroll`) and test scrolling directly. When judging search/filter latency or correctness, compare actual rendered item text and counts immediately after typing and again after the list has stabilized for >= 1 second (never rely solely on fixed paginated row counts).

4. **Never fabricate numbers, citations, or vibe scores.** Cite only counts and measurements recorded directly in this run (`steps`, `fields`, `ms`, `px`, `contrast ratio`, `Apca Lc`, `axe counts`). Score `U01–U18` strictly on discrete `0 / 1 / 2 / N/A` via `compute-scorecard.mjs`, linking every score `< 2` to verified Finding IDs.

5. **Lock claim scope tightly; mark untested states explicitly.** Every pass/fail claim covers ONLY the exact screens, viewports, light/dark modes, text sizes, open/closed collapsibles, and keyboard/pointer sequences directly tested. Mark untested assistive tech or gated states `"not tested"` with the reason.

6. **Persona epistemic isolation:** Personas act and think solely from rendered screen context and stated background — NEVER leak source internals, hidden DOM attributes, internal URLs, browser storage, or prior developer exploration into persona knowledge.

7. **Unbiased calibration:** Record `"uncertain"` when persona success is genuinely ambiguous. Never pad minor glitches into Major/Blocker, and never downgrade genuine defects merely to shorten reports. For borderline severities, document the exact boundary condition that raises or lowers impact.

8. **Requester context:** Attribute factual goals/constraints from the requester; treat subjective assumptions (`"users already know this"`) as testable hypotheses.

9. **Four-Tier Data Safety & Draft Isolation:** Across ALL tiers (`T0–T3`): never modify product source code prior to explicit owner sign-off and implementation approval; isolate all HTML/CSS prototypes inside `draft/`; never execute real payments or click external payment/donation/production links (inspect `href` and label read-only); never send external emails/SMS/notifications; never enter real PII. Strictly obey confirmed Data Tier limits from `step0-intake.md` (`T0 Read-Only` enforced strictly on unconfirmed environments/bypasses; `T2-Mock` route interception blocking remote cloud `POST/PUT/PATCH/DELETE` whenever `localhost` connects to a remote cloud DB so `realCloudWrites === 0`).

10. **Mandatory Step 0 Recon & Clarification Gate:** Follow [step0-intake.md](./step0-intake.md) before Step 1. Discover topology (`Mode S/C/P`), stack, live themes, `375px` clipping, cloud persistence risk, and UI Maturity upfront via `recon.mjs`, then pause ONCE to confirm ambiguous parameters.

## Process

### Step 0. Fast Recon & Pre-flight Clarification Gate
Execute `node ./scripts/recon.mjs <target>` plus read-only live inspection per [step0-intake.md](./step0-intake.md). Confirm Target Mode (`P` or `C`), Scope, Viewports, Data Tier (`T0–T3`), Ambition Level (`L1–L3 / +SG`), Depth (`Q/D`), and baseline `scores.json` before starting Step 1.

### Step 1. Map Product, Select Domain Weights & Inventory Journeys
- Survey product problem, target users, core value proposition, workflows, and user roles within confirmed Data Tier.
- Detect platform conventions (responsive web, desktop shortcuts/windows, mobile touch targets >= 44px and safe areas, pointer vs touch).
- Choose the matching Usability Domain Weight Preset from [scoring-model.md](./scoring-model.md) (`dev_b2b`, `consumer_mobile`, `commerce_forms`, `content_docs`, `balanced`; pillars P1..P6 sum strictly to 100).
- Inventory all reachable screens, routes, roles, and journeys ranked by core value, frequency, and failure cost. Define journey completion criteria, map 5 synthetic datasets (if `T2`/`T3`), and record exact test conditions.

### Step 2. Build Multi-Axis Persona Matrix
Identify user groups from evidence first, then domain context, flagging low confidence where unverified. Cover ALL **5 behavioral axes** even on single-role apps:
1. *Role & Core Goal* (primary actor, evaluator/viewer, admin/operator).
2. *Expertise & Frequency* (novice unfamiliar with domain jargon vs daily power user seeking shortcuts/speed).
3. *Device, Modality & Connectivity* (wide desktop, one-handed `375px` mobile, keyboard-only/AT user, slow/flaky network).
4. *Accessibility & Situational Stress* (low-vision `200%` zoom, color-vision deficiency, older/low-tech user, hurried/interrupted user).
5. *Edge, Heavy-Data & Error-Prone* (`100+` item load, malformed/long accented inputs, privacy/undo-cautious user).

Match persona count to confirmed depth and measured product complexity: use **Standard (`5+` minimum baseline)** vs **Deep-Dive (`8+` minimum orthogonal personas — uncapped, expanding with distinct roles/routes/signals and custom roles in `.dsaf/personas.custom.json` or `node ./scripts/generate-personas.mjs`)**. Never invent an artificial upper ceiling, and never pad with duplicate clones: every persona MUST expose distinct friction across behavioral axes. Document ID, name, axis, basis, goal, device/context, knowledge, expectations, limits, frequency, plus unrepresented user groups.

### Step 3. Design Task Scenarios & Map 5 Synthetic Edge Datasets
Write realistic goal-oriented tasks (never leaking exact UI button labels) spanning: first 60s clarity & empty-state activation, core value journeys end to end, search/filter/sort/CRUD, error prevention/recovery/undo/offline, repeat/keyboard/batch workflows, and supporting steps (auth, settings, permissions). Walk every core journey with >= 3 personas across distinct axes in Deep-Dive mode (`>= 2` in Standard). In `T2`/`T3`, explicitly bind the **5 synthetic datasets** (empty `0`, minimal `1`, `100+` heavy load, >60-char diacritics + large numeric torture, 3s slow/`422`/`500`/offline/`401` fault injection).

### Step 4. Execute Walkthroughs, Capture Cognitive Traces & Baseline Metrics
Operate the live product across every confirmed Persona × Task pair, viewport, theme, and key state, recording answers to all **5 cognitive walkthrough questions** at every meaningful step:
1. Does the persona know what to do next?
2. Can they see the required control (position, fold, prominence)?
3. Do they recognize the label/icon as matching their goal?
4. After acting, does feedback arrive promptly (< 400ms / loading status) and clarify what happened & what comes next?
5. If they make a mistake or change their mind, can they spot and undo it without data loss?

Exercise the **7-state edge matrix** (empty, slow, dense/long text, mid-flow reload/back, validation/server errors + input preservation, complete + next step, offline/expired/denied). In `T1–T3`, whenever a workflow depends on a selector that is empty, test submit behavior once to detect orphan-record bugs.

Record repeatable **baseline metrics**: shortest-path step/field/decision count, inputs lost after error, keyboard-inaccessible controls, unlabeled form controls, lowest rendered contrast across modes/open collapsibles (`WCAG >= 4.5:1` / `3.00:1` UI borders + `APCA Lc` + `pixelBehind` via `audit-runtime.mjs`), smallest effective mobile tap target (`>= 44.0 px` including wrapping `<label>` and `::before/::after` plus open overlays), `0px` overflow at `375px` and `200%` zoom, and live `axe-core` output. Mark untested real AT checks `"not tested"`.

Write **Full Cognitive Walkthrough Traces** for **100% of Persona × Task runs** — explicitly preserving complete step-by-step depth through the final runs in File `01` (never compress tail entries into single lines!), including screen state, all 5 cognitive answers, `(simulated)` thoughts, outcome (*completed easily / completed after hunting / needed help / failed / not tested*), confidence, and Finding IDs.

### Step 5. Synthesize Findings Across `U01–U18` & Compute Weighted Scorecard
- **Root-Cause Merging Discipline:** Merge into one Finding ID ONLY when sharing BOTH exact technical root cause AND exact same fix; split distinct components or fixes into separate Finding IDs before scoring. Never duplicate finding specs in appendices (cite IDs only).
- Audit thoroughly across all 18 criteria `U01–U18` in [scoring-model.md](./scoring-model.md) (including U14 AI-copy tells: canned greetings, hype `!`, baseline-less deltas like `"+12%"`, mixed sibling numeric precision, unverified claims).
- Include 3 separate rationales (`Severity (reason)`, `Confidence (reason)`, `Effort (concrete basis)`) for 100% of findings (full deep-dive specs for Blocker/Major/Moderate; compact evidence format for Minor).
- Run `node ./scripts/compute-scorecard.mjs --input <scorecard-input.json> --format markdown` passing `finding_severities` and `hard_floor_blockers` (enforcing `U18`/data-loss Hard Floor). Document existing strengths to preserve.

### Step 6. Design Improvements by Confirmed Ambition Level (Dual-Track Ready)
Express every fix concretely (`current -> proposed`, plus consolidated Before -> After microcopy table when >= 2 copy issues exist):
- **`Level 1` Surgical Polish:** Smallest fix solving root cause (labels -> layout/status -> flow -> new capability).
- **`Level 2` Structured Upgrade:** Reorganize screens, navigation, and forms systematically within current paradigm.
- **`Level 3` Breakthrough Redesign (Dual-Track):** Present both:
  - **Track A — Pragmatic Fix:** Fixes all Blocker/Major/Moderate defects cleanly inside existing architecture.
  - **Track B — North-Star Redesign:** Rethinks IA, screen decomposition, progressive disclosure, quick command bars, and workflows for class-leading UX without inventing unrelated product features — while keeping mobile `375px` rest states compact (opt-in bulk selection, collapsible composers, crisp status toggles).
Verify fixes across personas so helping novices never cripples power users.

### Step 7. Prioritize by Impact, Exact Rubric Point Delta & Effort
Derive exact point gains directly from `compute-scorecard.mjs` (`Pts/Step` and `Before -> Track A -> Track B` deltas). Bucket every work item into **Do Now**, **Plan Next** (separating Track A vs Track B), **Do When Convenient**, and **Defer**, plus sequencing, dependencies, and sign-off decisions.

### Step 8. Real-User Validation & Telemetry Plan
Pair repeatable script baselines with targeted qualitative usability test protocols and product telemetry funnels for low-confidence or high-cost `Track A vs Track B` decisions. Never fabricate real-user benchmarks.

### Step 9. Interactive Canonical Previews, Visual Handoff Constraints & Owner Sign-Off
Scale interactive preview coverage (`up to 5 screens -> all changed screens`; `> 5 screens -> all Blocker/Major journey archetypes + pattern sheet`). Clone [preview-shell.html](../resources/preview-shell.html) per [preview-shell-contract.md](./preview-shell-contract.md) inside isolated `draft/` using authentic real Before data (long/accented text, huge numbers, `default/empty/stress/error` states, working controls & shortcuts). Run the **Fresh-Context Reverse Regression Check** (*"What did Before do better than Track A / Track B?"*) and run `node ./scripts/audit-runtime.mjs <draft-dir>` across `1440px`, `720x450`, and `375px` in Light/Dark confirming `0` shell failures, `0` axe errors, `>= 4.5:1` / `>= 3.00:1` borders, `>= 44.0 px` mobile targets, `0px` overflow, and zero closed-drawer focus leaks.

Emit the **Visual UI Handoff Constraints** block (locking approved labels, banned jargon, step order, preserved strengths, recommended track, and minimum a11y/tap floors) plus **3–6 Sign-Off Discussion Points**. Only after explicit owner sign-off, emit the **Post-Signoff Implementation Handoff Spec** covering exact source files, **Kept Wiring Inventory** (`a[href]`, `form`, `[name]`, `[id]`, `[data-testid]`), and **Repo Lint & Test Contract Scan**, modifying real repo source only when explicitly asked.

If re-evaluating after fixes (`--baseline`), compare identical metrics side by side, run `audit-runtime.mjs --wiring-before ... --wiring-after ...`, and run `node ./scripts/audit-diff.mjs --baseline <old-scores.json> --current <new-scores.json>`.

### Step 10. Pre-Delivery Reconciliation Self-Check
Confirm programmatically before delivery: Step 0 & Tier `0–3` safety obeyed; zero tail walkthrough compression; every score `< 2` maps to Finding IDs in `compute-scorecard.mjs`; every cited `.png`/`.json`/`.html` artifact exists on disk; all broad coverage claims and `axe` totals match raw logs; every finding at every severity has 3 separate rationales (`Severity`, `Confidence`, `Effort`); 100% of `draft/*.html` passed `audit-runtime.mjs`.

## Output Structure

When file writing is available (default), emit a **5-file structured dossier** (`audit-output/usability/` + `draft/` + `scores.json`):
- **File `00-executive-scorecard-signoff.md`:** Executive Summary, Scope/Data Tier/Weights, `U01–U18` Weighted Scorecard (Before / Track A / Track B), and Sign-Off Discussion Points.
- **File `01-personas-and-walkthroughs.md`:** 5-Axis Persona Matrix, Summary Matrix, and Full Step-by-Step Cognitive Traces (100% uncompressed).
- **File `02-detailed-findings.md`:** Master Summary Table, Full Deep-Dive Specs (100% Blocker/Major/Moderate + compact Minor), Root-Cause Themes, and Strengths to Preserve.
- **File `03-roadmap-redesign-handoff.md`:** Prioritized Action Plan (with exact `Pts/Step` deltas), Validation Plan, Flow Previews, Consolidated Microcopy Table, Visual UI Handoff Constraints, and Post-Signoff Handoff template.
- **File `04-appendix-and-evidence.md`:** Unmerged functional bugs (ID refs only if already in File `02`), Open Hypotheses, 5 Synthetic Edge Datasets report, `audit-runtime.mjs` / `axe-core` JSON summary, and File/Screenshot Inventory.

In chat-only mode or when single-file output is requested, preserve all 10 sections cleanly in sequence without compression.

# Step 0 — Fast Read-Only Recon & Clarification Gate (`v0.2.0`)

Always execute this gate at the start of every DSAF run BEFORE creating `audit-output/`, scoring criteria, writing `draft/` previews, or running state-mutating interactions.

**Language Rule:** Mirror the requester's conversation language cleanly across the summary, decision table, trade-offs, recommendations, and fast reply cue.

---

## 1. Purpose

Audits fail when an agent silently assumes wrong constraints — treating an established design system repo like a consumer app, treating a crude MVP lacking a DS as failing enterprise RFC governance, auditing desktop-only when users are mobile-first, or triggering real cloud/OS side effects on `localhost`.

**Golden Rule:** Discover everything objective in a ~30-second Tier 0 read-only scan (`recon.mjs` + live Tier 0 DOM check if a URL is running), then **PAUSE ONCE** to confirm only missing or ambiguous user parameters using **Concrete Options · Trade-offs · Evidence-Backed Recommendations**.

---

## 2. Fast Read-Only Recon Checklist (Strictly Tier 0 Safe)

Run `node ./scripts/recon.mjs <repo-or-url> --out <tmp-dir/recon.json>` (plus read-only Playwright inspection when a live URL/build is provided):

1. **Topology Detection (`Mode S` vs `Mode C` vs `Mode P`):**
   - **`Mode S` (Design System Core):** Repository exports UI components/tokens or ships a token catalog (`*.tokens.json`, `tokens.css`), Storybook (`.storybook/`, `*.stories.*`), component contracts/docs, and package exports without primary product routes.
   - **`Mode C` (Product-on-DS Conformance & Drift):** Application repo consuming an internal/external design system dependency, structured DTCG token package, Tailwind `@theme` tokens, Figma Code Connect files, or a dedicated token stylesheet (`tokens.css` / `variables.css`). *(Local feature CSS custom properties alone do NOT promote an ad-hoc app to `Mode C`.)*
   - **`Mode P` (Product UX/UI Without a Formal DS):** Application/website with routes and screens but ad-hoc styling and no formal design system or token pipeline.
2. **Stack, Responsive Capabilities & Rendered Display Modes:**
   - Traverse live `cssRules` recursively (including nested `@layer` / `@supports`) when inspecting a live app.
   - **Dead-CSS Guard:** Verify supported themes (Light/Dark/High-Contrast), font-size toggles, and languages directly on the **rendered UI** (opening read-only theme menus without saving is Tier 0 safe) — NEVER infer theme counts via regex scraping over unused CSS stylesheets.
   - **True Narrow-Viewport Clipping (`375px`):** Measure `document.body.scrollWidth`, visible child wrapper `scrollWidth > clientWidth`, and element bounding boxes (`rect.left < 0 || rect.right > innerWidth`) — never trust `documentElement.scrollWidth` alone when `overflow: hidden` hides clipping.
3. **Environment & Cloud / Host-OS Isolation Check:**
   - Identify production domains (`Tier 0`), staging/preview URLs (`Tier 1`), or local sandbox (`localhost` / `127.0.0.1` -> candidate for `Tier 2`).
   - Always inspect environment config keys read-only (never log secret values!) and browser network traffic on `localhost` to detect whether local builds still write to real host-OS files, local shared DBs, or live **remote cloud backends** (e.g., BaaS REST/RPC/GraphQL endpoints). Whenever remote persistence exists on `localhost`, default to **`T2-Mock`** (browser route interception blocking remote `POST`/`PUT`/`PATCH`/`DELETE` calls so `realCloudWrites === 0`).
4. **Scale & Fragmentation Snapshot:** Rough screen/route/story count, rough CSS/token counts, test/lint scripts present, prior `scores.json` if re-auditing.
5. **UI / System Maturity Classification:**
   - **Maturity Tier 1 — Crude / Ad-Hoc:** Weak hierarchy, patchwork controls, fragmented styling -> auto-recommend Ambition `L3` Dual-Track + Starter DS Spec if `Mode P`.
   - **Maturity Tier 2 — Functional Baseline:** Working flows/tokens but visible drift, friction, or partial coverage -> auto-recommend `L2` Structured Upgrade (or `L3` when structural bottlenecks exist).
   - **Maturity Tier 3 — Mature System/Product:** Coherent system and flows -> auto-recommend `L1` Surgical Polish + strict `audit-diff` regression gating.

---

## 3. When to Pause vs When to Bypass

- **PAUSE at Step 0 (Default):** Whenever ANY of the 6 dimensions below is missing or ambiguous in the user's request. Present one crisp Clarification Brief and wait for confirmation before Step 1.
  - **Pause Hygiene Invariant:** Save ONLY read-only `recon.json`, recon screenshots (in temp/scratch), and the Brief — NEVER create `audit-output/`, scorecards, findings, or `draft/*.html` prior to confirmation.
- **BYPASS Step 0:** Only when (a) the user explicitly supplied all critical parameters upfront, OR (b) the user explicitly passed `--auto` / asked to proceed directly with recommended defaults.
- **Mandatory Bypass Safety Lock:** If Step 0 is bypassed WITHOUT an explicitly confirmed data mutation tier, **strictly lock execution to `T0` (Strict Read-Only) — even on `localhost`**. Never escalate to `T1/T2/T3` without explicit confirmation.

---

## 4. Standardized Clarification Brief Format (1 Turn)

Translate headings, labels, trade-offs, and recommendations naturally into the user's language, keep ONLY rows that are missing or ambiguous, and use compact codes (`S/C/P`, `US/UI/DS/Full`, `1A–1D`, `T0–T3`, `L1–L3/+SG`, `Q/D+diff`) so a 1-line reply works cleanly:

```markdown
### Step 0 — Fast Read-Only Recon & Clarification Gate (Before Auditing)

**Read-Only Recon Summary (Tier 0):**
- **Detected Topology & Maturity:** <Mode S / C / P> · <Tier 1 Crude / Tier 2 Baseline / Tier 3 Mature> — <1-sentence measured recon evidence>
- **Product / System & Stack:** <framework, styling/token files, Storybook/Code Connect signals, approximate screen/story count>
- **Verified Runtime Capabilities:** <desktop/mobile responsiveness, live verified themes, `375px` check, existing lint/test contracts>
- **Environment & Isolation Risk:** <localhost / staging / production — explicit note on remote cloud API `T2-Mock` or host-OS safety>

Before I start the audit, please confirm the parameters below:

| Parameter | Options | Trade-offs | Recommendation |
|---|---|---|---|
| **1. Target Mode** | `(S)` Design System Core · `(C)` Product + DS Conformance/Drift · `(P)` Product UX/UI (no DS) | Mode S judges library maturity (`DS01–DS12`); Mode C adds token/override/N-of-1 drift to UX/UI; Mode P skips corporate DS overhead while optionally designing a starter system | **`<S / C / P>`** — <recon evidence> |
| **2. Audit Scope** | `(US)` Usability · `(UI)` Visual UI · `(DS)` Tokens/Components/Drift · `(Full)` Full Chained Suite | Focused modules finish faster; chaining Usability -> Handoff Constraints -> Visual UI/DS prevents polish from breaking workflows | **`<US / UI / DS / Full>`** — <scope rationale> |
| **3. Platform & Viewports** | `(1A)` Desktop (`1440px`) · `(1B)` Mobile (`375px`) · `(1C)` Both (Desktop-first) · `(1D)` Both (Mobile-first) | Single viewport deepens platform ergonomics; testing both catches responsive overflow & `< 44px` tap failures | **`<1A..1D>`** — <viewport rationale> |
| **4. Data Mutation Tier** | `(T0)` Strict Read-Only · `(T1)` Staging Safe-Create · `(T2)` Local Sandbox + `T2-Mock` + 5 Synthetic Datasets · `(T3)` Isolated Worktree | `T0` guarantees zero mutation but skips post-submit/edge tests; `T2 + T2-Mock` tests `100+` rows & `422/500` faults safely with zero cloud writes | **`<T0..T3>`** — <isolation rationale> |
| **5. Ambition & Deliverables** | `(L1)` Surgical Polish · `(L2)` Structured Upgrade · `(L3)` Breakthrough Dual-Track (`draft/` HTML) · `(+SG)` Add Starter DS Spec & Executable CI Guardrails | `L1` minimizes code churn; `L3` lets you compare Pragmatic vs North-Star side-by-side in HTML; `+SG` outputs runnable lint/token rules | **`<L1..L3 [+SG]>`** — <maturity rationale> |
| **6. Depth & Baseline Diff** | `(Q)` Quick (`DSAF-25` / 5–7 personas) · `(D)` Deep-Dive (`Full` / 8–12+ personas, 5-file dossier) · `(+Diff)` Enforce `audit-diff` against prior `scores.json` | Deep-Dive prevents report compression and uncovers edge/a11y flaws; `+Diff` blocks silent regressions across releases | **`<(Q|D) [+Diff]>`** — <depth rationale> |

*Quick 1-line reply example (in your language): "Accept all recommendations" or "Proceed with recommendations, but use 1C, T2, L3+SG".*
```

---

## 5. Reference Definitions: 4 Data Tiers & 5 Synthetic Edge Datasets

### Absolute Invariants Across ALL Tiers (`T0–T3`)
- NEVER modify committed product source code or repo configs prior to explicit owner sign-off and implementation request.
- Write all interactive HTML/CSS prototypes solely inside an isolated `draft/` folder outside product source code.
- NEVER execute real financial transactions, NEVER click external payment/donation/production links (inspect `href`/labels read-only), NEVER send real emails/SMS/notifications, and NEVER enter real PII.

### Data Mutation Matrix
| Tier | Name | Allowed Actions | Forbidden Actions |
|---|---|---|---|
| **Tier 0** | Production / Unknown (`Read-Only`) | Navigate, read, measure DOM/CSS/pixels, Tab focus inspection, read-only accordions/menus without saving | Any form submit (incl. browser localStorage), create/edit/delete/cancel, external links, auth bypass |
| **Tier 1** | Shared Staging (`Safe-Create`) | Submit non-destructive forms with clearly labeled synthetic test records to inspect post-submit UI | Deleting/editing pre-existing records, irreversible actions, payments |
| **Tier 2** | Local Sandbox (`Full CRUD + T2-Mock + 5 Edge Datasets`) | Full create/edit/delete lifecycle, fake test accounts, delete/undo verification, `T2-Mock` route interception blocking remote `POST/PUT/PATCH/DELETE` when localhost talks to cloud DBs (`realCloudWrites === 0`), and synthetic edge seeding | Real payments, clicking external links, real emails/notifications, unmocked remote cloud writes, real PII |
| **Tier 3** | Isolated Branch / Worktree | All Tier 2 permissions + temporary local fixture scripts/mock servers inside an isolated worktree copy | Modifying main/production branch, real external side effects |

### 5 Synthetic Edge-Case Datasets (Seeded in `T2` / `T3`)
1. **Empty (`0 items`):** First-run activation and empty-state clarity.
2. **Minimal (`1 item`):** Singular copy, layout balance, delete-last-item recovery.
3. **Heavy Stress (`100+ items`):** Pagination, virtual scroll, search latency (verifying rendered text changes after >= 1s stability, not fixed row counts), sticky headers, and density crowding.
4. **Typography & I18n Torture:** 60–100+ character names with heavy diacritics/accents, unbroken strings/URLs, 12+ digit numbers/currency, special chars (`<>&"'—`) testing truncation, wrapping, `tabular-nums`, and overflow.
5. **Fault Injection:** Route interception / offline emulation simulating 3s latency skeletons, HTTP `422` validation errors, HTTP `500` failures, offline drops, and `401` session expiry confirming input preservation and recovery paths.

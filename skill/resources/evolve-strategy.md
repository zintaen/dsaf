# DSAF Repository Auto-Evolution Strategy (`v0.9.2`)

Pinned downstream governance profile aligned with `zintaen/auto-evolve-strategy v1.2.0` (C1–C10 + A7.5/A9.4/A12) for autonomous Design System & UX refinement loops bootstrapped via `dsaf init`.

## Core Principles (C1-C10)

1. **C1 · Verification-Driven Promotion**: Every UI, style, or token edit MUST pass deterministic measurement (`dsaf check`, `dsaf tokens`, `dsaf hook check`, `dsaf figma-diff`, `dsaf runtime`) before being kept.
2. **C2 · Red-to-Green Proof (Test-Must-Fail-Without-Fix)**: Record the baseline failing finding/metric before applying a fix, and prove the exact check passes after the change.
3. **C3 · Adversarial Verifier Separation**: Treat the proposing coding agent and the verification runner (`audit-tokens`, `dsaf-hook`, `audit-runtime`, `audit-diff`) as separate roles; never self-certify visual fixes without running Playwright/static gates.
4. **C4 · Protected Files & Decision Queue**: Files listed under `protectedFiles` in `.dsaf/rules.json` (design tokens, core layout primitives, CI gates, `.dsaf/` governance) MUST NOT be weakened silently. Architectural trade-offs go into `.dsaf/decision-queue.md` for human review.
5. **C5 · Kill-Switch, Atomic Lease & Circuit Breakers**:
   - Creating `.dsaf/STOP` or `.evolve/STOP` halts every autonomous optimization loop at the next step boundary.
   - Concurrent sessions take an atomic numbered local lease (`.dsaf/lease.<n>`, `A9.4`) created exclusively (`wx`) and released by writing `owner: none` (keeping `integration:`).
   - Reaching `maxConsecutiveFailures` (default `2`) trips `.dsaf/circuit-breaker.json` and stops edits until inspected.
6. **C6 · Focused <-> Maintenance Modes**:
   - **Focused Mode**: Resolve a single bounded defect cluster (e.g., Floor focus outlines or hardcoded palette tokens) without sweeping unrelated files.
   - **Maintenance Mode**: Periodically audit `No-Silent-Regression`, prune unused ignore waivers, and confirm `Defined <-> Shipped` parity.
7. **C7 · Measured Fitness Gate**: Promotion requires `Floor === 0`, `Reflex` non-increasing, `APCA >= 60` (body) / `>= 45` (large), `small44 === 0`, and zero regressions on `dsaf diff`.
8. **C8 · Pinned Strategy & Upstream Feedback (`A12`)**: Keep `.dsaf/STRATEGY.md` versioned cleanly; capture domain-stripped rule friction or false positives in `.dsaf/strategy-feedback.md`.
9. **C9 · Atomic Batching & Handoff**: Scope each cycle to `maxFilesPerRound` files and update `.dsaf/handoff.md` (`owner:` + `state:` current-state block + append-only log) with verified commands, failing baseline, and next step.
10. **C10 · Zero-Waiver Floor & Budget Caps**: Floor violations (suppressed `:focus-visible`, missing button labels, horizontal overflow, clipped controls) cannot be waived automatically; stop on budget exhaustion rather than guessing.

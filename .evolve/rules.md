# Auto-Evolve Rules — `@zintaen/dsaf` (`zintaen/dsaf`)

Governed by `.evolve/STRATEGY.md` (`zintaen/auto-evolve-strategy` Version `1.2.0`).

## A10.0 Tooling & Local Gate

Run commands in order from the repository root. Never skip checks or lower suite pass counts:

1. **Core Integrity & Isolation Gate:** `npm test`
   - Runs `node skill/scripts/check-integrity.mjs` (verifies `skill/` payload, Markdown links, Canonical Preview Shell contract, zero contamination, and all deterministic CLI `--self-test` suites) followed by `node evolve/scripts/validate-isolation.mjs` (verifies CLI parity, schema contracts, version parity, `.evolve/` pinned v1.2.0 invariants, zero host/private leaks).
   - **Pass/Fail parsing:** exits `0` and prints `ALL_DSAF_ISOLATION_AND_INTEGRITY_CHECKS_PASSED` (`0` allowed skips).
2. **CLI & Self-Tests:** `node bin/dsaf.mjs version` + `node bin/dsaf.mjs verify`
   - Exits `0`; version matches `package.json`.
3. **Preview Shell Parity:** `cmp -s skill/resources/preview-shell.html docs/demo/preview-shell.html`
   - Exits `0` (byte-for-byte identical).
4. **Docs Static Dogfood:**
   - `node bin/dsaf.mjs hook check docs/styles.css --tier all --report-unused-ignores` (`Floor=0`, exit `0`)
   - `node bin/dsaf.mjs hook check docs/index.html --tier floor` (`Floor=0`, exit `0`)
   - `node bin/dsaf.mjs tokens docs --json` (`drift.hardcodedColorHits === 0`)
5. **Playwright Runtime & Defect Gate** (when Playwright + Chromium available):
   - `node bin/dsaf.mjs runtime skill/resources/preview-shell.html` (exit `0`, `allPassed: true`)
   - `node bin/dsaf.mjs runtime docs/demo/preview-shell.html` (exit `0`, `allPassed: true`)
   - `node bin/dsaf.mjs runtime docs/index.html --live --skip-shell-check --extended-viewports` (exit `0`)
   - `node bin/dsaf.mjs runtime docs/demo/sample-report.html --live --skip-shell-check --extended-viewports` (exit `0`)
   - `node bin/dsaf.mjs runtime evolve/fixtures/synthetic/mode-p-app/index.html --live` (exit `0`)
   - `node bin/dsaf.mjs runtime --storybook evolve/fixtures/synthetic/storybook-static/index.json` (exit `0`)
   - `node bin/dsaf.mjs runtime evolve/fixtures/synthetic/mode-p-defects/index.html --live` (MUST fail exit `1`)
6. **Packaging & Leak Smoke Test (A4.6 / A10.2):** `npm pack --dry-run`
   - MUST contain only `bin/`, `skill/`, `README.md`, `RELEASE_NOTES.md`, `LICENSE`, `package.json`, and MUST exclude `.evolve/`, `evolve/`, `docs/`, `.github/`.
7. **Secret & Private-Term Scan:**
   - Optional `DSAF_PRIVATE_TERMS` comma list enforced inside `npm test` across tracked text files (always clean).

## A10.1 Identity, Branches, Protected Files & Public Surface

- **Default branch:** `main`
- **Integration branch:** `audit-loop`
- **Maintainer / Approvers:** `zintaen` (GitHub handle; SSH-signed commits + host PR review approval required for protected files and minor/major releases). Note: commits pushed using maintainer SSH signing key (`git commit -S`) verify authenticity; silence is never approval.
- **Outside services (A8.8):** Code/diffs only; zero credentials, personal emails, or internal URLs in prompts, commits, fixtures, or `.evolve/`.
- **Merge rules:** Merge commits on `main` (never rebase or force-push `main` or `audit-loop`).
- **Package exclusion mechanism (A10.2):** `package.json#files` whitelist (`bin/`, `skill/`, `README.md`, `RELEASE_NOTES.md`, `LICENSE`) excludes `.evolve/`, `evolve/`, and `docs/` from npm tarballs. `.gitignore` excludes `.evolve/repro/`, `.evolve/lease.*`, `.dsaf/lease.*`.
- **Lease & Kill Switch:** Local file lease `.evolve/lease.<n>` (`owner: none` when released, `integration: audit-loop`). Kill switch: `.evolve/STOP` on `main` or beside the lease.
- **Protected Files (C4 / A3.4 — maintainer PR only):**
  - `.evolve/STRATEGY.md`, `.evolve/rules.md`, `.evolve/roadmap.md`, `.evolve/templates/**`
  - `package.json`, `.github/workflows/**`, `action.yml`
  - `skill/scripts/check-integrity.mjs`, `evolve/scripts/validate-isolation.mjs`
- **Protected Core Test Targets (A9.2):** `skill/scripts/check-integrity.mjs`, `evolve/scripts/validate-isolation.mjs`, `evolve/fixtures/synthetic/**`, `evolve/fixtures/calibration/**`.
- **Public Surface (A4.2):** `bin/dsaf.mjs` commands & flags, `action.yml` inputs/outputs, JSON schemas (`dsaf-scores/2`, `dsaf-audit/1`, `dsaf-personas/1`, `dsaf-init-rules/1`, `dsaf-runtime/2`), 9 MCP tool names/schemas in `skill/scripts/mcp-server.mjs`, CLI exit codes, `docs/` URLs (`https://zintaen.github.io/dsaf/`, `demo/preview-shell.html`, `demo/sample-report.html`).
- **Version Scheme & Delivery Channels (A11.4):** Semantic Versioning (`0.x.y`); patch/minor/major per `C8`/`A4.2`. Channels: npm Trusted Publishing OIDC (`@zintaen/dsaf`), GitHub Releases (`v*` signed tags), GitHub Pages (`docs/`). Deprecate step: `npm deprecate @zintaen/dsaf@<ver> "<reason>"`.
- **Weekly Digest & Decisions Channel:** Maintainer reviews `.evolve/decisions.md` & PRs on `github.com/zintaen/dsaf`.
- **Ceilings & Rotation (A8.4 / A9.19):** `maxFilesPerRound: 5`, `maxConsecutiveFailures: 2`, `maxLanes: 5`, `triageWeeklyCap: 15`. Independent subagent verification uses separate context/model pass from author; no self-certification.

## A10.4 Audit Areas & Skip List

| Area | Path Globs |
|---|---|
| `cli-and-pipeline` | `bin/**`, `skill/scripts/audit-pipeline.mjs`, `skill/scripts/setup.mjs`, `skill/scripts/mcp-server.mjs`, `skill/scripts/install-skill.mjs`, `skill/scripts/doctor.mjs` |
| `static-scanners` | `skill/scripts/recon.mjs`, `skill/scripts/audit-tokens.mjs`, `skill/scripts/dsaf-hook.mjs`, `skill/scripts/ci-report.mjs`, `skill/scripts/audit-figma-diff.mjs`, `skill/scripts/fix-floor.mjs` |
| `runtime-and-reporting` | `skill/scripts/audit-runtime.mjs`, `skill/scripts/compute-scorecard.mjs`, `skill/scripts/audit-diff.mjs`, `skill/scripts/generate-guardrails.mjs`, `skill/scripts/generate-personas.mjs`, `skill/scripts/generate-html-report.mjs`, `skill/scripts/init-evolve.mjs`, `skill/scripts/evolve-runner.mjs` |
| `skill-specs-and-shell` | `skill/SKILL.md`, `skill/references/**`, `skill/resources/**` |
| `docs-ci-and-evolution` | `docs/**`, `action.yml`, `.github/workflows/**`, `evolve/SKILL.md`, `evolve/references/**`, `evolve/scripts/**`, `README.md`, `RELEASE_NOTES.md` |

- **Skip List:** `.evolve/**`, `node_modules/**`, `docs/assets/*.png`, `evolve/fixtures/synthetic/*/storybook-static/**`, `draft/**`, `audit-output/**`, `.tmp*/**`, `LICENSE`.

## C7 Severity Rubric (Adapted for DSAF)

- **High:** False negative letting Floor defects pass exit `0`, crash/hang on valid repos, path/data loss in `dsaf fix`, leaked private/evolve files into npm tarball or `skill/`, or broken CLI install/startup on Node `>= 20`.
- **Medium:** Wrong score/compliance/drift math on ordinary UI repos, broken Preview Shell / HTML report interactivity or accessibility defect (`APCA < 60`, `axe > 0`, `overflow > 0`), or incorrect SARIF/Action output.
- **Low:** Copy clarity, rare CSS grammar edge cases, optional performance improvements.

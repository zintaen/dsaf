# DSAF — UI, Accessibility & Design Token Audit Toolkit (`v0.9.3`)

[![Website](https://img.shields.io/badge/site-zintaen.github.io%2Fdsaf-14243D)](https://zintaen.github.io/dsaf/)
[![CI](https://github.com/zintaen/dsaf/actions/workflows/ci.yml/badge.svg)](https://github.com/zintaen/dsaf/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@zintaen/dsaf)](https://www.npmjs.com/package/@zintaen/dsaf)
[![Release](https://img.shields.io/github/v/release/zintaen/dsaf)](https://github.com/zintaen/dsaf/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**Website:** [zintaen.github.io/dsaf](https://zintaen.github.io/dsaf/) · **Preview Shell Demo:** [Live Comparison](https://zintaen.github.io/dsaf/demo/preview-shell.html) · **Sample Audit Report:** [Interactive HTML Report](https://zintaen.github.io/dsaf/demo/sample-report.html)

**DSAF** is a zero-dependency Node ESM + Playwright toolkit that catches accessibility blockers, keyboard focus bugs, dark-mode contrast failures, layout clipping, and design token drift — in your terminal, inside your AI coding agent, or on GitHub pull requests.

---

## Quick Start (30 Seconds)

### 1. Check any repository with one command

```bash
npx @zintaen/dsaf check .
# Or pass a path directly:
npx @zintaen/dsaf ./apps/web
```

Export an offline editorial HTML audit report (Scorecard, Persona Impact Matrix, and Tokens tabs):

```bash
npx @zintaen/dsaf audit . --html audit-report.html --out ./audit-output
```

### 2. Install AI Agent Skill & MCP Server (Zero Config Edits)

Installs the portable `dsaf` skill and wires the 8-tool read-only MCP server (`dsaf mcp`) cleanly into Claude, Cursor, Codex, Antigravity, or generic `.agents` clients:

```bash
npx @zintaen/dsaf setup --agent claude
# Or configure all supported clients at once:
npx @zintaen/dsaf setup --agent all --scope user
```

### 3. Preview Before/After Fixes or Enforce on GitHub PRs

```bash
# Preview or apply safe Floor CSS/a11y fixes
npx @zintaen/dsaf fix src --dry-run
npx @zintaen/dsaf fix src --apply --backup
```

```yaml
# .github/workflows/dsaf-gate.yml (floating @v0 channel picks up non-breaking releases automatically)
name: DSAF Gate
on: [pull_request]
permissions:
  contents: read
  security-events: write
  pull-requests: write
jobs:
  dsaf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: zintaen/dsaf@v0
        with:
          target: .
          fail-on-floor: "true"
          upload-sarif: "true"
          comment-pr: "true"
```

### 4. Auto-Update & Distribution for Any External Repo

Any external project (including independent OSS/company repos) stays current automatically without manual tracking:

- **Non-blocking CLI update check:** Interactive CLI commands run a 24h-cached npm check (`~/.dsaf/update-check.json`, offline fail-open, silenced with `DSAF_NO_UPDATE_CHECK=1`, omitted in `CI`/`--json`/`--sarif`/`mcp`/`hook`) and `dsaf doctor` Check #7 flags older CLIs.
- **One-command repo updater (`dsaf update`):** Refreshes installed skills, `.dsaf/personas.json`, `.dsaf-guardrails/`, semver workflow pins, and MCP configs — while preserving `.dsaf/personas.custom.json` and floating `@v0` pins (`dsaf update --check --fail-if-outdated` in CI).
- **Scheduled Weekly PR Sync:** Pass `--with-ci --with-auto-update` to `dsaf setup` to generate `.github/workflows/dsaf-gate.yml` and `.github/workflows/dsaf-auto-update.yml` (runs `npx -y @zintaen/dsaf@latest update . --all-agents` weekly and opens/updates a PR via `gh`), or let Dependabot/Renovate track `zintaen/dsaf@v0.9.3` & `action.yml`'s `::notice::` / sticky PR reminder.

---

## Live Preview Shell & Editorial Reports

![DSAF Canonical Preview Shell — Before, Track A Pragmatic & Track B North-Star Comparison](docs/assets/preview-shell-showcase.png)

- **Comparison Shell ([preview-shell.html](docs/demo/preview-shell.html)):** Side-by-side `Before`, `Track A` (minimal safe patch), and `Track B` (North-Star layout) rendered inside `@container` responsive frames (`1440px`, `768px`, `390px`), Light/Dark modes, 4 UI states, and design review pins.
- **Standalone HTML Audit Report (`dsaf audit --html`):** Self-contained report ([sample](docs/demo/sample-report.html)) mapping every Floor/Reflex defect to impacted user personas (`dsaf personas`).

---

## Auto-Detected Modes & Core Toolchain

| Topology | Detected When | Primary Checks |
|---|---|---|
| **`Mode S` — Design System** | DTCG `tokens/*.json`, Storybook, or DS package exports | W3C DTCG validation, Light/Dark contrast, Storybook runtime + reduced motion, 2/3-vertex Figma diff |
| **`Mode C` — Product on DS** | App consuming an internal/external DS package | Token compliance %, hardcoded/arbitrary drift, `!important` overrides, live `N-of-1` clusters, `--ds-css` focus check |
| **`Mode P` — Product UI (No DS)** | Web/mobile app or prototype with custom CSS/Tailwind | Accessibility (`WCAG 2.2 AA` + `APCA-W3 Lc`), mobile `44x44` targets, header/table/badge clipping, Dual-Track drafts |

### Full CLI Reference (`dsaf help`)

| Command | Role |
|---|---|
| `dsaf check [path]` | Fast summary check (Floor/Reflex counts, compliance %, impacted personas) |
| `dsaf setup [target]` | One-command Skill + MCP installer (`--with-hook` / `--with-ci` / `--with-auto-update`) |
| `dsaf update [target]` | Check (`--check` / `--fail-if-outdated`) or safely refresh skills, personas, guardrails, workflows & MCP |
| `dsaf audit <target>` | Full Tier 0 pipeline (`--html`, `--sarif`, `--out`, `--url`, `--figma`) |
| `dsaf fix <target>` | Preview (`--dry-run`) or apply (`--apply --backup`) safe Floor patches |
| `dsaf mcp` / `dsaf mcp install` | Run 8-tool stdio MCP server or write client MCP JSON config |
| `dsaf personas [target]` | Uncapped signal-driven Persona Matrix + `.dsaf/personas.custom.json` merge |
| `dsaf runtime <target-or-url>` | Playwright + `axe-core` verifier (APCA, keyboard map, `44px`, tabs/toggles, `--cdp`) |
| `dsaf figma-diff` | 2-vertex `Defined <-> Shipped` or 3-vertex `Designed <-> Defined <-> Shipped` diff |
| `dsaf recon` / `tokens` / `hook` / `doctor` / `guardrails` / `scorecard` / `diff` | Granular Tier 0 scanners, edit-time hooks, CI generators & regression gates |

---

## Development & Verification

Published npm tarballs (`package.json#files`) include **only** `bin/`, `skill/`, `README.md`, `RELEASE_NOTES.md`, and `LICENSE`. Run the full integrity, parity, and isolation suite locally:

```bash
git clone https://github.com/zintaen/dsaf.git
cd dsaf
npm test
```

## License

[MIT](LICENSE) — Copyright (c) 2026 Stephen Cheng.

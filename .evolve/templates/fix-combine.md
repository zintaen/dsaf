# Fix & Combine Template (`A3.3`–`A3.6`)

- **Red-to-Green (A3.4 / C2):** Every fix MUST pair with a failing check/test on the base commit before applying.
- **Scope & Protected Files (A3.4 / A9.6):** Never modify `.evolve/rules.md`, `.evolve/STRATEGY.md`, `.github/workflows/**`, `package.json`, or `validate-isolation.mjs` from a fix lane.
- **Example Sweep (A9.3):** Re-run `npm test` + Playwright fixtures (`preview-shell.html`, `docs/`, `mode-p-app`, `mode-p-defects`) serially (A9.23).
- **Lane Note (A4.2):** Include `Lane-Note:` trailer (`Kind`, `User-visible`, `Public-surface`, `Packages`, `Summary`).
- **Release Parity (A9.22 / C9):** Zero skipped gate checks; tag release PR commit only; run `npm pack --dry-run` tarball check.
- **Verifier Severity Rule (A9.21):** Record explicit rationale for any severity adjustment.

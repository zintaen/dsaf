# Upstream Strategy Feedback (`zintaen/dsaf` -> `zintaen/auto-evolve-strategy`)

Entries collected under `A12` when `STRATEGY.md` rules prove unclear, redundant, or costly in practice.

## Open Observations

- **2026-11-27 | CLI & npm library repos (`A10.4` / `A10.6`):** Clarified in `.evolve/rules.md` that small focused CLI packages (`< 10k` LOC total) work best with `5` coherent audit areas rather than padding to `8`, and package `"files"` whitelisting cleanly keeps `.evolve/` excluded from published tarballs.

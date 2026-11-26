# Canonical Before/After Preview Shell Contract (`v0.1.1`)

Load this contract whenever generating `draft/*.html` previews in `Mode P` or `Mode C` (`usability`, `visual`, or component specimen views). *(Preserve `data-ux-shell-toolbar="v3.0"` and `.uxs-*` / `data-uxs-*` attributes so `audit-runtime.mjs` verifies shell wiring cleanly across every audit.)*

---

## 1. Mandatory Single-File Shell Rule

Never split Before and After into disconnected HTML files and never invent custom toolbar layouts across repositories. Clone `../resources/preview-shell.html` for every `draft/<screen-slug>.html` preview and inject content ONLY inside the designated slots.

---

## 2. Invariant 5-Group Toolbar (`data-ux-shell-toolbar="v3.0"`)

| # | Group Attribute | Fixed Controls | Behavior |
|---|---|---|---|
| **1** | `data-uxs-group="view"` | `Before` · `After · Pragmatic` · *(at L3)* `After · North-Star` · **`Side-by-Side`** | All tracks live in ONE HTML file. `Side-by-Side` shows Before on left and selected After track on right (`>= 960px`) or cleanly stacked with sticky jump links (`< 960px`). Set `<html data-uxs-ambition="L1|L2|L3">`. |
| **2** | `data-uxs-group="viewport"` | `Fluid` · `1440` · `375` | Resizes preview canvas (`container-name: uxs-stage`). Preview CSS MUST support `@container uxs-stage (max-width: 520px)` (or `html[data-uxs-vp="mobile"]`) in addition to `@media` so `375` toggles authentically on desktop monitors. |
| **3** | `data-uxs-group="theme"` | `Light` · `Dark` | Sets `html[data-uxs-theme="light|dark"]` and emits `uxs:change`. |
| **4** | `data-uxs-group="state"` | `<select id="uxs-state-select">` with exact options: `default` · `empty` · `stress` · `error` | Switches real-data UI states (`Default`, `Empty (0)`, `Stress / Long`, `Error`) using authentic domain copy. |
| **5** | `data-uxs-group="pins"` | `Finding Pins` button (`aria-pressed="false"` default) | Default **OFF** so product previews stay clean; **ON** reveals `.uxs-pin` tags and `#uxs-pins-drawer` populated from `#uxs-findings-data`. |

---

## 3. Clean Slot & Isolation Rules

1. **Preserve `.uxs-*` chrome:** Never drop toolbar groups, `Side-by-Side`, or weaken `--uxs-*` token contrast.
2. **Scope product CSS strictly:** Prefix preview CSS under `[data-pane="before"]`, `[data-pane="track-a"]`, and `[data-pane="track-b"]` so Before styles cannot leak into Track A/B.
3. **Fill all slots & localize product UI:** Populate `SLOT:SCREEN_TITLE`, `SLOT:SCREEN_META`, `SLOT:BEFORE_HTML` (authentic baseline UI & data), `SLOT:TRACK_A_HTML`, `SLOT:TRACK_B_HTML` (when `L3`), and `#uxs-findings-data` JSON. Wire interactive handlers to `window.addEventListener("uxs:change", ...)` so state/theme switches update the live preview DOM.
4. **Hub Page (`draft/index.html`):** When a multi-screen dossier includes an index hub, link each screen preview cleanly (optionally with `?view=compare&target=track-b&theme=dark&state=stress`) while enforcing the full canonical shell inside every individual screen preview.

---

## 4. Automated Runtime Verification

Verify 100% of `draft/` HTML files cleanly with:

```bash
node ./scripts/audit-runtime.mjs <draft-file-or-dir> [--wiring-before <url-or-file> --wiring-after <url-or-file>] [--axe <path-to-axe.min.js>]
```

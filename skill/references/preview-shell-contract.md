# Canonical Before/After Preview Shell Contract (`v0.9.3`)

Load this contract whenever generating `draft/*.html` previews in `Mode P` or `Mode C` (`usability`, `visual`, or component specimen views). *(Preserve `data-ux-shell-toolbar="v3.0"` and `.uxs-*` / `data-uxs-*` attributes so `audit-runtime.mjs` verifies shell wiring cleanly across every audit.)*

---

## 1. Mandatory Single-File Shell Rule

Never split Before and After into disconnected HTML files and never invent custom toolbar layouts across repositories. Clone `../resources/preview-shell.html` for every `draft/<screen-slug>.html` preview and inject content ONLY inside the designated slots.

---

## 2. Invariant 5-Group Toolbar (`data-ux-shell-toolbar="v3.0"`)

| # | Group Attribute | Fixed Controls | Behavior |
|---|---|---|---|
| **1** | `data-uxs-group="view"` | `Before` · `Track A` · *(at L3)* `Track B` · **`Compare`** | All tracks live in ONE HTML file. `Compare` shows Before alongside selected Track A/B panes (`> 1020px` container) or cleanly stacked (`<= 1020px`). Set `data-uxs-ambition` on `<html>` to `"L1"`, `"L2"`, or `"L3"`. |
| **2** | `data-uxs-group="viewport"` | `1440px` (`desktop`) · `768px` (`tablet`) · `390px` (`mobile`) | Resizes preview canvas (`container-name: uxs-stage`). Preview CSS MUST support `@container uxs-pane (...)` / `@container uxs-stage (...)` so `768px`/`390px` toggles work authentically on wide monitors. |
| **3** | `data-uxs-group="theme"` | `Light` (`data-theme="light"`) · `Dark` (`data-theme="dark"`) | Defaults to OS `prefers-color-scheme` when unset, switches `html[data-theme]` & `html[data-uxs-theme]`, and emits `uxs:change`. |
| **4** | `data-uxs-group="state"` | `<select id="uxs-state-select">` with exact values: `default` · `empty` · `stress` · `error` | Switches real-data UI states (`Active`, `Trial / Empty`, `Long Locale`, `Error`) using authentic domain copy. |
| **5** | `data-uxs-group="pins"` | `Finding Pins` button (`#uxs-pins-btn`, `aria-pressed="false"` default) | Default **OFF**; clicking any `#uxs-pins-btn` or `[data-pin-target]` badge opens `#uxs-drawer`, highlights `[data-pin-card]`, and closes cleanly on `Escape`. |

---

## 3. Clean Slot & Isolation Rules

1. **Preserve `.uxs-*` chrome:** Never drop toolbar groups, `Compare`, or weaken `--uxs-*` token contrast.
2. **Scope product CSS strictly:** Prefix preview CSS under `[data-pane="before"]`, `[data-pane="track-a"]`, and `[data-pane="track-b"]` so Before styles cannot leak into Track A/B.
3. **Fill all slots & localize product UI:** Populate `SLOT:SCREEN_TITLE`, `SLOT:BEFORE_HTML` (authentic baseline UI & data), `SLOT:TRACK_A_HTML`, `SLOT:TRACK_B_HTML` (when `L3`), `SLOT:PINS_HTML`, and `#uxs-findings-data` JSON. Wire interactive handlers to `window.addEventListener("uxs:change", ...)` so state/theme switches update the live preview DOM.
4. **Hub Page & Query Deep-Links:** Link individual screen previews cleanly (supports `?view=before|track-a|track-b|compare&vp=desktop|tablet|mobile&theme=light|dark&state=default|empty|stress|error&pins=on|off&ambition=L1|L2|L3`) while enforcing the full canonical shell inside every screen preview.

---

## 4. Automated Runtime Verification

Verify 100% of `draft/` HTML files cleanly with:

```bash
node ./scripts/audit-runtime.mjs <draft-file-or-dir> [--wiring-before <url-or-file> --wiring-after <url-or-file>] [--axe <path-to-axe.min.js>]
```

# Lessons Learned (`zintaen/dsaf`)

Technical, domain-stripped lessons recorded per A7.2:

- **2026-11-27 | Simulated desktop viewport tests must use `@container`:** Media queries (`@media (max-width: 768px)`) inside a desktop iframe/stage ignore simulated width buttons; always key internal preview panes and stacked tables off `@container uxs-stage` / `@container uxs-pane` and verify under `Compare + Pins` open.
- **2026-11-27 | 44px touch targets with 26px badges need transparent wrappers:** Setting `margin-inline: -4px` or oversized children inside fixed badges causes `scrollWidth > clientWidth`; wrap small visual pins inside a `44x44` transparent `<button>` with explicit `color: inherit` on the pinpill for accurate `pixelBehind` checks.
- **2026-11-27 | CSS gradients require opaque `background-color`:** Automated computed-style contrast samplers read `background-color` behind transparent layers; always declare a matching solid fallback alongside `background-image` gradients.
- **2026-11-27 | Zero `.evolve/` leakage into published npm tarballs:** Because `package.json` uses `"files": ["bin/", "skill/", "README.md", "RELEASE_NOTES.md", "LICENSE"]`, repo governance lives safely at `.evolve/` while reusable Tier 1 agent tooling stays in `skill/`.

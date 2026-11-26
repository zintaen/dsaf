# Known Gaps (`zintaen/dsaf`)

Documented limitations (A3.1, A7.3):

- Static `audit-tokens` & `dsaf-hook` run zero-dep regex/AST-light scans in Node ESM; live visual contrast (`APCA-W3`), focus-order mapping, and responsive checks require Chromium Playwright (`audit-runtime`).
- Mutation testing per A9.2 uses built-in adversarial synthetic fixtures (`mode-p-defects`) plus contract schema tests rather than an external mutation runner.

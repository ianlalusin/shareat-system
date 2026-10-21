# T-450 release review — 2026-10-21
FINDINGS: no outstanding code finding; visual and exact-head full CI gates pending.
Coverage: 106 native table definitions + six shared-table calls across 83 ERP files; AST inventory checked.
Phone cards reuse original controls; tablet >=768px and print retain tables; no-JS retains native scrollable tables.
Ian rejected stacked cards, the V-like glyph and square frame: summaries now use a flat, borderless 52px double-chevron SVG control.
Request new item uses a native Add disclosure; the original form stays mounted and expands without JavaScript.
Shared shell remembers per-account/tab URL filters, document/panel scroll and open cards/disclosures; no input values.
Return-state tests cover remount, delayed content, ancestor links, fragments, malformed/blocked storage and cleanup.
Earlier 309 checks / 17 files passed; latest flat-control correction: 207 checks / eight files and production build passed; postcommit repeat required.
Interaction census gained one measured 44px summary; no fail/unresolved baseline or guard exemptions changed.
Preview starts on 9008 against shareat_test_codex_ui_smoke; no live Firebase checks or production data writes.
Owner's local sign-in link was recovered through the audited service; earlier user screenshots show Items access.
Model: GPT-6 (Codex).
## FOR IAN
Refresh Items to review cards, return navigation and Add; merge/deploy still needs visual approval and full green PR CI.

# T-450 release review — 2026-10-21
FINDINGS: no outstanding code finding; visual and full CI gates pending.
Coverage: 106 native table definitions + six shared-table calls across 83 ERP files; inventory checked by AST.
Phone cards use original rows, controls, form values and links; tablet >=768px and print retain tables.
Grouped headers, full-width totals, dynamic rows, header controls and five headerless tables are covered.
Corrected during review: sorting/checkbox labels; initial CI rejected the client kit placement and two span loops; moved the adapter to shell and validated span dimensions without guard exemptions.
Local evidence: 244 affected checks / 11 files passed; earlier caller census and app boundaries passed; postcommit repeat required.
Corrected production-mode build and typecheck passed; the initial local build inherited NODE_ENV=test and was rerun explicitly in production mode.
Preview starts on 9008 against shareat_test_codex_ui_smoke; no production data writes or live Firebase checks.
Cards activate after hydration; without JavaScript the original scrollable table remains usable.
Browser policy denies the local origin; manual phone/tablet/print verification requested, still pending.
Local sign-in recovery: reused the owner's existing local account link through the audited service in this test database only; browser retry pending.
Model: GPT-6 (Codex).
## FOR IAN
Check Items and one report/detail on phone, tablet and print; merge/deploy waits for this and full green PR CI.

FINDINGS: lightbox clean; 1 LOW supporting test defect corrected, full CI pending
- CHECKED CLEAN: dialog bounds use the dynamic viewport, its content can shrink, the Close row stays visible, and the image fits inside the dialog's content box.
- CHECKED CLEAN: native dialog open/close, Escape, backdrop click, fresh audited file URL on each open, and PDF handling remain intact.
- Original branch: 34 targeted checks passed. After merging deployed main (758a48c): 52 affected UI checks passed; the UI source change remains confined to Lightbox.tsx and its wiring test.
- Full CI on 8d692b6: unit and all 8,790 PostgreSQL integration tests passed; ERP build failed in Next's Google-font import resolver ("queries have exactly one entry"). No application error is inferred from that compiler diagnostic.
- Fresh CI 39281194661: 8,790 integration assertions passed but an unhandled weekly-payroll refusal made the job fail. No green result or merge is claimed.
- LOW · packages/domain/tests/integration/t190-statutory.test.ts:659,671 · Eager promise arrays started preview/post together, letting the second reject before its handler attached. T-449 defers each call without changing assertions; all 42 tests in that file pass on real PostgreSQL.
- Supporting scope beyond T-441 is this T-449 test-harness repair, its task and defect log; production payroll is untouched. Another full PR CI run is required.
- The separate uncommitted T-442 backfill in wt-t403 is excluded and preserved. This isolated checkout does not rewrite that working tree.
- Automated viewport review remains unavailable under the saved browser policy; Ian approved the refreshed compact UI preview separately.
FOR IAN: the compact white UI is already live. The lightbox correction stays held until its complete CI is green.
Model: GPT-6 (Codex).

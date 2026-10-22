# T-460 — preserve SDK values and verify receipt comparison (DEF-730)
Status: specified 22 October after actual Android quarantine; not implemented.
Goal: a saved receipt's nonfinancial timestamp representation cannot cause a false different-sale conflict.
Read docs/discovery/pos-receipt-sdk-values.md and T-458/T-459 evidence first. No live operations.

## Exact scope
apps/pos/src/lib/firebase/utils.ts and utils.test.ts;
apps/pos/src/lib/outbox/linesHash.ts (separate legacy-clock comparison helper only), reconcile.ts, reconcile.test.ts;
apps/pos/src/components/cashier/offlineWiring.test.ts (real SDK timestamp round-trip control);
apps/pos/V1-COPY.md; this task; the discovery; docs/reviews/t460-receipt-sdk-values.md;
docs/DEFECTS-REGISTER.md DEF-730; docs/tasks/455-pos-emulator-runtime.md (actual evidence only).
No pricing, accounting, schema, receipt-number reset, history deletion, outbox-status bypass or auth change.

## S1: ordinary cleaner
stripUndefined recursively cleans only arrays and plain objects (Object.prototype or null prototype).
Preserve Date, actual Firebase Timestamp, FieldValue/serverTimestamp and DocumentReference instances unchanged.
Keep existing undefined-array filtering, plain-property omission, null and falsy values. Do not import another app or add a dependency.
Tests must use real installed SDK types; a fake class without SDK properties is not sufficient evidence.

## S2: legacy comparison, only after target tests prove the cause
Keep computeLinesHash and ORIGINAL event.linesHash contract unchanged. Keep receipt number and centavos checks mandatory.
If normal hash comparison fails, a second candidate may recognize ONLY top-level line createdAt/updatedAt clock fields containing exactly
seconds/nanoseconds with valid timestamp bounds and no extra keys, treating these as the SDK timestamps already excluded by the hash.
Candidate must equal original event.linesHash. Do not accept solely by hashing ops or skip any financial/identity field.
Do not treat {_methodName:'serverTimestamp'} maps as live sentinels or erase arbitrary objects/nulls to force equality.
No automatic reprocessing or edits of already-quarantined receipts; preserve EMU-01-000001 forensic history.
If exact metadata normalization does not reproduce the original hash, REPORT the spec defect with real evidence; do not broaden it.

## Gates
Before source: SDK prototype/cleaning round-trip failure and false-conflict legacy case; positive normal timestamp case;
changed qty/price/discount/item id/total/receipt number still quarantined; extra-key/invalid timestamp-shaped object not ignored.
Retain all old reconciliation/refusal/ownership/retry controls. Run affected/full POS tests, typecheck and postcommit guards/census.
Stop dev before APK; preserve stale dev types safely; verify 34 moved sources restored byte-identically.
NEW own Android demo order with a real timestamp-bearing line, offline cash/receipt/restart/reconnect:
one receipt/payment/number and server-proven acknowledgement (unsent0 alone does not prove this if quarantine grew).
No printer/provider/24h-soak claim; DEF-729 follow-up marker atomicity remains separately scoped.

# T-458 — durable offline payment intent (DEF-726 / DEF-727)
Status: core save/restart/reconnect verified 22 October; post-save UI exposed DEF-728; overall POS gates pending.
Goal: an owning tablet can save a cash sale with no cached receipt, and concurrent/restarted retries cannot consume another number.

## Scope and sequence
S1: apps/pos/src/lib/outbox/ledger.ts and ledger-intent.test.ts: atomic receipt-intent reservation.
S2: apps/pos/src/components/cashier/offlinePayment.ts and offlineWiring.test.ts;
apps/pos/src/lib/outbox/effects-store.ts and effects-store.test.ts;
apps/pos/src/test-helpers/fakeFirestore.ts: cache-miss fidelity and stable deferred-effect identity.
tests/unit/pos-v2-offline-guards.test.ts: require the new intent reservation API instead of the old generic API;
retain every counter, rules, batch and effects boundary assertion. This supporting guard scope was added after its real failure.
Documentation: this task; docs/discovery/pos-offline-receipt-intent.md;
docs/reviews/t458-offline-payment-intent.md; docs/DEFECTS-REGISTER.md DEF-726/727;
apps/pos/V1-COPY.md; docs/tasks/455-pos-emulator-runtime.md (evidence only).
No SQLite, DB version change, new package, production operations, statutory-rule change or backend migration.

## S1 contract
Use existing meta store, counter and events in ONE readwrite transaction; intent key is storeId + receiptId for sales.
reserveOfflineSaleIntent requires storeId and an opaque intentFingerprint in addition to the existing offline reservation data.
Return {event, created}: new event created=true; matching durable unsent or acknowledged event created=false.
Only unsent events with complete ops may be replayed; stored ops and original timestamps/number are reused verbatim.
Fingerprint covers billing revision, financial lines, bill adjustments, statutory inputs, totals, tender identity and actor;
createdAt, generated analytics ids and UI payment ids do not define a new intent. Existing linesHash semantics stay unchanged.
Changed fingerprint/amount/lines/tenders refuses before number, event or intent write.
reserved (uncertain online result), stuck, rejected, quarantined and ambiguous legacy history refuse pending reconciliation.
Confirmed skipped attempts may reserve a new number; preserve their old rows. Legacy unsent events without a fingerprint
are never silently adopted as equal. If multiple non-skipped legacy events exist, refuse rather than choose one.
The missing-pointer path checks historical events in this same transaction, including reserved online attempts.
An existing pointer whose event was pruned is a tombstone: refuse, never forget that the intent was already used.
Pruning retains this small pointer (no bill lines, tender data or government ids). Unsent events remain unpruned.
Store mismatch and storage failure leave all three stores unchanged. Different receipt ids continue to reserve distinct numbers.
An online reservation must also refuse an existing offline intent pointer in the same counter transaction,
so switching connectivity cannot bypass it. Online/online concurrency and offline void intents remain outside this slice.

## S2 contract
Required cached session/billing reads, owner, tender, revision and statutory checks remain before reservation.
A receipt cache miss is UNKNOWN, never proof of server absence; cached positive paid evidence still prevents another sale.
Do not catch arbitrary errors, fake missing snapshots or remove refund/authorization guards.
Use the S1 transaction as the local duplicate backstop, then replay only its stored ops; acknowledged events are not replayed.
Retries must not create duplicate/reset deferred effects. A saved intent with no queued effects must be recoverable.
Retain server reconciliation/conflict checking. Unknown online outcomes cannot become fresh offline sales.

## Gates
Tests first: concurrent same intent, restart retry, changed payload, unknown online outcome, skipped retry, legacy history,
pruned-pointer refusal, rollback, store scope and different-receipt positive control. Preserve all old ledger controls.
S2 regression must reproduce actual SDK unavailable on an uncached receipt, plus permission/read-error negative controls.
Then affected/full POS tests, typecheck, postcommit guards/census. Stop dev before APK build; verify 34 moved files restored.
Android demo: cash own cached order offline, force-stop/reopen, reconnect, exactly one receipt/payment set and number.
No claim of physical printer, real payment provider or 24-hour soak completion from an emulator pass.

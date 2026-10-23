# T-459 — saved payment must reach its receipt (DEF-734)
Status: corrected and Android demo verified 22 October; postcommit checks/release gates pending.
Goal: an optional uncached print preference cannot turn a saved payment into a payment-failed message.
Evidence: Android log confirms EMU-01-000001 saved; payment-modal.tsx:406 then reads receiptSettings/main,
raises unavailable and enters Payment failed catch. Restart retains closed session; demo server later has one P760 receipt/payment.

## Scope
apps/pos/src/components/cashier/payment-modal.tsx;
apps/pos/src/lib/receipts/offline-payment-destination.ts and offline-payment-destination.test.ts;
apps/pos/V1-COPY.md; this task; docs/reviews/t459-saved-payment-handoff.md;
docs/DEFECTS-REGISTER.md DEF-734; docs/tasks/463-pos-emulator-runtime.md (runtime evidence only).
No money, reservation, ledger, receipt formatting or authorization changes; preserve the existing success/receipt UI.

## Contract
Only after completePaymentOffline returns its durable receipt id, resolve the optional autoprint preference from cache.
Cached true retains autoprint=1; false/missing/unknown uses the existing manual receipt route for THAT saved id.
Unknown preference is not persisted as false; a preference-read error is logged, never a payment failure or invitation to pay again.
Use a small tested destination helper so any preference exception returns the saved receipt's route.
Do not catch completePaymentOffline failures in that helper or turn an unsaved payment into success.
Do not change online payment behavior in this bounded slice.

## Gates
Tests fail first for no cached settings / rejected preference read, explicit autoprint true and false,
same saved id in every outcome, and no second payment invocation. Check actual modal calls the helper AFTER save.
Affected POS tests, typecheck, full POS suite and postcommit guards/census; no baselines/exemptions widened.
Stop POS dev before APK build; preserve stale generated dev types rather than deleting them; verify 34 sources restored.
Android demo with a NEW own order: offline cash succeeds, success UI opens same receipt without settings cached,
force-stop/reopen and reconnect keep one receipt/number/payment. Preserve EMU-01-000001 and its history.
Physical printer, statutory/provider controls and 24h soak remain separate gates. No live Firebase/real payment.

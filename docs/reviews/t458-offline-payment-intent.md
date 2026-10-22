# T-458 review and evidence
Status: core save/restart/reconnect verified in Android demo; NOT a POS release approval.

- Intent targets before code: 15 failed (missing export). S1 plus original ledger controls: 29 passed.
- Payment targets before wiring: 4 failed / 19 passed; uncached SDK unavailable, duplicate attempts and lost-batch retry reproduced.
- Effects target before helper: 1 failed / 11 passed. Closed-session recovery target: 1 failed / 23 passed.
- Initial full POS checkpoint: 940 passed / 1 existing skip / 88 files; typecheck clean.
- Additional online-switch refusal target: 1 failed / 15 passed; correction plus old ledger controls: 30 passed.
- Final full POS checkpoint: 941 passed / 1 existing skip / 88 files; static TypeScript phase and native APK build passed (111 tasks).
- All 34 moved API/server/middleware sources restored byte-identically; no cap-stash remains.
- Initial guards: 239 passed / 2 failed: old API-name assertion and unchanged 5s artifact-scan timeout. Supporting guard updated to REQUIRE the intent API; focused 55 passed, without widening any limit/exemption.
- Source commit 9cca215 postcommit: 941 POS passed/1 existing skip; typecheck clean; guards 240 passed/1 unchanged artifact-scan timeout; unchanged focused boundary repeat 20 passed. Source pushed; combined guard invocation was not fully green.
- Counter/event/pointer transaction is synchronous and resolves on commit; storage abort leaves no number consumed.
- Pointer persists after payload pruning; old ambiguous/online-reserved attempts cannot silently become new offline sales.
- Original saved ops drive replays and effect context. A queue retry preserves existing status and completed effect stages.
- No storage engine/package/schema change or reference-repository write. Existing online/online and offline-void intent protocols unchanged.
- Android own order P760, Wi-Fi/data off: actual log saved EMU-01-000001. Force-stop/reopen offline retained closed state (no active sessions).
- Reconnect demo REST: one receipt P760, one payment G4Yea7DR4bWumgMepciA-p0 and one matching receipt-number mapping. Baseline receipt was HTTP404 with local emulator owner auth.
- UI then reports Payment failed from uncached OPTIONAL receiptSettings read AFTER save (DEF-728). Overall payment/receipt UI gate is still red; no paid-flow completion claim.
- DEF-729 recorded separately: follow-up marker is not atomic with the ledger; automatic recovery after acknowledgement is not established.
- Screenshots/logs in Temp/shareat-t458-{paid,reopened}.png, shareat-t458-build-final.log, shareat-t458-full-final.log; physical printer/provider/24h soak unverified.

## FOR IAN
The cash sale now saves and survives restart/sync. Its misleading post-save error needs the next correction; POS remains unreleased.

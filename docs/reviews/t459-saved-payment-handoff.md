# T-459 evidence
- Red: 7 targets failed before implementation; final target: 7 passed. Actual offline modal saves once then calls the cache-only preference helper with that saved id; real save failures retain their error path.
- Full POS: 948 passed / 1 existing skip / 89 files; typecheck passed. Optional preference errors use manual printing and do not write a guessed preference.
- Static export and Android emulator APK passed (111 tasks); all 34 moved sources restored byte-identically, no cap-stash. Dev was stopped first; stale generated dev types preserved in Temp/shareat-pos-t459-dev-types-a39cd0d3b3214e55936cb996819836bc.
- Android demo new own order e2tw4nP3oOmhih3oZxb7, one Test dish P100: Wi-Fi/data off, Cash100 opened receipt EMU-01-000002 with correct total, manual Print button and no false Payment failed.
- Force-stop/reopen offline retained closed state. Reconnect REST confirmed receipt P100, one payment, original EMU-01-000001/P760 still one receipt/payment. Native Settings subsequently showed unsent0, quarantined1 (the OLD P760 receipt only).
- Receipt settings server document is absent; unknown-cache exceptions are covered in the target tests. Do not claim the native preference read itself threw: no warning was observed in that run.
- Source adf99fb postcommit: 948 passed/1 existing skip, typecheck clean; root240 passed/1 unchanged 5s artifact-scan timeout, unchanged focused boundary repeat20 passed. No assertion, timeout, limit or exemption relaxed; combined root invocation was not fully green.
- New finding DEF-730: OLD P760 receipt quarantined despite matching number/total; receipt contains flattened Timestamp/sentinel maps. This corrects any inference that the earlier REST count proved ledger acknowledgement. History preserved; no manual status rewrite.
- Source review: online payment branch and existing success/receipt presentation unchanged. No production/reference writes, printer hardware or payment provider used; full device/soak gates remain.
- Screenshots Temp/shareat-t459-paid.png, shareat-t459-restart.png, shareat-t459-after-sync.png; logs shareat-t459-{red,target,full,types,build,guards}.log.
## FOR IAN
The new offline payment opens its receipt correctly. POS stays unreleased while the older receipt conflict and crash-recovery work remain.

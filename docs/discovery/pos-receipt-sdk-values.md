# DEF-730 — receipt metadata loses SDK types
Verdict: repair the existing cleaner's type preservation, then verify a narrow historical timestamp comparison; no new storage dependency.
Actual Android Settings quarantines old EMU-01-000001/P760 as a different sale although demo REST shows one number/receipt/payment.
Its receipt lines contain createdAt:{seconds,nanoseconds}, while original SDK Timestamp values are excluded by computeLinesHash.
stripUndefined in apps/pos/src/lib/firebase/utils.ts recurses through every non-Date object, flattening SDK instances before ledger encoding.
The same receipt contains {_methodName:'serverTimestamp'} maps from older bill-line writes. Do not silently reinterpret these as live SDK sentinels.
The SDK distinguishes Timestamp instances from JSON representations: https://firebase.google.com/docs/reference/js/firestore_.timestamp
Existing encodeLedgerValue/decodeValue already own typed timestamp transport; their input must retain SDK prototypes.
No package needed: the project already checks plain-object prototypes in its ledger. A dependency would not fix this premature flattening.
Production frequency is unknown; one old synthetic receipt is quarantined, new P100 receipt acknowledged. No live data was queried.
Candidate compatibility: only recognized clock fields createdAt/updatedAt with exact valid seconds/nanoseconds shape may be normalized
for a SECOND comparison against the ORIGINAL stored linesHash. Keep every price/quantity/discount/identity field and the original number/total gates.
Do not accept merely because server matches stored ops: that could hide a builder changing financial data relative to the original hash.
Historical already-quarantined rows stay preserved; no automatic status rewrite, server receipt edit, broad metadata stripping or relaxed financial hash.
Write T-460 tests with real SDK Timestamp and serverTimestamp values first; preserve existing financial-conflict controls.

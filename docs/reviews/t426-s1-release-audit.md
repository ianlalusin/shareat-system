FINDINGS: 2 (2 MED); corrected locally; branch held
- MED · apps/pos/src/lib/statutory/totals.ts:13 · Independent rounding could produce negative per-diner sales/VAT or refuse two P449.95 dishes with 10% own discounts; three red controls now enforce bounded allocation and one bill/promo budget (DEF-713).
- MED · apps/pos/src/lib/statutory/capture.ts:47 · Stored entries could bypass required names/IDs and forged normalization could duplicate a person; five red controls now require payment-time validation of actual IDs and record shape (DEF-714).
CHECKED CLEAN
- All 132 selected math/capture/money/refund checks, POS typecheck and normal/cap builds pass. Cap restored 34 source files with identical hashes and no stash. The original three files started at 64 failed / 3 passed.
- Seven rounding checks include 4,860 tiny bills across VAT-inclusive, exclusive and non-VAT stores; every diner stays nonnegative and balances. Frozen T-423 parity, generated mixed/all-qualifying bills and existing expectations pass.
- Exact line and ordinary remainder stages are shared with the original tax path; no test helper enters production. The numeric allocator retains six-decimal weight normalization and delegates to the same exact allocation routine.
- IDs remain masked in activity and closed-session helpers; refusal sentences never quote an ID. No live Firestore audit or write was run.
- Separate ERP release: PR #40 merged after full green CI; main CI 39384872258 and Deploy 39387626986 passed. Public health confirms fd82dfafe39b37f182c211103ed974075d708d94, valid configuration and a reachable database. POS is not deployed.
FOR IAN: This is an unfinished S1/capture checkpoint. Payment/caller wiring, capture UI, receipt/print/logbook, runtime and full branch CI are still pending. New helpers must gain real S2 callers; the caller baseline is not widened to hide unfinished wiring.
Model: GPT-6 (Codex).

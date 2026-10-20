FINDINGS: 8 (5 HIGH, 2 MED, 1 LOW); 7 corrected locally, 1 MED open; branch held
- HIGH · apps/pos/src/lib/cash/handover.ts:57 · Cash substring matching counted GCash as physical cash and the tester repeated it; a 100 cash/500 GCash sale expected 600. Configured identities plus a cash-word fallback now produce 100 (DEF-704).
- HIGH · apps/pos/src/server/pos2/conversions.ts:100 · Advisory read/write failures claimed no change after money committed; known commits now return Recorded with a durable pending warning and no duplicate move (DEF-695).
- HIGH · apps/pos/src/server/pos2/conversions.ts:81 · Lost primary commit acknowledgments claimed no change for create/void; recovery confirms by id/status or returns an honest unconfirmed 503 without another money write (DEF-703).
- HIGH · apps/pos/src/lib/pos2/client.ts:25 · Lost/unreadable responses told staff Nothing was changed; the shared client now gives same-request recovery instructions and preserves definite refusal sentences (DEF-705).
- HIGH · apps/pos/src/components/cashier/CashHandoverClient.tsx:184 · A preview snapshot closed a later period and lost intervening movements; save now reads fresh totals through its captured end. Ian's separate signed adjustment and reason preserve manual correction (DEF-706).
- MED · apps/pos/src/lib/cash/convert-net.ts:25 · Adjacent inclusive windows counted an exact-boundary conversion twice; subsequent reads start one millisecond after the preceding inclusive end, while the first includes its opening (DEF-707).
- MED · apps/pos/src/components/cashier/CashHandoverClient.tsx:190 · The pre-existing addDoc handover writer has no stable retry identity; a committed write with a lost acknowledgment can be logged again on retry. Reported, not live-tested (DEF-710).
- LOW · apps/pos/scripts/pos2-audit.mjs:27 · Impossible/reversed date flags could audit the wrong or empty period; canonical Manila range validation now refuses before credential/Firestore reads (DEF-709).
CHECKED CLEAN
- Ninety-two affected checks, POS typecheck and normal production build pass: exact money, real overlap, same-id replay, original-day void, ID/source/shift gates, GCash classification, boundary/adjustment math, final negative-day classification and command wiring.
- Sheet is wired with persisted same-id retry, plain movement preview, offline disabled state and cached-list discard protection. Handover history/export show adjustments/converts; mobile history uses cards. Source controls supplement tests, not a browser smoke claim.
- The live audit was not run. CLI output retains counts/document numbers and no monetary totals. Twelve intentional test/inspection census exports were reviewed individually before controlled baseline regeneration; no scanner/ceiling widened.
FOR IAN: Convert is local work awaiting visual review and branch gates. Full POS CI, runtime and build:cap remain unmet; DEF-677 blocks cap execution. Per-diner statutory work remains unfinished.
Model: GPT-6 (Codex).

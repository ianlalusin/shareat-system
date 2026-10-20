FINDINGS: 10 (6 HIGH, 3 MED, 1 LOW); 9 corrected locally, 1 MED open; branch held
- HIGH · apps/pos/src/lib/cash/handover.ts:57 · Cash substring matching counted GCash as physical cash and the tester repeated it; a 100 cash/500 GCash sale expected 600. Configured identities plus a cash-word fallback now produce 100 (DEF-704).
- HIGH · apps/pos/src/server/pos2/conversions.ts:100 · Advisory read/write failures claimed no change after money committed; known commits now return Recorded with a durable pending warning and no duplicate move (DEF-695).
- HIGH · apps/pos/src/server/pos2/conversions.ts:81 · Lost primary commit acknowledgments claimed no change for create/void; recovery confirms by id/status or returns an honest unconfirmed 503 without another money write (DEF-703).
- HIGH · apps/pos/src/lib/pos2/client.ts:25 · Lost/unreadable responses told staff Nothing was changed; the shared client now gives same-request recovery instructions and preserves definite refusal sentences (DEF-705).
- HIGH · apps/pos/src/components/cashier/CashHandoverClient.tsx:184 · A preview snapshot closed a later period and lost intervening movements; save now reads fresh totals through its captured end. Ian's separate signed adjustment and reason preserve manual correction (DEF-706).
- HIGH · apps/pos/scripts/build-cap.mjs:57 · The restore deleted saved source when a build recreated its target; restoration now merges missing files and preserves collisions, refusing another build until reviewed (DEF-677).
- MED · apps/pos/src/lib/cash/convert-net.ts:25 · Adjacent inclusive windows counted an exact-boundary conversion twice; subsequent reads start one millisecond after the preceding inclusive end, while the first includes its opening (DEF-707).
- MED · apps/pos/src/components/cashier/CashHandoverClient.tsx:190 · The pre-existing addDoc handover writer has no stable retry identity; a committed write with a lost acknowledgment can be logged again on retry. Reported, not live-tested (DEF-710).
- MED · apps/pos/src/lib/appVersion.ts:1 · Importing the package manifest shipped its dependency list into the APK and failed the existing artifact scan; Next config now injects only its version scalar, retaining the CI override (DEF-711).
- LOW · apps/pos/scripts/pos2-audit.mjs:27 · Impossible/reversed date flags could audit the wrong or empty period; canonical Manila range validation now refuses before credential/Firestore reads (DEF-709).
CHECKED CLEAN
- Ninety-two affected checks, 95 post-commit guards, POS typecheck and normal build pass. Eight cap recovery checks pass after three red loss cases; actual build:cap restored 34 files byte-for-byte, no stash remains. Exact money/replay/void/shift gates and adjustment/boundary math pass.
FOR IAN: No live audit or Firestore writes were run. Convert awaits visual review, full POS CI and runtime gates. Handover retry identity and per-diner statutory work remain unfinished; branch held.
Model: GPT-6 (Codex).

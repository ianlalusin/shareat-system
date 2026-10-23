# T-457 — terminal setup query compatibility (DEF-736)
Status: corrected locally 22 October; Android Terminal01 claim and next-number display verified; release gates pending.
Android demo Settings > Terminal > 1 > Set up refuses: "Firestore does not support descending key scans".
Existing claim.ts highestSeq uses only descending document-id ordering. No live Firebase was queried;
production behavior is unverified. The fake accepts this shape, so passing unit tests missed the runtime refusal.
Spec defect: T-423's required desc-id/limit1 query is not executable on the actual test backend; do not suppress
the error, assume zero, seed the device counter by hand, or bypass terminal setup to report a paid-sale pass.
Planned pattern: bounded binary search on the six-digit sequence space using ascending document-id range
queries and limit1; at most 20 probes, no composite index, no unbounded receipt download.
Each probe asks whether any id exists between CODE-TT-mid and CODE-TT-999999. Absence lowers the upper bound;
presence raises the lower bound to at least mid (and may advance to the returned sequence). Return the true max,
zero for empty prefix. Preserve release-gap, local counter, held-terminal transaction and legacy-prefix checks.
Scope: apps/pos/src/lib/terminal/claim.ts, claim.test.ts; this task; docs/discovery/pos-terminal-query-compatibility.md;
apps/pos/V1-COPY.md; docs/DEFECTS-REGISTER.md (DEF-736); docs/reviews/t457-terminal-query.md;
T-463/T-456 status/evidence updates. No fake index exemption or production transport change.
Research the installed SDK/actual local emulator query shapes first; then four controls red before source fix:
reject descending-key-only query, sparse highest sequence, terminal-prefix isolation and at most20 bounded probes.
Run existing claim/release/reinstall/exhaustion tests unchanged; emulator query controls and Android terminal
setup must pass before offline cash-payment restart/reconnect testing. Stop local POS dev server before builds.
Record real paid-receipt/outbox results separately from physical printer, approval and 24h soak gates.
Runtime outcome: Terminal01 claim and EMU-01-000001 next-number display passed; subsequent own-order Cash P760
failed on uncached receipt read in offlinePayment.ts (DEF-732), so no paid-sale/restart/reconnect pass is claimed.

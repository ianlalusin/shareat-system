FINDINGS: 2 (2 LOW), corrected; POS release remains pending
- LOW · apps/pos/src/lib/printing/xSlipFormatter.test.ts:99 · The expected Cash total omitted the period's unsent sale: 1,196 acknowledged + 45,000 unsent must print 46,196, while the old assertion required 1,196.
- LOW · apps/pos/src/lib/outbox/reconcile.test.ts:208 · The reseated-table fixture changed only the canonical table but expected the untouched projection to acquire the new session; the assertion now snapshots the projection and proves replay leaves it unchanged.
CHECKED CLEAN
- These changes retain the ledger-total rule and the canonical-table replay guard; no production logic changed.
- Focused Vitest run: 42 tests passed across the two files, after the original full POS run exposed both failures.
- The whole POS branch still has unfinished T-426 and T-427 implementation; this focused result does not establish release readiness.
FOR IAN: two false failures are corrected; the unfinished POS features remain separate from the live ERP UI.
Model: GPT-6 (Codex).

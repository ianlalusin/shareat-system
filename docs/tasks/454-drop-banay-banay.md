# T-454: Drop Banay-Banay from v2 (store closing)

**Status:** 2026-10-25: RESERVED. Spec not written. Banay-Banay closes at the end of 2026 and Lipa buys it back. Open: do the staff move to Lipa?
**Ruling:** bible row 377 (Ian, 2026-10-22): Banay-Banay is closing; drop it completely from v2. Its history stays in v1.

## Scope to specify
- T-396 S3/S4: link Malvar and Davao only; take Banay-Banay (`zZM9TfGqSyA5eDg2kyrv`) out of the runbook and the POS key map.
- Dual run (T-392) and master-data (T-391) store lists: Banay-Banay (`iGOW7q2pZbeHWV832UNh`) left out, said so in the output.
- Cutover (T-390/T-394): no opening balances, stock or assets for Banay-Banay; the purge rehearsal expects none.
- Production: if a Banay-Banay store row exists in v2, close it (never delete: ledger rows may point at it). Script Ian runs.
- `docs/STORE-ROSTER.md`, `docs/ops/pos-v1-key.md`, `docs/CROSS-APP-MAP.md`: mark it closed.

## Open questions for Ian
1. Closing date.
2. Its last stock, cash and equipment: moved to another store in v1 before closing, or written off?
3. Its staff: moving to another store, or separated (payroll final pay in v1)?

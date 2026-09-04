# T-208 — accounting-foundation audit remediation, batch 2

Status: done — 2026-09-04. The original blocker cleared (the concurrent T-176/T-178 session
committed and wrapped up); a second concurrent session (T-177) confirmed it had not yet touched
`findings.ts` before this landed, and will layer its own `posUsagePullNotRun` detector on top
afterward. See `docs/DEFECTS-REGISTER.md`'s DEF-157/DEF-159 rows for closing detail.

## Goal

Close `DEF-157` (reimbursement payable never clears) and `DEF-159` (cash-request liquidation gate
and ageing).

## Scope

- `packages/domain/src/expenses/` — new `payReimbursement` function (or similar), `Dr 2130 / Cr
  cash or bank`, named party, mirroring the shape of an AP/AR settlement.
- `packages/domain/src/cash-requests/index.ts` — refuse a new request/approval when the same
  person already holds one with `outstanding > 0`.
- `packages/domain/src/findings/index.ts` + `packages/db/src/repo/findings.ts` — two new
  detectors: `reimbursablePayableAgeing`, `cashRequestFloatAgeing`, wired into `listFindings`
  alongside the existing `supplierCreditAgeing`/`customerCreditAgeing` pair.

## Contract

Same shape as the existing `serviceChargeFloatAgeing`/`supplierCreditAgeing` detectors — age from
the posting date, a `hard`/`soft` severity split matching the existing convention in that file, a
`key` unique per (org, party) so an acknowledgement targets one instance.

## Invariants

Bible §16.10: "enforce liquidation before a new advance to the same person, and age unliquidated
advances." §16.1 invariant 4 (source-document traceability) for the new payout function.

## Tests

- `cash-requests.test.ts` — a new request is refused while an existing one for the same person is
  outstanding; released and fully liquidated, a new one succeeds.
- `expenses.test.ts` — `payReimbursement` debits `2130`, named party, references the settled
  expense(s).
- `findings.test.ts` — both new detectors fire and clear correctly; `listFindings`'s full feed
  still returns the right count with them added.

## Out of scope

Statutory-obligation ageing (bible §16.5's own requirement — separate, larger, gated on T-190/193
having data to work with at all).

## Done when

- [x] `findings/index.ts`/`repo/findings.ts` confirmed clean (not mid-edit by another session)
  before starting.
- [x] Same gate list as T-207 — typecheck clean · unit 996/997 (1 pre-existing skip) · full
  integration suite, 81 files / 2223 tests, green against `shareat_test_207` · `npm run build`
  exit 0.
- [x] `docs/DEFECTS-REGISTER.md`'s DEF-157/DEF-159 rows updated with their closing disposition.

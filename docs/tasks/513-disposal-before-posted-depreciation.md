# T-513: an asset cannot be disposed of on a date before depreciation that is already posted (audit CR-3)

**Status:** SPEC 2026-11-03 (AUDIT). Number from the orchestrator (BOARD line 130). Source: Goldfish review GF-100
(proposed P3), confirmed on origin/main 92382176 and re-graded P2 as CR-3
(`shareat-audits/OPEN/claude-current-revision-2026-11-03-findings.md`). No migration expected; if one turns out to be
needed, STOP and ask the orchestrator for a number. No DEF row (Ian, 28 Oct). Branch
`audit/t513-disposal-before-depreciation`, worktree `wt-audit-t513`.

## 1. The problem in plain words

`disposeAsset` (packages/domain/src/fixed-assets/dispose.ts:98-102) checks only that the disposal date is not before the
acquisition date. Accumulated depreciation is read from the ledger with no date limit
(`fixedAssetsRepo.accumulatedFromLedger`, packages/db/src/repo/fixed-assets.ts:426). So if January, February and March
depreciation are posted (entries dated 31 Jan, 28 Feb, 31 Mar) and someone disposes the asset "as of 15 Feb", the disposal
entry is dated 15 Feb but clears all three months from 1590. On 15 Feb the books then show more depreciation removed than
had been charged by that date, and depreciation entries dated after the asset's disposal stay in the ledger. Totals still
add up; the dates and the per-period picture are wrong.

## 2. Ruling (planner, AUDIT)

Refuse it. A disposal date must be on or after the date of the asset's latest posted (not reversed) depreciation entry.
To dispose earlier, the user first voids/reverses the later depreciation through the existing reversal path, then
disposes. Reason (plain words, `throw` or `{ ok:false }` matching how dispose.ts already refuses, which is `throw new
Error(...)` with a `disposeAsset:` prefix): `disposeAsset: disposal date <d> is before depreciation already posted up to
<latest date>. Reverse the later depreciation first, or dispose on or after <latest date>.`

Same-day is allowed (disposedOn == latest depreciation entry date). Reversed depreciation entries (status 'reversed' or
those with a reversal) do not count; match exactly what `accumulatedFromLedger` treats as live so the two never disagree.

**Built note (3 Nov):** `accumulatedFromLedger` sums every non-draft entry, so a reversed original and its reversal
net to zero there. A latest-date read cannot net, so `latestDepreciationDate` uses the same attribution plus two
conditions that drop BOTH halves of a reversed pair (`status <> 'reversed'` and `reversal_of_entry_id IS NULL`). The two
reads therefore agree on which depreciation is live. (`reverseEntry` dates the reversal on the original's date by
default, which would otherwise pin the latest date.) The numeric-write guard needed one EXEMPT line for the new
ISO-date string comparison, the same as the existing `disposedOn < acquiredOn` line.
A held asset with no depreciation keeps today's behaviour (only the acquisition-date check applies). Do not add an
in_service_on rule in this task.

## 3. Changes

1. `packages/db/src/repo/fixed-assets.ts`: add a read `latestDepreciationDate(tx, orgId, assetId): Promise<string | null>`
   using the SAME attribution and status filter as `accumulatedFromLedger` (`source_type = 'depreciation'`,
   `source_id = asset id`, same live-entry condition). SQL only in repo (bible §4.3).
2. `packages/domain/src/fixed-assets/dispose.ts`: after the acquisition check, call it and refuse as in §2. Before any
   write.

## 4. Tests (write them FIRST, show them failing on unchanged code, then fix)

Integration, real PostgreSQL on `shareat_test_audit513` (already in this worktree's `.env.local`; never print that file;
never use shareat_test or shareat_dev). File `tests/integration/t513-disposal-before-depreciation.test.ts` (or next to the
existing `fixed-assets.test.ts`; follow the neighbours and reuse its fixtures).
- (a) Asset with Jan/Feb/Mar depreciation posted; dispose on 15 Feb: refused with the plain reason; asset still
  `active`; no disposal journal entry; 1590/1510/7400 balances unchanged.
- (b) Same asset, dispose on 31 Mar (same day as the last entry): allowed, and the entry matches today's figures.
- (c) Same asset, dispose on 15 Apr: allowed (positive control, unchanged amounts).
- (d) Reverse March's depreciation through the existing reversal function, then dispose on 15 Mar: allowed, and the
  accumulated amount used equals Jan+Feb only.
- (e) Held asset / asset with no depreciation entries: disposal after acquisition still allowed.
Assert the error message pattern, not a bare `rejects.toThrow()`.

## 5. Checks
- Root `npm run typecheck` clean.
- New test file plus the existing fixed-asset integration files (fixed-assets.test.ts, t368-*, t346-* that touch
  disposal) green on `shareat_test_audit513`.
- Unit guard/census files (`tests/unit/*guard*`, `*census*`, app-boundaries) green.
- No CR bytes. `git diff --stat` shows only the two source files, the new test and this spec.

## 6. Acceptance
No disposal can be dated before the asset's latest live depreciation entry; earlier disposal needs the later months
reversed first; all other disposals behave as before. Closing CR-3 in `shareat-audits` happens after merge.

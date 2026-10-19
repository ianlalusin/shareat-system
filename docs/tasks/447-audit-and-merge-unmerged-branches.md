# T-447 — Audit, test, merge and deploy unmerged work

Status: IN PROGRESS. Ian, 2026-10-19: merge all unmerged branches once green, then deploy so he can see them live.

## Inventory at 22:33 Manila

| Branch | Unmerged work | Initial evidence |
|---|---|---|
| codex/compact-form-fields | T-445 compact controls; T-446 plain white content and related rows | Draft PR #38; 212 affected unit tests + 67 PostgreSQL tests pass; 56 caller/census guards pass; full CI running |
| lane/t442-l1 | Committed T-441 lightbox containment correction, two files | Source matches T-441 L1 contract; 34 wiring checks pass; uncommitted T-442 backfill work is separate |
| lane/t440-sweep | Live field checks and authorization-first validation | Working tree contains uncommitted S9 corrections; initial focused run 318 passed / 11 failed (conditional rules not implemented, stale baseline); must finish/audit before merge |
| claude/pos-v2-907a29 | T-425 offline work; T-426/T-427 approved specs and red tests | Full POS unit run started; T-426/T-427 source implementations absent; not merge-ready |

All other local/remote branch heads are already ancestors of origin/main. Historical branches need no duplicate merge.
Do not include unrelated root docs/operations/. Preserve other worktree changes and distinguish committed branch work
from uncommitted next-slice work before staging anything.

## Execution and scope

Audit each diff against its existing task contract, run affected checks, fix real defects without weakening tests,
and use PR CI for the full suites. No merge while red. Merge only reviewed green work; deployment remains the normal
CI-built artifact workflow, never a build on either droplet. Existing task specs own implementation file scope:
T-445/T-446 for the workspace; T-441 L1 for Lightbox.tsx and its wiring test; T-440 S9 for auth/conditional field rules;
T-425/T-426/T-427 for POS. This task owns this inventory and docs/reviews/t447-unmerged-branches.md.

Browser automation is denied by a saved permission/managed policy even after Ian enabled access. No alternate browser
surface/network workaround is allowed. Ian was offered the synthetic localhost preview for manual screenshots. Its
two-hour session had expired and was refreshed on 19 Oct without linking a real identity into the synthetic database.
Ian chose: **deploy green work first, then continue unfinished branches** (19 Oct). After reviewing the refreshed local
preview he approved: **"better now go"**. PR #38 passed full CI on 8cc3925 and merged as 758a48c; main CI 39272611434
and Deploy 39275146755 succeeded. Compact white UI is live. No automated visual-verification claim is made.
POS baseline: 14 failed / 59 passed files; 161 failed / 635 passed / 1 skipped tests. T-426/T-427 modules are missing.
T-440 S9 B now implemented in wt-t386; the existing conditional tests plus three new state regressions were red first.
Broader T-440 unit run: 1,403 passed; focused PostgreSQL integration: 55 passed. A subsequent audit found G6 accepted
`if (!record || await can(...))`, including paths where can never runs; a new control was red before tightening this proof
and removing four ungated fallbacks in money-transfer/trade actions. G6 then passed 14 tests with no baseline file.
Additional supporting files outside S9 B's short list: check-dom.ts, check-state.ts and FieldCheck.tsx are required for
controller reads, applicability state and disabled-control ownership; three existing supplier regression files and the
S4 parity fixture update the explicitly revised blank sentence without removing their data/rollback assertions.

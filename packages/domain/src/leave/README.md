# Leave
## Overview
Leave and absence tracking (T-436): requests, manager-recorded leave, approve/reject/cancel/void, per-kind caps, Service Incentive Leave (SIL) entitlement and balance, medical-certificate documents, and the payroll effect of leave. The scope of every balance and rule is the PERSON, not the employment, and every transition is race-safe under the person's leave lock.
## Interface
- `index.ts` (barrel): `export *` from `requests` and `documents`; from `sil` `silEntitlementDays`, `silAnniversary`, `serviceStartFor`; `isoDateCompare` (alias of `cmpIso`); from `refusal` `LeaveRefusal`, `leaveRefusal`, `LEAVE_REFUSAL_CODES`, `LeaveRefusalCode`; `LEAVE_DOCUMENT_LINK_SECONDS`.
- `requests.ts`: `requestLeave`, `recordLeave`, `approveLeave`, `rejectLeave`, `cancelLeave`, `voidLeave`, `setLeaveCap`, `addLeaveType`, `setLeaveTypeActive`, `listLeaveTypes`, `listLeaveCaps`, `silBalance`, `loadLeaveRequest`, `listLeave`, `leaveGrid`, `exportLeaveCsv`, `myLeave`; types `LeaveDayInput`, `LeaveRequestInput`, `LeaveCapInput`, `LeaveRequestView`, `LeaveRow`, `MyLeave`.
- `documents.ts`: `attachLeaveDocument`, `leaveProofFileId`.
- `document-access.ts`: `LEAVE_DOCUMENT_LINK_SECONDS` (60), `decideLeaveDocumentRead`, `recordLeaveDocumentViewed`, `recordLeaveDocumentViewRefused`, type `LeaveDocumentVerdict`.
- `checks.ts`: `leaveKindDays`, `pickCap`, `computeSilBalance`, `effectivePaid`, `checkAndPrice`, `withinEmployment`, `loadEmployment`, types `DayIn`, `SilBalance`, `CheckContext`.
- `sil.ts` (pure): `silAnniversary`, `silEntitlementDays`, `serviceStartFor`, type `ServiceSpan`.
- `dates.ts` (pure): `cmpIso`, `isoBefore`, `isoAfter`, `isoOnOrBefore`, `isoOnOrAfter`.
- `refusal.ts`: `LEAVE_REFUSAL_CODES`, `LeaveRefusalCode`, `LeaveRefusal`, `leaveRefusal`.
- `audit.ts`: `audit`, type `LeaveAuditInput`.
- `payroll.ts` (imported by relative path from payroll, not in the barrel): `SIL_COMMUTATION_SOURCE`, `sumMoney`, `planLeavePayroll`, `applyLeaveToRun`, `releaseLeaveOfRun`, `settleSilAtSeparation`, `releaseSilOfSeparation`, types `LeavePayLine`, `SilPayoutPlan`, `LeavePayrollPlan`.
- `worked.ts` (imported by `attendance/adjudicate.ts`, not in the barrel): `reconcileLeaveWithWorkedDay`, type `LeaveWorkOutcome`.
## Invariants
- Authorize, then take the person's leave lock (`lockPersonLeave`), re-read the status, and move it with `UPDATE ... WHERE status = <from>`; zero rows means `LEAVE_NOT_PENDING`. Cap and SIL counts are read under the same lock.
- Nobody approves their own leave (keyed on the person, not the role); the one exception is a super_admin, audited as `leave.self_approved`.
- Whole days only; a `portion` is refused. A `rest_day` row is not leave (pays nothing, uses no SIL, counts toward no cap).
- Cap precedence: store+position, then position, then store, then org default; a more specific NULL ("no limit") still wins.
- SIL: 5 days once a year of service is complete; anniversary-year entitlement is `ceil(5 x M / 12)` (company policy, rounded up). Service start is the earliest start of the person's current unbroken employment chain.
- Refusals are typed (`LeaveRefusal` with a `code` from `LEAVE_REFUSAL_CODES`) and the sentence carries the numbers.
- The leave note is personal data: only `loadLeaveRequest` returns it, and audit payloads never carry the note or any file id, path or URL.
- Leave documents are read only through `decideLeaveDocumentRead`; links last 60 seconds; a refused view is audited in its own transaction.
- Leave pay and SIL conversion are NOT part of `basic_pay` (13th month excludes them); one SIL payout per person per year; a paid leave day freezes to the pay run and voiding the run releases it.
- `worked.ts` stays a leaf (db repos plus audit only) so attendance can import it without a cycle; ISO dates are compared via `cmpIso`, not `<`/`>` on strings.
## Side Effects
- DB writes via `leaveRepo`, `auditLogRepo`, `advisoryLocksRepo` on the caller's `Tx`, or on a fresh `transaction` when `tx` is `null` (request and document functions).
- `payroll.ts` posts and reverses ledger entries (`postEntry`, `reverseEntry`, debiting account 6100) and freezes/releases leave days and payouts.
- `documents.ts` stores photos through the file broker (`uploadFile`/`claimUpload`/`linkFile`).
- `document-access.ts` writes audit rows and uses `withOrgPrincipal` for an independent transaction; logs via the logger.
- `worked.ts` writes `superseded_by_work` or holds an attendance day and appends a system audit row.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)

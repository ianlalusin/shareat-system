# Audit report - Shareat System (ERP, POS, Customer) - 2026-11-13

Produced with the `app-audit-and-test` skill. **Mode: Report only.** No source file was changed.

## Summary
The foundations are strong: sign-in, the central permission check, company separation in the database, exact-centavo money handling, backups and the till's server-protected actions all held up. The serious findings are about money leaving unseen: on the till a cashier can void items, mark them free or give a discount above 100% with no manager approval, and in the ERP a second payment of the same amount on the same day to the same obligation is silently not recorded while the screen reports success. Several finance screens can be read by any signed-in staff member across all stores. Nothing was fixed in this pass because the project requires a task spec before code changes and the working tree holds 458 uncommitted files of in-flight work. On 2026-11-13 the owner ruled on the four open questions: till voids and line discounts stay as designed (with a store setting to build for when a guard is wanted), the finance screens get read permissions, a repeated Senior/PWD ID gets a warning, and voiding a deposit will need a manager PIN. Signed-in screens were not clicked through; most findings are confirmed by reading the code, not by running it.

| Status | Count |
|---|---|
| Closed | 0 |
| Accepted | 1 |
| Open | 23 |
| Needs decision | 0 |

## App profile
```
Purpose:        Accounting-correct rebuild of the Shareat restaurant ERP, with a POS till and a diner app. Staff, managers, finance, owner.
Platform(s):    Web (ERP, Next.js server). Android tablet shell for POS (Capacitor). Android shell for Customer (Capacitor, fixture-only skeleton today). Scheduled operator scripts.
Stack:          TypeScript, Next.js 16.3.2, React 18, Drizzle ORM 0.38, PostgreSQL 18, Firebase Auth (identity only) + Firestore (mirror and inbox; the POS writes to it directly), Vitest 4, GitHub Actions, Caddy on the server.
Dependencies:   npm workspaces: 3 apps, 8 packages. Shaping ones: next, drizzle-orm, firebase, firebase-admin, @capacitor/*, zod, xlsx, @aws-sdk/client-s3, pino.
Data:           PostgreSQL is the system of record (168 tables, all in the row-level-security registry). Firestore holds a read-mostly mirror, an append-only inbox, and the POS's live receipts. Files in object storage.
Auth & roles:   Firebase sign-in or staff code + PIN -> server session cookie. One `authorize()` module: org, then role and grants, then store scope. Roles include staff, manager, admin. Manager PIN approvals on the till are checked on the server.
External:       Firebase, object storage, PayMongo QR (POS), GitHub Actions deploy over SSH to the production host.
How to run:     npm ci; npm run typecheck; npm run test; npm test -w @shareat/pos; npm test -w @shareat/customer; npm run test:integration (shared test database); npm run start on port 9008 (`next dev` is known broken here, DEF-401).
Environments:   Local (allowed). Production erp2.shareat.net (read-only requests only). Reference repos are read-only and were not opened.
Connections:    Database -> localhost:5435 / shareat_dev (local). Test database -> localhost:5435 / shareat_test (shared between sessions). Sign-in -> the real Firebase project (no emulator configured). Storage -> none configured locally (in-memory).
Riskiest parts: Ledger postings, cash on the till (voids, discounts, refunds, handover), payroll, permissions across stores, offline sync, deploy pipeline.
Mode:           Report only - the project rule "no implementation without a written task spec" applies, and the tree has 458 uncommitted files from other work on branch feat/store-settlement-settings.
```

## Coverage
| # | Area | Plan | Result |
|---|---|---|---|
| 1 | Runs and builds | Check: type-check, three unit suites, start the built app, health | 1 finding (A-20). Type-check clean. POS 969 pass, Customer 90 pass. App starts, health ok, database reachable. Build and integration suite not run |
| 2 | Function | Check: signed-out behaviour of every route and page; till flows by reading | 1 finding (A-22). Signed-in flows not run |
| 3 | Data integrity | Check: money math, postings, idempotency, races, time zone, till totals | 11 findings (A-06, A-07, A-08, A-09, A-10, A-12, A-13, A-14, A-15, A-16, A-23) |
| 4 | Security | Check: every route handler and server action for a guard, store scoping, till approvals, input into HTML, secrets | 7 findings (A-01, A-02, A-03, A-04, A-05, A-11, A-21) |
| 5 | Dependencies | Check: npm audit, npm outdated | 1 finding (A-19) |
| 6 | Errors and resilience | Check: bad and unauthenticated requests, swallowed errors around financial writes | checked, nothing found |
| 7 | Performance | Cannot check - not reached in this pass | cannot check - needs a signed-in session with realistic data |
| 8 | UX and accessibility | Cannot check - signed-in screens were not opened | cannot check - needs a browser session with test accounts |
| 9 | Platform and release config | Check: Android manifests, Capacitor config, Firestore rules, CI and deploy workflows, live response headers | 3 findings (A-17, A-18, A-24) |
| 10 | Docs and upkeep | Check: README commands against reality | checked, nothing found (leftover files are in A-24) |

## Checklist

- [ ] **A-02 - Finance screens can be read by any signed-in staff member, across all stores** · Area: Security · Severity: High · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-834
  - Finding: Accounts payable (every supplier balance and invoice), budgets, cash requests, and single expense, sales-day and wastage records only check that someone is signed in. They load data for the whole organization with no permission and no store filter. Changes are still properly gated; this is read-only exposure. The page-permission map says some counter screens are open on purpose, but does not name these.
  - Proof: `apps/erp/src/app/ap/page.tsx:25` calls only `requireSession('/ap')`, then `ap/lib.ts:32-51` reads org-wide via `withOrgPrincipal(orgId)`. None of `/ap`, `/budgets`, `/cash-requests` appear in `apps/erp/src/lib/route-capability.ts`. Same shape in `budgets/page.tsx:46`, `cash-requests/page.tsx:31`, `expenses/[id]/page.tsx:55`, `sales-days/[id]/page.tsx:42`, `wastage/[id]/page.tsx:43`.
  - Action taken: none - decided, needs a task spec
  - Decision made: Ian, 2026-11-13: add them - AP, budgets and cash requests go in the permission map, and single-record pages are limited to the person's stores.

- [ ] **A-06 - A second same-day, same-amount payment is silently not recorded** · Area: Data integrity · Severity: High · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-830
  - Finding: Ledger entries for liability payments and owner transactions use a key built from the record, the date and the amount. A second real event with the same three values is treated as a repeat and not posted, and the function still reports success. Two real ₱5,000 payments on one obligation on the same day would leave the books showing one, with ₱10,000 gone from cash.
  - Proof: `packages/domain/src/liabilities/index.ts:212` - `idempotencyKey: liability:${id}:payment:${on}:${amount}`; lines 234-241 return `result.entryId` and never read `result.created`. Same key shape at `owners/index.ts:193, 343, 425, 503, 586` and `loans/index.ts:176`. `service-charge/index.ts:163` already passes `created` on, so the pattern for the fix exists.
  - Action taken: none - report-only mode. Clear fix: a key unique per submission (a form token or generated id), and callers that surface `created: false`.
  - Verification blocked: needs a write test against a database; the shared test database was not used in this pass.
  - Decision made: none needed

- [ ] **A-07 - A percent discount is not capped at 100%** · Area: Data integrity · Severity: High · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-831
  - Finding: Fixed-amount discounts are capped at the line or bill value; percent discounts are not, on lines or on the whole bill. A 150% line discount on a ₱900 line would pull ₱450 off the rest of the bill.
  - Proof: `apps/pos/src/lib/money/line-amounts.ts:57-58` multiplies by `pct(adj.value)` with no limit (the fixed branch on line 60 uses `.min(...)`); the form only requires `discountValue >= 0` (`edit-billable-item-dialog.tsx:43`); `lib/money/ordinary-bill.ts:11` has the same shape for bill promos.
  - Action taken: none - report-only mode. Clear fix: cap percent at 100 in the money functions and the form.
  - Decision made: none needed

- [ ] **A-08 - Cash handover ignores cash refunds** · Area: Data integrity · Severity: High · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-832
  - Finding: Expected cash at shift handover skips every refund receipt and subtracts nothing for it. Refunds are cash-only, so a ₱1,200 refund makes the outgoing cashier look ₱1,200 short.
  - Proof: `apps/pos/src/lib/cash/handover.ts:76` - `if (r?.isRefund === true) return;` with no deduction elsewhere in the loop.
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-03 - Senior/PWD discount accepts any ID text and repeats across tables** · Area: Security · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-843
  - Finding: Any cashier can add a Senior/PWD diner (20% off plus VAT removal) with any non-empty ID, such as "1". Duplicates are caught only within one bill, so one ID can be used at several tables the same evening.
  - Proof: `apps/pos/src/lib/statutory/capture.ts:22-33`.
  - Action taken: none - decided, needs a task spec
  - Decision made: Ian, 2026-11-13: warn on repeated use of an ID; no manager PIN. What counts as repeated (auditor's reading: same store, same business day) is for the planner to confirm.

- [ ] **A-04 - A reservation deposit can be voided with a typed reason only** · Area: Security · Severity: Medium · Confidence: Suspected · Status: **Open** · Register: DEF-844
  - Finding: Anyone who can open a reservation can void its deposit with free text. There is no PIN and no check that the deposit was already applied to a bill. Staff could record a cash deposit, void it as "wrong entry" and keep the cash.
  - Proof: `apps/pos/src/components/reservations/ReservationPaymentVoidModal.tsx:37-62` (read by the reviewer; not re-read or run by the lead).
  - Action taken: none - decided, needs a task spec
  - Decision made: Ian, 2026-11-13: agreed - manager PIN to void a deposit, and refuse once it is applied to a bill.

- [ ] **A-09 - Sales totals can be reversed for a receipt that was never voided** · Area: Data integrity · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-835
  - Finding: The till server's analytics "void" operation removes a receipt's sales from the day, month and year totals without checking the receipt's status. Any signed-in cashier's tablet can call it, and the ERP sales pull reads those totals.
  - Proof: `apps/pos/src/server/pos2/apply-delta.ts:45-57` - the `void` branch checks only the `analyticsReversed` and `analyticsApplied` flags, then rebuilds the receipt "as original".
  - Action taken: none - report-only mode. Clear fix: refuse unless the receipt's status is voided.
  - Decision made: none needed

- [ ] **A-10 - A sale can be counted twice in analytics after a crash or timeout** · Area: Data integrity · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-836
  - Finding: The tablet's fallback applies the analytics in one write and marks "applied" in a second. A crash between them, or a server call that timed out after succeeding, makes the retry queue apply it again.
  - Proof: `apps/pos/src/components/cashier/firestore.ts:862-875` (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-11 - Customer name is written into a print page as raw HTML** · Area: Security · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-837
  - Finding: The browser fallback for printing a password slip builds a page from the customer's name and phone without escaping. A customer who signs up with script in their name would run it under the staff member's sign-in when the slip is printed.
  - Proof: `apps/pos/src/components/pins/customers-admin.tsx:403-409, 424` (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-12 - Two returns at the same moment can exceed what was delivered** · Area: Data integrity · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-838
  - Finding: The "how much can still be returned" check reads without a lock and no database rule backs it. Two returns of 8 against a line of 10 can both pass, reversing stock and payables for 16.
  - Proof: `packages/domain/src/stock/supplier-returns.ts:143-157` and `packages/domain/src/trade/returns.ts:99`; no lock in either file and no cap trigger in migrations 0118/0119 (reviewer's search).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-13 - Overdraft check reads the balance without locking the account** · Area: Data integrity · Severity: Medium · Confidence: Suspected · Status: **Open** · Register: DEF-839
  - Finding: Two payouts at the same moment from one cash account can both pass the balance check and take it negative.
  - Proof: `packages/domain/src/money-accounts/overdraft.ts:53` (`checkDraw`); callers include `liabilities/index.ts:206`. Only staff-float cash requests take a row lock (`approve.ts:134`).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-14 - Two loan payments at the same moment can double-book interest** · Area: Data integrity · Severity: Medium · Confidence: Suspected · Status: **Open** · Register: DEF-840
  - Finding: A loan payment reads the outstanding amount and last payment date without a lock. Two at once each take the same accrued interest and both pass the overpayment check.
  - Proof: `packages/domain/src/loans/index.ts:233-255, 312` (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-15 - Loan interest is calculated with floating-point numbers** · Area: Data integrity · Severity: Medium · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-841
  - Finding: This breaks the project rule "money is never a float". The result is posted to the ledger, and a half-centavo tie can round the wrong way.
  - Proof: `packages/domain/src/loans/interest.ts:68-69` - `Number(base) * dailyRate(...) * days` then `amount.toFixed(2)`.
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-16 - A reservation deposit could be credited on two bills** · Area: Data integrity · Severity: Medium · Confidence: Suspected · Status: **Open** · Register: DEF-842
  - Finding: A deposit counts as used only if a marker matches the current session. The marker is written after payment, and a failed write is only logged.
  - Proof: `apps/pos/src/components/cashier/payment-modal.tsx` around lines 175 and 436-452 (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-17 - Live ERP sends no browser-protection headers** · Area: Platform and release config · Severity: Medium · Confidence: Confirmed · Status: **Open** · Register: DEF-845
  - Finding: No protection against being framed by another site, no "do not guess file types", no script policy and no "always use https" header. The server software name is advertised.
  - Proof: `curl -sI https://erp2.shareat.net/sign-in` returned `HTTP/1.1 200 OK` and `X-Powered-By: Next.js`, and none of X-Frame-Options, Content-Security-Policy, X-Content-Type-Options, Referrer-Policy or Strict-Transport-Security. `apps/erp/next.config.js` has no `headers()`; the Caddy config in `docs/ops/provision.sh:151-153` is a bare reverse proxy.
  - Action taken: none - report-only mode, and it is a production setting.
  - Decision made: none needed

- [ ] **A-18 - Deploy trusts whatever server key it is shown** · Area: Platform and release config · Severity: Medium · Confidence: Confirmed (by reading) · Status: **Open** · Register: DEF-846
  - Finding: Each deploy fetches the production server's identity key from the network instead of using a stored one. Someone able to intercept the connection could receive the build and the session.
  - Proof: `.github/workflows/deploy.yml:133` - `ssh-keyscan -H`.
  - Action taken: none - report-only mode. Clear fix: store the host key as a repository secret.
  - Decision made: none needed

- [ ] **A-19 - 37 packages have known security problems, 3 critical** · Area: Dependencies · Severity: Medium · Confidence: Confirmed · Status: **Open** · Register: DEF-847
  - Finding: Critical: `next` (a fix exists inside the same major version: 16.3.2 -> 16.4.6), `shell-quote`, and `tar` (through `@capacitor/cli`). High includes `xlsx` (no fix offered), `drizzle-orm`, `zod`, `firebase`.
  - Proof: `npm audit` -> `37 vulnerabilities (1 low, 21 moderate, 12 high, 3 critical)`.
  - Action taken: none - report-only mode. The `next` update is the clear first step.
  - Decision made: none needed

- [ ] **A-20 - 16 to 25 unit tests fail in the current working tree** · Area: Runs and builds · Severity: Medium · Confidence: Confirmed · Status: **Open**
  - Finding: The main unit suite is red on this branch with its uncommitted files, and the count changes between runs (25, then 16), so some failures are timing-related when everything runs at once. In the second run, 11 of the 16 are guard tests reacting to the in-flight work (new untracked README files, a new folder without a ceiling entry, an exported function with no caller, a route not reachable from the menu, unlogged edits to copied POS files, faint grey text). The other 5 are behaviour tests and deserve a look: 2 in `inter-store-legs.test.ts` (inter-store ledger pairs) and 3 in `t343-s5-5s-number-boxes.test.ts` (amount boxes on the transfer and settlement forms). Why those 5 fail was not investigated.
  - Proof: run 1: `Test Files 14 failed | 403 passed (417)`, `Tests 25 failed | 9047 passed | 4 skipped (9076)`. Run 2: `Test Files 10 failed | 407 passed (417)`, `Tests 16 failed | 9056 passed | 4 skipped (9076)`. Failing files in run 2: `apps/erp/tests/t343-s5-5s-number-boxes.test.ts` (3), `packages/domain/tests/unit/inter-store-legs.test.ts` (2), `tests/unit/t343-throw-ratchet.test.ts` (2), `tests/unit/production-caller-ratchet.test.ts` (2), `tests/unit/pos-v2-copy.test.ts` (2), `tests/unit/nav-route-reachability.test.ts` (1), `tests/unit/domain-actions-have-callers.test.ts` (1), `packages/domain/tests/unit/t440-field-rules.test.ts` (1, expected `[]`, received `["README.md"]`), `apps/erp/tests/t541-no-faint-grey-text.test.ts` (1), `apps/erp/tests/t441-s1-upload-rules.test.ts` (1, the known timing issue DEF-722).
  - Action taken: none - the files belong to in-flight work.
  - Decision made: none needed

- [ ] **A-05 - Diner app design lets a guessed session number reach another table** · Area: Security · Severity: Medium · Confidence: Suspected · Status: **Open** · Register: DEF-848
  - Finding: The customer app is a sample-data skeleton today, so nothing is exposed yet. But its interface, which the README names as the specification for the real server, identifies a table by a session id alone, mints them in sequence (`sess-1`), keys PIN lockout on an id the phone supplies, and returns the sign-up SMS code to the phone. Copied as is, a diner could read or order on another table's bill.
  - Proof: `apps/customer/src/data/customer-data.ts:21-24, 31`; `fixture-data.ts:73, 142-156, 250`.
  - Action taken: none - report-only mode. Clear fix when the server is built: unguessable ids, server-side participant check, throttling by table and IP, never return the code.
  - Decision made: none needed

- [ ] **A-21 - ERP: export files can carry formulas; health check reveals the build** · Area: Security · Severity: Low · Confidence: Confirmed (by reading) · Status: **Open** · Register: DEF-849 to DEF-850
  - Finding: (1) Report exports do not neutralise text starting with `= + - @`, so a supplier named like a formula runs when finance opens the file in Excel. (2) The public health address returns the exact build id and time.
  - Proof: `apps/erp/src/lib/csv.ts:9-14`; `apps/erp/src/app/api/health/route.ts:57-70`; live response included `"sha":"6bff..."`.
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-22 - POS: smaller till issues** · Area: Function · Severity: Low · Confidence: Confirmed (by reading, not run) · Status: **Open** · Register: DEF-851 to DEF-855
  - Finding: (1) Paying a bill already closed on another tablet shows "Payment Successful" and records nothing (`components/cashier/firestore.ts` ~520-527). (2) Reprinted receipts carry no COPY mark (`lib/printing/receiptFormatter.ts`, `hooks/use-print.ts:65`). (3) A refused refund burns a receipt number with no skipped-number record (`components/receipts/RefundReceiptDialog.tsx:96-116`). (4) A payment 1 centavo short is accepted (`payment-modal.tsx:46,55`). (5) Refund line shares ignore modifier prices (`lib/money/refundShare.ts:35`).
  - Proof: file and line as listed (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-23 - Data layer: smaller issues** · Area: Data integrity · Severity: Low · Confidence: Suspected · Status: **Open** · Register: DEF-856 to DEF-860
  - Finding: (1) `month-end --period=2026-13` is not validated and posts depreciation into January 2027 (`scripts/month-end.ts:30`). (2) A return at one store can cite another store's delivery line in the same org (`stock/supplier-returns.ts:129,140`). (3) Two queries build SQL text from ids read from the database (`packages/db/src/repo/payroll.ts:457`, `repo/cutover.ts:35`). (4) Overtime and holiday pay factors pass through floating point (`payroll/compute.ts:217-225`). (5) A date cast may be a day off for rows created between midnight and 8 am Manila (`repo/findings.ts:1816,1826`).
  - Proof: file and line as listed (reviewer's reading).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-24 - Release, mobile and repo hygiene: smaller issues** · Area: Platform and release config · Severity: Low · Confidence: Confirmed (by reading) · Status: **Open** · Register: DEF-861 to DEF-865
  - Finding: (1) The deploy trigger checks branch name and success only, not that the run came from this repository's own push (`deploy.yml:26-31,47`); pull-request jobs inherit signing secrets (`ci.yml:259-266`, `app-build.yml:44-49`). Both are limited by the repo being private. (2) Both Android apps allow device backup of app data (`AndroidManifest.xml:4` in `apps/pos` and `apps/customer`); the customer release build falls back to the debug key when no release key is present (`apps/customer/android/app/build.gradle:46`). (3) The Firestore inbox rule checks required fields but allows extra ones (`firebase/firestore.rules:63-74`). (4) `.tmp-login.mjs` and `.tmp/` are untracked but not ignored, and `.tmp/ui/auth.json` is a saved session; `.playwright-mcp/` has 11 tracked screenshots. (5) `@capacitor/core` is declared in the customer app and unused.
  - Proof: file and line as listed; `git check-ignore` and `git ls-files` (reviewer's run).
  - Action taken: none - report-only mode.
  - Decision made: none needed

- [ ] **A-01 - Cashier can void items, mark them free or discount a line with no manager approval** · Area: Security · Severity: High · Confidence: Confirmed (by reading, not run) · Status: **Accepted** · Register: DEF-833
  - Finding: On the till's "edit item" dialog, voiding quantity, marking items free and line discounts have no role check and no manager PIN. Only the bill-level discount button is hidden from cashiers. These are direct database writes from the tablet, so the server never sees them. A cashier could take cash for 10 unlimited-meal heads, void 9 as a "mistake" and keep the difference.
  - Proof: `apps/pos/src/components/cashier/edit-billable-item-dialog.tsx` - a search of the file for `role`, `isManager`, `pin`, `approval` finds nothing; contrast `bill-adjustments.tsx:235-239`, which hides the bill discount by role.
  - Action taken: none - accepted as designed; the setting is recorded in DEF-833 as work to spec
  - Decision made: Ian, 2026-11-13: by design - cashiers may void, mark free and discount a line. Follow-up to build: a store setting, off by default, that requires the manager PIN for these actions, so the guard is ready when a store needs it.

### Already in the defects register (not counted above)
- DEF-749: any signed-in user can read every store's mirror in Firestore (`firebase/firestore.rules:30-31,39`). Still open in code.
- DEF-018: an offline sale does a blind write of the receipt and can overwrite a finalised one (`apps/pos/src/components/cashier/offlinePayment.ts:296`). Still open in code.
- DEF-652: receipts and totals are written by the tablet; server refund and correction paths read those client-writable values. Still open in code.

### Checked and found sound
- All 12 API route handlers refuse signed-out requests (307 to sign-in, 401 or 405). All 96 static pages redirect signed-out visitors, except the sign-in page, the kiosk pairing screen and an empty report shell, none of which show data.
- The "return to" address after sign-in is sanitised (`safeNext`).
- Every server action has a session check; actors come from the session, never the form. `authorize()` checks org, then role and grants, then store.
- Money core: whole centavos, one rounding rule, allocation remainders handled. All 168 tables are in the row-level-security registry; no permissive policies.
- Backup, restore drill and purge scripts have real guards. Secrets files and `.env.local` are ignored by git; no keys are tracked.
- Till server actions (refund, tender correction, void) verify the token, staff record and store, use idempotency keys and transactions; manager PIN is checked on the server with an attempt cap.

## Not tested
- Any signed-in screen in a browser, on a tablet or on a phone: no clicking through ERP, POS or Customer flows. Needs test accounts and, for POS, an Android device or emulator.
- Writes of any kind. The findings about dropped payments, races and totals are from reading the code. Proving them needs a disposable database; the shared test database was left alone.
- `npm run test:integration` (shared test database) and `npm run build`.
- The live Firestore security rules for the POS, which are outside this repo. Every till check that exists only in the app depends on them.
- Older server routes the POS still calls (`/api/loyalty/*`, `/api/pins/*`), printers, PayMongo, kitchen screens.
- Performance, accessibility, and most of the roughly 90 repository files and 25 domain modules beyond a search.
- The live site beyond two read-only requests (sign-in page headers, health).

Method notes: four reviewers read the code by area (ERP permissions; data and money; POS; customer app, Firebase rules and release setup). The lead re-read the top finding of each area in the source before listing it. The app was started from the existing build of 10 November on 127.0.0.1:9008 for the signed-out sweep and stopped afterwards. No file in the repository was changed except this report.

# Handoff - app audit of 2026-11-13 (paste this to the session that picks it up)

You are picking up the results of an independent audit of `C:\Users\ianla\webapps\shareat-system`, run on
2026-11-13 by a session outside the lanes. You start cold. Read `docs/RULES.md` first; everything below
obeys it. The audit changed **no source code**.

## What exists now

| File | State |
|---|---|
| `docs/reviews/2026-11-13-audit-report.md` | New, untracked. 24 items: 23 Open, 1 Accepted, 0 awaiting Ian. Has the app profile, coverage, proof per item and a "Not tested" list |
| `docs/DEFECTS-REGISTER.md` | 36 rows added at the top of section E (**DEF-830 to DEF-865**) and two change-log lines dated 2026-11-13. The file already carried someone else's uncommitted edits; the audit only added lines |
| This file | New, untracked |

Nothing is committed. The tree had 458 uncommitted files on `feat/store-settlement-settings` before the
audit and has 3 more now (the report, this file, and the register edit rides in the existing diff).

## How much to trust it

- Method: four Sonnet reviewers read the code by area; the lead re-read the top findings.
- **10 rows are `verified`** (lead read the code or saw the live response): DEF-830, 831, 832, 833, 834,
  835, 841, 845, 847, 850. **26 are `reported`**: re-read the cited lines before acting (register rule).
- Almost everything is confirmed by reading, **not by running**. No database was written to. No signed-in
  screen was opened. `test:integration` and `npm run build` were not run.
- Ran: `npm run typecheck` clean; POS unit 969 pass; Customer unit 90 pass; `next start` on 9008 from the
  10 November build for a signed-out sweep (12 route handlers and 96 static pages all refuse or redirect).
- Root unit suite is red in this working tree and unstable: 25 failed, then 16 failed, of 9,076. Eleven of
  the 16 are guard tests reacting to in-flight files. Five are behaviour tests nobody has explained:
  `packages/domain/tests/unit/inter-store-legs.test.ts` (2) and
  `apps/erp/tests/t343-s5-5s-number-boxes.test.ts` (3). Whoever owns that work should look.

## Ian's rulings, 2026-11-13 (given in chat; recorded in the register rows and the report)

| Row | Ruling |
|---|---|
| **DEF-833** POS void / mark free / line discount with no approval | **By design.** Cashiers may do these. **Build a store setting, off by default, that requires the manager PIN for the three actions**, so the guard exists when a store needs it |
| **DEF-834** ERP finance screens readable by any signed-in staff, org-wide | **Add them.** `/ap`, `/budgets`, `/cash-requests` into `ROUTE_CAPABILITY`; store-scope the single-record pages (`expenses/[id]`, `sales-days/[id]`, `wastage/[id]`) |
| **DEF-843** Senior/PWD ID accepts anything and repeats across bills | **Warn on repeated use. No manager PIN.** The window for "repeated" was not stated; the auditor read it as same store, same business day - confirm with Ian or rule it in the spec |
| **DEF-844** Reservation deposit void with free text only | **Agreed with the recommendation:** manager PIN to void, and refuse once the deposit is applied to a bill |

Still to do for these rulings, and not done by the audit because they are not an outside session's to do:
1. **Bible §13 rows** for the four rulings - planner only (RULES §1 row 14).
2. **Copy the four answers to the Open Questions page** (RULES §2: answers given in chat are copied there).
3. **Task specs** in `docs/tasks/` before any code (RULES §1 row 8). DEF-833's setting touches POS and
   store settings; DEF-834 touches `apps/erp/src/lib/route-capability.ts` and its coverage test.

## The new register rows

Money and correctness (⛔):
- **DEF-830** `verified` - a second same-day, same-amount payment is silently not posted: content-based idempotency key and ignored `postEntry().created`. `packages/domain/src/liabilities/index.ts:212,234-241`; same key shape `owners/index.ts:193,343,425,503,586`, `loans/index.ts:176`. `service-charge/index.ts:163` shows the fix pattern.
- **DEF-831** `verified` - POS percent discount not capped at 100. `apps/pos/src/lib/money/line-amounts.ts:57-58`, `lib/money/ordinary-bill.ts:11`, form at `components/cashier/edit-billable-item-dialog.tsx:43`.
- **DEF-832** `verified` - POS cash handover skips refund receipts and deducts nothing. `apps/pos/src/lib/cash/handover.ts:76`.
- **DEF-833** `verified` - see rulings: by design, plus a setting to build.
- **DEF-841** `verified` - loan interest in floating point. `packages/domain/src/loans/interest.ts:68-69`.

Structural and security (⚠️):
- **DEF-834** `verified` - see rulings: add the read gates.
- **DEF-835** `verified` - POS analytics `void` op reverses a receipt without checking it is voided. `apps/pos/src/server/pos2/apply-delta.ts:45-57`.
- **DEF-836** - POS analytics double-count after crash or timeout. `apps/pos/src/components/cashier/firestore.ts:862-875`.
- **DEF-837** - customer name and phone written as raw HTML into a print popup. `apps/pos/src/components/pins/customers-admin.tsx:403-409,424`.
- **DEF-838** - returnable-quantity cap has no lock or trigger. `packages/domain/src/stock/supplier-returns.ts:143-157`, `trade/returns.ts:99`.
- **DEF-839** - `checkDraw` reads the balance without locking the account. `packages/domain/src/money-accounts/overdraft.ts:53`. Distinct from DEF-755/756.
- **DEF-840** - concurrent loan payments double-book interest. `packages/domain/src/loans/index.ts:233-255,312`.
- **DEF-842** - reservation deposit can be credited on two bills. `apps/pos/src/components/cashier/payment-modal.tsx` ~175, ~436-452.
- **DEF-843** - see rulings: warn on repeat ID. `apps/pos/src/lib/statutory/capture.ts:22-33`.
- **DEF-844** - see rulings: manager PIN to void a deposit. `apps/pos/src/components/reservations/ReservationPaymentVoidModal.tsx:37-62`.
- **DEF-845** `verified` (live response) - production sends no frame, nosniff, referrer, CSP or HSTS headers, and advertises `X-Powered-By`. `apps/erp/next.config.js`, `docs/ops/provision.sh:151-153`.
- **DEF-846** - deploy uses `ssh-keyscan` with no pinned host key. `.github/workflows/deploy.yml:133`.
- **DEF-848** - customer app data contract: sequential session ids, lockout keyed on a client id, sign-up code returned to the client. Fixture only today; design input for the server phase. `apps/customer/src/data/customer-data.ts:21-24,31`, `fixture-data.ts:73,142-156,250`.

Quality (🔸):
- **DEF-847** `verified` - `npm audit`: 37 advisories, 3 critical (`next` 16.3.2, fixed in 16.4.6; `shell-quote`; `tar` via `@capacitor/cli`). High includes `xlsx` (no fix offered), `drizzle-orm`, `zod`, `firebase`.
- **DEF-849** - ERP CSV exports do not neutralise formula-leading cells. `apps/erp/src/lib/csv.ts:9-14`.
- **DEF-850** `verified` - public health endpoint returns build sha and time. `apps/erp/src/app/api/health/route.ts:57-70`. May be intended.
- **DEF-851** - POS shows "Payment Successful" for a session already closed elsewhere. `apps/pos/src/components/cashier/firestore.ts` ~520-527.
- **DEF-852** - POS reprints carry no COPY mark. `apps/pos/src/lib/printing/receiptFormatter.ts`, `hooks/use-print.ts:65`.
- **DEF-853** - refused refund burns a receipt number with no skipped-number record. `apps/pos/src/components/receipts/RefundReceiptDialog.tsx:96-116`.
- **DEF-854** - POS accepts a payment one centavo short. `apps/pos/src/components/cashier/payment-modal.tsx:46,55`.
- **DEF-855** - refund line shares ignore modifier prices. `apps/pos/src/lib/money/refundShare.ts:35`.
- **DEF-856** - `month-end --period` not validated (`2026-13` posts into January 2027). `scripts/month-end.ts:30`.
- **DEF-857** - a supplier return can cite another store's delivery line. `packages/domain/src/stock/supplier-returns.ts:129,140`.
- **DEF-858** - `sql.raw` with interpolated ids. `packages/db/src/repo/payroll.ts:457`, `repo/cutover.ts:35`.
- **DEF-859** - payroll premium factors pass through floats. `packages/domain/src/payroll/compute.ts:217-225`.
- **DEF-860** - `created_at::date` cast in the session time zone. `packages/db/src/repo/findings.ts:1816,1826`.
- **DEF-861** - deploy trigger checks branch and success only; PR jobs inherit signing secrets. `.github/workflows/deploy.yml:26-31,47`, `ci.yml:259-266`, `app-build.yml:44-49`.
- **DEF-862** - both Android apps allow backup; customer release can fall back to the debug key. `AndroidManifest.xml:4` (pos, customer), `apps/customer/android/app/build.gradle:46`.
- **DEF-863** - Firestore inbox create uses `hasAll`, not `hasOnly`. `firebase/firestore.rules:63-74`.
- **DEF-864** - `.tmp-login.mjs` and `.tmp/` (holds `ui/auth.json`, a saved session) are untracked and not ignored; `.playwright-mcp/` has 11 tracked files.
- **DEF-865** - `@capacitor/core` declared in the customer app and unused.

Found again, already registered, still open in code: DEF-749, DEF-018, DEF-652.

## Suggested order

1. Planner: record the four rulings (bible rows, Open Questions page), then verify the 26 `reported` rows or mark which to verify first.
2. Spec and fix the money rows first: **DEF-830** (needs an integration test proving the second payment posts), **DEF-831**, **DEF-832**, **DEF-841**.
3. Then the rulings' work: DEF-834 read gates, DEF-844 PIN, DEF-843 warning, DEF-833 setting.
4. `next` 16.3.2 -> 16.4.6 (DEF-847) and the response headers (DEF-845) are small and independent.
5. Explain the five behaviour-test failures before the branch merges.

## Not covered by the audit

Signed-in flows in any app; anything on a tablet or phone; the live Firestore rules for POS (outside this
repo, and every app-only check on the till depends on them); the older server routes the POS still calls
(`/api/loyalty/*`, `/api/pins/*`); performance and accessibility; most repository files beyond a search.

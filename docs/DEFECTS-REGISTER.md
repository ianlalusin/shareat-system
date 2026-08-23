# Defects register — gaps, bugs, and defects to fix in the rebuild

> **Living document.** Ian, 2026-08-23: *"these surfacing gaps, bugs and defects — document
> them so we can fix as we build this project."*
>
> ### A defect here is never an argument against the feature
> Bible §1.2b — every feature in a reference repo exists because the business needed it and
> uses it daily. **A flawed implementation is evidence of a real need, not a proposal to drop.**
> Log the defect, harvest the intent, build it correctly here. If a feature looks pointless,
> **ask Ian** — something in daily operations probably explains it.
>
> ### ⛔ Nothing here is fixed at the source
> All four reference repos — `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website` — are
> **read-only** (bible §2 rule 1, §13 row 80). Every entry below is fixed **in the rebuild**.
> A defect is logged here, its business rule is harvested, and the correct behaviour is built
> into Shareat System. We never patch the reference.

## How to use this

- **Add a row the moment a defect is found.** Cite `file:line`. An unlogged finding is a lost one.
- **Verified means *I* read the code**, not that an agent reported it. Agent findings are
  `reported` until checked — three of four explorers on 2026-08-23 made at least one claim that
  did not survive verification.
- When a rebuild task closes a defect, mark it and name the task.

| Field | Meaning |
|---|---|
| **Sev** | ⛔ correctness/money · ⚠️ structural risk · 🔸 quality/maintenance |
| **State** | `verified` (read the code) · `reported` (agent, unchecked) · `fixed` |
| **Disposition** | What the rebuild does about it |

---

## A. Money and correctness ⛔

| # | Sev | App | Defect | State | Disposition |
|---|---|---|---|---|---|
| **DEF-001** | ⛔ | POS | **Refund receipt numbers collide.** Refunds write `receiptSeq: 0` and `receiptNumber: RF-{parent}` with **no sequence suffix** — a second partial refund against the same parent mints an *identical* receipt number. `POS/src/components/cashier/firestore.ts:1484-1485` | `verified` | Refunds are first-class documents with their own sequence. Receipt number is UNIQUE per store by constraint, not convention |
| **DEF-002** | ⛔ | POS | **Two sale-completion paths write the same `receiptSeq` from non-comparable sequence spaces** — server-arbitrated counter online, per-device daily counter offline (`<store>-OL-<deviceTag>-<HHMM>-<NNN>`) | `verified` | Model honestly: composite `(device_id, local_seq)` for offline + a separate server sequence. Never one integer column pretending to be both. ADR-003 |
| **DEF-003** | ⛔ | POS | **Money stored as JS floats** (decimal pesos), not integer centavos — and **two duplicate rounding implementations**, `lib/money.ts` plus an inline copy in `lib/tax.ts` | `reported` | Already solved: `src/lib/money.ts` integer centavos, `numeric(14,2)` in DB. Bible §6. One implementation, no second copy |
| **DEF-004** | ⛔ | POS | **`receipt.source` is written but never read** by the analytics aggregation layer, so online sales silently fold into the `walkIn` bucket — which feeds ERP's `takeOutSales` | `verified` | `fulfilment` is a required column on the receipt table from day one. T-113 §6.7 |
| **DEF-005** | ⛔ | POS | **No take-out flag exists at all.** `sessionMode` has two values; walk-in à la carte and in-store take-out are the *same* value. Online orders live in a separate `onlineOrders` collection that *does* carry `fulfillment.type: pickup\|delivery`, never carried onto the receipt | `verified` | Harvest `fulfillment.type` onto the receipt as a **dimension**. The 4150/4200 account split was withdrawn 2026-08-23 — two food accounts only (unli, à la carte), so this is now about channel/fulfilment reporting, not revenue classification. T-113 §6.6 |
| **DEF-006** | ⛔ | ERP | **No nominal ledger.** Single-leg entries treated as "trivially balanced"; revenue and expense never post as journal legs; the income statement is a hand-maintained scan list | `verified` | **The reason this project exists.** Bible §16.0. Phase 1 |

## B. Data integrity and architecture ⚠️

| # | Sev | App | Defect | State | Disposition |
|---|---|---|---|---|---|
| **DEF-007** | ⚠️ | POS + CUSTOMER | **Six collections written by BOTH apps** — `activeSessions`, `sessions`, `sessions/{id}/kitchentickets`, `rtKdsTickets/{loc}`, `customers/{phone}`, `loyaltyRedemptions`. Bible §4.2 rule 8 violated six times across a process boundary | `verified` | Disappears by construction under one backend. ADR-003 |
| **DEF-008** | ⚠️ | POS | **`merge:false` analytics rebuild** reconstructs kitchen and per-staff stats purely from surviving `kitchentickets` — purge the tickets and a rebuild silently zeroes them | `reported` | Derived data is a view or materialised view, never a hand-rebuilt document. Bible §4.2 rule 7 |
| **DEF-009** | ⚠️ | CUSTOMER | **Three separate identity schemes** — hashed device id (session participant), **phone number as document id** (loyalty, bcrypt), `d_`-prefixed device id (games) | `reported` | One `person` spine (bible §13 row 14). Phone is an attribute, never a primary key — it changes |
| **DEF-010** | ⚠️ | Website | **Three independently-synced sources of branch identity** — a content collection, a hardcoded `BRANCHES` array in the build script, and the live POS store doc | `reported` | One `stores` table. The whole class disappears |
| **DEF-011** | ⚠️ | Website | **`/menu` is baked at build time** from 3 hardcoded branch IDs; prices and copy go stale between deploys, and the build fails hard on a missing price | `reported` | Explicit publish step with a versioned snapshot, or live read. Decide in the Website phase |

## C. Security and access ⚠️

| # | Sev | App | Defect | State | Disposition |
|---|---|---|---|---|---|
| **DEF-012** | ⛔ | POS/CUSTOMER | **CUSTOMER can overwrite POS's production ruleset.** CUSTOMER ships its own 85-line `firestore.rules` plus a `.firebaserc` alias `customerapp` → `shareat-hub-v2`, the same project POS uses. A deploy from CUSTOMER replaces POS's 800+ line ruleset. One-directional; POS has no reverse path | `verified` | One backend, one authorization module (bible §7 rule 1). No client-deployed rules govern business data |
| **DEF-013** | ⛔ | POS/CUSTOMER | **Flash-ad image upload fails closed in production.** CUSTOMER uploads to `flashAdImages/{storeId}/...` (`CUSTOMER/src/app/admin/flash-ads/page.tsx:234`); POS's `storage.rules` has no match block for that path and the catch-all is `allow write: if false` (`storage.rules:61-64`) | `verified` | File storage is an explicit, authorized server-side operation. Distinct from the known flash-ads *display* fix |
| **DEF-014** | ⚠️ | POS/CUSTOMER | **Checked-in rules diverge from deployed rules.** CUSTOMER's committed `firestore.rules` denies `activeSessions`, which its own live dashboard reads, and expects custom claims POS never sets — proof the file has never been deployed | `verified` | Rules live with the code that needs them and deploy from CI, not a laptop |
| **DEF-015** | ⚠️ | POS/CUSTOMER | **Local dev reaches production.** Both `.env.local` files reference a service-account key with the identical basename (`POS.json`) — either repo's local environment can write to live Firestore | `reported` | Environment isolation is enforced; production credentials never resolve from a dev `.env` |
| **DEF-016** | ⚠️ | Website | **Cross-project service-account credential.** The Website's Cloud Functions hold `HUB_SA_KEY`, a borrowed identity into POS's database (`shareat-hub-v2`); `MENU_BUILD_SA_KEY_PATH` is a second at build time | `reported` | Deleted outright — the seam it bridges no longer exists |
| **DEF-017** | ⚠️ | POS | **Connectivity judged by bare `navigator.onLine`** — no reachability probe, so a captive portal or dead uplink reads as "online" | `reported` | Real reachability probe against the API before declaring online |
| **DEF-018** | ⚠️ | POS | **The planned rules guardrail against a stale offline write clobbering an already-finalised receipt/session was never implemented** — confirmed absent from `firestore.rules` | `reported` | Posted records immutable by constraint (bible §4.2 rule 6). Replay is idempotent behind a UNIQUE key |
| **DEF-019** | 🔸 | CUSTOMER | **Admin PIN-registry delete is a raw client-side `deleteDoc`** | `reported` | Every mutation goes through an authorized server action. Bible §7 |
| **DEF-020** | 🔸 | Website | **Public writes into shared data** — reservations, online orders, a merge-only `customers/{phone}` upsert, and two different chat-thread models (bearer-id vs token-gated) | `reported` | Public input is validated server-side and never writes business state directly |

## D. Quality and maintenance 🔸

| # | Sev | App | Defect | State | Disposition |
|---|---|---|---|---|---|
| **DEF-021** | 🔸 | CUSTOMER | **Refill rules are magic numbers in app code** — 60s cooldown anchored on serve, 10-minute "still in kitchen" and 20-minute "first serving pending" safety valves | `reported` | **Harvest the rules, make them per-store configuration.** The behaviour is correct; the hardcoding is not |
| **DEF-022** | 🔸 | POS/CUSTOMER | **Loyalty spend is split across two apps** — CUSTOMER holds points and issues a code; POS applies it and performs the spend at payment finalisation | `reported` | One transaction in one backend |
| **DEF-023** | 🔸 | CUSTOMER | **`repeat-first-order` duplicates kitchen-ticket-write logic inline** instead of reusing the shared helper, and is "dead but live" per its own code comment | `reported` | Omit. Nothing to carry across |
| **DEF-024** | 🔸 | Website | **`PAYMONGO-GOLIVE.md` documents a payment design the code abandoned** — the real flow is manual GCash/Maya confirmed by a POS cashier | `reported` | Do not trust as current. Stale docs are not migrated |
| **DEF-025** | 🔸 | POS | **Payment-method classification is hardcoded substring matching** (`cashKeys`/`eWalletKeys`/`cardKeys`); an unmatched method silently lands in `otherPayments` | `verified` | Payment methods are a reference table with a typed class, seeded and UNIQUE by code. Bible §4.4 |
| **DEF-026** | 🔸 | Website | Unused `OPENAI_API_KEY` sits in a local `.env`. **NOT a breach** — gitignored, untracked, no git history. Logged only to close the question | `verified` | Nothing to do. Rotate at leisure |

| **DEF-032** | ⛔ | ERP | **The nightly ledger reconciliation has NO scheduler job — it has never run on a schedule.** `/api/cron/reconcile` exists and is live, but no Cloud Scheduler job targets it. `reconcileAccounts()` is v1's actual source-of-truth check: it re-sums every posted journal leg per account and compares to the stored `balance` field, reporting drift. Nothing corrupts data by its absence — **but nobody has been watching for drift.** Verified live 2026-08-23 against `studio-7300228488-a394e` / `asia-southeast1` (the only region with jobs; four other regions checked, zero) | `verified` | **Directly threatens ADR-005's opening balance**, which assumes v1's books reconcile. Run it manually before the December close and quantify the drift. In Shareat System the equivalent is invariant 10 (trial balance ties), enforced continuously in CI rather than by a cron someone must remember to create |
| **DEF-033** | ⚠️ | ERP | **Three more cron routes have no scheduler job**: `daily-snapshot`, `rebuild-performance`, `wastage-auto-charge`. Same verification. Five of nine routes ARE scheduled and enabled — `daily-insights`, `loan-autodeduct`, `budget-reissue`, `attendance-sweep`, `recurring-expense-autopay` | `verified` | Confirm with Ian which are intended to run. A route that exists but nothing triggers is the silent-failure pattern in its purest form: the code looks present and does nothing forever |
| **DEF-034** | 🔸 | ERP | **Repo docs about scheduling are stale and misleading.** `docs/HANDOFF-2026-07-22-...md` states only `budget-reissue` and `recurring-expense-autopay` are confirmed scheduled, and that `attendance-sweep` has "no evidence the scheduler job was ever created" — but `attendance-sweep` **is** live and enabled. A capability-inventory agent reading those docs reported 2 of 9; the live answer is 5 of 9 | `verified` | Never trust a repo doc about live infrastructure state. **Query the infrastructure.** Same lesson as `PAYMONGO-GOLIVE.md` (DEF-024) |

## E. Found in Shareat System itself

| # | Sev | Defect | State | Disposition |
|---|---|---|---|---|
| **DEF-031** | ⚠️ | **Posted-entry immutability has a hole on INSERT.** The trigger blocks UPDATE and DELETE on a posted entry, per T-103's contract — but a client writing raw SQL could still INSERT a *new balanced pair* of lines onto an already-committed posted entry, changing its content without tripping the balance rule. Found and reported by the T-103 implementer, which first over-implemented a blanket INSERT block, discovered it made legitimately building a posted entry inside one transaction impossible, and reverted rather than shipping a broken constraint | **`fixed`** | **Closed WITHOUT `xmin`/`txid_current()`** — T-105's actual fix is draft-first ordering, not transaction-id comparison (that escape hatch turned out to be unnecessary, contrary to this row's original disposition). `postEntry` (`packages/domain/src/ledger/post-entry.ts`) always inserts the entry as `status='draft'`, inserts every line while it is still draft, then flips it to `posted` as the LAST statement. Migration `0004_journal_lines_posted_immutable_insert.sql` replaces `journal_lines_posted_immutable` (now `BEFORE INSERT OR UPDATE OR DELETE`) so a line can never be INSERTed onto an entry whose status is not `draft` — closing the hole for every path, not just `postEntry`'s. Closing test: `packages/domain/tests/integration/post-entry.test.ts`, invariant 14 ("DEF-031 regression: raw SQL cannot INSERT a line onto an already-posted entry" — asserts a balanced pair is rejected even from a brand-new, later transaction). **Caveat found while closing this**: the new trigger also rejects `packages/db/tests/integration/journal.test.ts`'s pattern of constructing a posted-entry fixture by inserting `journal_entries` with `status='posted'` directly and then inserting its lines (non-draft-first) — 4 pre-existing tests in that file now fail for that reason. See the T-105 task report |
| **DEF-035** | ⛔ | **The seeded chart of accounts is missing 17 accounts that COA-ALIGNMENT §4 requires** — `5110` `5120` `5130` `5140` `5150` `5160` `5170` (the COGS breakdown by category) and `6160` `6510` `6620` `6630` `6650` `6850` `6860` `6870` `6880` `6890` (OPEX detail). **My T-102 spec is the cause:** it said *"take the complete list from COA-ALIGNMENT §2"*, but §2 gives account **groups** while **§4** gives the finer category→account mapping and introduces these seventeen. The implementer seeded exactly what I asked for | **`fixed`** | **Blocks T-113** — the expense-category mapping routes to accounts that do not exist. Fixed by T-102b: migration `0006_coa_expense_category_accounts.sql` adds the 17 leaf accounts (parented `5000`/`6000` per code range, no `legacy_code`, `is_system=true`, `status='active'`), and `packages/db/seed/chart-of-accounts.ts`'s `CHART_OF_ACCOUNTS` grows from 75 to 92 rows to match. `5170` COGS — commissary transfers carries the inter-store/double-count elimination warning from §4.1 as a source comment (no `memo` column exists on `accounts`; schema was out of scope). Closing test: `packages/db/tests/integration/chart-of-accounts.test.ts`, describe block **"T-102b invariant 7 — every account code named anywhere in COA-ALIGNMENT §4 exists in the chart"** — it parses §4's own markdown table rows for bold `**NNNN**` codes (not a hand-maintained list) and asserts each exists in the freshly seeded chart; confirmed failing (listing exactly these 17 missing codes) before the migration/seed change, and passing after. The other 6 T-102b invariants (type/normal_balance, parenting, no legacy_code, active/is_system, idempotent re-seed, 92-account total) are the same file's "T-102b invariant 1" through "6" blocks. Lesson recorded: a spec that points at one section of a two-level source produces a half-complete result, and the half that is missing is invisible until something tries to use it |
| **DEF-036** | ⛔ | **A `reversed` entry's lines were mutable by raw SQL.** Migration `0004`'s immutability branch checked `entry_status = 'posted'` only. Nothing had ever produced a `'reversed'` entry, so the hole was **dormant** — T-106 would have created the first one, leaving every reversed entry's lines editable and directly breaking invariant 6 (*nothing deleted, no amount changed on the original*). Found by the T-106 implementer **while implementing something else**, and outside its own contract | **`fixed`** | Migration `0005` checks `entry_status IN ('posted','reversed')`. **The lesson: a guard written against the states that exist today silently stops guarding when a new state is introduced.** Any status added to `journal_entries` from here must be checked against every trigger that switches on status |
| **DEF-037** | ⛔ | **Invariant 6 is currently unsatisfiable: there is no subledger.** `journal_lines` carries `account_id`, `store_id`, `channel_id` — **no counterparty**. COA-ALIGNMENT specifies *"2110 AP — **CONTROL** + supplier subledger"* and *"1210 AR — CONTROL + customer subledger"*, but no subledger table or column exists, so a line posting to 2110 **cannot say which supplier it is for**. Invariant 6 requires *"AR detail total = AR control balance"* — there is no detail to total. Undetected because Phase 1 has not yet posted an AP or AR line. Verified against the live schema 2026-08-23 | `verified` | **Decide the shape before Phase 2 posts its first AP line.** Research (`docs/discovery/17`) found **both ERPNext and Odoo put the counterparty on the journal line itself** rather than in a separate subledger table — a `party_type` / `party_id` pair. That is the cheaper shape and the better-precedented one, but it is a schema change to a shipped table and needs a deliberate decision, not a default |
| **DEF-038** | ⚠️ | **No period-close routine exists, and no rule for where a correction lands when the error is in an already-closed period.** `fiscal_periods` has `open`/`closed`/`locked` and nothing that performs a close | `verified` | Research found **no consensus** even among reference systems — ERPNext posts real reversing entries zeroing P&L into retained earnings; Odoo posts nothing and computes P&L live, then partially reversed that in v19 for reporting stability. **We have neither.** Needed before the December close regardless of the rebuild |
| **DEF-027** | 🔸 | **No linter at all.** No ESLint config in the repo, `next lint` removed in Next 16, no CI lint step — behind a `next.config.js` key that claimed to enforce lint-on-build and was silently ignored | `verified` | Open. ESLint 9 flat config + Next plugin + a CI gate |
| **DEF-028** | ⚠️ | `env.ts` hard-required Firebase credentials no code path reads, blocking local dev and `/api/health` | **`fixed`** | Required in production only, `superRefine`. 8 tests guard both halves. Bible row 71 |
| **DEF-030** | ⛔ | **Credential leaked into a log by a lazy redaction regex.** `migrate.ts` redacted its connection string with `/:\/\/[^@]*@/`, which stops at the **first** `@`. A password containing `@` leaked its tail to stdout on every migration run. Observed live 2026-08-23 | **`fixed`** | Greedy `/:\/\/.*@/` matches to the last `@`. 5 tests in `packages/db/tests/redaction.test.ts` cover `@` in the password, all-`@` passwords, and no-credential URLs |
| **DEF-029** | ⚠️ | `/api/health` reported `database: unreachable` for *any* error — a missing env var was blamed on Postgres while it was healthy | **`fixed`** | Configuration and database reported separately; detail withheld in production. Bible row 72 |

---

## Open questions that are not yet defects

| # | Question | Raised by |
|---|---|---|
| 1 | Is `categories` genuinely POS-shared, or CUSTOMER-local? | CUSTOMER discovery |
| 2 | Are `customerRequests` / loyalty-earn ledger writes POS or ERP? | CUSTOMER discovery |
| 3 | Has CUSTOMER's `firestore.rules` **ever** been deployed? | CUSTOMER discovery |
| 4 | Do the seven unverified POS `external/*` consumers match their route names? | Cross-app map |
| 5 | Are ERP's 9 cron routes actually live-scheduled? | Infrastructure discovery |

## Change log

| Date | Change |
|---|---|
| 2026-08-23 | DEF-031 fixed by T-105 (`postEntry` + migration 0004): draft-first ordering, not `xmin`/`txid_current()` as this row originally proposed. Closing test named in the row. Fixing it exposed 4 pre-existing tests in `packages/db/tests/integration/journal.test.ts` that build a posted-entry fixture the non-draft-first way — reported in the T-105 task report, not fixed here (out of that task's Scope). |
| 2026-08-23 | DEF-030 added: a credential leaked into logs via a lazy redaction regex, found by reading migration output during the monorepo restructure. Fixed same day.
| 2026-08-23 | Created. Seeded with 29 entries from the four-app discovery pass. 12 verified by hand, 2 already fixed, 2 agent security claims investigated and dismissed as non-issues. |

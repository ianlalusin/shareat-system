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
| **DEF-031** | ⚠️ | **Posted-entry immutability has a hole on INSERT.** The trigger blocks UPDATE and DELETE on a posted entry, per T-103's contract — but a client writing raw SQL could still INSERT a *new balanced pair* of lines onto an already-committed posted entry, changing its content without tripping the balance rule. Found and reported by the T-103 implementer, which first over-implemented a blanket INSERT block, discovered it made legitimately building a posted entry inside one transaction impossible, and reverted rather than shipping a broken constraint | `verified` | **Closable at the database level** using `xmin` vs `txid_current()` — allow the INSERT when the parent entry row was created by the *current* transaction (still being built), reject otherwise. Assigned to **T-105**, where `postEntry` owns the write path. Invariant 5 says posted entries are immutable, and a service-layer-only guarantee is exactly the "application code can forget" pattern this project rejects |
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
| 2026-08-23 | DEF-030 added: a credential leaked into logs via a lazy redaction regex, found by reading migration output during the monorepo restructure. Fixed same day.
| 2026-08-23 | Created. Seeded with 29 entries from the four-app discovery pass. 12 verified by hand, 2 already fixed, 2 agent security claims investigated and dismissed as non-issues. |

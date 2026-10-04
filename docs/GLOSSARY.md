# Glossary — what the words actually mean

> **Living document.** This exists because in this domain the obvious reading of a name is
> often wrong, and an agent that guesses writes confidently incorrect code.
>
> **Add an entry the moment a term surprises you.** That is the trigger — not "is this
> important", but "did I have to go read code to find out what this meant".

| Marker | Meaning |
|---|---|
| ⚠️ | **The name lies.** The obvious reading is wrong. Read before using |
| ✅ | Verified in code on the cited line |
| 🔸 | Business usage, from Ian — not a code artefact |

---

## ⚠️ The five that have already caused errors

### `dineInSales` ⚠️ ✅

**Means: unlimited-package sales only.** *Not* "all dine-in".

```ts
// POS/src/lib/analytics/daily.ts:263
const isDineIn = r.sessionMode === 'package_dinein';
const mode = isDineIn ? "dineIn" : "walkIn";
```

À la carte and online both fall into `walkIn`. ERP does not compute this field — it pulls it
from POS. Consequence: it maps straight to account **4100 (dine-in, unlimited)** with no
reconstruction needed.

### `takeOutSales` ⚠️ ✅

**A residual, not a measurement.** `Math.max(0, totalGross - dineInSales)`
(`POS/src/app/api/external/sales/route.ts:53`). It absorbs everything `totalGross` counts that
`dineInSales` does not — today that is à la carte only, because no online orders exist yet.
**Never treat it as a revenue figure on its own**; treat a non-zero value as a reconciliation
signal.

### `deliverySales` ⚠️ ✅ — **means neither delivery NOR one consistent thing**

**Two different meanings depending on which document wrote it**
(`ERP-rebuild/src/lib/financial/sales-report/derive-totals.ts:88-96`):

| Document | What `deliverySales` actually holds |
|---|---|
| **DAY doc** | *"the full channel sum + branchDelta (i.e. **it currently equals `totalSales`**)"* — a duplicate of the total, **not** delivery |
| **SHIFT doc** | `nonRemittedChannelsTotal` = `max(0, totalSales − remittedChannelsTotal)` — the channels whose money never reaches the till (Foodpanda, Grab, …) |

⚠️ The day-doc behaviour is a known wart frozen in place — *"preserved verbatim so create and
adjust agree."* **Never read this field as delivery revenue.** The useful concept underneath is
**non-remitted channels**, which is what `SalesChannel.isRemittedDaily` decides.

### `dineInSales` — ⚠️ ALSO means something different in the ERP than in POS

The entry above defines POS's meaning (unlimited-package sales). **The ERP's sales-report form
stores something else in the same field:** *"Stored `dineInSales` — the **remitted-daily
channels**"* (`derive-totals.ts:83-85`). **One field name, two meanings, depending on which system
wrote the row.** Anything reconciling ERP against POS must know which it is holding.

### `cashPayments` ⚠️ — a floored residual, not a measurement

*"cash is DERIVED: remitted channels − online − credit − other, floored at 0"* (`derive-totals.ts`).
**Flooring at zero hides a negative**, and a negative here would be a real signal that the tender
figures disagree. Same family as `takeOutSales`: a residual wearing a measurement's name.

### `creditCardPayments` ⚠️ — **always 0**

*"Always 0 — card tenders are captured through the online accounts."* The field exists; nothing
populates it. Do not build a card-tender breakdown on it.

### `sessionMode` ⚠️ ✅

Two values only: `'package_dinein' | 'alacarte'`. **Walk-in à la carte and in-store take-out
are the same value** — there is no take-out flag anywhere in POS. Online orders live in a
separate `onlineOrders` collection and get `sessionMode: 'alacarte'` hardcoded onto a
synthesised receipt. See DEF-004, DEF-005.

### `session` ⚠️

**A group of diners at a table**, from seating to payment. **Not** an auth session, not an HTTP
session. When you mean authentication, say *auth session* explicitly.

### `shift day` ✅

**05:00 → 05:00 Manila.** The attendance calendar, and **not** the financial business day, which is
midnight-based. A closing staffer who punches out at 01:30 belongs to the shift day they *started* —
so that one punch sits on the **previous shift day** and the **current business day** at the same
time.

⛔ Two calendars, one repo. `toShiftDay` lives in `packages/domain/src/attendance/shift-day.ts`,
`toBusinessDate` in `packages/core/src/datetime.ts`, and `ShiftDay` / `BusinessDate` are **separate
branded types** so passing one where the other belongs does not compile. v1 made the same
distinction and wrote down why it named the field `sessionDate` rather than `dayKey`
(`ERP-rebuild/src/lib/attendance/shift-day.ts:3-6`).

### `punch` ✅

**One raw credential presentation at a terminal** — "this person presented this credential at this
device at this time". A **fact**, never an outcome: a punch carries no hours, no lateness and no
pay. Postgres adjudicates (bible §5.1). The direction the staffer pressed is stored as
`assertedIntent`, and the name is the specification: the device asserts, the server decides.

### `attendance day` ✅ ⚠️

The **adjudicated** result for one person on one shift day — hours, breaks, night differential,
anomalies.

⛔ **Never called a "session".** `session` above already means *a group of diners at a table*, and
`packages/db/schema/sessions.ts` already took the second meaning for auth. v1's `attendanceSessions`
would be the **third** meaning of one word in one system.

### `receiptSeq` ⚠️ ✅

An integer written by **two different allocators from non-comparable sequence spaces** — a
server-arbitrated counter when online, a per-device daily counter when offline. Refunds write
`0`. **It is not a per-store monotonic key**, despite looking exactly like one. DEF-001,
DEF-002.

---

## Sales and service

| Term | Meaning |
|---|---|
| **unli / unlimited / package** 🔸 | The core product: unlimited samgyupsal, fixed price per head, variable consumption. Its margin moves with *how much people eat*, which is why it gets its own revenue account (4100) |
| **à la carte** 🔸 | Ordering individual items rather than the package. Sold both dine-in and take-out |
| **take-out** 🔸 | Always items / à la carte — **never unli**. Includes delivery: *delivery is a mode of take-out, not a third channel* |
| **refill** ✅ | A repeat serving within an unli session. Cooldown **60s, anchored on SERVE not order**, with two safety valves (10 min "still in kitchen", 20 min "first serving pending"). All magic numbers in app code today — DEF-021 |
| **addon** ✅ | An extra item bought during a package session. Counted into `dineInSales` via `dineInAddonSalesAmount` |
| **kitchen ticket** ✅ | The kitchen's copy of an order. `billOnServe: true` means **no bill line exists yet** |
| **billOnServe** ⚠️ ✅ | **The bill is created on SERVE, not on order.** Recognise revenue at order instead and unserved orders become revenue. `POS/src/lib/kitchen/customer-order-billing.ts` |
| **void** ✅ | Cancels the *sale*. In POS a void is a status flip on the same document, not a reversing entry |
| **refund** ✅ | A separate negative receipt referencing a parent. Currently mints colliding numbers — DEF-001 |
| **re-ring** ✅ | A corrected receipt replacing a voided one; consumes the retained void cash |
| **voidCashRetained** ⚠️ ✅ | Cash collected on a voided receipt and **not refunded**. It sits in the drawer backing no sale, so ERP carries it into expected remittance and books it to a suspense liability |
| **comps** 🔸 | Complimentary items. **Contra-revenue** (4950), confirmed by Ian — not marketing expense |
| **day feed** (T-375) | The stored, immutable copy of one POS v1 response for one store-day (`pos_v1_day_feeds`): the exact text, its parsed form and a sha256. A sales day on a linked store is DERIVED from it and nothing else. Append-only: every fetch is a fact, none is edited or de-duplicated. Interim — retired per store at P2, when that store's sales reach Postgres directly (ADR-015) |
| **linked store** (T-375) | A store with a row in `pos_v1_store_links`. **That row is the whole switch** — no flag, no env var. Linked: its sales days are imported from POS and never typed. Unlinked: today's typed path, labelled "Typed — store not linked to POS" |
| **tender (master)** (T-375) | A store's tender definition (`tenders`): a name, `cash` or `wallet`, the money account a wallet pays into, and how POS v1 spells it. **Not** `sales_day_tenders`, which is one day's wallet rows (where that day's money went). The master is what a till will sell against; `sales_day_tenders` is what a day recorded |
| **platform sales** (T-375) | Foodpanda, Grab and similar: typed per day on the store's NON-remitted channels, kept outside the figures POS derives. One removable seam, until platforms are rung through POS |
| **refunds (sales day)** (T-375) | `sales_days.refunds`: POS refunds of the day, **contra-revenue 4950**, on a feed-sourced day only. **Never `comps`** — comps keep their meaning (complimentary items). Derived as the amount by which POS's method totals exceed its paid total, above the rounding band |

## Money and books

| Term | Meaning |
|---|---|
| **journal entry** | The whole transaction: a header plus **two or more** lines that balance. In the legacy ERP an "entry" was a *single leg* with no header — the root defect (DEF-006) |
| **leg / line** | One account movement. v2 stores explicit `debit` / `credit`; v1 stored `direction: in\|out` and derived the rest from an account-name prefix |
| **nominal ledger** | The revenue and expense accounts. **The legacy system has none** — the P&L is a hand-maintained scan list. Building one is the reason this project exists |
| **control account** | A summary account (AP, AR, Inventory) that a subsidiary ledger must reconcile to. The legacy system has none: `ap__{supplierId}` *is* the account, so "AP total" is just a sum with nothing to check it against |
| **posted vs draft** | Draft is a worksheet; posted is a financial fact. **Posted records are immutable** — corrections are new reversing entries, never edits |
| **reversal** | A new, dated, opposite entry that unwinds a posted one. **Not** the same as a void, which cancels a document |
| **contra-revenue** | Reduces revenue rather than being an expense: discounts (4900), returns and comps (4950), loyalty points redeemed (4910) |
| **normal balance** | Whether an account naturally carries a debit or credit. **A declared column in v2** — never inferred from a code prefix, which is how the legacy system got it wrong |
| **fiscal period** | A dated window with status `open` / `closed` / `locked`. No posting into a closed period **by any path**, including crons, ETL and admin tools |
| **trial balance** | The one-query check that total debits equal total credits. Must pass at any moment |
| **legacy_code** | The old system's account identifier, kept on the new account so migrated data can be traced back |
| **management ledger** 🔸 | What this system is. **Not a statutory filing basis.** VAT here is a label; reported sales are not all sales. Never label or export output as BIR-ready — bible §13 row 75 |
| **receipt** ⚠️ | **Two unrelated meanings across the reference repos.** In POS/CUSTOMER/a sale, a receipt is the customer-facing proof of a **sale** (`receiptSeq`, `receiptId` on a sale/kitchen ticket — see the entry above). In ERP-rebuild's AP module, `ReceiptPlain` (`types/index.ts:441`) is a **supplier invoice** — what a supplier bills you, broken into one or more `expenses` postings over time. **v2 never uses "receipt" for the supplier-invoice sense** — that table is `supplier_invoices` (T-130) precisely to avoid this collision. If you mean the sale-side document, say *sales receipt*; if you mean a supplier's bill, say *supplier invoice*. Never bare "receipt" in this codebase |

## Identity

| Term | Meaning |
|---|---|
| **person** | One **human being**, independent of how they authenticate. A staff member who is also a loyalty customer is **one** person |
| **person_identity** | One way a person is recognised: `firebase_uid`, `phone`, `email`, `staff_no`, `device_hash`. Many per person. **Phone is an identity, never a primary key** — it changes. DEF-009 |
| **staff vs diner** | A *role*, not a table. Both are persons |
| **platformAdmin** ✅ | A Firebase custom claim granting cross-store admin. Distinct from `staff/{uid}.status === 'active'`; either passes CUSTOMER's admin gate |

## Places and structure

| Term | Meaning |
|---|---|
| **org / organization** | The legal entity. One row today; SEBN reserved as the second |
| **store / branch** | A trading location. `store` is the schema word — prefer it. Every store-scoped table carries `store_id` |
| **commissary** 🔸 | A store that produces and dispatches to other branches rather than serving diners. `storeKind === 'commissary'` |
| **branch sale** | Commissary → branch dispatch booked as revenue. System-booked, never typed into a form |
| **channel** | Where an order came from — walk-in, Grab, Foodpanda, branch sales. **A dimension (`channel_id`) on journal lines, not a set of accounts** |
| **Lane A / mirror** | Postgres → Firestore, server-written, **client read-only**. Staleness is expected and tolerated |
| **Lane B / inbox** | Device → Firestore, **append-only**. Raw facts only, never computed outcomes. The server adjudicates |
| **the four verbs** | How anything is carried across from a reference repo: **duplicate** what's good, **correct** what's wrong, **add** what's missing, **delete** what's redundant |
| **reference repos** | `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`. **All four are READ-ONLY.** Nothing is ever fixed at the source — findings go to `DEFECTS-REGISTER.md` |

## Repo names — the trap

| You read | It means | Actual path |
|---|---|---|
| **v1**, **the legacy ERP**, **the old system** | The live production ERP being replaced | `webapps\ERP-rebuild` |
| **the reference repos** | All four read-only sources | `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website` |
| **this project**, **Shareat System** | The rebuild | `webapps\shareat-system` |

> **`ERP-rebuild` is the OLD system.** Its name says "rebuild" because it was itself a rebuild
> of something older. A cold agent reasonably reads that folder name as *this* project and
> starts editing a live production system. **It is read-only, like the other three.**

## Words we deliberately avoid

| Don't say | Say | Why |
|---|---|---|
| "v1" for this project | **legacy ERP** / **Shareat System** | "v1" means the legacy ERP in ~170 places. This project has no version number |
| "dine-in" for a metric | name the account — 4100 unli, 4150 à la carte | "dine-in" is ambiguous exactly where it matters |
| "sync" between apps | **publish** (Lane A) or **ingest** (Lane B) | "Sync" implies bidirectional. Nothing here is bidirectional |
| "the API" | name the app and route | Four apps had eight cross-app routes. Ambiguity here caused real bugs |

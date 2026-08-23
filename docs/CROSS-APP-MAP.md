# Cross-app map — POS · ERP · CUSTOMER · Website

> **Living document.** Ian, 2026-08-23: *"document every finding, reference, connection across
> apps — POS, website, ERP and customer; as we go along we will touch them 1 by 1."*
>
> This is the index of every seam between the four applications. It is **added to as work
> touches each connection**, never written once. When you verify a connection, move it from
> ⬜ to ✅ and cite `file:line`. When you find a new one, add a row before you forget it.

## Maintenance rules

1. **Cite or mark unverified.** Every claim carries a `file:line`, or an explicit ⬜.
   A remembered fact is not a verified one.
2. **Direction matters.** Record who calls whom. "They share data" is not a finding.
3. **Record the contract, not the vibe.** Fields, auth, failure mode.
4. **Never edit `ERP-rebuild`** (bible §2 rule 1). POS, CUSTOMER, and Website are *not* v1 and
   may be changed — but only deliberately, and never as a side effect of ERPv2 work.
5. A connection that turns out to matter for the ledger gets a line in `PROJECT_BIBLE.md` §13.

| | Status |
|---|---|
| ✅ | Verified this session, with citations |
| 🟡 | Partially verified — shape known, details open |
| ⬜ | Believed to exist, **not yet verified** — do not rely on it |

---

## The four apps

| App | Folder | Port | Role |
|---|---|---|---|
| **POS** | `webapps/POS` | 9003 | Point of sale. Owns receipts, sessions, daily analytics. Branch `sev5_advanced` |
| **ERP** (v1) | `webapps/ERP-rebuild` | 9002 | Back office, books, payroll, inventory. **READ-ONLY to us** |
| **CUSTOMER** | `webapps/CUSTOMER` | 9004 | Diner-facing ordering, refills, loyalty |
| **Website** | `webapps/Shareat Website` | 9007 | Public site, storefront, reservations (Astro) |
| **ERPv2** | `webapps/ERPv2` | 9008 | This project. Will replace ERP v1's persistence |

**Shared infrastructure is itself a connection.** POS and CUSTOMER live in the same Firebase
project, which is why a deploy from one repo can overwrite the other's rules. ⬜ *To verify:
exact project IDs per app and which repo owns which ruleset.*

---

## 1. POS → ERP — the daily books feed ✅

**The most load-bearing seam in the business.** ERP's entire revenue recognition depends on it.

| | |
|---|---|
| Mechanism | HTTP GET, POS `api/external/sales` |
| Auth | External API key → `resolveExternalKeyScope` + `storeAllowed` (`POS/src/lib/server/external-auth.ts`) |
| Consumer | `ERP-rebuild/src/lib/financial/posSalesPull.ts` → `mapPosSalesToFormFields` |
| Source of truth | POS doc `stores/{storeId}/analytics/{yyyymmdd}` (`POS/src/app/api/external/sales/route.ts:25`) |
| Lands in | ERP `salesDays/{YYYY-MM-DD}`, recognised only at `status='verified'` |

### Fields returned

`totalSales` · `totalSessions` · `dineInSales` · `takeOutSales` · `cashPayments` ·
`eWalletPayments` · `creditCardPayments` · `otherPayments` · `paymentsByMethod` ·
`discountsTotal` · `chargesTotal` · `voidCashRetained`

### Two semantics you must not get wrong ✅

**1. `dineInSales` means *unlimited package only*, not "all dine-in".**

```ts
// POS/src/lib/analytics/daily.ts:263
const isDineIn = r.sessionMode === 'package_dinein';
const mode = isDineIn ? "dineIn" : "walkIn";
```

À la carte and online both fall into `walkIn`. This is why ERPv2 can map `dineInSales`
straight to **4100 Food sales — dine-in, unlimited** with no reconstruction (T-113 §6.1).

**2. `takeOutSales` is a residual, not a measurement.**

```ts
// POS/src/app/api/external/sales/route.ts:53
const takeOutSales = Math.max(0, totalGross - dineInSales);
```

It absorbs everything `totalGross` counts that `dineInSales` does not. Today that is à la
carte only — **because no online transactions exist yet** (Ian, 2026-08-23). The day online
launches, this figure silently starts mixing 4150 and 4200. See §2.

**3. Payment-method classification is string matching.** `cashKeys`/`eWalletKeys`/`cardKeys`
are hardcoded lowercase substring lists (`route.ts:61-63`); anything unmatched falls to
`otherPayments`. A new payment method name silently lands in "other" until someone adds it.
🟡 *Risk noted, not yet quantified.*

### Void cash ✅

`voidCashRetained` — cash collected on a voided receipt and **not** refunded. It sits in the
drawer with no backing sale, so ERP carries it into *expected* remittance and reclassifies it
to `liability__void_cash_suspense` at posting. Receipt-level fields: `voidCashPaid`,
`voidCashRefunded`, `voidCashRetained`, `voidCashDisposition`, `reRingReceiptId`,
`voidCashRetainedReversed` (`POS/src/lib/types.ts`).

---

## 2. POS online orders — not yet live ⚠️ ✅

Ian, 2026-08-23: **no online transactions as of now**, and POS can still be changed.

`POS/src/app/api/admin/online-orders/route.ts:503` writes a receipt with
`sessionMode: "alacarte"`, then line 518:

```ts
(receipt as any).source = "online";
```

An **untyped field bolted on via an `as any` cast** — absent from the `Receipt` type. Once
online volume exists, that cast becomes the only thing separating take-out revenue (4200)
from dine-in à la carte (4150), and nothing type-checks it.

**Recommendation (T-113 §6.7):** add a typed, required `fulfilment` discriminator to
`Receipt` before online launches. `sessionMode` answers *how it was sold* (package vs à la
carte); fulfilment answers *where the food went*. The COA needs both.

**This is the cheapest it will ever be to fix** — there is no historical online data to
migrate.

---

## 3. POS external API — the full surface ✅

All eight are key-scoped through `resolveExternalKeyScope` + `storeAllowed`.

| Route | Direction | Believed consumer | Status |
|---|---|---|---|
| `api/external/sales` | POS → ERP | Daily sales / books feed | ✅ §1 |
| `api/external/sold-items` | POS → ERP | Inventory usage pull | ⬜ |
| `api/external/inventory-items` | POS → ERP | Item master sync | ⬜ |
| `api/external/payment-methods` | POS → ERP | Payment-method mapping | ⬜ |
| `api/external/staff-metrics` | POS → ERP | Performance scoring | ⬜ |
| `api/external/staff-profiles` | POS → ERP | Staff identity | ⬜ |
| `api/external/stores` | POS → ERP / Website | Store roster | ⬜ |
| `api/external/feedback` | POS ← ? | Customer feedback capture | ⬜ |
| `api/admin/storefront-catalog` | POS → Website | Public menu/catalogue | ⬜ |
| `api/webhooks/paymongo` | PayMongo → POS | Payment provider callback | ⬜ |

> **Each ⬜ becomes a section as we touch it.** Do not assume the consumer named above is
> correct — it is inferred from the route name, not verified.

---

## 4. POS ↔ CUSTOMER ⬜

Believed connections, **none verified this session** — recorded so they are not forgotten:

- Refill rules and timers; refill cache authored in POS, consumed by CUSTOMER
- Loyalty rewards with a per-store disable list
- Kitchen tickets / KDS serve paths
- Shared Firebase project → shared rules blast radius

---

## 5. POS ↔ Website ⬜

- `api/admin/storefront-catalog` feeds the public menu
- Storefront online ordering and per-store menu selection
- Store enrolment / reservation surface

---

## 6. What this means for ERPv2

The ledger's **revenue** depends entirely on §1, and its **inventory cost** will depend on
`sold-items` / `inventory-items`. Two consequences already recorded in T-113:

1. ERPv2 must treat the POS feed as a **source document with known semantics**, not as raw
   truth — `takeOutSales` in particular is derived, and derived figures need a reconciliation
   rule, not a direct posting.
2. The historical window is clean **only because online does not exist yet**. That is a
   time-limited property and it is the reason §2 is worth doing now.

---

## Open questions

| # | Question | Blocks |
|---|---|---|
| 1 | Is à la carte eaten in or taken away — does 4150 need to be a live account? | T-113 §6.6 |
| 2 | Which repo owns the Firestore ruleset in the shared POS/CUSTOMER project? | Any rules work |
| 3 | Do the seven unverified `external/*` consumers match their route names? | Phase 2/3 |
| 4 | What happens when a POS payment method name matches no key list? | Reconciliation |

## Change log

| Date | Change |
|---|---|
| 2026-08-23 | Created. Seeded from T-113 discovery: §1 POS→ERP sales feed verified with citations, §2 online-order gap, §3 API surface enumerated. |

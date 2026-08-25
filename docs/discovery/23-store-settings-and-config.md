# 23 — Store settings and config, across ERP and POS

**Date:** 2026-08-25 · **Read-only** over `ERP-rebuild` and `POS` (`sev5_advanced`)
**Prompted by Ian:** *"Inspect store settings on both ERP and POS v1 — you'll get a better picture
of the app, as well as admin settings like config etc."*

**Why it matters more than it sounds:** ⭐ **the POS↔ERP seam is almost entirely configuration, not
code.** How a day's sales reach the books, which channel they land on, which payment account they
map to, whether a store is even eligible for a pull — all of it is fields on a store document. *A
misconfigured store does not throw; it silently reports less money.*

---

## 1. The two `Store` types overlap by ~9 fields, with no sync between them

`ERP-rebuild/src/types/index.ts:135-198` · `POS/src/lib/types.ts:1109-1210`

| Field | ERP | POS |
|---|---|---|
| name · address · code | ✅ `storeCode` | ✅ `code` |
| **`tin`** | ✅ | ✅ |
| **`taxType`** | ✅ | ✅ (+ `taxRatePct`) |
| openingDate · contact · email · logo | ✅ | ✅ |
| active/status | ✅ `status` | ✅ `isActive` |
| AI master switch | `aiInsightsEnabled` | **`aiEnabled`** — different name, same job |

They are joined by a **hand-set `posStoreId`** on the ERP store. **The same restaurant exists twice,
with two identities and two copies of its statutory data.**

> ⛔ **`taxType` being duplicated is the dangerous one.** POS computes the customer's receipt from
> its own `taxType` + `taxRatePct`; the ERP keeps its own. **If the two ever disagree, the receipt
> the customer holds and the books disagree about VAT** — and nothing anywhere compares them.

### ⚠️ But "pick one" is the wrong fix for most of these

The cash handover *is* a computation, so it has exactly one right home (§4). **`taxType` is not** —
POS genuinely needs it at the point of sale, and the ERP genuinely needs it for the books.

> **The rule is one OWNER, published to whoever needs it — not one copy.** That is the bible's
> Lane A mirror, and it is the shape most of this table wants. Only *one* of the two may be
> editable; the other reads.

---

## 2. ⛔ The silent-sales-loss landmine

`Store.posSalesChannelId`, and the comment is the finding:

> *"Sales channel that receives the POS pull's whole `totalSales` figure. POS dine-in/take-out is
> split by session mode and does not line up with ERP channels, so the full total lands on one
> channel. **When unset, the pull falls back to the first active channel whose name contains
> "dine"**; a store with no such channel (e.g. Walk In / FoodPanda / GrabFood only) would otherwise
> **drop its sales silently.**"*

**Three separate problems in one field:**

1. **A string-match fallback on the substring `"dine"`.** Rename a channel to "Restaurant" and the
   match stops.
2. **The failure mode is silent.** No error, no zero — the day simply reports less money.
3. It confirms Ian's account exactly: **POS's session modes do not map to ERP's channels**, so the
   entire POS total is dumped onto one channel and the rest are entered by hand.

**v2:** the channel a POS pull lands on is **explicit and required**. No substring fallback, and an
unresolvable channel **blocks** — the same rule as an unmapped expense category (T-122 invariant 7).

---

## 3. What each side actually configures — and it maps cleanly onto Ian's split

Ian: *"POS will only transact — its job is getting the order, passing it to kitchen and server,
computing and processing payment. Just that. ERP will handle the money."*

**The existing config already sorts almost perfectly along that line**, which is a good sign the
split is natural rather than imposed:

| POS-side — *serving and transacting* | ERP-side — *money, people, statute* |
|---|---|
| `offersAlaCarte` / `offersUnlimited` (which start-session buttons appear) | `salesChannels[]` + **`isRemittedDaily`** |
| `openingTime` / `closingTime`, `onlineOrderMode`, `onlineOrderManualOpen` | `posPaymentMethodMap` (POS method name → ERP payment account) |
| `deliveryRadiusKm`, `pickupRadiusKm`, `geo` | `posSalesChannelId` (§2) |
| `acceptsOnlineOrders`, `acceptsReservations`, `acceptsWebsiteChat`, `fbPageLink` | `channelSettlement` — `storeKey`, `matchLabels`, `fileHints`, `foodpandaPartnerCode` |
| `loyaltyConfig`, `forecastConfig` | `attendanceConfig`, `payrollConfig`, `holidayCalendar` |
| | `storeKind` (commissary/branch/kiosk), `hasProduction`, `legalName` |

**⭐ `SalesChannel { channelId, name, isActive, isRemittedDaily }` is exactly the per-store
remittable flag Ian described** — and it is the field that decides whether a channel's money
reaches the till at all. Foodpanda money settles to a bank later; cash does not. **That flag is
what makes expected remittance computable**, and it is already there.

### ⚠️ Two smaller landmines in the settlement wiring

- **`foodpandaPartnerCode` is documented as NOT unique** — *"Lipa and the TEST sandbox deliberately
  share O6JZ."* ✅ **Not a real constraint, and v2 should drop it:** Ian, 2026-08-25 — *"never mind
  TEST, it's a test store, not real."* The only collision is with a sandbox that does not carry
  forward (ADR-007 purges it), so **v2 may treat the partner code as unique per store** and gets a
  simpler key for free. *Recorded because the comment reads like a business rule and is not one.*
- **`matchLabels` / `fileHints`** route uploaded settlement PDFs/CSVs by **outlet-name text match
  and filename substring** (`"lip 15.zip"` → Lipa). Works, and is fragile in the same way as §2.

---

## 4. ✅ The cash handover — folded to the ERP (Ian, 2026-08-25)

> *"The cash handover is duplicated in POS and ERP shift report. Let's simplify — fold that to ERP
> or POS, not both. I suggest ERP, because the cash handover is affected by deductions like
> expenses paid by cashier, cash requests released by cashier, online payments converted to cash,
> AP paid by cashier."*

**Agreed, and his reason is the decisive one.** POS computes
`expectedCash = startingCash + cashSales − deductions[]` — but **POS does not know the deductions.**
Every one of them is an ERP document.

> **So POS's `deductions[]` can only be filled by the cashier re-entering what the ERP already
> knows — a second entry point for the same fact, which is precisely how two figures come to
> disagree.** An expected-cash figure is only as good as its deduction data, and only one of the
> two systems has it.

**POS may still take the physical count** at the terminal, where the drawer is. **But it submits
evidence; it does not compute expected cash.** One computation, one owner.

⚠️ **Design for, do not discover:** POS sells offline (discovery 22 §4) and the ERP may be
unreachable at shift change. **A count is not a sale** — it can go on paper and be entered late —
but the flow must say so rather than failing.

---

## 5. Patterns worth keeping

| | |
|---|---|
| ⭐ **Fail-closed opt-ins** | `wastageEmailIngestEnabled` — *"Undefined/false = NOT ingestable (fail-closed)"*; `aiEnabled` / `aiInsightsEnabled` both default OFF. **A store must opt in to be acted upon** |
| ⭐ **`noSalesChannelIds`** on the sales day | Channels explicitly marked *"No Sales"* versus left blank — *"lets a reviewer tell 'confirmed no sales' apart from 'forgot to fill this in'."* **This is the same distinction T-134 B3 makes about a counted zero, already solved here** |
| **`posSourced` / `posSourcedAt`** | The day's figures record whether they came from a POS pull or were hand-entered. **Provenance on the figure itself** |
| **Configuration replacing constants** | `channelSettlement` exists *"so a new store is configuration, not a deploy"* |

---

## 6. What v2 does about it

1. **One `stores` row.** The duplication in §1 dissolves — it is an artefact of two databases, and
   there is only one now. `posStoreId` disappears with it.
2. **One owner per setting, published where needed** (§1). Not one copy; one *editable* copy.
3. **No substring fallbacks** (§2). An unresolved channel or payment mapping **blocks**.
4. **Expected cash is computed once, in the ERP** (§4).
5. **Keep the fail-closed defaults and `noSalesChannelIds`** (§5) — they are already right.

## Open

1. **Which side owns `taxType` in v2?** It must be ERP (statutory, and the books depend on it), with
   POS reading a published copy — but confirm before wiring, because POS computes receipts from it
   and a stale mirror is a wrong receipt.
2. **Do `offersAlaCarte`/`offersUnlimited` survive** once POS v2 exists, or do they become a
   property of the channel list? They currently gate cashier buttons only.
3. **`storeKind` and `hasProduction`** gate whole feature areas. They belong with Phase 3's
   commissary work, named here so they are not rediscovered.

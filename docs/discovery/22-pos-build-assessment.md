# 22 — POS as a BUILD: what to preserve, improve, and correct

**Date:** 2026-08-25
**Brief (Ian):** *"Most of my current POS v1 is in good shape, and since the majority of sales data
will come from that app, good to start looking at its build. Try to preserve as much as it does,
improve what can be improved, correct what's flawed. My staff can navigate the app well, so most
work is on backend. Research and plan with the principle that POS v2 is an improved v1, not a new
one."*

**Method:** read-only over `C:\Users\ianla\webapps\POS` (branch `sev5_advanced`). **Builds on
`docs/discovery/09-pos-system.md` (557 lines) rather than re-deriving it** — 09 is the
entity/behaviour inventory and its findings are cited, not repeated. This document asks the
question 09 explicitly did not: *given that inventory, what does v2 keep?*

---

## The headline: "most work is on backend" is literally true, not approximately

| | Measured |
|---|---|
| Source files (`src/`) | **601** · ~98,900 LOC |
| Page routes | **49** |
| API routes | **62** |
| **Client files writing DIRECTLY to Firestore** | **73** (`setDoc`/`updateDoc`/`addDoc`/`writeBatch`/`runTransaction`, excluding `api/` and `server/`) |
| The sale engine | **`src/components/cashier/firestore.ts` — 1,526 lines, in the browser** |
| Test files | 64 |

> **POS v1 has almost no backend for a sale.** Receipt numbering, bill computation, payment
> validation, analytics deltas and the audit log all execute in the cashier's browser and write
> straight to Firestore. The 62 API routes serve admin, cron, loyalty, storefront and the 8
> read-only ERP endpoints — **not the transaction.**

**So Ian's read is exactly right, and the reason is architectural, not cosmetic.** The screens are
good and the staff know them. What has to change is *where the rules run* — and on Postgres it
cannot be the browser, because a browser cannot be trusted with a `BEGIN`.

---

## 1. PRESERVE — and this is the majority of the app

**v1 is in better shape than most systems this project has read.** Naming the specific good
decisions matters, because "improve it" otherwise becomes licence to rewrite them.

| What | Why it survives untouched |
|---|---|
| ⭐ **The whole cashier / server / KDS interaction model** | Staff are fluent in it. **Retraining is a real cost that buys nothing** — the screens are the part that works |
| ⭐ **Offline-first selling** | Purpose-built, documented, and load-bearing. A restaurant that cannot sell when the uplink drops is not a restaurant. See §4 — this is the hard part |
| **Payment validation in integer centavos** | `Math.round(amount*100)` with a 1-cent tolerance (09 §4). v1 already knew floats were wrong *at the point it mattered most* |
| **Change is only payable against a cash tender** | Completion throws otherwise (09 §4). A small, correct rule most systems omit |
| **Asia/Manila day boundaries computed explicitly** | With an inline comment recording that host-local time shifted every hourly bucket by −8h in production (09 §8). **That comment is a scar; keep the fix and the scar** |
| **`activityLogsByDay` — full before/after audit of every session mutation** | Already the audit trail bible §4 requires. v2 inherits it, it does not invent it |
| **PayMongo webhook idempotency** (`processedEventIds[]`) + HMAC verification | Correct by construction |
| **External-API auth: timing-safe compare, and no silent misconfiguration** | If neither key env var is set, every request 500s (09 §9.1). **A control that fails loudly** — the opposite of DEF-052 |
| ⭐ **"The POS does not record what was received here"** — QR proof is photo-only, no amount, no reference | A deliberate refusal to record a number nobody verified. **This is the same instinct as the 3900 halt** |
| **The 8 read-only ERP endpoints** | They are the contract Phase 2's sales day consumes. **They keep working through the January cutover** — see §5 |
| **`sold-items` computed from a bounded receipts scan, not the analytics doc** | Chosen for "stable ids, correct refund netting, and comped units kept separate" (09 §9.2). Someone thought about this properly |

---

## 2. IMPROVE — same behaviour, better mechanism

| What | Today | v2 |
|---|---|---|
| **Where the sale executes** | 1,526-line browser module | A server transaction. **The single biggest change, and it is invisible to staff** |
| **Money** | JS float from creation to storage; `increment()` sums floats in analytics | Integer minor units, decided once (bible §6). 09 §4 already recommends this |
| **Rounding** | Two textually identical implementations (`money.ts`, and a private copy in `tax.ts`) | One importable source of truth |
| **The analytics day doc** | Two mechanisms that must agree — per-receipt `increment()` deltas *and* a `merge:false` full rebuild | **Derived from the ledger, not maintained.** Same lesson as T-135: v1 stores what v2 recomputes |
| **Connectivity signal** | Bare `navigator.onLine` — reports "attached to an interface", not "the server answers" | A reachability probe. 09 §6.6 names this; the fix was specced in v1's own backlog and never built |
| **`sessionMode`** | Two values doing four jobs; take-out is indistinguishable from dine-in à la carte | A real `sales_channel` column — see §3, this is a correction not an improvement |

---

## 3. CORRECT — the flaws, all previously found and none yet fixed

Every one of these is already documented in 09 with a `[VERIFIED]` citation. **None is a surprise;
all are unfixed in v1 and must not be inherited.**

1. ⛔ **`receiptSeq` holds two non-comparable sequence spaces.** Online receipts carry a
   store-lifetime counter; offline receipts carry a **per-device, per-day** counter — both small
   integers in the same field (09 §5). Any v2 schema treating it as a monotonic per-store key
   *silently misorders the moment one offline sale exists.* **v2 needs a real key and must keep
   `receiptNumber` as the human-facing string it already is.**
2. ⛔ **No server-side guard against a stale offline write clobbering a finalized receipt.** The
   intended Firestore rule was specced in v1's own backlog and never implemented — confirmed
   absent from `firestore.rules` (09 §5). Today's only protection is a client-side toast **after**
   the write has landed. In v2 the server owns the write, which removes the class.
3. ⚠️ **`receipt.source = "online"` is stamped and never read.** Online-order sales fold into the
   same `walkIn` analytics bucket as in-store à la carte (09 §3). **A sales-channel dimension does
   not exist as one column anywhere today** — and the ERP's own channel settlement work assumes it
   does.
4. ⚠️ **A rebuild silently zeroes kitchen and per-staff stats** if kitchen tickets were ever
   purged, because the rebuild is `merge:false` and ticket-sourced (09 §8). Already bitten this
   business once.
5. 🔸 **Multi-tab offline receipt numbering can reuse a sequence number** — race-free only within
   one webview, which the shipping APK happens to be (09 §6.6). True today by luck of packaging.
6. 🔸 Minor, known, still open: an offline void with nothing to sync shows a misleading "will
   sync" toast; the drain toast says "sale" for a void; an offline void's KDS station-doc update
   is unguarded and would fail the whole batch on sync (09 §6.6).

---

## 4. ⚠️ The real architectural problem: offline selling versus bible rule 1

**This is the finding that decides the shape of POS v2, and it is a conflict, not a detail.**

Bible §5.3 offline write-back rule 1 says:

> **"A device never computes a business outcome offline."**

**POS v1's offline path does precisely that** — it computes the bill, allocates a receipt number,
prints, and applies analytics, with no server involved. And it must keep doing so: *a cashier
cannot tell a customer the till is down.*

Worse, the **hot set is a closed list** (§5.3) and **contains no POS entity at all** — it was
written for the attendance clock terminal. POS was never in scope of the offline model.

### The reconciliation, and it is principled rather than an exception

The rule is right for attendance and wrong-shaped for a till, because the two devices are doing
different things:

| | Clock terminal | POS terminal |
|---|---|---|
| What the device captures | *"Ana pressed her finger at 09:03"* — an **event** | *"₱1,240 was taken, ₱260 change given, receipt printed"* — a **completed physical fact** |
| Who decides the outcome | The server. Late? Which shift? What deduction? | **Nobody.** The money already moved. The paper is already in the customer's hand |
| Can it be provisional? | Yes | **No.** A receipt is a document handed to a person |

> **A POS sale recorded offline is not the device computing a business outcome — it is the device
> RECORDING one that already happened in the physical world.** The server's job is to accept the
> record, not to decide it.

**And the guard that makes this safe is cheap:** the bill is deterministic arithmetic over priced
lines, so **the server recomputes it from the line items and compares.** Agreement is silent;
disagreement is a finding (T-135), never a silent accept. That keeps offline selling *and* removes
"the device's arithmetic is trusted" — which is the part rule 1 actually cares about.

**This needs an ADR and a bible amendment before any POS v2 code is written.** Rules 2–5 (never
edit a synced record · replay in event-time order · uniqueness is a DB constraint · quarantine,
never drop) all carry over unchanged and are exactly right for a till.

---

## 5. ⚠️ There is no POS phase in the plan — and January does not need one

**Phases 0–8 deliver the ERP.** `apps/pos` is reserved in the repo layout and **no phase delivers
it.** Phase 2's "sales day" is the ERP's *record of* POS sales — the daily summary pulled through
`/api/external/sales` — not the till.

**That is not an oversight to fix by rushing.** ADR-005's January cutover is **books-first**:

- The ERP consumes POS through **8 read-only endpoints** that keep working unchanged.
- POS v1 stays live and correct on Firestore. Nothing about the opening balance depends on
  replacing it.
- Replacing it means ~98,900 LOC, an offline engine, **and hardware** — Bluetooth/USB ESC/POS
  printers, KDS screens, a Capacitor APK on the cashier terminal. That is not a module; it is a
  phase.

> **The right time is after January, and the reason is scheduling honesty, not caution.** Wave 1
> (expenses + sales day) is the only thing standing between now and the 30 September checkpoint,
> and *"Wave 0/1 slipping"* is the one risk the phase plan names as compounding.

### What this research buys us *now*, before any of that

1. **It sharpens T-123.** Sales day consumes POS output — so the `sessionMode` gap (§3.3) and the
   missing channel column are **T-123's problem in October**, not POS v2's problem next year.
2. **It fixes the sequencing question before it is expensive.** Deciding *"POS v2 is a phase after
   January"* on evidence beats discovering it in December.
3. **The archive project is reusable evidence.** `C:\Users\ianla\webapps\POS MIGRATION` already
   has a Postgres schema for POS receipts and a real census — **7 stores, 9,533 receipts, main
   store ~33/day** (2026-08-13). ⭐ **That volume matters: this is not a throughput problem.** A
   POS v2 on Postgres has no scale obstacle whatsoever, which removes the usual reason such a
   rebuild is hard.
   ⚠️ It also found that payments live *nested under sessions*
   (`stores/{id}/sessions/{sid}/payments/{pid}`), not flat under the store — a join every v2
   design must get right.

---

## Recommendation

| | |
|---|---|
| **Now** | Finish Wave 1 — **T-123 sales day**. This document is an input to it, not a competitor |
| **Before any POS v2 code** | An **ADR on offline selling** (§4). It is the decision everything else hangs from, and it amends the bible |
| **After January** | POS v2 as its own phase, **strangled module by module** behind the same 8 endpoints, screens preserved |
| **Never** | A from-scratch POS. §1 is most of the app, and it is good |

## Open

1. **Does POS v2 keep Firestore as the offline lane, or move to a local queue?** Firestore's local
   cache *is* the offline database today — that is why offline works at all. Replacing it is a much
   bigger change than replacing the server.
2. **What happens to the 55 per-store subcollections?** Many are configuration (KEEP), some are
   operational (PURGE), several are caches that should be derived. They need the T-119 treatment.
3. **Does the APK stay Capacitor?** Out of scope here; named so it is not forgotten.

# Handoff — the inventory lane, 2026-08-29 → 30

> ⚠️ **Lane-scoped on purpose.** `docs/HANDOFF-TODAY.md` is the shared wrap-up ritual's file and
> belongs to whoever runs it; overwriting it from one of three concurrent lanes would clobber
> another lane's handoff. This file is only the `inventory` branch.

**Branch:** `inventory` · **pushed** to `origin/inventory` · 4 commits since `main`.
**Gates at the end:** 676/676 unit · 1,446/1,446 integration · `npm run build` green.

---

## 1. What shipped

| Commit | What |
|---|---|
| `0d9f69a` | **T-171/172/173** — the commissary catalogue, the branch order, and the receipt that moves both stores' books in one transaction |
| `c07a0ee` | **T-174** — what happens to the goods that never arrived, and the `1340` hole it exposed |
| `cdb56de` | **T-175** — low stock becomes an order, and the order has a conversation |
| `4f64b3a` | **The wave gets a surface** — five screens, and the app's first navigation |

That closes the commissary → branch pipeline end to end on the ledger side. It is the deliverable
`CAPABILITY-GAPS.md` calls *"the largest single omission in the plan"* — for a branch store, this
IS how inventory gets replenished, and it straddled Phases 2 and 3 owned by neither.

---

## 2. ⭐ The one that mattered — DEF-098

**`1340 Inventory in transit` could never clear.** The dispatch debited it at what the goods COST
the commissary (FIFO, ₱300/kg); the receipt credited it at the agreed TRANSFER rate (₱310/kg).
Those differ *by design* — T-133: *"the transfer PRICE carries the processing cost."* So a fully
received ₱30,000 shipment transferred at ₱31,000 left the account at **−₱1,000, permanently, once
per shipment.**

⚠️ **The trial balance still tied**, because the ₱1,000 was merely in the wrong account. Nothing
announced it, and the periodic pattern this replaced had no in-transit step for the error to hide
in. It was one day old when T-174's fixture found it by asking what was actually stranded after a
short receipt.

**The rule that closes it: `1340` is a COST account, relieved at cost, always.** The margin is a
different fact — the commissary's processing work — and it goes to `5175`, only for goods that
actually arrive.

⭐ **That makes `5175` load-bearing under perpetual**, rather than a periodic leftover kept for the
franchise case. Crediting it nets the commissary's payroll for the job back to zero, which is
correct: *an internal transfer earns nothing.*

---

## 3. Decisions I made that you should check

### ⚠️ I overrode one of my own spec rules — T-174 invariant 6

The spec said a staff **charge** must be refused until Phase 5's payroll module exists. It is not.
Refusing leaves *audit* and *loss* as the only options, so a genuinely **recoverable** shortfall
gets written off as a loss — worse, and irreversible in the books. The same `1230` receivable is
already raisable through two shipped doors (`owners`, `cash-requests`), so a gate here would be
inconsistent rather than protective.

⛔ **The real gap is DEF-099: nothing in the codebase ever CREDITS `1230`.** Same shape as
DEF-082's service-charge float — the accrual shipped, the clearing did not. The right control is an
ageing alarm, not a block. **It is not built.**

### ⭐ T-175's open question, answered the recommended way

v1 queues a low-stock item onto the branch's draft at **quantity 0**. I build it with a **suggested
quantity** — `threshold − onHand`, rounded up — because a zero-quantity line is a to-do item
wearing an order line's clothes, and a line that arrives filled in is one keystroke *fewer* than a
blank one.

**One line reverts it:** `suggestFor()` in `packages/domain/src/commissary/auto-order.ts` returns
`quantity('0')`.

### ⭐ Three capabilities granted to ALL FOUR roles

`confirm_receipt`, `set_item_threshold`, `post_order_message`. That means the role column proves
nothing for them and some other control has to be real — pinned and reasoned in
`authorize.test.ts`'s `UNIVERSALLY_GRANTED` list. For `confirm_receipt` the real control is the
two-sided store check; a branch cook signing for crates should not need a manager on site, because
that is the rule people work around by sharing a login.

---

## 4. What the new screens found on their first run

⭐ `/inventory` renders **bible invariant 6's inventory arm** — FIFO layers against
`1310+1320+1330` — which the bible asks be checked *"continuously, not at year end"* and which had
never existed anywhere a person could see it.

It immediately showed **Malvar ₱480 out of tie**. Traced to a pre-existing `demo_seed` fixture in
`shareat_dev` that posts `Dr 5300 / Cr 1310` for ₱480 with **no stock movement behind it**. Not
this lane's data. **Left in place deliberately** — it is a truthful demonstration of the panel
working, and it means `shareat_dev` has never tied and nobody knew, because there was nowhere to
look.

⚠️ Also fixed while verifying: the deferral date defaulted to `toISOString().slice(0,10)` — UTC.
Manila is UTC+8, so at 01:50 local the form offered **yesterday**, and a manager deferring "to
today" would have got a date already past — blocking again immediately and burning their one
allowed deferral.

---

## 5. Six defects logged

| # | Sev | One line |
|---|---|---|
| **DEF-094** | ⛔ | A migration is **silently skipped** when a concurrent lane's went in first — three worktrees share one `shareat_dev`. Both other lanes are exposed right now |
| **DEF-095** | ⛔ | `schema/trade.ts` stated a constraint T-133 had already replaced; acting on the stale text, I wrote a migration that **reverted its fix**. T-133's own 9 tests caught it |
| **DEF-096** | ⚠️ | `INVENTORY_ACCOUNT_BY_ITEM_KIND` maps `prepped`, which `ITEM_KINDS` cannot store — `1330` is unreachable until T-176 |
| **DEF-097** | ⚠️ | Every Phase 3 domain module was unreachable outside `packages/domain`. Exporting them surfaced two same-named `PostingResult` types with different shapes |
| **DEF-098** | ⛔ | §2 above |
| **DEF-099** | ⚠️ | Nothing ever credits `1230` |
| **DEF-100** | 🔸 | Three specs exempt an item kind that does not exist, so the exemption is structural — and becomes a real gap the day the kind is added |

---

## 6. ⛔ What I did NOT touch, and why

- **T-165, the periodic → perpetual switch.** `dispatchTradeOrder` still posts the old
  `5170`/`5175` shape and is what a real order goes through; my perpetual functions are called by
  nothing. Running both for one order would **double-count the transfer with a trial balance that
  still ties**. The warning is in both module headers and in `POSTING-PATTERNS.md`. This is a live
  accounting cutover and it is your call, not an overnight one.
- **T-151's outbound delivery fee on the transfer.** The sources genuinely do not determine a
  posting — `deliveryFee`'s own comment says *"no separate freight leg and no freight account"*
  while T-151 invariant 2 says it must not enter the item's cost, and those two leave nowhere for
  it to land. The obvious shape risks driving the commissary's expense **negative** when the
  haulage was its own driver's time. It needs the v1 read. T-173 §12.
- **`docs/ROADMAP.html`.** Stale for the whole Phase 3 wave, not just this lane — its ids stop at
  T-152. Three lanes are writing into that wave; one of them rewriting a shared HTML file is a
  merge conflict the other two find later. It wants one pass by whoever merges, or a generated file.
- **`main`.** It is 12 commits ahead of `origin/main` and not all of them are mine.
- **`AGENTS.md`, `CLAUDE.md`, `docs/RULES.md`, `ROADMAP.html`** — modified in the working tree by
  another lane. Left alone.

---

## 7. To pick it up

```bash
git checkout inventory
npm run db:migrate            # ⚠️ then CHECK it applied — DEF-094
npm run dev:seed              # people, PINs, channels
npm run dev:seed:inventory    # the worked commissary shipment, through the real domain functions
npm run dev                   # port 9008
```

Sign in as **Dev Admin / `111111`** at either store, then:

- `/inventory` — switch between Lipa and Malvar. Lipa ties with ₱3,000 in transit; Malvar shows
  the ₱480 drift described above.
- `/inventory/low-stock` — Malvar's pork sits at 90 kg against a 120 threshold.
- `/commissary/discrepancies` — the 10 kg shortfall, and the sales-day block it causes.

**The next UI slice** is receiving (T-166), usage and wastage (T-168), counts (T-169), and the
ordering lifecycle (T-172). The engine for all of them is green and unreachable. The pattern is
established: a `lib.ts` of reads, a `page.tsx`, an `actions.ts` that authorises and calls the
domain, and nothing re-implemented in between.

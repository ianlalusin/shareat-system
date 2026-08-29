# Handoff — 2026-08-29

## Where things stand

**Waves 0–5 are complete, and so is the cutover machinery.** Every module that posts to the ledger
exists, is tested, and has a screen or a script in front of it: AP, AR, expenses, sales days, fixed
assets, prepaid, loans, equity, liabilities, customers, items, wholesale orders, inter-store
transfers, channel settlement, the integrity watchdog, and the 31 December conversion.

**Three tasks remain, all designed and none started:** T-136 cash custody, T-137 statutory discount
logbook, T-146 invoice OCR (parked — it needs a GitHub repo URL from Ian).

**The nearest real deadline is the November cutover rehearsal**, roughly eleven weeks out. The
wizard, the count sheet and the opening-balance entry all work; the purge is deliberately still a
command-line step.

## Gates at `1db914a`

typecheck 0 · unit **611/611** · integration **1173/1173** (40/40 files) · build 0

⚠️ The build was run and green at this code state before the dev server was restarted for a UI
walkthrough; port 9008 is live now, so a re-run would clobber the `.next` it is serving.

## What happened this session

### Wave 4 — the documents Wave 3 was built to feed

- **T-132 wholesale orders.** `ar_charges` had a total and no lines, so a franchisee sale was a lump
  sum and the item master, price lists and `sellable_wholesale` had no reader. Now an order document
  consumes all three. **The research already existed** — `docs/discovery/19-b2b-order-to-cash.md`
  read ERPNext, Odoo, Tryton and Dolibarr at pinned commits — and its three open forks were taken on
  its own recommendations: dispatch *is* the billing event, one credit gate, the rate is captured.
- **⭐ Two findings from reading our own schema:** there was **no wholesale revenue account**
  (`4300` added by migration — not `4200`, which the 2026-08-23 amendment removed), and
  `customer_group`'s `internal` vs `wholesale` is a **chart boundary, not a label** — an own-branch
  transfer eliminates against `5170` or the peso counts twice.
- **T-133 inter-entity trade** turned out not to be a new document at all. ADR-008 §8 had already
  decided it: *"one flow, two treatments — a mode is a fork; a derived treatment is a fact."*
  `wholesale_orders` was renamed `trade_orders`, because the old name was about to start lying.

### ⛔ T-133 was wrong, and Ian's question found it within the hour

He asked how Malvar expenses a slab Lipa bought and processed. The honest answer under what had just
shipped was: **it cannot, and Lipa carries 100% of a cost for goods it no longer holds.**

The posting followed `POSTING-PATTERNS.md` faithfully — and that pattern assumes **perpetual**
inventory. This system is **periodic**: every expense category maps to a 5xxx COGS account, and
before T-133 *nothing in the codebase debited 1310, 1330 or 1340*.

**A transfer moves COST now**, via `5175 Cost transferred to branches` — the account `5170`'s own
seed comment has demanded since T-102b and which had never been created. `POSTING-PATTERNS.md`
carries both shapes, each labelled with the era it belongs to.

### T-151 — the two delivery fees, which is Ian's rule verbatim

> *"delivery fee from supplier to Lipa is added to price. delivery fee on top of that is the fee
> from Lipa to Malvar."*

Inbound freight is allocated across invoice lines **by value** and folded into landed cost; outbound
freight rides **on top** of the trade order. Plus v1's branch price, ported at source — three modes,
`max` of the last two receives, slab-linked costing, margin alert.

⭐ **The one improvement on v1:** the basis is **derived** from invoice history, not stored. v1's
rolling `lastReceivedCost` froze a chopstick price at ₱1,458 instead of ₱1.46 and could not
self-heal. There is a test reproducing that exact case and proving it now heals on the next read.

### T-150 — channel settlement, built to a peer session's spec

`ianla-72` wrote `docs/tasks/150-channel-settlement.md`; Ian said build it. Both of its open
decisions were taken on its own recommendations (`6420` seeded; `1220` and the clearing accounts
keep separate jobs). **Withholding tax is an expense at `6800`, and no `1270` asset is seeded** —
the credit cannot be realised, and an account that exists invites someone to use it.

Three corrections while implementing: the spec's `1120` is staff-custodian cash, not a bank (the
code now asks the chart whether the destination needs a party); v1's "void refuses while a loan
payment stands" guard is **not needed here**, because the repayment is a leg inside this settlement's
own entry; and the cross-store loan legs needed care.

### T-135 — the watchdog, where only the acknowledgement is stored

Seven ledger-integrity detectors, derived on every read. **A finding cannot be "resolved" while it
is still true** — acknowledging says *"I accept this for now"*, is still counted, ages visibly, and
expires after 30 days. Half-closes DEF-078.

### T-134 — the conversion, its screens, and its buttons

Twelve steps, four gates, resumable. `/cutover`, `/cutover/count`, `/cutover/opening`.

**Two findings from building it:** two of the six ✅ checks **cannot be checked here** (they query v1
data this system never holds — they say so rather than showing a tick they did not earn), and a
verified check **can pass vacuously** — *"3900 nets to zero"* is trivially true on an empty ledger,
so a blocked step is now never `done` even when its own check passes.

**Three copy bugs that only looking could find:** the ⭐/⚠️/⛔ markers this project uses in source
comments were rendering mid-sentence on screen; *"Checked by a query · not machine-verifiable"*
appeared side by side; and a heading said "v1".

### ⛔ DEF-079 — the purge could never have run

`scripts/cutover-purge.ts` `DELETE`s the purge-class tables, and `journal_entries` has a BEFORE
DELETE trigger that raises on any **posted** row. Every real ledger is posted rows.

**Proved, not reasoned:** deleting a posted entry in `shareat_test` inside a rolled-back transaction
returned the trigger's own message.

**Nothing caught it because no test ever ran the purge against posted data.** T-119's tests cover
classification and ordering — both correct. Fixed with `TRUNCATE`, which does not fire row triggers
by definition, so invariant 5 stays armed everywhere else. Chosen over a GUC exemption (a flag a code
path can forget to unset) and over `session_replication_role = 'replica'` (which disables FK
enforcement too).

### Also this session

- **DEF-078** — the month-end runner has no installed trigger. Raised after I wrote the opposite
  into the roadmap and caught it an hour later.
- **The roadmap was two waves stale** — Wave 2 read "in progress" when all four tasks had shipped.
- **Five task docs still said "Spec"/"design" after shipping** — corrected in this wrap-up.

### Where the decisions are recorded

| Decision | Recorded in |
|---|---|
| Two delivery fees, two treatments | `docs/tasks/151-*.md` §1 |
| Wholesale revenue is `4300`, not `4200` | migration `0056`, seed, task 132 §4 |
| `internal` vs `wholesale` is a chart boundary | `docs/tasks/132-*.md` §3 |
| A transfer moves cost, not inventory | `docs/tasks/133-*.md` §3, `POSTING-PATTERNS.md` |
| Withholding tax is an expense; no `1270` | `docs/tasks/150-*.md` §7, migration `0057` |
| `6420` seeded for settlement variance | migration `0057` §1 |
| A finding is derived; only the ack is stored | `docs/tasks/135-*.md`, migration `0058` |
| Purge uses TRUNCATE | **DEF-079**, `scripts/cutover-purge.ts` |
| Month-end has no installed trigger | **DEF-078** |

## Pick up here

1. **T-136 cash custody**, or **T-137 statutory discount logbook** — the only two designed-and-unbuilt
   tasks left. T-136 is the larger and the one that touches money.
2. **Rehearse the cutover against a restored copy** before November rather than in it. Everything
   needed now exists; DEF-079 is exactly what a rehearsal is for, and it was found early only because
   a button was built.
3. **The 94 import conflicts and 11 duplicate item pairs** are Ian's to action as super-admin.

## Do not decide these alone — they are Ian's

- **T-146 invoice OCR** — parked pending the GitHub repo URL he mentioned. Recommendation on the
  table: scaffold from an existing open-source project rather than build a reader.
- **The 94 import conflicts / 11 duplicate pairs** — judgement calls on units and identity that a
  machine should not make.
- **DEF-078(a): installing the month-end timer.** There is no host yet; it belongs on the T-134
  cutover checklist, and until then the finding will fire the moment a period completes. That is
  intended.

## Traps that have actually bitten

- **⛔ The purge and posted entries** — DEF-079. Fixed with TRUNCATE; do not revert to DELETE.
- **The balance check is DEFERRED** — every entry, draft included, must balance and have two lines
  **at commit**. An unbalanced draft cannot exist, which is why each opening figure is its own
  balanced pair against `3900`.
- **`requires_party` accounts** — `1120`, `1140`, `1210`, `1220`, `1250`, `2110`, `2150`, `2400`,
  `2500` refuse a line with no party. Test fixtures hit this repeatedly.
- **Pinned guards are decisions, not chores** — the account count (97→100 across this session), the
  capability count (47→48), the RLS and cutover registries. Each one caught something real.
- **The Bash tool mangles markdown prose** — backticks in `git commit -m` are command substitution:
  words vanish and it exits 0. Use `-F` or the Write tool.

## The paste-ready prompt

```
Continue on shareat-system (C:\Users\ianla\webapps\shareat-system).

Read docs/RULES.md, then docs/HANDOFF-TODAY.md. Waves 0–5 and the cutover are
built; T-136 cash custody, T-137 statutory discount logbook and T-146 OCR are
the only tasks left, all designed and unstarted.

Standing rules that catch agents out: verify v1's shape at source before
designing (ERP-rebuild is READ-ONLY and its name lies — it is the OLD live
ERP); assess a new feature before building it and be willing to argue against
it (/research-evaluate-propose); update docs/ROADMAP.html every wrap-up.

Start with T-136 cash custody unless Ian says otherwise. Spec first —
docs/tasks/136-cash-custody.md exists as a design.
```

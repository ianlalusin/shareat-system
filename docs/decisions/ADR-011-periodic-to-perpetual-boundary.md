# ADR-011 — The periodic → perpetual boundary: retro-fit, or a dated split?

| | |
|---|---|
| **Status** | ✅ **ACCEPTED 2026-08-29 — Ian answered the same day. §3.1 records the answer and how it differs from the recommendation.** Bible rows 165–166 |
| **Raised by** | The Phase 3 planning pass (`docs/plans/phase-3-inventory.md`), which cannot sequence a single task until this is answered |
| **Forced by** | T-133's correction of 2026-08-28 — *"this system is **periodic**"* — against bible §10's Phase 3 exit gate, which is **perpetual** |
| **Decides for** | T-160 – T-179, ADR-005's January scope, and whether `POSTING-PATTERNS.md` carries one live shape per event or two (**it carries one**) |
| **Does not decide** | FIFO vs weighted average (settled, bible row 110) · counted opening inventory (settled, row 109) · the commissary pipeline's operational design (that is the plan, not this) |
| **Bible amendment** | ✅ **APPLIED 2026-08-29 (v3.0)** on Ian's instruction — *"3 corrections go amend bible, your 3 points are all valid."* §16.11 rewritten · §10's Phase 3 row split · ADR-005's January scope amended · decision rows **165** and **166** added. §8 records each |

---

## 1. The collision, stated exactly

Two documents in this repo describe the same system and disagree about what it *is*.

**T-133, 2026-08-28** — verified against the codebase, not assumed:

> *"`POSTING-PATTERNS.md` §`commissary_dispatch.transfer` moves `1330` inventory, which assumes
> **perpetual** inventory — and this system is **periodic**. Verified: every expense category maps
> to a 5xxx COGS account, there is no capitalisation path, and nothing anywhere debited
> `1310`/`1330`/`1340`."*

**PROJECT_BIBLE §10, Phase 3's exit gate** — written 2026-08-22, never revised:

> *"Inventory control account = sum of on-hand valuations; stock ledger reconciles"*

An inventory control account that equals the sum of on-hand valuations **is** perpetual inventory.
It is invariant 6's inventory arm (§16.1), and it has never been enforceable because no inventory
subledger exists to reconcile.

### Both statements are true, and that is the problem

The system was **specified** perpetual and **built** periodic, one module at a time, each
correctly following the shape of the one before it. Nobody made a wrong call. The periodic shape
entered through T-122's seed comment, which named itself as a simplification and named who would
undo it:

> *"COGS categories map directly to a 5xxx account here — NOT the two-stage purchase → inventory →
> consumption pattern COA-ALIGNMENT §4.1 eventually wants (that needs real inventory tracking,
> **Phase 3**)."* — `packages/db/seed/expense-categories.ts`

Phase 3 is now. The accepted simplification has come due, and the bill is larger than the seed
comment implies, because five more modules have shipped on top of it since.

---

## 2. What is actually shipped, verified this session

Every row read at source, not remembered. This is the surface a retro-fit has to move.

| Module | Where the cost lands today | The perpetual shape it would have to take |
|---|---|---|
| **T-122** expenses | `expense_categories.account_code` → `5110`/`5120`/`5150`/… directly, on approval. `packages/domain/src/expenses/routing.ts` | Dr `1310`/`1320`/`1330` when the expense carries stock lines; the `5xxx` debit moves to consumption |
| **T-130** AP | Credits `2110`; debit side is the expense's, above | Unchanged on the credit side. The debit follows the expense |
| **T-145** item master + `supplier_invoice_lines` | Quantity, unit price, snapshotted conversion factor. **No stock effect at all** — the lines are price history | The same rows become the **FIFO layer's** source: quantity received, landed unit cost |
| **T-151** landed cost | Allocates fees by value in a *query*; feeds `item_pricing`. **Posts nothing** | The same allocation feeds the layer's unit cost, so a corrected fee re-costs the layer |
| **T-132** trade orders | Sale treatment: `4xxx` revenue + `1210` receivable | Adds `Cr` inventory / `Dr` COGS at dispatch — the goods leave |
| **T-133** internal transfer | `5175` seller-credit / `5170` buyer-debit, `1250`/`2150` reciprocal. **Cost moves; no inventory moves** | `1330` seller-credit / `1330` buyer-debit — already written in `POSTING-PATTERNS.md` as *"⛔ The Phase 3 target"* |

**Two facts about this table decide most of the argument below.**

⭐ **First: `2120 Goods received not invoiced` already exists**, seeded `reserved`
(`chart-of-accounts.ts:183`). ADR-009's amendment asked for exactly this account —
*"a provisional posting with nowhere to put the credit is not a design, it is a gap"* — and it was
provisioned and never activated. The retro-fit needs no new account, only a status flip.

⭐ **Second: `1310`, `1320`, `1330`, `1340` are seeded and empty**, and T-133 already resolved what
they are: *"**EARLY, not wrong.** They exist for a perpetual system this one is not yet; nothing
funds them, so nothing may relieve them."*

### The three modules that do NOT move

Worth naming, because it bounds the work:

- **T-134's cutover wizard and `opening_counts`.** Already collects quantity × unit cost per store
  per item. It is a perpetual-shaped artefact already, sitting inside a periodic system.
- **T-151's derivation.** It never posted, so it cannot have posted wrongly. It gains a second
  consumer, not a rewrite.
- **T-135's findings engine.** It gains detectors. Its shape is right either way.

---

## 3. ⭐ THE QUESTION FOR IAN

> **Do the six shipped modules get retro-fitted to the perpetual shape, or does a cutover date
> split periodic-before from perpetual-after?**

**My recommendation was: RETRO-FIT — and put the boundary on 2027-01-01, the date that already
exists.** Reasoning in §4–§6; what each choice costs the January books in §7.

The recommendation carried **one consequence Ian had to accept or refuse**, and it was the real
content of the decision: it moves Phase 3's *valuation core* into ADR-005's January scope, which
that ADR listed as **explicitly not in scope** (§7.3 below).

---

### 3.1 ✅ Ian's answer, 2026-08-29 — retro-fit, and for a better reason than mine

> *"For inventory let's build it right for v2 — everything in v1 plus the inventory being asset
> and used. That's the model of v1, it just was not realized, so we are building v2 a more robust
> way. Everything is anchored in inventory: the expense, delivery, usage, wastage etc. So when we
> test the app we are testing its final deliverable shape and won't need to adjust later. And we
> also capture things to be improved if there is."*

**Accepted: retro-fit. No dated split, no boundary constant, no second posting shape.**

⭐ **Two things in the answer go beyond what was asked, and both change how the work is framed.**

**First, the justification is TESTABILITY, not accounting tidiness.** My §6 argued the boundary
from period-close mechanics and the purge. Ian's argument is stronger and simpler: *a pilot that
exercises an interim shape has not rehearsed anything.* The Oct–Dec pilot is the only chance to
find out what staff actually do with these screens, and if it runs the periodic shape then every
finding it produces is about a system that will not exist.

> **Consequence: the practical deadline is not 31 December, it is "before the pilot meaningfully
> exercises inventory."** Earlier than the date this ADR proposed, and for a reason the ADR did not
> contain.

**Second, `2027-01-01` stops being a boundary at all.** With one shape and a purge behind it, there
is no periodic era in v2's books to be on the other side of anything. **The date is where the books
open, not where the basis changes.** The §5 fallback, the date branch, the second valued count and
the two-era `POSTING-PATTERNS.md` are all **withdrawn** — kept below only as the reasoning trail
(§14's rule: a superseded recommendation is kept, not deleted).

**Third, and it is the framing that matters most:** *"that's the model of v1, it just was not
realized."* ⭐ **This is not a new requirement — it is v1's own intent, finally implemented.** v1
records quantities and links a cost through an expense; it simply never posted the asset. Read as
`docs/RULES.md` §1.2b requires — *intent is authoritative, implementation is not* — **v1 has always
been a perpetual system that could not perform.** That reading also settles the four verbs for this
whole phase: this is **CORRECT**, not ADD.

⚠️ **What I flagged and Ian did not overrule, so it stands:** if the valuation core competes with
Phase 2's remainder (T-121 unbuilt, T-130 spec-ready), **Phase 2 wins.** Recorded in ADR-005's
amendment and in the phase plan's risk table.

⭐ **And *"we also capture things to be improved"* is now a deliverable, not a sentiment.** Every
Phase 3 task spec's `Done when` already routes findings through the three doors of bible row 164
(`DEFECTS-REGISTER` A–D · `CAPABILITY-GAPS` · `DEFECTS-REGISTER` E). The pilot's job is to fill
them.

---

## 4. Option A — retro-fit the shipped modules

**What it means.** The six modules change posting shape. One shape exists in the codebase. There
is no date branch anywhere, because there is nothing on the other side of any date.

### ⭐ The fact that makes this cheap, and it is easy to miss

**ADR-007's purge deletes every periodic-era journal entry.** Verified in
`packages/db/src/cutover/classification.ts`: `journal_entries`, `journal_lines`, `expenses`,
`expense_payments`, `sales_days` and `trade_orders` are all class **PURGE**, replaced wholesale by
the 2027-01-01 opening entry. `items`, `item_pricing`, `store_item_sellability` and
`supplier_items` are class **KEEP** — configuration, not postings.

> **So a retro-fit migrates no data.** Every peso posted under the periodic shape during the
> Oct–Dec pilot is deleted on 1 January by a decision already taken (bible row 106: *"v2 may
> ALWAYS assume a zero starting point"*). The retro-fit is a **code** change against **zero**
> production rows.

That is unusual and it will not be true again. Six months from now the same change costs a
restatement.

### What it costs

| | |
|---|---|
| **Code** | Six modules' posting paths, their worked examples in `tests/worked-examples/fixtures.ts`, and the `POSTING-PATTERNS.md` entries the drift-guard test pins to them |
| **Sequencing** | ⚠️ **It cannot be done piecemeal.** Retro-fitting T-122 alone would debit `1310` for food with no stock ledger to relieve it — the P&L would show **no food cost at all** until consumption postings land. The switch is atomic with the stock ledger, or it is worse than what it replaces |
| **Scope** | The atomic unit is *"the valuation core"* — roughly T-160 – T-165 in the Phase 3 plan. It is the smallest thing that can be switched on |

### What it does NOT cost

- No data migration. No backfill. No `was_this_migrated` branch — the three things bible row 106
  exists to prevent.
- No second valued count. It rides the 31 December count already committed by row 109.

---

## 5. Option B — a dated cutover, periodic before, perpetual after

> ⛔ **NOT ADOPTED — §3.1.** Kept as the reasoning trail (§14's rule: a superseded recommendation is
> kept, not deleted). **Nothing in §5, §6's fallback or §7.2/§7.3 is live.** Read them as the
> alternatives that were weighed, never as instructions.

**What it means.** Both shapes stay in the code. Which one a posting takes is derived from the
entry's date against a boundary constant.

### It survives the objection that would normally kill it

Bible row 108 says *"the table is the mark — there is no per-row pilot flag"*, because a flag must
be set by every insert path that will ever exist and one miss contaminates the books. **A date
branch is not that.** The entry date is already on every entry, set by nobody specially, and the
branch is *derived* from it. Row 108's objection does not reach it, and a shallow reading that
rejects Option B on those grounds is rejecting it for the wrong reason.

### And the fork is shorter-lived than it looks

Bible row 103: **every period closes on the 15th of the following month.** Once the boundary month
closes, no new entry may be dated before it (invariant 7). The periodic branch is therefore
reachable for about **45 days** and is dead code after that — but it can never be deleted with
confidence, because deleting it is a change nobody can test against data that no longer exists.

### Where it is genuinely better than Option A

⭐ **One case, and it is real:** a supplier invoice for goods received in the periodic era, posted
after the boundary. Under a date branch it posts periodic — `Dr 5110` — which is correct, because
those goods were consumed under the periodic basis. Under a hard switch it posts perpetual —
`Dr 1310` for goods that no longer exist — overstating inventory and understating COGS until a
count sweeps the difference into `5400`.

**Under my recommendation this case cannot arise**, because the boundary is a fiscal-year boundary
with a purge behind it: there is no pre-boundary period in v2 to post into at all. Under any
*other* boundary date, it arises on day one and Option B is the honest answer to it.

### What it costs

| | |
|---|---|
| **`POSTING-PATTERNS.md`** | Two live shapes per stock-touching event, each labelled with its era. It already does this for `commissary_dispatch` and the file says plainly why: *"so the next reader is not left choosing between a documented pattern and a working one."* Doing it for every event is that cost, ×8 |
| **⛔ A second valued count** | The boundary's opening `1310` must equal real on-hand **at that instant**. Nothing tracked stock between 1 January and the boundary, so the 31 December count is stale by then. **Four stores count again** |
| **⛔ Reports that span the boundary** | A quarter containing the switch reports gross margin on two bases with nothing on the face of the statement saying where the join is. This is the exact defect ADR-009 flagged for year-on-year comparison and it would now be *inside* one year |
| **Testing** | The invariant suite runs twice, once per era, forever |

---

## 6. Why retro-fit, and why the boundary is 2027-01-01

**The two options are not alternatives at the level Ian's question implies. Both are needed, and
choosing the right date makes one of them free.**

- The **code** needs one shape. Two shapes in the posting engine is a permanent tax on a system
  whose entire thesis (§16.7's closing note) is that *a rule maintained by remembering is a rule
  that drifts.*
- The **books** need a boundary. A change in accounting basis is a real event with a date, and
  pretending otherwise is how a gross-margin series becomes uncomparable without anyone noticing.

⭐ **Set the boundary at 2027-01-01 and both are satisfied at once**, because everything on the
periodic side of that date is deleted:

| | |
|---|---|
| It is a **fiscal-year** boundary | The cleanest possible place to change an accounting basis |
| It is a **period** boundary | Row 103's close rule means nothing may be posted before it once January closes |
| A **valued count already exists** for it | Row 109 committed the business to 31 December. No second count |
| The **opening entry already carries inventory** | `opening_counts` (quantity × unit cost, per store per item) feeds T-134's C3 step today |
| **Nothing survives behind it** | ADR-007's purge. The periodic branch would have zero rows to serve |

> **So the honest answer to the question as asked is: retro-fit — and the cutover date turns out
> to be a no-op, because the purge has already performed it.**

### ⚠️ The one thing that has to change, and it is Ian's call

ADR-005 lists **Inventory (Phase 3)** under *"Explicitly NOT in scope for 1 January"*, crossing
over during Q1 behind feature flags.

**The recommendation requires Phase 3's valuation core to land before 31 December.** Not all of
Phase 3 — and that distinction is what makes this credible rather than wishful:

| | Must land before 31 Dec | May follow in Q1 behind flags |
|---|---|---|
| **What** | Stock ledger · FIFO layers · receipt posts value (`2120` GRNI) · consumption / wastage / count postings · the switch itself | Deliveries UI · transfers · counts UI · **the whole commissary ↔ branch pipeline** · production · POS usage pull · channel wastage |
| **Why** | It is the **posting shape**. It cannot arrive mid-year without a second count and a two-basis quarter | They are **operational surfaces**. They feed an already-perpetual spine and change no posting shape |
| **Size** | 6 task specs, one new subsystem, no UI | 13 task specs, most of the screens |

⭐ **The posting shape and the operational modules are separable, and that separation is the whole
recommendation.** The large, slow part of Phase 3 (24 commissary capabilities) genuinely can wait
for Q1. The small part cannot, because it decides what every peso means.

### If the core cannot land by 31 December — the fallback, stated now

Recommending something and having no answer when it slips is not a plan.

1. **The boundary moves to a MONTH boundary — 2027-04-01 or 2027-07-01. Never a deploy date.**
   A basis that changes when a release ships is a basis nobody can reconcile.
2. **Option B's date branch is then genuinely required**, for the late-invoice case in §5.
3. **A valued count is scheduled on the boundary date**, in all four stores, as a calendar
   commitment — the same class of commitment as 31 December, and the same failure mode if nobody
   books it (OPEN-DECISIONS item 9: *"the kind of thing discovered on 2 January, when it is
   unfixable"*).
4. ⭐ **A T-135 finding declares `1310` stale in the meantime** — `inventoryBasisIsPeriodic`,
   carrying the last count date. Because the worse half of the fallback is not the wrong number,
   it is a **frozen inventory asset that looks current**. v1 had no inventory asset at all, which
   was at least honest about it; a stale one is read as live by everyone who opens the balance
   sheet.

---

## 7. What it costs the January books — either way

The question asked for this explicitly. All three scenarios assume row 109 stands: the
2027-01-01 opening entry debits `1310`/`1320`/`1330` at counted value against `3900`.

### 7.1 ✅ ADOPTED — retro-fit, one shape (§3.1 removed the boundary from this row entirely)

| | |
|---|---|
| **The opening entry** | Unchanged in shape. **Changed in meaning:** `1310` becomes a live control account on 1 January instead of a number that will sit still |
| **January's P&L** | ⭐ **Gross margin is real from month one.** COGS is what was consumed, not what happened to be bought. §16.7 defect #5 (*"gross margin is wrong"*) closes at the cutover instead of a quarter later |
| **January's balance sheet** | Stock is an asset that moves. Invariant 6's inventory arm is checkable on 2 January |
| **The 15 February close** | Ties on one basis. No note, no caveat, no two-column comparison |
| **The cost** | ⚠️ **January's build scope grows by six task specs**, and they are on the critical path to a date that cannot move. If they slip, the 15 November go/no-go is the place that finds out — which is what it is for |
| **The risk** | ⛔ The valuation core competes with the unfinished parts of Phase 2 (T-121 is decided-but-unbuilt, DEF-053; T-130 spec-ready). **Phase 3 must not eat Phase 2** — a January with correct inventory and incomplete AP is worse than the reverse |

### 7.2 Retro-fit with a deploy-date switch — ⛔ the option I am arguing against

| | |
|---|---|
| **January's P&L** | Periodic. Purchase-basis COGS, distorted by bulk buys — the defect the project exists to fix, live in month one |
| **The switch** | Lands mid-quarter on whatever day the release goes out. **March is half one basis and half the other** |
| **The gate** | ⛔ **Fails on switch day.** `1310` holds December's count; nothing tracked stock since. The control account cannot equal on-hand valuation until an unscheduled count happens |
| **Late invoices** | A pre-switch delivery invoiced after the switch debits `1310` for goods already eaten — or is refused by the closed-period lock and lands in the wrong month |
| **Verdict** | It takes Option A's code simplicity and pays Option B's accounting price. **The worst of both** |

### 7.3 Dated split, boundary 2027-04-01

| | |
|---|---|
| **January's P&L** | Periodic, and *correctly and consistently so* — the same basis the opening entry was built for and the same basis v1 used all of 2026 |
| **January's balance sheet** | ⚠️ **A frozen `1310`.** Right on 1 January, drifting from 2 January, and nothing on the balance sheet says so. The T-135 finding is a mitigation, not a fix |
| **Q1 gross margin** | Purchase-basis for three months. Not wrong — *stated*, and stated in the quarter everyone is scrutinising the new system |
| **31 March** | ⛔ A second valued count in four stores, then a restatement of `1310` to counted value. The catch-up (goods bought and expensed in Q1 but still on hand) **credits Q1 COGS in March** — one explainable line, in the wrong month |
| **The cost** | Two shapes in the codebase and in `POSTING-PATTERNS.md`; the invariant suite doubled; a count nobody has scheduled |
| **The honest upside** | ⭐ **January's scope does not grow.** If Phase 2 is at risk, this is the option that protects the cutover — and protecting the cutover outranks having perpetual inventory in month one |

> **If Ian's answer is "protect January's scope," the right answer is 7.3, not 7.2.** They are not
> the same conservative choice, and 7.2 is the one that looks safer and is not.

---

## 8. Bible amendment — ✅ APPLIED 2026-08-29

Ian: *"3 corrections go amend bible, your 3 points are all valid."* **All four edits are now in
`PROJECT_BIBLE.md` (v3.0), and this section is the record of what changed and why.**

### 8.1 ✅ §16.11 contradicted row 110 — corrected

§16.11 read *"Valuation is **weighted average**, recomputed on receipt, held per item per
location."* **Bible row 110 (2026-08-24) chose FIFO** and ADR-009 built its whole design on layers;
§16.11 sat four sections from the decision that overrode it, and **§10's Phase 3 row carried the
same stale phrase**.

**Now:** both read **FIFO — cost layers, consumed oldest-first**, with the one surviving average
named explicitly (the 2027-01-01 opening layer, ADR-009's *"the basis changes exactly once, at the
boundary, by design"*). ⭐ **And the layer's grain is stated, because it was never written down
anywhere and T-167 depends on it:** layers are **per item per store**, movements are **per
location** — so a room-to-room transfer moves quantity and not cost.

§16.11 also gained the perpetual rule itself (row 165), the return rule (row 166), and a
correction of its own last line: the inventory tie is **invariant 6's inventory arm**, not
*"invariant 5"* as it said.

### 8.2 ✅ §10's Phase 3 row — split into valuation core and operational surface

**Now:** the *Delivers* cell names the **valuation core** (in ADR-005's January scope, because it
is the posting shape) and the **operational surface** (Q1, behind flags, posting into the
already-perpetual spine), points at `docs/plans/phase-3-inventory.md` and at this ADR, and adds
**customer returns** — which no phase owned before row 166.

*Gate to exit* is unchanged and becomes meetable for the first time.

### 8.3 ✅ ADR-005 — the January scope line

**Now:** the valuation core is an in-scope row in ADR-005's own table, and *"explicitly NOT in
scope"* reads **"inventory's operational surface (Phase 3 Waves 1–3)"** with its members listed.
⚠️ Both the scope growth and the *"if it competes, Phase 2 wins"* rule are recorded there, next to
the commitment rather than in a plan nobody reads at a checkpoint.

### 8.4 ✅ Two decision-log rows, not one

**Row 165** — inventory is perpetual from v2's first posting; the six shipped modules retro-fit;
no dated split. Recorded because **T-133 discovered the basis by accident, in production code,
while fixing something else** — and a basis nobody has written down is a basis that will be
discovered again the same way.

**Row 166** — a return is a credit in both directions. Not foreseen by this ADR at all: it arrived
with Ian's answer, closed `CAPABILITY-GAPS.md`'s standing *"Needs Ian"* on supplier returns, and
opened a capability (**customer returns**) that no phase had ever owned.

---

## 9. What this ADR deliberately does not decide

- ⛔ **FIFO vs weighted average.** Settled, row 110. This ADR is about *when* value posts, not how
  it is measured.
- ⛔ **Whether the opening inventory is counted or zero.** Settled, row 109 and OPEN-DECISIONS
  item 9. Both options above assume counted.
- ✅ ~~**Supplier returns' AP treatment.**~~ **ANSWERED the same day, outside this ADR's question**
  — bible row 166. A return is a **credit**: `1240 Advances to suppliers` when the receipt was
  invoiced, `2120` when it was not. And the customer side, which nothing had ever owned, is
  `2140 Customer store credits payable` or a refund. T-170 respecified; **T-179 added**.
- ⛔ **The franchise dispatch pattern.** ADR-008 §4 and bible row 111 own it. It becomes *more*
  urgent once inventory is real — a franchise dispatch relieves inventory and recognises revenue —
  but it is a second question and stacking it here would bury this one.

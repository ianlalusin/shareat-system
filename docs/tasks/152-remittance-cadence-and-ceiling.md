# T-152 — Remittance cadence and the un-remitted ceiling

> **Status:** ✅ **BUILT, 2026-08-29.** Spec written before implementation (bible §1.2a); §11
> records the four decisions taken while building and the two bugs only the browser found.
> **Requirements:** T-136 §4 — this is its design. Bible row **129** (decided 2026-08-25).
> **Completes:** T-143, whose §7 rule 5 shipped pooling and *explicitly* left the ceiling
> unenforced. **Depends on:** T-143 (built), T-135 findings layer (built 2026-08-28).
> **Assessment:** T-136 §9, 2026-08-29 — this is the one piece of T-136 that is decided,
> unblocked and unbuilt.

## 1. Why this task exists, in one paragraph

T-143 shipped **pooled remittance** — the capability that lets a store's cash sit across several
days before it is carried to the office. Its own §7 rule 5 says so plainly:

> *"Row 129's un-remitted **ceiling** still governs the cadence; this task surfaces the figure it
> watches (§3) but does not enforce the ceiling."*

⛔ **So the risk shipped and the guard did not.** That was an honest scope call at the time, not a
defect — but it leaves pooling unbounded: nothing today notices a store sitting on cash, and
nothing says how long it may sit. Bible row 129 settled the mechanism on 2026-08-25 and
deliberately left the peso numbers to Ian. This task builds the mechanism.

## 2. ⭐ The configuration, built so it cannot express the wrong answer

Two columns on `stores`, both governed by one check constraint:

| Column | |
|---|---|
| `remittance_cadence` | `text` **NOT NULL DEFAULT `'daily'`**, `CHECK IN ('daily','every_3_days','weekly','monthly')` |
| `unremitted_ceiling` | `numeric(14,2)`, nullable **only when the cadence is `daily`** |

```sql
CHECK (remittance_cadence = 'daily' OR unremitted_ceiling IS NOT NULL)
```

⭐ **You cannot opt into pooling without naming a ceiling.** Row 129's warning is that a long
cadence and an unbounded amount is the dangerous *combination* — *"₱200/day versus ₱20,000/day is
the same number of days and a completely different amount sitting in a drawer."* The constraint
makes that combination **unrepresentable** rather than merely discouraged. Same instinct as
T-136 §6's closed cadence list: *if a setting can be set to something unsafe, eventually it will
be, and nobody will notice.*

### Why columns on `stores`, and not a `store_cash_policies` table

Row 129: ⚠️ *"a store with none configured must not silently mean 'never'. **Default to daily**,
the safe end."* A `NOT NULL DEFAULT 'daily'` column on the row **every store already has** makes
"unset" impossible by construction. A separate table reintroduces exactly the hole the row warns
about — as a **missing row** instead of a null column, which is harder to see, not easier.

⚠️ **This is a deliberate reversal of the instinct to group related settings.** The grouping is
worth less than the guarantee. When the imprest amount and the service-charge cadence arrive
(T-136 §2, §6), they follow the same rule for the same reason.

### On offering `monthly`

Ian's brief asked for *"3 days' sales in one remittance, weekly remittance, or monthly."*
T-136 §1 argued hard against a monthly cadence — but read it precisely: it argued against
**patterning the cadence on the period close**, whose 15-day grace yields *"up to 45 days of cash
in a drawer."* A clean monthly cycle is 30 days, and with a **mandatory** ceiling beside it the
exposure is bounded by amount rather than by days, which row 129 says is the risk that actually
matters. So `monthly` is offered, and it is offered *only* because §2's constraint makes a ceiling
compulsory the moment a store leaves `daily`.

## 3. The un-remitted position — derived, never stored

Per store, as **one figure** (see the correction below):

```
position = Σ (what each day is owed)  −  Σ (what remittances have settled against it)
```

Both halves already exist: T-143 computes what a day is owed (its §3) and what has settled against
it (its allocations). This task adds no new arithmetic — it **reads T-143's** and compares it to a
number.

⛔ **No stored balance, no cached position.** Rows 143, 145 and 147 each refuse this independently,
and row 146 records what a cached derived value costs: v1 shipped an admin *"recompute remittance
status"* button for days stuck on `partially_remitted`, which is a derived status that was being
stored somewhere.

### ⛔ CORRECTED before implementation — the position is ONE figure, not two tracks

An earlier draft of this spec said *"cash and online are separate tracks (row 144), so the ceiling
is evaluated per track."* **That was wrong, and reading T-143 at source caught it.**

Bible row 144 (2026-08-26) did split cash and online. **Row 157 (2026-08-27) superseded it**, on
Ian's *"it must be END DAY REPORT, not sales report… the composition of all money movement of the
day."* T-143 §3 states the consequence directly:

> ⭐ *"So rows 144 and 145 turn out to be **one figure**, one totalled and one per date."*

And the schema is built that way: `remittance_allocations` is keyed `(remittance_id, business_date)`
with a single `amount` and **no track column**, while `endDayReports` sums every cashier-custodian
`11xx` account into one `movement`. The two tracks survive where they are still real — in
`remittance_lines`, which records *how the money moved*, wallet to wallet or cash to cash.

⚠️ **So the ceiling watches one number per store.** Evaluating per track would have required
inventing a split the ledger no longer carries, and would have made this task's arithmetic disagree
with T-143's — the second source of truth this project refuses everywhere else.

⭐ **The lesson is the project's own:** a bible row is not automatically current. Row 144 was
correct when written and was overtaken the next day; only the task that shipped knows which won.

## 4. ⭐ Two detectors in T-135's existing layer — not new machinery

T-136 §7.6 said this flag *"must not wait for T-135, because T-135 is on ADR-005's can-wait-past-
January list and cash sitting unremitted is not."*

**T-135 shipped on 2026-08-28.** That constraint is gone, and the cheap answer is now also the
correct one: the findings layer already derives on every read, already ages, already refuses to let
a finding be resolved while it is still true, and already has an acknowledgement table. Building a
parallel mechanism beside it would be the second source of truth this project refuses everywhere
else.

Two functions in `packages/db/src/repo/findings.ts`, returning `DetectedFinding[]`, added to the
`detected` array in `listFindings`:

| `kind` | Fires when |
|---|---|
| `unremittedCeilingBreached` | A store's un-remitted position exceeds its `unremitted_ceiling` |
| `remittanceOverdue` | The **oldest** unsettled verified day is older than the store's cadence allows |
| `serviceChargeFloatAgeing` | `2160`'s oldest **un-cleared** accrual is older than **16 days** (see §4a) |

### 4a. ⭐ The third detector — added 2026-08-29 on Ian's answer, and it is a deliberate scope change

Ian, asked whether any store charges a service charge: ***"for now no we dont charge but im
planning."***

⛔ **That is the answer that needs a guard.** `2160` is credited by every sales day carrying a
service charge and **nothing in the tree ever debits it** (DEF-082). Today the balance is zero, so
it looks healthy. The day a store first enables a service charge in POS, it begins accruing, RA
11360's sixteen-day clock starts, and **the only symptom is a liability growing — which looks
exactly like a normal balance sheet.** Nobody would connect a POS settings change to an
unclearable obligation in the ERP weeks later.

**What is NOT being built here: the distribution document.** There is no demand for it — building
a document for something nobody does yet is the failure T-136 §9's whole assessment exists to
prevent. **T-136 §6 still owns it.**

**What IS being built: the alarm**, because this task is already adding detectors to this exact
file, so the marginal cost is a few lines and one test.

⚠️ **It will fire permanently once service charge is switched on**, since nothing can discharge
`2160` until §6 exists. ⭐ **That permanence is the feature.** T-135's rule is that a finding
cannot be resolved while it is still true, and *"we are accruing an obligation we have no way to
pay"* is true until §6 is built. The alarm turns a silent trap into a standing demand.

**Ageing is FIFO, not "oldest line".** Walk the `2160` credits oldest-first and offset them by the
total of its debits; the first credit not fully covered is the oldest un-cleared accrual. With no
debits that reduces to the oldest credit — but it stays correct the day §6 starts posting them,
rather than needing a rewrite.

⭐ **Both carry age as well as amount** (row 147: *"₱200 outstanding for 40 days is a worse finding
than ₱9,000 since yesterday"*), and both name the store, because the person who can clear it is at
one store.

## 5. ⛔ It never blocks

Row 129, verbatim: ⚠️ *"'Forces' means what it means everywhere else here: the pile becomes visible
and unignorable to the person who can clear it, **never a blocked till**."*

**No write path gains a guard in this task.** A cashier is never stopped from selling, a sales day
is never stopped from being verified, and a remittance is never refused because an earlier one is
outstanding — T-143 §7 already settled that last one and this task does not revisit it. The entire
output of this task is *visibility*.

## 6. Where it is edited

⚠️ **v2 has no store-administration screen at all** — `apps/erp/src/app/` has no `stores` route, and
stores today arrive through the seed and the cutover. Rather than grow one here, the cadence and
ceiling are edited on the **`/remittance` screen**, as a per-store policy panel beside the position
it governs. That is where the person who carries the risk already looks.

⛔ **A general store-settings screen is a real and separate gap**, logged rather than absorbed into
this task — see `docs/CAPABILITY-GAPS.md` (2026-08-29).

### 6a. ⛔ DEF-084 — found while wiring this: there was no findings screen at all

Building §4's detectors meant finding where findings are displayed. **They are not.** `listFindings`
is exported from `@shareat/domain` and, before this task, **had no caller anywhere in
`apps/erp/src`** — a repo-wide search for *finding* in the app returned one hit, and it was a code
comment.

⚠️ **So T-135's watchdog was invisible**, which is the failure it was built to prevent, one level
up. Row 147: *"visible in the sense that it was rendered, invisible in the sense that no one acted
on it."* A finding nobody can render is further from watched than that.

**This task surfaces its own three kinds** on `/remittance`. ⛔ **The other seven remain
unrendered, and four of them are `hard`** — meaning they block a period close from a screen that
does not exist. **A `/findings` page belongs to T-135**, and absorbing it here would be exactly the
scope-discovered-mid-build this project refuses.

## 7. Files this task may touch

| File | |
|---|---|
| `packages/db/migrations/0060_t152_remittance_cadence_and_ceiling.sql` | New, hand-written (DEF-073: `db:generate` cannot be used) |
| `packages/db/schema/stores.ts` | The two columns and the check |
| `packages/db/src/repo/findings.ts` | The two detectors |
| `packages/db/src/repo/remittance.ts` | The per-store position, if T-143's is not directly reusable |
| `packages/domain/src/findings/index.ts` | Two lines in `listFindings` |
| `apps/erp/src/app/remittance/` | The policy panel and the two findings on screen |
| `packages/domain/tests/integration/` · `tests/unit/` | Below |

## 8. Rules

1. The ceiling and the cadence are **per store**, never a constant (row 129).
2. An unset cadence is impossible: `NOT NULL DEFAULT 'daily'`.
3. Leaving `daily` requires a ceiling — enforced by the database, not the service layer
   (bible §6.3: *the database enforces the rules*).
4. The position is **derived on read**. No column anywhere holds it.
5. Cash and online are evaluated separately and reported separately.
6. ⛔ Nothing blocks. No new guard on any write path.
7. Changing a store's cadence or ceiling is an **audited** change — it moves money policy, and
   row 129 says it belongs to whoever carries the risk.

## 9. Done when

- [x] Migration applied; the check constraint proved by a failing insert (cadence `weekly`, ceiling
      `NULL`) inside a rolled-back transaction — **proved, not reasoned**, per DEF-079's lesson.
- [x] The `serviceChargeFloatAgeing` detector (§4a), with tests proving it is **silent on a zero
      float**, fires once an accrual passes sixteen days, and ages FIFO rather than by oldest line.
- [x] All three detectors, with integration tests against real Postgres covering: under the ceiling
      (silent), over it (fires), an overdue cadence, a store on `daily` with no ceiling (never
      fires a ceiling breach), and ⭐ a **zero-owed** day that must not sit outstanding forever
      (row 146's sharper warning: settled means *nothing outstanding*, not *a transfer arrived*).
- [x] A ceiling breach and an overdue cadence both visible on `/remittance`, with age and amount.
- [x] Acknowledgement and ageing inherited from T-135 and proved by a test, including that an
      acknowledged breach still counts and re-fires while it is still true.
- [ ] typecheck · unit · integration against real Postgres · smoketested on 9008 · `npm run build`
      with the dev server stopped · self-reviewed line by line.
- [ ] Bible row 129 marked built; `docs/ROADMAP.html` updated.

## 10. Deliberately NOT in scope

| Out | Why |
|---|---|
| **The imprest store fund** (T-136 §2) | Assessed 2026-08-29 and **recommended against as designed**, pending Ian resolving what he meant by *"allot a store budget"*. T-136 §9 |
| **The service-charge DISTRIBUTION document** (T-136 §6) | Ian, 2026-08-29: *"for now no we dont charge but im planning."* No demand yet, so the document is not built — ⭐ but its **alarm** is (§4a), because the trap fires silently the day the switch is flipped. T-136 §6 still owns the document |
| **The retained-float question** (T-136 §8.4) | One line either way, but it changes what *expected* means. It belongs with the peso numbers, which are Ian's |
| **The peso ceilings themselves** | Business policy. Row 129 settled the mechanism and deliberately did not pick the numbers |
| **A store-administration screen** | Real, separate, and logged (§6). Absorbing it here would be scope discovered mid-build |

---

## 11. Built — the decisions taken, and what only looking caught

### 11.1 ⛔ The position counts POSITIVE days only, and a green test suite said otherwise

The first implementation summed raw `owed` across every date. All 26 tests passed. The screen then
said:

> *"Lipa has cash outstanding from 2026-08-07, 22 day(s) ago… **₱-21450.00 is un-remitted**."*

**The alarm was right and the figure was nonsense.** Lipa had ₱9,400 sitting from three weeks
earlier — genuinely outstanding — while two later days had paid *more out of* the till than came
in (−₱35,000, −₱4,200). Netting them produced a negative "outstanding".

⭐ **The fix is not arithmetic taste; it is agreeing with the module this task extends.**
`remittanceStateOf` already rules that a net-outflow day owes nothing — *"the office is out of
pocket, not the till"* — and the screen's own **"Ready to remit"** sums positives only. Summing raw
`owed` made T-152 disagree with T-143 about the same pesos, which is the second-source-of-truth
this project refuses. Now `filter (where owed > 0.005)`, and the detector's *"₱3,950.00 can be
remitted now"* matches the table's *"Ready to remit: ₱3,950.00"* exactly.

⚠️ **No test could have caught this**, and that is the lesson worth keeping: every assertion was
about whether the finding *fired*, and it fired correctly the whole time. The defect was in a
number nobody had asserted on. **Only rendering it in a browser showed it.**

### 11.2 ⛔ `₱-21,450.00` — the sign in the wrong place, in a file written to prevent exactly that

The same screenshot exposed a second bug. The detail strings interpolated `₱${n.toFixed(2)}`,
which renders a negative as **`₱-21,450.00`** — symbol first, sign second.

`apps/erp/src/lib/format.ts` exists *because five screens each grew that same broken copy*, and
its header says so. **Every detector in `findings.ts` had it too** — five pre-existing ones
included, so a negative trial-balance drift would have printed the same way.

All eleven sites now use `@shareat/core`'s `formatMoney`, one formatter rather than a fourth copy
of the `Intl` options. ⭐ **Fixed beyond this task's scope on purpose** — it was a one-line change
in a file already open, and leaving five known-broken siblings beside a fixed one is worse than
either.

### 11.3 The severity is `soft`, including the statutory one

`hard` blocks a period close and an acknowledgement does not lift it. With no distribution document
in existence, a `hard` service-charge finding would block **every** close, permanently, with no
legitimate remedy — and a control nobody can satisfy is one people route around.

⭐ **Severity here tracks *"do the books add up"*, not *"is this serious"*.** Every `hard` detector
is a ledger that does not tie. This one's ledger is **correct**: the liability is recorded exactly
as it should be, and what is overdue is the *payment* — a business fact the books are reporting
faithfully.

### 11.4 `manage_store_settings`, not `accept_remittance`

Accepting a handover is an operational act a supervisor does daily; deciding how much cash may sit
in a drawer is the policy that governs it. One capability for both would let whoever accepts
remittances raise the ceiling they are measured against. The capability already existed
(manager and above, staff denied) so no matrix change was needed — and there is a test proving the
staff denial fires.

### 11.5 ⭐ The constraint's message is translated, and that is not a second rule

The database refuses pooling-without-a-ceiling, and the raw error reached the screen as
*"new row for relation "stores" violates check constraint "stores_pooling_requires_ceiling_check""*
— honest, and useless to a manager.

The screen now maps **the constraint name the database reported** to plain language: *"Pooling cash
needs a ceiling. Set the most that may sit un-remitted, or choose Daily."*

⚠️ **The distinction is easy to get wrong and worth stating: deciding stays in the database; only
the wording is ours.** Re-checking the condition in TypeScript would be the drifting second copy.
If the constraint is ever renamed the mapping stops matching and the raw text shows through —
visibly wrong rather than silently stale.

## 12. Gates

- typecheck **0** · build **0**, run with the dev server stopped and the server restarted after
- unit **611/611**
- integration **1189/1189** (40/40 files); `findings` 26/26 and `remittance` 12/12, of which
  **16 are new**
- ⭐ The firing tests were **proved to fail** with the detectors disabled, then restored — a test
  that only ever passed proves nothing (§9, bible §3.2)
- The check constraints proved against real Postgres by five probe inserts in a rolled-back
  transaction, each refused **by name**
- Driven end to end in a browser at 9008: the finding panel, the policy form, the database refusal
  with its translated message, and the saved policy raising **both** findings

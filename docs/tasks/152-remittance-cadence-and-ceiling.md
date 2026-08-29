# T-152 — Remittance cadence and the un-remitted ceiling

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
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

Per store, and **per track**:

```
position = Σ (what each verified day is owed)  −  Σ (what remittances have settled against it)
```

Both halves already exist: T-143 computes what a day is owed (its §3) and what has settled against
it (its allocations). This task adds no new arithmetic — it **reads T-143's** and compares it to a
number.

⛔ **No stored balance, no cached position.** Rows 143, 145 and 147 each refuse this independently,
and row 146 records what a cached derived value costs: v1 shipped an admin *"recompute remittance
status"* button for days stuck on `partially_remitted`, which is a derived status that was being
stored somewhere.

⚠️ **Cash and online are separate tracks** (row 144). A store may be perfectly current on online
transfers and a week behind on physical cash, and one number would hide it — the same reason T-143
allocates the two independently. **The ceiling is a cash-custody control**, so it is evaluated per
track and breaches are reported per track.

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
| `unremittedCeilingBreached` | A store's un-remitted position on either track exceeds its `unremitted_ceiling` |
| `remittanceOverdue` | The **oldest** unsettled verified day is older than the store's cadence allows |

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
this task — see T-136 §9's findings list.

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

- [ ] Migration applied; the check constraint proved by a failing insert (cadence `weekly`, ceiling
      `NULL`) inside a rolled-back transaction — **proved, not reasoned**, per DEF-079's lesson.
- [ ] Both detectors, with integration tests against real Postgres covering: under the ceiling
      (silent), over it (fires, per track), an overdue cadence, a store on `daily` with no ceiling
      (never fires a ceiling breach), and ⭐ a **zero-expected** day that must not sit outstanding
      forever (row 146's sharper warning).
- [ ] A ceiling breach and an overdue cadence both visible on `/remittance`, with age and amount.
- [ ] Acknowledgement and ageing inherited from T-135 and proved by a test, including that an
      acknowledged breach still counts and re-fires while it is still true.
- [ ] typecheck · unit · integration against real Postgres · smoketested on 9008 · `npm run build`
      with the dev server stopped · self-reviewed line by line.
- [ ] Bible row 129 marked built; `docs/ROADMAP.html` updated.

## 10. Deliberately NOT in scope

| Out | Why |
|---|---|
| **The imprest store fund** (T-136 §2) | Assessed 2026-08-29 and **recommended against as designed**, pending Ian resolving what he meant by *"allot a store budget"*. T-136 §9 |
| **Service-charge distribution** (T-136 §6) | Blocked on one live-data question — whether any store actually charges a service charge. T-136 §9. ⛔ If the answer is yes it outranks this task |
| **The retained-float question** (T-136 §8.4) | One line either way, but it changes what *expected* means. It belongs with the peso numbers, which are Ian's |
| **The peso ceilings themselves** | Business policy. Row 129 settled the mechanism and deliberately did not pick the numbers |
| **A store-administration screen** | Real, separate, and logged (§6). Absorbing it here would be scope discovered mid-build |

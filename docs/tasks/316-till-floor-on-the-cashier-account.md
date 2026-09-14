# T-316 — the maintaining balance moves onto the cashier's own drawer

> ### **Status: SPEC APPROVED 2026-09-14 by `system32-85`. NOT BUILT.** Written by lane C
> (`webapps-f7`, Opus 5); lane B builds it. No code, no migration file, no register edit yet.
>
> ⛔ **BLOCKED ON ONE PRECONDITION AND ONE OPERATIONAL ANSWER, both Ian’s** — §5 and §3.4.
> The precondition is the live `1115` balance query, and **the orchestrator cannot run it**: its
> `DATABASE_URL` points at `shareat_dev` and SSH to the droplet is blocked for agents, so Ian runs
> it. **Any non-zero balance stops this task** — moving a live balance between accounts is a
> posting with a pattern and a date, not a schema change.
>
> ⭐ **Three findings here are load-bearing and none was in the original assessment**, which had
> concluded *one migration plus zero new code*:
> **(1)** the migration ALONE would flip every cashier draw from *warn* to *blocked at zero*, because
> `judgeDraw` branches on `floatTarget !== null` on the premise that a float balance is complete —
> true of `1115`, **false of the takings drawer** — so the 2pm-buying-ice case Ian described is the
> case it would refuse;
> **(2)** `tillFloatOffTarget` would fire on **every normal day at every store**, because drift on
> `1110` is ordinary trading rather than the float being spent;
> **(3)** the first draft of the refusal **double-counted**, subtracting both the owed figure and the
> handover when they are the same money. The wrong arithmetic is left visible above the right one on
> purpose.
>
> ⭐ **So the architecture is ONE function, not two:** `tillFloorPosition` serves both the refusal
> and the repaired detector — Phase 6’s invariant applied properly, since two callers of one query
> cannot drift. ⛔ Its fields must not be collapsed into one expression; the refusal and the
> detector use different ones.
>
> ⚠️ **Option C (cap the handover at `owed`) is recorded as REJECTED with its reason**, not quietly
> dropped: with nothing verified `owed` is zero, and a cap of zero refuses the whole remittance —
> option A’s failure by another route.
>
> **Ian, verbatim:** *"attach the till budget to cash cashier account as maintaining balance so when
> there is no sales yet and cashier has to spend something it can draw from there replenish when
> sales comes and check when closing if maintaining balance still complete i guess this mirror the
> operations better."*
>
> ⭐ **He is right, and T-136 §9.3 reached the same conclusion in August** — *"the till already
> functions as the revolving fund"* — recommended against the imprest design on those grounds, and
> left the question open because only Ian could answer it. **He has now answered it independently,
> from operations rather than from the document.** Two readings arriving at one boundary from
> opposite directions is the strongest evidence available that the boundary is real.
>
> ⛔ **This is DESIGNED, not ported.** v1 has no minimum-balance concept anywhere — its
> `openingFloat` is a starting input to an arithmetic expectation, never a floor that alarms on
> breach. RULES §1.2d: v1 is authoritative about WHAT, never about HOW, and here it has no HOW to
> offer.

---

# 1. WHAT THIS ACTUALLY COSTS — three sites, and two of them were not on the list

Lane B measured that the mechanism is already generic: the one-float-per-store index keys on store
rather than GL code, the remittance refusal reads `floatTarget`, and `tillFloatOffTarget` keys on
`float_target is not null`. **All true.** ⛔ **And "generic" is exactly what makes two of them go
quietly wrong**, because each carries an unstated premise that was true only while the float lived
on its own account.

> ⭐ **The premise, stated once, because all three failures are the same one:**
> `1115` moves **only by transfer**, so its ledger balance is COMPLETE and equal to the float.
> `1110` is the takings drawer: sales post at **verify**, so its ledger balance is **provisional**,
> and it legitimately holds float **plus** takings. **Merging the two accounts merges two facts
> that three pieces of code still treat as one.**

## 1.1 ⛔ `judgeDraw` — the migration alone refuses the case Ian is asking for

`packages/domain/src/money-accounts/draw-verdict.ts:69` branches on `floatTarget !== null`
**before** the cashier branch at `:80`, and blocks at zero. Its own stated reason, `:61-68`:

> *"The warn-vs-block split is NOT really about the custodian — it is about **whether the ledger can
> see the whole balance**. A takings drawer holds today's sales hours before they post at verify, so
> its ledger balance is provisional. **A float pot's is complete**."*

**True of `1115`. False of `1110`.** So migration `0151` **on its own, with no other change**, flips
every cashier draw from *"warn, allowed down to −`overdraftLimit`"* to *"blocked at zero"* — and
`overdraft.ts`'s header names the consequence in advance:

> *"A drawer that reads ₱0 at 2pm may hold ₱40,000. Refusing an outflow there would refuse a
> shortfall that is not real — and the surest way to make people work around a system is to have it
> deny things they can see with their own eyes."*

⛔ **The cashier at 2pm buying ice — the entire motivating case — is the case the migration alone
would refuse.** ⚠️ A grep for `'1115'` cannot find this: the coupling is semantic.

**Fix, in this task:** `judgeDraw` must key on *"is this balance complete"*, not on *"does this
account carry a target"*. Those were the same question only while the float had its own account.
**Recommended shape:** block-at-zero applies when `custodian !== 'cashier'` **or** the account is a
float pot that is **not** the takings drawer. Since after this task there is no such thing — the
float IS the takings drawer — the honest form is that the float branch **is deleted** and
`custodian === 'cashier'` governs, with the floor enforced at the document (§2) rather than at the
value. ⚠️ Lane B must confirm no other `floatTarget`-bearing shape survives; `money_accounts_float_target_shape_check` after `0151` is what decides that.

## 1.2 ⛔ `tillFloatOffTarget` becomes noise — and it is the "check when closing" Ian asked for

`packages/db/src/repo/findings.ts:504-534` compares the account's **ledger balance** against
`float_target` and reports any drift over half a centavo.

Today that is exactly right: `1115` only moves by transfer, so drift **is** the float being spent.
⛔ **On `1110` drift is ordinary trading.** Between verify and remittance the drawer legitimately
holds float **plus** the day's posted takings — ₱20,000 float and ₱40,000 takings reads as ₱40,000
"over target", every day, at every store. **A detector that fires on every normal day is worse than
no detector**, and `till-shifts.ts:32`'s three-variance table would gain a fourth meaning nobody
asked for.

**Fix, in this task:** the detector must compare **what is in the drawer that is not owed to a
day** against the target — which is the same figure the refusal needs. §2 makes them one query.

## 1.3 ✅ The one that genuinely is fine

The remittance EXPECTED figure. `endDayReports` (`packages/db/src/repo/remittance.ts:81`) excludes
`je.source_type <> 'transfer'`, so establishing or replenishing a floor **by transfer** is already
outside what a day owes. Proven by `packages/domain/tests/integration/remittance.test.ts`, whose own
comment records that those tests were written for **the model Ian has just re-proposed** and kept
because the property is real. ⭐ Nothing to do, and worth stating so nobody "fixes" it.

Both shortage paths are likewise unaffected — the ledger-drift alarm and T-186's counted-short
charge to `1230` are different comparisons and neither is written against the literal account code.

---

# 2. THE DESIGN — one derived figure, two callers, and that is the whole architecture

**Ruled by `system32-85`, 2026-09-14: operand B.** The refusal measures the drawer as the ledger
sees it **plus** the day's declared-but-unposted cash. ⛔ **Rejected: A** (ledger alone — refuses a
physically correct handover whenever unverified takings are in the drawer) and **C** (cap the
handover at `owed` — which is A in disguise: with nothing verified `owed` is **zero**, so the cap
refuses the entire remittance).

## 2.1 ⚠️ What B needs, and where it is — the BLOCKED check, run

The ruling said to implement B by **calling the query `endDayReports` already uses, never by
re-deriving it**, and to report BLOCKED rather than duplicate the arithmetic. **Checked, and the
situation is better than the ruling assumed:**

- ⛔ **`endDayReports` cannot supply the figure and never could.** It sums `journal_lines` where
  `je.status <> 'draft'` — **posted** movement. An unverified day has posted nothing, so by
  construction the unposted takings are not in it. There is no shared helper underneath it either;
  it is one inline SQL statement in the repo.
- ✅ **The figure exists elsewhere, as a stored column, on a row that already exists.**
  `sales_days.cash_collected` (`packages/db/schema/sales-days.ts:231`, `numeric(14,2) NOT NULL
  DEFAULT '0'`) is present from the moment a day is created, across statuses
  `open → submitted → verified`.

> ⭐ **So B is NOT a second derivation of `endDayReports`, and the defect the ruling feared cannot
> arise here.** Posted cashier movement and declared-unposted cash are **two different facts from
> two different tables**. One query reads each. Nothing computes the same thing twice.
>
> **NOT BLOCKED.** `createRemittance` already holds `tx`, `actor.orgId` and `input.storeId`, so a
> repo call is reachable with no plumbing.

## 2.2 ⭐ ONE new repo function, and BOTH consumers call it

The refusal (§3) and the repaired detector (§1.2) need the *same* derived figure: **what the drawer
holds that is not owed to a sales day.** Deriving it twice is precisely the two-sources-of-truth
failure §1.2 is about, so it is derived once.

**Create `tillFloorPosition(tx, orgId, storeId)` in `packages/db/src/repo/remittance.ts`** — beside
`endDayReports`, because it is the same subject and a reader looking for one must find the other.

| Returns | From |
|---|---|
| `postedBalance` | the same `(gl code, store)` scoping `balanceOf` and `tillFloatOffTarget` already use |
| `declaredUnposted` | `sum(cash_collected)` over `sales_days` at this store with `status in ('open','submitted')` — never `verified` (already posted, double count) and never `voided` |
| `unremittedOwed` | the `owed` total `endDayReports` already computes, **by calling it** |
| `floatTarget` | the account's column |

**`drawerFree = postedBalance + declaredUnposted − unremittedOwed`** — what is in the drawer over
and above what the days are owed. **That is the maintaining balance**, and the question *"is it
still complete?"* is `drawerFree >= floatTarget`.

⚠️ **Two callers of one function cannot drift; two derivations can.** `tillFloatOffTarget` is
rewritten to compare `drawerFree` against the target instead of the raw balance, and the refusal in
§3 uses the same value. **If a third surface ever needs "what should be in the drawer", it calls
this.**

---

# 3. THE REFUSAL

## 3.1 ⛔ It is a rule about the DOCUMENT, not about every draw

**Ruled and confirmed.** Ian's sentence permits the draw the briefing's first framing would have
refused: *"when there is no sales yet and cashier has to spend something **it can draw from there**
replenish when sales comes."* ⭐ And T-153's author had already drawn the same line in code —
`packages/domain/src/remittance/index.ts:105-107`:

> *"A service-layer rule rather than a database one on purpose: **the money may legitimately leave
> this account** (an expense paid from the float, a transfer resizing it). **What is refused is this
> DOCUMENT moving it** — which is a question about the document, not about the value."*

**So an expense drawing the float down is the intended use, not the risk. A remittance carrying it
away is the risk, and it is the capability being lost** — `createRemittance:108`'s existing refusal
(*"a float is never remitted"*) cannot survive `1110` becoming a valid remittance source.

## 3.2 Where it goes, and why not the database

**`createRemittance`, `packages/domain/src/remittance/index.ts`**, replacing the `from.floatTarget
!== null` refusal at `:108` rather than sitting beside it.

⛔ **Not `checkDraw`/`judgeDraw`** — that is the *value* chokepoint, shared by six callers
(`approveExpense`, `createMoneyTransfer`, `recordPayment`, cash requests, reimbursement,
`payLiability`), and putting a document rule there would refuse the expense draws §3.1 establishes
as legitimate.

⚠️ **Not a CHECK or a trigger, and here is the test RULES §6 item 3 actually sets.** Its own ⚠️ note
scopes the database-enforces-it rule to **balance, period and immutability** — CHECK constraints and
triggers. This rule compares a **running balance plus a figure from another table** against a
column. A trigger doing that re-implements the ledger inside a trigger, which is the second source
of truth the rule exists to prevent. ⭐ **It is service-layer, and the thing that makes it
unbypassable is the single door**: remittance is the only document that moves cashier→office as a
settlement, and every one of its lines already posts through one path
(`index.ts:143` — *"The money moves through the ONE transfer path"*). **A rule at
`createRemittance` cannot be reached around by `createMoneyTransfer`, because a bare transfer is not
a remittance and settles nothing** — which is exactly the distinction §3.1 draws.

## 3.3 The arithmetic, and the one character that matters

For each line whose `from` account carries a non-null `floatTarget`:

```
drawerFree      = postedBalance + declaredUnposted − unremittedOwed     (§2.2)
drawerFreeAfter = drawerFree − <this remittance's total from that account>
REFUSE if        drawerFreeAfter < floatTarget
```

> ⭐ **`<`, never `<=`. Ruled 2026-09-14, and recorded as a ruling because the failure it prevents
> is invisible.** With `<=`, a ₱8,000 float sitting at exactly ₱8,000 makes the drawer **unusable
> for the purpose it exists for while every report says everything is fine** — no finding, no
> variance, no alarm, just a cashier who cannot remit. Exactly-at-target is the CORRECT resting
> state of a float, not a breach. Bible §13 row 204: record the ruling, never leave it to be
> re-derived.

**Worked, against the ruling's own numbers.** Float ₱20,000, posted ₱20,000, declared-unposted
₱8,000, owed ₱8,000:

| Remit | `drawerFreeAfter` | Verdict | Physically |
|---|---|---|---|
| ₱8,000 | 20,000 + 8,000 − 8,000 − 8,000 = **₱12,000**… | | |

⚠️ **Careful — that is wrong, and the trap is worth writing down.** `unremittedOwed` and the
remittance are the *same money*: subtracting both double-counts it. The handover settles the owed,
it does not come on top of it. **The correct form subtracts the remittance from the drawer, and
compares against the floor, with `owed` used only to establish that the money being handed over is
takings rather than float:**

```
drawerAfter = postedBalance + declaredUnposted − remittedFromThisAccount
REFUSE if     drawerAfter < floatTarget
```

| Float | Posted | Declared unposted | Remit | `drawerAfter` | Verdict |
|---|---|---|---|---|---|
| ₱20,000 | ₱20,000 | ₱8,000 | ₱8,000 | **₱20,000** | ✅ allowed — lands exactly on target, the `<` case |
| ₱20,000 | ₱20,000 | ₱8,000 | ₱12,000 | **₱16,000** | ⛔ refused — this is the task |
| ₱20,000 | ₱60,000 | ₱0 | ₱40,000 | **₱20,000** | ✅ allowed — ordinary verified-day close |

⛔ **`unremittedOwed` therefore does NOT belong in the refusal arithmetic**, and §2.2's
`drawerFree` is the **detector's** figure, not the refusal's. Both still come from one function;
they use different fields of it. **Lane B: do not "simplify" these into one expression.**

## 3.4 What it costs Ian's day — say it out loud

⭐ **B requires a DECLARATION, not a VERIFICATION.** The refusal reads `cash_collected` on `open`
and `submitted` days, so the cashier entering the day's cash is enough; a manager's verify is not
needed. ⚠️ **But if nobody has entered anything, `declaredUnposted` is ₱0 and B degenerates to A** —
a remittance of real cash is refused because the system has no evidence the cash exists. **That is
defensible and should be stated rather than discovered:** the ask is *"declare the day's takings
before handing them over"*, which is a cashier's own action on a screen that exists, not a manager's
sign-off. **If Ian's stores remit before anyone enters a figure at all, this becomes a real change
to their morning and he should be told.**

---

# 4. THE MIGRATION — `0151`, ONE FILE

**Index `0151` allocated by `system32-85`.** ⛔ Its `when` is **re-derived at build time** from
`packages/db/migrations/README.md` and ADR-012 §5 (`previous.when + 86_400_000 × (idx − previous.idx)`),
**never copied from this document or from any message** — DEF-039's failure mode is a migration
silently skipped for a `when` that sorts wrong, so the arithmetic must be confirmed by something
that executes. It must exceed **1798860707084** (`0148`, shipped in `94554a6`).

⚠️ **Two concerns, one file** — say so in the migration header:

1. **`money_accounts_float_target_shape_check`** (`packages/db/schema/money-accounts.ts:216-218`)
   currently reads `… and gl_account_code = '1115'`. It must permit `1110`. ⛔ **Decide and state
   whether it permits `1110` ONLY or `1110`-or-`1115`** — §5 says only.
2. ⚠️ **`money_accounts_one_float_per_store`** (`:214`) may or may not need touching — see §5. It is
   named here so the decision is taken rather than defaulted.

Per ADR-012 §5 step 3, `packages/db/schema/money-accounts.ts` is edited to match, and an applied
migration is never edited (RULES §1 rule 9).

---

# 5. ⛔ `1115` — A STRAIGHT REPLACE, AND THE PRECONDITION THAT DECIDES IT

⭐ **The choice is already made by an index nobody had named.**
`money_accounts_one_float_per_store` (`:214`) is keyed on **`storeId` alone**, `where float_target
is not null`. **So a store cannot carry a float on `1115` and `1110` at the same time — the database
refuses it.** *"Permit either during a transition"* is structurally impossible without also changing
that index, and changing it would break the property its own comment says it exists for
(*"two pots in one store would share one figure and the off-target detector would compare it against
two targets"*).

**It is a straight replace.** Which makes the following a **precondition, not diligence:**

> ⛔ **RUN THIS BEFORE ANYTHING IS BUILT. `system32-85` runs it; nobody assumes the answer.**
>
> ```sql
> SELECT ma.id, ma.org_id, ma.store_id, ma.name, ma.gl_account_code, ma.float_target,
>        COALESCE(SUM(jl.debit - jl.credit), 0) AS ledger_balance
> FROM money_accounts ma
> LEFT JOIN accounts a
>        ON a.org_id = ma.org_id AND a.code = ma.gl_account_code
> LEFT JOIN journal_lines jl
>        ON jl.account_id = a.id AND jl.store_id = ma.store_id
> LEFT JOIN journal_entries je
>        ON je.id = jl.entry_id AND je.status <> 'draft'
> WHERE ma.float_target IS NOT NULL
>    OR ma.gl_account_code = '1115'
> GROUP BY ma.id, ma.org_id, ma.store_id, ma.name, ma.gl_account_code, ma.float_target;
> ```
>
> | Result | What it changes |
> |---|---|
> | **No rows** | The replace is free. `0151` loosens the CHECK and nothing is migrated, because there is nothing to migrate |
> | **Rows with `ledger_balance = 0`** | Still free; retire them in the same migration with a reason |
> | ⛔ **Any row with a non-zero balance** | ⛔⛔ **STOP. This is a different task.** Moving a live balance between accounts is a posting, not a schema change — it needs a journal entry, a pattern from `docs/POSTING-PATTERNS.md`, and Ian's sign-off on the date it lands |

⚠️ Lane B believed there is *very likely* no live `1115` anywhere — nothing in `dev-seed`,
`provision-terminal` or `bootstrap-org` creates a float account, and T-153 §9 deliberately made it
hand-set on demand. ⛔ **It said "very likely", not "confirmed", and had no database access. Neither
do I.** The difference between those two is the whole of this section.

---

# 6. THE CLOSE-TIME CHECK — no new surface

Ian: *"check when closing if maintaining balance still complete."*

⭐ **Under his model there is ONE row to count instead of two**, which makes the close screen
simpler, not more complex. T-186's `closeTillShift` is where a physical count already happens, and
§1.2's repaired `tillFloatOffTarget` answers *"is the maintaining balance still complete"*
**continuously** rather than only at close — which is better than what was asked for.

⛔ **No new screen, no new table, no new finding kind.** The three-variance table at
`packages/db/schema/till-shifts.ts:32` keeps its three meanings; `tillFloatOffTarget` keeps its
`soft` severity and its existing sentence — *"this is NOT a counted shortage and must not be charged
to a cashier — it is money that was legitimately paid out and posted"* — which stays true and stays
the replenishment signal. **Only its operand changes** (§2.2).

---

# 7. TESTS — each shown red first

⭐ **The house method: put the OLD behaviour back and watch the right test fail.** Where a test
cannot be shown red by reverting (because the code did not exist), say so explicitly rather than
implying it was.

| # | Test | Red first by |
|---|---|---|
| 1 | ⛔ **A remittance that would take the drawer below the floor is REFUSED** | New behaviour — state that it fails only by being absent |
| 2 | ⭐ **Exactly-at-target is ALLOWED** — the `<` vs `<=` case (§3.3) | Flip `<` to `<=`; this test must fail and **no other** |
| 3 | ⛔ **A remittance of declared-but-unverified cash is allowed** — the ₱8,000 case | Drop `declaredUnposted` from the operand (= option A); this must fail |
| 4 | ⛔ **An expense CAN draw the float down** — §3.1, the motivating case | Put the refusal in `checkDraw` instead of `createRemittance`; this must fail |
| 5 | ⛔⛔ **A cashier draw at ₱0 ledger balance WARNS, it does not block** — §1.1 | **Apply `0151` without the `judgeDraw` change.** ⭐ This is the test that catches the silent regression, and it is the most important one in the file |
| 6 | **`tillFloatOffTarget` does not fire on an ordinary trading day** — §1.2 | Leave the detector on the raw balance; it fires, and this fails |
| 7 | ⭐ **The refusal cannot be reached around by `createMoneyTransfer`** | Required by the ruling: a bare cashier→office transfer is not a remittance and settles nothing, so it is governed by `checkDraw` alone. **Assert that explicitly**, so the seam is a decision and not an oversight |
| 8 | **One float per store still refused** — the index survives `0151` | |

⚠️ **Test 5 is the one to write first.** It is the only one that fails from the *migration* rather
than from the feature, and it is the one a reviewer reading a green suite would never think to ask
for.

---

# 8. OUT OF SCOPE

## 8.1 Two real defects found while specifying — `system32-85` writes the rows

⛔ **Both predate T-316, both are real without a float involved, and neither belongs inside it.**

- **DEF-357 — `createRemittance`'s `lines[].amount` is an unbounded human-entered figure**, neither
  computed from `owed` nor capped by it. Lane B found the existing float test survives only because
  its fixture happens to enter `8000.00` rather than the account's full `28000.00`. ⭐ **This is why
  option C looked airtight**, and fixing it is not the same as fixing the floor.
- **DEF-358 — a remittance recorded before any day is verified posts the money and records NO
  variance row.** With no verified days `allocateFifo` returns a positive `variance` with
  `varianceDayId` null (`allocate.ts:85-88`), and `index.ts`'s guard `if (Number(result.variance)
  !== 0 && result.varianceDayId)` skips the write while the remittance still posts. **The money
  moves and nothing is written down.** The sharper of the two.

## 8.2 ⚠️ The AP ceremony — for Ian, not for this task

T-130 makes every expense name a supplier and a **verified invoice, receipt photo included**. A
floor-funded purchase is a broom, a bag of ice, a ₱200 repair. ⛔ **Putting those through the same
ceremony as a supplier bill may be heavier than a petty-cash draw warrants** — and this task makes
that path more used, not less, because it is now the intended way to spend the maintaining balance.

⛔ **Do NOT change the AP rule, and do not design around it here.** **This needs Ian's decision, and
it is a different task.** Recorded because T-316 is what makes the friction routine.

## 8.3 Also out

Changing `overdraftLimit`'s meaning or its relationship to the floor — they bound different things
and the code's own comment calls the limit a warning · the two shortage paths (§1.3) · face of
`remittance_variances` · any change to what `owed` means.

---

# 9. ⚠️ WHAT I DID NOT VERIFY

- **Nothing was run.** No code, no migration, no query, no test. Reading only.
- ⛔ **Whether any live `1115` balance exists** — §5, and it is a precondition rather than an
  assumption for exactly that reason. I have no database access.
- **That `tillFloatOffTarget` will fire on ordinary trading days** is reasoned from the code
  (`findings.ts:504-534` compares the raw ledger balance; sales post to the cashier account at
  verify), **not observed.** It is test 6's job to prove it.
- **Whether Ian's stores enter `cash_collected` before remitting** (§3.4). The refusal's usability
  turns on it and I could not measure it.
- **Whether `1110` is the only account that will carry a `float_target` after `0151`.** §1.1's
  recommended deletion of the float branch in `judgeDraw` depends on it; lane B must confirm against
  the CHECK as written.

# 35 — Cash closing before verification (DEF-358)

**Date:** 2026-09-17
**Unblocks:** DEF-358 · DEF-357 · Ian's ruling (a cashier remitting before any day is verified is to
be **REFUSED**, not silently allowed)
**Method:** read v1 at source (`ERP-rebuild`, read-only, unmodified) · read v2 at source
(`packages/domain/src/remittance`, `apps/erp/src/app/remittance`) · queried `shareat_dev` directly
(local, read-only, via the `postgres` client already a dependency of `packages/db`) · cross-checked
existing discovery docs 13 and 26, and task docs 316 and 143, before re-deriving anything they had
already measured.

---

## 0. Verifying the mechanism I was handed, before building on it

The briefing quoted a chain — `settleable` → `allocateFifo` → the `varianceDayId` guard — as the
reason a pre-verification remittance posts money and writes no variance. **Confirmed at source,
exactly as stated:**

- `packages/domain/src/remittance/index.ts:125` — `settleable = reports.filter((r) => r.remittable
  && Number(r.owed) > 0)`. With no verified day, `settleable` is `[]`.
- `packages/domain/src/remittance/allocate.ts:64-89` — with `days` empty, the loop never runs,
  `lastTouched` stays `null`, and `varianceDayId: Number(variance) === 0 ? null : (lastTouched ??
  days.at(-1)?.salesDayId ?? null)` evaluates to `null` (both `lastTouched` and `days.at(-1)` are
  null/undefined). `variance` itself is `handedOver − 0`, i.e. the whole amount, non-zero.
- `packages/domain/src/remittance/index.ts:178` — `if (Number(result.variance) !== 0 &&
  result.varianceDayId)`. Non-zero variance, null `varianceDayId` → the condition is `false` → the
  `insertVariance` call is skipped.
- The money movement itself (`createMoneyTransfer`, lines 148-165) is **unconditional** and sits
  **above** the variance write — it always runs.

So the register's description is right: **the cash moves and nothing is written down.** And
`remittable` really does mean exactly "verified" — `packages/db/src/repo/remittance.ts:99`:
`(sd.status = 'verified') as remittable`, with the comment at `:41-42` saying so directly. No gap
between what the register claims and what the code does.

---

## 1. What v1 actually does

`ERP-rebuild` (read-only, read but not changed) has **no pooled remittance** — T-143's pooling
(many days, one handover, FIFO-allocated) is a v2 invention. v1 remits **one sales day at a time**
(`remitSalesReportAction`, `src/lib/actions/sales-report.actions.ts:39`), so the exact shape DEF-358
describes — a handover with **zero** verified days behind it — cannot arise the same way. v1 avoids
it with two separate mechanisms, neither of which is "refuse":

**(a) Auto-verify-inline.** `sales-report.actions.ts:95-109`: if the target day's status is `open`,
the remit action calls `verifySalesDayAction` itself, synchronously, before doing anything else. If
verification fails, the remit fails with it (`:102-104`). Only a `verified` (or `partially_remitted`)
day proceeds past that point (`:107-109` refuses anything else). **v1 never lets an unverified day's
cash move without first verifying it as part of the same request** — it doesn't refuse the person,
it does the missing step for them.

**(b) A shortage can't move with an unnamed cause.** `:178-194`: if the actual cash handed over is
short of what verification computed, `chargeToStaffId` is **required** — the action refuses outright
(`'Shortage detected — chargeToStaffId is required to charge a staff member.'`) rather than posting
the money and leaving an anonymous variance for later. v1's version of "don't let money move with
nothing written down" is *stricter* than either option DEF-358's register row offers v2: it never
produces an unattributed gap at all.

**(c) A day cannot go stale enough to make this common.** `submitSalesDayAction`,
`src/lib/actions/sales-day.actions.ts:343-356`: a non-admin cannot submit day *N+1* while day *N* is
still unverified — `queryOldestUnverifiedSalesDayBefore` blocks it, admin can override. This is the
**sequential-verification gate** discovery doc 13 already names (`docs/discovery/13-capabilities-financial.md:34`).
It doesn't prevent the single most-recent day from sitting unverified; it prevents a *backlog* of
them, which is what would turn an occasional gap into a routine one.

⭐ **v2 already ported (c).** `packages/domain/src/sales-days/create.ts:112,126-142` —
`findOldestUnverifiedBefore`, admin-bypassable, refuses to create a new day while an older one is
blocking. So the piece of v1's design that structurally limits how large this problem can get is
already here. What v2 has **not** ported is (a) and (b) — see §6.

---

## 2. The goal, not the mechanism

Not "verify before remit" as an end in itself. **The goal is: no cash changes hands, ever, without a
signed count behind it and a named cause for any gap.** v1 reaches that two ways — forcing the
missing count inline, and refusing to post a shortage to nobody — rather than by blocking the
handover outright. **Refusing the handover is a third way to reach the same goal, not v1's way**,
and it is the one Ian has now chosen for v2 (§4 explains why it's the cheap option here, unlike in
v1).

---

## 3. Counting the live data

**`shareat_dev` (local, queried directly, read-only): 0 rows in `remittances`, 0 in
`remittance_variances`, 0 in `money_transfers`. 2 `sales_days` rows, both `verified`.** This is a
thin dev seed, not ETL'd data — there is nothing in this database that could answer "how often does
this happen." Said plainly rather than estimated, per the brief.

**Production**, per standing rule, is not queryable from here (`DATABASE_URL` points at
`shareat_dev`, SSH is blocked for agents) — Ian would have to run this himself. **I did not
substitute a v1/Firestore number for a v2 one.** The closest adjacent fact already measured, from a
different system entirely: discovery doc 26 found the v1 sales-day lifecycle (`open → submitted →
verified → remitted`) "proven at scale: **348 real documents across 5 live stores**"
(`docs/discovery/26-reporting-dashboards-and-insights.md:80`). That says the *lifecycle* is real and
used; it says nothing about how often a remittance was attempted ahead of verification, because v1's
own auto-verify-inline (§1a) means that specific sequence never appears as a distinct event in v1's
data — it gets folded into an ordinary verify-then-remit before it can be observed. **There is no
data anywhere, v1 or v2, that measures the thing being asked about.**

---

## 4. What breaks if we refuse — tracing v2's own path

**Nothing, for the only real caller that exists today — and that is worth stating plainly rather
than assuming.** `apps/erp/src/app/remittance/page.tsx:295`:

```
{remittable.length > 0 && cashier.length > 0 && office.length > 0 && ( … the handover form … )}
```

`remittable` is filtered from the same `remittable: boolean` field `createRemittance` itself reads
(`endDayReports`, one repo function, one definition: `packages/db/src/repo/remittance.ts:99`). **The
screen already does not render the handover form at all when zero days are verified.** A cashier
cannot reach DEF-358's trigger condition through the one application that exists — not because
anyone designed a refusal, but because there is nothing to type an amount into.

⛔ **And that is exactly the shape RULES §1 rule 7 warns about: a client-side-only gate.** The
*screen* happens to prevent this today; `createRemittance` itself does not. Anyone else calling it —
a script, a test, a future POS integration, a raw form post to the server action — hits DEF-358
directly, with no server-side check standing in the way. **A domain-layer refusal in `createRemittance`
changes nothing about what today's one real screen allows. It closes the hole for every caller that
isn't that screen.** This is the cheapest possible refusal to ship: it cannot regress a UX that
doesn't currently permit the state being refused.

**The honest worst case, for a store closing at 11pm with nobody left to verify:** the cash still has
to go somewhere physically — a drawer, a safe — and that was already true; nothing about the *system*
refusing a `createRemittance` call changes what a cashier can do with the physical cash overnight. It
changes only whether the **system's record** of a cashier→office handover can be created before a
manager has signed a count. Today, per (a) above, v1 would have silently promoted the manager
who remits into also verifying; per the render gate, v2's own screen already refuses to let this
happen at all until someone verifies. **A formal refusal in the domain layer does not create a new
operational problem — it names, in the one place that currently lacks it, a rule the screen has been
enforcing by accident all along.**

---

## 5. DEF-357 — the refusal makes the cap *easier*, not harder

DEF-357 (`createRemittance`'s `lines[].amount` is uncapped) explicitly rejected capping at `owed`
alone: *"Do NOT cap at owed alone — with nothing verified, settleable is empty, owed is zero, and a
cap of zero refuses the entire remittance, which is a normal closing pattern"* (register, DEF-357).
**T-316 hit the identical shape independently, for a different check** (the till-floor overdraft
refusal), and rejected the same fix for the same reason: *"Option C (cap the handover at owed) is
recorded as REJECTED — with nothing verified owed is zero, and a cap of zero refuses the whole
remittance — option A's failure by another route"* (`docs/tasks/316-till-floor-on-the-cashier-account.md:29-31`).
Two different tasks, two different mechanisms, the same trap: **a cap keyed on `owed` is only safe
once `owed` can no longer legitimately be zero while cash is being handed over.**

**If DEF-358 is fixed by refusing the remittance outright whenever `settleable` is empty, `owed`
being zero-while-remitting stops being reachable at all** — whenever a remittance is actually allowed
to proceed, at least one verified day exists, so `owed > 0` by construction. DEF-357's rejected
"cap at owed" option, un-rejected: the degenerate zero case that made it unsafe no longer exists once
DEF-358 refuses first. **Take the two together, in this order — DEF-358's refusal first, DEF-357's
cap second — and the cap DEF-357 explicitly said not to write becomes the correct one to write.**

---

## 6. What this doc is NOT recommending, and why

- ⛔ **Not adopting v1's auto-verify-inline (§1a).** It would make `createRemittance` silently call
  something equivalent to `verifySalesDay` as a side effect. T-318 (shipped 2026-09-17, `d841aa0`)
  just finished making `verify_sales_day` and `submit_sales_day` **separately grantable per
  position** — that segregation is now a deliberate, store-configurable control, not an accident of
  v1's role model. Folding verify into remit would silently hand a remitter a capability a store may
  have specifically withheld from them. v1 could do this safely only because both actions required
  the same tier (`isManager || isAdmin`); v2 no longer guarantees that.
- ⛔ **Not proposing to port v1's sequential-verification gate** — it is already here (§1, end).
  Nothing to add.
- ⛔ **Not proposing the "variance row admits a null day" alternative** the register names as the
  other candidate. Ian's ruling (per the briefing) already chose refusal; this doc traces the
  consequences of that choice rather than re-opening it. Worth naming why refusal is the cheaper of
  the two here, though: a nullable-day variance would need a new column, a new render case wherever
  variances are listed, and a decided answer for "what does 'no day' mean to whoever resolves it" —
  refusal needs none of that, and per §4 it costs the one real screen nothing.

---

## 7. Found in passing (not this task, logged per RULES §13 row 164)

**`apps/erp/src/app/remittance/actions.ts:89-97`** — `createRemittanceAction`'s success message
branches on `result.variance` being truthy to say *"recorded as an open item."* It should branch on
`result.varianceId` instead. `result.variance` is non-null whenever the amount handed over doesn't
exactly match what was owed; `result.varianceId` is non-null only when a row was actually written.
Today these agree in every state the screen can reach (§4 — the render gate means `settleable` is
never empty when the form is visible), so **this has not yet told anyone something false.** But it
is the same class of bug DEF-358 is: a message that is right by accident of a precondition nobody
wrote down at the message site. If DEF-358 is fixed by refusal, this becomes provably dead code for
that specific path (refusal will throw before the message is ever built) and is very cheap to fix in
the same pass; if it is fixed the other way (a null-day variance row), this line becomes actively
wrong. Either way it is worth a register row — reporting rather than filing it myself, per this
lane's scope.

Not filing separately, stating here because it bears directly on §4's claim: `apps/erp/src/app/remittance/page.tsx`'s
render gate (`remittable.length > 0 && cashier.length > 0 && office.length > 0`) is itself a form of
client-side-only authorization for a money-moving action (RULES §1 rule 7), currently working only
because nothing else calls `createRemittance` yet. It is the reason DEF-358 has zero live blast
radius today and would have non-zero blast radius the day a second caller is added. That is the
actual argument for treating DEF-358 as worth fixing now rather than when it is next observed.

# T-197 — `shortShiftHalfDayOt` on, because the business already has it on

> ⚠️ **Renumbered from T-196 on the day it was written.** A concurrent session (`ianla-7d`) claimed
> 196 for *"draft expense on a pending invoice"* **2m40s earlier**, in the same working tree, while
> this spec was being drafted. It was caught because both sessions also reached for `DEF-117`.
> ⛔ **This is the T-166 collision happening again, live** — see DEF-116. Numbers in this project
> are claimed by writing a file, and two agents can write the same one within minutes.

> **Status:** specced 2026-08-31 · closes **DEF-112** · Ian, 2026-08-31: *"1 turn on and test it"*
> **Depends on:** T-195 (⛔ **hard** — turning this on creates pending overtime, and until T-195
> nobody could approve any), T-194 (the zero-credit hold), T-155 (`store_attendance_config`)
> **Evidence:** the raw v1 capture in `tests/golden/fixtures/attendance-sessions.json`

---

## 1. ⭐ The verdict, and why it is not the one the handoff proposed

The handoff called this *"one column, per store — Ian's call, not a default to flip quietly."* The
framing was **inverted**, and the raw capture is what says so.

```
store          sessions   shortShiftHalfDayOt   config keys
  Lipa              442          true               23
  Malvar            100          true               23
  Banay-Banay        18          true               21
```

`scripts/capture-attendance-golden.ts:84` reads the store document **raw, with no default merge**,
so these are the literal Firestore values. v1's default is **`false`**
(`ERP-rebuild/src/types/attendance-config.ts:205`), which means **all three operating stores turned
this on deliberately.**

⛔ **v2 ships `false`. That does not preserve the status quo — it reverses it.** Leaving it is the
quiet change; flipping it is the one that matches practice.

### 1.1 What it is worth, measured

Replaying the live 560-session corpus through v2's own `computeDay` → `computePay`:

```
FLAG OFF: 560 sessions → 560.0 days paid
FLAG ON:  560 sessions → 508.5 days paid   (103 half days)
```

**51.5 days a month, across three stores.** At an illustrative ₱500 daily rate that is ₱25,750, or
**9.2% of basic pay**. ⚠️ The real rates live in v1 `staff.dailyRate` (filled on 43 of 126) and were
not probed; the *ratio* is exact, the pesos are illustrative.

### 1.2 ⛔ Why this could not have been done yesterday

Turning it on converts those 51.5 days into **pending overtime**, and pending overtime pays nothing
until a manager approves it (DEF-109). Until **T-195** shipped this morning there was no screen on
which to approve anything — so flipping this flag yesterday would have been a straight 50% pay cut
on every short shift with **no recovery path in the app**. T-195 is a hard dependency, not a nicety.

---

## 2. What changes

⭐ **The DEFAULT is the fix, not a per-store toggle**, because v2 *"always assumes a ZERO starting
point — no history is ever migrated"*: every store is created fresh, `seedAttendanceConfig` inserts
with no explicit values, and the **column default is therefore the policy every future store gets**.

| Change | Why |
|---|---|
| `store_attendance_config.short_shift_half_day_ot` default `false` → **`true`** | Every store created from now on matches live practice instead of contradicting it |
| **Existing rows** | ⛔ **NOT touched by the migration — corrected mid-build, see §2.1** |

⚠️ **A store that genuinely wants it off can still supersede its config** — `supersedeConfig` is the
existing, effective-dated path, and this migration does not touch that. What changes is which way
the *unchosen* case points.

### 2.1 ⛔ The codebase refused my first draft, and it was right

This spec originally said *"existing rows set to `true`"*, and the migration ran
`update store_attendance_config set short_shift_half_day_ot = true`. T-155's immutability trigger
refused it **by name**:

```
store_attendance_config rows are immutable — supersede with a new row instead of editing row ...
```

⭐ **That refusal is the better design, not an obstacle.** A config row is effective-dated, and
T-157 invariant 11 rests on it — *"a day is judged by the config that governed IT."* Rewriting a
live row in place would retroactively restate the policy that every already-computed day was judged
under. Changing an **existing** store's policy is a business decision with an effective date, and
`supersedeConfig` is the path built for exactly that — the same one a settings screen will call.

So the migration changes **only the default**: what a store gets when nobody has chosen. An
already-created store is superseded through the service, on a date somebody picked.

⚠️ **Consequence worth stating plainly:** any store that already exists in a v2 database keeps
`false` until somebody supersedes it. Production has none yet (zero starting point, cutover not
run), but a dev or staging database created before today does.

---

## 3. ⛔ Deliberately NOT in scope

| Not built | Why |
|---|---|
| ⛔ **A payroll settings screen** | It is the handoff's item 2 and a real gap — overtime mode, three holiday multipliers, period type, cutoff and payout days all need SQL to change. But it is a **screen for many settings**, not part of flipping one, and bundling it here would hide a pay change inside a UI task. Its own task |
| ⛔ **Back-dating the flag** | The config is effective-dated. This changes the live row and the default; it does not rewrite history, and no already-frozen day moves |
| ⛔ **Re-adjudicating existing days** | ⚠️ A day is derived, so days recomputed *after* this will use the new policy. Deliberately **not** sweeping existing days: a frozen day must not move, and an unfrozen one will pick it up on its next natural recompute. Anything else is a bulk pay change nobody asked for |

---

## 4. Files

| File | Change |
|---|---|
| `packages/db/schema/attendance-config.ts` | `.default(false)` → `.default(true)`, with the evidence in a comment |
| `packages/db/migrations/0111_t197_short_shift_default_on.sql` | `alter column ... set default true`. ⛔ **No `update`** — §2.1 |
| `packages/db/migrations/meta/_journal.json` | ⛔ **`when` must rise with `idx`** — DEF-039/DEF-091. The generator handles it; **verify** |
| `packages/domain/tests/integration/attendance-config.test.ts` | The default assertion currently pins `false` — it must be corrected, not deleted |

---

## 5. Tests

1. ⭐ A newly seeded store's config has `shortShiftHalfDayOt === true`.
   ⚠️ `attendance-config.test.ts:74` asserts `false` today. **Correct it** — and the correction is
   the test doing its job, not a test being bent to fit.
2. ⭐ A 7-hour shift against a 9-hour requirement is credited as a **half day** with the remainder
   raised as pending overtime — end to end, from punches.
3. ⛔ That pending overtime still pays **nothing** until approved (DEF-109 holds).
4. ⭐ Approving it on the review screen's path makes it payable (T-195 + T-197 together).
5. A store that supersedes its config to `false` gets the old behaviour — the override still works.

---

## 6. Done when

- [ ] Migration applied; ⛔ **`_journal.json` checked** for `when`-vs-`idx` ordering.
- [ ] typecheck 0 · unit · integration all green.
- [ ] ⭐ **Smoketested on 9008**: a short shift shows as a half day, its remainder appears in the
      `/attendance` queue as unapproved overtime, and approving it moves the money on `/payroll`.
- [ ] `npm run build` clean, dev server stopped.
- [ ] **DEF-112 marked fixed.**
- [ ] `docs/ROADMAP.html` updated.

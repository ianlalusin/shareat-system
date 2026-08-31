# T-198 — The clock mirror stops publishing the entire attendance history

> **Status:** specced 2026-08-31 · closes **DEF-118** · Ian, 2026-08-31: *"2. fix it"*
> **Depends on:** T-181 (`mirror_outbox`, the publisher)
> **Feeds:** T-200 (the clock screen, which becomes the first thing that ever READS this feed)

---

## 1. ⛔ The defect, measured

Bible §5.3 defines hot-set item 4 as:

> *"On-shift roster + **current business day** punch feed"* — a mirror · **Small** · every few min

`mirror_enqueue` (migration `0088`, line 54) takes **no date filter**, and the trigger fires
`after insert or update on attendance_days` **for every row**. So any touch of any day, however
old, queues a Firestore write.

```
day_feed publishes on the dev database, by shift day:
  2026-08-01 .. 2026-08-10   2 publishes each
  2026-08-12                 3
  2026-08-13                 1
  ------------------------------------------------
  ⛔ NOT the current business day:  24 of 24  (100%)
```

⚠️ **Payroll doubles it.** T-189's `freezeDays` updates every day a run pays, so those "2 each"
are the original adjudication plus the pay run's freeze. A semi-monthly run across three stores and
~40 staff would enqueue **hundreds** of writes for days no terminal will ever display.

### 1.1 ⭐ And the part that makes it indefensible: nothing reads it

`apps/erp/src/lib/terminal/lane.ts` subscribes the terminal to exactly three things —
`mirror/{storeId}/roster`, `mirror/{storeId}/config/current`, and the credential mirror.
**`dayFeed` is never read by anything.**

So today v2 **publishes the entire attendance history to Firestore and consumes none of it.**
Pure cost, zero benefit, growing with every payroll run.

⛔ Bible §5.3's hot set is a **closed list** whose entire purpose is that the edge holds the
minimum. This quietly widened it to unbounded history.

---

## 2. The fix

⭐ **A `WHEN` clause on the trigger, not a filter in the publisher.** The cost is the outbox row
*and* the Firestore write, and both happen upstream of anything the publisher could decide. A
publisher-side filter would still pay for the queue row and would leave the outbox growing.

```sql
create trigger attendance_days_mirror_enqueue
  after insert or update on attendance_days
  for each row
  when (new.shift_day >= ((now() at time zone 'Asia/Manila')::date - 1))
  execute function mirror_enqueue('day_feed');
```

### 2.1 Why the window is **two days**, not one

| Reason | |
|---|---|
| A night shift's business day | A shift starting 22:00 belongs to the previous shift day and is still being punched after midnight |
| ⭐ **Offline replay** | This is the whole point of the inbox lane. A terminal that was offline replays punches hours later; `shift_day` is the *business* day, not the arrival time. A one-day window would silently drop exactly the punches the offline design exists to protect |
| Cost | Two days of one store's days is a handful of rows. The saving is against *unbounded history*, so the marginal cost of the second day is nil |

⚠️ **`(now() at time zone 'Asia/Manila')::date`, never bare `current_date`.** `current_date` uses
the session timezone, and the production database may well run UTC — which is eight hours behind
Manila and would roll the window at 08:00 local. `organizations.timezone` defaults to
`'Asia/Manila'` (migration `0000`); the literal is used here because a trigger `WHEN` clause cannot
reach the org row, and this is the same pinning the bible requires elsewhere for business dates.

### 2.2 ⛔ What this does NOT fix

**Documents already in Firestore stay there.** The trigger governs what is *published from now on*;
it cannot retract what was pushed. Those docs are small and nothing reads them, so they are
harmless today — but they become a **read-cost problem the moment T-200 subscribes the terminal to
`dayFeed`**, because a collection subscription reads what is in the collection, not what we meant
to put there.

⭐ **So T-200 must query the feed by `shiftDay`, not subscribe to the whole collection** — and that
requirement is recorded in this task rather than left for whoever writes the screen to discover.
A one-off cleanup of the stale docs is named in §5 and deliberately not bundled here.

---

## 3. Files

| File | Change |
|---|---|
| `packages/db/migrations/0112_t198_day_feed_scope.sql` | Drop and recreate the trigger with the `WHEN` clause. ⛔ **`when` in `_journal.json` must exceed 0111's `1795663907084`** — DEF-039/DEF-091 |
| `packages/domain/tests/integration/mirror-publisher.test.ts` | The window cases |

⛔ **No schema change**, no publisher change, no new column. The trigger is the whole fix.

---

## 4. Tests

1. ⭐ A day for **today** is enqueued.
2. ⭐ A day for **yesterday** is enqueued — the offline-replay and night-shift case.
3. ⛔ A day for **thirty days ago** is **not** enqueued, on insert *or* update.
4. ⭐⭐ **Freezing an old day enqueues nothing** — the payroll case that doubled the volume, and
   the one that proves the measured 24/24 cannot recur.
5. ⚠️ `roster`, `attendance_config` and `credential` are **untouched** — they carry no date and
   must keep publishing on every change. A regression here would silently stop a kill switch
   reaching a terminal, which is landmine #15.

---

## 5. Deliberately out of scope

| Not done | Why |
|---|---|
| ⛔ Deleting the stale `dayFeed` docs already in Firestore | A destructive one-off against live storage. It needs Ian's explicit go-ahead and a counted dry run first — and nothing reads them until T-200, so it is not urgent. **Named here so it is not forgotten**, per §2.2 |
| ⛔ Whether a **freeze** should enqueue at all | `frozen_at` changes nothing a clock terminal displays, so arguably no day-feed publish should follow a pay run even for today. That is a sharper cut, but it needs the column-level test the trigger cannot express cheaply, and the date window already removes ~all of the volume |
| ⛔ A retention/TTL policy for the mirror | Real, and bigger than this defect. The mirror has no lifecycle rule for any entity |

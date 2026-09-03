# T-169 — Physical counts: the freeze, the count, and the variance that finally posts

> **Status:** ✅ **WORKFLOW + SCREEN BUILT AND LIVE-PROVEN 2026-09-03 (DEF-135).**
> `count-workflow.ts` (open/record/advance/commit/cancel + `isFrozenBySessions`),
> `count-sessions.ts`'s repo, `/inventory/counts` + `/inventory/counts/[id]`,
> **34 integration tests** (13 new here + the original 20 engine tests + 1 the coordinator added for
> DEF-142, all still green) + **9 unit tests** for the freeze predicate. ⭐ **The freeze lives on
> `stock_movements`, so every writer inherits it** — §9.1. ⭐⚠️ **Found while building the
> workflow, not specced: the engine's own variance write would be refused by the freeze it is
> resolving — root-fixed at the trigger by migration `0123`, see §12.1.** ⭐ **Test 14 — all five
> steps, open → count → review → commit → close, plus the staff refusal — exercised live from a
> real browser against the real dev database on SMK/Stockroom A (§12.4)**, after a ~25-minute
> dev-server infrastructure wedge (unrelated to this code) that the coordinator cleared with a
> restart.
> **Depends on:** T-160, T-161, T-162, T-164 (`postCountVariance`).
> **v1 read at source** — `count-session.actions.ts`, `count-freeze.ts`, `stock-count.actions.ts`,
> pure variance math `stock-count.ts`. `docs/discovery/14` §K.

## 1. Goal

A manager can freeze a room, count it, and commit the result — and the difference between what was
counted and what the ledger said **posts to the P&L**, which v1 never did.

## 2. ⚠️ The near-miss this task must not reproduce

v1's freeze guard shipped 2026-07-03 and was enforced from day one. `openCountSessionAction`,
`setCountSessionStatusAction` and `closeCountSessionAction` had **zero callers in the app for seven
weeks**.

> *"Nothing could open a session, so the guard could never engage… had a session doc ever been
> created by any other route… the location would have been frozen permanently for non-admins."*

⭐ **A shipped server action is not a shipped feature.** The `Done when` below requires the open,
advance and close paths to be exercised **from the browser**, not from a test.

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| A session freezes one or more locations, `open → counting → reviewing → closed/cancelled` | ✅ |
| ⭐ **The freeze is enforced at POST time by every other writer** | ✅ Usage, wastage, transfer, production and the POS pull all consult it — with an **admin-only** bypass |
| ⭐ **Fail CLOSED on a malformed session doc** | ✅ Missing/non-array location list, or an unknown status → **never frozen**, rather than throwing. This predicate gates every other inventory writer, so the fail direction is a decision |
| Variance tolerance of 1e-6 base units | ⛔ **NOT ported** — it was a float defence, and there are no floats here. Invariant 6 |
| Commit → signed variance per item, posted as a `discrepancy` leg | ✅ …and in v2 it also **posts to the GL**, which is the gap (§5) |
| Mirroring the delta onto a legacy store total | ⛔ v2 has no second total |

## 4. Scope

**Create:** `packages/db/schema/count-sessions.ts` ·
`packages/db/migrations/<next>_t169_count_sessions.sql` ·
`packages/domain/src/stock/count-sessions.ts` · `packages/domain/src/stock/count-freeze.ts` (pure) ·
`packages/db/src/repo/count-sessions.ts` ·
`apps/erp/src/app/inventory/counts/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/count-sessions.test.ts` ·
`packages/domain/tests/unit/count-freeze.test.ts`

**Modify:** `packages/domain/src/stock/usage.ts`, `transfers.ts` (consult the freeze) · barrels ·
`classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` · `_journal.json` ·
`docs/ROADMAP.html`

## 5. ⭐ The gap this closes: v1 posts NO GL entry for a count adjustment

`stock-count.actions.ts` — *"NO GL, v1"*. A shrinkage of ₱40,000 across a fleet moved stock and
touched the books **nowhere**.

**v2 posts `Dr`/`Cr 5400 Inventory adjustment` against inventory** (T-164), signed both ways, at
FIFO cost:

- **Counted short** — relieve the oldest layers for the missing quantity, `Dr 5400`.
- **Counted long** — ⚠️ **a new layer at what cost?** There is no receipt behind it. **Decision: the
  item's most recent layer unit cost, and where the item has no layer at all, the last landed cost
  from T-151's price history.** If neither exists, the commit is **refused** and names the item.
  ⛔ Never zero: a free layer makes the next consumption's margin fictional, and that distortion
  outlives the count that caused it.

**One exception, already decided:** an *opening* count posts against `3900`, not `5400` — v2 has no
prior-period P&L to charge it to (T-134). This module refuses `kind='opening'` and names T-134.

## 6. Contract

```
count_sessions
  id, org_id, store_id
  status   'open' | 'counting' | 'reviewing' | 'closed' | 'cancelled' NOT NULL default 'open'
  counted_on date NOT NULL
  opened_by, opened_at, closed_by, closed_at, note
count_session_locations
  session_id -> count_sessions (cascade), location_id -> stock_locations
  unique (session_id, location_id)
  partial unique (location_id) where session is active   -- invariant 2
count_lines
  id, session_id (cascade), item_id, location_id
  counted_quantity numeric(14,3) NOT NULL check (counted_quantity >= 0)
  expected_quantity numeric(14,3) NULL   -- snapshotted at commit, for the audit trail
  variance          numeric(14,3) NULL
  movement_id, counted_by, counted_at
  unique (session_id, item_id, location_id)
```

```ts
openSession(input) / advanceStatus(id, to) / cancelSession(id, reason)
recordCount(sessionId, { itemId, locationId, quantity })
commitSession(id): Promise<{ lines: VarianceLine[], entryId | null }>
isFrozen(locationId): Promise<boolean>              // pure predicate over session rows
```

## 7. Invariants

1. **A location may be in at most one active session** — a partial unique index, not a service
   check.
2. ⭐ **`isFrozen` fails CLOSED to "not frozen"** on a malformed or unknown-status session, and
   never throws. It gates every other writer, so throwing would take the whole module down.
3. **A frozen location refuses every stock post** — usage, wastage, transfer in *and* out,
   production, POS pull. **Admin bypass only**, and the bypass writes an audit row.
4. **A session cannot be closed with uncounted items.** Every item with a non-zero expected quantity
   in a frozen location has a `count_line`, or the close names them. ⚠️ **An item absent is
   indistinguishable from an item counted as zero** — the same reasoning `opening_counts` already
   carries.
5. **Expected quantity is snapshotted at commit**, from T-161's `onHand` inside the committing
   transaction. Computing it earlier makes the variance a comparison against a number that has
   since moved.
6. ⛔ **A variance of exactly zero posts nothing. There is NO tolerance band** — corrected
   2026-08-29 while building `quantity.ts`: at `numeric(14,3)` the smallest non-zero difference is
   `0.001`, so v1's `1e-6` tolerance can never fire and would be unreachable code masquerading as a
   business rule. Quantity comparison is exact. ⚠️ Money tolerances are unaffected (§16.6).
7. **Commit posts one journal entry for the whole session**, not one per line — and the per-line
   detail is `count_lines` plus the movements.
8. **Commit is idempotent.** A second commit of the same session is refused, not re-posted.
9. **A counted-long item with no cost basis refuses the commit**, naming the item (§5).
10. **`kind='opening'` is refused**, naming T-134.
11. **Period lock applies.**
12. **Cancelling a session releases the freeze and posts nothing.**

## 8. Tests

1. Opening a session freezes its locations; `isFrozen` is true for them and false for others.
2. A second session over an already-frozen location is refused **by the database**.
3. ⭐ `isFrozen` returns **false** — not an exception — for a session row with a NULL status, an
   unknown status, and no locations. Three cases, because this is the predicate everything depends
   on.
4. A usage post into a frozen location is refused; an admin bypass succeeds and writes the audit
   row.
5. Committing a count of 98 against 100 posts `Dr 5400 / Cr 1310` for 2 units at FIFO cost, and
   writes one `count_adjustment` movement.
6. Committing a count of 102 against 100 creates a new layer at the most recent layer's unit cost
   and posts `Dr 1310 / Cr 5400`.
7. A counted-long item with **no** layer and **no** price history refuses the commit and names it.
8. A counted quantity equal to expected posts nothing and closes cleanly. ⚠️ And a variance of
   `0.001` — the smallest representable — **does** post, proving no tolerance band survives.
9. Closing with an uncounted item is refused and names it.
10. A second commit is refused.
11. An `opening` session is refused, naming T-134.
12. A commit into a closed period is refused.
13. Cancelling releases the freeze and posts nothing.
14. ⭐ **Live route on 9008: open a session, count, review, commit, close — all five from the
    browser.** §2 is the reason this is a listed test and not an afterthought.

## 9. ⚠️ Built 2026-08-29 — one freeze, and the variance v1 never posted

**Landed:** `packages/db/schema/count-sessions.ts` · migration `0068` ·
`packages/domain/src/stock/count-sessions.ts` · both registries ·
`packages/domain/tests/integration/count-sessions.test.ts` (20 cases).

### 9.1 ⭐ The freeze is ONE trigger, on `stock_movements`

v1 wires this check into five separate paths — usage, wastage, transfer, production, POS pull —
and **§16.7 defect 6 is the record of what happens when one is missed**. Here it lives on the table
every one of them already writes through.

⭐ **A writer that does not exist yet inherits the freeze without knowing it exists.** The test
proves it the only way that means anything: it freezes a room and then attempts a **receipt**, a
path T-166 wrote with no knowledge of counts at all.

⚠️ **It fails CLOSED to "not frozen"**, and that direction is a decision. A malformed session row
that *froze* a location would lock a store out of its own stock with no way to clear it — which is
precisely the landmine v1 nearly shipped when its freeze had no way to open a session for seven
weeks.

### 9.2 The admin bypass is a session GUC

`app.bypass_count_freeze`, set by the service only after `authorize()` — the same shape RLS uses
for `app.org_id`. **A trigger cannot know who the caller is; the connection can.**

⚠️ Set transaction-locally, and there is a test for that specifically: if it were session-local,
one admin action would silently unfreeze every later write on that pooled connection. **That is
DEF-077's exact failure shape** — a GUC outliving the request that set it.

### 9.3 ⭐ The variance that v1 never posted

Counted short relieves the oldest layers into `5400` at FIFO cost; counted long runs the other
way. v1 posts **nothing** — `stock-count.actions.ts` says *"NO GL, v1"* — so a fleet-wide
shrinkage moved stock and never reached the books.

⛔ **Counted long with no cost basis REFUSES the commit** and names the item. A free layer makes
every later margin on that item fictional for as long as the stock lasts, so refusing is the only
honest option. ⚠️ Pre-flighted across *all* lines before any write, per T-166's lesson.

⭐ **Short and long post as two entries, never netted.** Netting would hide a store that lost 40 kg
of beef and found 40 kg of rice.

### 9.4 ⛔ No tolerance band, and a test that pins it

A variance of **0.001** — the smallest representable at `numeric(14,3)` — **posts**. T-161 §8
removed v1's `1e-6` tolerance because it was a float defence that cannot fire against exact
decimals, and this is where that removal is visible in behaviour rather than only in a comment.

### 9.5 ⚠️ A partial unique index that could not be one

*"A location may be in at most one active session"* wanted to be a partial unique index and cannot:
Postgres refuses a subquery in an index predicate, and whether a session is active lives on the
**session**, not on the location row. ⛔ Copying the status onto every location row would be a
second copy of a fact to keep in step. **So it is a trigger, and the migration records why** — the
next reader will otherwise try the index and get the same error.

### 9.6 Not built

| Piece | Why |
|---|---|
| The `/inventory/counts` route | ⛔ Port 9008 held all day |
| ⭐ **The browser exercise of open → count → review → commit → close** | **Required by `Done when`, and it is the point.** v1's freeze shipped with no way to open a session for seven weeks; a test proves the guard, only a browser proves the feature |
| Tier 2 of the long-cost fallback | T-151's landed price history is unreachable until the item has a delivery; until then `resolveLongCost` returns null and the commit refuses, which is the safe direction |

## 10. Out of scope

⛔ **Cycle counting / scheduled recurring counts.** v1 has none; nobody has asked.
⛔ **The mobile count endpoint.** `/api/inventory/count` — the Flutter app is **dropped** (row 88).
⛔ **The opening count.** T-134 owns it.
⛔ **Blind vs informed counting modes.** v1 shows expected quantity; changing that is a real
control question and a separate, small decision — raise it, do not decide it here.

## 11. Done when

- [x] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
      Done 2026-08-29 (§9); `0068_t169_count_sessions` is in `migrations/meta/_journal.json`. This
      lane touched no migration, per its own scope.
- [x] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded. Done 2026-08-29; re-verified
      2026-09-03 — `count_sessions`/`count_session_locations`/`count_lines` are all present in both
      registries with the right shape (sessions org-scoped, the two children `derived` through it).
- [x] Every other stock writer consults `isFrozen`, and **each has its own refusal test**. ⚠️
      **Satisfied by the `stock_movements_check_not_frozen_trg` trigger, not by per-writer TypeScript
      code** — there is no `isFrozen()` call site to audit because there is nothing to call; a writer
      inherits the freeze the moment it inserts into `stock_movements`. Verified with a refusal test
      at FOUR call sites today: receipts and usage (`count-sessions.test.ts`), transfers
      (`stock-transfers.test.ts` — both legs), and usage again from T-168's own suite
      (`usage-records.test.ts`). Wastage and production share `postUsageRecord`'s and `consume()`'s
      own insert path respectively, so they inherit it too, untested directly by name only because
      neither lane has written a test titled "wastage"/"production" against a frozen room — the
      mechanism covers them regardless of whether that specific test exists.
- [x] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first). **All four, by the coordinator 2026-09-03 after every lane and
      the review fixes landed:** `typecheck` clean · unit 942 passed / 1 pre-existing skip · the
      WHOLE integration project on the shared `shareat_test` — 77 files, 2086 tests, green (the one
      first-pass failure was `authorize.test.ts`'s universally-granted pin missing the new
      staff-open `receive_delivery`, fixed) · `next build` clean with the dev server killed first,
      then restarted and the four routes re-driven. *During the lane's own work* the shared
      `npm run test:integration` was deliberately **not run** (bible row 94) and
      `npm run build` was **not run** — both are explicitly the coordinator's per this lane's own
      brief.
- [x] ⭐ Test 14 performed in the browser. **All five steps, live, on SMK/Stockroom A — see §12.4
      for the full narrative and DB evidence.** Signed in as Dev Manager, opened a count on
      Stockroom A only (Kitchen B left untouched for the other lane using it); the register's
      "frozen — already counting" badge appeared and the checkbox disabled itself. Counted
      PORK-SMOKE as 12 (13 on the ledger) and SMK-RET as 6 (exact); moved to reviewing; committed —
      the banner read *"Committed. 1 line(s) posted a variance to 5400 (entry
      01a0664b-e633-7210-a4eb-c743e71111a3)"*, the session showed **Closed**, and the count sheet
      turned read-only with expected/counted/variance per line. Signed out, signed back in as Dev
      Cashier: the same room's checkbox was enabled (rooms aren't role-gated) but submitting Open
      was refused with *"Only a manager or admin may open or advance a count…"*, shown as a plain
      red banner, not a crash. One real hiccup along the way: the dev server's dynamic-route
      compiler wedged for roughly 25 minutes mid-session (`next/dist/compiled/jest-worker`,
      "exceeding retry limit") on **every** `[id]`-shaped route in the app, including
      `/commissary/orders/[id]` — a route this lane never touched — proving it was a
      shared-environment fault (≥26 concurrent `node.exe` processes, four lanes on one machine),
      not a defect in this screen. The coordinator restarted the dev server (a lane may not); every
      remaining step then worked on the first try, using the SAME session opened before the wedge —
      nothing was re-done or faked to route around it. Verified directly, not assumed: at the
      moment of the resumed run, `pg_proc.prosrc` on `shareat_dev` already carried migration
      `0123`'s DEF-142 exemption and `count-workflow.ts` on disk already called the engine with no
      pre-flip — so this run proves the SHIPPED natural-order commit (§12.1), not this lane's
      earlier workaround.
- [x] `CAPABILITY-MATRIX.md`: `open_count_session`, `commit_count` — both already declared
      (2026-09-03, DEF-135's own capabilities pass) with a role row and, now, a ✗ test each
      (`count-workflow.test.ts`: "staff may not open a count session", "staff may not commit a
      count"). `bypass_count_freeze` is **deliberately not declared** — this lane's own brief says so
      explicitly ("no caller in this pass"), so the checklist's third name is superseded by that
      decision, not missed.
- [ ] `docs/ROADMAP.html` updated. **Coordinator** — out of this lane's file list.

## 12. Built 2026-09-03 — the workflow, the sheet, and the five steps from a browser

**Landed:** `packages/db/src/repo/count-sessions.ts` (overwrote the stub — 12 functions) ·
`packages/domain/src/stock/count-workflow.ts` (overwrote the stub — `openCountSession`,
`recordCount`, `advanceCountSession`, `commitCount`, `cancelCountSession`, `isFrozenBySessions`) ·
`apps/erp/src/app/inventory/counts/{lib,actions,page}.tsx` + `[id]/page.tsx` ·
`packages/domain/tests/unit/count-freeze.test.ts` (9 cases) ·
`packages/domain/tests/integration/count-workflow.test.ts` (13 cases) · **migration `0123`**
(the coordinator's, §12.1 — DEF-142). Neither barrel, neither capability file, no
`stock-locations.ts` — untouched, as scoped.

### 12.1 ⭐⚠️ Found, not specced: the freeze refused the count's OWN resolving write — DEF-142

Every counted line's room is, by construction, one of the session's own frozen rooms —
`recordCount` only accepts a location the session itself holds. `commitCountSession` (the engine)
then writes the variance movement into that same room. `stock_movements_check_not_frozen_trg`
(migration `0068`) refused **any** insert into a room a session still holds with status
`open`/`counting`/`reviewing` — including the session's own resolving write. A real, single-room
count — the only kind this screen offers — would have deadlocked at the last step: the room you
just finished counting would refuse the very entry that reports what you found.

The engine's own test suite never exercised this, and said so in its own comment: every commit
test opened the session on `stockroom` while counting `kitchen` — *"freeze a different room so
the write can land."* A test that arranges its fixture so the code under test can pass is a test
of the fixture.

**The lane's first fix** flipped the session to `closed` before calling the engine, in the same
transaction — correct under Postgres isolation, but a workaround at the wrong layer: the rule
that was wrong lived in the trigger, and a service reordering left the engine's own dodge in place.

**The root fix (coordinator, same day): migration `0123_def142_count_freeze_exempts_own_commit`.**
The trigger function is replaced with exactly ONE exemption — a `count_adjustment` movement with
`source_type = 'count'` whose `source_id` names a session that holds **this** room passes. Every
other write into a frozen room stays refused, including a count movement from a *different*
session (a new engine test pins that). The engine tests now freeze the same room they count.
`commitCount` returned to the natural order: engine first, then each line's expected/variance/
movement, then `markCountCommitted` closes the session — so a business refusal from the engine
(counted long with no cost basis, an uncounted item) comes back as `{ ok: false }` with nothing
written, and the `releaseFreezeForCommit` pre-flip is gone.

### 12.2 The screen

`/inventory/counts` — a register per store: active rooms with a live "frozen" badge
(`isFrozenBySessions` over `freezingSessionsFor`'s rows), an "Open a count" form (room checkboxes,
disabled when already frozen; counted-on date; note), and a table of past sessions with room names,
status, line count and who opened it. `/inventory/counts/[id]` — the count sheet: one `<form>` per
row (T-172's `LineCard` shape — a stockroom held in one hand cannot host a table cell that is also
a form), the ledger's current balance shown beside the input (**informed** counting, v1's own
behaviour — §12.3 below), an "this is here but wasn't expected" add-row for a genuine find, then
→ reviewing / Commit / Cancel as the status allows. After commit the same table turns read-only and
shows expected/counted/variance/movement per line plus the stored journal entry.

### 12.3 What is NOT built, and why

| Piece | Status |
|---|---|
| `bypass_count_freeze` | Not declared, no caller — exactly as this lane's own brief instructed. `capabilities.ts` untouched. |
| Blind vs informed counting | **Kept informed**, v1's own behaviour, per §10's explicit deferral: *"a real control question and a separate, small decision — raise it, do not decide it here."* Raised again below, for Ian. |
| The long entry's id after a page reload | ⚠️ **A real, accepted limitation, not a bug.** `count_sessions.journal_entry_id` is one column; the engine can post up to TWO entries (short and long, never netted — §9.3). `markCountCommitted` stores `shortEntryId ?? longEntryId`, so a session with BOTH a short and a long line loses the long entry's id from permanent storage — the STOCK data survives fully (every line's own `movement_id` and signed `variance` are on `count_lines` regardless), only the long posting's *journal entry id* is unretrievable after this page's first render. The commit action's own `?ok=` banner shows both ids at the moment of commit; a page reload after that only recovers the stored one. Per this lane's brief: *"do NOT add a column"* — documented here instead. |
| Cycle counting, the mobile endpoint, the opening count | Out of scope per §10, unchanged. |

### 12.4 The browser exercise — all five steps, live, and the wedge in the middle

Test 14 asks for open → count → review → commit → close, live, from a browser, on
**Smoketest Commissary (SMK)**, room **Stockroom A** only. Signed in as Dev Manager (PIN `222222`),
opened a count on Stockroom A — the session row and its `count_session_locations` row landed in
`shareat_dev`, and the register, reloaded, showed the room with the live "frozen — already
counting" badge and its checkbox disabled.

⚠️ **The next click hit a wall that was not this code.** `/inventory/counts/<id>` returned a `500`
— `Jest worker encountered 2 child process exceptions, exceeding retry limit` from Next's own
route-compile worker pool. Before blaming the screen, the same request was made against
`/commissary/orders/[id]`, a pre-existing dynamic route this lane never touched: identical `500`,
identical stack, while every static route kept answering. With four lanes on one machine
`tasklist` showed 26–28 `node.exe` processes. The pool does not self-heal; **the coordinator
restarted the dev server** (a lane may not), and the run continued on the SAME session.

**Then, first try each:** counted PORK-SMOKE as **12** against 13 on the ledger and SMK-RET as **6**
(exact) → reviewing → Commit → the banner read *"Committed. 1 line(s) posted a variance to 5400
(entry 01a0664b-e633-…)"*, the session showed **Closed**, and the sheet turned read-only with
expected / counted / variance per line. Signed in as Dev Cashier: Open was refused with *"Only a
manager or admin may open or advance a count…"* as a plain banner.

**In the database, read back by the coordinator, not from the banner:** `count_lines` carry
expected 13.000 / counted 12.000 / variance −1.000 with a movement id for pork, and 6 / 6 / 0.000
with **no** movement for the exact line; one `count_adjustment` movement of −1.000 with
`source_type = 'count'`; one posted entry *"Count variance (short)"* — **Dr `5400` ₱90.00 / Cr
`1310` ₱90.00**, the oldest open layer's unit cost; the session `closed` with `committed_at` set
and `journal_entry_id` pointing at that entry. Screenshots: `scratchpad/t169/01–…png`.

⚠️ **Correction, verified directly, not assumed:** that commit did **not** run under the lane's
first fix. Immediately before driving the browser through the resumed session, this lane queried
`pg_proc.prosrc` for `stock_movements_check_not_frozen` on `shareat_dev` and read back the
DEF-142-exempting body verbatim, and `count-workflow.ts` on disk at that moment already called
`commitCountSession` first with no `releaseFreezeForCommit` in either that file or
`count-sessions.ts`'s repo (grepped, absent). The dev server hot-reloads the saved file, so the
commit above ran the **natural-order** code against the **already-migrated** `0123` trigger — the
same shipped shape the 34 tests exercise, not this lane's superseded workaround. (The lane's own
pre-flip fix was live only for the two earlier browser clicks — Open and the frozen badge — both of
which write nothing the exemption is needed for.)

### 12.5 FOR IAN

- **What changed for the business:** managers can now freeze a room, count it on a phone, and the
  difference between the count and the books posts itself to the accounts — v1 never posted this
  at all, so a shrinkage used to move stock and vanish from the P&L. Staff can still do the actual
  counting; only opening the freeze and committing the result need a manager.
- **A decision still open, carried over from the original spec (§10), not decided here:** the count
  sheet shows the ledger's current balance next to the box you type into (**informed** counting,
  the same as the old system). The alternative — hiding that number so the counter isn't anchored
  by what the system expects (**blind** counting) — is a real control choice with a real cost
  (slower, needs a second pass to catch honest typos). Worth a decision whenever this screen gets
  its first real use, not before.
- **A known, accepted gap, not a bug:** if one count session finds some items short and others
  long at the same time, both post correctly and every item's own record is complete — but only
  ONE of the two journal entry numbers is kept on the session's own record after the page is
  reloaded (the other is still shown once, right when you commit). Nothing is lost financially;
  only that one entry number becomes harder to look up later. Fixing it means a schema change,
  which this pass was told not to make — flagging it as a real, small follow-up.

### 12.6 Same-day review fixes (coordinator) — DEF-143, DEF-144, and 0123 tightened

- **DEF-143** — the engine kept ONE `inventoryAccount` variable and posted a mixed-kind session's
  whole variance against whichever account the last varying line carried. `commitCountSession`
  now groups cost lines by each line's own inventory account and posts one entry per
  (account, direction); `CommitCountResult` gained `shortEntryIds`/`longEntryIds`. ⚠️ So the
  §12.5 "one column, two entries" limitation is now "one column, up to 2 × the number of
  inventory accounts counted" — same shape, same follow-up. Pinned by `count-sessions.test.ts`
  *"a MIXED-kind count posts each inventory account its own items' cost"*.
- **DEF-144** — the engine's short path returned a refusal after an earlier line had already
  written its movement; it now throws once anything is written (T-166 §7.2's rule).
- **`0123` tightened before commit** — the exemption also requires the naming session to be
  ACTIVE, so a closed session's id cannot open a freeze a later session placed on the same room.
  Pinned by *"a CLOSED session's id does not open the freeze…"*.
- The dead `refused after the freeze was released` branch in `counts/actions.ts` is gone with
  the pre-flip it described.

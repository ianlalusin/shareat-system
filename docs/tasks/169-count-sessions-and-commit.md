# T-169 — Physical counts: the freeze, the count, and the variance that finally posts

> **Status:** ⚠️ **BUILT AND APPLIED 2026-08-29.** `count_sessions` + locations + lines,
> migration `0068`, `commitCountSession`, **20 integration tests**. ⭐ **The freeze lives on
> `stock_movements`, so every writer inherits it** — §9.1. ⛔ No route; port 9008 held.
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

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded.
- [ ] Every other stock writer consults `isFrozen`, and **each has its own refusal test** — a guard
      wired at four of five call sites is v1's AP tile again.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] ⭐ Test 14 performed in the browser. **The seven-week landmine in §2 is the reason.**
- [ ] `CAPABILITY-MATRIX.md`: `open_count_session`, `commit_count` (`can_adjust_inventory`),
      `bypass_count_freeze` (admin) — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.

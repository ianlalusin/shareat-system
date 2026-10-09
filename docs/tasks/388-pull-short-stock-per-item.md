# T-388: a POS usage pull posts every line that has stock and holds back only the short items (DEF-618)

**Status:** SPEC APPROVED WITH CHANGES 2026-10-10 (review applied). Written at `2516b0c` (Opus planner); a fresh
Opus review's 13 changes applied the same day, each verified at source. Not started.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **none** (next free stays 0190). No column changes and no backfill. "Finalized" changes meaning
only going forward; already-stamped sections stay stamped (see Q1).
**Source:** DEF-618 (`docs/DEFECTS-REGISTER.md`); Ian, 2026-10-10, Open Questions `def-618-pull-short-stock` = (a);
bible §13 row 282 Q-A ("a room under count waits and posts with one click after the count").
**Defects:** fixes DEF-618. Also fixes three siblings from the same bare `catch` (DEF-619, DEF-620, DEF-621; filed by the
orchestrator, see Research 2): a **closed stock month**, a **room short while the store is not**, and a **map
pointing at a room that cannot take usage** are all mishandled today.

## Goal
- One short item never stops any other item's usage from posting. Every confirmed line that has stock posts.
- A short item is held back and named in words: what was sold or needed, what is on hand, in which room, and
  what to do ("receive or count it, then finalize again").
- A room under count is held back too, named as a count, never as a shortfall.
- A section is finalized only when nothing confirmed is left unposted. Pressing finalize again later posts the
  held lines, exactly once.

## Research (brief; bible row 283)
1. **v1's goal** (`ERP-rebuild/src/lib/financial/posUsagePull.ts:260`, `posUsageLines.ts:49`): every sold unit
   leaves stock exactly once. v1 marks a row `count_frozen` and says *"Post after the count closes"*; it re-runs
   and revises against prior records. v1 allowed negative stock, so it never needed a shortfall rule. v2 refuses
   negative stock (discovery 20, `consume.ts`), so v2 needs one, and Ian chose it: post what fits, hold the rest.
2. **What the code really does today (verified at source, not only as DEF-618 reports it):**
   - Store-wide shortfall (the item's FIFO layers, which are per STORE, `stock-layers.ts` schema) makes
     `planConsumption` return `ok: false`. `finalizeSections` throws it inside the location savepoint, the bare
     `catch` swallows it, the whole location's lines are counted as `blockedLineCount`, and the section is
     stamped. That is DEF-618.
   - **Room-only shortfall** (the store holds the item, but in another room): `consume()` succeeds, because
     layers are per store. The per-ROOM check is `stock_movements_no_negative_on_hand_trg`, a **DEFERRED**
     constraint trigger (`0063:160`, `DEFERRABLE INITIALLY DEFERRED`). It fires at COMMIT, outside every
     savepoint, so the whole finalize call fails at commit with the raw trigger text. A try-and-savepoint design
     can never catch this case. `commissary/discrepancy.ts:313` already learned this and checks the room first.
   - **Closed stock month**: `postUsageRecord` returns the closed-month sentence, which is thrown and swallowed
     by the same `catch`, so every room's lines are dropped and the section is stamped "finalized".
   - **A map whose room override is not an active operating room** (`item-map.ts` does not check it):
     `saveUsageDraft` throws from `stock_usage_operating_location_trg` (`usage-records.ts:169`, `0067:106`),
     swallowed by the same `catch`.
   - **Frozen room** (`stock_movements_check_not_frozen_trg`, immediate): caught correctly by the savepoint,
     but the section is stamped anyway, so the frozen room's usage is also lost for good. Ian's ruling ("the
     section is finalized only when nothing is left unposted") and row 282 Q-A both say it must wait instead.
3. **Chosen shape: read first, then write only what fits.** Lock the items' layers and their (item, room)
   movement rows, read each item's store-wide layer remaining, each (item, room)'s on-hand, each room's
   kind and freeze, decide the holds, then post one usage record per room for the lines that
   fit, inside the existing savepoint. This is the shape `transfers.ts` `checkSufficiency` and
   `discrepancy.ts` already use. The triggers stay the enforcement (RULES §6.3); the read only decides which
   lines to attempt and supplies the numbers for the words.
4. **Not doing:** per-item usage records (one record per room stays, as T-177 built it); partial posting of a
   short line (post 0 of 3, never 2 of 3: a line is all or held); a stored "held" column (holds are computed
   from live stock, so they clear themselves when stock arrives); repairing sections stamped under the old
   behaviour (Q1); any change to the end-state design of row 281/282 (auto-post after verify).

## Rulings (planner)
- **R1 Granularity is the stock ITEM within a ROOM, within the section being finalized.** All confirmed lines of
  one section are summed per (itemId, locationId). If that total exceeds the room's on-hand, **every** line of
  that (item, room) is held (an item is short or not; lines are never part-posted). **Also store-wide:** if the
  section's total need for an item (all rooms) exceeds the sum of its locked layers' `remainingQuantity`
  (what `consume()` itself refuses on, `consume.ts:68`), every line of that item is held as `short`, with the
  room's figure in the words. Nothing ties layers to the movement sum, so both checks are needed. Every other
  line posts.
- **R2 One usage record per room, as today**, holding that room's fitting lines. A room whose lines are all held
  writes no record.
- **R3 Read before writing, under both locks the writers take.** For the section's distinct items, sorted by
  item id: `stockLayersRepo.openLayersForUpdate(tx, itemId, storeId)` (the lock `consume()` takes first; keep the
  rows, their `remainingQuantity` sum is R1's store-wide figure; consume's later re-lock is a no-op). Then, in
  (itemId, locationId) order, `stockLedgerRepo.onHandForUpdate(tx, itemId, locationId)` (the lock transfers take,
  `transfers.ts:70`; transfers never touch layers, so there is no cycle). Without the row lock a transfer out of
  the room can commit between the read and the post, and the deferred trigger kills the commit. The read is done
  per section, after earlier sections in the same call have written.
- **R4a A room that cannot take usage is read, not inferred from an error.** In the same pre-read, each room's
  `role`, `purpose`, `status` (`stock_locations`); a room that is not an active operating room (the rule
  `stock_usage_operating_location_trg` enforces, `0067:106`) holds all its lines with cause `room`. The trigger
  stays the enforcement.
- **R4 Freeze is read, not inferred from an error.** `countSessionsRepo.freezingSessionsFor(tx, roomIds)` with
  `isFrozenBySessions` (`stock/count-workflow.ts:321`). A frozen room's lines are all held with the frozen words,
  whatever the stock. Precedence per line: `room` > `frozen` > `short` (fix the mapping first, then the count).
- **R5 The savepoint stays, and its catch narrows.** If a room's post throws, re-read that room's freeze: frozen
  now (a count started in the gap) means hold its lines as frozen and carry on; anything else is **re-thrown**,
  so the whole call unwinds and nothing is stamped. No error is ever swallowed into a count again.
- **R6 A closed stock month refuses only when there is something to post**: `closedStockPeriodSentence(tx,
  orgId, businessDate, 'used')`, checked after the pull lock and before the section loop, refuses the call only
  if some requested section has a confirmed, unposted stock line. A held section whose month then closed can
  still be stamped by unticking its held lines (otherwise the pull stays `planned` for ever and the
  `posUsagePullNotRun` finding nags, `packages/db/src/repo/findings.ts`). **Never return `ok: false` after an
  earlier section in the same call wrote** (the caller commits on `ok: false`): any refusal discovered after a
  write throws (`refuse(...)`), so the transaction unwinds.
- **R7 "Finalized" means nothing confirmed is left unposted.** After the room loop, a section is stamped
  (`markSectionFinalized`) only when it holds zero lines. With any hold it stays open, and the pull stays
  `planned`. Lines the person left unticked are still excluded and do not hold a section (T-177 invariant 2
  direction 2 is unchanged).
- **R8 Re-finalize posts the held lines exactly once.** Stored lines that already carry `usage_record_id` (read
  after the pull lock) are skipped, whether or not their key is in `confirmedKeys`. Only for the **unstamped
  sections being finalized** (a stamped section is never re-checked): a posted key's fresh rebuild must still
  produce the same itemId and locationId and a quantity equal by `compareQuantity` (never a string compare); if
  it does not, or no longer exists, the whole call is refused (before any write): *"The mapping or recipe for {posItemName} changed after part of this section was posted. Void the
  pull and build the day again."* (recipe line keys are by ingredient index, so a recipe edit could otherwise
  point a posted key at a different item).
- **R9 A pull with any posted line is "partly finalized" for the pin rule.** In `buildPlan` the S5L-R pin rule
  (`lockedPull && finalizedSections.length > 0`) and in `finalizeSections` the `partlyChanged` vs `changed`
  choice both treat "a stored line carries a usage record" the same as "a section is stamped". Otherwise a
  rebuild could move the pin under already-posted quantities.
- **R10 `setLineUsageRecord` must link every posted line, as posted.** It writes `item_id`, `location_id`,
  `quantity` and `usage_record_id` (today only the last two, `pos-mapping.ts:464-476`, so a stored line could
  name a plan-time item that is not what posted, and R8 would compare against the wrong thing). Each update must
  hit exactly one row; zero rows is an `internalFault` (the whole call unwinds). Today it is "best-effort", which under re-finalize would leave a
  posted line unlinked and post it a second time.
- **R11 The words** (plain, no ids; quantities with trailing zeros trimmed: `3.000` -> `3`, `0.500` -> `0.5`):
  - short, direct section: `{Item}: {need} {unit} sold, {onHand} on hand in {Room}. Receive or count it, then finalize again.`
  - short, recipe section: `{Item}: {need} {unit} needed, {onHand} on hand in {Room}. Receive or count it, then finalize again.`
    (`{unit}` is the item's base unit as stored on the item. A store-wide shortfall keeps the room's figure and
    adds `({storeOnHand} in the whole store)`.)
  - frozen: `{Room} is being counted, so {n} line(s) there wait. Finish or cancel the count, then finalize again.`
  - room: `{Room} can't take usage; fix the mapping for {Item}, then finalize again.`
  - a held flash ends once with: `Or untick a held line to finalize without it.`
  - `{onHand}` below zero is impossible (the trigger); `0` prints as `0`.
- **R12 Screen.** The finalize flash, per outcome:
  - nothing held: `{section}: {n} line(s) posted.` (as today) and the section shows Finalized.
  - something held (error-style flash, because a person must act): `{section}: {n} line(s) posted. Not finalized
    yet, {m} held back: ` followed by the R11 sentences joined with a space.
  - the "finish" button with a held section open cannot occur (`canFinish` needs every unstamped section empty),
    so its messages are unchanged.
  On the page, inside an open section: a posted line shows `posted` and no tick box; an unposted line that would
  be held right now shows its R11 sentence in red in the Status cell (computed live, see Contract
  `pullHolds`); otherwise `pending`. Inside a stamped section an unposted line shows `not posted` (grey), never
  `pending` (that is old data, Q1).

## Contract
`packages/domain/src/pos/usage-holds.ts` (new, PURE, no DB):
```ts
export interface HoldInputLine { readonly key: string; readonly section: 'direct' | 'recipe';
  readonly itemId: string; readonly locationId: string; readonly quantity: string; }
export interface HeldLine { readonly key: string; readonly itemId: string; readonly locationId: string;
  readonly cause: 'short' | 'frozen' | 'room'; readonly need: string; readonly onHand: string;
  readonly storeOnHand?: string; }
/** R1/R4/R4a: which lines of ONE section are held. onHand keyed `${itemId}|${locationId}` (missing = '0');
 *  layerRemaining keyed by itemId (missing = '0'). */
export function decideHolds(lines: readonly HoldInputLine[], onHand: ReadonlyMap<string, string>,
  layerRemaining: ReadonlyMap<string, string>, frozenRooms: ReadonlySet<string>,
  unusableRooms: ReadonlySet<string>): { readonly post: readonly HoldInputLine[]; readonly held: readonly HeldLine[] };
/** R11: one sentence per held (item, room) or per frozen room, in a stable order (room name, then item name). */
export function heldSentences(section: 'direct' | 'recipe', held: readonly HeldLine[],
  names: { item(id: string): string; unit(id: string): string; room(id: string): string }): string[];
export function trimQuantity(q: string): string;
```
Quantity comparison uses `stock/quantity.ts` (`quantity`, `toThousandths`), never floats.

`packages/domain/src/pos/usage-pull.ts`:
```ts
export interface SectionOutcome {
  readonly section: PlanSection; readonly ok: boolean; readonly reason?: string;
  readonly postedLineCount: number;
  readonly held: readonly HeldLine[];     // replaces blockedLineCount
  readonly heldSentences: readonly string[];
  readonly finalized: boolean;            // true only when the section was stamped by this call
}
/** For the page (S2): per unposted line of each UNSTAMPED section, its hold sentence now, or none. Read-only, no
 *  locks. Each section is judged on its own (as one finalize press is); it does NOT subtract another open
 *  section's unposted need, so with two open sections on one item it can under-warn. Documented, not fixed:
 *  finalize re-decides under R3's locks, so the worst case is a hold the page did not predict. */
export async function pullHolds(tx: Tx, orgId: string, pullId: string): Promise<ReadonlyMap<string, string>>;
```
`finalizeSections` order inside the call: existing checks and locks (unchanged) -> rebuild -> direction-1
PLAN_CHANGED (unchanged) -> R8 posted-line check -> R6 closed month (only if something would post) -> per section:
skip posted keys, R3 locks+reads, R4a room read, R4 freeze read, `decideHolds`, per room savepoint post (R5),
`setLineUsageRecord` (R10), stamp only if no holds (R7); any refusal after a write THROWS -> T-377 empty-section
sweep (unchanged) -> pull finalized when all three stamped (unchanged).

`packages/db/src/repo/pos-mapping.ts`: `setLineUsageRecord` returns nothing but throws an internal fault when an
update matches other than one row (R10); `hasPostedLine(tx, pullId): Promise<boolean>` for R9.

## Invariants
1. No line is ever posted twice: a stored `usage_record_id` is final (R8, R10).
2. No write without its link: every posted line is linked in the same transaction, or the call unwinds.
3. A section is stamped iff, after this call, no confirmed line of it is held.
4. A shortfall never moves stock below zero and never fails the call: it is a hold. Only a non-freeze, non-short
   failure fails the call, and then nothing is written.
5. A frozen room is never described as short, a short item never as frozen, an unusable room as neither.
6. A closed stock month posts nothing; it stamps only a section with nothing confirmed left to post.
7. Lock order inside finalize: layers (sorted by item id), then movement rows (sorted by item id, room id), then
   writes. Transfers take only movement rows, so there is no cycle with them. Other `consume()` callers
   (`postUsageRecord`, production) lock layers in their own line order, not sorted, so a deadlock with one of
   them is possible; Postgres aborts one side with 40P01 and that call fails whole, nothing written. Accepted.
8. After a refusal, the call has written nothing: no `ok: false` follows a write in the same call.

## Slices
| Slice | Size | TESTER writes (only these) | BUILDER writes (only these) |
|---|---|---|---|
| **S1 domain + flash** | M-L | `packages/domain/tests/unit/t388-usage-holds.test.ts` (new) · `packages/domain/tests/integration/t388-pull-holds-short-items.test.ts` (new) · `packages/domain/tests/integration/pos-usage-pull.test.ts` (test 10 rewritten to the new rule) · and, **only** to move `blockedLineCount` assertions to `held`/`finalized` (no other edit): `packages/domain/tests/integration/t383-retired-item-usable.test.ts`, `t373-s1-voided-day-writers.test.ts`, `t374-s7-void-pos-usage-pull.test.ts`, `t375-s5-usage-from-feed.test.ts`, `t375-s6-drift.test.ts`, `t377-s2-empty-sections.test.ts` (all under `packages/domain/tests/integration/`), `apps/erp/tests/integration/t374-s7-pos-usage-void-action.test.ts`, `apps/erp/tests/t343-s7-wrapper-refusals.test.ts` | `packages/domain/src/pos/usage-holds.ts` (new) · `packages/domain/src/pos/usage-pull.ts` · `packages/domain/src/index.ts` (export) · `packages/db/src/repo/pos-mapping.ts` · `packages/db/schema/pos-mapping.ts` (header COMMENT only: point 2 and the invariant 9 wording) · `apps/erp/src/app/inventory/pos-usage/actions.ts` (R12 flash) |
| **S2 page** | S | none automated (all logic is S1's `pullHolds`, tested there); the §9.4 smoke below is the gate | `apps/erp/src/app/inventory/pos-usage/lib.ts` · `apps/erp/src/app/inventory/pos-usage/page.tsx` |

S2 starts after S1 is committed. One lane, sequential. Tester red first, for the right reason (bible §3.2).

## Tests (S1). Each names the mutant it kills.
Unit, `decideHolds` / `heldSentences` / `trimQuantity`:
- U1 two lines, one item short in its room: that line held, the other posts. *Mutant: hold the whole room -> red.*
- U2 two recipe lines from DIFFERENT POS items sharing one ingredient (Cheese 2 + 2) in one room, on hand 3:
  both held. *Mutant: per-line check instead of per-(item, room) sum -> red.*
- U2b store-wide: Coke 3 needed in Kitchen, Kitchen on hand 3, layer remaining 2 (layers and movements disagree):
  held as `short` with `storeOnHand` 2. *Mutant: room check only -> posts, and consume() refuses, red.*
- U2c a room in `unusableRooms` holds its lines as `room`, even when also frozen and short. *Mutant: precedence
  wrong -> red.*
- U3 same item, two rooms, one room short: only that room's line held. *Mutant: key by item only -> red.*
- U4 on hand exactly equals need: posts. *Mutant: `<=` for `<` -> red.*
- U5 frozen room with stock: held as `frozen`; frozen AND short: `frozen`. *Mutant: shortfall checked first -> red.*
- U6 sentences word for word for direct (with unit), recipe, store-wide, frozen and room; the closing untick
  sentence once; `3.000`->`3`, `0.500`->`0.5`, `0.000`->`0`; stable order.
Integration (real Postgres), `finalizeSections`:
- I1 **DEF-618 itself**: Kitchen has Coke 0 and Cheese 10; sold Coke 3, Cheese 2. Cheese posts (10 -> 8), Coke
  held, outcome `{ postedLineCount: 1, held: [coke], finalized: false }`, `direct_finalized_at` null, pull
  `planned`, sentence `Coke: 3 {unit} sold, 0 on hand in Kitchen. Receive or count it, then finalize again.`
  *Mutant: today's code (whole room blocked, section stamped) -> red.*
- I2 re-finalize after receiving 5 Coke (rebuild the plan first if the snapshot is stale): Coke posts (5 -> 2),
  Cheese is NOT posted again (still 8, one OUT movement for cheese), section stamped. *Mutants: posted keys not
  skipped -> cheese 6, red; stamp before re-check -> red.*
- I3 **room-only shortfall**: store holds 10 Coke in Storage, 0 in Kitchen; sold 3 from Kitchen. Call returns
  ok with Coke held (`0 on hand in Kitchen`), other lines post, and the transaction COMMITS (no deferred-trigger
  failure). *Mutant: store-wide check instead of room on-hand -> commit fails, red.*
- I4 frozen room: rewritten T-177 test 10: Display posts, Kitchen's line held as frozen, section NOT stamped;
  cancel the count, finalize again, Kitchen posts, section stamped. *Mutant: stamp regardless -> red.*
- I5 closed stock month for the business date: `{ ok: false, reason: <closed-month sentence> }`, no movement, no
  record, no stamp. *Mutant: drop R6 -> today's swallow stamps the section, red.*
- I5b R6 escape: I1's state, then the month closes; finalize again with Coke unticked: ok, nothing posted,
  section stamped. *Mutant: R6 refuses unconditionally -> red.*
- I5c R6/Inv 8: finalize `['direct','recipe']` where direct posts and recipe then meets a refusal: the call
  throws and direct's posting is gone (no movement, no record). *Mutant: `return { ok: false }` after a write ->
  direct's record survives, red.*
- I6 an unexpected throw inside the savepoint fails the whole call; nothing stamped, no record. Force it by fixture
  SQL that removes the org's 1310 inventory GL account before finalize (every item kind has an account,
  `receipt-posting.ts:63`, so a kind cannot be used). *Mutant: keep the bare catch -> red.*
- I6b R4a: a direct map whose room override is a storage room: that line held with the `room` sentence, other
  lines post, call ok. *Mutant: no room read -> the trigger throws and the call fails, red.*
- I6c R3 row lock: in a second connection, start a transfer of Kitchen's Coke and hold it open after its
  `onHandForUpdate`; finalize blocks until it commits, then holds Coke as short and commits cleanly.
  *Mutant: plain `onHand` -> finalize reads the old figure and its commit fails on the deferred trigger, red.*
- I6d one call `['direct','recipe']`, Cheese 2 direct + 2 recipe, 3 on hand: direct posts (3 -> 1), recipe's
  Cheese held. *Mutant: on-hand read once for the call, not per section -> both post and the commit fails, red.*
- I7 R8: post part of a recipe section, then edit the recipe so ingredient index 0 is a different item, rebuild,
  re-finalize: refused with the R8 sentence, nothing new posted; and the stored posted line names the item that
  actually posted (R10). *Mutants: no posted-line check -> red; R10 writing only quantity and record id -> the
  stored line names the plan-time item, red.*
- I8 R9: post part of a section, then store a newer sold_items feed with different quantities, rebuild: refused
  with `partlyChanged`. *Mutant: pin rule keyed only on stamps -> rebuild re-pins, red.*
- I9 R10: a posted line whose key has no stored row (call `finalizeSections` with a confirmed key present in the
  rebuild but deleted from `pos_usage_pull_lines` by fixture SQL) -> internal fault, nothing written; and after a
  normal post, the stored line's `item_id`/`location_id` equal the posted usage line's. *Mutant: best-effort
  update -> red.*
- I10 `pullHolds` returns the I1 sentence for Coke's key before receiving and nothing after. *Mutant: reads the
  stamp instead of live stock -> red.*
- I11 unticked lines do not hold: section with one unticked line and every ticked line in stock is stamped.
  *Mutant: count unticked as held -> red.*
- Every existing caller's suite stays green (the eight files in the S1 tester row plus `pos-usage-pull.test.ts`); a void of a partly posted, unstamped pull reverses exactly the
  posted records (add as I12 in the new file). *Mutant: void reads only stamped sections -> red.*

## §9.4 smoke (S2, on 9008)
Kitchen with one item at 0 and one in stock, a day selling both: finalize direct -> red flash names the short
item in words, page shows the posted line `posted` without a tick box and the held line's sentence in red;
receive the short item; rebuild if stale; finalize again -> green flash, section Finalized. Screenshot both.

## Migration
None. Holds are computed, not stored; `*_finalized_at` keeps its column and changes only when it is written.
No precheck and no backfill: old stamped sections are left as they are (Q1).

## Out of scope
- Re-opening or repairing sections stamped under the old behaviour (Q1).
- Auto-posting after verify / one-click post after a count (row 282 Q-A end state; the unified-backend redesign).
- Partial posting of one line; negative stock; any change to `consume()`, the triggers, or `voidPosUsagePull`.
- Mapping the raw `stock_movements_no_negative_on_hand_trg` text in `constraint-messages.ts` (after R3 the
  pull cannot reach it; other callers are their own tasks).

## Done when
S1 and S2 committed; S1's tests red-then-green with the named mutants; all nine suites that call
`finalizeSections` green (S1 tester row plus `pos-usage-pull.test.ts`); typecheck
clean; §9.4 smoke screenshots; `npm run build` with the dev server stopped; DEF-618 marked fixed in the register
and a bible §13 row recording R7 (finalized = nothing confirmed left unposted, frozen rooms included) and
superseding T-177 invariants 4 and 9 (orchestrator/planner, not the lanes); Q1 answered.

## Questions only Ian can answer
**Q1 (`t388-q1-old-dropped-lines`, priority medium). Sections finalized before this fix may have lost lines.**
Example: a day where Coke was short; the whole Kitchen's usage never posted, and the section says Finalized.
Options: **(a, recommended) leave them as they are**: any physical count since then already put on-hand right,
so posting them now would count that usage twice; a manager who wants one recent day fixed (no count since,
stock month open) can already Void the pull and build it again, which now posts under the new rule.
(b) build a "re-open section" action that posts the missing lines (new code; it cannot tell a dropped line from
one a person deliberately unticked, so it would need a person to choose line by line).
Count on production first (READ ONLY; an upper bound, because an unticked line looks the same as a dropped one;
a room where every line is unposted while other rooms posted is the DEF-618 signature):
```sql
BEGIN READ ONLY;
SELECT st.name AS store, sd.business_date, l.section, loc.name AS room,
       count(*) AS unposted_lines, p.id AS pull_id
FROM pos_usage_pulls p
JOIN pos_usage_pull_lines l ON l.pull_id = p.id
JOIN sales_days sd ON sd.id = p.sales_day_id
JOIN stores st ON st.id = p.store_id
LEFT JOIN stock_locations loc ON loc.id = l.location_id
WHERE p.status <> 'void'
  AND l.usage_record_id IS NULL AND l.blocked IS NULL
  AND l.item_id IS NOT NULL AND l.quantity > 0
  AND ((l.section = 'direct' AND p.direct_finalized_at IS NOT NULL)
    OR (l.section = 'recipe' AND p.recipe_finalized_at IS NOT NULL))
GROUP BY st.name, sd.business_date, l.section, loc.name, p.id
ORDER BY sd.business_date, st.name;
ROLLBACK;
```

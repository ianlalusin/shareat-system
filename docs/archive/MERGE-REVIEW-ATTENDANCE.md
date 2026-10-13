# Merge review — `attendance`, and what the inventory lane must fix first

> **Reviewed 2026-08-30 by `ianla-e7`.** Full gates run on an **isolated database**
> (`shareat_test_attn`, created and dropped for this review) so the inventory lane's `shareat_test`
> was never touched. Browser verification on port 9008 against a throwaway seeded dev database,
> both since dropped and the port released.
>
> Supersedes `docs/MERGE-CONSOLIDATION.md` (2026-08-29) where they disagree. **One conclusion in
> that document is now reversed — §3.**

## 1. ✅ Verdict: `attendance` is merge-ready, after two mechanical fixes

Every gate run green at `d339e2a`, from a **fresh database** — which matters more than it sounds,
because it proves all 90 migrations apply from nothing rather than only incrementally:

| Gate | Result |
|---|---|
| `typecheck` | **0 errors** |
| `npm test` (unit) | **696 passed, 1 skipped** — the skip is a *conditional* golden-master guard with a named reason, not a disabled test |
| `npm run test:integration` | ⭐ **1360 passed, 50 files**, on a database created empty for this review |
| `npm run build` | **clean** |
| Migrations | **90 applied to an empty database in 1.4s**, no skips |
| Browser | `/sign-in` ✅ · `/attendance/lane` ✅ · `/clock` ⚠️ needs config (§5) |

**Trial merge into `main`:** two conflicts, both mechanical — `docs/DEFECTS-REGISTER.md` and
`packages/db/migrations/meta/_journal.json`. **No source-code conflict.**

## 2. ⛔ BLOCKER — six task numbers collide with the inventory lane

Both lanes marched into the same band. The files have different names, so **git merges both without
complaint** and the project is left with two tasks under each number:

| # | `attendance` | `main` / `inventory` |
|---|---|---|
| **T-153** | firestore-two-lane-spike | standing-till-float *(on `main` already)* |
| **T-160** | lane-a-publisher | stock-locations-and-rooms |
| **T-161** | lane-b-ingestor | stock-ledger-and-balances |
| **T-162** | quarantine-and-lane-health | fifo-cost-layers |
| **T-163** | offline-clock-terminal | receipt-posts-value |
| **T-164** | credential-enrolment-and-mirror | consumption-wastage-and-variance-postings |

⭐ **`attendance` should move, not `inventory`** — and the reason is availability, not merit.
Inventory holds T-160–T-179 and is **still being written**; renumbering a lane mid-flight is how you
get a half-renamed tree. Attendance is finished and frozen, so its rename is safe.

**Suggested: the six move to T-180–T-185**, keeping 154–159 (which collide with nothing) where they
are. ⚠️ Each is referenced by its own commit messages, `docs/plans/phase-4-attendance.md`, and in
T-153's case `spike/firestore-two-lane/README.md`.

## 3. ⭐ REVERSED — the migration-timestamp fault is INVENTORY's, not attendance's

`docs/MERGE-CONSOLIDATION.md` §2 implied attendance should re-timestamp. **That was wrong.**

Drizzle applies a migration only when `entry.when > lastApplied.when` (DEF-039), and the journal is
walked in `idx` order. So `when` must rise with `idx`. Simulating the merged journal, **10
migrations are silently skipped** — the entire attendance table set.

**But attendance is the branch that got it right:**

```
inventory  idx 69  when=1792035107084
attendance idx 80  when=1792985507084   ← correctly ABOVE inventory's idx 69
inventory  idx 70  when=1793849507084   ← JUMPS +21 days, over attendance's whole block
inventory  idx 71  when=1793935907084
inventory  idx 72  when=1794022307084
```

Attendance reserved **both** a number block (0080–0089) **and** a matching timestamp block above the
incumbent — exactly what the rule requires. Inventory's `idx 70` then jumped to land one day above
attendance's `idx 89`, which looks like an attempt to avoid collision and **inverts the idx↔when
relationship instead**. A lower `idx` now carries a higher `when`, and the idx-ordered scan skips
everything after it.

### ⛔ The fix belongs to the inventory lane

Its `idx 70, 71, 72` must continue from `idx 69` — below attendance's `idx 80`:

```
idx 70 → 1792121507084      idx 71 → 1792207907084      idx 72 → 1792294307084
```

⭐ That leaves `idx 73–79` free with room to spare beneath attendance's block — **seven idx slots,
seven days of headroom.** Attendance's reservation was sized correctly; there is space for inventory
to grow into without ever touching it.

⚠️ **Nothing breaks until both branches are on `main` together**, so `attendance` can merge first
safely. But the inventory lane must fix this before *it* lands, or the attendance tables will simply
never be created on a fresh database — and every test that ran incrementally will still pass.

## 4. ⚠️ All 13 attendance task docs still say "Spec written"

`153` through `164` all carry `Status: Spec written 2026-08-29/30 by the Opus planner`, and T-163's
four *Done when* boxes are unticked — **although the work shipped.** T-163's commit body documents
all four browser assertions with what was observed, so the gate is genuinely met; only the document
lags.

⭐ This is the same defect class the 2026-08-28 session already fixed once ("five task docs said SPEC
after they shipped"). It is cosmetic on its own and corrosive in aggregate: the next reader cannot
tell built from planned without reading 38 commit messages.

## 5. ⚠️ `/clock` cannot start without five Firebase variables — a deployment prerequisite

`/clock` returns **HTTP 200 and renders a runtime-error screen**:

> *`NEXT_PUBLIC_FIREBASE_PROJECT_ID` is not set. The terminal cannot open its offline store without
> a project id — see `.env.example`.*

**Not a defect.** All five `NEXT_PUBLIC_FIREBASE_*` keys are present-but-empty in this machine's
`.env.local`; the terminal is the offline lane and genuinely needs Firestore. It fails loudly, early,
and points at the file that explains it — which is the right behaviour.

⛔ **But it is worth stating plainly because a green build hides it entirely:** on any machine or
environment without those five values, the clock terminal is a crash screen. That includes CI, and
it will include the tablets on day one if the deploy does not carry them.

## 6. ⭐ Quality: this is the strongest branch of the three

Two things worth Ian's attention rather than an agent's.

**DEF-088 is about real money.** *"v1 pays for shifts nobody worked — 40.4 excess hours in one month
across two stores,"* measured over 550 real sessions. `lipa-0319`: present **1.6 minutes, paid 5
hours**. The mechanism is named precisely — late-arrival crediting × hour-flooring, neither wrong
alone — which is what makes it fixable rather than merely alarming.

**Two bugs only a browser could find**, both in the offline path the feature exists for:

1. `await setDoc(...)` **hangs forever offline** — the promise resolves on *server* acknowledgement,
   though the local write is already durable. The cashier taps a badge, nothing happens, they tap
   again. It appears *only* when the network is down.
2. The pending count never reached zero — a one-shot `getDocs` that also counted the wrong thing. Now
   a live listener with `includeMetadataChanges`, without which it never fires at all, because
   acknowledgement changes metadata rather than data.

⭐ `/attendance/lane` renders with real care. *"Punches in from terminals: **Not measured** — no relay
has reported yet. **This is not the same as 'nothing is waiting'.**"* A counted zero told apart from
an unknown, which is the same distinction `noSalesChannelIds` makes on the sales day.

## 7. Recommended sequence

```
1. attendance renumbers T-153/160/161/162/163/164 → T-180–T-185, and refreshes its 13 status lines.
2. attendance merges main (it is 11 behind), resolves its own two registry conflicts, reports green.
3. MERGE attendance → main.
4. inventory fixes its idx 70-72 `when` values (§3) — required before it lands, not before attendance.
5. lane/t137 renumbers DEF-084/085/086 (still colliding, branch idle 8h) and sets the capability count.
```

⚠️ **`lane/t137-discount-logbook` is unchanged since yesterday** and still carries the three duplicate
DEF ids `MERGE-CONSOLIDATION.md` §2 named. Its DEF-084 also still invalidates bible rows 131–132 on
`main` (§5 there), which remains an Opus-planner job.

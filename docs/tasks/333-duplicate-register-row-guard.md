# T-333 — nothing asks whether a register row is NEW, and tonight that cost a near-miss

**Status:** ⚠️⚠️ **PROPOSED, NOT APPROVED AND NOT SPECCED. AWAITING IAN.** Written 2026-09-20 by the
orchestrator (`system32-df`) to reserve the number and record the evidence while it is fresh.
⛔ **Nobody builds this until Ian rules.** RULES §13 row 163: a feature is **assessed** before it is
planned, and recommending against is sanctioned — so the assessment is §3 and it is honest about
the case against.
**Migration slot:** none. **Depends on:** nothing.

---

## 1. What happened, because the proposal is only as good as the evidence

2026-09-20, this session filed **DEF-405**: a freshly bootstrapped store has no
`store_attendance_config` row. It was measured properly — `count(*)` returning 0, and
`/settings/attendance` rendering a store picker and nothing else in a real signed-in browser.

**It was a duplicate of DEF-249**, filed eleven days earlier, still open, with two discovery
documents behind it. It was caught by a lane that had been sent to verify something else entirely
and volunteered it.

⛔ **The register was never grepped.** A real thing was measured, confirmed in a browser, written
into a task spec and committed, without one search for `attendance_config` across
`docs/DEFECTS-REGISTER.md`.

⭐⭐ **And every guard in the room was pointed the other way:**

| Guard | What it asks | Would it catch a duplicate? |
|---|---|---|
| `register-row-shape` | is the row well-**formed** — pipe count, escaping | ⛔ no |
| `document-facts` | do documents **agree** with each other | ⛔ no |
| `callers.mjs` / `gates.mjs` | does the **code** hold together | ⛔ no |

**A duplicate register row passes every gate this repository has**, and the register is long past
the size where a person holds it in their head.

## 2. ⭐ The near-miss is the actual argument, not the duplicate

A duplicate row is untidy. **What it nearly cost is not.** DEF-249 carries two live consequences a
fresh row knows nothing about, both on the same table:

- **DEF-251** — the attendance sweep `INNER JOIN`s on the config, so an unconfigured store is not
  in the population at all and the job reports **clean success**. ⚠️ That is the exact quiet-failure
  shape T-332's detector is being built to avoid — already shipped, one table away, and invisible
  to anyone starting from a new row.
- **DEF-256** — T-197's short-shift overtime decision has **never reached a single store** through
  the same hole.

⛔ **T-332 was about to be built without either.** The cost of a duplicate is not the row; it is
**re-solving a problem while its known consequences sit unread.**

## 3. The assessment — including the case against

**Expected utilisation:** every new defect filing, which in this repo is several a week.

**The case against, stated first because it is real:** the register rows are enormous prose, the
vocabulary overlaps heavily (half of them mention a table name), and a naive similarity check would
produce false matches constantly. ⛔ **A guard that cries wolf gets routed around, and then it is
worse than nothing** — it consumes attention and supplies false assurance. This is the failure mode
to design against, not the misses.

**What makes it tractable anyway:** the check does not need to understand prose. Tonight's duplicate
shared two exact, rare, load-bearing identifiers with the row it duplicated —
`store_attendance_config` and `seedAttendanceConfig`. **Matching on code identifiers rather than
English is a much narrower and much cheaper question**, and it is the one that would have fired.
⚠️ **Note the irony and do not repeat it: DEF-403 in this very repo is two guard scripts counting
English as code.** This guard must do the reverse deliberately — read code identifiers and **ignore
the prose** — or it becomes the same defect wearing a different hat.

**Recommendation: build it, small, as a report — but Ian's call.**

## 4. Shape, if approved

1. Extract from each register row the **code identifiers** only — backticked symbols, file paths,
   table names. Not words.
2. On a new or changed row, report existing rows sharing rare identifiers, ranked.
3. ⛔ **REPORT, NEVER REFUSE.** A genuine duplicate filing is sometimes correct — a retraction, a
   correction, a deliberate re-file. **The guard must not be able to block one**, or the next person
   routes around it and it is worse than absent. A human dismisses it in one second; that is the
   whole interaction.
4. ⚠️ **It must not fire on a row that CITES another** — cross-references are the register working
   as intended, and a guard that punishes them would teach people to stop writing them.

## 5. Out of scope

- ⛔ Prose or semantic similarity. §3 — that is the version that cries wolf.
- ⛔ Any automatic edit, merge or refusal.
- ⛔ Retrofitting the existing register. Tonight's pass may well surface historical duplicates; ⚠️
  **finding them is not the same as being asked to merge them**, and merging old rows silently
  rewrites decisions nobody re-made.

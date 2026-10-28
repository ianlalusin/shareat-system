# T-398 S6 — questions

Nothing here blocks the build: each item has a default S6 builds, and changing it later is a one-line change.

## For Ian (plain words; goes on the Open Questions page)

### QI-1 — Which of Padre Garcia's sales days may you see?

A sales day goes open → submitted (cashier closed it) → verified (manager checked it). Royalties should come from
checked figures.
- **(a) Every day except voided ones, each marked with its status; the totals count verified days only.** You see
  today's numbers as they come in, clearly labelled "not yet checked". (Default S6 builds.)
- **(b) Verified days only.** You never see a figure PG has not checked, but you see nothing for the last day or two.
- **Recommended: (a).** Nothing extra of PG's business is shown, the totals stay honest, and you can spot a day PG
  forgot to verify (row 399: an unverified day also blocks PG's month-end).

### QI-2 — How PG was paid: kinds or accounts?

- **(a) Cash / online / on credit totals per day.** (Default.)
- **(b) Also which account the money went into** (e.g. "GCash-cashier", "BDO-office").
- **Recommended: (a).** (b) shows PG's bank arrangements, which is beyond "sales" in your Q2 answer.

## For the orchestrator / planner to rule (not Ian)

| Id | Question | Default S6 builds | Why |
|---|---|---|---|
| **QO-1** (K1) | The database check on who may read: role only (spec A5) or role **or** the grant | role `super_admin` **or** an active person-level `view_franchise_sales` grant | Production Ian is `admin` + grants; role-only refuses him |
| **QO-2** (K2) | Sales result shape | one function, `row_kind` day/channel, fixed columns; payment split by kind | one call = one log row; the catalog leg still pins every column |
| **QO-3** | Can `view_franchise_access_log` be granted to a staff member? | No: `ROLE_ONLY_CAPABILITIES` | keeps the matrix's staff ✗ true; managers hold it by role |
| **QO-4** (K4) | Break-glass sign-in: callable definer (A5) or a trigger on `sessions` | trigger | the database writes it on all three sign-in paths; nothing to forget or forge |
| **QO-5** (K10) | Agreement writes and `scope` column | app SELECT only; S7 writes as owner; no `scope` | Q2 (b) fixed the scope; no app path should change who may look |
| **QO-6** | Before `sales_visible_from` / ranges over 366 days | refused in words, no log row | spec V6 left it to the builder; a refusal is testable and never silently hides days |
| **QO-7** | Log classification | `keep` (both tables) | the append-only trigger would refuse a purge; the owner is owed the history |
| **QO-8** | Spec text now stale | A5 "super_admin role" → QO-1; B3's two sign-in paths → three; R6 "sales only" in the matrix; A5's `CROSS_ORG_BY_DESIGN` entry → composites (K6); `scope`/`log_break_glass_sign_in()` dropped; size 2.3 → 2.7 | fold as amendments when S6 merges |

## Orchestrator rulings (28 Oct)
- QO-1 to QO-8: APPROVED as the defaults above (role super_admin OR an active view_franchise_sales grant; one sales
  function with row_kind; view_franchise_access_log role-only; break-glass sign-in by a trigger on sessions; app
  SELECT-only on agreements, no scope column; out-of-range requests refused in words with no log row; both log tables
  `keep`; QO-8's stale spec text folded into the spec by the orchestrator at merge).
- QI-1 and QI-2 go to Ian; S6 builds the stated defaults meanwhile (unchecked days visible and labelled, totals from
  checked days only; payments by kind, never by account).
- S6c audit (28 Oct): CLEAN. Noted, not changed: if the approval log write itself fails, the approval fails closed
  (raw error, and it counts as a wrong-PIN miss) - accepted for an audit log the owner is owed; a friendlier sentence
  can come with S6d. The capability-list drift is already pinned (tests/unit/t398-s6-approval-capability-list.test.ts).

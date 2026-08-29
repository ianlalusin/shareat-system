# T-183 — The quarantine screen, and whether the lane is actually working

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> ⚠️ **RENUMBERED 2026-08-30: was T-162.** Both this lane and the inventory lane had taken T-162; attendance moved because it is finished while inventory is still being written. ⛔ **Commit messages predating the rename still say T-162** — git history is not rewritten.
> **Depends on:** T-181 (outbox), T-182 (quarantine).
> ⚠️ **This is the first task in Phase 4 with a user interface**, so it is also the first that needs
> the dev server — **port 9008 is not this lane's, and Ian is asked before it starts.**

## Why this is a task and not a nice-to-have

Landmine #14 is the only landmine in bible §12 whose structural fix is *a screen*:

| The failure | How v2 prevents it structurally |
|---|---|
| *"Offline punches dead-letter silently; no in-app reconciliation UI, recovery is 'tell a manager'"* | *"Inbox quarantine is a **first-class screen**, alertable, with a defined operator action (§5.4 rule 5)"* |

v1's whole recovery path is `OfflineBanner.tsx:33` telling staff *"N failed — tell a manager"*, and
discovery 05 confirms there is nothing for the manager to then open. ⭐ **A quarantine nobody can
read is a dead letter with better manners.**

## Goal

A manager can see every event that did not make it, understand why in one sentence, and do exactly
one of two things about it — and can tell at a glance whether the lane itself is healthy.

## Scope

**Create:** `apps/erp/src/app/attendance/lane/page.tsx` and its components ·
`packages/domain/src/sync/health.ts` · integration tests.
**Modify:** the domain barrel · the ERP nav.
**Out of bounds:** the ingestor and publisher themselves — this task reads and resolves, it does not
re-implement.

## Contract

### 1. Two questions, one screen

⭐ The screen answers **"is the lane healthy?"** above **"what is stuck?"** — because a manager who
only ever sees a list of failures cannot tell a bad hour from a broken week.

| Panel | Shows |
|---|---|
| **Lane health** | Oldest unpublished outbox row · oldest un-stamped inbox event · terminals by `lastSeenAt` · quarantine count by reason |
| **Quarantine** | One row per stuck event: staffer (if resolvable), terminal, when it happened, when it arrived, the reason **in a sentence**, and the raw body behind a disclosure |

### 2. ⛔ Exactly two operator actions, and both are recorded

Bible §5.4 rule 5 asks for *"a defined operator action"* — singular and defined, not a toolbox.

| Action | What it does |
|---|---|
| **Retry** | Re-runs the ingest checks for that event. ⭐ Usually the whole fix — an event quarantined as `unknown_credential` ingests the moment the staffer is enrolled |
| **Discard** | Marks it `resolved: discarded` with a **required reason**. The row survives forever; nothing is deleted |

⛔ **There is no "edit the event".** The raw event is a fact from a device. Correcting attendance is
what `manual_entry` punches (T-156) and adjustments (T-158) are for, and both attribute the human
who did it. An editable inbox would be a second, unattributed write path into payroll.

### 3. The reason, in a sentence a manager can act on

A code is for the database. The screen renders the action:

| Code | What the manager reads |
|---|---|
| `unknown_credential` | *"No staffer at this store matches this card. Enrol them, then Retry."* |
| `revoked_device` | *"This terminal was revoked on 12 Aug. Re-provision it, or discard."* |
| `method_disabled` | *"Card clock-in was switched off for this store on 12 Aug. Turn it back on and Retry, or discard."* |
| `malformed` | *"This device sent something we could not read. Show the raw event."* |
| `store_mismatch` | *"This terminal belongs to Lipa but the event claims Malvar."* |
| `future_timestamp` | *"This device's clock is ahead. Fix the clock, then Retry."* |

### 4. Health thresholds — named, not magic

```ts
export const LANE_HEALTH = {
  outboxLagWarnMinutes: 15,
  inboxUnprocessedWarnMinutes: 15,
  terminalSilentWarnHours: 26,   // ⭐ longer than a day, so a store that shut early is not "down"
} as const;
```

⚠️ **First cuts, and they are exported constants so they can be argued with rather than found.**
`26` is deliberate: 24 would fire every time a store closed an hour early.

### 5. Authorization

Reading is `manage_attendance`. Retry is `manage_attendance`. ⛔ **Discard is
`provision_clock_terminal`** — the T-159 capability — because discarding is the only action here
that can *lose* a real shift, and it should sit with whoever is trusted with the terminals. Naming
it rather than defaulting to the same capability as everything else.

## Invariants

1. A quarantined event is visible to a manager of its store, and to nobody else's.
2. Retry re-runs the real ingest path; a healed event disappears from the list and appears as a punch.
3. Discard requires a reason and never deletes the row.
4. A discarded event is not retried by the next ingest run.
5. Health warns when the oldest unpublished outbox row is older than the threshold.
6. A terminal silent past its threshold is listed, and one that closed early is not.
7. The raw event is viewable, and shown as received.
8. Nothing on the screen can edit an event.
9. ⭐ **Smoketested in the running app** (bible §9): a real quarantined event, retried, becoming a
   real punch — because a green build and green tests have already shipped an app that could not
   start.

## Tests

Integration for the domain half. UI verified in a browser per the `verifying-ui-in-a-browser` skill
— ⚠️ *a green build is not evidence a screen renders.*

## Out of scope

**Alert delivery** (email/push) — the condition is computed here; where it is *sent* is a Phase 6
concern with its own decisions · **Bulk retry** — retry is per-event until there is evidence a
manager needs more; a bulk button is the easiest way to discard fifty real shifts by accident ·
**Editing events** — §2 · **Retention** — needs Ian's number.

## Done when

- [ ] All nine invariants pass.
- [ ] ⚠️ **Ian was asked before the dev server started** — port 9008 is not this lane's.
- [ ] Smoketested in the running app, with the screenshot or the observed behaviour reported.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green, dev server
      stopped before the build.

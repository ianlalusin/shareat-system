# T-264 — DEF-284: give the period lock a way to be armed, and an override only admins hold

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⚠️ **THREE SEPARABLE SLICES, AND SLICE 1 IS NOT ABOUT LOCKING AT ALL.** Slice 1
> fixes a failure happening today; slices 2 and 3 build the control Ian asked for. **Do not attempt
> all three in one change** — each has a different shape and a different risk.

## The situation, in one paragraph

The database already enforces the rule correctly. `fiscal_periods` exists with
`status in ('open','closed','locked')`, and the period-open trigger (migration `0003`, bible §16.1
invariant 7) refuses a posting into a closed period **by any path**. ⛔ **But `fiscalPeriods` is
read-only across the entire codebase** — `packages/db/src/repo/journal.ts` only ever `SELECT`s it.
There is no repo writer, no domain function, no server action, no screen and no job that creates a
period or closes one. **The wall is built and enforced, and nobody has been given a way to raise
it.** Anyone with posting rights can back-date into January in June.

⭐ **The symptom is already on screen and has been read as mundane.** `fixed-assets/page.tsx:85` and
`components/scheduler-status.tsx:78` both carry the stock failure *"no fiscal period covers …"* —
that is depreciation failing because **no period row exists at all**, not a date edge case.

## Ian's decision, 2026-09-10 — the WHAT, not open to revision

> A **lock with an override**, and the override is restricted to **`admin` and `super_admin` only**.
>
> The close happens on **the 15th of the following month**, because some sales channels remit up to
> the second week. ⭐ **That makes the 15th a PROMPT FOR A HUMAN, not a trigger** — *"did the
> remittance actually arrive"* is a judgement a timer cannot make. Do not schedule the close.

Both roles already exist: `person_roles_role_check` in migration `0014` is
`('super_admin', 'admin', 'manager', 'staff')`.

---

## Slice 1 — something must CREATE fiscal periods

**Ship this first and alone. It is not about locking and it fixes a live failure.**

Nothing inserts `fiscal_periods` rows, so depreciation fails today with *"no fiscal period covers
…"* for any org whose periods were never hand-inserted.

- Decide and state: are periods generated per org on demand, seeded ahead for a year, or created at
  org bootstrap? ⚠️ **Say which and why** — this is a data-shape decision that is expensive to undo.
- ⚠️ Periods are **org-scoped**. Check what `bootstrap-org` does today and whether it should own this.
- ⚠️ The period must cover the dates depreciation posts to — `endOfPeriod(period)` is the date the
  runner uses. A period that exists but does not span that date fails identically.

## Slice 2 — a way to CLOSE one

- A surface for a holder of the **`close_period`** capability. ⚠️ That capability already exists and
  is authorised in two places (`findings/index.ts:184`, `sales-days/create.ts:266`) — **for other
  actions, never for closing a fiscal period.** Reuse it; do not invent a second name.
- `closed_at` and `closed_by` (→ `persons`) already exist on the table and are unwritten. Write them.
- ⚠️ **Closing is a human action prompted on the 15th, never scheduled.** See Ian's ruling above.
- ⭐ Consider what "ready to close" means and surface it — that is the useful half for the person
  deciding, and it is the reason the 15th exists.

## Slice 3 — the override, and it has a sanctioned pattern already

⛔ **DO NOT INVENT A MECHANISM. This schema already has one and it must be reused.**

Migration `0005` exempts reversal postings from a comparable rule using a **transaction-local GUC**:

```sql
is_reversal_context := coalesce(current_setting('app.reversal_posting', true), '') = 'on';
```

⭐ **Why that shape is the right one, and it is the whole reason it is safe:** `set_config(..., true)`
is transaction-local, so it cannot leak into the next request on a pooled connection; and the
`coalesce(..., '')` means **an unset GUC reads as NOT exempt**. A bug, a crash, or a forgotten line
can only ever fail *closed*. Build `app.period_override` the same way.

- The GUC is set **only after `authorize()` has confirmed the role** — never from a caller-supplied
  parameter (bible §7.1, landmine 17: *"who approved this" is a value the caller chose*).
- ⛔ **Do NOT implement the override in TypeScript around the trigger.** RULES §6 item 3 and bible
  §6.3: the database enforces period rules; a second copy in the service layer is a second source of
  truth and the two will drift. The trigger gets the exemption; the app decides who may set the flag.
- ⭐ **An override without an audit row is a hole with better manners.** Record who overrode, which
  period, which entry, and **why** — a typed reason, not a boolean. Check whether an existing audit
  table fits before adding one.

---

## Watch out

- ⚠️ **`close_period` is a CAPABILITY, and Ian named ROLES.** Decide deliberately whether the
  override checks the role directly or a new capability granted to those roles, and say which. This
  codebase deliberately expresses these as capability questions — `sales-days/create.ts:258` says so
  in terms: *"Deliberately expressed as a CAPABILITY question, not a role check."* ⛔ Do not
  contradict that without stating why.
- ⚠️ **Reversals of entries in closed periods are legitimate and already handled** (migration `0003`
  lines 202-208: *"reversals of entries in already-closed periods are the primary real-world use of
  a reversal"*). Your override must not disturb that path or duplicate it.
- ⚠️ `status` has **three** values — `open`, `closed`, `locked`. Say what `locked` means here and
  whether this task touches it. Do not silently treat it as a synonym for `closed`.
- ⛔ Any schema change is a **hand-authored migration** (RULES rule 9, ADR-012 §5, `npm run
  db:generate` is retired and fails closed). One migration slot per lane per cycle.

## Out of scope

- **T-263** — the `lastCompletedPeriod()` timezone fix. Different defect, do not fold it in.
- Moving the month-end timer. Ops change, Ian's, and it is sequenced after T-263.

## Done when — per slice, and each ships on its own

- The slice's decision is stated in writing before code, with what would have to be true for it to
  be wrong.
- typecheck clean · unit green · **integration green against real Postgres** · smoketested in the
  running app on 9008 · `npm run build` succeeds with the dev server stopped · self-reviewed.
- ⛔ **Slice 3 must be watched failing first**: an override attempt by a `manager` must be REFUSED by
  the database, and the refusal must be observed before the exemption is wired, not reasoned about.
- The report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-284, DEF-249, DEF-260; `PROJECT_BIBLE.md` §16.1 invariant 7,
§7.1, §12 landmine 17; migrations `0000` (table), `0003` (the trigger), `0005` (the exemption
pattern), `0014` (the roles).

# Handoff — 2026-09-01

## Where things stand

**Three tasks shipped, and one required going back to fix another one.** The session began by
correcting a false premise in yesterday's handoff — the production droplet has never had the app
deployed to it at all — then built the attendance/payroll settings screen, 13th-month pay, and a
first slice of separation/final-pay/clearance. Building the third forced a real fix to the second:
without it, a departed employee's 13th month would have been paid twice.

## Gates at `6d16fdc`

```
typecheck   ✅ exit 0
unit        ✅ 879 passed, 1 skipped (880)
integration ✅ 1797 passed (1797)
build       ✅ exit 0, dev server stopped first
```

Verified at `038590f` (the last code commit) immediately before that commit; nothing code-facing
changed since — `6d16fdc` is docs only (task-spec status lines, `docs/ROADMAP.html`).

## What happened this session

### The deploy that never happened

Item 1 in yesterday's handoff said "install the sweep timer on the droplet." Read-only SSH
inspection of `159.223.78.207` found **the app has never been deployed there at all** — no
`/srv/shareat`, no `shareat` OS user, no shareat-system systemd units, no CI deploy step. Matches
ADR-005/ADR-007: pilot go-live is Oct–Dec 2026, not now. Corrected in `docs/ops/README.md` and
(at the time) `docs/HANDOFF-TODAY.md`, so nobody acts on the stale framing. **Production was left
untouched** — Ian confirmed correcting the record over scoping or executing a first deploy.

### T-201 — attendance & payroll settings screen

`/settings/attendance`. Turned `supersedeConfig` (T-155, already built and tested) into a form —
until now the only way to change a policy value was an engineer hand-writing SQL, which cost real
time twice last week (T-197, DEF-119). No schema change, no migration. Smoketested live: save,
`/payroll`'s summary line picking up the new value, the backdating rejection, the nullable
`autoClockOutHour` staying blank rather than coercing to 0.

### T-191 — 13th-month pay

`/payroll/thirteenth-month`. A confirmed ADD (bible row 90) that turned out to be a sum, not a new
engine: `payslips.basicPay` already excludes overtime/night-diff/holiday premiums and already
reflects actual attendance — column-for-column DOLE's statutory formula. Migration `0115`,
hand-written (see DEF-121 below). Smoketested live end-to-end: preview → post → void → repayable,
verified against the dev server's own request log, not just the UI.

⚠️ **Flagged, not solved**: 2026 is not real here — v2 pilots Oct–Dec 2026 and purges every
operational table 1 Jan 2027 (ADR-007), so the real 2026 payout has to happen outside v2. The
banner on the page says so.

### T-192 — separation, final pay, clearance (first slice)

`/payroll/separations`. The other confirmed ADD from bible row 90. **Ian answered two scoping
questions before any code was written**: no track record of paying separation pay (decide the
policy now), and skip unused-leave conversion (no data source in v2 at all). Separation pay is
therefore a **manual decision**, never an auto-computed formula — PH law (Labor Code Art.
298/299) owes it only for specific authorized causes.

⛔ **Required amending T-191**: the annual run summed a full year for every employment, ended ones
included — correct only because nothing else paid a departed employee's 13th month yet. A posted
separation now excludes that employment from the annual run (`hasPostedSeparationInYear`), or
December would pay it twice. T-191's own test 9 is unaffected. Migration `0116`.

Smoketested live end-to-end, and that pass caught a real bug the type checker could not: the void
form's hidden field was named `store`, the action read `storeId` — silently producing an empty
redirect. Found, fixed, re-verified live.

### Two defects logged in passing

| | |
|---|---|
| **DEF-120** | 🔸 v1's AI-generated user manual describes a "13th-month estimate" on the pay-rate editor that has zero backing code anywhere in the repo — a documentation hallucination, not a feature |
| **DEF-121** | ⚠️ `drizzle-kit generate` has been effectively unusable in this repo since ~migration 0020 — only 12 of 116 migrations have a snapshot file, so it can't diff cleanly and re-litigates decades-old renames on unrelated tables. Every migration since has almost certainly been hand-written for this reason, just not previously named as the reason. Migrations `0115`/`0116` were hand-written and verified by direct apply to dev + test DBs |

### Roadmap brought current

`docs/ROADMAP.html` had drifted: Phase 5's chip said "13 of 17," the masthead's gate numbers said
"872 unit / 1778 integration," a separate mini-tracker further down said "1 of 5 built," and the
footer's "status verified" date said 30 August. All corrected. T-201 added as a new entry (it
wasn't in the original 17-slice count).

## Pick up here

1. **T-190/T-193 (statutory contributions, remittance) remain gated on DATA, not effort.** 0 of
   126 staff have an SSS/PhilHealth/Pag-IBIG/TIN number. This is not a coding task — somebody has
   to enter the numbers before either can be specced. Also a live compliance exposure independent
   of software.
2. **The first production deployment still doesn't exist.** T-201's finding stands: provisioning
   DO Managed Postgres, creating the `shareat` user, shipping a build via CI, is its own task spec
   — not due until closer to the Oct 2026 pilot per ADR-005/007, but somebody eventually has to
   write it.
3. **No specific direction beyond payroll was given.** With Phase 5 at 16 of 18 (only the two
   gated ones left), the next reasonable lane is Ian's call: Phase 3 inventory has 6 specced tasks
   remaining (T-167, T-170, T-176–179), or T-187 (service-charge distribution, unbuilt on purpose
   until service charge is switched on).

## Do not decide these alone — they are Ian's

| Question | The recommendation on the table |
|---|---|
| **T-192's void-after-annual-run edge case** | If a separation is voided after that year's annual 13th-month run already posted, the employment is not automatically re-included. Named in the task spec §5 as a real gap, not solved — a correction would need a new run, same as any other void-after-the-fact in this codebase |
| **DEF-121, the broken drizzle-kit snapshot chain** | Low urgency — hand-writing migrations already IS this project's practice. Worth a deliberate fix eventually (regenerate the missing snapshots, or just say so explicitly in `docs/RULES.md` rather than the next session re-discovering it) |
| **Who enters 126 staff members' statutory numbers** | Blocks T-190/T-193 entirely. Not a software question |

## Traps that have actually bitten — live in this area now

- ⛔ **A browser click can silently no-op.** `find` + `computer left_click` on a ref sometimes does
  not register — no error, just no state change. Confirmed via the dev server's own request log
  (no new POST line), not the extension's success message. **Screenshot + explicit coordinate
  click is the reliable fallback**, used repeatedly this session.
- ⚠️ **A `FormData` field-name mismatch passes every gate and is invisible until a live click.**
  `name="store"` vs `str(formData, 'storeId')` typechecks fine — strings are strings. Only the
  browser smoketest caught it (T-192's void redirect went to `?store=` empty).
- ⚠️ **A design that is correct today can become a double-payment bug when a sibling feature
  lands.** T-191's "ended employments still get the annual 13th month" was right in isolation and
  wrong the moment T-192 could also pay one. When building a task that touches money a sibling
  task already computes, ask whether the sibling's own exclusion logic still holds.
- ⛔ **`drizzle-kit generate` cannot be trusted in this repo** — DEF-121. Hand-write the migration
  from `schema.ts`, following the nearest sibling migration's exact style, then verify by applying
  directly to both `shareat_dev` and `shareat_test` (`export DATABASE_URL=... && npm run db:migrate --workspace=@shareat/db`).
- ⚠️ **Two agents share this one working tree — `ListAgents` before you start.** No collisions
  this session, but a peer (`ianla-a6`) was active throughout.

## The paste-ready prompt

```
Continue on shareat-system (C:\Users\ianla\webapps\shareat-system).

Read docs/RULES.md, then docs/HANDOFF-TODAY.md. main is at 6d16fdc, all gates
green (typecheck 0 · 879 unit + 1 skipped · 1797 integration · build).

⚠️ ANOTHER AGENT MAY BE IN THIS SAME WORKING TREE. Run ListAgents before you
start. Next task number is 202; next migration is 0117.

Phase 5 (payroll) is 16 of 18 built. The two remaining — T-190 (statutory
contributions) and T-193 (statutory remittance) — are gated on DATA, not
effort: 0 of 126 staff have an SSS/PhilHealth/Pag-IBIG/TIN number. Do not
attempt to spec or build either without that data existing first.

No specific direction was given beyond payroll. Before picking a next lane,
ask Ian: Phase 3 inventory (6 specced tasks: T-167, T-170, T-176-179), T-187
(service-charge distribution, deliberately unbuilt until service charge is
switched on), or something else entirely.

Before building anything, assess it and be willing to argue against it
(/research-evaluate-propose) — it changed the shape of every task this week,
including a real design conflict between T-191 and T-192 that needed fixing
after the fact.

Standing rules: ERP-rebuild is READ-ONLY and its name lies (it is the OLD live
ERP). No implementation without a written task spec in docs/tasks/. Verify UI
in a browser — a green build is blind to whether anyone can see the thing,
and this session found a real bug (mismatched form field name) that only a
live click caught. Update docs/ROADMAP.html at every wrap-up.
```

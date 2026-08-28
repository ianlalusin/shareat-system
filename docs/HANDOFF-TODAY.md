# Handoff — 2026-08-28

## Where things stand

**T-130 is finished and shipped: suppliers, supplier invoices, AP payments, open-item allocation.**
No expense — cash or credit — can be recorded until its supplier invoice is verified; verification
*is* the approval, so recording an expense against one posts immediately, no draft. New screens at
`/ap`, `/ap/invoices/[id]`, `/ap/suppliers/[id]`. Smoketested end to end in a real browser: recorded
a supplier, logged and verified an invoice, posted a credit AND a cash expense against it, watched
recording capacity update, recorded a partial payment and watched the open item drop. A peer
session's audit of the just-shipped code found three real issues (below); all three are fixed, gates
re-run green, and the fixes are pushed. Nothing is half-built for this task; T-131 (AR) starts clean.

## Gates at `9a3cd96` (pushed to `main`, current HEAD)

| Gate | Result |
|---|---|
| `typecheck` | ✅ exit 0 |
| `npm test` (unit) | ✅ **598 / 598** |
| `npm run test:integration` | ✅ **998 / 998** (2 new, from the audit fix) |
| `npm run build` | ✅ exit 0 |

**No `npm run lint`** — DEF-027, there isn't one.

## What happened this session

### T-130, built in this order

1. **Spec first** (bible §1.2a) — `docs/tasks/130-accounts-payable.md`, grounded in reading
   ERP-rebuild's real AP code (`ap-projection.server.ts`, `ap-payment.builder.ts`,
   `payment.actions.ts`, `receipt.actions.ts`) as requirements, never as design.
2. **Corrected twice by Ian, mid-spec, before any code** — the first draft dropped v1's
   `pending → verified` receipt lifecycle as redundant with expense approval. It wasn't: *"receipt
   and expense are 2 separate records... before an expense can be recorded it needs a verified
   receipt — but expense may already be posted, no need for draft."* And it's universal — cash
   expenses too, not just credit/AP. Then: *"look at how v1 expense is recorded and use that
   pattern"* — the spec was rewritten to port v1's actual mechanism (`canTagExpenseToReceipt`, the
   photo-at-create rule, receipt-date authority, the void-cascade-through-the-primitive lesson)
   rather than a re-derived guess at one.
3. **Schema, migration, repo, domain** — `suppliers`, `supplier_invoices`, `ap_payments`,
   `ap_payment_allocations`; hand-written migration `0043` (DEF-073 — `db:generate` is still
   unusable); `expenses.supplierId`/`supplierInvoiceId` now required; the DEF-055 photo gate
   relocated from `expenses` to `supplier_invoices`, closing **DEF-057** (logged 2026-08-25 — this
   is that row's own prescription, built as written).
4. **Three of my own spec defects, caught and fixed before shipping** (§3.4a — report, don't
   silently work around): a `funding_source` enum on `ap_payments` that would have reintroduced
   the exact office-drawer anti-pattern DEF-058 already removed; a CHECK constraint that made
   voiding an already-verified invoice impossible; two different "close enough" tolerances
   conflated into one, which would have let a single expense overshoot an invoice's total by up to
   a peso.
5. **One bug the browser found, not the tests**: the "record expense" form embedded on the invoice
   page failed over to `/expenses/new` on error — wrong page, every field wiped — surfaced by a
   real overdraft rejection mid-smoketest. Fixed with a `returnTo` field.

### ⚠️ Three more, found by a peer session's audit AFTER T-130 first shipped — all fixed

A concurrent Claude session (`/daily-review`, sharing this working directory) reviewed T-130's diff
and reported three findings mid-wrap-up. All three were independently re-verified against live
behaviour before fixing — not taken on faith — and all three are now fixed, tested, and pushed.

1. **RLS policies since migration 0036 (including 3 of T-130's own new tables) use a raw
   `current_setting('app.org_id', true)::uuid`** instead of the project's `app_current_org()`
   function, which wraps the same call in `NULLIF(..., '')`. ⚠️ **This is reachable in production,
   not theoretical — a first pass got that part wrong, and the same peer session's second pass
   caught it.** `set_config('app.org_id', $1, true)` is `SET LOCAL` on a custom GUC; when that
   transaction commits, PostgreSQL resets the GUC to `''`, not to unset/NULL — a documented quirk
   of custom GUCs that were only ever assigned with `LOCAL`, and exactly why `app_current_org()`'s
   `NULLIF` guard exists. `principal.ts`'s customer branch (*"NO org is set... evaluates against
   NULL"*) is true on a fresh connection and false on a pooled, reused one that previously served a
   staff request — `app.org_id` reads back `''`. Reproduced live with a `max: 1` pool forcing
   connection reuse: a staff transaction sets a real org and commits, the next (customer) one on
   the same connection sees `''`, and every table still on the raw idiom throws `22P02` instead of
   denying. **Still not a data leak** (a policy error still returns zero rows), but it is a live,
   reachable, customer-facing **500** on any affected table, depending on connection-pool reuse
   history — my own first verification used a superuser connection (bypasses RLS,
   `rolbypassrls=true`) and a never-reused connection, both of which hid this. Fixed for T-130's
   own 4 tables — source migration and the already-applied live policies on both `shareat_dev` and
   `shareat_test`. The ~10 pre-existing tables on the old idiom are **not** touched — logged as
   **DEF-077** (severity raised 🔸→⚠️ after the correction) — but this is no longer background
   cleanup; see "Pick up here" below.
2. **`verifyInvoice`'s evidence check was truthiness-only** (`!!(invoice.receiptFileId || ...)`) —
   a hand-typed, nonexistent `receiptFileId` would have passed. This regressed T-141's own
   hardening (DEF-070's closure), which validates the file against `filesRepo.getById` — exists in
   this org, belongs to this store — and only falls back to the plain-text URL when no file is
   named. Restored that exact check in `verifyInvoice`; 2 new tests in `ap.test.ts` cover "no
   evidence at all" and "a forged `receiptFileId`".
3. **The wrap-up skill's own migration-drift check (patched earlier this same session) told the
   reader to run `npm run db:generate`** — which DEF-073, read extensively during this session's
   own T-130 work, says is unusable here. A self-contradiction, fixed: the check now diffs
   `packages/db/schema/` against `packages/db/migrations/` and points at the hand-written-migration
   convention instead.

### ⭐ Decisions Ian made, and where each is recorded

| Decision | Recorded in |
|---|---|
| Aging is by **due date**, not invoice date, for both AP and AR | `docs/tasks/130-accounts-payable.md` Invariant 11 — **drafted as a bible row, not yet landed** (see below) |
| Manager verifies supplier invoices | `docs/decisions/CAPABILITY-MATRIX.md`, `packages/auth/src/capabilities.ts` (`verify_supplier_invoice`) |
| Capture VAT data on supplier invoices (not yet posted to a separate account) | `docs/tasks/130-accounts-payable.md` Contract §2; `supplier_invoices.vatType/vatRate/vatAmount/vatExclusiveAmount` |
| The receipt/expense split is real, not redundant, and applies to every expense | `docs/tasks/130-accounts-payable.md` Contract §2's correction history; Invariant 2 |
| DEF-057 closed by T-130 | `docs/DEFECTS-REGISTER.md` |

⭐ **Nothing Ian decided is left in the transcript only** — except one, named explicitly below
because it genuinely cannot be recorded by this session.

### ⚠️ One decision NOT yet durably recorded, and why

**Aging basis = due date** needs a `PROJECT_BIBLE.md` §13 row, and *"a Sonnet implementer never
amends it, it reports a conflict and stops"* (§14) — this session is Sonnet, not the Opus planner.
The exact row text is drafted and ready to paste, sitting in
`docs/tasks/130-accounts-payable.md` right after Invariant 11. **An Opus pass needs to actually
paste it in** before or alongside T-131, which depends on this basis matching.

## Pick up here

**1. Get the aging-basis bible row landed** (Opus planner, five minutes) — the draft is sitting in
   the task doc, see above.

**2. T-131 — AR.** Finally posts to the `1210` control account `T-129`'s `customers` already
   derives a balance from. Mirrors T-130's shape closely — this task doc is now the reference
   pattern for "control account + subledger + open-item allocation," proven for the first time on
   `2110`.

**3. T-132 — wholesale orders**, the document that consumes a price list.

**4. DEF-077's remaining scope — worth raising with Ian directly, not left as background cleanup.**
   The ~10 tables from migrations 0036–0042 still use the raw `current_setting` idiom, and this is
   now confirmed **live and reachable** (see above) — a customer-kind request on a connection
   previously used for staff can 500 against any of them, not merely a theoretical inconsistency.
   Not a data leak (fails to an error, not a leaked row), so not an emergency, but it should be
   fixed sooner than "whenever someone gets to it." Mechanical fix: `DROP POLICY`/`CREATE POLICY`
   against the already-applied live policies (a migration file edit alone won't re-apply).
   **Verify with a `max: 1` pool forcing a staff-then-customer sequence on the same connection** —
   a fresh/never-reused connection, or a superuser connection (`rolbypassrls=true`), both falsely
   show the bug as absent.

## Do not decide these alone — they are Ian's

| Question | The recommendation already on the table |
|---|---|
| **Entity structure** — sole proprietorship, partnership or corporation? | Carried over, unanswered, from the last several handoffs. Worth one conversation with the accountant before go-live |
| Should input-VAT actually post to a GL account, now that supplier invoices capture the data? | Recommendation: not yet — nothing in `POSTING-PATTERNS.md` splits it today, and inventing the split without a discovery pass is exactly the unconfirmed-scope T-130 refused for withholding tax |
| Expanded withholding tax on purchases — do any real suppliers need it? | Out of scope for T-130, named as a decision, not an oversight — needs a real answer on which suppliers are subject to it before it's designed |
| Fold DEF-077's remaining ~10 tables into a dedicated task now, or leave it as a background item? | **Upgraded after a correction — confirmed live and reachable, not theoretical** (see above). Not a data leak, so not an emergency, but recommend a short, dedicated task soon rather than open-ended background cleanup, since it touches RLS policies on live tables and causes real customer-facing 500s today |

## Traps that have actually bitten, live in this area right now

- ⛔ **Two `funding_source`-shaped columns is the same mistake twice.** If a future module wants to
  record "how money moved," check `ADR-010`/DEF-058 first — the account's own custodian decides,
  never a typed label. Caught once already in T-130's own first draft.
- ⚠️ **A biconditional CHECK on a status+anchor pair breaks the moment something can leave that
  status while keeping its history** (voiding a verified invoice). One-directional
  (`status <> 'X' or anchor is not null`) is usually what's actually wanted.
- ⚠️ **Two tolerances that look like the same number are not the same question.** "Is this close
  enough to call fully recorded" and "does this posting fit" need different epsilons — conflating
  them lets postings overshoot.
- ⚠️ **A server action shared by two different pages needs to know where to redirect on error.** A
  hardcoded error-redirect target is only safe if the action has exactly one caller.
- ⚠️ **A truthiness check on a stored id/URL is not evidence.** `!!row.someFileId` proves a field is
  non-empty, not that the thing it names is real. If a check exists to gate something meaningful
  (photo evidence, an attached document), it needs a repo lookup (`filesRepo.getById` or
  equivalent) that can actually fail — copy an existing hardened check (T-141's) rather than
  re-deriving a weaker one from the field's shape alone.
- ⚠️ **`npm run db:generate` is unusable** (DEF-073). Hand-write migrations, journal them with
  `previous.when + 86400000`.
- ⚠️ **A raw `current_setting('app.org_id', true)::uuid` in an RLS policy throws instead of denying
  on an empty-string `app.org_id`** — `app_current_org()` exists specifically to guard this with
  `NULLIF`. ⛔ **And it IS live**, on a pooled connection: `SET LOCAL` on a custom GUC resets to
  `''`, not NULL, when its transaction commits — a documented Postgres quirk, not a theoretical
  edge case — so a connection previously used for a staff request leaves `app.org_id` as `''` for
  the next request that sets no org of its own (`principal.ts`'s customer branch). A first pass on
  this got "reachable?" wrong by testing only a never-reused connection; caught by a second,
  independent pass. New RLS policies should use `app_current_org()`, never the raw idiom (DEF-077).
- ⚠️ **Verifying an RLS claim from a superuser connection, or from a connection that's never been
  reused, both prove nothing.** The `postgres` role used for local dev has `rolbypassrls=true`, so
  it ignores every policy regardless of `FORCE ROW LEVEL SECURITY` — any probe must `SET LOCAL ROLE
  shareat_app` first. Separately, a custom-GUC reset bug (above) only shows up on a **reused**
  connection — a fresh one always looks fine. Both traps bit this exact session, on this exact
  finding, in that order: first the wrong role, then the wrong connection lifecycle. A real RLS
  probe needs the app role AND a `max: 1` pool exercising the actual sequence (e.g. staff, then
  customer) that production connection pooling produces.
- ⚠️ **A concurrent session sharing this working directory can check out a different branch out
  from under you mid-session** — `git branch --show-current` silently changed from `main` to
  `daily-review/2026-08-28` at some point this session, discovered mid-wrap-up. Fixed by switching
  back once confirmed safe (0 commits ahead of `main` on that branch — only uncommitted
  working-tree files). **Check `git branch --show-current` again right before committing**, not
  just at session start.
- ⚠️ **When you find uncommitted files you don't recognize, don't guess who wrote them — and don't
  trust your first guess either.** `docs/FILE-MAP.md`, `docs/reviews/NEXT-PROMPT.md`, and
  `docs/reviews/2026-08-28.md` are `/daily-review`-shaped output (a diff review, findings, a
  next-session prompt), left uncommitted (mtimes 12:09–12:11) while this session was checked out on
  `daily-review/2026-08-28`. This session first attributed them to a peer session by name in both
  chat and this file — **that peer then disputed it with real counter-evidence** (its own last repo
  write was ~40 minutes earlier; the review content describes toolchain failures — a broken vitest
  binding, an unreachable Postgres — never seen in either session's own gate runs, and references
  T-130 as still-uncommitted WIP, meaning it ran before this session's own T-130 commits). **Actual
  authorship is unresolved as of this handoff** — possibly a subagent, possibly a session that has
  since exited, possibly something else. The 3 files are still uncommitted. **Do not commit them
  under your own authorship without first working out who actually produced them** — ask Ian if
  it's unclear; the content itself looks safe to merge (docs-only, `git diff -w` confirms no code
  changes per its own claim) but attribution matters for a project this disciplined about who
  decided what.

## The paste-ready prompt

```
Continue Shareat System at C:\Users\ianla\webapps\shareat-system.

Read docs/HANDOFF-TODAY.md first, then docs/RULES.md, then the PROJECT_BIBLE.md
sections it cites for your area.

⚠️ FIRST: the aging-basis bible row is drafted in docs/tasks/130-accounts-payable.md
(Invariant 11) but not yet landed in PROJECT_BIBLE.md — only the Opus planner may
amend it (§14). Land it before or alongside T-131.

Next task: T-131 accounts receivable — finally posts to the 1210 control account
T-129's customers already derives a balance from. Write docs/tasks/131-*.md as a
spec BEFORE any code (bible §1.2a). T-130 (docs/tasks/130-accounts-payable.md) is
now the reference pattern for "control account + subledger + open-item
allocation" — read it as a template for structure, not as a source of AR-specific
answers. Ground the actual AR rules in reading ERP-rebuild as requirements, never
as design. ERP-rebuild is the OLD live ERP and is read-only — the name lies.

Gates at HEAD (9a3cd96): typecheck · 598 unit · 998 integration · build, all green.
There is NO lint script in this repo (DEF-027) — do not report one.

Before writing a migration, read DEF-073: db:generate is unusable here. Hand-write
it and journal with previous.when + 86400000.

Before writing any RLS policy, use app_current_org() — not a raw
current_setting('app.org_id', true)::uuid cast, which throws instead of denying on
an empty org_id. This is LIVE, not theoretical (DEF-077, corrected mid-session
after an initial "unreachable" call was wrong): SET LOCAL on a custom GUC resets
to '' on commit, not NULL, so a pooled connection previously used for a staff
request leaves app.org_id as '' for the next request that sets no org (the
customer principal). ~10 pre-existing tables still carry the bug — ask Ian
whether to fold a fix into your own task or do it as its own.

If you ever need to PROVE an RLS policy denies something: SET LOCAL ROLE
shareat_app first (the local dev superuser connection bypasses RLS entirely), AND
use a max: 1 pool that actually exercises connection reuse (a fresh connection
hides the GUC-reset bug above). Both traps bit the previous session on this exact
finding, in that order.

Verify UI in a browser before claiming a screen works — T-130 found a real bug
this way (a shared server action redirecting to the wrong page on error) that
998 passing tests did not catch.

Check `git branch --show-current` before committing, not only at session start —
another session sharing this machine can check out a different branch mid-session.
If it has, commit ONLY your own files explicitly — never sweep unrecognized
uncommitted output into your commit on a guess. docs/FILE-MAP.md, docs/reviews/
NEXT-PROMPT.md, and docs/reviews/2026-08-28.md are /daily-review-shaped output
sitting uncommitted as of this handoff — the previous session guessed whose it
was, guessed wrong (or at least unconfirmed — the named peer disputed it with
real counter-evidence), and never resolved actual authorship. Don't repeat the
guess; ask Ian if it's still unresolved when you get here.
```

# T-260 — DEF-272: a sub-centavo amount defeats every `> 0` money guard

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⭐ **This spec CORRECTS its own defect row in two places — read "What DEF-272 got
> wrong" before doing anything, because the remedy the register proposes is narrower than the
> correct fix and would leave a quieter version of the same defect behind.**

## The failure

The money domain guards the **typed** value and the database checks the **stored** one, and at the
sub-centavo boundary the two disagree.

Enter `0.004` in a cash request:

1. `Number('0.004') > 0` → **true**. The guard passes. *(Executed, not reasoned — see below.)*
2. The action passes the form string straight through: `amount: str(formData, 'amount')`
   (`apps/erp/src/app/cash-requests/actions.ts:48`).
3. The column is `numeric(14,2)`. Postgres rounds the value to `0.00` on insert.
4. `cash_requests_amount_positive_check` **refuses the row**.
5. The person moving money reads raw Postgres driver text.

⚠️ **Severity is ⚠️ and not ⛔, and state it that way in the report: the database REFUSES the row.
Nothing wrong is stored and no money is mis-recorded.** The database is doing its job. The defect
is a missing server-side guard and an ugly refusal — not data corruption.

⭐ This is bible §13 row 189's "double signal" arriving as a **measurement**: the constraint is
reachable precisely because the layer above it does not agree with it.

### Proven by execution, so you do not have to re-derive it

```
Number('0.004') > 0   →  true          '0.004' → stored 0.00   guard passes, DB refuses
Number('0.001') > 0   →  true          '0.001' → stored 0.00   guard passes, DB refuses
Number('1e-7')  > 0   →  true          '1e-7'  → stored 0.00   guard passes, DB refuses
Number('.004')  > 0   →  true          '.004'  → stored 0.00   guard passes, DB refuses
Number('0.005') > 0   →  true          '0.005' → stored 0.01   guard passes, DB ACCEPTS — fine
```

⚠️ **The boundary is "rounds to zero at scale 2", not "is less than one centavo".** `0.005` stores
as `0.01` and is a legitimate entry. A fix that refuses everything below `0.01` is wrong.

## What DEF-272 got wrong — both corrections change the work

**1. The citation.** DEF-272 lists four guards "each of the shape `if (Number(input.amount) <= 0)
throw`" and cites `money-transfers/index.ts:103`. **`:103` is the distinct-accounts guard and
contains no amount at all.** Money transfers' real amount guard is at **`money-transfers/index.ts:155`**
and reads `if (!(out > 0) || !(inn > 0))` — a different spelling of the same defect, on **two**
amount fields (`amountOut` and `amountIn`), not one.

⛔ **This matters beyond a wrong line number: a one-line grep for `Number(...)` compared to zero
MISSES that site**, because the comparison is on a variable assigned on a previous line. The
orchestrator's own census made exactly that mistake before catching it. **Do not trust a
single-line regex to find the set.**

**2. The proposed remedy is too narrow.** The register says the guard should "reject an amount that
rounds to zero at the column's scale". That would accept **`1.234`** and silently store `1.23` —
the user typed a precision the system cannot hold and nothing says so. A quieter defect of the same
family.

⭐ **And the project already owns the right primitive.** `packages/core/src/money.ts`'s `money()`
refuses anything that is not exact to 2dp:

```
money('0.004') → throws     money('1.234') → throws     money('0.005') → throws
money('0.01')  → ok         money('0')     → ok         money('12.50') → ok
```

⛔ **`createCashRequest` does not import `money` at all.** It passes the raw form string into
`insertRequest`. The primitive exists, is correct, and is bypassed. **That is the fix: route money
inputs through `money()`, then apply the positivity check to the parsed value.** Not a new
rounds-to-zero helper — a second way to say what `money()` already says is the shape T-255 spent a
day deleting.

⚠️ `money('0.005')` throws too, which is stricter than the database. That is **correct and
intended**: the person typed three decimal places into a two-decimal field, and rounding it for
them silently is the defect, not the fix. Refuse it with a sentence that says so.

## Contract

- Money **inputs** in the domain layer are parsed with `money()` before use, and the positivity
  check runs on the parsed value.
- The refusal a person sees is a **written sentence**, not a `TypeError` from `money()` and not
  driver text. `money()`'s own message (`Invalid money string: "0.004" (expected up to 2 decimal
  places)`) is a developer's message — catch it and say something a cashier can act on.
- ⛔ **One shared entry point, not one per module.** Four hand-copied guards is the shape T-255
  just deleted; do not rebuild it. Where the shared helper lives is your call — argue for it in
  the report.
- ⚠️ **Rates are `numeric(14,4)`, not `(14,2)`** (bible §6). `customers/index.ts:194` guards
  `input.rate`. Do not force a rate through a 2dp parser. Say explicitly which paths you treated as
  money and which as rate.
- ⚠️ **Zero is a legitimate value in this codebase** (money.ts header, §12 landmine 8). Never
  `if (amount)`. The check is `<= 0` on a *parsed* value, and only where the column's CHECK says
  positive.

## Find the set as a GUARD, not as a census

⛔ **Write the census as a test whose assertion is ZERO.** A hand count counts spellings; a guard
whose assertion is zero cannot be fooled by a naming convention. That is how lane C found 4 copies
its own name-based count had missed, and it is why this project has had a text-scanning guard match
a *spelling* where it needed a *shape* four separate times (DEF-243, DEF-269, the T-250 target test,
the caller census twice).

**Known sites — a floor, not the set.** Verified at source by the orchestrator:

| Site | Shape |
|---|---|
| `cash-requests/index.ts:52`, `:107` | `Number(input.amount) <= 0` |
| `loans/index.ts:91`, `:165` | `Number(input.amount) <= 0` |
| `ap/index.ts:702` | `const amount = Number(input.amount); amount <= 0` |
| `money-transfers/index.ts:155` | `!(out > 0) \|\| !(inn > 0)` — **two** fields, missed by grep |
| `ar/index.ts:61` | `Number(input.totalAmount) <= 0` |
| `expenses/reimbursement.ts:44` | `Number(input.amount) <= 0` |
| `owners/index.ts:119` | `Number(input.amount) <= 0` |
| `recurring-expenses/index.ts:90`, `:167` | `Number(input.defaultAmount) <= 0` |
| `trade/index.ts:236` | `Number(lineTotal) <= 0` |
| `wastage/orders.ts:292` | `Number(amount) <= 0` |
| `sales-days/create.ts:318` | `Number(amount) <= 0` |

⚠️ **Not every hit is this defect.** `pos/item-map.ts:46` and `cutover/index.ts:221` guard
**quantities**, and the `> 0.005` comparisons in `ap`, `customers`, `liabilities` and `cutover` are
**balance tolerances**, not input guards. Classify before changing, and report the classification.

## Watch out

- ⚠️ **Prove the injection before believing either outcome.** A test that "passes" because the
  sub-centavo value never reached the guard is indistinguishable from a working fix by exit code
  alone. Assert the value actually arrived — a byte count, a logged value, an assertion on the
  parsed result. This orchestrator's predecessor was fooled by exactly this on T-259.
- ⚠️ **Tests before implementation, failing for the right reason first** (RULES §2). A test that
  only ever passed proves nothing.
- ⚠️ `Number('')` is `0` and `Number('abc')` is `NaN`, and `NaN <= 0` is **false** — so today a
  non-numeric amount also sails past every one of these guards. Check what happens to it and report
  it; it may be a second row.
- ⛔ **You may not run `git`, `npm run build`, the dev server, or `npm run test:integration`.**
  Integration only via `node ~/.claude/skills/orchestrator/tools/it.mjs <your lane db> <files>`.
  The orchestrator runs every gate on the shared database.
- ⛔ **Never add an export with no production caller.** `scripts/production-caller-census.mjs`
  checks it mechanically and the orchestrator runs it.
- ⚠️ Three files in this tree use CRLF (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
  `statutory-discounts/actions.ts`) — a sweep matching on a line ending silently skips them.

## Out of scope

- The **UI** half. Client-side input constraints are a separate, weaker layer (RULES §1 rule 7 —
  every gate exists server-side). If a screen should also refuse this before submitting, **file it**;
  do not build it here.
- Wiring the hit counter into these screens — that is DEF-274 and is being done in parallel. **Do
  not touch `recordIfUnmappedConstraint` or any catch block's contents.**
- Amending the bible. Report an amendment and stop (RULES rule 14).

## Done when

- A sub-centavo amount is refused **by the domain, with a written sentence**, on every money path
  in the set — watched failing before the fix and passing after.
- `1.234` is refused too, and the report says what the person sees.
- ⚠️ **`0.005` is refused as well, and this is DELIBERATE — corrected 2026-09-10 after lane E
  caught this line contradicting the spec's own argument.** An earlier draft said "0.005 and 0.01
  still work", which belonged to the rejected rounds-to-zero-only remedy. It does not survive the
  `money()` decision: `money()` refuses anything past 2dp, full stop. **The database boundary
  (rounds to zero) and the product boundary (is this a storable amount) are different boundaries,
  and the product one is stricter on purpose** — silently turning a typed `0.005` into `0.01` is
  the same silent coercion `money.ts` already refuses everywhere else ("dirty data is surfaced,
  not silently coerced"). `0.01` still works.
- The set was found by a guard asserting zero, not by a hand census, and the guard is committed.
- The classification of money vs rate vs quantity vs tolerance is stated explicitly.
- A `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-272, and DEF-275 for the related bible-row narrowing (Ian's).

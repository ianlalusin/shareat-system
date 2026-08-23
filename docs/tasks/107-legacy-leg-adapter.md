# T-107 — The legacy leg adapter: `direction: in|out` → debit / credit

> **Status:** ✅ **COMPLETE 2026-08-23** — 19/19 invariants. See the correction at the end:
> my §4 motivation overstated how many accounts will actually flag.
> **Was:** spec ready. **Depends on:** T-102 (COA seeded), T-105 (`postEntry`).
> **Blocks:** T-112 / T-114 — the ETL cannot read v1's journal without this.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.
> **Runs alongside T-106.** Scope is disjoint by construction — see below.

## Goal

Translate the legacy journal's `{ accountId, direction: 'in'|'out', amount }` legs into real
debits and credits, so v1's history can be posted into a ledger that stores polarity instead
of inferring it.

## The problem being solved

v1 never stores debit or credit. It stores a `direction` — *balance increased* or *balance
decreased* — and derives the accounting polarity at read time from the account's **nature**,
which it infers from a **string prefix on the account id** (`ap__*` and `income__*` are credit,
almost everything else is debit — discovery `06` §1.1, `account-defs.ts:19-43`).

v2 does not infer anything. **`normal_balance` is a declared column** (bible §13 row 39), and
T-102 seeded it explicitly — including the six accounts where deriving it from `type` gives the
wrong answer.

## The translation

`direction` says which way the balance moved. `normal_balance` says which side of the ledger
that means.

| `direction` | account `normal_balance` | → |
|---|---|---|
| `in` (increase) | `debit` | **debit** |
| `in` (increase) | `credit` | **credit** |
| `out` (decrease) | `debit` | **credit** |
| `out` (decrease) | `credit` | **debit** |

Two lines of logic. **The value is not the arithmetic — it is §4.**

---

## Scope

Create **only** these three files:

```
packages/domain/src/ledger/legacy-adapter.ts
packages/domain/tests/legacy-adapter.test.ts              unit — NO database
packages/domain/tests/integration/legacy-adapter.test.ts  proves the output actually posts
```

> ⚠️ **T-106 is running concurrently and owns `packages/domain/src/index.ts` and
> `packages/db/src/repo/journal.ts`. Do NOT touch either file** — not even to add an export.
> The planner wires the barrel export once both tasks land. Bible §3.4: two agents must never
> touch the same file.

Do not modify any schema, seed, migration, `postEntry`, `reverseEntry`, or anything under
`apps/`. **Do not touch `PROJECT_BIBLE.md`** (§14 reserves amendments to the planner).

---

## Contract

### 1. A pure function, with the lookup injected

```ts
type LegacyLeg = {
  accountId: string;          // v1's structured id, e.g. 'cash__cashier', 'ap__SUP123'
  direction: 'in' | 'out';
  amount: string | number;    // v1 stored floats — see §3
  legKey?: string;
};

type ResolvedAccount = {
  code: string;                       // v2 account code, e.g. '1110'
  normalBalance: 'debit' | 'credit';
  isPostable: boolean;
  status: 'active' | 'reserved' | 'archived';
};

adaptLegacyLegs(
  legs: LegacyLeg[],
  resolve: (accountId: string) => ResolvedAccount | null,
) → AdaptResult
```

**No SQL, no imports from `@shareat/db`.** The resolver is injected, so this is unit-testable
without a database and the ETL can supply whatever mapping T-113 settles on. A pure function
here is what lets the *hard* part — the mapping — be tested separately.

### 2. The result is a classification, never a throw

```ts
type AdaptResult =
  | { ok: true;  lines: AdaptedLine[]; findings: Finding[] }
  | { ok: false; reason: string;       findings: Finding[] }
```

`ok: false` for: an unresolvable `accountId`, a non-postable target, a non-positive amount,
an empty leg set. **Never throw for bad legacy data** — bad legacy data is the expected input,
and the ETL must classify millions of rows rather than crash on the first one (bible §11
rule 5: quarantine with a reason, never silently coerce).

### 3. Money crosses as a string, and rounding is a finding

v1 stored every peso as a **JS float** (bible §12). Accept `number` for that reason, but
convert through `@shareat/core/money` immediately and emit every line's amount as a **string**.

If a legacy amount does not survive the round trip exactly — a float carrying more precision
than two decimals — **record a `finding`, do not silently round.** How much v1's float storage
actually drifted is something we want measured, not smoothed away.

### 4. ⭐ The polarity disagreement check — the reason this task exists

For every leg, compute the polarity **twice**:

1. From **v2's declared `normalBalance`** (authoritative — this is what the line is written with).
2. From **v1's inferred prefix nature**, reproducing `account-defs.ts:19-43` exactly:
   credit for `ap__`, `liability__`, `staff_reimbursable__`, `income__`, `equity__`,
   `contra_asset__`, `others__remittance_overage`; debit for everything else.

**When they disagree, emit a `Finding`** naming the account, both polarities, and the leg.
**Always use v2's.** v1's prefix table is a heuristic over a string; v2's column is a declared
fact.

> This is what turns a translator into an audit instrument. Bible §1.4 — *the migration **is**
> the audit* — and §1.3 — *a v1-vs-v2 accounting difference is a **finding**, not a failure*.
> The six accounts where deriving polarity from type is wrong (1590, 3200, 4900, 4910, 4920,
> 4950) are exactly where a prefix heuristic is most likely to have been silently wrong for
> years. **This check is how we find out.**

### 5. It does not decide whether the entry balances

Emit the lines. **The database decides.** A group of legs that cannot balance is T-113/T-114's
quarantine problem, not this function's. `adaptLegacyLegs` may report `ok: true` for a set that
`postEntry` will then reject at COMMIT — that is correct, and the ETL records it as the finding
it is.

Do **not** add a balance pre-check. A second implementation of the balance rule is a second
source of truth (T-105's principle).

---

## Invariants the tests must prove

**Translation — unit, no database**
1. `in` + debit-normal → debit; the credit side is zero.
2. `in` + credit-normal → credit.
3. `out` + debit-normal → credit.
4. `out` + credit-normal → debit.
5. A multi-leg group translates every leg independently and preserves order and `legKey`.
6. Amounts emerge as **strings**, exact to the centavo.

**Classification, not exceptions**
7. An unresolvable `accountId` → `ok: false` naming the id. **No throw.**
8. A non-postable (header) target → `ok: false`. **No throw.**
9. A zero or negative amount → `ok: false`. **No throw.**
10. An empty leg array → `ok: false`. **No throw.**
11. A **`reserved` or `archived`** account resolves and adapts fine — this function does not
    police account status; `postEntry` does. It reports, it does not gate.

**The disagreement check — §4**
12. `cash__cashier` (v1 prefix ⇒ debit; v2 1110 debit-normal) → **no finding**.
13. `ap__SUP1` (v1 prefix ⇒ credit; v2 2110 credit-normal) → **no finding**.
14. An account where the two disagree → **a finding is emitted**, naming both polarities, and
    **the line is written using v2's**.
15. Findings never prevent `ok: true` — they are observations, not errors.

**Money**
16. A float carrying more than two decimals emits a **finding** and is not silently rounded.
17. `0.1 + 0.2` style legacy values round-trip to exactly `0.30`.

**End to end — integration, real Postgres**
18. A balanced two-leg legacy group adapts and **posts successfully via `postEntry`**.
19. A **single-leg** legacy group adapts to one line and is then **rejected at COMMIT** by the
    database — proving the adapter defers the balance judgement rather than pre-empting it.
    *This is v1's defining defect meeting v2's constraint, and it must be demonstrated.*

## Out of scope

The v1→v2 account **mapping** itself (T-113 — this task takes a resolver) · reading Firestore ·
the ETL framework (T-112) · quarantine storage (T-114) · reporting views · any UI · any
schema change · anything in T-106's scope.

## Done when

- [ ] All 19 invariants pass; 1–17 with **no database**.
- [ ] `legacy-adapter.ts` imports nothing from `@shareat/db`.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**all existing tests
      still pass**) · `build` succeeds.
- [ ] No file outside the three named in **Scope** modified.
- [ ] Any spec defect **reported, not silently worked around**.


---

## Correction — my §4 motivation was overstated

The implementer reproduced v1's prefix table faithfully and then checked it against the real
`legacyCode`s in the seeded chart. **Three of the six accounts I named do not actually
disagree:**

| Account | Why no disagreement |
|---|---|
| **1590** accumulated depreciation | v1 already special-cases `contra_asset__*` as **credit** — matching 1590's declared credit-normal exactly |
| **4910** loyalty points redeemed | v1 buckets generic `others__*` as **debit** — matching 4910's declared debit-normal contra-revenue |
| **4920** vouchers redeemed | same |

**v1's heuristic is better than I gave it credit for.** It special-cases the contra-asset
prefix and, by accident of bucketing, gets the `others__` contra-revenue cases right too.

A genuine disagreement only appears where a legacy id carries a domain-intuitive prefix the
table does *not* special-case — `equity__owner_drawings` → 3200 is the clear example, since
drawings are credit by the `equity__` rule and debit by declaration. The unit test for
invariant 14 uses that case rather than one of the three that would never fire.

**Nothing in the implementation changes** — §4 says reproduce the table exactly, and it does.
What changes is the expectation: **the disagreement check will flag fewer accounts than I
implied**, and how many depends entirely on which real legacy prefixes T-113's mapping
resolves them from. The check is still worth having; the claim that six accounts were
landmines was not evidence, it was inference.

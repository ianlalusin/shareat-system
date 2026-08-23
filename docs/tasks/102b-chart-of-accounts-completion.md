# T-102b — Seed the 17 accounts T-102 missed

> **Status:** ✅ **COMPLETE 2026-08-23** — 7/7 invariants, 92 accounts, DEF-035 fixed.
> Invariant 7 verified failing before the change, naming exactly the 17.
> **Was:** spec ready. **Depends on:** T-102 (done). **Blocks:** T-113 (expense mapping).
> **Closes:** DEF-035. **Written by:** Opus planner, 2026-08-23.

## Goal

Seed the seventeen accounts `COA-ALIGNMENT.md` **§4** requires and T-102 did not create, so the
expense-category mapping has somewhere to post.

## Why they were missed — my error, recorded so it is not repeated

T-102's spec said *"take the complete list from `COA-ALIGNMENT.md` §2."* **§2 gives account
groups. §4 gives the category→account mapping, and introduces a finer breakdown.** The
implementer seeded exactly what was asked and the result is a chart that cannot express §4.

> A spec that points at one section of a two-level source produces a half-complete result —
> and the missing half stays invisible until something tries to use it.

## Scope

Create or modify **only**:

```
packages/db/seed/chart-of-accounts.ts                    add the 17
packages/db/migrations/*.sql                             a NEW migration
packages/db/tests/integration/chart-of-accounts.test.ts  extend
```

Do **not** modify schema files. Migrations already applied are **never edited** — add a new one.
**Do not touch `PROJECT_BIBLE.md`** (§14). Do not touch `packages/domain/**` or
`packages/db/src/repo/**` — other tasks own those.

## Contract

### The 17 accounts — names from `COA-ALIGNMENT.md` §4

**Cost of sales** (all `type='expense'`, `normal_balance='debit'`, parent `5000`):

| Code | Name |
|---|---|
| 5110 | COGS — meat |
| 5120 | COGS — sides |
| 5130 | COGS — condiments and seasoning |
| 5140 | COGS — sauces and dips |
| 5150 | COGS — packaging |
| 5160 | COGS — retail and consumables |
| 5170 | COGS — commissary transfers |

**Operating expenses** (all `type='expense'`, `normal_balance='debit'`, parent `6000`):

| Code | Name |
|---|---|
| 6160 | Employee benefits and welfare |
| 6510 | Smallwares |
| 6620 | Pest control and waste management |
| 6630 | Vehicle and transportation |
| 6650 | Marketing and advertising |
| 6850 | Administrative expenses |
| 6860 | Bad debt expense |
| 6870 | Bank charges |
| 6880 | Insurance |
| 6890 | Subscriptions and software |

### Rules

- **Idempotent by `(org_id, code)`**, exactly like T-102. Re-running inserts nothing.
- `is_system = true`, `status = 'active'`.
- **No `legacy_code`** on any of them — every one is either new or fed by a free-text category,
  not by a stable 1:1 v1 account id. (T-102's invariant 7 already forbids `{`/`}` in a
  `legacy_code`; these simply have none.)
- **5170 carries a warning in its name or memo**: commissary transfers are **inter-store and
  must eliminate on consolidation**, or the same peso is counted twice — once when the
  commissary buys the raw material, again when the branch "buys" from the commissary. It is
  kept separate from 5110 for exactly this reason.

## Invariants the tests must prove

1. All 17 exist after migration, each with `type='expense'` and `normal_balance='debit'`.
2. Each is parented to the correct header — `5xxx` → `5000`, `6xxx` → `6000`.
3. None has a `legacy_code`.
4. All are `status='active'` and `is_system=true`.
5. Re-running the seed inserts nothing and changes nothing.
6. **Total account count = T-102's 75 + 17 = 92.**
7. **Every account code named anywhere in `COA-ALIGNMENT.md` §4 now exists in the chart.**
   Write this as a real check against the parsed set, not a hand-maintained list — it is the
   test that would have caught DEF-035, and it must keep catching it.

## Done when

- [ ] Migration applies cleanly; re-running is a no-op.
- [ ] All 7 invariants pass.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**all existing tests
      still pass**) · `build` succeeds.
- [ ] **DEF-035 marked `fixed`** in `docs/DEFECTS-REGISTER.md`, naming the closing test.
- [ ] Any spec defect **reported, not silently worked around**.


---

## Implementation notes — resolved 2026-08-23

**1. My invariant 7 contained a trap, and the implementer found it.**
I wrote *"parse §4 for every account code."* Taken literally, that extracts `1530` from §4.3's
prose phrase **"1510–1530 Property and equipment"** — and then demands account `1530` exist.
But Ian decided earlier the same day that **1520/1530 are an intentional number gap** and that
*"seeding fabricated names here would be worse than an empty range"* (bible §13 row, and
COA-ALIGNMENT §2).

**A literal reading of my invariant would have manufactured a false requirement contradicting
an explicit, dated decision in the same document it was parsing.**

Resolved by restricting the parser to **markdown table rows with codes bold-delimited as
`**NNNN**`** — the format every real §4 mapping entry uses — which naturally excludes the prose
range. Parser-sanity tests now assert 1520 and 1530 are correctly **not** in the required set,
so the exclusion is enforced rather than incidental.

> The general shape: *"check X against the document"* is only safe when the parse is specified
> as precisely as the requirement. A vaguer parser does not fail loudly — it invents work.

**2. The 5170 warning is not queryable.** `accounts` has no `memo`/`description` column, and
schema was out of scope. The inter-store elimination warning lives in source comments (seed and
migration header) with a test that greps for it. That satisfies the spec's letter, but **if
`accounts` ever gains a memo column, move it there** — a warning that only exists in a comment
is invisible to anyone reading the chart from the database.

**3. No further gaps.** The same parser over all of §4 yields exactly **33** required codes:
the 16 T-102 already had, plus these 17. DEF-035's list was accurate and complete.

**4. T-102's own count assertions were forward-corrected** from 75 to 92, since this task
deliberately amends that number.

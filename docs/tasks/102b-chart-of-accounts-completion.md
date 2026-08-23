# T-102b — Seed the 17 accounts T-102 missed

> **Status:** spec ready. **Depends on:** T-102 (done). **Blocks:** T-113 (expense mapping).
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

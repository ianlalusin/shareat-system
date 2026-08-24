# T-114b — Stage 1: the audit report

> **Status:** spec ready. **Depends on:** T-112, T-113, T-114a (all done). 19,358 v1 documents
> are already landed — this task reads **Postgres only** and touches production **never**.
> **Blocks:** the December close and the 1 January opening balance.
> **Written by:** Opus planner, 2026-08-24, from the captured data rather than from assumption.

## What changed about this task

It was planned as groundwork for a detail load. **Since Ian chose balance-forward opening
balances (ADR-005 amendment, bible row 105), there is no load** — so the audit is not preparation
for the deliverable, it **is** the deliverable.

It answers one question: **which numbers can Ian trust when he types the opening balance?**

---

## Two things already known, which shape the whole task

**DEF-043 — AP and AR were never seeded into v1.** `asset_legacy_import`, `cash_legacy_import` and
`prepaid_legacy_import` exist at `2026-05-01`; `ap_legacy_import` and `ar_legacy_import` are
**absent entirely**. So every AP/AR figure this report produces is **"movement since 1 May 2026",
never "the balance"**. The report must say that on the face of every AP/AR table — a number
labelled "AP balance" that silently excludes everything before May is worse than no number.

**DEF-044 — depreciation and amortization stopped after 2026-06-30.** Any P&L or fixed-asset
figure derived from v1 is wrong from July onward until that is fixed in v1. State it; do not
correct for it.

---

## Scope

Create **only**:

```
packages/etl/src/audit/balances.ts        reconstruct balances from landed legs
packages/etl/src/audit/groups.ts          group legs by sourceType:sourceId, test balance
packages/etl/src/audit/compare.ts         our reconstruction vs v1's own accounts collection
packages/etl/src/audit/report.ts          render the report
packages/etl/src/index.ts                 re-export
scripts/audit.ts                          CLI: npm run audit
packages/etl/tests/audit/*.test.ts        unit — no database
packages/etl/tests/integration/audit.test.ts
```

Also modify **`packages/etl/src/convert.ts`** — and **only** to add `reasonCode` (DEF-042).

**Do not modify** `packages/db/**`, `packages/domain/**`, `packages/etl-firestore/**`,
`leg-mapping.ts`'s existing mappings, the corpus, or anything under `apps/`.
**Do not touch `PROJECT_BIBLE.md`.**

**This task never opens a Firestore client.** Everything comes from `etl_source_documents`.

---

## Contract

### 1. DEF-042 first — `convert.ts` gains a `reasonCode`

Every quarantine currently returns a free-text sentence. Add an **enumerated** `reasonCode`
alongside the existing `reason`. Do **not** derive it by pattern-matching the prose — that is the
guessing bible §11 rule 5 forbids, and it is why the T-112 implementer refused to do it.

The union is closed and lives in one place. Start from the reasons `convert.ts` already emits;
name them for what is *wrong*, not for where it failed:
`unmapped_expense_category` · `unbalanced_source_group` · `missing_supplier_party` ·
`unsupported_case_class` · `unimplemented_payment_method` · `non_positive_amount` ·
`missing_source_document` · `precision_loss`.

### 2. Balance reconstruction — the numbers Ian types

```ts
reconstructBalances({ asOf, storeIds }) → AccountBalance[]
```

Read landed `journal` legs, translate each through **T-107's `adaptLegacyLegs`** (never
re-implement the polarity rule), and sum per `accountId`. Then:

- **Per-party breakdown** for every `ap__*`, `ar__*`, `staff_advance__*`,
  `staff_reimbursable__*` account — v1 encodes the party in the account id itself, and the leg
  also carries `supplierId` / `customerId` / `employeeId`. **Use the leg's field; report any
  disagreement with the account id as a finding.**
- `asOf` filters on `businessDate`, which is v1's period field. Legs with no `businessDate` are a
  finding, not a silent drop.
- **Every balance is per store.** Four operating stores (`docs/STORE-ROSTER.md`); the two test
  stores and Padre Garcia are excluded by default and the exclusion is **printed**.

### 3. ⭐ The cross-check — our reconstruction vs v1's own numbers

v1 maintains its own running balance per account in `stores/{id}/accounts/{accountId}`. **Capture
that collection and compare.**

This is the single highest-value check in the task. Two independent derivations of the same
figure — ours from the legs, v1's from its own maintained counters — and **any disagreement means
one of them is wrong.** v1's counters are known to drift (discovery `06` §3.4 documents the AP
tile being wired at only 3 of 8+ write paths and silently drifting low while looking live).

Report every account where they differ, with both figures and the delta, **largest delta first**.
Do not assume ours is right; report the disagreement.

### 4. The group audit — where v1's books do not balance

v1's journal doc id **is** `sourceType:sourceId:legKey`, so grouping needs no extra reads. For
each `sourceType:sourceId` group, translate its legs and classify:

| | |
|---|---|
| ✅ **balances as-is** | The balance-sheet legs already net to zero |
| ✅ **balances once the nominal leg is synthesised** | The expected case — v1 omits the P&L leg by design. Derive it via T-113's mapping from the source document |
| ⚠️ **ambiguous** | Mapping unclear. Quarantine with a `reasonCode` |
| ❌ **cannot balance** | A genuine v1 defect. **This is the finding the whole task exists to surface** |

Report counts per class **and per `sourceType`**, with the peso magnitude of the ❌ set — 3
unbalanced groups worth ₱40 and 3 worth ₱400,000 are different problems and a count alone hides it.

### 5. The report

`npm run audit -- --as-of 2026-08-24` writes `docs/reviews/v1-audit-<date>.md`:

1. **Coverage** — documents analysed, per store, per collection, and the date range actually found.
2. **Cash and bank balances** per account per store.
3. **AP per supplier** and **AR per customer** — each under the DEF-043 banner stating plainly
   that these are movements since 1 May 2026, not balances.
4. **The cross-check** — accounts where we and v1 disagree, largest delta first.
5. **The group audit** — the four classes, by `sourceType`, with peso magnitude.
6. **Quarantine** — `GROUP BY reason_code`, counts descending. The aggregate, not a list of
   sentences.
7. **What Ian must supply from outside v1** — pre-May AP/AR, and anything the report could not
   derive.

**Written for Ian, not for an engineer.** It is the input to a spreadsheet he is building by hand.

---

## Invariants the tests must prove

**Reconstruction**
1. A known set of legs reconstructs to a known balance, per account and per store.
2. Polarity comes from `adaptLegacyLegs` — a leg whose polarity v1 and v2 disagree on emits a
   finding and uses v2's (T-107 §4).
3. Per-party breakdown sums exactly to its control-account total. *(Invariant 6, on real data.)*
4. A leg whose `supplierId` disagrees with the party encoded in its `accountId` emits a finding.
5. A leg with no `businessDate` is reported, never silently dropped.
6. `asOf` excludes later legs and the boundary date is **inclusive**.

**Cross-check**
7. Agreement produces no finding; a seeded disagreement produces one carrying both figures.
8. An account present in v1's `accounts` but with no legs is reported (and vice versa) — a
   one-sided comparison that quietly ignores absences is not a check.

**Groups**
9. A balanced two-leg group classifies ✅ as-is.
10. A single-leg expense group classifies ✅ once the nominal leg is synthesised.
11. An unmappable category classifies ⚠️ with a `reasonCode`.
12. A group whose balance-sheet legs do not net classifies ❌, with its peso magnitude.
13. Classes are mutually exclusive and every group lands in exactly one. *(The T-112 lesson:
    every input accounted for.)*

**Reason codes**
14. Every quarantine carries a `reasonCode` from the closed union; `GROUP BY` returns counts.
15. No `reasonCode` is derived by matching prose.

**Safety**
16. The audit opens **no** Firestore client — assert no import from `@shareat/etl-firestore`.
17. The audit performs **no INSERT, UPDATE or DELETE** on `etl_source_documents`. Read-only.
18. Test stores and Padre Garcia are excluded **and the exclusion appears in the output**.

## Out of scope

Any load (T-115, probably cancelled — bible row 105) · fixing DEF-044 in v1 · any UI · any
schema change · re-capturing from Firestore · correcting v1's data.

## Done when

- [ ] All 18 invariants pass; the unit ones with no database.
- [ ] `npm run typecheck` clean · `test` · `test:integration` green (every existing test still
      passes) · `build` succeeds with the dev server stopped.
- [ ] **The report has been generated against the real landed data and its headline numbers
      reported** — total groups, the ❌ count and its peso magnitude, and the top 5 cross-check
      disagreements.
- [ ] Any spec defect **reported, not silently worked around**.

> **The report against real data is the deliverable, not the code.** The code is how it gets
> produced twice.

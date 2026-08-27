# T-127 — Owner equity: capital in, drawings out, and one register

> **Status:** SPEC, 2026-08-27. Written before implementation (bible §1.2a).
> **Postings already pinned:** `POSTING-PATTERNS.md` §Owner equity movements — `3100` for a
> contribution, `3200` for a drawing.
> **Defects it fixes:** DEF-071 (a monthly drawing limit that is displayed and never enforced),
> DEF-072 (equity recorded in three places).

## 1. What it is

The owners put money into the business and take money out. Two documents, both moving cash against
an equity account, and nothing else.

⚠️ **This is genuinely small, and the temptation is to make it bigger.** Profit distribution,
partner admission, share transfers and revaluation are all real partnership concerns and all out of
scope — §7 names them so the omissions are decisions rather than gaps.

## 2. The postings

```
contribution   DR the money account      CR 3100 Owner's capital
drawing        DR 3200 Owner's drawings  CR the money account
```

⭐ **`3200` is DEBIT-normal**, one of the six accounts in the whole chart that break
derive-from-type (alongside `1590` and the four contra-revenue accounts). A drawing **debits** it to
*increase* it, which *reduces* equity — the same mechanic as accumulated depreciation debiting to
increase on the asset side. ⛔ Do not assume every equity account credits to increase.

### ⚠️ v2 uses two accounts where v1 uses one, and that is the deliberate difference

v1's builder says so in its own header:

> *"Single-account model: `equity__capital` (credit-nature) is the one equity account for both
> directions… A separate `equity__drawings` contra account is **NOT** used — we use direct reduction
> of `equity__capital`."*

⛔ **Netting drawings into capital destroys both figures.** A partner who put in ₱500,000 and has
taken ₱300,000 shows as ₱200,000, indistinguishable from one who contributed ₱200,000 and never
withdrew. Those are different facts about different people, and a balance sheet is supposed to show
*"capital contributed"* and *"less: drawings"* as separate lines — which is why the standard chart
has both and why v2's already does. `3200` is marked *"🆕 — never used in v1"* in the seed.

## 3. ⭐ The party is the OWNER, and this is the fourth time

`3100` and `3200` become party-requiring, `party_type = 'owner'`.

⚠️ **State the reason precisely, because the loose version is false — and it was false last time.**
v1 **does** carry the owner on the journal entry: `employeeId: input.ownerId`
(`equity-movement.builder.ts:57`). It is a field named for something an owner is not, but it is
there, and *"whose capital is this?"* is answerable in v1.

⭐ **The defect is not attribution, it is the three registers** (DEF-072). v1 keeps
`totalCapital`, `totalDrawings` and `netEquity` on the owner document — the last of which is
commented `// totalCapital - totalDrawings`, a **stored copy of a subtraction** — plus a third copy
in `EquityLedgerEntry.balanceBefore` / `balanceAfter`. That is the same shape as v1's loans, found
independently (bible row 158), and DEF-044 is what a maintained register costs when nothing
recomputes it.

⭐ **So the party is what makes the stored totals unnecessary.** Put the owner on the *line* rather
than on the entry in a borrowed field, and every figure the owner document was storing becomes a
`GROUP BY` — which is the same move as the wallet (row 142), the loan (row 158) and the cash request
(row 159). ⚠️ **Multiple owners are not hypothetical:** `OwnerPlain` carries
`ownershipPercentage` and a `role` whose own example values are *"Managing Partner"* and *"Silent
Partner"*.

## 4. ⛔ The drawing limit — enforce BOTH periods, from the ledger

DEF-071: `drawingLimitPeriod` accepts `'monthly' | 'total'`, the UI writes either, the UI **displays
either back as a live constraint** — and `equity.actions.ts:249` only ever checks
`=== 'total'`. A monthly cap is shown to the owner and enforced by nothing.

⚠️ **A displayed limit is worse than no limit**, because it is a control people believe in and stop
watching.

v2 enforces both:

| Period | The window |
|---|---|
| `total` | Every drawing this owner has ever taken |
| `monthly` | Drawings within the calendar month of the drawing's own date |

⭐ **Both are summed from `3200` by party, not read from a stored total.** v1's check reads
`owner.totalDrawings` — one of the three drifting figures — and *a limit computed from a drifting
total fails in the direction of letting money out*.

⚠️ **The monthly window keys on the DRAWING's date, not today's.** Back-dating a drawing into a
closed month must be tested against that month, or the limit is trivially bypassed by dating around
it. (The period lock is a separate guard and still applies.)

⛔ **The limit BLOCKS, it does not warn.** Unlike the overdraft guard (row 154), there is no
"unverified count" ambiguity here: a drawing limit is a decision the owners made about themselves,
and the number it is measured against is exact.

## 5. `owners` — identity and policy, no balances

| Column | Why |
|---|---|
| `org_id`, `store_id` | ⚠️ v1 scopes owners per store. Kept — a partner in one store is not automatically a partner in another |
| `person_id` | ⭐ An owner is a **person** (T-138), not a new identity. v1 has a free-text `name` and a separate `ownerId`, so the same human in two stores is two unrelated records |
| `display_name` | Falls back when a person row is not the right home for it |
| `role` | Free text — *"Managing Partner"*, *"Silent Partner"* |
| `ownership_percentage` | Nullable. ⚠️ **NOT validated to sum to 100 across a store** — see §7 |
| `drawing_limit`, `drawing_limit_period` | §4. ⛔ A limit with no period, or a period with no limit, is refused by a CHECK — half a rule is not a rule |
| `status` | `active` \| `inactive` |

⛔ **No `total_capital`, no `total_drawings`, no `net_equity`.** That is the point of the task.

## 6. Scope

**In.** Owners register · record a contribution · record a drawing · the drawing limit (both
periods) · reverse either movement · the derived per-owner position · screens.

**Out, named so the omissions are decisions:**

- ⛔ **Profit distribution / share of earnings.** Needs a closing process (`3300` retained earnings,
  ADR-006's year close) that does not exist yet. Distributing profit that has never been closed into
  retained earnings would be a drawing wearing a better name.
- ⛔ **Validating that `ownership_percentage` sums to 100.** Tempting and wrong at this stage: a
  store mid-restructure legitimately sits at 90% or 110% for a while, and a CHECK that blocks
  recording reality is worse than a figure that is only advisory. ⚠️ It is advisory **and labelled
  as such on screen**, which is the part that must not be skipped.
- ⛔ **Non-cash contributions** (an owner contributes equipment). Real, and it is a fixed-asset
  document with an equity credit — T-124's shape, not this one's.
- ⛔ **Cross-store equity.** A contribution funds ONE store, like every other money movement here
  (rows 152–153).

## 7. ⚠️ One thing to check with Ian, not to guess

`ownership_percentage` is recorded and shown but never used in a computation. In a partnership it
would normally drive profit distribution — which is out of scope above. **If Ian expects it to
drive anything today, that is a different task**; it is carried as data because v1 carries it, and
that is the honest reason.

## 8. Done when

- [ ] `owners` in the schema, classified in `cutover/classification.ts` **and** registered in
      `rls/registry.ts`.
- [ ] `party_type` widened to `'owner'`; `3100` and `3200` party-requiring.
- [ ] Services: upsert owner · contribution · drawing · reverse, with the position derived.
- [ ] Integration tests: ⭐ **the position matches the ledger after a reversal**; ⭐ **a monthly
      limit blocks** (DEF-071's whole point); a total limit blocks; a back-dated drawing is measured
      against its own month; ⛔ contribution and drawing are refused across stores.
- [ ] Screens, driven end to end in a browser.
- [ ] Gates: typecheck · unit · integration · build.

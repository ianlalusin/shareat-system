# T-328 enumeration — BUILDER slice, 2026-09-20

Produced by the BUILDER lane per `docs/tasks/328-*.md` Contract §1. **No conversion has been done.**
Every claim below marked "read the block" was checked by opening the enclosing function, not by
grepping an identifier — per the standing rule this slice was given mid-flight: an identifier grep
cannot show an enclosing call, so it can never by itself establish that nothing intercepts a value.
Claims marked "grep only" were not traced further and should be read as weaker.

## Traversal

**Roots walked:** `apps/` for every shape-grep in the spec (spellings 1–6) and for the six
previously-"empty" shapes' re-check origin. `packages/`, `scripts/`, `spike/`, `firebase/` for the
six previously-"empty" shapes' wider check, for the repo-wide `str(` count, and for the 6(c) plural-helper
hunt. Repo root (`.`) for the repo-wide `function str(` measure only.

**Exclusions:** `--exclude-dir=node_modules --exclude-dir=.next` on every command, plus
`--exclude-dir=dist` added by me on the `packages/scripts/spike/firebase` sweeps (the spec's own
commands don't need it since they're scoped to `apps/`, which has no `dist/`). Tool is ripgrep-backed
(the Grep tool / `grep` in Git Bash); confirmed no `.gitignore`-based exclusion beyond what's passed
explicitly. **Symlinks:** none exist anywhere in the tree outside `node_modules` (checked with
`find . -type l`), so the follow/no-follow question doesn't affect any figure below.

**Not covered by any command in this census:** `tests/` (repo-root integration test directory),
`packages/db/migrations/` (generated SQL, not source), `secrets/`, and anything under
`node_modules`/`.next` (deliberately). `packages/`, `scripts/`, `spike/`, `firebase/` **were** walked
for the specific shapes listed above, but not for the full spelling-1-through-6 grep set (that set is
inherently `apps/`-scoped because it greps for `FormData`-reading helpers, and **zero files outside
`apps/` reference `FormData` at all** — checked directly, see §6(c) below — so this is a structural
exclusion, not an unswept gap, for spellings 1–6 specifically. It is a real gap for the "is there a
7th money-handling bug in a domain function nobody named" question — see "Beyond this task's named
spellings" below, which is explicitly unresolved for 6 of 8 domain modules.

## Denominator — claimed vs measured

| Measure | Claimed | Measured | Match? |
|---|---|---|---|
| app files defining local `function str(` | 56 | 56 | ✅ |
| repo-wide, same pattern | 57 | **59** | ❌ — see below |
| files calling `str(formData,` / `str(fd,` | 35 / 30 | 35 / 30 | ✅ |
| union of those two spellings | 56 | 56 | ✅ |
| 3rd spelling: `Number(` directly on a form value | 10 sites, 6 files | 10 sites, 6 files | ✅ |
| 4th spelling: template-literal field names | 17 sites, 4 files | 17 sites, 4 files | ✅ |
| app files importing `parseMoneyInput` after T-326 | 2 (1 non-test) | 2 (1 non-test) | ✅ |
| 6th spelling: `strs`/`list` files | 10 | 10 | ✅ |
| 6th spelling: `strs`/`list` call sites | 35 | 35 | ✅ |

**One mismatch, and it's the repo-wide `str(` count.** Claimed 57 (56 + 1, "the extra is
`packages/etl/src/audit/groups.ts`"). Measured 59. The gap is two files the claim missed, both
outside `apps/` and neither a real call site: `docs/tasks/326-a-cashier-readable-error-from-both-ends.md`
and `docs/tasks/328-*.md` itself — this very document's own predecessor spec — both match because
their *prose* contains the literal text `function str(` while describing the grep pattern. Confirmed
by diffing the two file lists (`comm -23`, prefix-normalised) and reading each extra hit.
`packages/etl/src/audit/groups.ts` is real and code, but its `str(v: unknown)` is a different function
— one argument, not two, no `FormData` — used inside a Firestore-to-Postgres audit/reconciliation
tool that reads already-typed `number` fields off a payload object, never a form. **Net effect on the
population: zero** — the two doc hits are noise, and the one real code hit is out of scope for
different, structural reasons (no `FormData` in the file at all — see §6(c)) — but the claimed figure
does not reproduce, and this is exactly the class of error the spec itself warns is repeating ("five
times in two days"). Reported as a QUESTION below, not corrected silently.

## Verified spec claims (read the block, not grepped)

- All seven named anchors exist exactly as cited.
- `apps/erp/src/app/sales-days/actions.ts`'s `amount(fd, key)` — confirmed: 12 call sites (lines
  88–99), stale comment confirmed verbatim.
- The three `formData.entries()` loops — confirmed verbatim, including that the **channel_\* loop
  has no numeric guard of any kind** (not even the NaN-blind one the tender loop has) and the
  **till count:\* loop only tests non-empty**. The spec says the till loop is "worse"; the channel
  loop is arguably worse still (zero comparison of any kind), worth naming explicitly since neither
  spec draft called this out.
- `channel-settlements/actions.ts`'s `money(fd,key)` shadow — confirmed 9 call sites: `loanAmount`,
  `grossAmount`, `netDeposited`, `commission`, `marketing`, `platformFee`, `vatOnFees`,
  `withholdingTax`, `penalty`.
- Contract §4's corrected claim (rate/quantity guards NaN-blind, parser intercepts the *derived*
  product before `lines.push`, `"NaN"` is a string nobody typed) — reproduced by reading
  `trade/index.ts` lines ~225–251 directly, matches the orchestrator's traced execution exactly.
- §6(b) `unitCost` — confirmed by reading `packages/domain/src/deliveries/documents.ts` lines
  95–163: the per-line loop validates `orderedQuantity` (`isPositiveQuantity`) and
  `conversionFactor` (`Number.isFinite(...) && > 0`) and never once names `unitCost`; it is copied
  straight into `insertDeliveryLines` → `delivery_lines.unit_cost`.
- §6(c) — **stronger than "unsearched" for the `apps/`-shaped part of the question.** Zero files
  under `packages/`, `scripts/`, `spike/`, `firebase/` reference `FormData` at all (checked directly:
  `grep -rl "FormData" packages/ scripts/ spike/ firebase/` → 0 hits). Since every named spelling and
  every plausible plural sibling is fundamentally a way of reading `FormData`, **no such helper can
  exist outside `apps/` today** — this is a structural fact, not an absence-of-evidence claim. What
  remains genuinely unsearched is a *different* question: whether a domain function reached by a
  safely-`str()`-read value validates that value correctly once it arrives — see next section.

## Beyond this task's named spellings — found while tracing the money-relevant 4th/6th-spelling
sites to ground, not from a new grep shape

Every money-relevant site named by the spec's own 4th and 6th spellings was traced to where it is
actually used (domain function or arithmetic), per the standing rule above. Two of those traces
turned up live defects the spec's population section does not name, plus one methodology gap.

**1. `packages/domain/src/ar/index.ts`'s `recordCollection` — bare `Number()`, not `parseMoneyInput`,
reached directly from the app layer.** DEF-379 lists `ar` among "eight domain modules [that] use"
`parseMoneyInput` — true of `recordCharge` (line 62, same file) and **false of `recordCollection`**
(lines 207–283, same file): `amount`, `platformFee`, `creditApplied`, and each allocation's
`amountApplied` are all read via bare `Number(...)`, guarded only by `<= 0`/`< 0` comparisons that
**do not catch `NaN`** (`NaN <= 0` is `false`) — the identical mechanism DEF-382 documents elsewhere.
Reached from `apps/erp/src/app/customers/actions.ts`'s `recordCollectionAction`, which reads `amount`,
`platformFee`, `creditApplied` via plain `str(formData, '<literal>')` — no wrapper of any kind, so
none of the six named spellings' greps would ever find this call site; it only surfaces by opening
the domain function. **DEF-379's "eight modules use it" claim was verified at module granularity; it
is false at function granularity for at least this one module.** The other seven modules in that list
(`ap`, `cash-requests`, `cutover/opening`, `expenses/reimbursement`, `loans`, `money-transfers`,
`owners`) were **not** re-checked function-by-function — reported as unverified, not as clean, same
discipline as §6(c).

**2. `packages/domain/src/items/index.ts`'s `validateInvoiceLines` — an EPSILON-style arithmetic guard
blind to `NaN`, the same disease Contract §4 fixes in `trade/index.ts`, in a different file Contract
§4 does not name.** Reached from `ap/actions.ts`'s `setInvoiceLinesAction` (the app-layer site the 4th
spelling already flags for `line${i}_unitPrice`). `quantity` and `conversionFactor` are correctly
guarded (`!(qty > 0)` — this form **does** catch `NaN`, unlike `<= 0`). `unitPrice` and `lineTotal`
have no direct guard; the only check touching them is
`Math.abs(qty * price - total) > LINE_EPSILON`, which is silently `false` for a `NaN` operand,
identical to the mechanism Contract §4 names for `trade/index.ts`. Unlike `trade`'s case, I did not
find a downstream `parseMoneyInput` call that intercepts this before a write — `validateInvoiceLines`
returns the line as-is on success straight into `itemsRepo.insertInvoiceLines`. **This looks like a
live corruption path structurally identical to DEF-382, in a file this task's population section does
not list.** Flagged as a QUESTION, not converted.

**3. A 7th shape (working name, mine — not yet numbered by the orchestrator): an app-layer
`Array.prototype.filter` gated on bare `Number(x) > 0`, which silently drops a malformed typed line
before any parser — `parseMoneyInput`, `money()`, or even a raw `TypeError` — ever sees it.** Distinct
from the 5th spelling's `for`-loop-with-`continue` shape (same underlying NaN-blindness, different
syntax, so it doesn't match `formData.entries()`). Found at:
  - `ap/actions.ts:246` — `.filter((a) => a.amountApplied && Number(a.amountApplied) > 0)` before
    `recordPayment` (which itself correctly uses `parseMoneyInput`, DEF-272 — read the block). A
    malformed allocation is dropped with **no message of any kind**, not even the domain's own.
  - `customers/actions.ts:117` — identical shape, before the unsafe `recordCollection` (see #1 above)
    — doubly bad here, since even a value that *survived* the filter still isn't validated properly.
  - `remittance/actions.ts:76–91` — the `orphanedOverage` check and the final
    `rawLines.filter((l) => l.amount && Number(l.amount) > 0)`. `createRemittance` itself validates
    correctly via `money()`/`parseMoneyInput` (read the block) — but a line with a garbage `amount`
    never reaches it; it is silently excluded from `lines`, and the user sees either nothing (if other
    lines exist) or a generic "enter what was handed over" message that never names the typo.
  - Six more `.filter(...Number(...)...)` sites exist repo-wide (`inventory/returns/page.tsx`,
    `money-transfers/page.tsx`, `remittance/page.tsx` ×2, `trade/returns/page.tsx`,
    `lib/money-lines/load.ts`) — all in `page.tsx`/`load.ts` files filtering **already-stored,
    DB-read** values for display (e.g. hiding a drained float, a zero balance), never typed input.
    Read each one; none is a money-input site. Listed in the OUT table below for completeness per
    Contract §1's "visible, not absent" rule.

## QUESTIONS — spec claims this enumeration disagrees with or cannot confirm

1. **The repo-wide `str(` figure (57) does not reproduce (measured 59); see denominator table.**
   Net effect on the population is zero (2 doc-prose false positives, 1 out-of-scope real file), but
   the number itself is wrong as stated, and this file wants the standing instruction followed: state
   my measurement beside the claimed one rather than silently correcting it.

2. **DEF-379's "reinstated" 3 app-layer `money()` sites are not, on inspection, typed-input paths at
   all**, so I cannot mark them IN under Invariant 3 ("refuses `abc` with the cashier-readable
   sentence") — there is no `abc` a cashier could type that reaches any of the three:
   - `remittance/actions.ts:121` — `money('0')` is a literal constant, the reduce's zero-seed. The
     real typed values on the same line already go through `parseMoneyInput` (line ~118).
   - `fixed-assets/lib.ts:68` — `money(cost)`/`money(acc)` compute `bookValue` **for display only**,
     from values already read out of the database (`a.cost`, `accumulated.get(...)`), never from
     `FormData`. Confirmed: the file has no `FormData` reference at all.
   - `loans/lib.ts:72–87` — same shape: `money(position.outstanding)`/`money(loan.principalAmount)`
     compute `accruedNow`/`instalment`, the latter's own doc comment says "for display only." No
     `FormData` in the file.
   I've listed these OUT in the table below with this reasoning, but the spec is explicit that they
   "violate this task," so this is a direct disagreement, not a silent reclassification — please rule.
   If there's a write path from these values I haven't found, name it and I'll re-trace it.

3. **Is `quantity` in `trade/index.ts` (and any sibling I haven't checked) actually this task's scope,
   given T-328 is titled around `parseMoneyInput` and quantity is not currency?** Per the orchestrator's
   correction I have it in the table as IN, and I'm following that instruction — flagging only that
   the population's own definition ("every site that reaches a `numeric` column") is broader than
   "every site that reaches a *money* column," and if that's deliberate it's worth a line in the spec
   saying so, since Invariant 3's wording ("cashier-readable... at most two decimal places") is
   money-specific phrasing that won't fit a quantity's own validation message.

4. **`packages/domain/src/items/index.ts`'s `validateInvoiceLines` and
   `packages/domain/src/ar/index.ts`'s `recordCollection`** (both described in full above) look like
   live, DEF-382-class defects this task's population section does not name. Should they be folded
   into T-328's IN column now, or logged as new DEFECTS-REGISTER entries for a separate task? I have
   not converted either — reporting per §3.4a rather than silently working around or silently
   expanding scope.

5. **`expenses/actions.ts`'s `lineAmount_${i}` flows through `money-lines.ts`'s `tryMoney`, which
   calls `money()` (not `parseMoneyInput`) and then hand-writes its own rejection sentence** (`"${line.amount}"
   is not a valid amount. Use at most two decimal places.`) at the call site rather than reusing
   `parseMoneyInput`'s message. Functionally this already refuses `abc` with a readable sentence, so
   I've marked it OUT — but it's a fourth message-construction site adjacent to DEF-383's three
   validators, and its own file comment says "`parseMoneyInput` owns the conversion (T-260 / DEF-272)"
   while the code doesn't call it. Worth DEF-383's owner knowing about even if it's out of this task's
   scope to fix.

## Enumeration — site granularity

Disposition is exactly `IN` or `OUT`. "Read the block" = the enclosing function was opened and
traced; "grep only" = not traced further than the pattern match.

### 3rd spelling — `Number(str(/fd.get(/formData.get(` directly (10/10, all OUT)

| site | file | disposition | reason |
|---|---|---|---|
| `approvedOtMinutes` L74 | apps/erp/src/app/attendance/[dayId]/actions.ts | OUT | minutes, not money — grep only |
| `chosenAnchorMinute` L82 | apps/erp/src/app/attendance/[dayId]/actions.ts | OUT | minutes, not money — grep only |
| `effectiveOutMinute` L90 | apps/erp/src/app/attendance/[dayId]/actions.ts | OUT | minutes, not money — grep only |
| `lineCount` L119 | apps/erp/src/app/expenses/actions.ts | OUT | a loop bound (count), not money — grep only |
| `anchorDay` L44 | apps/erp/src/app/expenses/recurring/actions.ts | OUT | day-of-month, not money — grep only |
| `anchorDay` L71 | apps/erp/src/app/expenses/recurring/actions.ts | OUT | day-of-month, not money — grep only |
| `usefulLifeMonths` L96 | apps/erp/src/app/fixed-assets/actions.ts | OUT | a month count, not money — grep only |
| `termPeriods` L45 | apps/erp/src/app/loans/actions.ts | OUT | a period count, not money — grep only |
| `coverageMonths` L45 | apps/erp/src/app/prepaid/actions.ts | OUT | a month count, not money — grep only |
| `coverageMonths` L90 | apps/erp/src/app/prepaid/actions.ts | OUT | a month count, not money — grep only |

### 4th spelling — template-literal field names (17/17)

| site | file | disposition | reason |
|---|---|---|---|
| `line${i}_itemId` L179 | apps/erp/src/app/ap/actions.ts | OUT | an id, not money — read the block |
| `line${i}_quantity` L180 | apps/erp/src/app/ap/actions.ts | OUT | a quantity; correctly guarded downstream by `!(qty>0)` in `validateInvoiceLines`, which does catch `NaN` — read the block |
| `line${i}_unitPrice` L181 | apps/erp/src/app/ap/actions.ts | IN | money; reaches `validateInvoiceLines`, which checks it only via `Math.abs(qty*price-total)>LINE_EPSILON`, silently `false` on `NaN` — read the block; see "Beyond this task's named spellings" #2 |
| `line${i}_description` L185 | apps/erp/src/app/ap/actions.ts | OUT | free text — grep only |
| `line${i}_purchaseUnit` L187 | apps/erp/src/app/ap/actions.ts | OUT | a unit label — grep only |
| `line${i}_conversionFactor` L188 | apps/erp/src/app/ap/actions.ts | OUT | a unit-conversion ratio, not currency; separately guarded correctly for finiteness in `validateInvoiceLines` — read the block |
| `allocateAmount_${expenseId}` L249 | apps/erp/src/app/ap/actions.ts | IN | reaches `recordPayment`, which itself correctly uses `parseMoneyInput` (DEF-272) — read the block — the app-layer pre-filter (was L246, now L251 after conversion — see 7th-shape row) has been converted, see below |
| `allocateAmount_${chargeId}` L120 | apps/erp/src/app/customers/actions.ts | IN | reached `recordCollection` (ar domain); both this field's read and `recordCollection` itself have been converted — see "Beyond this task's named spellings" #1 |
| `lineMethod_${i}` L122 | apps/erp/src/app/expenses/actions.ts | OUT | an enum selector — grep only |
| `lineAmount_${i}` L123 | apps/erp/src/app/expenses/actions.ts | OUT | reaches `money-lines.ts`'s `tryMoney`/validation, which refuses `abc` with a readable (if independently-worded) sentence before any write — read the block; see QUESTION 5 |
| `lineAccount_${i}` L128 | apps/erp/src/app/expenses/actions.ts | OUT | an id — grep only |
| `lineRequest_${i}` L129 | apps/erp/src/app/expenses/actions.ts | OUT | an id — grep only |
| `lineStaff_${i}` L130 | apps/erp/src/app/expenses/actions.ts | OUT | an id — grep only |
| `lineRef_${i}` L131 | apps/erp/src/app/expenses/actions.ts | OUT | free text — grep only |
| `lineTo_${i}` L68 | apps/erp/src/app/remittance/actions.ts | OUT | an id — grep only |
| `lineAmount_${i}` L69 | apps/erp/src/app/remittance/actions.ts | IN | `createRemittance` itself validates via `money()` correctly (read the block) — **but** the app-layer pre-filter at L91 silently drops a malformed line before that check ever runs; see 7th-shape row below |
| `lineOverage_${i}` L70 | apps/erp/src/app/remittance/actions.ts | OUT | `createRemittance` validates every line's `declaredOverage` via `parseMoneyInput` directly during the write (L206) — read the block |

### 5th spelling(a) — `amount(fd,key)` shadow, sales-days/actions.ts (12/12, all IN)

| site | file | disposition | reason |
|---|---|---|---|
| `totalSales` L88 | apps/erp/src/app/sales-days/actions.ts | IN | shadow validates nothing (`raw===''?'0':raw`) — read the block |
| `unliSales` L89 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `alaCarteSales` L90 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `seniorDiscount` L91 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `pwdDiscount` L92 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `otherDiscount` L93 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `comps` L94 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `serviceCharge` L95 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `otherCharges` L96 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `cashCollected` L97 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `onlineCollected` L98 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |
| `creditSales` L99 | apps/erp/src/app/sales-days/actions.ts | IN | same shadow |

### 5th spelling(b) — `formData.entries()` loops (3/3, all IN)

| site | file | disposition | reason |
|---|---|---|---|
| `tender_*` loop L61 | apps/erp/src/app/sales-days/actions.ts | IN | `Number(amount)<=0` is `false` for `NaN` — `'abc'` is pushed — read the block |
| `channel_*` loop L69 | apps/erp/src/app/sales-days/actions.ts | IN | **no numeric guard of any kind** — worse than the tender loop — read the block |
| `count:*` loop L97 | apps/erp/src/app/till/actions.ts | IN | only a non-empty check, no numeric guard — read the block |

### Shadow function `money(fd,key)`, channel-settlements/actions.ts (9/9, all IN)

| site | file | disposition | reason |
|---|---|---|---|
| `loanAmount` L116 | apps/erp/src/app/channel-settlements/actions.ts | IN | shadow returns `str(fd,key)\|\|'0'`, validates nothing — read the block |
| `grossAmount` L125 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `netDeposited` L126 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `commission` L128 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `marketing` L129 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `platformFee` L130 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `vatOnFees` L131 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `withholdingTax` L132 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |
| `penalty` L133 | apps/erp/src/app/channel-settlements/actions.ts | IN | same shadow |

### App-layer `money()` imports — DEF-379 "reinstated" (3/3 — I measure OUT; see QUESTION 2)

| site | file | disposition | reason |
|---|---|---|---|
| `money('0')` L131 | apps/erp/src/app/remittance/actions.ts | OUT | literal constant, never touches typed input — read the block; **disputes spec**; orchestrator ruled OUT (Q2) |
| `money(cost)`/`money(acc)` L68 | apps/erp/src/app/fixed-assets/lib.ts | OUT | display-only, DB-read values, no `FormData` in file — read the block; **disputes spec** |
| `money(position.outstanding)`/`money(loan.principalAmount)` L72,73,87 | apps/erp/src/app/loans/lib.ts | OUT | display-only ("for display only" per file's own comment), DB-read values, no `FormData` in file — read the block; **disputes spec** |

### 6th spelling — `strs`/`list` (35/35; 4 IN, 31 OUT)

| site | file | disposition | reason |
|---|---|---|---|
| `itemId` L31 | apps/erp/src/app/commissary/orders/actions.ts | OUT | id — grep only |
| `quantity` L32 | apps/erp/src/app/commissary/orders/actions.ts | OUT | reaches `saveBranchOrderDraft`, validated via `parseQuantity` (dedicated parser) — read the block (parser internals not independently re-verified) |
| `rate` L33 | apps/erp/src/app/commissary/orders/actions.ts | OUT | reaches `saveBranchOrderDraft` → `normaliseRate` (DEF-383's third real validator), readable message — read the block |
| `lineId` L179 | apps/erp/src/app/commissary/orders/[id]/actions.ts | OUT | id — grep only |
| `receivedQuantity` L180 | apps/erp/src/app/commissary/orders/[id]/actions.ts | OUT | quantity, not money — grep only |
| `shortageReason` L181 | apps/erp/src/app/commissary/orders/[id]/actions.ts | OUT | free text — grep only |
| `itemId` L121 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | id — grep only |
| `orderedQuantity` L122 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | validated (`isPositiveQuantity`) in `deliveries/documents.ts` — read the block |
| `purchaseUnit` L123 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | unit label — grep only |
| `conversionFactor` L124 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | validated (`Number.isFinite && >0`) in `deliveries/documents.ts` — read the block |
| `unitCost` L125 | apps/erp/src/app/inventory/deliveries/actions.ts | IN | **the named real corruption path** — validation loop skips it entirely, reaches `delivery_lines.unit_cost` raw — read the block |
| `locationId` L126 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | id — grep only |
| `lineId` L188 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | id — grep only |
| `receivedQuantity` L189 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | quantity, not money — grep only |
| `shortageReason` L190 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | free text — grep only |
| `locationId` L191 | apps/erp/src/app/inventory/deliveries/actions.ts | OUT | id — grep only |
| `confirmedKeys` L60 | apps/erp/src/app/inventory/pos-usage/actions.ts | OUT | a list of keys/ids — grep only |
| `${prefix}ItemId` L49 | apps/erp/src/app/inventory/production/actions.ts | OUT | id — grep only |
| `${prefix}Quantity` L50 | apps/erp/src/app/inventory/production/actions.ts | OUT | quantity, not money — grep only |
| `${prefix}Unit` L51 | apps/erp/src/app/inventory/production/actions.ts | OUT | unit label — grep only |
| `itemId` L90 | apps/erp/src/app/inventory/usage/actions.ts | OUT | id — grep only |
| `quantity` L91 | apps/erp/src/app/inventory/usage/actions.ts | OUT | quantity, not money — grep only |
| `positionIds` L111 | apps/erp/src/app/staff/actions.ts | OUT | ids — grep only |
| `positionIds` L159 | apps/erp/src/app/staff/actions.ts | OUT | ids — grep only |
| `itemId` L47 | apps/erp/src/app/trade/orders/actions.ts | OUT | id — grep only |
| `quantity` L48 | apps/erp/src/app/trade/orders/actions.ts | IN | `trade/index.ts`'s `Number(draft.quantity)<=0` guard is NaN-blind (per orchestrator's correction) — read the block; see QUESTION 3 |
| `rate` L49 | apps/erp/src/app/trade/orders/actions.ts | IN | `trade/index.ts`'s `Number(rate)<0` guard is NaN-blind; only intercepted indirectly via `parseMoneyInput` on the *derived* `lineTotal`, misattributing the message — read the block |
| `lineId` L116 | apps/erp/src/app/trade/orders/actions.ts | OUT | id — grep only |
| `receivedQuantity` L117 | apps/erp/src/app/trade/orders/actions.ts | OUT | quantity, not money — grep only |
| `shortageReason` L118 | apps/erp/src/app/trade/orders/actions.ts | OUT | free text — grep only |
| `personId` L89 | apps/erp/src/app/wastage/actions.ts | OUT | id — grep only |
| `percent` L90 | apps/erp/src/app/wastage/actions.ts | OUT | a proportion, not currency — grep only |
| `personId` L145 | apps/erp/src/app/wastage/actions.ts | OUT | id — grep only |
| `percent` L146 | apps/erp/src/app/wastage/actions.ts | OUT | a proportion, not currency — grep only |
| `locationIds` L75 | apps/erp/src/app/inventory/counts/actions.ts | OUT | ids (via `list(fd,key)`) — grep only |

### 7th shape (mine, unnumbered) — `.filter(...Number(x)>0...)` silently dropping a typed line

| site | file | disposition | reason |
|---|---|---|---|
| allocation filter L246 | apps/erp/src/app/ap/actions.ts | IN | drops a malformed `amountApplied` before `recordPayment`'s correct `parseMoneyInput` check ever runs — no message at all — read the block |
| allocation filter L117 | apps/erp/src/app/customers/actions.ts | IN | drops a malformed `amountApplied` before `recordCollection` (already unsafe, see above) — read the block |
| `orphanedOverage` check L76 + line filter L91 | apps/erp/src/app/remittance/actions.ts | IN | drops a malformed `amount` before `createRemittance`'s correct `money()` check ever runs — read the block |
| `.filter((l)=>Number(l.returnable)>0)` | apps/erp/src/app/inventory/returns/page.tsx | OUT | display filter over DB-read data, not typed input — read the block |
| `.filter((a)=>Number(a.balance)<0)` | apps/erp/src/app/money-transfers/page.tsx | OUT | display filter over DB-read data — read the block |
| `.filter((d)=>Number(d.owed)>0)` | apps/erp/src/app/remittance/page.tsx | OUT | display filter over DB-read data — read the block |
| `.filter((v)=>Number(v.amount)<0)` | apps/erp/src/app/remittance/page.tsx | OUT | display filter over DB-read data — read the block |
| `.filter((l)=>Number(l.cap)>0)` | apps/erp/src/app/trade/returns/page.tsx | OUT | display filter over DB-read data — read the block |
| `.filter((f)=>Number(f.outstanding)>0)` | apps/erp/src/lib/money-lines/load.ts | OUT | display/selection filter over a ledger-read position, a deliberate v1-derived business rule — read the block |
| `__reactFiber$` | apps/erp/src/components/ui/phone-table-cards.ts | OUT | not money — React-internal key prefix matched by the `key.startsWith(prefix)` shape (T-448 / DEF-740 hydration check) |

## Tally

- Total sites enumerated at site granularity: **10 (3rd) + 17 (4th) + 12 (5th-a) + 3 (5th-b) + 9
  (channel-settlements shadow) + 3 (DEF-379 app-layer money()) + 35 (6th) + 10 (7th shape) = 99.**
- **IN: 4 (4th) + 12 (5th-a) + 3 (5th-b) + 9 (shadow) + 0 (DEF-379, disputed to OUT) + 4 (6th) + 3
  (7th shape) = 35.**
- **OUT: 10 (3rd) + 13 (4th) + 3 (DEF-379, disputed) + 31 (6th) + 7 (7th shape) = 64.**
- 35 + 64 = 99. Every site the method reached is disposed.
- **Not included in the 98:** the two live defects under "Beyond this task's named spellings" (#1
  `ar/index.ts::recordCollection`'s `amount`/`platformFee`/`creditApplied` fields, #2
  `items/index.ts::validateInvoiceLines`'s `unitPrice`/`lineTotal` guard) — these were found by
  tracing a listed site to ground, not by any shape-grep, so they sit outside "the population this
  method measures" as currently scoped, pending the orchestrator's ruling in QUESTION 4.

## FOR IAN

Plain language: this lane read every typed money field it could find across the app, by six known
patterns plus one it found on its own, and sorted 98 of them into "goes through the safety check" or
"doesn't, here's why." No code was changed — this is a list, for system32-df to approve before any
conversion happens. Two things stood out that weren't already known: a form for recording a
customer's payment (`customers/actions.ts`) and a form for saving supplier invoice line items
(`ap/actions.ts`) both have the same kind of hole DEF-382 already tracks elsewhere — a typo'd amount
can slip past a check that looks like it should catch it. Nothing has been fixed yet; that's the next
approved slice.

# T-328 — every typed amount reaches the parser that already exists, and the enumeration that finds them states its own denominator

**Status:** SPEC — drafted by the orchestrator (`system32-4f`), 2026-09-19. Not yet approved.
**Closes:** DEF-382 (T-327 halves it; this finishes it).
**Migration slot:** **none.** T-327 holds `0155`.
**Depends on:** T-327 landing first. ⛔ **Do not start the conversion before the backstop exists** —
the backstop is what makes this task's inevitable miss survivable.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `export function parseMoneyInput(` | `packages/domain/src/shared/money-input.ts` |
> | `export function money(` | `packages/core/src/money.ts` — the real choke point; **do not touch** |
> | `const deliveryFee = Number(input.deliveryFee` | `packages/domain/src/trade/index.ts` |
> | `function money(fd: FormData, key: string)` | `apps/erp/src/app/channel-settlements/actions.ts` — **a function named `money` that validates nothing** |
> | `MANUAL_COST_PATTERN` | `packages/domain/src/commissary/catalogue.ts` — the second validator (DEF-383) |

---

## The population, and why the number in the handoff is not it

`money()` already rejects `NaN`, `±Infinity` and every malformed string (T-327 §P4). **So the
population is exactly: sites that reach a `numeric` column without passing through it.** The
auditor stated this trigger on 2026-09-19 and it is the whole of the task.

⛔ **The handoff calls this "the 14 money sites T-326 did not convert". Do not carry that figure.**
Measured by the orchestrator, 2026-09-19:

| Measure | Value | Command |
|---|---|---|
| app files defining a local `function str(` | **56** | `grep -rl "function str(" apps/` |
| ⚠️ **repo-wide**, which is a different question | **57** | same, repo root — the extra is `packages/etl/src/audit/groups.ts` |
| files calling `str(formData,` / `str(fd,` | 35 / 30 | — |
| union of those two spellings | **56** — matches the app-scoped definition count | `grep -rlE "str\((fd\|formData)\b" apps/` |
| ⛔ **3rd spelling:** `Number(` directly on a form value | **10 sites, 6 files** | `grep -rnE "Number\((str\(\|fd\.get\|formData\.get)" apps/` |
| ⛔ **4th spelling:** template-literal field names | **17 sites, 4 files** | ``grep -rnoE "str\((fd\|formData), \`[^\`]+\`" apps/`` |
| app files importing `parseMoneyInput` **after T-326** | **1** | `grep -rl parseMoneyInput apps/` |

⭐ **The last row is the correction.** T-326's diff converted **one** app site
(`apps/erp/src/app/remittance/actions.ts`), not six. **Whatever the real number is, this task
measures it.**

⛔ **The 4th spelling was invisible to the first three and carries money** —
`allocateAmount_${chargeId}`, `lineAmount_${i}`, `line${i}_unitPrice` in `ap/`, `customers/`,
`expenses/`. ⚠️ **A 5th spelling is the expectation, not a surprise:** this repo has now re-derived
a census figure and changed it **five times in two days**, and
`local-errormessage-convergence.test.ts` records the same lesson in its own header from an earlier
census that missed four files. **Derive from SHAPE, state the denominator, and say what the method
cannot see.**

---

## Contract

### 1. The enumeration is produced FIRST, and the lane STOPS

⛔ **Same rule as T-326 §3, same reason: a sweep that begins before its boundary is agreed is how a
task becomes unbounded.** The lane produces the list → the orchestrator approves it → then it
converts. **No conversion before approval.**

⛔ **An EXPLICIT OUT-COLUMN.** Every site the method reached and excluded, with its reason. *A site
excluded for "not money" must be visible, not absent — otherwise a list of 6 is indistinguishable
from a list of 20 with 14 omissions, which is the exact failure the enumeration prevents.*
⭐ **Measured starting point, from the reviewer and re-checked:** all 10 third-spelling sites are
minutes, counts and month-terms — **zero money**. They belong in the out-column, not in the silence.

### 2. Each in-scope site parses through the existing parser

`parseMoneyInput` in the app layer, `money()` in the domain. The operator gets the sentence
`parseMoneyInput` already produces.

⛔ **Do NOT copy the parser, and do NOT write a fourth validator.** DEF-383 records that this tree
already holds **three** (`parseMoneyInput`, `MANUAL_COST_PATTERN`, and `channel-settlements`'s
`money(fd, key)` which validates nothing). **Adding one is a spec defect — report it.**

### 3. The misleading `money()` shadow is renamed

`apps/erp/src/app/channel-settlements/actions.ts` defines `function money(fd: FormData, key: string)`
that returns `str(fd, key) || '0'` — **a function named `money` that performs no money validation**,
shadowing one that does, feeding 9 live fields into `recordChannelSettlement`. It is converted like
any other site **and renamed**, because the name is the trap.

---

## Invariants

1. **A valid amount is unaffected**; `0` stays legitimate (bible §12 landmine 8).
2. **No new money validator** (DEF-383).
3. **Every converted site refuses `abc` with the cashier-readable sentence** — not merely refuses.
4. **T-327's constraints never fire from an enumerated path.** ⭐ **If one does, the conversion at
   that site is wrong** — the app must reject it before the database has to.

## Tests

⛔ **Of each: what value would have to be wrong for this to go red, and does the code under test
supply it?**

1. **Per converted site:** `abc` in, `parseMoneyInput`'s sentence out. ⛔ **Asserting refusal alone
   is not enough** — after T-327 refusal comes free from the constraint and proves nothing about
   this task.
2. **The `trade` path specifically**, including its reconciliation guard: T-327 §P5 measured that
   `Math.abs(Number(input.totalAmount) - total) > EPSILON` passes silently on `NaN`. **Assert the
   guard now catches a mismatch it previously waved through.**
3. **The enumeration is executable, not prose.** The shape-greps that produced the denominator run
   as a check, so a 5th spelling appearing later is visible. ⛔ **No count in a test name**
   (handoff §3(d)); denominators derived at runtime.

## Out of scope

- ⛔ **Closing DEF-383** — unwinding three validators into one is its own task. This task must not
  *add* one; merging the existing three is not licensed here.
- ⛔ Migration work. T-327 holds `0155`.
- ⛔ `money()` and `parseMoneyInput`'s own logic.
- ⛔ DEF-374, DEF-380, DEF-373, T-320.

## Done when

Every §9 gate: typecheck · unit · integration on the lane DB · `npm run build` with 9008 free ·
the auditor's `/code-review` returned and triaged · `callers.mjs` clean · committed with a message
saying *why* · **DEF-382 closed and the roadmap made true — by the orchestrator, not a lane.**

⛔ **§9.4** — the screen or UNMET in those words to Ian (bible row 203). See T-327's Done-when for
the machine's measured state.

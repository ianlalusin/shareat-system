# Handoff — 2026-08-27

## Where things stand

**Wave 2 is finished and Wave 3 has started.** Every source-document module through T-129 is built,
tested and driven in a browser: fixed assets, prepaid, loans, cash requests, owner equity, generic
liabilities, money transfers, pooled remittance, the month-end scheduler, and now customers and
price lists. **Storage is live and verified** against a real private bucket. Nothing is half-built;
the next task starts clean.

⚠️ The one thing that is *designed but not executed*: several items in each task doc's "still not
done" list, all named deliberately. None of them block T-130.

## Gates at `7e4927c`

| Gate | Result |
|---|---|
| `typecheck` | ✅ exit 0 |
| `npm test` (unit) | ✅ **592 / 592** |
| `npm run test:integration` | ✅ **969 / 969** |
| `npm run build` | ✅ exit 0 |

⚠️ **There is no `lint` script in this repo** (DEF-027). Earlier in the session I reported "lint OK"
from a piped exit code that could not fail — it never ran. Four gates, not five.

## What happened this session

### Modules built, in order

| | |
|---|---|
| **T-139** money transfers | Manager-level; the fee is derived from two stated amounts, never typed |
| **T-142** foundation accounts | Every store born with five money accounts, un-retirable while it trades |
| **T-143** pooled remittance | Settles **end-day reports**, not sales reports — Ian's correction |
| **T-140** month-end scheduler | Closed the live half of DEF-044 |
| **T-141** upload brokering | Firebase adapter, and the bucket verified private |
| **T-126** loans | One register, a computed principal/interest split |
| **T-144** cash requests | A float that nets to zero; `1120` gains a party |
| **T-127** owner equity | A drawing limit that actually fires, and a monthly close that locks |
| **T-128** liabilities | The residual control account, with a boundary that refuses |
| **T-129** customers + price lists | The treatment is derived from two links, never declared |

### ⭐ Decisions Ian made, and where each is recorded

| Decision | Recorded in |
|---|---|
| Money moves between stores **office to office only** | Bible row **152** |
| Cross-store movement needs access to **both** stores | Bible row **153** |
| Overdraft **warns** a cashier drawer, **blocks** an office safe | Bible row **154** |
| One Auth tenant; storage split by **sensitivity, not app** | Bible row **155** |
| Every store born with **five** money accounts | Bible row **156** |
| What is remitted is the **END-DAY REPORT**, not the sales report | Bible row **157** |
| v1's loan model is flawed — build a **standard** one | Bible row **158** |
| A cash request is a float that **nets to zero** | Bible row **159** |
| A personal expense routes by **whether it is expected back**; drawings get a monthly close | Bible row **160** |
| A cashier overdraft is **capped, per account, admin-set** | Bible row **161** |
| DEF-070 **accepted and deferred** until after cutover | `DEFECTS-REGISTER.md` DEF-070 |
| Cash repayment + pay recovery first, write-off after | `docs/tasks/127-owner-equity.md` §9, §10 |
| Storage stays on Firebase — **costed**, not assumed | `docs/tasks/141-file-upload-brokering.md` §8 |

⭐ **Nothing Ian decided is left in the transcript only.** The Supabase question he re-raised needed
no new row — the bible already records it as rejected (§4.1) — but the *costing* behind reaffirming
it is now in T-141 §8 so it is not run a third time.

### Defects registered

**DEF-071** ⛔ a monthly owner drawing limit is displayed on screen and enforced by nothing ·
**DEF-072** owner equity in three registers · **DEF-073** ⚠️ *ours* — `db:generate` is unusable
(39 migrations, 12 snapshots, chain dead since 0019) · **DEF-074** liabilities in three registers ·
**DEF-075** a stored `outstandingBalance`, the fifth and sixth time.

⭐ **DEF-072, 074 and 075 are the same defect found in four more modules.** At this point the
finding is not the column, it is the **habit**: six modules, written at different times, each
independently deciding the ledger needed a companion number.

### Bugs the BROWSER found that tests did not

1. ⛔ **The drawing limit counted unrelated staff advances.** An owner's cap reported *"₱600 already"*
   against an empty account — that ₱600 was a cash-request float shortage, same human, different
   role. Scoped to the owner's own recoveries; pinned by a test.
2. ⛔ **A credential path resolved from the wrong directory.** `./secrets/…` worked in
   `storage-smoke` and killed `next dev` at boot, because Next runs with `cwd = apps/erp`.
3. ⛔ **A price re-quote blanked the item's label and unit.** Re-pricing the normal way — a code and
   a number — erased "Pork belly" and "kg".
4. ⚠️ **Five copies of `peso()` rendered a negative as `₱-27,850.00`** — symbol first, sign second, on
   exactly the figure the overdraft guard exists to raise.

## Pick up here

**1. T-130 — Accounts payable.** Supplier invoices, payments, and open-item allocation against the
`2110` subledger. ⭐ It is the first module to **use** a party subledger for real rather than
deriving a balance from an empty one, so it will exercise machinery five tasks have been building.
⚠️ `expenses.supplier_id` is opaque text today and T-130 is when a real `suppliers` table lands —
`price_list_items.item_code` is waiting on the same kind of decision for items.

**2. T-131 — AR**, which finally posts to the `1210` T-129 already derives from.

**3. T-132 — wholesale orders**, the document that consumes a price list.

## Do not decide these alone — they are Ian's

| Question | The recommendation already on the table |
|---|---|
| **Entity structure** — sole proprietorship, partnership or corporation? | It changes how an unpaid owner receivable is treated on examination. ⚠️ **Worth one conversation with the accountant before go-live** |
| An obligation the **whole org** owes (group insurance, a franchise fee) | Today it must be recorded per store or not at all. Needs a decision before someone hits it |
| `ownership_percentage` is recorded and **drives nothing** | Carried because v1 carries it. If it should drive profit distribution, that is a different task |

### ⛔ Still Ian's to do, outside the repo

- **Install the month-end cron** on the droplet:
  `0 2 1 * * cd /srv/shareat && /usr/bin/npm run month-end >> /var/log/shareat-month-end.log 2>&1`
- **True both Grab loan balances** to Grab's statements for 07-23 → cutover. Both live figures are
  unusable — one stale by fourteen days, the other *"a wiring artifact, not a fact."*

## Traps that have actually bitten, live in this area right now

- ⛔ **`npm run db:generate` is unusable** (DEF-073). Hand-write migrations, and journal them with
  `previous.when + 86400000` — `Date.now()` sorts *before* the synthetic series and the migration is
  **silently skipped** (DEF-069).
- ⛔ **Never put a backtick inside a `` sql`` `` template**, even in a SQL comment. It terminates the
  template. Bit twice today.
- ⚠️ **Two concurrent integration runs corrupt each other** — they share one test database. A run
  started while another finished produced 4 spurious journal-trigger failures.
- ⚠️ **`| tail` hides an exit code.** `npm run typecheck --silent | tail -5` exits 0 whatever tsc did.
- ⚠️ **A new route directory needs a dev-server restart** before Tailwind emits its classes.
- ⚠️ **Stop the dev server before `npm run build`** — the build clobbers the `.next` it is serving.

## The paste-ready prompt

```
Continue Shareat System at C:\Users\ianla\webapps\shareat-system.

Read docs/HANDOFF-TODAY.md first, then docs/RULES.md, then the PROJECT_BIBLE.md
sections it cites for your area. Bible rows 152-161 are this week's decisions.

Next task: T-130 accounts payable — supplier invoices, payments, and open-item
allocation against the 2110 subledger. Write docs/tasks/130-*.md as a spec BEFORE
any code (bible §1.2a), grounded in reading ERP-rebuild as requirements, never as
design. ERP-rebuild is the OLD live ERP and is read-only — the name lies.

Gates at 7e4927c: typecheck · 592 unit · 969 integration · build, all green.
There is NO lint script in this repo (DEF-027) — do not report one.

Before writing a migration, read DEF-073: db:generate is unusable here. Hand-write
it and journal with previous.when + 86400000.

Verify UI in a browser before claiming a screen works — that is where four real
bugs were caught this session that the tests missed.
```

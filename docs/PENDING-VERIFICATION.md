# Pending verification — what the `inventory` branch has NOT proved

> **For whoever gets port 9008.** Everything on branch `inventory` (13 commits, T-160 → T-164) is
> green on `typecheck`, `npm test` and `npm run test:integration`. **Two gates have never run**, and
> both are blocked by the same thing: another session has held the dev server on port 9008 all day.
>
> Written 2026-08-29 by the session that wrote the work, so the next person is not guessing what
> was and was not checked.

---

## ⚠️ First, a correction to what I said earlier in the day

I described *"the screens for five finished tasks"* as blocked. **That was wrong, and the
difference matters to whoever picks this up.**

```
git diff main...inventory --name-only | grep "^apps/"   →  (nothing)
```

⛔ **No route was built.** Not one file under `apps/` was touched. So the screens are **unbuilt
work, not unverified work** — there is nothing sitting in a browser waiting to be looked at.

⭐ **What that leaves is exactly two real items**, §1 and §2. They are small, and neither takes
long.

---

## 1. ⛔ `npm run build` — never run, on any of it

**Not a browser task.** It needs the dev server **stopped**, because the build clobbers the `.next`
directory the dev server is serving (bible §2.9, and it produces unstyled pages and phantom errors
that look like real bugs).

```bash
# whoever owns the dev server on 9008: stop it first
npm run typecheck && npm test && npm run build
```

**Expected:** clean. Nothing in these 13 commits imports into `apps/`, so a failure here would be
a surprise — which is precisely why it has to be run rather than assumed.

⚠️ **This gate is outstanding for every one of the 13 commits.** The definition of done (§9) lists
it, and it has not passed once today.

---

## 2. ⚠️ THE REAL BROWSER CHECK — a new column on a live table

**This is the only genuine regression risk in the branch**, and it is worth two minutes.

`stores` gained `stock_model` (T-160, migration `0062`). Drizzle generates **explicit column
lists**, so every existing query against `stores` now names that column.

| | |
|---|---|
| **Why it should be fine** | The migration is applied to **both** `shareat_dev` and `shareat_test`, and the full integration suite (1298 tests) passes against it |
| **Why it still needs a look** | ⛔ **The running app has never once selected that column.** Integration tests exercise repos, not pages |
| **What breaks if wrong** | `column stores.stock_model does not exist` — a 500 on every page that reads a store |

### What to open, on `inventory`, once 9008 is free

```bash
git checkout inventory
npm run dev          # port 9008, and only if nobody else holds it
```

Then load any page that lists or reads stores. The cheapest good coverage:

- **`/remittance`** — reads stores directly (T-152/T-153 territory)
- **`/cutover`** — T-134's wizard, which is per-store
- **Any page with a store picker**

⭐ **Good looks like:** the page renders and lists stores as before. **Bad looks like:** a 500, or
an empty store list where there should be several.

> If it does fail, the fix is not in this branch — it means `0062` did not apply to the database
> that app instance points at. Check `DATABASE_URL` and re-run `npm run db:migrate`.

---

## 3. What is deliberately NOT on this list

⛔ **Do not go looking for inventory screens.** None exist yet. Each task's own spec records why it
stopped where it did:

| Task | Built | Not built |
|---|---|---|
| **T-160** locations | Schema, migration `0062`, pure rules, 19 unit + 20 integration tests | Repo, service, `/inventory/locations` route |
| **T-161** stock ledger | Schema, migration `0063`, repo, 28 integration tests | `packages/domain/src/stock/ledger.ts` — the thin wrapper, deferred to its first real caller |
| **T-162** FIFO layers | Schema, migration `0064`, repo, planner, 21 unit + 14 integration tests | `consume.ts` — the transactional wrapper, deferred to T-163's caller |
| **T-163** receipt posts value | `2120` activated, `5450` seeded (`0065`), both posting functions, 12 unit + 14 integration tests | Layer creation on receipt, the `unit_cost` true-up, `cost-confirmation.ts` |
| **T-164** consumption/wastage/variance | Both modules, 16 integration tests | The documents that call them — T-166/168/169/176/177 |

⚠️ **These are all real, deliberate stopping points**, not oversights — each is argued in its
task's `Built` section. The pattern is the same one every time: **a thin wrapper invented ahead of
its only caller ends up fitting nothing.**

---

## 4. Migration state, so nobody re-applies by hand

| | |
|---|---|
| **Journal** | 66 entries, through `0065_t163_grni_and_price_variance` |
| **Applied to** | `shareat_dev` **and** `shareat_test`, by this session |
| **Idempotency** | Verified — `npm run db:migrate` run a third time applied nothing |

⚠️ A peer session runs its integration tests against a **separate** database, `shareat_test_b`.
That is why `shareat_test` stayed uncontended today, and it is worth keeping.

---

## 5. One measurement worth not re-diagnosing

An integration run reported **1 failure at 1602s**, against a normal ~300s. ⭐ **Ian confirmed the
machine changed location mid-run** — a suspend stretches the wall clock and trips a 30-second test
timeout. **A clean re-run passes 1298/1298.**

⚠️ Recorded because a green retry after a red run is only trustworthy when the reason for the red
one is named. If you see a lone timeout-shaped failure at an implausible duration, check whether
the machine slept before hunting for a defect.

## T-171 / T-172 / T-173 — the commissary pipeline (2026-08-29)

The ledger side is built and green; **nothing with a URL exists yet**, and neither does the
`confirm_receipt` capability row that goes with it (T-173 §12).

| Needs a browser | Why it cannot be checked here |
|---|---|
| `apps/erp/src/app/commissary/orders/**` — the branch order form, the commissary's fulfil screen, the branch's receive screen | Not written. Port 9008 is held by another lane |
| The catalogue read path and price resolution (T-171 §5) | Not written — it is the order form's data source |
| ⚠️ **`trade_orders_submit_hardening_trg`'s three refusals, seen by a human** | The trigger is tested at the SQL level, but its messages are what a branch manager actually reads at 6am with a truck waiting. They should be read once by a person before they are the only explanation someone gets |

⭐ **One thing to check that is NOT a screen:** run `npm run db:migrate` in each of the three
worktrees and confirm the last journal tag matches what the database applied. **DEF-094** — the
three lanes share one `shareat_dev`, and a lane whose migration `when` is below the shared maximum
is skipped with no error and exit 0.

## T-174 — discrepancy disposal and the day-open block (2026-08-30)

| Needs a browser | Why it cannot be checked here |
|---|---|
| `apps/erp/src/app/commissary/discrepancies/**` — the list and the resolve dialog | Not written. Port 9008 is held by another lane |
| ⭐ **`TransitShortfallBlockedError`'s message, read by a real manager** | A commissary manager meets this at 6am when the day will not open. The message names the quantity, the value and how many others there are — but whether that is enough to act on is a question only a person looking at the screen can answer |
| The `resolve_trade_discrepancy` / `charge_staff_for_discrepancy` capability rows | Deliberately unbuilt — no caller yet, so their ✗ cannot be tested (T-174 §10.4) |

⚠️ **One thing worth watching for in the data, not the browser:** `1230 Advances to employees`
only ever grows (DEF-099). If anyone charges a shortfall to a staffer, that receivable has no
drawdown path until Phase 5.

## T-175 — low stock, the auto-draft, and the order thread (2026-08-30)

| Needs a browser | Why it cannot be checked here |
|---|---|
| `apps/erp/src/app/inventory/low-stock/**` — the list and the threshold editor | Not written. Port 9008 is held by another lane |
| The order thread on the order page | Not written |
| ⭐ **An auto-drafted line, seen by the branch manager it is for** | This is §3's question in the only form that settles it. The line arrives with a SUGGESTED quantity rather than v1's zero — whether that reads as helpful or as presumptuous is a judgement nobody can make from a test |

---

## ⚠️ `docs/ROADMAP.html` is stale for the WHOLE Phase 3 wave, not just one lane

Its task ids stop at **T-152** and it has no Phase 3 section at all, so T-160 through T-175 —
every task in the inventory wave, across every lane — are invisible there. Each of those specs'
*Done when* lists "update `docs/ROADMAP.html`" and none of them has.

⛔ **Deliberately not fixed from inside one lane.** Three worktrees are writing tasks into that
wave right now, and a single-file HTML roadmap rewritten by one of them is a conflict the other two
discover at merge. It wants one pass, by whoever merges the lanes — or a generated file, which is
the better answer given it is derived from `docs/tasks/` anyway.

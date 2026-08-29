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

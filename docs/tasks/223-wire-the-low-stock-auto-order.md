# T-223 — Wire the low-stock auto-order

> **Status:** spec written 2026-09-06 (ianla-25, Opus planner). **Closes:** DEF-186.
> **Decision:** Ian, 2026-09-06 — *"wire `replenishAfterUsage`"*. The seam was left to this task.
> ⛔ **No migration.** No schema change.

## Why this exists

`replenishAfterUsage` has **zero production callers** — `grep` finds it in three places, all inside
`packages/domain/tests/integration/low-stock.test.ts`. T-175 built the entire replenishment path
(threshold resolution, suggested quantities, order-thread append, an idempotent auto-append index)
and nothing invokes it. **The low-stock auto-order has never run.**

## Where the seam actually is — and DEF-186's guess was wrong

DEF-186 framed the choice as *"an ERP action or a scheduler job."* Reading the code, **neither
describes the real constraint**, and the honest answer is narrower.

`replenishAfterUsage`'s own header rules out the obvious caller and is right to:

> *"deliberately NOT called from `postUsageRecord`. That function takes a `tx` it does not own, so it
> is structurally incapable of running anything after the commit."*

⭐ **The transaction is owned one layer higher than DEF-186 assumed.** `postUsageRecord` is called by
`postUsage` (also handed a `tx`), which is called by **`postUsageAction`**
(`apps/erp/src/app/inventory/usage/actions.ts:126`) — and *that* is where the transaction begins and
ends:

```ts
result = await withOrgPrincipal(actor.orgId, (tx) => postUsage(tx, actor, { recordId }));
// ← everything after this line is post-commit
```

So the seam is **the ERP action, immediately after `withOrgPrincipal` returns**. Not a scheduler job:
⛔ a nightly sweep would replenish against yesterday's usage and lose the *"a cook recorded usage, so
propose the order now"* property the function was built for, while adding a cron whose absence is
invisible — the exact failure `openShiftsStale` exists to catch.

⚠️ **Do not move the call into the domain to make it "tidier."** The layer that can run something
after a commit is the layer that opened the transaction, and that is the action. Pushing it down
recreates the coupling T-175's invariant 8 forbids.

## Contract

### 1. `PostOutcome` carries what the caller needs

`postUsage` already holds the record and its lines. It returns neither the store nor the items, so
the action would have to re-read them — a second query, and a race against a concurrent void.

```ts
{ ok: true; totalCost: Money; entryIds: readonly string[];
  storeId: string; itemIds: readonly string[] }
```

⭐ Data already in hand, returned rather than re-fetched.

### 2. `customerId` becomes optional on `AutoOrderInput`

`replenishAfterUsage` requires the branch's counterparty `customerId`; the action does not have one
and should not open a transaction to find it. Make it **optional**, resolved inside the existing
transaction via `commissaryRepo.internalCustomerFor(tx, orgId, branchStoreId)` when omitted.

⛔ **A missing internal customer is not an error** — it means the store is not a buyer. It returns the
same `ok: false` shape as the existing *"this store has no active commissary link"* path, which the
wrapper already turns into a note rather than a throw.

### 3. The call site

```ts
const replenish = result!.ok
  ? await replenishAfterUsage({
      orgId: actor.orgId, branchStoreId: result!.storeId,
      orderedOn: toBusinessDate(), createdBy: actor.personId,
      itemIds: result!.itemIds,
    })
  : null;
```

⚠️ **`itemIds` is passed, not omitted** — scoping to what this post touched, rather than sweeping the
whole store on every usage record.

### 4. ⛔ The failure must not be silent — that is the whole defect

`replenishAfterUsage` never throws; it returns `failed: string | null`. **DEF-186 is a function whose
failures had nowhere to go**, so the wiring must not reproduce that one layer up.

- The usage post **stands regardless** — it is already committed, and a cook must be able to record
  what they used when the ordering subsystem is down (T-175 invariant 8).
- On `failed`, **append a clause to the success message** naming what did not happen. ⛔ Not a
  separate error toast: the post succeeded, and an error banner over a successful post trains people
  to ignore banners.
- On success with lines appended, say so — a manager who sees *"3 lines added to the open order"*
  learns the feature exists. **Nothing in this system currently tells anyone it does.**

⚠️ **The durable answer is a detector, and it is deliberately NOT in this task**: *an item below its
threshold with no draft order line* is derivable, persisted, and survives a lost log line. That is a
T-135-shaped follow-up, noted in Out of scope, and it is what makes a *repeated* failure visible
rather than a single one.

## Invariants

1. A failing replenishment **never** fails, reverses, or hides a committed usage post.
2. `replenishAfterUsage` is called **after** the transaction commits — never inside one.
3. A store with no commissary link produces a note, not an error.
4. No new transaction is opened by the action; `replenishAfterUsage` owns its own.

## Tests

- ⭐ **A usage post whose replenishment throws still posts.** Force the failure and assert the record
  is `posted`, stock moved, journal written — the invariant T-175 built the wrapper for and which
  nothing has ever exercised through a real caller.
- A store **with** a commissary link and a below-threshold item gets a draft order line after a
  usage post. ⚠️ **This is the first end-to-end proof the feature works at all.**
- A store with **no** link posts usage and produces a note, not an error.
- `itemIds` is scoped to the posted lines, not the whole store.
- `PostOutcome.storeId`/`itemIds` match the record and its lines.

⚠️ Integration on an isolated lane DB, announced first; `ListAgents` before anything heavy.

## Out of scope — with reasons

- ⛔ **A scheduler job.** §"Where the seam actually is".
- ⛔ **A `lowStockOrderNotProposed` detector** — the durable answer, but a separate task: it needs a
  threshold-vs-draft-line query and its own both-direction tests, and folding it in here would mean
  shipping a detector in the same commit as the path it watches, with no independent evidence either
  works. ⚠️ **Recorded so it is a placement, not an omission.**
- **`production/index.ts`'s usage-shaped path** — it mirrors `postUsageRecord`'s ordering discipline
  but is a different document with its own seam. If prepping should also trigger replenishment, that
  is a second decision and Ian's.

## Done when

- [ ] `replenishAfterUsage` has a production caller and the auto-order runs.
- [ ] A failing replenishment provably cannot damage a committed usage post.
- [ ] Success and failure are both **visible to the person who posted**.
- [ ] typecheck · unit · integration (lane DB, stated) · build (dev server stopped) · smoketest
      `/inventory/usage` on 9008.
- [ ] DEF-186 closed. Roadmap + this status line updated.

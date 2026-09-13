# T-230 — Sales channels: the admin surface (DEF-207) + per-channel wastage policy

> **Status**: 🟡 **APPROVED WITH REDLINES 2026-09-07 (orchestrator ianla-60) — BUILDING.**
> R1–R6 are applied throughout and marked where they land. Migration slot **0133** is this lane's.
> ⭐ **R1 is the one that changed the design**: `order_wastages` gets a real `channel_id` FK instead
> of the hand-maintained rename cascade the first draft specced. See finding (a) and contract 3.
>
> **Absorbs T-229 slice 5.** T-229's slice table has been updated to say so; that spec keeps
> slices 2, 3 and 4.
>
> Discovery: `docs/discovery/28-reference-data-administration.md` **§3.2** (the wastage mode) and
> **§8.6** (`sales_channels` has no production writer). Decisions: **bible §13 row 180** (Ian,
> 2026-09-07 — tracked-vs-instant is a per-channel policy) and the same day's DEF-207 call (an
> admin surface, *not* channels seeded at store creation). Defects closed: **DEF-207**.
> DEF-205's rule is applied to a second table here.
>
> ---
>
> ### ⚠️ Three findings from reading the code, reported rather than designed around (RULES §3.4a)
>
> **(a) ⛔ A rename does NOT "orphan nothing" — it strands every OPEN tracked wastage on the old
> name.** The lane brief states a rename *"changes what future wastages resolve to and orphans
> nothing"*. Half of that is right. `order_wastages.channel` is text, dereferenced by
> `findChannelByName` **at posting time** (`repo/order-wastage.ts:246-257`), and an `open` tracked
> wastage has not posted yet. Rename `Foodpanda` → `Foodpanda PH` while one is open, and resolving
> it as `absorbed` or `charged` throws *"no 'Foodpanda' channel is configured for this store"*
> (`wastage/orders.ts:138-144`) — the row cannot be closed by a human at all, and at day 15 the
> backstop hits the same wall. `platform_paid` survives, because it posts nothing.
>
> ⭐ **REDLINED 2026-09-07 (orchestrator R1), and the redline is right.** The first draft of this
> spec kept the text column and hand-maintained it on rename. That is a denormalised string with a
> bespoke sync path where a foreign key is the boring, standard answer (RULES §4; bible §4.2 rule
> 8) — and every future name-keyed reader would have to remember the sync. **`order_wastages` gets
> a real `channel_id` FK** (contract 3). The reason T-178 gave for text-by-name — *"resolved at
> POSTING time only, because that is the one moment a party is actually needed"* — **stops being
> true inside this very task**, which moves resolution to creation so the mode can be derived.
> Production holds zero `order_wastages` (zero orgs), dev holds one resolved row, lane DBs are
> empty: this is the cheapest day the change will ever have.
>
> **(b) ⚠️ Deactivation is inert today and becomes live the moment this ships — in three readers
> that do not check it.** `salesChannels.isActive` has **no writer anywhere**, so nothing has ever
> been false. `salesDaysRepo.listChannels` (`repo/sales-days.ts:105`) returns active and inactive
> alike and feeds **the `/sales-days/new` picker**, `/wastage`'s datalist, and `writeChannels`'
> validation (`domain/sales-days/create.ts:229`). Give a manager a Deactivate button and a retired
> channel keeps being offered for new days. **Two files outside the brief's list are needed to make
> deactivate mean anything** — see Scope, "⚠️ Requested additions".
>
> **(d) ⛔ `npm run db:generate` CANNOT BE USED HERE, and the lane brief, this spec's first draft
> and T-229's slice-2 note all told me to use it.** Attempted 2026-09-07 as instructed. It opened
> an interactive prompt asking whether `expenses.supplier_invoice_id` — created in migration
> **0043**, ninety migrations ago — is a new column or a rename of `receipt_photo_url`, a column
> `schema/expenses.ts` has not had since T-130. **Cause: the snapshot chain in
> `migrations/meta/` stops at `0019_snapshot.json`**, so drizzle-kit diffs today's schema against a
> 113-migration-old baseline; run to completion it would propose re-creating schema that has been
> live for months. ⚠️ **This is long known and already registered — DEF-073 and DEF-121** — and
> **hand-writing the migration from the schema file is this project's working convention** since
> 0020. `0131_t215_expense_budgets.sql` and `0132_t216_recurring_expenses.sql` both say so in their
> own headers. ⭐ Nothing was written: the prompt took no input and the tool exited. Migration 0133
> is hand-written, and R3's *intent* survives intact — the CHECK belongs in the schema builder
> because the schema file is where a table is DEFINED (bible §8), not because `db:generate` will
> emit it.
>
> **(c) 🔸 `/wastage`'s channel field is free text with a `<datalist>` hint, not a picker**
> (`page.tsx:110-116`). A typo creates a **tracked** wastage against a channel that does not exist;
> nothing checks at creation, and it surfaces days later as an unresolvable row. This task fixes it
> as a by-product (the mode must be derived, which forces resolution at creation), but it existed
> before this task and is worth its own register row — orchestrator, it is in the report.
>
> ---
>
> ### ⛔ What this task does NOT re-decide
>
> `sales_channels` is **not** seeded reference data. Bible §4.4's rule 2 (`is_system`, seeded rows
> deactivated-never-deleted) does not apply: there is no channel seed, no `code` column, and which
> channels a branch sells through is a business fact — `storesRepo.countSalesChannels`' own comment
> calls a default there *"a guess wearing the costume of a decision"*. Rule 3 (normalised
> uniqueness) **does** apply and is the one this task must land, in the same migration as the first
> human create path, never after.

---

## Goal

**A manager can configure the channels their store sells through, and the channel — not the person
recording a loss — decides whether an order wastage enters the charge lifecycle.**

Two observable outcomes:

1. **DEF-207.** A store created through `/admin/stores` shows *"At least one sales channel"*
   unsatisfied and **blocking**, with no remedy anywhere in the product. After this ships, the
   readiness row links to a screen, a manager fills one form, and the store becomes ready without
   an engineer, a script or a `psql` session.
2. **Bible row 180.** A staffer recording a Foodpanda wastage can no longer choose `instant` and
   skip the Wastage Monitor, the 48-hour dispute window and the 15-day auto-charge backstop. The
   channel carries the mode; the form stops asking.

---

## Scope — the exact files this task may create or modify

### Create

| File | What |
|---|---|
| `packages/db/migrations/0133_t230_sales_channel_admin.sql` | ⚠️ **HAND-WRITTEN from the schema files, per DEF-073 / DEF-121** — see the correction in the status block. `0131` and `0132` say the same in their own headers |
| `packages/domain/src/sales-channels/index.ts` | `createSalesChannel`, `updateSalesChannel`, `setSalesChannelActive`, `listSalesChannelsForAdmin` |
| `apps/erp/src/app/settings/sales-channels/page.tsx` | the screen |
| `apps/erp/src/app/settings/sales-channels/actions.ts` | three server actions |
| `apps/erp/src/app/settings/sales-channels/lib.ts` | server-only reads |
| `packages/domain/tests/integration/sales-channels-admin.test.ts` | the 14 tests below |

### Modify

| File | Change |
|---|---|
| `packages/db/schema/sales-days.ts` | add `wastageTypeMode` **as a typed enum column with its `check(...)` in the builder** — Drizzle expresses both, and `positions` already does it, so `db:generate` emits them (R3); **remove** the `uniqueIndex(...)` builder line and replace it with a `NOTE:` comment (contract 6) |
| `packages/db/schema/order-wastage.ts` | ⭐ **R1** — add `channelId` (uuid, not null, FK `sales_channels.id`, `onDelete: 'restrict'`); rewrite the `channel` column's comment, which currently explains a by-name design that stops being true here |
| `packages/domain/src/wastage/settlement-match.ts` | `SettleableOrderWastage` gains `channelId`; the matcher keys on it instead of `channel.toLowerCase()` (`:60-65`), so a renamed channel's open wastages still match their settlement |
| `packages/domain/src/channel-settlements/index.ts` | `PostedSettlementSummary` + `toSummary` gain `channelId` — **four lines**; `R.getById` does `select()` over the whole table, so `ChannelSettlementRow` already carries it. ⚠️ Also delete the now-false comment at `:605-606` (*"order_wastages.channel is free text matched by name"*) |
| `packages/db/src/repo/sales-days.ts` | `insertChannel`, `updateChannel`, `setChannelActive`, `channelById`, `channelByNormalisedName`; `listChannels` gains an **optional** `activeOnly`; `SalesChannelRow` gains `wastageTypeMode` + `destinationMoneyAccountId` + `taxTreatment` |
| `packages/db/src/repo/order-wastage.ts` | `findChannelByName` returns `{ id, name, isActive, wastageTypeMode }` and is used **at creation only**; add `channelById` for the posting path; `create` takes `channelId`; the row shape exposes it. ⛔ **No `renameChannelOnUnresolved`** — R1 deleted it |
| `packages/domain/src/wastage/orders.ts` | ⛔ **`RecordOrderWastageInput.typeMode` is deleted**; the mode is derived from the resolved channel (:236-274's branches keep their shape) |
| `packages/domain/src/stores/service.ts` | the `salesChannel` readiness `detail` names the remedy — **text only**, no logic change |
| `packages/domain/src/index.ts` | one line, `export * from './sales-channels';` |
| `packages/db/src/index.ts` | export the new repo functions through the existing `salesDaysRepo` / `orderWastageRepo` namespaces |
| `apps/erp/src/app/settings/page.tsx` | one `SettingsCard`. ⚠️ Its *"Not here yet"* list needs **no** edit — its three items are the category create path, the staff-advance ceiling and org identity, none of which this task touches |
| `apps/erp/src/lib/constraint-messages.ts` | ✅ **cleared by R4.** Three keys: `sales_channels_non_remitted_needs_receivable_check`, `sales_channels_wastage_type_mode_check`, `sales_channels_org_id_store_id_name_unique`. T-201 hoisted this map so screens cannot fork one constraint's wording; `errorMessage` (`:57-63`) substring-matches the raw error, so an index name is a valid key |
| `apps/erp/src/app/wastage/page.tsx` | the channel `<input list>` becomes a `<select>` of ACTIVE channels annotated with their mode; ⛔ **the two `typeMode` radios at :133-136 are deleted**; the Monitor sentence at :146 stops pointing at a screen that does not exist |
| `apps/erp/src/app/wastage/actions.ts` | stop reading `typeMode` from the form |
| `apps/erp/src/app/admin/stores/[id]/page.tsx` | the `salesChannel` readiness row gets a link, exactly as `signIn` already links to `/staff` (`:118-124`) |

### ✅ Additions outside the brief's original list — **all approved 2026-09-07 (orchestrator R4)**

| File | Why |
|---|---|
| `packages/domain/tests/integration/order-wastage.test.ts` | **17 call sites pass `typeMode`.** Deleting the field from the input type breaks the suite at typecheck. The fixture also needs a second, `instant` channel so the instant path stays exercised |
| `apps/erp/src/app/sales-days/lib.ts`<br>`apps/erp/src/app/sales-days/new/page.tsx` | **One argument each.** `listChannels(orgId, storeId, { activeOnly: true })` so a deactivated channel stops being offered for a NEW day. ⚠️ `writeChannels` deliberately does **not** filter — editing an old day that references a since-retired channel must keep working |
| `apps/erp/src/lib/constraint-messages.ts` | Three keys (below). Confirmed unheld: lane A is read-only this cycle and git shows T-201 as the last toucher |

### ⛔ Out of bounds

`PROJECT_BIBLE.md` · `docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` ·
`docs/decisions/CAPABILITY-MATRIX.md` · `packages/auth/src/capabilities.ts` ·
`apps/erp/src/components/nav.tsx` · anything T-228 owns · anything under `ERP-rebuild`.
**No new capability row is needed** — `manage_store_settings` exists (`capabilities.ts:206`,
store-scoped, manager ✅). **No nav line is needed** — `/settings` is already in the Setup group
and `nav-route-reachability` resolves transitively through the hub card.

---

## Contract

### 1. `createSalesChannel`

```ts
// packages/domain/src/sales-channels/index.ts
export interface CreateSalesChannelInput {
  readonly storeId: string;
  readonly name: string;
  /** ⭐ NOT optional and NOT defaulted. `is_remitted_daily` is NOT NULL with NO default in the
   *  schema, on purpose: "a channel whose remittance behaviour nobody stated is a channel whose
   *  money nobody can account for" (schema/sales-days.ts:71-77). A `?: boolean` here would
   *  reintroduce the default the schema refused to have. */
  readonly isRemittedDaily: boolean;
  /** Required when `isRemittedDaily` is false, forbidden-in-spirit when true (invariant 3). */
  readonly receivableAccountCode?: string | null;
  /** ⭐ Defaulted to `'tracked'` DELIBERATELY — unlike `isRemittedDaily`, this field HAS a safe
   *  value. Tracked keeps the monitor, the 48h dispute window and the 15-day backstop; instant is
   *  the control Ian just closed. A default that silently disables a control would be the wrong
   *  default; a default that keeps one is the right one. */
  readonly wastageTypeMode?: 'tracked' | 'instant';
}

export async function createSalesChannel(
  tx: Tx, actor: Actor, input: CreateSalesChannelInput,
): Promise<{ channelId: string }>;
```

In this order:

1. `await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId })`.
2. The store belongs to `actor.orgId`, or throw. One org cannot address another's store.
3. `name = input.name.trim()`; empty is refused with a sentence.
4. `isRemittedDaily === false` and no `receivableAccountCode` → refused **here**, naming the
   reason, *before* SQL. ⚠️ The database's `sales_channels_non_remitted_needs_receivable_check`
   remains the authority (**RULES §6 item 3 (bible §15.11)** — *"the database enforces the rules, not the service
   layer… a second copy is a second source of truth, and the two will drift"*); this only turns a
   constraint name into a sentence.
5. A non-null `receivableAccountCode` is resolved in `accounts` for this org and refused unless
   **`is_postable` ∧ `status = 'active'` ∧ `requires_party`** — invariant 4.
6. Insert with `is_active = true`, `tax_treatment` left at the schema default, and
   `destination_money_account_id` **null** (contract 5).
7. A collision on the normalised unique index surfaces through
   `apps/erp/src/lib/constraint-messages.ts` as a sentence naming the existing channel, **not** a
   Postgres error string.

### 2. `updateSalesChannel`

```ts
export interface UpdateSalesChannelInput {
  readonly channelId: string;
  readonly name: string;
  readonly isRemittedDaily: boolean;
  readonly receivableAccountCode?: string | null;
  readonly wastageTypeMode: 'tracked' | 'instant';
}
export async function updateSalesChannel(tx: Tx, actor: Actor, input: UpdateSalesChannelInput): Promise<void>;
```

Same gate (on the channel's **own** `store_id`, read first — never on a store id the caller
supplies), same validations. ⛔ **It does not write `destination_money_account_id`, `is_active` or
`tax_treatment`** — contract 5, contract 4 and invariant 8 respectively.

### 3. ⭐ `order_wastages.channel_id` — finding (a)'s remedy (orchestrator R1)

```ts
// packages/db/schema/order-wastage.ts
channelId: uuid('channel_id').notNull().references(() => salesChannels.id, { onDelete: 'restrict' }),
/** The channel's name AS RECORDED. Display and memo only — never re-read to find the channel,
 *  never updated after creation. `channel_id` is the pointer. */
channel: text('channel').notNull(),
```

⭐ **A rename becomes a display change and nothing else.** No sync path, no cascade, no reader that
has to remember one. `postDisposition` resolves through `channelById`; `findChannelByName` survives
for exactly one job — turning what the recorder picked into an id, at creation.

⭐ **`channel` text stays, and is not redundant.** It is the name the wastage was recorded under,
which is what the memo says and what a person reading history expects to see. Renaming a channel
must not retroactively change what a posted memo claims. So: **`channel_id` answers *which
channel*; `channel` answers *what it was called at the time*.** Two different questions.

⚠️ **`settlement-match.ts` keys on the id.** `:60-65` currently builds
`${storeId}|${channel.toLowerCase()}|${businessDate}`; a rename would silently stop matching open
wastages to their settlement — the same defect one layer up. `PostedSettlementSummary` gains
`channelId` (`R.getById` already returns it, `select()` over the whole table), the matcher keys on
it, and the rationale string keeps using the name for display.

**Backfill, in migration 0133 —** the column arrives nullable, is filled, and only then becomes
`not null` with its FK:

```sql
alter table "order_wastages" add column "channel_id" uuid;
update "order_wastages" w set "channel_id" = c.id
  from "sales_channels" c
 where c.org_id = w.org_id and c.store_id = w.store_id
   and lower(trim(c.name)) = lower(trim(w.channel));
-- ⚠️ If SET NOT NULL fails, a dev database holds a wastage whose channel name matches no channel
--    row — exactly finding (c)'s free-text typo, made visible. That is a dev DATA fix (delete the
--    orphan or create its channel), never a reason to make this column nullable. Production holds
--    zero order_wastages: there are no organizations yet.
alter table "order_wastages" alter column "channel_id" set not null;
alter table "order_wastages" add constraint "order_wastages_channel_id_sales_channels_id_fk"
  foreign key ("channel_id") references "sales_channels"("id") on delete restrict;
```

> ⛔ **THE COMMENT IN THAT BLOCK IS WRONG, AND IT CANNOT BE FIXED — T-300, 2026-09-13 (DEF-331).**
>
> *"Production holds zero `order_wastages`: there are no organizations yet."* Production holds
> **one** organisation, `SHAREAT OPC` (`select count(*) from organizations` → `1`, measured
> 2026-09-13 as the admin role). The premise was true when written and had already stopped being
> true by 2026-09-12 at the latest.
>
> ⚠️ **The SQL block above is deliberately left byte-for-byte as it was applied**, comment and all.
> It is a *quotation of an immutable artifact* — `packages/db/migrations/0133_t230_sales_channel_admin.sql:30,59`
> carries these same two sentences, and bible §2 rule 9 forbids editing an applied migration.
> Correcting the quotation here while the migration still says it would make this document disagree
> with the thing it is quoting, which is worse than an error a reader can see.
>
> ⭐ **The migration's OUTCOME was correct; its ARGUMENT was not.** `set not null` succeeded, so
> `order_wastages` genuinely held no unmatched rows at apply time. But the reason given —
> *"there are no organizations yet"* — is not what made it safe, and would not have made it safe:
> had an organisation existed with a free-text channel typo, the statement would have failed and
> the correct response would still have been the dev DATA fix the comment itself prescribes, never
> a nullable column. **The instruction in that comment is right. The justification under it is not,
> and the justification is the part that was load-bearing for anyone reading it later.**
>
> ⛔ **If this migration is ever used as a template, do not copy the last sentence of either
> comment.** The rest of both is sound.

### 4. `setSalesChannelActive`

```ts
export async function setSalesChannelActive(
  tx: Tx, actor: Actor, input: { channelId: string; isActive: boolean },
): Promise<void>;
```

⛔ **There is no delete, and there never will be.** `sales_day_channels`, `order_wastages` and
`channel_settlements` all reference channels with `onDelete: 'restrict'`, so a delete either fails
at the FK or destroys the party behind a posted `1220` line. ⚠️ **v1 shipped a delete** — *"This
will permanently remove the sales channel… This cannot be undone"*
(`ERP-rebuild/.../sales-channel-manager.tsx:88-92`) — beside an `isActive` flag it already had.
That is the **correct** verb of the four (§1.2): the capability is kept, the destructive
implementation is not.

⚠️ Deactivating is **not** gated on having no open wastages. An open wastage on a retired channel
must still resolve and post — invariant 7, test 13's second half.

### 5. ⛔ Two fields this screen shows and does NOT write

| Field | Why not |
|---|---|
| `destination_money_account_id` | **It already has a gated writer with its own screen and its own tests**: `setChannelPayoutDestination` (`domain/channel-settlements/index.ts:510-540`, `manage_store_settings`, called from `/channel-settlements`, tested at `channel-settlements.test.ts:480-535`). A second writer for one column is two validations that will drift (bible §4.2 rule 8). Shown read-only with a cross-link, the way `/settings` cross-links `/staff` for positions. ⚠️ A new channel therefore starts with none — which `recordChannelSettlement` **already refuses loudly** on (*"there is nowhere to bank this"*), and that refusal already has a remedy screen |
| `tax_treatment` | ⛔ **`creditable` has nowhere to post.** No `1270` creditable-withholding asset is seeded, deliberately (`schema/sales-days.ts:96-107` — *"an account that exists invites someone to use it"*), and bible §13 row 75 says the credit is unrealisable because this ledger is never a filing basis. `channel-settlements/index.ts:402-404` states it plainly: *"today every channel is `expense`."* Offering the other value would let a manager select a posture the ledger cannot honour. **Shown, with that sentence, not editable** — which is what "handle it honestly" means for a field with one supported value |

### 6. The migration — 0133, and the two hand-augmentations

⚠️ **The whole migration is hand-written from the schema files — finding (d), DEF-073 / DEF-121.**
`db:generate`'s snapshot chain died at 0019 and the tool would propose re-creating months of live
schema. That does **not** dissolve R3: every rule Drizzle *can* express still belongs in the schema
builder, because the schema file is where a table is DEFINED (bible §8) and a constraint living
only in a migration is one the definition does not know about — the exact drift DEF-073 describes.
So `wastage_type_mode` is a typed enum column with `not null default 'tracked'` **and** its
`check(...)` in `schema/sales-days.ts`, and the migration transcribes them.

Bible row 180's rule, with the default on the SAFE side: tracked keeps the monitor, the 48-hour
dispute window and the 15-day backstop.

**The one rule that cannot go in the builder** is the expression index:

```sql
-- Bible §4.4 rule 3 / DEF-205's rule on a second table. The shipped index is case- and
-- whitespace-SENSITIVE, which is harmless while nothing can create a channel and live the moment
-- this task's create path ships. Hand-added exactly as employment.ts:126-134 documents for
-- positions, and the schema builder's uniqueIndex(...) is REMOVED in favour of a NOTE comment so
-- a future db:generate does not "fix" the drift by dropping it (DEF-073).
drop index "sales_channels_org_id_store_id_name_unique";
create unique index "sales_channels_org_id_store_id_name_unique"
  on "sales_channels" ("org_id", "store_id", lower(trim("name")));
```

…plus contract 3's `channel_id` backfill, whose three statements sit between the generated
`add column` and the generated constraint for the same reason: a `not null` column cannot be added
to a table with rows without filling it first.

⚠️ **The index spans active AND inactive rows on purpose.** `findChannelByName` resolves with
`limit 1` and no ordering; two rows sharing a name — one retired, one live — would make which
receivable a wastage posts against a matter of which row Postgres returned first.

⚠️ **Backfill.** Every existing row becomes `tracked`, by the column default. ⛔ **No name
heuristic** — not `dine` → instant, not anything. Discovery 23 §2 records exactly that pattern as
the standing example of what a silent guess costs (`posSalesChannelId`'s `"dine"` substring match:
*"the day simply reports less money"*). A store that wants instant says so on the screen.
⚠️ In production the backfill is theoretical — DEF-207's whole point is that `sales_channels` has
**no production writer**, so there are no rows. It is real in dev and lane databases.

⚠️ **`when` must track `idx`.** 0132 is `idx: 132, when: 1797478307084`. 0133 must carry
`idx: 133` and a **strictly greater** `when` (the file's own +86400000 cadence gives
`1797564707084`). Drizzle silently skips a migration whose `when` goes backwards.

⚠️ **Re-migrate the lane DB after generating**:
`node ~/.claude/skills/orchestrator/tools/make-test-dbs.mjs shareat_test_t229`.

### 7. ⭐ `recordOrderWastage` — the mode is derived, and the form stops asking

```ts
export interface RecordOrderWastageInput {
  storeId: string;
  salesDayId: string;
  channel: string;
  orderRef?: string | null;
  // ⛔ typeMode: DELETED. Bible §13 row 180 — the channel carries the policy.
  amount: string;
  reason: string;
  openedOn: string;
  allocations?: AllocationInput[];
  /** Required exactly when the RESOLVED CHANNEL's mode is `instant`; refused when it is
   *  `tracked`. The caller states a FACT (what happened to the money); the channel states the
   *  POLICY (whether that fact may be decided now). */
  disposition?: 'platform_paid' | 'absorbed' | 'charged';
}
```

The function gains one step, immediately after `authorize`:

```ts
const channelRow = await orderWastageRepo.findChannelByName(trx, actor.orgId, input.storeId, input.channel);
if (!channelRow) throw new Error(`recordOrderWastage: no '${input.channel}' channel is configured for this store — configure it under Settings › Sales channels.`);
if (!channelRow.isActive) throw new Error(`recordOrderWastage: '${channelRow.name}' is no longer an active channel at this store.`);
const typeMode = channelRow.wastageTypeMode;
```

⭐ **Resolution moves from posting time to CREATION time**, and that is a second defect closed:
today a mistyped channel yields a tracked wastage that nothing rejects until a human tries to
resolve it days later (finding (c)). ⚠️ `findChannelByName` itself must **keep returning
deactivated rows** — a wastage opened before a channel was retired still has to post — so the
`isActive` refusal lives in the domain, at creation, and nowhere else.

Everything downstream of `const typeMode` keeps its current shape: the instant-needs-a-disposition
check, the tracked-forbids-one check, invariant 2's Monitor seed, and the two branches at
:236-274. Only the source of the value changes.

### 8. The screen — `/settings/sales-channels`

⭐ **Its own route, not a panel on `/admin/stores/[id]`, and the capability decides it.** Channels
are `manage_store_settings` (store, **manager ✅**); the store detail page is `manage_stores`
(admin only) and **early-returns for a manager with a refusal card** (`page.tsx:40-56`). A channel
editor embedded there would be invisible to exactly the role that holds the capability.
`/admin/stores/[id]` gets a **link** from its failing readiness row instead — the pattern that page
already uses for `signIn` → `/staff`.

Server component, no client JS, `/settings/expense-categories`' house style:

- A store `<select>` + Show button (`/wastage`'s pattern, `page.tsx:82-93`), defaulting to the
  first store the actor can see.
- One table: **name · remittance · receivable · wastage policy · payout wallet · status**, active
  first, then name. Each row opens an inline edit form; a retired row shows a Reactivate button.
- An **Add a channel** form beneath it.
- **`grid-cols-1` first, no `min-w` on the wrapper, the table in its own `overflow-x-auto`** —
  DEF-199 measured 24 of 66 routes scrolling sideways at 390 px. Phone portrait is the canvas.

⭐ **`is_remitted_daily` renders as two radios with NO `defaultChecked` and `required`** — not a
checkbox and not a preselected select. A checkbox has a default by construction (unchecked), and
this is the one field the schema refused to give a default to. v1 got this wrong in the other
direction: `isRemittedDaily: z.boolean().default(true)` in its form, and every v1 reader written as
`!== false` to cope with the rows that produced. Both labels state the consequence, not the flag:

> ⦿ **Reaches the till** — cash and cards counted in the daily remittance.
> ⦾ **Settles later** — a platform owes us until it pays out. Needs a receivable account.

The receivable `<select>` lists **postable + active + `requires_party`** accounts (`1220 Channel
receivable` is the answer in practice) with a blank first option and no preselection. ⛔ The blank
submits as `null`, never `''` — DEF-087's shape, which `setCategoryAccountAction:30-36` already had
to guard once on this same house form.

The wastage-policy control is two radios, `tracked` preselected, labelled by consequence:

> ⦿ **Tracked** — a loss here is reviewed, can be disputed for 48 hours, and is charged
> automatically after 15 days if nobody decides.
> ⦾ **Instant** — whoever records a loss here decides on the spot. No review, no dispute window.

### 9. Three copy changes that make the remedy findable

| Where | Now | After |
|---|---|---|
| `stores/service.ts:260-268` `salesChannel` detail | *"Without one a sales day has nowhere to land…"* | unchanged sentence **+** *"Add one under Settings › Sales channels."* |
| `admin/stores/[id]/page.tsx` | `signIn` links to `/staff` | `salesChannel` links to `/settings/sales-channels?store={id}` the same way |
| `wastage/page.tsx:143-148` | *"set the Monitor under Settings"* — a screen that does not exist | names T-229 slice 3 as not built yet, and links the channel policy to the new screen |

---

## Invariants

1. **The gate is inside the domain function, never in the action.** Every one of the four functions
   calls `authorize` itself. — bible §2 rule 7; `settings/attendance/actions.ts:6-9` states the
   reason: *"A gate here would protect only this one caller, and the screen would be one new form
   away from a hole."*
2. **The gate reads the channel's own `store_id`, never a caller-supplied one.** An update that
   authorised against a `storeId` from the form would let a manager scoped to store A edit store
   B's channel by posting B's `channelId` with A's store. `setChannelPayoutDestination:522-526`
   already does it in the correct order and is the precedent.
3. **A non-remitted channel names its receivable — enforced by the DATABASE.**
   `sales_channels_non_remitted_needs_receivable_check` is the authority; the domain's copy exists
   only to turn a constraint name into a sentence. — **RULES §6 item 3 (bible §15.11)**, *"the database enforces
   the rules, not the service layer."*
4. **A receivable account must be postable, active AND `requires_party`.** T-118's trigger refuses
   a `1220`-shaped line without a party and refuses a party on an account that does not want one,
   both directions. `sales-days/routing.ts:211-225` debits `receivableAccountCode` with
   `partyType: 'channel'`, so an account with `requires_party = false` makes a channel that
   configures cleanly and blocks every day it appears on.
5. **Uniqueness is `(org_id, store_id, lower(trim(name)))` and it ships in the same migration as
   the first create path.** — bible §4.4 rule 3, DEF-205. Never after; the interval between is when
   the duplicate arrives.
6. ⭐ **A wastage points at its channel by id from the moment it is created, so a rename is a
   display change and resolves nothing differently.** — contract 3 (orchestrator R1). The `channel`
   text is the name as recorded: memo and display only, never re-read to find a channel and never
   updated after creation.
7. **Deactivate, never delete; and a retired channel still posts what it already owes.** FK
   `restrict` on three tables makes deletion impossible; an open wastage predating the retirement
   must still resolve, so `findChannelByName` does not filter on `is_active`.
8. **`is_active` is not part of `updateSalesChannel`.** Retiring a channel and correcting its
   receivable are different acts with different consequences; one form that does both retires a
   channel as a side effect of a typo fix. Separate function, separate button, separate test.
9. **One writer per column.** `destination_money_account_id` belongs to
   `setChannelPayoutDestination`; this task reads it. — bible §4.2 rule 8.
10. **The recorder states facts; the channel states policy.** `typeMode` is derived and
    unspecifiable by a caller. — bible §13 row 180.
11. **Nothing here is seeded and nothing is created at store creation.** Ian's DEF-207 call,
    2026-09-07: an admin surface, not seed-at-creation. `createStore` is untouched.

---

## Tests — written before the implementation, each watched to fail for the right reason

Runner: `node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_t229 <files>`.
⛔ **Never `npm run test:integration`** — it truncates a database shared with other lanes.

### New — `packages/domain/tests/integration/sales-channels-admin.test.ts`

| # | Case | Must fail first because | Proves |
|---|---|---|---|
| 1 | ⭐ A store with **zero** channels reports `salesChannel` **not ok, blocking** → an admin calls `createSalesChannel` → `storeReadiness` reports it **ok** | `createSalesChannel` does not exist | ⛔ **DEF-207 itself.** The only test that proves the remedy is a remedy |
| 2 | A **manager** creates one and succeeds; a **cashier** is refused with `AuthorizationError`; a manager scoped to another store is refused | no function to call | Invariants 1–2, and the ✗ half — *"a capability with no denial test is a checkbox, not a control"* |
| 3 | `isRemittedDaily: false` with no receivable is refused, and the message names the receivable — not `sales_channels_non_remitted_needs_receivable_check` | — | Invariant 3, and that the DB constraint is reachable rather than pre-empted into silence |
| 4 | A blank/whitespace name is refused. A name colliding by **case and padding** (`Foodpanda` vs `  foodpanda `) is refused through the domain with a message naming the existing channel — **and, in the same test, inserted twice straight through the repo, bypassing the pre-read, where the INDEX refuses it** | the shipped index is case-sensitive, so both the second domain call and the second raw insert **succeed** today | ⛔ Invariant 5, DEF-205's rule on a second table. ⚠️ R6: the raw half is what makes *"by the database"* mean anything — a `channelByNormalisedName` pre-read alone only proves the sentence is nice |
| 5 | Receivable validation, four refusals: a code not in `accounts`; `is_postable = false`; `status = 'reserved'`; `requires_party = false` | — | Invariant 4, all four halves |
| 6 | Another org's store is refused on create; another org's channel is refused on update — **refused, not silently no-op** | — | Cross-org isolation |
| 7 | ⭐ Rename survives by id: one **open** tracked wastage and one **resolved** one on `Foodpanda` → rename to `Foodpanda PH` → **the open one resolves and posts**, and the resolved one's memo is **unchanged**. Its settlement match still proposes after the rename | `channel_id` does not exist; the resolve throws *"no 'Foodpanda' channel is configured"*, and `settlement-match` stops matching | ⛔ **Finding (a).** The failure this spec exists to prevent, and the reason contract 3 is an FK rather than a sync path |
| 8 | Deactivate: `countSalesChannels` drops by one, readiness goes back to **not ok**, `listChannels(activeOnly)` omits it, plain `listChannels` still returns it, and the row is **still there** | `setSalesChannelActive` does not exist; `activeOnly` does not exist | Invariant 7, contract 4, and finding (b)'s first half |
| 9 | `updateSalesChannel` leaves `is_active`, `destination_money_account_id` and `tax_treatment` **byte-identical** after a name+receivable edit | — | Invariants 8–9 |
| 10 | ⭐ Migration backfill: a channel inserted with `wastage_type_mode` **omitted** reads `'tracked'`; an insert of `'both'` is refused by the CHECK | the column does not exist | Contract 6, and that the safe side is the default |

### New — the derivation, in the same file

| # | Case | Must fail first because | Proves |
|---|---|---|---|
| 11 | ⭐ `recordOrderWastage` on a **tracked** channel with no disposition → `open`, Monitor seeded; on an **instant** channel with `absorbed` → `resolved` + a journal entry `Dr 5300 / Cr 1220` | the input still demands `typeMode` | Contract 7 — the mode comes from the channel |
| 12 | ⛔ **The hole Ian closed.** On a **tracked** channel, supplying a `disposition` is refused with a named reason — and `typeMode` is not a field a caller can pass at all | today the identical call **succeeds** and resolves the row instantly, skipping the monitor, the dispute window and the backstop | ⛔ **Bible row 180.** Watch this one succeed before the change and refuse after — a test that only ever passed proves nothing |
| 13 | A channel name that is not configured is refused **at creation**, naming the channel | today creation accepts it and it fails much later, at posting | Finding (c) |
| 14 | Recording against a **deactivated** channel is refused at creation — **but** a wastage opened before the deactivation still resolves and posts | — | Invariant 7, both halves. The one that catches an over-eager `is_active` filter in `findChannelByName` |

### Existing suites — re-run because this task changes their contract

`order-wastage.test.ts` (**updated**: 17 `typeMode` call sites removed, the fixture gains an
`instant` channel) · `sales-days.test.ts` · `channel-settlements.test.ts` · `stores.test.ts` ·
`sales-rollup.test.ts`. Plus `npm run typecheck` and `npm test` (unit) whole.

### Smoketest on 9008, dev server running (bible §9.4)

1. `/settings` shows the new card; it opens the screen. Both measure
   `scrollWidth − clientWidth === 0` at **390 × 844**.
2. Create a channel with the remittance radios **untouched** → the browser refuses; force the POST
   → **the server refuses** with a sentence, not a stack trace.
3. Create *Settles later* with no receivable → refused, naming the receivable.
4. Create `Foodpanda`, then `  foodpanda ` → refused, naming the existing one.
5. ⭐ `/admin/stores/[id]` for a fresh store: `salesChannel` is amber and its link lands on the new
   screen **with the store already selected**. Add one. Reload: the row is green and the
   *"N things still stop this store working"* banner drops by one. **DEF-207, end to end.**
6. `/wastage`: the channel field is a **select**, the two mode radios are **gone**, and picking a
   tracked channel then submitting with a disposition is refused with a readable message.
7. Set that channel to **Instant**, reload `/wastage`, record with `absorbed` → resolves and posts.
   Set it back to Tracked → the same submission is refused again. The policy is the only thing that
   changed.
8. Rename a channel with an open wastage on it → the banner reports how many moved; the wastage
   detail page resolves and posts.
9. Deactivate it → gone from `/sales-days/new` and from `/wastage`'s picker, still listed on the
   settings screen as retired, and the open wastage still resolves.
10. Sign in as a **manager**: the screen works (they hold `manage_store_settings`). As a
    **cashier**: the write is refused by the server with a readable message and nothing changes.

---

## Out of scope

| Not done | Why |
|---|---|
| ⛔ **Seeding channels at store creation** | Ian's DEF-207 call, 2026-09-07 — an admin surface instead. `countSalesChannels`' own comment: a default here is *"a guess wearing the costume of a decision"* |
| ⛔ **A `wastageTypes` table** | Discovery §3.2: `order_wastages.channel` already resolves against `sales_channels`, so v1's types and v2's channels are the same objects under two names. A second list would make them agree by string-matching instead of by construction |
| ⛔ **The policy-memo generator** on v1's wastage settings screen | Memos are not a v2 module. Named, not built — discovery §7 |
| ~~Making `order_wastages.channel` an FK~~ | ⭐ **Reversed by orchestrator R1 — it is now contract 3, in scope.** The first draft deferred it on the grounds that T-178 chose text-by-name deliberately; re-reading T-178's spec, the text column is stated as a *shape*, and the only *reason* given for it (resolution happens at posting time) is exactly what this task removes |
| ⛔ **Editing `destination_money_account_id` / `tax_treatment`** | Contract 5 — one has a gated writer already, the other has one supported value |
| **T-229 slices 2, 3, 4** | Still T-229's. This task takes slice 5 only |
| **`audit_log` writes** | `audit_log` has zero writers and zero readers (DEF-169). `updated_at` is on the row |

---

## Open questions — for the orchestrator, and none of them blocks the build

1. ✅ **CLOSED by orchestrator R1, 2026-09-07.** *Rename: cascade or refuse?* — **neither.** A real
   `channel_id` FK makes the question disappear rather than answering it, which is the better shape
   of answer. Contract 3.
2. ✅ **CLOSED by orchestrator R4, 2026-09-07.** The two `/sales-days` lines land **here**;
   `writeChannels` stays unfiltered.
3. ✅ **ANSWERED by orchestrator R5, 2026-09-07 — ship as specced.** Every existing channel
   backfills to `tracked`, with no name heuristic, and the dine-in channels are set to Instant by
   hand during the smoketest. ⚠️ **On production this is moot**: there are zero channels and zero
   orgs, so whoever creates each channel picks its mode at that moment. The visible-change concern
   applies to dev and to any store already configured by hand.

---

## Done when

- [x] `/settings/sales-channels` creates, renames, re-points and retires a channel, gated
      `manage_store_settings`, refusing a rank-and-file staff member, another org's row, an
      unstated remittance flag, a missing receivable, a non-postable / reserved / party-less
      account, and a case-or-whitespace duplicate — the last **by the database**
      (⚠️ there is no `cashier` ROLE in v2: `person_roles_role_check` allows only
      super_admin | admin | manager | staff, so the denial case is a staff member)
- [x] ⭐ **DEF-207 closed**: a store with no channel reports `salesChannel` **not ok, blocking**;
      one `createSalesChannel` call flips it to ok — test 1. ⏳ Smoketest 5 is the orchestrator's
- [x] ⭐ **Bible row 180 shipped**: `RecordOrderWastageInput.typeMode` is **deleted**, the mode is
      derived from the channel, the two radios are gone from `/wastage`, and **test 12 was watched
      to succeed before and refuse after** — the "before" run reported
      `AssertionError: promise resolved "{ status: 'resolved' }" instead of rejecting`, which is
      the hole itself: a tracked-channel wastage booked and closed in one call
- [x] ⭐ **`order_wastages.channel_id` shipped** (R1): backfilled, `not null`, FK `restrict`,
      indexed; `postDisposition` resolves by id; `settlement-match` keys on id; a rename resolves
      nothing differently — test 7 (integration) and the rewritten unit test
- [x] Migration 0133 **hand-written from the schema files** (DEF-073 / DEF-121 — finding (d)),
      with the enum column and its CHECK declared in the schema builder per R3's intent;
      `idx: 133`, `when: 1797564707084` (0132 is `1797478307084`); applied to `shareat_test_t229`
      and **verified in the database**: `wastage_type_mode` NOT NULL default `'tracked'`,
      `channel_id` NOT NULL + FK, and the index reads
      `(org_id, store_id, lower(TRIM(BOTH FROM name)))`
- [x] **15** new integration tests pass on `shareat_test_t229` (the spec listed 14; test 15 was
      added for the settlement matcher's id key), plus `order-wastage`, `sales-days`,
      `channel-settlements`, `stores`, `sales-rollup` and `scheduler` — **7 files, 121 tests, 0
      failures**
- [x] `npm run typecheck` **clean**
- [ ] ⛔ `npm test` — **1059 passed / 1 failed / 1 skipped, 63 of 64 files.** The failure is
      **not this lane's**: `tests/unit/no-client-supplied-actor.test.ts` is a guard another lane
      added to the shared tree while this task was building (+93 lines, uncommitted, alongside
      `docs/tasks/231-tenancy-id-never-from-the-client.md`). It flags
      `apps/erp/src/app/inventory/returns/actions.ts`, `.../inventory/transfers/actions.ts` and
      `.../trade/returns/actions.ts` for reading `orgId` from client input — DEF-210 / T-231.
      **None of those three files is touched by T-230**, and no T-230 file is flagged.
      ⚠️ **Consequence, stated rather than waved past:** `npm test` is red as a whole, so any
      CI job or wrap-up gate keyed on it fails, and this task cannot be committed on a green
      `npm test` until T-231 lands its fixes. The two lanes are independent; the ordering is the
      orchestrator's call
- [ ] Smoketested on 9008 — all ten items, including both 390 px measurements *(orchestrator runs
      9008 and the browser smoketest for this lane)*
- [ ] `npm run build` succeeds **with the dev server stopped** *(orchestrator runs this)*
- [x] Self-reviewed line by line
- [ ] Committed with a message saying *why* *(orchestrator)*
- [ ] ⛔ **Filed by the orchestrator, not this lane**: DEF-207 → `✅ Corrected`; a register row for
      finding (c) (`/wastage`'s free-text channel accepted a name nothing checked until posting);
      a register row for finding (d) if `db:generate` is to be re-attempted by anyone
      (DEF-073/DEF-121 already cover it, but three task specs now instruct the opposite); and
      bible §13 row 180's Disposition updated from *"Built as part of lane B's package"* to shipped

---

## Deviations from this spec, as built (RULES §3.4a — reported, never silently worked around)

| # | Spec said | As built | Why |
|---|---|---|---|
| 1 | The `order-wastage` fixture gains a second, `instant` channel | It does not | ⭐ **The T-178 suite contains no `instant` case at all** — all 17 `recordOrderWastage` calls were `typeMode: 'tracked'`, and the word "instant" does not appear in the file. A second fixture channel would have been dead setup. The instant path is covered by new tests 11 and 14 instead. ⚠️ Worth noting on its own: T-178's own suite never exercised half of its `type_mode` contract |
| 2 | Modify `apps/erp/src/app/sales-days/new/page.tsx` | Not modified | It calls `listChannels` through `sales-days/lib.ts`, which is the one place the `activeOnly` filter was needed. Editing the page too would have been a second copy of one decision |
| 3 | 14 integration tests | 15 | Test 15 pins the settlement matcher's id key at the unit boundary the integration test cannot reach cheaply |
| 4 | `apps/erp/src/lib/constraint-messages.ts` listed as a scope addition to confirm | Taken, per R4 | Three keys added; no peer held the file |

⚠️ **Also worth the orchestrator's eye when reviewing the diff:** `git status` shows two files
this lane did **not** touch — `tests/unit/no-client-supplied-actor.test.ts` (+93) and
`packages/domain/tests/integration/supplier-returns.test.ts` (+111) — plus
`docs/tasks/231-tenancy-id-never-from-the-client.md`. They arrived in the shared tree from the
other lane mid-build.

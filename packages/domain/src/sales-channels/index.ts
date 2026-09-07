/**
 * Sales-channel administration — T-230.
 * `docs/tasks/230-sales-channels-admin-and-wastage-policy.md`. Closes **DEF-207**.
 *
 * ## ⛔ Why this is not in `stores/service.ts`
 *
 * That file is T-222's store lifecycle and its module constant is `const CAPABILITY =
 * 'manage_stores'` — admin-only. Channels are `manage_store_settings`: store-scoped, and a
 * **manager holds it**. Putting a manager-level function in a file whose every other function is
 * admin-only is how the wrong gate gets copied from the function above.
 *
 * ## ⭐ What DEF-207 actually was
 *
 * `sales_channels` had **no production writer of any kind** — only `scripts/dev-seed.ts` (guarded
 * to `_dev` databases) and test fixtures. Meanwhile `storeReadiness`'s `salesChannel` check is
 * **blocking**: *"Without one a sales day has nowhere to land."* So a store created through
 * `/admin/stores` was permanently not-ready, its own readiness panel said so, and there was no
 * remedy anywhere in the product. That is DEF-193's shape one severity higher.
 *
 * ## ⚠️ Two columns this module deliberately does NOT write
 *
 * - **`destination_money_account_id`** already has a gated writer with its own screen and tests:
 *   `channel-settlements`' `setChannelPayoutDestination`, on the same `manage_store_settings`
 *   capability. A second writer is a second validation, and the two would drift (bible §4.2
 *   rule 8). The settings screen shows it and links there.
 * - **`tax_treatment`** has exactly one supported value. No `1270` creditable-withholding asset is
 *   seeded — deliberately, per the schema's own comment — and bible §13 row 75 makes the credit
 *   unrealisable because this ledger is never a filing basis. `channel-settlements` says it
 *   plainly: *"today every channel is `expense`."* Offering the other value would let a manager
 *   pick a posture the ledger cannot honour.
 */
import { salesDaysRepo, storesRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';

/** Store-scoped, manager ✅ — `packages/auth/src/capabilities.ts:206`, `:492`. */
const CAPABILITY = 'manage_store_settings' as const;

export type SalesChannelWastageMode = 'tracked' | 'instant';

export interface SalesChannelAdminRow {
  readonly id: string;
  readonly name: string;
  readonly isRemittedDaily: boolean;
  readonly receivableAccountCode: string | null;
  readonly wastageTypeMode: SalesChannelWastageMode;
  readonly isActive: boolean;
  /** Read-only here — `setChannelPayoutDestination` owns it. */
  readonly destinationMoneyAccountId: string | null;
  /** Read-only here — one supported value, see the module comment. */
  readonly taxTreatment: string;
}

export interface CreateSalesChannelInput {
  readonly storeId: string;
  readonly name: string;
  /**
   * ⭐ **Required, and not optional-with-a-default.** `is_remitted_daily` is NOT NULL with **no**
   * default in the schema, on purpose — *"a channel whose remittance behaviour nobody stated is a
   * channel whose money nobody can account for."* A `?: boolean` here would quietly reintroduce
   * the default the schema refused to have, which is precisely what v1 did
   * (`sales-channel-form.tsx:19` — `z.boolean().default(true)`), and why every v1 reader is
   * written `isRemittedDaily !== false`.
   */
  readonly isRemittedDaily: boolean;
  readonly receivableAccountCode?: string | null;
  /**
   * ⭐ Defaults to `tracked` DELIBERATELY, unlike `isRemittedDaily` — because here there IS a safe
   * value. Tracked keeps the Wastage Monitor, the 48-hour dispute window and the 15-day
   * auto-charge backstop; instant removes all three.
   */
  readonly wastageTypeMode?: SalesChannelWastageMode;
}

export interface UpdateSalesChannelInput {
  readonly channelId: string;
  readonly name: string;
  readonly isRemittedDaily: boolean;
  readonly receivableAccountCode?: string | null;
  readonly wastageTypeMode: SalesChannelWastageMode;
}

/**
 * ⛔ The wiring a non-remitted channel needs, checked in the domain ONLY so the refusal is a
 * sentence. **The database is the authority** — `sales_channels_non_remitted_needs_receivable_check`
 * refuses the row whatever this function believes (RULES §6 item 3, bible §15.11: a second copy is a second
 * source of truth, and the two will drift).
 */
async function validateWiring(
  tx: Tx,
  orgId: string,
  isRemittedDaily: boolean,
  receivableAccountCode: string | null,
): Promise<string | null> {
  if (!isRemittedDaily && !receivableAccountCode) {
    throw new Error(
      'This channel settles later, so it needs a receivable account — otherwise its sales have ' +
        'nowhere to land and the money is silently lost rather than refused (DEF-059).',
    );
  }
  if (!receivableAccountCode) return null;

  const account = await salesDaysRepo.receivableAccountFor(tx, orgId, receivableAccountCode);
  if (!account) {
    throw new Error(`Account ${receivableAccountCode} does not exist in this organisation's chart of accounts.`);
  }
  if (!account.isPostable) {
    throw new Error(
      `Account ${account.code} ${account.name} is not postable — it is a parent, and only a leaf account can carry a balance.`,
    );
  }
  if (account.status !== 'active') {
    throw new Error(`Account ${account.code} ${account.name} is ${account.status}, not active, so nothing may be posted to it.`);
  }
  if (!account.requiresParty) {
    throw new Error(
      `Account ${account.code} ${account.name} does not track who owes the money (no subledger party), ` +
        'so a sales day posting this channel to it would be refused. Use a receivable control account such as 1220.',
    );
  }
  return account.code;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error('A sales channel needs a name.');
  return name;
}

/**
 * ⚠️ Only to WORD the refusal. The unique index on `(org_id, store_id, lower(trim(name)))` is what
 * actually refuses a collision, including one this pre-read raced (bible §4.4 rule 3, DEF-205).
 */
async function refuseNameCollision(
  tx: Tx,
  orgId: string,
  storeId: string,
  name: string,
  exceptChannelId?: string,
): Promise<void> {
  const existing = await salesDaysRepo.channelByNormalisedName(tx, orgId, storeId, name);
  if (existing && existing.id !== exceptChannelId) {
    throw new Error(
      `This store already has a channel called "${existing.name}" — names are compared ignoring ` +
        'case and spacing, so it would be the same channel twice.',
    );
  }
}

export async function createSalesChannel(
  tx: Tx,
  actor: Actor,
  input: CreateSalesChannelInput,
): Promise<{ channelId: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  // ⚠️ Scoped to the actor's org, so one org cannot address another's store even holding scope.
  const store = await storesRepo.getById(tx, actor.orgId, input.storeId);
  if (!store) throw new Error('createSalesChannel: that store does not exist in this organisation.');

  const name = cleanName(input.name);
  await refuseNameCollision(tx, actor.orgId, input.storeId, name);
  const receivableAccountCode = await validateWiring(
    tx,
    actor.orgId,
    input.isRemittedDaily,
    input.receivableAccountCode ?? null,
  );

  const { id } = await salesDaysRepo.insertChannel(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    name,
    isRemittedDaily: input.isRemittedDaily,
    receivableAccountCode,
    wastageTypeMode: input.wastageTypeMode ?? 'tracked',
  });
  return { channelId: id };
}

/**
 * ⭐ **The gate reads the channel's OWN `store_id`, never one the caller supplied.** Authorising
 * against a form-supplied store would let a manager scoped to store A edit store B's channel by
 * posting B's `channelId` with A's store. `setChannelPayoutDestination` already does it in this
 * order and is the precedent.
 *
 * ⛔ Does not touch `is_active` — retiring a channel and correcting one are different acts, and
 * one form that does both retires a channel as a side effect of fixing a typo.
 */
export async function updateSalesChannel(tx: Tx, actor: Actor, input: UpdateSalesChannelInput): Promise<void> {
  const channel = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!channel) throw new Error('updateSalesChannel: that sales channel does not exist in this organisation.');
  await authorize(tx, actor, CAPABILITY, { storeId: channel.storeId });

  const name = cleanName(input.name);
  await refuseNameCollision(tx, actor.orgId, channel.storeId, name, input.channelId);
  const receivableAccountCode = await validateWiring(
    tx,
    actor.orgId,
    input.isRemittedDaily,
    input.receivableAccountCode ?? null,
  );

  await salesDaysRepo.updateChannel(tx, actor.orgId, input.channelId, {
    name,
    isRemittedDaily: input.isRemittedDaily,
    receivableAccountCode,
    wastageTypeMode: input.wastageTypeMode,
  });
}

/**
 * ⛔ **Deactivate, never delete, and there is no delete function here on purpose.**
 * `sales_day_channels`, `order_wastages` and `channel_settlements` all reference a channel with
 * `on delete restrict`, so a delete either fails at the FK or destroys the party behind a posted
 * `1220` line. ⚠️ v1 shipped a hard delete beside its own `isActive` flag — *"This will permanently
 * remove the sales channel… This cannot be undone"* — which is the implementation this corrects
 * while keeping the capability (§1.2's four verbs).
 *
 * ⚠️ Not gated on having no open wastages: one opened before the channel was retired must still
 * resolve and post, which `orderWastageRepo.channelById` allows by not filtering on `is_active`.
 */
export async function setSalesChannelActive(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; isActive: boolean },
): Promise<void> {
  const channel = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!channel) throw new Error('setSalesChannelActive: that sales channel does not exist in this organisation.');
  await authorize(tx, actor, CAPABILITY, { storeId: channel.storeId });
  await salesDaysRepo.setChannelActive(tx, actor.orgId, input.channelId, input.isActive);
}

/**
 * The screen's read. ⚠️ **No capability gate**, matching `/settings/expense-categories`' own lib
 * and the house rule stated in `apps/erp/src/app/admin/users/lib.ts`: the gate belongs to the
 * WRITE. Someone who opens the screen and is refused on submit has been told the truth; hiding the
 * screen would be presentation, and presentation is not a control (DEF-051).
 */
export async function listSalesChannelsForAdmin(
  tx: Tx,
  _actor: Actor,
  input: { storeId: string },
): Promise<SalesChannelAdminRow[]> {
  const rows = await salesDaysRepo.listChannels(tx, _actor.orgId, input.storeId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isRemittedDaily: r.isRemittedDaily,
    receivableAccountCode: r.receivableAccountCode,
    wastageTypeMode: r.wastageTypeMode,
    isActive: r.isActive,
    destinationMoneyAccountId: r.destinationMoneyAccountId,
    taxTreatment: r.taxTreatment,
  }));
}

/** The receivable picker's options — postable, active, party-bearing (invariant 4). */
export async function receivableAccountOptions(
  tx: Tx,
  actor: Actor,
): Promise<{ code: string; name: string }[]> {
  return salesDaysRepo.receivableAccountOptions(tx, actor.orgId);
}

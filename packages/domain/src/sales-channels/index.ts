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
import { auditLogRepo, posV1Repo, salesDaysRepo, storesRepo, type Tx } from '@shareat/db';
import { authorize, can, type Actor } from '@shareat/auth';
import { refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SETTINGS_BANK_HINTS_RULES, SETTINGS_PLATFORM_CODE_RULES, SETTINGS_SALES_CHANNEL_RULES } from '../field-rules/settings';

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
  /** T-511 S2b — read-only here; `setSalesChannelPlatformCode` owns both (admin only). */
  readonly platform: 'grab' | 'foodpanda' | null;
  readonly platformStoreCode: string | null;
  /** T-564 — bank-name fragments for the payout parser. Stored, not yet read by intake. */
  readonly bankHints: readonly string[];
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
  // T-440: the rule (and its sentence) is the one the settings screen shows live (field-rules/settings.ts).
  return assertFieldRules(SETTINGS_SALES_CHANNEL_RULES, { name: raw }).name ?? '';
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
 * T-375 S1 (V6): a channel a POS link names is where POS's sales land, so it must stay remitted daily and active.
 * Called AFTER `authorize()`. Only the link's own channel is guarded; another channel of the store is free.
 */
async function refuseIfLinkedToPos(tx: Tx, orgId: string, channelId: string): Promise<void> {
  const link = await posV1Repo.getLinkByChannel(tx, orgId, channelId);
  if (link) {
    throw refuse(
      'sales channel is named by a POS link: it must stay remitted daily and active',
      "POS's sales land in this channel, so it has to stay remitted daily and active. Change the POS link first.",
    );
  }
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
  if (!input.isRemittedDaily) await refuseIfLinkedToPos(tx, actor.orgId, input.channelId);

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

// ---- T-511 S2b: which delivery platform a channel is, and the store code its statements print --------------------------

const GRAB_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const FOODPANDA_CODE = /^[A-Za-z0-9]{3,12}$/;
const PLATFORM_NAME = { grab: 'Grab', foodpanda: 'Foodpanda' } as const;

/**
 * ⚠️ Only to recognise the unique index refusing the code (a race the pre-read cannot see). The error may arrive wrapped,
 * so the cause chain is walked, as `pos/store-link.ts` does for its own index.
 */
function isPlatformCodeTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'sales_channels_org_platform_code_key') return true;
  }
  return false;
}

/**
 * ⭐ **Say which platform a channel is and what store code that platform prints on its statements** (T-511 S2b).
 * Both boxes blank clears it. Copy of `setChannelPayoutDestination`'s order: read the channel, authorize on the CHANNEL's own
 * store, judge the boxes AFTER the gate (a manager posting garbage is told they may not, not that the code is malformed),
 * a same-value save writes nothing (no `updated_at` move, no audit row), and a real change writes its audit row in the same
 * transaction.
 *
 * ⛔ The unique index `sales_channels_org_platform_code_key` is the authority on "one channel per code"; the read below only
 * words the sentence, and a race the read could not see ends in the same refusal.
 */
export async function setSalesChannelPlatformCode(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; platform: 'grab' | 'foodpanda' | null; code: string | null },
): Promise<{ wrote: boolean }> {
  const channel = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!channel) {
    throw refuse(`setSalesChannelPlatformCode: channel ${input.channelId} does not exist.`, 'That channel no longer exists.');
  }
  // Admin only (Ian, T-511 S2): the code decides which store an uploaded settlement file books to.
  await authorize(tx, actor, 'edit_platform_store_code', { storeId: channel.storeId });
  const checked = assertFieldRules(SETTINGS_PLATFORM_CODE_RULES, { platform: input.platform ?? '', code: input.code ?? '' });
  const platform = (checked.platform ?? null) as 'grab' | 'foodpanda' | null;
  const code = checked.code ?? null;

  if (platform && !code) {
    throw refuse('setSalesChannelPlatformCode: a platform needs a code.', `Enter the store code ${PLATFORM_NAME[platform]} prints on its statements, or choose no platform.`);
  }
  if (!platform && code) {
    throw refuse('setSalesChannelPlatformCode: a code needs a platform.', 'Choose the platform this store code belongs to, or clear the code.');
  }
  if (platform === 'grab' && code && !GRAB_UUID.test(code)) {
    throw refuse('setSalesChannelPlatformCode: not a Grab store UUID.', 'A Grab store code is the 36-character Store ID from the Grab files, in the form 8-4-4-4-12 letters and digits separated by dashes.');
  }
  if (platform === 'foodpanda' && code && !FOODPANDA_CODE.test(code)) {
    throw refuse('setSalesChannelPlatformCode: not a Foodpanda store code.', 'A Foodpanda store code is 3 to 12 letters or digits.');
  }

  // Same value: nothing to write. Compared as typed (a case-only edit of the code is a real change).
  if (channel.platform === platform && channel.platformStoreCode === code) return { wrote: false };

  if (platform && code) {
    const holder = await salesDaysRepo.channelByPlatformCode(tx, actor.orgId, platform, code, input.channelId);
    if (holder) {
      // Name the holder only to someone who could edit its code too: a store-scoped admin must not learn another store's channel names.
      const named = await can(tx, actor, 'edit_platform_store_code', { storeId: holder.storeId });
      throw refuse(
        `setSalesChannelPlatformCode: code held by channel ${holder.id}.`,
        named
          ? `That code is already used by ${holder.storeName} ${holder.name}${holder.isActive ? '' : ' (retired)'}.`
          : 'That code is already used by another channel.',
      );
    }
  }

  try {
    await salesDaysRepo.setChannelPlatformCode(tx, actor.orgId, input.channelId, platform, code);
  } catch (err) {
    if (isPlatformCodeTaken(err)) {
      throw refuse('setSalesChannelPlatformCode: the unique index refused the code.', 'That code is already used by another channel.');
    }
    throw err;
  }

  // Same transaction, only on a real write. `source: 'web'`: the settings screen is the only caller today.
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'sales_channel.platform_code_edited',
    storeId: channel.storeId,
    entityId: input.channelId,
    before: { platform: channel.platform, platformStoreCode: channel.platformStoreCode },
    after: { platform, platformStoreCode: code },
    source: 'web',
  });
  return { wrote: true };
}

/**
 * T-564 — bank-name fragments a payout parser can use to recognise a channel's account (stored, not yet read by intake).
 * `manage_store_settings` on the channel's own store, like the rest of the channel settings. A same-value save writes nothing; a
 * real change writes its audit row in the same transaction.
 */
export async function setSalesChannelBankHints(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; bankHints: readonly string[] },
): Promise<{ wrote: boolean }> {
  const channel = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!channel) throw refuse(`setSalesChannelBankHints: channel ${input.channelId} does not exist.`, 'That channel no longer exists.');
  await authorize(tx, actor, CAPABILITY, { storeId: channel.storeId });
  const bankHints = [...new Set(input.bankHints.map((s) => s.trim()).filter(Boolean))];
  // After the gate: a format limit (at most 20 names, 60 characters each) in plain words.
  assertFieldRules(SETTINGS_BANK_HINTS_RULES, { bankHints: bankHints.join(',') });
  if (JSON.stringify(bankHints) === JSON.stringify(channel.bankHints)) return { wrote: false };
  await salesDaysRepo.setChannelBankHints(tx, actor.orgId, input.channelId, bankHints);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'sales_channel.bank_hints_edited',
    storeId: channel.storeId,
    entityId: input.channelId,
    before: { bankHints: channel.bankHints },
    after: { bankHints },
    source: 'web',
  });
  return { wrote: true };
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
  if (!input.isActive) await refuseIfLinkedToPos(tx, actor.orgId, input.channelId);
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
    platform: r.platform,
    platformStoreCode: r.platformStoreCode,
    bankHints: r.bankHints,
  }));
}

/** The receivable picker's options — postable, active, party-bearing (invariant 4). */
export async function receivableAccountOptions(
  tx: Tx,
  actor: Actor,
): Promise<{ code: string; name: string }[]> {
  return salesDaysRepo.receivableAccountOptions(tx, actor.orgId);
}

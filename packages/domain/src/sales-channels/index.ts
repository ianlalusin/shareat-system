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
import { auditLogRepo, channelSettlementsRepo, fiscalPeriodsRepo, journalRepo, manilaToday, posV1Repo, salesDaysRepo, storesRepo, type Tx } from '@shareat/db';
import { authorize, can, type Actor } from '@shareat/auth';
import { add, compare, formatMoney, negate, ZERO } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { postEntry } from '../ledger/post-entry';
import { requireRequestId } from '../ledger/replay';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SETTINGS_BANK_HINTS_RULES, SETTINGS_PLATFORM_CODE_RULES, SETTINGS_SALES_CHANNEL_RULES } from '../field-rules/settings';

/** Store-scoped, manager ✅ — `packages/auth/src/capabilities.ts:206`, `:492`. */
const CAPABILITY = 'manage_store_settings' as const;

/**
 * T-606 (DEF-924, Ian 18 Nov): a channel on a delivery PLATFORM must use the channel receivable - the one constant settlement, platform files, charges and wastage read.
 * Any other channel (dine-in, a wholesale buyer, a branch) may be sold on credit and keeps the free, party-bearing choice.
 */
export const PLATFORM_RECEIVABLE_CODE = channelSettlementsRepo.CHANNEL_RECEIVABLE_CODE;

/** The picker's options for a platform channel: only the channel receivable (what the settlement path accepts), from the same list every channel picks from. */
export function platformReceivableOptions(options: readonly { code: string; name: string }[]): { code: string; name: string }[] {
  return options.filter((o) => o.code === PLATFORM_RECEIVABLE_CODE);
}

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
  /** T-606: what the channel holds on accounts other than the channel receivable, net (a credit is negative); null when nothing. Presentation for the move button. */
  readonly offAccountBalance: string | null;
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
  /** T-606: the channel has a delivery platform, so only the channel receivable is allowed. */
  onPlatform = false,
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
  // T-618 DEF-927: a cash, payable or equity account is not somewhere a channel's sales can be owed (the picker lists receivables only; this is the server's own check).
  if (!salesDaysRepo.isReceivableAccount(account)) {
    throw refuse(
      `Account ${account.code} is a ${account.type} account, not a receivable.`,
      `Account ${account.code} ${account.name} is not a receivable account, so a channel's sales cannot be owed on it. Pick a receivable such as 1210 or 1220.`,
    );
  }
  // T-606: last, so the refusals above keep their messages.
  if (onPlatform && account.code !== PLATFORM_RECEIVABLE_CODE) {
    throw refuse(
      `A delivery-platform channel must use ${PLATFORM_RECEIVABLE_CODE} Channel receivable, not ${account.code}.`,
      `A channel on a delivery platform must use ${PLATFORM_RECEIVABLE_CODE} Channel receivable. Settlements, platform files and wastage all read that account, so ` +
        `${account.code} ${account.name} would leave its sales uncollected.`,
    );
  }
  return account.code;
}

/** What a channel holds, in words. Never a negative amount on screen: a credit balance is "in its favour". */
function heldSentence(total: ReturnType<typeof add>, where: string): string {
  return compare(total, ZERO) < 0 ? `has ${formatMoney(negate(total))} in its favour on ${where}` : `still has ${formatMoney(total)} owed on ${where}`;
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
  const seen = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!seen) throw new Error('updateSalesChannel: that sales channel does not exist in this organisation.');
  await authorize(tx, actor, CAPABILITY, { storeId: seen.storeId });
  // DEF-926: the row lock comes before the balance guard below, so a sales day verified at the same moment waits and posts on the account this edit leaves.
  const channel = await salesDaysRepo.lockChannel(tx, actor.orgId, seen.id);
  if (!channel) throw refuse(`updateSalesChannel: channel ${seen.id} vanished under the lock.`, 'That channel no longer exists.');
  // T-592 R1: a store code belongs only on a settle-later channel. The CHECK `sales_channels_platform_only_settle_later_check` is the authority.
  if (input.isRemittedDaily && channel.platform) {
    throw refuse(
      'updateSalesChannel: a channel with a platform store code cannot be remitted daily.',
      `"${channel.name}" has a ${PLATFORM_NAME[channel.platform]} store code. Ask an admin to clear it first.`,
    );
  }
  if (!input.isRemittedDaily) await refuseIfLinkedToPos(tx, actor.orgId, input.channelId);

  const name = cleanName(input.name);
  await refuseNameCollision(tx, actor.orgId, channel.storeId, name, input.channelId);
  const receivableAccountCode = await validateWiring(
    tx,
    actor.orgId,
    input.isRemittedDaily,
    input.receivableAccountCode ?? null,
    channel.platform !== null,
  );

  // T-606 S2: never switch a channel's receivable away from an account that still carries what the channel is owed (or owes). The old account would keep the balance
  // while settlements, platform files and the aging read the new one. Ian, 18 Nov: such a balance is cleared by voiding and re-posting the sales first.
  const old = channel.receivableAccountCode;
  if (old !== null && old !== receivableAccountCode) {
    const balances = await channelSettlementsRepo.partyBalancesByStore(tx, actor.orgId, channel.id, old);
    if (balances.length > 0) {
      const total = add(...balances.map((b) => b.balance));
      const oldAccount = await salesDaysRepo.receivableAccountFor(tx, actor.orgId, old);
      const held = heldSentence(total, `${old}${oldAccount ? ` ${oldAccount.name}` : ''}`);
      throw refuse(
        `updateSalesChannel: channel ${channel.id} still has ${total} on ${old}; its receivable account cannot change.`,
        channel.platform
          ? `${channel.name} ${held}. Press "Move to Channel receivable" on this channel's card; it moves the balance and the setting together.`
          : `${channel.name} ${held}. Void and re-post those sales on the normal screens so the balance clears, then change the account.`,
      );
    }
  }

  await salesDaysRepo.updateChannel(tx, actor.orgId, input.channelId, {
    name,
    isRemittedDaily: input.isRemittedDaily,
    receivableAccountCode,
    wastageTypeMode: input.wastageTypeMode,
  });
}

/**
 * ⭐ **T-606 S4 - "Move to Channel receivable"** (Ian, 18 Nov: "move the foodpanda and grab sales directly"). A delivery-platform channel whose balance sits on another account (Lipa's
 * Foodpanda and Grab sat on 1210) gets that balance moved to the channel receivable, and its setting switched, in ONE transaction, so the books and the screen can never disagree:
 * `authorize` FIRST (`manage_chart_of_accounts`, admin; a non-admin learns nothing about whether an id exists) -> the channel row LOCKED and re-read -> refuse a channel with no platform
 * -> the balance per store on EVERY account other than the channel receivable (exactly what the stranded-balance refusal reads) -> one reclass entry, per store Dr 1220 / Cr that account (a credit balance
 * the other way), party = the channel, dated TODAY (Manila) when today's month is open, else refused, never a closed period -> the channel's receivable set to the channel receivable -> the audit row.
 * Zero balance: it only switches the account. Already on the channel receivable with nothing elsewhere: nothing to do.
 *
 * ⭐ **It also runs for a channel ALREADY on the channel receivable** whose balance sits elsewhere again (an admin reversed the move entry, an old day was voided, a posting landed during the move):
 * that leftover is swept with the same entry and audit row. Without it the stranded-balance refusal would tell the user to "move it" while the button was gone.
 * Each press carries its own request id (minted when the page renders): a real second sweep posts; a replay of the SAME press finds its entry already written (idempotency key) and posts nothing.
 * Undoing a move is a normal reversal of its entry by an admin (`reverseEntry`); a reversal does not change the setting, and what it puts back on the old account is swept by the next press.
 */
export async function moveChannelToChannelReceivable(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; requestId: string },
  /** Tests only: the Manila business date to date the entry by (the screen never passes one). */
  today?: string,
): Promise<{ moved: boolean; entryId: string | null; total: string; replayed?: true }> {
  await authorize(tx, actor, 'manage_chart_of_accounts', {});
  const seen = await salesDaysRepo.channelById(tx, actor.orgId, input.channelId);
  if (!seen) throw refuse(`moveChannelToChannelReceivable: channel ${input.channelId} does not exist in this organisation.`, 'That channel no longer exists.');
  const requestId = requireRequestId('moveChannelToChannelReceivable', input.requestId);
  // Under the row lock, so a verify or an edit racing this move reads what it committed; re-read, because a press that queued ahead may already have moved it.
  const channel = await salesDaysRepo.lockChannel(tx, actor.orgId, seen.id);
  if (!channel) throw refuse(`moveChannelToChannelReceivable: channel ${seen.id} vanished under the lock.`, 'That channel no longer exists.');
  if (!channel.platform) {
    throw refuse(
      `moveChannelToChannelReceivable: channel ${channel.id} has no delivery platform.`,
      `${channel.name} is not a delivery platform channel, so there is nothing to move. Only Grab and Foodpanda channels use the channel receivable.`,
    );
  }
  const old = channel.receivableAccountCode;
  // Every account but the channel receivable: the set the stranded-balance refusal blocks on, so one press clears exactly what it complains about.
  const balances = await channelSettlementsRepo.partyBalancesOffAccount(tx, actor.orgId, channel.id, PLATFORM_RECEIVABLE_CODE);
  if (old === PLATFORM_RECEIVABLE_CODE && balances.length === 0) return { moved: false, entryId: null, total: '0.00' };

  let entryId: string | null = null;
  let total = ZERO;
  let entryDate: string | null = null;
  if (balances.length > 0) {
    const clock = today ?? (await manilaToday(tx));
    const open = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, actor.orgId, clock, clock);
    if (open === null || open.shutBy !== null) {
      throw refuse(
        `moveChannelToChannelReceivable: the period of today ${clock} is closed or locked.`,
        `This month is closed, so the move can't be dated. Ask an admin to open a month first. Nothing was changed.`,
      );
    }
    if (!(await journalRepo.findPeriodForDate(tx, actor.orgId, clock))) {
      throw refuse(`moveChannelToChannelReceivable: no fiscal period covers ${clock}.`, `There is no fiscal period for today yet. Nothing was changed.`);
    }
    entryDate = clock;
    total = add(...balances.map((b) => b.balance));
    const from = [...new Set(balances.map((b) => b.accountCode))].join(', ');
    const memo = `${channel.name} receivable moved from ${from} to ${PLATFORM_RECEIVABLE_CODE}`;
    const party = { partyType: 'channel' as const, partyId: channel.id };
    const lines = balances.flatMap((b) => {
      const owed = compare(b.balance, ZERO) > 0; // a credit balance posts the other way round
      const amount = String(owed ? b.balance : negate(b.balance));
      return [
        { accountCode: PLATFORM_RECEIVABLE_CODE, storeId: b.storeId, debit: owed ? amount : '0', credit: owed ? '0' : amount, ...party, lineMemo: memo },
        { accountCode: b.accountCode, storeId: b.storeId, debit: owed ? '0' : amount, credit: owed ? amount : '0', ...party, lineMemo: memo },
      ];
    });
    const posted = await postEntry(tx, {
      orgId: actor.orgId,
      entryDate: clock,
      sourceType: 'channel_receivable_reclass',
      sourceId: channel.id,
      idempotencyKey: `channel_receivable_reclass:${channel.id}:${requestId}`,
      memo,
      postedBy: actor.personId,
      lines,
    });
    // A replay of a press whose entry was written (and later reversed): nothing new was posted, so nothing else happens either. DEF-929: `total` is what sits on another account NOW
    // (the reversal put it back), so the screen can say so instead of "nothing to do".
    if (!posted.created) return { moved: false, entryId: posted.entryId, total: String(total), replayed: true };
    entryId = posted.entryId;
  }
  if (old !== PLATFORM_RECEIVABLE_CODE) {
    await salesDaysRepo.updateChannel(tx, actor.orgId, channel.id, {
      name: channel.name,
      isRemittedDaily: channel.isRemittedDaily,
      receivableAccountCode: PLATFORM_RECEIVABLE_CODE,
      wastageTypeMode: channel.wastageTypeMode,
    });
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'sales_channel.receivable_moved',
    storeId: channel.storeId,
    entityId: channel.id,
    before: { receivableAccountCode: old, balance: String(total) },
    after: { receivableAccountCode: PLATFORM_RECEIVABLE_CODE, journalEntryId: entryId, entryDate },
    source: 'web',
  });
  return { moved: true, entryId, total: String(total) };
}

// ---- T-511 S2b: which delivery platform a channel is, and the store code its statements print --------------------------

const GRAB_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const FOODPANDA_CODE = /^[A-Za-z0-9]{3,12}$/;
const PLATFORM_NAME = { grab: 'Grab', foodpanda: 'Foodpanda' } as const;

/**
 * ⚠️ Only to recognise the unique index refusing the code (a race the pre-read cannot see). The error may arrive wrapped,
 * so the cause chain is walked, as `pos/store-link.ts` does for its own index.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === constraint) return true;
  }
  return false;
}

/** T-592 R2: the sentence for "this store already has an active channel on this platform" (pre-read and the index's 23505 say the same). */
const storePlatformClash = (platform: 'grab' | 'foodpanda', holderName?: string): string =>
  `This store already has an active ${PLATFORM_NAME[platform]} channel${holderName ? `, "${holderName}"` : ''}. A store can have only one.`;

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

  // T-592 R1: only a settle-later channel gets a store code. Clearing (both null) is always allowed. The CHECK is the authority.
  if (platform && channel.isRemittedDaily) {
    throw refuse(
      'setSalesChannelPlatformCode: a channel remitted daily has no store code.',
      `"${channel.name}" reaches the till, so it has no store code.`,
    );
  }

  // Same value: nothing to write. Compared as typed (a case-only edit of the code is a real change).
  if (channel.platform === platform && channel.platformStoreCode === code) return { wrote: false };

  // T-606: a delivery platform needs the channel receivable. Changing the receivable is its own step (and is refused while a balance sits on the old account), so it comes first.
  if (platform && channel.receivableAccountCode !== PLATFORM_RECEIVABLE_CODE) {
    throw refuse(
      `setSalesChannelPlatformCode: channel ${channel.id} receivable account is ${channel.receivableAccountCode ?? 'unset'}, not ${PLATFORM_RECEIVABLE_CODE}.`,
      `"${channel.name}" uses ${channel.receivableAccountCode ?? 'no receivable account'}. A channel on a delivery platform must use ${PLATFORM_RECEIVABLE_CODE} Channel receivable, so edit the channel and change its receivable account first, then set the platform.`,
    );
  }

  // T-592 R2: one active channel per platform per store. The unique index is the authority.
  if (platform && channel.isActive) {
    const rival = await salesDaysRepo.activeChannelOnPlatformAtStore(tx, actor.orgId, channel.storeId, platform, input.channelId);
    if (rival) throw refuse('setSalesChannelPlatformCode: the store already has an active channel on this platform.', storePlatformClash(platform, rival.name));
  }

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
    if (isUniqueViolation(err, 'sales_channels_org_platform_code_key')) {
      throw refuse('setSalesChannelPlatformCode: the unique index refused the code.', 'That code is already used by another channel.');
    }
    if (platform && isUniqueViolation(err, 'sales_channels_store_platform_active_key')) {
      throw refuse('setSalesChannelPlatformCode: the unique index refused a second active channel on the platform.', storePlatformClash(platform));
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
  if (!input.isActive) {
    await refuseIfLinkedToPos(tx, actor.orgId, input.channelId);
    // T-618 DEF-926: retiring a channel that still holds a balance strands it: a new channel starts at zero and the old one's receivable is never collected. Lock the row first
    // (a sales day verifying now waits), then read what is held on any account.
    await salesDaysRepo.lockChannel(tx, actor.orgId, channel.id);
    const held = await channelSettlementsRepo.partyBalancesOffAccount(tx, actor.orgId, channel.id, null);
    if (held.length > 0) {
      const total = add(...held.map((b) => b.balance));
      const where = [...new Set(held.map((b) => b.accountCode))].join(', ');
      throw refuse(
        `setSalesChannelActive: channel ${channel.id} still holds ${total} on ${where}; it cannot be retired.`,
        `${channel.name} ${heldSentence(total, where)}. Collect or settle that first, then retire the channel.`,
      );
    }
  }
  // T-592 R2: reactivating must not make a second active channel on one platform at the store. The unique index is the authority.
  // T-606 audit: and a platform channel may not come back on a receivable the platform paths do not read (the same rule the sales-day verify applies).
  if (input.isActive && channel.platform && channel.receivableAccountCode !== PLATFORM_RECEIVABLE_CODE) {
    throw refuse(
      `setSalesChannelActive: channel ${channel.id} is a delivery platform channel on receivable ${channel.receivableAccountCode ?? 'unset'}, not ${PLATFORM_RECEIVABLE_CODE}.`,
      `${channel.name} is a delivery platform channel but is not set to Channel receivable. Fix it in Settings › Sales channels, then turn it back on.`,
    );
  }
  if (input.isActive && channel.platform) {
    const rival = await salesDaysRepo.activeChannelOnPlatformAtStore(tx, actor.orgId, channel.storeId, channel.platform, input.channelId);
    if (rival) throw refuse('setSalesChannelActive: the store already has an active channel on this platform.', storePlatformClash(channel.platform, rival.name));
  }
  try {
    await salesDaysRepo.setChannelActive(tx, actor.orgId, input.channelId, input.isActive);
  } catch (err) {
    if (channel.platform && isUniqueViolation(err, 'sales_channels_store_platform_active_key')) {
      throw refuse('setSalesChannelActive: the unique index refused a second active channel on the platform.', storePlatformClash(channel.platform));
    }
    throw err;
  }
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
  const off = new Map<string, string>();
  for (const r of rows.filter((c) => c.platform !== null)) {
    const b = await channelSettlementsRepo.partyBalancesOffAccount(tx, _actor.orgId, r.id, PLATFORM_RECEIVABLE_CODE);
    if (b.length > 0) off.set(r.id, String(add(...b.map((x) => x.balance))));
  }
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
    offAccountBalance: off.get(r.id) ?? null,
  }));
}

/** The receivable picker's options — postable, active, party-bearing (invariant 4). */
export async function receivableAccountOptions(
  tx: Tx,
  actor: Actor,
): Promise<{ code: string; name: string }[]> {
  return salesDaysRepo.receivableAccountOptions(tx, actor.orgId);
}

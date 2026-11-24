/**
 * T-375 S2 (R1, R3, R7) - the store's tenders; T-629 (migration 0277) - a store tender IS the store's switch for one of the org's PAYMENT OPTIONS.
 * `docs/tasks/629-payment-options-master-list.md`.
 *
 * The option (`payment_options`, org-level, `pos/payment-options.ts`) owns the NAME and the KIND; the tender's own `name` / `kind` are a mirror the
 * database keeps equal. The store owns the rest: the money account (a wallet's, one of THIS store's active accounts), its POS v1 alias and whether it is
 * switched on. `pos_v1_alias`, normalized (lowercase, a-z0-9 only), is the identity among a store's ACTIVE tenders (R3).
 *
 * Capability `manage_chart_of_accounts` on the store: where money is booked is not a manager's setting. `authorize()` comes first (I1).
 * Every write is audited against entity `tenders`.
 */
import { auditLogRepo, moneyAccountsRepo, posV1Repo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';
import { normalizePosV1Alias } from './v1-methods';

const CAPABILITY = 'manage_chart_of_accounts' as const;

const ACCOUNT_SENTENCE = "That money account isn't one of this store's.";

const STALE_SENTENCE = 'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';

export interface SwitchOnPaymentOptionInput {
  readonly storeId: string;
  readonly paymentOptionId: string;
  readonly moneyAccountId?: string | null;
  readonly posV1Alias?: string | null;
}

export interface UpdateTenderInput {
  readonly tenderId: string;
  /** R1: the version the page was drawn with; a write against a changed row is refused. */
  readonly expectedVersion?: string;
  readonly posV1Alias?: string | null;
  readonly moneyAccountId?: string | null;
}

/** An empty or whitespace alias is no alias; an alias that normalizes to nothing is refused in words. */
function cleanAlias(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const alias = raw.trim();
  if (alias === '') return null;
  if (normalizePosV1Alias(alias) === '') {
    throw refuse(`tenders: alias "${alias}" has no letters or digits`, 'The POS name needs at least one letter or digit.');
  }
  return alias;
}

async function assertStoreAccount(tx: Tx, orgId: string, storeId: string, moneyAccountId: string): Promise<void> {
  const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId, activeOnly: false });
  const acct = accounts.find((x) => x.id === moneyAccountId);
  if (!acct) {
    throw refuse(`tenders: money account ${moneyAccountId} is not an account of store ${storeId}`, ACCOUNT_SENTENCE);
  }
  if (!acct.isActive) {
    throw refuse(
      `tenders: money account ${moneyAccountId} is retired`,
      `"${acct.name}" is a retired money account. Choose one that is active.`,
    );
  }
  if (acct.instrument === 'cash') {
    throw refuse(
      `tenders: money account ${moneyAccountId} is a cash drawer`,
      `"${acct.name}" is a cash drawer. A wallet tender pays into a bank or e-wallet account.`,
    );
  }
}

async function assertAliasFree(tx: Tx, orgId: string, storeId: string, alias: string | null, exceptId?: string): Promise<void> {
  if (alias == null) return;
  const holder = await posV1Repo.findActiveTenderByAlias(tx, orgId, storeId, normalizePosV1Alias(alias), exceptId);
  if (holder) {
    throw refuse(
      `tenders: alias "${alias}" is held by active tender ${holder.id}`,
      `Another tender of this store already answers to "${holder.posV1Alias ?? alias}" from POS.`,
    );
  }
}

function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name) return x.constraint_name;
  }
  return undefined;
}

/** A race past the pre-checks lands on the unique indexes: say it in words, never in constraint text. */
function translate(err: unknown, name: string, alias: string | null): never {
  const c = constraintOf(err);
  if (c === 'tenders_store_alias_active_unique') {
    throw refuse(`tenders: ${c}`, `Another tender of this store already answers to "${alias ?? ''}" from POS.`);
  }
  if (c === 'tenders_store_payment_option_unique' || c === 'tenders_store_name_unique') {
    throw refuse(`tenders: ${c}`, `${name} is already switched on at this store.`);
  }
  throw err;
}

/**
 * T-629: switch an option ON at a store. A store holds one tender per option (a unique): a first switch-on makes the row, a later one after a
 * switch-off turns the same row back on, and an option that is already on is refused in words. A wallet option needs one of THIS store's active
 * bank or e-wallet accounts; a cash option has none. A retired option cannot be switched on.
 */
export async function switchOnPaymentOption(tx: Tx, actor: Actor, input: SwitchOnPaymentOptionInput): Promise<{ id: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const option = await posV1Repo.getPaymentOptionById(tx, actor.orgId, input.paymentOptionId);
  if (!option) throw gone(`tenders: payment option ${input.paymentOptionId} not in org`, 'payment option');
  if (option.status === 'retired') {
    throw refuse(`tenders: payment option ${option.id} is retired`, `${option.name} is retired. An admin brings it back under Settings > Payment options first.`);
  }
  const existing = await posV1Repo.findTenderByOption(tx, actor.orgId, input.storeId, option.id);
  if (existing?.isActive) throw refuse(`tenders: ${option.name} already on at store ${input.storeId}`, `${option.name} is already switched on at this store.`);

  const alias = input.posV1Alias === undefined && existing ? existing.posV1Alias : cleanAlias(input.posV1Alias);
  const moneyAccountId = input.moneyAccountId === undefined && existing ? existing.moneyAccountId : (input.moneyAccountId ?? null);
  if (option.kind === 'wallet') {
    if (!moneyAccountId) throw refuse('tenders: wallet without a money account', `${option.name} needs the money account it pays into at this store.`);
    await assertStoreAccount(tx, actor.orgId, input.storeId, moneyAccountId);
  } else if (moneyAccountId) {
    throw refuse('tenders: cash tender with a money account', 'A cash tender has no money account.');
  }
  await assertAliasFree(tx, actor.orgId, input.storeId, alias, existing?.id);

  let id: string;
  try {
    if (existing) {
      await posV1Repo.updateTenderRow(tx, actor.orgId, existing.id, { isActive: true, moneyAccountId: option.kind === 'wallet' ? moneyAccountId : null, posV1Alias: alias });
      id = existing.id;
    } else {
      ({ id } = await posV1Repo.insertTender(tx, {
        orgId: actor.orgId,
        storeId: input.storeId,
        paymentOptionId: option.id,
        name: option.name,
        kind: option.kind,
        moneyAccountId: option.kind === 'wallet' ? moneyAccountId : null,
        posV1Alias: alias,
      }));
    }
  } catch (err) {
    translate(err, option.name, alias);
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: existing ? 'reactivate_tender' : 'create_tender',
    storeId: input.storeId,
    entityId: id,
    before: existing ? { isActive: false } : null,
    after: {
      storeId: input.storeId,
      paymentOptionId: option.id,
      name: option.name,
      kind: option.kind,
      moneyAccountId: option.kind === 'wallet' ? moneyAccountId : null,
      posV1Alias: alias,
    },
    source: 'web',
  });
  return { id };
}

async function loadAndAuthorize(tx: Tx, actor: Actor, tenderId: string) {
  // The store is needed to authorize, so the row is read plainly first; the lock follows the gate (I1).
  const peek = await posV1Repo.getTenderById(tx, actor.orgId, tenderId);
  if (!peek) throw gone(`tenders: tender ${tenderId} not in org`, 'tender');
  await authorize(tx, actor, CAPABILITY, { storeId: peek.storeId });
  const before = await posV1Repo.getTenderByIdForUpdate(tx, actor.orgId, tenderId);
  if (!before) throw gone(`tenders: tender ${tenderId} not in org`, 'tender');
  return before;
}

/** R1, checked first on the locked row, before any other refusal. The WHERE clause in the repo stays as the backstop. */
function assertFresh(current: string, expected: string | undefined, id: string): void {
  if (expected !== undefined && expected !== current) throw refuse(`tenders: ${id} version moved`, STALE_SENTENCE);
}

/** The store's own side of a tender: its money account (a wallet's) and its POS name. The name and kind are the option's and are never edited here. */
export async function updateTender(tx: Tx, actor: Actor, input: UpdateTenderInput): Promise<void> {
  const before = await loadAndAuthorize(tx, actor, input.tenderId);
  assertFresh(before.version, input.expectedVersion, before.id);

  const patch: { posV1Alias?: string | null; moneyAccountId?: string | null } = {};
  if (input.posV1Alias !== undefined) patch.posV1Alias = cleanAlias(input.posV1Alias);
  if (input.moneyAccountId !== undefined) {
    if (before.kind === 'cash') {
      if (input.moneyAccountId) throw refuse('tenders: money account on a cash tender', 'A cash tender has no money account.');
    } else {
      if (!input.moneyAccountId) throw refuse('tenders: wallet without a money account', 'A wallet tender needs the money account it pays into.');
      if (input.moneyAccountId !== before.moneyAccountId) await assertStoreAccount(tx, actor.orgId, before.storeId, input.moneyAccountId);
      patch.moneyAccountId = input.moneyAccountId;
    }
  }
  if (patch.posV1Alias !== undefined && before.isActive) {
    await assertAliasFree(tx, actor.orgId, before.storeId, patch.posV1Alias, before.id);
  }

  let changed = 0;
  try {
    changed = await posV1Repo.updateTenderRow(tx, actor.orgId, before.id, patch, input.expectedVersion);
  } catch (err) {
    translate(err, before.name, patch.posV1Alias ?? before.posV1Alias);
  }
  if (changed === 0 && input.expectedVersion !== undefined) throw refuse(`tenders: ${before.id} version moved`, STALE_SENTENCE);

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'update_tender',
    storeId: before.storeId,
    entityId: before.id,
    before: { name: before.name, kind: before.kind, moneyAccountId: before.moneyAccountId, posV1Alias: before.posV1Alias },
    after: {
      name: before.name,
      kind: before.kind,
      moneyAccountId: patch.moneyAccountId !== undefined ? patch.moneyAccountId : before.moneyAccountId,
      posV1Alias: patch.posV1Alias !== undefined ? patch.posV1Alias : before.posV1Alias,
    },
    source: 'web',
  });
}

export async function setTenderActive(tx: Tx, actor: Actor, input: { tenderId: string; isActive: boolean; expectedVersion?: string }): Promise<void> {
  const before = await loadAndAuthorize(tx, actor, input.tenderId);
  assertFresh(before.version, input.expectedVersion, before.id);
  if (before.isActive === input.isActive) return;

  if (input.isActive) {
    // A retired option cannot be switched on again: the same sentence as switchOnPaymentOption, before the database trigger would refuse it in raw words.
    const option = await posV1Repo.getPaymentOptionById(tx, actor.orgId, before.paymentOptionId);
    if (option?.status === 'retired') {
      throw refuse(`tenders: payment option ${option.id} is retired`, `${option.name} is retired. An admin brings it back under Settings > Payment options first.`);
    }
    // Reactivating must not put two active tenders on one alias.
    await assertAliasFree(tx, actor.orgId, before.storeId, before.posV1Alias, before.id);
    if (before.moneyAccountId) await assertStoreAccount(tx, actor.orgId, before.storeId, before.moneyAccountId);
  }
  let changed = 0;
  try {
    changed = await posV1Repo.updateTenderRow(tx, actor.orgId, before.id, { isActive: input.isActive }, input.expectedVersion);
  } catch (err) {
    translate(err, before.name, before.posV1Alias);
  }
  if (changed === 0 && input.expectedVersion !== undefined) throw refuse(`tenders: ${before.id} version moved`, STALE_SENTENCE);

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: input.isActive ? 'reactivate_tender' : 'retire_tender',
    storeId: before.storeId,
    entityId: before.id,
    before: { isActive: before.isActive },
    after: { isActive: input.isActive },
    source: 'web',
  });
}

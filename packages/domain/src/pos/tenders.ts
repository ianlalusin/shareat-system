/**
 * T-375 S2 (R1, R3, R7) - the tender master. `docs/tasks/375-pos-v1-day-feed.md` S2.
 *
 * A tender is what the till sells against (ADR-015 section 7); `pos_v1_alias` is how POS v1 names it, and its
 * normalized form is the identity among a store's ACTIVE tenders (R3). Capability `manage_chart_of_accounts` on the
 * store: where money is booked is not a manager's setting. `authorize()` comes first (I1).
 *
 * A wallet's money account must be an ACTIVE account of THIS store (the composite FK only proves the org).
 * Every write is audited against entity `tenders`.
 */
import { auditLogRepo, moneyAccountsRepo, posV1Repo, type Tx } from '@shareat/db';
import { TENDER_KINDS, type TenderKind } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';
import { normalizePosV1Alias } from './v1-methods';

const CAPABILITY = 'manage_chart_of_accounts' as const;

const ACCOUNT_SENTENCE = "That money account isn't one of this store's.";

const STALE_SENTENCE = 'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';

export interface CreateTenderInput {
  readonly storeId: string;
  readonly name: string;
  readonly kind: TenderKind;
  readonly moneyAccountId?: string | null;
  readonly posV1Alias?: string | null;
}

export interface UpdateTenderInput {
  readonly tenderId: string;
  /** R1: the version the page was drawn with; a write against a changed row is refused. */
  readonly expectedVersion?: string;
  readonly name?: string;
  readonly kind?: TenderKind;
  readonly posV1Alias?: string | null;
  readonly moneyAccountId?: string | null;
}

function cleanName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) throw refuse('tenders: name is blank', 'Give the tender a name.');
  return name;
}

/** '' and whitespace are no alias; an alias that normalizes to nothing is refused in words. */
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
  if (c === 'tenders_store_name_unique') {
    throw refuse(`tenders: ${c}`, `This store already has a tender called "${name}".`);
  }
  throw err;
}

export async function createTender(tx: Tx, actor: Actor, input: CreateTenderInput): Promise<{ id: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const name = cleanName(input.name);
  if (!(TENDER_KINDS as readonly string[]).includes(input.kind)) {
    throw refuse(`tenders: unknown kind ${String(input.kind)}`, 'Choose whether this tender is cash or a wallet.');
  }
  const alias = cleanAlias(input.posV1Alias);
  const moneyAccountId = input.moneyAccountId ?? null;
  if (input.kind === 'wallet') {
    if (!moneyAccountId) throw refuse('tenders: wallet without a money account', 'A wallet tender needs the money account it pays into.');
    await assertStoreAccount(tx, actor.orgId, input.storeId, moneyAccountId);
  } else if (moneyAccountId) {
    throw refuse('tenders: cash tender with a money account', 'A cash tender has no money account.');
  }
  await assertAliasFree(tx, actor.orgId, input.storeId, alias);

  let id: string;
  try {
    ({ id } = await posV1Repo.insertTender(tx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      name,
      kind: input.kind,
      moneyAccountId: input.kind === 'wallet' ? moneyAccountId : null,
      posV1Alias: alias,
    }));
  } catch (err) {
    translate(err, name, alias);
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'create_tender',
    entity: 'tenders',
    entityId: id,
    before: null,
    after: {
      storeId: input.storeId,
      name,
      kind: input.kind,
      moneyAccountId: input.kind === 'wallet' ? moneyAccountId : null,
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

export async function updateTender(tx: Tx, actor: Actor, input: UpdateTenderInput): Promise<void> {
  const before = await loadAndAuthorize(tx, actor, input.tenderId);
  assertFresh(before.version, input.expectedVersion, before.id);

  const patch: { name?: string; kind?: TenderKind; posV1Alias?: string | null; moneyAccountId?: string | null } = {};
  if (input.name !== undefined) patch.name = cleanName(input.name);
  if (input.posV1Alias !== undefined) patch.posV1Alias = cleanAlias(input.posV1Alias);
  if (input.kind !== undefined && !(TENDER_KINDS as readonly string[]).includes(input.kind)) {
    throw refuse(`tenders: unknown kind ${String(input.kind)}`, 'Choose whether this tender is cash or a wallet.');
  }
  const kindChanged = input.kind !== undefined && input.kind !== before.kind;
  const kind: TenderKind = input.kind ?? before.kind;
  if (kind === 'wallet') {
    // A wallet keeps its account unless a new one is given; a cash tender turned wallet must be given one.
    if (input.moneyAccountId !== undefined || kindChanged) {
      const accountId = input.moneyAccountId !== undefined ? input.moneyAccountId : null;
      if (!accountId) {
        throw refuse('tenders: wallet without a money account', 'A wallet tender needs the money account it pays into.');
      }
      if (accountId !== before.moneyAccountId) await assertStoreAccount(tx, actor.orgId, before.storeId, accountId);
      patch.moneyAccountId = accountId;
    }
  } else if (kindChanged) {
    // Wallet -> cash: the account is cleared (the shape CHECK holds). Naming one is refused.
    if (input.moneyAccountId) throw refuse('tenders: money account on a cash tender', 'A cash tender has no money account.');
    patch.moneyAccountId = null;
  } else if (input.moneyAccountId !== undefined) {
    throw refuse('tenders: money account on a cash tender', 'A cash tender has no money account.');
  }
  if (kindChanged) patch.kind = kind;
  if (patch.posV1Alias !== undefined && before.isActive) {
    await assertAliasFree(tx, actor.orgId, before.storeId, patch.posV1Alias, before.id);
  }

  let changed = 0;
  try {
    changed = await posV1Repo.updateTenderRow(tx, actor.orgId, before.id, patch, input.expectedVersion);
  } catch (err) {
    translate(err, patch.name ?? before.name, patch.posV1Alias ?? before.posV1Alias);
  }
  if (changed === 0 && input.expectedVersion !== undefined) throw refuse(`tenders: ${before.id} version moved`, STALE_SENTENCE);

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'update_tender',
    entity: 'tenders',
    entityId: before.id,
    before: { name: before.name, kind: before.kind, moneyAccountId: before.moneyAccountId, posV1Alias: before.posV1Alias },
    after: {
      name: patch.name ?? before.name,
      kind,
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
    entity: 'tenders',
    entityId: before.id,
    before: { isActive: before.isActive },
    after: { isActive: input.isActive },
    source: 'web',
  });
}

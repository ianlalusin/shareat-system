/**
 * T-629 (migration 0277) - the org's MASTER LIST of payment options (Cash, GCash, Maya, QRPH, Credit card, Debit card). `docs/tasks/629-payment-options-master-list.md`.
 *
 * Org-level: one list per org, edited on Settings > Payment options; each store switches the options on (`pos/tenders.ts`, a store tender is the switch). The option owns the
 * NAME and the KIND of every tender that uses it. Ian: cards stay simple (a `wallet` option tied, per store, to the bank money account the card machine pays into).
 *
 * Capability `manage_chart_of_accounts`, org scope (admin and super-admin; a manager is refused, a cashier too): the same bar as the tenders a store holds and as every other
 * org-wide setting of where money is booked. `authorize()` is the first statement of every write; every write is audited against entity `payment_options`.
 *
 * Rules here speak first in words; the database holds them too (0277): a name unique per org (case-insensitively), the kind frozen while any store
 * uses the option, retiring refused while any store has it switched on. An org may hold several cash options (Lipa's live tenders are Cash and Collected).
 */
import { fromCentavos, toCentavos, type Money } from '@shareat/core/money';
import { auditLogRepo, posV1Repo, type Tx } from '@shareat/db';
import { PAYMENT_OPTION_STATUSES, TENDER_KINDS, type PaymentOptionStatus, type TenderKind } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SETTINGS_PAYMENT_OPTION_RULES } from '../field-rules/settings';
import { normalizePosV1Alias } from './v1-methods';

const CAPABILITY = 'manage_chart_of_accounts' as const;

export interface CreatePaymentOptionInput {
  readonly name: string;
  readonly kind: TenderKind;
}

export interface UpdatePaymentOptionInput {
  readonly paymentOptionId: string;
  readonly name?: string;
  readonly kind?: TenderKind;
}

function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name) return x.constraint_name;
  }
  return undefined;
}

/** A race past the pre-checks lands on the unique indexes: say it in words. */
function translate(err: unknown, name: string): never {
  const c = constraintOf(err);
  if (c === 'payment_options_org_name_unique') throw refuse(`payment options: ${c}`, `There is already a payment option called "${name}".`);
  throw err;
}

/** The name judged by the one rule set the form shows (1-40 characters), and it must hold a letter or a digit: its a-z0-9 form is how a store tender is matched to it. */
function cleanName(raw: string): string {
  const name = assertFieldRules(SETTINGS_PAYMENT_OPTION_RULES, { name: raw, kind: 'cash' }).name ?? '';
  if (normalizePosV1Alias(name) === '') throw refuse(`payment options: name "${name}" has no letters or digits`, 'The name needs at least one letter or digit.');
  return name;
}

function cleanKind(kind: unknown): TenderKind {
  if (!(TENDER_KINDS as readonly unknown[]).includes(kind)) throw refuse(`payment options: unknown kind ${String(kind)}`, 'Choose whether this payment option is cash or a wallet.');
  return kind as TenderKind;
}

/** The same name twice (any case or punctuation: "G-Cash" is "GCash") is refused in words, before the index would. */
async function assertFree(tx: Tx, orgId: string, name: string, exceptId?: string): Promise<void> {
  const same = await posV1Repo.findPaymentOptionByKey(tx, orgId, normalizePosV1Alias(name));
  if (same && same.id !== exceptId) throw refuse(`payment options: "${name}" matches option ${same.id}`, `There is already a payment option called "${same.name}".`);
}

export async function createPaymentOption(tx: Tx, actor: Actor, input: CreatePaymentOptionInput): Promise<{ id: string }> {
  await authorize(tx, actor, CAPABILITY, {});
  const name = cleanName(input.name);
  const kind = cleanKind(input.kind);
  await assertFree(tx, actor.orgId, name);
  const all = await posV1Repo.listPaymentOptions(tx, actor.orgId);
  const sortOrder = all.reduce((m, o) => Math.max(m, o.sortOrder), 0) + 10;
  let id: string;
  try {
    ({ id } = await posV1Repo.insertPaymentOption(tx, { orgId: actor.orgId, name, kind, sortOrder }));
  } catch (err) {
    translate(err, name);
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'payment_option.created',
    storeId: null,
    entityId: id,
    before: null,
    after: { name, kind, sortOrder },
    source: 'web',
  });
  return { id };
}

async function loadLocked(tx: Tx, actor: Actor, paymentOptionId: string) {
  const row = await posV1Repo.getPaymentOptionById(tx, actor.orgId, paymentOptionId, true);
  if (!row) throw gone(`payment options: option ${paymentOptionId} not in org`, 'payment option');
  return row;
}

/** Rename, and change cash / wallet while no store uses the option. */
export async function updatePaymentOption(tx: Tx, actor: Actor, input: UpdatePaymentOptionInput): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  const before = await loadLocked(tx, actor, input.paymentOptionId);
  const name = input.name === undefined ? before.name : cleanName(input.name);
  const kind = input.kind === undefined ? before.kind : cleanKind(input.kind);
  if (name === before.name && kind === before.kind) return;
  if (kind !== before.kind) {
    const used = await posV1Repo.countTendersOfOption(tx, actor.orgId, before.id);
    if (used.total > 0) {
      throw refuse(`payment options: ${before.id} kind change while used`, `${before.name} is used by a store, so it cannot change between cash and wallet.`);
    }
  }
  await assertFree(tx, actor.orgId, name, before.id);
  try {
    await posV1Repo.updatePaymentOptionRow(tx, actor.orgId, before.id, { name, kind });
  } catch (err) {
    translate(err, name);
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'payment_option.updated',
    storeId: null,
    entityId: before.id,
    before: { name: before.name, kind: before.kind },
    after: { name, kind },
    source: 'web',
  });
}

/** Retire is refused while any store has the option switched on; reactivating needs nothing. */
export async function setPaymentOptionStatus(tx: Tx, actor: Actor, input: { paymentOptionId: string; status: PaymentOptionStatus }): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  if (!(PAYMENT_OPTION_STATUSES as readonly unknown[]).includes(input.status)) throw refuse(`payment options: unknown status ${String(input.status)}`, 'Choose active or retired.');
  const before = await loadLocked(tx, actor, input.paymentOptionId);
  if (before.status === input.status) return;
  if (input.status === 'retired') {
    const used = await posV1Repo.countTendersOfOption(tx, actor.orgId, before.id);
    if (used.active > 0) {
      throw refuse(
        `payment options: ${before.id} retire while on at ${used.active} store(s)`,
        `${before.name} is switched on at ${used.active} ${used.active === 1 ? 'store' : 'stores'}. Switch it off there first, then retire it.`,
      );
    }
  }
  await posV1Repo.updatePaymentOptionRow(tx, actor.orgId, before.id, { status: input.status });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: input.status === 'retired' ? 'payment_option.retired' : 'payment_option.reactivated',
    storeId: null,
    entityId: before.id,
    before: { status: before.status },
    after: { status: input.status },
    source: 'web',
  });
}

/**
 * The company-wide report hook (T-629): amounts by tender line grouped by PAYMENT OPTION, so "GCash" at three stores is one figure. Pure: it sums whatever tender lines a
 * reading, a day close or a sales day already lists (each carries `paymentOptionId`), in the order the options first appear.
 */
export function groupByPaymentOption<L extends { readonly paymentOptionId: string; readonly amount: Money }>(lines: readonly L[]): { paymentOptionId: string; amount: Money }[] {
  const cents = new Map<string, bigint>();
  for (const l of lines) cents.set(l.paymentOptionId, (cents.get(l.paymentOptionId) ?? 0n) + toCentavos(l.amount));
  return [...cents.entries()].map(([paymentOptionId, c]) => ({ paymentOptionId, amount: fromCentavos(c) }));
}

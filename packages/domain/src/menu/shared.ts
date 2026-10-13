/**
 * T-401 S2 - what every menu write shares: the transaction, the audit row, the money and quantity parsers, and the
 * "is this instant allowed for a history row" checks. docs/tasks/401-erp-menu-catalog-master.md section 3.
 *
 * Money arrives as a STRING (bible section 6) and is parsed through `@shareat/core/money` before it can reach a numeric
 * cast: `numeric(14,2)` silently rounds `'10.005'`, so more than two decimals is refused here, never rounded (I13b).
 */
import type { Actor } from '@shareat/auth';
import { auditLogRepo, menuRepo, transaction, type Tx } from '@shareat/db';
import { parseDecimalInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

/** Runs `run` on the caller's transaction, or opens one. Every menu function ends here, so the write and its audit row share it. */
export async function inTx<T>(tx: Tx | undefined, run: (trx: Tx) => Promise<T>): Promise<T> {
  return tx ? run(tx) : transaction(run);
}

/** Exactly one audit row per write, in the write's own transaction. `before`/`after` are the rows as stored. */
export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, { actorPersonId: actor.personId, action, entity, entityId, before, after, source: 'web' });
}

/** A required, trimmed, non-blank name. */
export function requireName(raw: unknown, rawLabel: string, humanLabel: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw refuse(`${rawLabel}: a name is required.`, `${humanLabel} needs a name.`);
  return name;
}

/**
 * A money amount: text only, at most two decimals, finite. `signed` is for option deltas ("no rice, -10" is real, R4);
 * an offer amount is never negative. A JavaScript number is refused outright: `0.1 + 0.2` is not money.
 */
export function parseMenuAmount(raw: unknown, rawLabel: string, humanLabel: string, signed: boolean): string {
  if (typeof raw !== 'string') {
    throw refuse(
      `${rawLabel} - the amount must be text with at most two decimal places, not a number.`,
      `${humanLabel} - enter it as an amount with at most two decimal places.`,
    );
  }
  const value = parseDecimalInput(raw, '14,2', rawLabel, humanLabel);
  if (!signed && value.startsWith('-')) {
    throw refuse(`${rawLabel} - "${raw}" is negative; an amount cannot be below zero.`, `${humanLabel} - can't be below zero.`);
  }
  return value;
}

/** A depletion quantity: `numeric(14,6)`, text only, more than six decimals refused, strictly above zero. */
export function parseMenuQuantity(raw: unknown, rawLabel: string, humanLabel: string): string {
  if (typeof raw !== 'string') {
    throw refuse(
      `${rawLabel} - the quantity must be text with at most six decimal places, not a number.`,
      `${humanLabel} - enter it as a quantity with at most six decimal places.`,
    );
  }
  const value = parseDecimalInput(raw, '14,6', rawLabel, humanLabel);
  if (value.startsWith('-') || /^0(\.0+)?$/.test(value)) {
    throw refuse(`${rawLabel} - "${raw}" must be above zero.`, `${humanLabel} - must be above zero.`);
  }
  return value;
}

function requireValidDate(at: Date, rawLabel: string): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw refuse(`${rawLabel}: effectiveFrom is not a valid date and time.`, 'That date and time is not valid.');
  }
}

/**
 * A history row (offer, option offer, depletion rule) is never back-dated: the past is not rewritten, not even by an import.
 * `effectiveFrom` omitted means "from now" and is the database's clock (the trigger refuses anything before `now()`); this
 * only turns the trigger's refusal into a sentence. The trigger stays the authority.
 */
export async function requireNotBackdated(tx: Tx, at: Date | undefined, rawLabel: string, what: string): Promise<void> {
  if (at === undefined) return;
  requireValidDate(at, rawLabel);
  if (at.getTime() < (await menuRepo.dbNow(tx)).getTime()) {
    throw refuse(
      `${rawLabel}: effectiveFrom ${at.toISOString()} is in the past; ${what} are never back-dated.`,
      `That date and time has already passed. ${what[0]!.toUpperCase()}${what.slice(1)} take effect from now or later - the past is never rewritten.`,
    );
  }
}

/** A scheduled row may be cancelled; one already in effect is history and never goes. The trigger enforces it too. */
export async function requireScheduled(tx: Tx, effectiveFrom: Date, rawLabel: string, what: string): Promise<void> {
  if (effectiveFrom.getTime() <= (await menuRepo.dbNow(tx)).getTime()) {
    throw refuse(
      `${rawLabel}: the row took effect at ${effectiveFrom.toISOString()}; only a scheduled change can be cancelled.`,
      `That ${what} has already taken effect, so it can't be cancelled. Set a new one instead.`,
    );
  }
}

/** The fields of `input` that are present and differ from `row`: an edit that changes nothing writes nothing and audits nothing. */
export function changedFields<R extends object, K extends keyof R & string>(
  row: R,
  input: { [P in K]?: R[P] },
  keys: readonly K[],
): { [P in K]?: R[P] } {
  const out: { [P in K]?: R[P] } = {};
  for (const k of keys) {
    const v = input[k];
    if (v !== undefined && v !== row[k]) out[k] = v;
  }
  return out;
}

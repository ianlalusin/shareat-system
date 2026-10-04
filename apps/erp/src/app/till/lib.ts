/**
 * Server-only helpers for `/till`. T-186.
 *
 * ⭐ **The variance is DERIVED on read**, always — `counted − expected`. What is *stored* is
 * `expected` itself, and that inversion is deliberate: a count is an observation of a moment, and
 * a backdated entry must never move a figure somebody was already charged for.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { sql } from 'drizzle-orm';
import { tillShiftsRepo, type TillCountRow, type TillShiftRow } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';
export type { TillCountRow, TillShiftRow };

export interface ShiftView {
  shift: TillShiftRow;
  counts: TillCountRow[];
}

/** The moment a shift still needs counted, or `null` when both counts are complete. */
export function nextMomentFor(
  counts: TillCountRow[],
  accounts: { id: string }[],
): 'open' | 'close' | null {
  const at = (m: 'open' | 'close') =>
    new Set(counts.filter((c) => c.moment === m).map((c) => c.moneyAccountId));
  if (at('open').size === 0) return 'open';
  const closed = at('close');
  // ⚠️ Every pocket counted IN must be counted OUT — the same rule `closeTillShift`
  // enforces. Offering the form once that is satisfied invites a duplicate the database refuses.
  const owed = [...at('open')].filter((id) => !closed.has(id));
  return owed.length > 0 ? 'close' : null;
}

/** The store's open shift plus its recent closed ones, each with its counts. */
export async function tillOverview(
  orgId: string,
  storeId: string,
  limit = 8,
): Promise<{
  open: ShiftView | null;
  recent: ShiftView[];
  accounts: Awaited<ReturnType<typeof tillShiftsRepo.countableAccounts>>;
  /** Count lines whose shortage is already posted against a person. */
  chargedLineIds: ReadonlySet<string>;
}> {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await tillShiftsRepo.countableAccounts(tx, orgId, storeId);
    // ⭐ A charge leaves no flag on the count line — the ledger entry IS the record. Read it
    // back rather than storing a `charged` boolean that could disagree with the books.
    const chargedRows = (await tx.execute(sql`
      select source_id from journal_entries
      where org_id = ${orgId} and source_type = 'tillcountshortage' and status <> 'draft'
    `)) as unknown as { source_id: string }[];
    const chargedLineIds = new Set(chargedRows.map((r) => String(r.source_id)));
    const shifts = await tillShiftsRepo.listShifts(tx, orgId, { storeId });

    const withCounts = await Promise.all(
      shifts.slice(0, limit + 1).map(async (shift) => ({
        shift,
        counts: await tillShiftsRepo.countsFor(tx, shift.id),
      })),
    );

    const open = withCounts.find((v) => v.shift.status === 'open') ?? null;
    const recent = withCounts.filter((v) => v.shift.status !== 'open').slice(0, limit);
    return { open, recent, accounts, chargedLineIds };
  });
}

/** Today, as a `YYYY-MM-DD` string. ⚠️ The trading date, which the user may override. */
export function today(now = new Date()): string {
  return toBusinessDate(now);
}

/**
 * ⭐ The counted variance, as a signed number.
 *
 * ⚠️ **Negative is SHORT.** Callers must format `Math.abs(...)` and say the direction in words —
 * `peso(-500)` renders `₱-500.00`, a bug this codebase has shipped three times.
 */
export function varianceOf(c: { counted: string; expected: string }): number {
  return Number(c.counted) - Number(c.expected);
}

/**
 * ⛔ Only the CLOSING count is chargeable, and only if it has not been charged already.
 *
 * ⚠️ The second condition is not cosmetic. `chargeTillShortage` is idempotent on the count
 * line, so a second charge posts nothing — but a form still offering to charge a settled
 * shortage tells a manager the debt is outstanding when it is already on the books against a
 * named person. An opening variance is the PREVIOUS shift's problem and is never offered here.
 */
export function chargeableShortages(
  counts: TillCountRow[],
  chargedLineIds: ReadonlySet<string>,
): TillCountRow[] {
  return counts.filter(
    (c) => c.moment === 'close' && varianceOf(c) < 0 && !chargedLineIds.has(c.id),
  );
}

/**
 * The sentence shown beside a count.
 *
 * ⚠️ This wording is the guard T-153 §13.4 asked for: a COUNTED variance and a LEDGER variance
 * look identical as a number and mean opposite things, so this one says **counted** and says who
 * answers for it. Never soften it into "off by".
 */
export function varianceSentence(v: number, peso: (n: number) => string): string {
  if (v === 0) return 'Counted exactly what the ledger says.';
  return v < 0
    ? `${peso(Math.abs(v))} SHORT on the physical count — chargeable to the cashier who held it.`
    : `${peso(v)} OVER on the physical count — the tip box. ⛔ Posts nothing at all.`;
}

/**
 * setPlatformSales - the typed, separate, removable seam for platform sales (Foodpanda and the like) on a FEED day.
 * `docs/tasks/375-pos-v1-day-feed.md` R8 (q1 (b)), S4.
 *
 * A feed day's own figures are what POS said and are never typed. Platform orders are rung outside POS, so they are
 * the one thing a person types on a feed day: a `sales_day_channels` row per NON-remitted channel, which T-150's
 * settlement queue already reads. They are composed into the day at routing time only (`compose.ts`), never written
 * into the day's figures.
 *
 * ## Removing it (when Ian rings platforms through POS)
 * Delete this file, the day page's "Platform sales" section and its action, and the platform lines in `compose.ts`;
 * the 0185 channel trigger's non-remitted branch then becomes "needs the flag".
 *
 * Authorization is `editSalesDay`'s: `submit_sales_day` while the day is open, `verify_sales_day` once submitted (and
 * `submit_sales_day` for the status sentence on a closed day). `authorize()` comes first (I1).
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, salesDaysRepo, transaction, type Tx } from '@shareat/db';
import { compare, ZERO, isZero, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { gone, refuse } from '../shared/refusal';

export interface SetPlatformSalesInput {
  salesDayId: string;
  /** `amount` is the raw text typed (blank = none); parsed in words AFTER authorize() (T-371 R5). */
  rows: { channelId: string; amount: string; noSales: boolean }[];
}

export async function setPlatformSales(tx: Tx | null, actor: Actor, input: SetPlatformSalesInput): Promise<{ id: string }> {
  if (tx) return run(tx, actor, input);
  return transaction((trx) => run(trx, actor, input));
}

async function run(tx: Tx, actor: Actor, input: SetPlatformSalesInput): Promise<{ id: string }> {
  // The row lock first (as edit and verify do), so this and a verify of the day cannot interleave.
  const day = await salesDaysRepo.getByIdForUpdate(tx, actor.orgId, input.salesDayId);
  if (!day) throw gone(`setPlatformSales: sales day ${input.salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, day.status === 'submitted' ? 'verify_sales_day' : 'submit_sales_day', { storeId: day.storeId });

  if (day.status !== 'open' && day.status !== 'submitted') {
    throw refuse(
      `setPlatformSales: sales day ${day.id} is ${day.status}`,
      'Platform sales can only be changed before the day is verified.',
    );
  }
  if (day.source !== 'pos_v1_day_feed') {
    throw refuse(
      `setPlatformSales: sales day ${day.id} is a typed day`,
      "This day's figures were typed in, so its platform sales are entered with them. Edit the day instead.",
    );
  }

  // Validate every row before anything is written.
  const configured = await salesDaysRepo.listChannels(tx, actor.orgId, day.storeId);
  const byId = new Map(configured.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rows = input.rows.map((r) => {
    const cfg = byId.get(r.channelId);
    if (!cfg) {
      throw refuse(
        `setPlatformSales: channel ${r.channelId} is not configured for store ${day.storeId}`,
        "One of the sales channels on this day isn't set up for this store. Reload the page and try again.",
      );
    }
    if (cfg.isRemittedDaily) {
      throw refuse(
        `setPlatformSales: channel "${cfg.name}" is remitted daily`,
        `${cfg.name} is paid at the till, so its sales come from POS, not from here.`,
      );
    }
    if (seen.has(r.channelId)) {
      throw refuse(`setPlatformSales: "${cfg.name}" appears twice`, `"${cfg.name}" appears twice. One row per channel.`);
    }
    seen.add(r.channelId);
    const raw = r.amount.trim();
    const amount: Money = r.noSales || raw === '' ? ZERO : parseMoneyInput(raw, `setPlatformSales: "${cfg.name}"'s amount`, `The amount for "${cfg.name}"`);
    if (compare(amount, ZERO) < 0) {
      throw refuse(
        `setPlatformSales: "${cfg.name}" carries ${amount}`,
        `The amount for "${cfg.name}" can't be negative. Leave it blank if there were no sales.`,
      );
    }
    if (r.noSales && !isZero(amount)) {
      throw refuse(
        `setPlatformSales: "${cfg.name}" is marked "no sales" but carries ${amount}`,
        `"${cfg.name}" is marked "no sales" but carries ${amount} — a confirmed zero and an amount are different claims.`,
      );
    }
    return { channelId: r.channelId, amount, noSales: r.noSales };
  });

  const ids = rows.map((r) => r.channelId);
  const before = await salesDaysRepo.getChannelRowsFor(tx, day.id, ids);
  await salesDaysRepo.replacePlatformChannelRows(tx, day.id, rows);
  const after = await salesDaysRepo.getChannelRowsFor(tx, day.id, ids);

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'set_platform_sales',
    storeId: day.storeId,
    entityId: day.id,
    before: { platformRows: before },
    after: { platformRows: after },
    source: 'web',
  });
  return { id: day.id };
}

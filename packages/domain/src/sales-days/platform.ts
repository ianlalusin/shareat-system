/**
 * Platform sales - the typed, removable seam for platform sales (Foodpanda and the like) on a FEED day.
 * `docs/tasks/375-pos-v1-day-feed.md` R8 (q1 (b)), S4; T-504 (one Save).
 *
 * A feed day's own figures are what POS said and are never typed. Platform orders are rung outside POS, so they are the one
 * thing a person types on a feed day: a `sales_day_channels` row per NON-remitted channel, which T-150's settlement queue
 * already reads. They are composed into the day at routing time only (`compose.ts`), never written into the day's figures.
 *
 * T-504: the day page has ONE Save. `editSalesDay` (edit.ts) carries these rows as `platform` and writes them here, in the same
 * transaction as anything else the edit carries. This file is its body: the caller has locked the day and authorized, so this
 * file never authorizes. Every row is validated before anything is written, so a refused row leaves the others unwritten.
 * (The separate `setPlatformSales` entry point and its Save button were retired - ruling 3, 1 Nov 2026.)
 *
 * ## Removing it (when Ian rings platforms through POS)
 * Delete this file, the day page's "Platform sales" section and the `platform` branch of `editSalesDay`, and the platform lines
 * in `compose.ts`; the 0185 channel trigger's non-remitted branch then becomes "needs the flag".
 */
import { auditLogRepo, salesDaysRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { compare, ZERO } from '@shareat/core/money';
import { interpretChannelEntry } from './channel-entry';
import { refuse } from '../shared/refusal';

export type PlatformRowInput = { channelId: string; amount: string; noSales: boolean };

export async function writePlatformRows(
  tx: Tx,
  actor: Actor,
  day: { id: string; storeId: string; status: string; source: string },
  inputRows: PlatformRowInput[],
): Promise<void> {
  if (day.status !== 'open' && day.status !== 'submitted') {
    throw refuse(
      `setPlatformSales: sales day ${day.id} is ${day.status}`,
      'Platform sales can only be changed before the day is verified.',
    );
  }
  // T-531: a day derived from the POS receipts takes platform sales exactly as a feed day does (its own figures are never typed; platform orders are rung outside POS).
  if (day.source === 'legacy_typed') {
    throw refuse(
      `setPlatformSales: sales day ${day.id} is a typed day`,
      "This day's figures were typed in, so its platform sales are entered with them. Edit the day instead.",
    );
  }

  // Validate every row before anything is written.
  const configured = await salesDaysRepo.listChannels(tx, actor.orgId, day.storeId);
  const byId = new Map(configured.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rows = inputRows.map((r) => {
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
    // T-504: the same rule as a typed day. A blank unticked box is a draft: its row clears (zero, unticked, is dropped by the repo).
    const entry = interpretChannelEntry(cfg.name, r.amount, r.noSales, 'setPlatformSales');
    if (compare(entry.amount, ZERO) < 0) {
      throw refuse(
        `setPlatformSales: "${cfg.name}" carries ${entry.amount}`,
        `The amount for "${cfg.name}" can't be negative. Leave it blank if there were no sales.`,
      );
    }
    return { channelId: r.channelId, amount: entry.amount, noSales: entry.noSales };
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
}

/**
 * T-511 S5b - what /channel-settlements/review reads besides the day table: the stores the person may review, and the days staff recorded sales for that no file
 * covers yet, each with its blocker sentence from the domain's `dayBlockers`. Composes repo and domain calls; no SQL here.
 */
import { can, type Actor } from '@shareat/auth';
import { dayBlockers } from '@shareat/domain';
import { settlementIntakeRepo, storesRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';

/** More than this many missing days are counted, not listed, so a long gap cannot make the page slow. */
export const MISSING_DAYS_SHOWN = 40;

export interface ReviewStore {
  id: string;
  name: string;
}

/** The stores whose days this person may review: the same word the domain checks (recording a channel settlement), asked per store. */
export async function listReviewStores(actor: Actor): Promise<ReviewStore[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const out: ReviewStore[] = [];
    for (const s of await storesRepo.listForOrg(tx, actor.orgId)) if (await can(tx, actor, 'record_ar_collection', { storeId: s.id })) out.push({ id: s.id, name: s.name });
    return out;
  });
}

export interface MissingFileDay {
  storeName: string;
  channelName: string;
  salesDate: string;
  sentence: string;
}

export interface MissingFiles {
  days: MissingFileDay[];
  /** days beyond the ones listed */
  more: number;
}

/**
 * Days with recorded sales and no file, for the channels this person may REVIEW (the review right, per store: the list is part of the review screen, so it follows
 * the screen's gate, not the upload right; `dayBlockers` asks the same gate, so a store left out here is never asked about). The 40 places are shared round-robin
 * across channels, oldest first in each, so one channel with a long gap cannot hide the others. A day the domain no longer blocks (its sales were removed) is left
 * out and is not counted as "more".
 */
export async function listMissingFileDays(actor: Actor): Promise<MissingFiles> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const queues: { storeName: string; channelId: string; channelName: string; days: string[] }[] = [];
    for (const c of await settlementIntakeRepo.listPlatformChannels(tx, actor.orgId)) {
      if (!(await can(tx, actor, 'record_ar_collection', { storeId: c.storeId }))) continue;
      const days = await settlementIntakeRepo.daysWithRecordedSalesAndNoLine(tx, actor.orgId, c.id);
      if (days.length > 0) queues.push({ storeName: c.storeName, channelId: c.id, channelName: c.name, days });
    }
    const total = queues.reduce((n, q) => n + q.days.length, 0);
    const shown: { queue: number; day: MissingFileDay }[] = [];
    let skipped = 0;
    for (let round = 0; shown.length < MISSING_DAYS_SHOWN; round++) {
      let reached = false;
      for (const [queue, q] of queues.entries()) {
        const salesDate = q.days[round];
        if (salesDate === undefined || shown.length >= MISSING_DAYS_SHOWN) continue;
        reached = true;
        const first = (await dayBlockers(tx, actor, { channelId: q.channelId, salesDate })).blockers[0];
        if (first) shown.push({ queue, day: { storeName: q.storeName, channelName: q.channelName, salesDate, sentence: first.sentence } });
        else skipped++;
      }
      if (!reached) break;
    }
    // channel by channel, oldest first, however the places were handed out
    const days = shown.sort((a, b) => a.queue - b.queue || a.day.salesDate.localeCompare(b.day.salesDate)).map((s) => s.day);
    return { days, more: Math.max(0, total - days.length - skipped) };
  });
}

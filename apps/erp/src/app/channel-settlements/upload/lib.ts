/**
 * T-511 S4 - what /channel-settlements/upload shows besides the drop zone: for each Grab or Foodpanda channel the person may upload for,
 * the verified sales days that have sales and no staged line yet (the days still waiting for a file). Composes repo calls; no SQL here.
 */
import { can, type Actor } from '@shareat/auth';
import { settlementIntakeRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';

export interface WaitingForFile {
  channelId: string;
  storeName: string;
  channelName: string;
  /** ascending YYYY-MM-DD */
  days: string[];
}

export async function listWaitingForFile(actor: Actor): Promise<WaitingForFile[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const out: WaitingForFile[] = [];
    for (const c of await settlementIntakeRepo.listPlatformChannels(tx, actor.orgId)) {
      // presentation only: the upload itself is gated again, at the matched store, by the domain
      if (!(await can(tx, actor, 'upload_settlement_files', { storeId: c.storeId }))) continue;
      const days = await settlementIntakeRepo.daysWithRecordedSalesAndNoLine(tx, actor.orgId, c.id);
      if (days.length > 0) out.push({ channelId: c.id, storeName: c.storeName, channelName: c.name, days });
    }
    return out;
  });
}

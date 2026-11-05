/**
 * T-511 S4 - which channel does the code in a settlement file belong to? The Foodpanda vendor code or the Grab Store ID is looked up on
 * `sales_channels.platform_store_code` (S2: unique per org and platform, compared ignoring case and spaces). Knows nothing about who is
 * uploading: whether that person may upload for the matched store is the ingest's gate, asked AFTER this (BOSS 4 Nov).
 *
 * A refusal names what the person typed or can act on: the Foodpanda vendor code, never a Grab Store ID (a UUID; `refuse()` would print
 * it as `[hidden]`, so the Grab sentences do not try).
 */
import { settlementIntakeRepo, type Tx } from '@shareat/db';
import { intakeRefusal, shown } from './refusal';

export type SettlementPlatform = 'grab' | 'foodpanda';

export interface MatchedChannel {
  channelId: string;
  channelName: string;
  storeId: string;
  storeName: string;
  platform: SettlementPlatform;
  /** the code as the file carried it, trimmed */
  code: string;
  /** an inactive channel is still returned: the ingest asks the store gate first, then `refuseIfInactive` (audit fix 4, 4 Nov) */
  isActive: boolean;
}

export async function matchChannel(tx: Tx, orgId: string, platform: SettlementPlatform, code: string): Promise<MatchedChannel> {
  const typed = code.trim();
  const grab = platform === 'grab';
  if (typed === '') {
    throw intakeRefusal('CHANNEL_NOT_SET_UP', grab ? 'The file has no Grab Store ID in it, so its store cannot be found.' : 'The file has no Foodpanda vendor code in it, so its store cannot be found.');
  }
  const found = await settlementIntakeRepo.channelByPlatformCode(tx, orgId, platform, typed);
  if (!found) {
    throw intakeRefusal(
      'CHANNEL_NOT_SET_UP',
      grab
        ? 'This Grab store is not set up. Ask an admin to enter its Grab store code on the channel.'
        : `The Foodpanda vendor code "${shown(typed)}" is not set up on any channel. Ask an admin to enter it on the store's Foodpanda channel.`,
    );
  }
  return { channelId: found.id, channelName: found.name, storeId: found.storeId, storeName: found.storeName, platform, code: typed, isActive: found.isActive };
}

/**
 * The inactive sentence names a channel that exists, so it is for someone who may see that channel's store: the ingest calls this AFTER the
 * store gate, never before (a manager of another store gets only the generic sentence). A code that matches no channel at all is refused
 * inside `matchChannel`, as before: that sentence reveals nothing about any store.
 */
export function refuseIfInactive(matched: MatchedChannel): void {
  if (matched.isActive) return;
  throw intakeRefusal(
    'CHANNEL_NOT_SET_UP',
    matched.platform === 'grab'
      ? "This Grab store's channel is inactive, so the file cannot be added. Ask an admin to switch the channel back on."
      : `The channel for Foodpanda vendor code "${shown(matched.code)}" is inactive, so the file cannot be added. Ask an admin to switch the channel back on.`,
  );
}

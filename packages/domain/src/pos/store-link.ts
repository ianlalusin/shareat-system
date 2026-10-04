/**
 * T-375 S1 (R7, R13, W6, W7) - linking a v2 store to its POS v1 store. `docs/tasks/375-pos-v1-day-feed.md` S1.
 *
 * A store's link row IS its switch (I10): linked, its sales days are imported from POS and never typed; unlinked,
 * it keeps today's typed path. Linking is therefore the go-live act for a store, done by an admin, store by store.
 *
 * Capability: `manage_chart_of_accounts` (admin, super admin). The mapping decides where money is booked and whose
 * custody it is, so a manager, whose custody is measured, does not set it (R7; the `set_cash_policy` reasoning).
 * `authorize()` comes FIRST (I1): a manager who names a wrong channel is told she may not, not told about the channel.
 *
 * ## Order
 * authorize -> the store row `FOR UPDATE` (R13) -> the channel and POS-store rules -> the unverified-typed-day rule
 * -> write -> audit `link_store_to_pos`.
 *
 * The store lock is what makes a typed `createSalesDay` and a link of the same store serialize (W7): the create holds
 * the store `FOR KEY SHARE` (S3), `FOR UPDATE` conflicts with it, so either the typed day commits first and the link
 * then refuses it, or the link commits first and the typed create refuses.
 *
 * Relinking updates the POS id, name, channel and tax type, never `store_id`.
 */
import { auditLogRepo, posV1Repo, salesDaysRepo, type Tx } from '@shareat/db';
import { POS_V1_TAX_TYPES, type PosV1TaxType } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import type { BusinessDate } from '@shareat/core/datetime';
import { gone, humanDate, refuse } from '../shared/refusal';

const CAPABILITY = 'manage_chart_of_accounts' as const;

export interface LinkStoreToPosInput {
  readonly storeId: string;
  /** POS's own store id (the bridge's `storeId`), never the v2 store id. */
  readonly posStoreId: string;
  readonly posStoreName: string;
  /** The v2 channel POS's sales land in: this store's, remitted daily, active. */
  readonly salesChannelId: string;
  readonly posTaxType: PosV1TaxType;
}

export async function linkStoreToPos(tx: Tx, actor: Actor, input: LinkStoreToPosInput): Promise<{ linkId: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const posStoreId = input.posStoreId.trim();
  const posStoreName = input.posStoreName.trim();
  if (!posStoreId) throw refuse('linkStoreToPos: posStoreId is blank', 'Choose or enter the POS store this store sells under.');
  if (!posStoreName) throw refuse('linkStoreToPos: posStoreName is blank', 'Give the POS store a name so people can recognise it.');
  if (!(POS_V1_TAX_TYPES as readonly string[]).includes(input.posTaxType)) {
    throw refuse(`linkStoreToPos: unknown tax type ${String(input.posTaxType)}`, "Choose the tax type shown in the POS store's settings.");
  }

  // R13: the store row, FOR UPDATE, before anything else is read.
  const store = await posV1Repo.lockStoreForUpdate(tx, actor.orgId, input.storeId);
  if (!store) throw gone(`linkStoreToPos: store ${input.storeId} not in org`, 'store');

  // Then the channel row (consistent order: store, channel), so a concurrent channel edit cannot flip it between
  // the checks below and the write.
  await posV1Repo.lockChannelForUpdate(tx, actor.orgId, input.salesChannelId);
  const channel = await salesDaysRepo.channelById(tx, actor.orgId, input.salesChannelId);
  if (!channel) throw gone(`linkStoreToPos: channel ${input.salesChannelId} not in org`, 'sales channel');
  if (channel.storeId !== input.storeId) {
    throw refuse('linkStoreToPos: channel belongs to another store', 'That sales channel belongs to a different store.');
  }
  if (!channel.isRemittedDaily) {
    throw refuse(
      'linkStoreToPos: channel is not remitted daily',
      "POS's sales are paid at the till, so they need a channel whose money is remitted daily.",
    );
  }
  if (!channel.isActive) {
    throw refuse('linkStoreToPos: channel is retired', 'That sales channel is retired. Choose one that is active.');
  }

  const elsewhere = await posV1Repo.getLinkByPosStoreId(tx, actor.orgId, posStoreId);
  if (elsewhere && elsewhere.storeId !== input.storeId) {
    throw refuse(
      `linkStoreToPos: pos store ${posStoreId} already linked to store ${elsewhere.storeId}`,
      `That POS store is already linked to ${elsewhere.storeName}.`,
    );
  }

  // W6: no typed day may be left half-way on a linked store.
  const typed = await posV1Repo.unverifiedTypedDates(tx, actor.orgId, input.storeId);
  if (typed.length > 0) {
    const dates = typed.map((d) => humanDate(d as BusinessDate)).join(', ');
    throw refuse(
      `linkStoreToPos: ${typed.length} unverified typed sales day(s) on store ${input.storeId}`,
      `${store.name} still has typed sales days that aren't verified (${dates}). Verify or withdraw them before linking it to POS.`,
    );
  }

  const before = await posV1Repo.getLinkByStoreForUpdate(tx, actor.orgId, input.storeId);
  let linkId: string;
  try {
  if (before) {
    await posV1Repo.updateLink(tx, actor.orgId, input.storeId, {
      posStoreId,
      posStoreName,
      salesChannelId: input.salesChannelId,
      posTaxType: input.posTaxType,
      updatedBy: actor.personId,
    });
    linkId = before.id;
  } else {
    ({ id: linkId } = await posV1Repo.insertLink(tx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      posStoreId,
      posStoreName,
      salesChannelId: input.salesChannelId,
      posTaxType: input.posTaxType,
      createdBy: actor.personId,
    }));
  }
  } catch (err) {
    // POS ids are linked by ONE org globally. RLS hides another org's link from the pre-read above, so the unique
    // index is the only thing that can see it (and the only thing that catches a race). The sentence names no org
    // and no store.
    if (isPosStoreIdTaken(err)) {
      throw refuse(`linkStoreToPos: pos store ${posStoreId} is already linked`, 'That POS store is already linked to another store.');
    }
    throw err;
  }

  // `source: 'web'`: the admin screen is this function's only caller today; a second front-end must pass its own.
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'link_store_to_pos',
    entity: 'pos_v1_store_links',
    entityId: linkId,
    before: before
      ? { posStoreId: before.posStoreId, posStoreName: before.posStoreName, salesChannelId: before.salesChannelId, posTaxType: before.posTaxType }
      : null,
    after: { storeId: input.storeId, posStoreId, posStoreName, salesChannelId: input.salesChannelId, posTaxType: input.posTaxType },
    source: 'web',
  });

  return { linkId };
}

function isPosStoreIdTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'pos_v1_store_links_pos_store_id_unique') return true;
  }
  return false;
}

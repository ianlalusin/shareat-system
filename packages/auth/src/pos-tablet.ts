/**
 * T-464 - pairing a store's POS tablet and un-pairing it. docs/tasks/464-pos-tablet-sign-in.md s2.
 *
 * The ONLY writer of `pos_tablet_pairings`. `authorize()` comes FIRST in both (I1): capability `pair_pos_tablet`, store-scoped
 * (manager of THAT store, admin, super_admin). The pre-sign-in read of a pairing lives in `sessions.ts` (`resolvePosTablet`): the auth
 * door's closed caller list is that one file.
 *
 * pair: authorize -> the store row FOR UPDATE -> revoke the store's live pairing and end its sessions (ONE live pairing per store) ->
 *       insert the new row (only the keyed hash of the 32 random bytes is stored) -> audit `pos_tablet.paired`.
 *       The caller sets the cookie with the returned `token` (shown once, never stored) and ends the manager's own session.
 * unpair: the row FOR UPDATE -> authorize at the ROW's store -> the tier-1 confirm (retype the label) -> revoke + end sessions -> audit `pos_tablet.unpaired`.
 */
import { auditLogRepo, posTabletPairingsRepo, posV1Repo, refuse, type Tx } from '@shareat/db';
import { authorize, type Actor } from './authorize';
import { newSessionToken, posTabletTokenHash } from './credentials';
import { endAllForDevice } from './sessions';

/** The httpOnly cookie that holds a paired tablet's secret. The name is public; the value is 32 random bytes. */
export const POS_TABLET_COOKIE = 'shareat_pos_tablet';

const CAPABILITY = 'pair_pos_tablet' as const;
const LABEL_MAX = 60;

const GONE = 'That tablet is not paired any more.';

const fold = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
/** Mirrors apps/erp `retypeMatches` (T-412): an empty value never matches. */
const labelsMatch = (typed: string, label: string): boolean => fold(typed) !== '' && fold(typed) === fold(label);

export async function pairPosTablet(
  tx: Tx,
  actor: Actor,
  /** `previousToken`: this browser's current pairing cookie, if any. Pairing it to another store gives that old pairing up (audit finding 4). */
  input: { storeId: string; label: string; previousToken?: string | null },
): Promise<{ pairingId: string; token: string; replaced: { id: string; label: string } | null; storeName: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  const label = input.label.trim().replace(/\s+/g, ' ');
  if (label.length === 0 || label.length > LABEL_MAX) {
    throw refuse('pairPosTablet: label empty or too long', `Give the tablet a name of 1 to ${LABEL_MAX} characters, like "Lipa counter".`);
  }

  const store = await posV1Repo.lockStoreForUpdate(tx, actor.orgId, input.storeId);
  if (!store) throw refuse(`pairPosTablet: store ${input.storeId} not in org`, 'That store was not found.');

  const previous = await posTabletPairingsRepo.getLiveForStoreForUpdate(tx, actor.orgId, input.storeId);
  if (previous) {
    await posTabletPairingsRepo.revoke(tx, actor.orgId, previous.id, actor.personId, 'replaced by a new tablet');
    // The old tablet's live sessions end now (deviceId = the pairing id; the org is passed because a pairing is not a persons row).
    await endAllForDevice(tx, { deviceId: previous.id, actorPersonId: actor.personId, orgId: actor.orgId });
  }

  // ⭐ This browser was already another store's tablet: holding its cookie is what proves the right to give it up, so no second
  // capability check. Left alone it would stay live with no device behind it until the 30-day idle rule.
  const held = input.previousToken ? await posTabletPairingsRepo.findLiveByTokenHash(tx, posTabletTokenHash(input.previousToken)) : undefined;
  if (held && held.orgId === actor.orgId && held.id !== previous?.id) {
    await posTabletPairingsRepo.revoke(tx, actor.orgId, held.id, actor.personId, 'this browser was paired to another store');
    await endAllForDevice(tx, { deviceId: held.id, actorPersonId: actor.personId, orgId: actor.orgId });
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'pos_tablet.unpaired',
      storeId: held.storeId,
      entityId: held.id,
      before: { pairingId: held.id, label: held.label },
      after: { revoked: true, reason: 'this browser was paired to another store' },
      source: 'web',
    });
  }

  const token = newSessionToken();
  const { id } = await posTabletPairingsRepo.insertPairing(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    label,
    tokenHash: posTabletTokenHash(token),
    pairedBy: actor.personId,
  });

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos_tablet.paired',
    storeId: input.storeId,
    entityId: id,
    before: previous ? { pairingId: previous.id, label: previous.label } : null,
    after: { pairingId: id, label, storeId: input.storeId },
    source: 'web',
  });

  return { pairingId: id, token, replaced: previous ?? null, storeName: store.name };
}

export async function unpairPosTablet(
  tx: Tx,
  actor: Actor,
  input: { pairingId: string; confirmLabel: string },
): Promise<{ pairingId: string; label: string; sessionsEnded: number }> {
  const row = await posTabletPairingsRepo.getByIdForUpdate(tx, actor.orgId, input.pairingId);
  if (!row) throw refuse(`unpairPosTablet: pairing ${input.pairingId} not in org`, GONE);
  await authorize(tx, actor, CAPABILITY, { storeId: row.storeId });
  if (row.revokedAt) throw refuse(`unpairPosTablet: pairing ${row.id} already revoked`, GONE);

  // Row 329 tier-1 confirm: the label is typed back, compared by the SAME rule as the page's `retypeMatches` (NFC, trim, collapsed spaces, case-folded).
  if (!labelsMatch(input.confirmLabel, row.label)) {
    throw refuse('unpairPosTablet: confirm label does not match', `Type the tablet's name exactly as shown ("${row.label}") to un-pair it.`);
  }

  await posTabletPairingsRepo.revoke(tx, actor.orgId, row.id, actor.personId, 'un-paired by a manager');
  const { ended } = await endAllForDevice(tx, { deviceId: row.id, actorPersonId: actor.personId, orgId: actor.orgId });

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos_tablet.unpaired',
    storeId: row.storeId,
    entityId: row.id,
    before: { label: row.label, storeId: row.storeId },
    after: { revoked: true, sessionsEnded: ended },
    source: 'web',
  });
  return { pairingId: row.id, label: row.label, sessionsEnded: ended };
}

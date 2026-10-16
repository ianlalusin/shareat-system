/**
 * T-424 S5 - registering a POS v2 tablet as an ERP terminal person: `pos_terminal_links` (migration 0202).
 * docs/tasks/424-pos-v2-server-approvals.md Ruling 5 (B1 fix).
 *
 * The ONLY writer of the table. A tablet or a request can never create a link: the POS v2 server resolves (POS store, device id) to the
 * terminal person whose PIN bucket an approval charges FROM THIS TABLE (`resolvePosTerminalLink` in @shareat/auth), never from Firestore.
 *
 * Capability: the EXISTING `provision_clock_terminal` (admin, super admin; manager NO) at the store. A link decides which person's bucket
 * a manager PIN is charged to, so whoever may register a clock tablet may register this one; the same narrowness is the safety argument.
 * `authorize()` comes FIRST (I1).
 *
 * Order: authorize -> checks -> the store row FOR UPDATE -> revoke the store's previous active link (ADR-015 A3: one tablet per store; a
 * reinstall makes a new device id) -> insert -> audit `pos_terminal_link.provision`.
 */
import { accessRepo, auditLogRepo, posTerminalLinksRepo, posV1Repo, type Tx } from '@shareat/db';
import { authorize, isPosDeviceId, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';

const CAPABILITY = 'provision_clock_terminal' as const;

export interface ProvisionPosTerminalLinkInput {
  /** The ERP store. */
  readonly storeId: string;
  readonly terminalNo: number;
  /** The tablet's install id, as `/settings` in POS v2 shows it. */
  readonly deviceId: string;
  /** A `persons` row of kind 'terminal' credentialed to the store (`npm run provision-terminal` creates it). */
  readonly terminalPersonId: string;
}

export async function provisionPosTerminalLink(
  tx: Tx,
  actor: Actor,
  input: ProvisionPosTerminalLinkInput,
): Promise<{ linkId: string; revokedLinkId: string | null }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });

  if (!isPosDeviceId(input.deviceId)) {
    throw refuse('provisionPosTerminalLink: deviceId is not a uuid', "That device id is not valid. Copy it from the tablet's Settings page.");
  }
  const deviceId = input.deviceId.toLowerCase();
  if (!Number.isInteger(input.terminalNo) || input.terminalNo < 1) {
    throw refuse('provisionPosTerminalLink: terminalNo is not a positive whole number', 'The terminal number must be a whole number, 1 or more.');
  }

  const store = await posV1Repo.lockStoreForUpdate(tx, actor.orgId, input.storeId);
  if (!store) throw gone(`provisionPosTerminalLink: store ${input.storeId} not in org`, 'store');

  const storeLink = await posV1Repo.getLinkByStore(tx, actor.orgId, input.storeId);
  if (!storeLink) {
    throw refuse(
      `provisionPosTerminalLink: store ${input.storeId} has no live POS link`,
      `${store.name} is not linked to a POS store yet. Link it to POS first.`,
    );
  }

  const isTerminal = await accessRepo.personIsTerminal(tx, actor.orgId, input.terminalPersonId);
  const credentialed = isTerminal && (await posTerminalLinksRepo.terminalIsCredentialedToStore(tx, actor.orgId, input.terminalPersonId, input.storeId));
  if (!credentialed) {
    throw refuse(
      `provisionPosTerminalLink: person ${input.terminalPersonId} is not a terminal credentialed to store ${input.storeId}`,
      `That person is not a terminal set up for ${store.name}. Register the tablet as a terminal for this store first.`,
    );
  }

  const previous = await posTerminalLinksRepo.getActiveLinkForStoreForUpdate(tx, actor.orgId, input.storeId);
  if (previous) await posTerminalLinksRepo.revokeLink(tx, actor.orgId, previous.id, actor.personId);

  let linkId: string;
  try {
    ({ id: linkId } = await posTerminalLinksRepo.insertLink(tx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      posV1StoreLinkId: storeLink.id,
      terminalNo: input.terminalNo,
      deviceId,
      terminalPersonId: input.terminalPersonId,
      createdBy: actor.personId,
    }));
  } catch (err) {
    // The device id may be actively linked at ANOTHER store (the partial unique index on active device ids).
    if (isActiveDeviceTaken(err)) {
      throw refuse('provisionPosTerminalLink: device id is already linked', 'That tablet is already registered to a store. Revoke its link first: npm run provision-terminal -- --store=<CODE of that store> --revoke-pos-device=<device id> --admin=<admin person id> --confirm.');
    }
    throw err;
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos_terminal_link.provision',
    storeId: input.storeId,
    entityId: linkId,
    before: previous ? { linkId: previous.id, deviceId: previous.deviceId, terminalNo: previous.terminalNo } : null,
    after: { storeId: input.storeId, terminalNo: input.terminalNo, deviceId, terminalPersonId: input.terminalPersonId },
    source: 'web',
  });

  return { linkId, revokedLinkId: previous ? previous.id : null };
}

function isActiveDeviceTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'pos_terminal_links_active_device_unique') return true;
  }
  return false;
}

/**
 * T-424 audit - revoke a POS v2 tablet's link without registering a new one (a lost or retired tablet). Same capability as provisioning
 * (`provision_clock_terminal` at the link's store), audited as `pos_terminal_link.revoke`. After it the tablet's approvals say "not registered".
 */
export async function revokePosTerminalLink(tx: Tx, actor: Actor, input: { linkId: string }): Promise<{ linkId: string }> {
  const link = await posTerminalLinksRepo.getLinkByIdForUpdate(tx, actor.orgId, input.linkId);
  if (!link) throw gone(`revokePosTerminalLink: link ${input.linkId} not in org`, 'tablet link');
  await authorize(tx, actor, CAPABILITY, { storeId: link.storeId });
  if (link.revokedAt) throw refuse(`revokePosTerminalLink: link ${input.linkId} already revoked`, 'That tablet link is already revoked.');
  await posTerminalLinksRepo.revokeLink(tx, actor.orgId, link.id, actor.personId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos_terminal_link.revoke',
    storeId: link.storeId,
    entityId: link.id,
    before: { deviceId: link.deviceId, terminalNo: link.terminalNo, terminalPersonId: link.terminalPersonId },
    after: { revoked: true },
    source: 'web',
  });
  return { linkId: link.id };
}

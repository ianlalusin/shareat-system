/**
 * T-525 R7 and R8 - what the store tablet reads: the snapshot (everything it needs to sell offline, as one closed list, row 430) and the 3-second state poll.
 * docs/tasks/525-pos-v2-apis.md.
 *
 * The snapshot holds NOTHING outside the list below, and no PIN material of any kind (the tablet signs a person in with its own device-only verifier, A6).
 * The tablet fetches it at sign-in and every 5 minutes and never blanks a good snapshot on a failed fetch (A6, T-508): that rule is T-530's, stated here so
 * the route's author sees it.
 */
import { createHash } from 'node:crypto';
import { can, type Actor } from '@shareat/auth';
import { accessRepo, posV1Repo, posV2Repo, RefusalError, storesRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { canonicalJson } from '../menu/project';
import { loadStoreMenu } from '../menu/load-store-menu';
import { refuse } from '../shared/refusal';
import { POS_NOT_SWITCHED_ON, type PosPairing } from './inbox';
import { listKitchenQueue, listOpenStands, listRefillQueue } from './sale';
import { businessDateOf, readRules, requireStoreScope, type PosDeps } from './shared';

/** The POS capabilities the tablet greys its buttons by (the closed list of R7's `staff`). */
const POS_CAPABILITIES = ['record_sale', 'request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads', 'approve_pos_correction'] as const;
export const NO_TILL_NUMBER = 'This tablet has no till number yet. Ask a manager.';

export interface PosSnapshot {
  body: {
    store: { storeId: string; name: string; mode: string; terminalNo: number; vatRegistered: boolean };
    menu: Awaited<ReturnType<typeof loadStoreMenu>>;
    stands: { id: string; number: number }[];
    tenders: { id: string; name: string; kind: string }[];
    discountPresets: { id: string; name: string; valueType: string; value: string }[];
    rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number; businessDayStartHour: number; tableWarnMinutes: number };
    staff: { personId: string; displayName: string; employeeId: string; posCapabilities: string[] }[];
    device: { pairingId: string; lastSeq: number; lastTerminalSeq: number };
    businessDate: string;
  };
  /** The quoted sha256 of the canonical JSON body. */
  etag: string;
  nextChangeAt: string | null;
}

export async function buildPosSnapshot(tx: Tx, input: { pairing: PosPairing }, deps?: PosDeps): Promise<PosSnapshot> {
  const { orgId, storeId, pairingId } = input.pairing;
  const store = await posV2Repo.getPosStore(tx, orgId, storeId);
  if (!store || store.mode === 'off') throw refuse('pos: store switched off', POS_NOT_SWITCHED_ON);
  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, pairingId);
  if (!terminal) throw refuse('pos: pairing has no terminal', NO_TILL_NUMBER);
  const storeRow = await storesRepo.getById(tx, orgId, storeId);
  const menu = await loadStoreMenu(tx, orgId, storeId, undefined, { showWithdrawnStore: true }); // T-527b: a sold-out dish stays on the tablet, greyed (row 307)
  const businessDate = await businessDateOf(tx, orgId, storeId, deps);
  const rules = await readRules(tx, orgId, businessDate, deps);

  // Who may sign in at this store NOW, with the 3-digit code they type and only the POS capabilities authorize() grants them here.
  const staff: PosSnapshot['body']['staff'] = [];
  for (const c of await posV2Repo.listOpenEmploymentsAtStore(tx, orgId, storeId)) {
    if (!(await accessRepo.personMaySignInAtStore(tx, c.personId, storeId))) continue;
    const actor = { personId: c.personId, orgId };
    const posCapabilities: string[] = [];
    for (const cap of POS_CAPABILITIES) if (await can(tx, actor, cap, { storeId })) posCapabilities.push(cap);
    staff.push({ personId: c.personId, displayName: c.displayName, employeeId: c.staffCode.slice(3), posCapabilities });
  }

  const body: PosSnapshot['body'] = {
    store: { storeId, name: storeRow?.name ?? '', mode: store.mode, terminalNo: terminal.terminalNo, vatRegistered: (await posV2Repo.getOrgTaxType(tx, orgId)) === 'vat' }, // T-528 R1: the tablet prices with the org's own VAT status
    menu,
    stands: (await posV2Repo.listActiveStands(tx, orgId, storeId)).map((s) => ({ id: s.id, number: s.number })),
    tenders: (await posV1Repo.listTendersByStore(tx, orgId, storeId)).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
    discountPresets: (await posV2Repo.listActivePresets(tx, orgId, storeId)).map((p) => ({ id: p.id, name: p.name, valueType: p.valueType, value: p.value })),
    rules: {
      vatPercentBasisPoints: Number(rules.vatPercentBasisPoints),
      scPwdPercentBasisPoints: Number(rules.scPwdPercentBasisPoints),
      businessDayStartHour: rules.businessDayStartHour,
      tableWarnMinutes: rules.tableWarnMinutes,
    },
    staff,
    device: {
      pairingId,
      lastSeq: await posV2Repo.maxSeqForPairing(tx, orgId, storeId, pairingId),
      lastTerminalSeq: await posV2Repo.maxTerminalSeq(tx, orgId, storeId, terminal.terminalNo),
    },
    businessDate,
  };
  return { body, etag: `"${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')}"`, nextChangeAt: menu.nextChangeAt };
}

/** The route's door: one org-scoped transaction around `buildPosSnapshot`. */
export function loadPosSnapshot(pairing: PosPairing, deps?: PosDeps): Promise<PosSnapshot> {
  return withOrgPrincipal(pairing.orgId, (tx) => buildPosSnapshot(tx, { pairing }, deps));
}

// ---------------------------------------------------------------------------------------------------------------------
// R8 - the state poll
// ---------------------------------------------------------------------------------------------------------------------
export type PosStateAnswer =
  | { status: 'forbidden' }
  | { status: 'not_modified' }
  | { status: 'ok'; body: { stateVersion: number; openStands: unknown[] | null; kitchenQueue: unknown[] | null; refillQueue: unknown[] | null } };

/**
 * `since` is the version the screen already holds (-1 when it has none). Store scope is judged FIRST, so a 304 never confirms another store's version;
 * then the one-row `state_version` check; only a changed version runs the lists, and each list only for a person who holds its capability (the others are
 * `null`, not a refusal: a cashier's tablet gets stands, a kitchen screen gets its queue).
 */
export function readPosState(actor: Actor, input: { storeId: string; since: number; stationId?: string }): Promise<PosStateAnswer> {
  return withOrgPrincipal(actor.orgId, async (tx): Promise<PosStateAnswer> => {
    try {
      await requireStoreScope(tx, actor, input.storeId);
    } catch (err) {
      if (err instanceof RefusalError) return { status: 'forbidden' };
      throw err;
    }
    const stateVersion = (await posV2Repo.getStateVersion(tx, actor.orgId, input.storeId)) ?? 0;
    if (input.since === stateVersion) return { status: 'not_modified' };
    const at = { storeId: input.storeId };
    const openStands = (await can(tx, actor, 'record_sale', at)) ? (await listOpenStands(tx, actor, at)).stands : null;
    const kitchenQueue = (await can(tx, actor, 'serve_pos_ticket', at))
      ? (await listKitchenQueue(tx, actor, input.stationId ? { ...at, stationId: input.stationId } : at)).tickets
      : null;
    const refillQueue = (await can(tx, actor, 'request_pos_refill', at)) ? (await listRefillQueue(tx, actor, at)).tickets : null;
    return { status: 'ok', body: { stateVersion, openStands, kitchenQueue, refillQueue } };
  });
}

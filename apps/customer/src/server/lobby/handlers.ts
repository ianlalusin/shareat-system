import 'server-only';
import { lobbyRepo, withOrgPrincipal } from '@shareat/db';
import { cancelMyEntry, checkIn, getMyEntry, LOBBY_POS_STALE_MINUTES, type CheckInLine } from '@shareat/domain';
import { newCookieValue, readCookie, setCookieHeader } from './cookie';
import { BodyTooLarge, fail, json, MAX_BODY_BYTES, readJsonObject, SENTENCES } from './http';
import { logFault, logMissingIp, logReply } from './log';
import { refusalReply } from './refusals';
import { clientIp, hmacHex, isUuid, readConfig, type LobbyConfig } from './secrets';

/**
 * T-455 S3 - the three diner routes as thin glue. Every rule (limits, ownership, expiry, hand-off once) lives in packages/domain/src/lobby;
 * this file only: reads the settings, reads the capped body, turns the cookie and ip into keyed hashes, finds the store by its public code,
 * runs the domain call in one org-scoped transaction, and maps a typed refusal to a status and its one plain sentence.
 *
 * The diner is identified ONLY by the cookie. No input names a code or an entry id.
 */

type Route = 'check-in' | 'me' | 'cancel' | 'store';
const MAX_STORE_CODE = 64;

const storeCodeOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= MAX_STORE_CODE ? v : null);

/** Runs a handler, answering a body that is too large as 413, a typed refusal as its status, and anything else as a logged, plain 500. */
async function guarded(route: Route, run: (noteEntry: (id: string) => void) => Promise<Response>): Promise<Response> {
  let res: Response;
  let entryId: string | undefined;
  try {
    res = await run((id) => {
      entryId = id;
    });
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      res = fail(413, SENTENCES.tooLarge);
    } else {
      const refused = refusalReply(err);
      if (refused) {
        res = fail(refused.status, refused.error);
      } else {
        logFault(route, err);
        res = fail(500, SENTENCES.unexpected);
      }
    }
  }
  logReply(route, res.status, entryId);
  return res;
}

const notConfigured = (): Response => fail(503, SENTENCES.counter);

export async function handleCheckIn(req: Request): Promise<Response> {
  return guarded('check-in', async (noteEntry) => {
    const cfg = readConfig();
    if (!cfg) return notConfigured();
    const ip = clientIp(req);
    if (!ip) {
      logMissingIp('check-in');
      return notConfigured();
    }
    const body = await readJsonObject(req);
    if (!body || !isUuid(body.clientRequestId)) return fail(400, SENTENCES.badInput);

    const existing = readCookie(req);
    const cookie = existing ?? newCookieValue();
    const storeCode = storeCodeOf(body.storeCode);
    if (!storeCode) return fail(409, SENTENCES.counter);

    const result = await withOrgPrincipal(cfg.orgId, async (tx) => {
      const storeId = await lobbyRepo.getStoreIdByCode(tx, cfg.orgId, storeCode);
      if (!storeId) return null;
      return checkIn(tx, {
        orgId: cfg.orgId,
        storeId,
        deviceHash: hmacHex(cfg.secret, cookie),
        ipHash: hmacHex(cfg.secret, ip),
        displayName: body.displayName as string,
        partySize: body.partySize as number,
        note: body.note as string | null | undefined,
        clientRequestId: body.clientRequestId as string,
        lines: body.lines as readonly CheckInLine[] | undefined,
      });
    });
    if (!result) return fail(409, SENTENCES.counter);

    noteEntry(result.entryId);
    return json(
      200,
      {
        ok: true,
        created: result.created,
        entry: { entryId: result.entryId, code: result.code, status: result.status, partiesAhead: result.partiesAhead },
      },
      existing ? undefined : { 'set-cookie': setCookieHeader(cookie) },
    );
  });
}

/** The cookie owner's key at one store, or the reply that stops the request. */
async function ownerKey(cfg: LobbyConfig, req: Request, storeCode: string | null): Promise<{ deviceHash: string } | { stop: Response }> {
  const cookie = readCookie(req);
  if (!cookie) return { stop: fail(401, SENTENCES.notFound) };
  if (!storeCode) return { stop: fail(404, SENTENCES.notFound) };
  return { deviceHash: hmacHex(cfg.secret, cookie) };
}

export async function handleMe(req: Request): Promise<Response> {
  return guarded('me', async (noteEntry) => {
    const cfg = readConfig();
    if (!cfg) return notConfigured();
    const storeCode = storeCodeOf(new URL(req.url).searchParams.get('s'));
    const owner = await ownerKey(cfg, req, storeCode);
    if ('stop' in owner) return owner.stop;

    const view = await withOrgPrincipal(cfg.orgId, async (tx) => {
      const storeId = await lobbyRepo.getStoreIdByCode(tx, cfg.orgId, storeCode!);
      if (!storeId) return null;
      return getMyEntry(tx, { orgId: cfg.orgId, storeId, deviceHash: owner.deviceHash });
    });
    if (!view) return fail(404, SENTENCES.notFound);

    noteEntry(view.entryId);
    return json(200, {
      ok: true,
      entry: {
        entryId: view.entryId,
        code: view.code,
        status: view.status,
        partiesAhead: view.partiesAhead,
        displayName: view.displayName,
        partySize: view.partySize,
        standLabel: view.standLabel,
        handoffUrl: view.handoffUrl,
      },
    });
  });
}

export async function handleCancel(req: Request): Promise<Response> {
  return guarded('cancel', async (noteEntry) => {
    const cfg = readConfig();
    if (!cfg) return notConfigured();
    const body = await readJsonObject(req);
    if (!body) return fail(400, SENTENCES.badInput);
    const storeCode = storeCodeOf(body.storeCode);
    const owner = await ownerKey(cfg, req, storeCode);
    if ('stop' in owner) return owner.stop;

    const done = await withOrgPrincipal(cfg.orgId, async (tx) => {
      const storeId = await lobbyRepo.getStoreIdByCode(tx, cfg.orgId, storeCode!);
      if (!storeId) return null;
      return cancelMyEntry(tx, { orgId: cfg.orgId, storeId, deviceHash: owner.deviceHash });
    });
    if (!done) return fail(404, SENTENCES.notFound);

    noteEntry(done.entryId);
    return json(200, { ok: true, entry: { entryId: done.entryId, status: done.status } });
  });
}

/** The one reply for every store the diner cannot join: paused, switched off, POS unseen, no lobby row, unknown or missing code. Same keys as an open store. */
const closedStore = (): Response =>
  json(200, { ok: true, store: { storeName: '', partiesWaiting: 0, accepting: false }, error: SENTENCES.counter });

/**
 * GET /api/lobby/store?s=CODE - what the lobby screen shows before check-in: the store's name, how many parties are waiting, and whether the line
 * is open. Public and read-only: no cookie, no ip, no hash secret, no person data and no money. A closed store and an unknown code look the same.
 */
export async function handleStore(req: Request): Promise<Response> {
  return guarded('store', async () => {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, SENTENCES.tooLarge);

    const orgId = (process.env.LOBBY_ORG_ID ?? '').trim();
    const storeCode = storeCodeOf(new URL(req.url).searchParams.get('s'));
    if (!isUuid(orgId) || !storeCode) return closedStore();

    const view = await withOrgPrincipal(orgId, async (tx) => {
      const storeId = await lobbyRepo.getStoreIdByCode(tx, orgId, storeCode);
      if (!storeId) return null;
      const sw = await lobbyRepo.getLobbyStore(tx, orgId, storeId, LOBBY_POS_STALE_MINUTES, false);
      if (!sw || !sw.enabled || sw.paused || !sw.posFresh) return null;
      const storeName = await lobbyRepo.getStoreName(tx, orgId, storeId);
      if (storeName === undefined) return null;
      return { storeName, partiesWaiting: await lobbyRepo.countLive(tx, orgId, storeId) };
    });
    if (!view) return closedStore();
    return json(200, { ok: true, store: { storeName: view.storeName, partiesWaiting: view.partiesWaiting, accepting: true } });
  });
}

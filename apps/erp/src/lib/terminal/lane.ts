/**
 * Reading the mirrors and writing a punch, from the device. T-184.
 *
 * ⛔ CLIENT SDK ONLY — see `firebase.ts`. Every function here works with the network pulled.
 */
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

export type CredentialKind = 'card' | 'fingerprint';
export type PunchIntent = 'in' | 'out';

export interface MirroredCredential {
  credentialId: string;
  employmentId: string;
  kind: CredentialKind;
  cardId?: string;
  matchToken?: string;
  templates?: string[];
}

export interface MirroredRoster {
  employmentId: string;
  staffCode: string | null;
  displayName: string;
  position: string | null;
}

/**
 * ⭐ **T-200 — hot-set item 4, finally read.** Bible §5.3 mirrors this as *"on-shift roster +
 * current business day punch feed"*, and until now **nothing consumed it** — the publisher wrote
 * it and no terminal ever subscribed (DEF-118).
 *
 * ⚠️ `status === 'open'` is what "on shift right now" MEANS: an in with no out. It is derived by
 * the server, never by the device — bible §5.1, *"a device never computes a business outcome."*
 */
export interface MirroredDayFeed {
  id: string;
  shiftDay: string;
  status: string;
  computedMinutes: number;
  anchorMinute: number | null;
  endMinute: number | null;
  staffCode: string | null;
  displayName: string;
}

export interface MirroredConfig {
  configId: string;
  credentialNfc: boolean;
  credentialFingerprint: boolean;
  credentialFace: boolean;
}

/**
 * Live views of the three mirrors, served from the local cache when there is no network.
 *
 * ⭐ `onSnapshot` rather than `getDocs`: a listener is fed from the cache immediately and then
 * updated when the server has something newer, which is exactly the behaviour a terminal wants —
 * it never blocks on a network round trip to show a roster it already has.
 */
export function watchMirrors(
  db: Firestore,
  storeId: string,
  on: {
    roster: (rows: MirroredRoster[]) => void;
    dayFeed: (rows: MirroredDayFeed[]) => void;
    config: (config: MirroredConfig | null) => void;
    credentials: (rows: MirroredCredential[]) => void;
    error: (message: string) => void;
  },
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    onSnapshot(
      collection(db, `mirror/${storeId}/roster`),
      (snap) => {
        on.roster(
          snap.docs
            .map((d) => d.data() as MirroredRoster & { deletedAt?: unknown })
            // ⛔ A tombstone is a document, not an absence — that is the point of §5.1's "an offline
            // device must be able to LEARN that a record went away". Filtering here is what turns
            // the tombstone back into the deletion it represents.
            .filter((r) => !(r as { deletedAt?: unknown }).deletedAt),
        );
      },
      (err) => on.error(`Roster: ${err.message}`),
    ),
  );

  /**
   * ⛔ **QUERIED BY `shiftDay`, never a whole-collection subscription — T-198 §2.2.**
   *
   * T-198 scoped the publisher's trigger so no NEW old day is written, but it could not retract
   * what was already pushed: 24 of 24 publishes measured before the fix were historical. A bare
   * `collection()` listener reads what IS there, not what we meant to put there, and would pull
   * that entire backlog onto the tablet on first load — the exact cost T-198 just removed.
   *
   * ⚠️ Two days, matching the trigger's own window: a 22:00 shift belongs to the previous business
   * day, and an offline terminal replays punches hours late carrying the business day they
   * happened on.
   */
  const from = new Date(Date.now() + 8 * 3_600_000); // Asia/Manila, as the publisher pins it
  from.setUTCDate(from.getUTCDate() - 1);
  unsubs.push(
    onSnapshot(
      query(
        collection(db, `mirror/${storeId}/dayFeed`),
        where('shiftDay', '>=', from.toISOString().slice(0, 10)),
      ),
      (snap) => {
        on.dayFeed(
          snap.docs
            .map((d) => d.data() as MirroredDayFeed & { deletedAt?: unknown })
            .filter((r) => !(r as { deletedAt?: unknown }).deletedAt),
        );
      },
      (err) => on.error(`Day feed: ${err.message}`),
    ),
  );

  unsubs.push(
    onSnapshot(
      doc(db, `mirror/${storeId}/config/current`),
      (snap) => on.config(snap.exists() ? (snap.data() as MirroredConfig) : null),
      (err) => on.error(`Config: ${err.message}`),
    ),
  );

  unsubs.push(
    onSnapshot(
      collection(db, `biometricMirror/${storeId}/credentials`),
      (snap) => {
        on.credentials(
          snap.docs
            .map((d) => d.data() as MirroredCredential & { deletedAt?: unknown })
            // ⭐ A revoked badge arrives as a tombstone, and dropping it here is what makes a
            // revocation take effect on a terminal that has been offline since it happened.
            .filter((c) => !(c as { deletedAt?: unknown }).deletedAt),
        );
      },
      (err) => on.error(`Credentials: ${err.message}`),
    ),
  );

  return () => unsubs.forEach((u) => u());
}

/**
 * Resolve a scanned badge against the mirrored credentials.
 *
 * ⚠️ **This decides what to SHOW, and nothing else.** The punch still carries the credential, never
 * the employment — T-185 made the server the authority on whose badge it is, and a terminal that
 * "helpfully" sent its own conclusion would put landmine #22 straight back.
 */
export function resolveScan(
  credentials: readonly MirroredCredential[],
  scanned: string,
): MirroredCredential | null {
  const value = scanned.trim();
  if (!value) return null;
  return credentials.find((c) => c.cardId === value || c.matchToken === value) ?? null;
}

export interface PunchInput {
  db: Firestore;
  deviceId: string;
  storeId: string;
  credentialKind: CredentialKind;
  credentialRef: string;
  method: 'nfc' | 'qr' | 'fingerprint';
  assertedIntent: PunchIntent;
}

/**
 * Write one punch into `/inbox`.
 *
 * ⛔⛔ **DO NOT `await` THE RETURNED `acknowledged` PROMISE BEFORE TELLING THE STAFFER IT WORKED.**
 *
 * This is the single most important line in the terminal, and it was found by running the page in
 * a real browser rather than by reading the SDK docs. **Offline, `setDoc()`'s promise does not
 * resolve** — it settles only when the SERVER acknowledges the write. The local write has already
 * happened, synchronously, into IndexedDB; the promise is about the round trip.
 *
 * So `await setDoc(...)` on a tablet with no network hangs **forever**: the cashier taps their
 * badge, nothing appears, and they tap again. The punch was captured perfectly every time; the UI
 * simply never said so. ⚠️ That is a spectacular failure mode precisely because it only appears
 * when the network is down — which is the one condition this whole feature exists for.
 *
 * ⭐ Splitting the return is the fix: `clientPunchId` is available *immediately*, because the
 * device minted it and the local write is already durable, and `acknowledged` is there for a caller
 * that wants to know about a later refusal. The UI shows success on the first and never blocks on
 * the second.
 *
 * ⛔ `setDoc` at an id we choose, never `addDoc`. `addDoc` mints a server id, which would break the
 * idempotency key that T-159's rule (`clientPunchId == eventId`), the ingestor's UNIQUE constraint
 * and the quarantine's healing all key on. The SDK's own retry then writes to the same path instead
 * of creating a second punch.
 */
export function writePunch(input: PunchInput): {
  clientPunchId: string;
  acknowledged: Promise<void>;
} {
  const clientPunchId = newClientPunchId();
  const acknowledged = setDoc(doc(input.db, 'inbox', clientPunchId), {
    clientPunchId,
    occurredAt: Date.now(),
    deviceId: input.deviceId,
    storeId: input.storeId,
    credentialKind: input.credentialKind,
    credentialRef: input.credentialRef,
    method: input.method,
    assertedIntent: input.assertedIntent,
  });
  return { clientPunchId, acknowledged };
}

/**
 * ⚠️ Minted on the DEVICE, deliberately. The key has to exist before the write does, or an offline
 * punch has no identity and cannot be deduplicated when it finally arrives.
 */
function newClientPunchId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return random;
}

/**
 * How many punches this terminal has written that the server has not acknowledged.
 *
 * ⛔⛔ **THE `where` CLAUSE IS NOT A FILTER — IT IS WHAT MAKES THE QUERY LEGAL.** T-180 finding 1:
 * Firestore rules are not filters, so an unconstrained `list` over `/inbox` is **refused outright**
 * with *"Property deviceId is undefined on object"*, because the rule
 * (`resource.data.deviceId == request.auth.token.deviceId`) cannot be proven to hold for every
 * document the query might return.
 *
 * ⚠️ The rule and this query are a **matched pair**: changing either one silently breaks the other,
 * and the composite index in `firestore.indexes.json` exists for exactly this shape. Removing the
 * `where` to "show everything" does not widen the result — it returns nothing at all.
 */
export function watchPending(
  db: Firestore,
  deviceId: string,
  on: (state: { pending: number; fromCache: boolean }) => void,
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'inbox'), where('deviceId', '==', deviceId)),
    /**
     * ⭐ `includeMetadataChanges` is doing the real work here, and without it this number LIES.
     *
     * By default a listener fires only when document *data* changes. A punch being acknowledged by
     * the server changes no data at all — it flips `hasPendingWrites` from true to false, which is
     * metadata. So the count would sit at "2 punches waiting" forever after a reconnect, on a
     * screen whose entire job is to tell a staffer whether their clock-in is safe.
     *
     * ⚠️ Found in the browser: the first version polled once with `getDocs` on mount, and after a
     * reconnect it still read 2 while the server already had all four.
     */
    { includeMetadataChanges: true },
    (snap) => {
      on({
        pending: snap.docs.filter((d) => d.metadata.hasPendingWrites).length,
        fromCache: snap.metadata.fromCache,
      });
    },
  );
}

/** One-shot variant, kept for tests and for a caller that wants a value rather than a stream. */
export async function pendingCount(
  db: Firestore,
  deviceId: string,
): Promise<{ pending: number; fromCache: boolean }> {
  const snap = await getDocs(query(collection(db, 'inbox'), where('deviceId', '==', deviceId)));
  return {
    /**
     * ⭐ `hasPendingWrites` is the SDK's OWN answer to "has the server taken this yet", and it is
     * the only honest source for this number.
     *
     * ⚠️ The first attempt counted documents with no `punchId` stamped on them — the field the
     * relay writes back after ingesting. That is a different question ("has Postgres adjudicated
     * this"), and with no relay running it counted every punch ever made, forever. A staffer would
     * have watched the number climb all day and concluded nothing was syncing.
     */
    pending: snap.docs.filter((d) => d.metadata.hasPendingWrites).length,
    // ⭐ Worth surfacing: a count read from cache while offline is the *device's* view, and the
    // honest thing is to say so rather than present it as the server's.
    fromCache: snap.metadata.fromCache,
  };
}

import type { LobbyBirthday, LobbyCheckInInput, LobbyEntrySummary, LobbyMyEntry, LobbyResult, LobbyStatus } from './http-lobby-data';
import type { LobbyData, LobbyStoreView } from './lobby-data';

/**
 * T-455 S4 - an in-memory LobbyData that follows the server's rules (S2/S3) so the screens can be built and tested without a server:
 * 4-digit codes, a replay of the same clientRequestId returns the same place, bounds refused with 400, a closed or unknown store refused with
 * 409 and the one counter sentence, and the hand-off link handed over ONCE. Nothing here is money or contact data. `demo` moves the line along.
 */

const COUNTER = 'Please check in at the counter.';
const BAD = 'Please check the name, party size and order, then try again.';
const NOT_FOUND = 'We could not find that place in line.';
const STORE_NAME = 'Shareat Lipa';

interface Row {
  entryId: string;
  storeCode: string;
  device: number;
  seq: number;
  clientRequestId: string;
  code: string;
  status: LobbyStatus;
  displayName: string;
  partySize: number;
  standLabel: string | null;
  handoffUrl: string | null;
  repeatLink: boolean;
}

interface LobbyDemo {
  pause(): void;
  call(): void;
  seat(url: string | null, standLabel: string, opts?: { repeatLink?: boolean }): void;
  close(status: 'removed' | 'expired' | 'cancelled'): void;
  asNewDevice(): void;
  /** The cashier accepts / declines the latest place's birthday request (S6a). */
  acceptBirthday(inMinutes: number): void;
  declineBirthday(reason: string): void;
}

const fail = <T>(status: number, error: string): LobbyResult<T> => ({ ok: false, status, error });

export function createFixtureLobbyData(opts: { now?: () => number } = {}): LobbyData & { demo: LobbyDemo } {
  const now = opts.now ?? Date.now;
  const rows: Row[] = [];
  let device = 1;
  let seq = 0;
  let paused = false;
  const birthdays = new Map<string, LobbyBirthday>();

  const live = (r: Row) => r.status === 'waiting' || r.status === 'called';
  const mine = (storeCode: string) => [...rows].reverse().find((r) => r.storeCode === storeCode && r.device === device);
  const latest = () => [...rows].reverse().find((r) => r.device === device);
  const ahead = (r: Row) => rows.filter((o) => o.storeCode === r.storeCode && o.seq < r.seq && live(o)).length;
  const summary = (r: Row): LobbyEntrySummary => ({ entryId: r.entryId, code: r.code, status: r.status, partiesAhead: ahead(r) });

  const data: LobbyData = {
    async getStore(storeCode): Promise<LobbyResult<LobbyStoreView>> {
      if (storeCode !== 'LIPA') return fail(409, COUNTER);
      return {
        ok: true,
        value: { storeCode, storeName: STORE_NAME, partiesWaiting: rows.filter((r) => r.storeCode === storeCode && live(r)).length, accepting: !paused },
      };
    },

    async checkIn(input: LobbyCheckInInput) {
      const same = rows.find((r) => r.device === device && r.clientRequestId === input.clientRequestId);
      if (same) return { ok: true as const, value: { ...summary(same), created: false } };
      const name = (input.displayName ?? '').trim();
      const note = input.note ?? '';
      if (name.length < 1 || name.length > 40 || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 30 || note.length > 60) {
        return fail(400, BAD);
      }
      if (input.storeCode !== 'LIPA' || paused) return fail(409, COUNTER);
      seq += 1;
      const row: Row = {
        entryId: `fixture-${seq}-${now()}`,
        storeCode: input.storeCode,
        device,
        seq,
        clientRequestId: input.clientRequestId,
        code: String(4820 + seq).padStart(4, '0').slice(-4),
        status: 'waiting',
        displayName: name,
        partySize: input.partySize,
        standLabel: null,
        handoffUrl: null,
        repeatLink: false,
      };
      rows.push(row);
      return { ok: true as const, value: { ...summary(row), created: true } };
    },

    async myEntry(storeCode): Promise<LobbyResult<LobbyMyEntry>> {
      const r = mine(storeCode);
      if (!r) return fail(404, NOT_FOUND);
      const handoffUrl = r.status === 'seated' ? r.handoffUrl : null;
      if (handoffUrl && !r.repeatLink) r.handoffUrl = null; // the link is handed over once
      return { ok: true, value: { ...summary(r), displayName: r.displayName, partySize: r.partySize, standLabel: r.standLabel, handoffUrl } };
    },

    async cancel(storeCode): Promise<LobbyResult<{ entryId: string; status: 'cancelled' }>> {
      const r = mine(storeCode);
      if (!r) return fail(404, NOT_FOUND);
      if (!live(r)) return fail(409, COUNTER);
      r.status = 'cancelled';
      return { ok: true, value: { entryId: r.entryId, status: 'cancelled' } };
    },

    async birthday(storeCode): Promise<LobbyResult<LobbyBirthday | null>> {
      const r = mine(storeCode);
      if (!r) return fail(404, NOT_FOUND);
      return { ok: true, value: birthdays.get(r.entryId) ?? null };
    },

    async requestBirthday(storeCode, celebrantName): Promise<LobbyResult<LobbyBirthday | null>> {
      const r = mine(storeCode);
      if (!r) return fail(404, NOT_FOUND);
      const name = celebrantName === null ? null : celebrantName.trim() || null;
      if (name !== null && name.length > 40) return fail(400, BAD);
      if (!live(r)) return fail(409, 'That place in line is already closed.');
      const had = birthdays.get(r.entryId);
      if (had && had.status !== 'cancelled') return fail(409, 'A birthday song has already been requested for your table.');
      const b: LobbyBirthday = { status: 'requested', celebrantName: name, scheduledAt: null, declineReason: null };
      birthdays.set(r.entryId, b);
      return { ok: true, value: { ...b } };
    },

    async cancelBirthday(storeCode): Promise<LobbyResult<LobbyBirthday | null>> {
      const r = mine(storeCode);
      if (!r) return fail(404, NOT_FOUND);
      const b = birthdays.get(r.entryId);
      if (!b) return fail(404, NOT_FOUND);
      if (b.status !== 'requested' && b.status !== 'accepted') return fail(409, 'That birthday song request can no longer be changed.');
      b.status = 'cancelled';
      return { ok: true, value: { ...b } };
    },
  };

  const demo: LobbyDemo = {
    pause: () => {
      paused = true;
    },
    call: () => {
      const r = latest();
      if (r && r.status === 'waiting') r.status = 'called';
    },
    seat: (url, standLabel, o = {}) => {
      const r = latest();
      if (!r) return;
      r.status = 'seated';
      r.standLabel = standLabel;
      r.handoffUrl = url;
      r.repeatLink = o.repeatLink === true;
    },
    close: (status) => {
      const r = latest();
      if (r) r.status = status;
    },
    asNewDevice: () => {
      device += 1;
    },
    acceptBirthday: (inMinutes) => {
      const r = latest();
      const b = r ? birthdays.get(r.entryId) : undefined;
      if (b && b.status === 'requested') {
        b.status = 'accepted';
        b.scheduledAt = new Date(now() + inMinutes * 60_000).toISOString();
      }
    },
    declineBirthday: (reason) => {
      const r = latest();
      const b = r ? birthdays.get(r.entryId) : undefined;
      if (b && b.status === 'requested') {
        b.status = 'declined';
        b.declineReason = reason;
      }
    },
  };

  return Object.assign(data, { demo });
}

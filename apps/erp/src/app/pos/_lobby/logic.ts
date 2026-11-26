/**
 * T-644 S1 - the pure half of the POS Lobby tab: the shapes the server actions answer with, the code keypad, the one-line row, and the poller's
 * single-flight rule. No React, no clock, no network: every dependency arrives in an argument. docs/tasks/644-lobby-in-erp-pos.md.
 * Ported as REQUIREMENTS from apps/pos/src/lib/pos2/lobby.ts (the old POS); the rules themselves live in `packages/domain/src/lobby`.
 */

/** pos2's beat. The poll is also what tells diners' phones that this POS is up (the `pos_seen_at` stamp), so it runs on every tab. */
export const LOBBY_POLL_MS = 10_000;
export const LOBBY_NEEDS_INTERNET = 'The waiting line needs the internet.';
export const LOBBY_NOT_LOADED = 'The waiting line could not be loaded. It will try again.';
export const LOBBY_NOT_PAIRED = 'The waiting line is run from the store tablet.';
export const BAD_ENTRY = 'Choose a party from the list.';
const CODE_DIGITS = 4;
const DOT = '·';

export interface LobbyLineView {
  lineKind: 'package' | 'a_la_carte';
  qty: number;
  variantId: string;
  /** T-644 S2: the options the diner chose (ids), so the seat sheet can pre-fill the line. Absent on an answer from before S2. */
  optionValueIds?: string[];
  label: string;
  /** The store's active POS v1 link key, or null: the line is shown as text to tap in by hand. */
  posItemKey: string | null;
}

/** One row of the list, JSON-safe (times are ISO strings). */
export interface LobbyEntryView {
  entryId: string;
  code: string;
  displayName: string | null;
  partySize: number;
  status: 'waiting' | 'called';
  source: 'lobby' | 'staff';
  note: string | null;
  phone: string | null;
  createdAt: string;
  calledAt: string | null;
  lines: LobbyLineView[];
}

export interface LobbyListView {
  lobbyEnabled: boolean;
  paused: boolean;
  entries: LobbyEntryView[];
}

/** What every lobby action answers: a result, never a thrown refusal. */
export type LobbyResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/** What the poll leaves for the screens: the last good list, whether one has arrived, and a plain sentence when the last try failed. */
export interface LobbyPollState {
  list: LobbyListView | null;
  loaded: boolean;
  error: string | null;
}
export const LOBBY_IDLE: LobbyPollState = { list: null, loaded: false, error: null };

/** The number pad: a digit appends (up to four), 'back' drops the last, 'clear' empties. */
export function keypadPress(digits: string, key: string): string {
  if (key === 'clear') return '';
  if (key === 'back') return digits.slice(0, -1);
  if (/^[0-9]$/.test(key)) return digits.length < CODE_DIGITS ? digits + key : digits;
  return digits;
}

/** The line narrowed by the digits tapped so far: by CODE only (never by name or phone). No digits = the whole line, in order. */
export function filterByCode<T extends { code: string }>(entries: T[], digits: string): T[] {
  return digits === '' ? entries : entries.filter((e) => e.code.startsWith(digits));
}

/** "4821 · Ana · 5 pax · Pork+Chicken · 12 min" (the package part is left out when the party ordered none). */
export function lobbyRowSummary(e: Pick<LobbyEntryView, 'code' | 'displayName' | 'partySize' | 'createdAt' | 'lines'>, nowMs: number): string {
  const created = new Date(e.createdAt).getTime();
  const mins = Number.isFinite(created) ? Math.max(0, Math.floor((nowMs - created) / 60000)) : 0;
  const packages = e.lines.filter((l) => l.lineKind === 'package').map((l) => l.label);
  const parts = [e.code, e.displayName && e.displayName.trim() !== '' ? e.displayName : 'Guest', `${e.partySize} pax`];
  if (packages.length > 0) parts.push(packages.join('+'));
  parts.push(`${mins} min`);
  return parts.join(` ${DOT} `);
}

/** The lines with no menu match on this store: the cashier taps these in by hand. */
export const handLine = (l: Pick<LobbyLineView, 'qty' | 'label'>): string => `${l.qty} x ${l.label} (tap in by hand)`;
export const byHandLines = (e: Pick<LobbyEntryView, 'lines'>): string[] => e.lines.filter((l) => !l.posItemKey).map(handLine);

/**
 * The poll's traffic rule: ONE list call in flight. A poll asked for while one runs is skipped and remembered, then re-run once when the call ends; an answer
 * older than one already applied is dropped. (Kills: a second request per tick on a slow connection, and a stale answer replacing a newer one.)
 */
export function createPollGuard() {
  let running = false;
  let queued = false;
  let issued = 0;
  let applied = 0;
  return {
    begin(): number | null {
      if (running) {
        queued = true;
        return null;
      }
      running = true;
      return ++issued;
    },
    accept(seq: number): boolean {
      if (seq <= applied) return false;
      applied = seq;
      return true;
    },
    /** The call is over. True when another poll was asked for meanwhile. */
    end(): boolean {
      running = false;
      const again = queued;
      queued = false;
      return again;
    },
  };
}

/** The poller the shell mounts. `list` is the server action; `apply` receives the outcome. A failed call keeps the last list (the screens show the sentence). */
export function createLobbyPoller(deps: { list: () => Promise<LobbyResult<LobbyListView>>; apply: (outcome: { list: LobbyListView } | { error: string }) => void }) {
  const guard = createPollGuard();
  const poll = async (): Promise<void> => {
    const seq = guard.begin();
    if (seq === null) return;
    try {
      const r = await deps.list();
      if (guard.accept(seq)) deps.apply(r.ok ? { list: { lobbyEnabled: r.lobbyEnabled, paused: r.paused, entries: r.entries } } : { error: r.error });
    } catch {
      if (guard.accept(seq)) deps.apply({ error: LOBBY_NOT_LOADED });
    } finally {
      if (guard.end()) void poll();
    }
  };
  return { poll };
}

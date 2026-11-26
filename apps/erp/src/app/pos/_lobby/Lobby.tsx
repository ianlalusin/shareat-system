'use client';

/**
 * T-644 S1 - the Lobby tab: the waiting line (walk-ins and diners checked in on their phones) with Call, Remove (after a confirm), Pause / Resume the diner
 * check-in, and Add walk-in. A code keypad narrows the line by code, tap only. T-644 S2 adds Seat: the Orders seat sheet (`OrderDialog`) opens with the party's size and
 * lines filled in; confirming opens the table first, then tells the lobby (`seat.ts`); a lobby step that fails leaves "Seated, link not saved" with Retry / Dismiss on the
 * row. Online only: the list comes from the shell's poll
 * (`use-lobby-poll.ts`, every tab, so the `pos_seen_at` stamp keeps diners able to check in); every move is a Server Action (`../lobby/actions.ts`).
 * Same sheets, touch sizes and wording as the Reservations tab. Nothing here decides: the server judges every rule.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkAll, nativeAttrs, POS_LOBBY_WALKIN_RULES } from '@shareat/domain/field-rules';
import { Badge, Banner, Dialog } from '@/components/ui';
import { enqueue, type PosEvent } from '@/lib/pos-device';
import { newDeviceId } from '../_orders/ids';
import type { MenuLike } from '../_orders/menu-filter';
import { OrderDialog, type OrderSend, type SeatPrefill } from '../_orders/OrderDialogs';
import { actingPersonId, seatEvent, submitPosEvent } from '../_orders/payloads';
import { projectOrders, type ServerStand } from '../_orders/project';
import { usePos } from '../_shell/pos-context';
import { Keypad } from '../_shell/Keypad';
import { callEntryAction, parkWalkInAction, removeEntryAction, seatLobbyEntryAction, setLobbyPausedAction } from '../lobby/actions';
import { byHandLines, filterByCode, keypadPress, LOBBY_NEEDS_INTERNET, LOBBY_NOT_PAIRED, lobbyRowSummary, type LobbyEntryView, type LobbyResult } from './logic';
import { addPending, clearPending, keepOnly, readPending, type PendingSeat } from './pending';
import { mapLobbyLines, retryLobbyLink, SEAT_LINK_NOT_SAVED, seatButton, seatLobbyParty, type SeatDeps } from './seat';

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-2xl border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

// The walk-in fields' own rules (name 1 to 40, phone up to 30, note up to 60): the same set the server asserts.
const NAME_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.displayName);
const PHONE_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.phone);
const NOTE_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.note);

type Sheet = { kind: 'walkin' } | { kind: 'remove'; e: LobbyEntryView } | { kind: 'dismiss'; e: LobbyEntryView };
const nameOf = (e: LobbyEntryView) => e.displayName?.trim() || e.code;
const NO_EVENTS: PosEvent[] = [];

export function Lobby() {
  const pos = usePos();
  const [digits, setDigits] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seating, setSeating] = useState<{ e: LobbyEntryView; prefill: SeatPrefill } | null>(null);
  const [pending, setPending] = useState<Record<string, PendingSeat>>({});
  const [justSeated, setJustSeated] = useState<string[]>([]); // off the list until the next poll confirms it, so a second tap cannot open a second table
  // Add walk-in
  const [name, setName] = useState('');
  const [party, setParty] = useState(2);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  const list = pos?.lobby?.list ?? null;
  const entries = list?.entries ?? [];
  const shown = useMemo(() => filterByCode(entries.filter((e) => !justSeated.includes(e.entryId)), digits), [entries, digits, justSeated]);
  // The seat sheet's stand grid greys out the tables already open (the server's list with the outbox on top), exactly as the Orders tab does.
  const snapshot = pos?.ordersSnapshot ?? null;
  const menu = (snapshot?.menu ?? null) as MenuLike | null;
  const openStands = (pos?.openStands ?? null) as ServerStand[] | null;
  const outbox = pos?.pendingEvents ?? NO_EVENTS;
  const tiles = useMemo(() => projectOrders({ openStands, sessions: {} }, outbox, snapshot && menu ? { stands: snapshot.stands, menu } : null, []).tiles, [openStands, outbox, snapshot, menu]);
  // The "link not saved" notes of this store; parties that left the line are forgotten once the list has loaded (their retry could never work).
  const pendingStore = pos?.storeId ?? null;
  const loaded = pos?.lobby?.loaded === true;
  const idsKey = entries.map((e) => e.entryId).join(',');
  useEffect(() => {
    if (!pendingStore) return;
    if (loaded) keepOnly(pendingStore, idsKey === '' ? [] : idsKey.split(','));
    setPending(readPending(pendingStore));
  }, [pendingStore, loaded, idsKey]);
  if (!pos) return null;
  const storeId = pos.storeId;
  const online = pos.online;
  const ready = pos.paired && online && storeId !== null;
  const refresh = () => void pos.lobby?.refresh();
  const now = Date.now();
  const menuAt = pos.clockAt === undefined ? undefined : new Date(pos.clockAt); // the shell's menu clock, as the Orders tab reads it
  const personId = actingPersonId(pos.offlineActorPersonId ? { personId: pos.offlineActorPersonId } : null, pos.personId);

  const close = () => {
    setSheet(null);
    setProblem(null);
    setSaving(false);
  };
  /** Runs one action; a refusal is the domain's own sentence. Always re-reads the line afterwards. */
  const act = async (id: string | null, run: () => Promise<LobbyResult>, done: string): Promise<boolean> => {
    setBusyId(id);
    setNotice(null);
    try {
      const r = await run();
      if (r.ok) {
        setNotice(done);
        return true;
      }
      setProblem(r.error);
      setNotice(null);
      return false;
    } catch {
      setProblem(LOBBY_NEEDS_INTERNET);
      return false;
    } finally {
      setBusyId(null);
      refresh();
    }
  };

  const openWalkIn = () => {
    setName('');
    setParty(2);
    setPhone('');
    setNote('');
    setProblem(null);
    setSheet({ kind: 'walkin' });
  };
  const saveWalkIn = async () => {
    if (!storeId) return;
    const who = name.trim();
    setSaving(true);
    setProblem(null);
    let code = '';
    const ok = await act(
      null,
      async () => {
        const r = await parkWalkInAction({ storeId, displayName: who, partySize: party, phone: phone.trim() || null, note: note.trim() || null });
        if (r.ok) code = r.code;
        return r;
      },
      '',
    );
    setSaving(false);
    if (ok) {
      setNotice(`${who} is on the line: code ${code}.`);
      close();
    }
  };

  const call = (e: LobbyEntryView) => {
    if (!storeId) return;
    setProblem(null);
    void act(e.entryId, () => callEntryAction({ storeId, entryId: e.entryId }), `${nameOf(e)} is called.`);
  };
  const confirmRemove = async (e: LobbyEntryView) => {
    if (!storeId) return;
    setSaving(true);
    const ok = await act(e.entryId, () => removeEntryAction({ storeId, entryId: e.entryId }), `${nameOf(e)} is off the line.`);
    setSaving(false);
    if (ok) close();
  };
  const togglePause = () => {
    if (!storeId || !list) return;
    setProblem(null);
    void act(null, () => setLobbyPausedAction({ storeId, paused: !list.paused }), list.paused ? 'Check-in is open again.' : 'Check-in is paused.');
  };

  const openSeat = (e: LobbyEntryView) => {
    setProblem(null);
    setNotice(null);
    const { cart, byHand } = mapLobbyLines(e.lines, menu, menuAt ?? new Date());
    setSeating({ e, prefill: { title: `Seat ${nameOf(e)} · ${e.partySize} ${e.partySize === 1 ? 'guest' : 'guests'}`, heads: e.partySize, cart, byHand } });
  };
  const seatDeps: SeatDeps = {
    submit: async (event) => {
      const r = await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event);
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
    link: (b) => seatLobbyEntryAction(b),
    remember: (p) => {
      if (storeId) addPending(storeId, p);
    },
    forget: (entryId) => {
      if (storeId) clearPending(storeId, entryId);
    },
  };
  /** The sheet's confirm: ONE `stand.opened` through the outbox (the Orders builder), THEN the lobby is told. Returns the sentence to show in the sheet, or null when the table is open. */
  const sendSeat = async (e: LobbyEntryView, o: OrderSend): Promise<string | null> => {
    const stand = snapshot?.stands.find((s) => s.id === o.standId);
    if (!menu || !storeId) return 'The menu is not on this tablet yet.';
    if (!stand || o.standId === null) return 'Pick a stand first.';
    let event: ReturnType<typeof seatEvent>;
    try {
      event = seatEvent({ personId, menu, now: new Date(), newId: newDeviceId, cart: o.cart, standId: o.standId, heads: o.heads });
    } catch (err) {
      return err instanceof Error ? err.message : 'That could not be sent.';
    }
    const out = await seatLobbyParty(seatDeps, { entryId: e.entryId, event, standLabel: String(stand.number) });
    setPending(readPending(storeId));
    refresh();
    if (out.kind === 'refused') return out.message;
    if (out.kind === 'link-pending') setProblem(`${nameOf(e)} is at Stand ${stand.number}, but the lobby was not told: ${out.message}`);
    else {
      setJustSeated((ids) => [...ids, e.entryId]);
      setNotice(`${nameOf(e)} is seated at Stand ${stand.number}. Add the rest of the order on the Orders tab.`);
    }
    return null;
  };
  const retry = async (e: LobbyEntryView, p: PendingSeat) => {
    if (!storeId) return;
    setBusyId(e.entryId);
    setProblem(null);
    const r = await retryLobbyLink(seatDeps, p);
    setBusyId(null);
    setPending(readPending(storeId));
    refresh();
    if (r.ok) {
      setJustSeated((ids) => [...ids, e.entryId]);
      setNotice(`${nameOf(e)} is seated.`);
    } else setProblem(r.message);
  };
  /** Dismiss (after a confirm): stop asking. Only this tablet's note goes; the party stays on the line until it is removed (the table itself is open and stays). */
  const dismiss = (e: LobbyEntryView) => {
    if (!storeId) return;
    clearPending(storeId, e.entryId);
    setPending(readPending(storeId));
    setProblem(null);
    close();
  };

  const pausedNow = list?.lobbyEnabled === true && list.paused;

  return (
    <>
      {seating ? <OrderDialog mode={{ kind: 'seat' }} menu={menu} stands={snapshot?.stands ?? []} tiles={tiles} onClose={() => setSeating(null)} onSend={(o) => sendSeat(seating.e, o)} at={menuAt} prefill={seating.prefill} /> : null}
      <div hidden={seating !== null}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-ink">Waiting line</h1>
              {entries.length > 0 ? <Badge tone="info" label={`${entries.length} waiting`} /> : null}
              {pausedNow ? <Badge tone="warning" label="Paused" /> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {list?.lobbyEnabled ? (
                <button type="button" className={SECONDARY} disabled={!ready} onClick={togglePause}>
                  {list.paused ? 'Resume check-in' : 'Pause check-in'}
                </button>
              ) : null}
              <button type="button" className={SECONDARY} disabled={!ready} onClick={openWalkIn}>
                Add walk-in
              </button>
            </div>
          </div>
          {!pos.paired ? <Banner tone="info">{LOBBY_NOT_PAIRED}</Banner> : null}
          {pos.paired && !online ? <Banner tone="warning">{LOBBY_NEEDS_INTERNET}</Banner> : null}
          {ready && pos.lobby?.error ? <Banner tone="warning">{pos.lobby.error}</Banner> : null}
          {ready && list && !list.lobbyEnabled ? <Banner tone="info">Diner check-in is off for this store. Walk-ins can still be added.</Banner> : null}
          {notice ? <Banner tone="success">{notice}</Banner> : null}
          {problem && sheet === null ? <Banner tone="error">{problem}</Banner> : null}

          {entries.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex min-h-12 items-center rounded-2xl border border-field-border bg-field px-4 text-xl tabular-nums tracking-widest text-ink" aria-label="Code search">
                {digits || <span className="text-base tracking-normal text-muted">Tap the code</span>}
              </div>
              <Keypad onDigit={(d) => setDigits((v) => keypadPress(v, d))} onBack={() => setDigits((v) => keypadPress(v, 'back'))} onClear={() => setDigits('')} />
            </div>
          ) : null}

          {ready && !pos.lobby?.loaded ? <p className="text-base text-muted">Loading the line…</p> : null}
          {ready && pos.lobby?.loaded && entries.length === 0 ? <p className="text-base text-muted">No one in the line.</p> : null}
          {entries.length > 0 && shown.length === 0 && digits !== '' ? <p className="text-base text-muted">No one with that code.</p> : null}
          <ul className="flex flex-col gap-3">
            {shown.map((e) => {
              const busy = busyId === e.entryId;
              const byHand = menu ? mapLobbyLines(e.lines, menu, menuAt ?? new Date(now)).byHand : byHandLines(e);
              const stuck = pending[e.entryId];
              const seat = seatButton({ ready, online, busy });
              return (
                <li key={e.entryId} className="rounded-2xl border border-surface-border bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-base font-semibold text-ink">{lobbyRowSummary(e, now)}</p>
                    {e.status === 'called' ? <Badge tone="success" label="Called" /> : null}
                  </div>
                  {e.phone || e.note || byHand.length > 0 ? (
                    <p className="text-base text-muted">{[e.phone, e.note, ...byHand].filter(Boolean).join(' · ')}</p>
                  ) : null}
                  {stuck ? <p role="status" className="mt-1 text-base font-semibold text-warning-ink">{`${SEAT_LINK_NOT_SAVED} (Stand ${stuck.standLabel})`}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {stuck ? (
                      <>
                        <button type="button" className={SECONDARY} disabled={!ready || busy} onClick={() => void retry(e, stuck)}>
                          Retry
                        </button>
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => setSheet({ kind: 'dismiss', e })}>
                          Dismiss
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={SECONDARY} disabled={seat.disabled} title={seat.hint ?? undefined} aria-label={`Seat ${nameOf(e)}`} onClick={() => openSeat(e)}>
                          Seat
                        </button>
                        <button type="button" className={SECONDARY} disabled={!ready || busy || e.status === 'called'} onClick={() => call(e)}>
                          Call
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={!ready || busy}
                      aria-label={`Remove ${nameOf(e)} from the line`}
                      onClick={() => {
                        setProblem(null);
                        setSheet({ kind: 'remove', e });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  {seat.hint && !stuck ? <p className="mt-2 text-sm text-muted">{seat.hint}</p> : null}
                </li>
              );
            })}
          </ul>

          <Dialog open={sheet?.kind === 'walkin'} onClose={close} title="Add walk-in" description="Put a customer on the waiting line. They get a code." size="md">
            <div className="flex flex-col gap-3">
              <input className={FIELD} {...NAME_ATTRS} aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              <div className="flex items-center gap-2">
                <span className="text-base text-ink">Guests</span>
                <button type="button" className={STEP} aria-label="One fewer guest" disabled={saving || party <= 1} onClick={() => setParty((p) => Math.max(1, p - 1))}>
                  −
                </button>
                <span className="min-w-10 text-center text-xl font-semibold tabular-nums text-ink" aria-live="polite">
                  {party}
                </span>
                <button type="button" className={STEP} aria-label="One more guest" disabled={saving || party >= 30} onClick={() => setParty((p) => Math.min(30, p + 1))}>
                  +
                </button>
              </div>
              <input className={FIELD} {...PHONE_ATTRS} aria-label="Phone number" placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+\-\s]/g, ''))} />
              <input className={FIELD} {...NOTE_ATTRS} aria-label="Note" placeholder="Note (optional): birthday, window seat" value={note} onChange={(e) => setNote(e.target.value)} />
              {problem ? <Banner tone="error">{problem}</Banner> : null}
              <button type="button" className={PRIMARY} disabled={saving || !checkAll(POS_LOBBY_WALKIN_RULES, { displayName: name, phone, note }).ok} onClick={saveWalkIn}>
                Add to the line
              </button>
            </div>
          </Dialog>

          <Dialog open={sheet?.kind === 'remove'} onClose={close} title={sheet?.kind === 'remove' ? `Remove ${nameOf(sheet.e)}?` : 'Remove'} description="They will no longer be on this list." size="sm">
            {sheet?.kind === 'remove' ? (
              <div className="flex flex-col gap-3">
                {problem ? <Banner tone="error">{problem}</Banner> : null}
                <button type="button" className={PRIMARY} disabled={saving} onClick={() => confirmRemove(sheet.e)}>
                  Remove from the line
                </button>
                <button type="button" className={SECONDARY} disabled={saving} onClick={close}>
                  Keep them
                </button>
              </div>
            ) : null}
          </Dialog>

          <Dialog open={sheet?.kind === 'dismiss'} onClose={close} title={sheet?.kind === 'dismiss' ? `Dismiss the note for ${nameOf(sheet.e)}?` : 'Dismiss'} description="A table is already open for this party. Dismiss only hides this note — do not seat them again." size="sm">
            {sheet?.kind === 'dismiss' ? (
              <div className="flex flex-col gap-3">
                <button type="button" className={PRIMARY} onClick={() => dismiss(sheet.e)}>
                  Dismiss the note
                </button>
                <button type="button" className={SECONDARY} onClick={close}>
                  Keep it
                </button>
              </div>
            ) : null}
          </Dialog>
        </div>
      </div>
    </>
  );
}

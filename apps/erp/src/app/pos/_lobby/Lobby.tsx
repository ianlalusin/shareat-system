'use client';

/**
 * T-644 S1 - the Lobby tab: the waiting line (walk-ins and diners checked in on their phones) with Call, Remove (after a confirm), Pause / Resume the diner
 * check-in, and Add walk-in. A code keypad narrows the line by code, tap only. No Seat yet (S2). Online only: the list comes from the shell's poll
 * (`use-lobby-poll.ts`, every tab, so the `pos_seen_at` stamp keeps diners able to check in); every move is a Server Action (`../lobby/actions.ts`).
 * Same sheets, touch sizes and wording as the Reservations tab. Nothing here decides: the server judges every rule.
 */
import { useMemo, useState } from 'react';
import { checkAll, nativeAttrs, POS_LOBBY_WALKIN_RULES } from '@shareat/domain/field-rules';
import { Badge, Banner, Dialog } from '@/components/ui';
import { usePos } from '../_shell/pos-context';
import { Keypad } from '../_shell/Keypad';
import { callEntryAction, parkWalkInAction, removeEntryAction, setLobbyPausedAction } from '../lobby/actions';
import { byHandLines, filterByCode, keypadPress, LOBBY_NEEDS_INTERNET, LOBBY_NOT_PAIRED, lobbyRowSummary, type LobbyEntryView, type LobbyResult } from './logic';

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-2xl border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

// The walk-in fields' own rules (name 1 to 40, phone up to 30, note up to 60): the same set the server asserts.
const NAME_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.displayName);
const PHONE_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.phone);
const NOTE_ATTRS = nativeAttrs(POS_LOBBY_WALKIN_RULES.note);

type Sheet = { kind: 'walkin' } | { kind: 'remove'; e: LobbyEntryView };
const nameOf = (e: LobbyEntryView) => e.displayName?.trim() || e.code;

export function Lobby() {
  const pos = usePos();
  const [digits, setDigits] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Add walk-in
  const [name, setName] = useState('');
  const [party, setParty] = useState(2);
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  const list = pos?.lobby?.list ?? null;
  const entries = list?.entries ?? [];
  const shown = useMemo(() => filterByCode(entries, digits), [entries, digits]);
  if (!pos) return null;
  const storeId = pos.storeId;
  const online = pos.online;
  const ready = pos.paired && online && storeId !== null;
  const refresh = () => void pos.lobby?.refresh();
  const now = Date.now();

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

  const pausedNow = list?.lobbyEnabled === true && list.paused;

  return (
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
      {entries.length > 0 && shown.length === 0 ? <p className="text-base text-muted">No one with that code.</p> : null}
      <ul className="flex flex-col gap-3">
        {shown.map((e) => {
          const busy = busyId === e.entryId;
          const byHand = byHandLines(e);
          return (
            <li key={e.entryId} className="rounded-2xl border border-surface-border bg-surface p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-base font-semibold text-ink">{lobbyRowSummary(e, now)}</p>
                {e.status === 'called' ? <Badge tone="success" label="Called" /> : null}
              </div>
              {e.phone || e.note || byHand.length > 0 ? (
                <p className="text-base text-muted">{[e.phone, e.note, ...byHand].filter(Boolean).join(' · ')}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={SECONDARY} disabled={!ready || busy || e.status === 'called'} onClick={() => call(e)}>
                  Call
                </button>
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
    </div>
  );
}

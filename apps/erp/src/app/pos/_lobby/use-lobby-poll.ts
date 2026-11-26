'use client';

/**
 * T-644 S1 - the shell-level lobby poll. Mounted by `PosShell`, so it runs while the POS is open on ANY tab (not only Lobby): every list read stamps
 * `lobby_stores.pos_seen_at`, and without that stamp diners cannot check in (5-minute window, checkin.ts). One request in flight at a time (`createLobbyPoller`).
 * It runs only when `enabled` (a paired tablet, online, record_sale); the Lobby tab reads the result from `PosContext`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { approvedClaimsForSessionAction, listLobbyAction } from '../lobby/actions';
import { loadApprovedClaims, type ApprovedClaimView } from './claims';
import { createLobbyPoller, LOBBY_IDLE, LOBBY_POLL_MS, type LobbyPollState } from './logic';

export interface LobbyPoll extends LobbyPollState {
  refresh: () => Promise<void>;
  /** T-644 S4 (ruling 6): the senior / PWD claims approved for one table session, for the paying screen. Never throws; no answer is an empty list. */
  approvedClaims: (sessionId: string) => Promise<ApprovedClaimView[]>;
}

export function useLobbyPoll({ enabled, storeId }: { enabled: boolean; storeId: string | null }): LobbyPoll {
  const [state, setState] = useState<LobbyPollState>(LOBBY_IDLE);
  const poller = useMemo(
    () =>
      createLobbyPoller({
        list: () => listLobbyAction({ storeId: storeId ?? '' }),
        apply: (o) => setState((s) => ('list' in o ? { list: o.list, loaded: true, error: null } : { ...s, error: o.error })),
      }),
    [storeId],
  );
  const live = enabled && storeId !== null;
  useEffect(() => {
    if (!live) return;
    void poller.poll();
    const t = setInterval(() => void poller.poll(), LOBBY_POLL_MS);
    return () => clearInterval(t);
  }, [live, poller]);
  const refresh = useCallback(() => poller.poll(), [poller]);
  const approvedClaims = useCallback((sessionId: string) => loadApprovedClaims((id) => approvedClaimsForSessionAction({ sessionId: id }), sessionId), []);
  return { ...state, refresh, approvedClaims };
}

'use client';

/**
 * T-527 - what the shell hands down to a tab: the store, the polled lists, the outbox as it stands, the cached menu, and the ways to send. The shell owns
 * every one of these (one poll, one drain); a tab only reads them. A tab outside the shell (a test) gets `null`, and the Orders tab then shows nothing.
 */
import { createContext, useContext, type MutableRefObject } from 'react';
import type { PosEvent, PosEventResult } from '@/lib/pos-device';
import type { SessionBody } from '../_orders/project';
import type { SnapshotOrdersPart } from './use-device-sync';

export interface PosContextValue {
  storeId: string | null;
  /** A live pairing: this is the store tablet. A phone or a kitchen browser is not (row 447: it reads orders, it does not take them). */
  paired: boolean;
  /** The signed-in person; offline, `offlineActorPersonId` takes over (T-526 R5). */
  personId: string;
  offlineActorPersonId: string | null;
  /** The name of whoever is selling now (the offline cashier when there is one): the receipt's CASHIER line. */
  personName?: string;
  online: boolean;
  /** The state poll's open stands (T-524 `listOpenStands` rows); null until the first answer, or when this person may not read them. */
  openStands: unknown[] | null;
  stateVersion: number | null;
  pendingEvents: PosEvent[];
  ordersSnapshot: SnapshotOrdersPart | null;
  /** The table bodies the Orders tab has fetched, written by it and read by the shell's refusal notice (a cancelled line names its stand from here). */
  bodiesRef: MutableRefObject<Record<string, SessionBody | undefined>>;
  requestDrain: () => void;
  setResultsHandler: (handler: ((sent: PosEvent[], results: PosEventResult[]) => void) | null) => void;
}

export const PosContext = createContext<PosContextValue | null>(null);
export const usePos = (): PosContextValue | null => useContext(PosContext);

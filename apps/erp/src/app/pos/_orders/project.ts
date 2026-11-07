/**
 * T-527 R1 - the local view of the Orders tab: the server's last open-stand list and cached table bodies, with the outbox's pending events on top.
 * Pure. It never invents a server fact; an event the outbox has removed (applied, duplicate, quarantined, conflict) is simply not in `pending` any more,
 * so it stops being applied. docs/tasks/527-pos-orders-screen.md.
 */
import type { ProjectedStoreMenu, StoreMenuV2 } from '@shareat/domain';
import type { PosEvent, PosEventResult } from '@/lib/pos-device';
import { POS_TILE_WARN_AFTER_MINUTES } from '../_shell/constants';
import { offlineFor } from '../_shell/status-pill';
import { asStoreMenu, displayUnitPrice } from './menu-filter';

export interface ServerStand {
  sessionId: string;
  standId: string | null;
  standNumber: number | null;
  mode: string;
  headsCashier: number;
  headsServer: number | null;
  openedAtDevice: string;
}
export interface ServerLine {
  id: string;
  kind: string;
  name: string;
  qty: number;
  unitPrice: string | null;
  kitchenStatus: string;
  bundleHeads: number | null;
  /** Added by T-527; an older body has neither. The `name` already carries the chosen options as the server wrote it. */
  menuItemId?: string;
  note?: string | null;
}
export interface SessionBody {
  session: { id: string; mode: string; standId: string | null; status: string; headsCashier: number; headsServer: number | null };
  lines: ServerLine[];
}
export interface OrdersServer {
  openStands: ServerStand[] | null;
  sessions: Record<string, SessionBody | undefined>;
}
export interface OrdersSnapshot {
  stands: { id: string; number: number }[];
  menu: StoreMenuV2 | ProjectedStoreMenu;
}

export interface Tile {
  sessionId: string;
  standId: string | null;
  standNumber: number | null;
  mode: string;
  headsCashier: number;
  headsServer: number | null;
  openedAtDevice: string;
  packageName: string | null;
  needsHeads: boolean;
  /** The tile exists ONLY because of a pending stand.opened. */
  pending: boolean;
}
export interface ProjectedLine {
  id: string;
  name: string;
  qty: number;
  unitPrice: string | null;
  kitchenStatus: string;
  note: string | null;
  optionNames: string[];
  pending: boolean;
  cancelled: boolean;
}
export interface ProjectedSession {
  headsCashier: number;
  headsServer: number | null;
  /** False until the table's own body has arrived: the panel says so instead of showing an empty list as a fact. */
  loaded: boolean;
  lines: ProjectedLine[];
}
export interface OrdersView {
  tiles: Tile[];
  sessions: Record<string, ProjectedSession>;
}

const BUNDLE_SUFFIX = / \((?:up to \d+|extra head)\)$/;

interface Work extends ProjectedSession {
  kinds: Map<string, string>;
}
type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function projectOrders(server: OrdersServer, pending: readonly PosEvent[], snapshot: OrdersSnapshot | null): OrdersView {
  const menu = snapshot ? asStoreMenu(snapshot.menu) : null;
  const tiles = new Map<string, Tile>();
  const work = new Map<string, Work>();

  for (const s of server.openStands ?? []) {
    tiles.set(s.sessionId, { ...s, packageName: null, needsHeads: false, pending: false });
    const body = server.sessions[s.sessionId];
    const kinds = new Map<string, string>();
    work.set(s.sessionId, {
      headsCashier: s.headsCashier,
      headsServer: s.headsServer,
      loaded: body !== undefined,
      kinds,
      lines: (body?.lines ?? []).map((l): ProjectedLine => {
        kinds.set(l.id, l.kind);
        return {
          id: l.id,
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          kitchenStatus: l.kitchenStatus,
          note: l.note ?? null,
          optionNames: [],
          pending: false,
          cancelled: false,
        };
      }),
    });
  }

  const pendingLine = (raw: unknown): { line: ProjectedLine; kind: string } | null => {
    const l = raw as Payload | null;
    const id = str(l?.lineId);
    if (!l || !id) return null;
    const item = menu?.items.find((i) => i.id === l.menuItemId);
    const variant = item?.variants.find((v) => v.id === l.variantId) ?? item?.variants.find((v) => v.isDefault) ?? item?.variants[0];
    const chosen = Array.isArray(l.optionValueIds) ? (l.optionValueIds as string[]) : [];
    const optionNames = variant ? variant.optionGroups.flatMap((g) => g.values.filter((v) => chosen.includes(v.id)).map((v) => v.name)) : [];
    return {
      kind: item?.itemType === 'package' ? 'package' : 'item',
      line: {
        id,
        name: item ? `${item.name}${variant?.label ? ` - ${variant.label}` : ''}` : 'Item',
        qty: typeof l.qty === 'number' ? l.qty : 1,
        unitPrice: variant ? displayUnitPrice(variant, chosen) : null,
        kitchenStatus: 'queued',
        note: str(l.note),
        optionNames,
        pending: true,
        cancelled: false,
      },
    };
  };
  const addPending = (w: Work, raws: unknown) => {
    for (const raw of Array.isArray(raws) ? raws : []) {
      const made = pendingLine(raw);
      if (!made || w.lines.some((x) => x.id === made.line.id)) continue; // the server already holds it: shown once, not marked pending
      w.lines.push(made.line);
      w.kinds.set(made.line.id, made.kind);
    }
  };

  for (const e of pending) {
    const p = e.payload as Payload;
    const sessionId = str(p.sessionId);
    if (e.kind === 'stand.opened' && sessionId) {
      if (!tiles.has(sessionId)) {
        const standId = str(p.standId);
        const heads = typeof p.headsCashier === 'number' ? p.headsCashier : 0;
        tiles.set(sessionId, {
          sessionId,
          standId,
          standNumber: snapshot?.stands.find((s) => s.id === standId)?.number ?? null,
          mode: str(p.mode) ?? 'dine_in',
          headsCashier: heads,
          headsServer: null,
          openedAtDevice: str(p.openedAtDevice) ?? e.occurredAtDevice,
          packageName: null,
          needsHeads: false,
          pending: true,
        });
        work.set(sessionId, { headsCashier: heads, headsServer: null, loaded: true, kinds: new Map(), lines: [] });
      }
      addPending(work.get(sessionId)!, p.lines);
    } else if (e.kind === 'lines.added' && sessionId && work.has(sessionId)) {
      addPending(work.get(sessionId)!, p.lines);
    } else if (e.kind === 'heads.set' && sessionId && work.has(sessionId) && typeof p.headsCashier === 'number') {
      work.get(sessionId)!.headsCashier = p.headsCashier;
    } else if (e.kind === 'line.cancelled') {
      const lineId = str(p.lineId);
      for (const w of work.values()) {
        const line = w.lines.find((l) => l.id === lineId);
        if (line) line.cancelled = true;
      }
    }
  }

  const sessions: Record<string, ProjectedSession> = {};
  const out: Tile[] = [];
  for (const [id, t] of tiles) {
    const w = work.get(id)!;
    const pkg = w.lines.find((l) => w.kinds.get(l.id) === 'package' && !l.cancelled);
    const packageName = pkg ? pkg.name.replace(BUNDLE_SUFFIX, '') : null;
    out.push({ ...t, headsCashier: w.headsCashier, packageName, needsHeads: t.mode === 'dine_in' && packageName !== null && t.headsServer === null });
    sessions[id] = { headsCashier: w.headsCashier, headsServer: w.headsServer, loaded: w.loaded, lines: w.lines };
  }
  out.sort((a, b) => Date.parse(a.openedAtDevice) - Date.parse(b.openedAtDevice) || a.sessionId.localeCompare(b.sessionId));
  return { tiles: out, sessions };
}

/** The seat dialog's stand grid: every snapshot stand in number order; one with a tile on it (a pending one too) cannot be tapped. */
export function seatStandChoices(stands: readonly { id: string; number: number }[], tiles: readonly Tile[]): { id: string; number: number; inUse: boolean }[] {
  return [...stands].sort((a, b) => a.number - b.number).map((s) => ({ id: s.id, number: s.number, inUse: tiles.some((t) => t.standId === s.id) }));
}

export function tileClock(openedAtDevice: string, nowMs: number): { minutes: number; label: string; warn: boolean } {
  const ms = Math.max(0, nowMs - Date.parse(openedAtDevice));
  const minutes = Math.floor(ms / 60_000);
  return { minutes, label: offlineFor(ms), warn: minutes > POS_TILE_WARN_AFTER_MINUTES };
}

/** One sentence per QUARANTINED result, naming the stand. `view` is the one computed while the events were still in the outbox. */
export function refusalNotices(sent: readonly PosEvent[], results: readonly PosEventResult[], view: OrdersView): string[] {
  const notices: string[] = [];
  for (const r of results) {
    if (r.status !== 'quarantined') continue;
    const event = sent.find((e) => e.seq === r.seq);
    const p = (event?.payload ?? {}) as Payload;
    const sessionId = str(p.sessionId) ?? Object.keys(view.sessions).find((id) => view.sessions[id]!.lines.some((l) => l.id === str(p.lineId)));
    const tile = view.tiles.find((t) => t.sessionId === sessionId);
    const where = !tile ? 'A change' : tile.standNumber !== null ? `A change to Stand ${tile.standNumber}` : 'A change to Take-out';
    notices.push(`${where} was refused. A manager will see it.`);
  }
  return notices;
}

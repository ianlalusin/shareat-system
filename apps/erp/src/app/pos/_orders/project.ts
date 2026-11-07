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
  /** T-527b: when the line was added (device time); the list is ordered by it so it never reshuffles. */
  addedAtDevice?: string;
  /** T-528: the line's ACTIVE discounts, in creation order (getSessionBill). An older body has none. */
  discounts?: ServerDiscount[];
}
export interface ServerDiscount {
  id: string;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  valueType: 'percent' | 'fixed';
  value: string;
  qty: number;
  dinerNo: number | null;
  presetId: string | null;
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
  /** A dine-in package table whose server count is still null: shown as quiet text, never a pill (no time threshold: that would be a business value). */
  needsHeads: boolean;
  /** The server counted a different number than the cashier: the one amber pill, "Heads 4 vs 5". */
  headsMismatch: boolean;
  /** The tile exists ONLY because of a pending stand.opened. */
  pending: boolean;
  /** T-528: a sale.completed for this table is still in the outbox: "Paid, sending". Present only then. */
  paid?: true;
}
export interface ProjectedLine {
  id: string;
  name: string;
  qty: number;
  unitPrice: string | null;
  kitchenStatus: string;
  note: string | null;
  optionNames: string[];
  /** A pending event touches this line (added, cancelled, or a package line re-made by a heads change): the sending dot. */
  pending: boolean;
  cancelled: boolean;
  addedAtDevice: string | null;
  /** Only on the line the screen adds for the difference when a served package gets more heads: it is not a server line, so it cannot be cancelled. */
  extraHeads?: true;
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

const time = (iso: string | null): number => {
  const t = iso === null ? 0 : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};
// plain code-unit order (the default sort) = Postgres' uuid order; no relational operator on a string (T-371 G2)
const byId = (x: string, y: string): number => (x === y ? 0 : [x, y].sort()[0] === x ? -1 : 1);
const byPlace = (a: ProjectedLine, b: ProjectedLine): number => time(a.addedAtDevice) - time(b.addedAtDevice) || byId(a.id, b.id);
const BUNDLE_SUFFIX = / \((?:up to \d+|extra head)\)$/;

interface Work extends ProjectedSession {
  kinds: Map<string, string>;
  /** Lines that are a bundle's flat line (its qty is not the heads). */
  bundles: Set<string>;
  /** A pending heads.set touches this table: its package line is being re-made by the server. */
  headsPending: boolean;
  /** Device time of the last pending heads.set: where a pending extra-heads line sits in the list. */
  headsAt: string | null;
}
type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A line the tablet saw on a table's last body; kept only while a cancel of it is on screen, so the line can stay struck through until the server confirms. */
export interface GhostLine {
  sessionId: string;
  line: ServerLine;
}

/**
 * Lines are ordered by `addedAtDevice`, then `lineId`, always (T-527b): a server body that replaces a pending line has the same key, so nothing jumps.
 * `ghosts` are the last-seen lines for cancels still on screen (see `GhostLine`).
 */
export function projectOrders(server: OrdersServer, pending: readonly PosEvent[], snapshot: OrdersSnapshot | null, ghosts: readonly GhostLine[] = []): OrdersView {
  const menu = snapshot ? asStoreMenu(snapshot.menu) : null;
  const tiles = new Map<string, Tile>();
  const work = new Map<string, Work>();

  const fromServer = (l: ServerLine): ProjectedLine => ({
    id: l.id,
    name: l.name,
    qty: l.qty,
    unitPrice: l.unitPrice,
    kitchenStatus: l.kitchenStatus,
    note: l.note ?? null,
    optionNames: [],
    pending: false,
    cancelled: false,
    addedAtDevice: l.addedAtDevice ?? null,
  });
  for (const s of server.openStands ?? []) {
    tiles.set(s.sessionId, { ...s, packageName: null, needsHeads: false, headsMismatch: false, pending: false });
    const body = server.sessions[s.sessionId];
    const kinds = new Map<string, string>();
    const bundles = new Set<string>();
    work.set(s.sessionId, {
      headsCashier: s.headsCashier,
      headsServer: s.headsServer,
      loaded: body !== undefined,
      kinds,
      bundles,
      headsPending: false,
      headsAt: null,
      lines: (body?.lines ?? []).map((l) => {
        kinds.set(l.id, l.kind);
        if (l.bundleHeads !== null && l.bundleHeads > 1) bundles.add(l.id);
        return fromServer(l);
      }),
    });
  }

  const pendingLine = (raw: unknown): { line: ProjectedLine; kind: string; bundle: boolean } | null => {
    const l = raw as Payload | null;
    const id = str(l?.lineId);
    if (!l || !id) return null;
    const item = menu?.items.find((i) => i.id === l.menuItemId);
    const variant = item?.variants.find((v) => v.id === l.variantId) ?? item?.variants.find((v) => v.isDefault) ?? item?.variants[0];
    const chosen = Array.isArray(l.optionValueIds) ? (l.optionValueIds as string[]) : [];
    const optionNames = variant ? variant.optionGroups.flatMap((g) => g.values.filter((v) => chosen.includes(v.id)).map((v) => v.name)) : [];
    const offer = variant?.channels.store;
    return {
      kind: item?.itemType === 'package' ? 'package' : 'item',
      bundle: offer !== undefined && offer.orderable && offer.bundleHeads !== null && offer.bundleHeads > 1,
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
        addedAtDevice: str(l.addedAtDevice),
      },
    };
  };
  const addPending = (w: Work, raws: unknown) => {
    for (const raw of Array.isArray(raws) ? raws : []) {
      const made = pendingLine(raw);
      if (!made || w.lines.some((x) => x.id === made.line.id)) continue; // the server already holds it: shown once, not marked pending
      w.lines.push(made.line);
      w.kinds.set(made.line.id, made.kind);
      if (made.bundle) w.bundles.add(made.line.id);
    }
  };

  const paidSessions = new Set<string>();
  for (const e of pending) {
    const p = e.payload as Payload;
    const sessionId = str(p.sessionId);
    if (e.kind === 'sale.completed' && sessionId) paidSessions.add(sessionId);
    else if (e.kind === 'stand.opened' && sessionId) {
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
          headsMismatch: false,
          pending: true,
        });
        work.set(sessionId, { headsCashier: heads, headsServer: null, loaded: true, kinds: new Map(), bundles: new Set(), headsPending: false, headsAt: null, lines: [] });
      }
      addPending(work.get(sessionId)!, p.lines);
    } else if (e.kind === 'lines.added' && sessionId && work.has(sessionId)) {
      addPending(work.get(sessionId)!, p.lines);
    } else if (e.kind === 'heads.set' && sessionId && work.has(sessionId) && typeof p.headsCashier === 'number') {
      work.get(sessionId)!.headsCashier = p.headsCashier;
      work.get(sessionId)!.headsPending = true;
      work.get(sessionId)!.headsAt = e.occurredAtDevice;
    } else if (e.kind === 'line.cancelled') {
      const lineId = str(p.lineId);
      let line = [...work.values()].flatMap((w) => w.lines).find((l) => l.id === lineId);
      if (!line) {
        // The server body has already dropped the line but the cancel is still being shown: bring the last-seen line back, struck through, until it lets go.
        const ghost = ghosts.find((g) => g.line.id === lineId);
        const w = ghost ? work.get(ghost.sessionId) : undefined;
        if (ghost && w) {
          line = fromServer(ghost.line);
          w.lines.push(line);
          w.kinds.set(line.id, ghost.line.kind);
        }
      }
      if (line) {
        line.cancelled = true;
        line.pending = true;
      }
    }
  }

  const sessions: Record<string, ProjectedSession> = {};
  const out: Tile[] = [];
  for (const [id, t] of tiles) {
    const w = work.get(id)!;
    w.lines.sort(byPlace);
    const packages = w.lines.filter((l) => w.kinds.get(l.id) === 'package' && !l.cancelled);
    // A heads change, as the server will do it (followHeads): billed heads = the larger of the two counts. An UNSERVED per-head package line is re-made whole
    // (same place in the list); a SERVED one is kept and only the difference is added as a new line. A bundle's flat line is never rewritten.
    const billed = Math.max(w.headsCashier, w.headsServer ?? 0);
    if (w.bundles.size === 0 && packages.length > 0 && (w.headsPending || packages.some((l) => l.pending))) {
      if (packages.some((l) => l.kitchenStatus === 'served')) {
        const covered = packages.reduce((n, l) => n + l.qty, 0);
        if (w.headsPending && billed > covered) {
          const first = packages[0]!;
          w.lines.push({ ...first, id: `pending-extra-heads-${id}`, qty: billed - covered, kitchenStatus: 'queued', note: null, pending: true, cancelled: false, addedAtDevice: w.headsAt, extraHeads: true });
        }
      } else if (packages.length === 1) {
        packages[0]!.qty = billed;
        packages[0]!.pending = true;
      }
    } else if (w.headsPending) for (const l of packages) l.pending = true;
    w.lines.sort(byPlace);
    const pkg = w.lines.find((l) => w.kinds.get(l.id) === 'package' && !l.cancelled);
    const packageName = pkg ? pkg.name.replace(BUNDLE_SUFFIX, '') : null;
    const dineIn = t.mode === 'dine_in';
    out.push({
      ...t,
      headsCashier: w.headsCashier,
      packageName,
      needsHeads: dineIn && packageName !== null && t.headsServer === null,
      headsMismatch: dineIn && t.headsServer !== null && t.headsServer !== w.headsCashier,
      ...(paidSessions.has(id) ? { paid: true as const } : {}),
    });
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

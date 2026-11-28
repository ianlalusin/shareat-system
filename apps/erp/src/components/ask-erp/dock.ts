/**
 * T-652 - where the Ask ERP tab sits. Pure (no DOM), so the snap and the clamp are unit-tested: the launcher is a slim tab docked to the left or right
 * edge that a person can drag up or down, or across; on release it snaps to the NEARER side and stays inside the visible height.
 * The position is `{ side, topPct }`: `topPct` is the tab's top edge as a percentage of the viewport height.
 */
export type DockSide = 'left' | 'right';
export interface Dock {
  side: DockSide;
  topPct: number;
}

/** Default: right edge, near the bottom (where the old round button sat). */
export const DEFAULT_DOCK: Dock = { side: 'right', topPct: 80 };
/** A pointer must travel this far (px) before a press becomes a drag; a shorter press opens the panel. */
export const DRAG_THRESHOLD_PX = 6;
export const DOCK_STORAGE_KEY = 'shareat.askErpDock';

export interface SnapInput {
  /** Pointer position (px) at release. */
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Space to keep clear at the top (the phone TopBar) and bottom (px), and the tab's own height (px). */
  topInset: number;
  bottomInset: number;
  tabHeight: number;
  /** Where inside the tab the pointer grabbed it (px from the tab's top), so the tab does not jump under the finger. */
  grabOffsetY?: number;
}

/** The nearer side wins; a pointer exactly in the middle goes right. The top edge is clamped so the tab is fully visible and clear of both insets. */
export function snapDock(i: SnapInput): Dock {
  const side: DockSide = i.x < i.viewportWidth / 2 ? 'left' : 'right';
  const minTop = i.topInset;
  const maxTop = Math.max(minTop, i.viewportHeight - i.bottomInset - i.tabHeight);
  const wanted = i.y - (i.grabOffsetY ?? i.tabHeight / 2);
  const top = Math.min(maxTop, Math.max(minTop, wanted));
  return { side, topPct: i.viewportHeight > 0 ? (top / i.viewportHeight) * 100 : DEFAULT_DOCK.topPct };
}

/** A stored value from localStorage, or the default when it is missing, not JSON, or the wrong shape. Never throws. */
export function parseDock(raw: string | null): Dock {
  if (raw === null) return DEFAULT_DOCK;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return DEFAULT_DOCK;
    const { side, topPct } = v as { side?: unknown; topPct?: unknown };
    if ((side !== 'left' && side !== 'right') || typeof topPct !== 'number' || !Number.isFinite(topPct)) return DEFAULT_DOCK;
    return { side, topPct: Math.min(95, Math.max(0, topPct)) };
  } catch {
    return DEFAULT_DOCK;
  }
}

export function readDock(): Dock {
  try {
    return parseDock(window.localStorage.getItem(DOCK_STORAGE_KEY));
  } catch {
    return DEFAULT_DOCK;
  }
}

export function writeDock(d: Dock): void {
  try {
    window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(d));
  } catch {
    /* private mode or storage full: the tab simply returns to its default next visit */
  }
}

/** True once the pointer has moved past the threshold from where it went down. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

/** Bottom padding `<main>` gets while the launcher renders: the tab's height plus its offset, so the last control on a page can scroll clear of it. */
export const ASK_ERP_CLEARANCE = 'pb-24';

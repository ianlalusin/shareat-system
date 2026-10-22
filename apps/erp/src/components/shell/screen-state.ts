/** Presentation only. Never snapshot controls, record contents, credentials or router history state. */
type Point = { x: number; y: number };
type Snapshot = Point & { details: Record<string, boolean>; cards: string[]; panels: Record<string, Point> };
type Pages = Record<string, Snapshot>;
const PANEL = '[data-screen-scroll],.catalogue-table,.overflow-auto,.overflow-x-auto,.overflow-y-auto';
const point = (value: unknown): value is Point => Boolean(value && typeof value === 'object'
  && 'x' in value && typeof value.x === 'number' && Number.isFinite(value.x)
  && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y));
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function snapshot(value: unknown): value is Snapshot {
  return point(value) && 'details' in value && record(value.details) && Object.values(value.details).every(v => typeof v === 'boolean')
    && 'cards' in value && Array.isArray(value.cards) && value.cards.every(v => typeof v === 'string')
    && 'panels' in value && record(value.panels) && Object.values(value.panels).every(point);
}
const validPath = (path: string) => path.startsWith('/') && !path.startsWith('//') && !/[\\#\s]/.test(path);
function read(win: Window, key: string): Pages {
  try {
    const raw = win.sessionStorage.getItem(key);
    if (!raw || raw.length > 250_000) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Snapshot] => validPath(entry[0]) && snapshot(entry[1])).slice(-30));
  } catch { return {}; }
}
function locationKey(win: Window): string {
  const query = new URLSearchParams(win.location.search);
  for (const name of ['f', 'ok', 'error', 'warning', 'notice', 'token', 'password']) query.delete(name);
  const search = query.toString();
  return win.location.pathname + (search ? `?${search}` : '');
}
const panels = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(PANEL));
const panelKey = (panel: HTMLElement, index: number) => panel.dataset.screenScroll || panel.id || String(index);
const rows = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLTableRowElement>('tr[data-card-kind="summary"]'));
function rowKey(row: HTMLTableRowElement, index: number): string {
  const table = row.closest('table');
  const tableIndex = table ? Array.from(row.ownerDocument.querySelectorAll('main table')).indexOf(table) : 0;
  return `${tableIndex}:${row.querySelector('a[href]')?.getAttribute('href') ?? index}`;
}
function capture(root: HTMLElement, win: Window): Snapshot {
  return { x: win.scrollX, y: win.scrollY,
    details: Object.fromEntries(Array.from(root.querySelectorAll('details')).map((item, index) => [item.id || String(index), item.open])),
    cards: rows(root).flatMap((row, index) => row.hasAttribute('data-card-expanded') ? [rowKey(row, index)] : []),
    panels: Object.fromEntries(panels(root).map((panel, index) => [panelKey(panel, index), { x: panel.scrollLeft, y: panel.scrollTop }])),
  };
}
function restore(root: HTMLElement, win: Window, state: Snapshot) {
  root.querySelectorAll('details').forEach((item, index) => {
    const open = state.details[item.id || String(index)];
    if (open !== undefined && item.open !== open) item.open = open;
  });
  rows(root).forEach((row, index) => {
    const expanded = state.cards.includes(rowKey(row, index));
    row.toggleAttribute('data-card-expanded', expanded);
    row.querySelector('[data-card-toggle]')?.setAttribute('aria-expanded', String(expanded));
  });
  panels(root).forEach((panel, index) => {
    const saved = state.panels[panelKey(panel, index)];
    if (saved) { panel.scrollLeft = saved.x; panel.scrollTop = saved.y; }
  });
  win.scrollTo({ left: state.x, top: state.y, behavior: 'instant' });
}

/** Mounted once per URL; cached state belongs to this account and this browser tab. */
export function rememberScreen(root: HTMLElement, scope: string): () => void {
  const win = root.ownerDocument.defaultView;
  if (!win) return () => {};
  const key = `erp-screen:${scope}`, url = locationKey(win), pages = read(win, key);
  const saved = win.location.hash ? undefined : pages[url];
  let restoring = Boolean(saved), disposed = false;
  const write = () => {
    if (disposed || locationKey(win) !== url || restoring) return;
    delete pages[url]; pages[url] = capture(root, win);
    try { win.sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(pages).slice(-30)))); } catch { /* Storage is optional. */ }
  };
  let pending: number | undefined;
  const cancelPending = () => { if (pending !== undefined) { win.clearTimeout(pending); pending = undefined; } };
  const flush = () => { cancelPending(); write(); };
  const schedule = () => { if (pending === undefined) pending = win.setTimeout(() => { pending = undefined; write(); }, 250); };
  const returnLinks = () => root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => {
    // Existing detail-page ancestor links share the same behavior without per-page copies.
    if (!link.hasAttribute('data-screen-return') && !link.textContent?.trim().startsWith('←')) return;
    let target: URL;
    try { target = new URL(link.getAttribute('href') ?? '', win.location.href); } catch { return; }
    if (target.origin !== win.location.origin || target.search || target.hash) return;
    if (!win.location.pathname.startsWith(`${target.pathname}/`)) return;
    const previous = Object.keys(pages).reverse().find(path => new URL(path, win.location.origin).pathname === target.pathname);
    if (previous) link.setAttribute('href', previous);
  });
  returnLinks();
  const apply = () => { if (restoring && saved && !disposed && locationKey(win) === url) restore(root, win, saved); returnLinks(); };
  const observer = new win.MutationObserver(apply);
  const resize = win.ResizeObserver ? new win.ResizeObserver(apply) : undefined;
  const timers: number[] = [];
  const stopRestoring = () => { restoring = false; resize?.disconnect(); timers.splice(0).forEach(id => win.clearTimeout(id)); };
  if (saved) {
    observer.observe(root, { childList: true, subtree: true }); resize?.observe(root);
    apply(); [0, 80, 250, 800].forEach(delay => timers.push(win.setTimeout(apply, delay)));
    // Slow streamed sections may arrive later; their observer remains until interaction or navigation.
  } else observer.observe(root, { childList: true, subtree: true });
  const interact = () => { stopRestoring(); };
  const click = () => { stopRestoring(); flush(); win.queueMicrotask(write); };
  win.addEventListener('scroll', schedule, true);
  root.addEventListener('toggle', flush, true);
  root.addEventListener('click', click, true);
  win.addEventListener('pagehide', flush);
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) win.addEventListener(event, interact, { passive: true });
  return () => {
    flush(); disposed = true; stopRestoring(); observer.disconnect();
    win.removeEventListener('scroll', schedule, true); root.removeEventListener('toggle', flush, true);
    root.removeEventListener('click', click, true); win.removeEventListener('pagehide', flush);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) win.removeEventListener(event, interact);
  };
}

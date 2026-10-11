/**
 * T-392 S1 - the keys sheet (spec R7): the v1 -> v2 key map Ian ticks. Pre-fill suggests ONLY on an exact normalised
 * name match and never ticks; a re-run keeps every row Ian touched. Pure.
 */
import type { V1Snapshot } from './snapshot';

export type KeySection = 'store' | 'money' | 'category';
export interface KeyRow {
  section: KeySection;
  v1Store: string;
  v1Key: string;
  v1Label: string;
  v2Key: string;
  ticked: boolean;
}
export interface V2KeyCatalogue {
  stores: { key: string; name: string }[];
  money: { key: string; name: string }[];
  categories: { key: string; name: string }[];
}

const HEADER = ['section', 'v1_store', 'v1_key', 'v1_label', 'v2_key', 'ticked'];
const SECTION_ORDER: Record<string, number> = { store: 0, money: 1, category: 2 };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const rowId = (r: { section: string; v1Store: string; v1Key: string }): string => `${r.section}|${r.v1Store}|${r.v1Key}`;

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function serialiseKeysCsv(rows: KeyRow[]): string {
  const out = [HEADER.join(',')];
  for (const r of rows) {
    out.push([r.section, r.v1Store, r.v1Key, r.v1Label, r.v2Key, r.ticked ? 'Y' : ''].map(quote).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

/** RFC-4180 reader: quoted cells, doubled quotes, embedded newlines; LF or CRLF row ends. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function parseKeysCsv(text: string): KeyRow[] {
  const rows = readCsv(text);
  const head = rows.shift();
  if (!head || HEADER.some((h, i) => (head[i] ?? '').trim().toLowerCase() !== h)) {
    throw new Error(`keys csv: header must be ${HEADER.join(',')}`);
  }
  return rows.map((r, n) => {
    const section = (r[0] ?? '').trim();
    if (section !== 'store' && section !== 'money' && section !== 'category') {
      throw new Error(`keys csv: row ${n + 2} has unknown section ${JSON.stringify(section)}`);
    }
    return {
      section, v1Store: r[1] ?? '', v1Key: r[2] ?? '', v1Label: r[3] ?? '', v2Key: r[4] ?? '',
      ticked: (r[5] ?? '').trim().toUpperCase() === 'Y',
    };
  });
}

/** Every v1 key seen in the snapshot, once, with a name-match suggestion; existing rows are kept exactly as left. */
export function prefillKeys(input: { snapshot: V1Snapshot; existing: KeyRow[]; v2: V2KeyCatalogue }): KeyRow[] {
  const { snapshot, existing, v2 } = input;
  const suggest = (list: { key: string; name: string }[], label: string): string =>
    list.find((c) => norm(c.name) === norm(label))?.key ?? '';

  const fresh = new Map<string, KeyRow>();
  const put = (section: KeySection, v1Store: string, v1Key: string, v1Label: string, list: { key: string; name: string }[]): void => {
    const row: KeyRow = { section, v1Store, v1Key, v1Label, v2Key: suggest(list, v1Label), ticked: false };
    if (!fresh.has(rowId(row))) fresh.set(rowId(row), row);
  };

  const storeIds = new Set(snapshot.stores.map((s) => s.id));
  for (const s of snapshot.stores) put('store', '', s.id, s.name, v2.stores);

  const accountName = (storeId: string, accountId: string): string => {
    const raw = accountId.replace(/^online__/, '');
    const pa = snapshot.paymentAccounts.find((a) => a.storeId === storeId && a.id === raw);
    if (pa && accountId.startsWith('online__')) return pa.name;
    return accountId.replace('__', ' ').replace(/_/g, ' ');
  };
  for (const l of snapshot.journal) {
    if (storeIds.has(l.storeId) && (l.accountId.startsWith('cash__') || l.accountId.startsWith('online__'))) {
      put('money', l.storeId, l.accountId, accountName(l.storeId, l.accountId), v2.money);
    }
  }
  for (const a of snapshot.paymentAccounts) {
    if (storeIds.has(a.storeId)) put('money', a.storeId, `online__${a.id}`, a.name, v2.money);
  }
  for (const d of snapshot.salesDays) {
    if (!storeIds.has(d.storeId)) continue;
    for (const w of Object.keys(d.onlineBreakdown)) put('money', d.storeId, `online__${w}`, accountName(d.storeId, `online__${w}`), v2.money);
  }
  for (const e of snapshot.expenses) {
    if (storeIds.has(e.storeId) && e.expenseEntryId) put('category', e.storeId, e.expenseEntryId, e.category, v2.categories);
  }

  const kept = new Map<string, KeyRow>();
  for (const r of existing) kept.set(rowId(r), r);
  for (const [id, r] of fresh) if (!kept.has(id)) kept.set(id, r);
  return [...kept.values()].sort(
    (a, b) => (SECTION_ORDER[a.section]! - SECTION_ORDER[b.section]!) || cmp(a.v1Store, b.v1Store) || cmp(a.v1Key, b.v1Key),
  );
}

/** Every operating v1 store must have a ticked store row with a v2 key; a skipped store is a refusal, not a gap. */
export function assertStoresTicked(rows: KeyRow[], v1StoreIds: string[]): void {
  const problems: string[] = [];
  for (const id of v1StoreIds) {
    const row = rows.find((r) => r.section === 'store' && r.v1Key === id);
    if (!row) problems.push(`${id}: no store row in the keys sheet`);
    else if (!row.ticked) problems.push(`${id} (${row.v1Label}): store row is not ticked`);
    else if (row.v2Key.trim() === '') problems.push(`${id} (${row.v1Label}): ticked but has no v2 key`);
  }
  if (problems.length > 0) throw new Error(`keys sheet: v1 stores not mapped - ${problems.join('; ')}`);
}

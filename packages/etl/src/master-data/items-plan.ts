/**
 * T-391 S2 - the item planner: a PURE function from (v1 snapshot, store map, what v2 already holds, links, Ian's
 * answers) to the writes the load will make and the sheets Ian answers. No database, no clock, no randomness.
 * docs/tasks/391-production-master-data-load.md, rulings R4, R5, R11, R12, R14 and I-a .. I-i.
 *
 * Shape of the decision, per name (a "candidate": one exact key `lower(trim)`, or several names Ian called "same"):
 *   - every record already linked          -> nothing (R4);
 *   - the name is already in v2 (or a record is already linked to a v2 item) -> LINK the unlinked records to that item;
 *     the v2 item is never changed, a unit that differs waits for a factor, a merged item links to its winner, an
 *     inactive item waits for `link_inactive` (I-i);
 *   - otherwise CREATE once kind and base unit are both decided. The unit is the majority of the TARGET ORG's stores
 *     whatever the scope (R5); a tie, a container, and a kind nobody can vouch for are held for Ian (I-b, I-c, I-d, I-g, I-h).
 *
 * Sheets are computed over the whole org and carried with Ian's fresh answers; WRITES are limited to the scope stores.
 * An answer binds to a row only through its `row_key` (R11): a v1 record that changed moves the key, the old answer is
 * ignored and listed stale, and the row comes back blank. There is no write but `create` and `link` (I7).
 */
import { isJunkName, key, loose } from './keys';
import { rowKey, toCsv } from './sheets';
import { selectTargetStores, type StoreMapRow } from './store-map';

export const ITEM_KINDS: ReadonlySet<string> = new Set(['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced']);
/** Units that are genuinely units of measure. A container is a way of buying, never a way of measuring. */
export const REAL_UNITS: ReadonlySet<string> = new Set(['pcs', 'kg', 'g', 'ltr', 'ml', 'roll']);
export const CONTAINER_UNITS: ReadonlySet<string> = new Set(['box', 'pack', 'case', 'sack', 'tray', 'dozen']);

export interface SnapshotItem {
  id: string;
  store: string;
  name?: string;
  kind?: string;
  baseUnit?: string;
  purchaseUnit?: string;
  conversionFactor?: number;
}
export interface ItemsSnapshot {
  items: SnapshotItem[];
}
export interface ExistingItem {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'merged';
  baseUnit: string;
  kind: string;
  mergedIntoId: string | null;
  /** The item's default buying unit and its ratio to the base unit (both set or both absent). */
  purchaseUnit?: string | null;
  purchaseFactor?: number | string | null;
}
export interface ExistingLink {
  entity: string;
  v1StoreId: string;
  v1Id: string;
  v2Id: string;
  v1Unit?: string | null;
  factorToBase?: number | string | null;
}
export interface PlannedLink {
  v1StoreId: string;
  v1Id: string;
  v1Unit: string;
  factorToBase: number;
}
export type ItemWrite =
  | {
      op: 'create';
      name: string;
      kind: string;
      baseUnit: string;
      purchase: null | { unit: string; factor: number };
      links: PlannedLink[];
    }
  | { op: 'link'; itemId: string; links: PlannedLink[] };

export type Row = Record<string, string>;
export const ITEM_SHEETS = ['items-units', 'items-box', 'items-pack-pack', 'items-twins', 'items-kind', 'items-not-imported'] as const;
export type ItemSheet = (typeof ITEM_SHEETS)[number];

export const ITEM_SHEET_COLUMNS: Record<ItemSheet, readonly string[]> = {
  'items-units': ['row_key', 'item', 'store', 'majority_unit', 'v1_unit', 'factor', 'unit', 'link_inactive', 'note'],
  'items-box': ['row_key', 'item', 'v1_unit', 'inside_unit', 'how_many', 'note'],
  'items-pack-pack': ['row_key', 'item', 'v1_unit', 'base_unit', 'per_pack', 'ok', 'note'],
  'items-twins': ['row_key', 'group', 'name', 'stores', 'same_or_different', 'keep_name', 'note'],
  'items-kind': ['row_key', 'item', 'v1_kinds', 'kind', 'ok', 'note'],
  'items-not-imported': ['row_key', 'item', 'stores', 'note'],
};

/** The columns Ian fills. Everything else on a row is the planner's and is never read back from an answer. */
const ANSWER_COLUMNS: Record<ItemSheet, readonly string[]> = {
  'items-units': ['factor', 'unit', 'link_inactive'],
  'items-box': ['inside_unit', 'how_many'],
  'items-pack-pack': ['base_unit', 'per_pack', 'ok'],
  'items-twins': ['same_or_different', 'keep_name'],
  'items-kind': ['kind', 'ok'],
  'items-not-imported': [],
};
/** A stale row is only reported when it carried one of these (a blank old row is not an answer). */
const STALE_TRIGGER: Record<ItemSheet, readonly string[]> = {
  'items-units': ['factor', 'unit', 'link_inactive'],
  'items-box': ['inside_unit', 'how_many'],
  'items-pack-pack': ['ok'],
  'items-twins': ['same_or_different'],
  'items-kind': ['ok'],
  'items-not-imported': [],
};

export interface StaleAnswer {
  sheet: string;
  row_key: string;
  item: string;
  /** The row Ian filled, as he left it: a stale answer is never lost (items-stale.csv). */
  answer: Row;
}

/** items-stale.csv: every answer the planner ignored because its row_key no longer matches. */
export function staleAnswersCsv(stale: readonly StaleAnswer[]): string {
  const extra = [...new Set(stale.flatMap((s) => Object.keys(s.answer)))].filter((c) => c !== 'row_key' && c !== 'item');
  const cols = ['sheet', 'row_key', 'item', ...extra];
  return toCsv(
    cols,
    stale.map((s) => ({ ...s.answer, sheet: s.sheet, row_key: s.row_key, item: s.item })),
  );
}
export interface ItemPlan {
  writes: ItemWrite[];
  sheets: Record<ItemSheet, Row[]>;
  stale: StaleAnswer[];
  /** Rows Ian still has to answer (a name, a record or a group waiting). 0 = nothing held (the exit code is 0). */
  held: number;
}
export interface PlanItemsInput {
  snapshot: ItemsSnapshot;
  map: readonly StoreMapRow[];
  orgCode: string;
  storeCodes?: readonly string[];
  existing: readonly ExistingItem[];
  links: readonly ExistingLink[];
  answers: Record<string, Row[]>;
}

interface Rec {
  id: string;
  store: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
  purchaseUnit: string;
  factor: number;
}
interface Entity {
  name: string;
  recs: Rec[];
  v2Hint?: ExistingItem;
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const yes = (s: string | undefined): boolean => norm(s) === 'yes';

/** The columns the database stores at 6 decimals (numeric(14,6)): a longer answer is held, never rounded late. */
const NUMERIC_ANSWER_COLUMNS = ['factor', 'how_many', 'per_pack'] as const;
const tooPrecise = (s: string | undefined): boolean => /\.\d{7,}/.test((s ?? '').trim()) || /e/i.test((s ?? '').trim());

function parsePositive(s: string | undefined): number | null {
  const t = (s ?? '').trim();
  if (t === '' || tooPrecise(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function planItems(input: PlanItemsInput): ItemPlan {
  const orgRows = selectTargetStores(input.map, { orgCode: input.orgCode });
  const scopeRows = selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes });
  const codeOf = new Map(orgRows.map((r) => [r.v1StoreId, r.storeCode]));
  const order = new Map(orgRows.map((r, i) => [r.v1StoreId, i]));
  const scope = new Set(scopeRows.map((r) => r.v1StoreId));

  const sheets = Object.fromEntries(ITEM_SHEETS.map((s) => [s, [] as Row[]])) as Record<ItemSheet, Row[]>;
  const emitted = Object.fromEntries(ITEM_SHEETS.map((s) => [s, new Set<string>()])) as Record<ItemSheet, Set<string>>;
  const answerByKey = Object.fromEntries(
    ITEM_SHEETS.map((s) => [s, new Map((input.answers[s] ?? []).map((r) => [(r.row_key ?? '').trim(), r] as const))]),
  ) as Record<ItemSheet, Map<string, Row>>;

  /** Emit a row, overlaying Ian's FRESH answer (same row_key). Returns the row as emitted - decisions read from it. */
  const emit = (sheet: ItemSheet, row: Row): Row => {
    const a = answerByKey[sheet].get(row.row_key!);
    if (a) for (const c of ANSWER_COLUMNS[sheet]) row[c] = (a[c] ?? '').trim();
    for (const c of NUMERIC_ANSWER_COLUMNS) {
      if (tooPrecise(row[c])) row.note = `held: ${c} "${row[c]}" has more than 6 decimal places (or an exponent); give at most 6 decimal places. ${row.note ?? ''}`.trim();
    }
    emitted[sheet].add(row.row_key!);
    sheets[sheet].push(row);
    return row;
  };

  const linked = new Map<string, string>();
  for (const l of input.links) if (l.entity === 'item') linked.set(`${l.v1StoreId}|${l.v1Id}`, l.v2Id);
  const isLinked = (r: Rec): boolean => linked.has(`${r.store}|${r.id}`);

  const existingById = new Map(input.existing.map((e) => [e.id, e]));
  const existingByKey = new Map(input.existing.map((e) => [key(e.name), e]));

  // ---- the org's records, in store order, junk set aside (R14)
  const recs: Rec[] = [];
  const nameless: Array<{ id: string; store: string }> = [];
  for (const it of input.snapshot.items) {
    if (!order.has(it.store)) continue;
    if (typeof it.name !== 'string' || !it.name.trim()) {
      nameless.push({ id: it.id, store: it.store });
      continue;
    }
    recs.push({
      id: it.id,
      store: it.store,
      code: codeOf.get(it.store)!,
      name: it.name.trim(),
      kind: norm(it.kind),
      unit: norm(it.baseUnit),
      purchaseUnit: norm(it.purchaseUnit),
      factor: typeof it.conversionFactor === 'number' ? it.conversionFactor : 0,
    });
  }
  recs.sort((a, b) => order.get(a.store)! - order.get(b.store)! || a.id.localeCompare(b.id));

  const junk = new Map<string, Rec[]>();
  const byKey = new Map<string, Rec[]>();
  for (const r of recs) {
    const bucket = isJunkName(r.name) ? junk : byKey;
    const k = key(r.name);
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k)!.push(r);
  }
  for (const [k, rs] of [...junk].sort((a, b) => a[0].localeCompare(b[0]))) {
    emit('items-not-imported', {
      row_key: rowKey('items-not-imported', k),
      item: rs[0]!.name,
      stores: [...new Set(rs.map((r) => r.code))].join(' '),
      note: 'junk name (under 2 characters, or no letter): never imported',
    });
  }

  for (const n of nameless) {
    emit('items-not-imported', {
      row_key: rowKey('items-not-imported', 'nameless', n.store, n.id),
      item: `(no name) ${n.id}`,
      stores: codeOf.get(n.store)!,
      note: 'v1 record with no name: never imported',
    });
  }

  const spelling = (rs: Rec[]): string => {
    const n = new Map<string, number>();
    for (const r of rs) n.set(r.name, (n.get(r.name) ?? 0) + 1);
    let best = rs[0]!.name;
    for (const [name, c] of n) if (c > n.get(best)!) best = name;
    return best;
  };
  const storesOf = (rs: Rec[]): string => [...new Set(rs.map((r) => r.code))].join(' ');

  // ---- candidates: one per exact key, except where the twin sheet says otherwise
  const candidates = [...byKey].map(([k, rs]) => ({ k, recs: rs, name: spelling(rs) }));
  const open = candidates.filter((c) => c.recs.some((r) => !isLinked(r)));

  let held = 0;
  const entities: Entity[] = [];
  const groups = new Map<string, { k: string; recs: Rec[]; name: string; v2?: ExistingItem }[]>();
  const openLoose = new Set(open.map((c) => loose(c.name)));
  for (const c of open) {
    const l = loose(c.name);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push({ ...c, v2: existingByKey.get(c.k) });
  }
  for (const e of input.existing) {
    const l = loose(e.name);
    if (!openLoose.has(l)) continue;
    const g = groups.get(l)!;
    if (!g.some((m) => m.k === key(e.name))) g.push({ k: key(e.name), recs: [], name: e.name, v2: e });
  }

  for (const [l, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length < 2) {
      for (const m of members) if (m.recs.length) entities.push({ name: m.name, recs: m.recs });
      continue;
    }
    // a twin group: every name is held until Ian answers (I-e)
    const v2Names = members.filter((m) => m.v2).map((m) => m.v2!);
    v2Names.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.name.localeCompare(b.name));
    let prefill: string;
    if (v2Names.length) prefill = v2Names[0]!.name;
    else {
      const best = [...members].sort((a, b) => b.recs.length - a.recs.length || a.name.localeCompare(b.name))[0]!;
      prefill = best.name;
    }
    const rows = members
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({
        m,
        row: emit('items-twins', {
          row_key: rowKey('items-twins', l, m.k, m.recs.map((r) => `${r.store}:${r.id}`).join(','), m.v2?.id ?? ''),
          group: l,
          name: m.v2 ? m.v2.name : m.name,
          stores: [storesOf(m.recs), m.v2 ? `in v2 (${m.v2.status})` : ''].filter(Boolean).join(' '),
          same_or_different: '',
          keep_name: prefill,
          note: 'the same product typed two ways, or two products that only look alike? same / different',
        }),
      }));
    const answers = rows.map((x) => norm(x.row.same_or_different));
    const holdGroup = (): void => {
      held += rows.length;
    };
    if (answers.some((a) => a !== 'same' && a !== 'different')) {
      holdGroup();
      continue;
    }
    if (answers.some((a) => a !== answers[0])) {
      holdGroup(); // rows that disagree: the group is one decision
      continue;
    }
    if (answers[0] === 'different') {
      for (const d of rows) if (d.m.recs.length) entities.push({ name: d.m.name, recs: d.m.recs, v2Hint: d.m.v2 });
      continue;
    }
    // all 'same': the keep_name Ian edited (differs from the pre-fill) wins; it must be one of the group's names
    const typed = [...new Set(rows.map((x) => (x.row.keep_name ?? '').trim()).filter((n) => n !== ''))];
    const edited = typed.filter((n) => key(n) !== key(prefill));
    if (edited.length > 1) {
      holdGroup();
      continue;
    }
    const keep = edited[0] ?? typed[0] ?? prefill;
    const names = new Set(members.flatMap((m) => [key(m.name), ...(m.v2 ? [key(m.v2.name)] : [])]));
    if (!names.has(key(keep))) {
      holdGroup();
      continue;
    }
    const v2s = rows.map((x) => x.m.v2).filter((v): v is ExistingItem => !!v);
    const hint = v2s.find((v) => key(v.name) === key(keep)) ?? v2s[0];
    const merged = rows.flatMap((x) => x.m.recs).sort((x, y) => order.get(x.store)! - order.get(y.store)! || x.id.localeCompare(y.id));
    if (merged.length) entities.push({ name: keep, recs: merged, v2Hint: hint });
  }
  entities.sort((a, b) => key(a.name).localeCompare(key(b.name)));

  // ---- decide each entity
  const creates: ItemWrite[] = [];
  const linkOps = new Map<string, PlannedLink[]>();
  const addLink = (itemId: string, l: PlannedLink): void => {
    if (!linkOps.has(itemId)) linkOps.set(itemId, []);
    linkOps.get(itemId)!.push(l);
  };
  const mk = (r: Rec, factor: number): PlannedLink => ({ v1StoreId: r.store, v1Id: r.id, v1Unit: r.unit, factorToBase: factor });

  /** A record the plan cannot place: listed on items-units and counted held, never silently dropped. */
  const dropRecord = (e: Entity, r: Rec, why: string): void => {
    emit('items-units', {
      row_key: rowKey('items-units', 'dropped', key(e.name), r.store, r.id, why),
      item: e.name,
      store: r.code,
      majority_unit: '',
      v1_unit: r.unit,
      factor: '',
      unit: '',
      link_inactive: '',
      note: `held: ${why}`,
    });
    held++;
  };

  const linkExisting = (e: Entity, t: ExistingItem, unlinked: Rec[]): void => {
    let w: ExistingItem | undefined = t;
    const seen = new Set<string>();
    while (w && w.status === 'merged' && w.mergedIntoId && !seen.has(w.id)) {
      seen.add(w.id);
      w = existingById.get(w.mergedIntoId);
    }
    if (!w || w.status === 'merged') {
      for (const r of unlinked) dropRecord(e, r, `"${t.name}" is merged into an item that cannot be found (or the merge loops); fix it in v2`);
      return;
    }
    const via = w.id === t.id ? '' : ` (merged from "${t.name}")`;
    for (const r of unlinked) {
      const sameUnit = r.unit === w.baseUnit;
      const pf = Number(w.purchaseFactor);
      // the item already has this very buying unit (a box counted in 24 pcs): its factor is known
      const known = sameUnit ? 1 : r.unit !== '' && r.unit === w.purchaseUnit && Number.isFinite(pf) && pf > 0 ? pf : null;
      if (known !== null && w.status === 'active') {
        if (scope.has(r.store)) addLink(w.id, mk(r, known));
        continue;
      }
      const note =
        `already in v2 as "${w.name}"${via}, unit ${w.baseUnit}` +
        (w.status === 'inactive' ? '; retired - link_inactive yes to link to it' : '') +
        (known !== null ? '' : `; give factor: 1 ${r.unit || 'v1 unit'} = factor ${w.baseUnit}`);
      const row = emit('items-units', {
        row_key: rowKey('items-units', 'v2', key(e.name), r.store, r.id, r.unit, w.id, w.baseUnit, w.status),
        item: e.name,
        store: r.code,
        majority_unit: w.baseUnit,
        v1_unit: r.unit,
        factor: '',
        unit: '',
        link_inactive: '',
        note,
      });
      const factor = known ?? parsePositive(row.factor);
      const permitted = w.status === 'active' || yes(row.link_inactive);
      if (permitted && factor !== null) {
        if (scope.has(r.store)) addLink(w.id, mk(r, factor));
      } else held++;
    }
  };

  const decideKind = (e: Entity): string | null => {
    const valid = e.recs.map((r) => r.kind).filter((k) => ITEM_KINDS.has(k));
    const distinct = new Set(valid);
    if (valid.length === e.recs.length && distinct.size === 1) return valid[0]!;
    const tally = new Map<string, number>();
    for (const k of valid) tally.set(k, (tally.get(k) ?? 0) + 1);
    const top = Math.max(0, ...tally.values());
    const tops = [...tally].filter(([, n]) => n === top).map(([k]) => k);
    const prefill = valid.length && tops.length === 1 ? tops[0]! : '';
    const row = emit('items-kind', {
      row_key: rowKey('items-kind', key(e.name), e.recs.map((r) => `${r.store}:${r.id}:${r.kind}`).join(',')),
      item: e.name,
      v1_kinds: e.recs.map((r) => `${r.code}: ${r.kind || '(none)'}`).join('; '),
      kind: prefill,
      ok: '',
      note: prefill
        ? 'stores disagree on the kind: majority filled in; tick ok (or change kind and tick ok)'
        : 'v1 has no usable kind: fill in one of raw_material, supply, retail, meat_slab, meat_sliced',
    });
    const k = norm(row.kind);
    if (!ITEM_KINDS.has(k)) return null;
    if (prefill !== '' && !yes(row.ok)) return null;
    return k;
  };

  const minorityRow = (e: Entity, r: Rec, base: string): Row =>
    emit('items-units', {
      row_key: rowKey('items-units', 'minor', key(e.name), r.store, r.id, r.unit, base),
      item: e.name,
      store: r.code,
      majority_unit: base,
      v1_unit: r.unit,
      factor: '',
      unit: '',
      link_inactive: '',
      note: `this store counts in ${r.unit || 'an unknown unit'}, the item in ${base}: give factor (1 ${r.unit || 'v1 unit'} = factor ${base}); blank = this record is not linked`,
    });

  /** Factor of one record against the decided base: same unit 1, the container 'inside' factor, else Ian's factor row. */
  const factorsFor = (e: Entity, base: string, container?: { unit: string; factor: number }): Map<Rec, number> => {
    const out = new Map<Rec, number>();
    for (const r of e.recs) {
      if (r.unit === base) out.set(r, 1);
      else if (container && r.unit === container.unit) out.set(r, container.factor);
      else {
        const f = parsePositive(minorityRow(e, r, base).factor);
        if (f !== null) out.set(r, f);
        else held++;
      }
    }
    return out;
  };

  const decideUnit = (e: Entity): null | { base: string; purchase: null | { unit: string; factor: number }; factors: Map<Rec, number> } => {
    const stores = new Map<string, Set<string>>();
    for (const r of e.recs) {
      if (!r.unit) continue;
      if (!stores.has(r.unit)) stores.set(r.unit, new Set());
      stores.get(r.unit)!.add(r.store);
    }
    const top = Math.max(0, ...[...stores.values()].map((s) => s.size));
    const tops = [...stores].filter(([, s]) => s.size === top).map(([u]) => u);

    if (tops.length !== 1) {
      // a tie (or no unit at all) has no majority: held until Ian picks (I-b)
      const rows = e.recs.map((r) =>
        emit('items-units', {
          row_key: rowKey('items-units', 'tie', key(e.name), r.store, r.id, r.unit),
          item: e.name,
          store: r.code,
          majority_unit: '',
          v1_unit: r.unit,
          factor: '',
          unit: '',
          link_inactive: '',
          note: 'stores disagree and there is no majority: fill unit (pcs, kg, g, ltr, ml, roll) on these rows; give factor where a store counts in another unit',
        }),
      );
      const picked = new Set(rows.map((r) => norm(r.unit)).filter(Boolean));
      if (picked.size !== 1) return null;
      const base = [...picked][0]!;
      if (!REAL_UNITS.has(base)) return null;
      const factors = new Map<Rec, number>();
      e.recs.forEach((r, i) => {
        if (r.unit === base) factors.set(r, 1);
        else {
          const f = parsePositive(rows[i]!.factor);
          if (f !== null) factors.set(r, f);
          else held++;
        }
      });
      return { base, purchase: null, factors };
    }

    const majority = tops[0]!;
    if (REAL_UNITS.has(majority)) return { base: majority, purchase: null, factors: factorsFor(e, majority) };

    // the majority counts in a container (or an unknown unit): q5-2 / q5-3
    const inMajority = e.recs.filter((r) => r.unit === majority);
    const samePack = CONTAINER_UNITS.has(majority) ? inMajority.find((r) => r.purchaseUnit === majority && r.factor > 0 && r.factor !== 1) : undefined;
    const inputs = e.recs.map((r) => `${r.store}:${r.id}:${r.unit}:${r.purchaseUnit}:${r.factor}`).join(',');
    if (samePack) {
      const row = emit('items-pack-pack', {
        row_key: rowKey('items-pack-pack', key(e.name), inputs),
        item: e.name,
        v1_unit: majority,
        base_unit: 'pcs',
        per_pack: String(samePack.factor),
        ok: '',
        note: `v1 says 1 ${majority} = ${samePack.factor} ${majority}: counted in pieces instead. Tick ok, or correct per_pack / base_unit`,
      });
      if (!yes(row.ok)) return null;
      const base = norm(row.base_unit) || 'pcs';
      const perPack = (row.per_pack ?? '').trim() === '' ? samePack.factor : parsePositive(row.per_pack);
      if (!REAL_UNITS.has(base) || perPack === null) return null;
      const purchase = { unit: majority, factor: perPack };
      return { base, purchase, factors: factorsFor(e, base, purchase) };
    }
    const real = inMajority.map((r) => r.purchaseUnit).find((u) => REAL_UNITS.has(u)) ?? '';
    const row = emit('items-box', {
      row_key: rowKey('items-box', key(e.name), inputs),
      item: e.name,
      v1_unit: majority,
      inside_unit: real,
      how_many: '',
      note: `counted in ${majority}: what is inside (pcs, kg, g, ltr, ml, roll) and how many per ${majority}? The ${majority} becomes the buying unit`,
    });
    const inside = norm(row.inside_unit);
    const howMany = parsePositive(row.how_many);
    if (!REAL_UNITS.has(inside) || howMany === null) return null;
    const purchase = { unit: majority, factor: howMany };
    return { base: inside, purchase, factors: factorsFor(e, inside, purchase) };
  };

  for (const [, rs] of byKey) {
    for (const r of rs) {
      const v2 = linked.get(`${r.store}|${r.id}`);
      if (v2 && !existingById.has(v2)) dropRecord({ name: r.name, recs: [r] }, r, 'linked to a v2 item that cannot be found');
    }
  }

  for (const e of entities) {
    const unlinked = e.recs.filter((r) => !isLinked(r));
    if (unlinked.length === 0) continue;
    const linkedTo = e.recs.map((r) => linked.get(`${r.store}|${r.id}`)).find((v) => !!v);
    const target = linkedTo ? existingById.get(linkedTo) : (e.v2Hint ?? existingByKey.get(key(e.name)));
    if (target) {
      linkExisting(e, target, unlinked);
      continue;
    }
    if (linkedTo) {
      for (const r of unlinked) dropRecord(e, r, 'a sibling record is linked to a v2 item that cannot be found');
      continue;
    }

    const kind = decideKind(e);
    const unit = decideUnit(e);
    if (kind === null || unit === null) {
      held++;
      continue;
    }
    const inScope = e.recs.filter((r) => scope.has(r.store));
    if (inScope.length === 0) continue;
    const links = inScope.filter((r) => unit.factors.has(r)).map((r) => mk(r, unit.factors.get(r)!));
    creates.push({ op: 'create', name: e.name.trim(), kind, baseUnit: unit.base, purchase: unit.purchase, links });
  }

  // ---- answers whose row no longer exists (R11)
  const stale: StaleAnswer[] = [];
  for (const sheet of ITEM_SHEETS) {
    for (const [rk, a] of answerByKey[sheet]) {
      if (emitted[sheet].has(rk)) continue;
      if (!STALE_TRIGGER[sheet].some((c) => (a[c] ?? '').trim() !== '')) continue;
      stale.push({ sheet, row_key: rk, item: a.item ?? a.name ?? '', answer: { ...a } });
    }
  }

  const writes: ItemWrite[] = [
    ...creates,
    ...[...linkOps].map(([itemId, links]): ItemWrite => ({ op: 'link', itemId, links })),
  ];
  return { writes, sheets, stale, held };
}

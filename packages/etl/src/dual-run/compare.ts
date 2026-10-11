/**
 * T-392 S2 - compare one store-week, v1 against v2 (spec R6-R13). Pure and deterministic: no DB, no clock, no input-order
 * dependence. Money is integer centavos; delta = v2 - v1 everywhere.
 *
 * Per line: delta 0 is TIES. Otherwise the line is classed by rule (unmapped key, inventory basis, supplier advance, a
 * recorded disposition, the v1 cash residual) and, for what remains, candidate matching runs beneath it (R9) in a fixed pass
 * order, each document used at most once. Whatever no pass explains is its own UNEXPLAINED item.
 */
import { createHash } from 'node:crypto';
import { CLASS_CATALOGUE, DISPOSITION_CLASSES, type ClassCode, type ClassFamily } from './classes';
import type { ScopeEntry, V1Flag, V1Line, V1LineKind } from './v1-figures';

export interface V2Line { kind: V1LineKind; key: string; amount: number; days: Record<string, number> }
export interface CompareDoc {
  id: string;
  kind: V1LineKind;
  key: string;
  date: string;
  amount: number;
  state: 'posted' | 'unposted';
  receiptId?: string;
  correctionOf?: string;
  channel?: boolean;
}
export interface Disposition {
  orgId: string;
  storeId: string;
  weekStart: string;
  kind: V1LineKind;
  lineKey: string;
  deltaAt: number;
  class: string;
  ref: string;
  createdAt: string;
}
export interface CompareInput {
  orgId: string;
  storeId: string;
  weekStart: string;
  through: string;
  v1: { lines: V1Line[]; tradingDays: string[]; cashResidual: Record<string, number>; scope?: ScopeEntry[]; flags?: V1Flag[] };
  v2: { lines: V2Line[]; tradingDays: string[] };
  keyMap: Record<string, string>;
  v1Docs: CompareDoc[];
  v2Docs: CompareDoc[];
  dispositions: Disposition[];
}
export type Verdict = 'no_data' | 'ties' | 'explained' | 'open';
export interface ResultItem {
  class: ClassCode;
  paired: boolean;
  amount: number;
  v1Id?: string;
  v2Id?: string;
  /** Business date of the document behind an unpaired PENDING_* item (its age is read from it). */
  date?: string;
  ref?: string;
}
export interface ResultDay { date: string; v1: number; v2: number; delta: number; state: 'tied' | 'classed' | 'open' }
export interface ResultLine {
  kind: V1LineKind;
  key: string;
  v1: number;
  v2: number;
  delta: number;
  class: ClassCode;
  family: ClassFamily;
  paired: boolean;
  reCheck: boolean;
  items: ResultItem[];
  days: ResultDay[];
}
export interface StoreWeekResult {
  storeId: string;
  weekStart: string;
  through: string;
  verdict: Verdict;
  comparedDays: string[];
  matchRuns: number;
  lines: ResultLine[];
  scope: ScopeEntry[];
  flags: V1Flag[];
  v1Fingerprint: string;
  v2Fingerprint: string;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS);
const signedDays = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const DEF_REF = /^DEF-\d+$/;
const PENDING_MAX_AGE_DAYS = 2;
const DATE_SHIFT_MAX_DAYS = 7;

interface Acc {
  kind: V1LineKind;
  key: string;
  unmapped: boolean;
  flagged: boolean;
  v1: number;
  v2: number;
  v1Days: Record<string, number>;
  v2Days: Record<string, number>;
  rawV1: string[];
  advV1: number;
  nonCash: boolean;
}
interface MDoc extends CompareDoc { side: 'v1' | 'v2' }

function validateDispositions(list: Disposition[]): void {
  for (const d of list) {
    if (!(DISPOSITION_CLASSES as readonly string[]).includes(d.class)) {
      throw new Error(`disposition class ${JSON.stringify(d.class)} refused: only ${DISPOSITION_CLASSES.join(' or ')} may be assigned by a person`);
    }
    if (typeof d.ref !== 'string' || !DEF_REF.test(d.ref)) {
      throw new Error(`disposition ref ${JSON.stringify(d.ref)} refused: a DEF-nnn register reference is required`);
    }
  }
}

function assertCentavos(value: unknown, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${what}: amount ${String(value)} is not an integer number of centavos`);
  }
}

function validateAmounts(input: CompareInput): void {
  for (const [side, lines] of [['v1', input.v1.lines], ['v2', input.v2.lines]] as const) {
    for (const l of lines) {
      assertCentavos(l.amount, `${side} line ${l.kind}/${l.key}`);
      for (const [d, v] of Object.entries(l.days)) assertCentavos(v, `${side} line ${l.kind}/${l.key} day ${d}`);
    }
  }
  for (const [side, docs] of [['v1', input.v1Docs], ['v2', input.v2Docs]] as const) {
    for (const d of docs) assertCentavos(d.amount, `${side} document ${d.id}`);
  }
  for (const [d, v] of Object.entries(input.v1.cashResidual)) assertCentavos(v, `v1 cash residual ${d}`);
}

function addDay(days: Record<string, number>, date: string, amount: number): void {
  days[date] = (days[date] ?? 0) + amount;
}

const docTuple = (d: CompareDoc): string =>
  JSON.stringify([d.id, d.kind, d.key, d.date, d.amount, d.state, d.receiptId ?? null, d.correctionOf ?? null, d.channel === true]);
const docOrder = (a: MDoc, b: MDoc): number => cmp(a.date, b.date) || a.amount - b.amount || cmp(a.id, b.id) || cmp(docTuple(a), docTuple(b));

function fingerprintSide(
  lines: { kind: string; key: string; amount: number; days: Record<string, number> }[],
  docs: CompareDoc[],
  tradingDays: string[],
  extra: unknown,
): string {
  return sha({
    lines: lines
      .map((l) => [l.kind, l.key, l.amount, Object.entries(l.days).sort((a, b) => cmp(a[0], b[0]))] as const)
      .sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))),
    docs: docs.map((d) => docTuple(d)).sort(),
    tradingDays: [...tradingDays].sort(),
    extra,
  });
}

export function compareStoreWeek(input: CompareInput): StoreWeekResult {
  validateDispositions(input.dispositions);
  validateAmounts(input);
  const { weekStart, through } = input;
  const inWeek = (d: string): boolean => d >= weekStart && d <= through;
  const mapKey = (kind: string, key: string): { key: string; unmapped: boolean } =>
    has(input.keyMap, `${kind}|${key}`)
      ? { key: input.keyMap[`${kind}|${key}`] as string, unmapped: false }
      : { key: `v1:${key}`, unmapped: true };

  // ---- 1. accumulate lines by (kind, result key)
  const accs = new Map<string, Acc>();
  const acc = (kind: V1LineKind, key: string, unmapped: boolean): Acc => {
    const id = `${kind}|${key}`;
    let a = accs.get(id);
    if (!a) {
      a = { kind, key, unmapped, flagged: false, v1: 0, v2: 0, v1Days: {}, v2Days: {}, rawV1: [], advV1: 0, nonCash: false };
      accs.set(id, a);
    }
    return a;
  };
  for (const l of input.v1.lines) {
    const m = mapKey(l.kind, l.key);
    const a = acc(l.kind, m.key, m.unmapped);
    a.v1 += l.amount;
    for (const [d, v] of Object.entries(l.days)) addDay(a.v1Days, d, v);
    a.rawV1.push(l.key);
    if (l.key.startsWith('supplier_advance__')) a.advV1 += l.amount;
    if (!l.key.startsWith('cash__')) a.nonCash = true;
    if (l.class === 'V1_UNKNOWN_EXPENSE_GROUP') a.flagged = true;
  }
  for (const l of input.v2.lines) {
    const a = acc(l.kind, l.key, false);
    a.v2 += l.amount;
    for (const [d, v] of Object.entries(l.days)) addDay(a.v2Days, d, v);
  }
  const lineIds = [...accs.keys()].sort((x, y) => {
    const a = accs.get(x) as Acc;
    const b = accs.get(y) as Acc;
    return cmp(`${a.kind}/${a.key}`, `${b.kind}/${b.key}`);
  });
  const dayDelta = (a: Acc, date: string): number => (a.v2Days[date] ?? 0) - (a.v1Days[date] ?? 0);

  // ---- 2. classify by rule
  const items = new Map<string, ResultItem[]>();
  const reCheck = new Map<string, boolean>();
  const matchable = new Map<string, number>(); // line id -> remainder awaiting matching
  let matchRuns = 0;
  for (const id of lineIds) {
    const a = accs.get(id) as Acc;
    const delta = a.v2 - a.v1;
    const list: ResultItem[] = [];
    items.set(id, list);
    reCheck.set(id, false);
    if (delta === 0) continue;
    if (a.unmapped) { list.push({ class: 'UNMAPPED_KEY', paired: false, amount: delta }); continue; }
    if (a.kind === 'inventory_basis') { list.push({ class: 'INVENTORY_BASIS', paired: false, amount: delta }); continue; }
    if (a.key.startsWith('1240:')) {
      list.push({ class: 'SUPPLIER_ADVANCE_1240', paired: false, amount: delta });
      continue;
    }
    const mine = input.dispositions
      .filter((d) => d.orgId === input.orgId && d.storeId === input.storeId && d.weekStart === weekStart && d.kind === a.kind && d.lineKey === a.key)
      .sort((x, y) => cmp(x.createdAt, y.createdAt) || cmp(x.class, y.class) || cmp(x.ref, y.ref));
    const latest = mine[mine.length - 1];
    if (latest) {
      if (latest.deltaAt === delta) { list.push({ class: latest.class as ClassCode, paired: false, amount: delta, ref: latest.ref }); continue; }
      reCheck.set(id, true);
    }
    let remainder = delta;
    // Only the v1 advance sub-line amount is the advance; anything else merged into the same key is a separate difference.
    if (a.advV1 !== 0) { list.push({ class: 'SUPPLIER_ADVANCE_1240', paired: false, amount: -a.advV1 }); remainder += a.advV1; }
    if (a.kind === 'sales_tender' && !a.nonCash && a.rawV1.length > 0) {
      for (const date of Object.keys(input.v1.cashResidual).sort()) {
        const r = input.v1.cashResidual[date] as number;
        if (r < 0 && dayDelta(a, date) === r) { list.push({ class: 'V1_CASH_RESIDUAL', paired: false, amount: r }); remainder -= r; }
      }
    }
    if (remainder !== 0) { matchable.set(id, remainder); matchRuns += 1; }
  }

  // ---- 3. candidate matching (R9), over the lines still awaiting it
  const pushItem = (kind: V1LineKind, key: string, item: ResultItem): void => {
    if (item.amount === 0) return;
    (items.get(`${kind}|${key}`) as ResultItem[]).push(item);
  };
  const v1Contribution = (d: MDoc): number => (inWeek(d.date) ? -d.amount : 0);
  const v2Contribution = (d: MDoc): number => (inWeek(d.date) ? d.amount : 0);
  const toM = (d: CompareDoc, side: 'v1' | 'v2'): MDoc => ({
    ...d,
    side,
    key: side === 'v1' ? mapKey(d.kind, d.key).key : d.key,
  });
  const inScope = (d: MDoc): boolean => matchable.has(`${d.kind}|${d.key}`);
  const m1 = input.v1Docs.map((d) => toM(d, 'v1')).filter(inScope);
  const m2 = input.v2Docs.map((d) => toM(d, 'v2')).filter(inScope);
  const v1Posted = m1.filter((d) => d.state === 'posted').sort(docOrder);
  const v2Posted = m2.filter((d) => d.state === 'posted').sort(docOrder);
  const v1Un = m1.filter((d) => d.state === 'unposted').sort(docOrder);
  const v2Un = m2.filter((d) => d.state === 'unposted').sort(docOrder);
  const used = new Set<MDoc>();
  const free = (d: MDoc): boolean => !used.has(d);

  const pairPass = (test: (a: MDoc, b: MDoc) => boolean, onPair: (a: MDoc, b: MDoc) => void): void => {
    for (const a of v1Posted) {
      if (!free(a)) continue;
      const b = v2Posted.find((c) => free(c) && test(a, c));
      if (!b) continue;
      used.add(a);
      used.add(b);
      onPair(a, b);
    }
  };
  const sameKey = (a: MDoc, b: MDoc): boolean => a.kind === b.kind && a.key === b.key;
  const exactPass = (): void => pairPass((a, b) => sameKey(a, b) && a.date === b.date && a.amount === b.amount, () => undefined);
  const timingPair = (cls: ClassCode) => (a: MDoc, b: MDoc): void =>
    pushItem(a.kind, a.key, { class: cls, paired: true, amount: v1Contribution(a) + v2Contribution(b), v1Id: a.id, v2Id: b.id });

  // V2_CORRECTION_DATED_LATER: a correction and its source on opposite sides of the week boundary, only when v1 holds the
  // CORRECTED amount (source + correction) on the source's date. Runs before the exact pass so the source is not taken
  // at its uncorrected amount.
  for (const c of v2Posted) {
    if (!free(c) || c.correctionOf === undefined) continue;
    const src = v2Posted.find((x) => free(x) && x.id === c.correctionOf && sameKey(x, c));
    if (!src || inWeek(src.date) === inWeek(c.date)) continue;
    const corrected = src.amount + c.amount;
    const v1Side = v1Posted.find((x) => free(x) && sameKey(x, src) && x.date === src.date && x.amount === corrected);
    if (!v1Side) continue;
    used.add(c);
    used.add(src);
    used.add(v1Side);
    pushItem(c.kind, c.key, { class: 'V2_CORRECTION_DATED_LATER', paired: true, amount: inWeek(c.date) ? c.amount : -c.amount, v1Id: v1Side.id, v2Id: c.id });
  }
  exactPass();
  pairPass(
    (a, b) => a.kind === 'ap_supplier' && sameKey(a, b) && a.receiptId !== undefined && a.receiptId === b.receiptId && a.amount === b.amount && a.date !== b.date,
    timingPair('AP_AT_INVOICE'),
  );
  // DATE_SHIFT / CHANNEL_AR_FLOW: a shared receiptId is the document link and wins; without a link only the UNIQUE
  // equal-centavo candidate on each side pairs (two equal daily charges are ambiguous and stay unpaired).
  const shiftPass = (needChannel: boolean, linked: boolean, cls: ClassCode): void => {
    const ok = (a: MDoc, b: MDoc): boolean =>
      sameKey(a, b) && a.amount === b.amount && a.date !== b.date && daysBetween(a.date, b.date) <= DATE_SHIFT_MAX_DAYS &&
      (!needChannel || (a.channel === true && b.channel === true)) &&
      (linked ? a.receiptId !== undefined && a.receiptId === b.receiptId : a.receiptId === undefined || b.receiptId === undefined);
    for (const a of v1Posted) {
      if (!free(a)) continue;
      const cands = v2Posted.filter((c) => free(c) && ok(a, c));
      const b = cands[0];
      if (!b) continue;
      if (!linked && (cands.length !== 1 || v1Posted.filter((x) => free(x) && ok(x, b)).length !== 1)) continue;
      used.add(a);
      used.add(b);
      timingPair(cls)(a, b);
    }
  };
  shiftPass(true, true, 'CHANNEL_AR_FLOW');
  shiftPass(true, false, 'CHANNEL_AR_FLOW');
  shiftPass(false, true, 'DATE_SHIFT');
  shiftPass(false, false, 'DATE_SHIFT');
  pairPass(
    (a, b) => sameKey(a, b) && a.date === b.date && a.amount !== b.amount,
    (a, b) => pushItem(a.kind, a.key, { class: 'KEYING_DIFFERENCE', paired: false, amount: v1Contribution(a) + v2Contribution(b), v1Id: a.id, v2Id: b.id }),
  );
  pairPass(
    (a, b) => a.kind === b.kind && a.key !== b.key && a.date === b.date && a.amount === b.amount,
    (a, b) => {
      pushItem(a.kind, a.key, { class: 'MISCLASSIFIED', paired: false, amount: v1Contribution(a), v1Id: a.id, v2Id: b.id });
      pushItem(b.kind, b.key, { class: 'MISCLASSIFIED', paired: false, amount: v2Contribution(b), v1Id: a.id, v2Id: b.id });
    },
  );
  // PENDING: the other side holds the same document, unposted. (Checked before NOT_DOUBLE_ENTERED, which means "nothing in v2".)
  for (const a of v1Posted) {
    if (!free(a)) continue;
    const u = v2Un.find((x) => free(x) && sameKey(a, x) && x.date === a.date && x.amount === a.amount);
    if (!u) continue;
    used.add(a);
    used.add(u);
    pushItem(a.kind, a.key, { class: 'PENDING_V2', paired: false, amount: v1Contribution(a), v1Id: a.id, v2Id: u.id, date: a.date });
  }
  for (const b of v2Posted) {
    if (!free(b)) continue;
    const u = v1Un.find((x) => free(x) && sameKey(b, x) && x.date === b.date && x.amount === b.amount);
    if (!u) continue;
    used.add(b);
    used.add(u);
    pushItem(b.kind, b.key, { class: 'PENDING_V1', paired: false, amount: v2Contribution(b), v1Id: u.id, v2Id: b.id, date: b.date });
  }
  for (const a of v1Posted) {
    if (!free(a)) continue;
    used.add(a);
    pushItem(a.kind, a.key, { class: 'NOT_DOUBLE_ENTERED', paired: false, amount: v1Contribution(a), v1Id: a.id });
  }

  // ---- 4. close each line: the unexplained remainder is its own item
  const SEVERITY: ClassFamily[] = ['open', 'encoder', 'timing', 'defect', 'scope', 'policy', 'tie'];
  const itemBlocks = (i: ResultItem): boolean => {
    const f = CLASS_CATALOGUE[i.class].family;
    if (f === 'open' || f === 'encoder') return true;
    if (f === 'timing' && !i.paired) return i.date === undefined || signedDays(i.date, through) > PENDING_MAX_AGE_DAYS;
    return false;
  };
  const itemSort = (a: ResultItem, b: ResultItem): number =>
    cmp(a.class, b.class) || a.amount - b.amount || cmp(a.v1Id ?? '', b.v1Id ?? '') || cmp(a.v2Id ?? '', b.v2Id ?? '');

  interface Closed { acc: Acc; line: ResultLine; blocked: boolean }
  const closed: Closed[] = [];
  for (const id of lineIds) {
    const a = accs.get(id) as Acc;
    const delta = a.v2 - a.v1;
    const list = items.get(id) as ResultItem[];
    const remainder = delta - list.reduce((s, i) => s + i.amount, 0);
    if (remainder !== 0) list.push({ class: 'UNEXPLAINED', paired: false, amount: remainder });
    list.sort(itemSort);
    let cls: ClassCode;
    if (delta === 0) cls = a.flagged ? 'V1_UNKNOWN_EXPENSE_GROUP' : 'TIES';
    else if (list.some((i) => i.class === 'UNEXPLAINED')) cls = 'UNEXPLAINED';
    else {
      const rank = (i: ResultItem): number => SEVERITY.indexOf(CLASS_CATALOGUE[i.class].family);
      cls = ([...list].sort((x, y) => rank(x) - rank(y) || cmp(x.class, y.class))[0] as ResultItem).class;
    }
    const blocked = a.flagged || (delta !== 0 && list.some(itemBlocks));
    const dates = [...new Set([...Object.keys(a.v1Days), ...Object.keys(a.v2Days)])].sort();
    const days: ResultDay[] = dates.map((date) => {
      const d = dayDelta(a, date);
      const state: ResultDay['state'] = d === 0 ? 'tied' : delta !== 0 && !blocked ? 'classed' : 'open';
      return { date, v1: a.v1Days[date] ?? 0, v2: a.v2Days[date] ?? 0, delta: d, state };
    });
    closed.push({
      acc: a,
      blocked,
      line: {
        kind: a.kind,
        key: a.key,
        v1: a.v1,
        v2: a.v2,
        delta,
        class: cls,
        family: CLASS_CATALOGUE[cls].family,
        paired: delta !== 0 && list.length > 0 && list.every((i) => i.paired),
        reCheck: reCheck.get(id) === true,
        items: list,
        days,
      },
    });
  }

  // ---- 5. compared days and the verdict (R12, R13)
  const v1Trading = new Set(input.v1.tradingDays);
  const figureDates = new Set<string>();
  const openDates = new Set<string>();
  for (const c of closed) {
    for (const d of c.line.days) {
      if (d.v1 !== 0 || d.v2 !== 0) figureDates.add(d.date);
      if (d.state === 'open') openDates.add(d.date);
    }
  }
  const comparedDays = [...new Set(input.v2.tradingDays)].filter((d) => v1Trading.has(d) && figureDates.has(d) && !openDates.has(d)).sort();
  const lines = closed.map((c) => c.line);
  const scope = [...(input.v1.scope ?? [])].sort((a, b) => cmp(`${a.class}/${a.sourceType}`, `${b.class}/${b.sourceType}`));
  const flags = [...(input.v1.flags ?? [])].sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  const anyOpenDay = closed.some((c) => c.line.days.some((d) => d.state === 'open'));
  const anyFigure = closed.some((c) => c.acc.v1 !== 0 || c.acc.v2 !== 0 || c.line.days.some((d) => d.v1 !== 0 || d.v2 !== 0));
  let verdict: Verdict;
  const empty =
    !anyFigure && input.v1.tradingDays.length === 0 && input.v2.tradingDays.length === 0 && flags.length === 0 &&
    input.v1Docs.length === 0 && input.v2Docs.length === 0 && input.dispositions.length === 0 && scope.length === 0;
  if (empty) verdict = 'no_data';
  else if (flags.length > 0 || anyOpenDay || closed.some((c) => c.blocked)) verdict = 'open';
  else if (comparedDays.length === 0) verdict = 'open';
  else if (lines.every((l) => l.delta === 0)) verdict = comparedDays.length > 0 ? 'ties' : 'open';
  else verdict = 'explained';

  const window = { orgId: input.orgId, storeId: input.storeId, weekStart, through };
  return {
    storeId: input.storeId,
    weekStart,
    through,
    verdict,
    comparedDays,
    matchRuns,
    lines,
    scope,
    flags,
    v1Fingerprint: fingerprintSide(input.v1.lines, input.v1Docs, input.v1.tradingDays, {
      ...window,
      cashResidual: Object.entries(input.v1.cashResidual).sort((a, b) => cmp(a[0], b[0])),
      scope,
      flags,
      keyMap: Object.entries(input.keyMap).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])),
    }),
    v2Fingerprint: fingerprintSide(input.v2.lines, input.v2Docs, input.v2.tradingDays, {
      ...window,
      dispositions: input.dispositions.map((d) => JSON.stringify(d)).sort(),
    }),
  };
}

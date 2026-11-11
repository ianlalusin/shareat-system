/**
 * T-529 (TESTER) - R1 / R4 unit: the Kitchen tab's cards, late colour, station chips and filter, refill tag, optimistic hide, remembered filter.
 * docs/tasks/529-pos-kitchen-refills.md R1 and R4. Pure functions, no database, no DOM.
 *
 * ASSUMED API (apps/erp/src/app/pos/_kitchen/cards.ts) - the builder matches these or says why not:
 *   buildKitchenCards(tickets: Ticket[], o: { stations: ProjectedStation[]; nowMs: number; stationId?: string | null; hiddenLineIds?: ReadonlySet<string> }): KitchenCard[]
 *     Ticket = T-524 `listKitchenQueue` ticket { lineId, sessionId, standNumber, sessionMode, kind, name, qty, note, stationId, addedAtDevice(ISO) }.
 *     ONE card per table (sessionId), cards OLDEST FIRST by the table's first (oldest) remaining line, lines inside a card oldest first (then lineId).
 *     stationId = a station id keeps only that station's lines (a card with none left is dropped); null/undefined = All.
 *     hiddenLineIds = lines served optimistically: left out; a card with no line left is dropped.
 *     KitchenCard = { sessionId, title: 'Stand 12' | 'Take-out', standNumber: number | null, takeOut: boolean, ageMinutes: number (whole minutes, floor, of the
 *       card's oldest remaining line), ageLabel: '14 min', late: boolean, lines: { lineId, name, qty, note: string | null, tag: 'Refill' | null, stationId }[] }
 *     late = some remaining line is older than ITS OWN station's slaMinutes (read from `stations`, never hard-coded); a line with no station is never late.
 *   stationChips(stations): { id: string | null; label: string }[]   -> [{ id: null, label: 'All' }, ...each station, in sortOrder = array order of `stations`]
 * ASSUMED API (apps/erp/src/app/pos/_kitchen/station-filter.ts):
 *   KITCHEN_STATION_KEY: string   the localStorage key
 *   readStationFilter(storage: Pick<Storage, 'getItem'> | null, stationIds: readonly string[]): string | null   null = All; never throws; an id no longer in `stationIds` is null
 *   saveStationFilter(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, stationId: string | null): void   never throws (a per-viewer convenience, wrapped in try/catch)
 *
 * RED NOW FOR THE RIGHT REASON: the modules do not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it } from 'vitest';
import { id, minutesAgo, NOW, STATIONS, ST, ticket } from './helpers/t529-fixtures';

async function load(mod: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/_kitchen/${mod}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_kitchen/${mod} cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const cards = async (tickets: ReturnType<typeof ticket>[], o: { stationId?: string | null; hiddenLineIds?: ReadonlySet<string>; nowMs?: number } = {}) =>
  (await load('cards')).buildKitchenCards(tickets, { stations: STATIONS, nowMs: NOW, ...o }) as {
    sessionId: string; title: string; standNumber: number | null; takeOut: boolean; ageMinutes: number; ageLabel: string; late: boolean;
    lines: { lineId: string; name: string; qty: number; note: string | null; tag: string | null; stationId: string | null }[];
  }[];

const A = id(701), B = id(702), C = id(703), D = id(704);

describe('grouping and ordering (R1 layout)', () => {
  it('one card per table, titled "Stand N", with that table\'s lines', async () => {
    const out = await cards([
      ticket({ sessionId: A, standNumber: 12, name: 'Pork belly', qty: 2, addedAtDevice: minutesAgo(5) }),
      ticket({ sessionId: B, standNumber: 5, name: 'Cheese corn', qty: 2, addedAtDevice: minutesAgo(4) }),
      ticket({ sessionId: A, standNumber: 12, name: 'Beef brisket', qty: 1, addedAtDevice: minutesAgo(5) }),
    ]);
    expect(out.map((c) => c.title)).toEqual(['Stand 12', 'Stand 5']);
    expect(out[0]!.lines.map((l) => [l.name, l.qty])).toEqual([['Pork belly', 2], ['Beef brisket', 1]]);
    expect(out[1]!.lines.map((l) => [l.name, l.qty])).toEqual([['Cheese corn', 2]]);
  });

  it('cards are OLDEST FIRST by the first unserved line, whatever order the tickets arrive in', async () => {
    const out = await cards([
      ticket({ sessionId: C, standNumber: 9, addedAtDevice: minutesAgo(3) }),
      ticket({ sessionId: A, standNumber: 12, addedAtDevice: minutesAgo(14) }),
      ticket({ sessionId: D, standNumber: 10, addedAtDevice: minutesAgo(1) }),
      ticket({ sessionId: B, standNumber: 5, addedAtDevice: minutesAgo(8) }),
    ]);
    expect(out.map((c) => c.title)).toEqual(['Stand 12', 'Stand 5', 'Stand 9', 'Stand 10']);
  });

  it('a table that ordered again later sorts by its OLDEST line, not its newest', async () => {
    const out = await cards([
      ticket({ sessionId: A, standNumber: 12, addedAtDevice: minutesAgo(1) }),
      ticket({ sessionId: B, standNumber: 5, addedAtDevice: minutesAgo(6) }),
      ticket({ sessionId: A, standNumber: 12, addedAtDevice: minutesAgo(10) }),
    ]);
    expect(out.map((c) => c.title)).toEqual(['Stand 12', 'Stand 5']);
    expect(out[0]!.lines).toHaveLength(2);
  });

  it('lines inside a card run oldest first', async () => {
    const out = await cards([
      ticket({ sessionId: A, name: 'Kimchi', addedAtDevice: minutesAgo(2) }),
      ticket({ sessionId: A, name: 'Pork belly', addedAtDevice: minutesAgo(9) }),
      ticket({ sessionId: A, name: 'Rice', addedAtDevice: minutesAgo(5) }),
    ]);
    expect(out[0]!.lines.map((l) => l.name)).toEqual(['Pork belly', 'Rice', 'Kimchi']);
  });

  it('a take-out table is titled "Take-out" and has no stand number', async () => {
    const out = await cards([ticket({ sessionId: A, standNumber: null, sessionMode: 'take_out', addedAtDevice: minutesAgo(2) })]);
    expect(out[0]).toMatchObject({ title: 'Take-out', standNumber: null, takeOut: true });
  });

  it('the line note and quantity come through exactly; a line with no note has note null', async () => {
    const out = await cards([
      ticket({ sessionId: B, name: 'Kimchi fried rice', qty: 1, note: 'No egg on the rice', addedAtDevice: minutesAgo(2) }),
      ticket({ sessionId: B, name: 'Cheese corn', qty: 2, note: null, addedAtDevice: minutesAgo(3) }),
    ]);
    expect(out[0]!.lines).toEqual([
      expect.objectContaining({ name: 'Cheese corn', qty: 2, note: null }),
      expect.objectContaining({ name: 'Kimchi fried rice', qty: 1, note: 'No egg on the rice' }),
    ]);
  });

  it('nothing in the queue is no cards', async () => {
    expect(await cards([])).toEqual([]);
  });
});

describe('elapsed time', () => {
  it('is the whole minutes since the card\'s oldest line, shown as "N min"', async () => {
    const out = await cards([ticket({ sessionId: A, addedAtDevice: minutesAgo(14, 40) }), ticket({ sessionId: A, addedAtDevice: minutesAgo(3) })]);
    expect(out[0]!.ageMinutes).toBe(14);
    expect(out[0]!.ageLabel).toBe('14 min');
  });
  it('under a minute reads "0 min"', async () => {
    const out = await cards([ticket({ sessionId: A, addedAtDevice: minutesAgo(0, 30) })]);
    expect(out[0]).toMatchObject({ ageMinutes: 0, ageLabel: '0 min' });
  });
});

describe('late colour (R1 Late: read from the station, never hard-coded)', () => {
  it('Grill is 12 min: a line at 13 min makes its card late, at 11 min it does not', async () => {
    expect((await cards([ticket({ sessionId: A, stationId: ST.grill, addedAtDevice: minutesAgo(13) })]))[0]!.late).toBe(true);
    expect((await cards([ticket({ sessionId: A, stationId: ST.grill, addedAtDevice: minutesAgo(11) })]))[0]!.late).toBe(false);
  });
  it('each station has its own number: Drinks is 5 min, so 6 min is late for a drink and 6 min is fine for the grill', async () => {
    expect((await cards([ticket({ sessionId: A, stationId: ST.drinks, name: 'Iced tea pitcher', addedAtDevice: minutesAgo(6) })]))[0]!.late).toBe(true);
    expect((await cards([ticket({ sessionId: A, stationId: ST.drinks, name: 'Iced tea pitcher', addedAtDevice: minutesAgo(4) })]))[0]!.late).toBe(false);
    expect((await cards([ticket({ sessionId: A, stationId: ST.grill, addedAtDevice: minutesAgo(6) })]))[0]!.late).toBe(false);
  });
  it('the number comes from the stations it is given: change Grill to 30 min and 13 min is no longer late', async () => {
    const { buildKitchenCards } = await load('cards');
    const slow = STATIONS.map((s) => (s.id === ST.grill ? { ...s, slaMinutes: 30 } : s));
    const out = buildKitchenCards([ticket({ sessionId: A, stationId: ST.grill, addedAtDevice: minutesAgo(13) })], { stations: slow, nowMs: NOW });
    expect(out[0].late).toBe(false);
  });
  it('a card is late when ANY of its lines passes its own station\'s limit (a late drink on a card of fresh grill lines)', async () => {
    const out = await cards([
      ticket({ sessionId: A, stationId: ST.grill, addedAtDevice: minutesAgo(3) }),
      ticket({ sessionId: A, stationId: ST.drinks, name: 'Iced tea pitcher', addedAtDevice: minutesAgo(7) }),
    ]);
    expect(out[0]!.late).toBe(true);
  });
  it('a line with no kitchen station is never late (no hidden default number)', async () => {
    const out = await cards([ticket({ sessionId: A, stationId: null, name: 'Starter set', addedAtDevice: minutesAgo(500) })]);
    expect(out[0]!.late).toBe(false);
  });
  it('a refill line is judged the same way as any other line', async () => {
    const out = await cards([ticket({ sessionId: A, kind: 'refill', stationId: ST.grill, addedAtDevice: minutesAgo(13) })]);
    expect(out[0]!.late).toBe(true);
  });
});

describe('refill lines are tagged on the same card', () => {
  it('a refill line carries tag "Refill" and an ordinary line carries null, both on ONE card', async () => {
    const out = await cards([
      ticket({ sessionId: A, standNumber: 12, kind: 'refill', name: 'Pork belly', qty: 2, addedAtDevice: minutesAgo(6) }),
      ticket({ sessionId: A, standNumber: 12, kind: 'item', name: 'Beef brisket', qty: 1, addedAtDevice: minutesAgo(5) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.lines.map((l) => [l.name, l.tag])).toEqual([['Pork belly', 'Refill'], ['Beef brisket', null]]);
  });
  it('a package line is not tagged', async () => {
    const out = await cards([ticket({ sessionId: A, kind: 'package', name: 'Unli Grill', qty: 4, addedAtDevice: minutesAgo(6) })]);
    expect(out[0]!.lines[0]!.tag).toBeNull();
  });
});

describe('the station filter', () => {
  const mixed = () => [
    ticket({ sessionId: A, standNumber: 12, stationId: ST.grill, name: 'Pork belly', addedAtDevice: minutesAgo(9) }),
    ticket({ sessionId: A, standNumber: 12, stationId: ST.drinks, name: 'Iced tea pitcher', addedAtDevice: minutesAgo(8) }),
    ticket({ sessionId: B, standNumber: 5, stationId: ST.drinks, name: 'Iced tea pitcher', addedAtDevice: minutesAgo(4) }),
    ticket({ sessionId: C, standNumber: 9, stationId: null, name: 'Starter set', addedAtDevice: minutesAgo(2) }),
  ];
  it('All (null or absent) shows every line, including a line with no station', async () => {
    for (const stationId of [null, undefined]) {
      const out = await cards(mixed(), { stationId });
      expect(out.map((c) => c.title)).toEqual(['Stand 12', 'Stand 5', 'Stand 9']);
      expect(out[0]!.lines).toHaveLength(2);
    }
  });
  it('Grill keeps only grill lines and drops the tables with none left', async () => {
    const out = await cards(mixed(), { stationId: ST.grill });
    expect(out.map((c) => c.title)).toEqual(['Stand 12']);
    expect(out[0]!.lines.map((l) => l.name)).toEqual(['Pork belly']);
  });
  it('Drinks keeps the drinks on both tables; the card\'s age and colour come from the remaining lines only', async () => {
    const out = await cards(mixed(), { stationId: ST.drinks });
    expect(out.map((c) => [c.title, c.ageMinutes, c.late])).toEqual([['Stand 12', 8, true], ['Stand 5', 4, false]]);
  });
  it('a station nobody has tickets for is an empty list, not an error', async () => {
    expect(await cards(mixed(), { stationId: ST.hot })).toEqual([]);
  });
});

describe('the chips across the top', () => {
  it('All first, then each station of the menu in the order the menu gives them', async () => {
    const { stationChips } = await load('cards');
    expect(stationChips(STATIONS)).toEqual([
      { id: null, label: 'All' },
      { id: ST.hot, label: 'Hot kitchen' },
      { id: ST.grill, label: 'Grill' },
      { id: ST.drinks, label: 'Drinks' },
    ]);
  });
  it('a store with no stations still has the All chip', async () => {
    const { stationChips } = await load('cards');
    expect(stationChips([])).toEqual([{ id: null, label: 'All' }]);
  });
});

describe('optimistic serve (R1 Writes)', () => {
  const t = () => [
    ticket({ sessionId: A, standNumber: 12, name: 'Pork belly', addedAtDevice: minutesAgo(9) }),
    ticket({ sessionId: A, standNumber: 12, name: 'Beef brisket', addedAtDevice: minutesAgo(8) }),
    ticket({ sessionId: B, standNumber: 5, name: 'Cheese corn', addedAtDevice: minutesAgo(4) }),
  ];
  it('a served line leaves its card at once; the other line stays and the card\'s age follows the line that is left', async () => {
    const tickets = t();
    const out = await cards(tickets, { hiddenLineIds: new Set([tickets[0]!.lineId]) });
    expect(out[0]!.lines.map((l) => l.name)).toEqual(['Beef brisket']);
    expect(out[0]!.ageMinutes).toBe(8);
  });
  it('All out hides every line of the card and the card goes', async () => {
    const tickets = t();
    const out = await cards(tickets, { hiddenLineIds: new Set([tickets[0]!.lineId, tickets[1]!.lineId]) });
    expect(out.map((c) => c.title)).toEqual(['Stand 5']);
  });
  it('a refusal brings it back: the same call without the line in the hidden set shows it again', async () => {
    const tickets = t();
    const out = await cards(tickets, { hiddenLineIds: new Set() });
    expect(out.map((c) => c.lines.length)).toEqual([2, 1]);
  });
});

describe('the remembered station filter (localStorage, a per-viewer convenience)', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const ids = STATIONS.map((s) => s.id);
  it('a saved station is read back on the next visit', async () => {
    const f = await load('station-filter');
    const s = memory();
    f.saveStationFilter(s, ST.drinks);
    expect(s.m.size).toBe(1);
    expect(s.m.has(f.KITCHEN_STATION_KEY)).toBe(true);
    expect(f.readStationFilter(s, ids)).toBe(ST.drinks);
  });
  it('choosing All forgets the station: read gives null', async () => {
    const f = await load('station-filter');
    const s = memory();
    f.saveStationFilter(s, ST.grill);
    f.saveStationFilter(s, null);
    expect(f.readStationFilter(s, ids)).toBeNull();
  });
  it('nothing saved reads as All', async () => {
    const f = await load('station-filter');
    expect(f.readStationFilter(memory(), ids)).toBeNull();
  });
  it('a saved station that is not one of the store\'s stations any more (retired) reads as All', async () => {
    const f = await load('station-filter');
    const s = memory();
    f.saveStationFilter(s, id(999));
    expect(f.readStationFilter(s, ids)).toBeNull();
  });
  it('storage that throws (private window, blocked site data) never throws out of read or save', async () => {
    const f = await load('station-filter');
    const boom = () => {
      throw new Error('SecurityError');
    };
    const broken = { getItem: boom, setItem: boom, removeItem: boom };
    expect(() => f.saveStationFilter(broken, ST.grill)).not.toThrow();
    expect(f.readStationFilter(broken, ids)).toBeNull();
  });
  it('no storage at all (null) is fine', async () => {
    const f = await load('station-filter');
    expect(() => f.saveStationFilter(null, ST.grill)).not.toThrow();
    expect(f.readStationFilter(null, ids)).toBeNull();
  });
});

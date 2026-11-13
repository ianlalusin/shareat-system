import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/menu/project';
import { POS_REDACTED } from '../../src/field-rules/pos';
import { applyPosEvents, replayQuarantinedEvent, scrubStatutoryHolders } from '../../src/pos/inbox';
import { asOrg, closeAll, counts, ev, eventsOf, fixture, HOLDER, IDNO, plainDay, RATES, salePayload, seniorEntry, signedIn, sql, standOpenedPayload, linesAddedPayload, uuid, nowIso, type Ev, type Fx } from './_fixtures/t525-pos';

/**
 * T-572 (DEF-823) - a senior or PWD card number and name are never stored in the POS device log (pos_events). docs/tasks/572-pos-events-senior-id-scrub.md.
 * The BIR register (statutory_discount_records) keeps them; the log does not. Real PostgreSQL; fixture shared with T-525.
 */
afterAll(closeAll);

const SECOND = { dinerNo: 2, kind: 'pwd', idNumber: 'PWD-7770031', holderName: 'Quibble Marmalade' };
const SECRETS = [IDNO, HOLDER, SECOND.idNumber, SECOND.holderName];
const SENTENCE = 'This sale had a senior or PWD discount. Its ID numbers are not kept in the device log, so it cannot be replayed. Discard it and ring the sale again.';

const send = (f: Fx, events: Ev[], madeOn?: { pairingId: string; revokedAt: Date | null }, pairingId = f.pairingId) =>
  applyPosEvents({ pairing: { pairingId, orgId: f.orgId, storeId: f.storeId }, events, ...(madeOn ? { madeOn } : {}) }, RATES);
const statuses = (r: Awaited<ReturnType<typeof send>>) => r.results.map((x) => x.status);

/** Two diners, a senior and a PWD, each on one head of a two-head pork line: stand, lines, two discounts, then the sale with both cards. */
function twoCardDay(f: Fx, o: { cards?: unknown[]; discounts?: boolean } = {}) {
  const sessionId = uuid();
  const porkLineId = uuid();
  const disc = (kind: string, dinerNo: number) => ({ discountId: uuid(), lineId: porkLineId, kind, qty: 1, dinerNo, appliedAtDevice: nowIso() });
  const payload = salePayload(f, { sessionId, porkLineId, cashPaid: '1000.00', seniors: o.cards ?? [seniorEntry(1), SECOND] });
  const sale = ev(o.discounts === false ? 3 : 5, 'sale.completed', f.counterId, payload);
  const events = [
    ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
    ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: porkLineId, item: f.menu.pork, qty: 2 }])),
    ...(o.discounts === false ? [] : [ev(3, 'discount.added', f.counterId, disc('senior', 1)), ev(4, 'discount.added', f.counterId, disc('pwd', 2))]),
    sale,
  ];
  return { sessionId, porkLineId, sale, events, payload };
}

/** Every pos_events row of the org, whole, as text: payload, error and every other column. */
const logText = async (f: Fx) => (await sql<{ t: string }[]>`select to_jsonb(e)::text t from pos_events e where org_id = ${f.orgId}`).map((r) => r.t).join('\n');
const noSecrets = (text: string) => { for (const s of SECRETS) expect(text, `the log must not hold ${s.slice(0, 4)}...`).not.toContain(s); };

describe('T-572 R1/R2 - nothing in the log, everything in the register', () => {
  it('1 (BOSS 4). a sale with two card holders: no pos_events row holds either number or name, as text, in payload or error - while the BIR register keeps both (R2)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = twoCardDay(f);
    expect(statuses(await send(f, day.events))).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    // and a second sale, refused (its discounts never arrived), so the log also holds a quarantined senior event with an error text
    const refused = twoCardDay(f, { discounts: false });
    const q = await send(f, refused.events.map((e, i) => ({ ...e, seq: 10 + i })));
    expect(statuses(q)).toEqual(['applied', 'applied', 'quarantined']);
    expect(q.results[2]!.error).toBeDefined();

    noSecrets(await logText(f));
    for (const r of q.results) noSecrets(r.error ?? '');
    const stored = (await eventsOf(f)).find((x) => x.seq === '5')!;
    expect(stored.payload.seniors).toEqual([
      { dinerNo: 1, kind: 'senior', idNumber: POS_REDACTED, holderName: POS_REDACTED },
      { dinerNo: 2, kind: 'pwd', idNumber: POS_REDACTED, holderName: POS_REDACTED },
    ]);
    const register = await sql<{ id_number: string; holder_name: string }[]>`select id_number, holder_name from statutory_discount_records where org_id = ${f.orgId} order by id_number`;
    expect(register.map((r) => [r.id_number, r.holder_name])).toEqual([[IDNO, HOLDER], [SECOND.idNumber, SECOND.holderName]]);
    expect((await counts(f)).statutory).toBe(2);
  });

  it('2. a key the tablet adds to a card holder (birthday, address) is dropped from the stored copy - the event is refused as invalid, and the log still holds none of it', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = twoCardDay(f, { cards: [{ ...seniorEntry(1), birthday: '1950-01-01' }, { ...SECOND, address: '1 Rizal St' }] });
    const r = await send(f, day.events);
    expect(statuses(r)).toEqual(['applied', 'applied', 'applied', 'applied', 'quarantined']);
    expect(r.results[4]!.error).toContain('POS_EVENT_INVALID');
    const stored = (await eventsOf(f)).find((x) => x.seq === '5')!;
    for (const c of stored.payload.seniors as Record<string, unknown>[]) expect(Object.keys(c).sort()).toEqual(['dinerNo', 'holderName', 'idNumber', 'kind']);
    const text = await logText(f);
    noSecrets(text);
    expect(text).not.toMatch(/1950-01-01|Rizal/);
  });
});

describe('T-572 R3 - a resend of a scrubbed sale', () => {
  it('4. the same sale sent again is a duplicate; so is a resend that differs only in the card number or name (both scrub to the marker)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = twoCardDay(f);
    expect(statuses(await send(f, day.events)).every((s) => s === 'applied')).toBe(true);
    expect(statuses(await send(f, [day.sale]))).toEqual(['duplicate']);
    const other = { ...day.sale, payload: { ...day.payload, seniors: [{ ...seniorEntry(1), idNumber: 'OSCA-0000001' }, { ...SECOND, holderName: 'Someone Else' }] } };
    expect(statuses(await send(f, [other]))).toEqual(['duplicate']);
    expect(await counts(f)).toMatchObject({ receipts: 1, statutory: 2 });
    noSecrets(await logText(f));
  });
});

describe('T-572 R4 - a quarantined senior sale cannot be replayed', () => {
  const replay = (f: Fx, eventId: string) => asOrg(f.orgId, (tx) => replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId }, RATES));

  async function quarantinedSeniorSale(f: Fx) {
    await signedIn(f, f.counterId);
    const day = twoCardDay(f, { discounts: false });
    expect(statuses(await send(f, day.events))).toEqual(['applied', 'applied', 'quarantined']);
    return { day, row: (await eventsOf(f)).find((x) => x.kind === 'sale.completed')! };
  }

  it('5a. the replay is refused with the sentence, the row stays open, and nothing is written (the discounts then arrive: still refused, never a "[redacted]" in the BIR register)', async () => {
    const f = await fixture();
    const { day, row } = await quarantinedSeniorSale(f);
    expect(await replay(f, row.id)).toEqual({ replayed: false, error: SENTENCE });
    // the discounts land late: the sale WOULD now run, so only the guard stops it
    const disc = (kind: string, dinerNo: number) => ({ discountId: uuid(), lineId: day.porkLineId, kind, qty: 1, dinerNo, appliedAtDevice: nowIso() });
    expect(statuses(await send(f, [ev(4, 'discount.added', f.counterId, disc('senior', 1)), ev(5, 'discount.added', f.counterId, disc('pwd', 2))]))).toEqual(['applied', 'applied']);
    expect(await replay(f, row.id)).toEqual({ replayed: false, error: SENTENCE });
    expect(await counts(f)).toMatchObject({ receipts: 0, statutory: 0 });
    expect((await eventsOf(f)).find((x) => x.id === row.id)).toMatchObject({ status: 'quarantined', resolution: null, resolved_by: null });
  });

  it('5b. the same refusal on the carried-over path: the tablet was replaced, so the replay would run under the live pairing', async () => {
    const f = await fixture();
    const { row } = await quarantinedSeniorSale(f);
    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.adminId}, revoke_reason = 'replaced by a new tablet' where id = ${f.pairingId}`;
    await sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${f.orgId}, ${f.storeId}, 'tablet-2', ${uuid() + uuid()}, ${f.adminId})`;
    expect(await replay(f, row.id)).toEqual({ replayed: false, error: SENTENCE });
    expect((await counts(f)).statutory).toBe(0);
  });

  it('5c. a quarantined sale with no seniors replays as before', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const [open, lines, sale] = plainDay(f).events as [Ev, Ev, Ev];
    expect(statuses(await send(f, [open, { ...sale, seq: 2 }, { ...lines, seq: 3 }]))).toEqual(['applied', 'quarantined', 'applied']);
    const row = (await eventsOf(f)).find((x) => x.kind === 'sale.completed')!;
    expect(await replay(f, row.id)).toEqual({ replayed: true });
    expect(await counts(f)).toMatchObject({ receipts: 1 });
  });
});

describe('T-572 R5 - migration 0252 redacts the rows that were stored before it', () => {
  const FILE = fileURLToPath(new URL('../../../db/migrations/0252_t572_pos_events_senior_id_scrub.sql', import.meta.url));
  const run0252 = () => sql.begin(async (tx) => { for (const s of readFileSync(FILE, 'utf8').split('--> statement-breakpoint')) await tx.unsafe(s); });

  it('6. a raw pre-0252 row becomes exactly what scrub stores; other rows are untouched; the freeze trigger is still on (an UPDATE is refused 23001)', async () => {
    const f = await fixture();
    const raw = twoCardDay(f, { cards: [{ ...seniorEntry(1), birthday: '1950-01-01' }, SECOND] }).payload;
    const odd = { ...raw, seniors: 'OSCA-12345' };
    const rows = [
      { seq: 1, kind: 'sale.completed', payload: raw },
      { seq: 2, kind: 'sale.completed', payload: { ...raw, seniors: [] } },
      { seq: 3, kind: 'sale.completed', payload: (({ seniors: _s, ...rest }) => rest)(raw) },
      { seq: 4, kind: 'stand.opened', payload: { seniors: [seniorEntry(1)] } },
      { seq: 5, kind: 'sale.completed', payload: odd },
    ];
    for (const r of rows) {
      await sql`insert into pos_events (org_id, store_id, pairing_id, seq, kind, payload, person_id, occurred_at_device, status)
                values (${f.orgId}, ${f.storeId}, ${f.pairingId}, ${r.seq}, ${r.kind}, ${sql.json(r.payload as never)}, ${f.counterId}, now(), 'applied')`;
    }
    await run0252();
    const after = new Map((await eventsOf(f)).map((x) => [Number(x.seq), x.payload]));
    expect(canonicalJson(after.get(1)), 'byte for byte what scrub stores').toBe(canonicalJson(scrubStatutoryHolders(raw)));
    expect(canonicalJson(after.get(5))).toBe(canonicalJson(scrubStatutoryHolders(odd)));
    for (const seq of [2, 3, 4]) expect(canonicalJson(after.get(seq)), `row ${seq} is untouched`).toBe(canonicalJson(rows[seq - 1]!.payload));
    noSecrets(JSON.stringify([after.get(1), after.get(5)]));
    expect(JSON.stringify(after.get(1))).not.toContain('1950');

    const [t] = await sql<{ tgenabled: string }[]>`select tgenabled from pg_trigger where tgname = 'pos_events_frozen' and tgrelid = 'pos_events'::regclass`;
    expect(t!.tgenabled, 'ENABLE ALWAYS').toBe('A');
    const err = await sql`update pos_events set payload = '{}'::jsonb where org_id = ${f.orgId} and seq = 1`.then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('23001');
    await run0252(); // idempotent: a second run changes nothing
    expect(canonicalJson((await eventsOf(f)).find((x) => x.seq === '1')!.payload)).toBe(canonicalJson(scrubStatutoryHolders(raw)));
  });
});

import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-564 — store settlement wiring (T-515 re-applied on main). `docs/tasks/564-store-settlement-wiring-renumber.md`.
 *
 * Stored, not yet read by intake: store key, match labels, file hints, wastage-email opt-in and per-channel bank hints. What this
 * file pins is the part that can be wrong today: the key is unique and immutable, another org sees nothing, a change leaves an
 * audit row, and the settlement preview carries plain-word wiring warnings WITHOUT ever blocking a post.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, storeChannelSettlementRepo, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  getStoreChannelSettlementConfig,
  previewChannelSettlement,
  saveStoreChannelSettlement,
  setSalesChannelBankHints,
  listSalesChannelsForAdmin,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t564-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('malvar');
  const otherStoreId = await mkStore('lipa');
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
  const mk = async (role: string, name: string, stores: string[]) => {
    const [q] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${q!.id}, ${orgId}, ${role})`;
    for (const st of stores) await sql`insert into person_store_scope (person_id, store_id) values (${q!.id}, ${st})`;
    return actor(orgId, q!.id);
  };
  const staff = await mk('staff', 'Staff', [storeId]);
  // A manager whose scope is the OTHER store only: allowed the capability, but not at `storeId`.
  const outsider = await mk('manager', 'Lipa manager', [otherStoreId]);
  return { orgId, storeId, otherStoreId, channelId: channel!.id, manager: actor(orgId, p!.id), staff, outsider };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const previewOf = (f: Fixture) =>
  asOrg(f.orgId, (tx) =>
    previewChannelSettlement(tx, f.manager, {
      storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
      grossAmount: '1000.00', netDeposited: '1000.00',
    }),
  );

/** The sentence a person is shown: a RefusalError (or a permission refusal) with a plain `userMessage`, never a bare Error. */
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  const isKnown = err instanceof RefusalError || err instanceof AuthorizationError;
  expect(isKnown, `expected a RefusalError or AuthorizationError, got ${String((err as Error)?.message)}`).toBe(true);
  const sentence = (err as RefusalError | AuthorizationError).userMessage;
  expect(sentence, 'the refusal carries a sentence for a person').toBeTruthy();
  return sentence as string;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the store key is unique and cannot be changed', () => {
  it('a second store taking the same key is refused by the database (23505 on the org+key index)', async () => {
    const f = await fixture('dupkey');
    await sql`insert into store_channel_settlement_configs (org_id, store_id, store_key) values (${f.orgId}, ${f.storeId}, 'malvar')`;
    const err = await sql`insert into store_channel_settlement_configs (org_id, store_id, store_key) values (${f.orgId}, ${f.otherStoreId}, 'malvar')`
      .then(() => null, (e: { code?: string; constraint_name?: string }) => e);
    expect(err?.code).toBe('23505');
    expect(err?.constraint_name).toBe('store_channel_settlement_configs_org_key_unique');
  });

  it('the same key may live in two different organisations', async () => {
    const a = await fixture('xorg-a');
    const b = await fixture('xorg-b');
    await asOrg(a.orgId, (tx) => saveStoreChannelSettlement(tx, a.manager, { storeId: a.storeId, storeKey: 'malvar' }));
    await asOrg(b.orgId, (tx) => saveStoreChannelSettlement(tx, b.manager, { storeId: b.storeId, storeKey: 'malvar' }));
  });

  it('through the domain, a clashing key is refused in plain words', async () => {
    const f = await fixture('domclash');
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar' }));
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.otherStoreId, storeKey: 'MALVAR' })))).toMatch(
      /Another store already uses the key “malvar”/,
    );
  });

  it('once saved the key cannot change; the other fields can, and the key stays', async () => {
    const f = await fixture('immutable');
    await asOrg(f.orgId, (tx) =>
      saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', matchLabels: ['Malvar Branch'] }),
    );
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar-2' })))).toMatch(
      /^This store's key is “malvar” and it cannot be changed once saved, because other records use it by that name\.$/,
    );
    await asOrg(f.orgId, (tx) =>
      saveStoreChannelSettlement(tx, f.manager, {
        storeId: f.storeId, storeKey: 'malvar', matchLabels: ['  Malvar Branch ', 'malvar branch', 'Share@ Malvar'], fileHints: ['mlv'],
        wastageEmailIngestEnabled: true,
      }),
    );
    const saved = await asOrg(f.orgId, (tx) => getStoreChannelSettlementConfig(tx, f.manager, f.storeId));
    expect(saved).toMatchObject({ storeKey: 'malvar', fileHints: ['mlv'], wastageEmailIngestEnabled: true });
    expect(saved!.matchLabels).toEqual(['Malvar Branch', 'malvar branch', 'Share@ Malvar']);
  });

  it('the app role has no UPDATE on store_key at all (the database backs the domain rule)', async () => {
    const f = await fixture('grant');
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar' }));
    await expect(
      asOrg(f.orgId, (tx) => tx.execute(dsql`update store_channel_settlement_configs set store_key = 'renamed' where org_id = ${f.orgId}`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a key that breaks the field rule is refused before anything is written', async () => {
    const f = await fixture('badkey');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'Not A Key!' })))).toBe(
      'The store key must be 2 to 24 lowercase letters, numbers or dashes, starting with a letter or number.',
    );
    expect(await asOrg(f.orgId, (tx) => storeChannelSettlementRepo.listConfigs(tx, f.orgId))).toEqual([]);
  });
});

describe('one organisation never sees another organisation’s wiring', () => {
  it('RLS: org B lists and reads nothing of org A, and cannot insert into org A', async () => {
    const a = await fixture('rls-a');
    const b = await fixture('rls-b');
    await asOrg(a.orgId, (tx) => saveStoreChannelSettlement(tx, a.manager, { storeId: a.storeId, storeKey: 'only-a' }));
    expect(await asOrg(b.orgId, (tx) => storeChannelSettlementRepo.listConfigs(tx, b.orgId))).toEqual([]);
    const rows = await asOrg(b.orgId, (tx) => tx.execute(dsql`select 1 from store_channel_settlement_configs where org_id = ${a.orgId}`));
    expect([...(rows as unknown as unknown[])]).toHaveLength(0);
    await expect(
      asOrg(b.orgId, (tx) =>
        tx.execute(dsql`insert into store_channel_settlement_configs (org_id, store_id, store_key) values (${a.orgId}, ${a.otherStoreId}, 'x-in-a')`),
      ),
    ).rejects.toThrow();
  });

  it('a store cannot be wired into a different organisation (same-org foreign key)', async () => {
    const a = await fixture('fk-a');
    const b = await fixture('fk-b');
    const err = await sql`insert into store_channel_settlement_configs (org_id, store_id, store_key) values (${a.orgId}, ${b.storeId}, 'cross')`
      .then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe('23503');
  });
});

describe('every change leaves an audit row', () => {
  it('saving the wiring audits once; saving the same thing again audits nothing', async () => {
    const f = await fixture('audit');
    const audits = () => sql<{ action: string }[]>`
      select action from audit_log where org_id = ${f.orgId} and action = 'store_settlement.wiring_saved'`;
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', fileHints: ['a'] }));
    expect(await audits()).toHaveLength(1);
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', fileHints: ['a'] }));
    expect(await audits()).toHaveLength(1);
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', fileHints: ['a', 'b'] }));
    expect(await audits()).toHaveLength(2);
  });

  it('bank hints on a channel are cleaned, saved and audited', async () => {
    const f = await fixture('bankhints');
    await asOrg(f.orgId, (tx) => setSalesChannelBankHints(tx, f.manager, { channelId: f.channelId, bankHints: [' BDO ', 'bdo', '', 'GCash'] }));
    const channels = await asOrg(f.orgId, (tx) => listSalesChannelsForAdmin(tx, f.manager, { storeId: f.storeId }));
    expect(channels.find((c) => c.id === f.channelId)!.bankHints).toEqual(['BDO', 'bdo', 'GCash']);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int n from audit_log where org_id = ${f.orgId} and action = 'sales_channel.bank_hints_edited' and entity_id = ${f.channelId}`;
    expect(row!.n).toBe(1);
  });
});

describe('omitted lists keep what is saved', () => {
  it('saving with only the key (labels and file hints omitted) leaves the saved labels, hints and opt-in alone; an empty list clears', async () => {
    const f = await fixture('keep');
    const save = (input: Partial<Parameters<typeof saveStoreChannelSettlement>[2]>) =>
      asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', ...input }));
    await save({ matchLabels: ['Malvar'], fileHints: ['mlv'], wastageEmailIngestEnabled: true });
    expect(await save({})).toEqual({ wrote: false });
    const kept = await asOrg(f.orgId, (tx) => getStoreChannelSettlementConfig(tx, f.manager, f.storeId));
    expect(kept).toMatchObject({ matchLabels: ['Malvar'], fileHints: ['mlv'], wastageEmailIngestEnabled: true });
    await save({ matchLabels: [] });
    const cleared = await asOrg(f.orgId, (tx) => getStoreChannelSettlementConfig(tx, f.manager, f.storeId));
    expect(cleared).toMatchObject({ matchLabels: [], fileHints: ['mlv'] });
  });
});

describe('size limits: at most 20 entries, 60 characters each', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `label ${i}`);
  const sixty = 'x'.repeat(60);
  const cases = [
    ['outlet names', (f: Fixture, v: string[]) => asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', matchLabels: v }))],
    ['file name starts', (f: Fixture, v: string[]) => asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', fileHints: v }))],
    ['bank names', (f: Fixture, v: string[]) => asOrg(f.orgId, (tx) => setSalesChannelBankHints(tx, f.manager, { channelId: f.channelId, bankHints: v }))],
  ] as const;
  for (const [name, write] of cases) {
    it(`${name}: exactly 20 entries and exactly 60 characters are accepted`, async () => {
      const f = await fixture(`lim-ok-${name}`);
      await write(f, twenty);
      await write(f, [sixty]);
    });
    it(`${name}: 21 entries, or one of 61 characters, is refused in plain words and nothing is written`, async () => {
      const f = await fixture(`lim-bad-${name}`);
      const said = /^(Outlet names|File name starts|Bank names): give at most 20, separated by commas, each at most 60 characters\.$/;
      expect(await sentenceOf(write(f, [...twenty, 'one more']))).toMatch(said);
      expect(await sentenceOf(write(f, ['x'.repeat(61)]))).toMatch(said);
      const [n] = await sql<{ n: number }[]>`
        select (select count(*) from store_channel_settlement_configs where org_id = ${f.orgId})::int
             + (select count(*) from sales_channels where org_id = ${f.orgId} and bank_hints <> '{}')::int as n`;
      expect(n!.n).toBe(0);
    });
  }
});

describe('who may write, and only inside their own organisation', () => {
  const STAFF = /^Your role \(Staff\) can't manage store settings\. Ask an admin if you need to\.$/;
  const OUT_OF_SCOPE = /^You aren't assigned to Store malvar \(.+\), so you can't manage store settings there\.$/;
  const OTHER_ORG = /^That store isn't part of Org .+\.$/;
  const storeRows = (orgId: string) => sql<{ n: number }[]>`select count(*)::int n from store_channel_settlement_configs where org_id = ${orgId}`;

  it('saveStoreChannelSettlement: staff (no manage_store_settings) is refused with a sentence; nothing is written', async () => {
    const f = await fixture('auth-staff');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.staff, { storeId: f.storeId, storeKey: 'malvar' })))).toMatch(STAFF);
    expect((await storeRows(f.orgId))[0]!.n).toBe(0);
  });

  it('saveStoreChannelSettlement: a manager outside the store scope is refused with a sentence', async () => {
    const f = await fixture('auth-scope');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.outsider, { storeId: f.storeId, storeKey: 'malvar' })))).toMatch(OUT_OF_SCOPE);
    expect((await storeRows(f.orgId))[0]!.n).toBe(0);
  });

  it('saveStoreChannelSettlement: another organisation store id is refused with a sentence and writes nothing in either org', async () => {
    const a = await fixture('auth-xorg-a');
    const b = await fixture('auth-xorg-b');
    expect(await sentenceOf(asOrg(a.orgId, (tx) => saveStoreChannelSettlement(tx, a.manager, { storeId: b.storeId, storeKey: 'sneaky' })))).toMatch(OTHER_ORG);
    expect((await storeRows(a.orgId))[0]!.n + (await storeRows(b.orgId))[0]!.n).toBe(0);
  });

  it('setSalesChannelBankHints: staff is refused with a sentence', async () => {
    const f = await fixture('bh-staff');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => setSalesChannelBankHints(tx, f.staff, { channelId: f.channelId, bankHints: ['bdo'] })))).toMatch(STAFF);
  });

  it('setSalesChannelBankHints: a manager outside the channel store scope is refused with a sentence', async () => {
    const f = await fixture('bh-scope');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => setSalesChannelBankHints(tx, f.outsider, { channelId: f.channelId, bankHints: ['bdo'] })))).toMatch(OUT_OF_SCOPE);
  });

  it('setSalesChannelBankHints: another organisation channel id reads as "no longer exists" and writes nothing', async () => {
    const a = await fixture('bh-xorg-a');
    const b = await fixture('bh-xorg-b');
    expect(await sentenceOf(asOrg(a.orgId, (tx) => setSalesChannelBankHints(tx, a.manager, { channelId: b.channelId, bankHints: ['bdo'] })))).toBe('That channel no longer exists.');
    const [n] = await sql<{ n: number }[]>`select count(*)::int n from sales_channels where id = ${b.channelId} and bank_hints <> '{}'`;
    expect(n!.n).toBe(0);
  });
});

describe('two first saves racing for one store cannot record a key that was not stored', () => {
  it('the loser is refused in plain words, and the audit trail names only the stored key', async () => {
    const f = await fixture('race');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aInserted!: () => void;
    const inserted = new Promise<void>((r) => (aInserted = r));
    const a = asOrg(f.orgId, async (tx) => {
      await saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'first' });
      aInserted();
      await gate; // hold A's transaction open so B starts while A's row is uncommitted
    });
    await inserted;
    const bSaid = sentenceOf(asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'second' })));
    await new Promise((r) => setTimeout(r, 400));
    release();
    await a;
    expect(await bSaid).toMatch(/^This store's key is “first” and it cannot be changed once saved/);
    const rows = await sql<{ after: { storeKey: string } }[]>`
      select "after" from audit_log where org_id = ${f.orgId} and action = 'store_settlement.wiring_saved'`;
    expect(rows.map((r) => r.after.storeKey)).toEqual(['first']);
    const [saved] = await sql<{ store_key: string }[]>`select store_key from store_channel_settlement_configs where org_id = ${f.orgId}`;
    expect(saved!.store_key).toBe('first');
  });
});

describe('the settlement preview carries wiring warnings and never blocks on them', () => {
  it('no wiring row: one plain warning about the missing store key; the post is not blocked', async () => {
    const f = await fixture('warn-none');
    const p = await previewOf(f);
    expect(p.storeKey).toBeNull();
    expect(p.wiringWarnings).toHaveLength(1);
    expect(p.wiringWarnings[0]).toMatch(/store key/i);
    expect(p.blockers.join(' ')).not.toMatch(/store key/i);
  });

  it('key saved but no labels and no file hints: a different warning, still not a blocker', async () => {
    const f = await fixture('warn-bare');
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar' }));
    const p = await previewOf(f);
    expect(p.storeKey).toBe('malvar');
    expect(p.wiringWarnings).toHaveLength(1);
    expect(p.wiringWarnings[0]).toMatch(/label|file hint|nothing to match/i);
    expect(p.wiringWarnings[0]).not.toMatch(/store key/i);
  });

  it('fully wired: no warnings', async () => {
    const f = await fixture('warn-ok');
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', matchLabels: ['Malvar'] }));
    const p = await previewOf(f);
    expect(p.wiringWarnings).toEqual([]);
  });

  it('⭐ nothing but the two new fields differs between an unwired and a wired preview (blockers and every figure identical)', async () => {
    const f = await fixture('unchanged');
    const before = await previewOf(f);
    await asOrg(f.orgId, (tx) => saveStoreChannelSettlement(tx, f.manager, { storeId: f.storeId, storeKey: 'malvar', matchLabels: ['Malvar'] }));
    const after = await previewOf(f);
    const strip = ({ storeKey: _k, wiringWarnings: _w, ...rest }: typeof before) => rest;
    expect(strip(after)).toEqual(strip(before));
  });
});

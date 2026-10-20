/**
 * T-440 S1 (TESTER) - the shared field-rule module: `packages/domain/src/field-rules/` (the client-safe leaf) and
 * `packages/domain/src/shared/field-rules-assert.ts` (the server half). Spec: docs/tasks/440-live-field-checks.md
 * section 3.1 and tests T-S1-1 .. T-S1-7, T-S1-15 (money T-S1-2 included). Audit A1, A5, A6, A7, A9. Node, no database.
 *
 * Every module is imported lazily, so while the builder has not written it each case fails on its own with
 * "Cannot find module" instead of the whole file dying at collection.
 *
 * CONTRACT PINNED HERE (the spec names the functions, not every shape; the builder matches this):
 *   defineFieldRules(form, rules) -> a FROZEN set. `set.form === form`; each rule is reachable as `set[ruleKey]`
 *     with `rule.name === ruleKey`. (Enumerate a set's rules by taking its values that carry a `kind`.)
 *   checkField(rule, raw) -> { ok: true, value: string | null }
 *                          | { ok: false, requirement: string, progress: string }
 *     raw may be null/undefined (= blank). Blank: optional -> { ok: true, value: null }; required -> progress "Required".
 *     text kind: the value is TRIMMED (whitespace-only is blank). digits kind: `strip: 'spaces-dashes'` removes spaces and
 *     dashes before checking AND in the returned value; min/max are LENGTHS; a non-digit gives progress "Digits only";
 *     too short gives "N more digit(s) needed" (singular at 1). Sentences are exact where this file quotes them.
 *     money kind: uses parseMoneyInput itself - `requirement` is its userMessage (humanLabel = rule.label).
 *     date kind: YYYY-MM-DD; "today" is the Manila business date (toBusinessDate()), never the UTC date.
 *   nativeAttrs(rule) -> { name, required?, maxLength?, inputMode? } and nothing else (spec 3.4).
 *   assertFieldRules(set, input) (from shared/field-rules-assert.ts): throws RefusalError (raw `${set.form}.${name}: ${kind}
 *     check failed`, userMessage === checkField(...).requirement) on the FIRST failing rule in definition order; returns
 *     { [name]: normalised string | null } for every rule. input: FormData | Record<string, unknown>; an absent key is
 *     blank; a non-string value (a File) is an internal fault (not a RefusalError).
 *   Index barrel: `export * from './<area>'` for every area file (A9), so a set exported by an area file is a value of the
 *     `field-rules` module namespace. A set is recognised as a frozen object with a string `form`.
 *
 * MUTANTS (each named at its case): <= for < ; strip removed ; Number(x) > 0 for the money parse ; edited server sentence ;
 * UTC date for the Manila date ; `optional` ignored ; `pattern`/`min`/`max` added to the native attrs ; a leaf importing
 * @shareat/db ; the raw diagnostic or a sentence interpolating the typed value.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const SRC = join(__dirname, '..', '..', 'src');
const LEAF_DIR = join(SRC, 'field-rules');
const ROOT = join(__dirname, '..', '..', '..', '..');
const leaf = () => import('../../src/field-rules');
const server = () => import('../../src/shared/field-rules-assert');
const refusal = () => import('../../src/shared/refusal');
const moneyInput = () => import('../../src/shared/money-input');

it('money range checks keep the amount in core money, never Number()', async () => {
  const source = readFileSync(join(LEAF_DIR, 'check.ts'), 'utf8');
  const moneyCase = source.slice(source.indexOf("case 'money':"), source.indexOf("case 'date':"));
  expect(moneyCase).not.toMatch(/\bNumber\s*\(/);
  const { checkField, defineFieldRules } = await leaf();
  const set = defineFieldRules('t440.money-boundary', {
    amount: { label: 'The amount', kind: 'money', min: 0.01, max: 999999999999.98 },
  });
  expect(checkField(set.amount, '0.00').ok).toBe(false);
  expect(checkField(set.amount, '0.01')).toEqual({ ok: true, value: '0.01' });
  expect(checkField(set.amount, '999999999999.98')).toEqual({ ok: true, value: '999999999999.98' });
  expect(checkField(set.amount, '999999999999.99').ok).toBe(false);
});

type Rule = Record<string, unknown> & { name: string; label: string; kind: string; optional?: true };
type Check = { ok: true; value: string | null } | { ok: false; requirement: string; progress: string };

const FIXTURE_RULES = {
  sss: { label: 'The SSS number', optional: true, kind: 'digits', min: 10, max: 10, strip: 'spaces-dashes' },
  tin: { label: 'The TIN', optional: true, kind: 'digits', min: 9, max: 12, strip: 'spaces-dashes' },
  title: { label: 'The title', kind: 'text', min: 2, max: 5 },
  note: { label: 'The note', optional: true, kind: 'text', max: 8 },
  days: { label: 'Days to pay', optional: true, kind: 'number', integer: true, min: 0, max: 365 },
  amount: { label: 'The amount', kind: 'money' },
  due: { label: 'The due date', optional: true, kind: 'date', notBeforeToday: true },
  until: { label: 'The end date', optional: true, kind: 'date', notAfterToday: true },
  code: { label: 'The code', optional: true, kind: 'pattern', pattern: '^[A-Za-z0-9]+$', patternSays: 'letters and digits' },
} as const;

async function fixtureSet() {
  const { defineFieldRules } = await leaf();
  return defineFieldRules('t440.fixture', FIXTURE_RULES as never) as unknown as Record<string, Rule> & { form: string };
}
async function check(rule: Rule, raw: string | null | undefined): Promise<Check> {
  const { checkField } = await leaf();
  return (checkField as unknown as (r: Rule, v: string | null | undefined) => Check)(rule, raw);
}
function failed(c: Check): { requirement: string; progress: string } {
  expect(c.ok, 'expected the value to FAIL the rule').toBe(false);
  if (c.ok) throw new Error('unreachable');
  return c;
}

/** Every frozen set exported by the leaf (the area files are re-exported by its index). */
async function exportedSets(): Promise<Array<Record<string, Rule> & { form: string }>> {
  const mod = (await leaf()) as Record<string, unknown>;
  return Object.values(mod).filter(
    (v): v is Record<string, Rule> & { form: string } =>
      typeof v === 'object' && v !== null && Object.isFrozen(v) && typeof (v as { form?: unknown }).form === 'string',
  );
}
const rulesOf = (set: Record<string, unknown>): Rule[] =>
  Object.values(set).filter((v): v is Rule => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string');
async function setWithRule(name: string) {
  const hit = (await exportedSets()).find((s) => rulesOf(s).some((r) => r.name === name));
  expect(hit, `a pilot rule set exported by field-rules carries a rule named "${name}"`).toBeDefined();
  return hit!;
}

describe('defineFieldRules', () => {
  it('returns a frozen set: form, and each rule reachable by key with name = key', async () => {
    const set = await fixtureSet();
    expect(Object.isFrozen(set)).toBe(true);
    expect(set.form).toBe('t440.fixture');
    expect(set.sss!.name).toBe('sss');
    expect(set.title!.label).toBe('The title');
    expect(() => {
      (set as Record<string, unknown>).extra = 1;
    }).toThrow();
  });
});

describe('T-S1-1 digits (mutants: <= for <; strip removed)', () => {
  it('10 digits pass; the value is the digits', async () => {
    const s = await fixtureSet();
    expect(await check(s.sss!, '1234567890')).toEqual({ ok: true, value: '1234567890' });
  });
  it('9 fail with the exact sentence and "1 more digit needed"; 11 fail; 7 say "3 more digits needed"', async () => {
    const s = await fixtureSet();
    const nine = failed(await check(s.sss!, '123456789'));
    expect(nine.requirement).toBe('The SSS number must be 10 digits.');
    expect(nine.progress).toBe('1 more digit needed');
    expect(failed(await check(s.sss!, '1234567')).progress).toBe('3 more digits needed');
    expect(failed(await check(s.sss!, '12345678901')).requirement).toBe('The SSS number must be 10 digits.');
  });
  it('"12-345 6789-0" passes and is normalised to 10 digits (the strip is real)', async () => {
    const s = await fixtureSet();
    expect(await check(s.sss!, '12-345 6789-0')).toEqual({ ok: true, value: '1234567890' });
  });
  it('a letter is "Digits only"', async () => {
    const s = await fixtureSet();
    expect(failed(await check(s.sss!, '12345abcde')).progress).toBe('Digits only');
  });
  it('a range (9 to 12) has its own sentence and both edges are inclusive', async () => {
    const s = await fixtureSet();
    expect(failed(await check(s.tin!, '12345678')).requirement).toBe('The TIN must be 9 to 12 digits.');
    expect((await check(s.tin!, '123456789')).ok).toBe(true);
    expect((await check(s.tin!, '123456789012')).ok).toBe(true);
    expect((await check(s.tin!, '1234567890123')).ok).toBe(false);
  });
  it('text: min/max are lengths, edges inclusive, the value is trimmed', async () => {
    const s = await fixtureSet();
    expect(await check(s.title!, '  ab  ')).toEqual({ ok: true, value: 'ab' });
    expect((await check(s.title!, 'abcde')).ok).toBe(true);
    expect(failed(await check(s.title!, 'abcdef')).progress).toMatch(/too long/);
    expect(failed(await check(s.title!, 'a')).progress).toMatch(/more/);
  });
  it('number: whole numbers in range; 0 and 365 pass, -1, 366, 1.5 and text fail', async () => {
    const s = await fixtureSet();
    expect(await check(s.days!, '0')).toEqual({ ok: true, value: '0' });
    expect((await check(s.days!, '365')).ok).toBe(true);
    for (const bad of ['-1', '366', '1.5', 'abc']) expect((await check(s.days!, bad)).ok, bad).toBe(false);
  });
  it('pattern: a match passes; a miss fails and names patternSays', async () => {
    const s = await fixtureSet();
    expect((await check(s.code!, 'AB12')).ok).toBe(true);
    const bad = failed(await check(s.code!, 'AB-12'));
    expect(`${bad.requirement} ${bad.progress}`).toMatch(/letters and digits/i);
  });
});

describe('T-S1-2 money uses parseMoneyInput itself (mutant: Number(x) > 0)', () => {
  const bad = ['0.004', '1.234', 'abc', '1e400', '1,250.00'];
  it.each(bad)('"%s" fails with parseMoneyInput\'s own sentence (A7: commas are refused)', async (raw) => {
    const s = await fixtureSet();
    const { parseMoneyInput } = await moneyInput();
    let expected: string | undefined;
    try {
      parseMoneyInput(raw, 'amount', 'The amount');
    } catch (e) {
      expected = (e as { userMessage?: string }).userMessage;
    }
    expect(expected, 'parseMoneyInput itself refuses it').toBeTruthy();
    // Ian, 20 October: money alone keeps the parser's exact quoted-amount sentence.
    const f = failed(await check(s.amount!, raw));
    expect(f.requirement).toBe(expected);
    expect(f.progress).not.toContain(raw);
  });
  it.each(['12abc', '1,250.00x', 'SECRET9'])('money typing "%s": only the user-facing requirement quotes the amount, never the raw diagnostic or progress', async (raw) => {
    const s = await fixtureSet();
    const f = failed(await check(s.amount!, raw));
    expect(f.requirement).toContain(raw);
    expect(f.progress).not.toContain(raw);
    const { assertFieldRules } = await server();
    let err: { message: string; userMessage: string } | undefined;
    try {
      (assertFieldRules as unknown as (a: unknown, b: unknown) => unknown)({ form: 'x', amount: s.amount }, { amount: raw });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.userMessage).toBe(f.requirement);
    expect(err?.message).not.toContain(raw);
    expect(err?.userMessage).toContain(raw);
  });
  it('"1250.00" passes', async () => {
    const s = await fixtureSet();
    expect(await check(s.amount!, '1250.00')).toEqual({ ok: true, value: '1250.00' });
  });
});

describe('T-S1-4 the date rule uses the Manila business date (mutant: UTC new Date().toISOString().slice(0,10))', () => {
  afterEach(() => vi.useRealTimers());
  it('at 2026-10-17T16:30:00Z (18 Oct in Manila) notAfterToday passes 2026-10-18 and refuses 2026-10-19', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T16:30:00Z'));
    const s = await fixtureSet();
    expect(await check(s.until!, '2026-10-18')).toEqual({ ok: true, value: '2026-10-18' });
    const late = failed(await check(s.until!, '2026-10-19'));
    expect(late.progress).toMatch(/after today/);
    // the sentence names the Manila date (18 Oct), not the UTC date (17 Oct)
    expect(late.progress).toMatch(/18/);
    expect(late.progress).not.toMatch(/\b17\b/);
  });
  it('notBeforeToday passes 2026-10-18 and refuses 2026-10-17 at the same instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T16:30:00Z'));
    const s = await fixtureSet();
    expect((await check(s.due!, '2026-10-18')).ok).toBe(true);
    expect(failed(await check(s.due!, '2026-10-17')).progress).toMatch(/before today/);
  });
  it('a date that is not a real date fails', async () => {
    const s = await fixtureSet();
    for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow']) expect((await check(s.until!, bad)).ok, bad).toBe(false);
  });
});

describe('T-S1-5 blank (mutant: `optional` ignored)', () => {
  it('an optional blank passes as null (empty, spaces, null, undefined, and dashes-only for a stripped digits rule)', async () => {
    const s = await fixtureSet();
    for (const raw of ['', '   ', null, undefined]) expect(await check(s.note!, raw), String(raw)).toEqual({ ok: true, value: null });
    expect(await check(s.sss!, ' - ')).toEqual({ ok: true, value: null });
  });
  it('a required blank fails with progress "Required" and a sentence (text, money)', async () => {
    const s = await fixtureSet();
    for (const [rule, raw] of [[s.title!, ''], [s.title!, '   '], [s.title!, undefined], [s.amount!, '']] as const) {
      const f = failed(await check(rule, raw));
      expect(f.progress).toBe('Required');
      expect(f.requirement.length).toBeGreaterThan(5);
    }
  });
});

describe('T-S1-6 nativeAttrs: only exact equivalents (mutant: add `pattern`)', () => {
  const FORBIDDEN = ['pattern', 'min', 'max', 'minLength', 'step', 'type'];
  it('every kind: name always; required unless optional; never pattern/min/max', async () => {
    const { nativeAttrs } = await leaf();
    const s = await fixtureSet();
    for (const r of rulesOf(s)) {
      const attrs = (nativeAttrs as unknown as (x: Rule) => Record<string, unknown>)(r);
      expect(attrs.name, r.name).toBe(r.name);
      for (const k of FORBIDDEN) expect(Object.keys(attrs), `${r.name} must not carry ${k}`).not.toContain(k);
      expect(attrs.required === true, `${r.name} required`).toBe(r.optional !== true);
      expect(Object.keys(attrs).every((k) => ['name', 'required', 'maxLength', 'inputMode'].includes(k)), r.name).toBe(true);
    }
  });
  it('maxLength only for an unstripped text rule; inputMode numeric for digits/integer, decimal for money, none for text/date/pattern', async () => {
    const { nativeAttrs } = await leaf();
    const n = nativeAttrs as unknown as (x: Rule) => Record<string, unknown>;
    const s = await fixtureSet();
    expect(n(s.title!)).toEqual({ name: 'title', required: true, maxLength: 5 });
    expect(n(s.note!)).toEqual({ name: 'note', maxLength: 8 });
    expect(n(s.sss!)).toEqual({ name: 'sss', inputMode: 'numeric' }); // digits: no maxLength (strip allows dashes)
    expect(n(s.days!)).toEqual({ name: 'days', inputMode: 'numeric' });
    expect(n(s.amount!)).toEqual({ name: 'amount', required: true, inputMode: 'decimal' });
    expect(n(s.due!)).toEqual({ name: 'due' });
    expect(n(s.code!)).toEqual({ name: 'code' });
  });
});

describe('T-S1-7 the leaf is pure (mutant: a leaf importing @shareat/db)', () => {
  /** Every module specifier a file imports/exports/requires/dynamically imports. */
  function specifiers(source: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
    for (const m of source.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
    for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
    return out;
  }
  const ALLOWED = (s: string) =>
    /^\.\/[A-Za-z0-9_-]+$/.test(s) || s === '../shared/money-input' || s === '../shared/manual-cost-pattern' || s === '@shareat/core/datetime' || s === '@shareat/core/money' || s === '@shareat/core/sentence';
  const offenders = (source: string) => specifiers(source).filter((s) => !ALLOWED(s));

  it('positive controls: the detector flags db, auth, refusal, the barrel and a deep relative; allows the legal pure leaves/core modules', () => {
    const src = [
      "import { db } from '@shareat/db';",
      "import { a } from '@shareat/auth';",
      "export * from '../shared/refusal';",
      "import x from '@shareat/domain';",
      "const y = await import('../ap/index');",
      "const z = require('postgres');",
      "import { ok } from './check';",
      "import { m } from '../shared/money-input';",
      "import { cost } from '../shared/manual-cost-pattern';",
      "import { d } from '@shareat/core/datetime';",
      "import { u } from '@shareat/core/money';",
    ].join('\n');
    expect(offenders(src)).toEqual(['@shareat/db', '@shareat/auth', '../shared/refusal', '@shareat/domain', '../ap/index', 'postgres']);
  });
  it('the directory exists with index.ts, check.ts and no other kind of file', () => {
    expect(existsSync(LEAF_DIR), 'packages/domain/src/field-rules/ exists').toBe(true);
    const files = readdirSync(LEAF_DIR);
    expect(files).toContain('index.ts');
    expect(files).toContain('check.ts');
    expect(files.filter((f) => !f.endsWith('.ts'))).toEqual([]);
  });
  it('every file in field-rules/ imports only the allowed list (A1: no refusal, no db, no auth, no barrel)', () => {
    const bad: string[] = [];
    for (const f of readdirSync(LEAF_DIR).filter((x) => x.endsWith('.ts'))) {
      for (const s of offenders(readFileSync(join(LEAF_DIR, f), 'utf8'))) bad.push(`${f} imports ${s}`);
    }
    expect(bad).toEqual([]);
    expect(specifiers(readFileSync(join(SRC, 'shared/manual-cost-pattern.ts'), 'utf8'))).toEqual([]);
    expect(specifiers(readFileSync(join(ROOT, 'packages/core/src/sentence.ts'), 'utf8'))).toEqual([]);
  });
  it('A9: one file per sweep area exists and index.ts re-exports each (no sweep worker edits index.ts)', () => {
    const AREAS = [
      'inventory', 'ap', 'settings', 'commissary', 'payroll', 'fixed-assets', 'menu', 'loans', 'owners', 'staff', 'attendance',
      'prepaid', 'cash-requests', 'customers', 'expenses', 'trade', 'cutover', 'statutory-discounts', 'admin', 'money-transfers',
      'liabilities', 'channel-settlements', 'items', 'sales-days', 'setup', 'wastage', 'sign-in', 'remittance', 'money-accounts',
      'service-charge', 'findings', 'budgets', 'till', 'reports', 'clock',
    ];
    const index = existsSync(join(LEAF_DIR, 'index.ts')) ? readFileSync(join(LEAF_DIR, 'index.ts'), 'utf8') : '';
    const missingFile = AREAS.filter((a) => !existsSync(join(LEAF_DIR, `${a}.ts`)));
    const notExported = AREAS.filter((a) => !new RegExp(`from\\s*['"]\\./${a}['"]`).test(index));
    expect({ missingFile, notExported }).toEqual({ missingFile: [], notExported: [] });
  });
  it('the leaf barrel does NOT export the server half (A1); the @shareat/domain barrel does', () => {
    const idx = readFileSync(join(LEAF_DIR, 'index.ts'), 'utf8');
    expect(idx).not.toMatch(/field-rules-assert|assertFieldRules|\.\.\/shared\/refusal/);
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toMatch(/field-rules-assert/);
  });
  it('resolution: package.json exports ./field-rules, and vitest + both tsconfigs map it BEFORE the bare @shareat/domain', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./field-rules']).toMatch(/src\/field-rules(\/index\.ts)?$/);
    const vitest = readFileSync(join(ROOT, 'vitest.config.mts'), 'utf8');
    expect(vitest).toContain("'@shareat/domain/field-rules'");
    expect(vitest.indexOf("'@shareat/domain/field-rules'")).toBeLessThan(vitest.indexOf("'@shareat/domain':"));
    for (const f of ['tsconfig.json', 'apps/erp/tsconfig.json']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toContain('"@shareat/domain/field-rules"');
    }
  });
});

describe('T-S1-3 parity: the server throws the very sentence the screen shows (mutant: edit one server sentence)', () => {
  it('money hints hide pasted identifiers and collapse whitespace exactly as server refusals do', async () => {
    const { defineFieldRules, checkField } = await leaf();
    const { assertFieldRules } = await server();
    const set = defineFieldRules('money-privacy', { amount: { label: 'The amount', kind: 'money' } });
    for (const [raw, quoted] of [
      ['a1234567-1234-1234-1234-123456789abc', '[hidden]'],
      ['1,\n0OO', '1, 0OO'],
      ['1,0OO', '1,0OO'],
    ] as const) {
      const sentence = `The amount — "${quoted}" is not a valid amount. Use at most two decimal places.`;
      expect(checkField(set.amount, raw)).toEqual({ ok: false, requirement: sentence, progress: 'Enter an amount like 1250.00' });
      try {
        assertFieldRules(set, { amount: raw });
        expect.unreachable('invalid amount must be refused');
      } catch (e) {
        expect((e as { userMessage: string }).userMessage).toBe(sentence);
        expect((e as Error).message).toBe('money-privacy.amount: money check failed');
      }
    }
  });
  const CANDIDATES = [
    '', '   ', 'abc', '!', '-1', '1.5', '0.004', '1e400', '1,250.00', '12', '123', '4815162342x', '99999999999999999999',
    '123456789012345678901234567890', 'x'.repeat(600), '2026-02-30', '1900-01-01', '2999-12-31', 'bad value',
    'a1234567-1234-1234-1234-123456789abc', '1,\n0OO',
  ];
  /** The rule alone, as a set of one, so the others cannot fail first. */
  async function solo(set: { form: string }, rule: Rule) {
    const { defineFieldRules } = await leaf();
    const { name: _n, ...rest } = rule;
    void _n;
    return (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, Rule>)(set.form, { [rule.name]: rest });
  }
  async function everySet() {
    return [await fixtureSet(), ...(await exportedSets())];
  }

  it('for every rule of the fixture and of every exported set, each bad value throws a RefusalError whose userMessage equals checkField().requirement and whose raw message names form.rule: kind (no value)', async () => {
    const { assertFieldRules } = await server();
    const { RefusalError } = await refusal();
    let exercised = 0;
    for (const set of await everySet()) {
      for (const rule of rulesOf(set)) {
        const one = await solo(set, rule);
        for (const raw of CANDIDATES) {
          const c = await check(rule, raw);
          if (c.ok) continue;
          let thrown: unknown;
          try {
            (assertFieldRules as unknown as (s: unknown, i: unknown) => unknown)(one, { [rule.name]: raw });
          } catch (e) {
            thrown = e;
          }
          const where = `${set.form}.${rule.name} <- ${JSON.stringify(raw.slice(0, 20))}`;
          expect(thrown, `${where} must throw`).toBeInstanceOf(RefusalError);
          const err = thrown as InstanceType<typeof RefusalError>;
          expect(err.userMessage, where).toBe(c.requirement);
          expect(err.message, where).toBe(`${set.form}.${rule.name}: ${rule.kind} check failed`);
          exercised += 1;
        }
      }
    }
    expect(exercised, 'the loop is not vacuous').toBeGreaterThan(40);
  });

  it('a value that PASSES does not throw and comes back normalised (Record and FormData agree; absent key = blank)', async () => {
    const { assertFieldRules } = await server();
    const s = await fixtureSet();
    const assertIt = assertFieldRules as unknown as (set: unknown, input: unknown) => Record<string, string | null>;
    const good = { sss: '12-3456789-0', tin: '', title: '  abc ', days: '30', amount: '1250.00', until: '', due: '', code: 'AB12' };
    const expected = { sss: '1234567890', tin: null, note: null, title: 'abc', days: '30', amount: '1250.00', until: null, due: null, code: 'AB12' };
    expect(assertIt(s, good)).toEqual(expected);
    const fd = new FormData();
    for (const [k, v] of Object.entries(good)) fd.set(k, v);
    expect(assertIt(s, fd)).toEqual(expected);
  });

  it('the FIRST failing rule in definition order is the one refused', async () => {
    const { assertFieldRules } = await server();
    const s = await fixtureSet();
    let err: { userMessage?: string } | undefined;
    try {
      (assertFieldRules as unknown as (a: unknown, b: unknown) => unknown)(s, { sss: '1', tin: '2', title: '', amount: '' });
    } catch (e) {
      err = e as { userMessage?: string };
    }
    expect(err?.userMessage).toBe('The SSS number must be 10 digits.');
  });

  it('A6: a non-string (a File/Blob) is an internal fault, not a refusal sentence', async () => {
    const { assertFieldRules } = await server();
    const { RefusalError } = await refusal();
    const s = await fixtureSet();
    let thrown: unknown;
    try {
      (assertFieldRules as unknown as (a: unknown, b: unknown) => unknown)(s, { title: new Blob(['x']) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RefusalError);
  });
});

describe('T-S1-15 no echo (A5): non-money never echoes; money progress and diagnostics never echo', () => {
  // Ian, 20 October: money requirements may quote the amount; raw diagnostics and progress never do.
  const TOKENS = ['4815162342x', 'SECRETSECRET', 'SECRET-9', 'SECRETDATE'];
  it('fixture and every exported set preserve non-money privacy and the money-only requirement exception', async () => {
    const { assertFieldRules } = await server();
    const { defineFieldRules } = await leaf();
    let exercised = 0;
    for (const set of [await fixtureSet(), ...(await exportedSets())]) {
      for (const rule of rulesOf(set)) {
        const { name: _n, ...rest } = rule;
        void _n;
        const one = (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, Rule>)(set.form, { [rule.name]: rest });
        for (const raw of TOKENS) {
          const c = await check(rule, raw);
          if (c.ok) continue;
          let err: { message: string; userMessage: string } | undefined;
          try {
            (assertFieldRules as unknown as (a: unknown, b: unknown) => unknown)(one, { [rule.name]: raw });
          } catch (e) {
            err = e as { message: string; userMessage: string };
          }
          const all = JSON.stringify(rule.kind === 'money' ? [c.progress, err?.message] : [c.requirement, c.progress, err?.message, err?.userMessage]);
          expect(all, `${set.form}.${rule.name} leaked ${raw}`).not.toContain(raw);
          exercised += 1;
        }
      }
    }
    expect(exercised).toBeGreaterThan(8);
  });
});

describe('pilot rule sets exist with the spec\'s rules (staff government IDs, supplier add form)', () => {
  it('SSS 10 / PhilHealth 12 / Pag-IBIG 12 / TIN 9-12 digits, all optional, with the sentences the server speaks today', async () => {
    const gov = await setWithRule('sssNo');
    for (const k of ['philhealthNo', 'pagibigNo', 'tin']) expect(gov[k], k).toBeDefined();
    expect(failed(await check(gov.sssNo!, '123')).requirement).toBe('The SSS number must be 10 digits.');
    expect(failed(await check(gov.philhealthNo!, '123')).requirement).toBe('The PhilHealth number must be 12 digits.');
    expect(failed(await check(gov.pagibigNo!, '123')).requirement).toBe('The Pag-IBIG number must be 12 digits.');
    expect(failed(await check(gov.tin!, '123')).requirement).toBe('The TIN must be 9 to 12 digits.');
    for (const k of ['sssNo', 'philhealthNo', 'pagibigNo', 'tin']) expect(await check(gov[k]!, ''), k).toEqual({ ok: true, value: null });
    expect(await check(gov.sssNo!, '12-3456789-0')).toEqual({ ok: true, value: '1234567890' });
  });
  it('supplier add form: name required text; creditTermsDays optional whole number 0-365', async () => {
    const sup = await setWithRule('creditTermsDays');
    const name = (await setWithRule('name'))['name']!;
    expect(failed(await check(name, '   ')).progress).toBe('Required');
    expect(await check(name, '  ABC Meat  ')).toEqual({ ok: true, value: 'ABC Meat' });
    expect(await check(sup.creditTermsDays!, '')).toEqual({ ok: false, requirement: 'Days to pay is required.', progress: 'Required' });
    expect((await check(sup.creditTermsDays!, '365')).ok).toBe(true);
    // audit (b): "-0" is not a number of days; the rule is the ONE definition and the server speaks it.
    for (const bad of ['366', '-1', '-0', '-00', ' -0 ', '+5', '1.5', 'x']) expect((await check(sup.creditTermsDays!, bad)).ok, bad).toBe(false);
    expect(await check(sup.creditTermsDays!, '0')).toEqual({ ok: true, value: '0' });
  });
});

describe('payroll/rates.ts source: the inline digits() helper is deleted and the value-echoing diagnostic is gone (spec 3.2, A5)', () => {
  const src = () => readFileSync(join(SRC, 'payroll', 'rates.ts'), 'utf8');
  it('setGovernmentIds calls assertFieldRules and no longer defines `digits` or interpolates "${v}"', () => {
    const s = src();
    const fn = s.slice(s.indexOf('export function setGovernmentIds'), s.indexOf('export function setGovernmentIds') + 4000);
    expect(fn).toMatch(/assertFieldRules\(/);
    expect(fn).not.toMatch(/const digits\s*=/);
    expect(fn).not.toMatch(/has the wrong shape/);
    expect(fn).not.toMatch(/"\$\{v\}"/);
  });
});

describe('T440 existing bound sentences', () => {
  it('a range-only sentence does not replace the blank or malformed-money sentence', async () => {
    const { defineFieldRules, checkField } = await leaf();
    const s = defineFieldRules('range-example', { amount: { kind: 'money', label: 'The amount', min: 0.01, rangeSays: 'The amount has to be greater than zero.' } });
    expect(checkField(s.amount, '0')).toMatchObject({ ok: false, requirement: 'The amount has to be greater than zero.' });
    expect(checkField(s.amount, '')).toMatchObject({ ok: false, requirement: "The amount — can't be left blank. Enter an amount." });
    expect(checkField(s.amount, 'abc')).toMatchObject({ ok: false, requirement: 'The amount — "abc" is not a valid amount. Use at most two decimal places.' });
  });
});

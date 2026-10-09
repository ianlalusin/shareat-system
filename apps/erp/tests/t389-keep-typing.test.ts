import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_COOKIE, captureRedirect, currentJar, resetJar } from './helpers/flash-jar';

/**
 * T-389 S1 - K1 (the keep-typing helper) and K3 (typedFor, through the real flash). DEF-617.
 * Spec: docs/tasks/389-refused-save-keeps-typing.md, R2, R4, R5, K1, K3.
 *
 * Red on HEAD because `apps/erp/src/lib/keep-typing.ts` does not exist. Every leg loads it through `kt()` inside
 * `beforeAll`, so the file fails by name (the T-380 precedent) instead of collapsing at collection.
 * Each test names its killing mutant in a `Mutant:` line.
 *
 * CONTRACT PINNED HERE (the spec names the functions, not every edge; the builder matches this):
 *   defineTypedForm({ form, fields }) -> def with `def.form` (the string) and `def.fields` (the list given).
 *   keepTyping(fd, def, record, opts?) -> { form: def.form, record, fields } | undefined.
 *   - fields holds a name only if the FormData has it AND it is allow-listed (string entry, or a RegExp entry that
 *     matches) AND it is not on the deny list (NEVER_ECHO or SENSITIVE) AND, when the form sent `__changed`
 *     (comma-separated names), it is in that list. `__changed` itself is never kept.
 *   - a single value is a STRING, two or more values for one name are a string[] in submitted order.
 *   - SPEC GAP, pinned: a name that is in `__changed` and allow-listed but ABSENT from the FormData (an unticked
 *     checkbox sends nothing) is kept as `[]`. Without that, un-ticking a box and getting a refusal would reopen
 *     the record with the box ticked again (names not in `fields` keep the stored value, R3). Without `__changed`
 *     an absent name is simply not kept (nothing says the user changed it).
 *   - a File value is never kept; values are never trimmed, shortened or logged.
 *   - returns undefined for: opts.stale === true; a blank `record`; nothing kept.
 *   typedFor(sp, def, record) -> { kind: 'typed', fields } | { kind: 'dropped' } | null   (R2).
 */

vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

const logSpy = vi.hoisted(() => {
  const fn = () => vi.fn();
  const l = { warn: fn(), info: fn(), error: fn(), debug: fn(), trace: fn(), fatal: fn(), child: undefined as unknown };
  l.child = () => l;
  return l;
});
vi.mock('@shareat/core/logger', () => ({ logger: logSpy, childLogger: () => logSpy }));
vi.mock('@shareat/core', async (orig) => ({ ...(await orig<Record<string, unknown>>()), logger: logSpy }));

const BASE = {
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
};

type KT = {
  defineTypedForm(def: { form: string; fields: ReadonlyArray<string | RegExp> }): { form: string; fields: ReadonlyArray<string | RegExp> };
  keepTyping(
    fd: FormData,
    def: ReturnType<KT['defineTypedForm']>,
    record: string,
    opts?: { stale?: boolean },
  ): { form: string; record: string; fields: Record<string, string | string[]> } | undefined;
  typedFor(
    sp: { typed?: { form: string; record: string; fields: Record<string, string | string[]> }; typedDropped?: { form: string; record: string } },
    def: ReturnType<KT['defineTypedForm']>,
    record: string,
  ): { kind: 'typed'; fields: Record<string, string | string[]> } | { kind: 'dropped' } | null;
};
type Flash = typeof import('../src/lib/flash');
let ktMod: KT;
let flash: Flash;
const kt = (): KT => ktMod;

beforeAll(async () => {
  process.env = { ...process.env, ...BASE } as unknown as NodeJS.ProcessEnv;
  const specifier = '@/lib/keep-typing';
  ktMod = (await import(/* @vite-ignore */ specifier).catch((err: unknown) => {
    throw new Error(`apps/erp/src/lib/keep-typing.ts cannot be loaded (T-389 S1 builder file): ${String(err)}`);
  })) as KT;
  flash = (await import('@/lib/flash')) as Flash;
}, 60_000);

beforeEach(() => {
  resetJar();
  for (const fn of [logSpy.warn, logSpy.info, logSpy.error, logSpy.debug]) fn.mockClear();
});


const A0 = '00000000-0000-4000-8000-0000000000a0';
/** The builder's contract (S1 audit): keepTyping needs { actorId }, typedFor needs the reading actor. These shims supply one actor. */
const keep = (fd: FormData, d: ReturnType<KT['defineTypedForm']>, r: string, o: { stale?: boolean } = {}) =>
  (kt().keepTyping as unknown as (...a: unknown[]) => ReturnType<KT['keepTyping']>)(fd, d, r, { actorId: A0, ...o });
const tf = (sp: Parameters<KT['typedFor']>[0], d: ReturnType<KT['defineTypedForm']>, r: string) =>
  (kt().typedFor as unknown as (...a: unknown[]) => ReturnType<KT['typedFor']>)(sp, d, r, A0);

const REC = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-1111-4222-8333-444455556666';

function form(entries: Array<[string, string | File]>): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}
const def = (fields: ReadonlyArray<string | RegExp>, key = 'supplier.edit') => kt().defineTypedForm({ form: key, fields });

describe('K1 - keepTyping: which names ride, and what never does', () => {
  it('keeps only allow-listed names; ids, the version and unknown names are left out', () => {
    const d = def(['name', 'notes']);
    const out = keep(form([['supplierId', REC], ['version', '7'], ['name', 'Typed Co'], ['notes', 'n'], ['evil', 'x']]), d, REC);
    expect(out).toMatchObject({ form: 'supplier.edit', record: REC, fields: { name: 'Typed Co', notes: 'n' } });
    // Mutant: keep every name in the FormData -> supplierId / version / evil appear, red.
  });

  it('a RegExp entry matches by name (line1_itemId ... line5_unitPrice) and nothing else', () => {
    const d = def([/^line[1-5]_(itemId|quantity|unitPrice)$/]);
    const out = keep(
      form([['line1_itemId', 'i1'], ['line5_unitPrice', '9.50'], ['line6_itemId', 'no'], ['line1_other', 'no'], ['invoiceId', REC]]),
      d,
      REC,
    );
    expect(out?.fields).toEqual({ line1_itemId: 'i1', line5_unitPrice: '9.50' });
    // Mutant: treat a RegExp entry as "keep everything" -> line6_itemId / invoiceId appear, red.
  });

  it('R5: with __changed, only names that are allow-listed AND listed are kept; __changed is never kept', () => {
    const d = def(['name', 'notes', 'address']);
    const out = keep(form([['name', 'A'], ['notes', 'B'], ['address', 'C'], ['__changed', 'name,address,version']]), d, REC);
    expect(out?.fields).toEqual({ name: 'A', address: 'C' });
    expect(Object.keys(out!.fields)).not.toContain('__changed');
    // Mutant: ignore __changed -> notes appears, red.
  });

  it('R5: without __changed (no-JavaScript submit) every allow-listed name that was submitted is kept; absent names are not', () => {
    const d = def(['name', 'notes', 'address']);
    const out = keep(form([['name', 'A'], ['notes', '']]), d, REC);
    expect(out?.fields).toEqual({ name: 'A', notes: '' });
    expect('address' in out!.fields).toBe(false);
  });

  it('a field the user CLEARED is kept as the empty string (changed, present, blank)', () => {
    const out = keep(form([['name', 'Keep'], ['notes', ''], ['__changed', 'notes']]), def(['name', 'notes']), REC);
    expect(out?.fields).toEqual({ notes: '' });
  });

  it('SPEC GAP (pinned): an UNTICKED checkbox is in __changed and absent from the FormData -> kept as [] so the box reopens unticked', () => {
    const d = def(['name', 'issuesOfficialReceipt']);
    const out = keep(form([['name', 'Typed'], ['issuesOfficialReceiptPresent', '1'], ['__changed', 'name,issuesOfficialReceipt']]), d, REC);
    expect(out?.fields).toEqual({ name: 'Typed', issuesOfficialReceipt: [] });
    // Mutant: skip names absent from the FormData -> issuesOfficialReceipt missing, red.
  });

  it('a checkbox group: one value is a string, two or more are an array in submitted order', () => {
    const d = def(['positionIds', 'primaryPositionId']);
    const many = keep(form([['positionIds', 'p3'], ['positionIds', 'p1'], ['primaryPositionId', 'p3']]), d, REC);
    expect(many?.fields).toEqual({ positionIds: ['p3', 'p1'], primaryPositionId: 'p3' });
    const one = keep(form([['positionIds', 'p2']]), d, REC);
    expect(one?.fields).toEqual({ positionIds: 'p2' });
    // Mutant: keep only fd.get (first value) -> the array collapses to 'p3', red.
  });

  it('values come back exactly: a 500-character note whole, spaces and a mistyped amount untouched', () => {
    const note = 'n'.repeat(250) + ' | 1,0OO | ' + 'm'.repeat(239);
    expect(note).toHaveLength(500);
    const out = keep(form([['notes', note], ['name', '  007.10 ₱ "quoted" é&=?#  '], ['amount', '1,0OO']]), def(['notes', 'name', 'amount']), REC);
    expect(out?.fields.notes).toBe(note);
    expect(out?.fields.name).toBe('  007.10 ₱ "quoted" é&=?#  ');
    expect(out?.fields.amount).toBe('1,0OO');
    // Mutant: trim() or slice() the value -> red.
  });

  it('a File value is never kept', () => {
    const d = def([/^[a-zA-Z]+$/]);
    const out = keep(form([['name', 'x'], ['photo', new File(['abc'], 'a.jpg')]]), d, REC);
    expect(out?.fields).toEqual({ name: 'x' });
  });
});

describe('K1 - keepTyping: undefined cases', () => {
  const d = () => def(['name', 'notes']);
  it('stale: true -> undefined, even though name was typed (A6: a stale refusal reopens LOCKED)', () => {
    expect(keep(form([['name', 'Typed']]), d(), REC, { stale: true })).toBeUndefined();
    expect(keep(form([['name', 'Typed']]), d(), REC, { stale: false })?.fields).toEqual({ name: 'Typed' });
    // Mutant: delete the stale branch -> the first line is red.
  });
  it('a blank record on a record form -> undefined', () => {
    expect(keep(form([['name', 'Typed']]), d(), '')).toBeUndefined();
  });
  it('nothing allow-listed was submitted -> undefined (only hidden ids), and an empty __changed -> undefined', () => {
    expect(keep(form([['supplierId', REC], ['version', '3']]), d(), REC)).toBeUndefined();
    expect(keep(form([['name', 'Typed'], ['__changed', '']]), d(), REC)).toBeUndefined();
  });
});

describe('R4 - never echoed: the deny list', () => {
  it('pin, newPin and bankAccountNumber are never kept, even through a catch-all RegExp; neighbours are', () => {
    const d = def([/^[a-zA-Z_]+$/]);
    const out = keep(
      form([['pin', '1234'], ['newPin', '5678'], ['bankAccountNumber', '0012-3456'], ['user_pin', '1'], ['login_password', 'p'], ['name', 'Typed'], ['bankName', 'BDO']]),
      d,
      REC,
    );
    expect(out?.fields).toEqual({ name: 'Typed', bankName: 'BDO' });
    expect(JSON.stringify(out)).not.toMatch(/1234|5678|0012|"1"/);
    // Mutant: delete the deny filter in keepTyping -> pin / newPin / bankAccountNumber appear, red.
  });

  it('a form whose only changed field is on the deny list keeps nothing at all', () => {
    expect(keep(form([['bankAccountNumber', '9999']]), def([/^bank/]), REC)).toBeUndefined();
  });

  it('defineTypedForm throws at module load for a string entry on the deny list', () => {
    for (const bad of ['password', 'pin', 'newPin', 'bankAccountNumber', 'user_pin', 'api_key', 'otp']) {
      expect(() => def([bad]), bad).toThrow();
    }
    expect(() => def(['name', 'bankName', 'bankAccountName'])).not.toThrow();
    // Mutant: delete the throw -> red.
  });

  it('nothing is logged: keepTyping never writes a value (or anything) to the logger', () => {
    keep(form([['name', 'SecretyTypedValue'], ['pin', '4242'], ['__changed', 'name']]), def([/^(name|pin)$/]), REC);
    keep(form([['name', 'SecretyTypedValue']]), def(['name']), REC, { stale: true });
    const logged = JSON.stringify([logSpy.warn.mock.calls, logSpy.info.mock.calls, logSpy.error.mock.calls, logSpy.debug.mock.calls]);
    expect(logged).not.toContain('SecretyTypedValue');
    expect(logged).not.toContain('4242');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('K3 - typedFor: a flash meant for another record or form is ignored', () => {
  const d = () => def(['name'], 'tender.edit');
  const typed = { form: 'tender.edit', record: REC, fields: { name: 'Typed' }, actor: A0 };

  it('the matching form and record -> the view', () => {
    expect(tf({ typed }, d(), REC)).toEqual({ kind: 'typed', fields: { name: 'Typed' } });
  });
  it('wrong form -> null; wrong record -> null; nothing in the flash -> null', () => {
    expect(tf({ typed }, def(['name'], 'supplier.edit'), REC)).toBeNull();
    expect(tf({ typed }, d(), OTHER)).toBeNull();
    expect(tf({}, d(), REC)).toBeNull();
    // Mutant: compare only the form -> the wrong-record line is red (20 tenders on one page would all reopen).
  });
  it('typedDropped matching form and record -> dropped; a different record or form -> null', () => {
    expect(tf({ typedDropped: { form: 'tender.edit', record: REC } }, d(), REC)).toEqual({ kind: 'dropped' });
    expect(tf({ typedDropped: { form: 'tender.edit', record: REC } }, d(), OTHER)).toBeNull();
    expect(tf({ typedDropped: { form: 'other.form', record: REC } }, d(), REC)).toBeNull();
  });

  async function refuse(fields: Record<string, string>, extra: Record<string, unknown> = {}) {
    const sig = await captureRedirect(() =>
      flash.redirectWithFlash('/settings/pos-link', {}, { error: 'No.', typed: { form: 'tender.edit', record: REC, fields, actor: A0 }, ...extra } as never),
    );
    return new URL(sig.url, 'http://x.test').searchParams.get('f')!;
  }
  const read = async (params: Record<string, string>) =>
    (await flash.withFlash(Promise.resolve(params))) as unknown as Parameters<KT['typedFor']>[0] & { error?: string };

  it('through the signed flash: the page that follows the redirect gets the view for the one record, nothing for another', async () => {
    const f = await refuse({ name: 'Typed Name Zed' });
    const sp = await read({ f });
    expect(sp.error).toBe('No.');
    expect(tf(sp, d(), REC)).toEqual({ kind: 'typed', fields: { name: 'Typed Name Zed' } });
    expect(tf(sp, d(), OTHER)).toBeNull();
  });

  it('an expired cookie, a wrong token, and a later redirect (another tab) all give null', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
      const f = await refuse({ name: 'Typed' });
      vi.setSystemTime(new Date('2026-10-10T10:00:30Z'));
      expect(tf(await read({ f }), d(), REC)).not.toBeNull();
      expect(tf(await read({ f: 'AAAAAAAAAAAAAAAA' }), d(), REC)).toBeNull();
      vi.setSystemTime(new Date('2026-10-10T10:01:01Z'));
      expect(tf(await read({ f }), d(), REC)).toBeNull();
      // Another tab: a new redirect writes a new cookie with a new token, so the first tab's ?f= no longer matches.
      vi.setSystemTime(new Date('2026-10-10T10:02:00Z'));
      const first = await refuse({ name: 'Tab A' });
      const second = await refuse({ name: 'Tab B' });
      expect(first).not.toBe(second);
      expect(tf(await read({ f: first }), d(), REC)).toBeNull();
      expect(tf(await read({ f: second }), d(), REC)).toEqual({ kind: 'typed', fields: { name: 'Tab B' } });
    } finally {
      vi.useRealTimers();
    }
    // Mutant: skip the exp or token check in withFlash -> a line above is red.
  });

  it('a cookie over budget carries typedDropped, and typedFor returns dropped for that record only', async () => {
    const f = await refuse({ notes: 'x'.repeat(5000) });
    const sp = await read({ f });
    expect(sp.typed).toBeUndefined();
    expect(tf(sp, d(), REC)).toEqual({ kind: 'dropped' });
    expect(tf(sp, d(), OTHER)).toBeNull();
    expect(currentJar().get(FLASH_COOKIE)).toBeDefined();
  });
});

describe('R4 - the not-kept hint (SPEC GAP, pinned)', () => {
  const HINT = 'The account number is not kept after a refused save. Check it before saving.';
  it('defineTypedForm({ notKeptHint }) -> typedFor returns it as view.hint; a form without one has no hint', () => {
    const withHint = kt().defineTypedForm({ form: 'supplier.edit', fields: ['name'], notKeptHint: HINT } as never);
    const typed = { form: 'supplier.edit', record: REC, fields: { name: 'Typed' }, actor: A0 };
    expect(tf({ typed }, withHint, REC)).toEqual({ kind: 'typed', fields: { name: 'Typed' }, hint: HINT });
    const plain = tf({ typed }, def(['name']), REC) as { hint?: string };
    expect(plain.hint).toBeUndefined();
  });
});

describe('T-389 rulings: compound deny names, and singleton forms', () => {
  it('currentPin, confirmPassword, accessToken, clientSecret, oldPasscode are never kept, even through a catch-all RegExp', () => {
    const names = ['currentPin', 'confirmPassword', 'accessToken', 'clientSecret', 'oldPasscode'];
    const out = keep(form([...names.map((n): [string, string] => [n, 'x1']), ['name', 'Typed']]), def([/^[a-zA-Z_]+$/]), REC);
    expect(out?.fields).toEqual({ name: 'Typed' });
    // Mutant: keep the old (^|_) anchored NEVER_ECHO -> compound names appear, red.
  });

  it('defineTypedForm throws when a compound denied name is allow-listed', () => {
    for (const bad of ['currentPin', 'confirmPassword', 'accessToken', 'clientSecret', 'oldPasscode']) {
      expect(() => def([bad]), bad).toThrow();
    }
  });

  it('a singleton def (no record id) keeps typing with record "" ; a non-singleton def with record "" still gets undefined', () => {
    const s = kt().defineTypedForm({ form: 'org.settings', fields: ['name'], singleton: true } as never);
    const out = keep(form([['name', 'Typed']]), s, '');
    expect(out).toMatchObject({ form: 'org.settings', record: '', fields: { name: 'Typed' } });
    expect(keep(form([['name', 'Typed']]), def(['name']), '')).toBeUndefined();
    expect(tf({ typed: out! }, s, '')).toEqual({ kind: 'typed', fields: { name: 'Typed' } });
  });
});

describe('T-389 ruling: deny by TOKEN, not by substring', () => {
  const DENIED = ['currentPin', 'confirm_password', 'accessToken', 'client-secret', 'newPIN', 'otp', 'apiKey'];
  const ALLOWED = ['shipping', 'mapping', 'spinning', 'shippingFee', 'tokenizer', 'pinnacle'];

  it('denied names are never kept (catch-all RegExp) and defineTypedForm throws on each', () => {
    const fd = form([...DENIED.map((n): [string, string] => [n, 'x1']), ['name', 'Typed']]);
    expect(keep(fd, def([/^[a-zA-Z_-]+$/]), REC)?.fields).toEqual({ name: 'Typed' });
    for (const bad of DENIED) expect(() => def([bad]), bad).toThrow();
  });

  it('allowed names are kept and defineTypedForm does not throw on them (red against a containment rule)', () => {
    for (const ok of ALLOWED) expect(() => def([ok]), ok).not.toThrow();
    const fd = form(ALLOWED.map((n): [string, string] => [n, 'v']));
    const out = keep(fd, def([/^[a-zA-Z_-]+$/]), REC);
    expect(Object.keys(out?.fields ?? {}).sort()).toEqual([...ALLOWED].sort());
  });
});

describe('T-389 audit: the typed slot is bound to the actor', () => {
  // CONTRACT PINNED: keepTyping(fd, def, record, { actorId, stale? }) stores the actor in the slot;
  // typedFor(sp, def, record, actorId) returns null when the reading actor differs (the existing argument order is kept,
  // `sp` stays first, because the page already passes it). The slot's own field name for the actor is not pinned.
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const call = (fn: unknown, ...a: unknown[]) => (fn as (...x: unknown[]) => unknown)(...a);

  it('kept as person A: read as A -> the view; read as B -> null', () => {
    const d = def(['name']);
    const slot = call(kt().keepTyping, form([['name', 'Typed']]), d, REC, { actorId: A }) as { form: string; record: string; fields: Record<string, string> };
    expect(slot?.fields).toEqual({ name: 'Typed' });
    expect(call(kt().typedFor, { typed: slot }, d, REC, A)).toEqual({ kind: 'typed', fields: { name: 'Typed' } });
    expect(call(kt().typedFor, { typed: slot }, d, REC, B)).toBeNull();
    // Mutant: typedFor ignores the actor -> the B line is red.
  });

  it('the actor id travels through the signed flash and still binds', async () => {
    const d = def(['name']);
    const slot = call(kt().keepTyping, form([['name', 'Typed']]), d, REC, { actorId: A }) as never;
    const sig = await captureRedirect(() => flash.redirectWithFlash('/p', {}, { error: 'No.', typed: slot } as never));
    const f = new URL(sig.url, 'http://x.test').searchParams.get('f')!;
    const sp = (await flash.withFlash(Promise.resolve({ f }))) as never;
    expect(call(kt().typedFor, sp, d, REC, A)).not.toBeNull();
    expect(call(kt().typedFor, sp, d, REC, B)).toBeNull();
  });

  it('the dropped notice is bound to the actor too', async () => {
    const d = def(['notes']);
    const slot = call(kt().keepTyping, form([['notes', 'x'.repeat(5000)]]), d, REC, { actorId: A }) as never;
    const sig = await captureRedirect(() => flash.redirectWithFlash('/p', {}, { error: 'No.', typed: slot } as never));
    const f = new URL(sig.url, 'http://x.test').searchParams.get('f')!;
    const sp = (await flash.withFlash(Promise.resolve({ f }))) as never;
    expect(call(kt().typedFor, sp, d, REC, A)).toEqual({ kind: 'dropped' });
    expect(call(kt().typedFor, sp, d, REC, B)).toBeNull();
  });

  it('stale still wins with an actor given', () => {
    expect(call(kt().keepTyping, form([['name', 'T']]), def(['name']), REC, { actorId: A, stale: true })).toBeUndefined();
  });
});

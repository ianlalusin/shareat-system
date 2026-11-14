import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepTyping, typedFor } from '../src/lib/keep-typing';
import { BANK_HINTS_EDIT, STORE_SETTLEMENT_EDIT } from '../src/app/settings/sales-channels/typed-forms';

/**
 * T-564: a refused save of the settlement wiring panel or a channel's bank names keeps what was typed (closes the logged
 * follow-up "keep typed text after a refused panel save"). No database: the real keepTyping / typedFor on a real FormData, plus
 * the wiring read from source with a mutant for each leg. Each test names its killing mutant.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'settings', 'sales-channels');
const actions = readFileSync(join(SRC, 'actions.ts'), 'utf8');
const page = readFileSync(join(SRC, 'page.tsx'), 'utf8');

function body(text: string, name: string): string {
  const at = text.indexOf(`export async function ${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const next = text.slice(at + 10).search(/\nexport /);
  return next === -1 ? text.slice(at) : text.slice(at, at + 10 + next);
}
/** True when the action's catch branch keeps typing with this form def, for this record expression. */
const keepsInCatch = (text: string, action: string, def: string) =>
  new RegExp(String.raw`catch \(err\) \{[\s\S]*?typed: keepTyping\(fd, ${def}, `).test(body(text, action));
/** True when the page hands an EditableRecord typed={typedFor(sp, DEF, ...)} for the action. */
const pageTypes = (text: string, action: string, def: string) =>
  new RegExp(String.raw`<EditableRecord action=\{${action}\}[^>]*typed=\{typedFor\(sp, ${def}, `).test(text);

const fd = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe('T-564 keep typing: the real functions', () => {
  it('settlement wiring: typed values come back for the same store and person, and no other', () => {
    const typed = keepTyping(
      fd([['storeId', 's1'], ['storeKey', 'LIPA!'], ['matchLabels', 'a, b'], ['fileHints', 'x'], ['wastageEmailIngestEnabled', 'true']]),
      STORE_SETTLEMENT_EDIT, 's1', { actorId: 'p1' },
    );
    // Mutant: drop a name from the allow-list, or allow storeId -> the toEqual is red.
    expect(typed?.fields).toEqual({ storeKey: 'LIPA!', matchLabels: 'a, b', fileHints: 'x', wastageEmailIngestEnabled: 'true' });
    expect(typedFor({ typed }, STORE_SETTLEMENT_EDIT, 's1', 'p1')).toMatchObject({ kind: 'typed', fields: { storeKey: 'LIPA!' } });
    // Mutant: typedFor ignores the record or the actor -> one of these is non-null, red.
    expect(typedFor({ typed }, STORE_SETTLEMENT_EDIT, 's2', 'p1')).toBeNull();
    expect(typedFor({ typed }, STORE_SETTLEMENT_EDIT, 's1', 'p2')).toBeNull();
  });

  it('settlement wiring: an unticked email box comes back unticked (the browser sends nothing for it)', () => {
    const typed = keepTyping(fd([['storeId', 's1'], ['__changed', 'wastageEmailIngestEnabled']]), STORE_SETTLEMENT_EDIT, 's1', { actorId: 'p1' });
    // Mutant: skip the changed-but-unsent rule -> undefined, red.
    expect(typed?.fields).toEqual({ wastageEmailIngestEnabled: [] });
  });

  it('bank names: kept per channel, and a different channel is not reopened', () => {
    const typed = keepTyping(fd([['storeId', 's1'], ['channelId', 'c1'], ['bankHints', 'maribank, ???']]), BANK_HINTS_EDIT, 'c1', { actorId: 'p1' });
    expect(typed?.fields).toEqual({ bankHints: 'maribank, ???' });
    // Mutant: key the record by store instead of channel -> the second line is non-null, red.
    expect(typedFor({ typed }, BANK_HINTS_EDIT, 'c1', 'p1')).not.toBeNull();
    expect(typedFor({ typed }, BANK_HINTS_EDIT, 'c2', 'p1')).toBeNull();
  });
});

describe('T-564 keep typing: the wiring in source', () => {
  it('both actions keep typing in the refusal branch, with their own form def', () => {
    expect(keepsInCatch(actions, 'saveStoreSettlementAction', 'STORE_SETTLEMENT_EDIT')).toBe(true);
    expect(keepsInCatch(actions, 'setBankHintsAction', 'BANK_HINTS_EDIT')).toBe(true);
    // Mutant: the catch redirects without `typed:` -> the checker returns false.
    expect(keepsInCatch(actions.replace(/, typed: keepTyping\(fd, STORE_SETTLEMENT_EDIT, [^)]*\)/, ''), 'saveStoreSettlementAction', 'STORE_SETTLEMENT_EDIT')).toBe(false);
    expect(keepsInCatch(actions.replace(/, typed: keepTyping\(fd, BANK_HINTS_EDIT, [^)]*\)/, ''), 'setBankHintsAction', 'BANK_HINTS_EDIT')).toBe(false);
  });

  it('both records on the page read the kept typing back with typedFor', () => {
    expect(pageTypes(page, 'saveStoreSettlementAction', 'STORE_SETTLEMENT_EDIT')).toBe(true);
    expect(pageTypes(page, 'setBankHintsAction', 'BANK_HINTS_EDIT')).toBe(true);
    // Mutant: typed={null} -> the checker returns false.
    expect(pageTypes(page.replace(/typed=\{typedFor\(sp, BANK_HINTS_EDIT, [^}]*\}/, 'typed={null}'), 'setBankHintsAction', 'BANK_HINTS_EDIT')).toBe(false);
    expect(pageTypes(page.replace(/typed=\{typedFor\(sp, STORE_SETTLEMENT_EDIT, [^}]*\}/, 'typed={null}'), 'saveStoreSettlementAction', 'STORE_SETTLEMENT_EDIT')).toBe(false);
  });
});

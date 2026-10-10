import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_COOKIE, captureRedirect, currentJar, resetJar } from './helpers/flash-jar';

/**
 * T-389 S3 - the typed-field NAME pattern widens to allow hyphens (orchestrator ruling): a UUID-bearing control name such
 * as `channel_<uuid>` (sales-days platform sales) must be kept; a name with a space or a quote is still dropped.
 * New file (the S1 K-tests stay untouched). Red on HEAD: /^[A-Za-z][A-Za-z0-9_]{0,63}$/ rejects the hyphen.
 */
vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

const GOOD = 'channel_3f2a9c1e-0b4d-4e8a-9f1c-2d3e4f5a6b7c';
const A = 'person-1';
beforeEach(() => resetJar());

describe('typed field names may carry hyphens', () => {
  it('keepTyping keeps a hyphenated name that a RegExp allow-list matches', async () => {
    const { defineTypedForm, keepTyping } = await import('../src/lib/keep-typing');
    const def = defineTypedForm({ form: 'salesDay.platform', fields: [/^(channel|nosales)_[0-9a-f-]{36}$/] });
    const fd = new FormData();
    fd.set(GOOD, '500.00');
    expect(keepTyping(fd, def, 'rec-1', { actorId: A })?.fields).toEqual({ [GOOD]: '500.00' });
  });

  it('keepTyping still drops a name with a space or a quote, even when the RegExp would match it', async () => {
    const { defineTypedForm, keepTyping } = await import('../src/lib/keep-typing');
    const def = defineTypedForm({ form: 'salesDay.platform', fields: [/^channel_.*$/] });
    const fd = new FormData();
    fd.set('channel_a b', '1');
    fd.set('channel_a"b', '2');
    fd.set("channel_a'b", '3');
    expect(keepTyping(fd, def, 'rec-1', { actorId: A })).toBeUndefined();
  });

  it('the signed flash carries the hyphenated name round-trip, and decodeFlash rejects a quoted or spaced one', async () => {
    const flash = await import('../src/lib/flash');
    const send = async (name: string) => {
      resetJar();
      await captureRedirect(() => flash.redirectWithFlash('/p', {}, { error: 'No.', typed: { form: 'a.b', record: 'rec-1', actor: A, fields: { [name]: '1' } } } as never));
      return (flash.decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as { t?: { fields: Record<string, unknown> } } | null)?.t;
    };
    expect((await send(GOOD))?.fields).toEqual({ [GOOD]: '1' });
    expect(await send('channel_a b')).toBeUndefined();
    expect(await send('channel_a"b')).toBeUndefined();
  });
});

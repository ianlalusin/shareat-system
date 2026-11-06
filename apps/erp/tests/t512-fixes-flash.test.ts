import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureRedirect, resetJar } from './helpers/flash-jar';
import { RULE_REGISTRY } from '../../../packages/domain/src/business-rules/registry';

/**
 * T-512 S5c FIXER 2: a refused business-rule save keeps what was typed. A rule key has a dot (`settlement.variance_percent`) and the flash record id
 * does not allow one, so the typed slot used to be dropped ("wrong shape"). The screen and the action now both use ruleRecordId(key).
 */
vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

const A0 = '00000000-0000-4000-8000-0000000000a0';
type Flash = typeof import('../src/lib/flash');
let flash: Flash;
beforeAll(async () => {
  process.env = { ...process.env, DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev', SESSION_SECRET: 'x'.repeat(48), APP_TIMEZONE: 'Asia/Manila' } as unknown as NodeJS.ProcessEnv;
  flash = await import('@/lib/flash');
}, 60_000);
beforeEach(() => resetJar());

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('T-512 fixes - the business-rule form keeps its typing across a refused save', () => {
  it.each(Object.keys(RULE_REGISTRY))('%s: value, date and reason come back for that rule and for no other [kills: dotted key dropped as wrong shape]', async (key) => {
    const { BUSINESS_RULE_EDIT, ruleRecordId } = await import('../src/app/settings/business-rules/typed-forms');
    const { keepTyping, typedFor } = await import('../src/lib/keep-typing');
    const fd = new FormData();
    fd.append('key', key);
    fd.append('value', '12.5');
    fd.append('effectiveFrom', '2026-12-01');
    fd.append('reason', 'Because');
    const slot = keepTyping(fd, BUSINESS_RULE_EDIT, ruleRecordId(key), { actorId: A0 });
    const sig = await captureRedirect(() => flash.redirectWithFlash('/settings/business-rules', {}, { error: 'No.', typed: slot } as never));
    const f = new URL(sig.url, 'http://x.test').searchParams.get('f')!;
    const sp = (await flash.withFlash(Promise.resolve({ f }))) as never;
    expect(typedFor(sp, BUSINESS_RULE_EDIT, ruleRecordId(key), A0)).toEqual({ kind: 'typed', fields: { value: '12.5', effectiveFrom: '2026-12-01', reason: 'Because' } });
    expect(typedFor(sp, BUSINESS_RULE_EDIT, ruleRecordId(key) + 'x', A0)).toBeNull();
  });

  it('the action and the page both build the record id through ruleRecordId, never the raw key [kills: one side reverted]', () => {
    expect(read('apps/erp/src/app/settings/business-rules/actions.ts')).toMatch(/keepTyping\(fd, BUSINESS_RULE_EDIT, ruleRecordId\(key\)/);
    expect(read('apps/erp/src/app/settings/business-rules/page.tsx')).toMatch(/typedFor\(sp, BUSINESS_RULE_EDIT, ruleRecordId\(item\.key\)/);
  });
});

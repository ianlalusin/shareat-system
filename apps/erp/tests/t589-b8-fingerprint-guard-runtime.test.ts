/**
 * T-589 B8 F3 (runtime) - the fingerprint test form's server action refuses outside development. It CALLS the action with its
 * collaborators mocked. The flash mock does NOT throw (the real redirect does), so a guard missing its `return` falls through to the
 * write and the "no write" assertions catch it.
 *   MUTANT (a): the guard condition becomes `false`  -> production / test legs red.
 *   MUTANT (b): the guard loses its `return`         -> the "never written" assertions red.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  redirectWithFlash: vi.fn(async () => undefined),
  enrolFingerprint: vi.fn(async () => undefined),
  withOrgPrincipal: vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/lib/flash', () => ({ redirectWithFlash: m.redirectWithFlash }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../src/lib/session', () => ({ requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })) }));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: m.withOrgPrincipal }));
vi.mock('@shareat/domain', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), enrolFingerprint: m.enrolFingerprint }));

const REFUSAL = { error: 'Fingerprint enrolment is not available yet.' };
const form = () => {
  const fd = new FormData();
  fd.set('employmentId', 'emp-1');
  fd.set('templates', 'tpl-a\ntpl-b');
  return fd;
};
const run = async () => {
  const { enrolFingerprintAction } = await import('../src/app/staff/[employmentId]/credentials/actions');
  await enrolFingerprintAction(form());
};

beforeAll(async () => {
  await import('@shareat/domain');
}, 60_000);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.each(['production', 'test'])('enrolFingerprintAction with NODE_ENV=%s', (env) => {
  it('refuses with the plain sentence and writes nothing', async () => {
    vi.stubEnv('NODE_ENV', env);
    await run();
    expect(m.redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(m.redirectWithFlash).toHaveBeenCalledWith('/staff/emp-1/credentials', {}, REFUSAL);
    expect(m.enrolFingerprint).not.toHaveBeenCalled();
    expect(m.withOrgPrincipal).not.toHaveBeenCalled();
  });
});

describe('enrolFingerprintAction with NODE_ENV=development', () => {
  it('gets past the guard: enrols once and says ok, not the refusal', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await run();
    expect(m.enrolFingerprint).toHaveBeenCalledTimes(1);
    expect(m.redirectWithFlash).toHaveBeenCalledTimes(1);
    expect(m.redirectWithFlash).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), REFUSAL);
    expect(m.redirectWithFlash).toHaveBeenCalledWith('/staff/emp-1/credentials', {}, expect.objectContaining({ ok: expect.any(String) }));
  });
});

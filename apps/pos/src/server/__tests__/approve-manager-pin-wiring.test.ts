/**
 * Lipa trial, 31 Oct: every refund failed with `sign_in_attempts_device_id_persons_id_fk`. `approveManagerPin` handed the tablet's POS
 * device uuid to `verifyPosManagerApproval` as `deviceId`, and the attempt row stores that in a column that is a FK to persons.id (the
 * TERMINAL's person row). deps.ts is real wiring that nothing exercised, so the mistake shipped. This pins what it passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const TABLET_DEVICE = '5561b32b-3c27-42a4-b80a-193f3d0abeda';
const TERMINAL_PERSON = '01a09b5f-14b5-767e-a683-64e7c15d5ae7';
const ORG = '01a081bc-8cfe-7a3b-adc8-ed5eb554f496';

const verifyPosManagerApproval = vi.fn();
const resolvePosTerminalLink = vi.fn();

vi.mock('node:fs', () => ({ readFileSync: () => '{"project_id":"p"}', default: { readFileSync: () => '{"project_id":"p"}' } }));
vi.mock('firebase-admin/app', () => ({ initializeApp: () => ({}), getApps: () => [], cert: (c: unknown) => c }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: async () => ({ uid: 'u' }) }) }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ doc: () => ({}), collection: () => ({}), runTransaction: async () => ({}) }),
  FieldValue: {},
  FieldPath: {},
}));
vi.mock('@shareat/auth', () => ({
  AuthenticationError: class AuthenticationError extends Error {},
  resolvePosTerminalLink: (...a: unknown[]) => resolvePosTerminalLink(...a),
  verifyPosManagerApproval: (...a: unknown[]) => verifyPosManagerApproval(...a),
}));
vi.mock('@shareat/db', () => ({ withOrgPrincipal: async (_org: string, fn: (tx: unknown) => unknown) => fn({}) }));

beforeEach(() => {
  verifyPosManagerApproval.mockReset().mockResolvedValue({ approverPersonId: 'approver' });
  resolvePosTerminalLink.mockReset().mockResolvedValue({ erpStoreId: 'erp-store', terminalPersonId: TERMINAL_PERSON, terminalNo: 1, linkId: 'l' });
});

describe('approveManagerPin wiring', () => {
  it('records the attempt against the terminal PERSON, never the tablet device uuid', async () => {
    const { getPos2Deps } = await import('../pos2/deps');
    const got = await getPos2Deps({ POS_FIREBASE_SA_KEY_FILE: '/k.json', DATABASE_URL: 'postgres://x', POS_ORG_ID: ORG });
    if (!got.ok) throw new Error('deps not built');

    const out = await got.deps.approveManagerPin({ posStoreId: 'pos-store', deviceId: TABLET_DEVICE, pin: '1234' });

    expect(out).toMatchObject({ ok: true, approverPersonId: 'approver', terminalNo: 1 });
    expect(resolvePosTerminalLink).toHaveBeenCalledWith(expect.anything(), { orgId: ORG, posStoreId: 'pos-store', deviceId: TABLET_DEVICE });
    const input = verifyPosManagerApproval.mock.calls[0]![1];
    expect(input.deviceId).toBe(TERMINAL_PERSON);
    expect(input.deviceId).not.toBe(TABLET_DEVICE);
    expect(input.terminalPersonId).toBe(TERMINAL_PERSON);
  });
});

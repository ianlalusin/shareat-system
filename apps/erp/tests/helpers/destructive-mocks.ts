import { vi } from 'vitest';

/**
 * T-412: the destructive-button helpers (`@/lib/destructive`) and the approval check (`verifyAdminApproval`) read the database
 * and the PIN credentials. A unit test that exercises an action only for how a REFUSAL IS CARRIED (a banner, a redirect) stubs
 * them here, so the action reaches the (mocked) domain call exactly as before. The real path - PIN, admin, store from the
 * record, audit in the same transaction - is `apps/erp/tests/integration/t412-destructive-actions.test.ts`.
 *
 * Use inside the test file (vi.mock is hoisted there):
 *   vi.mock('@/lib/destructive', async () => (await import('./helpers/destructive-mocks')).destructiveLibMock());
 *   vi.mock('@shareat/auth', async (orig) => (await import('./helpers/destructive-mocks')).withApprovalStub(await orig()));
 */
export function destructiveLibMock(target: { storeId?: string | null; name?: string | null; status?: string | null } = {}) {
  return {
    loadDestructiveTarget: vi.fn(async () => ({ storeId: 'store-1', name: 'The Name', status: 'dispatched', ...target })),
    recordApproval: vi.fn(async () => undefined),
    assertApprovalStillRight: vi.fn(async () => undefined),
    authorizeOrgLevel: vi.fn(async () => undefined),
    retypeRefusalError: (name: string) => new Error(`Type the name exactly — '${name}' — to confirm.`),
  };
}

/** `@shareat/auth` as it really is, with the one PIN check answered "approved by admin-1". */
export function withApprovalStub<T extends object>(real: T): T & { verifyAdminApproval: () => Promise<{ approverPersonId: string }> } {
  return { ...real, verifyAdminApproval: vi.fn(async () => ({ approverPersonId: 'admin-1' })) };
}

/**
 * T-343 S7 — DEF-452, the 11 non-admin screens. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S7.
 *
 * ⛔ TESTER, not BUILDER. Every one of these 11 files still keys its local `errorMessage` on
 * `authorize()`'s raw text (`may not '<cap>'`) BEFORE falling through to the shared, presentable-
 * aware `errorMessage` — so a mocked `AuthorizationError` whose own `userMessage` (S2/S2b) differs
 * from the local bypass sentence renders the BYPASS sentence today. Expected red until the builder
 * adds `if (isPresentable(err)) return sharedErrorMessage(err);` as each local function's first
 * statement and deletes the dead branches (S7 change 1/2).
 *
 * Harness: same shape as `t343-s5-1d-wrapper-refusals.test.ts`. `RedirectSignal` captures
 * `next/navigation`'s `redirect`; `next/cache`'s `revalidatePath` and each file's own session import
 * are stubbed; each file's own `./lib` (or `../../../expenses/lib`) module is replaced with a
 * minimal object providing only `withOrgPrincipal` (a passthrough — never a real transaction) plus
 * whatever else that one file imports from it. `@shareat/domain` is mocked ONCE, module-wide, with
 * exactly the functions these 11 files' exercised call sites use — every other named export a file
 * imports from `@shareat/domain` resolves to `undefined` and is never invoked on these paths.
 * `@/lib/constraint-messages` forwards to the REAL module (the bare `@/...` specifier the root
 * `vitest.config.mts` does not resolve) — never a stub, since S7's whole point is that function's
 * `isPresentable`-first behaviour. `@shareat/db`, `@shareat/db/schema`, `@shareat/auth` and
 * `@shareat/sync-firestore` are left REAL: every connection in this codebase is lazy by design
 * (`packages/db/src/client.ts`'s own header), and none of the paths exercised here ever reaches one.
 *
 * `provisionTerminalAction` returns `{ ok: false, error }` instead of redirecting (T-159's own
 * doc comment on why: a one-time token cannot survive a redirect's URL/cookie/query string) — read
 * `.error` directly for that file's rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));

vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

// Each file's own `./lib` (or, for credentials, `../../../expenses/lib`) — a minimal replacement,
// never `importOriginal`: every one of these 11 files imports only `withOrgPrincipal` from it,
// except pos-usage (`buildPlanForDay` too).
vi.mock('../src/app/inventory/pos-map/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const buildPlanForDay = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../src/app/inventory/pos-usage/lib', () => ({
  buildPlanForDay: (...args: unknown[]) => buildPlanForDay(...args),
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/inventory/production/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/inventory/usage/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/inventory/counts/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/items/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/staff/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

// `staff/[employmentId]/credentials/actions.ts` imports `withOrgPrincipal` from
// `../../../expenses/lib` (resolves to `apps/erp/src/app/expenses/lib`, the same physical module
// `t343-s5-1d`'s wastage/admin-stores/deliveries/locations legs already mock).
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/trade/orders/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/commissary/catalogue/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock('../src/app/attendance/terminals/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

// One `@shareat/domain` mock, module-wide — exactly the functions these 11 files' exercised call
// sites use. Untyped `vi.fn()` + spread wrapping throughout (S6b/S5.5m precedent: an inline typed
// implementation pins a zero-arg signature and TS2556s on the spread).
const upsertPosItemMap = vi.fn();
const decideMapRequest = vi.fn();
const requestMap = vi.fn();
const finalizeSections = vi.fn();
const createProductionDraft = vi.fn();
const postProduction = vi.fn();
const editPostedProduction = vi.fn();
const voidProduction = vi.fn();
const saveUsageDraft = vi.fn();
const postUsage = vi.fn();
const voidUsage = vi.fn();
const openCountSession = vi.fn();
const commitCount = vi.fn();
const recordCount = vi.fn();
const createItem = vi.fn();
const updateItem = vi.fn();
const createEmployment = vi.fn();
const upsertStorePosition = vi.fn();
const enrolCard = vi.fn();
const createTradeOrder = vi.fn();
const upsertCommissaryLink = vi.fn();
const upsertMap = vi.fn();
const provisionTerminal = vi.fn();
const mintTerminalToken = vi.fn();

vi.mock('@shareat/domain', () => ({
  upsertPosItemMap: (...args: unknown[]) => upsertPosItemMap(...args),
  decideMapRequest: (...args: unknown[]) => decideMapRequest(...args),
  requestMap: (...args: unknown[]) => requestMap(...args),
  finalizeSections: (...args: unknown[]) => finalizeSections(...args),
  createProductionDraft: (...args: unknown[]) => createProductionDraft(...args),
  postProduction: (...args: unknown[]) => postProduction(...args),
  editPostedProduction: (...args: unknown[]) => editPostedProduction(...args),
  voidProduction: (...args: unknown[]) => voidProduction(...args),
  saveUsageDraft: (...args: unknown[]) => saveUsageDraft(...args),
  postUsage: (...args: unknown[]) => postUsage(...args),
  voidUsage: (...args: unknown[]) => voidUsage(...args),
  // Called directly at module scope in `quantity(countedQuantity)` before `recordCount` — must be a
  // real callable, or `counts/actions.ts`'s `recordCountAction` throws a TypeError before ever
  // reaching the mocked `recordCount` (a different failure from the one this file tests).
  quantity: (v: unknown) => v,
  openCountSession: (...args: unknown[]) => openCountSession(...args),
  commitCount: (...args: unknown[]) => commitCount(...args),
  recordCount: (...args: unknown[]) => recordCount(...args),
  createItem: (...args: unknown[]) => createItem(...args),
  updateItem: (...args: unknown[]) => updateItem(...args),
  createEmployment: (...args: unknown[]) => createEmployment(...args),
  upsertStorePosition: (...args: unknown[]) => upsertStorePosition(...args),
  enrolCard: (...args: unknown[]) => enrolCard(...args),
  createTradeOrder: (...args: unknown[]) => createTradeOrder(...args),
  upsertCommissaryLink: (...args: unknown[]) => upsertCommissaryLink(...args),
  upsertMap: (...args: unknown[]) => upsertMap(...args),
  provisionTerminal: (...args: unknown[]) => provisionTerminal(...args),
  mintTerminalToken: (...args: unknown[]) => mintTerminalToken(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

function errorOf(to: string): string | null {
  return paramsOf(to).get('error');
}

/** A Postgres-shaped error the way `postgres.js` attaches `code`/`constraint` — non-presentable by
 *  `isPresentable`'s own `hasStringCode` guard, whatever else it carries. */
function pgError(message: string, code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(message), { code, constraint });
}

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

// ===========================================================================================
// P1 — 27 of the 30 deleted `may not '<cap>'` branches (the remaining 3 — admin/users x2,
// access-defaults x1 — are covered in `t343-s7-admin-refusals.test.ts`).
// ===========================================================================================

interface Row {
  file: string;
  capability: string;
  run: (S: string) => Promise<string>;
}

async function authErr(capability: string, S: string): Promise<InstanceType<typeof import('../../../packages/auth/src/errors').AuthorizationError>> {
  const { AuthorizationError } = await import('../../../packages/auth/src/errors');
  return new AuthorizationError(`authorize: role 'staff' may not '${capability}'`, capability as never, S);
}

const rows: Row[] = [
  {
    file: 'inventory/pos-map',
    capability: 'manage_pos_map',
    run: async (S) => {
      upsertPosItemMap.mockRejectedValueOnce(await authErr('manage_pos_map', S));
      const { upsertPosItemMapAction } = await import('../src/app/inventory/pos-map/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('mode', 'direct');
      const to = await expectRedirectTo(() => upsertPosItemMapAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/pos-map',
    capability: 'request_pos_map',
    run: async (S) => {
      upsertPosItemMap.mockRejectedValueOnce(await authErr('request_pos_map', S));
      const { upsertPosItemMapAction } = await import('../src/app/inventory/pos-map/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('mode', 'no_stock');
      const to = await expectRedirectTo(() => upsertPosItemMapAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/pos-map',
    capability: 'decide_pos_map_request',
    run: async (S) => {
      decideMapRequest.mockRejectedValueOnce(await authErr('decide_pos_map_request', S));
      const { decideMapRequestAction } = await import('../src/app/inventory/pos-map/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('requestId', 'req-1');
      fd.set('decision', 'approved');
      const to = await expectRedirectTo(() => decideMapRequestAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/pos-usage',
    capability: 'record_stock_movement',
    run: async (S) => {
      buildPlanForDay.mockRejectedValueOnce(await authErr('record_stock_movement', S));
      const { buildPlanAction } = await import('../src/app/inventory/pos-usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('salesDayId', 'sd-1');
      fd.set('locationId', 'loc-1');
      const to = await expectRedirectTo(() => buildPlanAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/pos-usage',
    capability: 'finalize_pos_usage_pull',
    run: async (S) => {
      finalizeSections.mockRejectedValueOnce(await authErr('finalize_pos_usage_pull', S));
      const { finalizeSectionAction } = await import('../src/app/inventory/pos-usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('salesDayId', 'sd-1');
      fd.set('pullId', 'pull-1');
      fd.set('section', 'direct');
      const to = await expectRedirectTo(() => finalizeSectionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/pos-usage',
    capability: 'request_pos_map',
    run: async (S) => {
      requestMap.mockRejectedValueOnce(await authErr('request_pos_map', S));
      const { requestMapFromPullAction } = await import('../src/app/inventory/pos-usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('salesDayId', 'sd-1');
      fd.set('pullId', 'pull-1');
      fd.set('posItemKey', 'key-1');
      fd.set('posItemName', 'Name');
      const to = await expectRedirectTo(() => requestMapFromPullAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/production',
    capability: 'record_stock_movement',
    run: async (S) => {
      createProductionDraft.mockRejectedValueOnce(await authErr('record_stock_movement', S));
      const { saveProductionDraftAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('locationId', 'loc-1');
      fd.set('kind', 'slice');
      fd.set('producedOn', '2026-01-10');
      const to = await expectRedirectTo(() => saveProductionDraftAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/production',
    capability: 'post_production',
    run: async (S) => {
      postProduction.mockRejectedValueOnce(await authErr('post_production', S));
      const { postProductionAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      const to = await expectRedirectTo(() => postProductionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/production',
    capability: 'edit_posted_production',
    run: async (S) => {
      editPostedProduction.mockRejectedValueOnce(await authErr('edit_posted_production', S));
      const { editPostedProductionAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      const to = await expectRedirectTo(() => editPostedProductionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/production',
    capability: 'void_production',
    run: async (S) => {
      voidProduction.mockRejectedValueOnce(await authErr('void_production', S));
      const { voidProductionAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      fd.set('reason', 'Mistake');
      const to = await expectRedirectTo(() => voidProductionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/usage',
    capability: 'record_stock_movement',
    run: async (S) => {
      saveUsageDraft.mockRejectedValueOnce(await authErr('record_stock_movement', S));
      const { saveUsageDraftAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('kind', 'usage');
      fd.set('locationId', 'loc-1');
      fd.set('usedOn', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      const to = await expectRedirectTo(() => saveUsageDraftAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/usage',
    capability: 'record_wastage',
    run: async (S) => {
      saveUsageDraft.mockRejectedValueOnce(await authErr('record_wastage', S));
      const { saveUsageDraftAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('kind', 'wastage');
      fd.set('locationId', 'loc-1');
      fd.set('usedOn', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      const to = await expectRedirectTo(() => saveUsageDraftAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/usage',
    capability: 'post_usage',
    run: async (S) => {
      postUsage.mockRejectedValueOnce(await authErr('post_usage', S));
      const { postUsageAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      const to = await expectRedirectTo(() => postUsageAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/usage',
    capability: 'void_usage_record',
    run: async (S) => {
      voidUsage.mockRejectedValueOnce(await authErr('void_usage_record', S));
      const { voidUsageAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      fd.set('reason', 'Mistake');
      const to = await expectRedirectTo(() => voidUsageAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/counts',
    capability: 'open_count_session',
    run: async (S) => {
      openCountSession.mockRejectedValueOnce(await authErr('open_count_session', S));
      const { openCountSessionAction } = await import('../src/app/inventory/counts/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.append('locationIds', 'loc-1');
      fd.set('countedOn', '2026-01-10');
      const to = await expectRedirectTo(() => openCountSessionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/counts',
    capability: 'commit_count',
    run: async (S) => {
      commitCount.mockRejectedValueOnce(await authErr('commit_count', S));
      const { commitCountAction } = await import('../src/app/inventory/counts/actions');
      const fd = new FormData();
      fd.set('sessionId', 'sess-1');
      const to = await expectRedirectTo(() => commitCountAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'inventory/counts',
    capability: 'record_stock_movement',
    run: async (S) => {
      recordCount.mockRejectedValueOnce(await authErr('record_stock_movement', S));
      const { recordCountAction } = await import('../src/app/inventory/counts/actions');
      const fd = new FormData();
      fd.set('sessionId', 'sess-1');
      fd.set('itemId', 'item-1');
      fd.set('locationId', 'loc-1');
      fd.set('countedQuantity', '5');
      const to = await expectRedirectTo(() => recordCountAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'items',
    capability: 'approve_item',
    run: async (S) => {
      createItem.mockRejectedValueOnce(await authErr('approve_item', S));
      const { createItemAction } = await import('../src/app/items/actions');
      const fd = new FormData();
      fd.set('code', 'IT1');
      fd.set('name', 'Item');
      fd.set('kind', 'raw_material');
      fd.set('baseUnit', 'kg');
      const to = await expectRedirectTo(() => createItemAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'items',
    capability: 'manage_items',
    run: async (S) => {
      updateItem.mockRejectedValueOnce(await authErr('manage_items', S));
      const { updateItemFlagsAction } = await import('../src/app/items/actions');
      const fd = new FormData();
      fd.set('itemId', 'item-1');
      const to = await expectRedirectTo(() => updateItemFlagsAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'staff',
    capability: 'enrol_staff',
    run: async (S) => {
      createEmployment.mockRejectedValueOnce(await authErr('enrol_staff', S));
      const { hireAction } = await import('../src/app/staff/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('personChoice', 'existing:person-1');
      fd.set('employmentStatus', 'full_time');
      fd.set('startedOn', '2026-01-10');
      const to = await expectRedirectTo(() => hireAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'staff',
    capability: 'manage_store_settings',
    run: async (S) => {
      upsertStorePosition.mockRejectedValueOnce(await authErr('manage_store_settings', S));
      const { upsertStorePositionAction } = await import('../src/app/staff/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('name', 'Prep Cook');
      const to = await expectRedirectTo(() => upsertStorePositionAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'staff/[employmentId]/credentials',
    capability: 'manage_attendance',
    run: async (S) => {
      enrolCard.mockRejectedValueOnce(await authErr('manage_attendance', S));
      const { enrolCardAction } = await import('../src/app/staff/[employmentId]/credentials/actions');
      const fd = new FormData();
      fd.set('employmentId', 'emp-1');
      fd.set('cardId', 'card-1');
      const to = await expectRedirectTo(() => enrolCardAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'trade/orders',
    capability: 'approve_buyer',
    run: async (S) => {
      createTradeOrder.mockRejectedValueOnce(await authErr('approve_buyer', S));
      const { createOrderAction } = await import('../src/app/trade/orders/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('customerId', 'cust-1');
      fd.set('orderDate', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      fd.append('rate', '10');
      const to = await expectRedirectTo(() => createOrderAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'commissary/catalogue',
    capability: 'manage_commissary_offerings',
    run: async (S) => {
      upsertCommissaryLink.mockRejectedValueOnce(await authErr('manage_commissary_offerings', S));
      const { upsertLinkAction } = await import('../src/app/commissary/catalogue/actions');
      const fd = new FormData();
      fd.set('commissaryStoreId', 'store-1');
      fd.set('branchStoreId', 'store-2');
      const to = await expectRedirectTo(() => upsertLinkAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'commissary/catalogue',
    capability: 'manage_commissary_map',
    run: async (S) => {
      upsertMap.mockRejectedValueOnce(await authErr('manage_commissary_map', S));
      const { upsertMapAction } = await import('../src/app/commissary/catalogue/actions');
      const fd = new FormData();
      fd.set('commissaryStoreId', 'store-1');
      fd.set('branchStoreId', 'store-2');
      fd.set('commissaryItemId', 'item-1');
      fd.set('branchItemId', 'item-2');
      const to = await expectRedirectTo(() => upsertMapAction(fd));
      return errorOf(to)!;
    },
  },
  {
    file: 'attendance/terminals',
    capability: 'provision_clock_terminal',
    run: async (S) => {
      provisionTerminal.mockRejectedValueOnce(await authErr('provision_clock_terminal', S));
      const { provisionTerminalAction } = await import('../src/app/attendance/terminals/actions');
      const result = await provisionTerminalAction({ storeId: 'store-1', label: 'Front door' });
      if (result.ok) throw new Error('expected provisionTerminalAction to refuse');
      return result.error;
    },
  },
  {
    file: 'attendance/terminals',
    capability: 'manage_attendance',
    run: async (S) => {
      mintTerminalToken.mockRejectedValueOnce(await authErr('manage_attendance', S));
      const { mintTerminalTokenAction } = await import('../src/app/attendance/terminals/actions');
      const result = await mintTerminalTokenAction({ terminalId: 'term-1' });
      if (result.ok) throw new Error('expected mintTerminalTokenAction to refuse');
      return result.error;
    },
  },
];

describe('P1 — 27 deleted `may not \'<cap>\'` branches: the S2/S2b userMessage wins, not the local sentence', () => {
  it.each(rows.map((r) => [`${r.file} — ${r.capability}`, r] as const))(
    '%s',
    async (_label, row) => {
      const S = `S2 sentence for ${row.capability}.`;
      const got = await row.run(S);
      expect(got, `file: ${row.file}, capability: ${row.capability}`).toBe(S);
    },
    30000,
  );
});

// ===========================================================================================
// P3 — one row per file that keeps a branch (7): a PRESENTABLE error whose raw text also matches
// the kept branch's own regex still renders the userMessage, never the local sentence/raw text.
// ===========================================================================================

describe('P3 — a presentable error beats a kept local branch, even when its raw text also matches that branch', () => {
  it(
    'production — "…live slicer payment…" via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'The slicer is mid-payment; try again once it settles.';
      postProduction.mockRejectedValueOnce(refuse('postProduction: a live slicer payment is in progress', S));
      const { postProductionAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      const to = await expectRedirectTo(() => postProductionAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'usage — "…is a parking spot…" via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'The Receiving room cannot be a usage source.';
      saveUsageDraft.mockRejectedValueOnce(refuse('saveUsageDraft: the Receiving room is a parking spot', S));
      const { saveUsageDraftAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('kind', 'usage');
      fd.set('locationId', 'loc-1');
      fd.set('usedOn', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      const to = await expectRedirectTo(() => saveUsageDraftAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'counts — "…already in active count session…" via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'One of those rooms is already frozen by another active count.';
      openCountSession.mockRejectedValueOnce(refuse('openCountSession: room already in active count session', S));
      const { openCountSessionAction } = await import('../src/app/inventory/counts/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.append('locationIds', 'loc-1');
      fd.set('countedOn', '2026-01-10');
      const to = await expectRedirectTo(() => openCountSessionAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'items — a raw containing items_org_name_key, but no `code`, via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'An item with that name already exists.';
      createItem.mockRejectedValueOnce(refuse('createItem: violates unique constraint "items_org_name_key"', S));
      const { createItemAction } = await import('../src/app/items/actions');
      const fd = new FormData();
      fd.set('code', 'IT1');
      fd.set('name', 'Item');
      fd.set('kind', 'raw_material');
      fd.set('baseUnit', 'kg');
      const to = await expectRedirectTo(() => createItemAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'staff — "…already has an open employment…" via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'This person already has an open employment at this store.';
      createEmployment.mockRejectedValueOnce(refuse('createEmployment: person already has an open employment', S));
      const { hireAction } = await import('../src/app/staff/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('personChoice', 'existing:person-1');
      fd.set('employmentStatus', 'full_time');
      fd.set('startedOn', '2026-01-10');
      const to = await expectRedirectTo(() => hireAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

// ===========================================================================================
// K1 (⛔ green now) — one row per file that keeps a branch (7): a NON-presentable, constraint- or
// plain-Error-shaped error still renders exactly today's kept-branch text.
// ===========================================================================================

describe('K1 (⛔) — a non-presentable error still hits its kept local branch, unchanged', () => {
  it(
    'production — a plain Error matching /live slicer payment/ renders the raw text itself',
    async () => {
      postProduction.mockRejectedValueOnce(new Error('postProduction: a live slicer payment is in progress'));
      const { postProductionAction } = await import('../src/app/inventory/production/actions');
      const fd = new FormData();
      fd.set('recordId', 'rec-1');
      const to = await expectRedirectTo(() => postProductionAction(fd));
      expect(errorOf(to)).toBe('postProduction: a live slicer payment is in progress');
    },
    30000,
  );

  it(
    'usage — a plain Error matching /is a parking spot/ renders the mapped sentence',
    async () => {
      saveUsageDraft.mockRejectedValueOnce(new Error('saveUsageDraft: the Receiving room is a parking spot for new deliveries'));
      const { saveUsageDraftAction } = await import('../src/app/inventory/usage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('kind', 'usage');
      fd.set('locationId', 'loc-1');
      fd.set('usedOn', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      const to = await expectRedirectTo(() => saveUsageDraftAction(fd));
      expect(errorOf(to)).toBe('The Receiving room is a parking spot for new deliveries — it cannot be a usage source.');
    },
    30000,
  );

  it(
    'counts — a plain Error matching /is frozen by an active count session/ renders the mapped sentence',
    async () => {
      openCountSession.mockRejectedValueOnce(new Error('openCountSession: this room is frozen by an active count session'));
      const { openCountSessionAction } = await import('../src/app/inventory/counts/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.append('locationIds', 'loc-1');
      fd.set('countedOn', '2026-01-10');
      const to = await expectRedirectTo(() => openCountSessionAction(fd));
      expect(errorOf(to)).toBe('That room is frozen by an active count — finish or cancel the count first.');
    },
    30000,
  );

  it(
    'items — a { code: "23505", constraint: "items_org_name_key" } error renders the mapped sentence',
    async () => {
      createItem.mockRejectedValueOnce(
        pgError('duplicate key value violates unique constraint "items_org_name_key"', '23505', 'items_org_name_key'),
      );
      const { createItemAction } = await import('../src/app/items/actions');
      const fd = new FormData();
      fd.set('code', 'IT1');
      fd.set('name', 'Item');
      fd.set('kind', 'raw_material');
      fd.set('baseUnit', 'kg');
      const to = await expectRedirectTo(() => createItemAction(fd));
      expect(errorOf(to)).toBe('An item with that name already exists — names are one per organisation, ignoring case.');
    },
    30000,
  );

  it(
    'staff — a plain Error matching /must be exactly 6 digits/ renders the raw text itself',
    async () => {
      createEmployment.mockRejectedValueOnce(new Error(`setPin: the PIN ${U} must be exactly 6 digits`));
      const { hireAction } = await import('../src/app/staff/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('personChoice', 'existing:person-1');
      fd.set('employmentStatus', 'full_time');
      fd.set('startedOn', '2026-01-10');
      const to = await expectRedirectTo(() => hireAction(fd));
      expect(errorOf(to)).toBe(`setPin: the PIN ${U} must be exactly 6 digits`);
    },
    30000,
  );
});

// ===========================================================================================
// K2 (⛔ green now) — one row per emptied file (6): a plain, non-presentable Error with a UUID in
// it renders exactly the SHARED errorMessage, with no UUID — the fallback these files keep once
// their local bypass is gone is the one they already fall through to today.
// ===========================================================================================

describe('K2 (⛔) — an emptied file’s fallback already equals the shared errorMessage, no UUID', () => {
  it(
    'pos-map',
    async () => {
      upsertPosItemMap.mockRejectedValueOnce(new Error(`upsertPosItemMap: ${U} text`));
      const { upsertPosItemMapAction } = await import('../src/app/inventory/pos-map/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('mode', 'direct');
      const to = await expectRedirectTo(() => upsertPosItemMapAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`upsertPosItemMap: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );

  it(
    'pos-usage',
    async () => {
      buildPlanForDay.mockRejectedValueOnce(new Error(`buildPlanForDay: ${U} text`));
      const { buildPlanAction } = await import('../src/app/inventory/pos-usage/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('salesDayId', 'sd-1');
      fd.set('locationId', 'loc-1');
      const to = await expectRedirectTo(() => buildPlanAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`buildPlanForDay: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );

  it(
    'staff/[employmentId]/credentials',
    async () => {
      enrolCard.mockRejectedValueOnce(new Error(`enrolCard: ${U} text`));
      const { enrolCardAction } = await import('../src/app/staff/[employmentId]/credentials/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('employmentId', 'emp-1');
      fd.set('cardId', 'card-1');
      const to = await expectRedirectTo(() => enrolCardAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`enrolCard: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );

  it(
    'trade/orders',
    async () => {
      createTradeOrder.mockRejectedValueOnce(new Error(`createTradeOrder: ${U} text`));
      const { createOrderAction } = await import('../src/app/trade/orders/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('customerId', 'cust-1');
      fd.set('orderDate', '2026-01-10');
      fd.append('itemId', 'item-1');
      fd.append('quantity', '1');
      const to = await expectRedirectTo(() => createOrderAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`createTradeOrder: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );

  it(
    'commissary/catalogue',
    async () => {
      upsertCommissaryLink.mockRejectedValueOnce(new Error(`upsertCommissaryLink: ${U} text`));
      const { upsertLinkAction } = await import('../src/app/commissary/catalogue/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('commissaryStoreId', 'store-1');
      fd.set('branchStoreId', 'store-2');
      const to = await expectRedirectTo(() => upsertLinkAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`upsertCommissaryLink: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );

  it(
    'attendance/terminals',
    async () => {
      provisionTerminal.mockRejectedValueOnce(new Error(`provisionTerminal: ${U} text`));
      const { provisionTerminalAction } = await import('../src/app/attendance/terminals/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const result = await provisionTerminalAction({ storeId: 'store-1', label: 'Front door' });
      if (result.ok) throw new Error('expected provisionTerminalAction to refuse');
      expect(result.error).toBe(errorMessage(new Error(`provisionTerminal: ${U} text`)));
      expect(result.error).not.toContain(U);
    },
    30000,
  );
});

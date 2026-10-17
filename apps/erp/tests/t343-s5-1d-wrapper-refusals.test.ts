/**
 * T-343 S5.1d — W1-W3, S1-S5, D1-D6, L1-L4: the remaining app wrappers that pre-empt refusals
 * (DEF-448, DEF-450, rest of DEF-444). `docs/tasks/343-def-417-human-readable-refusals.md` §S5.1d.
 *
 * Same harness shape as `t343-s5-1c-commissary-refusals.test.ts`: `next/navigation`'s `redirect`
 * mocked to capture the URL via `RedirectSignal`, the four BUILDER files' own dependencies mocked
 * (`@shareat/domain`, `@shareat/db`, `../src/app/expenses/lib`, session) — never the BUILDER files
 * themselves, so each file's own LOCAL, private `errorMessage`/`errorMessageOf` runs for real. The
 * real `@shareat/core/datetime` (`toBusinessDate`) and the real `@/lib/constraint-messages` are
 * forwarded, never stubbed.
 *
 * ⛔ Was red before the builder: `wastage/actions.ts`'s `errorMessageOf` and the local `errorMessage`
 * in `admin/stores`, `inventory/deliveries` and `inventory/locations` each had regex bypasses
 * (`may not '…'`, `no store scope`, `/authorize:/`) that returned a role/scope sentence instead of
 * decoding the real `userMessage` S2/S2b already attached. The ⛔ legs (W3, S4, S5, D5, D6, L3, L4)
 * are negative halves — already true.
 *
 * ⛔ S5.3b ruling (orchestrator, 2026-09-27): the original spec's X1 (a static source-text scan for
 * `may not '`/`no store scope`/`authorize:` across the four files) was dropped here — it pinned
 * spelling and comment shape, not behaviour. The W/S/D/L legs above are the real guard: they fail
 * for the CORRECT behavioural reason regardless of how the builder rewords or restructures the
 * bypass, where a text scan would just start failing to find the string it was written against.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuse } from '../../../packages/db/src/refusal';
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

// `wastage/actions.ts` imports `withOrgPrincipal` from `../expenses/lib`; `admin/stores/actions.ts`
// from `../../expenses/lib`; `inventory/deliveries/lib.ts` and `inventory/locations/lib.ts` (real,
// unmocked — see below) both re-export it from the SAME `../../expenses/lib`. One mock, one
// absolute module, covers all four.
vi.mock('../src/app/expenses/lib', () => ({
  listStores: vi.fn(async () => []),
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const findByBusinessDate = vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({
  id: 'sd-1',
}));
vi.mock('@shareat/db', () => ({
  salesDaysRepo: { findByBusinessDate: (...args: unknown[]) => findByBusinessDate(...args) },
  storesRepo: { isValidDateString: vi.fn(() => true) },
  // `inventory/deliveries/lib.ts` / `inventory/locations/lib.ts` (real, unmocked) import these at
  // module scope; unused by any leg here, stubbed only so evaluation does not throw.
  apRepo: {},
  deliveriesRepo: {},
  itemsRepo: {},
  stockLocationsRepo: {},
}));

const recordOrderWastage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: 'resolved' }));
const disputeOrderWastage = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>>(async () => ({
  ok: true,
}));
const createStore = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  storeId: 'store-1',
  scopedAdminIds: [],
  missingCanonical: [],
  accessDefaultsSeeded: 0,
}));
const setStoreOpeningDate = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
const createDeliveryDocument = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  deliveryId: 'delivery-1',
  warnings: [],
}));
const receiveDeliveryDocument = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  totalValue: '0.00',
  entryId: 'je-1',
}));
const uploadFile = vi.fn<(...args: unknown[]) => Promise<{ fileId: string }>>(async () => ({ fileId: 'file-1' }));
const createLocation = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);

vi.mock('@shareat/domain', () => ({
  assertFieldRules: () => ({}),
  // wastage
  recordOrderWastage: (...args: unknown[]) => recordOrderWastage(...args),
  disputeOrderWastage: (...args: unknown[]) => disputeOrderWastage(...args),
  resolveOrderWastage: vi.fn(async () => ({ ok: true })),
  reverseAutoCharge: vi.fn(async () => ({ ok: true })),
  // admin/stores
  CANONICAL_POSITION_DEFAULTS: {},
  createStore: (...args: unknown[]) => createStore(...args),
  deactivateStore: vi.fn(async () => undefined),
  reactivateStore: vi.fn(async () => ({ scopedAdminIds: [] })),
  setStoreOpeningDate: (...args: unknown[]) => setStoreOpeningDate(...args),
  setStoreStockModel: vi.fn(async () => undefined),
  updateStoreDetails: vi.fn(async () => undefined),
  // inventory/deliveries
  createDeliveryDocument: (...args: unknown[]) => createDeliveryDocument(...args),
  receiveDeliveryDocument: (...args: unknown[]) => receiveDeliveryDocument(...args),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  // inventory/locations
  createLocation: (...args: unknown[]) => createLocation(...args),
  deactivateLocation: vi.fn(async () => undefined),
  ensureLocationTypes: vi.fn(async () => undefined),
  reactivateLocation: vi.fn(async () => undefined),
  seedStoreLocations: vi.fn(async () => ({ created: [] })),
  setDefaultLocation: vi.fn(async () => undefined),
  updateLocation: vi.fn(async () => undefined),
}));

// ⛔ NOT a stub — forwards to the real module (same reason as S5.1c/S5's outcome-message file: the
// bare `@/...` specifier is not resolved by the root `vitest.config.mts`).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

afterEach(() => {
  findByBusinessDate.mockClear();
  recordOrderWastage.mockClear();
  disputeOrderWastage.mockClear();
  createStore.mockClear();
  setStoreOpeningDate.mockClear();
  createDeliveryDocument.mockClear();
  receiveDeliveryDocument.mockClear();
  uploadFile.mockClear();
  createLocation.mockClear();
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

/** A Postgres-shaped error the way `postgres.js` attaches `code`/`constraint_name`, sufficient for
 *  each file's own regex (keyed on the constraint NAME appearing in `.message`, not the property). */
function pgError(message: string, code: string, constraint: string): Error & { code: string; constraint_name: string } {
  return Object.assign(new Error(message), { code, constraint_name: constraint });
}

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

describe('W1 — recordOrderWastageAction decodes an AuthorizationError’s userMessage (role shape)', () => {
  it(
    'error === S, not "Your role may not record order wastage." (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot record wastage for this store.';
      recordOrderWastage.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'manager' may not 'record_order_wastage'", 'record_order_wastage' as never, S),
      );

      const { recordOrderWastageAction } = await import('../src/app/wastage/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('channel', 'grab');
      fd.set('businessDate', '2026-01-15');
      fd.set('amount', '100.00');
      fd.set('reason', 'Dropped');

      const to = await expectRedirectTo(() => recordOrderWastageAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('W2 — disputeOrderWastageAction decodes an AuthorizationError’s userMessage (store-scope shape)', () => {
  it(
    'error === S, not "You are not assigned…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = "You aren't assigned to this store, so you can't dispute this wastage.";
      disputeOrderWastage.mockRejectedValueOnce(
        new AuthorizationError(`authorize: person p1 (role 'staff') has no store scope for ${U}`, 'dispute_order_wastage' as never, S),
      );

      const { disputeOrderWastageAction } = await import('../src/app/wastage/actions');
      const fd = new FormData();
      fd.set('id', 'wastage-1');
      fd.set('storeId', 'store-1');

      const to = await expectRedirectTo(() => disputeOrderWastageAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('W3 (⛔) — a plain Error with no userMessage still falls through to the shared errorMessage', () => {
  it(
    'green now and after: equals errorMessage(err), no UUID',
    async () => {
      recordOrderWastage.mockRejectedValueOnce(new Error(`recordOrderWastage: ${U} text`));

      const { recordOrderWastageAction } = await import('../src/app/wastage/actions');
      const { errorMessage } = await import('../src/lib/constraint-messages');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('channel', 'grab');
      fd.set('businessDate', '2026-01-15');
      fd.set('amount', '100.00');
      fd.set('reason', 'Dropped');

      const to = await expectRedirectTo(() => recordOrderWastageAction(fd));
      const error = errorOf(to)!;
      expect(error).toBe(errorMessage(new Error(`recordOrderWastage: ${U} text`)));
      expect(error).not.toContain(U);
    },
    30000,
  );
});

describe('S1 — createStoreAction decodes an AuthorizationError’s userMessage (role shape)', () => {
  it(
    'error === S, not "Only an admin or super-admin…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot open or close a branch.';
      createStore.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'manager' may not 'manage_stores'", 'manage_stores' as never, S),
      );

      const { createStoreAction } = await import('../src/app/admin/stores/actions');
      const fd = new FormData();
      fd.set('code', 'NEW1');
      fd.set('name', 'New Store');

      const to = await expectRedirectTo(() => createStoreAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('S2 — setStoreOpeningDateAction decodes an AuthorizationError’s userMessage (store-scope shape)', () => {
  it(
    'error === S, not "You do not have access to that store." (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = "You aren't assigned to this store, so you can't set its opening date.";
      setStoreOpeningDate.mockRejectedValueOnce(
        new AuthorizationError(`authorize: person p1 (role 'staff') has no store scope for ${U}`, 'manage_stores' as never, S),
      );

      const { setStoreOpeningDateAction } = await import('../src/app/admin/stores/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');

      const to = await expectRedirectTo(() => setStoreOpeningDateAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('S3 — createStoreAction’s "named" prefix-strip pre-empts a presentable userMessage', () => {
  it(
    'error === S, not the raw tail "raw tail" (was the named-branch bypass)',
    async () => {
      const S = 'A store needs a real, human reason here.';
      createStore.mockRejectedValueOnce(refuse('createStore: raw tail', S));

      const { createStoreAction } = await import('../src/app/admin/stores/actions');
      const fd = new FormData();
      fd.set('code', 'NEW1');
      fd.set('name', 'New Store');

      const to = await expectRedirectTo(() => createStoreAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('S4 (⛔) — a real DB constraint (pooling ceiling) keeps its own local sentence', () => {
  it(
    'green now and after',
    async () => {
      createStore.mockRejectedValueOnce(
        pgError(
          'insert or update on table "stores" violates check constraint "stores_pooling_requires_ceiling_check"',
          '23514',
          'stores_pooling_requires_ceiling_check',
        ),
      );

      const { createStoreAction } = await import('../src/app/admin/stores/actions');
      const fd = new FormData();
      fd.set('code', 'NEW1');
      fd.set('name', 'New Store');

      const to = await expectRedirectTo(() => createStoreAction(fd));
      expect(errorOf(to)).toBe(
        'A store that pools cash must name the ceiling that bounds it. Either set the cadence to daily, or give an unremitted ceiling.',
      );
    },
    30000,
  );
});

describe('S5 (⛔) — a plain domain Error still reads as one clean sentence', () => {
  it(
    'green now and after (must stay after S3’s "named" branch is deleted)',
    async () => {
      createStore.mockRejectedValueOnce(new Error('createStore: a store needs a code.'));

      const { createStoreAction } = await import('../src/app/admin/stores/actions');
      const fd = new FormData();
      fd.set('name', 'New Store');

      const to = await expectRedirectTo(() => createStoreAction(fd));
      expect(errorOf(to)).toBe('a store needs a code.');
    },
    30000,
  );
});

describe('D1 — receiveDeliveryAction decodes an AuthorizationError’s userMessage (receive_delivery shape)', () => {
  it(
    'error === S, not "Recording or receiving a delivery needs…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot receive this delivery.';
      receiveDeliveryDocument.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'staff' may not 'receive_delivery'", 'receive_delivery' as never, S),
      );

      const { receiveDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const fd = new FormData();
      fd.set('deliveryId', 'delivery-1');

      const to = await expectRedirectTo(() => receiveDeliveryAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('D2 — receiveDeliveryAction decodes an AuthorizationError’s userMessage (allow_over_receipt shape)', () => {
  it(
    'error === S, not "Only a manager or admin can approve…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'Ask a manager to approve receiving more than what was ordered.';
      receiveDeliveryDocument.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'staff' may not 'allow_over_receipt'", 'allow_over_receipt' as never, S),
      );

      const { receiveDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const fd = new FormData();
      fd.set('deliveryId', 'delivery-1');

      const to = await expectRedirectTo(() => receiveDeliveryAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

function deliveryFormData(): FormData {
  const fd = new FormData();
  fd.set('storeId', 'store-1');
  fd.set('kind', 'purchase');
  fd.set('deliveredOn', '2026-01-15');
  fd.set('itemId', 'item-1');
  fd.set('orderedQuantity', '10');
  fd.set('proofPhoto', new File([new Uint8Array([1, 2, 3])], 'proof.jpg', { type: 'image/jpeg' }));
  return fd;
}

describe('D3 — createDeliveryAction decodes an AuthorizationError’s userMessage (store-scope shape)', () => {
  it(
    'error === S, not "You are not assigned…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = "You aren't assigned to this store, so you can't create a delivery there.";
      createDeliveryDocument.mockRejectedValueOnce(
        new AuthorizationError(`authorize: person p1 (role 'staff') has no store scope for ${U}`, 'create_delivery' as never, S),
      );

      const { createDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const to = await expectRedirectTo(() => createDeliveryAction(deliveryFormData()));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('D4 — createDeliveryAction decodes a gone-proof-file refusal’s userMessage', () => {
  it(
    'error === S, not "That photo could not be found…" (was the bypass sentence)',
    async () => {
      const S = 'The attached photo has gone missing — attach it again.';
      createDeliveryDocument.mockRejectedValueOnce(
        refuse(`createDeliveryDocument: proof file ${U} does not exist in this org`, S),
      );

      const { createDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const to = await expectRedirectTo(() => createDeliveryAction(deliveryFormData()));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('D5 (⛔) — a plain shortage-reason refusal keeps its own local sentence', () => {
  it(
    'green now and after',
    async () => {
      receiveDeliveryDocument.mockRejectedValueOnce(
        new Error('receiveDeliveryDocument: line 2 must carry a shortage reason'),
      );

      const { receiveDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const fd = new FormData();
      fd.set('deliveryId', 'delivery-1');

      const to = await expectRedirectTo(() => receiveDeliveryAction(fd));
      expect(errorOf(to)).toBe('A line received short needs a reason before it can be received.');
    },
    30000,
  );
});

describe('D6 (⛔) — a real DB constraint (duplicate supplier reference) keeps its own local sentence', () => {
  it(
    'green now and after',
    async () => {
      createDeliveryDocument.mockRejectedValueOnce(
        pgError(
          'duplicate key value violates unique constraint "deliveries_supplier_reference_key"',
          '23505',
          'deliveries_supplier_reference_key',
        ),
      );

      const { createDeliveryAction } = await import('../src/app/inventory/deliveries/actions');
      const to = await expectRedirectTo(() => createDeliveryAction(deliveryFormData()));
      expect(errorOf(to)).toBe(
        'This supplier and reference number are already recorded on another delivery — check you are not entering the same paper twice.',
      );
    },
    30000,
  );
});

describe('L1 — createLocationAction decodes an AuthorizationError’s userMessage (manage_locations shape)', () => {
  it(
    'error === S, not "Only a manager or admin scoped…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = 'You cannot manage rooms for this store.';
      createLocation.mockRejectedValueOnce(
        new AuthorizationError("authorize: role 'staff' may not 'manage_locations'", 'manage_locations' as never, S),
      );

      const { createLocationAction } = await import('../src/app/inventory/locations/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('code', 'ROOM1');
      fd.set('name', 'Room One');
      fd.set('typeId', 'type-1');
      fd.set('role', 'storage');

      const to = await expectRedirectTo(() => createLocationAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('L2 — createLocationAction decodes an AuthorizationError’s userMessage (store-scope shape)', () => {
  it(
    'error === S, not "You do not have access to manage rooms…" (was the bypass sentence)',
    async () => {
      const { AuthorizationError } = await import('../../../packages/auth/src/errors');
      const S = "You aren't assigned to this store, so you can't manage its rooms.";
      createLocation.mockRejectedValueOnce(
        new AuthorizationError(`authorize: person p1 (role 'staff') has no store scope for ${U}`, 'manage_locations' as never, S),
      );

      const { createLocationAction } = await import('../src/app/inventory/locations/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('code', 'ROOM1');
      fd.set('name', 'Room One');
      fd.set('typeId', 'type-1');
      fd.set('role', 'storage');

      const to = await expectRedirectTo(() => createLocationAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

describe('L3 (⛔) — a real DB constraint (one Receiving room per store) keeps its own local sentence', () => {
  it(
    'green now and after',
    async () => {
      createLocation.mockRejectedValueOnce(
        pgError(
          'duplicate key value violates unique constraint "stock_locations_one_receiving_per_store"',
          '23505',
          'stock_locations_one_receiving_per_store',
        ),
      );

      const { createLocationAction } = await import('../src/app/inventory/locations/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('code', 'ROOM1');
      fd.set('name', 'Room One');
      fd.set('typeId', 'type-1');
      fd.set('role', 'storage');
      fd.set('isReceiving', 'on');

      const to = await expectRedirectTo(() => createLocationAction(fd));
      expect(errorOf(to)).toBe('This store already has a Receiving room — there can be only one.');
    },
    30000,
  );
});

describe('L4 (⛔) — the single-room plain-Error refusal keeps its own local sentence', () => {
  it(
    'green now and after',
    async () => {
      createLocation.mockRejectedValueOnce(
        new Error('createLocation: this store is single_room and already has an active non-Receiving room'),
      );

      const { createLocationAction } = await import('../src/app/inventory/locations/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('code', 'ROOM1');
      fd.set('name', 'Room One');
      fd.set('typeId', 'type-1');
      fd.set('role', 'storage');

      const to = await expectRedirectTo(() => createLocationAction(fd));
      expect(errorOf(to)).toBe(
        'This store keeps stock in ONE room. Deactivate or repurpose the existing room before adding another.',
      );
    },
    30000,
  );
});

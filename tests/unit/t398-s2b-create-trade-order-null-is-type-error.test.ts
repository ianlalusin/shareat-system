/**
 * T-398 S2b T3 - compile-time guard. `docs/tasks/398-padre-garcia-franchise-org.md` S2, T3.
 * The `@ts-expect-error` below is only satisfied while `null` is NOT assignable to `createTradeOrder`'s first parameter.
 * Today the parameter is `tx: Tx | null`, so the directive is unused and `npm run typecheck` fails with TS2578
 * (tests/** is inside tsconfig `include`). Mutant killed: `| null` put back on createTradeOrder -> typecheck red.
 * The runtime assertion is only a placeholder so vitest collects the file; the real check is `tsc --noEmit`.
 */
import { describe, expect, it } from 'vitest';
import { createTradeOrder } from '@shareat/domain';

describe('T-398 S2b T3: createTradeOrder(null, ...) is a compile error', () => {
  it('has a @ts-expect-error on the null call (checked by typecheck, never executed)', () => {
    const neverCalled = async () => {
      // @ts-expect-error DEF-421: a null tx must not type-check.
      await createTradeOrder(null, { personId: 'p', orgId: 'o' }, {} as never);
    };
    expect(typeof neverCalled).toBe('function');
  });
});

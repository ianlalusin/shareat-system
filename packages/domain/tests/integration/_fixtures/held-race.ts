import type { Tx } from '@shareat/db';

/**
 * T-574: run `opA` to completion but HOLD its transaction open, start `opB` meanwhile, give B a moment to either finish (no lock) or
 * park (lock), then let A commit. Resolves with both results. If A throws, the error is rethrown at once - B is still released, and
 * the gate is always opened - so a broken A fails the test instead of hanging it.
 */
export async function heldRace<A, B>(
  asOrg: <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>,
  orgId: string,
  opA: (tx: Tx) => Promise<A>,
  opB: (tx: Tx) => Promise<B>,
  waitMs = 700,
): Promise<[A, B]> {
  const aDone = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const aSettled = asOrg(orgId, async (tx) => {
    let r: A;
    try {
      r = await opA(tx);
    } finally {
      aDone.resolve();
    }
    await gate.promise;
    return r;
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await aDone.promise;
  const bSettled = asOrg(orgId, opB).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([bSettled, new Promise((r) => setTimeout(r, waitMs))]);
  } finally {
    gate.resolve();
  }
  const [a, b] = await Promise.all([aSettled, bSettled]);
  if (!a.ok) throw a.error;
  if (!b.ok) throw b.error;
  return [a.value, b.value];
}

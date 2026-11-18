import type postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import type { Tx } from '@shareat/db';

/**
 * T-574: run `opA` to completion but HOLD its transaction open, start `opB` meanwhile, give B a moment to either finish (no lock) or
 * park (lock), then let A commit. Resolves with both results. If A throws, the error is rethrown at once - B is still released, and
 * the gate is always opened - so a broken A fails the test instead of hanging it.
 *
 * T-594: pass `park` and the race PROVES B really parked: B's backend is polled in `pg_stat_activity` until it shows waiting on a lock
 * (`wait_event_type = 'Lock'`), instead of trusting the sleep. If B finishes without ever waiting, or never parks within `timeoutMs`,
 * the call throws - a race in which B never waited is not a race, and its green result would say nothing about the lock.
 */
export async function heldRace<A, B>(
  asOrg: <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>,
  orgId: string,
  opA: (tx: Tx) => Promise<A>,
  opB: (tx: Tx) => Promise<B>,
  waitMs = 700,
  park?: { sql: postgres.Sql; waitEvents?: string[]; timeoutMs?: number },
): Promise<[A, B]> {
  const aDone = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const bPid = Promise.withResolvers<number>();
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
  const runB = park
    ? async (tx: Tx): Promise<B> => {
        const rows = (await tx.execute(dsql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
        bPid.resolve(Number(rows[0]?.pid));
        return opB(tx);
      }
    : opB;
  let bFinished = false;
  const bSettled = asOrg(orgId, runB).then(
    (value) => {
      bFinished = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      bFinished = true;
      return { ok: false as const, error };
    },
  );
  let parked = true;
  try {
    if (park) {
      parked = false;
      const events = park.waitEvents ?? ['transactionid', 'tuple', 'advisory'];
      const pid = await Promise.race([bPid.promise, bSettled.then(() => 0)]);
      const deadline = Date.now() + (park.timeoutMs ?? 5000);
      while (pid && !bFinished && !parked && Date.now() < deadline) {
        const hit = await park.sql<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock' and wait_event = any(${events})`;
        parked = hit.length > 0;
        if (!parked) await new Promise((r) => setTimeout(r, 20));
      }
    } else {
      await Promise.race([bSettled, new Promise((r) => setTimeout(r, waitMs))]);
    }
  } finally {
    gate.resolve();
  }
  const [a, b] = await Promise.all([aSettled, bSettled]);
  if (!a.ok) throw a.error;
  if (!b.ok) throw b.error;
  if (park && !parked) throw new Error('heldRace: B never parked on a lock while A held its transaction open, so this was not a race.');
  return [a.value, b.value];
}

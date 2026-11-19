/**
 * T-612: `createEmployment` for a person with no open job starts them `pending` (a manager activates them). Fixtures in this folder hire raw-inserted
 * people who are meant to WORK, so they import this wrapper instead: it hires through the real domain function, then activates the person in the same
 * transaction - "T-612: activate after hire, as a manager would". Tests about the pending state itself (t612-*) use the real function.
 */
import { sql } from 'drizzle-orm';
import type { Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { createEmployment as hire } from '../../../src/people';

export async function createEmployment(tx: Tx, actor: Actor, input: Parameters<typeof hire>[2]): Promise<Awaited<ReturnType<typeof hire>>> {
  const employment = await hire(tx, actor, input);
  await tx.execute(sql`update persons set account_status = 'active' where id = ${input.personId} and account_status = 'pending'`);
  return employment;
}

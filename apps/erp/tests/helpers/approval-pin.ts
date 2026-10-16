import type postgres from 'postgres';
import { hashPin, pinLookupHash } from '@shareat/auth';

/**
 * T-412 test helper: gives a fixture person a sign-in PIN and returns the six digits, so a test can post `adminPin` to a
 * Tier P action. In an org with no administrator the elevated manager who holds the capability is whose PIN counts
 * (bible row 196), so most older fixtures only need a PIN for their manager.
 */
let n = 0;
export async function givePin(
  sql: postgres.Sql,
  o: { orgId: string; storeId: string; personId: string },
): Promise<string> {
  const pin = String(300000 + ((Date.now() + ++n * 7919) % 600000));
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${o.personId}, 'pin', ${o.storeId}, ${await hashPin(pin)}, ${pinLookupHash(o.orgId, pin)})`;
  return pin;
}

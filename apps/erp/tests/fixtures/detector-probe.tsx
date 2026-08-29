'use server';

/**
 * ⭐ NOT REAL CODE. A deliberately non-compliant file, so the client-only detector in
 * `clock-route-is-client-only.test.ts` can be **watched catching something**.
 *
 * T-153 established the discipline: every refusal in the Firestore ruleset was watched failing
 * against a permissive version, because *"a test that has never failed is a test nobody has proven
 * detects anything."* The same reasoning applies to a static import guard — a changed regex or a
 * resolution bug would leave the real check silently passing on everything.
 *
 * ⚠️ It lives under `tests/fixtures/` and NOT under `src/app/clock/` on purpose: anything in the
 * app directory is compiled by Next, and a `'use server'` file importing `@shareat/db` is exactly
 * what this repo must not ship. Here it is inert — nothing imports it but the test.
 */
import { transaction } from '@shareat/db';

export async function probe(): Promise<void> {
  await transaction(async () => {});
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  setSetupIdentityCookie,
  readSetupIdentity,
  clearSetupIdentityCookie,
  SETUP_IDENTITY_TTL_MS,
} from '../src/lib/session';

/**
 * T-232 slice 1 — the `SetupIdentity` seam (`docs/tasks/232-email-sign-in-and-first-run-setup.md`
 * §2.4). **Lane E issues the cookie; lane B's `/setup` consumes it.** These tests are the contract
 * between the two lanes, so they assert the wire format and the four exported names, not just the
 * happy path.
 *
 * ## ⭐ What this actually guards
 *
 * The cookie carries a **verified** Firebase uid across one redirect, and at the other end lane B
 * turns it into the owner of the organisation. So the thing under test is not "does a round-trip
 * work" — it is *"can anything other than this server's key produce a value `readSetupIdentity`
 * accepts?"* Tests 4, 5 and 9 are that question asked three ways.
 *
 * ⚠️ The cookie is **not** the control that stops a replay — `bootstrapOrganization`'s advisory
 * lock and zero-org refusal are (§2.4, "the guarantee is the database, not the cookie"). What this
 * file proves is narrower and still necessary: an *unsigned* or *stale* identity never gets that
 * far.
 */

const BASE = {
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
};

/** `process.env.NODE_ENV` is readonly once Next's types are in scope — same accessor
 *  `tests/unit/env.test.ts` uses, for the same reason. */
type MutableEnv = Record<string, string | undefined>;
const E = () => process.env as unknown as MutableEnv;

interface SetCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** A cookie jar with just enough of Next's `cookies()` surface for this seam. */
class FakeJar {
  store = new Map<string, string>();
  calls: SetCall[] = [];
  set(name: string, value: string, options: Record<string, unknown>) {
    this.store.set(name, value);
    this.calls.push({ name, value, options });
  }
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  delete(name: string) {
    this.store.delete(name);
  }
}

let jar: FakeJar;
let saved: NodeJS.ProcessEnv;

vi.mock('next/headers', () => ({
  cookies: async () => jar,
}));

beforeEach(() => {
  saved = process.env;
  process.env = { ...BASE } as unknown as NodeJS.ProcessEnv;
  jar = new FakeJar();
});

afterEach(() => {
  process.env = saved;
  vi.useRealTimers();
});

/**
 * ⛔ **The import is STATIC and there is no `vi.resetModules()` in `beforeEach`, deliberately.**
 *
 * `session.ts` → `@shareat/auth` → `authorize`/`sessions` → `@shareat/db` → the whole schema
 * barrel. Measured cold: **4.65 s to import `@shareat/auth` alone.** With a per-test module reset
 * every test re-imported that graph, and the unit project's timeout is vitest's **5 s** default
 * (only the integration project raises it to 30 s) — so the first test spent its entire budget in
 * `import` and timed out, while the later ones passed on a warm transform cache. It looked like
 * flakiness; it was a fixed cost in the wrong place.
 *
 * A static import pays that cost once, at collection, where no timeout applies. The one test that
 * genuinely needs a fresh registry — production mode, because `env()` memoises — resets and
 * re-imports for itself.
 */
async function freshSeam() {
  vi.resetModules();
  return await import('../src/lib/session');
}

const IDENTITY = {
  uid: 'firebase-uid-abc123',
  email: 'ian@shareat.net',
  displayName: 'Ian',
};

/** The two halves of the stored value, for the tests that need to corrupt one of them. */
function split(value: string): { payload: string; signature: string } {
  const [payload, signature] = value.split('.');
  return { payload: payload!, signature: signature! };
}

describe('the SetupIdentity cookie — the seam lane B consumes', () => {
  it('round-trips a verified identity, and the expiry is the 10-minute TTL', async () => {
    expect(SETUP_IDENTITY_TTL_MS).toBe(10 * 60 * 1000);

    const before = Date.now();
    await setSetupIdentityCookie(IDENTITY);
    const read = await readSetupIdentity();

    expect(read).not.toBeNull();
    expect(read!.uid).toBe(IDENTITY.uid);
    expect(read!.email).toBe(IDENTITY.email);
    expect(read!.displayName).toBe(IDENTITY.displayName);
    // Not an exact equality: the clock moves between the write and the read.
    expect(read!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SETUP_IDENTITY_TTL_MS);
    expect(read!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SETUP_IDENTITY_TTL_MS);
  });

  it('a null email and a null display name survive the round trip as null, not as "null"', async () => {
    // Firebase gives no display name for an account created by email and password alone, and lane
    // B prefills the owner's name from `displayName ?? email`. A string "null" would render.
    await setSetupIdentityCookie({ uid: 'u1', email: null, displayName: null });
    const read = await readSetupIdentity();
    expect(read).toEqual(
      expect.objectContaining({ uid: 'u1', email: null, displayName: null }),
    );
  });

  it('is httpOnly, lax, path-wide, and expires in 600 seconds', async () => {
    await setSetupIdentityCookie(IDENTITY);

    const call = jar.calls.at(-1)!;
    expect(call.name).toBe('shareat_setup');
    expect(call.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    // ⚠️ NOT secure outside production, and deliberately: on http://localhost a `secure` cookie
    // never sets, and the failure looks like a bug in the sign-in code. Same reason the session
    // cookie gives in `session.ts`.
    expect(call.options.secure).toBe(false);
  });

  it('is secure in production', async () => {
    E().NODE_ENV = 'production';
    // ⚠️ Signing reads `SESSION_SECRET` through `env()`, and `env()` fails CLOSED in production —
    // so a production-mode test must satisfy the whole production contract, not just the key it
    // uses. That is the point of §7 rule 9 and it is why these two lines are here rather than a
    // cast around the check.
    E().FIREBASE_PROJECT_ID = 'studio-7300228488-a394e';
    E().FIREBASE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
    // The one test that needs a fresh registry: `env()` memoises, so production mode is only
    // really exercised if the module graph re-reads it.
    const { setSetupIdentityCookie: setInProd } = await freshSeam();
    await setInProd(IDENTITY);
    expect(jar.calls.at(-1)!.options.secure).toBe(true);
  });

  it('carries the uid, the email, the name and an expiry — and nothing else', async () => {
    // The value is readable by anyone holding the cookie. It must not be a place a secret lands.
    await setSetupIdentityCookie(IDENTITY);

    const { payload } = split(jar.calls.at(-1)!.value);
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['displayName', 'email', 'exp', 'uid']);
    expect(decoded.uid).toBe(IDENTITY.uid);
    expect(typeof decoded.exp).toBe('number');
  });

  describe('what it refuses — all four answer null, because they need one action', () => {
    it('absent', async () => {
      expect(await readSetupIdentity()).toBeNull();
    });

    it('malformed — no separator, empty, or not JSON', async () => {
      for (const junk of ['', 'not-a-cookie', 'a.b', '.', Buffer.from('{oops').toString('base64url') + '.x']) {
        jar.store.set('shareat_setup', junk);
        expect(await readSetupIdentity()).toBeNull();
      }
    });

    it('⛔ TAMPERED payload — a uid swapped for somebody else s', async () => {
      await setSetupIdentityCookie(IDENTITY);
      const { signature } = split(jar.store.get('shareat_setup')!);

      const forged = Buffer.from(
        JSON.stringify({ uid: 'somebody-else', email: null, displayName: null, exp: Date.now() + 60_000 }),
      ).toString('base64url');
      jar.store.set('shareat_setup', `${forged}.${signature}`);

      expect(await readSetupIdentity()).toBeNull();
    });

    it('⛔ a signature that is merely well-formed', async () => {
      await setSetupIdentityCookie(IDENTITY);
      const { payload, signature } = split(jar.store.get('shareat_setup')!);

      // Same length, one byte different — the compare must be over bytes, not a prefix.
      const flipped = Buffer.from(signature, 'base64url');
      flipped[0] = flipped[0]! ^ 0xff;
      jar.store.set('shareat_setup', `${payload}.${flipped.toString('base64url')}`);

      expect(await readSetupIdentity()).toBeNull();
    });

    it('⛔⭐ a signature made with the BARE SESSION_SECRET — the label is what keeps the keys apart', async () => {
      // §2.4: "signed with a key derived from SESSION_SECRET under a NEW domain-separation label
      // 'setup-identity' … not a bare SESSION_SECRET HMAC in the app layer". If this test passes
      // with the bare secret, the label is decorative and any other HMAC in the system could be
      // replayed as a setup identity.
      const payload = Buffer.from(
        JSON.stringify({ uid: 'forged', email: null, displayName: null, exp: Date.now() + 60_000 }),
      ).toString('base64url');
      const bare = createHmac('sha256', BASE.SESSION_SECRET).update(payload).digest('base64url');
      jar.store.set('shareat_setup', `${payload}.${bare}`);

      expect(await readSetupIdentity()).toBeNull();
    });

    it('⛔ EXPIRED — a correctly signed identity from eleven minutes ago', async () => {

      // Sign it in the past through the real signer, so the ONLY thing wrong is the clock.
      vi.setSystemTime(new Date(Date.now() - SETUP_IDENTITY_TTL_MS - 60_000));
      await setSetupIdentityCookie(IDENTITY);
      vi.useRealTimers();

      expect(await readSetupIdentity()).toBeNull();
    });
  });

  it('clearing it means the next read is null', async () => {
    await setSetupIdentityCookie(IDENTITY);
    expect(await readSetupIdentity()).not.toBeNull();

    await clearSetupIdentityCookie();
    expect(await readSetupIdentity()).toBeNull();
  });
});

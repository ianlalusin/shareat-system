/**
 * flash-jar-core.ts - T-380 S1a. The in-memory cookie jar and the Next module fakes, and NOTHING that
 * imports `@/lib/flash`.
 *
 * Why this is a separate file from `flash-jar.ts`: `flash-jar-setup.ts` (a vitest `setupFile` for
 * the `unit` and `integration` projects, REV-2) imports THIS file. If it imported `flash-jar.ts`, which
 * statically imports `@/lib/flash`, then on any tree where `flash.ts` does not exist yet every test in
 * the repo would fail to load. The jar must be safe to load everywhere, always.
 *
 * The jar lives on `globalThis` under a Symbol.for key, so the instance the setup file installed and
 * the instance a test file reads are the same object whatever the module graph does.
 */

export interface StoredCookie {
  value: string;
  options: Record<string, unknown>;
}

export class FlashJar {
  readonly store = new Map<string, StoredCookie>();
  /** Every `set` call in order, so a test can prove a read path never wrote. */
  readonly sets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  /** Every `delete` call in order. */
  readonly deletes: string[] = [];

  set(nameOrCookie: string | { name: string; value: string; [k: string]: unknown }, value?: string, options?: Record<string, unknown>): this {
    if (typeof nameOrCookie === 'string') {
      this.sets.push({ name: nameOrCookie, value: value ?? '', options: options ?? {} });
      this.store.set(nameOrCookie, { value: value ?? '', options: options ?? {} });
    } else {
      const { name, value: v, ...rest } = nameOrCookie;
      this.sets.push({ name, value: v, options: rest });
      this.store.set(name, { value: v, options: rest });
    }
    return this;
  }

  get(name: string): { name: string; value: string } | undefined {
    const c = this.store.get(name);
    return c ? { name, value: c.value } : undefined;
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  getAll(): Array<{ name: string; value: string }> {
    return [...this.store.entries()].map(([name, c]) => ({ name, value: c.value }));
  }

  delete(name: string | { name: string }): this {
    const n = typeof name === 'string' ? name : name.name;
    this.deletes.push(n);
    this.store.delete(n);
    return this;
  }
}

const KEY = Symbol.for('shareat.t380.flashJar');
type G = { [KEY]?: FlashJar };

/** The jar `next/headers`' `cookies()` currently returns. */
export function currentJar(): FlashJar {
  const g = globalThis as unknown as G;
  g[KEY] ??= new FlashJar();
  return g[KEY];
}

/** Install and return a fresh, empty jar. */
export function resetJar(): FlashJar {
  const g = globalThis as unknown as G;
  g[KEY] = new FlashJar();
  return g[KEY];
}

/** The `vi.mock('next/headers', ...)` factory body. */
export function nextHeadersMock(): Record<string, unknown> {
  return {
    cookies: async () => currentJar(),
    headers: async () => new Headers(),
  };
}

/** What a mocked `redirect()` throws, so a test can catch it where Next would have unwound. */
export class RedirectSignal extends Error {
  constructor(
    readonly url: string,
    readonly kind: 'redirect' | 'permanent' = 'redirect',
  ) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

/** The `vi.mock('next/navigation', ...)` factory body. */
export function nextNavigationMock(): Record<string, unknown> {
  return {
    redirect: (url: string): never => {
      throw new RedirectSignal(url);
    },
    permanentRedirect: (url: string): never => {
      throw new RedirectSignal(url, 'permanent');
    },
    notFound: (): never => {
      throw new Error('NEXT_NOT_FOUND');
    },
    // T-448: FormModal (and so every page that draws an add form) reads the address to close on navigation.
    usePathname: (): string => '/',
    useSearchParams: (): URLSearchParams => new URLSearchParams(),
    useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  };
}

/** Run an action; return the redirect it threw, or fail loudly if it returned or threw otherwise. */
export async function captureRedirect(run: () => Promise<unknown>): Promise<RedirectSignal> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err;
    throw err;
  }
  throw new Error('expected a redirect, but the action returned normally');
}

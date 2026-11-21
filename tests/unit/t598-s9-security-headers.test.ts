/**
 * T-598 S9 / DEF-845: the ERP sends the four browser-safety headers on every page and no `X-Powered-By`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

async function loadConfig(): Promise<{ poweredByHeader?: boolean; headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }> {
  // The config runs dotenv against the repo-root .env.local; keep that from changing this worker's environment.
  const saved = { ...process.env };
  try {
    return require(join(__dirname, '..', '..', 'apps', 'erp', 'next.config.js'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('apps/erp/next.config.js security headers (DEF-845)', () => {
  it('turns X-Powered-By off', async () => {
    expect((await loadConfig()).poweredByHeader).toBe(false);
  });

  it('sends the four headers on every path, with HSTS but no includeSubDomains or preload', async () => {
    const rules = await (await loadConfig()).headers();
    const all = rules.find((r) => r.source === '/(.*)');
    expect(all, 'a rule for every path').toBeDefined();
    const h = Object.fromEntries(all!.headers.map((x) => [x.key, x.value]));
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000');
  });

  it('keeps the service worker uncached', async () => {
    const rules = await (await loadConfig()).headers();
    expect(rules.find((r) => r.source === '/sw.js')?.headers[0]).toEqual({ key: 'Cache-Control', value: 'no-cache, max-age=0' });
  });
});

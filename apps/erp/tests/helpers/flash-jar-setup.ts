/**
 * flash-jar-setup.ts - T-380 S1a / REV-2. A vitest `setupFile` for the `unit` and `integration`
 * projects.
 *
 * Once a page calls `withFlash`, it calls the real `cookies()`, which throws outside a request scope.
 * About 27 page-render tests mock `page-access`/`session` and not `next/headers`; without this they
 * would all turn red the moment their page converts. A test that does its own
 * `vi.mock('next/headers', ...)` still wins over this one (a test file's mock overrides a setup
 * file's), so nothing that works today changes.
 */
import { beforeEach, vi } from 'vitest';
import { resetJar } from './flash-jar-core';

vi.mock('next/headers', async () => (await import('./flash-jar-core')).nextHeadersMock());

// Signing the flash needs the app secret, and `@shareat/core/env` refuses to start without these.
// A unit test boots without env; an integration test already has them, so `??=` changes nothing there.
// Signing itself is NOT mocked: the real `signFlash` runs.
process.env['DATABASE_URL'] ??= 'postgresql://postgres:pw@localhost:5435/shareat_dev';
process.env['SESSION_SECRET'] ??= 'x'.repeat(48);
process.env['APP_TIMEZONE'] ??= 'Asia/Manila';

beforeEach(() => {
  resetJar();
});

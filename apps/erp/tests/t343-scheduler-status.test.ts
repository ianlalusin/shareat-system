/**
 * T-343 S4 (S4b) — `docs/tasks/343-def-417-human-readable-refusals.md` §S4.
 * `apps/erp/src/components/scheduler-status.tsx:77,84-86`: `last.error`, `f.subjectName`,
 * `f.reason` must go through `containsIdentifier` (S1, already in the tree at
 * `apps/erp/src/lib/error-shape.ts`) before reaching the screen — id-bearing text becomes
 * `(detail in the server log)` / `an item from an earlier run`, never the raw UUID.
 *
 * ⛔ `.test.tsx` matches NO project glob in this repo's `vitest.config.mts` (`include` lists
 * `apps/**\/*.test.ts` only, never `.tsx`) — the same trap T-337's own grid-render test file header
 * already names. `.test.ts` + `createElement` + `renderToStaticMarkup`, same idiom.
 *
 * `SchedulerStatus` is an `async` function component — plain `react-dom/server` cannot render an
 * async component (that is Next.js's own RSC machinery, not available here), so this file calls the
 * function directly (`await SchedulerStatus(props)`, which is legal: it is just an async function
 * that happens to return JSX) to get the element, THEN renders that element with
 * `renderToStaticMarkup` — never `createElement(SchedulerStatus, props)` directly.
 *
 * ⛔ RED until the builder wires `containsIdentifier` into the three sites — today all three render
 * verbatim.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

const lastRunFor = vi.fn();
const unfinishedRuns = vi.fn();

vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return { ...actual, schedulerRepo: { lastRunFor, unfinishedRuns } };
});

vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/expenses/lib')>();
  return { ...actual, withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}) };
});

async function renderStatus(): Promise<string> {
  const { SchedulerStatus } = await import('../src/components/scheduler-status');
  const element = await SchedulerStatus({ orgId: 'org-1', job: 'fiscal_period_seed', trigger: undefined as never, label: 'Fiscal period seed' } as never);
  return renderToStaticMarkup(element as never);
}

describe('S4b — SchedulerStatus never renders a raw id from last.error / f.subjectName / f.reason', () => {
  // The FIRST dynamic import of the component below drags in its whole `@shareat/db` graph, and
  // under a full suite run that cold transform can exceed vitest's 5000ms default (same shape as
  // T-337's `t337-access-defaults-actions.test.ts` timeout) — an explicit per-test timeout, not a
  // weaker assertion.
  it('an id-bearing failure subject and reason are both redacted', async () => {
    unfinishedRuns.mockResolvedValue([]);
    lastRunFor.mockResolvedValue({
      id: 'run-1',
      job: 'fiscal_period_seed',
      period: '2026-09',
      startedAt: new Date('2026-09-01T04:00:00+08:00'),
      finishedAt: new Date('2026-09-01T04:00:05+08:00'),
      postedCount: 1,
      skippedCount: 0,
      failedCount: 1,
      failures: [{ subjectId: U, subjectName: `store ${U}`, reason: `coverage gap for org ${U}` }],
      outcome: 'partial',
      error: null,
      trigger: 'cron',
    });

    const html = await renderStatus();
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(html).toContain('an item from an earlier run');
  }, 20_000);

  it('an id-bearing top-level `error` is redacted too', async () => {
    unfinishedRuns.mockResolvedValue([]);
    lastRunFor.mockResolvedValue({
      id: 'run-2',
      job: 'fiscal_period_seed',
      period: '2026-09',
      startedAt: new Date('2026-09-01T04:00:00+08:00'),
      finishedAt: null,
      postedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failures: null,
      outcome: 'failed',
      error: `blew up on org ${U}`,
      trigger: 'cron',
    });

    const html = await renderStatus();
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(html).toContain('(detail in the server log)');
  });

  it('NEGATIVE: a mundane, id-free reason renders verbatim, unredacted', async () => {
    unfinishedRuns.mockResolvedValue([]);
    lastRunFor.mockResolvedValue({
      id: 'run-3',
      job: 'fiscal_period_seed',
      period: '2026-06',
      startedAt: new Date('2026-06-01T04:00:00+08:00'),
      finishedAt: new Date('2026-06-01T04:00:05+08:00'),
      postedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      failures: [{ subjectId: 'org-3', subjectName: 'SmokeStore', reason: 'no fiscal period covers 2026-06-30' }],
      outcome: 'partial',
      error: null,
      trigger: 'cron',
    });

    const html = await renderStatus();
    expect(html).toContain('no fiscal period covers 2026-06-30');
    expect(html).toContain('SmokeStore');
  });
});

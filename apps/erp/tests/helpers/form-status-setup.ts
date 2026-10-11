/**
 * T-387 S8: the workspace `react-dom` is 18.3.1, which has no `useFormStatus` (the App Router runs
 * Next's own bundled React 19, where it exists). Any test that renders a page containing the kit
 * `SubmitButton` would throw "useFormStatus is not a function" in node. Outside a pending action
 * the hook's answer is always "not pending", so that is what this shim returns, only when the
 * real one is missing. A test's own vi.mock still wins.
 */
import { vi } from 'vitest';

vi.mock('react-dom', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-dom')>();
  const existing = (real as Record<string, unknown>).useFormStatus;
  if (typeof existing === 'function') return real;
  return {
    ...real,
    default: real,
    useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
  };
});

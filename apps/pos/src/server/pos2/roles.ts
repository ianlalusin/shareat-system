import 'server-only';
/** T-424 - the role check apply-delta keeps from v1 (admin, manager, cashier). The role is the caller's `staff/{uid}.role`, never a body field. */
import type { Caller } from './identity';
import { fail } from './http';

export function requireRole(caller: Caller, allowed: readonly string[]): Response | null {
  return allowed.includes(caller.role) ? null : fail(403, 'You are not allowed to do this.');
}

/**
 * T-343 S5.0 — the domain-level refusal producer API.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5 Design.
 *
 * ⛔ SERVER-ONLY — imports `@shareat/db`. Never subpath-alias this file for the client; a
 * `'use client'` component that needs `humanDate`/`internalFault` imports `./refusal-leaf`
 * directly instead (code-review CHANGES item 2, 2026-09-26).
 *
 * `RefusalError` and `refuse` are DEFINED in `packages/db/src/refusal.ts` — auth cannot import
 * domain (`packages/domain/package.json`: domain depends on auth and db; auth depends on db), so a
 * class defined only here would be unreachable from `packages/auth/src/roles.ts`/
 * `credentials-admin.ts` (S5a). This file re-exports both, adds `gone` ("X does not exist" in
 * domain, `recordGone`'s exact wording via `goneSentence`), and re-exports the client-safe
 * `internalFault`/`InternalFaultError`/`humanDate` from `./refusal-leaf`.
 *
 * Production code calls `refuse`/`gone`/`internalFault`, never `new RefusalError(...)` directly
 * (R1.5).
 */
import { RefusalError, refuse, goneSentence } from '@shareat/db';

export { RefusalError, refuse };
export { InternalFaultError, internalFault, humanDate } from './refusal-leaf';

/** "X does not exist" in domain — `recordGone`'s exact wording, shared via `goneSentence`. */
export function gone(raw: string, what: string, notLonger?: string): RefusalError {
  return refuse(raw, goneSentence(what, notLonger));
}

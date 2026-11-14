# T-578 — Escape customer name and phone in the POS password-slip print (DEF-837)

**Problem.** `printPassword()` in `apps/pos/src/components/pins/customers-admin.tsx` builds an HTML string for the web print fallback and wrote `customer.name`, `customer.phone`, the temp password and the reset date into it raw, then `document.write`s it. A customer name containing a script would run under the staff member's session.

**Change.** New `escapeHtml(s: unknown)` in `apps/pos/src/lib/escape-html.ts` (escapes `& < > " '`, ampersand first). Every interpolation in that HTML template now goes through it. The Bluetooth text path is plain text and is untouched.

**Test.** `apps/pos/src/lib/escape-html.test.ts`: all five characters escaped, no double escaping, `<script>alert(1)</script>` comes out inert, null/undefined/number handled. Run: `cd apps/pos && npx vitest run --config vitest.config.mts src/lib/escape-html.test.ts`. The slip builder is inline in the component, so no separate builder test.

DEF-837 closes after merge.

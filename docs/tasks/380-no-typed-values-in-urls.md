# T-380: no typed values in page addresses (DEF-476)

**Status:** SPEC 2026-10-07 (Opus planner). Written at HEAD `c04198a`. ✎REV 2026-10-07: independent review, REV-1..13
(see "Review" at the end). Build-blocking: REV-1, REV-2, REV-3, REV-5. Apply them before S1a starts.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** none. No table, no capability, no new action. (If one turns out to be needed, stop and report: it
would be a spec defect.)
**Ruling behind it:** DEF-476 (`docs/DEFECTS-REGISTER.md:694`) and bible §13 row 260: *"amounts leave page addresses
before launch"* (`docs/plans/money-defects-2026-09-30.md:103`).

## Goal
- No amount, reason, note, name or other typed value travels in a URL after a form is submitted. Such a URL lands in
  browser history on a shared till PC, in nginx access logs on `159.223.46.224`, and in `Referer` headers.
- A refused form still comes back with what the person typed in it.
- Every `ok` and `error` banner still shows, with the same words, on the same page.
- One mechanism, in one file. No screen keeps its own copy.

## Research, evaluate, propose (bible row 283, `/research-evaluate-propose`)
- **Verdict: build it, app-wide, as a standard "flash".** This is post/redirect/get (PRG) with a one-time message
  carried in a short-lived, signed, httpOnly cookie. The URL keeps only what identifies the page (store, day, period,
  ids) plus a random one-time token.
- **Does the stated reason hold? Yes, and it goes further than the register says.** The register names prepaid
  write-off. The census found the same leak in the shared refusal path. `parseMoneyInput`'s sentence quotes the raw
  typed amount (`packages/domain/src/shared/money-input.ts:136`: `"${raw}" is not a valid …`). Every action then
  sends that sentence as `?error=`. So "fixed sentences stay in the URL, only typed values leave" cannot be checked
  from source. Whether a sentence holds a typed value depends on which domain error was thrown. **So all banner text
  leaves the URL, not just the refills.** (This departs from the briefing's "fixed sentences in the URL are fine". It
  is the only rule a source guard can enforce.)
- **What already exists here:**
  - The signed-cookie pattern: `shareat_setup` (`apps/erp/src/lib/session.ts:115-235`), HMAC'd by
    `signSetupIdentity` with a key derived for that one purpose (`packages/auth/src/credentials.ts:181-197`).
  - An AST source guard to model on: `apps/erp/tests/redirect-in-catch-sweep.ts`.
  - Next already does what this needs. A cookie set in a server action is passed on to the render of the redirect
    target in the same response: `node_modules/next/dist/server/app-render/action-handler.js:73-99` (`getForwardedHeaders`
    copies response cookies into the forwarded request's `cookie` header). See also
    `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md:81-87`. A Server Component can read a
    cookie but cannot set or delete one (`cookies.md:81`). That is why the token is needed (R3).
- **v1 (ERP-rebuild):** v1 has the same `?error=` pattern, so there is nothing to port. The goal is the same as v1's:
  tell the person what happened and keep what they typed.
- **The industry:**
  - Rails `flash` (in the session cookie), Django's messages framework (signed `CookieStorage`), Laravel session flash,
    and React Router/Remix `session.flash()` all do the same thing: the message is server state for one request, never
    a query string.
  - OWASP/CWE-598 (*use of GET request method with sensitive query strings*) names this exact leak.
  - The alternative is React 19 `useActionState`: the action returns `{error, values}` and the form re-renders with
    no redirect. It is the right tool for a NEW client form. Here it would mean rewriting about 200 server forms as
    client components. Rejected on cost.
- **Open source:** Next.js has no maintained flash library. The nearest is `sveltekit-flash-message`, which is for
  SvelteKit (https://github.com/ciscoheat/sveltekit-flash-message). `cookies-next` (https://www.npmjs.com/package/cookies-next)
  is a cookie get/set wrapper and does not do this. The pattern is about 150 lines on top of a precedent already in this
  repo. Nothing worth adopting.
- **Effort against use:**
  - About 410 redirect calls in 57 files carry banner text. 7 calls on 4 screens carry typed fields back. 84 pages read
    the keys (census below).
  - Every staff member who submits a form goes through this, so it is used thousands of times a day.
  - Effort: one helper slice, then four mechanical screen-group slices of about 80-125 calls each, then a one-file
    finishing slice.
- **Scope, and what is deliberately left out:** see "Out of scope". In short: sign-in and setup (no session yet, fixed
  policy sentences), report filter forms (the person chose to put them in the URL), and `items/` (another lane, follow-up
  N1).
- **A side benefit:** today anyone can send a link like `/ap?error=Call 0917… to verify your account`, and the ERP
  shows it as its own red banner. Once S6 lands, a banner can only come from the server.

## Census, verified at source (HEAD `c04198a`)

Method: a TypeScript-AST pass over `apps/erp/src` (excluding `app/items/`) for every `redirect(...)` and every
`back*/backTo*` wrapper, plus a grep for `sp.<key>` reads in pages. Totals:
- **57 files** redirect with a query. **About 410 calls** carry `ok`/`error`/`warning`/`notice`/`confirm`/`ran`.
- **7 calls on 4 screens** send typed form fields back as refills.
- **84 pages** read those keys, all through `const sp = await searchParams;`.
- **Local copies:** about 40 local `back()` helpers, plus `backTo*`, `withError`, `carryQs`+template redirects, and the
  positional `backToList(id, error, ok)` in wastage. That is 6 distinct shapes. No two screens share one.

### A. Typed field values sent back as refills (the register's case)
| # | Where | What travels |
|---|---|---|
| A1 | `app/prepaid/actions.ts:158-164` → `app/prepaid/[id]/page.tsx:265-288` | typed **reason** (200 chars), **refundAmount**, refundAccountCode, writtenOffOn |
| A2 | `app/fixed-assets/actions.ts:147-151` → `app/fixed-assets/[id]/page.tsx:187-211` | typed **reason**, inServiceOn, mode, plus `confirm` = the domain's sentence naming the entries it will reverse **and their amounts** |
| A3 | `app/admin/stores/actions.ts:209-216` → `app/admin/stores/[id]/page.tsx:215,230` | `confirm` (entries and amounts), `plan`, openingDate |
| A4 | `app/payroll/separations/actions.ts:49` | separationDate (employmentId is an id) |

### B. Banner sentences that hold money or typed text
- **B1. Every refusal can quote a typed amount.** See `money-input.ts:136` (above). It reaches the URL through
  `errorMessage(err)` in about 180 `error` calls.
  - Also `commissary/orders.ts:147,159` (`"${raw}" is not a quantity/rate`), `remittance/index.ts:256`, and
    `stores/service.ts:117,313` (the typed date). Admin stores echoes it again in its own `invalidDateMessage`
    (`admin/stores/actions.ts:91,199`).
- **B2. Success sentences with money:**
  - `prepaid/actions.ts:150-152` (₱ expensed, ₱ refunded; the register's example);
  - `commissary/orders/actions.ts:60` and `trade/orders/actions.ts:69` (₱ total of a draft);
  - `payroll/actions.ts:65` and `payroll/thirteenth-month/actions.ts:44` (total net pay);
  - `fixed-assets/actions.ts:216` (`ran=` run summary).
- **B3. Success sentences with typed text:**
  - `settings/expense-categories/actions.ts:97` (the new name);
  - `settings/sales-channels/actions.ts:77` (channel name);
  - `staff/actions.ts:234` (position name);
  - `settings/attendance/actions.ts:111` (date);
  - `admin/stores/actions.ts:218` (date).
- **B4. Ids in banners:** `service-charge/actions.ts:59` (entry id in a refusal); `inventory/production/actions.ts:104`
  (journal id).

### C. Redirect shapes, and two findings in passing
- **C1. Cross-folder targets: only two.**
  - `expenses/actions.ts:237,256,275,307` go to `returnTo`, which is `/ap` or `/ap/invoices/[id]`.
  - `sales-days/actions.ts:156-157` goes to `/reports/pos-reconciliation?…`.
  - Every other action goes back to its own folder. The slices below are cut on that.
- **C2. Finding: an unchecked redirect target.** `returnTo` is read from FormData and redirected to unchecked at
  `expenses/actions.ts:237-238,275-276`. Next's server-action Origin check limits the damage, but the helper must
  refuse any path that is not same-app (R6).
- **C3. Finding: a refusal that is never shown.** `/reports/pos-reconciliation` renders no banner at all
  (`reports/pos-reconciliation/page.tsx:30-40` reads only `store`/`date`). So a POS recheck refused from that page
  (`sales-days/actions.ts:157`) disappears without a word. Fixed in S4 because that page is converted anyway (R8).
- **C4. Server-side redirects that cannot set a cookie.**
  - `setup/page.tsx:59,62` is a Server Component. Together with `sign-in/actions.ts:90,139` and
    `lib/session.ts:88`, these carry `preSessionMessage` sentences and `next`.
  - These are fixed policy sentences, not typed text. Left as they are (out of scope N2).
- **C5. Tests that read the banner from the URL.** 46 test files under `apps/erp/tests` do this. The full list is in
  S1b. Several cover more than one slice's folders (e.g. `integration/t343-s5-5v-followups.test.ts` covers 9 folders).
  This is why S1b moves every test to a reader that accepts both forms before any action moves.

## Rulings (planner)
- **R1. All banner text and every refill goes in the flash. The URL keeps only navigation.**
  - **Flash keys** (closed set): `ok`, `error`, `warning`, `notice`, `confirm`, `plan`, `ran`, `failed`, `posted`,
    `needsConfirmation`.
  - **Keep (refill) keys** (closed set): `reason`, `refundAmount`, `refundAccountCode`, `writtenOffOn`, `inServiceOn`,
    `mode`, `openingDate`, `separationDate`.
  - **Navigation keys** (closed set, each with a shape the helper checks):
    - UUID, **anchored** `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`/i: `store`, `day`, `pull`,
      `supplier`, `employmentId`, `branch`, `commissary`, `changedChannel`, `pos`. ✎REV-4: NOT `UUID_SHAPE`
      (`lib/error-shape.ts:57`) — that one is `\b…\b`, unanchored, built for "contains an id", so
      `store=Call 0917… <uuid>` would pass it.
    - ISO date `^\d{4}-\d{2}-\d{2}$`: `start`, `end`, `date`, ✎REV-5 `from`, `to` (`statutory-discounts/actions.ts:44-52`
      carries both back today; without them S3 stops on the first call).
    - period `^\d{4}-?\d{2}$`: `period`.
    - `^\d{4}$`: `year`.
    - `^[a-z][a-z0-9_]{0,63}$`: `cap`.
  - A nav value that fails its shape is **dropped**. The helper logs the key name and never the value.
  - If a call site needs a key or shape not listed here, that is a spec defect. Stop and report it. Do not widen the
    list.
- **R2. One file: `apps/erp/src/lib/flash.ts`.** It exports:
  - `redirectWithFlash(path: string, nav: Nav, flash?: Flash): Promise<never>`. `Flash` is
    `{ ok?, error?, warning?, notice?, confirm?, plan?, ran?, failed?, posted?, needsConfirmation?, keep?: Partial<Record<KeepKey,string>> }`.
  - `withFlash<T>(searchParams: Promise<T>): Promise<T & FlashFields>`. It returns the URL params with the flash and
    the keep values merged in, flash first (R5).
  - `splitReturnTo(raw: string): { path: string; nav: Nav }` (R6).
  - `encodeFlash` and `decodeFlash`, exported for the test helper only.
  - Every local `back*`/`withError`/`carryQs`+template helper is **deleted**, not wrapped. Call sites call
    `redirectWithFlash` directly.
- **R3. The cookie.**
  - Name `shareat_flash`. One cookie, overwritten by every call. Flags: `httpOnly`, `sameSite: 'lax'`, `secure` in
    production only, `path: '/'`, `maxAge: 60`. These are the `shareat_setup` flags (`session.ts:171-177`).
  - Value: `base64url(JSON{v:1, n, p, exp, msg, keep}).sig`.
    - `n` is a fresh 96-bit random token, which also goes in the URL as `f=<n>`.
    - `p` is the redirect path.
    - `exp` = now + 60 s. The server enforces it, because a browser can ignore `maxAge`.
  - `withFlash` uses the flash only if all of these hold: the signature matches, `exp` has not passed, and `n` equals
    `sp.f`. ✎REV-3: the planner's "`p` equals the page's path" leg is struck. `withFlash(searchParams)` has no way to
    know the path: a Server Component gets no pathname, and `src/proxy.ts` matches `/clock` only. The 96-bit `n`
    already appears in exactly one redirect URL, so a path check adds nothing. `p` may stay in the payload for logs. Otherwise it is ignored, as if no flash existed. Absent, expired, wrong page,
    wrong token and tampered all look the same, as with `readSetupIdentity`.
  - **Why the token:** a Server Component cannot delete a cookie (`cookies.md:81`). Without the token, going back to
    the same page within 60 s would show "Written off" a second time on a money screen. With it, only the URL the
    redirect produced shows the banner. Reloading that URL within 60 s still shows it, as today.
  - ✎REV-7: the token is **not one-time**. Nothing consumes it: reload, Back or Forward to the `?f=` history entry
    within 60 s shows the banner and refill again. That is accepted; only reaching the page by a link or by typing
    the URL shows nothing.
- **R4. Signed with a key used for nothing else.** `signFlash` and `flashSignatureMatches` go in
  `packages/auth/src/credentials.ts`, using `derivedKey('flash')`. They are copied from `signSetupIdentity` and
  `setupIdentitySignatureMatches`, with the same constant-time compare.
  - Why sign: a sibling `*.shareat.net` host can set a `Domain=.shareat.net` cookie with this name. Without a
    signature, that brings back the fake-banner hole that S6 closes.
  - ⚠️ The payload can be read by anyone holding the cookie. Nothing secret goes in it. The typed reason is in the
    person's own browser for at most 60 s, and it is httpOnly.
- **R5. Pages change one line.**
  - `const sp = await searchParams;` becomes `const sp = await withFlash(searchParams);`. Every existing
    `sp.error`, `sp.ok`, `sp.reason`, `sp.refundAmount`… read stays exactly as it is.
  - S1–S5: if a key exists in both the flash and the URL, the flash wins, and URL banner keys still work. That makes
    every slice order safe.
  - S6 stops honouring flash and keep keys that arrive in the URL (R9).
- **R6. Path safety.** `redirectWithFlash` refuses (throws, in every environment) a `path` that:
  - does not start with exactly one `/`;
  - contains `?`, `#` or `\`;
  - starts with `//`.

  `splitReturnTo` parses a form's `returnTo`. It keeps the pathname only if it is a same-app path, and keeps only nav
  keys that fit their shapes. Otherwise it returns the caller's fallback. This fixes C2.
  - ✎REV-9: model the path test on the existing `safeNext` (`app/sign-in/lib.ts:68-69`, `/^\/(?![/\\])/`) so there is
    one definition of "same-app". C2 also covers `expenses/actions.ts:256,307` (`parsed.returnTo`, read unchecked at
    `:129`), not only `:237,275`. And `ap/actions.ts:399-403` builds a path from an id checked with the unanchored
    `UUID_SHAPE`: an id holding `?` would make R6 throw (a digest page, not a banner). S4 anchors that check.
- **R7. Every call is awaited.** `cookies()` is async, so the helper is async. A call that is not awaited lets the
  action carry on running: a refused write-off would then fall through to the success redirect, and a guard clause
  would fall through to the posting call.
  - ✎REV-1: every call site is **`return await redirectWithFlash(…)`**. A bare `await redirectWithFlash(…);` statement is
    not allowed. G1b enforces the `return await` form.
  - ✎REV-1: the planner's "`Promise<never>` keeps TypeScript's narrowing after `await`" is **false**. Checked with
    the repo's tsc 5.9.3 under `--strict`: `if (x === null) { await rwf('/a'); } return x.length;` gives TS18047
    ('x' is possibly 'null'), and `return await rwf('/a')` compiles clean. The 49 local helpers are typed `: never`
    today, and code relies on that narrowing (e.g. `prepaid/actions.ts`'s `summary`, the `result!` guards). A bare
    `await` therefore leaves the builder facing type errors, and the easy fixes for them (`!`, `= ''`) hide the
    fall-through that R7 is meant to stop.
- **R8. Size.** Banner texts are capped at 600 characters each. ✎REV-6: but **`confirm` and `plan` are never
  truncated**. `confirm` is the consent text: it names every affected asset and entry (`admin/stores/[id]/page.tsx:199`).
  `plan` is a token that is sent back byte for byte. In S2, the tester measures the longest `confirm` the
  domain can produce for the largest real store. If `confirm` + `plan` can go over the 3,000-byte budget once `keep`
  is dropped, that is a spec defect: stop and report it. Do not truncate, and do not let the browser silently drop a
  cookie over 4 KB. (A dropped cookie means no banner at all, so the confirm step would vanish without a word.)
  - If the encoded value is over 3,000 bytes, `keep` is dropped **whole** and a warning is logged. The form then comes
    back blank, which is the behaviour before T-343.
  - A keep value is never truncated or reformatted. If a refilled amount changed, a resubmit would post a different
    figure.
  - C3: `/reports/pos-reconciliation` gains the same `sp.error` banner markup its sibling report pages use.
- **R9. S6 closes the URL door.** `withFlash` deletes every flash key and keep key from the URL-side params before it
  merges, so a crafted `?error=` shows nothing. This is safe only once every in-scope caller is migrated, which is what
  S6 checks.
- **R10. Money does not move.** No slice edits a domain call, an argument to one, or a value parsed from FormData for
  the domain. Only redirect lines, imports, and the deleted local helpers change.

## Parallel plan
| Slice | Files (BUILDER) | Tester files | Shared state | Order / parallel-safe with |
|---|---|---|---|---|
| S1a | `apps/erp/src/lib/flash.ts` (new), `packages/auth/src/credentials.ts`, `packages/auth/src/index.ts`, `apps/erp/src/lib/session.ts` (`clearSessionCookie` also deletes `shareat_flash`) | `apps/erp/tests/flash.test.ts` (new), `packages/auth/tests/flash-signature.test.ts` (new), `apps/erp/tests/no-typed-values-in-urls.ts` + `.test.ts` (new), `apps/erp/tests/helpers/flash-jar.ts` (new), `apps/erp/tests/redirect-in-catch-sweep.ts` + `.test.ts`, ✎REV-2 `vitest.config.mts` (`setupFiles` jar only) | none (unit) | first |
| S1b | none (tester only) | the S1b files, re-grepped at S1b's HEAD (✎REV-2) | none | after S1a; before S2–S5 |
| S2 | prepaid, fixed-assets, admin/{stores,users,access-defaults}, payroll/{.,separations,thirteenth-month}, cutover, findings: listed in S2 | `t380-s2-*.test.ts` (new) | lane DB | after S1b; ∥ S3, S5 |
| S3 | loans, liabilities, owners, cash-requests, money-accounts, money-transfers, remittance, till, service-charge, budgets, channel-settlements, customers, statutory-discounts | `t380-s3-*.test.ts` (new) | lane DB | after S1b; ∥ S2, S5 |
| S4 | ap, expenses/*, sales-days + `reports/pos-reconciliation/page.tsx`, settings/*, commissary/*, trade/* | `t380-s4-*.test.ts` (new) | lane DB | after S1b **and after T-379 S1–S3 land** |
| S5 | inventory/*, attendance/*, staff/*, wastage | `t380-s5-*.test.ts` (new) | lane DB | after S1b; ∥ S2, S3 |
| S6 | `apps/erp/src/lib/flash.ts` (strip, R9) | `no-typed-values-in-urls.test.ts` (PENDING → items only), `helpers/flash-jar.ts` (drop URL fallback), `t380-s6-strip.test.ts` (new) | none | last |

No two of S2–S5 share a source file, a page or a test file. Neither touches `packages/domain/src/pos/`, `scripts/`,
`packages/db/migrations`, `apps/erp/src/app/items/`, `POSTING-PATTERNS.md`, `classification.ts` or the RLS registry.

**Overlaps with other lanes (say these in the briefing):**
- **T-379** (`docs/tasks/379-erp-small-follow-ups.md:181-183`) edits `commissary/discrepancies/actions.ts`,
  `trade/returns/actions.ts` + `page.tsx`, `ap/actions.ts`, `ap/page.tsx` and `ap/invoices/[id]/page.tsx`. All of
  these are in S4, so **S4 starts only after T-379 S1–S3 are committed.**
  - T-379 itself should still use `?error=`/`?ok=`. S4 migrates those lines afterwards, and S1b's dual reader keeps
    T-379's tests green.
  - If T-379 adds test files that read the banner from the URL, S4's tester moves them to `outcomeOf` (S1b).
- **T-375 (POS lane)** has uncommitted work under `packages/domain/src/pos/` and `scripts/`, which this task does not
  touch. Its later slices may edit `sales-days/*`, `inventory/pos-usage/*`, `settings/pos-link/*` or
  `reports/pos-reconciliation/page.tsx`. The orchestrator must not run S4/S5 at the same time as a T-375 slice on
  those files.

## Invariants
- I1. No migration, no new table, no new capability, no new action. `authorize()` order is unchanged everywhere.
- I2. **No amount posted changes (R10).**
  - The auditor checks each slice's `git diff -U0 -- 'apps/erp/src/app/**/actions.ts'`. Every changed line must be:
    an import, a `redirectWithFlash` call, a deleted local helper, or a `let`/flash variable feeding one.
  - Any change to a domain call's arguments, or to a FormData read that feeds one, fails the slice.
  - Proven by test in M1–M4 below.
- I3. Banner wording does not change. The same sentence reaches the same page.
- I4. After S6, the URL of a page reached through `redirectWithFlash` holds only nav keys (R1), GET-filter keys the
  page already had, and `f`.
- I5. Flash contents are never logged.

---

## S1a: the helper, the signature, the guards
**BUILDER:**
- `apps/erp/src/lib/flash.ts`: R1–R8 exactly.
  - Writing: `(await cookies()).set('shareat_flash', …)` and then `redirect(\`${path}?${nav}&f=${n}\`)`. The
    `next/navigation` `redirect` is called **only** here. If there are no nav keys, it is `?f=<n>`. If there is no flash
    at all, the cookie is not set and `f` is omitted.
  - Reading: `withFlash` reads the cookie with `cookies()`. It never sets or deletes it.
  - Header comment: why a cookie and not the URL (DEF-476, CWE-598), why the token (R3), why it is signed (R4), why it
    is awaited (R7).
- `packages/auth/src/credentials.ts` + `index.ts`: `signFlash`, `flashSignatureMatches` (R4).
- `apps/erp/src/lib/session.ts`: `clearSessionCookie` also deletes `shareat_flash`. At sign-out, the next person on a
  shared PC inherits nothing.

**TESTER:**
- `packages/auth/tests/flash-signature.test.ts`: round-trip; one byte changed → false; the setup-identity signature
  over the same bytes ≠ the flash signature.
- `apps/erp/tests/flash.test.ts`: `next/navigation` and `next/headers` mocked; uses `helpers/flash-jar.ts`.
- `apps/erp/tests/helpers/flash-jar.ts`:
  - an in-memory jar for `vi.mock('next/headers')`;
  - a `RedirectSignal` capture;
  - `outcomeOf(signal, jar): { path, nav: URLSearchParams, flash: FlashFields }`. During S1–S5, `flash` falls back to
    the URL's own `ok`/`error`/…/keep keys when the cookie has none (dual read). S6 removes the fallback.
- `apps/erp/tests/no-typed-values-in-urls.ts` (analyzer) + `.test.ts`, TypeScript AST like
  `redirect-in-catch-sweep.ts`:
  - **G1a.** In `apps/erp/src`, `redirect` from `next/navigation` may only be called with a string literal, or a
    template whose literal parts contain no `?`/`&`. Exceptions: `lib/flash.ts`, PRE_SESSION
    (`app/sign-in/actions.ts`, `app/setup/actions.ts`, `app/setup/page.tsx`, `lib/session.ts`), and PENDING.
  - **G1b.** Every `redirectWithFlash(` call is the operand of an `await` that is itself the expression of a `return`
    (✎REV-1).
    - ✎REV-10: the call is found through its import binding (`import { redirectWithFlash as x }` counts as `x(`).
    - It may appear only lexically inside a top-level exported action. It may not appear in a local function,
      arrow or wrapper, because `fail()` without `await` would get past a check that looks only for
      `redirectWithFlash(`.
    - No file but `lib/flash.ts` may re-export it.
    - The current `redirect-in-catch-sweep.ts:56` `importedRedirectName` returns early, making the sweep a no-op, for
      a file with no `next/navigation` import. After conversion that is every action file, so the sweep must treat
      the `@/lib/flash` import as a second root.
  - **G2.** Every `page.tsx` that reads `sp.<flash or keep key>` gets `sp` from `withFlash(`. Exceptions: PRE_SESSION
    and PENDING pages.
  - The analyzer exports `findingsForFile(path)` so each slice can assert its own files are clean.
  - PENDING = every in-scope action file and page in this census, plus `app/items/**`. S2–S5 do **not** edit this list;
    their own `t380-sN-guard.test.ts` asserts their files are clean. S6 cuts PENDING down to `app/items/**`.
  - **G3.** Stale-entry check, active from S6: a PENDING file with zero findings is red. When the items lane converts,
    the guard makes it remove its entry.
- `apps/erp/tests/redirect-in-catch-sweep.ts` + `.test.ts`: `redirectWithFlash` (imported) counts as a
  redirect-reaching call. Add a fixture: `try { await redirectWithFlash(…) } catch {}` → flagged.

**Tests (S1a):**
- **F1.** `redirectWithFlash('/prepaid/X', {}, { error: 'e', keep: { reason: 'r', refundAmount: '1,000.50' } })`:
  - the redirect URL is `/prepaid/X?f=<n>` and contains neither `r` nor `1,000.50`;
  - the jar holds a cookie that `decodeFlash` turns back into exactly those values.
  - Mutant: put `keep` into the query → F1 red.
- **F2.** `withFlash` with the right `f` and time → `sp.error === 'e'`, `sp.refundAmount === '1,000.50'`, byte for
  byte. Four more legs, each returns no flash: wrong `f`; `exp` passed; tampered payload; unsigned cookie. (✎REV-3:
  the wrong-path leg is struck.) ✎REV-11: one more leg — a cookie signed with `derivedKey('setup-identity')` → no
  flash.
  - Mutants, each turning its leg red: skip the token check; skip `exp`; skip the signature.
- **F3.** Nav shapes: `{ store: 'Refund for broken freezer' }` → the URL has no `store`, and the warning log names
  `store` but not the value. `{ store: <uuid>, period: '2026-09' }` → both kept. ✎REV-4: `{ store: 'x ' + <uuid> }` →
  dropped (mutant: use `UUID_SHAPE` → red).
  - Mutants: drop the shape check → F3 red. Log the value → F3 red (a log spy).
- **F4.** Size: a 5,000-char keep → the flash keeps `error` and drops `keep` whole; no keep value is shortened.
  - Mutant: truncate each value → F4 red.
- **F5.** Path: `'https://x.y'`, `'//x'`, `'/a?b=1'` → throws. `splitReturnTo('/reports/pos-reconciliation?store=<uuid>&date=2026-10-01&x=hi')`
  → that path, `{store, date}`.
  - Mutant: accept `//` → F5 red.
- **G-self.** The analyzer on fixtures (in `.test.ts`, as inline source strings):
  - a local `back()` with `URLSearchParams` → G1a finding;
  - an unawaited `redirectWithFlash` → G1b finding;
  - a page reading `sp.error` from bare `searchParams` → G2 finding;
  - the converted forms → clean.
  - **The guard's named mutant:** re-add `function back(p, q) { redirect(\`${p}?${new URLSearchParams(q)}\`) }` with
    `back(path, { error, reason })` in a non-PENDING fixture → red. Remove `await` from one call → red.
- **G-tree.** On the real tree at S1a: zero G1/G2 findings outside PENDING. It is green because PENDING is the whole
  census.
- **G-sweep.** The new `redirect-in-catch-sweep` fixture is flagged. Mutant: drop the new name from the sweep → red.

**Smoke:** none in S1a (no screen uses the helper yet).

---

## S1b: every banner test reads through `outcomeOf` (tester only)
Change each file below so that it:
- mocks `next/headers` with `helpers/flash-jar.ts`'s jar;
- reads banners and refills through `outcomeOf(signal, jar).flash.<key>`;
- reads nav through `.nav`.

No assertion's expected value changes. Every file must be green on HEAD before S2 starts. Because the reader accepts
both forms, the files stay green while S2–S5 move their actions.

Files (46):
- **integration/:** `t343-s5-5n-followups`, `t343-s5-5p-followups`, `t343-s5-5q-followups`, `t343-s5-5s-followups`,
  `t343-s5-5t-followups`, `t343-s5-5v-followups`, `t343-s5-5w-followups`, `t350-channel-payout-change`,
  `t350-s5-banner-roundtrip`, `t351-review-followups`, `t352-attendance-auth-before-parse`,
  `t358-ap-invoice-expense-form`, `t360-attendance-shiftday-web`, `t361-cod-credit-web-parity`,
  `t362-supplier-terms-web`, `t364-adjustment-reach-web`, `t364-expense-form-authorise-first`,
  `t365-supplier-bank-audit-web`, `t369-s1-reimbursement-web`, `t369-s3-sales-day-web`, `t369-s9-settle-action`,
  `t371-direct-repo-writes`, `t371-lowstock-error-banner`, `t374-s6-branch-recount-list`,
  `t374-s7-pos-usage-void-action`, `t375-s1-pos-link-action`, `t375-s3-import-web`, `t375-s5-pos-usage-page`,
  `t375-s6-day-corrections-web`, `t375-s6-reconciliation-web`.
- **unit, `apps/erp/tests/`:** `t337-access-defaults-actions`, `t343-s1-action-guard`,
  `t343-s5-1c-commissary-refusals`, `t343-s5-1d-wrapper-refusals`, `t343-s5-5m-remittance-rewrap`,
  `t343-s5-action-guard`, `t343-s5-outcome-message`, `t343-s6b-admin-users-labels`, `t343-s7-admin-refusals`,
  `t343-s7-wrapper-refusals`, `t349-hold-own-right-page`, `t349-s2c-fold-and-banner`,
  `t350-channel-payout-change-render`, `t369-s4f-void-actions`, `t376-s2-return-banners`.
- ✎REV-2: **the list above is 45 files, not 46. It also misses every test that RENDERS an in-scope page.**
  - Once a page calls `withFlash`, it calls the real `cookies()`, and outside a request scope that throws. About 27
    page-render test files mock `page-access`/`session` and not `next/headers`. Examples:
    `t343-s5-5r-prepaid-refund-render`, `t343-s6c-screen-labels` (pages from several slices plus items),
    `t343-s6d-wastage-detail-label`, `integration/t350-s2-render`, `t369-s0-void-payment-web`, `t369-s5-override-web`,
    `t375-s4-day-page`, `t376-s1-action-forward-web`, `t376-s1-verify-override-web`, `t378-s4-unit-form-gate`. Each
    of these turns red the moment its page converts. None is in any slice's TESTER list, and several span slices.
  - Some feed banner or refill keys through `searchParams` and go red at S6 (X2): `t343-s5-5r-prepaid-refund-render`
    (`postRefusalParams`, :131,175), `integration/t350-s4-banner` (:139), and `t369-s0-void-payment-web` (:184).
  - T-379 adds two more URL readers: `integration/t379-s1-discrepancy-action-web`, `t379-s2-customer-return-banners`.
  - **Fix (S1a):** add one `next/headers` jar mock (from `helpers/flash-jar.ts`) to the `unit` and `integration`
    projects' `setupFiles` in `vitest.config.mts`, so a test without its own `vi.mock('next/headers')` gets an empty
    jar. `vitest.config.mts` joins S1a's TESTER files.
  - **Fix (S1b):** the render tests that pass banner or refill keys in `searchParams` move to "jar + `f`". S1b's
    tester greps again at its own HEAD (pattern: `searchParams: Promise.resolve(` with any flash or keep key, plus
    `get('<flash or keep key>')`) and lists the real set in its report.
- **Not converted:** `setup-failure-redirect.test.ts`. It covers a PRE_SESSION path, which keeps its URL (N2).
- ⚠️ `t343-s7-wrapper-refusals` also exercises `items/`. Its items legs stay on the URL until N1.

**Test (S1b):** the full unit suite, plus the integration files above on a fresh gate DB, all green. There is no new
behaviour, so this slice has no mutant. Its proof comes in S2–S5: those files stay green after their actions move.

---

## S2: prepaid, fixed assets, admin, payroll, cutover, findings (about 83 calls; A1–A4, B2/B3 cases)
**BUILDER:**
- **Actions:**
  - `app/prepaid/actions.ts`, `app/fixed-assets/actions.ts`, `app/admin/stores/actions.ts`,
    `app/admin/users/actions.ts`, `app/admin/access-defaults/actions.ts`;
  - `app/payroll/actions.ts`, `app/payroll/separations/actions.ts`, `app/payroll/thirteenth-month/actions.ts`;
  - `app/cutover/actions.ts`, `app/findings/actions.ts`.
- **Pages:**
  - `app/prepaid/page.tsx`, `app/prepaid/[id]/page.tsx`;
  - `app/fixed-assets/page.tsx`, `app/fixed-assets/new/page.tsx`, `app/fixed-assets/[id]/page.tsx`;
  - `app/admin/stores/page.tsx`, `app/admin/stores/[id]/page.tsx`, `app/admin/users/[personId]/page.tsx`,
    `app/admin/access-defaults/page.tsx`;
  - `app/payroll/page.tsx`, `app/payroll/separations/page.tsx`, `app/payroll/thirteenth-month/page.tsx`;
  - `app/cutover/page.tsx`, `app/cutover/opening/page.tsx`, `app/cutover/count/page.tsx`, `app/findings/page.tsx`.
- **Rules per call:**
  - banner text goes in `flash`;
  - A1–A4 fields go in `flash.keep`;
  - `confirm`/`plan` go in `flash`;
  - `ran`/`failed`/`posted` go in `flash`;
  - ids and periods go in `nav`.
  - The `ok` codes (`terms`, `inservice`, `disposed`) go through `flash.ok` unchanged.
  - Each page changes one line (R5).

**TESTER:** `apps/erp/tests/integration/t380-s2-money-and-refill.test.ts` (new, lane DB),
`apps/erp/tests/t380-s2-guard.test.ts` (new).

**Tests:**
- **M1 (I2, money).** Prepaid item, ₱12,000 over 12 months, 3 months released. `writeOffAction` with
  refundAmount `'1,000.50'` and refundAccountCode = a cash account. Then:
  - the journal lines are exactly: expense = remaining − 100050 centavos, refund 100050, balanced (read from the DB);
  - the redirect URL is `/prepaid/<id>?f=…`, with no `₱`, `1,000`, `100050` or reason text;
  - `outcomeOf().flash.ok` is the same sentence as before (`Written off. ₱… recognised as expense, ₱1,000.50 refunded…`).
- **M2 (refill byte-exact, R8).** The same item, `refundAccountCode` = an account the domain refuses.
  - Zero journal entries are written.
  - The URL holds no keep value.
  - Rendering `/prepaid/<id>` with the jar and that `f` gives `value="1,000.50"` in the refund box and the reason
    exactly as typed.
  - Mutants: keep encoding through `Number()` → M2 red; drop `await` on the catch-path call → M2 red (the success
    redirect or `ok` wins), and G1b red.
- **M3 (A2).** Fixed asset in-service with a typed reason that needs confirmation. The URL holds neither the reason
  nor the `confirm` amounts. The page renders the confirm sentence, the hidden `confirmedPlan` and the reason. A
  resubmit with that plan posts the same entries as a direct domain call with the same plan (compare the
  `journal_lines` amounts).
- **M4 (A3/B1).** `admin/stores/[id]` opening date `'2026-13-40'` → refused; the URL holds no `2026-13-40`; the page
  re-renders the box with it.
  - ✎REV-8 **M4b.** The same refusal, with the store's opening date read from the DB before and after: unchanged.
    Mutant: drop the `await` on the `:199` call → the date is written (or the domain throws), and M4b and G1b go red.
- **W-S2.** Payroll post (B2): the URL has no net total, and the `ok` sentence is unchanged.
- **G-S2.** `findingsForFile` is empty for every BUILDER file of S2. Mutant: leave one local `back()` in
  `findings/actions.ts` → red.

- ✎S2-R1 (orchestrator, 2026-10-07): the plan hash pins the consent; the confirm text is its human summary. A store-wide confirm
  names at most 10 assets (stable order: name, then first entry id), then `and N more asset(s). In all: <entries>
  depreciation entries, <total>`, counted over the same entries the plan hash covers (`describeStoreReversal`,
  `fixed-assets/in-service.ts`). `plan` rides byte for byte; if `keep` still overflows it is dropped whole and the page
  says the typed values must be entered again.

**Smoke (9008):**
1. Prepaid: a refused write-off with a typed reason and refund. The address bar shows only `?f=…`, and the boxes are
   refilled.
2. A successful write-off: the banner shows ₱, and the address bar does not.
3. ✎REV-7: go back to the list, then open the item **from its link** after 5 s: no "Written off" banner (R3). (The
   browser's Forward button returns to the `?f=` entry, which within 60 s still shows the banner. That is expected.)
4. Fixed-asset confirm step; store opening-date confirm.

Screenshots of each at 375 px.

---

## S3: cash, ledgers, customers (about 110 calls)
**BUILDER:**
- **Actions:**
  - `app/loans/actions.ts`, `app/liabilities/actions.ts`, `app/owners/actions.ts`, `app/cash-requests/actions.ts`;
  - `app/money-accounts/actions.ts`, `app/money-transfers/actions.ts`, `app/remittance/actions.ts`,
    `app/till/actions.ts`;
  - `app/service-charge/actions.ts`, `app/budgets/actions.ts`, `app/channel-settlements/actions.ts`,
    `app/customers/actions.ts`, `app/statutory-discounts/actions.ts`.
- **Pages:**
  - `app/loans/page.tsx`, `app/loans/[id]/page.tsx`, `app/liabilities/page.tsx`, `app/liabilities/[id]/page.tsx`;
  - `app/owners/page.tsx`, `app/owners/[id]/page.tsx`, `app/cash-requests/page.tsx`, `app/cash-requests/[id]/page.tsx`;
  - `app/money-accounts/page.tsx`, `app/money-transfers/page.tsx`, `app/remittance/page.tsx`, `app/till/page.tsx`;
  - `app/service-charge/page.tsx`, `app/budgets/page.tsx`, `app/channel-settlements/page.tsx`;
  - `app/customers/page.tsx`, `app/customers/[customerId]/page.tsx`, `app/customers/price-lists/page.tsx`,
    `app/customers/price-lists/[id]/page.tsx`, `app/statutory-discounts/page.tsx`.
- `channel-settlements`: `ok: 'destination'` goes in `flash`, and `changedChannel` goes in `nav`.

**TESTER:** `apps/erp/tests/integration/t380-s3-money.test.ts` (new), `apps/erp/tests/t380-s3-guard.test.ts` (new).

**Tests:**
- **M5 (I2).** A money transfer of `'1,234.56'` between two accounts:
  - journal lines 123456 / −123456;
  - the URL has no amount.
- **M6 (B1).** A money transfer of `'1,0OO'`:
  - refused, no journal entry;
  - `flash.error` quotes `"1,0OO"`, and the URL does not.
  - Mutant: `money-transfers` keeps a template `?error=` → G-S3 and M6 red.
- **G-S3** as G-S2.

**Smoke (9008):** a refused and an accepted transfer, and a refused remittance. Check the address bar on each.

---

## S4: AP, expenses, sales days, settings, commissary, trade (about 125 calls). After T-379 S1–S3.
**BUILDER:**
- **Actions:**
  - `app/ap/actions.ts`;
  - `app/expenses/actions.ts`, `app/expenses/recurring/actions.ts`, `app/expenses/reimbursements/actions.ts`;
  - `app/sales-days/actions.ts`;
  - `app/settings/attendance/actions.ts`, `app/settings/expense-categories/actions.ts`,
    `app/settings/organization/actions.ts`, `app/settings/pos-link/actions.ts`,
    `app/settings/sales-channels/actions.ts`, `app/settings/wastage-monitor/actions.ts`;
  - `app/commissary/catalogue/actions.ts`, `app/commissary/orders/actions.ts`,
    `app/commissary/orders/[id]/actions.ts`, `app/commissary/discrepancies/actions.ts`;
  - `app/trade/orders/actions.ts`, `app/trade/returns/actions.ts`.
- **Pages:**
  - `app/ap/page.tsx`, `app/ap/invoices/[id]/page.tsx`, `app/ap/suppliers/page.tsx`, `app/ap/suppliers/[id]/page.tsx`;
  - `app/expenses/[id]/page.tsx`, `app/expenses/new/page.tsx`, `app/expenses/recurring/page.tsx`,
    `app/expenses/reimbursements/page.tsx`;
  - `app/sales-days/new/page.tsx`, `app/sales-days/[id]/page.tsx`, `app/sales-days/[id]/edit/page.tsx`,
    `app/reports/pos-reconciliation/page.tsx`;
  - `app/settings/attendance/page.tsx`, `app/settings/expense-categories/page.tsx`,
    `app/settings/organization/page.tsx`, `app/settings/pos-link/page.tsx`, `app/settings/sales-channels/page.tsx`,
    `app/settings/wastage-monitor/page.tsx`;
  - `app/commissary/catalogue/page.tsx`, `app/commissary/discrepancies/page.tsx`, `app/commissary/orders/page.tsx`,
    `app/commissary/orders/[id]/page.tsx`;
  - `app/trade/orders/page.tsx`, `app/trade/orders/[id]/page.tsx`, `app/trade/returns/page.tsx`.
- **Special cases:**
  - `expenses` `returnTo` and `sales-days` `returnTo` go through `splitReturnTo` (R6, C1, C2).
  - `reports/pos-reconciliation/page.tsx` gains the `error`/`ok` banner (R8, C3).
  - ✎REV-8: the same `if (!result.ok) back…` guard shape is at `trade/returns/actions.ts:63,85,112` and
    `commissary/discrepancies/actions.ts:67,95`. Each becomes `return await redirectWithFlash(…)`.
  - ✎REV-9: `ap/actions.ts:399-403` anchors its id checks (REV-4 regex), and `expenses/actions.ts:256,307` go through
    `splitReturnTo` too.

**TESTER:** `apps/erp/tests/integration/t380-s4-money.test.ts` (new), `apps/erp/tests/t380-s4-guard.test.ts` (new).

**Tests:**
- **M7 (I2).** Record-and-post an expense against a verified AP invoice from `/ap/invoices/[id]` with an amount of
  `'2,500.00'`:
  - the journal lines equal the amounts a direct domain call posts;
  - the redirect lands on `/ap/invoices/<id>?…f=…` with no amount.
- **M8 (C2).** `returnTo = 'https://evil.example'` → the redirect goes to the fallback (`/expenses/new` or `/ap`), never
  off-site. Mutant: pass `returnTo` through unchecked → M8 red.
- **W-C3.** A refused POS recheck submitted from `/reports/pos-reconciliation?store&date` → that page renders the
  refusal sentence. Red on HEAD: no banner. Mutant: drop the new banner markup → red.
- **W-B3.** Rename an expense category to `'Pa-load ni Boss'` → the URL does not hold the name, and the banner does.
- **G-S4** as G-S2.

**Smoke (9008):**
- an AP invoice expense: refused, then posted;
- a commissary draft (₱ total banner);
- a POS recheck refusal on the reconciliation page.

---

## S5: inventory, attendance, staff, wastage (about 125 calls)
**BUILDER:**
- **Actions:**
  - `app/inventory/counts/actions.ts`, `app/inventory/deliveries/actions.ts`, `app/inventory/locations/actions.ts`;
  - `app/inventory/low-stock/actions.ts`, `app/inventory/pos-map/actions.ts`, `app/inventory/pos-usage/actions.ts`;
  - `app/inventory/production/actions.ts`, `app/inventory/returns/actions.ts`, `app/inventory/usage/actions.ts`;
  - `app/attendance/lane/actions.ts`, `app/attendance/terminals/actions.ts`, `app/attendance/[dayId]/actions.ts`;
  - `app/staff/actions.ts`, `app/staff/[employmentId]/credentials/actions.ts`, `app/wastage/actions.ts`.
- **Pages:**
  - `app/inventory/counts/page.tsx`, `app/inventory/counts/[id]/page.tsx`, `app/inventory/deliveries/page.tsx`,
    `app/inventory/deliveries/[id]/page.tsx`;
  - `app/inventory/locations/page.tsx`, `app/inventory/low-stock/page.tsx`, `app/inventory/pos-map/page.tsx`,
    `app/inventory/pos-usage/page.tsx`;
  - `app/inventory/production/page.tsx`, `app/inventory/production/[id]/page.tsx`, `app/inventory/returns/page.tsx`,
    `app/inventory/usage/page.tsx`, `app/inventory/usage/[id]/page.tsx`;
  - `app/attendance/[dayId]/page.tsx`, `app/attendance/lane/page.tsx`, `app/attendance/terminals/page.tsx`;
  - `app/staff/page.tsx`, `app/staff/hire/page.tsx`, `app/staff/[employmentId]/page.tsx`,
    `app/staff/[employmentId]/credentials/page.tsx`;
  - `app/wastage/page.tsx`, `app/wastage/[id]/page.tsx`.
- **Shapes to watch:**
  - wastage's positional `backToList(id, error, ok)` and the `if (!result.ok) back…` guard clauses
    (`wastage/actions.ts:131,162,189,209`, `inventory/production/actions.ts:80,98,123,141`,
    `inventory/returns/actions.ts:59,81,110`) each become `return await redirectWithFlash(…)`;
  - `pos-usage`'s `day`/`pull` go in `nav`.

**TESTER:** `apps/erp/tests/integration/t380-s5-guard-clauses.test.ts` (new), `apps/erp/tests/t380-s5-guard.test.ts`
(new).

**Tests:**
- **M9 (I2, R7).** `inventory/returns` refund with a typed amount, on a return whose domain call refuses
  (`result.ok === false`, `:110`):
  - no journal entry and no stock movement;
  - `flash.error` is set, and the URL has no amount.
  - Mutant: drop the `await` on the `:110` guard-clause call → the success redirect wins, and M9 + G1b red.
  - ✎REV-8: M9 proves R7, **not** I2. At `:110` the domain has already refused, so "no journal entry" holds whether or
    not the mutant is applied. The leg that proves money cannot move is a guard **before** a write. That leg is
    M4b in S2: `admin/stores/actions.ts:198-200`, an invalid opening date, then `setStoreOpeningDate`. Without the
    `await`, the action falls through to the write; assert the store's opening date is unchanged.
- **W-S5.** Staff "add position" with a typed name → the name is not in the URL.
- **G-S5** as G-S2.

- ✎S5-N1 (S5 audit, 2026-10-08): `wastage/actions.ts`: a malformed hidden `id` makes `isSameAppPath` throw inside the `try` and again in the `catch`, so the person gets a 500 instead of a banner (tampered input only; pre-existing, not a T-380 regression).

**Smoke (9008):** a refused and an accepted wastage record; a refused count line; a pos-usage finalize refusal.

---

## S6: close the URL door (R9)
**BUILDER:** `apps/erp/src/lib/flash.ts` (`withFlash` strips flash and keep keys from the URL-side params).
**TESTER:**
- `no-typed-values-in-urls.test.ts`: PENDING = `app/items/**` only, and G3 is on.
- `helpers/flash-jar.ts`: drop the URL fallback from `outcomeOf`.
- `apps/erp/tests/integration/t380-s6-strip.test.ts` (new).

**Tests:**
- **X1.** Render `/ap?error=Call%200917…` with no cookie → no banner text in the HTML. Red before S6. Mutant: no strip
  → red.
- **X2.** With the S1b fallback removed, all 46 S1b files and every `t380-*` file are green. This proves every
  in-scope banner now travels in the flash.
- **X3.** `/prepaid/<id>?reason=hi` with no cookie → the reason box is empty.

**Smoke:** a crafted `?error=` link on `/ap` and `/prepaid/<id>` shows nothing. One normal refusal per S2–S5 area
still shows its banner.

---

## Out of scope
- **N1. `apps/erp/src/app/items/`** (another lane): `items/actions.ts:68-73` + two pages, 19 calls. PENDING names it,
  and G3 makes its owner remove the entry when it converts. The orchestrator files the follow-up. **DEF-476 is not
  fully closed until then.**
- **N2. Pre-session redirects** (`sign-in/actions.ts:90,139`, `setup/actions.ts:59`, `setup/page.tsx:59,62`,
  `lib/session.ts:88`) keep `?error=`/`?next=`.
  - They carry only `preSessionMessage` policy sentences and a return path. No typed value is echoed: T-235/DEF-222
    already filtered them.
  - `setup/page.tsx` is a Server Component and cannot set a cookie.
- **N3. GET filter forms** (`from`, `to`, `store`, `status`, `q`, `groupBy`… on reports and lists). The person puts
  these in the URL on purpose so the view can be bookmarked and shared. They are not a refusal and not a submission.
- **N4. Domain sentences that quote the raw input** (B1). They are correct to quote it *to the person*. Once off the
  URL they are harmless, so they are left as they are.
- **N5.** C2's open-redirect risk is fixed by R6. Logging it in the register (section E) is for the orchestrator.
- The register, the bible and the ROADMAP: the orchestrator does these at wrap-up.

## Done when
- S1a–S6 are green. Each red is shown red on HEAD or against its named mutant before the build.
- Typecheck is clean and the unit suite passes. The FULL integration suite passes on a fresh gate DB before any push.
  `npm run build` passes with the dev server stopped. Touched files are LF.
- Each slice's smoke is done on 9008, with screenshots that show the address bar.
- Each builder touched only its BUILDER paths, and each tester only its TESTER paths.
- The orchestrator, at wrap-up:
  - marks DEF-476 **fixed except `items/` (N1)** with the hashes;
  - files N1, and logs C2 and C3 in section E.

## Questions only Ian can answer
None.
- The rule he set is "amounts leave page addresses". This does that, and also takes typed text out.
- One thing staff may notice: a banner no longer comes back on a reload more than a minute later, or on a copied link.
  This is the standard behaviour and needs no ruling. The orchestrator mentions it in the FOR IAN block.

## Review (✎REV, independent Opus pass, 2026-10-07, at HEAD `cdac71f`)
- **Checked and holds:**
  - The census: 55 action files and 84 pages by my own grep. Every non-items file that redirects or reads a banner key
    is named in a slice. Every page uses `const sp = await searchParams;`, so G2's `sp.<key>` scan is sound.
  - A1–A4 and B1–B4 line numbers.
  - C3: `pos-reconciliation/page.tsx:30-40` reads only `store`/`date`.
  - Key separation: `derivedKey` is at `credentials.ts:65-66`, and `timingSafeEqual` with a length check at `:192-196`.
  - The Next claim, in next 16.3.2:
    - `cookies().set` writes `Set-Cookie` onto `res` at once (`async-storage/request-store.js:99-100`);
    - `getForwardedHeaders` (`action-handler.js:73-99`) merges it into the `cookie` header of the internal fetch
      that renders the redirect target (`:276,318`);
    - a no-JS form gets a 303, and the browser stores the cookie before its GET (`:902-905`).
  - No page, link or client code builds a `?error=`/`?ok=` URL. The only hits are actions, PRE_SESSION, and a comment
    at `channel-settlements/page.tsx:46`. S6 breaks no legitimate deep link.
  - S2–S5 share no source file. Their test overlap is REV-2.
- **REV-1..10:** inline above.
- **REV-11:** F2 adds a wrong-key leg (inline).
- **REV-13 (side effect, no action):** any cookie set in an action makes Next purge the whole client router cache
  (`action-handler.js:117-120`, `isCookieRevalidated`). Most of these actions already call `revalidatePath`, so the
  cost is small. It is noted so nobody chases it as a regression.
- **REV-12 (wording):** the Goal says "nginx access logs". Production fronts with Caddy (bible §13 row 200). The
  leak is the same either way.
- **Optional, not required:** add a short hash of the session token to the payload, so that a person who signs in
  by PIN on a till without signing the last person out cannot see that person's flash from history within 60 s.
  `clearSessionCookie` covers only an explicit sign-out.

## Ruling log
- 2026-10-07, planner: R1–R10.
  - Flash for ALL banner text, not just refills, because of B1.
  - A signed, 60-second cookie with a URL token.
  - Pages change one line.
  - S1b makes every test read both forms, so S2–S5 have disjoint files.
  - S4 waits for T-379.

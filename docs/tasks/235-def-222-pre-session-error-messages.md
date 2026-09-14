# T-235 — DEF-222: one environment-gated formatter for the pre-session surfaces

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-235`) for the commit, date and outcome —
> the roadmap is the maintained record.
>
> ⛔ **The register's remedy assumes two things are the same policy. They are opposites.** §2 is
> the report (RULES §3.4a — *"report a spec defect; never silently work around it"*). §3 is what I
> propose instead, and it is a real generalisation rather than a smaller one — it shares everything
> the two surfaces genuinely have in common and makes the one difference explicit and named.

## The defect, as the register states it

`docs/DEFECTS-REGISTER.md` DEF-222, `reported`, found 2026-09-08 by lane C reviewing slice 1, with a
second surface added by lane C reviewing slice 2:

1. **`apps/erp/src/app/sign-in/actions.ts:47`** — `signInAction`'s catch is
   `err instanceof Error ? err.message : 'Sign-in failed.'`, with **no production/dev split at all**,
   so a database error's raw text lands in the URL of the unauthenticated `/sign-in` screen.
2. **`apps/erp/src/app/setup/actions.ts:71-79`** — `/setup` formats its failure through
   `errorMessage()`, a repo-wide helper built for *authenticated* screens, and `/setup` is the one
   pre-session surface reusing it.

Remedy as written: *"One environment-gated formatter for the pre-session surfaces (`/sign-in` both
paths, `/setup`): slice 1's `emailSignInMessage` generalised, wrapping `errorMessage()` so
constraint sentences still pass through; two call sites and one test."*

⭐ **T-232 decision 6 ("the PIN sign-in stays exactly as it is") does not block this**, and the
register says so explicitly: that decision is about *behaviour* — the store picker, the six-digit
field, the flat refusal — not about echoing a database error into a URL.

---

## 1. Two corrections to the register's framing, before anything is built

### 1.1 There are THREE call sites, not two

The register's own remedy names *"`/sign-in` both paths, `/setup`"* — three actions — and then says
*"two call sites"*. Three:

| # | Call site | Today |
|---|---|---|
| 1 | `sign-in/actions.ts:47` `signInAction` (PIN) | **no gate at all** — the defect |
| 2 | `sign-in/actions.ts:94` `signInWithEmailAction` → `emailSignInMessage` (`:110-119`) | gated, slice 1 |
| 3 | `setup/actions.ts:143` `createFirstRunAction` → `setupErrorMessage` (`:71-79`) | gated, slice 2 |

The count matters only because a spec that says "two" invites a lane to stop after two, leaving the
one site that has no gate at all — which is the defect DEF-222 was opened for.

### 1.2 ⛔ `signInAction` does not LOG either, and that is the worse half

`emailSignInMessage` and `setupErrorMessage` both `logger.error` before deciding what to show.
`signInAction`'s catch (`:44-49`) logs **nothing**. So an infrastructure failure on the PIN path —
the path every terminal in every store uses — is today *simultaneously* leaked to the browser and
absent from the server log. The register describes the leak; the silence is not mentioned anywhere
and is the half that costs an operator an evening.

⚠️ **Probably still moot in practice**, exactly as the register says: `signInWithPin` throws
`AuthenticationError` on every failure path that matters. The hole is what `transaction()` itself
can throw. Fixing it is cheap; leaving one of three doors ungated after a task named for gating
them is not.

---

## 2. ⛔ SPEC DEFECT — the two existing helpers are a whitelist and a blacklist

The remedy says *"slice 1's `emailSignInMessage` generalised, wrapping `errorMessage()` so
constraint sentences still pass through."* That reads as though `setupErrorMessage` is
`emailSignInMessage` plus a constraint-sentence carve-out. **It is not.** They decide the opposite
question, and each is correct on its own surface for a reason that does not transfer.

| | `emailSignInMessage` (`sign-in/actions.ts:110`) | `setupErrorMessage` (`setup/actions.ts:71`) |
|---|---|---|
| Shape | **Whitelist** — only `AuthenticationError` survives | **Blacklist** — everything survives *except* a driver error |
| Masks a plain `Error` | **Yes** | **No** |
| Discriminator | the error's CLASS | a five-character SQLSTATE on `err.code` |

### 2.1 Why the whitelist is wrong for `/setup`

`bootstrapOrganization` and the functions under it refuse with **plain `Error`s carrying sentences
written for a person**: *"the PIN must be exactly 6 digits."*, *"…first-run setup is closed."*,
*"an organization needs a code."*, *"the first admin needs a name."*, *"a firebase uid was supplied
but is blank."* Under the whitelist every one of those becomes *"Setup failed"* in production, and
`/setup` becomes a six-field form that will not say which field is wrong — on the one screen whose
whole job is to be completed by a person who has never seen it.

⭐ **This is not a prediction. It is a measured result.** T-232's mutation test removed the SQLSTATE
discriminator — which is exactly what adopting the whitelist would do — and **five** assertions in
`apps/erp/tests/setup-failure-redirect.test.ts` went red, including *"the PIN must be exactly 6
digits"*.

### 2.2 Why the blacklist is wrong for `/sign-in`

The email path's own comment (`:104-108`) names what it is defending against: *"a missing
`FIREBASE_PROJECT_ID`, a database that is down, a bug."* A missing environment variable is a plain
`Error` from `verifyFirebaseIdToken` with **no SQLSTATE**, so under the blacklist it would pass
through verbatim in production — which is precisely the thing `api/health/route.ts` settled:
*"this endpoint is unauthenticated; in production it must not describe which variables are unset."*

### 2.3 So there is no single policy — and that is the finding worth keeping

The two surfaces differ in one real way: **on `/setup`, the domain talks to the visitor; on
`/sign-in`, it does not.** `/setup` is the only pre-session screen that runs business logic whose
refusals are addressed to the person reading them. That is a genuine property of the surface, not
an accident of who wrote it first.

Collapsing them into one policy therefore has to break one surface. **Collapsing them into one
FORMATTER, parameterised by that one difference, breaks neither** — and turns a distinction that is
currently invisible and accidental into one that is named, documented and tested.

---

## 3. The proposal

### 3.1 `apps/erp/src/lib/pre-session-message.ts` — new

Everything the three call sites genuinely share, which is the whole environment gate:

```ts
export interface PreSessionMessagePolicy {
  /** Does this error already carry a sentence written for the person reading it? */
  readonly isWrittenForAPerson: (err: unknown, message: string) => boolean;
  /** What a stranger is told in production when it does not. */
  readonly opaque: string;
  /** What the server log says happened. */
  readonly logged: string;
}

/**
 * Always logs. Outside production, returns the real message. In production, returns `opaque`
 * unless the policy says the message was written for a person.
 */
export function preSessionMessage(err: unknown, policy: PreSessionMessagePolicy): string;

/** `/sign-in`, both paths. Only a ratified refusal survives — nothing on that screen is
 *  addressed to the visitor except an AuthenticationError. */
export const SIGN_IN_POLICY: PreSessionMessagePolicy;

/** `/setup`. Also keeps mapped constraint sentences and any plain Error with no SQLSTATE,
 *  because the first-run domain refuses IN SENTENCES and the screen is unusable without them. */
export const SETUP_POLICY: PreSessionMessagePolicy;
```

⚠️ **The log line fires on every masked path, including outside production**, matching both
existing helpers — the reason is in the log whether or not it is also on the screen.

⚠️ **`errorMessage()` is applied before the policy runs**, so a mapped constraint sentence is
already in hand when `SETUP_POLICY` is asked about it. That is what the register means by
*"wrapping `errorMessage()` so constraint sentences still pass through"*, and it is the one part of
the remedy that carries over unchanged.

### 3.2 Where the two predicates come from

- `SIGN_IN_POLICY.isWrittenForAPerson` — `err instanceof AuthenticationError`. Lifted verbatim from
  `emailSignInMessage:111`, and now the PIN path gets it too.
- `SETUP_POLICY.isWrittenForAPerson` — `!isUnmappedInfrastructureError(err, message)`, **moved**
  from `apps/erp/src/app/setup/lib.ts:123` into this file, so the two predicates sit side by side
  and the difference between them can be read in one screen instead of inferred across two
  directories. Its 13 existing tests move with it, unchanged.

### 3.3 The three call sites afterwards

```ts
// sign-in/actions.ts — signInAction's catch, which today has no gate and no log
redirect(`/sign-in?next=…&error=${encodeURIComponent(preSessionMessage(err, SIGN_IN_POLICY))}`);

// sign-in/actions.ts — signInWithEmailAction; emailSignInMessage DELETED
redirect(`/sign-in?next=…&error=${encodeURIComponent(preSessionMessage(err, SIGN_IN_POLICY))}`);

// setup/actions.ts — setupErrorMessage DELETED
redirect(setupFailureRedirect(organisationCreated, preSessionMessage(err, SETUP_POLICY)));
```

⚠️ **One behaviour change on the PIN path, stated because it is a change and not a fix:** a
non-`AuthenticationError` failure now says *"Sign-in failed. Something on the server is wrong — the
reason is in the server log."* in production instead of the driver's words. The wrong-PIN and
unknown-PIN sentences are untouched, because those are `AuthenticationError`s. Decision 6's
behaviour is intact.

### 3.4 What this does NOT do

- **No change to `errorMessage()` or `CONSTRAINT_MESSAGES`.** They serve ~40 authenticated screens
  where showing a mapped sentence is right and there is no stranger to protect from.
- **No new sentence wording.** Both opaque strings are the ones already shipped and read by Ian in
  T-232's browser pass.
- **No rate limiting, no error codes in the URL, no correlation id.** A correlation id is the
  obvious next thought and is deliberately excluded: it is only useful with a log search a person
  can actually run, which is a different task.

---

## 4. Scope — the exact files

**Create**
- `apps/erp/src/lib/pre-session-message.ts`
- `apps/erp/tests/pre-session-message.test.ts`

**Modify**
- `apps/erp/src/app/sign-in/actions.ts` — the two catches; delete `emailSignInMessage`
- `apps/erp/src/app/setup/actions.ts` — the one catch; delete `setupErrorMessage`
- `apps/erp/src/app/setup/lib.ts` — remove `isUnmappedInfrastructureError` (moved)
- `apps/erp/tests/setup-failure-redirect.test.ts` — its 13 masking cases move to the new test file;
  the 6 `setupFailureRedirect` cases stay

**⚠️ Outside my previous scope and declared rather than assumed:** `apps/erp/src/app/sign-in/**` was
lane D/E's under T-232 and is explicitly listed as *"another lane's files"* in my original briefing.
Slice 1 is committed and that lane is parked or cleared, and DEF-222's remedy cannot be carried out
without it. **I will not touch it until you say so in as many words.**

**Out of bounds, as ever:** `PROJECT_BIBLE.md` · `docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md`
(DEF-222's status is yours to flip) · `CAPABILITY-MATRIX.md` · `capabilities.ts` · `nav.tsx` · any
`packages/*/src/index.ts` barrel · `packages/**` entirely — **this task touches no package at all.**

**Migration:** none, and none possible — nothing here reaches the database.

---

## 5. Tests — `apps/erp/tests/pre-session-message.test.ts`

Unit, not integration: this is a pure function over an error object. ⭐ It must import nothing that
pulls `@shareat/db` — T-232 measured that at ~2 s of import for 4 ms of assertions, and the fix was
to import the leaf module rather than the barrel.

| # | Case |
|---|---|
| 1 | ⭐ **The one that would have caught DEF-222**: a driver error through `SIGN_IN_POLICY` in production → the opaque sentence, and the driver's words are **absent from the returned string** |
| 2 | The same error outside production → the real message, named in full |
| 3 | An `AuthenticationError` → verbatim, in production. The wrong-PIN sentence must survive |
| 4 | ⛔ **The non-zero control**: `SETUP_POLICY` in production keeps *"the PIN must be exactly 6 digits."* — a plain `Error` with no SQLSTATE. Without this the suite passes against a formatter that masks everything |
| 5 | `SETUP_POLICY` in production keeps a mapped constraint sentence, even though the error carries a SQLSTATE |
| 6 | `SETUP_POLICY` in production masks a SQLSTATE error no constraint sentence claimed |
| 7 | ⭐ **The two policies genuinely differ**: one plain `Error` with a person-facing sentence, both policies, production → `SIGN_IN_POLICY` masks it, `SETUP_POLICY` does not. If this ever passes with both agreeing, one of them has silently become the other |
| 8 | Every masked path logs, and no unmasked path is silent — asserted against a stubbed logger, so "it logs" is executed rather than read |
| 9 | A thrown non-`Error` (a string, `null`, `undefined`) does not crash the formatter |
| 10 | ⛔ **`env()`'s banner** — a plain `Error`, no SQLSTATE, naming every unset variable — masked by both policies. 4 tests, 8 assertions |
| 11 | ⛔ **The driver's CONNECTION errors** — `ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT` carry a string `code` that is NOT a SQLSTATE and name the host and port. 4 tests |
| 12 | The four assertions restored from `setup-failure-redirect.test.ts`, including the one a mutation test proved was load-bearing |
| 13 | A thrown non-`Error` is masked; an empty message falls back to the opaque sentence and is still logged |
| 14 | The log carries the whole error, so the stack and `cause` survive |

⚠️ **Cases 10-14 were added during review, not planned here.** Case 11 is the one that matters: the
first cut masked only a five-character SQLSTATE, and the driver's connection errors have a string
code of any length — so a database-down first run put the host and port in the URL. The enumeration
in §7 missed it because it enumerated what **this repo** throws, not what the **driver constructs**.

⚠️ **`NODE_ENV` is set per-case and restored**, never once at module scope — a suite that mutates it
globally makes every later file's behaviour depend on test order.

**Also re-run:** `apps/erp/tests/setup-failure-redirect.test.ts`, `tests/unit/` in full (the
`no-direct-transaction-in-erp` and `no-client-supplied-actor` guards both scan these files), and
`packages/auth/tests/integration/sessions.test.ts` on the lane DB — not because this task touches
`packages/auth`, but because `signInAction`'s catch is the only caller-side proof that
`signInWithPin`'s refusals really are `AuthenticationError`s. If any of them is not, case 3 fails
and that is a finding, not a broken test.

## 6. Done when

typecheck clean · unit project green with the real numbers reported · the re-run suites green on
`shareat_test_t229` · self-reviewed line by line · **`FOR IAN` block in the READY report** ·
smoketest **not** claimed by me — the three surfaces are `/sign-in` (both forms) and `/setup`, all
of which need the orchestrator's browser pass, and one of them can only be seen on a genuinely
empty database.

⚠️ **Not verified by lane B and stated as such:** that production actually behaves as
`NODE_ENV === 'production'` here. The gate is read from `process.env.NODE_ENV` exactly as
`api/health/route.ts` and both existing helpers do, so this task inherits whatever that is worth; it
does not establish it.

## 7. Logged in passing (RULES §13 row 164)

- ⚠️ **`signInAction` logs nothing on failure** (`sign-in/actions.ts:44-49`) — §1.2. Reported as
  part of this task rather than separately, because the remedy closes it.
- ⚠️ **`errorMessage()` substring-matches the raw driver text against every key in
  `CONSTRAINT_MESSAGES`** (`apps/erp/src/lib/constraint-messages.ts:69-75`). A constraint whose name
  is a substring of another's would map to the wrong sentence. Nothing collides today; it is a
  property of the lookup, not a bug in it, and it is out of this task's scope. **Not verified beyond
  reading — worth a register row only if someone confirms a collision is possible.**

## FOR IAN

- **Nothing changes on a screen you use.** Wrong PIN still says the same thing; wrong password still
  says the same thing; the setup screen still tells you which field is wrong.
- **What changes is what a stranger sees when something breaks on the server.** Today one of the
  three sign-in doors puts the database's own words into the address bar of a page anyone can open.
  After this, all three say one sentence and put the real reason in the server log where you or an
  agent can read it.
- **You lose nothing diagnostically.** Outside production — on your laptop — the full error still
  appears on screen, exactly as now.

# ERPv2 — PROJECT BIBLE

> **This file is the single source of authority for how ERPv2 is built.**
> If anything — a prompt, a subagent, a habit carried over from ERP-rebuild, a
> clever idea mid-task — conflicts with this file, **this file wins.**
> Read it before touching the project. Amend it via §14, never silently.

| | |
|---|---|
| **Version** | 1.6 — Phase 0 verified on Postgres 18; T-113 answered; ledger scope set to management-basis |
| **Created** | 2026-08-22 |
| **Last amended** | 2026-08-23 |
| **Status** | Accounting-correctness project (§1.1). All discovery complete. Root cause identified (§16.0). **Chart of accounts aligned and signed off.** Ready to write Phase 0/1 task specs. |
| **Scale being replatformed** | 149 page routes (~53,700 LOC of pages), 20 API routes, 9 cron jobs, ~90 Firestore collection paths, 144 server-action modules / 578 exported functions |
| **Source project** | `C:\Users\ianla\webapps\ERP-rebuild` (branch `upgrade-next16`) — **READ-ONLY, NEVER MODIFY** |
| **This project** | `C:\Users\ianla\webapps\ERPv2` |

---

## 0. Standing directive — how Claude engages

*Given by Ian, 2026-08-22. This governs every other section, including how this file
itself gets amended.*

### 0.1 The division of authority

> **Ian describes WHAT needs to happen. Claude decides HOW it gets built.**

Ian's instructions are **statements of need, not implementation specifications.** When
Ian says "make it work offline" or "put the data in a relational database," that is the
goal. The mechanism — the pattern, the library, the schema shape, the sequencing — is
Claude's call, and Claude is accountable for it.

This means a literal reading of an instruction is **not** automatically the correct
execution of it. If the literal reading is the weaker engineering choice, Claude builds
the better one and says so.

### 0.2 Brainstorm before executing

Before acting on any non-trivial instruction, **stop and think first**:

1. What is the actual underlying need behind what was asked?
2. **How does the industry solve this?** What is the established pattern, and what is
   the name of it? Prefer a known, named, battle-tested approach over a bespoke one.
3. **How would a seasoned engineer handle this** on a production system with real
   money and real staff depending on it?
4. What would this decision cost us in twelve months?
5. Only then: what do we build?

A clever solution nobody else uses is a liability. Boring, standard, well-understood
approaches win by default. Deviation from an industry standard requires a written
reason in `docs/decisions/`.

### 0.3 Side with the project

When "what Ian asked for" and "what is best for the project" diverge, **build what is
best for the project and say plainly that you did, and why.**

This is explicit permission, and therefore an obligation. Silent compliance with a
choice you believe is wrong is a failure of the job, not politeness.

### 0.4 Push back — including hard

**Do not hold back.** If a request would hurt the project, say so directly, before
building it. That includes:

- Telling Ian a feature should not be built.
- Telling Ian the scope is too large, or the sequencing is wrong.
- Telling Ian an earlier decision — including one in this bible — has turned out to be
  a mistake, and should be reversed.
- Telling Ian that the whole project may be the wrong investment.

State the concern in a sentence or two, give a recommendation, then **keep working**.
Push back is not a refusal and not a stall: unless something is genuinely unsafe,
deliver the work under a clearly stated assumption while the concern stands. Raise it
once, properly — do not re-litigate a decision Ian has already made after hearing it.

### 0.5 What this does not license

- Not scope creep. Owning *how* is not permission to expand *what*.
- Not silent substitution. A different approach gets **stated**, not slipped in.
- Not skipping the destructive-action confirmations in §2 and §8.
- Not contrarianism. Most instructions are fine; execute them.

---

## 1. Prime directive

ERPv2 exists to give this business **books it can trust**, on a schema that is correct
by standard accounting practice and no more complicated than the business needs. It is a
**re-platform of ERP-rebuild, not a rewrite of it** — the product stays, the foundation
is rebuilt.

- **Fix:** the accounting. This is the point of the project (§1.1). Correct double-entry,
  enforced by the schema, verified continuously.
- **Keep:** the product. Every module, screen, and workflow ERP-rebuild encodes. The UI
  layer (`src/app` pages, `src/components`, Tailwind/shadcn config) carries over largely
  intact so nobody retrains.
- **Replace:** the persistence layer. Firestore stops being the system of record; a
  **relational database (PostgreSQL)** becomes the single source of truth.
- **Retain, narrowly:** Firebase — as an **offline edge cache** for a small, explicitly
  enumerated hot set (biometrics, attendance clock, store config) so clock terminals
  keep working with zero network.

Two sentences to remember: **Correct books, simply modelled.**
**Postgres owns the truth; Firebase owns the edge.**

### 1.1 The real goal: CORRECT and SIMPLE accounting

*Set by Ian, 2026-08-22: "most of my concern is accounting — the current ERP is
vibecoded and has lots of accounting gaps I'm closing and currently discovering. So
that's one of the goals: make the accounting, inventory and other data shape and schema
industry standard, correct and simple." And: "ERPNext's data structure is superb, but my
business is not an empire — that level of sophistication is overkill."*

**ERPv2 is not primarily a database migration. It is an accounting correctness project
that happens to require one.** Moving to SQL is the means; correct books are the end.

The target is the **midpoint between v1 and ERPNext**:

| | v1 (ERP-rebuild) | **ERPv2 — the target** | ERPNext |
|---|---|---|---|
| Correctness | Gaps, being discovered | **Rigorous** | Rigorous |
| Complexity | Ad hoc | **Minimal that is still correct** | Enterprise-general |
| Verdict | Not correct enough | **Correct AND simple** | Correct but overkill |

"Simple" never means "less correct." It means **carrying no generality this business
does not have**: one company (with an `organizations` table reserved for the second
entity), one currency (PHP), two reporting dimensions (store, channel), one costing method,
PH tax rules written directly rather than through a configurable tax engine. Every
axis of generality ERPNext offers must be **justified by an actual business need or
left out**.

### 1.2 The four verbs — the editorial doctrine

*Standing rule from Ian, 2026-08-22: "Don't touch v1 — it belongs to him alone and Frappe.
We **duplicate what's good, correct what's wrong, add what's missing, delete what's not
needed and redundant.**"*

This is how every single thing carried across from ERP-rebuild is decided. Four verbs, and
every element gets exactly one:

| Verb | Applies to | Who decides |
|---|---|---|
| **DUPLICATE** | Working features, hard-won business rules, the operational feel, screens staff know | Default for anything that works |
| **CORRECT** | Accounting defects, misclassifications, silent-failure patterns, security gaps | Claude, against the standard (§16) |
| **ADD** | The nominal ledger, control accounts, employer contributions, inventory valuation, statutory tracking | Claude, from the gap list (§16.7) |
| **DELETE** | Dead code, redundant duplicates, one-time migration tooling, unused stubs, near-duplicate categories | Claude for *redundant implementation*; **Ian for any user-facing capability** |

**The DELETE line matters.** Removing a redundant *implementation* — two categories meaning
the same thing, a dead stub, one-time tooling — is a "how" decision and therefore Claude's
(§0.1). Removing a *capability someone uses* is a "what" decision and therefore Ian's.
When unsure which side a thing falls on, ask.

This doctrine **relaxes** the workflow-parity rule below: v2 is not a pixel-copy of v1. It
is v1 with the wrong parts corrected, the missing parts added, and the redundant parts
gone.

### 1.2a v1 ownership — hands off

ERP-rebuild is **not ours to edit**, and now for a second reason beyond §2: it is actively
owned by someone else, alongside the Frappe work.

- **Never** modify, branch, or run git operations in `ERP-rebuild`. Read-only, always.
- Findings about v1 are **reported to Ian**, never acted on. If discovery shows a live v1
  bug, it goes in the report and into v2's fix list — we do not go fix it.
- Do not propose v1 remediation work as ours to do.

### 1.3 The parity contract — what is fixed, what is free

Three categories, not two. **Getting this wrong means either retraining staff for no
reason, or faithfully reproducing v1's accounting bugs.**

| | **Workflow & UX — FIXED** | **Accounting correctness — NOT parity** | **Data handling — FREE** |
|---|---|---|---|
| **What** | Screens, flows, fields, navigation, roles, the operational feel | Whether the books are right: postings, balances, valuation, periods | Engine, schema, indexing, caching, transactions, sync, queries |
| **Oracle** | ERP-rebuild | **Standard double-entry accounting** (§16) | Durable + scalable + secured |
| **Rule** | Mirror v1. Staff should not need retraining | Where v1 disagrees with correct accounting, **v1 is wrong** | Claude's call (§0.1). v1's shape is **evidence, not specification** |
| **Changing it** | Requires Ian | Expected, and documented as a divergence | No permission needed; must pass the three tests |

**The trap this avoids.** An earlier draft of this bible said "behaviour is fixed, a
different number is a bug," and planned to golden-master every figure against v1. Applied
to accounting that is **exactly wrong**: it would certify v1's defects as v2's
requirements. You cannot use a source you know to be broken as your oracle.

So the oracle splits:

- **Operational behaviour** (inventory movement, attendance, workflow, permissions) —
  v1 is the oracle. Golden-master against it (§15.2).
- **Accounting output** (journal postings, balances, valuation, aging, statements) —
  **accounting law is the oracle** (§16.2). v1 is a *comparison subject*, not a target.
  A v1-vs-v2 difference here is a **finding**, not a failure: it is either a v1 bug we
  just caught, or a v2 bug. Both outcomes are valuable; neither is settled by assuming
  v1 is right.

**Every accounting divergence gets written down** in `docs/decisions/ACCOUNTING-DIVERGENCES.md`:
what v1 does, what correct practice requires, what v2 does, and the effect on reported
figures. That file is a deliverable — it is the audit trail for why the numbers moved.

### 1.4 The migration *is* the audit

A useful consequence worth planning around: **replaying v1's data through a correct
schema with real constraints will surface v1's accounting gaps automatically.**

Entries that do not balance, subledgers that do not tie to control accounts, postings
with no source document, voids that never reversed — these cannot be loaded into a
schema that enforces double-entry. The ETL's quarantine table (§11 rule 5) therefore
becomes a **live list of v1's accounting defects**, discovered mechanically rather than
by hand.

This directly serves the work Ian is already doing. The reconciliation reports should be
treated as findings to act on in **both** systems, and shared back rather than merely
resolved inside v2.

### 1.5 The three tests for data-layer decisions

Every data-layer decision must be defensible on all three; trading one away requires an ADR:

1. **Durable** — survives crashes, races, partial failures, bad input, and operator
   error. Committed means committed. Nothing silently lost, coerced, or overwritten.
   History recoverable and audit-complete.
2. **Scalable** — holds up as stores, staff, transactions, and years of history grow.
   No unbounded query, no full-scan on a hot path, no design that only works because
   the dataset is small today.
3. **Secured** — least privilege by default, server-enforced, field-level where the data
   is sensitive.

**The practical consequence:** do **not** port Firestore's document shapes. v1's model
was bent to fit a document store — maps used as tables, arrays used as foreign keys, id
prefixes bridging two id spaces, projection docs standing in for joins, and (per
discovery) **one journal leg per document with a `direction: in/out` field instead of a
balanced header-plus-lines entry**. Copying those shapes into SQL would import the
pathology without the platform that forced it. Read v1's model to learn **what the
business means**, then model it properly.

### Why re-platform at all

ERP-rebuild's pain is structural, not incidental. Its recurring failure modes —
dual-writer projection drift, "cleaned but changed nothing" merge semantics, rules
that deploy green and silently deny, invariants held together by hand-rolled
transactions across documents, derived summary docs that go stale — are all
symptoms of forcing a relational, transaction-heavy, report-heavy accounting system
into a document store. ERPv2 fixes the category of bug, not the instances.

### What is explicitly NOT in scope

- Redesigning the UI. Visual/UX work is a separate future effort. v2 ships parity.
- Changing business rules. If ERP-rebuild computes something a certain way, v2
  computes it the same way, **unless** the rule is recorded as a bug in §12.
- Touching ERP-rebuild. It stays in production, untouched, until cutover.

---

## 2. Non-negotiables

These are absolute. Violating one is a defect regardless of whether tests pass.

1. **ERP-rebuild is read-only.** No edits, no branches, no "small fixes," no
   `git` operations in that directory. Discovery reads it; nothing writes it.
2. **`webapps\inactive projects` does not exist.** Never browse, search, glob,
   grep, or resolve a name into it.
3. **Postgres is the sole system of record.** No entity's authoritative state
   lives in Firestore. Ever.
4. **Firestore is one-way except the inbox lane.** See §5. Any code that reads a
   Firestore mirror doc as truth, or writes business state to Firestore outside
   the inbox lane, is a defect.
5. **No money in floats.** `numeric` in the DB, integer-safe helpers in code. See §6.
6. **No client-side-only authorization.** Every gate exists server-side. Client
   gates are cosmetic only. See §7.
7. **Opus plans, Sonnet codes.** See §3. No unplanned implementation.
8. **Every schema change is a migration file.** No hand-edited databases, no
   `push` against anything but local dev.
9. **Stop the dev server before building.** `next build` overwrites the `.next` a
   running `next dev` is serving — it produces unstyled pages and phantom build
   errors on untouched files.
10. **NEVER BUILD ON THE PRODUCTION SERVER.** No `next build`, no `npm install --build`,
    no compile step of any kind on the droplet. **The production host is not a build
    machine.** Builds run in CI; the server receives a finished artifact only. See §8.
11. **Port 9008 is ERPv2's, and only ERPv2's.** See §8.

---

## 3. Execution model — how work gets done

### 3.1 The division of labour

| Role | Model | Does | Never does |
|---|---|---|---|
| **Planner** | **Opus** | Reads discovery, designs schema, decides architecture, writes task specs, reviews every diff, amends this bible | Writes feature code |
| **Implementer** | **Sonnet** subagent | Executes one written task spec, writes code + tests, reports back | Invents scope, changes architecture, amends the bible |
| **Explorer** | **Sonnet** subagent | Read-only discovery, produces a doc under `docs/discovery/` | Writes production code |
| **Reviewer** | **Opus** | Self-review of every change before it is called done | Rubber-stamps |

**Rule: no Sonnet agent starts without a written task spec from Opus.**
**Rule: no Opus plan is written without discovery evidence to back it.**

### 3.2 The work loop

```
  Opus:   read discovery  ->  write task spec  ->  docs/tasks/NNN-<slug>.md
     |
  Sonnet: implement spec  ->  code + tests  ->  report
     |
  Opus:   self-review diff  ->  smoketest  ->  build  ->  commit
     |
  Opus:   amend bible if a decision was made  ->  next task
```

### 3.3 Task spec format (`docs/tasks/NNN-<slug>.md`)

Every spec must contain, or the Sonnet agent must refuse it:

- **Goal** — one sentence, the observable outcome.
- **Scope** — the exact files it may create or modify. Anything else is out of bounds.
- **Contract** — function signatures, table DDL, or API shape it must produce.
- **Invariants** — the business rules it must not break, with the source citation
  from `docs/discovery/`.
- **Tests** — the specific cases that must pass, written before the implementation.
- **Out of scope** — what it must explicitly leave alone.
- **Done when** — a checkable list.

### 3.4 Subagent rules

- Prefer **Sonnet** for all delegatable work. Opus time is for planning and review.
- Every subagent prompt is **self-contained** — it starts cold and knows nothing
  about this conversation.
- Every subagent that discovers something durable **writes a file**; context dies,
  files don't.
- Parallelise only genuinely independent work. Two agents must never touch the
  same file.
- A subagent that handles credentials **redacts, never writes the real value**.

### 3.5 Reporting to Ian

Every substantive report ends with a **`FOR IAN`** block: plain-language, what
changed, what it means for the business, what needs a decision. Preconditions and
agent-facing checks stay out of that block.

---

## 4. Architecture — the relational core

### 4.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Database** | **PostgreSQL 18** | Native `uuidv7()` for primary keys (§4.2 rule 1) without an extension — the deciding factor. Plus real transactions, FK + CHECK constraints, `numeric` money, window functions for aging/ledger/payroll, partial + expression indexes, materialised views for report read-models |
| **Prod hosting** | **Cloud SQL for PostgreSQL** | Same GCP project/region as the existing app; private IP from Firebase App Hosting |
| **Local dev** | Postgres 18, port **5435** | A non-default port, so no other Postgres on the machine is disturbed. Was 5433; moved 2026-08-23 after 5433 was found already bound by another project's container (§13 row 68). Docker optional — Docker Desktop/WSL2 is flaky on this machine; a native install is the safer default |
| **ORM / query** | **Drizzle ORM** | SQL-first and typed; migrations are plain reviewable SQL; **no native binary engine**, which avoids the Next.js server-bundling class of failure that a binary-engine ORM drags in |
| **App** | Next.js 16 App Router, TypeScript, Tailwind, shadcn/Radix | Carried over from ERP-rebuild unchanged |
| **Identity** | **Firebase Auth stays** as the IdP | Staff already have accounts; the phone/APK flows already work. Postgres owns roles and permissions, not Firebase |
| **File storage** | **Firebase Storage stays** | Receipt photos, proof images, exports. Postgres stores the path, never the bytes |
| **Hot/offline cache** | **Firestore, narrow lane only** | §5 |

> Alternative considered and rejected for now: Prisma (heavier, binary engine,
> weaker interactive-transaction ergonomics), Supabase (duplicates Auth + Storage
> we already run on Firebase). Revisit only via §14.

### 4.2 Schema principles

1. **Every table has** `id` (uuid v7 or bigint identity — decided per table),
   `created_at timestamptz not null default now()`, `updated_at timestamptz`,
   `created_by`, and where it matters `store_id`.
2. **`store_id` is on every store-scoped table**, indexed, and every query filters
   on it. Multi-store isolation is a schema property, not a convention.
3. **Foreign keys are declared.** No orphan rows. `on delete restrict` by default;
   `cascade` only where the child is genuinely a part of the parent.
4. **Money is `numeric(14,2)`** for amounts, `numeric(14,4)` for rates/quantities
   where fractional precision matters. Never `float`/`double`/`real`.
5. **Enums are Postgres enums or a CHECK-constrained text column**, never free text.
   Status columns especially: `draft | submitted | approved | posted | void`.
6. **Posted vs draft discipline is enforced by constraint**, not by hope. A posted
   record's financial columns are immutable; corrections are new rows (reversal +
   re-post), never in-place edits.
7. **Derived data is a view or materialised view**, not a hand-maintained summary
   row. If a materialised view is too slow to refresh, the fallback is a summary
   table refreshed inside the same transaction as its source write — never by a
   separate writer.
8. **One writer per table.** If two code paths write the same table, one of them
   is wrong. (This is the single most expensive lesson from ERP-rebuild.)
9. **Append-only where the audit trail matters** — ledger entries, stock movements,
   attendance punches. Correction = compensating entry, never `UPDATE`.
10. **Idempotency keys are UNIQUE constraints.** Any operation that can be retried
    (offline replay, webhook, cron, user double-click) carries a client-supplied
    key with a unique index behind it. This replaces debounce/throttle guesswork.

### 4.3 Application layering

```
  UI (app/, components/)          <- carried over from ERP-rebuild, unchanged
       | calls
  Server actions (lib/actions/)   <- thin: authorize -> validate -> call service
       | calls
  Services  (lib/services/)       <- business rules; owns transactions
       | calls
  Repositories (lib/db/repo/)     <- the ONLY place SQL is written
       |
  Drizzle schema (lib/db/schema/) <- the ONLY place tables are defined
```

- A server action never writes SQL. A repository never enforces a business rule.
- Every mutating service function runs inside **one** transaction, or explicitly
  documents why it cannot.
- Validation is **zod at the action boundary**, always, for every input.

---

### 4.4 Reference data and seeds — how the duplicate-Rent problem dies

*Ian, 2026-08-22, on the duplicated Rent category: "I added it manually and later a CC
agent hardcoded it. Is it better to hardcode system entries in v2?"*

**Hardcoding alone would not have prevented it.** Two writers created the same concept
under two ids; hardcoding one of them just makes one of the two authoritative-looking. The
thing that actually makes a duplicate impossible is a **unique constraint on identity**.

The rule for all reference data — chart of accounts, expense categories, payment methods,
positions, units:

1. **Seeds are owned by migrations**, versioned and committed, applied **idempotently by
   `code`**. Re-running a seed never creates a second copy. No agent, script, or human
   hand-creates a system row a second time.
2. **`is_system` flag** on seeded rows. They may be **deactivated but never deleted**, and
   their `code` is stable forever.
3. **A UNIQUE constraint on normalised identity** — e.g. for categories:
   `UNIQUE (org_id, group, lower(trim(category)), lower(trim(sub_category)))`.
   This is the actual fix. A manual add that collides with a seeded row is rejected **by
   the database**, with an error naming the existing row.
4. **Admins can still add their own** — user-defined reference data is first-class, it
   simply cannot collide. (84 of your 132 categories are owner-added; that is healthy and
   stays.)
5. **One writer** (§4.2 rule 8): the seed owns system rows, the admin UI owns user rows.
   Neither writes the other's.

This is the general shape of the whole project in miniature — a rule maintained *by
construction* rather than *by remembering* (§16.7).

## 5. Architecture — the Firebase hot lane

This is ERPv2's defining feature, and its most dangerous surface. The contract below
is not negotiable at implementation time.

### 5.1 The two-lane contract

Every Firestore document in ERPv2 is exactly one of two kinds. There is no third kind.

#### Lane A — **MIRROR** (Postgres -> Firestore, read-only to clients)

- Written **only** by the publisher, a server-side process. Clients have
  **no write access at all** in the security rules.
- Document id is **deterministic** — it is the Postgres primary key.
- Every doc carries `srcVersion` (from the source row) and `syncedAt`. The publisher
  writes only when `srcVersion` is newer. Publishing is idempotent and replayable.
- A mirror doc going stale is **acceptable and expected**. Code that reads a mirror
  must tolerate staleness and must never treat it as authoritative for a decision
  that has money or payroll consequences.
- Deletions are **tombstones** (`deletedAt`), never hard deletes — an offline device
  must be able to learn that a record went away.

#### Lane B — **INBOX** (device -> Firestore, append-only)

- Offline devices **create** event documents. They may not `update` or `delete` them —
  enforced in the security rules, not just in code.
- Every event carries a **client-generated idempotency key**. The ingestor writes to
  Postgres behind a `UNIQUE` constraint on that key; a replay is a silent no-op.
- Events record **raw facts only** — "staff X presented fingerprint at time T on
  device D." They **never** carry a computed business outcome (late/OT/hours/pay).
  Postgres adjudicates, always, on the server, with the full ruleset.
- The ingestor stamps `processedAt` + the resulting Postgres row id. An event with no
  `processedAt` after a threshold is an alertable condition.

**Forbidden by construction:** a Firestore document that is both read as truth and
written by a client. That shape is the origin of the dual-writer bug class and it does
not exist in ERPv2.

### 5.2 What v1 actually does offline — and why v2 changes it

**Correction, recorded 2026-08-22 from `docs/discovery/05-offline-and-biometrics.md`.**
The premise that ERP-rebuild "uses Firebase for offline" is **false**, and building v2
on that assumption would have been a mistake:

- Offline punches queue in **IndexedDB** (`punch-queue.ts`), replayed by a hand-rolled
  `sync-engine.ts`. Firestore is not involved.
- Firestore's `persistentLocalCache` **is** enabled but is **irrelevant to the clock** —
  every clock action is a Next.js Server Action using the Admin SDK, which the client
  cache cannot intercept.
- Fingerprint matching is **on-device**, in a native Java plugin driving a USB ZK9500
  reader (`FingerprintPlugin.java:169-185`) — offline even when online.
- The APK is a **pure online WebView shell** (`capacitor.config.ts`). All offline
  behaviour comes from browser IndexedDB/Service Worker, not a bundled native app.
- **Only fingerprint has an offline path.** Passcode, NFC/QR, and break start/end have
  none, and the UI does not gate them — a staffer keying a passcode offline gets a
  generic "Read failed" (`time-clock/page.tsx:271-288`).

**v2 deliberately moves offline onto the Firestore two-lane model**, replacing the
hand-rolled IndexedDB queue + sync engine. This is a simplification, not an addition:
the Firestore SDK provides offline persistence, automatic replay, and conflict-free
append-only writes as platform behaviour, which v1 reimplemented by hand and got
partly wrong (see the gaps in §12 rows 14–16).

**Binding consequence:** the clock terminal reads and writes Firestore via the
**client SDK**, never via Server Actions. A Server Action cannot function offline.
Any v2 code putting a Server Action on the offline clock path is a defect.

### 5.3 The hot set — closed list

The hot set is **closed**. Adding to it requires a bible amendment (§14): every
addition widens the offline attack surface and the staleness blast radius.

| # | Entity | Lane | Size | Refresh | Staleness tolerance |
|---|---|---|---|---|---|
| 1 | Active local-user roster for the store (name, position, staffId) | A mirror | ~200 B/staffer | On change + daily | Hours |
| 2 | **Fingerprint templates + matchToken** | A mirror | ~5.5 KB/staffer | On enrolment change | Hours |
| 3 | **Store attendance config** — credential kill-switches, shift windows | A mirror | <2 KB | On change, **priority** | Minutes |
| 4 | On-shift roster + current business day punch feed | A mirror | Small | Every few min | Minutes |
| 5 | Clock-terminal device identity | — | Tiny | On provision | n/a |
| 6 | Punch events captured offline | **B inbox** | Small | Written offline | n/a — write path |

**Item 3 is a new addition, not a port.** v1 does not cache attendance config offline,
so a terminal keeps accepting punches for a credential method an admin has just
disabled, discovering the rejection only at sync time as a silent dead letter. Caching
it is a bug fix.

#### Excluded from the hot set — deliberately, permanently

- **Face templates. Never mirrored, never cached, never bundled.** A 2026-07-04
  security fix in v1 removed face templates from the offline bundle after a biometric
  exfiltration finding. Face stays online-only in v2. **Do not re-propose this.**
- Any financial, payroll, or pay-rate data. A clock terminal has no business holding it.
- Anything not in the table above.

#### Biometric mirror access control — non-negotiable

Fingerprint templates are biometric data. In v1, Firestore rules are **store-membership
scoped, not role-scoped**, meaning any store member can read broad swathes of store
data. Mirroring templates under those semantics would recreate the exact exfiltration
risk the face fix closed.

Therefore in v2: **the biometric mirror is readable only by a provisioned device
identity**, scoped to its own store — never by an ordinary staff or manager account.
Device identities authenticate with a server-issued credential, and that credential is
**not** plaintext in `localStorage` (v1 stores `{id, secret}` in the clear).

### 5.4 Offline write-back rules

### 5.3 Offline write-back rules

1. A device **never** computes a business outcome offline.
2. A device **never** deletes or edits a synced record.
3. Reconnection replays the inbox in **event-time order**; the server, not the device,
   resolves ordering conflicts.
4. Duplicate suppression is the DB's `UNIQUE` constraint, not a client timer.
5. If an event cannot be ingested, it is **quarantined and surfaced**, never dropped.

---

## 6. Data conventions

### Money
- DB: `numeric(14,2)` amounts, `numeric(14,4)` rates. Never float.
- Code: one `Money` helper module. No arithmetic on raw numbers in feature code.
- Tolerances (e.g. receipt close tolerance) are **named exported constants** with a
  comment citing the business reason — never a magic number inline.
- A rate of `0` is a **legitimate value**, not "unset." Never `if (rate)`. Use
  `rate == null` for absence. *(Carried from a live ERPNext bug — see §12.)*

### Dates & time
- DB: `timestamptz`, always stored UTC.
- Business timezone is **`Asia/Manila`**, defined once, imported everywhere.
- Where a day boundary carries meaning (attendance, sales day, payroll period), the
  table has an explicit `business_date date` column — computed once on write, never
  re-derived at read time in each query.
- **Banned in server code:** bare `toLocaleTimeString` / `toLocaleDateString` /
  `toLocaleString` without an explicit timezone. Server runtimes are UTC; this
  silently shifts Philippine times by 8 hours. Enforce with a lint rule.
- Tests that touch time **pin the timezone**.

### Identifiers
- Primary keys: uuid v7 (sortable, safe to generate client-side for offline events).
- No meaning encoded in ids. No `YYYYMMDD_staffId` composite string keys as PKs —
  that is a natural key, and it becomes a `UNIQUE` constraint on real columns instead.
- Ids are stable forever. Nothing is renamed in place.

### Naming
- DB: `snake_case`, plural table names, singular column names, `_id` suffix on FKs.
- TypeScript: `camelCase`. The mapping lives in the Drizzle schema and nowhere else.
- No abbreviations that aren't already business vocabulary.

### Nulls
- `undefined` never reaches the database layer. Normalise with `?? null` at the
  repository boundary. Prefer `NOT NULL` + default over a nullable column.

---

## 7. Security model

1. **One authorization module.** Every server action's first statement is
   `await authorize(actor, action, resource)`. No exceptions, no inline role checks
   scattered through feature code.
2. **Permissions are `(action, resource)` tuples**, never coarse route-level or
   "admin ops" flags. Widening one capability must never grant an unrelated one.
3. **Roles live in Postgres**, not in Firebase custom claims and not in a client
   store. Firebase Auth answers *who you are*; Postgres answers *what you may do*.
4. **Store scoping is enforced in the repository layer** — a repo function that takes
   a `storeId` filters on it unconditionally. Cross-store reads require an explicit,
   separately-authorized code path.
5. **Firestore security rules in v2 are trivially small** and deny-by-default:
   mirror = read-only to authenticated members of that store; inbox = create-only
   with shape validation; everything else denied. If the ruleset grows past ~100
   lines, something has leaked into Firestore that belongs in Postgres.
6. **Self-dealing is blocked in the service layer** — no one approves, pays,
   adjusts, or scores their own record. Admins may be exempted, explicitly and
   auditably.
7. **Every mutation writes an audit row**: actor, action, entity, before/after,
   timestamp, source (web/APK/kiosk/cron/ingestor).
8. **Secrets never enter the repo.** `.env.local` is gitignored; a committed
   `.env.example` documents every required variable so a deploy never ships blank.
9. **Secrets fail closed.** A missing secret aborts startup. It never falls back to a
   default, a public value, or a dev constant. *(v1's passcode HMAC secret falls back
   to a public value if the production secret is unset — it fails **open**.)*
   **Scope note (2026-08-23, §13 row 71):** "fails closed" governs secrets a code path
   actually uses. A credential for a subsystem not yet wired may be declared
   *not-yet-required outside production* — never defaulted, never substituted, and still
   hard-required in production. Demanding a credential nothing reads does not add
   safety; it just blocks local development. Two traps to remember: an unset variable in
   a `.env` file arrives as the **empty string, not `undefined`**, so `.optional()` alone
   does not accept it; and a relaxation like this must be **covered by a test asserting
   the production path still refuses**, or it silently becomes permanent.
10. **Field-level authorization, not just row-level.** Store membership must not imply
    the right to read pay rates, salary-advance balances, infractions, or ledgers.
    Sensitive columns are gated per `(action, resource)`, and repositories expose
    narrow projections rather than whole rows.
11. **Every route is gated by default.** Access control is a property of the route
    table, not per-page discipline. A new page with no declared permission is denied,
    not allowed. *(v1 has a layout-level role gate only on `/admin`; everything else
    depends on remembering.)*

### 7.1 Identity — the v1 mess, and the v2 rule

Discovery (`docs/discovery/04-auth-and-permissions.md`) found a person can exist in up
to **four** loosely-linked systems, any subset of which may be missing:

| System | Holds | Problem |
|---|---|---|
| Firebase Auth user | role, status, storeAccess | The only layer rules actually see |
| Local user (per store) | bcrypt PIN, position | Shared-terminal login |
| Staff (HR) | pay rate, payroll linkage | May exist with no login |
| staffIdentities | cross-store aggregation | For salary-advance totals |

**The critical defect:** after a PIN check, the local-user "session" lives purely in
client-side `localStorage`/Zustand with **no server-issued token**. The acting
identity is then passed as a **client-asserted parameter to ~24 server actions**. The
server cannot verify who actually performed the action. Every attribution — who
approved, who charged, who counted — rests on a value the client supplies.

**The v2 rule, binding:**

- **One `person` table** is the spine. Firebase Auth account, local-user credential,
  HR record, and cross-store identity are all **rows referencing that person**, not
  parallel universes. A person with no login is a person row with no credential row.
- **A local-user PIN check issues a real, signed, server-side session token** with a
  short TTL, bound to the device and store. Acting identity is read **from that token,
  server-side**. No server action ever accepts an actor identity as a parameter.
- Attribution is therefore verifiable, which is a precondition for every self-dealing
  control, every audit row, and every payroll figure derived from a punch.

---

## 8. Repo & environment

### Layout

```
ERPv2/
  PROJECT_BIBLE.md          <- this file. The authority.
  CLAUDE.md                 <- loader; points every session at this file
  docs/
    discovery/              <- read-only findings from ERP-rebuild (Sonnet-produced)
    plans/                  <- Opus phase plans
    tasks/                  <- NNN-<slug>.md task specs
    decisions/              <- ADRs, one per irreversible choice
  db/
    schema/                 <- Drizzle table definitions (the ONLY place tables exist)
    migrations/             <- generated SQL, committed, never edited after apply
    seed/                   <- reference + dev fixture data
  etl/                      <- Firestore -> Postgres migration jobs
  src/
    app/                    <- routes + pages (ported from ERP-rebuild)
    components/             <- UI (ported)
    lib/
      actions/              <- thin server actions
      services/             <- business rules; owns transactions
      db/repo/              <- the ONLY place SQL is written
      sync/                 <- publisher (Lane A) + ingestor (Lane B)
      auth/                 <- the single authorize() module
  tests/
```

### Ports — reserved, never shared

| Thing | Port |
|---|---|
| ERPv2 Next.js dev | **9008** |
| ERPv2 local Postgres | **5435** |

`9002`–`9007` and `8000` belong to other repos and are off limits.
Never pass a different `-p`. Never start a second server on a port you don't own.

### Build discipline — two rules, both absolute

#### 🚫 RULE 1 — NEVER BUILD ON THE PRODUCTION DROPLET

**No `next build`, no compile, no bundling step of any kind on `159.223.78.207`.**

The droplet is **4 GB RAM** and runs **the application and (option A) the database on the
same box**. Next.js builds are memory-hungry and routinely peak past what is free on a
4 GB host. A build there does not merely fail — **it OOMs the box and takes Postgres down
with it.** That is a production outage and, at the wrong moment, a corrupted write.

- Builds run in **CI (GitHub Actions)**.
- The droplet receives a **finished artifact** and nothing else.
- `npm ci --omit=dev` for runtime dependencies only; never a build script.
- The principle, in industry terms: **build once, deploy many. The production host is not
  a build machine.** Artifacts are immutable and identical across environments.

If you find yourself about to run a build on the server "just this once" to test something
— stop. Build in CI, or build locally and ship the artifact.

#### RULE 2 — Locally, stop the dev server before building

`next build` overwrites the `.next` directory a running `next dev` is serving. The symptom
is misleading: unstyled pages and build errors pointing at files you never touched.

#### Other build notes

- `npm run dev` → port **9008**.
- Build from a POSIX shell (Git Bash), not `cmd.exe`.
- `npx rg` is **not** ripgrep and will report a false green. Use the Grep tool.

### Git

- Repository: **https://github.com/ianlalusin/ERPv2** (private), remote `origin`, default
  branch `main`. Created 2026-08-22.
- Work on feature branches; **`main` stays green** — CI runs typecheck, unit tests,
  migrations, integration tests against a real Postgres, and the build on every push.
- Commit after every green smoketest + build, not in one giant lump.
- Never `--no-verify`, never skip CI.

---

## 9. Definition of done

A change is done only when **all** of these are true:

1. Types check (`npm run typecheck`) — clean.
2. Unit tests pass, including the ones written *before* the implementation.
3. Integration tests pass against a real Postgres (not a mock).
4. Smoketested in the running app on port 9008 — the actual screen, the actual click.
5. `npm run build` succeeds (dev server stopped first).
6. Self-reviewed: the diff read back line by line, hunting for what it broke, not
   just confirming what it added.
7. Committed with a message that explains *why*.
8. Bible amended if a decision was made.

Reporting a task complete when any of these is unmet is a defect in itself. If a step
is skipped, say so explicitly and say why.

### Parity gate
Every ported module must be checked against ERP-rebuild with the **same real input**
producing the **same output** — same totals, same statuses, same edge-case behaviour.
A parity mismatch is a blocker unless it is a bug listed in §12, in which case it is
recorded as an intentional divergence.

---

## 10. Phase plan

Sequenced so that the riskiest, most differentiating work is proven early, and so that
each phase is independently shippable and independently verifiable.

**Resequenced 2026-08-22** once Ian confirmed accounting correctness is the point of the
project (§1.1). The accounting spine now comes first, because everything else posts
*into* it — building inventory or payroll before the ledger is right means reworking
their postings later.

| # | Phase | Delivers | Gate to exit |
|---|---|---|---|
| **0** | **Foundation + walking skeleton + offline spike** | Repo scaffold, Postgres, Drizzle, migrations, auth bridge, CI, observability, backups, port 9008. One thin end-to-end slice (§15.1). A **time-boxed spike** proving the Firestore two-lane contract with a toy payload | Skeleton runs end to end; spike proves an offline write survives and reconciles |
| **1** | **The accounting spine** | Chart of accounts, `journal_entries` + `journal_lines`, posting engine, reversal, fiscal periods, trial balance, the ten invariants as CI tests (§16) | Invariant suite green; worked examples post correctly; trial balance ties |
| **2** | **Money-moving source documents** | Expenses, AP, AR, payments, cash requests, sales day, settlements — each posting into the spine | Subledgers tie to control accounts; a real closed period reconciles; divergences from v1 logged |
| **3** | **Inventory + inventory accounting** | Items, locations, stock ledger, receiving, transfers, usage, wastage, counts, weighted-average valuation, COGS postings (§16.6) | Inventory control account = sum of on-hand valuations; stock ledger reconciles |
| **4** | **Attendance + biometrics + the hot lane** | Punch model, server-side adjudication, Lane A publisher, Lane B ingestor, offline clock terminal | A terminal clocks in with the network pulled and reconciles cleanly on reconnect |
| **5** | **Payroll** | Periods, effective-dated compensation, late/OT policy, salary advances, immutable pay runs, GL postings | Parity on a historical payroll run, peso for peso; postings balance |
| **6** | **Reporting & dashboards** | Sales report, dashboards, insights — as views / materialised views over the ledger | Statements tie; report figures reconcile for the same date range |
| **7** | **Peripheral modules** | Admin, onboarding, memos, performance, checklists, cookbook | Feature parity checklist complete |
| **8** | **Cutover** | Per-module strangler cutover (§15.3), full historical migration, daily reconciliation, rollback plan | Ian signs off on a reconciled dual-run |

**Why accounting moved from Phase 4 to Phase 1.** It is the stated purpose of the
project; it is the module every other module depends on; and it is where v1's defects
live. A wrong ledger discovered in Phase 4 invalidates Phases 2 and 3.

**Why attendance moved from Phase 2 to Phase 4.** It was placed early as "the thesis,"
but the thesis changed — and attendance is the one module that touches the ledger only
through payroll, so it is genuinely decoupled. Its real risk is technical (does the
offline lane work?), and technical risk is retired by a **spike in Phase 0**, not by
building the whole module early. If capacity allows, attendance can run as a **parallel
track** without blocking the accounting sequence.

---

## 11. Migration & ETL rules

1. **The ETL is code, committed, and re-runnable.** No one-off console scripts.
2. **Every ETL job is idempotent** — re-running it converges, never duplicates.
3. **Every ETL job emits a reconciliation report**: source count, target count,
   sum-of-amounts on both sides, and an itemised list of every row it skipped and why.
   "It ran without errors" is not evidence; the reconciliation report is.
4. **Never mutate the Firestore source.** ETL reads only.
5. **Dirty data is surfaced, not silently coerced.** Rows that fail validation go to a
   quarantine table with the reason. Ian decides; the ETL does not guess.
6. **Historical periods are migrated then frozen** — marked read-only so no v2 code
   path can rewrite closed history.
7. **Cutover is dual-run first**: both systems live, v2 shadow-writing, daily
   reconciliation, until the deltas are zero for a sustained period.

---

## 12. Inherited landmines — do not repeat these

Failure modes ERP-rebuild actually hit in production. ERPv2's architecture must make
each one **structurally impossible**, not merely avoided by care.

| # | The failure | How v2 prevents it structurally |
|---|---|---|
| 1 | Two writers on one derived document, drifting apart | §4.2 rule 8: one writer per table; derived data is a view |
| 2 | `merge:true` cannot delete map keys — cleanup ran, reported success, changed nothing | No maps-as-records. Real columns and real rows |
| 3 | Security rules where a nested "stricter" rule is a silent no-op under OR-semantics | Authorization is one server-side module, not a rules DSL |
| 4 | Rules deploy green then silently deny at runtime | Firestore rules in v2 are ~30 lines and covered by tests |
| 5 | Index "deploy complete" != index ready; queries fail after a green deploy | SQL migrations are transactional and verified by a probe query |
| 6 | Admin SDK rejects `undefined`, corrupting a write mid-flight | Normalise `?? null` at the repository boundary |
| 7 | Server-side `toLocaleTimeString` renders UTC — Philippine times off by 8 hours | Banned by lint rule; explicit `Asia/Manila` helper |
| 8 | A rate of `0` treated as falsy/unset, discarding a 100% discount | `== null` checks only; `0` is a value |
| 9 | Widening one operation on a route granted **all** operations on it | Permissions are `(action, resource)` tuples |
| 10 | Deploy shipped with blank env vars because `.env` was gitignored and untracked | `.env.example` committed; build fails fast on a missing required var |
| 11 | Data-level misconfiguration (a disabled child silently voiding a parent grant) with no error surfaced | FK + CHECK constraints; orphan and inconsistent states are unrepresentable |
| 12 | Two switches governed one behaviour; only one was enforced | Single authoritative column; no parallel flags |
| 13 | `next build` clobbered a running `next dev`, producing phantom errors | §8 build discipline |
| 14 | Offline punches dead-letter silently; no in-app reconciliation UI, recovery is "tell a manager" | Inbox quarantine is a first-class screen, alertable, with a defined operator action (§5.4 rule 5) |
| 15 | Attendance kill-switches not cached offline — terminal keeps accepting a disabled credential method, rejection surfaces only at sync | Store attendance config is hot-set item 3, priority refresh (§5.3) |
| 16 | Hand-rolled IndexedDB queue + sync engine reimplemented platform behaviour, partly wrong | Firestore SDK provides persistence, replay, append semantics (§5.2) |
| 17 | Acting identity is a client-supplied parameter on ~24 server actions; server cannot verify who acted | Server-issued session token; actor read server-side, never accepted as a parameter (§7.1) |
| 18 | Store membership grants read of colleagues' pay rates, salary advances, full ledgers | Field-level authorization; narrow repository projections (§7 rule 10) |
| 19 | Any signed-in user can write into any store's Storage folder | Uploads brokered server-side after `authorize()`; no direct client writes to shared buckets |
| 20 | Passcode HMAC secret falls back to a public value when unset — fails open | Secrets fail closed; missing secret aborts startup (§7 rule 9) |
| 21 | Post-punch cooldown enforced in UI only, not server-side | Every temporal guard is a server/DB constraint; UI is a courtesy |
| 22 | Punch authorized by bearer `matchToken` alone, no server-side re-verification | Device-bound session + server-side token verification on ingest |
| 23 | Biometric templates were exfiltratable via the offline bundle (face, fixed 2026-07-04) | Face permanently excluded; fingerprint mirror readable only by a device identity (§5.3) |
| 25 | **Money is plain `float` everywhere**, rounded half-away-from-zero at *every incremental write* to fight drift | `numeric` in Postgres; exact by construction; no rounding on intermediate steps (§6) |
| 26 | Four coexisting date idioms — one Manila-pinned, one with no TZ pinning at all, one using local `toLocaleDateString` | One datetime module, one `Asia/Manila` helper, lint-enforced (§6) |
| 28 | **`balancer.ts` treats a single-leg entry as "trivially balanced"** — the hole that let the nominal ledger go missing | Minimum two lines per entry as a CHECK constraint; no bypass, ever (§16.1) |
| 29 | Income statement is a hand-maintained scan list; a new P&L account is silently invisible until someone adds a block | P&L is `GROUP BY account_type` over `journal_lines` (§16.0) |
| 31 | **`inferAccountNature` silently defaults to DEBIT** — it checks 7 credit prefixes and one explicit debit; every other prefix falls through with no allow-list, so a typo'd or new prefix misclassifies with no error | `normal_balance` is a declared NOT NULL column on the account; nothing is inferred from a name |
| 32 | `asset__due_from_*` / `liability__due_to_*` exist only via an incidental partial merge-write — no seed, no label, no `tracksBalance` | Accounts are rows created deliberately; a posting to a non-existent account is an FK violation |
| 33 | Depreciation, amortisation and online-order expenses post **both** a journal leg **and** a paired expense document — the doc is what the P&L reads, the journal leg is trial-balance plumbing | One representation. The journal *is* the P&L source (§16.0) |
| 34 | `expense__loss_on_disposal` is posted but surfaced on no report — **asset write-offs never reduce reported net income** | P&L is a query over account type; nothing can be posted yet invisible |
| 35 | A branch is modelled as an AR customer, inflating receivables and sales | Inter-store uses due-from/due-to reciprocals that eliminate |
| 36 | `commissary_receive` is dead at the financial layer but **name-collides** with a live inventory-ledger source type of the same string | Source types are a shared enum, unique across domains |
| 30 | Debit/credit derived at read time from a hardcoded account-name-prefix table | Stored explicitly as `debit`/`credit` columns; nature is a declared account property (§16.3) |
| 27 | Cross-store money movement is a **fake distributed transaction** — two best-effort writes tied by a deterministic id, plus a repair tool | One real ACID transaction; both stores are rows in one database |
| 24 | Docs drifted from code — `ACTION_POLICIES.md` still documents a capability removed 2026-08-06 | Bible is amended in the same change that alters behaviour (§14); parity scoping reads code, not stale docs |

**Rule: when a v2 bug is found, it gets a row in this table and a structural fix — not
just a patch.**

---

## 13. Decision log

| # | Date | Decision | Rationale | Reversible? |
|---|---|---|---|---|
| 1 | 2026-08-22 | PostgreSQL as system of record | Transactions, constraints, real reporting | No — foundational |
| 2 | 2026-08-22 | Firebase retained only as offline edge cache | Preserve working offline clock without keeping Firestore as truth | Hard |
| 3 | 2026-08-22 | Drizzle ORM over Prisma | SQL-first, no binary engine, cleaner Next.js bundling | Yes, at cost |
| 4 | 2026-08-22 | Firebase Auth retained as IdP; roles move to Postgres | Staff accounts and APK flows already work | Yes |
| 5 | 2026-08-22 | Port 9008 / Postgres 5433 | No collision with the seven existing repos | Yes |
| 6 | 2026-08-22 | Port the UI layer, rewrite the data layer | Preserves years of edge-case work; forces discipline where it matters | No |
| 7 | 2026-08-22 | Two-lane Firestore contract (mirror / inbox), no third kind | Eliminates the dual-writer bug class by construction | No |
| 8 | 2026-08-22 | Attendance/offline is Phase 2, not last | It is the thesis of the project; prove it early | Yes |
| 9 | 2026-08-22 | PostgreSQL over the MariaDB named in `ERP-rebuild/docs/MARIADB_REBUILD_PLAN.md` | Materialised views, transactional DDL, RLS. See ADR-001. **Open to Ian's override — Frappe/ERPNext runs on MariaDB** | Cheap before Phase 1, expensive after |
| 10 | 2026-08-22 | Firestore two-lane model **replaces** v1's hand-rolled IndexedDB queue + sync engine | v1's offline is IndexedDB, not Firebase; the SDK gives persistence/replay/append for free | Yes |
| 11 | 2026-08-22 | Clock terminal uses the Firestore **client SDK**, never Server Actions | A Server Action cannot run offline; this is why v1's Firestore cache was inert | No |
| 12 | 2026-08-22 | Face templates permanently excluded from the hot set | Upholds v1's 2026-07-04 biometric-exfiltration fix | No |
| 13 | 2026-08-22 | Biometric mirror readable only by a provisioned device identity | Store-membership scoping would recreate the exfiltration risk | No |
| 14 | 2026-08-22 | One `person` spine; acting identity from a server-issued token only | v1 accepts actor as a client parameter on ~24 actions — attribution is unverifiable | No |
| 15 | 2026-08-22 | Attendance config joins the hot set (new capability, not a port) | v1 gap: terminals accept disabled credential methods offline | Yes |
| 16 | 2026-08-22 | §0 standing directive: Ian sets WHAT, Claude owns HOW; brainstorm + industry standard first; push back hard | Ian's explicit instruction | No |
| 17 | 2026-08-22 | §1.1 parity contract: behaviour fixed, data handling free if durable + scalable + secured | Ian's explicit instruction | No |
| 18 | 2026-08-22 | Do NOT port Firestore document shapes; model the domain properly | Copying them imports the pathology without the platform that forced it | No |
| 19 | 2026-08-22 | Golden-master characterisation tests gate every phase (§15.2) | The only way to redesign the data layer and *prove* behaviour did not move | No |
| 20 | 2026-08-22 | Strangler Fig with per-module feature flags; no big-bang cutover (§15.3) | Big-bang rewrites of live production systems are the best-documented failure mode in the industry | No |
| 21 | 2026-08-22 | No dual-write between v1 and v2 (§15.4) | Silent divergence; one writer per module at any moment | No |
| 22 | 2026-08-22 | Event sourcing / CQRS explicitly rejected; append-only ledgers only (§15.10) | Overkill for a single-business ERP with one operator | Yes |
| 23 | 2026-08-22 | **ERPv2 reframed: an accounting-correctness project, not a DB migration** (§1.1) | Ian: v1 is vibecoded with accounting gaps; correctness is the goal, SQL is the means | No |
| 24 | 2026-08-22 | **SUPERSEDES #17.** Parity splits three ways: workflow FIXED, accounting NOT parity, data handling FREE (§1.3) | Golden-mastering accounting against v1 would certify v1's defects as v2's requirements | No |
| 25 | 2026-08-22 | Accounting oracle is double-entry law, not v1; divergences logged in `ACCOUNTING-DIVERGENCES.md` (§16.2) | v1 is a comparison subject, not a target | No |
| 26 | 2026-08-22 | Target is the midpoint: correct like ERPNext, simple for one business (§16.4) | Ian: ERPNext's structure is superb but overkill; the business is not an empire | No |
| 27 | 2026-08-22 | Header + lines journal model; v1's one-leg-per-doc `direction: in/out` translated, not carried (§16.3) | Standard double-entry; builders remain reusable | No |
| 28 | 2026-08-22 | **Phases resequenced: accounting spine 4→1, attendance 2→4** | Everything posts into the ledger; attendance risk retired by a Phase-0 spike instead | Yes |
| 29 | 2026-08-22 | The ETL doubles as an audit of v1's books (§1.4) | A schema with real constraints rejects exactly the entries that are wrong | No |
| 30 | 2026-08-22 | PH statutory rates are effective-dated data in one module, never inline constants (§16.5) | Historical runs must reproduce their original figures | No |
| 31 | 2026-08-22 | **Root cause identified: v1 has no nominal ledger** (§16.0). Building one is ERPv2's single most important deliverable | Revenue/expense are not journal legs; the P&L is hand-assembled. Most other defects are downstream of this | No |
| 32 | 2026-08-22 | Invariants go from nine to ten: nominal ledger and control accounts split out | Discovery showed v1 lacks both entirely | No |
| 33 | 2026-08-22 | Minimum two lines per journal entry, enforced by CHECK constraint; no single-leg escape hatch | `balancer.ts:64-67` is the hole everything leaked through | No |
| 34 | 2026-08-22 | §16.7 known-defect table is the acceptance criteria for Phases 1–3, not a wish list | Turns diagnosis into testable requirements | Yes |
| 35 | 2026-08-22 | **ERPNext/Frappe migration retired. ERPv2 is the single destination** | Ian: two DBs and two shapes for one project; he knows ERPv2 end to end and cannot work efficiently in ERPNext. Operability by the maintainer is a legitimate criterion | Hard |
| 36 | 2026-08-22 | The invariant suite substitutes for ERPNext's battle-testing, so it is **not optional** | We gave up a track record; constraints + CI + worked examples buy it back | No |
| 37 | 2026-08-22 | Account lifecycle `active` / `reserved` / `archived` (§16.9) — nice-to-haves are reserved, not active | Keeps everything without the miscoding and report-noise cost of unused active accounts | Yes |
| 38 | 2026-08-22 | Per-counterparty GL accounts become **control account + subledger** | v1 has one GL account per supplier/customer; no independent check on the total | No |
| 39 | 2026-08-22 | `normal_balance` is a declared column, never inferred from an account-name prefix | v1's inference silently defaults to debit for any unlisted prefix | No |
| 40 | 2026-08-22 | `POSTING-PATTERNS.md` — one canonical pattern per business event — is a Phase 1 deliverable (§16.10) | Aligning accounts without aligning entries still yields wrong books | No |
| 41 | 2026-08-22 | Inter-store reciprocals must eliminate to zero (invariant 6) | Makes the cross-store transfer verifiable rather than best-effort | No |
| 42 | 2026-08-22 | `staff_reimbursable__` is a **LIABILITY** (2130) — Ian: "we owe to staff, staff own money they spend for business needs" | Confirms a live misclassification: it sits on the asset side today because nature defaults to debit | No |
| 43 | 2026-08-22 | Revenue splits **dine-in unli / dine-in à la carte / take-out**; delivery is a mode of take-out, not a channel. Beverage splits alcoholic / non-alcoholic | Ian's actual sales model. Unli is a different economic product — fixed price, variable consumption — and its margin is the key business signal | Yes |
| 44 | 2026-08-22 | **`channel_id` added as a second dimension** (nullable, revenue and channel-fee lines only). AMENDS §16.4 | Per-channel P&L without multiplying revenue accounts; platform fees differ per channel | Yes |
| 45 | 2026-08-22 | Points and vouchers are **contra-revenue**, not tender. Voucher accounts `reserved`; 2145 Unredeemed vouchers reserved for a future sold-voucher model | Ian: earned and redeemed as discount; selling is a maybe, later | Yes |
| 46 | 2026-08-22 | **Payroll moves to standard accrual with a draft pay run.** Expense + employer contributions posted on approval; payout clears the liability. Cash out before approval is an advance (1235) | v1 parks gross against a liability that then carries a debit balance. The 3-day settle is a draft-state problem, not an accounting-model problem — and Ian wants the system to shorten that cycle | Yes |
| 47 | 2026-08-22 | `expense__tax` → 6800 Taxes and licences; permits are non-VAT-able so no input VAT | Ian: mostly permits | Yes |
| 48 | 2026-08-22 | `loss_on_disposal` → 7400, on the P&L | Ian: yes. Write-offs have never reduced reported net income | No |
| 49 | 2026-08-22 | **Statutory obligations get a subledger, aging report, and a dashboard tile beside cash** (§16.5) | Ian asked how unremitted SSS/PhilHealth/Pag-IBIG would be tracked. v1 books none of it, so the obligation exists in law but nowhere in the books — unremitted withholding looks like free cash | No |
| 50 | 2026-08-22 | COGS categories map to an **(inventory account, COGS account) pair**, not one expense account | Purchase and consumption are different events; this is what puts stock on the balance sheet | No |
| 51 | 2026-08-22 | Interest expense and loss on disposal reclassified **out of OPEX** into other income/expense | They are not operating costs; improves comparability of operating margin. Net income unchanged | Yes |
| 52 | 2026-08-22 | Catch-all categories are kept but their **share of spend is reported** | Forcing spend into wrong-but-specific categories is worse; the fix is visibility, not removal | Yes |
| 53 | 2026-08-22 | **The four verbs** — duplicate what's good, correct what's wrong, add what's missing, delete what's not needed and redundant (§1.2) | Ian's standing rule. Relaxes strict workflow parity: v2 is not a pixel-copy of v1 | No |
| 54 | 2026-08-22 | **v1 is owned by someone else** — read-only, findings reported never acted on (§1.2a) | Ian: "don't touch v1, it belongs to him alone and Frappe" | No |
| 55 | 2026-08-22 | DELETE authority split: redundant *implementation* is Claude's call, removing a *user-facing capability* is Ian's | "How" vs "what" (§0.1) | No |
| 56 | 2026-08-22 | Reference data: migration-owned idempotent seeds + `is_system` + **UNIQUE on normalised identity** (§4.4) | Answers the duplicate-Rent question. A constraint prevents duplicates; hardcoding does not | No |
| 57 | 2026-08-22 | Owner drawings is an **ADD**, not a port — 3200, reducing equity | Ian: never used, so design it right | No |
| 58 | 2026-08-22 | **Skills are lenses, not assurance** (§15.12). Use `accounting-systems`; never install an unvetted skill as a correctness control | A skill cannot catch a wrong number; only a test can. False confidence is worse than none | No |
| 59 | 2026-08-22 | `accounting-systems` is invoked **before** writing any posting pattern | It independently confirmed the staff-reimbursement liability call and added 10 rules we had missed | Yes |
| 60 | 2026-08-22 | Adopted from the skill: single period-assignment rule, single aging basis, no unallocated payments, duplicate-invoice detection, WHT at posting, variance to suspense, void≠reverse, 3-stage cash-advance lifecycle | Standard controller practice | No |
| 61 | 2026-08-22 | **SUPERSEDES the Cloud SQL recommendation.** Infrastructure = **Option B**: DO Managed Postgres + app on the existing SharEat-Droplet, both SGP1, same private VPC | Ian challenged the cost and was right. The droplet (4 GB/80 GB) is already paid for and adequate; Spaces already exists for backups; co-location gives private networking that a GCP-app/DO-db split cannot (App Hosting has no static egress IP). ~$15/mo new vs ~$25–40 | Yes |
| 62 | 2026-08-22 | **NEVER BUILD ON THE PRODUCTION DROPLET** — §2 rule 10, §8 Rule 1, and `CLAUDE.md` | 4 GB box runs the app; a Next.js build OOMs it. Build once, deploy many; the production host is not a build machine | No |
| 63 | 2026-08-22 | ERP availability requirement is **lower than assumed** — POS and the customer app are independent, so ERP downtime costs back-office time, not revenue | Argues against over-engineering HA. Does **not** relax durability | Yes |
| 64 | 2026-08-22 | Frappe/ERPNext backups in `shareat-erp-backups` are **retained**, Postgres backups go to a separate prefix, no expiry rule | They are the only remaining record of the ERPNext work and may serve as a migration reference | Yes |
| 65 | 2026-08-22 | **PostgreSQL forbids DEFERRABLE on CHECK constraints.** Balance + minimum-two-lines must be a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`; per-row rules stay immediate CHECKs | Balance is inherently multi-row — an entry is legitimately unbalanced after its first line and need only be correct at COMMIT. Caught by the walking-skeleton test before Phase 1 was built on it | No |
| 66 | 2026-08-22 | `esbuild` pinned via `overrides` to a single version | Two versions forced a nested copy whose platform-specific optional packages lost their `optional` flag, breaking `npm ci` on Linux | Yes |
| 67 | 2026-08-22 | Money crosses the wire as a **string**, computed in integer centavos; `moneyFromLegacyFloat()` is the ETL-only escape hatch and **flags** every ambiguous source value | Reproduce v1's figure, surface the doubt (§11 rule 5) | No |
| 68 | 2026-08-23 | **Local Postgres port 5433 → 5435. Supersedes row 5** (port 9008 is unchanged) | Row 5 assumed 5433 was free. On Ian's machine it is bound by `amianai-postgres` (the AGENCY stack, `postgres:16-alpine`, Docker). The *reasoning* in row 5 was right — avoid the default 5432 so no other Postgres is disturbed — only the number was wrong. 5435 verified free alongside 5432/5436 | Yes |
| 69 | 2026-08-23 | ~~Local Postgres major version pinned to **16**~~ — **superseded by row 70 the same day** | CI pins `postgres:16` and §4.1 specifies 16; HANDOFF §3a said "likely 17". Installing 17 locally would have made dev diverge from CI — the exact class of bug §3a exists to prevent. The DO Managed cluster must also be created as 16 | Superseded — see row 70 |
| 70 | 2026-08-23 | **PostgreSQL 18 project-wide (local + CI + DO). Supersedes rows 69 and §4.1's original 16** | Row 69 treated CI's `postgres:16` as a constraint; it was only the scaffold-time default, and §4.1's rationale (transactions, constraints, `numeric`, window functions, partial indexes, matviews) is satisfied by every version from 16 up — so nothing actually pinned 16. **18 earns the change on its own merits: native `uuidv7()`**, which §4.2 rule 1 wants for primary keys and which 16 needs an extension or app-side generation to provide. DigitalOcean Managed Postgres supports 18, so local == CI == prod holds. Cost is one line in `ci.yml` and some docs, because no schema or data exists yet | Yes, until Phase 1 data exists — then expensive |
| 71 | 2026-08-23 | Firebase Admin credentials are **required in production only**, until the auth bridge lands (T-006) | `env.ts` hard-required them, contradicting HANDOFF §4's promise that Firebase can stay blank, and blocking local dev and `/api/health` on credentials **no code path reads**. §7 rule 9 is about secrets that are *used* failing closed — not about demanding unused ones. Production stays hard-required via `superRefine`, and eight tests now assert both halves | Yes — reverts naturally at T-006 |
| 73 | 2026-08-23 | **Beverage is ONE account (4400).** The 4410/4420 alcoholic split is withdrawn | Ian: one lump-sum record. §1.1 — carry no generality the business does not have. POS aggregates `addonSalesAmountByCategory`, so a later split is a reporting change, not a re-migration | Yes |
| 74 | 2026-08-23 | `comps` are **contra-revenue** (4950), not marketing expense | Ian, confirmed | Yes |
| 75 | 2026-08-23 | **ERPv2 is a management ledger, not a statutory filing basis. VAT is a label, not a tax engine** | Ian: the business is VAT-registered but reported sales are not all sales; this ERP is internal-use only and not VAT-compliant. Consequences: no VAT engine, no output-VAT liability accounts, no BIR report builders; SC/PWD discounts are plain contra-revenue into 4900; v1's dormant `vatableSales`/`outputVatAmount` fields are NOT migrated. §16.5's PH rules narrow to payroll statutory, which is real and does post. **ERPv2 must never be labelled or exported as BIR-ready output.** A statutory basis, if ever needed, is a separate reporting layer over the same ledger — not a retrofit of these accounts | No — shapes the whole chart |
| 76 | 2026-08-23 | **`docs/CROSS-APP-MAP.md` is a living document**, maintained as work touches each seam between POS / ERP / CUSTOMER / Website | Ian: document every finding and connection across the apps, we will touch them one by one. The POS→ERP sales feed alone carries two semantics that are wrong if assumed (`dineInSales` = package only; `takeOutSales` = residual) | No |
| 72 | 2026-08-23 | `/api/health` reports configuration and database failures **separately** | It caught every error and reported `database: unreachable`. A missing Firebase variable was therefore blamed on Postgres while Postgres was healthy — the exact misdirection the route's own comment claims to prevent (§15.6). Error text is returned outside production only; the endpoint is unauthenticated | Yes |

---

## 14. Amendment protocol

This file is **maintained, not written once.**

- **Who may amend:** Opus, in planner role. A Sonnet implementer never amends it — it
  reports a conflict and stops.
- **When to amend:** any architectural decision, any addition to the hot set (§5.2),
  any new landmine (§12), any intentional divergence from ERP-rebuild, any phase
  change.
- **How to amend:**
  1. Edit the relevant section.
  2. Add a row to §13 with the date and rationale.
  3. Bump **Version** and **Last amended** in the header.
  4. Say in the report to Ian, in plain language, what rule changed and why.
- **Never** delete a decision from §13. Supersede it with a new row that references it.
- **Conflict resolution:** bible > task spec > convention carried over from
  ERP-rebuild > a model's own preference. When in doubt, stop and ask Ian.

---

## 15. Engineering standards — the industry practices this project follows

Per §0.2, boring and standard wins. These are the named, established practices ERPv2
adopts. Deviating from one requires an ADR.

### 15.1 Build order: walking skeleton first
Before breadth, build **one thin vertical slice end to end** — login → one screen →
one table → one write → one report → one deploy. Prove the whole spine works, then
widen. Never build a layer at a time; a "finished" data layer with no screen on it is
unvalidated.

### 15.2 Golden-master testing — the most important practice here
Re-platforming financial logic without characterisation tests is malpractice.

- Capture **real production inputs and outputs** from ERP-rebuild: journal postings,
  AP/AR aging, payroll runs, stock ledgers, sales-day totals.
- Freeze them as fixtures under `tests/golden/`.
- Replay every one against v2 and assert **exact** equality.
- A golden-master mismatch blocks the phase. No exceptions, no "close enough."

This is what makes the §9 parity gate real instead of aspirational. It also means the
data layer can be redesigned freely (§1.1) with proof that behaviour did not move.

### 15.3 Strangler Fig, not big-bang cutover
Fowler's pattern. v1 and v2 run **side by side**, with routing at the **module**
boundary, feature-flagged per module and per store. A module migrates only when its
golden-master suite is green, and it can be **flipped back in one config change**.

There is never a single terrifying switchover night. Big-bang rewrites of running
production systems are the best-documented failure mode in our industry; ERPv2 does not
attempt one.

### 15.4 No dual-write
Dual-write between two databases is a notorious source of silent divergence. Instead:
**ETL → verify → freeze module in v1 → serve from v2.** One writer at any moment, per
module. (Consistent with §4.2 rule 8.)

### 15.5 Expand/contract migrations
Parallel Change. Add the new column/table, backfill, dual-read, switch, then drop the
old — each as a separate deploy. Never a destructive schema change in one step.
Migrations are forward-only, committed, and never edited after being applied anywhere.

### 15.6 Observability from day zero, not later
v1's defining pathology is **silent failure** — rules that deny quietly, cleanups that
report success and change nothing, dead-lettered punches nobody sees, deploys that ship
blank env vars. That is an observability failure as much as a design failure.

Phase 0 ships: structured logging with correlation ids, error tracking, slow-query
logging, and a health endpoint. Every swallowed exception is a defect. Every background
job reports success **with counts**, never a bare "done."

### 15.7 CI gates
Typecheck, lint, unit, integration, and golden-master run on every push. Red main
blocks merge. No manual deploy steps that a human can forget — v1 has already lost a
feature to a wrong-branch deploy and shipped a build with empty env vars.

### 15.8 Backups and a *tested* restore
Automated Postgres backups with point-in-time recovery, and a **restore rehearsed on a
schedule**. An untested backup is not a backup. This is an ERP: payroll, ledgers, and
statutory records live here.

### 15.9 Twelve-Factor config
Config in the environment, never in code. Startup **validates every required variable
and aborts loudly** if one is missing or empty (§7 rule 9). A committed `.env.example`
is the contract.

### 15.10 Append-only ledgers — but not event sourcing
Ledger, stock-movement, and punch tables are append-only with compensating entries.
That delivers auditability and time-travel where it matters.

Full event sourcing / CQRS across the app is **explicitly rejected** as overkill for a
single-business ERP: it multiplies complexity, and the team is one operator plus AI.
Boring wins.

### 15.11 Defence in depth
Authorization at the service layer (primary), store scoping at the repository layer,
constraints in the schema, and minimal Firestore rules at the edge. No single layer is
trusted alone — but **no layer may be the only one** for a given risk either.

### 15.12 Skills are lenses, not assurance

*Decided 2026-08-22 after Ian asked about installing a "tested and reliable" accounting skill.*

Agent skills (`accounting-systems`, `inventory-systems`, `inspect-financial-flow` — all
already installed at user level) are **genuinely useful and should be used**. They encode a
controller's checklist and they catch things a generalist misses. `accounting-systems` is
invoked before writing any posting pattern.

But be precise about what they are: **a skill is instructions to a model, not a verified
system.** It has no test suite, no track record, and no certification. It cannot catch a
wrong number — only a test can.

**Therefore: never treat an installed skill as an assurance control.** Installing an
unvetted third-party accounting skill and trusting it would repeat the exact mistake ERPv2
was created to avoid — adopting something whose correctness cannot be verified in
operation. An authoritative-sounding but wrong accounting skill is **worse than none**,
because it manufactures false confidence.

What actually buys reliability, in order (see decision #36):

1. The ten invariants as database constraints and CI tests — wrong entries become
   *impossible*, not merely discouraged.
2. Hand-computed worked examples, written **before** the implementation.
3. **Review by a human accountant** of the chart of accounts and posting patterns.
4. Reconciliation against real historical data.

Use the skills. Don't outsource confidence to them.

### 15.13 Reconciliation is a permanent feature
The reconciliation reports built for ETL (§11) do not get deleted after cutover. During
the strangler period they run **daily**, comparing v1 and v2 on the same date range, and
surface deltas. Reconciliation is how you find out you are wrong before the business does.

---

## 16. The accounting spine

This is the heart of ERPv2 (§1.1). It is written before any schema so that every other
module is built to post into a ledger that is already correct.

### 16.0 What we are actually fixing — the diagnosis

`docs/discovery/06-accounting-gaps.md` found the root cause, and it is bigger than a set
of bugs. **ERP-rebuild does not have double-entry bookkeeping.** It has a partial
balance-sheet ledger plus a hand-assembled income statement.

The mechanism, precisely:

1. A journal "entry" is **one leg per document** (`journal-writer.ts:33-56`) — one
   `accountId`, a `direction: 'in'|'out'`, an amount. There is **no header document**;
   a transaction is just several docs sharing a `sourceType:sourceId` prefix.
2. Debit/credit is **never stored**. It is derived at read time from a hardcoded
   account-prefix table.
3. **`balancer.ts:64-67` defines a single-leg entry as "trivially balanced."** That is
   the hole. It is not an edge case — it is used routinely.
4. Consequently, ordinary expenses and sales post **only the balance-sheet side**
   (cash / AP / online). **There is no revenue or expense leg at all.**
5. So the P&L cannot be derived from the ledger. The Income Statement is a **hand-
   maintained union** of an `expenses` document scan plus five-plus separately bolted-on
   journal-account scans. **Every new P&L account requires someone to remember to add a
   scan block, or it is silently invisible to the P&L.**

This was a deliberate build-cost decision, documented in `ACCOUNTING_BLUEPRINT.md §5.6`.
The decision was recorded; its consequence was not — it has already produced one
confirmed double-count (platform fees) and at least one unaudited gap.

**Therefore the single most important thing ERPv2 builds is a real nominal ledger.**
Revenue and expense become actual journal legs. The income statement becomes a
`GROUP BY account_type` over `journal_lines` — a query, not a maintained list. Almost
every defect in the discovery report is downstream of this one design choice, and fixing
it structurally retires them as a class rather than one at a time.

### 16.1 The ten invariants — non-negotiable

These are not preferences. They are what makes a set of books *books*. Each is enforced
by a database constraint or a test that runs in CI, never by convention.

1. **Every journal entry balances.** Σ debits = Σ credits, to the cent, enforced at
   commit. An unbalanced entry cannot exist.
   **There is no "trivially balanced" single-leg escape hatch.** A minimum of two lines
   per entry is a CHECK constraint. This one rule closes the hole described in §16.0;
   do not add a bypass for convenience, for migration, or for "simple" transactions.
   Every economic event has at least two sides — if you cannot name the second one, the
   transaction is not understood yet.
2. **A complete nominal ledger exists.** Revenue and expense accounts are real, posted
   journal lines — never derived from a source-document scan. The income statement is a
   query over `journal_lines`, so a new account appears in the P&L automatically and
   cannot be silently omitted.
3. **The general ledger is the single source of truth.** All financial reporting derives
   from journal lines. No parallel writable balance is authoritative. (v1 maintains
   incrementing balance documents — that is a cache in v2, derived and rebuildable.)
4. **Every posting traces to a source document.** No orphan entries. `journal_entries`
   carries a typed reference to the expense, receipt, payment, sales day, pay run, or
   stock movement that caused it.
5. **Posted entries are immutable.** Corrections are reversal entries, never edits.
   Applies uniformly across every module — v1 is inconsistent here.
6. **Real control accounts exist, and subsidiary ledgers reconcile to them.** AR detail
   total = AR control balance; same for AP and inventory. v1 has **no control accounts** —
   `ap__{supplierId}` *is* the ledger account, so "AP total" is just their sum with
   nothing to check it against, and the AP figure drifted for months unnoticed.
   Checked continuously, not at year end.
   **Reciprocal elimination:** total *Due from related store* across all stores must equal
   total *Due to related store*. If they do not net to zero, an inter-store transfer went
   missing. This is the invariant that makes the cross-store transfer safe once both
   stores are rows in one database.
7. **Fiscal periods close and lock — on every posting path.** No posting into a closed
   period by any code path, including inventory, production, migrations, crons, and admin
   tools. (In v1, 11 of 17 inventory/production paths have no period guard at all.)
8. **Accounts have a type and a normal balance.** Asset / Liability / Equity / Income /
   Expense, with debit-or-credit normal side declared and used by reporting.
9. **The accounting equation holds.** Assets = Liabilities + Equity, continuously.
10. **The trial balance always ties.** A one-query check that must pass at any moment.

*(Ten now, not nine — the nominal ledger and the control-account requirements were split
out once discovery showed v1 lacks both entirely.)*

### 16.2 The oracle: how "correct" is tested

Per §1.3, accounting correctness is **not** validated against v1. It is validated against
the invariants above:

- **Invariant suite** — the ten, as executable assertions, run in CI against the full
  dataset. Any violation is a build failure.
- **Property-based tests** — generate random valid transactions; assert the books still
  tie. This catches classes of error that example-based tests miss.
- **Worked examples** — a set of hand-computed scenarios (a purchase on credit, a partial
  payment, a void, a discount, a wastage write-off, a payroll run) with the expected
  postings written out by hand, in advance.
- **v1 comparison** — run the same period through both. Differences are **findings to
  investigate**, logged in `ACCOUNTING-DIVERGENCES.md`, never auto-resolved in v1's favour.

### 16.3 The model — header + lines, not legs

```
  accounts            id, code, name, type, normal_balance, parent_id, is_postable
  fiscal_periods      id, org_id, starts_on, ends_on, status(open|closed|locked)
  journal_entries     id, org_id, store_id, entry_date, period_id, memo,
                      source_type, source_id, status(draft|posted|reversed),
                      reversal_of_entry_id, posted_at, posted_by
  journal_lines       id, entry_id, account_id, debit, credit, store_id,
                      line_memo, CHECK (debit >= 0 AND credit >= 0
                                        AND (debit = 0) <> (credit = 0))
```

- **Balance is enforced at entry level**, in the same transaction that writes the lines.
- **`store_id` on the line**, not only the entry, so store-level P&L is a `GROUP BY`
  rather than a separate ledger per store.
- v1's `direction: in/out` single-leg-per-document model is **translated, not carried
  over**: the pure journal builders in `src/lib/financial/journal/builders/` are reusable
  after mapping in/out to debit/credit via each account's normal balance.
- Balances, aging, and statements are **views or materialised views** over
  `journal_lines`. Never hand-maintained rows (§4.2 rule 7).

### 16.4 Deliberately simpler than ERPNext

Omitted unless and until a real business need appears. Each is a decision, recorded so
nobody re-litigates it or "helpfully" adds it back:

| Omitted | Instead |
|---|---|
| Multi-currency, FX revaluation | PHP only |
| Multi-company consolidation | One org, `organizations` table reserved for the second entity |
| Cost centres, projects, arbitrary accounting dimensions | Exactly **two** dimensions: `store_id` (on every line) and a nullable `channel_id` (revenue and channel-fee lines only). No dimension framework, no third dimension without an ADR |
| Configurable tax engine / tax templates | PH VAT written directly as code (§16.5) |
| Serial/batch tracking, landed-cost vouchers, multiple valuation methods | Weighted average, per item per location |
| Full BOM/MRP | The existing recipe/production model, simplified |
| Workflow engine, custom doctypes | Fixed status enums and explicit code |
| Budgeting and variance modules | Existing budget feature only |
| Payment-terms schedules, dunning, credit scoring | Due date + aging buckets |

**Rule:** adding any of these back requires an ADR naming the business need. "It might be
useful later" is not one.

### 16.5 PH-specific rules — isolated, versioned, dated

VAT (12%, VAT-exempt, zero-rated), senior-citizen and PWD discounts, withholding tax,
SSS/PhilHealth/Pag-IBIG contributions, 13th-month, holiday and night-differential rules
live in **one rules module**, separate from posting logic.

- Rates are **effective-dated data**, never inline constants — statutory tables change,
  and historical runs must keep reproducing their original figures.
- A recomputation of a past period must use the rates in force **then**, not now.
- Each rule cites its statutory basis in a comment.

#### Statutory remittance tracking — recording an obligation ≠ settling it

*Raised by Ian, 2026-08-22: "what if the Pag-IBIG / SSS / PhilHealth is recorded but never
remitted to the agency, say an unforeseen event? No float, no way to track it?"*

**This is the single strongest argument for the statutory liability accounts, and v1 has
none of them.** Today the employee share is deducted from net pay and the employer share is
not booked at all — so the obligation exists in law but **nowhere in the books**. The cash
simply stays in the bank looking like yours.

The accrual model separates the two events, which is the whole point:

| Event | Posting |
|---|---|
| Withhold employee share | **Cr** 2210/2220/2230 statutory payable |
| Employer share | **Dr** 6110/6120/6130 · **Cr** 2210/2220/2230 |
| **Remit to agency** | **Dr** 2210/2220/2230 · **Cr** cash |

**If you never remit, the liability sits there and grows.** That is the feature, not a
gap. The balance of 2210 at any moment *is* what you owe SSS. It is on the balance sheet,
it is visible, and it ages.

**The danger it protects against:** unremitted statutory withholding *looks* like cash in
the bank, but it is money held on someone else's behalf. A business can feel liquid while
being deeply behind on statutory obligations — and it typically surfaces a year later as a
lump sum plus penalties. Employee-share amounts are held in trust; in the Philippines
non-remittance of withheld SSS contributions carries penalties and personal liability for
responsible officers under RA 11199. **Not legal advice — but it is why this must be
visible, not merely recorded.**

**Design consequence — a subledger, not just a balance.** A single account balance answers
"how much do we owe" but not "for which months, and how late." So statutory obligations
follow the same control-account-plus-subledger pattern as AP:

```
statutory_obligations
  agency (SSS | PhilHealth | Pag-IBIG | BIR)
  period                    -- the month it relates to
  employee_share, employer_share, total_due
  due_date                  -- per-agency statutory deadline
  remitted_on, remitted_amount, reference_no
  status (unremitted | partial | remitted)
```

Requirements this creates:
1. **Aging report** on unremitted obligations, per agency, oldest first.
2. **A dashboard tile**: total unremitted, and the age of the oldest — alongside cash, so
   the two are read together. Cash that is really someone else's should never look free.
3. **Due-date awareness** per agency, with a warning before the deadline.
4. **Penalty accrual** once overdue, so the true cost is on the books rather than
   arriving as a surprise.
5. **Partial remittance** must be representable — real catch-up payments are partial.
6. The subledger total must reconcile to the control account (invariant 6).

Phase 5 delivers this. The **accounts** land in Phase 1 so nothing has to be retrofitted.

### 16.6 What v1 already gets right — preserve the intent

Discovery (`docs/discovery/03-business-logic.md`) found real, hard-won correctness in v1.
These are **not** vibecoded, they encode genuine business rules, and v2 must carry the
*intent* forward even though the implementation changes:

- **Void is terminal everywhere; corrections are always new records.** Already matches
  §16.1 rule 4. Keep it, and make it uniform.
- **The verified-sales-day lock ships a deliberate exclusion list** (channel AR, payroll,
  channel settlement) so that verification does not self-block. Do not "tidy" this away —
  the exclusions are load-bearing.
- **Channel-settlement fees net as a SIGNED total** — a promo day can legitimately produce
  a credit. Never clamp this at zero.
- **Attendance pay is judged by span delivered, not clock-in time**, with a
  never-reduces-guaranteed-pay invariant. Settled decision; do not re-propose.
- **A paid payroll period is frozen, blocked by period OVERLAP not exact bounds** — the
  stricter and correct test.
- **Purpose-tuned tolerances** (₱1 receipt-closed, ₱1 cash-request auto-close, 0.001 AP,
  0.005 AR). Each fixed a real historical bug. Carry them as named constants with their
  reason (§6), do not collapse them to one global epsilon.
- **Three independent self-dealing blocks**, each with a different exemption shape.
  Preserve all three; unify the *mechanism*, not the policies.
- **One generic admin void/delete endpoint delegates to the same per-collection reversal
  function** normal void uses — preventing partial reversals. Excellent pattern; keep it.

### 16.7 Known defects v2 must fix — the Phase 1–3 requirements list

From `docs/discovery/06-accounting-gaps.md`, ranked by business impact. This is not a
wish list; it is the acceptance criteria for the accounting phases.

| # | Defect | Effect on the books | Fixed in |
|---|---|---|---|
| 1 | **Employer-share SSS / PhilHealth / Pag-IBIG are unbooked entirely** — explicitly "out of scope" in code | A legally mandated cost is missing from every period. **Costs understated, profit overstated** | Phase 5 (schema in 1) |
| 2 | The four statutory-remittance templates have no correct posting path; the generic action would **double-count** already-withheld employee contributions as fresh OPEX | Overstated expense if used | Phase 5 |
| 3 | **Senior / PWD discounts hardcoded to zero** on the live sales-entry path | **BIR VAT-exemption compliance gap** | Phase 2 |
| 4 | Every P&L-only account needs a hand-added income-statement scan block or it is silently omitted | Already caused a confirmed platform-fee double-count | **Phase 1** — retired by the nominal ledger (§16.0) |
| 5 | **No inventory valuation at all** — no `inventory__` account; COGS is purchase-basis (expensed on receipt) rather than consumption-basis; count adjustments have **no GL effect** | **Gross margin is wrong**; stock is not an asset on the balance sheet | Phase 3 |
| 6 | 11 of 17 inventory/production paths have **no period-lock guard** | Stock can post into closed periods | Phase 3 (invariant 7) |
| 7 | Historical channel-settlement fee-drop (OC-31); audit script written but **never run** | Unquantified historical mis-postings | Phase 2 + ETL audit |
| 8 | Self-dealing gates accept a **client-supplied actor identity** and fail open | Segregation of duties is unenforceable | Phase 0/1 (§7.1) |
| 9 | Recurring `hasStoreAccess` omissions — 5+ instances in two months — let managers act cross-store on money-moving actions | Unauthorised cross-store postings | Phase 0/1 (§7 rule 4) |
| 10 | **No AP/AR control accounts**; the AP dashboard tile drifted for months because only 3 of 8+ writers were wired | No independent check on AP/AR totals | **Phase 1** (invariant 6) |

**Note the pattern:** items 4, 8, 9 and 10 are not really separate bugs. They are what
happens when a rule is maintained *by remembering* instead of *by construction*. That is
the thesis of this whole project in one table.

### 16.8 What v1's accounting already gets right

Preserve the intent of all of these (see also §16.6):

- **Two-phase transactional discipline** — all reads before all writes, one transaction
  per business event, no async sync queue. Genuinely good; carry it into SQL.
- **Deterministic, idempotent entry ids.** Keep as the idempotency key (§4.2 rule 10).
- **`reconcileAccounts()` re-derives from the raw journal** rather than comparing one
  projection against another. That is the correct instinct and becomes §15.13.
- **sale ≠ collection ≠ expense ≠ AP ≠ cash**, consistently enforced. This distinction is
  the thing most naive systems get wrong, and v1 gets it right.
- **Park-then-lump-sum payroll model.**
- **Correct PH VAT math** and correct **employee-share** statutory and withholding tables.
- **A dated decision log with rationale** for every business decision. Continue it (§13).

### 16.9 Chart-of-accounts governance — lifecycle, not "create everything"

*Answers Ian's question of 2026-08-22: "can we keep all we are using, and all we have not
yet used but is in the chart of accounts, like nice-to-have?"*

**Yes to keeping everything in use. Not by making everything active.** Accounts have a
lifecycle, and the "nice to have" ones sit in a state that costs nothing until needed.

| State | Postable? | In pickers? | In reports? | Use |
|---|---|---|---|---|
| **`active`** | Yes | Yes | Yes | Accounts actually in use today |
| **`reserved`** | **No** | **No** | **No** | Defined, named, numbered — the nice-to-haves. One flag activates it |
| **`archived`** | No | No | Yes, for historical periods | Was used, has postings, accepts no new ones. **Never deleted** |

**Why not simply make the nice-to-haves active:**

1. **Miscoding.** An unused account in a picker is a wrong entry waiting to happen —
   staff choose the nearest plausible name. Every unused active account is a way to get
   the books wrong.
2. **Unreadable reports.** Dozens of permanently-zero lines make a *meaningful* zero
   invisible. Report noise is a real control weakness, not a cosmetic one.
3. **It reads as weak control.** An accountant or auditor treats a bloated chart of
   accounts as a signal that nobody owns it.

`reserved` gives the full benefit — the account is designed, numbered, documented, and
its place in the hierarchy is settled — with none of the cost. Activating one is a single
flag, not a migration.

**Numbering leaves gaps deliberately.** Codes are assigned so related accounts can be
inserted later without renumbering. Reserving a *range* is how you plan for needs you
cannot yet name; reserving an *account* is how you plan for ones you can.

**Rules:**
- Every account in v1 that has ever been posted to gets a v2 account. Nothing is lost.
  Where it was non-standard, it is **mapped** to the standard account and keeps its old
  id in `legacy_code`.
- An account with postings is **never deleted** — only `archived`. History must stay
  readable.
- New accounts are added when a real transaction needs one, not in anticipation.
- Only leaf accounts are postable. Parents exist to roll up.
- Scale check: a single-entity F&B business is normally well served by **60–120 active
  accounts**. If the active count climbs far past that, something that should be a
  subledger, a dimension, or a store split is being modelled as accounts instead.

### 16.10 Posting patterns — one canonical pattern per business event

Aligning the chart of accounts is only half the job. **The other half is aligning the
entries** — what each business event actually posts.

`docs/decisions/POSTING-PATTERNS.md` is a Phase 1 deliverable and becomes the reference
every module is built against. For each business event it states: the trigger, the debit
line(s), the credit line(s), the VAT treatment, what happens on void, and a worked
numeric example.

**Additional rules adopted from the `accounting-systems` skill, 2026-08-22:**

- **Pick ONE period-assignment rule** — document date, posting date, or user selection —
  and enforce it everywhere. Ambiguity here is how prior-period figures quietly move.
- **Pick ONE aging basis** — invoice date or due date — and be consistent across AP and AR.
- **Payments must name the open items they settle.** No floating or unallocated cash.
  Overpayment goes to a **named** home account (customer credit / supplier advance),
  never to nowhere.
- **Duplicate invoice detection** on supplier + invoice number + date. Warn at minimum.
- **Withholding tax is recognised at invoice posting**, not at payment.
- **Unreconciled settlement variance goes to a clearing/suspense account and is flagged**
  — never silently absorbed.
- **Void ≠ reverse.** Void cancels a document before it has financial effect; reverse
  creates an opposite entry unwinding a posted effect. Both keep the original visible.
- **Cash advance lifecycle is three distinct events:** request (operational, **no GL**) →
  release (creates a staff advance *asset*) → liquidation (converts the advance into
  expenses with receipts, plus returned cash). Enforce liquidation before a new advance to
  the same person, and age unliquidated advances — they are a standing control risk.
- **Reimbursement is expense-first** (staff paid, company owes) and is therefore a
  **liability**; an advance is cash-first and is an **asset**. *This independently confirms
  the §COA-ALIGNMENT call that `staff_reimbursable__` is a liability.*
- **Three-way match** (PO ↔ receiving ↔ invoice) enforced wherever POs exist.

**Events requiring a documented pattern** (minimum set): cash expense · credit expense/AP
booking · AP payment · supplier receipt/delivery · sales day (dine-in unli, dine-in à la
carte, take-out) · discounts (senior/PWD, points, vouchers) · cash remittance · AR charge ·
AR collection · channel settlement with deductions · cash request/release/liquidation ·
reimbursement · salary advance · payroll accrual and payout · employer statutory
contributions · statutory remittance · loan draw and repayment · asset purchase ·
depreciation · prepaid amortisation · inventory receipt · consumption/COGS · wastage ·
count adjustment · inter-store transfer · owner drawings · void and reversal of each.

**Rules:**
- **One pattern per event type.** If two code paths post the same event differently, one
  is wrong. (v1 has real instances of this.)
- A pattern is agreed **before** the module that uses it is built.
- Every pattern names its revenue or expense account explicitly — the omission of the
  nominal leg is precisely what went wrong in v1 (§16.0).
- Changing a pattern after postings exist requires an ADR and a statement of the effect
  on prior periods.

### 16.11 Inventory's accounting integration

Inventory is where operational and financial correctness meet, and where v1's gaps are
most likely to compound.

- Stock movements are the operational truth; **their financial effect posts to the GL in
  the same transaction**. No overnight job, no drift window.
- Valuation is **weighted average**, recomputed on receipt, held per item per location.
- Wastage, usage, transfers, and count adjustments each have **one defined posting
  pattern**, written down before implementation and applied uniformly.
- The inventory control account balance must equal the sum of on-hand valuations —
  invariant 5, checked continuously.

---

*End of bible. If you are an agent reading this: acknowledge the sections that bind
your task, then do exactly what your task spec says and nothing more.*

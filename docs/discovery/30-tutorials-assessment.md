# 30 — Tutorials: assessment (Phase 7 candidate)

> **Read-only pass. No code, no spec, nothing else touched.** Method: `/research-evaluate-propose`
> (RULES §4 row 163 — assess → research → propose, and recommending against is sanctioned), inside
> the discovery method (bible §1.2d): study v1 at source → write down the GOAL → count the live
> data → design v2 against the goal.
>
> **What Ian asked for, 2026-09-07:** *"a feature across the app called tutorial — an on-demand
> walkthrough of how to use the features. It must know that to record an expense a supplier must
> exist first, then a receipt must be recorded and verified. For each tutorial there is a
> prerequisites list, each with its own link to its tutorial."*
>
> ⭐ **AND, mid-assessment, the surface — Ian, 2026-09-07:** *"for the new tutorial we will have a
> questionmark in a circle in every page that needs it — it describes the page and how to use the
> feature."* **This is a WHAT decision (§0.1) and it settles two things this document had open:**
> the reading surface is **per-page, behind a `?` affordance**, not a `/tutorials` index; and the
> content is **descriptive prose about the page**, not only the prerequisite wall-check. §5 and §10
> are rewritten against it; the finding in §6 and the drift evidence in §4.3 are unchanged and
> matter *more* now, not less.
>
> Every count below prints a control before its total (bible §12, the landmine added at v3.11).

---

## 0. Verdict

**Build a smaller version: the derived prerequisite graph, seeded from what already exists — and
do NOT build a tutorial library.**

| | |
|---|---|
| **Verdict** | **Build both halves, per page, behind Ian's `?` — but CO-LOCATE the prose with the code it describes.** The prerequisite half is ~4–6 days and mostly already written. The prose half is real work Ian has now asked for; where it *lives* is the one decision that determines whether it is still true in a year. |
| **The stated reason** | ⛔ **Holds as a need, but its worked example is factually wrong about v2** — and that is the most useful thing in this document. See §6. |
| **What already exists** | The pattern is implemented **three times**: v1's `STORE_SETUP_STEPS`, v2's `storeReadiness`, v2's `CUTOVER_STEPS`. None of them is reachable as a tutorial. |
| **What is genuinely missing** | **A reading surface.** v1's own UI tells a manager to go and read a file *in the source repository*. |
| **Cost** | Graph: **4–6 days**, no migration. Per-page prose behind the `?`: **+0.5–1 day of engineering** and **~20–40 minutes of writing per page**, paid per page rather than all at once. |
| **What gets worse if never built** | A new manager at store 8 learns the order of operations by hitting errors. That is the current design and it is survivable — which is why this is a Phase 7 candidate and not a defect. |

⛔ **The one thing I would not do at any price is v1's answer**: a 1,891-line prose manual in a
separate `docs/` tree as the source of truth. It exists, it drifted, and an AI assistant repeated
the drift to cashiers as fact (§4.3). ⭐ **Ian's `?` does not require that mistake** — the same
prose, held beside the code it describes and rendered from there, is the whole of the difference
between v1's outcome and a good one.

---

## 1. What exists at source

### 1.1 v1 — three different things wearing similar names

⚠️ **`onboarding` in v1 is not this feature and must not be read as prior art for it.**
`ERP-rebuild/src/types/onboarding.ts:6` defines `OnboardingDocKind = 'handbook' | 'rules' |
'training' | 'menu' | 'other'` with exams, per-staff progress rows and acknowledgement tracking.
That is a **staff HR training library** — content *about the restaurant*, for employees. Ian's
tutorial is content *about the software*, for its operators. Different audience, different goal,
different lifecycle. Ian's 5 Sep decision to collapse the five kinds into one linear gated track
is a decision about that HR library, and it does not carry over here.

**The real prior art is `ERP-rebuild/src/lib/stores/store-readiness.ts` (247 lines)**, and its
header states the goal better than I could:

> *"THE registry of what a store needs before it can trade… the single source of truth for three
> things that must never disagree: the Store Setup checklist on `/admin/stores/[id]`, the
> server-side gate that refuses to mark a store `active`, and the human-facing guide at
> `docs/NEW_STORE_SETUP.md`."*
> — `store-readiness.ts:3-11`

Its `StoreSetupStep` (`:41-53`) carries exactly the fields Ian described:

| field | what it is |
|---|---|
| `key`, `label` | identity |
| `why` | *"Why it matters, in one sentence. Shown in the UI and mirrored in the guide."* |
| `satisfaction` | `'auto'` (a defined default exists) / `'manual'` (a real business fact) |
| `requiredForActive` | blocking |
| `href` | ⭐ *"Where a human goes to do it."* |
| `doc` | ⭐ *"Anchor in docs/NEW_STORE_SETUP.md"* |

**Measured: 12 steps, 9 carrying an `href`, 12 carrying a `doc` anchor**, against a 168-line guide.
The file even states the maintenance contract — *"When a feature needs something configured per
store, add an entry here and a matching section to `docs/NEW_STORE_SETUP.md` (same `doc` anchor)"*
(`:19-21`).

### 1.2 ⛔ And here is the gap, in v1's own words

The guide that the registry links to **is a file in the git repository**, and the application says
so to the user's face:

```tsx
// ERP-rebuild/src/components/admin/StoreSetupSection.tsx:95-99
Full guide: <code …>docs/NEW_STORE_SETUP.md</code> in the repo.
```

```ts
// ERP-rebuild/src/lib/actions/store.actions.ts:44
`Open Store Setup on this page to finish, or see docs/NEW_STORE_SETUP.md.`
```

⭐ **A manager cannot open a file in the repository.** v1 built the registry, the predicates, the
`why` prose and the anchors — and then pointed the reader at something only a developer can read.
**That, precisely, is the hole the tutorial feature exists to fill**, and it is a delivery gap, not
a modelling one.

### 1.3 v2 — the same pattern, implemented twice more, still with no reader

**(a) `storeReadiness`** — `packages/domain/src/stores/service.ts:330-400`. Four checks (`room`,
`adminScope`, `salesChannel`, `signIn`), each with `ok`, `kind: 'auto' | 'manual'`, `blocking`, and
a `detail` sentence. Derived on read and never stored, per **bible §13 row 176** — *"everything
that depends on the real world is a DERIVED CHECKLIST, never a stored status"*.

⚠️ **The port dropped the two fields that made v1's version a tutorial.** `ReadinessCheck`
(`:312-321`) has **no `href` and no `doc`**. The remedy survived only as prose inside `detail`:

> `'…Add one under Settings › Sales channels.'` — `service.ts:381`

A sentence naming a screen, where v1 had a link to the screen *and* a link to the guide. Nothing
was decided here; it was simply not carried across.

**(b) `CUTOVER_STEPS`** — `packages/domain/src/cutover/steps.ts`. **12 steps**, described in its own
header as *"A pure declaration, so the ordering and the gates can be reasoned about — and tested —
without a database. `index.ts` is what asks the ledger whether each one holds."* (`:4-6`). It
carries `kind: 'verified' | 'attested' | 'performed'`, `perStore`, `cannotVerifyHere`, and a `why`
that is **explicitly marked user-facing copy**:

> *"⚠️ USER-FACING COPY, rendered on the wizard. Plain prose only — no ⭐/⚠️/⛔ markers, which are a
> convention for readers of this source and read as noise to somebody doing a stock count. Found
> the hard way: they shipped to the screen and were spotted by looking at it."* — `steps.ts:18-22`

⭐ **That is the tutorial architecture, already shipped, for one domain** — a declared registry, a
live evaluator, gates between steps, and prose written for the reader rather than the author.

**(c) Two more prose surfaces already exist.** `apps/erp/src/components/nav.tsx` (58 `href` entries)
carries *relationships between features* in its comments — *"Beside Channel settlements on purpose:
that screen creates the receivable, this one ends it"*. And `apps/erp/src/app/settings/page.tsx:16`
records the rule *"Every card carries a sentence saying what changes there, not a category label."*

### 1.4 Every sibling system — searched, nothing found

Per this skill's own correction (finding nothing in the incumbent is not evidence): **POS**,
**CUSTOMER** and **Shareat Website** were searched for `tutorial|onboard|help|guide|tour` surfaces.
**Nothing.** The one POS hit is `forecast-helpers.ts`, a substring false positive. No tutorial
capability exists anywhere in the business's software except v1's, described above.

---

## 2. The goal, written down (bible §1.2d step 2)

Synthesised from `store-readiness.ts:3-30` and v1's UI copy, because neither states it in one line:

> **A person who has never done this task before should be able to find out, from inside the app,
> what must already be true before it will work, whether it is true right now, and where to go to
> make it true.**

Three parts, and they are separable — which is what makes a smaller version possible:

1. **the order of operations** (what must be true first) — a declaration;
2. **the current state** (is it true *here*, *now*) — a predicate over live data;
3. **the how** (what to click, what the words mean) — prose.

v1 built 1 and 2 and delivered 3 to the wrong audience. v2 built 1 and 2 twice and delivers 3 as
scattered sentences. ⭐ **Nobody has ever built the reading surface**, and it is the only part the
business is actually missing.

---

## 3. Counting the live data (bible §1.2d step 3)

| What | Count | Control |
|---|---|---|
| ERP routes that could carry a tutorial | **100** `page.tsx` | control passed (>10) |
| Navigable features (the honest surface) | **58** `href` entries in `nav.tsx` | — |
| Prerequisite-shaped sentences already written in the domain layer | **130** | 130 domain source files scanned; control passed |
| v1 registry steps / with `href` / with `doc` | **12 / 9 / 12** | — |
| v2 `storeReadiness` checks / with `href` | **4 / 0** | — |
| v2 `CUTOVER_STEPS` | **12** | — |
| v1 `docs/user-manual.md` | **1,891 lines, 137 KB, ~18,600 tokens** | — |
| Drift findings from ONE v1 documentation audit | **3** | — |

Samples of the 130, unedited — this is the raw material, and it is already in the reader's voice:

```
'createSupplier: a supplier needs a name people will recognise.'
'debt uncollectible needs a second pair of eyes — ask another admin.'
'A fingerprint enrolment needs at least one captured template.'
```

⛔ **The number I could not reach, named rather than invented.** *How often does anybody hit an
order-of-operations wall?* Nothing counts it — those 130 sentences are thrown as errors and no
telemetry records them. It is the number that should decide this feature's size. **It could be had
cheaply**: log a counter when a domain function throws a prerequisite-shaped refusal, run for a
month, and the tutorial backlog sorts itself by real frequency. I would rather ship that counter
first than guess which of 58 features deserves a tutorial. ⚠️ **And there is still no history to
mine — but the reason has changed, and the change has a direction.** This section was written on
the premise that production held **zero** organisations; it holds **one** (`SHAREAT OPC`,
`count(*) = 1` measured 2026-09-13 as the admin role — T-300). So the absence of history is no
longer structural. It is now simply that the organisation is new and nobody has worked in it:
production has one organisation, no users have signed in, and the counter would therefore start
from a real baseline rather than from nothing.

⭐ **That strengthens the recommendation rather than weakening it.** *"Ship the counter first"* was
a proposal to create data that could not otherwise exist; it is now a proposal to start counting at
the moment the data begins — which is a strictly better time to install a counter than a month into
the pilot, and the window closes by itself in January.

Standing in for it: **seven stores** (bible §1.1), one live franchise with a separate owner, and a
January cutover that will onboard every one of them at once.

---

## 4. What the industry does, and what we are NOT adopting

### 4.1 The setup-guide pattern — adopt the shape, it is already ours

Shopify's [setup guide pattern](https://shopify.dev/docs/api/app-home/patterns/compositions/setup-guide)
is an interactive checklist of expandable steps, each with a heading, description and action
button, over a progress indicator. Its
[onboarding guidance](https://shopify.dev/docs/apps/design/user-experience/onboarding) says steps
should be **"automatically marked as complete"** — derived, never ticked.

⭐ **That is bible §13 row 176, arrived at independently.** v2 already made this call and already
enforces it. Nothing to adopt; a confirmation that the existing choice is the standard one.

### 4.2 ⛔ Product-tour libraries — NOT adopting, and this is the important rejection

The mature options are real: [Shepherd.js](https://www.chameleon.io/blog/react-product-tour) (170+
releases, 100+ contributors, official React wrapper), [Driver.js](https://inlinemanual.com/blog/driverjs-vs-introjs-vs-shepherdjs-vs-reactour/)
(~5 KB gzipped), and [React Joyride](https://onboardjs.com/blog/5-best-react-onboarding-libraries-in-2025-compared)
(~340,000 weekly installs). Any would install in an afternoon.

**They solve a different problem.** A tour is a spotlight sequence over *one screen*, driven by CSS
selectors, answering *"which button do I press next?"*. Ian asked for something a tour cannot
express: **a prerequisite that lives in another feature, whose truth is a database question**
(*"you have 0 suppliers at this store"*). Driver.js explicitly has *"no built-in checklist
support"*; none of them reads your data.

⛔ **Adopting one would also import the failure mode we have spent two tasks removing**: a tour
step keyed to a CSS selector breaks silently when the markup changes, renders nothing, and no test
fails. That is `no-ungated-read-surface`'s exact shape. **Recommend against, at any scope.**

### 4.3 In-app documentation — the option v1 already ran, and its result

v1 shipped `docs/user-manual.md`: **1,891 lines**, auto-generated into
`src/lib/ai/help/manual-content.generated.ts` and used to ground the in-app **Ask ERP** assistant.
On 2026-08-21 a documentation audit cross-checked it against the code and found **three drift
findings**. The audit's own framing is the argument:

> *"`docs/user-manual.md` is not just documentation. Its text is the grounding source for the
> in-app Ask ERP assistant, so a wrong line there becomes a confidently wrong answer given to a
> cashier."*
> — `ERP-rebuild/docs/2026-08-21-doc-drift-and-dormant-flag.md`

⭐ **This is the evidence that decides the design.** Prose has no test. It drifts silently, and
routing it through an assistant converts a stale sentence into a confident one. One of the three
findings was exactly that: a kiosk manager asking Ask ERP whether they could order from commissary
would have been told no, when they can.

**Open-source verdict: nothing worth adopting.** The tour libraries solve the wrong problem; a docs
platform (Docusaurus and friends) is a static-site generator, which is §4.3's failure with a nicer
theme. The part that is genuinely hard here — *predicates over this schema* — is by definition not
something a library can supply.

---

## 5. The design question, and what each costs

⭐ **Ian settled the surface mid-assessment: a `?` in a circle on every page that needs one,
describing the page and how to use the feature.** That removes the "where does it live" question and
converts the remaining choice into a narrower and better one: **where does the PROSE live?** The
options below are re-framed against that; the effort figures are unchanged, because the surface was
never the expensive part.

⚠️ **One HOW consequence of that WHAT, stated now so it is not discovered on a tablet:** the `?`
must be a **tappable control, never a hover tooltip**. The ERP runs as an APK on phones and tablets
where there is no hover state at all, and a hover-only affordance is invisible to exactly the
people this feature is for. It also needs a real focus ring and a hit target of at least 44px —
the same rule the rest of the app follows.

### Option A — the prose lives in a `docs/` tree, rendered behind the `?`

Hand-written pages under `docs/`, one per screen, rendered into the panel.

- **Effort: 3 days of engineering + 15–25 days of writing**, then permanent upkeep.
- ⛔ **Not recommended, and this is the rejection that matters now that prose is in scope.** It is
  v1's answer exactly — and v1's post-mortem (§4.3) is a documentation audit finding three places
  where the manual had drifted from the code, in a file that was grounding an assistant answering
  cashiers. **Prose in a separate tree has nothing tying it to the thing it describes**, so it
  drifts silently and the reader cannot tell. Ian's `?` is not what makes this bad; the *location*
  is.

### Option B — the prose lives BESIDE the code, the prerequisites stay derived ⭐ RECOMMENDED

The `?` panel on each page renders two things from one co-located declaration: **a short
description of the page** (prose, hand-written, held in the feature's own module) and **its
prerequisites** (derived — a predicate over live data, a link to the screen that satisfies it, and
one `why` sentence).

⭐ **`CUTOVER_STEPS` already proves this arrangement works in this codebase.** Its `why` fields are
user-facing copy living in `packages/domain/src/cutover/steps.ts`, beside the steps they describe —
and the file carries a note that markers meant for source-readers once shipped to the screen and
were caught *by looking at it*. That is prose being maintained under the same review as code,
which is the only mechanism that has ever kept it true here.

- **The declaration already exists three times over** — v1's 12 steps, `storeReadiness`'s 4,
  `CUTOVER_STEPS`' 12 — and the `why` prose exists 130 times as error messages.
- **Most predicates already exist as repo counts.** `storesRepo.countSalesChannels`,
  `countActiveCredentials`, `accessRepo.personHasStoreScope` are exactly this shape; the expense
  chain's are in §6.
- **Effort: 4–6 days.** Registry type + evaluator (~1d), predicates for the first 8–10 features
  (~2d, reusing repo counts), the `?` control and its panel (~1.5d — one shared component, not 58),
  guard test that every nav entry either declares a tutorial or declares it needs none (~0.5d).
  **The description prose is ~20–40 minutes per page**, paid per page as each is covered, and Ian's
  *"every page that needs it"* is what keeps that from being 58 of them.
- **No migration. No new table.** It is derived, per row 176.
- **Why it does not drift:** a prerequisite whose predicate stops compiling is a build failure. The
  only free prose is one `why` sentence per prerequisite, and it sits beside the predicate it
  describes — the arrangement `CUTOVER_STEPS` already proved.

### Option C — restore v1's two dropped fields first, as slice 1 of B

Add `href` and `doc` back to `ReadinessCheck` and render them.

- **Effort: 0.5 day.** Genuinely tiny.
- **Buys:** the store-setup checklist stops saying *"Add one under Settings › Sales channels"* and
  starts linking there.
- ⚠️ **It is not the feature Ian asked for** — it covers one domain and answers no cross-feature
  question. But it is a **strict subset of Option B**, deliverable this week, and it would close
  the one gap v1 provably had.

**Recommendation: Option C now as the first slice of Option B, then Option B for the 8–10 features
the counter of §3 says people actually hit.** ⛔ Not Option A. Not a tour library.

---

## 6. ⛔ Ian's worked example, traced — and it is wrong about v2

This matters more than the rest of the document, because a tutorial built from the sentence as
given would teach a cashier something the code deliberately stopped requiring.

**Ian's chain:** record an expense ⇐ a receipt recorded **and verified** ⇐ a supplier exists.

**What v2 actually enforces:**

| # | Step | Predicate that says "done" | Where |
|---|---|---|---|
| 1 | A supplier exists | `apRepo.getSupplierById(tx, orgId, supplierId)` returns a row | `repo/ap.ts` |
| 2 | A supplier invoice is recorded | `supplier_invoices` row EXISTS, is not voided, and has capacity for this amount — **`pending` is sufficient** | `domain/expenses/create.ts:15-19`, trigger `expenses_check_invoice_open_for_recording` |
| 3 | The expense is drafted | `createExpense` — needs only `create_expense` | `domain/expenses/create.ts` |
| 4 | The expense is **posted** | ⭐ **THIS is what requires `verified`** | `approveExpense` |

The code says so itself, and says why:

> *"⭐ **T-196** — the invoice no longer has to be VERIFIED to create a draft against it. The gate
> moved from existence to posting… a `pending` invoice is fine, which is the whole point — **a
> cashier holding only `create_expense` can now draft against the paper they are holding, with no
> manager and no verification wait.** `approveExpense` is where `'posted'` is checked, and that is
> what still requires `verified`."*
> — `packages/domain/src/expenses/create.ts:25-31`

⛔ **So the tutorial Ian described would tell a cashier to wait for a manager — which is exactly the
wait T-196 was built to remove.** And it would omit the prerequisite that genuinely bites:
`verifyInvoice` refuses the person who logged the invoice (`domain/ap/index.ts:476-479`,
*"you logged this invoice, so you cannot also verify it"*), so **a store with one signed-in person
cannot post an expense at all** — a real, blocking, non-obvious prerequisite that no tutorial
written from the sentence would mention.

⭐ **This is the strongest argument for Option B over Option A, and it is not theoretical.** A
prerequisite the *code* declares stays true when T-196 moves the gate. A prerequisite a *person*
wrote down in 2026 does not, and nothing tells them.

---

## 7. Effort against use — honestly

**For:** seven stores and one January cutover that onboards all of them at once; a live franchise
whose owner is not Ian; 130 prerequisite sentences that today are only reachable by triggering the
error; and one measured incident (§4.3) of a manager being told the wrong thing by the system.

**Against:** the operators are a small, stable, mostly-trained group who already know the order of
operations. **Nobody is blocked today.** The honest answer to *"what gets worse if this is never
built?"* is: **a new manager learns by hitting errors, and those errors are unusually well
written** — that is what the 130 sentences are. That is a real answer, and it is why this is a
Phase 7 candidate rather than a defect.

**The number that should decide the size does not exist yet** (§3), and it costs about half a day
to start collecting. Building 58 tutorials before knowing which three get read would be the
expensive version of a guess.

---

## 8. Proposal

**Phase 7**, after the pilot, because the pilot is what generates the number in §3.

| Task | What | Days | Migration |
|---|---|---|---|
| **T-2xx a** | Option C — `href` + `doc` restored to `ReadinessCheck`, rendered on `/admin/stores/[id]` | 0.5 | No |
| **T-2xx b** | The prerequisite counter — log a metric when a domain function throws a prerequisite-shaped refusal | 0.5 | No |
| **T-2xx c** | The registry + evaluator + **the `?` control and its panel**, for the 8–10 features (b) ranks highest | 4–5 | No |

**In scope:** Ian's `?` control (one shared component, tappable not hover-only, on every page that
needs one); a short description of the page, held beside that page's own code; a declared
prerequisite per feature; a live predicate per prerequisite; a link to the screen; one `why`
sentence; a guard test that every `nav.tsx` entry either declares a tutorial or declares it needs
none — so a new screen cannot silently arrive without an answer.

**Deliberately out of scope, each with its reason:**

| Not doing | Why |
|---|---|
| 58 hand-written tutorials | §4.3 — v1 measured what happens |
| A product-tour library | §4.2 — solves a different problem, and breaks silently |
| Reviving `docs/user-manual.md` in v2 | 1,891 lines with no test; three drift findings from one audit |
| Grounding an AI assistant on tutorial prose | §4.3's finding is precisely this |
| Anything touching v1's staff-onboarding library | §1.1 — different feature, different audience |
| A `tutorials` table | Derived, per row 176. Storing "read" state would be the same defect as a stored readiness flag |

---

## 9. Found in passing (RULES §13 row 164 — logged here, not filed)

1. ⚠️ **`ReadinessCheck` lost v1's `href` and `doc` fields in the port** (`stores/service.ts:312-321`
   vs `store-readiness.ts:41-53`). No decision recorded either way; the remedy survives as prose in
   `detail`. Option C is a half-day fix.
2. 🔸 **v1's `StoreSetupSection.tsx:99` and `store.actions.ts:44` tell an end user to read a file in
   the git repository.** Left in v1 (read-only), but it is the clearest statement of the need this
   assessment found, and worth quoting to Ian verbatim.
3. 🔸 **v2 has no user-facing documentation of any kind** — no manual, no help route, no tooltip
   convention. That is a deliberate-looking absence nobody has ever written down as a decision.
4. ⚠️ **The 130 prerequisite sentences are excellent and completely unreachable.** They are only
   ever seen by someone who has already failed. Whatever is built, they are the content — they
   should be *read*, never rewritten.

---

## 10. FOR IAN

**The short version: you already have most of this, and one sentence in your request is out of
date — which is the useful part.**

**What you asked for exists three times already, minus one piece.** The store setup screen already
works out, live, what a new store still needs and why. The December cutover wizard already does the
same for twelve steps. The old ERP did it too, and even had links. **The piece nobody ever built is
somewhere to read it** — the old system's answer was a note telling the manager to open a file in
the programmers' code repository, which of course they cannot.

⛔ **The thing I'd most like you to know.** Your example was: *to record an expense, a supplier must
exist, then a receipt must be recorded and verified.* **That was true, and we changed it in
T-196** — deliberately, so a cashier holding a paper receipt no longer has to wait for a manager.
Today a cashier can record the expense against an unverified receipt; verification is only needed
to *post* it. A tutorial written from that sentence would reintroduce the wait we removed.

And it would miss the prerequisite that actually stops people: **whoever logs a receipt is not
allowed to verify it.** So at a store where only one person signs in, expenses cannot be posted at
all. That is a real wall, it is not obvious, and no hand-written tutorial would have mentioned it.

⭐ **That is the whole argument for building this the derived way**: a prerequisite the software
works out stays right when we change the rules. One somebody typed does not — and the old system
proves it. Its 1,891-line manual fed the "Ask ERP" assistant, drifted out of date, and an audit
found three places where it would have confidently told staff something false.

**What I recommend, and what it costs:**

1. **Half a day, this week if you like it:** put the links back on the store-setup checklist, so
   *"add a sales channel"* becomes something you can click instead of something you read.
2. **Half a day:** start counting how often anyone actually hits a *"you must do X first"* wall.
   Right now nothing records it, so I would be guessing which features need a tutorial. A month of
   counting turns that into a fact.
3. **Four to five days, after that:** the real feature — each screen able to tell you what must be
   true first, whether it is true here today, and where to go — for the eight or ten features the
   counting says people actually hit. No new database table.

**What I recommend against, plainly:** writing a tutorial for all 58 screens (three to five weeks of
writing that goes stale silently), and the popup "guided tour" libraries — those point at buttons on
one screen and cannot answer *"you have no suppliers yet"*, which is the whole of what you asked
for.

**What I still need from you:**

- **Is the counting step worth half a day**, or would you rather I pick the first ten features by
  judgement and start? I recommend counting — but it is a delay, and you may reasonably not want
  one before the pilot.
- ✅ **Answered while I was writing this** — you said a `?` in a circle on every page that needs
  one, describing the page and how to use it. So it is both halves: written description *and* the
  live wall-check. I have designed against that. **The one thing I would ask you to hold me to is
  where the writing lives:** beside the code of the page it describes, not in a separate documents
  folder. That is the entire difference between this and the old system's manual, which drifted and
  then told cashiers the wrong thing through Ask ERP. Same words on screen; one of them stays true.
- **Small but real, and easier to fix now than later:** the `?` must be a button you *tap*, not a
  tooltip you hover. On the tablets and phones this runs on there is no hover at all, so a
  hover-only `?` is invisible to precisely the people it is for.

Nothing in this document changed any file but itself. No code, no spec, no register edit — the
proposal in §8 is a proposal, and the task numbers are placeholders until you say go.

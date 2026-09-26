# ADR-014 — The AI brain: one call path, approved knowledge, humans approve every write

| | |
|---|---|
| **Status** | ⏳ **PROPOSED 2026-09-26.** Ian asked for the design docs the same day. **Not approved to build. Post-launch work** — nothing here is built before the app launches |
| **Raised by** | Ian, 2026-09-26 (§1 below) |
| **Research** | `docs/discovery/38-ai-brain.md` — v1 at source, the goal, live data, industry, what we are not adopting |
| **Decides for** | Where every AI call in this project lives; where provider keys live; how AI "learns" the business; what AI may and may not do to records |
| **Does not decide** | Table columns (a later task spec) · which feature pilots first (open question 1) · providers and budget (open questions 2–3) |
| **Interacts with** | `docs/plans/phase-6-reporting-and-dashboards.md` §4.5 (AI briefing deferred) and §4.6 (Ask ERP not ported). See §3 — this ADR does not overturn either |
| **Bible amendment** | None made. If accepted, the planner adds a §13 row and a §2/§7 note that AI calls go only through `packages/ai` |

---

## 1. What the owner asked for

Ian, 2026-09-26, in substance:

- A **centralized AI "brain"** inside this project.
- **All AI is controlled there.**
- Provider **API keys in GitHub secrets, or somewhere safer.**
- It **keeps learning the business** and **gets better over time.**

## 2. One premise needs correcting first

**Models do not learn from use.** A hosted model is the same model tomorrow no matter how often we
call it. Nothing we send teaches it our business.

So "gets better over time" has to be built from four things we own:

1. **An approved knowledge base** — short notes about how this business works, read into prompts.
2. **Feedback** — a person marks an answer good or wrong, and why.
3. **A fixed eval set** — questions with known right answers, scored on every change.
4. **Versioned prompts** — prompts live in git, so a change is reviewed and reversible.

That is how the system improves: the notes grow, bad answers become eval cases, and no model or
prompt change ships unless the eval score holds. This is honest "learning", and every step is
visible and reversible.

## 3. How this sits with Phase 6

Phase 6 deferred the AI briefing and did not port Ask ERP, on measured data: 13 Ask ERP calls ever,
and 2 of 4 enrolled stores never read the briefing (discovery 26 §C.2). **This ADR keeps both
rulings.** It builds the *place* AI lives, not a feature. Each feature that uses it still needs its
own case with a demand number. The deferred briefing — "call one model over numbers Phase 6 already
computed" (phase-6 §4.5) — is the obvious first user.

⚠️ **Pushback, stated once (bible §0.4, row 163):** measured AI demand here is small (~₱280/year,
one feature with real readers). The brain is worth building only as the thin, safe home for a
feature someone will use. Build P0 with its first feature, not ahead of one.

---

## 4. Decision

### 4.1 `packages/ai` is the ONE call path

- A new workspace package. **The only code allowed to call a model provider.** A test fails the
  build if any other package or app imports a provider SDK — the same shape as
  `tests/unit/app-boundaries.test.ts`.
- Inside it: a provider router, an optional fallback provider, a per-call output-token cap, a
  **monthly budget ceiling that refuses calls once spent**, and the per-store kill switch.
- **Model choice lives in code**, not in an editable settings row. Changing a model is a PR, and
  the PR runs the eval set (§4.5). v1's editable model string caused a full outage and a silent
  four-day mismatch (discovery 38 §3.2).
- **Not a separate server.** It runs inside the app process. Apps call domain functions; domain
  functions call `packages/ai`. Apps never call it directly for a write path.
- Adapter library: evaluate an in-process, Apache-2.0 TypeScript SDK (Vercel AI SDK is the lead
  candidate) so we do not rewrite v1's per-provider structured-output shims. Decided in the P0 spec.
- Every call gets a trace id carried into the app's structured log and into the call row.

### 4.2 Keys: runtime env on the droplet, never git, never the DB

- **GitHub Actions secrets are build-time only.** A key baked into the build artifact is a leaked
  key. So the key does not ride in the artifact.
- **Now:** keys live in `/srv/shareat-shared/.env.local` on the production droplet
  (`159.223.46.224`), the file the deploy already symlinks into each release
  (`.github/workflows/deploy.yml:21-24`, `:126-134`). Ian sets them, never an agent. A committed
  `.env.example` names each one (bible §7 rule 8).
- **Fails closed** (bible §7 rule 9): if AI is enabled and its key is missing, startup refuses.
  If AI is not yet enabled, the key is "not yet required" under row 71, with a test proving the
  production path still refuses.
- **Later upgrade:** Infisical (open source) for rotation and an access log. Open question 6.
- **Never:** in git, in GitHub build secrets that reach the artifact, or encrypted in Postgres.

### 4.3 `ai_calls` — every call logged in Postgres

- One table, **`ai_calls`**: one row per model call, modelled on v1 `audit.ts:156-186` — feature,
  provider, model, **a hash of the prompt, never the prompt text**, token counts, cost, duration,
  status, the asking user, the store.
- It is the source for cost reports, the budget check, per-feature error rate and latency, and
  the admin status view. No separate status table (v1 needed one only because Firestore could not
  query its own log, `audit.ts:98-111`).
- **Cost is never a float.** v1 stored pesos to 4 decimals (`audit.ts:81`). ⚠️ **Integer centavos
  are too coarse:** an average call costs ≈ 2.4 centavos (discovery 38 §3.1), so centavo rounding
  moves a typical row by up to ±20 %. Token counts are the exact fact. Cost is stored as `numeric`
  in the DB and handled as an integer sub-centavo unit in code (e.g. micro-pesos), rolled up to
  centavos for display. The spec fixes the unit.

### 4.4 The brain = `ai_knowledge`: AI proposes, an admin approves

- One table, **`ai_knowledge`**: short notes about how this business works.
- Lifecycle: **draft → approved → retired**, the same idea as the ledger's draft → posted.
  An approved note is **never edited**; a correction is a new note that retires the old one.
- **AI may propose a note. Only a human with the capability may approve it.** Only approved notes
  are ever read into a prompt. The approval writes an audit row (bible §7 rule 7).
- **Retrieval:** start with Postgres full-text search plus `pg_trgm` (already installed, migration
  0050). Add **pgvector** when keyword search stops finding the right notes. ⚠️ CI runs the plain
  `postgres:18` image (`.github/workflows/ci.yml:109`), which does not ship pgvector — adopting it
  means changing the CI image and confirming the extension on production first.
- **Seed** from `docs/GLOSSARY.md` and `docs/POSTING-PATTERNS.md`. Seeded notes enter as drafts and
  are approved in bulk by a named admin, so every note has a human approver.
- **Feedback:** one table, **`ai_feedback`**: a user's rating and reason on a call's answer. A
  "wrong" answer becomes a candidate eval case or a candidate note. Whether answer text is stored
  is a spec question under bible §7 rule 10 (field-level access).

### 4.5 A fixed eval set, run in CI

- The eval set lives in git under `packages/ai`: questions, expected answers or checks, and a
  pass bar.
- **CI runs it before any change to a model, a prompt, or the retrieval code.** A score below
  the bar fails the PR. This is the "gets better" proof: the score is a number over time.
- Evals call a real provider, so they run on a CI key with its own small ceiling, not on the
  production key.
- Prompts are versioned files in git; each call row records the prompt version.

### 4.6 Tools: through `authorize()`, AS THE ASKING HUMAN

- The model reaches data only through **tools**. Transport is MCP or an internal tool layer —
  decided in the P2 spec. Either way:
- **Every tool call runs `authorize()` as the human who asked**, with that human's stores and
  capabilities (bible §7 rules 1, 4, 10). The model never supplies its own actor or store.
  Keep v1's proven shape: tools built per request, closed over trusted context, strict inputs,
  trusted keys applied last (`ERP-rebuild/src/lib/ai/help/tools.ts:15-31`, `:60-74`).
- **Read-only tools first.**
- **Writes only as drafts.** A tool may create a draft document; a human reviews and posts it
  through the normal action. AI never posts, approves, voids, or closes anything.

---

## 5. Rules it must obey

| Rule | Where |
|---|---|
| Postgres is the sole system of record — the log, notes and feedback live there, not in Firestore or a vendor | Bible §2 rule 3 · RULES §1 #4 |
| No client-side-only authorization — every tool call and every approval is gated server-side | Bible §2 rule 6 · §7 · RULES §1 #7 |
| One `authorize()` module, `(action, resource)` capabilities, store scope in the repo layer, RLS behind it | Bible §7 rules 1, 2, 4 · §15.11 |
| Every new table classified in `packages/db/src/cutover/classification.ts` **and** `packages/db/src/rls/registry.ts` | CLAUDE.md router · the build guard |
| Migrations hand-authored, checklist in ADR-012 §5 | Bible §2 rule 8 · ADR-012 |
| New capabilities (e.g. use AI, approve a knowledge note, view AI cost, manage AI settings) go into `CAPABILITY-MATRIX.md`, each ✅ with a test proving the ✗ fires | CAPABILITY-MATRIX "How to read this" |
| Money never in floats — cost as `numeric` in DB, integer unit in code (§4.3) | Bible §2 rule 5 · RULES §1 #6 |
| Secrets never in the repo; fail closed | Bible §7 rules 8, 9 |
| SQL only in `packages/db/src/repo`; business rules in `packages/domain` | CLAUDE.md "Where things live" |
| Every mutation writes an audit row (note approval included) | Bible §7 rule 7 |
| Never build on either droplet | Bible §2 rule 10 · RULES §1 #11 |

---

## 6. Deliberately OUT

| Out | Reason |
|---|---|
| A separate AI server or proxy | Second runtime and deploy on a 4 GB box, second home for keys. In-process does the same at ~9 calls/store/day |
| Fine-tuning | Tiny corpus, no eval set to prove a gain, locks us to one model. Approved notes give the same effect and can be undone |
| Keys in git or in the DB | Git is permanent; a DB key sits next to the code that reads it |
| Autonomous posting or approval | Books must be correct (bible §1.1). A person owns every financial fact |
| An AI-owned super-user role | The AI acts only as the asking human. A service identity with broad rights is one prompt injection from misuse |
| Building before launch | No launched users, no demand number, and launch work comes first |

---

## 7. Effort and phases

| Phase | Delivers | Effort | Gate to start |
|---|---|---|---|
| **P0** | `packages/ai`: router, optional fallback, token cap, budget ceiling, kill switch; `ai_calls`; key handling; import guard test | **2–3 days** | App launched; a first feature named (open question 1) |
| **P1** | `ai_knowledge` draft → approved; approval capability; full-text retrieval; seed from GLOSSARY and POSTING-PATTERNS; `ai_feedback` | **3–5 days** | P0 live; first feature in use |
| **P2** | Read-only tools through `authorize()` as the asker | **3–5 days** | A pilot question set that needs record data |
| **P3** | Eval set + CI job + prompt versioning | **~2 days** | P1 live. ⚠️ Recommend running P3 **before** P2: without it, P1's "better" cannot be shown |
| **P4** | Draft-only write tools; a human posts | Sized in its own spec | P2 and P3 live, and a named use case |
| **Total P0–P3** | | **~2–3 weeks** | |

**Failure modes to design for in the specs:** provider down → one fallback if configured, else the
feature shows "AI unavailable" and **never blocks a business action**; budget reached → calls
refused and logged; prompt injection through a note → only approved notes are read; through a
tool result → tools cannot change actor or store; key leak → rotate in the env file, and no prompt
text was ever stored.

---

## 8. Open questions for Ian

1. **First use case to pilot?** Recommendation: the deferred daily briefing (phase-6 §4.5) at
   Lipa and Malvar — the two stores that read it.
2. **Which providers?** One primary, and is a fallback worth it at this volume? (v1 ran Groq.)
3. **Monthly budget ceiling?** Measured spend was ₱45.81 per 60 days at 4 stores.
4. **Knowledge notes org-wide or per store?**
5. **Who may approve a note?** Admin only, or managers for their own store?
6. **Infisical now, or later?** Recommendation: later; the droplet env file is enough at launch.

# The rules, in one place

> **This is a digest, not an authority.** Every rule cites its section in
> [`PROJECT_BIBLE.md`](../PROJECT_BIBLE.md), which **wins any disagreement** — if this file and
> the bible differ, this file is stale and that is a bug worth fixing.
>
> It exists because the bible is long and an agent starting cold needs the operating rules
> without reading 1,600 lines of architecture first. Read this to start working; read the bible
> before deciding anything.

---

## 1. Never — the hard constraints

| # | Rule | §  |
|---|---|---|
| 1 | **All four reference repos are READ-ONLY** — `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`. No edits, no branches, no `git`. **A defect found there is logged and fixed *here*, never patched at the source** | §2.1 · row 80 |
| 2 | **`ERP-rebuild` is the OLD system despite its name.** This project is `webapps/shareat-system` | §2.1 |
| 3 | **Never touch `webapps/inactive projects`** — exclude it from every recursive search | §2.2 |
| 4 | **Postgres is the sole system of record.** No entity's authoritative state lives in Firestore | §2.3 |
| 5 | **Firestore is one-way except the inbox lane** | §2.4 · §5 |
| 6 | **No money in floats.** `numeric` in the DB, integer centavos in code | §2.5 · §6 |
| 7 | **No client-side-only authorization.** Every gate exists server-side | §2.6 · §7 |
| 8 | **No implementation without a written task spec** in `docs/tasks/` | §2.7 · §3 |
| 9 | **Every schema change is a migration.** An applied migration is **never edited** — write a new one. ⭐ **And it is HAND-AUTHORED** — `npm run db:generate` is retired and fails closed; the checklist is **ADR-012 §5** (DEF-242; bible §13 row 191; `packages/db/migrations/README.md`) | §2.8 · §15.5 · ADR-012 |
| 10 | **Stop the dev server before `npm run build`** — the build clobbers the `.next` it is serving | §2.9 |
| 11 | 🚫 **NEVER BUILD ON EITHER DROPLET — and know which is which (DEF-238).** **`159.223.46.224` is OUR production host**: `erp2.shareat.net`, the `shareat-erp` service, `/srv/shareat-shared/.env.local`. **`159.223.78.207` is the OLD SHARED droplet** (ERPNext + the POS archive DB) — this project has never run there; `/srv` is empty on it. Both are small boxes and a build OOMs either. **Builds run in CI; the server receives a finished artifact.** ⚠️ Until 2026-09-08 this rule named only the old droplet and called it "the production droplet", which sent people to the wrong machine *and* said nothing about the real one | §2.10 |
| 12 | **Port 9008 is ERPv2's alone**; 5435 for local Postgres. Never pass a different `-p` | §2.11 |
| 13 | **An app may never import from another app.** Apps depend on `packages/`; packages never depend on apps. *Enforced by `tests/unit/app-boundaries.test.ts`* | §8 · ADR-004 |
| 14 | **Only the Opus planner amends the bible.** An implementer reports a needed amendment and stops. **A spec that lists the bible in its Scope is a defect in the spec** | §14 · row 86 |

---

## 2. How work is done

| Rule | § |
|---|---|
| **Research → plan → spec → implement.** A new phase, module, or any data shape expensive to undo gets a **bounded research pass first**, producing a document under `docs/discovery/`. Research **informs; it never decides** — the target is the midpoint (§1.1), so the output must name what we are **not** adopting and why | §3.6 · row 96 |
| **Pick the model for the task.** **Sonnet** = the default for delegated work (code reading, discovery, executing a spec, tests). **Opus** = planning, architecture, specs, review. **Fable** = *only* a bug that survived a deliberate Opus pass, or genuinely intricate data-shape design. *"It was hard" is not the escalation bar* — and do not spend Opus on what Sonnet does well. ⭐ **Whole lane terminals too (Ian, 2026-09-08):** a worker executing an approved spec runs on Sonnet; the orchestrator names the model in the briefing; a session cannot switch itself, so Ian types `/model` and the board lists which terminals | §3.1a · rows 93, 184 |
| **A spec names the exact files you may touch.** Stay inside it. If you must go outside, say so explicitly in your report | §3.3 |
| **Tests before implementation**, and confirm they fail *for the right reason* first. A test that only ever passed proves nothing | §3.2 · §9 |
| **Integration tests run against real Postgres, never a mock** | §9.3 |
| **Smoketest in the running app.** A green build and green tests have already shipped an app that could not start | §9.4 |
| **Report a spec defect; never silently work around it.** A planner's spec is a hypothesis — patching around a defect destroys the evidence it was wrong | **§3.4a** · row 97 |
| **Verify, do not claim.** Report the command's real output. *A task reported complete with a failing gate is worse than one reported blocked* | §3.4a · row 97 |
| **Every subagent prompt is self-contained** — it starts cold and knows nothing of the conversation | §3.4 |
| **Parallel agents must share no STATE, not merely no files.** Two agents running `test:integration` against the one `shareat_test` database truncate each other's fixtures. Before parallelising, ask what else is shared: the test DB, `migrations/meta/_journal.json`, a port | §3.4 · row 94 |
| ⚠️ **Prefer a guard to `!` on a regex match**, and where `!` is used, a comment names what makes it safe. `noUncheckedIndexedAccess` is on deliberately and `!` is the one remedy that silently switches it off at the point of use | §13 row 206 |
| **Every report ends with a `FOR IAN` block** — plain language, what changed, what needs a decision | §3.5 |

### Definition of done — all of it, every time

typecheck clean · unit tests pass · **integration tests pass against real Postgres — and the FULL suite before any PUSH, not just the lane's files (Ian, 2026-09-22; ~33 min; DEF-412 is what a lane-scoped gate hides)** ·
**smoketested in the running app on 9008** · `npm run build` succeeds with the dev server
stopped · self-reviewed line by line · committed with a message explaining *why* · **bible
amended if a decision was made**. *Reporting done when any of these is unmet is itself a
defect.* — §9

---

## 3. How to read the reference repos

| Rule | § |
|---|---|
| **Read them as REQUIREMENTS, not as design.** Every feature exists because the business needed it and staff use it daily. The code may be wrong; the *need* is proven. **Authoritative about WHAT, never about HOW** | §1.2b · row 84 |
| ⭐ **UI/UX is a third authority.** A screen should be familiar-but-upgraded, never reinvented — same record workflow, better presentation. One uniform, reusable pattern set across screens. `apps/erp`/`pos`/`customer` are one visual family. **POS, not ERP-rebuild, is today's presentation-quality benchmark** where the two disagree | §1.2c · row 171 |
| ⭐ **v1 is the flawed version; v2 is the improved one — and discovery has a METHOD, in this order.** Study v1 at source → **write down the GOAL** it was built to achieve (an unwritten goal can only be copied, never improved on) → **count the live data**: populated, consistent, and actually consumed by anything downstream? → design v2 against that goal, the bar being *more accurate, more correct, more effective, more efficient*, not merely *not-flawed*. ⛔ **Bad data downgrades v1 from proven practice to evidence of the NEED only** — then the v2 rule is designed, not ported | §1.2d · row 172 |
| **Reading needs no permission and no announcement.** Read freely and often — guessing what the old system does is far more dangerous than opening it | §2.1 |
| **The four verbs:** *duplicate* what's good · *correct* what's wrong · *add* what's missing · *delete* what's redundant | §1.2 |
| **If a feature looks pointless, ASK — never delete.** Removing a redundant *implementation* is Claude's call; removing a *capability someone uses* is Ian's | §1.2 |
| **Where v1 and correct accounting disagree, practice wins** — and the divergence is recorded. A v1-vs-v2 accounting difference is a **finding**, not a failure | §1.3 |
| ⭐ **LOG WHAT YOU SEE, EVEN WHEN IT IS NOT YOUR TASK.** A bug, gap or flaw you notice **in passing** while reading v1 for some other reason is logged before you move on. *"I wasn't tasked with that area"* is not a reason to skip it — one row costs nothing, and you are the only person who will ever have that context. **Verification is not required:** state it as `reported`; a later session confirms it | **§13 row 164** |
| ⭐ **Three doors, and the wrong one buries the finding.** v1 does it **wrong** → `docs/DEFECTS-REGISTER.md` A–D, cite `file:line` · v1 does it and **no phase owns it** → `docs/CAPABILITY-GAPS.md` (a gap is not a defect — that pass is what caught the five ledger modules January needed) · **Shareat System itself** is wrong → `DEFECTS-REGISTER.md` **section E** | **§13 row 164** |

---

## 4. Ian's standing directive

| | § |
|---|---|
| **Ian describes WHAT. Claude decides HOW.** A literal reading of an instruction is not automatically the correct execution of it | §0.1 |
| **Brainstorm before executing** — name the industry-standard pattern first. Boring and standard beats clever and bespoke | §0.2 |
| **Side with the project.** Where "what Ian asked for" and "what is best" diverge, build the better one **and say plainly that you did, and why** | §0.3 |
| **Push back, including hard** — on scope, on sequencing, on a decision that has turned out wrong. Explicit permission, therefore an obligation. Raise it once, properly; then keep working | §0.4 |
| **Not licence for:** scope creep · silent substitution · skipping destructive-action confirmations · contrarianism | §0.5 |
| ⭐ **A requested feature is ASSESSED before it is planned, and may be argued against.** Weigh expected utilisation against effort and complexity; say the number, not the adjective. **Then research** — the industry pattern *and* what already exists on GitHub, because a well-solved problem probably has been solved. **Then plan.** Recommending against is sanctioned, therefore expected: say it once, plainly, then build it anyway if Ian still wants it. ⚠️ Adopting is not free either — licence, self-hosted vs API, vendor vs depend are part of the assessment, not afterthoughts. ⭐ **Invoke `/research-evaluate-propose`** — the skill that carries these three steps, global, available in every repo | **§13 row 163** |

---

## 5. Where to look things up

| Question | File |
|---|---|
| What are the rules, in full? | **`PROJECT_BIBLE.md`** — the authority |
| Why is it built this way? | `docs/decisions/` (ADRs) and bible **§13**, 216 logged decisions |
| What does this word mean? | **`docs/GLOSSARY.md`** — *read before naming anything;* several fields mean the opposite of what they look like |
| What is already broken? | `docs/DEFECTS-REGISTER.md` |
| What does the business do that the plan misses? | `docs/CAPABILITY-GAPS.md` |
| How do the four apps connect? | `docs/CROSS-APP-MAP.md` |
| What am I building next? | `docs/plans/` and `docs/tasks/` |
| I am starting cold on a new machine | `HANDOFF.md` |
| **How do I actually run and click the app?** (the §9.4 gate) | ⭐ **`docs/SMOKETEST.md`** — from nothing to a signed-in screenshot. ⛔ Read it before reporting §9.4 as impossible; it has been reported impossible three times on premises that were wrong |

---

## 6. The three that catch people out

1. **`dineInSales` is package-only, `takeOutSales` is a residual, `receiptSeq` is not a
   monotonic key.** Read the glossary before trusting any field name.
2. **A defect in a reference repo is never an argument against the feature.** The
   implementation is evidence of a real need, not a proposal to drop it.
3. **The database enforces the rules, not the service layer.** Do not re-implement balance,
   period, or immutability checks in TypeScript — a second copy is a second source of truth,
   and the two will drift.
   ⚠️ **This is about CHECK constraints and triggers (balance, period, immutability) — not
   tenancy.** Tenancy is layered on purpose: the repository filters, RLS backstops (bible §7
   rule 4 + §15.11). The binding rule for both is §15.11 — *no layer may be the only one for a
   given risk*. DEF-210 is what it looks like when one is. (There is no "bible §6.3"; a citation
   to it means this item — bible §15.11.)

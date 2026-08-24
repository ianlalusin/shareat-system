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
| 9 | **Every schema change is a migration.** An applied migration is **never edited** — write a new one | §2.8 |
| 10 | **Stop the dev server before `npm run build`** — the build clobbers the `.next` it is serving | §2.9 |
| 11 | 🚫 **NEVER BUILD ON THE PRODUCTION DROPLET** (`159.223.78.207`). 4 GB RAM; a build OOMs it and takes Postgres down. Builds run in CI | §2.10 |
| 12 | **Port 9008 is ERPv2's alone**; 5435 for local Postgres. Never pass a different `-p` | §2.11 |
| 13 | **An app may never import from another app.** Apps depend on `packages/`; packages never depend on apps. *Enforced by `tests/unit/app-boundaries.test.ts`* | §8 · ADR-004 |
| 14 | **Only the Opus planner amends the bible.** An implementer reports a needed amendment and stops. **A spec that lists the bible in its Scope is a defect in the spec** | §14 · row 86 |

---

## 2. How work is done

| Rule | § |
|---|---|
| **Research → plan → spec → implement.** A new phase, module, or any data shape expensive to undo gets a **bounded research pass first**, producing a document under `docs/discovery/`. Research **informs; it never decides** — the target is the midpoint (§1.1), so the output must name what we are **not** adopting and why | §3.6 · row 96 |
| **Pick the model for the task.** **Sonnet** = the default for delegated work (code reading, discovery, executing a spec, tests). **Opus** = planning, architecture, specs, review. **Fable** = *only* a bug that survived a deliberate Opus pass, or genuinely intricate data-shape design. *"It was hard" is not the escalation bar* — and do not spend Opus on what Sonnet does well | §3.1a · row 93 |
| **A spec names the exact files you may touch.** Stay inside it. If you must go outside, say so explicitly in your report | §3.3 |
| **Tests before implementation**, and confirm they fail *for the right reason* first. A test that only ever passed proves nothing | §3.2 · §9 |
| **Integration tests run against real Postgres, never a mock** | §9.3 |
| **Smoketest in the running app.** A green build and green tests have already shipped an app that could not start | §9.4 |
| **Report a spec defect; never silently work around it.** A planner's spec is a hypothesis — patching around a defect destroys the evidence it was wrong | **§3.4a** · row 97 |
| **Verify, do not claim.** Report the command's real output. *A task reported complete with a failing gate is worse than one reported blocked* | §3.4a · row 97 |
| **Every subagent prompt is self-contained** — it starts cold and knows nothing of the conversation | §3.4 |
| **Parallel agents must share no STATE, not merely no files.** Two agents running `test:integration` against the one `shareat_test` database truncate each other's fixtures. Before parallelising, ask what else is shared: the test DB, `migrations/meta/_journal.json`, a port | §3.4 · row 94 |
| **Every report ends with a `FOR IAN` block** — plain language, what changed, what needs a decision | §3.5 |

### Definition of done — all of it, every time

typecheck clean · unit tests pass · **integration tests pass against real Postgres** ·
**smoketested in the running app on 9008** · `npm run build` succeeds with the dev server
stopped · self-reviewed line by line · committed with a message explaining *why* · **bible
amended if a decision was made**. *Reporting done when any of these is unmet is itself a
defect.* — §9

---

## 3. How to read the reference repos

| Rule | § |
|---|---|
| **Read them as REQUIREMENTS, not as design.** Every feature exists because the business needed it and staff use it daily. The code may be wrong; the *need* is proven. **Authoritative about WHAT, never about HOW** | §1.2b · row 84 |
| **Reading needs no permission and no announcement.** Read freely and often — guessing what the old system does is far more dangerous than opening it | §2.1 |
| **The four verbs:** *duplicate* what's good · *correct* what's wrong · *add* what's missing · *delete* what's redundant | §1.2 |
| **If a feature looks pointless, ASK — never delete.** Removing a redundant *implementation* is Claude's call; removing a *capability someone uses* is Ian's | §1.2 |
| **Where v1 and correct accounting disagree, practice wins** — and the divergence is recorded. A v1-vs-v2 accounting difference is a **finding**, not a failure | §1.3 |

---

## 4. Ian's standing directive

| | § |
|---|---|
| **Ian describes WHAT. Claude decides HOW.** A literal reading of an instruction is not automatically the correct execution of it | §0.1 |
| **Brainstorm before executing** — name the industry-standard pattern first. Boring and standard beats clever and bespoke | §0.2 |
| **Side with the project.** Where "what Ian asked for" and "what is best" diverge, build the better one **and say plainly that you did, and why** | §0.3 |
| **Push back, including hard** — on scope, on sequencing, on a decision that has turned out wrong. Explicit permission, therefore an obligation. Raise it once, properly; then keep working | §0.4 |
| **Not licence for:** scope creep · silent substitution · skipping destructive-action confirmations · contrarianism | §0.5 |

---

## 5. Where to look things up

| Question | File |
|---|---|
| What are the rules, in full? | **`PROJECT_BIBLE.md`** — the authority |
| Why is it built this way? | `docs/decisions/` (ADRs) and bible **§13**, 107 logged decisions |
| What does this word mean? | **`docs/GLOSSARY.md`** — *read before naming anything;* several fields mean the opposite of what they look like |
| What is already broken? | `docs/DEFECTS-REGISTER.md` |
| What does the business do that the plan misses? | `docs/CAPABILITY-GAPS.md` |
| How do the four apps connect? | `docs/CROSS-APP-MAP.md` |
| What am I building next? | `docs/plans/` and `docs/tasks/` |
| I am starting cold on a new machine | `HANDOFF.md` |

---

## 6. The three that catch people out

1. **`dineInSales` is package-only, `takeOutSales` is a residual, `receiptSeq` is not a
   monotonic key.** Read the glossary before trusting any field name.
2. **A defect in a reference repo is never an argument against the feature.** The
   implementation is evidence of a real need, not a proposal to drop it.
3. **The database enforces the rules, not the service layer.** Do not re-implement balance,
   period, or immutability checks in TypeScript — a second copy is a second source of truth,
   and the two will drift.

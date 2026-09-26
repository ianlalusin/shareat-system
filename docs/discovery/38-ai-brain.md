# 38 — The AI "brain": what v1 built, what the goal is, and what v2 should clear

**Date:** 2026-09-26 · **Prompted by Ian:** a centralized AI "brain" that controls all AI, keeps
provider keys safe, and gets better at the business over time.
**Feeds:** `docs/decisions/ADR-014-ai-brain.md` (PROPOSED, post-launch).
**Method:** bible §1.2d in order — v1 at source → the GOAL → what exists → the v2 bar. v1 read at
source (`ERP-rebuild`, `POS`, `CUSTOMER`, `RSR APP`; all read-only, unmodified). v2 read at source.
Live numbers taken from discovery 26 §C.2, which probed production Firestore on 2026-09-04; no new
probe was run (see §3.3). Industry claims are marked where this pass could not verify them.

**Read this with discovery 26 and `docs/plans/phase-6-reporting-and-dashboards.md` §4.5–§4.6.**
Those already decided that the v1 AI hub and Ask ERP are **not** ported in Phase 6. This document
does not reopen that. It answers a different question: if AI comes back after launch, what is the
one place it lives?

---

## 1. v1 at source

### 1.1 ERP-rebuild — the "AI Hub"

| Piece | What it does | Source |
|---|---|---|
| Provider factory | One Genkit instance per provider: Google Gemini (default), Groq, OpenAI, xAI, DeepSeek, **and NVIDIA NIM** (the brief missed NVIDIA) | `src/lib/ai/genkit-config.ts:95-157` |
| Env switch (legacy) | `AI_PROVIDER` picks the default provider; `GENKIT_MODEL` / `GROQ_MODEL` pick the model | `genkit-config.ts:25`, `:55-57` |
| Output cap | Every call capped at 2,500 output tokens after one call ran to ~29k tokens | `genkit-config.ts:80` |
| Structured-output shim | Per-provider workaround because Groq, xAI and DeepSeek break Genkit's JSON mode | `genkit-config.ts:204-226` |
| Provider registry | List of providers, enabled flag, priority, model — **stored in Firestore** `appSettings/aiProviders`, cached 60 s, admin-editable | `src/lib/ai/hub/registry.ts:5-6`, `:19-63` |
| Self-healing model names | A hard-coded table rewrites retired model ids on every read. It exists because an admin-editable stored model string caused a full Ask ERP outage on 2026-08-20 | `registry.ts:84-111` |
| Router with fallback | Filters enabled providers by required capability, sorts by priority, tries each; at most two passes per provider (original model, then one healed model) | `src/lib/ai/hub/router.ts:117-150`, throws at `:250` |
| Capability table | Per-provider flags (tool calling, structured output mode) plus which secret each needs | `src/lib/ai/hub/capabilities.ts:153-167` |
| Model discovery | Lists a provider's live models and picks a same-tier successor | `src/lib/ai/hub/model-discovery.ts:134-160` |
| Per-call audit | Writes `stores/{storeId}/aiCallLog/{id}`: feature, context, provider, model, **SHA-256 of the prompt (never the text)**, tokens, cost in pesos, duration, status, error, tool-call count, `calledByUid` | `src/lib/ai/audit.ts:16`, `:135-137`, `:156-186`; type at `src/types/ai-call-log.ts:9-26` |
| Cost | Hard-coded USD-per-million-token price table, converted at a fixed ₱58/USD | `audit.ts:23-66`, `:70`, `:72-82` |
| Provider status rollup | One Firestore doc with last outcome per provider, for the admin page | `audit.ts:112-133` |
| Per-store kill switch | `isStoreAiEnabled` — every AI path checks it first | `src/lib/ai/store-ai-enabled.ts:13`; used at `compare-orchestrator.ts:36-40` |
| Ask ERP tools | Tool-calling chat. Tools are built **per request, closed over the caller's own policy context and store**; inputs are `.strict()`; trusted keys spread last so a prompt-injected `storeId` cannot win | `src/lib/ai/help/tools.ts:15-31`, `:60-61`, `:69-74`, `:75-108` |
| Orchestrators | Daily insights (8 sections), period roll-ups, and a two-period comparison — all go through `generateWithFallback` | `src/lib/ai/orchestrator.ts`, `period-orchestrator.ts:6`, `compare-orchestrator.ts:4` |
| Features logged | `dailyInsights`, `reorderRecommendation`, `helpChat`, `futureAgent` | `src/types/ai-call-log.ts:9` |

**Keys.** Runtime env vars backed by GCP Secret Manager through Firebase App Hosting
(`apphosting.yaml:30-70`, e.g. `GROQ_API_KEY` ← secret `GROQ_INSIGHT_API`). Never in git. Adding a
provider needs a secret **and** an IAM grant, and a missing grant fails the whole deploy
(`apphosting.yaml:74-80`).

**Learning.** No store of AI outputs, feedback, or approved knowledge. The one thing that "learns"
is not AI at all: the expense save path keeps a per-store index of item → category, which Ask ERP
reads (`src/lib/ai/help/expense-category-lookup.ts:1-20`). That is a deterministic mapping, and it
is the right instinct — learning lives in data the business owns, not in the model.

### 1.2 The other apps

| App | What it has | Source |
|---|---|---|
| POS | One hard-coded Gemini instance (`gemini-3.8-flash`), no router, no audit. Two flows: weekly sales forecast, holiday calendar — both live | `POS/src/ai/genkit.ts:4-7`; flows under `src/ai/flows/`; called from `src/app/api/forecast-weekly-sales/route.ts`, `src/lib/server/generate-forecast.ts`, `src/lib/server/holiday-calendar.ts` |
| CUSTOMER | One hard-coded Gemini instance. **No feature imports it** — only a smoke test | `CUSTOMER/src/ai/genkit.ts:4-7`, `src/ai/_smoketest.ts:1-7` |
| RSR APP | **Has AI — contradicts the brief.** One hard-coded Gemini instance (`gemini-2.5-flash`) and a live flow that generates barangay profiles | `RSR APP/src/ai/genkit.ts:4-7`; `src/ai/flows/generate-barangay-profiles.ts`, used by `src/app/actions.ts` and `.../generate-profiles-dialog.tsx`. Not a Shareat app; out of scope |
| shareat-system (v2) | **No AI code.** No Genkit, no provider SDK, in `apps/` or `packages/` | grep of `apps/` and `packages/` for genkit / openai / gemini / anthropic / `@ai-sdk`: 0 hits |

---

## 2. The GOAL v1 was built to reach

Written down, because an unwritten goal can only be copied (bible §1.2d):

1. **Turn the day's numbers into words a manager reads** — the daily briefing.
2. **Answer a staff question without a human** — Ask ERP.
3. **Never go down because one vendor did** — the router and the retired-model heal.
4. **Know what AI costs, per store and per feature** — the audit log.
5. **Let an owner switch AI off per store** — the kill switch.

Ian's 2026-09-26 request adds a sixth that v1 never attempted:

6. **Get better at *this* business over time.**

---

## 3. What exists — the live data

### 3.1 Usage (discovery 26 §C.2, probed 2026-09-04)

| Measure | Value |
|---|---|
| AI calls logged, all-time | **3,489** |
| AI spend, last 60 days, 4 enabled stores | **₱45.81** (≈ ₱0.19 / store / day) |
| Average cost per call (derived: ₱45.81 ÷ ≤1,920 section calls in 60 d) | **≈ 2.4 centavos** |
| Daily briefings generated | 240 / 240 store-days |
| Briefings opened | Lipa 76 · Malvar 84 · Davao 5 · Padre Garcia **0** |
| Ask ERP calls, ever | **13**, one 8-day window, 3 of 7 stores, none after |
| Stores with AI on | 4 of 7 |

### 3.2 What the numbers say

- **Cost is not the constraint.** ~₱280/year now. Budget caps are about runaway calls, not spend.
- **Generation works; reading does not.** Half the enrolled stores ignore the briefing.
- **Chat demand, measured, is near zero.** 13 questions in four months.
- **The hub's complexity was spent on vendor quirks**, not on the business: structured-output
  shims, retired-model tables, Groq's 12k tokens-per-minute cap (`genkit-config.ts:59-80`,
  `registry.ts:84-120`). A model name stored in an editable doc caused one full outage (Gemini,
  2026-08-20) and one silent four-day mismatch where audit rows named a dead model (Groq,
  `registry.ts:112-120`).
- **Cost is a float.** `estimateCostPesos` returns pesos rounded to 4 decimals
  (`audit.ts:81`). In v2 that breaks bible §2 rule 5. Note also: at ≈ 2.4 centavos a call, integer
  **centavos** round a typical call by up to ±20 %. Tokens are the exact fact; cost needs a finer
  unit than centavos (see ADR-014 §4).

### 3.3 The number that is missing

**Current `aiCallLog` volume and spend since 2026-09-04.** It lives in production Firestore, which
is not reachable from this machine in this pass. The 2026-09-04 figures above are 22 days old.
**Flagged, not invented.** Re-probe (read-only, as discovery 26 did) before the P0 spec sets a
budget ceiling.

---

## 4. Industry — what exists

§3.6 guard 4 asks for sources. **This pass had no web access.** Rows marked *(briefed)* are taken
from the planner's brief and were **not** independently verified; verify before any adoption.

| Category | Option | Licence / model | Fit for one 4 GB droplet |
|---|---|---|---|
| Gateway / router | **LiteLLM** | MIT, self-host, Python proxy | Works, but a second runtime and process on a box that already runs the app |
| | **Portkey** gateway | Apache 2.0; acquired by Palo Alto Networks in 2026 *(briefed)* | Ownership change makes the roadmap uncertain |
| | **Helicone** | Apache 2.0; maintenance mode after a 2026 acquisition *(briefed)* | Do not start on a product in maintenance |
| | **OpenRouter**, **Vercel AI Gateway** | Hosted | One key, many models; adds a third party that sees every prompt |
| In-process library | **Vercel AI SDK** (`ai` + provider packages) | Apache 2.0, TypeScript | One `generateText` / `generateObject` API across providers; normalises structured output — the exact problem v1 hand-coded (`genkit-config.ts:159-226`). *Recommended to evaluate in the P0 spec; version and licence to be confirmed then* |
| | **Genkit** (what v1 used) | Apache 2.0 | Known to the team, but v1's comments are a catalogue of its per-provider gaps |
| Memory | **mem0**, **Letta / MemGPT** | Open source | Automatic memory the model writes for itself. See §6 |
| Tracing / prompts / evals | **Langfuse** | MIT core (tracing, prompt management); some eval features paid *(briefed)*; self-host needs ClickHouse | Too heavy for this box |
| Tool transport | **MCP** (Model Context Protocol) | Open spec | Standard way to expose tools. Safe only if every tool call runs through the app's own `authorize()` as the asking human |
| Secrets | GitHub Actions secrets | — | **Build-time only.** The droplet never sees them at runtime unless the deploy writes them out |
| | Droplet env file | — | Already the pattern: `/srv/shareat-shared/.env.local`, never shipped (`.github/workflows/deploy.yml:21-24`, `:126-134`) |
| | **Infisical** (open source) / **Doppler** (hosted) | — | Central store with rotation and audit; the upgrade path |
| | Keys encrypted in the DB | — | Puts the decryption key next to the ciphertext's reader |

**Standard vs one vendor's choice.** Standard: a single call path, per-call logging, human review
of anything that writes, an eval set before a model change, retrieval over a curated corpus. One
vendor's choice: a separate proxy server, automatic agent memory, a hosted observability suite.

---

## 5. The v2 design bar

v2 must beat v1 on each goal, not match it:

| Goal | v1 | v2 bar |
|---|---|---|
| Words from numbers | 8-module Firestore extraction layer | One model call over numbers Phase 6 already computes (phase-6 §4.5) |
| Answer a question | Chat nobody used | Only for a named pilot use case with a demand number |
| Survive a vendor | 6 providers, admin-editable model names, runtime heal tables | One call path; model choice **in code**, changed by PR, gated by evals |
| Know the cost | Firestore log, float pesos | Postgres table, exact token counts, cost in an integer sub-centavo unit |
| Kill switch | Per store | Per store, plus a monthly budget ceiling that refuses calls |
| Get better | Nothing | Approved knowledge notes, feedback, a fixed eval set, versioned prompts |
| Tool safety | Tools closed over the caller's context (good) | Same, through `authorize()` as the human; read-only first; writes only as drafts |

**Keep from v1:** prompt hash not text; per-store kill switch; the local non-AI short-circuit;
tools closed over trusted context with strict inputs; output-token cap; loud warning on an unpriced
model.
**Correct from v1:** editable model names in a datastore; float cost; Firestore as the log.

---

## 6. What we are NOT adopting, and why (§3.6 guard 3)

| Not adopting | Why |
|---|---|
| A separate AI server or proxy (LiteLLM, Portkey, self-hosted gateway) | A second runtime on a 4 GB box, a second deploy, a second place keys live. At ~9 calls/store/day an in-process package does the same job |
| Porting v1's 6-provider hub | Phase 6 §4.5 already ruled it out. Its code is vendor-quirk handling, not business value |
| Fine-tuning | Tiny corpus, fast-moving base models, no eval set yet to prove a gain. Retrieval over approved notes gets the same "knows the business" effect and is reversible |
| Automatic agent memory (mem0, Letta) | The model decides what it remembers. In an accounting system, what the AI "knows" must be reviewed like any other record |
| Langfuse / hosted observability | ClickHouse on a 4 GB droplet, or every prompt sent to a third party. A Postgres table covers the audit need |
| OpenRouter / Vercel AI Gateway as default | A third party in the path of every prompt. Revisit only if multi-provider fallback is ever proven necessary |
| Helicone | Maintenance mode *(briefed)* |
| Keys in git, in GitHub build-time secrets baked into the artifact, or in the DB | Git is forever; a baked artifact leaks the key to anyone with the artifact; a DB key sits next to its reader |
| Self-hosted models | Discovery 26 §C.3: GPU cost dwarfs ₱0.19/store/day |
| Porting Ask ERP as-is | 13 calls ever (phase-6 §4.6). A chat surface returns only with a pilot and a demand number |

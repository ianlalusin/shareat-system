# T-640: AI hub: several providers, keys entered on screen (encrypted), model fixed by test, spending caps, every call logged

**Owner:** builder (Sonnet). Auditor: Sonnet (security: secrets, auth, cost). **Spec:** BOSS (Opus), 25 Nov 2026. **MIGRATION 0284** (reserved).

**Ian, 25 Nov 2026:**
- "build an ai hub like the v1 that can accept api keys from different providers".
- Monthly cap ₱1,000.
- "Both now".
- **This supersedes proposed ADR-014 §4.2 ("keys only in .env.local, never in the DB")**: keys may be entered on screen, under the safeguards below. Update ADR-014 to say so.

## v1, read as requirements

v1 (ERP-rebuild `src/lib/ai/registry.ts`, `router.ts`, `capabilities.ts`, `audit.ts`, `usage-cap*.ts`):
- a provider hub (google, groq, openai, xai, deepseek, nvidia, anthropic)
- admin-editable in Firestore, tried in priority order with fallback
- a capability table (toolCalling)
- a log of every call (prompt hash, tokens, cost ₱)
- 30 questions per person per day

**Not copied:**
- **A free-text model name.** A mistyped model string took Ask ERP down on 2026-08-20; Groq's toolCalling was also wrong in the table.

## Rule

1. **`packages/ai`** is the ONLY code that calls a model. Each provider adapter goes behind one interface (chat with tools, token counting, cost per 1M tokens in/out). Start with **Anthropic, Google Gemini, OpenAI**; others are added later as adapters. Use the providers' official SDKs or plain HTTPS. Pin versions and check licences.
2. **Keys entered on screen** (super-admin only, under a new capability e.g. `manage_ai_hub`, never grantable below admin):
   - The key is encrypted at rest with AES-256-GCM using a master key from the server env (`AI_KEYS_MASTER_KEY` in /srv/shareat-shared/.env.local; BOSS adds it to the deploy env checklist; it is never in git or the DB).
   - It is NEVER shown back: after saving, only the provider and the last 4 characters show. Replacing a key means typing a new one.
   - It is never logged and never sent to the browser.
   - Saving, replacing or deleting a key writes an audit row (no key material).
3. **Models are picked from a list, never typed:** each adapter lists its models, either a curated list in code or the provider's list endpoint.
   - A model becomes usable only after a **"Test" call succeeds** (a tiny prompt plus one tool call, if tools are needed). The tested capability is stored (`tool_calling: true/false` from the test, not a hand table).
   - A failed test leaves the previous model active.
4. **Priority and fallback:** an ordered list of active provider+model. A call tries them in order on failure (timeout, 5xx, rate limit) and logs which one answered. The order is set on screen.
5. **Spending caps (settings with a screen):**
   - an org **monthly cap, ₱1,000 default**: when reached, calls refuse with a plain sentence until next month, and admins get a warning at 80%
   - a **per-person daily question limit** (default 30, admins exempt; editable)
   - cost is computed from the provider's token counts × the per-model price in code (₱ via a peso rate setting with a screen)
6. **Every call is logged** in `ai_calls`: org, store, person, feature (e.g. ask_erp), provider, model, tokens in/out, cost ₱, latency, tool calls count, ok/error, and a prompt **SHA-256 (never the text)**. A "AI usage" screen shows spend this month vs the cap, per feature and per person (admins).
7. **Privacy guard in the hub** (applies to every caller), a function every outgoing payload passes through:
   - strip or deny person names, government IDs, PINs, credentials, account numbers, pay per person and receipt images
   - callers send business fields only
   - a test proves a payload containing a TIN/SSS-shaped number or a key-shaped string is scrubbed or refused
8. **Switch:** an org-level "AI features on/off" and a per-store toggle (v1 `aiInsightsEnabled`).

## Not in this task

- The Ask ERP chat itself (T-641).
- AI judging expenses (rules do that: T-639).
- Model fine-tuning or "learning from use".

## Tests (each with a mutant that goes red)

1. Encryption round-trip; the stored value is not the plaintext; the key never appears in logs, responses, audit rows or browser HTML.
2. Only a super-admin can save keys; an admin, manager or staff member is refused (authorize first).
3. A model can't be activated without a passing test; a failing test keeps the old model.
4. Fallback order on a simulated failure; the log names the answering provider.
5. The monthly cap refuses at the limit; the 80% warning; the daily per-person limit; admin exemption.
6. ai_calls stores the hash, not the text.
7. The privacy guard scrubs ID-shaped and key-shaped strings.
8. Provider adapters are tested against recorded or fake HTTP; no real network in CI.

Migration 0284 hand-authored (ADR-012 §5): classification + RLS + audit catalogue. ai_calls is operational (purge class decided with the classification rules), the provider config is keep. Full CI suite. census:write.

## As built (26 Nov 2026)

- Migrations 0284 (five tables, capability backfill) and 0285 (`ai_calls.tokens_estimated`). `packages/ai` (adapters over plain fetch, no SDK; cipher; privacy guard; model list in code), `packages/domain/src/ai` (hub, Test call, `callAi`), screen `/settings/ai-hub`.
- Caps and the peso rate live in `ai_settings` (not the business-rules registry: T-639 edits the same registry lines).
- Security audit fixes: the cap and the daily limit are checked under a per-organisation advisory lock together with a RESERVATION row (worst-case cost, error code `reserved`, superseded by the first real row of the same call), so concurrent calls overshoot by at most one call; an answer with missing or zero usage is estimated (about 4 characters a token) and flagged; more separators and key shapes in the privacy guard; a 16-byte auth tag and no all-zero master key; no redirects and a 2 MB reply cap; replacing a key resets that provider's models to untested and off.
- Known limit: a reservation stops counting at the first real row of its call, so the second attempt of a fallback walk is briefly unreserved.

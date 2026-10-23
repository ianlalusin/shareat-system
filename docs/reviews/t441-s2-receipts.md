FINDINGS: clean for the three scoped receipt callers; channel-certificate spec gap remains open.
CHECKED CLEAN
- Customer collection, delivery and trade pay-now use the shared PhotoUpload and resolver, preserving the native File fallback.
- Claim and document writes share one transaction; conditional claim enforces org, uploader, purpose, store and age.
- Trade forwards the real collection id, never links a payment proof to the trade order; replay behavior and accounting are unchanged.
- Six real PostgreSQL positive controls prove both upload paths, exact owner links and clean referenced-unlinked/problem censuses.
- Three foreign-uploader controls assert the exact sentence and unchanged documents, journal, stock, orders and stored-file rows.
- Seven wiring checks failed first; 321 affected unit/guard checks and 61 PostgreSQL checks pass; typecheck and production build pass.
- One channel-certificate TODO remains: T-441 S2 scopes only customer, delivery and trade; the mismatch is recorded in both tasks.
- Scope extension is explicit: trade result forwarding, app integration tests, census cross-reference and review evidence.
- No schema/guard baseline changes, production writes or backfill; test database shareat_test_codex_t442s2 only.
Model: GPT-6 (Codex).
## FOR IAN
Keep draft for fresh full CI and runtime/visual checks; no live release or complete DEF-672 claim.

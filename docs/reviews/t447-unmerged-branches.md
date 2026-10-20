FINDINGS: audit continues; unfinished work is held from release
- PR #38 compact white UI is live; its main CI and Deploy passed.
- PR #39 lightbox merged as e34a979; PR #41 approved dashboard merged as fd8af80. Production CI 39353485354 and Deploy 39355100476 passed; public health verifies fd8af80, valid configuration and reachable database.
- PR #40 remains draft: latest full CI 39354321744 failed (77 failed / 8,856 passed). All 33 failed files now pass locally (615 tests); final date/auth controls pass 46 tests. Seven audit findings corrected locally; final guards, exact-head full CI and runtime check pending.
- Backfill S1 checkpoint 45dae60 on codex/file-link-backfill: two audit defects corrected; 21 real PostgreSQL tests pass / three TODO; typecheck and 91 caller/argument/ratchet/boundary/register checks pass, repeated after commit. S2 and T-441 S2 remain open. Not deployed.
- POS baseline: 635 passed / 161 failed / one skipped; offline-oracle corrections pass 42 checks. Convert routes remain unfinished; post-commit advisory failure can falsely claim no money changed (DEF-695). Statutory/UI/handover work remains open.
CHECKED CLEAN: no red work merged; unrelated root CLAUDE.md and docs/operations/ preserved; no force/reset/stash or reference-repository writes.
FOR IAN: approved dashboard is live; unfinished work continues separately. Ian's money ruling is implemented: quote invalid amounts only, keep identifiers hidden.

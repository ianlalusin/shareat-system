FINDINGS: audit in progress; POS and backfill remain unfinished
- PR #38 merged as 758a48c; main CI and Deploy succeeded. Compact white UI is live.
- PR #39 passed full CI 39349212629 and merged as e34a979; payroll refusal-test promises were repaired under T-449, preserving assertions.
- PR #41 passed full CI 39351822583 and merged as fd8af80; Ian approved the dashboard corrections. Production CI 39353485354 is running; this revision is not yet claimed live.
- PR #40 now includes fd8af80. Combined production build, root/ERP typechecks and 43 UI/auth/census checks pass; full CI is required again.
- Local number checks: 58 passed / four 5-second cold-import timeouts; all 20 checks in the affected file pass with a 30-second local budget. CI settings and assertions remain unchanged.
- POS baseline: 635 passed / 161 failed / one skipped; two incorrect offline oracles corrected in 54372a5 (42 checks pass). Convert server implementation is in progress; statutory, UI and handover work remains unfinished.
- File-link backfill remains uncommitted in wt-t403 and separate from the lightbox release.
CHECKED CLEAN: already-merged heads excluded; unrelated root CLAUDE.md and docs/operations/ preserved; no force/reset/stash or reference-repository writes.
FOR IAN: clean releases ship first; dashboard deployment is pending and unfinished work stays separate.

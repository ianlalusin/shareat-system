# T-588 addendum (BOSS, 26 Nov 2026): go now, repo part first

**Ian, 26 Nov 2026:** "completely retire the stale pos copy so we get back some space in our repo". This overrides the "after Lipa go-live" wait in docs/tasks/588-retire-pos2.md for the REPO part. The production part still waits for Ian's usage check, below.

## Corrections to 588
- Production serves pos2 through **Caddy**, not nginx (docs/ops/provision.sh:166-177).
- Archive choice: **tag then delete**. Tag `archive/apps-pos-final` on the last main commit that holds apps/pos. Move apps/pos/V1-COPY.md to docs/archive/apps-pos-V1-COPY.md. Delete the rest, including the emulator, practice scripts and audit scripts.

## Repo PR (builder, Sonnet): remove every reference, keep CI green
Delete apps/pos/ and the practice-erp scripts that exist only to drive it (scripts/practice-erp-start.mjs, practice-erp-seed.ts, practice-erp-check-approval.ts, scripts/lib/practice-env.mjs). Then fix each of these:
- **Root config:**
  - package.json: remove the workspace and `dev:pos`, then `npm i` to regenerate package-lock.
  - tsconfig.json:109
  - vitest.config.mts excludes
  - .claude/launch.json entries
- **CI:** ci.yml `app-pos` job plus the `pos` change output. scripts/ci-affected-apps.mjs: APPS = ['customer'].
- **deploy.yml:** remove the POS build, its artifact paths, the carry-forward, POS_RESTART and the :9009 probe.
- **Ops in repo:**
  - remove docs/ops/shareat-pos.service
  - provision.sh: the pos.log, sudoers and pos2 Caddy block
  - docs/ops/README.md sections
  - scripts/ops/node-cve-upgrade.sh service loop
- **Tests:**
  - Delete the ones that only exist for apps/pos: deploy-pos-failed-build, pos-v2-cap-restore, pos-v2-copy, pos-v2-copy-script, pos-v2-server-boundary, pos-v2-money-guards, pos-v2-offline-guards, pos-service-unit, practice-env.
  - Rewrite the ones that mention it among others: ci-app-jobs, ci-affected-apps, app-workspaces, app-boundaries, t455-s9a-ops (Caddy block ordering without pos2), scheduler-job-hosting, t398-s7-multi-org-jobs (services list), glossary-trap-names (drop the exclusion), t532-s3-pos-shell-workflow.
  - Never weaken a guard to pass; a rewritten test must still fail on its mutant.
- **Code comments:** drop the `as unknown` workaround in packages/db/src/repo/separations.ts:110,119 if tsc stays clean. Fix comments that point at apps/pos files.
- **AGENTS.md / CLAUDE.md** "apps/{pos,...} reserved" wording. Regenerate packages/domain/src/ask-erp/knowledge.generated.json.
- Historical docs (bible rows, register, old tasks) stay as history. Add one bible pending row: "apps/pos deleted 26 Nov 2026 (T-588), tag archive/apps-pos-final".
- **Gates (on BIBO):** FULL unit suite, tsc -p apps/erp, census:write, and grep `apps/pos` / `pos2` / `shareat-pos` across code + tests + workflows = only history docs left.

## Production (Ian runs, after the usage check is clean; host 159.223.46.224 only)
1. Read-only check: `journalctl -u shareat-pos --since "14 days ago" | tail` and the request count in /var/log/shareat/pos.log. Every tablet points at erp2 /pos.
2. **After the repo PR is deployed:**
   - stop and disable shareat-pos.service
   - remove the Caddy block and reload Caddy
   - remove the sudoers line
   - remove /srv/shareat-shared/pos2.env and its key file
3. Remove the DNS record. Retiring the Firebase service-account key on shareat-hub-v2 is Ian's call, because v1 shares that project.
4. After one week, delete the unit file and run daemon-reload.

**Space note for Ian:** about 11 MB of tracked files plus apps/pos's own installed packages. Git history keeps the old files; we do NOT rewrite history (never force-push).

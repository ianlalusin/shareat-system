/**
 * `npm run recurring-expense-draft` — T-216 Part 2's daily drafting run.
 *
 * Invoked by the host's systemd timer, daily, alongside the other scheduled jobs.
 *
 * ## ⭐ What it is for
 *
 * A fixed bill that depends on somebody remembering it is a bill that gets paid late, off-book, and
 * in the wrong month. This job puts the invoice and the draft expense on the screen on the morning
 * they are due, pre-filled from the template, so the only thing left is to check the real bill and
 * post it.
 *
 * ## ⛔ It drafts. It never pays.
 *
 * v1 auto-pays on a cron. Ian, 6–7 Sep 2026: v2 does not. This creates a PENDING supplier invoice
 * and a DRAFT expense and stops — no journal entry, no cash movement, no posting. Three of v1's
 * five hardening rounds exist only because a machine could move money unattended.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is exactly what happens when nothing speaks up.
 *
 * ⛔ **Registering this job is not the finish line. Arming its timer is**, and only Ian can do
 * that: `provision.sh` is the only thing that installs unit files and the deploy pipeline ships no
 * `docs/`. Three jobs have now shipped unarmed (DEF-194). See `docs/ops/README.md`.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runRecurringExpenses } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been running it by hand" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`recurring-expense-draft: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runRecurringExpenses({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
      // ⭐ T-233 guard C can keep the REAL posted/skipped even when only the run's own
      // bookkeeping failed — print them, or an operator reads "FAILED OUTRIGHT" for a run that
      // actually drafted.
      console.log(`${head}: ${o.detail ?? `drafted ${o.posted}`}`);
      continue;
    }
    // ⚠️ Counts, never a bare "done" (bible §15.6). "drafted 0" on a run that saw 12 due templates
    // is a fault; "drafted 0" on a run that saw none is a quiet morning, and the two are
    // indistinguishable without the first number.
    console.log(`${head}: ${o.detail ?? `drafted ${o.posted}`}`);
    // ⛔ A template that cannot draft is a CONFIGURATION fault and prints as one. The commonest is
    // a template with no supplier, and the fix is one field on /expenses/recurring.
    for (const f of o.failures) console.error(`${head}:   ⚠️ ${f.subjectName} — ${f.reason}`);
  }

  if (result.hadFailures) {
    console.error('recurring-expense-draft: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. No orgs found is a configuration problem wearing the costume of a quiet
    // night — the same distinction `finding-observation` and `budget-reissue` draw.
    console.error('recurring-expense-draft: no orgs were processed — nothing to draft?');
    return 1;
  }
  // ⚠️ Counts, never a bare "done" (bible §15.6) — the same rule the per-org lines above already
  // follow, applied to the script's own summary line.
  const drafted = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  const alreadyDrafted = result.outcomes.reduce((sum, o) => sum + o.skipped, 0);
  console.log(
    `recurring-expense-draft: ok — drafted ${drafted} · already drafted ${alreadyDrafted} · ${result.outcomes.length} orgs`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('recurring-expense-draft: crashed —', err);
    await closeDb();
    process.exit(1);
  });

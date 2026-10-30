# T-500: Padre Garcia's staff attendance, leave and payroll on v2 (bible row 369)

**Status:** SPEC 2026-10-31 (orchestrator, Opus). Sonnet tester first, then Sonnet builder, then Sonnet auditor.
**Needed by:** 1 Jan 2027 (PG's first v2 payroll is January's). Build now; nothing here touches production until PG is
onboarded for real (T-398 S7 production run, data due 27 Nov).
**Migration:** none.

## 1. Goal in plain words

Row 369 (Ian, 17 Oct): Padre Garcia (its own company, T-398) runs its staff attendance, leave and payroll on v2 from
1 Jan. Two things stand in the way today, measured on `origin/main` 1ec159b:

1. **PG has no government rates, so its payroll cannot even be previewed.** Rates are per company
   (`statutory_rates`, `withholding_brackets`, `minimum_wages`, migration 0206). 0206 seeded Ian's company only
   (`WHERE code='shareat'`, :314-324). `createOrganization` and `onboardFranchiseOrganization` seed none
   (S7 refresh :211 left this to this task). `applyStatutory` (`packages/domain/src/payroll/index.ts:451-486`) refuses a
   preview when no rate is in force, and `postPayRun` (:646-650) refuses while any rate is unconfirmed.
2. **Leave approval.** Row 369 feared a manager's own leave could not be approved in PG (no super-admin there). Measured:
   the row-355 guard (`packages/domain/src/leave/requests.ts:307-322`, `:133-136`) only stops a person deciding their
   OWN leave unless they are super-admin. Anyone else holding `manage_attendance` at the store may decide it. Ian's PG
   person is org admin (holds it); PG's owner is a store-scoped manager with **no employment row** (so files no leave).
   So the realistic cases already work. One real gap: `isSuperAdmin` (:92-95) checks the role literal `super_admin` and
   ignores the "admin plus every super-admin grant" equivalence that `holdsSuperAdminAuthority`
   (`packages/auth/src/roles.ts:213`) honours everywhere else.

## 2. Rulings

- **R1. Copy, never confirm.** Philippine contribution tables and BIR brackets are national, so PG starts from the
  franchisor's. Onboarding gains **step 11**: for each agency, copy into the franchisee every `statutory_rates` row and
  every `withholding_brackets` set **in force on or after 1 Jan 2027** in the franchisor org (and any later-dated rows),
  as **UNCONFIRMED** rows of the franchisee. PG's admin confirms them on `/payroll/rates` (the existing screen and
  `confirmStatutoryRate`); a payroll can be previewed at once but not posted until confirmed. Rationale: confirmation
  means "a person in this company checked these figures", which a copy cannot claim.
- **R2. Idempotent and safe.** Step 11 runs inside the Ian-side transaction (like steps 8-10), adds only rows the
  franchisee lacks (same agency + effective_from), never edits or deletes a franchisee row, and is covered by the
  DEF-804 dry-run rule (a dry run writes nothing and lists "N rates, M bracket sets to copy").
  A re-run of onboarding on an already-onboarded PG copies what is missing, so this also serves the real PG once
  onboarded before this ships.
- **R3. Minimum wage is not copied.** It is per store and unseeded everywhere (0206 :14); it stays data PG's admin
  enters on the rates page. The onboarding dry run prints a reminder line "Minimum wage: none on file for <store>".
- **R4. Employer numbers are data.** SSS / PhilHealth / Pag-IBIG employer numbers are per company
  (`statutory_employers`, 0222) and entered by PG's admin on the rates page; nothing is copied (they differ per company).
- **R5. Leave guard.** `isSuperAdmin` in `leave/requests.ts` uses `holdsSuperAdminAuthority` so an admin holding every
  super-admin grant is treated like a super-admin for row 355 (self-approval allowed and audited `leave.self_approved`).
  Nothing else in the leave rules changes.
- **R6. Audit.** Step 11 writes one `onboard.franchise` audit detail line naming the counts copied (no new action).

## 3. Tests (tester first; each names the mutant it kills)

| Id | Case | Expected | Kills |
|---|---|---|---|
| H1 | Onboard (MOCK file) with the franchisor holding confirmed 2027 SSS/PhilHealth/Pag-IBIG rates and a 2027 bracket set | PG has the same rows, `confirmed_at` NULL, PG's org_id | copy marks them confirmed; copies into the wrong org |
| H2 | Franchisor rows dated before 2027 only | nothing copied for those | copies history |
| H3 | Re-run onboarding after PG already has the SSS row | SSS untouched, the rest added | duplicates / overwrites |
| H4 | Dry run | writes nothing; output names the counts to copy and the minimum-wage reminder | dry run writes |
| H5 | PG payroll preview after onboarding (one employee, one day) | preview succeeds; post refused naming the unconfirmed rates; after confirming all, post succeeds | rates not usable by applyStatutory |
| H6 | PG staff member's leave decided by PG's owner (manager) | allowed | — (guard) |
| H7 | An admin holding every super-admin grant approves their own leave | allowed, audited `leave.self_approved`; a plain admin without the grants is refused | role-literal check kept |
| H8 | Isolation: Ian's org rates unchanged; PG cannot read Ian's rates (RLS) | unchanged / no rows | copy writes the franchisor's side |

## 4. Fences
- Write only: `packages/domain/src/organizations/onboard-franchise.ts` (step 11), the statutory repo (a read of
  franchisor rows in force from a date; an insert of unconfirmed copies — reuse existing insert helpers),
  `packages/domain/src/leave/requests.ts` (R5 only), and tests.
- No migration, no change to rate maths, `applyStatutory`, `postPayRun`, or the rates screen.
- Money/rates written as strings through the existing branded helpers (t371 guard). No new raw `throw new Error`.

## 5. Done when
H1-H8 red→green; t190*, t193*, t436* and all t398-s7*/def803* tests green; typecheck clean; Sonnet audit.

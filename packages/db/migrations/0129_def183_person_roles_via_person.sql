-- 0129 — T-221 / DEF-183: person_roles moves to the via_person policy form.
-- docs/tasks/221-person-roles-rls-via-person.md, docs/DEFECTS-REGISTER.md DEF-183,
-- RULES.md §6.3 ("the database enforces the rules, not the service layer").
--
-- HAND-WRITTEN. drizzle-kit does not generate RLS policies, and this migration changes no
-- table shape at all — only the policy on person_roles. 0000-0128 are applied and never
-- edited (bible §2 rule 8), so migration 0014's policy is replaced here, not amended there.
--
-- ## What was wrong
--
-- 0014 created the three access tables together and protected them TWO ways, deliberately:
--
--   person_store_scope, person_grants  — no org_id of their own, so their policies derive the
--                                        org THROUGH the person the row names.
--   person_roles                       — carries its own org_id, so its policy was simply
--                                        `org_id = app_current_org()`.
--
-- All three end in `= app_current_org()` and read as equivalent. They are not. The derived
-- form asks *"does this row's SUBJECT belong to my org?"*. The org_id form asks *"is this row
-- LABELLED with my org?"* — and a row carrying MY org_id with ANOTHER org's person_id answers
-- yes. Its FK to persons is satisfied too, because that person genuinely exists. So a
-- cross-org role assignment was accepted by the database for two weeks.
--
-- Not reasoned from the policy text — proved. A T-219 test written to expect a refusal
-- reported "promise resolved instead of rejecting", and the same assertion fails against this
-- file's parent commit today (rls.test.ts, "T-221 / DEF-183 — person_roles refuses a cross-org
-- role WRITE, not just a read").
--
-- ## Why the new policy ANDs both conjuncts instead of swapping one for the other
--
-- Dropping `org_id = app_current_org()` would admit the MIRROR row — this org's person given a
-- role in ANOTHER org. That conjunct is not redundant: it already refuses that row today
-- (invariant 2 in the test file passes before this migration and must keep passing after).
-- One conjunct answers "labelled with my org", the other "subject belongs to my org", and for
-- this table those are independent facts. Both are required.
--
-- ## Why USING changes too, not only WITH CHECK
--
-- A weaker USING leaves an already-written bad row readable and updatable by the org that
-- labelled it, and it leaves UPDATE able to walk a legitimate row across the boundary. It also
-- keeps four sibling policies in three different shapes, which is the actual hazard DEF-183
-- names: **whoever adds a fourth access table copies whichever policy they open first.** Four
-- policies with one shape and one naming convention is the cure. Hence the rename, too.

-- ---------------------------------------------------------------------------------------
-- Guard: refuse to install a stricter USING over data that already violates it.
--
-- A stricter USING makes any pre-existing violating row invisible to the app role — hiding
-- the evidence instead of surfacing it. Expected count is ZERO everywhere (v2 migrated no
-- history, assignRole had no callers before T-219, and scripts/dev-seed.ts inserts a person
-- and its role under the same org). This exists to be loud if that expectation is wrong,
-- rather than to be a branch anyone plans to take. Blocking beats a silent drop — the same
-- call DEF-059 and T-122 invariant 7 both made.
-- ---------------------------------------------------------------------------------------
DO $$
DECLARE
	violating integer;
BEGIN
	SELECT count(*) INTO violating
	FROM person_roles r
	JOIN persons p ON p.id = r.person_id
	WHERE p.org_id <> r.org_id;

	IF violating > 0 THEN
		RAISE EXCEPTION
			'DEF-183: % person_roles row(s) name a person outside the row''s own org. '
			'Installing this policy would make them invisible to the application rather than '
			'fixing them. Inspect them first: SELECT r.* FROM person_roles r JOIN persons p ON '
			'p.id = r.person_id WHERE p.org_id <> r.org_id; then decide per row whether to '
			'revoke it or repoint it, and re-run this migration.', violating;
	END IF;
END
$$;
--> statement-breakpoint

DROP POLICY "person_roles_org_isolation" ON "person_roles";--> statement-breakpoint

-- Renamed to state the FORM, so the four person-keyed access policies now read as one family:
-- person_identities_via_person · person_roles_via_person · person_store_scope_via_person ·
-- person_grants_via_person. Enforced by rls.test.ts, which reads pg_policies rather than
-- trusting this comment.
CREATE POLICY "person_roles_via_person" ON "person_roles" FOR ALL
	USING (
		"org_id" = app_current_org()
		AND EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_roles"."person_id" AND p."org_id" = app_current_org())
	)
	WITH CHECK (
		"org_id" = app_current_org()
		AND EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_roles"."person_id" AND p."org_id" = app_current_org())
	);

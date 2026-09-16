-- 0152 — T-318 slice B: backfill position_capability_defaults + person_grants for the 21
-- capabilities the role matrix currently grants to `staff` directly, BEFORE slice C flips them
-- to position-only. Reproduces today's behaviour exactly; changes nothing observable.
-- docs/tasks/318-position-decides-access.md, Scope "Slice B", "THE BLAST RADIUS", Contract 4.
--
-- ⛔⛔ REFUSES IF ANY OPEN EMPLOYMENT HAS NO POSITION — Ian's ruling (Needs from Ian #1,
-- 2026-09-14): a positionless open employment is a DATA ERROR, and shrinking the staff baseline
-- is only safe because nobody loses access by accident. This is the one shape where they would,
-- so this migration refuses to run at all while any exist, and names who.
--
-- ⭐ ATTRIBUTION — Ian's own ruling, 2026-09-14: his name goes on every row this migration
-- writes, because he is the person who decided to shrink the staff baseline, so attributing the
-- rows to him is TRUE, not fabricated, even though it will read as if he approved ~400 rows
-- individually when what he approved was the policy.
--
-- ⛔⛔ CORRECTED 2026-09-16, after the FIRST real production run refused with "SHAREAT OPC: 0
-- active super_admin(s)". Traced to source: `createFirstAdmin`
-- (`packages/domain/src/organizations/index.ts`) inserts `role: 'admin'` — bootstrap has NO code
-- path that ever creates a `super_admin`. Production was not misconfigured; the original gate
-- demanded a role the system does not produce, which made it unsatisfiable for every
-- supported-path organisation, not a data error to fix. The fallback to `admin` (originally
-- proposed, then overruled on an unchecked premise) is correct on the real facts: the admin is
-- not a lesser substitute standing in for a missing super_admin — **it is the account the
-- bootstrap actually creates for whoever stands up the business**, which is exactly who Ian's
-- ruling names. No org created the supported way has anything above it.
--
-- ⭐ THE NEW MECHANISM must still not turn the ruling back into an inference. Resolved PER ORG,
-- preferring the higher role, and refusing rather than guessing the moment it is not exactly one
-- at the tier it looked at:
--   1. Exactly one active `super_admin` -> use it.
--   2. No active `super_admin`, exactly one active `admin` -> use it (the bootstrap-created
--      owner account).
--   3. Anything else -> REFUSE, naming every candidate found AT THE TIER THAT WAS AMBIGUOUS
--      (more than one super_admin: blame that tier; zero super_admin and not exactly one admin:
--      blame the admin tier) — same refuse-and-print shape as the positionless-employment gate,
--      for the same reason: an ambiguous resolution silently attributing access decisions to the
--      wrong person is precisely the outcome Ian's ruling chose against.
-- ⭐ Step 2's refusal stays scoped to organisations Step 3 will actually write a row for (has an
-- active position paired to a store) — an org with none receives zero rows regardless of
-- attribution, so refusing for it protects nobody and only halts a production deploy for
-- nothing (review finding, system32-85, 2026-09-14).
--
-- Order, and why it is not negotiable (spec "THE BLAST RADIUS"):
--   1. Refuse if any open employment has no position.
--   2. Refuse if any organisation that WOULD receive a row cannot be resolved to exactly one
--      attribution person by the two-tier rule above.
--   3. Write one position_capability_defaults row per (active position x store x each of the 21).
--   4. Materialise the matching person_grants for every open employment holding those positions.
--   5. NOTHING ELSE. The matrix flip (staff: true -> false) is slice C and does not ride along.
--
-- ⭐⭐ TWO BUGS THIS MIGRATION'S OWN DRAFT HAD AND A SCRATCH-DATABASE RUN FOUND, BOTH LOAD-BEARING
-- FOR WHY THE SQL BELOW IS SHAPED THE WAY IT IS:
--   1. Step 3 covers EVERY store, active or not — NOT only active stores. Scoping to active
--      stores would have silently broken Contract 4 for anyone with an open employment at a
--      deactivated store: nothing about deactivating a store ends anyone's employment, so that
--      person's matrix-granted capabilities would have survived today and vanished silently the
--      day slice C flips the matrix, with no default row ever written to catch them. Found by
--      testing the CONTRACT rather than the code — this is exactly what Contract 4 is for, and it
--      would have passed every test that only looked at active stores.
--   2. Canonical positions (store_id IS NULL) join stores WITH `p."org_id" = s."org_id"`,
--      explicitly — never a blind cross join. Without it, one organisation's canonical position
--      defaults would be written onto every OTHER organisation's stores too. ⛔ RLS does NOT catch
--      this: migrations run as the owning role, which bypasses row-level security by design, so a
--      tenancy breach here is authored inside the one context where that backstop is off (bible
--      §15.11 — no layer may be the only one for a given risk; a migration is the place where the
--      second layer is missing by construction).
--
-- ⛔ UNAPPLIED, never edited in place until confirmed unapplied: checked directly against
-- `drizzle.__drizzle_migrations` on both `shareat_dev` and `shareat_test_lanea` before this edit
-- (queried for `created_at = 1799206307084`, this migration's own journalled `when` — absent on
-- both). The prior version's first real run REFUSED inside its own transaction, so the whole
-- batch rolled back and nothing was recorded — confirmed, not assumed; see this migration's own
-- integration test for the executable proof (a failed run leaves no tracking row).
--
-- Idempotent by construction (ON CONFLICT ... DO NOTHING on each table's own partial unique
-- index) even though an applied migration is never re-run (RULES §1 rule 9) — written
-- defensively because the INSERT...SELECT shape makes it free.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).
-- Additive to the schema (no DDL) -- packages/db/schema/ is unchanged, so there is no
-- `// NOTE: hand-added` comment to place (ADR-012 §5 step 3).

-- ---------------------------------------------------------------------------------------------
-- Step 1 — refuse if any open employment has no position.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	bad_count int;
	bad_list text;
BEGIN
	SELECT count(*), string_agg(e."staff_code" || ' (' || p."display_name" || ')', ', ' ORDER BY e."staff_code")
	INTO bad_count, bad_list
	FROM "employments" e
	JOIN "persons" p ON p."id" = e."person_id"
	LEFT JOIN "employment_positions" ep ON ep."employment_id" = e."id"
	WHERE e."ended_on" IS NULL AND ep."id" IS NULL;

	IF bad_count > 0 THEN
		RAISE EXCEPTION 'migration 0152 refuses to run: % open employment(s) have no position at all, which Ians ruling (docs/tasks/318-position-decides-access.md) makes a DATA ERROR the backfill must not paper over. Give each one a position, then re-run. Offenders (staff code, name): %', bad_count, bad_list;
	END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 2 — refuse if any organisation THAT STEP 3 WOULD ACTUALLY WRITE A ROW FOR cannot be
-- resolved to exactly one attribution person by the two-tier super_admin-then-admin rule. An
-- org with no stores or no active positions is excluded entirely: it receives nothing, so there
-- is nobody to protect by refusing for it.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	bad_org_count int;
	bad_org_list text;
BEGIN
	WITH candidate_orgs AS (
		SELECT o."id", o."name"
		FROM "organizations" o
		WHERE EXISTS (
			SELECT 1 FROM "stores" s JOIN "positions" p ON p."org_id" = s."org_id"
			WHERE s."org_id" = o."id" AND p."store_id" IS NULL AND p."is_active" = true
			UNION ALL
			SELECT 1 FROM "positions" p WHERE p."org_id" = o."id" AND p."store_id" IS NOT NULL AND p."is_active" = true
		)
	),
	tiers AS (
		SELECT
			co."id", co."name",
			sa.n AS sa_n, sa.names AS sa_names,
			ad.n AS ad_n, ad.names AS ad_names
		FROM candidate_orgs co
		CROSS JOIN LATERAL (
			SELECT count(*) AS n, string_agg(p."display_name", ', ' ORDER BY p."display_name") AS names
			FROM "person_roles" pr JOIN "persons" p ON p."id" = pr."person_id"
			WHERE pr."org_id" = co."id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL
		) sa
		CROSS JOIN LATERAL (
			SELECT count(*) AS n, string_agg(p."display_name", ', ' ORDER BY p."display_name") AS names
			FROM "person_roles" pr JOIN "persons" p ON p."id" = pr."person_id"
			WHERE pr."org_id" = co."id" AND pr."role" = 'admin' AND pr."revoked_at" IS NULL
		) ad
	)
	SELECT count(*), string_agg(
		CASE
			WHEN t.sa_n > 1 THEN t."name" || ' (super_admin tier ambiguous: ' || t.sa_n || ' candidates: ' || t.sa_names || ')'
			ELSE t."name" || ' (admin tier: ' || t.ad_n || ' candidate(s): ' || coalesce(t.ad_names, 'none') || ')'
		END, '; ' ORDER BY t."name")
	INTO bad_org_count, bad_org_list
	FROM tiers t
	WHERE NOT (t.sa_n = 1 OR (t.sa_n = 0 AND t.ad_n = 1));

	IF bad_org_count > 0 THEN
		RAISE EXCEPTION 'migration 0152 refuses to run: % organisation(s) cannot be resolved to exactly one attribution person (Ians ruling, 2026-09-16: prefer the sole active super_admin; if none, the sole active admin — the account the bootstrap actually creates for the org owner; anything else refuses rather than guesses). %', bad_org_count, bad_org_list;
	END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 3 — one position_capability_defaults row per (active position x store x 21 capability).
-- Canonical positions (store_id IS NULL) pair with every store IN THE SAME ORG only. A store's
-- own position pairs only with its own store, whatever that store's is_active is (bug 1 above).
-- `org_attribution` resolves the SAME two-tier rule Step 2 already validated — safe by
-- construction after Step 2's refusal, never re-checked here, never a fallback beyond admin.
-- ---------------------------------------------------------------------------------------------
WITH org_attribution AS (
	SELECT
		o."id" AS org_id,
		COALESCE(
			(SELECT pr."person_id" FROM "person_roles" pr
			 WHERE pr."org_id" = o."id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'super_admin' AND x."revoked_at" IS NULL) = 1),
			(SELECT pr."person_id" FROM "person_roles" pr
			 WHERE pr."org_id" = o."id" AND pr."role" = 'admin' AND pr."revoked_at" IS NULL
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'super_admin' AND x."revoked_at" IS NULL) = 0
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'admin' AND x."revoked_at" IS NULL) = 1)
		) AS set_by
	FROM "organizations" o
)
INSERT INTO "position_capability_defaults" ("org_id", "position_id", "store_id", "capability", "set_by")
SELECT sp."org_id", sp."position_id", sp."store_id", cap."capability", oa."set_by"
FROM (
	SELECT s."org_id" AS org_id, p."id" AS position_id, s."id" AS store_id
	FROM "stores" s
	JOIN "positions" p ON p."org_id" = s."org_id"
	WHERE p."store_id" IS NULL AND p."is_active" = true
	UNION ALL
	SELECT p."org_id", p."id", p."store_id"
	FROM "positions" p
	WHERE p."store_id" IS NOT NULL AND p."is_active" = true
) sp
JOIN org_attribution oa ON oa."org_id" = sp."org_id"
CROSS JOIN (VALUES
	('record_sale'), ('submit_sales_day'), ('record_statutory_discount'), ('record_till_count'),
	('create_expense'), ('edit_own_expense'), ('record_stock_movement'), ('record_wastage'),
	('transfer_stock'), ('record_supplier_return'), ('record_customer_return'), ('confirm_receipt'),
	('set_item_threshold'), ('post_order_message'), ('place_branch_order'), ('fulfil_branch_order'),
	('receive_delivery'), ('record_supplier_invoice'), ('create_wholesale_order'),
	('record_order_wastage'), ('request_pos_map')
) AS cap(capability)
ON CONFLICT ("position_id", "store_id", "capability") WHERE "revoked_at" IS NULL DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 4 — materialise person_grants for every open employment holding an active position,
-- deduplicated to one row per (person, capability) — the UNION across every position a person
-- holds, never one row per (person, position, capability). DISTINCT ON picks a deterministic
-- winner (earliest set_at) among multiple qualifying defaults purely for `source_ref`
-- provenance and `granted_by` — the CAPABILITY is granted identically either way.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source", "source_ref")
SELECT DISTINCT ON (e."person_id", d."capability")
	e."person_id", d."capability", d."set_by", 'position', d."id"
FROM "employments" e
JOIN "employment_positions" ep ON ep."employment_id" = e."id"
JOIN "positions" p ON p."id" = ep."position_id" AND p."is_active" = true
JOIN "position_capability_defaults" d
	ON d."position_id" = p."id" AND d."store_id" = e."store_id" AND d."revoked_at" IS NULL
WHERE e."ended_on" IS NULL
ORDER BY e."person_id", d."capability", d."set_at"
ON CONFLICT ("person_id", "grant_name") WHERE "revoked_at" IS NULL DO NOTHING;

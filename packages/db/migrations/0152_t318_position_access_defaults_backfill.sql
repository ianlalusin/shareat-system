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
-- ⭐ ATTRIBUTION — Ian's own ruling, 2026-09-14, asked in plain language with the cost stated: his
-- name goes on every row this migration writes, because he is the person who decided to shrink
-- the staff baseline, so attributing the rows to him is TRUE, not fabricated, even though it will
-- read as if he approved ~400 rows individually when what he approved was the policy. ⛔ The
-- MECHANISM must not turn that ruling back into an inference: "Ian" is a ruling, "the earliest
-- super_admin" is a guess that usually agrees with it. So per org: exactly one active
-- `super_admin` -> use it (that person IS Ian, by his ruling); zero or more than one -> REFUSE,
-- naming every candidate found — same refuse-and-print shape as the positionless-employment gate,
-- for the same reason (an ambiguous resolution silently attributing access decisions to the wrong
-- person is precisely the outcome Ian chose against). Do NOT fall back to `admin` when there is no
-- super_admin — a different person is the fabrication the ruling rejects, not a safe default.
-- ⭐ Step 2's refusal is scoped to organisations Step 3 will actually write a row for (has an
-- active position paired to a store) — an org with none receives zero rows regardless of
-- attribution, so refusing for it protects nobody and only halts a production deploy for
-- nothing (review finding, system32-85, 2026-09-14).
--
-- Order, and why it is not negotiable (spec "THE BLAST RADIUS"):
--   1. Refuse if any open employment has no position.
--   2. Refuse if any organisation that WOULD receive a row does not have EXACTLY ONE active
--      super_admin to attribute it to — an org Step 3 would write nothing for is not checked.
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
-- Step 2 — refuse if any organisation THAT STEP 3 WOULD ACTUALLY WRITE A ROW FOR does not have
-- EXACTLY ONE active super_admin. Ian's own ruling attributes every row to him BY BEING the
-- org's super_admin, never by a guess that usually agrees with it — ambiguity here must halt the
-- migration, not resolve itself. An org with no stores or no active positions is excluded from
-- this check entirely: it receives nothing, so there is nobody to protect by refusing for it.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	bad_org_count int;
	bad_org_list text;
BEGIN
	SELECT count(*),
		string_agg(o."name" || ' (' || sa.n || ' active super_admin(s): ' || coalesce(sa.names, 'none') || ')', '; ' ORDER BY o."name")
	INTO bad_org_count, bad_org_list
	FROM "organizations" o
	CROSS JOIN LATERAL (
		SELECT count(*) AS n, string_agg(p."display_name", ', ' ORDER BY p."display_name") AS names
		FROM "person_roles" pr
		JOIN "persons" p ON p."id" = pr."person_id"
		WHERE pr."org_id" = o."id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL
	) sa
	WHERE sa.n <> 1
	-- Scoped to organisations Step 3 will actually write a row for. An org with no stores or no
	-- active positions receives zero rows regardless of who it is attributed to, so refusing for
	-- it protects nobody and only halts a production deploy for no reason (system32-85, review,
	-- 2026-09-14). This EXISTS clause mirrors Step 3's own population exactly, on purpose — if the
	-- two ever drift, Step 3 is the ground truth to match, never this one.
	AND EXISTS (
		SELECT 1 FROM "stores" s JOIN "positions" p ON p."org_id" = s."org_id"
		WHERE s."org_id" = o."id" AND p."store_id" IS NULL AND p."is_active" = true
		UNION ALL
		SELECT 1 FROM "positions" p WHERE p."org_id" = o."id" AND p."store_id" IS NOT NULL AND p."is_active" = true
	);

	IF bad_org_count > 0 THEN
		RAISE EXCEPTION 'migration 0152 refuses to run: % organisation(s) do not have exactly one active super_admin to attribute this backfill to (Ians ruling, 2026-09-14: the org''s super_admin, never a guess). Offending organisations: %', bad_org_count, bad_org_list;
	END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 3 — one position_capability_defaults row per (active position x store x 21 capability).
-- Canonical positions (store_id IS NULL) pair with every store IN THE SAME ORG only. A store's
-- own position pairs only with its own store, whatever that store's is_active is (bug 1 above).
-- set_by resolves per-org to that org's sole active super_admin — safe by construction after
-- Step 2's refusal, never a fallback.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "position_capability_defaults" ("org_id", "position_id", "store_id", "capability", "set_by")
SELECT sp."org_id", sp."position_id", sp."store_id", cap."capability", sp."set_by"
FROM (
	SELECT
		s."org_id" AS org_id, p."id" AS position_id, s."id" AS store_id,
		(SELECT pr."person_id" FROM "person_roles" pr WHERE pr."org_id" = s."org_id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL) AS set_by
	FROM "stores" s
	JOIN "positions" p ON p."org_id" = s."org_id"
	WHERE p."store_id" IS NULL AND p."is_active" = true
	UNION ALL
	SELECT
		p."org_id", p."id", p."store_id",
		(SELECT pr."person_id" FROM "person_roles" pr WHERE pr."org_id" = p."org_id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL)
	FROM "positions" p
	WHERE p."store_id" IS NOT NULL AND p."is_active" = true
) sp
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

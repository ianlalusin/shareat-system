# T-592 — Sales channels page: one store code, only where it belongs

Status: SPEC (Opus), 2026-11-17. Owner: T-592 session (started by BOSS). Branch `claude/t592-sales-channels-a22340`.
Ian's request (via BOSS): daily channels get no store code; Foodpanda/Grab cards ask for their code directly, no platform
dropdown; full width; better look; "what is the settlement wiring for if we already have the store code?"; review the page.
His worry: one store could carry three Foodpanda codes in three places.

## Facts on main (f31e437) — verified in the files, not only the code map

| What | Where | Read by |
|---|---|---|
| Platform + store code | `sales_channels.platform`, `.platform_store_code` (0228). Pair CHECK (both or neither). Unique per org + platform + code, active and retired | **Statement matching**: `settlement-intake/store-match.ts` `matchChannel` → `settlementIntakeRepo.channelByPlatformCode`; `day-checks.ts:137`; `sales-days.ts:321` |
| Foodpanda "partner code" | **Does not exist on main.** T-515 had `foodpanda_partner_code`; T-564 dropped it (0257 header) because the channel code already is it | — |
| Store key, outlet names, file-name starts, wastage-email switch | `store_channel_settlement_configs` (0257) | **Nothing matches on them.** Only reader: `settlementWiringWarnings` (`store-channel-settlement/index.ts:48`), shown in the settlement preview (`channel-settlements/index.ts:677`) |
| Bank names per channel | `sales_channels.bank_hints` (0257) | **Nothing.** Card says "Not used yet" |

So the code IS stored once today. What lets Ian's "three places" happen:
1. The "Platform and store code" form sits on **every** card, dine-in included, and nothing stops a code on a daily channel.
2. A store may hold several channels of the same platform, each with its own code.
3. The wiring panel asks for outlet names and file names that look like a second and third way to identify the store.
4. `settlementWiringWarnings` is **wrong**: it says "without a store key a payout statement cannot be matched to this store".
   Matching never uses the store key. It uses the channel's code.

## Q4 answered plainly (for Ian)

> The settlement wiring is a leftover from the old system. The old ERP found which store a payout file belonged to by
> reading the outlet name inside it and the start of its file name ("lip 15.zip" means Lipa). The new system finds the
> store by the Foodpanda or Grab store code alone. Nothing reads the wiring today, and its one warning is wrong.
> The wastage-email switch is for a feature that is not built yet.

## Rulings

R1. **Only settle-later channels get a code.** Daily ("reaches the till") cards show no code form at all.
- Domain: `setSalesChannelPlatformCode` refuses a code on a daily channel ("Dine-in reaches the till, so it has no
  store code."). `updateSalesChannel` refuses switching a coded channel to daily ("Ask an admin to clear its Foodpanda
  store code first.").
- Database is the authority: `CHECK (platform IS NULL OR NOT is_remitted_daily)`.

R2. **At most one active channel per platform per store.** `UNIQUE (org_id, store_id, platform) WHERE platform IS NOT NULL AND is_active`.
Reactivating a retired coded channel when another active one holds that platform is refused with a sentence (map the
23505 in the domain). Gated on the production count (see below): if a real store needs two Foodpanda shops, drop R2.

R3. **No platform dropdown.**
- Card with platform set: one box labelled "Foodpanda store code" (or "Grab store ID"). Blank + save clears the code
  and the platform together.
- Settle-later card with no platform yet (admin only): two radio rows "Foodpanda" / "Grab" plus the code box, in one
  form. Shown only until the platform is set. (Radios, not a select: two visible choices, no hidden "None".)
- Daily card: nothing.
- Add-channel form unchanged (managers create channels; the platform stays admin-only, set on the card after).

R4. **Settlement wiring — RULED A by Ian 17 Nov 2026 (via BOSS): wiring panel and bank names removed from the page; DB data kept.** (Domain and repo functions also kept; no migration.)
- **A (recommended): take the wiring off the page.** Remove the panel (store key, outlet names, file-name starts,
  wastage email) and the per-channel bank-names form. Delete `settlementWiringWarnings` and its preview field (it is
  wrong). Keep the table and columns as they are (no data dropped, no migration for this); a later task brings back
  only what a real reader needs (the wastage email reader, if built).
  Why: it is the only option where each fact is asked once, and nothing is lost because nothing uses it.
- **B (BOSS's first direction): fold it into the delivery cards.** Outlet names, file-name starts and the email switch
  move onto the Foodpanda/Grab card; store key hidden. Cost: these are per store, not per channel, so the same values
  show on both cards or need a schema move; and the page still asks for fields nothing reads.

R5. **Layout (impeccable pass).** Page is already uncapped (`density="table"`). Channel cards go in a responsive grid
(1 column phone, 2 at `lg`, 3 at `2xl`); summary first, edit behind `EditableRecord` as today; one consistent card
anatomy: name + pills, money line (payout wallet / till), store code line, actions. Phone 375 px must not scroll sideways.

## Migration 0261 (number to be confirmed by BOSS before claiming)

Hand-authored per ADR-012 §5. `SET LOCAL lock_timeout = '5s'`.
1. Pre-check: `DO $$ ... RAISE EXCEPTION` naming the count and each offending row as `<store code> / "<channel name>"` of (a) coded daily channels, (b) stores with
   two active channels on one platform. **Never moves or picks a code silently.** It ends: "Move the code on screen first: ... then deploy again. Nothing was changed."
2. `ALTER TABLE sales_channels ADD CONSTRAINT sales_channels_platform_only_settle_later_check CHECK (platform IS NULL OR NOT is_remitted_daily) NOT VALID;` then `VALIDATE CONSTRAINT` (short lock).
3. `CREATE UNIQUE INDEX sales_channels_store_platform_active_key ON sales_channels (org_id, store_id, platform) WHERE platform IS NOT NULL AND is_active;` (table is tiny; plain create is fine inside the migration transaction).
4. Journal entry idx after main's latest, `when` = previous + 86400000. No new table, so no classification/registry entry.
5. Constraint-message lookup: add both names to the plain-sentence map (`constraint-messages`).

## Production count (Ian approved ONE read-only count) - RESULT

Run by BOSS on Ian's say-so, 17 Nov 2026, as doadmin via SYSTEM_DATABASE_URL, read-only, rolled back (Ian did not run it). Totals: 2 stores, 3 channels. a. codes on daily channels: LIPA 1. b. more than one channel on one platform: 0. c. settle-later channels with no platform: LIPA 2. d. settlement configs 0 (labels/hints 0, email on 0); channels with bank hints 1.

Consequence: 0261 refuses on production until Ian moves LIPA's code on the current screen (BOSS ruling 17 Nov: keep the refusal, never move it in SQL). MERGER holds the PR until Ian confirms the move.

The query that was run (as the database owner, since RLS is forced for the app role; prints no secrets and no codes):

```sql
BEGIN READ ONLY;
-- a. codes on daily channels
SELECT s.code AS store, count(*) FROM sales_channels c JOIN stores s ON s.id = c.store_id
 WHERE c.platform IS NOT NULL AND c.is_remitted_daily GROUP BY 1;
-- b. stores with more than one channel on one platform (all / active)
SELECT s.code AS store, c.platform, count(*) AS all_ch, count(*) FILTER (WHERE c.is_active) AS active_ch
  FROM sales_channels c JOIN stores s ON s.id = c.store_id WHERE c.platform IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- c. settle-later channels with no platform yet (these cards will show the Foodpanda/Grab choice)
SELECT s.code AS store, count(*) FROM sales_channels c JOIN stores s ON s.id = c.store_id
 WHERE NOT c.is_remitted_daily AND c.platform IS NULL GROUP BY 1;
-- d. how much wiring was ever filled in (decides how safe R4-A is)
SELECT count(*) AS configs,
       count(*) FILTER (WHERE cardinality(match_labels) > 0 OR cardinality(file_hints) > 0) AS with_labels_or_hints,
       count(*) FILTER (WHERE wastage_email_ingest_enabled) AS email_on
  FROM store_channel_settlement_configs;
SELECT count(*) FILTER (WHERE cardinality(bank_hints) > 0) AS channels_with_bank_hints FROM sales_channels;
ROLLBACK;
```
"Partner code vs channel code disagreements": not countable — the partner-code column never reached main (see facts).

## In / out

In: R1–R3, R4 as Ian rules, R5, migration 0261, constraint sentences, tests, census re-measure, `docs/ui-review/PAGES.md` row.
Out: changing statement parsing; the add-channel form gaining a platform; dropping the 0257 table/columns; the payout
wallet (stays on `/channel-settlements`); `/admin/stores` readiness rows.

## Tests (runtime first; each refusal = positive case + mutant shown red, red output quoted in the PR)

1. Domain integration (`packages/domain/tests/integration/t592-store-code.test.ts`):
   code on a settle-later channel saves (positive); code on a daily channel refused, no row change, no audit row;
   coded channel switched to daily refused; second active Foodpanda channel at the same store refused, a retired one is
   fine; reactivation into a clash refused with the sentence. Mutants: delete the domain check → the DB CHECK/index
   still refuses (proves the DB is the authority) and the test asserting the *sentence* goes red.
2. Migration integration (`packages/db/tests/integration/t592-migration.test.ts`): raw insert of a coded daily channel
   refused by the CHECK; pre-check raises on a seeded bad row (run the DO block on a fresh DB with the row present).
3. Web (`apps/erp/tests/integration/`): rendered page for a daily channel has no `code` input; Foodpanda card has a box
   labelled "Foodpanda store code" and no `select[name=platform]`; with R4-A, no `storeKey`/`matchLabels` inputs.
4. Existing tests that change: `t564-store-settlement-config.test.ts` preview-warning cases (R4-A deletes them),
   `t511-s2b-field-rules.test.ts` (platform rule), `t389-s2-sales-channels-web.test.ts`.

## Census pins touched (RE-MEASURE, never hand-edit)
`apps/erp/tests/action-link-sweep.test.ts` count, `apps/erp/tests/editable-record-baseline.json`
(`settings/sales-channels/page.tsx`), touch-target baseline, `tests/unit/t343-throw-ratchet.test.ts`
(`packages/domain/src/sales-channels`: 10 — new refusals use `refuse()`, not `throw new Error`), PAGES.md guard.

## Build order
S1 domain + migration + tests (Sonnet). S2 page (Sonnet, impeccable brief). S3 Opus verify + browser screenshots on a
private port (not 9008/9018/9038), desktop + 375 px. One PR.

## Audit fix (2026-11-18, audit F1 — stacked PR on this branch)
Finding: the saved-code form posts the hidden platform with a blank code (`platform=foodpanda, code=''`); the action passed
that through and the domain refused "a platform needs a code", so R3's "blank + save clears" never worked and a coded
channel could not be emptied before switching it to daily (R1).
Fix, two files only:
- `apps/erp/src/app/settings/sales-channels/actions.ts` `setPlatformCodeAction`: a blank (trimmed) code sends
  `platform: null, code: null`. The domain pair rule, field rules and the admin-only `authorize()` stay unchanged.
- `apps/erp/tests/integration/t511-s2b-actions.test.ts`: empty and whitespace-only code with the hidden platform clear
  both columns, then the shared form's daily switch saves. The two old refusal cases for exactly that payload are
  removed (they encoded the pre-R3 behaviour); every malformed NON-blank case stays refused.
No migration, no new number (the behaviour is R3's own).

# T-515 — Store settings and channel-settlement wiring

**Status:** **re-applied on main as T-564 (migration 0257), 2026-11-14.** The original build (branch
`feat/store-settlement-settings`, migration 0213_t515) never merged and its migration number clashed with
main's `0213_t398`. `docs/tasks/564-store-settlement-wiring-renumber.md` is the binding record; where this
page and that one differ, T-564 wins. What changed: the platform and the Foodpanda code are NOT re-added
(main already has `sales_channels.platform` / `platform_store_code`, unique and audited); the cash-policy
form is NOT re-added (`/remittance` already has it; the store page links to it); the new fields are
**stored, not yet read by intake**; every write leaves an audit row; the preview warnings are two, not three, and are stored and carried on the preview, not yet shown on a screen.

## The decisions

1. **The platform code is unique per organisation.** That is already true on main:
   `sales_channels.platform_store_code` (T-511 S2a, migration 0228) is unique per organisation and
   platform, ignoring case. The v1 note that two stores may share one was a TEST/sandbox artefact.
2. **Port what main lacks, faithfully (Ian, 2026-11-10).** The store key, outlet-name labels, file hints,
   the wastage-email opt-in and per-channel bank hints. Everything with an existing home stays there:
   the platform and its store code are `sales_channels.platform` / `platform_store_code`, the payout
   account is `sales_channels.destination_money_account_id`, tax treatment is `sales_channels.tax_treatment`.
   **Stored, not yet read by intake:** nothing matches a statement on these fields yet.
3. **Every store setting that has a writer has a screen.** Cash settings already exist on `/remittance`;
   the store page links to them, to Sales channels and to the POS link.
4. One branch, one audit, one merge.

## Data model (migration 0257)

`store_channel_settlement_configs` — one per store:

| Column | Rule |
|---|---|
| `store_key` | lowercase slug, unique per org, **immutable once saved** (domain refuses; the app role has no UPDATE on it) |
| `match_labels` | text[], outlet-name matching |
| `file_hints` | text[], bulk-upload filename routing |
| `wastage_email_ingest_enabled` | boolean, default false (fail-closed) |

`sales_channels.bank_hints` — text[], default empty.

## UI

- `/settings/sales-channels`: a "Settlement wiring" panel (store key once, labels, file hints, email opt-in)
  and, per channel, a "bank names" form. Capability `manage_store_settings`; each real change writes an
  audit row (`store_settlement.wiring_saved`, `sales_channel.bank_hints_edited`).
- `/admin/stores/[id]`: links to Sales channels, POS link and Cash settings.
- Channel settlements preview: `storeKey` and `wiringWarnings` (no key; key but no labels and no file hints).
  Warnings never block a post.

## Store-settings audit

| Store attribute | Where editable |
|---|---|
| code | **not editable** — stable handle |
| name, timezone, address, contact, TIN branch code | Store details |
| opening date | Opening date |
| stock model | Stock model |
| active / inactive | Deactivate / reactivate |
| remittance cadence, unremitted ceiling | `/remittance` cash settings (linked from the store page) |
| Wastage Monitor | `/settings/wastage-monitor` |
| sales channels | `/settings/sales-channels` (linked from the store page) |
| POS store link + POS sales channel | `/settings/pos-link` (linked from the store page) |
| channel settlement wiring | Settlement wiring panel |
| legal name, TIN, tax type | `/settings/organization` — org-owned, not duplicated per store |
| POS hours, radii, offers, reservations/chat flags | not modelled in v2 yet; belongs to the POS settings task |

## Verification

See `docs/tasks/564-store-settlement-wiring-renumber.md` and `packages/domain/tests/integration/t564-store-settlement-config.test.ts`.

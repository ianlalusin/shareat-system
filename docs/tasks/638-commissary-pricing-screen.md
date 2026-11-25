# T-638: commissary pricing on screen: "price to stores" per offered item

**Owner:** builder (Sonnet). Auditor: Sonnet (money: transfer and sale prices). **Spec:** BOSS (Opus), 25 Nov 2026. **No migration expected.** If one turns out to be needed, STOP and ask BOSS.

**Ian, 25 Nov 2026:**
- "where do we set commissary pricing?"
- After BOSS found the rule has no screen: "yes do the missing pricing part".
- STANDING rule: every business value needs a UI door.

## Today (facts, origin/main)

- **The price a commissary charges a branch or a franchise** (T-151):
  - basis = the higher of the item's last two landed delivery costs (derived on read: packages/db/src/repo/items.ts ~1385-1415; `computeBranchPrice` in packages/domain/src/items/branch-price.ts)
  - then a per-item rule: `fixed` / `fixed_markup` / `percent_markup`, plus an optional margin alert threshold
- **The fallback tiers:** a slab link first, then the item's own landed history, then the manual cost typed on Commissary → Catalogue → "+ Offer item".
- `setItemPricing` (packages/domain/src/items/index.ts:1491) authorizes `manage_items` first, parses after authorize (T-371), and audits.
  - It has **NO screen caller**: tests/unit/domain-actions-have-callers.test.ts:231 lists it as UNWIRED (DEF-198).
  - The sibling at :235 (the cost-basis / slab link) is unwired too. Check it, and wire it if it's the same screen.
- Screen: apps/erp/src/app/commissary/catalogue/page.tsx (offerings table, the "+ Offer item" form with manual cost).

## Rule

1. On **Commissary → Catalogue**, in the offerings table, each offered item gets a **"Price to stores"** column. It shows the price in force now, with how it was worked out in plain words:
   - "₱245.00 = last delivery ₱213.04 + 15%"
   - "₱180.00 fixed"
   - "₱95.00 = manual cost (no deliveries yet)"
   - "Needs a cost" when there is nothing; never price at zero (v1 rule)
   - A muted "below your X% margin alert" chip when the alert would fire.
   - Use the SAME derive function the orders use; never a second copy of the maths.
2. **Edit price** (a quiet button, a dialog, EditableRecord/CheckedForm house pattern):
   - Rule: Fixed price / Basis + amount / Basis + percent
   - The matching figure
   - Optional margin alert %
   - A live preview line of the resulting price against the current basis
   - It saves through `setItemPricing` (authorize first; same capability). The server action authorizes before assertFieldRules (T-440 S9 G6).
3. If the cost-basis / slab link (`domain-actions-have-callers.test.ts:235`) belongs to the same item pricing, wire it in the same dialog ("Priced from slab: …"). If it's a separate concept, leave it and say why.
4. Remove `setItemPricing` (and the sibling, if wired) from the UNWIRED exemption list. The census guard then proves the caller.
5. Phone 390px: rows become cards (house phone-table pattern); 44px taps. Invoke `impeccable`.

## Not in this task

- Per-buyer price lists for the commissary.
- Changing the "max of last two deliveries" basis.
- Franchise-specific prices.
- Online/menu prices (that's /menu/prices).

## Tests (each with a mutant that goes red)

1. The page shows the price and the "worked out" text for each mode, plus the "Needs a cost" case (a page or component test with a fake read model).
2. The action authorizes before field checks; a role without the capability is refused.
3. A save writes item_pricing through `setItemPricing` with an audit row (integration).
4. The preview line equals `computeBranchPrice` for the same inputs.
5. The census: `setItemPricing` now has a production caller.

Run census:write (touch targets, t450 inventory, row links, live-check, editable-record guards, domain-actions-have-callers). Typecheck per shareat-builder.md.

## Change (Ian, 25 Nov 2026): edit it on the ITEM page, show it on the catalogue

Ian's words: "i guess we put that to product pricing too, we have already that right the screen where we set wholesale and retail price why not put there?"

- **The edit lives on /items/[id]**, in the "Bought and sold as" section, on the Wholesale row: "Price to stores" (the price now plus the worked-out text) and an **Edit price** dialog (Fixed / + amount / + percent, margin alert, live preview), saving through `setItemPricing`. It shows whenever the item is sellable wholesale (org flag or any store override). If it isn't, it shows a quiet hint that it applies once Wholesale is ticked.
- **Commissary → Catalogue** shows a READ-ONLY "Price to stores" column (same derive function plus the worked-out text), and each price links to the item page. There is no second edit path.
- Retail (diner) prices stay on Menu → Prices / What this store sells. Say so in a one-line hint on the item page, so nobody looks for them there.
- Tests are unchanged in substance (the page test covers the item page; the catalogue column test is a read-only render).

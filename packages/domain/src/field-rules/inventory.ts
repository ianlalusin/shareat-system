/**
 * T-440 field rules for app/inventory. One set per form. Quantities are plain non-negative numbers here: the stock module's
 * quantity parser (`parseRequiredQuantity`) still decides the exact decimal places and refuses a zero in its own words.
 * Repeated line rows that share a name down a page (delivery lines, usage lines, the receive-delivery quantities, the recipe
 * ingredients) are a repeated line family and stay with S8.
 */
import { defineFieldRules } from './check';

/** Open a count session: which rooms is a row of ticks (not a text rule); the count date is the rule. */
export const INVENTORY_COUNT_OPEN_RULES = defineFieldRules('inventory.openCountSession', {
  countedOn: { label: 'The count date', kind: 'date' },
});

/**
 * One counted line. The saved-row forms carry the item and room as hidden boxes, so one set covers the row forms and the
 * "here but not expected" form.
 */
export const INVENTORY_COUNT_LINE_RULES = defineFieldRules('inventory.recordCount', {
  itemId: { label: 'The item', kind: 'text', requires: 'Choose the item that was counted.' },
  locationId: { label: 'The room', kind: 'text', requires: 'Choose the room it was counted in.' },
  countedQuantity: {
    label: 'The counted quantity',
    kind: 'number',
    min: 0,
    requires: 'That is not a valid quantity: use a number of 0 or more, with at most three decimal places.',
  },
});

/**
 * The header of a new delivery. The supplier is required for a supplier delivery and optional for a cash purchase, which
 * compares two boxes: that stays a save-time refusal (the select carries the native `required` in supplier mode).
 */
export const INVENTORY_DELIVERY_RULES = defineFieldRules('inventory.createDeliveryDocument', {
  kind: { label: 'The kind', kind: 'text', requires: 'Choose whether this is a supplier delivery or a cash purchase.' },
  supplierId: { label: 'The supplier', optional: true, kind: 'text' },
  deliveredOn: { label: 'The delivery date', kind: 'date' },
});

/** Add a room. */
export const INVENTORY_LOCATION_RULES = defineFieldRules('inventory.createLocation', {
  code: { label: 'The room code', kind: 'text', requires: 'A room needs a code.' },
  name: { label: 'The room name', kind: 'text', requires: 'A room needs a name.' },
  typeId: { label: 'The room type', kind: 'text', requires: 'Choose a room type.' },
});

/** A low-stock threshold. A blank CLEARS the threshold (zero is a different, real setting), so it is allowed. */
export const INVENTORY_THRESHOLD_RULES = defineFieldRules('inventory.setThreshold', {
  threshold: { label: 'Low-stock threshold', optional: true, kind: 'number', min: 0 },
});

/** New / edit POS item mapping. */
export const INVENTORY_POS_MAP_RULES = defineFieldRules('inventory.upsertPosItemMap', {
  posItemKey: { label: 'The POS item key', kind: 'text', requires: 'A map needs the POS item key.' },
  posItemName: { label: 'The POS item name', kind: 'text', requires: 'A map needs the POS item name.' },
});

/** Void a POS usage pull. */
export const INVENTORY_POS_VOID_RULES = defineFieldRules('inventory.voidPosUsagePull', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this pull is being voided.' },
});

/** Save a production draft: only the date is a single named box that every kind carries. */
export const INVENTORY_PRODUCTION_RULES = defineFieldRules('inventory.createProductionDraft', {
  producedOn: { label: 'The production date', kind: 'date' },
});

/** Void a production record. */
export const INVENTORY_PRODUCTION_VOID_RULES = defineFieldRules('inventory.voidProduction', {
  reason: { label: 'The reason', kind: 'text', requires: 'A void needs a reason.' },
});

/** Refund a supplier's credit. */
export const INVENTORY_REFUND_RULES = defineFieldRules('inventory.refundSupplierCredit', {
  amount: { label: 'The refund amount', kind: 'money', min: 0.01 },
});

/** Return goods to a supplier. */
export const INVENTORY_RETURN_RULES = defineFieldRules('inventory.recordReturn', {
  quantity: { label: 'The quantity', kind: 'number', min: 0 },
  reason: { label: 'The reason', kind: 'text', requires: 'A return needs a reason.' },
});

/** Void a supplier return. */
export const INVENTORY_RETURN_VOID_RULES = defineFieldRules('inventory.voidReturn', {
  reason: { label: 'The reason', kind: 'text', requires: 'A void needs a reason.' },
});

/** A new stock transfer (the from / to rooms are the TwoWayPicker's). */
export const INVENTORY_TRANSFER_RULES = defineFieldRules('inventory.createTransfer', {
  itemId: { label: 'The item', kind: 'text', requires: 'Choose the item to transfer.' },
  quantity: { label: 'The quantity', kind: 'number', min: 0 },
});

/** Void a stock transfer. */
export const INVENTORY_TRANSFER_VOID_RULES = defineFieldRules('inventory.voidTransfer', {
  reason: { label: 'The reason', kind: 'text', requires: 'A void needs a reason.' },
});

/** Void a usage record. */
export const INVENTORY_USAGE_VOID_RULES = defineFieldRules('inventory.voidUsage', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this usage record is being voided.' },
});

// Practice-copy seed: a realistic store for clicking through the POS with synthetic data only.
// Local emulators only (127.0.0.1), fixed demo project, ports from the same env vars the POS uses.
// Field names follow apps/pos/src/lib/types.ts and the hooks that read them (storeConfig/current, storePackages, storeRefills ...).
const projectId = 'demo-shareat-pos2';
const authPort = process.env.POS_EMULATOR_AUTH_PORT || '9099';
const fsPort = process.env.POS_EMULATOR_FIRESTORE_PORT || '8080';
const storeId = 'practice-store';
const password = 'Practice-2026!';
const people = [
  { email: 'cashier@pos.test', name: 'Practice Cashier', role: 'cashier' },
  { email: 'manager@pos.test', name: 'Practice Manager', role: 'manager' },
];
if (!process.argv.includes('--confirm')) {
  console.log(`Practice fixture: ${projectId}, store ${storeId}, logins ${people.map((p) => p.email).join(', ')}. Add --confirm to seed local emulators.`);
  process.exit(0);
}
async function request(url, body, method = 'POST', headers = {}) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || ![fsPort, authPort].includes(parsed.port)) throw new Error('Only local emulator endpoints are allowed.');
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Emulator fixture request failed.');
  return data;
}
const authBase = `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:`;
const key = '?key=emulator-only-not-a-real-key';
function field(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, field(v)])) } };
}
async function doc(path, data) {
  return request(`http://127.0.0.1:${fsPort}/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, field(v)])) }, 'PATCH', { authorization: 'Bearer owner' });
}
const now = new Date();
const stamps = { createdAt: now, updatedAt: now, createdBy: 'practice-seed', updatedBy: 'practice-seed' };

// 1. Logins + staff profiles (role comes from staff/{uid}; 'admin' would see every store, so none is created).
for (const p of people) {
  let acct;
  try { acct = await request(authBase + 'signUp' + key, { email: p.email, password, returnSecureToken: true }); }
  catch (e) {
    if (e.message !== 'EMAIL_EXISTS') throw e;
    acct = await request(authBase + 'signInWithPassword' + key, { email: p.email, password, returnSecureToken: true });
  }
  await doc(`staff/${acct.localId}`, { username: p.name, displayName: p.name, name: p.name, email: p.email, role: p.role, status: 'active', assignedStoreIds: [storeId] });
}

// 2. Store
await doc(`stores/${storeId}`, {
  name: 'Practice Branch', code: 'PRAC', address: '1 Practice St, Test City', isActive: true,
  offersUnlimited: true, offersAlaCarte: true, taxType: 'VAT_INCLUSIVE', taxRatePct: 12, tin: '000-000-000-000',
  openingTime: '10:00', closingTime: '22:00', contactNumber: '0000000000', createdAt: now, updatedAt: now,
});
await doc(`stores/${storeId}/receiptSettings/main`, {
  businessName: 'SharEat Practice', branchName: 'Practice Branch', address: '1 Practice St, Test City', contact: '0000000000', tin: '000-000-000-000',
  vatType: 'VAT', showLogo: false, showCashierName: true, showTableOrCustomer: true, showItemNotes: true, showDiscountBreakdown: true,
  showChargeBreakdown: true, paperWidth: '58mm', autoPrintAfterPayment: false, fontSize: 12, fontFamily: 'monospace', footerText: 'PRACTICE COPY - NOT A REAL RECEIPT',
});

// 3. Six tables (singleton config projection + plain tables collection)
const tables = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `table-${n}`, code: `T${n}`, tableNumber: String(n), displayName: `Table ${n}`, capacity: n <= 4 ? 4 : 6, status: 'available', currentSessionId: null, isActive: true }));
for (const t of tables) {
  await doc(`stores/${storeId}/storeConfig/current/tables/${t.id}`, t);
  await doc(`stores/${storeId}/tables/${t.id}`, t);
}

// 4. Menu: flavours, refills (meats/sides), packages
const flavors = [['spicy', 'Spicy'], ['garlic', 'Garlic Butter'], ['original', 'Original'], ['honey', 'Honey Soy']];
const refills = [
  { id: 'pork-belly', name: 'Pork Belly', requiresFlavor: true, allowedFlavorIds: [] },
  { id: 'beef-slices', name: 'Beef Slices', requiresFlavor: true, allowedFlavorIds: [] },
  { id: 'chicken', name: 'Chicken Thigh', requiresFlavor: true, allowedFlavorIds: ['spicy', 'garlic', 'original'] },
  { id: 'rice', name: 'Rice', requiresFlavor: false, allowedFlavorIds: [] },
  { id: 'kimchi', name: 'Kimchi', requiresFlavor: false, allowedFlavorIds: [] },
];
const refillIds = refills.map((r) => r.id);
const packageDefs = [
  { id: 'pkg-classic', name: 'Classic Unlimited', price: 399, refs: ['pork-belly', 'chicken', 'rice', 'kimchi'], sortOrder: 1 },
  { id: 'pkg-premium', name: 'Premium Unlimited', price: 599, refs: refillIds, sortOrder: 2 },
  { id: 'pkg-supreme', name: 'Supreme Unlimited', price: 799, refs: refillIds, sortOrder: 3 },
];
// Kitchen stations: starting a session sends the package to its station, and refuses with none.
const stations = [['grill', 'Grill', 1], ['drinks', 'Drinks', 2]];
for (const [id, name, sortOrder] of stations) await doc(`stores/${storeId}/kitchenLocations/${id}`, { name, sortOrder, isActive: true, slaMinutes: 15 });
const stationName = { grill: 'Grill', drinks: 'Drinks' };
const flavorIds = flavors.map(([id]) => id);
for (const [i, [id, name]] of flavors.entries()) {
  await doc(`flavors/${id}`, { name, isActive: true, createdAt: now, updatedAt: now });
  await doc(`stores/${storeId}/storeFlavors/${id}`, { flavorId: id, flavorName: name, isEnabled: true, sortOrder: i + 1 });
}
for (const [i, r] of refills.entries()) {
  await doc(`refills/${r.id}`, { name: r.name, requiresFlavor: r.requiresFlavor, allowedFlavorIds: r.allowedFlavorIds, isActive: true, createdAt: now, updatedAt: now });
  await doc(`stores/${storeId}/storeRefills/${r.id}`, { refillId: r.id, refillName: r.name, isEnabled: true, sortOrder: i + 1, kitchenLocationId: 'grill', kitchenLocationName: stationName.grill, flavorsAllowed: null, isOther: false });
}
await doc(`stores/${storeId}/storeRefills/extra-lettuce`, { refillId: 'extra-lettuce', refillName: 'Lettuce (extra)', isEnabled: true, sortOrder: 9, kitchenLocationId: 'grill', kitchenLocationName: stationName.grill, flavorsAllowed: null, isOther: true });
const storePackages = packageDefs.map((p) => ({ packageId: p.id, packageName: p.name, isEnabled: true, pricePerHead: p.price, kitchenLocationId: 'grill', kitchenLocationName: stationName.grill,
  refillsAllowed: p.refs, flavorsAllowed: flavorIds, sortOrder: p.sortOrder, menuScheduleId: null }));
for (const p of packageDefs) {
  await doc(`packages/${p.id}`, { name: p.name, allowedRefillIds: p.refs, isActive: true, createdAt: now, updatedAt: now });
}
for (const sp of storePackages) await doc(`stores/${storeId}/storePackages/${sp.packageId}`, sp);

// 5. A la carte dishes + add-ons (inventory rows with isAddon: the add-on picker reads these)
const items = [
  ['inv-water', 'Bottled Water', 'Drinks', 35], ['inv-softdrink', 'Soft Drink', 'Drinks', 60], ['inv-iced-tea', 'Iced Tea Pitcher', 'Drinks', 120],
  ['inv-bulgogi', 'Beef Bulgogi Plate', 'A La Carte', 249], ['inv-samgyup', 'Samgyupsal Plate', 'A La Carte', 229], ['inv-bibimbap', 'Bibimbap', 'A La Carte', 199],
  ['inv-kimchi-stew', 'Kimchi Stew', 'A La Carte', 189], ['inv-cheese', 'Extra Cheese (add-on)', 'Add-ons', 49], ['inv-egg', 'Steamed Egg (add-on)', 'Add-ons', 79],
  ['inv-ice-cream', 'Ice Cream Scoop (add-on)', 'Add-ons', 59],
];
for (const [id, name, category, price] of items) {
  await doc(`products/${id}`, { name, category, uom: 'pc', isActive: true, kind: 'single', createdAt: now, updatedAt: now });
  await doc(`stores/${storeId}/inventory/${id}`, { productId: id, name, itemName: name, category, uom: 'pc', cost: Math.round(price * 0.4), sellingPrice: price, isActive: true, isAddon: true, kitchenLocationId: category === 'Drinks' ? 'drinks' : 'grill', kitchenLocationName: category === 'Drinks' ? stationName.drinks : stationName.grill, createdAt: now, updatedAt: now });
}

// 6. Payment modes (card needs the internet-connected gateway, so it can be shown but will not complete here), discounts, charges
const mop = (id, name, type, hasRef, sortOrder) => ({ id, name, type, sortOrder, isActive: true, hasRef, isArchived: false, gateway: null, ...stamps });
const modes = [mop('cash', 'Cash', 'cash', false, 1), mop('gcash', 'GCash', 'online', true, 2), mop('card', 'Card', 'card', true, 3)];
for (const m of modes) await doc(`stores/${storeId}/storeModesOfPayment/${m.id}`, m);
const disc = (id, name, type, value, sortOrder, extra = {}) => ({ id, name, type, value, scope: ['bill'], stackable: false, isEnabled: true, sortOrder, isArchived: false, ...stamps, ...extra });
const discounts = [
  disc('senior', 'Senior Citizen (20%)', 'percent', 20, 1, { vatExempt: true }),
  disc('pwd', 'PWD (20%)', 'percent', 20, 2, { vatExempt: true }),
  disc('promo50', 'Promo P50 off', 'fixed', 50, 3),
];
for (const d of discounts) await doc(`stores/${storeId}/storeDiscounts/${d.id}`, d);
const charges = [{ id: 'service', name: 'Service charge (10%)', type: 'percent', value: 10, appliesTo: 'subtotal', scope: ['bill'], isEnabled: false, sortOrder: 1, isArchived: false, ...stamps }];

await doc(`stores/${storeId}/storeConfig/current`, {
  tables: tables.map(({ id, code, tableNumber, displayName, isActive, status, currentSessionId }) => ({ id, code, tableNumber, displayName, isActive, status, currentSessionId })),
  packages: storePackages,
  flavors: flavors.map(([id, name], i) => ({ flavorId: id, flavorName: name, isEnabled: true, sortOrder: i + 1 })),
  schedules: [], discounts, charges, modesOfPayment: modes, meta: { version: 1 },
});
console.log(`Seeded Practice Branch (${storeId}): 6 tables, 3 packages, ${flavors.length} flavours, ${items.length} dishes/add-ons, Cash/GCash/Card, SC/PWD/promo discounts. Logins are in apps/pos/emulator/PRACTICE.md. No live project was used.`);

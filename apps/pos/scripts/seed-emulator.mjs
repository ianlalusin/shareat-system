// All destinations are fixed local demo-project endpoints. No cloud configuration or key is accepted.
const projectId = 'demo-shareat-pos2';
const email = 'manager@pos.test';
const password = 'Test-only-2048!';
const storeId = 'demo-store';
if (!process.argv.includes('--confirm')) {
  console.log(`Synthetic fixture: ${projectId}, ${email}, store ${storeId}. Add --confirm to seed local emulators.`);
  process.exit(0);
}
async function request(url, body, method = 'POST', headers = {}) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || !['8080', '9099'].includes(parsed.port)) throw new Error('Only local emulator endpoints are allowed.');
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Emulator fixture request failed.');
  return data;
}
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:';
let account;
try { account = await request(authBase + 'signUp?key=emulator-only-not-a-real-key', { email, password, returnSecureToken: true }); }
catch (error) {
  if (error.message !== 'EMAIL_EXISTS') throw error;
  account = await request(authBase + 'signInWithPassword?key=emulator-only-not-a-real-key', { email, password, returnSecureToken: true });
}
function field(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, field(val)])) } };
}
async function doc(path, data) {
  return request(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { fields: Object.fromEntries(Object.entries(data).map(([key, val]) => [key, field(val)])) }, 'PATCH', { authorization: 'Bearer owner' });
}
await doc(`staff/${account.localId}`, { username: 'Test Manager', displayName: 'Test Manager', name: 'Test Manager', role: 'manager', status: 'active', assignedStoreIds: [storeId] });
await doc(`stores/${storeId}`, { name: 'Emulator Store', code: 'EMU', isActive: true, offersUnlimited: true, offersAlaCarte: true, taxType: 'NON_VAT', taxRatePct: 0 });
await doc(`stores/${storeId}/tables/table-1`, { tableNumber: '1', displayName: 'Test Table 1', capacity: 4, status: 'available', currentSessionId: null, isActive: true });
await doc(`stores/${storeId}/storeModesOfPayment/cash`, { name: 'Cash', type: 'cash', isActive: true, sortOrder: 1 });
await doc(`stores/${storeId}/storeConfig/current`, {
  tables: [], packages: [], flavors: [], schedules: [], discounts: [], charges: [],
  modesOfPayment: [{ id: 'cash', name: 'Cash', type: 'cash', isActive: true, sortOrder: 1 }],
  meta: { version: 1 },
});
await doc(`stores/${storeId}/storeConfig/current/tables/table-1`, {
  tableNumber: '1', displayName: 'Test Table 1', capacity: 4, status: 'available', currentSessionId: null, isActive: true,
});
await doc(`stores/${storeId}/inventory/test-dish`, { name: 'Test dish', itemName: 'Test dish', isAddon: true, isActive: true, sellingPrice: 100 });
console.log(`Seeded synthetic manager and Emulator Store. Login: ${email}; password: ${password}. No live project was used.`);

#!/usr/bin/env node
// T-424 Ruling 11 - the POS v2 detector. READ-ONLY, run by a person (never by a build or a request).
//
//   node apps/pos/scripts/pos2-audit.mjs --from=20261001 --to=20261016 [--store=<pos store id>]...
//   POS_FIREBASE_SA_KEY_FILE=<path to the service-account JSON> is read from the environment (never printed, never a flag).
//
// For each store and day (Manila business day of the document's own clock) it lists, as COUNTS and RECEIPT / DOCUMENT NUMBERS ONLY:
//   1. refund receipts with no `approvedByPersonId`                (a refund the POS v2 server did not approve: v1's open doors, or a forged record)
//   2. refund receipts with no `receiptNumbers/{number}` document  (a refund that skipped the numbered series)
//   3. `paymentConversions` whose `source` is not 'pos2-correction' (a conversion made by v1's /api/analytics/payment-conversion, no PIN)
//   4. 'pos2-correction' conversions that v1 has since VOIDED      (status 'voided': v1's dashboard reversed a v2 correction)
//   5. unpaid sessions VOIDED OFFLINE (T-425, `voidedOffline: true`)   (a manager reviews every void made without the internet; listed by session id)
// It only ever calls `.get()`: no write, no update, no delete. Exit code 0 when everything is clean, 2 when anything is listed, 1 on error.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const flag = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const [from] = flag('from');
const [to] = flag('to');
const onlyStores = flag('store');
const keyFile = (process.env.POS_FIREBASE_SA_KEY_FILE ?? '').trim();

if (!keyFile || !/^\d{8}$/.test(from ?? '') || !/^\d{8}$/.test(to ?? '')) {
  console.error('Usage: POS_FIREBASE_SA_KEY_FILE=<service-account.json> node apps/pos/scripts/pos2-audit.mjs --from=YYYYMMDD --to=YYYYMMDD [--store=<pos store id>]...');
  process.exit(1);
}

const manilaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ms) => manilaDay.format(new Date(ms)).replace(/-/g, '');
const dayStartMs = (yyyymmdd) => Date.parse(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00+08:00`);
const fromMs = dayStartMs(from);
const toMs = dayStartMs(to) + 86_400_000 - 1;

const credential = JSON.parse(readFileSync(keyFile, 'utf8'));
const app = initializeApp({ credential: cert(credential), projectId: credential.project_id }, 'pos2-audit');
const db = getFirestore(app);

const storeIds = onlyStores.length ? onlyStores : (await db.collection('stores').select().get()).docs.map((d) => d.id);
let listed = 0;

for (const storeId of storeIds) {
  const days = new Map(); // dayId -> { unapprovedRefunds, unnumberedRefunds, foreignConversions, voidedCorrections, voidedOffline }
  const bucket = (dayId) => {
    if (!days.has(dayId)) days.set(dayId, { unapprovedRefunds: [], unnumberedRefunds: [], foreignConversions: [], voidedCorrections: [], voidedOffline: [] });
    return days.get(dayId);
  };

  const refunds = await db.collection(`stores/${storeId}/receipts`).where('isRefund', '==', true).get();
  for (const d of refunds.docs) {
    const r = d.data();
    const ms = Number(r.createdAtClientMs);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    const label = String(r.receiptNumber ?? d.id);
    if (!r.approvedByPersonId) bucket(dayOf(ms)).unapprovedRefunds.push(label);
    const numberSnap = r.receiptNumber ? await db.doc(`stores/${storeId}/receiptNumbers/${r.receiptNumber}`).get() : null;
    if (!numberSnap || !numberSnap.exists) bucket(dayOf(ms)).unnumberedRefunds.push(label);
  }

  const conversions = await db.collection(`stores/${storeId}/paymentConversions`).get();
  for (const d of conversions.docs) {
    const c = d.data();
    const ms = Number(c.createdAtClientMs);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    const dayId = String(c.dayId ?? dayOf(ms));
    if (c.source !== 'pos2-correction') bucket(dayId).foreignConversions.push(d.id);
    else if (c.status === 'voided') bucket(dayId).voidedCorrections.push(d.id);
  }

  // T-425: sessions voided without the internet. `voidedAt` is a Firestore timestamp (the void's own server time, set when the write landed).
  const offlineVoids = await db.collection(`stores/${storeId}/sessions`).where('voidedOffline', '==', true).get();
  for (const d of offlineVoids.docs) {
    const v = d.data();
    const ms = typeof v.voidedAt?.toMillis === 'function' ? v.voidedAt.toMillis() : typeof v.updatedAt?.toMillis === 'function' ? v.updatedAt.toMillis() : Number.NaN;
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    bucket(dayOf(ms)).voidedOffline.push(d.id);
  }

  for (const [dayId, b] of [...days.entries()].sort()) {
    const n = b.unapprovedRefunds.length + b.unnumberedRefunds.length + b.foreignConversions.length + b.voidedCorrections.length + b.voidedOffline.length;
    if (n === 0) continue;
    listed += n;
    console.log(`store ${storeId}  day ${dayId}`);
    if (b.unapprovedRefunds.length) console.log(`  refunds without an approver (${b.unapprovedRefunds.length}): ${b.unapprovedRefunds.join(', ')}`);
    if (b.unnumberedRefunds.length) console.log(`  refunds without a receipt-number record (${b.unnumberedRefunds.length}): ${b.unnumberedRefunds.join(', ')}`);
    if (b.foreignConversions.length) console.log(`  payment conversions not made by POS v2 (${b.foreignConversions.length}): ${b.foreignConversions.join(', ')}`);
    if (b.voidedCorrections.length) console.log(`  POS v2 corrections voided by v1 (${b.voidedCorrections.length}): ${b.voidedCorrections.join(', ')}`);
    if (b.voidedOffline.length) console.log(`  sessions voided offline, for a manager to review (${b.voidedOffline.length}): ${b.voidedOffline.join(', ')}`);
  }
}

console.log(listed === 0 ? `pos2-audit: nothing to report for ${from} to ${to}.` : `pos2-audit: ${listed} item(s) listed for ${from} to ${to}.`);
process.exit(listed === 0 ? 0 : 2);

'use server';

/**
 * Server actions for the staff-onboarding screens. T-202 / DEF-131.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `createPerson` / `createEmployment`
 * / `endEmployment` / `setEmploymentPositions` / `upsertStorePosition`'s own first statement, not
 * repeated here. Every mutation runs under the org's RLS principal (`withOrgPrincipal`), the same
 * way the items and commissary-catalogue actions do.
 */
import { redirect } from 'next/navigation';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { STAFF_POSITIONS } from './typed-forms';
import {
  createEmployment,
  createPerson,
  endEmployment,
  removeStaffPhoto,
  removeStaffSignature,
  setEmploymentPositions,
  setStaffPhoto,
  setStaffSignature,
  upsertStorePosition,
  viewStaffSignatureUrl,
  type CreateEmploymentInput,
} from '@shareat/domain';
import type { EmploymentStatus } from '@shareat/db/schema';
import { authorize, reopenPinSignIn, setPin } from '@shareat/auth';
import { accessRepo, employmentRepo, refuse, storesRepo, type Tx } from '@shareat/db';
import { listStores, withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../lib/error-shape';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Repeated fields — one per checked position. */
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
}

/** Strips the throwing function's name and turns a known refusal into a readable sentence —
 *  invariant 1: "the form surfaces createEmployment's refusal as a readable error, not a raw
 *  exception." */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (/already has an open employment/.test(raw)) return raw;
  if (/needs a terminal status/.test(raw)) return raw;
  if (/before the start date/.test(raw)) return raw;
  if (/primary position must be one of/.test(raw)) return raw;
  if (/is a canonical position/.test(raw)) return raw;
  if (/A person needs a name/.test(raw)) return raw;
  if (/store scope, so you may not search/.test(raw)) return raw;
  if (/must be exactly 6 digits/.test(raw)) return raw;
  // ⭐ T-302 — the sentence `setPin` throws dropped "at this store" when the lookup key became
  // org-scoped. ⛔ This regex had to change WITH it: a mapping that still matched the old wording
  // would silently stop matching and fall through to `sharedErrorMessage`, replacing an actionable
  // "pick different digits" with a generic failure. Matched on the stable half of the sentence.
  if (/already in use\. Please choose another/.test(raw)) return raw;
  // ⭐ **DEF-177 was fixed at the source by T-237 (DEF-228), and this mapping outlived its original
  // case.** It used to mean *"that is already this person's own PIN"*: `setPin`'s pre-check refused
  // only a PIN held by a DIFFERENT person, so re-entering your own reached the unique index and
  // raised a raw Postgres message. `setPin` now retires the person's own live PIN — ⭐ **since
  // T-302 org-wide, not "for that store"** — BEFORE inserting the new one, and the index is partial
  // on `revoked_at is null`, so re-issuing the same six digits succeeds; this branch can no longer
  // be the same person's PIN at any branch.
  //
  // ⚠️ **Kept, because one path still reaches it**: two administrators issuing the same digits, to
  // two different people, at the same store, in the same moment — the pre-check reads before either
  // insert, so both pass it and the index refuses the second. Rare, real, and the sentence now says
  // what actually happened instead of describing a case that can no longer occur.
  if (/person_credentials_lookup_hash_unique/.test(raw)) {
    // ⭐ T-302 — no longer "at this store": the index is org-wide now, so the race is two admins
    // issuing the same digits to two different people anywhere in the business, in the same moment.
    return 'That PIN was just taken — try another.';
  }
  return sharedErrorMessage(err);
}

/**
 * ⭐ Contract §3. Find-or-create the person, then hire — ONE transaction, so a person created here
 * is never left with no employment to show for it if the employment half fails (a second open
 * employment at this store, most commonly).
 */
export async function hireAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff/hire');
  const storeId = str(formData, 'storeId');
  // Each existing-person radio carries `existing:<personId>` as its OWN value — a shared literal
  // "existing" value could not tell two search results apart once more than one existed.
  const personChoiceRaw = str(formData, 'personChoice');
  const isExisting = personChoiceRaw.startsWith('existing:');
  const isNew = personChoiceRaw === 'new';
  const existingPersonId = isExisting ? personChoiceRaw.slice('existing:'.length) : '';
  const newDisplayName = str(formData, 'newDisplayName');
  const employmentStatus = str(formData, 'employmentStatus') as EmploymentStatus;
  const startedOn = str(formData, 'startedOn');
  const positionIds = strs(formData, 'positionIds');
  const primaryPositionId = str(formData, 'primaryPositionId');

  if (!isExisting && !isNew) {
    return await redirectWithFlash('/staff/hire', { store: storeId }, { error: 'Pick "use this existing person" or "create new person" before hiring.' });
  }
  if (isExisting && !existingPersonId) {
    return await redirectWithFlash('/staff/hire', { store: storeId }, { error: 'Pick which existing person to hire.' });
  }
  if (isNew && !newDisplayName) {
    return await redirectWithFlash('/staff/hire', { store: storeId }, { error: 'Name the new person.' });
  }

  // ⚠️ A "primary" radio checked without its checkbox is a UI slip, not a rejection — the person
  // clearly meant that one included. Reconciled here rather than surfaced as `resolvePositions`'s
  // own refusal, which exists for a genuinely CONTRADICTORY submission, not a missed tick.
  const resolvedPositionIds =
    primaryPositionId && !positionIds.includes(primaryPositionId)
      ? [...positionIds, primaryPositionId]
      : positionIds;

  let employmentId = '';
  try {
    const employment = await withOrgPrincipal(actor.orgId, async (tx) => {
      const personId = isExisting
        ? existingPersonId
        : (await createPerson(tx, actor, { storeId, displayName: newDisplayName })).id;

      const input: CreateEmploymentInput = {
        storeId,
        personId,
        employmentStatus,
        startedOn,
        ...(resolvedPositionIds.length > 0 ? { positionIds: resolvedPositionIds } : {}),
        ...(primaryPositionId ? { primaryPositionId } : {}),
      };
      return createEmployment(tx, actor, input);
    });
    employmentId = employment.id;
  } catch (err) {
    return await redirectWithFlash('/staff/hire', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Hired.' });
}

export async function setPositionsAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const positionIds = strs(formData, 'positionIds');
  // ⚠️ Unlike `createEmployment`'s `CreateEmploymentInput`, `setEmploymentPositions`'s
  // `primaryPositionId` is REQUIRED, not optional — so a submission with positions checked but no
  // primary radio picked defaults to the first checked one here, in the UI, rather than reaching
  // `resolvePositions` as an empty string (which is neither nullish, so its own `??` default never
  // fires, nor a member of the assigned set, so it would be refused as a contradiction it never was).
  const primaryPositionId = str(formData, 'primaryPositionId') || positionIds[0] || '';

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setEmploymentPositions(tx, actor, { employmentId, positionIds, primaryPositionId }),
    );
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err), typed: keepTyping(formData, STAFF_POSITIONS, employmentId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Positions saved.' });
}

export async function endEmploymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const endedOn = str(formData, 'endedOn');
  const employmentStatus = str(formData, 'employmentStatus') as EmploymentStatus;

  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'employment', employmentId, ['enrol_staff']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'enrol_staff' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await endEmployment(tx, actor, { employmentId, endedOn, employmentStatus });
      await recordApproval(tx, actor, approval, { capability: 'enrol_staff', entityType: 'employment', entityId: employmentId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Employment ended. The record stays visible.' });
}

/**
 * T-217 / DEF-174. `setPin` (`packages/auth/src/sessions.ts`) has no `authorize()` call of its
 * own — it sits one layer below the domain, alongside `signInWithPin`, which correctly has no
 * actor yet to check. Issuing or re-issuing a person's sign-in credential is a "granting system
 * access" action, so this gates on `enrol_staff` (the same capability hiring already uses) rather
 * than shipping it ungated.
 */
const SUPER_ONLY = 'Only a super administrator can set a super administrator’s PIN.';

/** T-412 audit M5: a super_admin target's PIN may only be set by a super_admin (else an admin could choose it and approve in their place). */
async function requireSuperForSuperTarget(tx: Tx, actor: { personId: string; orgId: string }, targetPersonId: string): Promise<void> {
  const target = await accessRepo.activeRoleForPerson(tx, targetPersonId, actor.orgId);
  if (target?.role !== 'super_admin') return;
  const mine = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  if (mine?.role !== 'super_admin') throw refuse(`issuePin: actor ${actor.personId} is not a super_admin and the target ${targetPersonId} is`, SUPER_ONLY);
}

export async function issuePinAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const pin = str(formData, 'pin');

  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      const employment = await employmentRepo.getEmployment(tx, employmentId);
      if (!employment || employment.orgId !== actor.orgId) {
        throw new Error('That employment does not exist.');
      }
      await authorize(tx, actor, 'enrol_staff', { storeId: employment.storeId });
      // T-412: an administrator's PIN approves destructive actions, so setting it is administrator work: a manager who may
      // issue ordinary staff PINs must not be able to choose one for an administrator and then use it.
      if (await accessRepo.personIsActiveAdmin(tx, actor.orgId, employment.personId)) await authorize(tx, actor, 'manage_users', {});
      await requireSuperForSuperTarget(tx, actor, employment.personId);
      // ⭐ T-302 — `orgId` from the ACTOR, never from the form (T-231). It is also already known
      // to equal the employment's org: the guard three lines up refused `employment.orgId !==
      // actor.orgId`, so the two cannot disagree here.
      await setPin(tx, {
        orgId: actor.orgId,
        personId: employment.personId,
        storeId: employment.storeId,
        pin,
        actorPersonId: actor.personId,
      });
    });
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Sign-in PIN issued.' });
}

/**
 * T-412 (Ian Q1 "a", recommended): Staff issues a PIN to ANY administrator, including one who signs in by email only and has
 * no employment page. That PIN is how an administrator approves a destructive action (Tier P). Gated on `manage_users`
 * (admin work: whoever can set an administrator's PIN could otherwise approve in their place). The target must be an active
 * administrator of THIS organisation and `storeId` a store of it - `setPin` records the store the PIN was issued at; it
 * grants no access there. Same one-PIN-per-person rule as `issuePinAction`.
 */
export async function issueAdminPinAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const personId = str(formData, 'personId');
  const storeId = str(formData, 'storeId');
  const pin = str(formData, 'pin');

  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'manage_users', {});
      if (!UUID_SHAPE.test(personId) || !(await accessRepo.personIsActiveAdmin(tx, actor.orgId, personId))) {
        throw refuse(`issueAdminPin: ${personId} is not an active administrator of org ${actor.orgId}`, 'That person is not an active administrator.');
      }
      if (!UUID_SHAPE.test(storeId) || !(await storesRepo.getById(tx, actor.orgId, storeId))) {
        throw refuse(`issueAdminPin: store ${storeId} is not a store of org ${actor.orgId}`, 'Pick a store.');
      }
      await requireSuperForSuperTarget(tx, actor, personId);
      await setPin(tx, { orgId: actor.orgId, personId, storeId, pin, actorPersonId: actor.personId });
    });
  } catch (err) {
    return await redirectWithFlash('/staff', storeId ? { store: storeId } : {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/staff', { store: storeId }, { ok: 'Administrator PIN issued.' });
}

export async function upsertStorePositionAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const storeId = str(formData, 'storeId');
  const name = str(formData, 'name');

  let outcome: string | undefined;
  try {
    outcome = (await withOrgPrincipal(actor.orgId, (tx) => upsertStorePosition(tx, actor, { storeId, name })))?.outcome;
  } catch (err) {
    return await redirectWithFlash('/staff', { store: storeId }, { error: errorMessage(err) });
  }
  const verb = outcome === 'reactivated' ? 're-activated' : outcome === 'existing' ? 'already exists' : 'added';
  return await redirectWithFlash('/staff', { store: storeId }, { ok: `Position "${name}" ${verb}.` });
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-395 S2 (R5, R6). A manager reopens a store whose PIN sign-in the daily budget stopped.
 * ⭐ The actor comes from the session; `storeId` is only the resource. `reopenPinSignIn`'s first
 * statement is `authorize(enrol_staff, { storeId })`, so nothing is repeated here.
 */
export async function reopenPinSignInAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const storeId = str(formData, 'storeId');
  if (!UUID_SHAPE.test(storeId)) {
    return await redirectWithFlash('/staff', {}, { error: 'Pick a store to reopen PIN sign-in for.' });
  }

  let reopened: boolean;
  try {
    reopened = (await withOrgPrincipal(actor.orgId, (tx) => reopenPinSignIn(tx, actor, storeId))).reopened;
  } catch (err) {
    return await redirectWithFlash('/staff', { store: storeId }, { error: errorMessage(err) });
  }
  const name = (await listStores(actor.orgId)).find((s) => s.id === storeId)?.name ?? 'this store';
  const message = reopened
    ? `PIN sign-in reopened at ${name}.`
    : `PIN sign-in was not stopped at ${name}. Nothing changed.`;
  return await redirectWithFlash('/staff', { store: storeId }, { ok: message });
}

// ---------------------------------------------------------------------------------------------------------------------
// T-434 - staff photo and signature. Thin adapters: the file part and the ids come from the form, the ACTOR from the session,
// and every gate (enrol_staff at the store, no self-service, PNG-only signature, audit) is the domain function's own.
// The signature arrives as a file part drawn on the pad, never a data URL.
// ---------------------------------------------------------------------------------------------------------------------

async function filePart(fd: FormData, key: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const f = fd.get(key);
  if (!(f instanceof File) || f.size === 0) return null;
  return { contentType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) };
}

export async function setStaffPhotoAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  try {
    const part = await filePart(formData, 'photo');
    if (!part) throw new Error('Choose or take a photo first.');
    await withOrgPrincipal(actor.orgId, (tx) => setStaffPhoto(tx, actor, { employmentId, ...part }));
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Photo saved.' });
}

export async function removeStaffPhotoAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => removeStaffPhoto(tx, actor, { employmentId }));
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Photo removed.' });
}

export async function setStaffSignatureAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const personId = str(formData, 'personId');
  try {
    const part = await filePart(formData, 'signature');
    if (!part) throw new Error('Draw the signature first.');
    await withOrgPrincipal(actor.orgId, (tx) => setStaffSignature(tx, actor, { personId, ...part }));
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Signature saved.' });
}

export async function removeStaffSignatureAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const personId = str(formData, 'personId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => removeStaffSignature(tx, actor, { personId }));
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/staff/${employmentId}`, {}, { ok: 'Signature removed.' });
}

/** "View signature": mints a 60-second link per click (audited, refusals audited too) and sends the browser to it. Nothing is stored or logged. */
export async function viewStaffSignatureAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const personId = str(formData, 'personId');
  let url: string;
  try {
    ({ url } = await withOrgPrincipal(actor.orgId, (tx) => viewStaffSignatureUrl(tx, actor, { personId })));
  } catch (err) {
    return await redirectWithFlash(`/staff/${employmentId}`, {}, { error: errorMessage(err) });
  }
  redirect(url);
}

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
import {
  createEmployment,
  createPerson,
  endEmployment,
  setEmploymentPositions,
  upsertStorePosition,
  type CreateEmploymentInput,
} from '@shareat/domain';
import type { EmploymentStatus } from '@shareat/db/schema';
import { authorize, setPin } from '@shareat/auth';
import { employmentRepo } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

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
  const raw = err instanceof Error ? err.message : String(err);
  if (/already has an open employment/.test(raw)) return raw;
  if (/needs a terminal status/.test(raw)) return raw;
  if (/before the start date/.test(raw)) return raw;
  if (/primary position must be one of/.test(raw)) return raw;
  if (/is a canonical position/.test(raw)) return raw;
  if (/A person needs a name/.test(raw)) return raw;
  if (/store scope, so you may not search/.test(raw)) return raw;
  if (/may not 'enrol_staff'/.test(raw)) {
    return 'Only a manager or admin scoped to this store can hire, end an employment, change positions, or issue a sign-in PIN.';
  }
  if (/must be exactly 6 digits/.test(raw)) return raw;
  if (/already in use at this store/.test(raw)) return raw;
  // ⭐ **DEF-177 was fixed at the source by T-237 (DEF-228), and this mapping outlived its original
  // case.** It used to mean *"that is already this person's own PIN"*: `setPin`'s pre-check refused
  // only a PIN held by a DIFFERENT person, so re-entering your own reached the unique index and
  // raised a raw Postgres message. `setPin` now retires the person's own live PIN for that store
  // BEFORE inserting the new one, and the index is partial on `revoked_at is null`, so re-issuing
  // the same six digits succeeds — this branch can no longer be the same person's PIN.
  //
  // ⚠️ **Kept, because one path still reaches it**: two administrators issuing the same digits, to
  // two different people, at the same store, in the same moment — the pre-check reads before either
  // insert, so both pass it and the index refuses the second. Rare, real, and the sentence now says
  // what actually happened instead of describing a case that can no longer occur.
  if (/person_credentials_lookup_hash_unique/.test(raw)) {
    return 'That PIN was just taken at this store — try another.';
  }
  if (/may not 'manage_store_settings'/.test(raw)) {
    return 'Only a manager or admin scoped to this store can add a position.';
  }
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function backToHire(storeId: string, extra: Record<string, string>): never {
  redirect(`/staff/hire?${new URLSearchParams({ store: storeId, ...extra }).toString()}`);
}

function backToRoster(storeId: string, extra: Record<string, string>): never {
  redirect(`/staff?${new URLSearchParams({ store: storeId, ...extra }).toString()}`);
}

function backToEmployment(employmentId: string, extra: Record<string, string>): never {
  redirect(`/staff/${employmentId}?${new URLSearchParams(extra).toString()}`);
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
    backToHire(storeId, { error: 'Pick "use this existing person" or "create new person" before hiring.' });
  }
  if (isExisting && !existingPersonId) {
    backToHire(storeId, { error: 'Pick which existing person to hire.' });
  }
  if (isNew && !newDisplayName) {
    backToHire(storeId, { error: 'Name the new person.' });
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
    backToHire(storeId, { error: errorMessage(err) });
  }
  backToEmployment(employmentId, { ok: 'Hired.' });
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
    backToEmployment(employmentId, { error: errorMessage(err) });
  }
  backToEmployment(employmentId, { ok: 'Positions saved.' });
}

export async function endEmploymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const employmentId = str(formData, 'employmentId');
  const endedOn = str(formData, 'endedOn');
  const employmentStatus = str(formData, 'employmentStatus') as EmploymentStatus;

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      endEmployment(tx, actor, { employmentId, endedOn, employmentStatus }),
    );
  } catch (err) {
    backToEmployment(employmentId, { error: errorMessage(err) });
  }
  backToEmployment(employmentId, { ok: 'Employment ended. The record stays visible.' });
}

/**
 * T-217 / DEF-174. `setPin` (`packages/auth/src/sessions.ts`) has no `authorize()` call of its
 * own — it sits one layer below the domain, alongside `signInWithPin`, which correctly has no
 * actor yet to check. Issuing or re-issuing a person's sign-in credential is a "granting system
 * access" action, so this gates on `enrol_staff` (the same capability hiring already uses) rather
 * than shipping it ungated.
 */
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
      await setPin(tx, { personId: employment.personId, storeId: employment.storeId, pin });
    });
  } catch (err) {
    backToEmployment(employmentId, { error: errorMessage(err) });
  }
  backToEmployment(employmentId, { ok: 'Sign-in PIN issued.' });
}

export async function upsertStorePositionAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/staff');
  const storeId = str(formData, 'storeId');
  const name = str(formData, 'name');

  try {
    await withOrgPrincipal(actor.orgId, (tx) => upsertStorePosition(tx, actor, { storeId, name }));
  } catch (err) {
    backToRoster(storeId, { error: errorMessage(err) });
  }
  backToRoster(storeId, { ok: `Position "${name}" added.` });
}

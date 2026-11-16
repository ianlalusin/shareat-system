/**
 * T-584 fixtures: one synthetic organisation with two stores, an admin, managers, staff, an employee with a PIN and a saved signature.
 * Every name is invented ("Test Org", "Staff B"); there is no real company data. Seeds through a plain owner connection (the caller's `sql`).
 */
import type postgres from 'postgres';
import { hashPin, pinLookupHash } from '@shareat/auth';
import type { Actor } from '@shareat/auth';

let seq = 0;
let pinSeq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
/** Distinct, well-formed, never a repeated-digit run. */
export const nextPin = () => String(300000 + ++pinSeq * 17);

export interface Person {
  personId: string;
  pin: string;
  /** The Employee ID typed to sign (the number of the staff code, `SE-001` -> `1`). Null when the person has no employment. */
  employeeId: string | null;
  staffCode: string | null;
  employmentId: string | null;
  actor: Actor;
}

export interface DocFixture {
  orgId: string;
  storeA: string;
  storeB: string;
  admin: Person;
  /** Manager in scope of store A only. Has a PIN, a saved signature and an employment (position "Manager") at A. */
  managerA: Person;
  /** Manager in scope of store B only. */
  managerB: Person;
  /** The employee the documents are about: employment at store A, a PIN, a saved signature. */
  employee: Person;
  /** An employee at store B, no signature on file. */
  employeeB: Person;
  /** Role staff, no capability. */
  staff: Person;
  /** An employee who has a PIN but NO saved signature. */
  noSignature: Person;
  signatureFileOf: (personId: string) => Promise<string | null>;
  replaceSignature: (personId: string) => Promise<string>;
}

export async function documentFixture(sql: postgres.Sql, hint: string): Promise<DocFixture> {
  const code = uid(`t584-${hint}`);
  const [o] = await sql<{ id: string }[]>`
    insert into organizations (name, code, legal_name, tin) values (${`Test Org ${code}`}, ${code}, 'Test Org Incorporated', '123456789') returning id`;
  const orgId = o!.id;
  const mkStore = async (label: string, address: string, branch: string) =>
    (
      await sql<{ id: string }[]>`
        insert into stores (org_id, code, name, address, tin_branch_code)
        values (${orgId}, ${uid(label)}, ${`Test Store ${label}`}, ${address}, ${branch}) returning id`
    )[0]!.id;
  const storeA = await mkStore('A', '1 Test Street, Test City', '00001');
  const storeB = await mkStore('B', '2 Sample Road, Sample Town', '00002');
  const [pos] = await sql<{ id: string }[]>`
    insert into positions (org_id, name, is_canonical) values (${orgId}, 'Server', true) returning id`;
  const [posMgr] = await sql<{ id: string }[]>`
    insert into positions (org_id, name, is_canonical) values (${orgId}, 'Test Manager', true) returning id`;
  let staffNo = 0;

  const person = async (
    name: string,
    role: string,
    scope: string[],
    opts: { employAt?: string; position?: string; signature?: boolean; pin?: boolean; parts?: [string, string] } = {},
  ): Promise<Person> => {
    const [p] = opts.parts
      ? await sql<{ id: string }[]>`
          insert into persons (org_id, display_name, first_name, last_name)
          values (${orgId}, ${`${opts.parts[1]}, ${opts.parts[0]}`}, ${opts.parts[0]}, ${opts.parts[1]}) returning id`
      : await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    const personId = p!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${s}, 'manual')`;
    const pin = nextPin();
    if (opts.pin !== false) {
      await sql`
        insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
        values (${personId}, 'pin', ${scope[0] ?? opts.employAt ?? storeA}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    }
    let staffCode: string | null = null;
    let employmentId: string | null = null;
    if (opts.employAt) {
      staffCode = `SE-${String(++staffNo).padStart(3, '0')}`;
      const [e] = await sql<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${opts.employAt}, ${personId}, ${staffCode}, 'regular', '2025-01-06') returning id`;
      employmentId = e!.id;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${employmentId}, ${opts.position === 'manager' ? posMgr!.id : pos!.id}, true)`;
    }
    if (opts.signature) await mintSignature(personId);
    return {
      personId,
      pin,
      employeeId: staffCode ? String(Number(staffCode.slice(3))) : null,
      staffCode,
      employmentId,
      actor: { personId, orgId },
    };
  };

  const mintSignature = async (personId: string): Promise<string> => {
    const [f] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by, linked_to)
      values (${orgId}, 'staff_signature', ${`orgs/${orgId}/sig-${uid('f')}.png`}, 'image/png', 10, 'x', ${personId}, ${personId}) returning id`;
    await sql`update persons set signature_file_id = ${f!.id} where id = ${personId}`;
    return f!.id;
  };

  const admin = await person('Admin A', 'admin', [storeA, storeB], { signature: true });
  const managerA = await person('Manager A', 'manager', [storeA], { employAt: storeA, position: 'manager', signature: true });
  const managerB = await person('Manager B', 'manager', [storeB]);
  const employee = await person('Staff B', 'staff', [storeA], { employAt: storeA, signature: true, parts: ['Staffer', 'Employee'] });
  const employeeB = await person('Staff C', 'staff', [storeB], { employAt: storeB });
  const staff = await person('Staff D', 'staff', [storeA]);
  const noSignature = await person('Staff E', 'staff', [storeA], { employAt: storeA });
  return {
    orgId,
    storeA,
    storeB,
    admin,
    managerA,
    managerB,
    employee,
    employeeB,
    staff,
    noSignature,
    signatureFileOf: async (personId) =>
      (await sql<{ signature_file_id: string | null }[]>`select signature_file_id from persons where id = ${personId}`)[0]?.signature_file_id ?? null,
    replaceSignature: mintSignature,
  };
}

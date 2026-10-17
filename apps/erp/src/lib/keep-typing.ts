/**
 * T-389 (DEF-617): a refused save keeps what the user typed. Spec: docs/tasks/389-refused-save-keeps-typing.md.
 *
 * Not a `'use server'` file (those may export only async functions). A route's `typed-forms.ts` calls
 * `defineTypedForm` once; the page and the action import the same definition, so the form key cannot drift.
 *
 *   action, in the refusal branch only:  typed: keepTyping(fd, SUPPLIER_EDIT, supplierId, { stale })
 *   page, one prop on the record:        typed={typedFor(sp, SUPPLIER_EDIT, supplier.id)}
 *
 * The typed values ride only in the signed, httpOnly, one-minute flash cookie (lib/flash.ts), never in the address
 * and never in a log. This module logs nothing at all.
 *
 * Imports are type-only so the client component can share `TypedView` without pulling in server code.
 */
import type { TypedDropped, TypedFlash } from './flash';

/**
 * R4: a field is NEVER kept when any TOKEN of its name is a credential word. The name is split on `_`, `-` and camelCase
 * boundaries (an all-caps run too: newPIN -> new, pin) and lower-cased, so currentPin, confirm_password, accessToken,
 * client-secret, newPIN, otp and apiKey are denied, while shipping, mapping, spinning and tokenizer are not.
 */
const DENIED_TOKENS: ReadonlySet<string> = new Set(['pin', 'pins', 'password', 'passcode', 'token', 'secret', 'otp', 'apikey']);

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function credentialName(name: string): boolean {
  const t = nameTokens(name);
  return t.some((x, i) => DENIED_TOKENS.has(x) || (x === 'api' && t[i + 1] === 'key'));
}
/** Fields that are sensitive but not credentials. Q1 = (a): the supplier's account number is not kept. */
// T-190: government ID numbers are as sensitive as a bank account (bible row 353), so they are never echoed back either.
const SENSITIVE: ReadonlySet<string> = new Set(['bankAccountNumber', 'sssNo', 'philhealthNo', 'pagibigNo']);

export function isNeverEchoed(name: string): boolean {
  return credentialName(name) || SENSITIVE.has(name);
}

/** The shapes the flash accepts (lib/flash.ts). A name outside them would make the cookie's typed slot unreadable. */
const FORM_KEY = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface TypedFormDef {
  /** The `<area>.<form>` key, unique app-wide. */
  readonly form: string;
  /** User-editable controls: exact names, or a RegExp for a repeated family (`/^line[1-5]_(itemId|quantity)$/`). */
  readonly fields: ReadonlyArray<string | RegExp>;
  /** True for a form with no record id (organization settings): it keeps typing with record ''. */
  readonly singleton: boolean;
  /** Shown in the record's alert slot when it reopens, for a field that is deliberately not kept. */
  readonly notKeptHint?: string;
}

export type TypedView =
  | { kind: 'typed'; fields: Record<string, string | string[]>; hint?: string }
  | { kind: 'dropped' };

export function defineTypedForm(def: {
  form: string;
  fields: ReadonlyArray<string | RegExp>;
  singleton?: boolean;
  notKeptHint?: string;
}): TypedFormDef {
  if (!FORM_KEY.test(def.form)) throw new Error(`defineTypedForm: "${def.form}" is not an <area>.<form> key`);
  for (const f of def.fields) {
    if (typeof f !== 'string') continue;
    if (isNeverEchoed(f)) throw new Error(`defineTypedForm(${def.form}): "${f}" is a credential or sensitive field and is never kept`);
    if (!FIELD_NAME.test(f)) throw new Error(`defineTypedForm(${def.form}): "${f}" is not a field name the flash can carry`);
  }
  return Object.freeze({
    form: def.form,
    fields: Object.freeze([...def.fields]),
    singleton: def.singleton === true,
    ...(def.notKeptHint !== undefined ? { notKeptHint: def.notKeptHint } : {}),
  });
}

function allowed(def: TypedFormDef, name: string): boolean {
  if (!FIELD_NAME.test(name) || isNeverEchoed(name)) return false;
  return def.fields.some((f) => {
    if (typeof f === 'string') return f === name;
    f.lastIndex = 0;
    return f.test(name);
  });
}

/**
 * The typed slot for a refused save, or undefined when there is nothing to keep. Call it only in the refusal branch.
 *
 * - `opts.actorId`: the signed-in person. The slot is bound to them, so on a shared till PC the next person to sign in
 *   within the minute is not shown it (`typedFor` checks).
 * - `opts.stale`: the record changed under the user (A6). Nothing is kept; the page reopens it LOCKED with what is saved.
 * - a blank `record` on a non-singleton form keeps nothing.
 * - Only allow-listed names, never a denied one, never a File. With the client's `__changed` list (R5), only the
 *   names in it; a changed, allow-listed name the browser sent nothing for (an unticked box) is kept as [].
 * - Values are never trimmed, shortened or logged.
 */
export function keepTyping(
  fd: FormData,
  def: TypedFormDef,
  record: string,
  opts: { actorId: string; stale?: boolean },
): TypedFlash | undefined {
  if (opts.stale === true) return undefined;
  if (!record && !def.singleton) return undefined;

  const raw = fd.get('__changed');
  const changed = typeof raw === 'string' ? raw.split(',').map((n) => n.trim()).filter(Boolean) : null;
  const names = changed ?? [...new Set([...fd.keys()])];

  const fields: Record<string, string | string[]> = {};
  for (const name of new Set(names)) {
    if (!allowed(def, name)) continue;
    const values = fd.getAll(name).filter((v): v is string => typeof v === 'string');
    if (values.length === 0) {
      if (changed) fields[name] = []; // changed but not sent: an unticked box. Reopen it unticked.
      continue;
    }
    fields[name] = values.length === 1 ? (values[0] as string) : values;
  }
  if (Object.keys(fields).length === 0) return undefined;
  return { form: def.form, record, fields, ...(opts.actorId ? { actor: opts.actorId } : {}) };
}

/**
 * What the page hands a record: the typing for THIS form and THIS record, the "too long to keep" notice, or null.
 * A flash meant for another record, form or person is ignored, which is how one tender of twenty reopens.
 * (`actorId` is the signed-in person; the slot must have been kept for the same one. Returns null otherwise.)
 */
export function typedFor(
  sp: { typed?: TypedFlash | undefined; typedDropped?: TypedDropped | undefined },
  def: TypedFormDef,
  record: string,
  actorId: string,
): TypedView | null {
  const t = sp.typed;
  if (t && t.form === def.form && t.record === record && t.actor === actorId) {
    return { kind: 'typed', fields: t.fields, ...(def.notKeptHint !== undefined ? { hint: def.notKeptHint } : {}) };
  }
  const d = sp.typedDropped;
  if (d && d.form === def.form && d.record === record && (d.actor === undefined || d.actor === actorId)) return { kind: 'dropped' };
  return null;
}

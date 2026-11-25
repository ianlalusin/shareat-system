/**
 * T-641 - the shared world for the tool-loop and Ask ERP integration tests: two organisations, people of every role, a scripted FAKE provider (no network, ever), and the hub set up with
 * one active model. Not a test file. Every key and name below is made up.
 */
import { expect } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import type { HttpClient } from '@shareat/ai';
import { activateAiModel, saveProviderKey, testAiModel, type TxRunner } from '@shareat/domain';

export type Sql = ReturnType<typeof postgres>;
let seq = 0;
export const uniq = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export const KEY = 'sk-test-OOOO0123456789abcdefghijklmnopqrst-O1O2';
export const MASTER = Buffer.alloc(32, 7);

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
export const runnerFor = (orgId: string): TxRunner => <T,>(fn: (tx: Tx) => Promise<T>) => asOrg(orgId, fn);

export interface World {
  orgId: string;
  storeA: string;
  storeB: string;
  /** Holds every store of the org. */
  sup: Actor;
  admin: Actor;
  /** A manager scoped to store A only. */
  manager: Actor;
  /** A manager scoped to both stores. */
  managerBoth: Actor;
  staff: Actor;
  staff2: Actor;
  other: { orgId: string; storeX: string; manager: Actor };
}

export async function makeWorld(sql: Sql, tag: string): Promise<World> {
  const code = uniq(`t641-${tag}`);
  const org = async (suffix: string): Promise<string> => {
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Test Org ${code}${suffix}`}, ${`${code}${suffix}`}) returning id`;
    return o!.id;
  };
  const store = async (orgId: string, name: string): Promise<string> => {
    // a short code with no long digit run: the privacy guard would (rightly) take a 13-digit run in a code for an ID number
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${`T${++seq}${Math.random().toString(36).slice(2, 5)}`}, ${name}) returning id`;
    return s!.id;
  };
  const person = async (orgId: string, name: string, role: string, stores: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const orgId = await org('');
  const storeA = await store(orgId, 'Test Store A');
  const storeB = await store(orgId, 'Test Store B');
  const otherOrg = await org('-other');
  const storeX = await store(otherOrg, 'Other Org Store X');
  return {
    orgId,
    storeA,
    storeB,
    sup: await person(orgId, 'Sue Super', 'super_admin', [storeA, storeB]),
    admin: await person(orgId, 'Adam Admin', 'admin', [storeA, storeB]),
    manager: await person(orgId, 'Mia Manager', 'manager', [storeA]),
    managerBoth: await person(orgId, 'Max Manager', 'manager', [storeA, storeB]),
    staff: await person(orgId, 'Sam Staff', 'staff', [storeA]),
    staff2: await person(orgId, 'Sid Staff', 'staff', [storeA]),
    other: { orgId: otherOrg, storeX, manager: await person(otherOrg, 'Olga Other', 'manager', [storeX]) },
  };
}

// ---- the scripted provider (OpenAI Chat Completions shape; the model is gpt-4o-mini) ----------------------------------------------------------
export interface Turn {
  /** Tool calls this reply makes. Omit for a plain answer. */
  calls?: { tool: string; args?: Record<string, unknown> }[];
  text?: string;
  tokensIn?: number;
  tokensOut?: number;
}
export interface Scripted {
  http: HttpClient;
  /** The parsed request body of every call made, in order. */
  seen: { messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[]; tools?: { function: { name: string } }[]; raw: string }[];
  count: () => number;
}
/** Replies turn by turn; once the script runs out the last turn repeats (a model that never stops asking for tools). */
export function scripted(turns: Turn[]): Scripted {
  const seen: Scripted['seen'] = [];
  const http: HttpClient = async (req) => {
    const parsed = JSON.parse(req.body) as Pick<Scripted['seen'][number], 'messages' | 'tools'>;
    seen.push({ messages: parsed.messages, tools: parsed.tools, raw: req.body });
    const n = seen.length - 1;
    const turn = turns[Math.min(n, turns.length - 1)]!;
    const message = {
      content: turn.text ?? null,
      ...(turn.calls ? { tool_calls: turn.calls.map((c, i) => ({ id: `call_${n}_${i}`, type: 'function', function: { name: c.tool, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
    };
    return { status: 200, body: JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: turn.tokensIn ?? 100, completion_tokens: turn.tokensOut ?? 20 } }) };
  };
  return { http, seen, count: () => seen.length };
}

/** The key, a passing test and an active model for the org (a plain "ok" provider is used for the setup; the test then passes its own scripted one to each call). */
export async function readyHub(w: World): Promise<void> {
  const ok: HttpClient = async () => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: '{"value":"ok"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }),
  });
  const deps = { masterKey: MASTER, http: ok };
  await asOrg(w.orgId, (tx) => saveProviderKey(tx, w.sup, { provider: 'openai', key: KEY }, deps));
  const r = await testAiModel(runnerFor(w.orgId), w.sup, { provider: 'openai', model: 'gpt-4o-mini' }, deps);
  expect(r.ok, 'the setup test call').toBe(true);
  await asOrg(w.orgId, (tx) => activateAiModel(tx, w.sup, { provider: 'openai', model: 'gpt-4o-mini' }));
}

/** The real attempts of an org (the in-flight reservation rows are left out). */
export const callRows = (sql: Sql, orgId: string) =>
  sql<{ ok: boolean; error_code: string | null; feature: string; group_ref: string; tool_calls: number; person_id: string | null; tokens_in: number }[]>`
    select ok, error_code, feature, group_ref, tool_calls, person_id, tokens_in from ai_calls where org_id = ${orgId} and error_code is distinct from 'reserved' order by created_at, id`;

/** The text of every tool-role message in one captured request. */
export function toolTexts(s: Scripted, call: number): string[] {
  return (s.seen[call]?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));
}

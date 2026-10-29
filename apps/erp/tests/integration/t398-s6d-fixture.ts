/**
 * T-398 S6d (TESTER) - shared helpers for the three S6d screen files.
 *
 * ASSUMED CONTRACT the builder must match (or tell the tester, who adjusts THIS file only):
 *   pages:    apps/erp/src/app/franchise/{sales,stock,access-log}/page.tsx  (default export; read NO figures on render)
 *   actions:  apps/erp/src/app/franchise/actions.ts exporting viewFranchiseSalesAction and viewFranchiseStockAction.
 *             Form fields: franchiseeOrgId, from, to, reason (sales) / franchiseeOrgId, storeId (all stores = empty), reason (stock).
 *             Shape: `(formData)` or `(prevState, formData)` (useActionState). It either RETURNS state or REDIRECTS with a flash.
 *             What the person would read is: the returned value (an element is rendered, anything else JSON-stringified) plus any flash text.
 *   page search params (a GET, never logs): ?franchisee=<uuid> on sales/stock, ?store=<uuid> on stock; a non-uuid value -> notFound().
 */
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { outcomeOf, RedirectSignal, resetJar } from '../helpers/flash-jar';
import { session } from './t435-fixture';

export interface Seen {
  /** Everything the person is shown by this submit, as one string. */
  text: string;
  redirected: boolean;
  flash: Record<string, string | undefined>;
  value: unknown;
}

type ActionFn = ((fd: FormData) => Promise<unknown>) | ((prev: unknown, fd: FormData) => Promise<unknown>);

export async function loadAction(name: 'viewFranchiseSalesAction' | 'viewFranchiseStockAction'): Promise<ActionFn> {
  const mod = (await import('../../src/app/franchise/actions').catch((e: unknown) => {
    throw new Error(`MISSING MODULE: apps/erp/src/app/franchise/actions.ts (${e instanceof Error ? e.message : e})`);
  })) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: apps/erp/src/app/franchise/actions.ts does not export ${name}`);
  return fn as ActionFn;
}

export function formOf(fields: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Press the button as `who`. A thrown non-redirect error (a raw refusal) propagates: the screens must turn refusals into words. */
export async function submit(who: { personId: string; orgId: string }, name: 'viewFranchiseSalesAction' | 'viewFranchiseStockAction', fields: Record<string, string | undefined>): Promise<Seen> {
  const fn = await loadAction(name);
  session.actor = who as never;
  resetJar();
  const fd = formOf(fields);
  try {
    const value = fn.length >= 2 ? await (fn as (p: unknown, f: FormData) => Promise<unknown>)(null, fd) : await (fn as (f: FormData) => Promise<unknown>)(fd);
    return { text: stringify(value), redirected: false, flash: {}, value };
  } catch (e) {
    if (e instanceof RedirectSignal) {
      const o = outcomeOf(e);
      return { text: JSON.stringify(o.flash) + ' ' + o.path + ' ' + o.nav.toString(), redirected: true, flash: o.flash as Record<string, string | undefined>, value: undefined };
    }
    throw e;
  }
}

function stringify(v: unknown): string {
  if (isValidElement(v)) return renderToStaticMarkup(v as never);
  return JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x)) ?? '';
}

/** Words that must never reach a person: raw SQL / database internals. */
export const RAW_SQL = /franchise_sales_daily|franchise_stock_levels|PostgresError|ERRCODE|SQLSTATE|\bselect\b.+\bfrom\b|syntax error|violates|CONTEXT:|PL\/pgSQL/i;

/** The page text a person reads (tags dropped). */
export const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

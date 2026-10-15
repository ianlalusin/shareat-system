/**
 * ======================================================================================================================
 * T-401 S4 - THE CONTRACT THE BUILDER FOLLOWS (pinned by the tester; docs/tasks/401-erp-menu-catalog-master.md section 5)
 * ======================================================================================================================
 * Every S4 test file is red today because the modules below do not exist yet (pages and server actions are new).
 *
 * GENERAL
 *  - Every action is `export async function xAction(fd: FormData): Promise<void>` in a 'use server' file, calls `requireActor(path)`,
 *    calls the domain in `@shareat/domain` (packages/domain/src/menu) through `withOrgPrincipal`, and ALWAYS ends with
 *    `return await redirectWithFlash(path, nav, { ok } | { error })` (flash cookie, nothing typed in the URL, T-380/G1b).
 *    The error is `errorMessage(err)`. A BLANK or absent text field means "not sent" (an empty `amount` is not '0').
 *  - A refusal never writes, and its banner is a sentence (no SQLSTATE, no constraint or trigger name).
 *  - Money / percent / quantity fields are TEXT passed to the domain unchanged (never Number()).
 *  - `effectiveFrom` (prices and depletion rules): ABSENT or blank = "from now", and the action never sends the client clock
 *    (the database's `now()` decides). Present = a `datetime-local` value `YYYY-MM-DDTHH:mm` (or with seconds), read as
 *    ASIA/MANILA wall-clock through `@shareat/core/datetime` and stored as an instant: '2030-12-01T00:00' is 2030-11-30T16:00:00Z.
 *    An unparsable value is a sentence error (nothing written). A time already past is the domain's "already passed" sentence.
 *  - Pages: `export default async function Page({ params, searchParams })` (both Promises), `export const dynamic = 'force-dynamic'`.
 *    They start with `requirePageAccess(<route>)` and return `refusal` when it is set (so `lib/route-capability.ts` gets the routes;
 *    see READ GATES). Banners come from `withFlash(searchParams)`. The page function must return a tree `renderToStaticMarkup`
 *    can render: NO async child server components.
 *  - Redirect paths are literals/templates without `?` or `&`; nav values ride as the second argument (`{ store }`).
 *
 * FILES, ACTIONS AND FORM FIELDS (all under apps/erp/src/app/menu/)
 *  menu/actions.ts            redirect `/menu`
 *    createCategoryAction     name, parentId?, sortOrder?                     gate manage_menu          ok 'Category added.'
 *    editCategoryAction       id, name?, sortOrder?                           gate manage_menu          ok 'Category saved.'
 *    retireCategoryAction     id                                              gate manage_menu          ok 'Category retired.'
 *    createItemAction         categoryId, name, itemType, description?        gate add_menu_item        ok 'Item added.'
 *                             (this one redirects to `/menu/items/<new id>`)
 *  menu/items/[id]/actions.ts redirect `/menu/items/<menuItemId>`; EVERY form carries hidden `menuItemId` (the page's item)
 *    editItemAction           menuItemId, name?, description?, categoryId?, sortOrder?, status?   manage_menu   ok 'Item saved.'
 *    addVariantAction         menuItemId, label                               gate add_menu_item        ok 'Variant added.'
 *    setDepletionRuleAction   menuItemId, variantId, mode (direct|recipe|no_stock), stockItemId?, recipeId?, quantityPerSale?, effectiveFrom?
 *                                                                              gate set_menu_depletion   ok 'Depletion rule saved.'
 *    createOptionGroupAction  menuItemId, name, selectionMode, minSelections, maxSelections, values? (one name per line)
 *                             creates the group, its values AND attaches it to the item    manage_menu   ok 'Option group added.'
 *    editOptionGroupAction    menuItemId, id, name?, selectionMode?, minSelections?, maxSelections?, status?   ok 'Option group saved.'
 *    addOptionValueAction     menuItemId, optionGroupId, name                 manage_menu               ok 'Option added.'
 *    editOptionValueAction    menuItemId, id, name?, sortOrder?, status?      manage_menu               ok 'Option saved.'
 *    linkOptionGroupAction    menuItemId, optionGroupId, variantId? (blank = attach to the item)        ok 'Option group attached.'
 *    unlinkOptionGroupAction  menuItemId, linkId                              manage_menu               ok 'Option group removed.'
 *    setPackageRefillsAction  menuItemId, packageVariantId, refillItemIds (repeated; none ticked = no refills)   ok 'Refills saved.'
 *  menu/prices/actions.ts     redirect `/menu/prices` with nav { store: storeId }
 *    setPriceAction           storeId, variantId, channel (store|online), pricingMode? (fixed|percent_markup|fixed_markup, default fixed),
 *                             amount?, markupPercent?, fixedMarkupAmount?, bundleHeads?, extraHeadAmount?, effectiveFrom?
 *                                                                              gate set_menu_price @ storeId
 *                             ok 'Price saved.' (from now) or 'Price scheduled.' (effectiveFrom given)
 *    withdrawPriceAction      storeId, variantId, channel, effectiveFrom?     set_menu_price            ok 'Price withdrawn.'
 *    cancelScheduledPriceAction  storeId, offerId                             set_menu_price            ok 'Scheduled price cancelled.'
 *    setOptionPriceAction     storeId, optionValueId, channel, priceDelta?, withdraw? ('1'), effectiveFrom?   set_menu_price
 *                             a blank priceDelta WITHOUT withdraw=1 is an error (never a silent withdrawal)
 *                                                                              ok 'Option price saved.' / 'Option price withdrawn.'
 *    cancelScheduledOptionPriceAction  storeId, optionOfferId                 set_menu_price            ok 'Scheduled price cancelled.'
 *  menu/requests/actions.ts   redirect `/menu/requests`
 *    submitItemRequestAction  storeId, name, itemType, categoryId?, note?, confirmed?   request_menu_item @ storeId
 *                             TWO-STEP duplicate check: without `confirmed=1`, if the name looks like an item already on the menu
 *                             (menuRepo.similarMenuItems), NOTHING is written and the redirect carries a `warning` banner naming each
 *                             match ("... may already be on the menu: Samgyupsal Set. ..."); the page then shows a submit button labelled
 *                             "Send request anyway" (name="confirmed" value="1") only while that warning is shown. With `confirmed=1`,
 *                             or no match, the request is created. The gate runs BEFORE the check (a refused person learns no item names).
 *                             ok 'Request sent.'
 *    withdrawItemRequestAction  id                                            requester only            ok 'Request withdrawn.'
 *    approveItemRequestAction id, categoryId                                  gate add_menu_item        ok 'Item added from the request.'
 *    markItemRequestDuplicateAction  id, itemId                               gate add_menu_item        ok 'Marked as a duplicate.'
 *    rejectItemRequestAction  id, note                                        gate add_menu_item        ok 'Request rejected.'
 *
 * PAGES
 *  /menu                  menu/page.tsx           searchParams: type? (a_la_carte|package|refill), status? (active|retired),
 *                          filter? ('no_rule' | 'not_offered'), store? (needed by 'not_offered'). Items grouped under their category
 *                          (category name as a heading, item name linking to `/menu/items/<id>`). Controls by label: 'Add category'
 *                          (manage_menu only), 'Add item' (add_menu_item = super admin only), a link 'Request an item' to /menu/requests.
 *                          A category holding active items shows "Holds N active item(s)" (2 -> "Holds 2 active items", 1 ->
 *                          "Holds 1 active item") beside its Retire control: retiring is refused while it does (S3 ruling).
 *  /menu/items/[id]       menu/items/[id]/page.tsx   item, variants, option groups, package refills, depletion history (each rule with
 *                          its stock item NAME), per-store offer table with the full history and any scheduled change (amounts as 2-dp
 *                          text). Unknown id or another org's id -> notFound().
 *  /menu/prices           menu/prices/page.tsx    ?store=<id>. Store picker `<select name="store">` listing ONLY the stores the person is
 *                          scoped to (person_store_scope), by name. No ?store = the first of them. A store outside the scope is
 *                          never drawn (redirect or notFound are both fine; its id/name never appear). Grid variants x channel: price in
 *                          force, scheduled change, set/withdraw/cancel forms (hidden storeId, variantId, channel). An online RULE row
 *                          shows the rule ("+7.5%", "+/- peso") AND the resolved price (resolveOfferPrice) beside it; resolved below zero
 *                          shows a message containing "below zero"; no store row to follow shows "no counter price"; a withdrawn row
 *                          shows "withdrawn". Option-value deltas per channel below the grid.
 *  /menu/requests         menu/requests/page.tsx  manager: request form (select `storeId` listing only their stores, name, itemType,
 *                          categoryId, note) + THEIR OWN requests with outcomes (Open / Approved / Rejected + note / "Duplicate of <item>"
 *                          / Withdrawn). Super admin: the open queue, each with its likely matches and the buttons 'Approve' (category
 *                          select pre-selecting the request's category hint), 'Mark duplicate' (item select), 'Reject' (note). Admin and
 *                          manager never see those buttons.
 *
 * READ GATES (lib/route-capability.ts): /menu, /menu/items/[id] and /menu/prices need `view_menu`; /menu/requests needs
 *  `request_menu_item`. Staff (no capability) get the access-refused card that names the capability.
 *
 * NOT PINNED HERE (builder judgment, follow the T-389 pattern): typed-slot refill of a refused save.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from 'vitest';
import { sql as dsql } from 'drizzle-orm';

import type { Actor } from '@shareat/auth';
import { captureRedirect, outcomeOf, pageParamsOf, resetJar, type Outcome } from '../helpers/flash-jar';

export { cast, rawItem, rawRule, rawOption, asOrg, sql, uid, type Cast } from '../../../../packages/domain/tests/integration/_fixtures/t401-s2-menu';
export { dsql };

/**
 * T-401 S4 (TESTER) - the shared harness for the /menu screens. Spec: docs/tasks/401-erp-menu-catalog-master.md section 5.
 *
 * Each test file owns its `vi.mock`s (they hoist per file) and points the session mock at `session` below, so one
 * file-level `as(actor)` decides who is signed in:
 *
 *   vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
 *   vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
 *   vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
 *   vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
 */
export const session = { actor: null as Actor | null };

export function sessionMock() {
  return {
    requireActor: async () => session.actor,
    requireSession: async () => ({
      actor: session.actor,
      sessionId: 'session-1',
      credentialKind: 'pin' as const,
      storeId: null,
      expiresAt: new Date('2099-01-01'),
    }),
  };
}

type Field = string | string[] | null | undefined;
/** A FormData from a plain object. null / undefined fields are not sent; an array sends the name once per value. */
export function fd(fields: Record<string, Field>): FormData {
  const out = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else out.set(k, v);
  }
  return out;
}

/** Runs a server action as `who`. Every S4 action ends in a redirect (redirectWithFlash); the result is what the person is shown next. */
export async function run(load: () => Promise<Record<string, unknown>>, name: string, who: Actor, form: FormData): Promise<Outcome & { url: string }> {
  const mod = await load();
  const action = mod[name] as ((f: FormData) => Promise<void>) | undefined;
  if (typeof action !== 'function') throw new Error(`${name} is not exported by the module (S4 builder file does not exist yet, or lacks this action)`);
  session.actor = who;
  resetJar();
  const signal = await captureRedirect(() => action(form));
  return { ...outcomeOf(signal), url: signal.url };
}

/** Text as a person reads it. */
export const plain = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** Renders a page (default export) as `who`. `flashFrom` = the redirect URL of the action whose banner the page should show. */
export async function render(
  load: () => Promise<{ default: (p: never) => Promise<unknown> | unknown }>,
  who: Actor,
  props: { params?: Record<string, string>; search?: Record<string, string>; flashFrom?: string } = {},
): Promise<string> {
  const mod = await load();
  session.actor = who;
  const search = { ...(props.flashFrom ? pageParamsOf(props.flashFrom) : {}), ...(props.search ?? {}) };
  const el = await mod.default({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(search) } as never);
  return renderToStaticMarkup(el as never);
}

/** The refusal card requirePageAccess draws (page-access.tsx). */
export function expectAccessRefused(html: string, capability: string): void {
  const t = plain(html);
  expect(t, 'the access-refused card is drawn').toContain('You do not have access to this screen');
  expect(t, 'it names the capability').toContain(capability);
}

/** A refusal in a sentence: shown to the person, nothing raw from the database. */
export function expectSentenceError(error: string | undefined, what: string): void {
  expect(error, `${what}: no error banner`).toBeTruthy();
  expect(error as string, `${what}: database wording leaked`).not.toMatch(/violates|duplicate key|unique constraint|check constraint|trigger|menu_[a-z_]+_(key|check|fk|idx)|relation "|SQLSTATE/i);
  expect((error as string).trim().length, `${what}: empty sentence`).toBeGreaterThan(10);
}

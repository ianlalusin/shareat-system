/**
 * T-641 - the tools Ask ERP's model may call. Every one is a THIN WRAPPER over a report or read the screens already use, run AS THE PERSON WHO ASKED.
 *
 * What makes that true, and what a test pins:
 *   1. The organisation and the person are never tool arguments. They are the asker's own (`actor`), and nothing the model sends can replace them: a tool reads only the argument names it
 *      declares, and ignores every other key (an `orgId`, a `personId`, a `storeId` of another company are simply never read).
 *   2. A store the model names is looked up ONLY among the stores the asker may see (scope.ts), then `authorize()` runs for the tool's own capability at that store. Another company's store,
 *      or a store the asker is not assigned to, is "not one of yours".
 *   3. Which tools the model is OFFERED follows what the asker may do, but offering is a courtesy, not the lock: every call authorizes again, so a tool the model was never offered and calls
 *      anyway is refused the same way.
 *   4. A refusal is a plain sentence returned AS the tool result ("refused": true, "message"). The model passes it on; it does not get a way round it.
 *   5. No tool writes. No tool writes SQL: each calls an existing report function or repo read, and shapes its answer with a narrow projection (shape.ts).
 */
import { AuthorizationError, authorize, can, isAdministrative, CAPABILITY_SCOPE, type Actor, type Capability } from '@shareat/auth';
import { accessRepo, aiHubRepo, budgetsRepo, lowStockRepo, storesRepo, type Tx } from '@shareat/db';
import type { ToolCall, ToolDef } from '@shareat/ai';
import { RefusalError, refuse } from '../shared/refusal';
import { getIncomeStatement } from '../reports/income-statement';
import { getSalesRollup } from '../reports/sales-rollup';
import { getStorePLComparison } from '../reports/store-comparison';
import { expenseItemsReport } from '../reports/expense-items';
import { getUnpaidLiabilities } from '../reports/unpaid-liabilities';
import { listFindings } from '../findings';
import { lastCompletedPeriod } from '../scheduler';
import type { TxRunner } from '../ai/shared';
import { searchKnowledge } from './knowledge';
import { budgetPeriodKey, resolvePeriod, type ResolvedPeriod } from './period';
import { findStore, type Picked, type StoreRef, type Visible } from './scope';
import { periodOut, shapeBudgets, shapeCostDrivers, shapeFindings, shapeIncomeStatement, shapeKnowledge, shapeLowStock, shapeSalesRollup, shapeStoreComparison, shapeUnpaid, storesOut } from './shape';

export interface AskSource {
  label: string;
  href: string;
}

export interface AskKit {
  defs: ToolDef[];
  run: (call: ToolCall) => Promise<string>;
  /** The screens the answers came from, in the order the tools ran, without repeats. */
  sources: () => AskSource[];
  /** The names of the stores the asker may ask about, for the prompt. */
  storeNames: string[];
}

interface Ctx {
  actor: Actor;
  v: Visible;
  today: string;
  manager: boolean;
}
interface Out {
  data: Record<string, unknown>;
  source?: AskSource;
}
interface Tool {
  def: ToolDef;
  /** The capability that decides whether the tool is OFFERED (and which `pickStores` enforces on every call). null = open to anyone who may ask. */
  cap: Capability | null;
  exec: (tx: Tx, ctx: Ctx, args: Readonly<Record<string, unknown>>) => Promise<Out>;
}

const VIEW_REPORTS: Capability = 'view_financial_reports';
const MANAGE_BUDGETS: Capability = 'manage_expense_budgets';
const STOCK: Capability = 'record_stock_movement';
/** Most stores one answer fans out over (each is a report run). A technical ceiling on one tool's work. */
const MAX_FAN_OUT = 8;
const GROUPINGS = ['day', 'month', 'store'] as const;
type Grouping = (typeof GROUPINGS)[number];

const text = (v: unknown, max = 120): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined);
const name = (s: StoreRef): string => `${s.name} (${s.code})`;
const storeNameOf = (v: Visible) => (id: string): string | null => {
  const s = v.stores.find((x) => x.id === id);
  return s ? name(s) : null;
};
const link = (label: string, path: string, params: Record<string, string | undefined> = {}): AskSource => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return { label, href: q ? `${path}?${q}` : path };
};

// ---- which stores a question may touch (scope.ts has the types and the store lookup) ----

async function visibleStores(tx: Tx, actor: Actor): Promise<Visible> {
  const all = await storesRepo.listForOrg(tx, actor.orgId);
  const covers = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
  const held = new Set(await accessRepo.storeIdsForPerson(tx, actor.personId));
  const off = new Set((await aiHubRepo.listStoreSwitches(tx, actor.orgId)).filter((s) => !s.enabled).map((s) => s.storeId));
  const role = (await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role;
  const stores = all
    .filter((s) => !off.has(s.id) && (s.isActive ? covers || held.has(s.id) : held.has(s.id)))
    .map(({ id, name, code }) => ({ id, name, code }));
  const activeIds = new Set(all.filter((s) => s.isActive).map((s) => s.id));
  return { stores, orgWide: isAdministrative(role) || covers, activeCount: activeIds.size, activeShown: stores.filter((s) => activeIds.has(s.id)).length };
}

/**
 * The stores a tool reads for `capability`, as the asker. Throws the capability's own refusal (an `AuthorizationError`, with its plain sentence) when the person may not use it at the
 * named store, or at any store when none is named. `authorize` is the logging check, so a refused ask is recorded like any other refusal.
 */
async function pickStores(tx: Tx, actor: Actor, v: Visible, capability: Capability, raw: unknown): Promise<Picked> {
  const storeScoped = CAPABILITY_SCOPE[capability] === 'store';
  const given = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  if (given) {
    const s = findStore(v, given);
    await authorize(tx, actor, capability, storeScoped ? { storeId: s.id } : {});
    return { stores: [s], named: true, wholeOrg: false, note: null };
  }
  if (v.stores.length === 0) throw refuse('ask erp: the asker has no store in scope', 'You are not assigned to any store that AI is switched on for, so there is nothing I can show.');
  const allowed: StoreRef[] = [];
  for (const s of v.stores) if (await can(tx, actor, capability, storeScoped ? { storeId: s.id } : {})) allowed.push(s);
  if (allowed.length === 0) {
    // the logging check, once, so the person gets the capability's own sentence and the refusal is recorded
    await authorize(tx, actor, capability, storeScoped ? { storeId: (v.stores[0] as StoreRef).id } : {});
    throw refuse(`ask erp: ${capability} not held at any store`, 'You do not have access to that information.');
  }
  const wholeOrg = v.orgWide && allowed.length === v.stores.length && v.activeShown === v.activeCount;
  const note = allowed.length < v.stores.length ? `Only the ${allowed.length} of your ${v.stores.length} stores where you may see this are included.` : null;
  return { stores: allowed, named: false, wholeOrg, note };
}

// ---- the shared pieces of the definitions ------------------------------------------------------------------------------------------------------------
const STORE_PARAM = { type: 'string', description: 'A store code or name, as listed by listMyStores. Leave it out for every store the person may see.' };
const PERIOD_PARAMS = {
  period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'this_year'], description: 'A named period. Default this_month. Ignored when from and to are given.' },
  from: { type: 'string', description: 'First day, YYYY-MM-DD. Give together with to.' },
  to: { type: 'string', description: 'Last day, YYYY-MM-DD. Give together with from.' },
};
const def = (n: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  name: n,
  description,
  parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
});

/** Runs `one` for the whole organisation, for the single store, or for each allowed store (at most MAX_FAN_OUT). Each store's result is its own, never a sum the screen would not show. */
async function scoped<T>(picked: Picked, one: (storeId: string | null) => Promise<T>): Promise<{ whole: T } | { each: { store: string; data: T }[]; leftOut: number }> {
  if (picked.wholeOrg) return { whole: await one(null) };
  const only = picked.stores[0];
  if (picked.stores.length === 1 && only) return { whole: await one(only.id) };
  const each: { store: string; data: T }[] = [];
  for (const s of picked.stores.slice(0, MAX_FAN_OUT)) each.push({ store: name(s), data: await one(s.id) });
  return { each, leftOut: Math.max(0, picked.stores.length - MAX_FAN_OUT) };
}

function frame(picked: Picked, period: ResolvedPeriod | null): Record<string, unknown> {
  return { ...(period ? { period: periodOut(period) } : {}), stores: storesOut(picked.stores, picked.wholeOrg), ...(picked.note ? { note: picked.note } : {}) };
}

function shapedScope<T>(picked: Picked, period: ResolvedPeriod | null, r: { whole: T } | { each: { store: string; data: T }[]; leftOut: number }, shape: (t: T) => Record<string, unknown>): Record<string, unknown> {
  if ('whole' in r) return { ...frame(picked, period), ...shape(r.whole) };
  return {
    ...frame(picked, period),
    perStore: r.each.map((e) => ({ store: e.store, ...shape(e.data) })),
    ...(r.leftOut > 0 ? { storesNotShown: r.leftOut } : {}),
  };
}

const singleStoreId = (picked: Picked): string | undefined => (picked.stores.length === 1 && !picked.wholeOrg ? picked.stores[0]?.id : undefined);

// ---- the tools --------------------------------------------------------------------------------------------------------------------------------------
const TOOLS: readonly Tool[] = [
  {
    cap: null,
    def: def(
      'searchKnowledge',
      "Search the company's approved documents: how the ERP works, what the words mean, the decisions made and how each kind of entry is booked. Use it for any 'how do I' or 'what does X mean' question, before answering from memory.",
      { query: { type: 'string', description: 'A few key words from the question.' } },
      ['query'],
    ),
    exec: async (_tx, ctx, args) => {
      const query = text(args.query, 300);
      if (!query) throw refuse('ask erp: empty knowledge query', 'Give a few words to search for.');
      return { data: shapeKnowledge(await searchKnowledge(query, { manager: ctx.manager })) };
    },
  },
  {
    cap: null,
    def: def('listMyStores', 'List the stores this person may ask about, by name and code. Call it when a store is named loosely or when you are unsure which stores exist.', {}),
    exec: async (_tx, ctx) => ({ data: { stores: ctx.v.stores.map((s) => ({ name: s.name, code: s.code })) } }),
  },
  {
    cap: VIEW_REPORTS,
    def: def(
      'costDrivers',
      'Where the expense money went in a period: the biggest expense categories and items with their totals and share. Use it for "what is our cost driver", "what do we spend most on".',
      { ...PERIOD_PARAMS, store: STORE_PARAM },
    ),
    exec: async (tx, ctx, args) => {
      const period = resolvePeriod(args, ctx.today);
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, args.store);
      const r = await scoped(picked, (storeId) => expenseItemsReport(tx, ctx.actor, { from: period.from, to: period.to, storeId }));
      return {
        data: shapedScope(picked, period, r, shapeCostDrivers),
        source: link('Spending by item', '/reports/expense-items', { from: period.from, to: period.to, store: singleStoreId(picked) }),
      };
    },
  },
  {
    cap: VIEW_REPORTS,
    def: def('incomeStatement', 'Sales, cost of sales, expenses and profit for a period, with the biggest expense accounts. Use it for profit, margin, "how did we do".', { ...PERIOD_PARAMS, store: STORE_PARAM }),
    exec: async (tx, ctx, args) => {
      const period = resolvePeriod(args, ctx.today);
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, args.store);
      const r = await scoped(picked, (storeId) => getIncomeStatement(tx, { orgId: ctx.actor.orgId, storeId, fromDate: period.from, toDate: period.to, includeYearClose: false }));
      return {
        data: shapedScope(picked, period, r, shapeIncomeStatement),
        source: link('Income statement', '/reports/income-statement', { from: period.from, to: period.to, store: singleStoreId(picked) }),
      };
    },
  },
  {
    cap: VIEW_REPORTS,
    def: def('storeComparison', 'The income statement figures of each store side by side for a period. Use it to compare stores.', { ...PERIOD_PARAMS }),
    exec: async (tx, ctx, args) => {
      const period = resolvePeriod(args, ctx.today);
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, undefined);
      const result = await getStorePLComparison(tx, { orgId: ctx.actor.orgId, storeIds: picked.stores.slice(0, 12).map((s) => s.id), fromDate: period.from, toDate: period.to, includeYearClose: false });
      const byId = storeNameOf(ctx.v);
      return {
        data: { ...frame(picked, period), ...shapeStoreComparison(result.stores.map((row) => ({ store: byId(row.storeId) ?? 'a store', statement: row.statement }))) },
        source: link('Store comparison', '/reports/store-comparison', { from: period.from, to: period.to }),
      };
    },
  },
  {
    cap: VIEW_REPORTS,
    def: def('salesRollup', 'Total sales for a period, by day, month or store, and by channel (walk-in, Grab, Foodpanda) and package type. Use it for "how much did we sell".', {
      ...PERIOD_PARAMS,
      store: STORE_PARAM,
      groupBy: { type: 'string', enum: ['day', 'month', 'store'], description: 'How to break the total down. Default day for a short period, month for a long one.' },
    }),
    exec: async (tx, ctx, args) => {
      const period = resolvePeriod(args, ctx.today);
      const given = text(args.groupBy);
      const asked = GROUPINGS.find((g) => g === given);
      if (given !== undefined && asked === undefined) throw refuse('ask erp: unknown grouping', 'Group by day, month or store.');
      const groupBy: Grouping = asked ?? (period.from.slice(0, 7) === period.to.slice(0, 7) ? 'day' : 'month');
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, args.store);
      const byId = storeNameOf(ctx.v);
      const r = await scoped(picked, (storeId) => getSalesRollup(tx, { orgId: ctx.actor.orgId, storeId, fromDate: period.from, toDate: period.to, groupBy }));
      return {
        data: shapedScope(picked, period, r, (rollup) => shapeSalesRollup(rollup, byId, groupBy)),
        source: link('Sales rollup', '/reports/sales-rollup', { from: period.from, to: period.to, store: singleStoreId(picked), groupBy }),
      };
    },
  },
  {
    cap: MANAGE_BUDGETS,
    def: def('budgetVsActual', 'For each expense category, the budget cap against what was spent, for a month. Use it for "are we over budget".', {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Default this_month.' },
      store: STORE_PARAM,
    }),
    exec: async (tx, ctx, args) => {
      const asked = text(args.period);
      if (asked !== undefined && asked !== 'this_month' && asked !== 'last_month') throw refuse('ask erp: budget period', 'Budgets are kept by month: use this_month or last_month.');
      const period = resolvePeriod({ period: asked ?? 'this_month' }, ctx.today);
      const picked = await pickStores(tx, ctx.actor, ctx.v, MANAGE_BUDGETS, args.store);
      const each: { store: string; data: Record<string, unknown> }[] = [];
      for (const s of picked.stores.slice(0, MAX_FAN_OUT)) each.push({ store: name(s), data: shapeBudgets(await budgetsRepo.listForStorePeriod(tx, ctx.actor.orgId, s.id, budgetPeriodKey(period))) });
      const only = each[0];
      return {
        data:
          each.length === 1 && only
            ? { ...frame(picked, period), ...only.data }
            : { ...frame(picked, period), perStore: each.map((e) => ({ store: e.store, ...e.data })), ...(picked.stores.length > MAX_FAN_OUT ? { storesNotShown: picked.stores.length - MAX_FAN_OUT } : {}) },
        source: link('Budgets', '/budgets', { store: singleStoreId(picked), period: budgetPeriodKey(period) }),
      };
    },
  },
  {
    cap: VIEW_REPORTS,
    def: def(
      'openFindings',
      'What the system has flagged: unusual spending (a category far above its usual week, an expense far above its usual, a possible duplicate, spending over a budget cap), cash not remitted, books that do not tie and more. Use it for "anything unusual", "what needs attention".',
      { store: STORE_PARAM },
    ),
    exec: async (tx, ctx, args) => {
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, args.store);
      const feed = await listFindings(tx, ctx.actor.orgId, { period: lastCompletedPeriod() });
      const ids = new Set(picked.stores.map((s) => s.id));
      // company-wide findings (no store) only for an org-wide person looking at everything; otherwise only the findings of the stores in scope
      const mine = feed.findings.filter((f) => (f.storeId === null ? picked.wholeOrg : ids.has(f.storeId)));
      return { data: { ...frame(picked, null), ...shapeFindings(mine, storeNameOf(ctx.v)) }, source: link('Findings', '/findings') };
    },
  },
  {
    cap: STOCK,
    def: def('lowStock', 'Items at or below their reorder threshold, worst shortage first. Use it for "what are we running out of".', { store: STORE_PARAM }),
    exec: async (tx, ctx, args) => {
      const picked = await pickStores(tx, ctx.actor, ctx.v, STOCK, args.store);
      const rows = await lowStockRepo.lowStockForStores(tx, ctx.actor.orgId, picked.stores.map((s) => s.id));
      return {
        data: { ...frame(picked, null), ...shapeLowStock(rows, storeNameOf(ctx.v)) },
        source: link('Low stock', '/inventory/low-stock', { store: singleStoreId(picked) }),
      };
    },
  },
  {
    cap: VIEW_REPORTS,
    def: def('unpaidLiabilities', 'What the company still owes: supplier bills, recurring bills not yet recorded, loans and other obligations, with what is due when. Wages are never included.', { store: STORE_PARAM }),
    exec: async (tx, ctx, args) => {
      const picked = await pickStores(tx, ctx.actor, ctx.v, VIEW_REPORTS, args.store);
      const r = await scoped(picked, (storeId) => getUnpaidLiabilities(tx, ctx.actor, { storeId }));
      return { data: shapedScope(picked, null, r, shapeUnpaid), source: link('Everything unpaid', '/liabilities/unpaid') };
    },
  },
];

/** Does the asker hold `cap` at any store they may see? (non-logging) */
async function holdsAnywhere(tx: Tx, actor: Actor, v: Visible, cap: Capability): Promise<boolean> {
  for (const s of v.stores) if (await can(tx, actor, cap, { storeId: s.id })) return true;
  return false;
}

/**
 * Everything one question needs, built in ONE transaction as the asker: the stores they may see, which of the report capabilities they hold, and from those the tools to offer.
 * The returned `run` authorizes again on every call (see the file header, point 3).
 */
export async function buildKit(run: TxRunner, actor: Actor, today: string): Promise<AskKit> {
  const { v, held } = await run(async (tx) => {
    const visible = await visibleStores(tx, actor);
    const held = new Map<Capability, boolean>();
    for (const cap of [VIEW_REPORTS, MANAGE_BUDGETS, STOCK]) held.set(cap, await holdsAnywhere(tx, actor, visible, cap));
    return { v: visible, held };
  });
  const ctx: Ctx = { actor, v, today, manager: held.get(VIEW_REPORTS) === true };
  const offered = TOOLS.filter((t) => t.cap === null || held.get(t.cap) === true);
  const byName = new Map<string, Tool>(TOOLS.map((t) => [t.def.name, t] as const));
  const sources: AskSource[] = [];

  return {
    defs: offered.map((t) => t.def),
    storeNames: v.stores.map(name),
    sources: () => sources,
    run: async (call) => {
      const tool = byName.get(call.name);
      if (!tool) return JSON.stringify({ refused: true, message: 'That tool does not exist.' });
      try {
        const out = await run((tx) => tool.exec(tx, ctx, call.args));
        if (out.source && !sources.some((s) => s.href === out.source?.href)) sources.push(out.source);
        return JSON.stringify(out.data);
      } catch (e) {
        // a refusal is an answer, in the person's own words; anything else is a fault and goes up (the loop tells the model the lookup failed, never why)
        if (e instanceof AuthorizationError || e instanceof RefusalError) return JSON.stringify({ refused: true, message: e.userMessage ?? 'You do not have access to that information.' });
        throw e;
      }
    },
  };
}

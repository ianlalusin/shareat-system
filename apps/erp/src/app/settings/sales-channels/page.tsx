import { requirePageAccess } from '../../../lib/page-access';
import { listStores } from '../../expenses/lib';
import {
  createSalesChannelAction,
  setSalesChannelActiveAction,
  updateSalesChannelAction,
} from './actions';
import { channelsForStore, moneyAccountNames, receivableOptions, type SalesChannelAdminRow } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { EditableRecord } from '@/components/forms';
import { Banner, Button, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Sales channels — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

/**
 * `/settings/sales-channels`. T-230 — **DEF-207's remedy**, and bible §13 row 180's surface.
 *
 * ⭐ **Why this is its own route and not a panel on `/admin/stores/[id]`.** Channels are
 * `manage_store_settings`: store-scoped, and a **manager holds it**. The store detail page is
 * `manage_stores` (admin only) and early-returns for a manager with a refusal card. An editor
 * embedded there would be invisible to exactly the role that holds the capability. That page links
 * *here* from its failing readiness row instead, the way it already links `signIn` to `/staff`.
 *
 * ⭐ **DEF-207, in one sentence:** `sales_channels` had no production writer of any kind, while
 * `storeReadiness`'s `salesChannel` check is **blocking** — so a store created through
 * `/admin/stores` was permanently not-ready, its own panel said so, and there was no remedy.
 *
 * ⚠️ **Two fields are shown and not editable, and the reasons differ.** The payout wallet already
 * has a gated writer with its own screen (`setChannelPayoutDestination` on `/channel-settlements`)
 * and a second writer would be a second validation that drifts. The tax treatment has exactly one
 * supported value: no `1270` creditable-withholding asset is seeded, deliberately, and bible §13
 * row 75 makes the credit unrealisable. Showing them with the reason is what "handle it honestly"
 * means for a field this screen must not own.
 *
 * ⛔ **No delete, and never one.** Three tables reference a channel with `on delete restrict`. v1
 * shipped a hard delete beside its own `isActive` flag — *"This will permanently remove the sales
 * channel… This cannot be undone"* — which is the implementation this corrects while keeping the
 * capability (§1.2's four verbs).
 */
export default async function SalesChannelsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/sales-channels');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <Crumb />
        <h1 className="text-2xl font-semibold">Sales channels</h1>
        <PageDescription>
          This organisation has no stores yet. Create one under{' '}
          <a href="/admin/stores" className="underline">
            Stores
          </a>{' '}
          first — a channel belongs to a branch.
        </PageDescription>
      </Page>
    );
  }

  const [channels, accounts, walletNames] = await Promise.all([
    channelsForStore(actor, storeId),
    receivableOptions(actor),
    moneyAccountNames(actor),
  ]);

  const active = channels.filter((c) => c.isActive);
  const retired = channels.filter((c) => !c.isActive);

  return (
    <Page density="table">
      <div>
        <Crumb />
        <h1 className="text-2xl font-semibold">Sales channels</h1>
        <PageDescription>
          How this branch sells: walk-in, and each delivery platform. A channel decides{' '}
          <strong>whether its money reaches the till on the day</strong> or is owed to us until the
          platform settles — and <strong>whether a wasted order gets reviewed</strong> or is
          decided on the spot.
        </PageDescription>
      </div>

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="mt-1">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      <FlashBanner flash={sp} />

      {active.length === 0 && (
        <Banner tone="warning">
          <strong>This store has no active sales channel, so it cannot trade.</strong> A sales day
          has nowhere to land without one. Add the first below — for most branches that is a
          walk-in channel whose money reaches the till.
        </Banner>
      )}

      {active.map((c) => (
        <ChannelCard key={c.id} channel={c} storeId={storeId} accounts={accounts} walletNames={walletNames} />
      ))}

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Add a channel</h2>
        <form action={createSalesChannelAction} className="space-y-4 text-sm">
          <input type="hidden" name="storeId" value={storeId} />
          <ChannelFields accounts={accounts} />
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      </section>

      {retired.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium">Retired</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Not offered on new sales days. Still shown on everything already recorded, and anything
            still open against one can still be resolved — which is why a channel is retired and
            never deleted.
          </p>
          {retired.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
            >
              <div>
                <span className="font-medium">{c.name}</span>{' '}
                <span className="text-neutral-500 dark:text-neutral-400">
                  · {c.isRemittedDaily ? 'reached the till' : `settled to ${c.receivableAccountCode}`}
                </span>
              </div>
              <form action={setSalesChannelActiveAction}>
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="channelId" value={c.id} />
                <input type="hidden" name="name" value={c.name} />
                <input type="hidden" name="isActive" value="true" />
                <Button type="submit" variant="secondary">
                  Reactivate
                </Button>
              </form>
            </div>
          ))}
        </section>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Where a platform&apos;s payout lands is set on{' '}
        <a href="/channel-settlements" className="underline">
          Channel settlements
        </a>
        , alongside the settlement it is used for. Withholding tax is booked as an expense on every
        channel — there is no creditable-tax account to claim it against, because this ledger is a
        management record and never a filing basis.
      </p>
    </Page>
  );
}

function Crumb() {
  return (
    <p className="text-xs text-neutral-500 dark:text-neutral-400">
      <a href="/settings" className="underline">
        Settings
      </a>{' '}
      / Sales channels
    </p>
  );
}

function ChannelCard({
  channel,
  storeId,
  accounts,
  walletNames,
}: {
  channel: SalesChannelAdminRow;
  storeId: string;
  accounts: { code: string; name: string }[];
  walletNames: Map<string, string>;
}) {
  const wallet = channel.destinationMoneyAccountId ? walletNames.get(channel.destinationMoneyAccountId) : null;
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{channel.name}</h2>
        <Pill tone={channel.isRemittedDaily ? 'neutral' : 'amber'}>
          {channel.isRemittedDaily ? 'Reaches the till' : 'Settles later'}
        </Pill>
        <Pill tone={channel.wastageTypeMode === 'tracked' ? 'neutral' : 'amber'}>
          {channel.wastageTypeMode === 'tracked' ? 'Wastage reviewed' : 'Wastage decided on the spot'}
        </Pill>
      </div>

      {!channel.isRemittedDaily && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Payout wallet:{' '}
          {wallet ? (
            <strong>{wallet}</strong>
          ) : (
            <>
              <strong>not set</strong> — a settlement cannot be recorded until it is
            </>
          )}
          .{' '}
          <a href="/channel-settlements" className="underline">
            Set it on Channel settlements
          </a>
          . Withholding tax: <strong>expense</strong>.
        </p>
      )}

      <EditableRecord
        action={updateSalesChannelAction}
        label={channel.name}
        hidden={{ storeId, channelId: channel.id }}
      >
        <ChannelFields accounts={accounts} channel={channel} />
      </EditableRecord>

      <form action={setSalesChannelActiveAction}>
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="channelId" value={channel.id} />
        <input type="hidden" name="name" value={channel.name} />
        <input type="hidden" name="isActive" value="false" />
        <button
          type="submit"
          className={`${ACTION_LINK} text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200`}
        >
          Retire this channel
        </button>
      </form>
    </section>
  );
}

/**
 * ⭐ **The remittance radios carry NO `defaultChecked` on a new channel, deliberately.**
 * `is_remitted_daily` is NOT NULL with no default in the schema — *"a channel whose remittance
 * behaviour nobody stated is a channel whose money nobody can account for"* — so the form must be
 * able to be un-answered, and the server refuses an un-answered one. A checkbox could not express
 * that: unchecked IS a value.
 *
 * ⚠️ The receivable field is always visible rather than revealed by JS. These screens are server
 * components with no client bundle, and the honest arrangement is to show the field with the
 * condition written next to it — the database's CHECK is what actually enforces the pairing.
 */
function ChannelFields({
  accounts,
  channel,
}: {
  accounts: { code: string; name: string }[];
  channel?: SalesChannelAdminRow;
}) {
  return (
    <div className="space-y-4 text-sm">
      <FormGrid>
        <Field label={<span className="text-neutral-600 dark:text-neutral-400">Channel name</span>}>
          <Input
            name="name"
            required
            defaultValue={channel?.name ?? ''}
            placeholder="Walk-in, Foodpanda, GrabFood…"
            className="mt-1 w-full"
          />
        </Field>
      </FormGrid>

      <fieldset className="space-y-2">
        <legend className="text-neutral-600 dark:text-neutral-400">Where does this money go?</legend>
        <Radio
          field="isRemittedDaily"
          value="true"
          required
          defaultChecked={channel?.isRemittedDaily === true}
          title="Reaches the till"
          detail="Counted in the day's remittance, like cash and cards."
        />
        <Radio
          field="isRemittedDaily"
          value="false"
          required
          defaultChecked={channel?.isRemittedDaily === false}
          title="Settles later"
          detail="A platform owes us until it pays out. Needs a receivable account below."
        />
      </fieldset>

      <FormGrid>
        <Field
          label={
            <span className="text-neutral-600 dark:text-neutral-400">
              Receivable account <span className="text-neutral-400">— required when it settles later</span>
            </span>
          }
        >
          <Select
            name="receivableAccountCode"
            defaultValue={channel?.receivableAccountCode ?? ''}
            className="mt-1 w-full"
          >
            <option value="">— none (only valid when it reaches the till) —</option>
            {accounts.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>

      <fieldset className="space-y-2">
        <legend className="text-neutral-600 dark:text-neutral-400">
          When an order through this channel is wasted or refunded
        </legend>
        <Radio
          field="wastageTypeMode"
          value="tracked"
          defaultChecked={(channel?.wastageTypeMode ?? 'tracked') === 'tracked'}
          title="Review it"
          detail="Goes to the store's Wastage Monitor, can be disputed for 48 hours, and is charged automatically after 15 days if nobody decides."
        />
        <Radio
          field="wastageTypeMode"
          value="instant"
          defaultChecked={channel?.wastageTypeMode === 'instant'}
          title="Decide on the spot"
          detail="Whoever records it says what happens to the money, there and then. No review, no dispute window, no backstop."
        />
      </fieldset>

    </div>
  );
}

/**
 * ⚠️ **A radio group is scoped to its FORM, not to the document** (HTML: the group is the set of
 * radios sharing a name AND a form owner). So every card's edit form and the add form can each use
 * `name="isRemittedDaily"` without fighting — no per-form name mangling is needed, and adding one
 * would only make the action read a key it does not know.
 *
 * Touch targets are full-width rows, not bare dots — phone portrait is the canvas.
 */
function Radio({
  field,
  value,
  defaultChecked,
  required,
  title,
  detail,
}: {
  field: string;
  value: string;
  defaultChecked: boolean;
  /** ⭐ Only the remittance pair sets this: it is the field with no schema default, so "unanswered"
   *  must be refusable. The browser refuses first; the server refuses regardless. */
  required?: boolean;
  title: string;
  detail: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
      <input
        type="radio"
        name={field}
        value={value}
        defaultChecked={defaultChecked}
        required={required}
        className="mt-1"
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-neutral-500 dark:text-neutral-400">{detail}</span>
      </span>
    </label>
  );
}

function Pill({ tone, children }: { tone: 'neutral' | 'amber'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'bg-warning-soft text-warning-ink'
      : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

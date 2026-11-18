import { requirePageAccess } from '../../../lib/page-access';
import { listStores } from '../../expenses/lib';
import {
  createSalesChannelAction,
  setPlatformCodeAction,
  setSalesChannelActiveAction,
  updateSalesChannelAction,
} from './actions';
import { canEditPlatformCode, channelsForStore, moneyAccountNames, receivableOptions, type SalesChannelAdminRow } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { NAV_LINK } from '@/components/action-link';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { SETTINGS_PLATFORM_CODE_RULES, SETTINGS_SALES_CHANNEL_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, ConfirmDestructive, EmptyState, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { SALES_CHANNEL_EDIT } from './typed-forms';
import { accountLabel } from '@/lib/account-label';
import { PLATFORM_RECEIVABLE_CODE, platformReceivableOptions } from '@shareat/domain';

export const metadata = { title: 'Sales channels (walk-in, Grab, Foodpanda) — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

type Typed = Parameters<typeof typedFor>[0];

const CRUMB = (
  <>
    <a href="/settings" className={NAV_LINK}>
      Settings
    </a>{' '}
    / Sales channels (walk-in, Grab, Foodpanda)
  </>
);

const DESCRIPTION = (
  <>
    How this store sells: walk-in, and each delivery platform. A channel decides{' '}
    <strong>whether its money reaches the till on the day</strong> or is owed to us until the
    platform pays out, and <strong>whether a wasted order gets reviewed</strong> or is decided on
    the spot. Every channel belongs to a store; add stores under{' '}
    <a href="/admin/stores" className="underline">
      Stores
    </a>
    .
  </>
);

/** What a delivery platform calls the code on its statements, in the words the person sees. */
const CODE_LABEL = { foodpanda: 'Foodpanda store code', grab: 'Grab store ID' } as const;
const PLATFORM_NAME = { foodpanda: 'Foodpanda', grab: 'Grab' } as const;

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
 *
 * ⭐ **T-592: a list of records, and ONE store code, only where it belongs.** Each active channel is
 * a full-width band (name, where the money goes, store code, actions). A daily channel has no store
 * code at all (the database refuses one); a settle-later channel asks for it directly, with no
 * platform dropdown. The settlement wiring and bank-names forms are gone from this page (T-592 R4,
 * ruled by Ian 17 Nov 2026); their database data and domain functions stay.
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
      <Page density="table" className="space-y-4" crumb={CRUMB} title="Sales channels (walk-in, Grab, Foodpanda)" description={DESCRIPTION}>
        <EmptyState illustration="magnifier" title="No stores yet" body="Create a store under Stores first. Every channel belongs to a store." />
      </Page>
    );
  }

  const [channels, accounts, walletNames, canSetPlatformCode] = await Promise.all([
    channelsForStore(actor, storeId),
    receivableOptions(actor),
    moneyAccountNames(actor),
    // T-511 S2b: admin only, at THIS store. Presentation: the domain function is the gate.
    canEditPlatformCode(actor, storeId),
  ]);

  const active = channels.filter((c) => c.isActive);
  const retired = channels.filter((c) => !c.isActive);

  return (
    <Page density="table" crumb={CRUMB} title="Sales channels (walk-in, Grab, Foodpanda)" description={DESCRIPTION}>
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
          has nowhere to land without one. Add the first below. For most stores that is a
          walk-in channel whose money reaches the till.
        </Banner>
      )}

      <div className="space-y-8">
        <div className="space-y-4">
          {active.map((c) => (
            <ChannelBand key={c.id} channel={c} storeId={storeId} accounts={accounts} walletNames={walletNames} sp={sp} actorId={actor.personId} canSetPlatformCode={canSetPlatformCode} />
          ))}
        </div>

        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Add a channel</h2>
          <CheckedForm rules={SETTINGS_SALES_CHANNEL_RULES} action={createSalesChannelAction} className="space-y-4 text-sm">
            <input type="hidden" name="storeId" value={storeId} />
            <ChannelFields
              accounts={accounts}
              nameField={
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Channel name</span>} rule={SETTINGS_SALES_CHANNEL_RULES.name}>
                  <Input
                    {...nativeAttrs(SETTINGS_SALES_CHANNEL_RULES.name)}
                    defaultValue=""
                    placeholder="Walk-in, Foodpanda, GrabFood…"
                    className="mt-1 w-full"
                  />
                </Field>
              }
            />
            <Button type="submit" variant="primary">
              Save
            </Button>
          </CheckedForm>
        </section>

        {retired.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-medium">Retired</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Not offered on new sales days. Still shown on everything already recorded. A channel is
              retired, never deleted.
            </p>
            <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {retired.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{c.name}</span>{' '}
                    <span className="text-neutral-600 dark:text-neutral-400">
                      · {c.isRemittedDaily ? 'reached the till' : `settled to ${accountLabel(c.receivableAccountCode)}`}
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
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Where a platform&apos;s payout lands is set on{' '}
          <a href="/channel-settlements" className="underline">
            Channel settlements
          </a>
          , next to the settlement it is used for. Withholding tax is booked as an expense on every channel.
        </p>
      </div>
    </Page>
  );
}

/**
 * One active channel as a full-width band. At `lg` the summary is a row of four zones (name and pills, where the money goes,
 * store code, actions); on a phone they stack. A daily channel keeps an empty third zone so the columns line up down the list.
 */
function ChannelBand({
  channel,
  storeId,
  accounts,
  walletNames,
  sp,
  actorId,
  canSetPlatformCode,
}: {
  channel: SalesChannelAdminRow;
  storeId: string;
  accounts: { code: string; name: string }[];
  walletNames: Map<string, string>;
  sp: Typed;
  actorId: string;
  canSetPlatformCode: boolean;
}) {
  const wallet = channel.destinationMoneyAccountId ? walletNames.get(channel.destinationMoneyAccountId) : null;
  const receivable = accounts.find((a) => a.code === channel.receivableAccountCode);
  const settlesLater = !channel.isRemittedDaily;
  return (
    <section aria-label={channel.name} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_14rem] lg:gap-6">
        <div className="min-w-0 space-y-2">
          <h2 className="break-words font-medium">{channel.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{channel.isRemittedDaily ? 'Reaches the till' : 'Settles later'}</Pill>
            <Pill>{channel.wastageTypeMode === 'tracked' ? 'Wastage reviewed' : 'Wastage decided on the spot'}</Pill>
          </div>
        </div>

        <div className="min-w-0 space-y-1 text-sm">
          <ZoneLabel>Where the money goes</ZoneLabel>
          {settlesLater ? (
            <>
              <p>Owed by the platform until it pays out. Receivable account: <strong>{receivable ? `${receivable.code} · ${receivable.name}` : (channel.receivableAccountCode ?? 'not set')}</strong>.</p>
              {channel.platform && channel.receivableAccountCode !== PLATFORM_RECEIVABLE_CODE && (
                <p className="text-neutral-600 dark:text-neutral-400">
                  A delivery platform&apos;s sales must go to {PLATFORM_RECEIVABLE_CODE}, which payouts and platform files read. This channel uses {channel.receivableAccountCode ?? 'no account'}. Edit the channel to fix it.
                </p>
              )}
              <p className="text-neutral-600 dark:text-neutral-400">
                Payout wallet:{' '}
                {wallet ? (
                  <strong>{wallet}</strong>
                ) : (
                  <>
                    <strong className="text-warning-ink">not set</strong>. A settlement cannot be recorded until it is
                  </>
                )}
                .{' '}
                <a href="/channel-settlements" className="underline">
                  Set it on Channel settlements
                </a>
                .
              </p>
            </>
          ) : (
            <p>Reaches the till on the day, like cash and cards.</p>
          )}
        </div>

        {settlesLater && canSetPlatformCode && channel.platform ? (
          <StoreCodeForm channel={channel} storeId={storeId} inline />
        ) : settlesLater ? (
          <StoreCodeSummary channel={channel} canSetPlatformCode={canSetPlatformCode} />
        ) : (
          <div aria-hidden="true" className="hidden lg:block" />
        )}

        <div className="flex min-w-0 flex-wrap items-start gap-2 lg:justify-end">
          <EditableRecord
            action={updateSalesChannelAction}
            label={channel.name}
            editText="Edit channel"
            hidden={{ storeId, channelId: channel.id }}
            typed={typedFor(sp, SALES_CHANNEL_EDIT, channel.id, actorId)}
            rules={SETTINGS_SALES_CHANNEL_RULES}
          >
            <ChannelFields
              accounts={accounts}
              channel={channel}
              nameField={
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Channel name</span>} rule={SETTINGS_SALES_CHANNEL_RULES.name}>
                  <Input
                    {...nativeAttrs(SETTINGS_SALES_CHANNEL_RULES.name)}
                    defaultValue={channel.name}
                    placeholder="Walk-in, Foodpanda, GrabFood…"
                    className="mt-1 w-full"
                  />
                </Field>
              }
            />
          </EditableRecord>

          <form action={setSalesChannelActiveAction} className="min-w-0 max-w-full">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="channelId" value={channel.id} />
            <input type="hidden" name="name" value={channel.name} />
            <input type="hidden" name="isActive" value="false" />
            <ConfirmDestructive
              tier="confirm"
              quiet
              label="Retire this channel"
              consequence="It stays on everything already recorded, and anything still open against it can still be resolved. You can bring it back later."
            />
          </form>
        </div>
      </div>

      {settlesLater && canSetPlatformCode && !channel.platform && <StoreCodeForm channel={channel} storeId={storeId} />}
    </section>
  );
}

/** What is saved: the code, or a plain line saying what is missing and what that costs. Everyone sees this; only an admin gets the form. */
function StoreCodeSummary({ channel, canSetPlatformCode }: { channel: SalesChannelAdminRow; canSetPlatformCode: boolean }) {
  const platform = channel.platform;
  return (
    <div className="min-w-0 space-y-1 text-sm">
      <ZoneLabel>{platform ? CODE_LABEL[platform] : 'Store code'}</ZoneLabel>
      {channel.platformStoreCode ? (
        <p className="break-all font-medium">Store code: {channel.platformStoreCode}</p>
      ) : (
        <p className="text-warning-ink">
          Not set — payout files cannot be matched to this channel until it is.
          {!canSetPlatformCode && ' An admin sets it.'}
        </p>
      )}
    </div>
  );
}

/**
 * T-511 S2b / T-592: the admin-only store-code form, its own form so the shared edit form (which a manager posts) carries no
 * platform field. With the platform known it is one box and a hidden platform; with none it is two radio rows and the box
 * (a radio pair, not a dropdown: two visible choices and no hidden "None"). A blank box with the platform known clears both.
 * Renders inline in the band's third zone when the platform is known, and below the band only when it is not (the radio case).
 */
function StoreCodeForm({ channel, storeId, inline }: { channel: SalesChannelAdminRow; storeId: string; inline?: boolean }) {
  const platform = channel.platform;
  return (
    <div className={inline ? 'min-w-0' : 'mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800'}>
      <CheckedForm rules={SETTINGS_PLATFORM_CODE_RULES} action={setPlatformCodeAction} className="space-y-3 text-sm">
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="channelId" value={channel.id} />
        {platform ? (
          <input type="hidden" name="platform" value={platform} />
        ) : (
          <fieldset className="space-y-2">
            <legend className="font-medium">Which platform is this channel?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <Radio field="platform" value="foodpanda" required defaultChecked={false} title="Foodpanda" detail="Its statements show a code of 3 to 12 letters or digits." />
              <Radio field="platform" value="grab" required defaultChecked={false} title="Grab" detail="Its statements show a long store ID." />
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={platform ? CODE_LABEL[platform] : 'Store code from the platform’s statements'}
            rule={SETTINGS_PLATFORM_CODE_RULES.code}
            className={inline ? 'min-w-0 w-full flex-1' : 'w-full sm:w-72'}
          >
            <Input
              {...nativeAttrs(SETTINGS_PLATFORM_CODE_RULES.code)}
              required={!platform}
              defaultValue={channel.platformStoreCode ?? ''}
              placeholder={platform ? `The ${PLATFORM_NAME[platform]} code on its statements` : 'The code printed on the statements'}
              className="w-full"
            />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
        {platform && (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">Leave the box empty and press Save to remove the code. Admin only.</p>
        )}
      </CheckedForm>
    </div>
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
  nameField,
}: {
  accounts: { code: string; name: string }[];
  channel?: SalesChannelAdminRow;
  /** The name box, drawn by the caller INSIDE its own form so the live rule sits in the form that owns it (T-440 G2). */
  nameField: React.ReactNode;
}) {
  return (
    <div className="space-y-4 text-sm">
      <FormGrid>{nameField}</FormGrid>

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
        {channel?.platform ? (
          // T-606: a delivery platform's receivable is fixed - shown, not chosen. The hidden value is what the save carries (the domain refuses anything else).
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Receivable account</span>}>
            <input type="hidden" name="receivableAccountCode" value={PLATFORM_RECEIVABLE_CODE} />
            <p className="mt-1">
              <strong>
                {PLATFORM_RECEIVABLE_CODE} · {platformReceivableOptions(accounts)[0]?.name ?? 'Channel receivable'}
              </strong>{' '}
              <span className="text-neutral-600 dark:text-neutral-400">(fixed for a delivery platform)</span>
            </p>
          </Field>
        ) : (
          <Field
            label={
              <span className="text-neutral-600 dark:text-neutral-400">
                Receivable account <span className="text-neutral-600 dark:text-neutral-400">(required when it settles later)</span>
              </span>
            }
          >
            <Select
              name="receivableAccountCode"
              defaultValue={channel?.receivableAccountCode ?? ''}
              className="mt-1 w-full"
            >
              <option value="">None (only when it reaches the till)</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} · {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
        <span className="block text-xs text-neutral-600 dark:text-neutral-400">{detail}</span>
      </span>
    </label>
  );
}

/** One tone for every pill: the words carry the meaning, so nothing here reads as a warning that is not one. */
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{children}</span>;
}

function ZoneLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{children}</p>;
}

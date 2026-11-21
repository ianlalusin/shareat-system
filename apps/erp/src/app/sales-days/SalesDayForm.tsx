/**
 * The body of the sales-day form, shared by `/sales-days/new` and `/sales-days/[id]/edit`.
 * T-369 S3 (DEF-479): extracted from `new/page.tsx` so an edit is the SAME form, prefilled.
 *
 * ⚠️ Renders the SECTIONS only - the `<form action=...>` and its hidden `storeId` / `salesDayId`
 * stay on each page. `apps/erp/tests/t339-sales-day-new-store-picker.test.ts` reads `new/page.tsx`'s
 * own source for the form tag and the identifier its hidden `storeId` is bound to; moving the tag in
 * here would silently stop that guard from looking at the thing it guards.
 *
 * R1: the store and the date are never edited, so on an edit the date is plain text, not an input.
 */
import type { ReactNode } from 'react';
import { formatBusinessDayLong } from '@shareat/core/datetime';
import { peso } from '@/lib/format';
import { Button, HelpTip, Input, SaveBar } from '@/components/ui';
import { RuleCheck } from '@/components/forms';
import { DraftMemory } from './DraftMemory';
import { accountLabel } from '@/lib/account-label';
import type { ChannelOption } from './lib';

const FIELD = 'w-full text-right tabular-nums';
const CARD = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';
const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

export interface SalesDayDefaults {
  /** The day's own figures, by input name (`totalSales`, `cashCollected`, ...). Absent = blank. */
  figures?: Record<string, string>;
  /** Channel id -> what the day already says about it. */
  channels?: Record<string, { amount: string; noSales: boolean }>;
  /** Money account id -> the amount the day landed there. */
  tenders?: Record<string, string>;
}

export interface SalesDayFormProps {
  /** Left out when the page already shows the store (the New page's store switcher): the field would say it twice. */
  storeLabel?: string;
  /** New: an editable date defaulting to this. Edit: shown as text, never an input (R1). */
  businessDate: string;
  dateEditable: boolean;
  /** T-440: the editable date field, built by the page INSIDE its checked form (so the rule and the control sit in one lexical form). */
  dateField?: ReactNode;
  channels: ChannelOption[];
  wallets: { id: string; name: string; custodian: string }[];
  defaults?: SalesDayDefaults;
  /** Wallets the day already has money recorded against that are no longer active: shown, never an
   *  input (an edit keeps them as they are). */
  retiredTenders?: { name: string; amount: string }[];
  submitLabel: string;
  /** T-504: who and which store, for the browser-side draft memory (keyed by person + store + date). */
  draft: { personId: string; storeId: string };
}

export function SalesDayForm({ storeLabel, businessDate, dateEditable, dateField, channels, wallets, defaults, retiredTenders, submitLabel, draft }: SalesDayFormProps) {
  const channelFacts = { channels: channels.map((c) => ({ id: c.id, name: c.name })) };
  const fig = (name: string) => defaults?.figures?.[name];
  return (
    <>
      <DraftMemory personId={draft.personId} storeId={draft.storeId} businessDate={businessDate} dateFieldName={dateEditable ? 'businessDate' : undefined} />
      {dateEditable ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {storeLabel !== undefined && (
            <div className="flex flex-col gap-1">
              <span className={LABEL}>Store</span>
              <p className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                {storeLabel}
              </p>
            </div>
          )}
          {dateField}
        </section>
      ) : (
        <p className="text-xs text-muted">
          {storeLabel !== undefined && <>{storeLabel} · </>}
          {formatBusinessDayLong(businessDate)}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="space-y-4">
          <section className={CARD}>
            <Heading help="Unlimited plus à la carte must equal the total. À la carte includes dine-in à la carte, take-out and delivery.">Revenue</Heading>
            <div className="grid gap-3 sm:grid-cols-3">
              <Money name="totalSales" label="Total sales" value={fig('totalSales')} />
              <Money name="unliSales" label="Unlimited" value={fig('unliSales')} />
              <Money name="alaCarteSales" label="À la carte" value={fig('alaCarteSales')} />
            </div>
          </section>

          <section className={CARD}>
            <Heading help="Senior and PWD discounts are listed separately because the tax rules require it. Comps are recorded on their own, not as a discount.">Discounts and comps</Heading>
            <div className="grid gap-3 sm:grid-cols-4">
              <Money name="seniorDiscount" label="Senior" value={fig('seniorDiscount')} />
              <Money name="pwdDiscount" label="PWD" value={fig('pwdDiscount')} />
              <Money name="otherDiscount" label="Other" value={fig('otherDiscount')} />
              <Money name="comps" label="Comps" value={fig('comps')} />
            </div>
          </section>

          <section className={CARD}>
            <Heading help="Leftover, packaging and other charges are income. A service charge is not: by law all of it goes to staff, so it is held and paid out through payroll, and it never counts as revenue.">Charges</Heading>
            <div className="grid gap-3 sm:grid-cols-2">
              <Money name="serviceCharge" label="Service charge (held for staff)" value={fig('serviceCharge')} />
              <Money name="otherCharges" label="Other charges (leftover, packaging)" value={fig('otherCharges')} />
            </div>
          </section>

          <section className={CARD}>
            <Heading help="Everything taken in plus everything given away must equal everything earned: cash + online + credit + channels settled later + discounts + comps = gross sales + charges. Card payments go under online.">How it was paid</Heading>
            <div className="grid gap-3 sm:grid-cols-3">
              <Money name="cashCollected" label="Cash (at the cashier)" value={fig('cashCollected')} />
              <Money name="onlineCollected" label="Online / e-wallet" value={fig('onlineCollected')} />
              <Money name="creditSales" label="Credit / on account" value={fig('creditSales')} />
            </div>
          </section>
        </div>

        <div className="space-y-4">
          {channels.length > 0 && (
            <section className={CARD}>
              <Heading help="A channel that reaches the till is counted with the day's cash. One that settles later (Foodpanda, GrabFood) is paid to a bank afterwards. Every channel needs an amount, or No sales ticked. A zero is not the same as no sales. You can save with a box blank and finish later, but the day cannot be submitted until each one is filled.">Sales channels</Heading>
              <ul role="list" className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {channels.map((c) => {
                  const prior = defaults?.channels?.[c.id];
                  return (
                    <li key={c.id} className="grid min-h-11 grid-cols-[1fr_8rem] items-center gap-x-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate">{c.name}</p>
                        {c.isRemittedDaily ? (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">reaches the till</p>
                        ) : (
                          <p className="text-xs text-warning-ink">settles later → {accountLabel(c.receivableAccountCode)}</p>
                        )}
                      </div>
                      <Input
                        name={`channel_${c.id}`}
                        aria-label={`Amount for ${c.name}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        defaultValue={prior && !prior.noSales ? prior.amount : undefined}
                        className={FIELD}
                      />
                      <label className="col-span-2 flex min-h-11 items-center justify-end gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                        <input type="checkbox" name={`nosales_${c.id}`} defaultChecked={prior?.noSales ?? false} />
                        No sales
                      </label>
                    </li>
                  );
                })}
              </ul>
              {/* T-504: the rule, live. Zero-with-no-tick and amount-with-tick turn Save off; a blank only warns (a draft may carry it). */}
              <RuleCheck id="salesDay.channels.tickedOrTyped" facts={channelFacts} />
              <RuleCheck id="salesDay.channels.blankHint" facts={channelFacts} />
            </section>
          )}

          {/* ⭐ DEF-068 — WHERE the online money landed. NOT the same question as the channel
              breakdown above: a channel says where the sale came FROM, this says where the money
              WENT. A Foodpanda sale can settle into any wallet, so neither answers the other. */}
          {wallets.length > 0 && (
            <section className={CARD}>
              <Heading help="Must add up to the online figure above. Each peso has to say which wallet it reached.">Which wallet the online money reached</Heading>
              <ul role="list" className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {wallets.map((w) => (
                  <li key={w.id} className="grid min-h-11 grid-cols-[1fr_8rem] items-center gap-x-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate">{w.name}</p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">{w.custodian}</p>
                    </div>
                    <Input name={`tender_${w.id}`} aria-label={`Amount into ${w.name}`} inputMode="decimal" placeholder="0.00" defaultValue={defaults?.tenders?.[w.id]} className={FIELD} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {retiredTenders && retiredTenders.length > 0 && (
            <section className={CARD}>
              <Heading help="Money this day already recorded against wallets that have since been retired. It stays as it is and cannot be changed here. Verifying still needs all wallets, these included, to add up to the online figure.">Wallets no longer in use</Heading>
              <ul role="list" className="text-sm">
                {retiredTenders.map((t) => (
                  <li key={t.name} className="flex justify-between gap-4 py-1">
                    <span>{t.name}</span>
                    <span className="tabular-nums">{peso(t.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {/* T-589 B8 G8: the long form scrolls under the save, so it is never off-screen on a phone (same bar as admin/users). */}
      <SaveBar>
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
      </SaveBar>
    </>
  );
}

function Money({ name, label, value }: { name: string; label: string; value?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <Input name={name} placeholder="0.00" defaultValue={value} className={FIELD} />
    </label>
  );
}

function Heading({ children, help }: { children: string; help: string }) {
  return (
    <h2 className="flex items-center gap-2 font-medium">
      {children}
      <HelpTip label={children}>{help}</HelpTip>
    </h2>
  );
}

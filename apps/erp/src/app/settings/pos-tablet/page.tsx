import { formatBusinessDateTime } from '@shareat/core/datetime';
import { posTabletPairingsRepo } from '@shareat/db';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { withOrgPrincipal } from '../../expenses/lib';
import { staffStoresFor } from '../../staff/lib';
import { pairPosTabletAction, unpairPosTabletAction } from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, Button, ConfirmDestructive, FlashBanner, Input } from '@/components/ui';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'POS tablet — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
}

const when = (d: Date | null): string => (d ? formatBusinessDateTime(d) : 'never');

/**
 * `/settings/pos-tablet`. T-464 (Ian, 2026-10-22).
 *
 * Pair a store's POS tablet once; after that staff sign in there with Employee ID + PIN. A manager of the store, or an admin, pairs and
 * un-pairs it (`pair_pos_tablet`, store-scoped). Pairing is done ON the tablet, signed in with email: this browser becomes the store's
 * tablet and the manager is signed out. Un-pairing works from any device, which is how a lost tablet is cut off.
 *
 * One live tablet per store: pairing a new one replaces the old one, and the screen says so before the button. The page lists only
 * stores where the viewer holds the capability; the write checks it again at the store it resolves.
 */
export default async function PosTabletPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/pos-tablet');
  if (refusal) return refusal;

  const stores = await staffStoresFor(actor, ['pair_pos_tablet']);
  const rows = await withOrgPrincipal(actor.orgId, (tx) =>
    posTabletPairingsRepo.listForStores(
      tx,
      actor.orgId,
      stores.map((s) => s.id),
    ),
  );

  return (
    <Page density="table">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className={ACTION_LINK}>
            Settings
          </a>{' '}
          / POS tablet
        </p>
        <h1 className="text-2xl font-semibold">POS tablet</h1>
        <PageDescription>
          Set a store&apos;s counter tablet up once. After that, staff sign in on it with their Employee ID and PIN only. To pair, open this page
          on the tablet itself.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {stores.length === 0 && (
        <Banner tone="warning">You do not manage any store, so there is no tablet here for you to pair.</Banner>
      )}

      {stores.map((s) => {
        const mine = rows.filter((r) => r.storeId === s.id);
        const live = mine.find((r) => !r.revokedAt);
        const past = mine.filter((r) => r.revokedAt);
        return (
          <section key={s.id} className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="font-medium">{s.name}</h2>

            {live ? (
              <div className="space-y-2 text-sm">
                <p>
                  <strong>{live.label}</strong> is this store&apos;s POS tablet.
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Paired by {live.pairedByName} on {when(live.pairedAt)}. Last used {when(live.lastUsedAt)}.
                </p>
                <form action={unpairPosTabletAction} className="space-y-2">
                  <input type="hidden" name="pairingId" value={live.id} />
                  <ConfirmDestructive
                    tier="retype"
                    label="Un-pair tablet"
                    consequence="Signs this tablet out at once and puts it back to the email sign-in. Nothing is deleted."
                    expectedName={live.label}
                  />
                </form>
              </div>
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No tablet is paired yet.</p>
            )}

            <form action={pairPosTabletAction} className="space-y-3 text-sm">
              <h3 className="font-medium">{live ? 'Pair a different tablet' : 'Pair this tablet'}</h3>
              <input type="hidden" name="storeId" value={s.id} />
              {live && (
                <Banner tone="warning">
                  This replaces the current POS tablet &lsquo;{live.label}&rsquo;. It is signed out and stops working.
                </Banner>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name for this tablet</span>
                <Input name="label" placeholder="Lipa counter" />
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                You will be signed out here, and this browser becomes the {s.name} tablet.
              </p>
              <Button type="submit" variant="primary">
                Pair this tablet
              </Button>
            </form>

            {past.length > 0 && (
              <details className="text-xs text-neutral-500 dark:text-neutral-400">
                <summary className="inline-flex min-h-6 cursor-pointer items-center">Earlier tablets ({past.length})</summary>
                <ul className="mt-2 space-y-1">
                  {past.map((r) => (
                    <li key={r.id}>
                      {r.label} — paired by {r.pairedByName} on {when(r.pairedAt)}, last used {when(r.lastUsedAt)}, ended {when(r.revokedAt)}.
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </Page>
  );
}

/**
 * T-526 R3 - the full-screen POS frame. AppShell already hides the ERP chrome here (`proxy.ts` tags `/pos` as a kiosk), so this owns the page.
 *
 * Server part: who is signed in, which POS words they hold, which stores they work at, the pairing (null on a phone or a kitchen browser),
 * and where the ERP button goes. ⛔ Presentation only: every page below still calls `requirePageAccess` and renders its own refusal, and every
 * write is gated in the domain. A layout cannot read `searchParams`, so the store choice (`?storeId=`) is made in the client shell and
 * re-checked by each page.
 */
import { heldCapabilities, resolvePosTablet } from '@shareat/auth';
import { currentSession, readPosTabletToken } from '@/lib/session';
import { requirePageAccess } from '@/lib/page-access';
import { withOrgPrincipal } from '../expenses/lib';
import { landingForActor } from '../sign-in/landing';
import { POS_CAPABILITIES, effectiveStore, posShellFacts } from './lib';
import { PosShell } from './_shell/PosShell';
import { canOpenGatedErpScreen } from './_shell/erp-access';

export const dynamic = 'force-dynamic';

export default async function PosLayout({ children }: { children: React.ReactNode }) {
  // Signed out: render the page, which redirects to sign-in carrying its own route as `next` (a redirect from here would carry '/pos').
  if (!(await currentSession())) return <>{children}</>;
  const { actor } = await requirePageAccess('/pos');

  const tabletToken = await readPosTabletToken();
  // The pairing is read in the same org-principalled transaction (RLS shows only this organisation's pairings), so another organisation's tablet cookie finds nothing.
  const { held, facts, pairing } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    held: await heldCapabilities(tx, actor),
    facts: await posShellFacts(tx, actor),
    pairing: tabletToken ? await resolvePosTablet(tx, tabletToken) : null,
  }));
  const pairedStoreId = pairing && pairing.orgId === actor.orgId ? effectiveStore(pairing, undefined).storeId : null;

  return (
    <PosShell
      person={{ personId: actor.personId, displayName: facts.displayName }}
      heldPos={POS_CAPABILITIES.filter((c) => held.has(c))}
      stores={facts.stores}
      pairedStoreId={pairedStoreId}
      erpHref={canOpenGatedErpScreen(held as ReadonlySet<string>) ? await landingForActor(actor, '') : null}
    >
      {children}
    </PosShell>
  );
}

/**
 * T-257 / DEF-259 — the ERP has no way to sign out. `signOutAction` (sign-in/actions.ts:107) is
 * complete and correct and had zero callers; this guards the wiring, not the action itself (the
 * action's own session-ending behaviour is `packages/auth/tests/integration/sessions.test.ts`'s
 * job).
 *
 * ⚠️ Reads the shell components as TEXT rather than rendering them, same reasoning as
 * `proxy-kiosk-header.test.ts` and `clock-route-is-client-only.test.ts`: this project has no
 * React-rendering test contract (no `@testing-library/react`, no `jsdom` environment — checked),
 * and `TopBar.tsx`/`Sidebar.tsx` mix Server and Client Components in one tree, which a plain
 * `node`-environment unit test cannot render anyway. What actually needs guarding — the three
 * "Signed in" slots now call `signOutAction` instead of sitting inert — is fully checkable from
 * source.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(here, '..', 'src', 'components', 'shell');
const topBarSource = readFileSync(resolve(shellDir, 'TopBar.tsx'), 'utf8');
const sidebarSource = readFileSync(resolve(shellDir, 'Sidebar.tsx'), 'utf8');
const iconsSource = readFileSync(resolve(shellDir, 'icons.tsx'), 'utf8');

describe('TopBar (phone, <768) — the "Signed in" slot is now a sign-out control', () => {
  it('imports signOutAction from the sign-in action module', () => {
    expect(topBarSource).toMatch(/import\s*\{[^}]*signOutAction[^}]*\}\s*from\s*['"][^'"]*sign-in\/actions['"]/);
  });

  it('renders a form posting to signOutAction with a submit button, not a bare "Signed in" span', () => {
    expect(topBarSource).toMatch(/<form\s+action=\{signOutAction\}>/);
    expect(topBarSource).not.toMatch(/<span[^>]*>Signed in<\/span>/);
  });

  it('the button says "Sign out"', () => {
    expect(topBarSource).toMatch(/<button[^>]*type="submit"[^>]*>\s*Sign out\s*<\/button>/);
  });
});

describe('Sidebar, expanded (>=768) — same replacement, not an added control', () => {
  it('imports signOutAction', () => {
    expect(sidebarSource).toMatch(/import\s*\{[^}]*signOutAction[^}]*\}\s*from\s*['"][^'"]*sign-in\/actions['"]/);
  });

  it('the expanded-only slot is a sign-out form, not a bare "Signed in" span', () => {
    // className may be a plain string or a template literal (FOCUS_RING interpolation, same as
    // the Collapse button already does) — check the properties independently of quote style, over
    // the whole <form>...</form> block rather than assuming attribute order.
    const formStart = sidebarSource.indexOf('<form action={signOutAction}');
    expect(formStart).toBeGreaterThan(-1);
    const expandedBlock = sidebarSource.slice(formStart, formStart + 500);
    expect(expandedBlock).toContain('shell-sidebar-expanded-only');
    expect(expandedBlock).toMatch(/type="submit"/);
    expect(expandedBlock).toMatch(/>\s*Sign out\s*</);
    expect(sidebarSource).not.toMatch(/shell-sidebar-expanded-only">Signed in<\/span>/);
  });
});

describe('Sidebar, collapsed to the rail — the decorative dot becomes an accessible control', () => {
  it('the collapsed-only slot is an icon-only sign-out button, not an aria-hidden dot', () => {
    expect(sidebarSource).not.toMatch(/aria-hidden="true"\s+className="shell-sidebar-collapsed-only h-2 w-2/);

    // The SECOND `<form action={signOutAction}>` in the file is the collapsed-rail one (the first
    // is the expanded slot, asserted above) — anchor there and take a generous forward window so a
    // long doc-comment on the button (explaining its explicit width) can't push attributes out of
    // an over-tight slice.
    const firstForm = sidebarSource.indexOf('<form action={signOutAction}');
    const secondFormIdx = sidebarSource.indexOf('<form action={signOutAction}', firstForm + 1);
    expect(secondFormIdx).toBeGreaterThan(-1);
    const collapsedBlock = sidebarSource.slice(secondFormIdx, secondFormIdx + 1400);
    expect(collapsedBlock).toContain('shell-sidebar-collapsed-only');
    expect(collapsedBlock).toMatch(/type="submit"/);
    expect(collapsedBlock).toMatch(/aria-label="Sign out"/);
    expect(collapsedBlock).toContain('<SignOutIcon');
  });

  it('reuses .shell-nav-row for the rail button, matching the Collapse button\'s touch target rather than an arbitrary new size', () => {
    const collapsedButtonBlock = sidebarSource.slice(sidebarSource.indexOf('shell-sidebar-collapsed-only', sidebarSource.indexOf('Sign out')));
    expect(collapsedButtonBlock.slice(0, 400)).toMatch(/shell-nav-row/);
  });
});

describe('Sidebar footer stays pinned — orchestrator browser pass, 1280x800: 125px below the fold', () => {
  // The browser pass found the footer unreachable without discovering the sidebar scrolls: at
  // 1280x800 the nav content is 969px in an 800px box, and `.shell-sidebar` itself carried
  // `overflow-y-auto`, so the WHOLE sidebar scrolled and the sign-out control went below the fold.
  // Fix: the nav list becomes the scroll container; the footer (and the wordmark/Collapse above
  // it) stay pinned to the sidebar's fixed-height box. This guard pins that arrangement so it
  // cannot silently drift back to the sidebar-level scroll.
  const shellDivMatch = sidebarSource.match(/<div className="(shell-sidebar[^"]*)">/);

  it('`.shell-sidebar` itself is no longer the scroll container', () => {
    expect(shellDivMatch).not.toBeNull();
    expect(shellDivMatch![1]).not.toMatch(/overflow-y-auto/);
    // Still a fixed-height box — this guards against fixing the scroll by ALSO dropping md:h-dvh,
    // which would let the sidebar grow past the viewport instead of scrolling internally.
    expect(shellDivMatch![1]).toMatch(/md:h-dvh/);
  });

  it('the nav-list wrapper is the scroll container, with min-h-0 so flex lets it actually shrink', () => {
    const navWrapperMatch = sidebarSource.match(/<div className="([^"]*)">\s*<SidebarNav/);
    expect(navWrapperMatch).not.toBeNull();
    expect(navWrapperMatch![1]).toMatch(/overflow-y-auto/);
    expect(navWrapperMatch![1]).toMatch(/min-h-0/);
  });

  it('the sign-out footer sits structurally AFTER the scrolling nav region, not inside it', () => {
    const navWrapperEnd = sidebarSource.indexOf('</SidebarNav>') !== -1
      ? sidebarSource.indexOf('</SidebarNav>')
      : sidebarSource.indexOf('/>', sidebarSource.indexOf('<SidebarNav'));
    const footerStart = sidebarSource.indexOf('mx-2 mb-2 flex items-center justify-center border-t');
    expect(navWrapperEnd).toBeGreaterThan(-1);
    expect(footerStart).toBeGreaterThan(navWrapperEnd);
  });
});

describe('icons.tsx — the one new export the placement decision approved', () => {
  it('adds a sign-out icon following the existing icon export pattern', () => {
    expect(iconsSource).toMatch(/export function \w*SignOut\w*Icon\(props: IconProps\)/);
  });

  it('Sidebar.tsx is the icon\'s named caller', () => {
    const match = iconsSource.match(/export function (\w*SignOut\w*Icon)\(props: IconProps\)/);
    expect(match).not.toBeNull();
    const iconName = match![1]!;
    expect(sidebarSource).toContain(iconName);
  });
});

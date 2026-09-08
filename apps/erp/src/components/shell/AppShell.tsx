/**
 * T-234 slice 1 — the shell root: reads the session and the sidebar cookie, renders `TopBar` +
 * `Sidebar` + the single `<main>` this app owns (lane B's `Page`, slice 2, renders a plain `<div>`
 * inside it — not its own `<main>`, or the document gets two landmarks). Returns bare `{children}`
 * whenever there is no session, exactly as `Nav()` did before this task.
 *
 * ⛔ **DEF-233, filed by the orchestrator**: this session check is the ONLY exclusion — `/clock`
 * is not additionally excluded by path, because a Server Component cannot read the current
 * pathname in Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
 * use-pathname.md`: "Reading the current URL from a Server Component is not supported"), and
 * `/clock`'s Firebase auth is entirely separate from this app's own `__session` cookie
 * (`apps/erp/src/lib/session.ts`). So the ERP's chrome CAN render on `/clock` if a manager holds
 * an ERP session in the same browser. Fix is middleware or a route-group restructure; out of this
 * slice's scope (`docs/tasks/234-responsive-shell-sidebar-nav.md` §2.2's file list).
 */
import { cookies } from 'next/headers';
import { currentSession } from '../../lib/session';
import { SIDEBAR_COOKIE_NAME, parseSidebarState } from './sidebar-state';
import { Sidebar, SidebarProvider } from './Sidebar';
import { TopBar } from './TopBar';

export async function AppShell({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session) return <>{children}</>;

  const cookieStore = await cookies();
  const initialState = parseSidebarState(cookieStore.get(SIDEBAR_COOKIE_NAME)?.value);

  return (
    <SidebarProvider initialState={initialState}>
      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

/** DEF-271: "Sign out (Ian)" - the control says WHO it ends, not only that it ends something. A plain module: a server component (TopBar) and a client one (Sidebar) both call it. */
export function signOutLabel(signedInAs: string | null): string {
  return signedInAs ? `Sign out (${signedInAs})` : 'Sign out';
}

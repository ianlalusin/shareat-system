/**
 * T-526 R1 (bible row 433) - the Kitchen screen is dark unless the viewer chose light. Decided here, on the server, so the first paint is right:
 * `.pos-theme[data-theme]` below is what globals.css reads (`:root:has(.pos-theme[data-theme='dark'])` carries the dark tokens to the whole page,
 * top bar included). Every other POS route keeps the ERP's light-by-default rule; `theme-state.ts` is untouched.
 */
import { cookies } from 'next/headers';
import { THEME_COOKIE_NAME } from '@/components/shell/theme-state';
import { posThemeFor } from '../_shell/theme';

export default async function PosKitchenLayout({ children }: { children: React.ReactNode }) {
  const theme = posThemeFor('/pos/kitchen', (await cookies()).get(THEME_COOKIE_NAME)?.value);
  return (
    <div className="pos-theme" data-theme={theme}>
      {children}
    </div>
  );
}

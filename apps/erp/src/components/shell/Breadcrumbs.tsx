'use client';

/**
 * T-630 — the breadcrumb above every ERP page, rendered once here in `AppShell` so no page can forget it
 * (`docs/tasks/630-breadcrumbs.md`). The steps come from `crumbSteps` in `../nav-crumbs.ts`; this file
 * only reads the two things a browser knows and a pure function cannot:
 *
 * 1. **The current page's own title** — its first `<h1>` inside `<main>`. Rule 3: a detail page's last
 *    step is the record's name the page already loaded, never the raw id. 130 pages render their own
 *    `<h1>` rather than passing a title anywhere, so reading it is the one way to honour that without
 *    editing every page. A `MutationObserver` catches a heading that streams in after navigation.
 * 2. **Titles seen earlier in this tab** (`sessionStorage`), so a middle `[id]` step shows the record's
 *    name ("Lipa") once you have opened it, and the generic label ("Store") before that. Storage can
 *    be missing or throw (private window, blocked site data); every access is guarded and the trail
 *    still renders without it.
 *
 * Phone width (rule 6): the list wraps and each step truncates with an ellipsis, so it never scrolls
 * sideways. Links are 44px tall on touch and 32px with a mouse, the same as every other control here.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { navHrefAllowed } from '../../lib/route-capability';
import { crumbSteps } from '../nav-crumbs';

const STORE_KEY = 'erp-crumb-titles';
const STORE_MAX = 200;

function readTitles(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberTitle(path: string, title: string) {
  try {
    const titles = readTitles();
    delete titles[path];
    titles[path] = title;
    const keys = Object.keys(titles);
    for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete titles[k];
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(titles));
  } catch {
    // No storage: the middle steps keep their generic labels.
  }
}

function pageHeading(): string | undefined {
  const h1 = document.querySelector('main h1');
  const text = h1?.textContent?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

export function Breadcrumbs({ held }: { readonly held: readonly string[] }) {
  const pathname = usePathname() ?? '/';
  const [heading, setHeading] = useState<{ path: string; text: string } | undefined>(undefined);
  const [remembered, setRemembered] = useState<Record<string, string>>({});

  useEffect(() => {
    setRemembered(readTitles());
    const read = () => {
      const text = pageHeading();
      if (!text) return;
      setHeading((prev) => (prev?.path === pathname && prev.text === text ? prev : { path: pathname, text }));
      rememberTitle(pathname, text);
    };
    read();
    const main = document.querySelector('main');
    if (!main) return;
    const observer = new MutationObserver(read);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname]);

  const heldSet = useMemo(() => new Set(held), [held]);
  const steps = crumbSteps(pathname, {
    titleOf: (path) => (path === pathname ? (heading?.path === pathname ? heading.text : undefined) : remembered[path]),
    canOpen: (path) => navHrefAllowed(path, heldSet),
  });
  if (steps.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="erp-crumbs px-4 pt-2 md:px-6 md:pt-3 xl:px-6 print:hidden">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-neutral-500 dark:text-neutral-400">
        {steps.map((step, i) => (
          <li key={`${i}:${step.href ?? step.label}`} className="flex min-w-0 max-w-full items-center gap-x-1">
            {i > 0 && (
              <span aria-hidden="true" className="select-none">
                ›
              </span>
            )}
            {step.href ? (
              <Link
                href={step.href}
                className="inline-flex min-h-11 max-w-[14rem] items-center truncate underline-offset-4 hover:text-ink hover:underline [@media(pointer:fine)]:min-h-8"
              >
                <span className="truncate">{step.label}</span>
              </Link>
            ) : (
              <span
                aria-current={step.current ? 'page' : undefined}
                className={`inline-flex min-h-11 max-w-[14rem] items-center [@media(pointer:fine)]:min-h-8${step.current ? ' font-medium text-neutral-700 dark:text-neutral-300' : ''}`}
              >
                <span className="truncate">{step.label}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

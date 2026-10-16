'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase/client'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/lib/types'
import { SheetClose } from '../ui/sheet'
import { Badge } from '../ui/badge'
import { useStoreContext } from '@/context/store-context'
import { QrWalletNavButton } from './qr-wallet-nav-button'

const navLinks = [
  { href: '/cashier', label: 'Cashier', roles: ['admin', 'manager', 'cashier'] },
  { href: '/reservations', label: 'Reservations', roles: ['admin', 'manager', 'cashier'] },
  { href: '/online-orders', label: 'Online Orders', roles: ['admin', 'manager', 'cashier'] },
  { href: '/pins', label: 'PINs', roles: ['admin', 'manager', 'cashier'] },
  { href: '/kitchen', label: 'Kitchen', roles: ['admin', 'manager', 'kitchen'] },
  { href: '/server', label: 'Server', roles: ['admin', 'manager', 'server'] },
]

// Online-order statuses that still need staff attention (everything except the
// terminal completed/cancelled/rejected/expired and the unpaid pending_payment).
const OPEN_ONLINE_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'ready_for_pickup', 'out_for_delivery']

interface MainNavProps {
  role?: UserRole | null;
  isMobile?: boolean;
}

export function MainNav({ role, isMobile = false }: MainNavProps) {
  const pathname = usePathname()
  const { activeStoreId } = useStoreContext()

  const accessibleLinks = role ? navLinks.filter(link => link.roles.includes(role)) : []
  const showReservations = accessibleLinks.some(link => link.href === '/reservations')
  const showOnlineOrders = accessibleLinks.some(link => link.href === '/online-orders')

  // Live count of PENDING bookings (status "booked" — not yet confirmed,
  // cancelled/rejected, handled, etc.) across all upcoming dates, so future
  // website bookings aren't missed. Single-field query (no composite index);
  // upcoming filtering is done client-side. Drives the 3-color blink alert.
  const [pendingReservationCount, setPendingReservationCount] = useState(0)
  useEffect(() => {
    if (!showReservations || !activeStoreId) {
      setPendingReservationCount(0)
      return
    }
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const startMs = startOfToday.getTime()
    const q = query(
      collection(db, 'stores', activeStoreId, 'reservations'),
      where('status', '==', 'booked'),
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        const pending = snap.docs.filter(d => Number((d.data() as any).reservedForMs ?? 0) >= startMs).length
        setPendingReservationCount(pending)
      },
      () => setPendingReservationCount(0),
    )
    return () => unsub()
  }, [showReservations, activeStoreId])

  // Live online-order queue for the active store. `openOnlineCount` is the
  // working pipeline (badge number); `newOnlineCount` (status "pending", not yet
  // accepted) drives the blink so brand-new orders aren't missed. Bounded `in`
  // query on a single field — only the small active set is read, never the full
  // (growing) onlineOrders history.
  const [openOnlineCount, setOpenOnlineCount] = useState(0)
  const [newOnlineCount, setNewOnlineCount] = useState(0)
  useEffect(() => {
    if (!showOnlineOrders || !activeStoreId) {
      setOpenOnlineCount(0)
      setNewOnlineCount(0)
      return
    }
    const q = query(
      collection(db, 'stores', activeStoreId, 'onlineOrders'),
      where('status', 'in', OPEN_ONLINE_STATUSES),
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        setOpenOnlineCount(snap.size)
        setNewOnlineCount(snap.docs.filter(d => (d.data() as any).status === 'pending').length)
      },
      () => {
        setOpenOnlineCount(0)
        setNewOnlineCount(0)
      },
    )
    return () => unsub()
  }, [showOnlineOrders, activeStoreId])

  if (!role) return null;

  return (
    <nav className={cn(
      "items-center space-x-4 lg:space-x-6",
      isMobile ? "flex flex-col space-x-0 space-y-4 items-start" : "hidden md:flex"
    )}>
      {accessibleLinks.map(({ href, label }) => {
        // Per-link "needs attention" badge + blink.
        let badgeCount = 0
        let blink = false
        let title: string | undefined
        if (href === '/reservations') {
          badgeCount = pendingReservationCount
          blink = pendingReservationCount > 0
          title = blink ? `${pendingReservationCount} pending reservation${pendingReservationCount > 1 ? 's' : ''} awaiting confirmation` : undefined
        } else if (href === '/online-orders') {
          badgeCount = openOnlineCount
          blink = newOnlineCount > 0
          title = badgeCount > 0
            ? `${openOnlineCount} open online order${openOnlineCount > 1 ? 's' : ''}${newOnlineCount > 0 ? ` — ${newOnlineCount} new` : ''}`
            : undefined
        }
        const hasBadge = badgeCount > 0

        const link = (
           <Link
              key={href}
              href={href}
              className={cn(
                'text-sm font-medium transition-colors hover:text-white/80 inline-flex items-center gap-1.5',
                pathname?.startsWith(href) ? 'text-white' : 'text-white/70',
                isMobile && 'text-lg',
                blink && 'nav-alert-blink'
              )}
              title={title}
            >
              {label}
              {hasBadge && (
                <Badge
                  className="h-5 min-w-5 justify-center px-1.5 text-xs bg-white text-primary hover:bg-white"
                >
                  {badgeCount}
                </Badge>
              )}
            </Link>
        );

        if (isMobile) {
          return <SheetClose key={href} asChild>{link}</SheetClose>
        }

        return link;
      })}

      {/* Sits after the links so it lands next to Admin, the last entry. Not a
          navLinks row: it opens a dialog rather than navigating, and it is
          available to every store role (a cashier shows the QR; only a
          manager can add one, which the wallet gates internally). */}
      <QrWalletNavButton
        showLabel={isMobile}
        className={cn(
          'text-white/70 hover:bg-white/10 hover:text-white',
          isMobile && 'w-full justify-start px-0 text-lg hover:bg-transparent',
        )}
      />
    </nav>
  )
}

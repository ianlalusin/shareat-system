
"use client";

import { Badge } from "@/components/ui/badge";
import { CardPill } from "./CardPill";

interface SessionHeaderProps {
  session: {
    id: string;
    tableNumber?: string | null;
    guestCount: number;
    packageName: string;
    sessionMode?: 'package_dinein' | 'alacarte';
    customerName?: string | null;
    sessionLabel?: string;
    linkedCustomerName?: string | null;
    linkedCustomerPhone?: string | null;
    linkedBy?: string | null;
  };
  onLinkCard?: () => void;
}

export function SessionHeader({ session, onLinkCard }: SessionHeaderProps) {

  const isAlaCarte = session.sessionMode === 'alacarte';
  const title = session.sessionLabel
    ?? (isAlaCarte ? (session.customerName || 'Ala Carte') : `Table ${session.tableNumber}`);
  const subtitle = isAlaCarte ? "Ala Carte" : session.packageName;

  return (
    <div className="grid gap-1">
      <h1 className="text-2xl sm:text-3xl font-bold leading-none">{title}</h1>
      <div className="flex items-center gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground">{subtitle}</p>
        <div className="flex items-center gap-2 flex-wrap">
            {!isAlaCarte && <Badge variant="outline">{session.guestCount} Guests</Badge>}
            <Badge variant="secondary">ID: {session.id.substring(0, 6)}</Badge>
            <CardPill
              session={session}
              onLinkClick={onLinkCard ? (e) => { e.stopPropagation(); onLinkCard(); } : undefined}
            />
        </div>
      </div>
    </div>
  );
}

    

    

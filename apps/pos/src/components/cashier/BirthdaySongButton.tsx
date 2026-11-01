'use client';

import { useEffect, useRef, useState } from 'react';
import { Cake, Square } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { getCurrentTrack, playBirthdayLoop, stopAll, subscribe } from '@/lib/birthday/player';

/**
 * Floating on/off badge (cashier list + dashboard): tap to play the birthday songs on a
 * loop, tap again to stop. Playback lives in the player module, so it keeps going while
 * the cashier moves between screens. `className` sets the badge's position so it can
 * stack with other floating buttons.
 */
export function BirthdaySongButton({ className = 'bottom-44 right-6' }: { className?: string }) {
  const { toast } = useToast();
  const [track, setTrack] = useState<number | null>(getCurrentTrack);

  useEffect(() => subscribe(setTrack), []);

  const playing = track !== null;
  // Ignore taps while a start or stop is still in flight, so a quick double tap
  // cannot interleave them.
  const busy = useRef(false);

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (getCurrentTrack() !== null) await stopAll();
      else await playBirthdayLoop();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not play', description: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current = false;
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={playing}
      aria-label={playing ? 'Stop birthday song' : 'Play birthday song'}
      title={playing ? 'Stop birthday song' : 'Play birthday song'}
      className={cn(
        'fixed z-40 h-14 w-14 rounded-full text-white shadow-2xl flex items-center justify-center hover:scale-105 active:scale-95 transition-transform ring-4',
        playing ? 'bg-red-500 ring-red-500/40 animate-pulse' : 'bg-pink-500 ring-pink-500/20',
        className,
      )}
    >
      {playing ? <Square className="h-6 w-6 fill-current" /> : <Cake className="h-6 w-6" />}
    </button>
  );
}

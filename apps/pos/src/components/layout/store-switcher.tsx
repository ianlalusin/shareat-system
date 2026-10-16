'use client'

import * as React from 'react'
import { ChevronsUpDown, Store } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useAuthContext } from '@/context/auth-context'
import { useStoreContext } from '@/context/store-context'
import { useToast } from '@/hooks/use-toast';

type PopoverTriggerProps = React.ComponentPropsWithoutRef<typeof PopoverTrigger>

interface StoreSwitcherProps extends PopoverTriggerProps {
  variant?: "desktop" | "mobileSheet";
  onSelected?: () => void;
}

export function StoreSwitcher({ className, variant = "desktop", onSelected }: StoreSwitcherProps) {
  const { appUser } = useAuthContext();
  const { activeStore, stores, setActiveStoreById, loading } = useStoreContext();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  
  const handleStoreSelect = async (storeId: string) => {
    setOpen(false);
    if (activeStore?.id === storeId) return;

    try {
        await setActiveStoreById(storeId);
        const selectedStore = stores.find(s => s.id === storeId);
        toast({
            title: "Store Switched",
            description: `You are now managing ${selectedStore?.name}.`,
        });
        onSelected?.();
    } catch (error) {
        toast({
            variant: 'destructive',
            title: "Error Switching Store",
            description: "Could not update your active store.",
        });
    }
  };
  
  if (loading || !appUser || stores.length === 0) {
      // Render a placeholder or null while loading or if no stores are available
      return (
         <Button
          variant="outline"
          role="combobox"
          aria-label="Select a store"
          className={cn('w-[200px] justify-between', className)}
          disabled
        >
          <Store className="mr-2 h-4 w-4" />
          Loading stores...
          <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
        </Button>
      );
  }

  // Hide switcher if there's only one store and the user isn't an admin
  // who might need to create more.
  if (stores.length <= 1 && appUser.role !== 'admin' && variant === 'desktop') {
      return null;
  }
  
  if (variant === "mobileSheet") {
    return (
       <div className={cn("w-full", className)}>
         <label className="text-xs text-white/80">Store</label>
         <select
           className="mt-2 w-full rounded-md bg-white text-black px-3 py-2"
           value={activeStore?.id ?? ""}
           onChange={(e) => {
             const id = e.target.value;
             if (!id) return;
             handleStoreSelect(id);
           }}
         >
           {stores.map(s => (
             <option key={s.id} value={s.id}>{s.name}</option>
           ))}
         </select>
       </div>
     );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Select a store"
          className={cn('w-[200px] justify-between', className)}
        >
          <Store className="mr-2 h-4 w-4" />
          {activeStore ? (activeStore.name || "(unnamed store)") : "Select a store"}
          <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
          className="w-[200px] p-0"
      >
        <Command>
          <CommandList>
            <CommandInput placeholder="Search store..." />
            <CommandEmpty>No store found.</CommandEmpty>
            <CommandGroup heading="Accessible Stores">
              {stores.map((store) => (
                <CommandItem
                  key={store.id}
                  value={store.id}
                  onSelect={(value) => handleStoreSelect(value)}
                  className="text-sm"
                >
                  <Store className="mr-2 h-4 w-4" />
                  {store.name || "(unnamed store)"}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

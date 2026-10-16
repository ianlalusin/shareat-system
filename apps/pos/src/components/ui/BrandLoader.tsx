
"use client";
import Image from "next/image";

export function BrandLoader() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-24 w-24">
        {/* spinning ring */}
        <div className="absolute inset-0 rounded-full border-4 border-muted border-t-primary animate-spin" />

        {/* logo */}
        <div className="absolute inset-2 flex items-center justify-center">
          <Image
            src="/logo.png"
            alt="SharEat Hub Logo"
            width={64}
            height={64}
            className="object-contain"
            priority
          />
        </div>
      </div>

      <div className="text-center">
        <div className="text-lg font-semibold">Loading...</div>
        <div className="text-sm text-muted-foreground mt-1">
          Please wait a moment.
        </div>
      </div>
    </div>
  );
}

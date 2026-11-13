"use client"

import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed right-0 top-0 z-[100] flex max-h-screen w-full max-w-[92vw] flex-col gap-2 p-4 sm:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 overflow-hidden border-2 p-4 pr-10 transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
  {
    variants: {
      variant: {
        // T-568: Ticket — flat brand yellow, ink border, hard offset shadow, dashed stub.
        default: "toast-ticket pl-10 text-sm",
        // T-568: Keycap — same yellow, black exclamation square, keycap action.
        destructive: "toast-keycap pl-14 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      // Ticket action: a cream pill with a real red arrow cell on the right edge.
      // T-568 (UI-002): the label may wrap and the pill may shrink to the toast, so a long label never starves the message; the arrow cell stays on the pill.
      "relative inline-flex min-h-9 min-w-0 max-w-full shrink items-center justify-center overflow-hidden whitespace-normal break-words rounded-full border-2 border-[#241f18] bg-[#fff7dd] py-1.5 pl-3 pr-11 text-left text-[10px] font-extrabold uppercase leading-4 tracking-[0.08em] text-[#241f18] transition-colors after:absolute after:inset-y-0 after:right-0 after:flex after:w-9 after:items-center after:justify-center after:border-l-2 after:border-[#241f18] after:bg-[#d40909] after:text-[12px] after:font-bold after:text-white after:content-['→'] hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#241f18] focus:ring-offset-2 focus:ring-offset-[#f5d76e] disabled:pointer-events-none disabled:opacity-50",
      // Keycap action: black, short travel, hard 3 px lip.
      "group-[.toast-keycap]:min-h-9 group-[.toast-keycap]:py-1.5 group-[.toast-keycap]:rounded-[8px] group-[.toast-keycap]:border-0 group-[.toast-keycap]:bg-[#241f18] group-[.toast-keycap]:px-3 group-[.toast-keycap]:pr-3 group-[.toast-keycap]:text-[#fff7dd] group-[.toast-keycap]:shadow-[0_3px_0_#000] group-[.toast-keycap]:hover:bg-black group-[.toast-keycap]:after:hidden",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 rounded-full p-1.5 text-[#241f18]/50 opacity-0 transition-opacity hover:bg-[#241f18]/10 hover:text-[#241f18] focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[#241f18] group-hover:opacity-100",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-[15px] font-extrabold leading-5", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-xs leading-5 text-[#443a2a]", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}

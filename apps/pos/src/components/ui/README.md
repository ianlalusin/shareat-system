# src/components/ui contract

## Overview

Reusable Radix/React presentation primitives, loader and compact calendar.

## Interface

- [BrandLoader.tsx](./BrandLoader.tsx) — `BrandLoader`.
- [CompactCalendar.tsx](./CompactCalendar.tsx) — `CompactCalendar`.
- [accordion.tsx](./accordion.tsx) — `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent`.
- [alert-dialog.tsx](./alert-dialog.tsx) — `AlertDialog`, `AlertDialogPortal`, `AlertDialogOverlay`, `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel`.
- [alert.tsx](./alert.tsx) — `Alert`, `AlertTitle`, `AlertDescription`.
- [avatar.tsx](./avatar.tsx) — `Avatar`, `AvatarImage`, `AvatarFallback`.
- [badge.tsx](./badge.tsx) — `BadgeProps`, `Badge`, `badgeVariants`.
- [button.tsx](./button.tsx) — `ButtonProps`, `Button`, `buttonVariants`.
- [card.tsx](./card.tsx) — `Card`, `CardHeader`, `CardFooter`, `CardTitle`, `CardDescription`, `CardContent`.
- [checkbox.tsx](./checkbox.tsx) — `Checkbox`.
- [command.tsx](./command.tsx) — `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator`.
- [dialog.tsx](./dialog.tsx) — `Dialog`, `DialogPortal`, `DialogOverlay`, `DialogClose`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`.
- [drawer.tsx](./drawer.tsx) — `Drawer`, `DrawerPortal`, `DrawerOverlay`, `DrawerTrigger`, `DrawerClose`, `DrawerContent`, `DrawerHeader`, `DrawerFooter`, `DrawerTitle`, `DrawerDescription`.
- [dropdown-menu.tsx](./dropdown-menu.tsx) — `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuGroup`, `DropdownMenuPortal`, `DropdownMenuSub`, `DropdownMenuSubContent`, `DropdownMenuSubTrigger` (additional exports in source).
- [input.tsx](./input.tsx) — `Input`.
- [label.tsx](./label.tsx) — `Label`.
- [radio-group.tsx](./radio-group.tsx) — `RadioGroup`, `RadioGroupItem`.

## Invariants

- Dialog/drawer/menu content is bounded to available height and scrolls internally.
- Forwarded props/refs and controlled Radix state preserve primitive behavior.

## Side Effects

- Renders DOM/portal content and invokes user callbacks; these wrappers do not themselves own business persistence.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 17 direct source files (49992 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `form.tsx`, `popover.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx`, `sheet.tsx`, `skeleton.tsx`, `switch.tsx`, `table.tsx`, `tabs.tsx`, `textarea.tsx`, `toast.tsx`, `toaster.tsx`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.

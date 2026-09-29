"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef, FC, ReactNode } from "react";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

export const DropdownMenuContent: FC<
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
> = ({ className, sideOffset = 6, ...props }) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-40 overflow-hidden rounded-2xl border border-[#e8eaed] bg-white p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] dark:border-[#3c4043] dark:bg-[#1e1f20] dark:shadow-[0_4px_16px_rgba(0,0,0,0.4)]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
);

export interface DropdownMenuItemProps
  extends ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  icon?: ReactNode;
}

export const DropdownMenuItem: FC<DropdownMenuItemProps> = ({
  icon,
  children,
  className,
  ...props
}) => (
  <DropdownMenuPrimitive.Item
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-3 py-2 text-[#444746] outline-none transition-colors",
      "hover:bg-[#f1f3f4] focus:bg-[#f1f3f4]",
      "dark:text-[#c4c7c5] dark:hover:bg-[#333537] dark:focus:bg-[#333537]",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    {icon && (
      <span className="flex shrink-0 items-center text-[#444746] dark:text-[#c4c7c5]">
        {icon}
      </span>
    )}
    {children}
  </DropdownMenuPrimitive.Item>
);

export const DropdownMenuSeparator: FC<
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
> = ({ className, ...props }) => (
  <DropdownMenuPrimitive.Separator
    className={cn(
      "my-1.5 h-px bg-[#e8eaed] dark:bg-[#3c4043]",
      className,
    )}
    {...props}
  />
);

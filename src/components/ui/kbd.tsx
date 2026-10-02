import { cn } from "@/lib/utils.ts";
import type { HTMLAttributes } from "react";

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  size?: "xs" | "sm" | "default";
}

export function Kbd({ className, children, size = "default", ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center font-medium rounded-md border border-zinc-700/80 bg-zinc-800/90 text-zinc-300 shadow-xs select-none transition-colors leading-none",
        size === "xs" && "px-1.5 py-0.5 text-[10px] min-w-4.5",
        size === "sm" && "px-1.5 py-1 text-[11px] min-w-5",
        size === "default" && "px-2 py-1 text-xs min-w-6",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

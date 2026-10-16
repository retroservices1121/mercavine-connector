import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-11 w-full rounded-xl border border-[var(--line)] bg-white px-3 text-sm outline-none focus:border-[var(--vine)]",
        className,
      )}
      {...props}
    />
  );
}

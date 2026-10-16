"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer size-4 shrink-0 rounded border border-[var(--line)] bg-white data-[state=checked]:bg-[var(--vine)] data-[state=checked]:text-white",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[10px]">✓</CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

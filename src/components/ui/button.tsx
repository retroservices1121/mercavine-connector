import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vine)]",
  {
    variants: {
      variant: {
        default: "bg-[var(--copper)] text-white hover:bg-[#9a4a22]",
        vine: "bg-[var(--vine)] text-[#f4efe4] hover:bg-[#163628]",
        outline: "border border-[var(--line)] bg-transparent hover:bg-white",
        ghost: "hover:bg-black/5",
        danger: "bg-transparent text-[var(--danger)] border border-[var(--danger)] hover:bg-[var(--danger)] hover:text-white",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-3 text-xs",
        lg: "h-12 px-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

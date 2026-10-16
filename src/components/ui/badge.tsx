import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-[var(--line)] bg-white px-2.5 py-0.5 text-xs tracking-wide",
        className,
      )}
      {...props}
    />
  );
}

import Link from "next/link";
import { config } from "@/lib/config";

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  const cfg = config();
  return (
    <header className="flex items-center justify-between gap-4 px-5 py-4 md:px-10">
      <Link href="/" className="display text-xl tracking-tight">
        {cfg.brandName}
      </Link>
      <nav className="flex items-center gap-4 text-sm text-[var(--muted)]">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        {signedIn ? <Link href="/sellers">Sellers</Link> : null}
        <Link href={signedIn ? "/account" : "/login"} className="text-[var(--ink)]">
          {signedIn ? "Account" : "Sign in"}
        </Link>
      </nav>
    </header>
  );
}

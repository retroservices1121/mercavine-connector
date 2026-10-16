import Image from "next/image";
import Link from "next/link";
import { config } from "@/lib/config";
import { buttonVariants } from "@/components/ui/button";

function UserIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  const cfg = config();
  return (
    <header className="border-b border-[var(--line)] bg-[var(--paper)]/95">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2" aria-label={`${cfg.brandName} home`}>
          <Image src="/logo.svg" alt="" width={32} height={32} className="rounded-lg" />
          <span className="display text-xl tracking-tight">{cfg.brandName}</span>
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--muted)]">
          <Link href="/#how-it-works" className="hidden sm:inline hover:text-[var(--ink)]">How it works</Link>
          <Link href="/sell" className="hidden sm:inline hover:text-[var(--ink)]">Sell</Link>
          <Link href="/#faq" className="hidden sm:inline hover:text-[var(--ink)]">FAQ</Link>
          {signedIn ? <Link href="/sellers" className="hover:text-[var(--ink)]">Sellers</Link> : null}
          {signedIn ? (
            <Link href="/account" aria-label="Your account" className={buttonVariants({ variant: "outline", className: "h-9 px-4 text-[var(--ink)]" })}>
              <UserIcon />
              <span>Account</span>
            </Link>
          ) : (
            <Link href="/login" className="text-[var(--ink)]">Sign in</Link>
          )}
          {!signedIn && (
            <Link href="/signup" className="rounded-full bg-[var(--vine)] px-4 py-2 text-[#f4efe4] hover:opacity-90">
              Sign up
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

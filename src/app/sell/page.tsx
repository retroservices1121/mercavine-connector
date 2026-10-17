import Link from "next/link";
import { cookies } from "next/headers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { sellerUserFromSessionToken } from "@/lib/auth";
import { categoryLabels } from "@/lib/catalog";
import { SELLER_FEE_COPY, sellerForUser, US_STATES } from "@/lib/sellers";
import { SellerSignupForm } from "./seller-signup-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sell on Mercavine" };

const perks = [
  ["Get found by AI shoppers", "People ask Grok to shop for them. Your products show up when they ask."],
  ["List once", "Add your products one time. We keep them ready for every shopper's assistant."],
  ["Get paid by Stripe", "Money goes straight to your own Stripe account, on Stripe's normal payout schedule."],
  ["Ship your way", "Ship orders yourself, or connect Amazon to ship from stock you already keep there."],
];

export default async function SellPage() {
  const jar = await cookies();
  const user = sellerUserFromSessionToken(jar.get("mv_session")?.value);
  const existing = user ? sellerForUser(user.id) : undefined;
  return (
    <>
      <SiteHeader signedIn={Boolean(user)} />
      <main className="mx-auto grid max-w-6xl gap-10 px-5 py-12 md:grid-cols-[1fr_1fr] md:px-10">
        <section>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--copper)]">Sell on Mercavine</p>
          <h1 className="mt-3 text-5xl leading-[1.05]">More sales from AI shoppers.</h1>
          <p className="mt-4 text-lg text-[var(--muted)]">{SELLER_FEE_COPY}</p>
          <ul className="mt-8 space-y-4">
            {perks.map(([title, copy]) => (
              <li key={title} className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
                <h2 className="display text-xl">{title}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">{copy}</p>
              </li>
            ))}
          </ul>
          <h2 className="mt-8 text-2xl">How it works</h2>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[var(--muted)]">
            <li>Create your seller account.</li>
            <li>Set up payouts with Stripe.</li>
            <li>Add your products. They go live once Stripe says you&apos;re ready to accept payments.</li>
          </ol>
        </section>
        <section aria-labelledby="signup-title" className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 md:self-start">
          {existing ? (
            <>
              <h2 id="signup-title" className="text-3xl">You&apos;re already a seller</h2>
              <p className="mt-2 text-[var(--muted)]">Pick up where you left off.</p>
              <Link href="/seller" className="mt-5 inline-flex h-11 items-center rounded-full bg-[var(--vine)] px-6 text-[#f4efe4]">Go to your seller dashboard</Link>
            </>
          ) : (
            <>
              <h2 id="signup-title" className="text-3xl">Create your seller account</h2>
              <p className="mt-1 mb-5 text-sm text-[var(--muted)]">
                Takes about two minutes. Seller accounts are separate from shopping accounts and need their own email. Already a seller? <Link href="/login?next=/seller" className="underline">Sign in</Link>.
              </p>
              <SellerSignupForm
                signedInEmail={null}
                categories={categoryLabels().map(({ slug, label }) => ({ slug, label }))}
                states={US_STATES}
              />
            </>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

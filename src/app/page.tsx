import Link from "next/link";
import { SiteFooter, SUPPORT_EMAIL } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";
import { featuredItems } from "@/lib/featured";
import { formatUsd } from "@/lib/money";

export const dynamic = "force-dynamic";

const steps = [
  ["Ask Grok", "Tell Grok what you need, like “a cordless drill under $150.” It finds options from Mercavine sellers."],
  ["Review your cart", "Grok puts together a cart with real prices and stock. Nothing is bought yet."],
  ["Approve and pay", "Open one secure checkout, check the details, and pay. Grok keeps you posted on delivery."],
];

const sellerBenefits = [
  ["Reach AI shoppers", "Shoppers ask their AI assistants to buy for them. List once and your products show up when they ask."],
  ["A simple 3% fee, only when you sell", "No monthly plan and no listing fees. Stripe's processing fees apply."],
  ["Paid straight to you", "Payments go through Stripe directly to your account. You stay the seller, with your own customers."],
  ["Ship your way", "Ship it yourself, or let Amazon fulfill orders you already stock there."],
];

const trust = [
  ["Secure checkout", "Payments run through Stripe, and Shop Pay is supported. Your bot never sees your card."],
  ["You approve every purchase", "Your bot can shop and build a cart, but nothing is charged until you say yes."],
  ["Spending limits", "Set a per-order and monthly limit for your bot, and disconnect it anytime."],
];

const faqs = [
  ["Do I need Grok to shop?", "Mercavine is built for shopping through Grok. Create a free account, connect your bot from your account page, then just ask."],
  ["Can my bot buy something without me?", "No. Every purchase waits for your approval on a secure checkout page, and your spending limits always apply."],
  ["Does it cost shoppers anything?", "No. Shoppers pay only for what they buy. There are no extra fees."],
  ["What does it cost to sell?", "A simple 3% fee, only when you sell. Nothing up front."],
  ["What can I buy?", "We're starting with home improvement, tools and electronics accessories, plus camping and outdoor gear."],
  ["How do I get help?", `Email us at ${SUPPORT_EMAIL}. We read every message.`],
];

const categoryIcon: Record<string, string> = {
  "home-improvement": "🏠",
  tools: "🛠️",
  "electronics-accessories": "🔌",
  outdoor: "⛺",
  "camping-outdoor": "⛺",
};

const cta = "inline-flex h-12 items-center justify-center rounded-full px-6 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export default function HomePage() {
  const cfg = config();
  const featured = featuredItems();
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-6xl px-5 pb-14 pt-12 md:px-10 md:pt-20">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--copper)]">The marketplace for AI shopping</p>
          <h1 className="mt-3 max-w-3xl text-5xl leading-[1.05] md:text-7xl">Just ask Grok. We&apos;ll handle the checkout.</h1>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
              <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">For shoppers</p>
              <h2 className="mt-2 text-3xl">Just ask Grok</h2>
              <p className="mt-2 text-[var(--muted)]">Say what you&apos;re looking for. Grok finds it, builds your cart, and you approve one secure checkout.</p>
              <Link href="/signup" className={`${cta} mt-5 bg-[var(--vine)] text-[#f4efe4] focus-visible:outline-[var(--vine)]`}>Sign up as a shopper</Link>
            </div>
            <div className="rounded-3xl bg-[var(--vine)] p-6 text-[#f4efe4]">
              <p className="text-xs uppercase tracking-[0.16em] text-[#d7e7d4]">For sellers</p>
              <h2 className="mt-2 text-3xl">More sales from AI shoppers</h2>
              <p className="mt-2 text-[#d7e7d4]">List once and get found by shoppers whose assistants are ready to buy. A simple 3% fee, only when you sell.</p>
              <Link href="/sell" className={`${cta} mt-5 bg-[#f4efe4] text-[var(--vine)] focus-visible:outline-[#f4efe4]`}>Sell on {cfg.brandName}</Link>
            </div>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="how-title" className="bg-[var(--card)] py-14">
          <div className="mx-auto max-w-6xl px-5 md:px-10">
            <h2 id="how-title" className="text-4xl">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {steps.map(([title, copy], index) => (
                <li key={title} className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-6">
                  <span aria-hidden className="display flex h-10 w-10 items-center justify-center rounded-full bg-[var(--vine)] text-lg text-[#f4efe4]">{index + 1}</span>
                  <h3 className="display mt-4 text-2xl">{title}</h3>
                  <p className="mt-2 text-[var(--muted)]">{copy}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {featured.length > 0 && (
        <section aria-labelledby="featured-title" className="mx-auto max-w-6xl px-5 py-14 md:px-10">
          <h2 id="featured-title" className="text-4xl">Featured products</h2>
          <p className="mt-2 text-[var(--muted)]">A taste of what you can ask Grok for today.</p>
          <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((item) => (
              <li key={item.kind === "listing" ? item.offer.offer_id : item.product.id} className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--card)]">
                <div aria-hidden className="flex aspect-[4/3] items-center justify-center bg-gradient-to-br from-[#dfe9dc] to-[#c7d9c3]">
                  <span className="text-6xl">{categoryIcon[item.product.category] ?? "🛍️"}</span>
                </div>
                <div className="p-5">
                  <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{item.product.category.replaceAll("-", " ")}</p>
                  <h3 className="mt-1 font-medium">{item.product.title}</h3>
                  {item.kind === "listing" ? (
                    <p className="mt-2 flex items-center justify-between text-sm">
                      <span className="text-[var(--muted)]">{item.offer.seller.name}</span>
                      <span className="text-lg font-medium">{formatUsd(item.offer.price.amount)}</span>
                    </p>
                  ) : (
                    <>
                      <ul className="mt-2 list-disc pl-5 text-sm text-[var(--muted)]">
                        {item.product.specs.map((spec) => <li key={spec}>{spec}</li>)}
                      </ul>
                      <p className="mt-3 flex items-center justify-between text-sm">
                        <a className="text-[var(--muted)] underline" href={item.product.sourceUrl} rel="noopener noreferrer" target="_blank">
                          {item.product.brand} model {item.product.model}
                        </a>
                        <span className="text-right">
                          <span className="block text-lg font-medium">{formatUsd(item.product.listPriceCents)}</span>
                          <span className="block text-xs text-[var(--muted)]">Manufacturer list price</span>
                        </span>
                      </p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
        )}

        <section id="sellers" aria-labelledby="sellers-title" className="bg-[var(--vine)] py-14 text-[#f4efe4]">
          <div className="mx-auto max-w-6xl px-5 md:px-10">
            <h2 id="sellers-title" className="text-4xl">Sell where shoppers are asking</h2>
            <p className="mt-2 max-w-2xl text-[#d7e7d4]">More and more people let an AI assistant do the shopping. {cfg.brandName} puts your products in front of them.</p>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {sellerBenefits.map(([title, copy]) => (
                <li key={title} className="rounded-3xl bg-white/5 p-6 ring-1 ring-white/10">
                  <h3 className="display text-xl">{title}</h3>
                  <p className="mt-2 text-sm text-[#d7e7d4]">{copy}</p>
                </li>
              ))}
            </ul>
            <Link href="/sell" className={`${cta} mt-8 bg-[#f4efe4] text-[var(--vine)] focus-visible:outline-[#f4efe4]`}>
              Start selling
            </Link>
          </div>
        </section>

        <section aria-labelledby="trust-title" className="mx-auto max-w-6xl px-5 py-14 md:px-10">
          <h2 id="trust-title" className="text-4xl">Safe by design</h2>
          <ul className="mt-8 grid gap-5 md:grid-cols-3">
            {trust.map(([title, copy]) => (
              <li key={title} className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
                <h3 className="display text-2xl">{title}</h3>
                <p className="mt-2 text-[var(--muted)]">{copy}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="faq" aria-labelledby="faq-title" className="mx-auto max-w-3xl px-5 py-6 md:px-10">
          <h2 id="faq-title" className="text-4xl">Questions</h2>
          <div className="mt-6 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {faqs.map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="cursor-pointer list-none text-lg font-medium marker:hidden">
                  {q} <span aria-hidden className="float-right text-[var(--muted)] group-open:rotate-45">+</span>
                </summary>
                <p className="mt-2 text-[var(--muted)]">{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section id="about" aria-labelledby="about-title" className="mx-auto max-w-3xl px-5 py-14 text-center md:px-10">
          <h2 id="about-title" className="text-4xl">About {cfg.brandName}</h2>
          <p className="mt-3 text-[var(--muted)]">
            {cfg.brandName} is a marketplace built for shopping with AI. Shoppers get a faster way to buy, with full control over every purchase.
            Sellers get a new way to be found.
          </p>
          <Link href="/signup" className={`${cta} mt-6 bg-[var(--vine)] text-[#f4efe4] focus-visible:outline-[var(--vine)]`}>Create your free account</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

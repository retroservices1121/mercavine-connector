import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { categoryLabels, searchNative } from "@/lib/catalog";
import { config } from "@/lib/config";
import { feePercentLabel, formatUsd } from "@/lib/money";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const cfg = config();
  const fee = feePercentLabel(cfg.platformFeeBps);
  const sample = searchNative({ limit: 4, inStock: true });
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto grid max-w-5xl gap-10 px-5 pb-16 pt-8 md:grid-cols-[1.2fr_0.8fr] md:px-10">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Bot-first marketplace</p>
          <h1 className="mt-3 text-5xl leading-[1.05] md:text-6xl">Buy from sellers who expect your bot.</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--muted)]">
            {cfg.brandName} lets a shopper&apos;s agent search, compare, and build a cart. The human opens one approval link and pays.
            Each seller is charged on their own Stripe account. {cfg.brandName} takes a {fee} fee from that charge and never holds the sale.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="inline-flex h-12 items-center rounded-full bg-[var(--vine)] px-6 text-[#f4efe4]">
              Sign in to review a purchase
            </Link>
            <a href="/api/health" className="inline-flex h-12 items-center rounded-full border border-[var(--line)] px-6">
              API health
            </a>
          </div>
        </div>
        <ol className="space-y-4 rounded-3xl bg-[var(--vine)] p-6 text-[#f4efe4]">
          {[
            ["Search", "The bot calls search_products. It never sees a card."],
            ["Cart", "create_cart keeps price and stock on the server."],
            ["Approval", "request_checkout returns one short-lived link. You pay. The bot polls get_order_status."],
          ].map(([title, copy], index) => (
            <li key={title}>
              <p className="text-xs uppercase tracking-[0.16em] text-[#d7e7d4]">0{index + 1}</p>
              <p className="display mt-1 text-2xl">{title}</p>
              <p className="mt-1 text-sm text-[#d7e7d4]">{copy}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="mx-auto max-w-5xl px-5 pb-16 md:px-10">
        <h2 className="text-3xl">Launch categories</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {categoryLabels().map((category) => (
            <Badge key={category.slug}>{category.secondary ? `${category.label} · secondary` : category.label}</Badge>
          ))}
        </div>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {sample.flatMap((product) =>
            product.offers.slice(0, 1).map((offer) => (
              <li key={offer.offer_id} className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{product.category.replaceAll("-", " ")}</p>
                <p className="mt-1 font-medium">{product.title}</p>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  {offer.seller.name} · {formatUsd(offer.price.amount)}
                </p>
              </li>
            )),
          )}
        </ul>
        <p className="mt-6 max-w-2xl text-sm text-[var(--muted)]">
          The connector is free. Sellers pay the {fee} platform fee via Stripe <code>application_fee_amount</code> before their payout.
          A $100.00 charge carries a $3.00 fee at the default rate. Shop Pay orders are paid on the merchant&apos;s checkout and do not carry that fee.
          Contact {cfg.contactName}, {cfg.contactRole}, {cfg.contactEmail}.
          The {cfg.brandDomain} domain is intended and not yet purchased.
        </p>
      </section>
    </main>
  );
}

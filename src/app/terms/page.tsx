import { SiteFooter, SUPPORT_EMAIL } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";

export const metadata = { title: "Terms" };

export default function TermsPage() {
  const cfg = config();
  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 leading-relaxed">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Draft terms · not legal advice</p>
          <h1 className="text-4xl">Terms of Service</h1>
          <p>
            These draft terms cover {cfg.brandLegalName}. Shoppers don&apos;t pay anything to use {cfg.brandName}; you pay only for what you buy.
          </p>
          <h2 className="text-2xl">Who sells</h2>
          <p>
            Each seller on {cfg.brandName} is the seller of record for their products. Payments go through Stripe directly to the seller.
            Sellers pay a simple 3% fee, only when they sell. For example, on a $100.00 sale the fee is $3.00. It is never added to the shopper&apos;s total.
            Refunds and chargebacks are handled by the seller.
          </p>
          <h2 className="text-2xl">Your bot and your approval</h2>
          <p>
            A bot you connect can shop and build a cart only for you. Only you can approve a purchase, by signing in and confirming at checkout.
            Your bot never receives your card or billing details. You are responsible for purchases you approve and for any automatic approval rules you set.
          </p>
          <h2 className="text-2xl">What we don&apos;t sell</h2>
          <p>Firearms, hazardous materials, and other regulated goods aren&apos;t allowed. We&apos;re starting with home improvement, tools, and electronics accessories, plus camping and outdoor gear.</p>
          <h2 className="text-2xl">Digital downloads</h2>
          <p>
            Digital items are delivered by a private download link emailed after payment. Each link expires after 72 hours and works a limited number of times.
            Because a file can&apos;t be given back, digital items can&apos;t be returned once downloaded. Before the first download you can ask the seller to cancel.
            If an order is refunded or disputed, its download link stops working.
          </p>
          <h2 className="text-2xl">Shopify and Shop Pay</h2>
          <p>
            Some products come from Shopify stores and are paid on that store&apos;s own checkout. When you pay with Shop Pay, you approve each purchase in Shop Pay and your card details are not stored by {cfg.brandName}.
            These purchases don&apos;t carry the {cfg.brandName} seller fee.
          </p>
          <h2 className="text-2xl">Contact</h2>
          <p>{cfg.brandName}, <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Website: https://{cfg.brandDomain}.</p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

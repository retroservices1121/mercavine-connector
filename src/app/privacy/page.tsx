import { SiteFooter, SUPPORT_EMAIL } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  const cfg = config();
  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 leading-relaxed">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Draft privacy notice</p>
          <h1 className="text-4xl">Privacy Policy</h1>
          <p>
            {cfg.brandName} keeps only what it needs to run your orders: your account, saved addresses, your bot&apos;s permissions and limits, carts, orders, and a record of activity for security.
          </p>
          <h2 className="text-2xl">Your payment details</h2>
          <p>
            Card details are entered with our payment partner, Stripe, or with Shop Pay. {cfg.brandName} does not store your card, and your bot never sees it.
            If a seller ships through Amazon, we keep only what&apos;s needed to send that order. We don&apos;t place orders on amazon.com.
          </p>
          <h2 className="text-2xl">What your bot can see</h2>
          <p>Products, your cart, and your order status, including the city and region you&apos;re shipping to. Not your street address and not your card.</p>
          <h2 className="text-2xl">What we don&apos;t do</h2>
          <p>We don&apos;t sell your personal information, and shoppers never pay to use {cfg.brandName}.</p>
          <h2 className="text-2xl">How long we keep things</h2>
          <p>Order records are kept for tax and dispute purposes. You can disconnect your bot from your account page at any time, which also cancels its open carts.</p>
          <h2 className="text-2xl">Contact</h2>
          <p>{cfg.brandName}, <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

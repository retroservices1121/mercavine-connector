import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";

export default function PrivacyPage() {
  const cfg = config();
  return (
    <main>
      <SiteHeader />
      <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 text-sm leading-relaxed">
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Draft privacy notice</p>
        <h1 className="text-4xl">Privacy Policy</h1>
        <p>
          {cfg.brandLegalName} stores the account, saved addresses, bot scopes, carts, orders, and an audit log needed to run checkout.
          Card data for Mercavine sellers is entered in Stripe and is not stored by {cfg.brandName} or sent to the shopper&apos;s bot.
          Shop Pay card data stays with Shop. A single-use credential, when one is issued, is held in memory for that merchant checkout and is not written to the database, logs, or bot payloads.
          If a seller connects Amazon Multi-Channel Fulfillment, the Login with Amazon refresh token is stored for that seller and is not returned to the shopper&apos;s bot. {cfg.brandName} does not place orders on amazon.com.
          Contact {cfg.contactName}, {cfg.contactRole}, {cfg.contactEmail}. There is no public website URL yet.
        </p>
        <h2 className="text-2xl">What a bot can see</h2>
        <p>Product, cart, and order status, including city and region for a saved address. Not the street address, not a card brand, not a last four, and not Stripe ids.</p>
        <h2 className="text-2xl">What we don&apos;t do</h2>
        <p>We do not sell personal information. We do not charge for connector access. Webhook payloads are thin and signed. Approval links store only a hash of the token.</p>
        <h2 className="text-2xl">Retention</h2>
        <p>Order records stay for tax and dispute evidence. Bot tokens can be revoked from the account page, which cancels that bot&apos;s open carts.</p>
      </article>
    </main>
  );
}

import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";
import { feePercentLabel } from "@/lib/money";

export default function TermsPage() {
  const cfg = config();
  const fee = feePercentLabel(cfg.platformFeeBps);
  return (
    <main>
      <SiteHeader />
      <article className="mx-auto max-w-2xl space-y-4 px-5 py-10 text-sm leading-relaxed">
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Draft terms · not legal advice</p>
        <h1 className="text-4xl">Terms of Service</h1>
        <p>
          These draft terms cover {cfg.brandLegalName}. The connector is free. {cfg.brandName} does not charge shoppers or bot platforms for access.
          Contact {cfg.contactName}, {cfg.contactRole}, at {cfg.contactEmail}. Website: https://{cfg.brandDomain}.
        </p>
        <h2 className="text-2xl">Who sells</h2>
        <p>
          Each onboarded seller is the merchant of record. Charges are Stripe Connect direct charges on that seller&apos;s connected account.
          {cfg.brandName} adds <code>application_fee_amount</code> equal to {fee} of each seller&apos;s charge (default <code>PLATFORM_FEE_BPS=300</code>).
          On a $100.00 charge the fee is $3.00. The fee is taken before the seller&apos;s payout and is not added to the shopper&apos;s total.
          {cfg.brandName} does not hold sale funds. Refunds and chargebacks come from the seller&apos;s Stripe balance.
        </p>
        <h2 className="text-2xl">Bots and approval</h2>
        <p>
          A bot may search and build a cart only for the human who connected it. Only that human can approve a charge, by signing in and confirming on the approval page.
          The bot never receives card numbers, CVC, billing details, or Stripe identifiers. The human is responsible for orders they approve or that an auto-approve rule they created allows.
        </p>
        <h2 className="text-2xl">What we don&apos;t sell at launch</h2>
        <p>Firearms, hazardous materials, and other regulated goods are out of scope. Launch categories are home improvement, tools, and electronics accessories, with camping and outdoor as a secondary lane.</p>
        <h2 className="text-2xl">Shopify listings</h2>
        <p>Products discovered through Shopify Catalog are paid on the merchant&apos;s own checkout unless Shopify grants in-bot checkout. Those orders are not {cfg.brandName} direct charges and do not carry this platform fee.</p>
        <h2 className="text-2xl">Shop Pay</h2>
        <p>
          When Shop Pay is enabled, the shopper links a Shop Pay account and approves each purchase in Shop Pay.
          {cfg.brandName} receives a single-use payment credential only long enough to complete the merchant&apos;s normal checkout, then discards it.
          Card numbers are not stored. Shop Pay orders are not Stripe charges, so the {fee} platform fee does not apply.
        </p>
      </article>
    </main>
  );
}

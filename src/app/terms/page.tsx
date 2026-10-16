import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { termsPlaceholder } from "@/lib/terms-placeholders";

export const metadata = { title: "Terms and Conditions" };

/** Highlighted, unconfirmed legal/business fact. ids live in src/lib/terms-placeholders.ts. */
function Ph({ id }: { id: string }) {
  const p = termsPlaceholder(id);
  return (
    <mark data-placeholder={p.id} title={p.note || p.label} className="rounded bg-yellow-200 px-1 font-medium text-[var(--ink)]">
      [[PLACEHOLDER: {p.label}]]
    </mark>
  );
}

const sections: [string, string][] = [
  ["acceptance", "Acceptance of these terms"],
  ["who-we-are", "Who we are"],
  ["definitions", "Definitions"],
  ["accounts", "Accounts and eligibility"],
  ["shopper-terms", "Shopper terms"],
  ["bots", "AI agents and bots acting for you"],
  ["seller-terms", "Seller terms"],
  ["payments", "Payments"],
  ["orders", "Orders, pricing errors and cancellations"],
  ["shipping", "Shipping"],
  ["returns", "Returns and refunds"],
  ["conduct", "Prohibited conduct"],
  ["ip", "Intellectual property and content license"],
  ["third-party", "Third-party services"],
  ["fraud", "Fraud prevention and suspension"],
  ["termination", "Termination"],
  ["disclaimers", "Disclaimers"],
  ["liability", "Limitation of liability"],
  ["indemnification", "Indemnification"],
  ["disputes", "Dispute resolution"],
  ["governing-law", "Governing law"],
  ["changes", "Changes to these terms"],
  ["notices", "Notices"],
  ["misc", "Miscellaneous"],
  ["contact", "Contact"],
];

function Section({ id, summary, children }: { id: string; summary: string; children: React.ReactNode }) {
  const index = sections.findIndex(([key]) => key === id);
  const title = sections[index][1];
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6 md:p-8">
      <h2 id={`${id}-title`} className="text-2xl md:text-3xl">
        <span className="text-[var(--copper)]">{index + 1}.</span> {title}
      </h2>
      <p className="mt-3 rounded-2xl bg-[var(--paper)] px-4 py-3 text-sm">
        <span className="font-medium text-[var(--vine)]">In plain terms: </span>
        {summary}
      </p>
      <div className="mt-4 space-y-3 leading-relaxed text-[var(--ink)]/90">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="bg-[var(--vine)] text-[#f4efe4]">
          <div className="mx-auto max-w-6xl px-5 py-12 md:px-10">
            <p className="text-xs uppercase tracking-[0.18em] text-[#d7e7d4]">Legal</p>
            <h1 className="mt-2 text-5xl leading-[1.05] md:text-6xl">Terms and Conditions</h1>
            <p className="mt-4 max-w-2xl text-[#d7e7d4]">
              The rules for shopping and selling on Mercavine, including when an AI assistant shops for you.
            </p>
            <p className="mt-4 text-sm text-[#d7e7d4]">
              Effective: <Ph id="effective_date" /> · Last updated: <Ph id="last_updated" />
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-5 pt-8 md:px-10">
          <div role="note" className="rounded-3xl border-2 border-[var(--copper)] bg-[#fbeee3] p-5">
            <p className="display text-xl text-[var(--copper)]">Draft, pending legal review</p>
            <p className="mt-1 text-sm">
              These terms are a working draft and are not yet final. Items marked <mark className="rounded bg-yellow-200 px-1">[[PLACEHOLDER: …]]</mark> still
              need to be confirmed. Nothing here is legal advice.
            </p>
          </div>
        </div>

        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-8 md:grid-cols-[240px_1fr] md:px-10">
          <nav aria-label="Table of contents" className="md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:self-start md:overflow-y-auto">
            <details open className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5 md:open:block">
              <summary className="cursor-pointer font-medium">On this page</summary>
              <ol className="mt-3 space-y-1.5 text-sm text-[var(--muted)]">
                {sections.map(([id, title], i) => (
                  <li key={id}>
                    <a href={`#${id}`} className="hover:text-[var(--vine)] hover:underline">{i + 1}. {title}</a>
                  </li>
                ))}
              </ol>
            </details>
          </nav>

          <div className="space-y-6">
            <Section id="acceptance" summary="By using Mercavine, you agree to these terms. If you don't agree, please don't use it.">
              <p>These Terms and Conditions (the &ldquo;Terms&rdquo;) govern your use of the Mercavine website, accounts, seller tools, and the connections that let AI assistants shop on Mercavine (together, the &ldquo;Service&rdquo;). By creating an account, connecting a bot, listing products, or placing an order, you accept these Terms and our <a href="/privacy" className="underline">Privacy Policy</a>.</p>
              <p>If you use the Service for a business, you confirm you have authority to accept these Terms for that business.</p>
            </Section>

            <Section id="who-we-are" summary="Mercavine is a marketplace. Sellers sell their own products; Mercavine connects them with shoppers and their AI assistants.">
              <p>The Service is operated by <Ph id="entity_name" />, a <Ph id="entity_type" /> formed in <Ph id="formation_state" />, with its registered address at <Ph id="registered_address" /> (&ldquo;Mercavine,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;).</p>
              <p>Mercavine is a marketplace. Each seller is the seller of record for the products they list. Unless we say otherwise for a specific product, Mercavine does not own, inspect, store, or ship the products sold on the Service.</p>
            </Section>

            <Section id="definitions" summary="A few words we use throughout, explained once.">
              <ul className="list-disc space-y-1 pl-5">
                <li><strong>Shopper</strong>: a person who buys, or approves purchases, on Mercavine.</li>
                <li><strong>Seller</strong>: a business or person that lists products for sale on Mercavine.</li>
                <li><strong>Bot</strong> or <strong>AI agent</strong>: software, such as Grok, that you connect to your account to search, build carts, and request checkout for you.</li>
                <li><strong>Order</strong>: a purchase you approve at checkout.</li>
                <li><strong>Platform fee</strong>: the fee Mercavine charges sellers on completed sales.</li>
              </ul>
            </Section>

            <Section id="accounts" summary="You need an account to buy or sell. Keep it accurate and secure, and you must meet the minimum age.">
              <p>You must be at least <Ph id="minimum_age" /> to create an account. The Service is offered in <Ph id="eligible_regions" />.</p>
              <p>You agree to give accurate information, keep your password private, and tell us promptly if you think your account has been used without permission. You are responsible for activity on your account.</p>
              <p>You can stop using the Service at any time. To delete your account: <Ph id="account_deletion" />.</p>
            </Section>

            <Section id="shopper-terms" summary="You decide what to buy. Nothing is charged until you approve it at checkout.">
              <p>Product information, prices, and stock come from sellers. Before you approve an order, review the items, price, shipping, and taxes shown at checkout. By approving, you make an offer to buy from the seller on those terms.</p>
              <p>You agree to use what you buy lawfully and not to resell it in violation of a seller&apos;s stated restrictions.</p>
            </Section>

            <Section id="bots" summary="If you connect an AI assistant, it acts for you, within the permissions and limits you set. You approve purchases and can disconnect it anytime.">
              <p>You may connect a bot to your account from your account page. When you do, you choose what it may do (for example, search, build carts, or check order status) and set spending limits.</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><strong>You are responsible for your bot.</strong> Actions a connected bot takes within the permissions you granted are treated as your actions.</li>
                <li><strong>You approve purchases.</strong> A bot can prepare a cart, but an order is placed only when you approve it at checkout, or under an automatic-approval rule you set yourself.</li>
                <li><strong>Spending limits.</strong> Limits you set (per order and per month) are enforced by the Service. They are a safeguard, not a guarantee against every mistake your bot makes.</li>
                <li><strong>Revoking access.</strong> You can disconnect a bot at any time from your account page. This stops its access and cancels its open carts. Keep your bot&apos;s access credentials secret; treat them like a password.</li>
                <li>Bots never receive your card details.</li>
              </ul>
            </Section>

            <Section id="seller-terms" summary="List honest products you're allowed to sell. Mercavine takes a simple 3% fee, only when you sell, and Stripe's processing fees apply. You handle shipping, taxes, and returns.">
              <p><strong>Eligibility.</strong> <Ph id="seller_eligibility" /></p>
              <p><strong>Listings.</strong> Listings must be accurate, including title, description, price, stock, and images, and you must have the right to sell what you list. Keep stock and prices up to date.</p>
              <p><strong>Prohibited items.</strong> You may not list illegal items or regulated goods, including firearms and hazardous materials. Full list: <Ph id="prohibited_items" />.</p>
              <p><strong>Fees.</strong> Mercavine takes a simple 3% fee, only when you sell. The fee is taken from each completed sale charged through Mercavine, before your payout, and is not added to the shopper&apos;s total. Stripe&apos;s processing fees apply separately. We will give <Ph id="fee_change_notice" /> before changing our fee.</p>
              <p><strong>Stripe.</strong> Payments are processed by Stripe through a Stripe connected account in your name. By selling on Mercavine you agree to the <a href="https://stripe.com/connect-account/legal" className="underline">Stripe Connected Account Agreement</a>, which includes the Stripe Services Agreement. You must complete Stripe&apos;s verification before your listings are shown to shoppers.</p>
              <p><strong>Payouts.</strong> <Ph id="payout_timing" /></p>
              <p><strong>Taxes.</strong> <Ph id="tax_responsibility" /></p>
              <p><strong>Fulfillment.</strong> You are responsible for shipping orders promptly and as described: <Ph id="seller_fulfillment_sla" />. If you connect Amazon Multi-Channel Fulfillment, eligible orders may ship from your Amazon inventory; your agreements with Amazon also apply.</p>
              <p><strong>Returns and refunds.</strong> You must honor the return policy shown on your listings and the returns section below.</p>
            </Section>

            <Section id="payments" summary="Payments run through Stripe, and Shop Pay is supported for some stores. Mercavine doesn't store your card.">
              <p>Card payments for Mercavine sellers are processed by Stripe. Some products from Shopify stores may be paid with Shop Pay, where you approve the purchase in Shop Pay and that store&apos;s checkout applies. Mercavine does not store your full card details.</p>
              <p>If a payment fails or is reversed, the order may be cancelled. Chargebacks and payment disputes: <Ph id="chargeback_handling" />.</p>
            </Section>

            <Section id="orders" summary="Prices and stock can change until you approve. Obvious pricing errors may be cancelled, and you'll be told.">
              <p>Prices and stock are held for a limited time once a cart is ready for checkout. After that, they may change.</p>
              <p><strong>Pricing errors.</strong> <Ph id="pricing_error_policy" /></p>
              <p><strong>Cancellations.</strong> You may cancel an order within <Ph id="cancellation_window" />, if it hasn&apos;t shipped. A seller may cancel an order it can&apos;t fulfill; you will be refunded for any amount charged.</p>
            </Section>

            <Section id="shipping" summary="Sellers ship your order. Estimated delivery dates are estimates.">
              <p>Shipping costs and estimated delivery dates are shown at checkout. Estimates are not guarantees. We ship to: <Ph id="shipping_regions" />.</p>
              <p>Lost or damaged packages: <Ph id="lost_package_policy" />.</p>
            </Section>

            <Section id="returns" summary="Each listing shows its return policy. Here's how returns and refunds work across Mercavine.">
              <p>Unless a listing says otherwise, you may request a return within <Ph id="refund_window" />. Return shipping is paid by: <Ph id="return_shipping_payer" />.</p>
              <p>Who is responsible for refunds: <Ph id="marketplace_refund_policy" />.</p>
              <p>Approved refunds go back to the original payment method.</p>
            </Section>

            <Section id="conduct" summary="Don't misuse Mercavine, other people's accounts, or our systems.">
              <ul className="list-disc space-y-1 pl-5">
                <li>No fraud, fake orders, fake reviews, or misleading listings.</li>
                <li>No accessing accounts, bots, or data that aren&apos;t yours.</li>
                <li>No scraping, overloading, probing, or interfering with the Service, except through the connections we provide and within their limits.</li>
                <li>No using the Service to break the law or anyone else&apos;s rights.</li>
              </ul>
            </Section>

            <Section id="ip" summary="Mercavine's brand and software are ours. Sellers keep their content but let us show it to shoppers and their bots.">
              <p>The Mercavine name, logo, and Service are owned by Mercavine. You may not use them without permission, except to describe the Service accurately.</p>
              <p>Sellers keep ownership of their listing content and grant Mercavine a non-exclusive, worldwide, royalty-free license to host, display, adapt for display, and share it with shoppers and their connected bots to operate and promote the Service.</p>
              <p>To report content that infringes your rights, contact our designated agent: <Ph id="dmca_agent" />.</p>
            </Section>

            <Section id="third-party" summary="Some parts of Mercavine rely on other companies, and their terms apply too.">
              <p>The Service works with third parties such as Stripe, Shopify and Shop Pay, Amazon, email providers, and AI assistants such as Grok. Their services are governed by their own terms and privacy policies, and Mercavine is not responsible for them.</p>
            </Section>

            <Section id="fraud" summary="We may pause accounts, bots, listings, or orders to stop fraud or abuse.">
              <p>We may review, hold, or cancel orders, limit or suspend accounts, bots, or listings, or pause payouts as allowed by Stripe&apos;s terms, when we reasonably suspect fraud, abuse, or a breach of these Terms.</p>
              <p>Notice and appeal: <Ph id="suspension_process" /></p>
            </Section>

            <Section id="termination" summary="You can leave anytime. We can end access for breaches, or with notice otherwise.">
              <p>You may stop using the Service and close your account at any time. We may suspend or end your access immediately for serious breaches of these Terms, or otherwise with <Ph id="termination_notice" />.</p>
              <p>Sections that by their nature should survive (such as fees owed, disclaimers, limitation of liability, indemnification, and dispute resolution) survive termination.</p>
            </Section>

            <Section id="disclaimers" summary="We work hard to keep Mercavine running well, but we can't promise it will be perfect.">
              <p>To the fullest extent the law allows, the Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any kind. Products are sold by sellers, and any product warranty comes from the seller or manufacturer. Results produced by AI assistants may be inaccurate; review your cart before you approve.</p>
            </Section>

            <Section id="liability" summary="If something goes wrong, there are limits on what Mercavine can be held liable for.">
              <p>To the fullest extent the law allows, Mercavine is not liable for indirect, incidental, special, consequential, or punitive damages. Our total liability for any claim is limited to <Ph id="liability_cap" />. Some places don&apos;t allow these limits, so they may not apply to you.</p>
            </Section>

            <Section id="indemnification" summary="If your actions cause a legal claim against Mercavine, you agree to cover it.">
              <p>You agree to defend and indemnify Mercavine against claims, losses, and costs arising from your breach of these Terms, your misuse of the Service, your bot&apos;s actions within the permissions you granted, or, for sellers, your products and listings.</p>
            </Section>

            <Section id="disputes" summary="Let's try to work things out first. If we can't, here's how disputes are resolved.">
              <p>Please contact us first so we can try to resolve the issue informally.</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Method: <Ph id="dispute_method" /></li>
                <li>Provider and rules: <Ph id="arbitration_provider" /></li>
                <li>Class-action waiver: <Ph id="class_action_waiver" /></li>
                <li>Small-claims court: <Ph id="small_claims_carveout" /></li>
                <li>Opting out: <Ph id="arbitration_opt_out" /></li>
              </ul>
            </Section>

            <Section id="governing-law" summary="Which state's laws apply and where cases are heard.">
              <p>These Terms are governed by the laws of <Ph id="governing_law_state" />, without regard to conflict-of-law rules. Any claims not subject to the dispute process above will be heard in <Ph id="venue" />.</p>
            </Section>

            <Section id="changes" summary="If we change these terms, we'll tell you before the changes apply.">
              <p>We may update these Terms. For material changes we will give notice at least <Ph id="terms_change_notice" /> before they take effect, by email or on the Service. Continuing to use the Service after that means you accept the updated Terms.</p>
            </Section>

            <Section id="notices" summary="How we send you notices and how you send legal notices to us.">
              <p>We may send notices to the email on your account or post them on the Service. Legal notices to Mercavine must be sent to <Ph id="legal_notice_email" /> and <Ph id="legal_notice_address" />.</p>
            </Section>

            <Section id="misc" summary="The standard fine print that keeps the rest working.">
              <p>These Terms, with the Privacy Policy and any policies referenced here, are the entire agreement between you and Mercavine about the Service. If any part is unenforceable, the rest still applies. Our not enforcing a right is not a waiver. You may not transfer these Terms without our consent; we may transfer them in a merger, acquisition, or sale of assets. Neither party is liable for delays caused by events beyond reasonable control.</p>
            </Section>

            <Section id="contact" summary="Questions? Get in touch.">
              <p>Mercavine</p>
              <p>Support: <Ph id="support_email" /></p>
              <p>Privacy questions: <a href="mailto:privacy@mercavine.com" className="underline">privacy@mercavine.com</a></p>
            </Section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
